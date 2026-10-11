//! Live Level II chunk streaming ("RapidSweep"): polls the real-time chunks bucket,
//! decodes each chunk as it lands and notifies apps so partial sweeps can be drawn.

use super::encode;
use super::level2::{Decoder, Volume};
use super::service::{encode_tilt, vol_meta, VolMeta};
use crate::health::Health;
use crate::hub::Hub;
use crate::s3;
use anyhow::{anyhow, Result};
use bytes::Bytes;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const INTEREST_SECS: u64 = 120;

struct LiveState {
    vol_num: Option<u32>,
    seen: HashSet<String>,
    dec: Decoder,
    done: VecDeque<(u32, Arc<Volume>)>,
    last_new: Instant,
    chunks: u32,
}

impl LiveState {
    fn new() -> Self {
        Self { vol_num: None, seen: HashSet::new(), dec: Decoder::new(), done: VecDeque::new(), last_new: Instant::now(), chunks: 0 }
    }
}

pub struct ReplayCfg {
    pub site: String,
    pub dir: PathBuf,
    pub interval_ms: u64,
}

pub struct LiveManager {
    http: reqwest::Client,
    buckets: Vec<String>,
    health: Arc<Health>,
    hub: Hub,
    poll_secs: u64,
    max_sites: usize,
    always: Vec<String>,
    sites: Mutex<HashMap<String, Arc<Mutex<LiveState>>>>,
    keep_done: usize,
    interest: Mutex<HashMap<String, Instant>>,
    busy: Mutex<HashSet<String>>,
    replay: Option<ReplayCfg>,
}

fn chunk_parts(key: &str) -> Option<(u32, char)> {
    // SITE/NUM/YYYYMMDD-HHMMSS-CCC-T
    let name = key.rsplit('/').next()?;
    let p: Vec<&str> = name.split('-').collect();
    if p.len() != 4 {
        return None;
    }
    Some((p[2].parse().ok()?, p[3].chars().next()?))
}

fn chunk_time(key: &str) -> Option<i64> {
    let name = key.rsplit('/').next()?;
    let p: Vec<&str> = name.split('-').collect();
    if p.len() < 2 {
        return None;
    }
    let dt = chrono::NaiveDateTime::parse_from_str(&format!("{}{}", p[0], p[1]), "%Y%m%d%H%M%S").ok()?;
    Some(dt.and_utc().timestamp_millis())
}

impl LiveManager {
    pub fn new(
        http: reqwest::Client,
        buckets: Vec<String>,
        health: Arc<Health>,
        hub: Hub,
        poll_secs: u64,
        max_sites: usize,
        always: Vec<String>,
        replay: Option<ReplayCfg>,
        keep_done: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            http,
            buckets,
            health,
            hub,
            poll_secs,
            max_sites,
            always: always.into_iter().map(|s| s.to_ascii_uppercase()).collect(),
            sites: Mutex::new(HashMap::new()),
            keep_done: keep_done.max(2),
            interest: Mutex::new(HashMap::new()),
            busy: Mutex::new(HashSet::new()),
            replay,
        })
    }

    /// An app is looking at this site; keep it live for a while.
    pub fn touch(&self, site: &str) {
        let site = site.to_ascii_uppercase();
        if site.len() == 4 && site.chars().all(|c| c.is_ascii_alphanumeric()) {
            self.interest.lock().insert(site, Instant::now());
        }
    }

    fn state(&self, site: &str) -> Arc<Mutex<LiveState>> {
        self.sites.lock().entry(site.to_string()).or_insert_with(|| Arc::new(Mutex::new(LiveState::new()))).clone()
    }

    pub fn active_sites(&self) -> Vec<String> {
        let mut v: Vec<(String, Instant)> = self
            .interest
            .lock()
            .iter()
            .filter(|(_, t)| t.elapsed() < Duration::from_secs(INTEREST_SECS))
            .map(|(s, t)| (s.clone(), *t))
            .collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        let mut out: Vec<String> = self.always.clone();
        for (s, _) in v {
            if out.len() >= self.max_sites.max(self.always.len()) {
                break;
            }
            if !out.contains(&s) {
                out.push(s);
            }
        }
        if let Some(r) = &self.replay {
            if !out.contains(&r.site) {
                out.push(r.site.clone());
            }
        }
        out
    }

    pub fn spawn(self: &Arc<Self>) {
        if let Some(r) = &self.replay {
            let me = self.clone();
            let (site, dir, iv) = (r.site.clone(), r.dir.clone(), r.interval_ms);
            tokio::spawn(async move { me.replay_loop(site, dir, iv).await });
        }
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let sites = me.active_sites();
                for s in sites {
                    if me.replay.as_ref().map(|r| r.site == s).unwrap_or(false) {
                        continue;
                    }
                    if !me.busy.lock().insert(s.clone()) {
                        continue;
                    }
                    let m2 = me.clone();
                    tokio::spawn(async move {
                        if let Err(e) = m2.poll(&s).await {
                            m2.health.err("nexrad-chunks", "NEXRAD live chunks", format!("{s}: {e}"));
                        }
                        m2.busy.lock().remove(&s);
                    });
                }
                // drop state for sites nobody watches (frees memory)
                let active: HashSet<String> = me.active_sites().into_iter().collect();
                me.sites.lock().retain(|k, _| active.contains(k));
                tokio::time::sleep(Duration::from_secs(me.poll_secs)).await;
            }
        });
    }

    async fn first_key_time(&self, bucket: &str, prefix: &str) -> Option<i64> {
        let l = s3::list(&self.http, bucket, prefix, None, Some(1), 1).await.ok()?;
        l.objects.first().and_then(|o| chunk_time(&o.key))
    }

    /// Find the volume number currently being written.
    async fn discover(&self, bucket: &str, site: &str) -> Result<u32> {
        let l = s3::list(&self.http, bucket, &format!("{site}/"), Some("/"), None, 2).await?;
        let mut nums: Vec<u32> = l
            .prefixes
            .iter()
            .filter_map(|p| p.trim_end_matches('/').rsplit('/').next()?.parse().ok())
            .collect();
        if nums.is_empty() {
            return Err(anyhow!("no live volumes for {site}"));
        }
        nums.sort_unstable();
        let t0 = self.first_key_time(bucket, &format!("{site}/{}/", nums[0])).await.unwrap_or(0);
        let last = nums.len() - 1;
        let tl = self.first_key_time(bucket, &format!("{site}/{}/", nums[last])).await.unwrap_or(0);
        if tl >= t0 {
            return Ok(nums[last]);
        }
        // rotated: find the last index whose start time >= t0
        let (mut lo, mut hi) = (0usize, last);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            let tm = self.first_key_time(bucket, &format!("{site}/{}/", nums[mid])).await.unwrap_or(0);
            if tm >= t0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        Ok(nums[lo])
    }

    async fn poll(&self, site: &str) -> Result<()> {
        let st = self.state(site);
        let mut last_err = None;
        for bucket in &self.buckets {
            match self.poll_bucket(bucket, site, &st).await {
                Ok(()) => {
                    self.health.ok("nexrad-chunks", "NEXRAD live chunks", format!("s3://{bucket}"));
                    return Ok(());
                }
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("no buckets")))
    }

    async fn poll_bucket(&self, bucket: &str, site: &str, st: &Arc<Mutex<LiveState>>) -> Result<()> {
        let (vol_num, stale) = {
            let s = st.lock();
            (s.vol_num, s.last_new.elapsed() > Duration::from_secs(180))
        };
        let vol_num = match vol_num {
            Some(n) if !stale => n,
            _ => {
                let n = self.discover(bucket, site).await?;
                let mut s = st.lock();
                if s.vol_num != Some(n) {
                    s.vol_num = Some(n);
                    s.seen.clear();
                    s.dec = Decoder::new();
                    s.last_new = Instant::now();
                }
                n
            }
        };
        let l = s3::list(&self.http, bucket, &format!("{site}/{vol_num}/"), None, None, 2).await?;
        let mut keys: Vec<(u32, char, String)> = l
            .objects
            .into_iter()
            .filter_map(|o| chunk_parts(&o.key).map(|(n, t)| (n, t, o.key)))
            .collect();
        keys.sort_by_key(|k| k.0);
        let mut ended = false;
        for (num, kind, key) in keys {
            if st.lock().seen.contains(&key) {
                if kind == 'E' {
                    ended = true;
                }
                continue;
            }
            // chunks must be fed in order; stop at the first gap
            let expected = st.lock().seen.len() as u32 + 1;
            if num != expected {
                break;
            }
            let bytes = s3::get(&self.http, bucket, &key).await?;
            self.feed(site, vol_num, num, kind, &key, bytes, st);
            if kind == 'E' {
                ended = true;
            }
        }
        if ended {
            self.finish_volume(site, vol_num, st);
            let mut s = st.lock();
            s.vol_num = Some(if vol_num >= 999 { 1 } else { vol_num + 1 });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn feed(&self, site: &str, vol_num: u32, num: u32, kind: char, key: &str, bytes: Bytes, st: &Arc<Mutex<LiveState>>) {
        let ev = {
            let mut s = st.lock();
            s.seen.insert(key.to_string());
            s.last_new = Instant::now();
            s.chunks += 1;
            if let Err(e) = s.dec.feed(&bytes) {
                tracing::debug!("live chunk {key}: {e}");
            }
            let v = &s.dec.vol;
            let last = v.sweeps.len().saturating_sub(1);
            let tilts = super::level2::tilts(v);
            serde_json::json!({
                "type": "live",
                "site": site,
                "key": format!("live:{site}:{vol_num}"),
                "chunk": num,
                "kind": kind.to_string(),
                "tilts": tilts.len(),
                "tilt": tilts.len().saturating_sub(1),
                "sweep": last,
                "radials": v.sweeps.last().map(|s| s.radials.len()).unwrap_or(0),
                "elev": v.sweeps.last().map(|s| s.elevation()).unwrap_or(0.0),
                "time": v.sweeps.last().map(|s| s.end_ms()).unwrap_or(0),
            })
        };
        self.hub.send(ev);
    }

    fn finish_volume(&self, site: &str, vol_num: u32, st: &Arc<Mutex<LiveState>>) {
        let mut s = st.lock();
        let mut dec = std::mem::take(&mut s.dec);
        dec.finish();
        let vol = Arc::new(dec.vol);
        if !vol.sweeps.is_empty() {
            s.done.push_back((vol_num, vol));
            while s.done.len() > self.keep_done {
                s.done.pop_front();
            }
        }
        s.seen.clear();
        drop(s);
        self.hub.send(serde_json::json!({"type": "live_volume", "site": site, "key": format!("live:{site}:{vol_num}")}));
    }

    async fn replay_loop(self: Arc<Self>, site: String, dir: PathBuf, interval_ms: u64) {
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect())
            .unwrap_or_default();
        files.sort();
        if files.is_empty() {
            tracing::warn!("replay dir {} has no chunk files", dir.display());
            return;
        }
        tracing::info!("replaying {} chunks for {site} every {interval_ms} ms", files.len());
        let st = self.state(&site);
        let mut vol_num = 1u32;
        loop {
            {
                // shift timestamps so the replayed volume looks like it is happening now
                let offset = files
                    .first()
                    .and_then(|f| std::fs::read(f).ok())
                    .filter(|b| b.len() >= 24 && &b[0..4] == b"AR2V")
                    .map(|b| {
                        let jd = u32::from_be_bytes([b[12], b[13], b[14], b[15]]);
                        let ms = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
                        chrono::Utc::now().timestamp_millis() - super::level2::nexrad_time(jd as u16, ms)
                    })
                    .unwrap_or(0);
                let mut s = st.lock();
                s.vol_num = Some(vol_num);
                s.dec = Decoder::new();
                s.dec.time_offset_ms = offset;
                s.seen.clear();
            }
            for f in &files {
                let name = f.file_name().unwrap().to_string_lossy().to_string();
                let Some((num, kind)) = chunk_parts(&name) else { continue };
                if let Ok(b) = tokio::fs::read(f).await {
                    let key = format!("{site}/{vol_num}/{name}");
                    // ensure replay state survives the cleanup in the poll loop
                    self.touch(&site);
                    let st2 = self.state(&site);
                    self.feed(&site, vol_num, num, kind, &key, Bytes::from(b), &st2);
                }
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            }
            let st2 = self.state(&site);
            self.finish_volume(&site, vol_num, &st2);
            vol_num = if vol_num >= 999 { 1 } else { vol_num + 1 };
            tokio::time::sleep(Duration::from_millis(interval_ms * 3)).await;
        }
    }

    // ---------- queries ----------

    pub fn status(&self, site: &str) -> serde_json::Value {
        let site = site.to_ascii_uppercase();
        let Some(st) = self.sites.lock().get(&site).cloned() else {
            return serde_json::json!({"site": site, "active": false});
        };
        let s = st.lock();
        let current = s.vol_num.filter(|_| !s.dec.vol.sweeps.is_empty()).map(|n| format!("live:{site}:{n}"));
        let done: Vec<String> = s.done.iter().map(|(n, _)| format!("live:{site}:{n}")).collect();
        serde_json::json!({
            "site": site,
            "active": true,
            "current": current,
            "complete": done,
            "chunks": s.chunks,
            "last_chunk_age_s": s.last_new.elapsed().as_secs(),
        })
    }

    fn with_volume<T>(&self, key: &str, f: impl FnOnce(&Volume) -> Result<T>) -> Result<T> {
        let rest = key.strip_prefix("live:").ok_or_else(|| anyhow!("not a live key"))?;
        let (site, n) = rest.split_once(':').ok_or_else(|| anyhow!("bad live key"))?;
        let n: u32 = n.parse()?;
        let st = self.sites.lock().get(site).cloned().ok_or_else(|| anyhow!("site not live"))?;
        let s = st.lock();
        if s.vol_num == Some(n) && !s.dec.vol.sweeps.is_empty() {
            return f(&s.dec.vol);
        }
        if let Some((_, v)) = s.done.iter().find(|(m, _)| *m == n) {
            return f(v);
        }
        Err(anyhow!("live volume expired"))
    }

    pub fn meta(&self, key: &str) -> Result<VolMeta> {
        self.with_volume(key, |v| Ok(vol_meta(key, v)))
    }

    pub fn sweep(&self, key: &str, tilt: usize, moment: &str) -> Result<Bytes> {
        let raw = self.with_volume(key, |v| encode_tilt(v, tilt, moment))?;
        Ok(Bytes::from(encode::zstd(&raw)))
    }
}
