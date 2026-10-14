//! Data access for training and inference behind one trait, so tests can inject synthetic data.
//! [`NetSource`] is the real implementation: Level II archive / chunks, SPC / IEM / NHC / HMS
//! label databases and MRMS / METAR / GFS environment sampling.

use super::features::{fc_var, hrrr_var, model_var, mrms_product, Agg, FeatMap, Sources, VarKind};
use super::labels::{self, Event};
use crate::hist::tc::Storm;
use crate::radar::level2::Volume;
use crate::radar::service::{l2_time_from_name, RadarService, VolEntry};
use crate::sites::Site;
use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use chrono::{Datelike, NaiveDate, TimeZone, Timelike, Utc};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub type Bf<'a, T> = BoxFuture<'a, Result<T>>;

/// When environment features are wanted: the analysis / issue time `t` and, for forecast
/// fields, the target window (start, end) in unix ms.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EnvCtx {
    pub t: i64,
    pub win: Option<(i64, i64)>,
}

/// A gridded "truth" request (labels and current observations).
/// kinds: `t2m` (°C at `t1`), `qpe` (mm over (t0, t1]), `cref_max` (dBZ, max over the window
/// within the radius), `mesh_max` (mm), `glm_count` (flashes within the radius in the window).
#[derive(Clone, Debug, PartialEq)]
pub struct TruthReq {
    pub kind: String,
    pub t0: i64,
    pub t1: i64,
    pub radius_km: f64,
    pub realtime: bool,
}

/// Everything the dataset builder and the runner need from the outside world.
pub trait Fetch: Send + Sync {
    /// Radar sites (NEXRAD + TDWR).
    fn sites(&self) -> Vec<Site>;
    /// Level II volumes of a site on a UTC day.
    fn list_day<'a>(&'a self, site: &'a str, day: NaiveDate) -> Bf<'a, Vec<VolEntry>>;
    /// Newest complete volume of a site.
    fn latest<'a>(&'a self, site: &'a str) -> Bf<'a, Option<VolEntry>>;
    /// Decode a volume (not kept in the shared radar cache).
    fn volume<'a>(&'a self, key: &'a str) -> Bf<'a, Arc<Volume>>;
    /// SPC database rows of `kind` (tornado | hail | wind) for the years (reports for years not
    /// yet in the database come from IEM LSRs).
    fn spc<'a>(&'a self, kind: &'a str, years: (i32, i32)) -> Bf<'a, Vec<Event>>;
    /// IEM local storm reports in [t0, t1].
    fn lsr<'a>(&'a self, t0: i64, t1: i64) -> Bf<'a, Vec<Event>>;
    /// IEM storm-based warnings in [t0, t1].
    fn sbw<'a>(&'a self, t0: i64, t1: i64) -> Bf<'a, Vec<Event>>;
    /// HURDAT2 Atlantic + NE Pacific best tracks.
    fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>>;
    /// HMS fire detections of a UTC day.
    fn fires(&self, day: NaiveDate) -> Bf<'_, Vec<Event>>;
    /// Environment features for points at time `t` (`realtime`: newest data, not the archive).
    /// Fails only when every requested source failed.
    fn env<'a>(&'a self, s: &'a Sources, t: i64, pts: &'a [(f64, f64)], realtime: bool) -> Bf<'a, Vec<FeatMap>>;
    /// Environment features with a target window (forecast fields summarised over it).
    fn env_ctx<'a>(&'a self, s: &'a Sources, ctx: EnvCtx, pts: &'a [(f64, f64)], realtime: bool) -> Bf<'a, Vec<FeatMap>> {
        self.env(s, ctx.t, pts, realtime)
    }
    /// Gridded truth at points (NaN = unknown).
    fn truth<'a>(&'a self, req: &'a TruthReq, _pts: &'a [(f64, f64)]) -> Bf<'a, Vec<f32>> {
        Box::pin(async move { bail!("no gridded truth ({}) in this data source", req.kind) })
    }
    /// Warm the raw-download cache of a volume (pipelining: the next volume downloads while the
    /// current one is extracted).
    fn prefetch<'a>(&'a self, _key: &'a str) -> Bf<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    /// Raw bytes of a volume key (archive or real-time chunks, concatenated into one Level II
    /// file) — used by radar recordings.
    fn raw<'a>(&'a self, key: &'a str) -> Bf<'a, Bytes> {
        Box::pin(async move { bail!("no raw access to {key}") })
    }
    /// Concurrent decodes of gridded data (follows the training jobs' CPU budget).
    fn set_decode_threads(&self, _n: usize) {}
    /// Where grid predictions are published (the grid service; tests inject their own).
    fn pred_sink(&self) -> Option<Arc<dyn super::predict::PredSink>> {
        None
    }
    /// Bytes held in memory caches (bytes, items).
    fn cache_bytes(&self) -> (usize, usize) {
        (0, 0)
    }
    fn clear_cache(&self) {}
    /// 0.8.1: the current job will read these radar volume keys (computed when it starts);
    /// returns how many of them another running job planned too.
    fn plan(&self, _keys: &[String]) -> usize {
        0
    }
    /// 0.8.1: the current job finished: release its plan.
    fn release_plan(&self) {}
    /// 0.8.1: shared-data statistics (see `share.rs`).
    fn shared_stats(&self) -> Option<serde_json::Value> {
        None
    }
}

/// Small byte-capped LRU for raw downloads.
struct BytesLru {
    map: lru::LruCache<String, Bytes>,
    bytes: usize,
    cap: usize,
}

impl BytesLru {
    fn new(cap: usize) -> Self {
        Self { map: lru::LruCache::unbounded(), bytes: 0, cap }
    }
    fn get(&mut self, k: &str) -> Option<Bytes> {
        self.map.get(k).cloned()
    }
    fn put(&mut self, k: String, v: Bytes) {
        self.bytes += v.len();
        if let Some(old) = self.map.put(k, v) {
            self.bytes -= old.len();
        }
        while self.bytes > self.cap {
            match self.map.pop_lru() {
                Some((_, b)) => self.bytes -= b.len(),
                None => break,
            }
        }
    }
}

type IdxRows = Vec<(u64, Option<u64>, Vec<String>)>;

pub struct NetSource {
    pub http: reqwest::Client,
    pub radar: Arc<RadarService>,
    pub grids: Arc<crate::grid::service::GridService>,
    pub chunk_buckets: Vec<String>,
    /// data/cache/ml/labels
    pub label_dir: PathBuf,
    pub data_dir: PathBuf,
    pub sites_fn: Box<dyn Fn() -> Vec<Site> + Send + Sync>,
    raw: Mutex<BytesLru>,
    listings: Mutex<HashMap<String, (Instant, Arc<Vec<(i64, String)>>)>>,
    idx: Mutex<lru::LruCache<String, Arc<IdxRows>>>,
    spc_cache: Mutex<HashMap<String, Arc<Vec<Event>>>>,
    storms_cache: Mutex<Option<Arc<Vec<Storm>>>>,
    decode: crate::caches::Limiter,
    iem_gate: tokio::sync::Mutex<Option<Instant>>,
    /// parsed GLM files: key → flashes (lat, lon, t ms)
    pub(crate) glm: Mutex<lru::LruCache<String, Arc<Vec<(f32, f32, i64)>>>>,
    /// US Drought Monitor maps by week: (DM class, polygon rings)
    pub(crate) usdm: Mutex<lru::LruCache<String, Arc<Vec<(i8, Vec<[f32; 2]>)>>>>,
    /// 0.8.1: one download per URL / range at a time (jobs and the runner share it)
    gets: super::share::Inflight<Bytes>,
}

const GFS_BUCKET: &str = "noaa-gfs-bdp-pds";

impl NetSource {
    #[allow(clippy::too_many_arguments)]
    pub fn new(http: reqwest::Client, radar: Arc<RadarService>, grids: Arc<crate::grid::service::GridService>, chunk_buckets: Vec<String>, data_dir: &std::path::Path, mem_mb: usize, decode_threads: usize, sites_fn: Box<dyn Fn() -> Vec<Site> + Send + Sync>) -> Self {
        let label_dir = data_dir.join("cache/ml/labels");
        std::fs::create_dir_all(&label_dir).ok();
        Self {
            http,
            radar,
            grids,
            chunk_buckets,
            label_dir,
            data_dir: data_dir.to_path_buf(),
            sites_fn,
            raw: Mutex::new(BytesLru::new(mem_mb.clamp(32, 512) << 20)),
            listings: Mutex::new(HashMap::new()),
            idx: Mutex::new(lru::LruCache::new(std::num::NonZeroUsize::new(64).unwrap())),
            spc_cache: Mutex::new(HashMap::new()),
            storms_cache: Mutex::new(None),
            decode: crate::caches::Limiter::new(decode_threads.max(1)),
            iem_gate: tokio::sync::Mutex::new(None),
            glm: Mutex::new(lru::LruCache::new(std::num::NonZeroUsize::new(3000).unwrap())),
            usdm: Mutex::new(lru::LruCache::new(std::num::NonZeroUsize::new(4).unwrap())),
            gets: Default::default(),
        }
    }

    pub fn set_mem(&self, mem_mb: usize) {
        let mut g = self.raw.lock();
        g.cap = mem_mb.clamp(32, 512) << 20;
    }

    pub(crate) async fn get(&self, url: &str, range: Option<(u64, Option<u64>)>) -> Result<Bytes> {
        let ck = format!("{url}#{range:?}");
        if let Some(b) = self.raw.lock().get(&ck) {
            return Ok(b);
        }
        // 0.8.1: a request already in flight (another job / the runner) is awaited, not repeated
        let (r, shared) = self.gets.run(&ck, || self.get_net(url, range, ck.clone())).await;
        if shared {
            if let (Ok(b), Some(u)) = (&r, super::jobs::current()) {
                u.shared.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                u.shared_bytes.fetch_add(b.len() as u64, std::sync::atomic::Ordering::Relaxed);
            }
        }
        r
    }

    async fn get_net(&self, url: &str, range: Option<(u64, Option<u64>)>, ck: String) -> Result<Bytes> {
        let mut req = self.http.get(url);
        if let Some((a, b)) = range {
            req = req.header(reqwest::header::RANGE, match b {
                Some(b) => format!("bytes={a}-{}", b.saturating_sub(1)),
                None => format!("bytes={a}-"),
            });
        }
        let r = req.send().await?;
        if !r.status().is_success() {
            bail!("{url}: HTTP {}", r.status());
        }
        let b = r.bytes().await?;
        super::jobs::add_net(b.len() as u64);
        self.raw.lock().put(ck, b.clone());
        Ok(b)
    }

    /// IEM asks for ~1 request/s per client; retried with backoff (3 attempts).
    async fn iem_json(&self, url: &str) -> Result<serde_json::Value> {
        let mut last = anyhow!("no attempt");
        for attempt in 0..3u32 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(5 * 3u64.pow(attempt - 1))).await;
            }
            {
                let mut g = self.iem_gate.lock().await;
                if let Some(t) = *g {
                    let wait = Duration::from_millis(1100).saturating_sub(t.elapsed());
                    tokio::time::sleep(wait).await;
                }
                *g = Some(Instant::now());
            }
            let res: Result<serde_json::Value> = async {
                let r = self.http.get(url).timeout(Duration::from_secs(120)).send().await?;
                if !r.status().is_success() {
                    bail!("{url}: HTTP {}", r.status());
                }
                let b = r.bytes().await?;
                super::jobs::add_net(b.len() as u64);
                Ok(serde_json::from_slice(&b)?)
            }
            .await;
            match res {
                Ok(v) => return Ok(v),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    /// Text file cached on disk (immutable historical files).
    pub(crate) async fn cached_text(&self, name: &str, url: &str) -> Result<String> {
        let path = self.label_dir.join(format!("{name}.zst"));
        if let Ok(b) = tokio::fs::read(&path).await {
            if let Ok(d) = zstd::decode_all(&b[..]) {
                return Ok(String::from_utf8_lossy(&d).into_owned());
            }
        }
        let r = self.http.get(url).timeout(Duration::from_secs(180)).send().await.with_context(|| url.to_string())?;
        if !r.status().is_success() {
            bail!("{url}: HTTP {}", r.status());
        }
        let b = r.bytes().await?;
        super::jobs::add_net(b.len() as u64);
        if let Ok(z) = zstd::encode_all(&b[..], 9) {
            crate::platform::write_atomic(&path, &z).ok();
        }
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    /// Sorted (time, key) of an S3 prefix, cached (refreshed after `max_age`).
    pub(crate) async fn listing(&self, bucket: &str, prefix: &str, max_age: Duration, parse: fn(&str) -> Option<i64>) -> Result<Arc<Vec<(i64, String)>>> {
        let ck = format!("{bucket}/{prefix}");
        if let Some((t, v)) = self.listings.lock().get(&ck) {
            if t.elapsed() < max_age {
                return Ok(v.clone());
            }
        }
        let l = crate::s3::list(&self.http, bucket, prefix, None, None, 20).await?;
        let mut v: Vec<(i64, String)> = l.objects.into_iter().filter_map(|o| parse(&o.key).map(|t| (t, o.key))).collect();
        v.sort();
        let v = Arc::new(v);
        let mut g = self.listings.lock();
        if g.len() > 2000 {
            g.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(600));
        }
        g.insert(ck, (Instant::now(), v.clone()));
        Ok(v)
    }

    // ---------- radar ----------

    async fn decode_volume(&self, raw: Bytes, key: &str) -> Result<Arc<Volume>> {
        let _p = self.decode.sem.clone().acquire_owned().await?;
        let k = key.to_string();
        let v = tokio::task::spawn_blocking(move || -> Result<Volume> {
            let base = k.rsplit(['/', ':']).next().unwrap_or("").to_string();
            let mut v = crate::radar::service::decode_any(&raw, &base).with_context(|| format!("decode {k}"))?;
            if v.site.is_empty() {
                v.site = base.chars().take(4).collect::<String>().to_ascii_uppercase();
            }
            Ok(v)
        })
        .await??;
        Ok(Arc::new(v))
    }

    /// Newest complete volume in the real-time chunks bucket (TDWR and NEXRAD).
    async fn chunks_latest(&self, site: &str) -> Result<Option<VolEntry>> {
        for bucket in &self.chunk_buckets {
            let Ok(l) = crate::s3::list(&self.http, bucket, &format!("{site}/"), Some("/"), None, 2).await else { continue };
            let mut nums: Vec<u32> = l.prefixes.iter().filter_map(|p| p.trim_end_matches('/').rsplit('/').next()?.parse().ok()).collect();
            if nums.is_empty() {
                continue;
            }
            nums.sort_unstable();
            // volume numbers wrap around: compare the first-chunk times of the candidates
            let n = nums.len();
            let mut cand = vec![nums[0], nums[n - 1]];
            if n > 2 {
                cand.push(nums[n - 2]);
                cand.push(nums[1]);
            }
            cand.sort_unstable();
            cand.dedup();
            let mut best: Option<(i64, u32)> = None;
            for num in cand {
                let Ok(cl) = crate::s3::list(&self.http, bucket, &format!("{site}/{num}/"), None, None, 2).await else { continue };
                let t = cl.objects.first().and_then(|o| chunk_time(&o.key)).unwrap_or(0);
                let complete = cl.objects.iter().any(|o| o.key.ends_with("-E"));
                if complete && best.map(|b| t > b.0).unwrap_or(true) {
                    best = Some((t, num));
                }
            }
            if let Some((t, num)) = best {
                return Ok(Some(VolEntry { key: format!("chunks:{bucket}/{site}/{num}"), time: t, size: 0, source: "chunks" }));
            }
        }
        Ok(None)
    }

    /// The chunks of a real-time volume concatenated: a valid Level II archive file.
    async fn chunks_raw(&self, key: &str) -> Result<Bytes> {
        let rest = key.strip_prefix("chunks:").ok_or_else(|| anyhow!("bad key"))?;
        let (bucket, prefix) = rest.split_once('/').ok_or_else(|| anyhow!("bad key"))?;
        if !self.chunk_buckets.iter().any(|b| b == bucket) {
            bail!("bucket not allowed");
        }
        let l = crate::s3::list(&self.http, bucket, &format!("{prefix}/"), None, None, 3).await?;
        let mut keys: Vec<(u32, String)> = l.objects.iter().filter_map(|o| Some((o.key.rsplit('-').nth(1)?.parse().ok()?, o.key.clone()))).collect();
        keys.sort();
        if !keys.iter().any(|k| k.1.ends_with("-E")) {
            bail!("volume not complete yet");
        }
        let mut out = Vec::new();
        for (_, k) in &keys {
            let b = crate::s3::get(&self.http, bucket, k).await?;
            super::jobs::add_net(b.len() as u64);
            out.extend_from_slice(&b);
        }
        Ok(Bytes::from(out))
    }

    async fn chunks_volume(&self, key: &str) -> Result<Arc<Volume>> {
        let rest = key.strip_prefix("chunks:").ok_or_else(|| anyhow!("bad key"))?;
        let (bucket, prefix) = rest.split_once('/').ok_or_else(|| anyhow!("bad key"))?;
        if !self.chunk_buckets.iter().any(|b| b == bucket) {
            bail!("bucket not allowed");
        }
        let l = crate::s3::list(&self.http, bucket, &format!("{prefix}/"), None, None, 3).await?;
        let mut keys: Vec<(u32, String)> = l.objects.iter().filter_map(|o| Some((o.key.rsplit('-').nth(1)?.parse().ok()?, o.key.clone()))).collect();
        keys.sort();
        let mut parts = vec![];
        for (_, k) in &keys {
            let b = crate::s3::get(&self.http, bucket, k).await?;
            super::jobs::add_net(b.len() as u64);
            parts.push(b);
        }
        let _p = self.decode.sem.clone().acquire_owned().await?;
        let v = tokio::task::spawn_blocking(move || -> Result<Volume> {
            let mut d = crate::radar::level2::Decoder::new();
            for p in &parts {
                d.feed(p)?;
            }
            d.finish();
            Ok(d.vol)
        })
        .await??;
        Ok(Arc::new(v))
    }

    // ---------- labels ----------

    async fn spc_kind(&self, kind: &str, years: (i32, i32)) -> Result<Vec<Event>> {
        let mut out = vec![];
        let mut missing_years = vec![];
        if kind == "tornado" {
            let rows = self.spc_tornadoes().await?;
            let max_year = rows.iter().map(|e| labels::year_of(e.t0)).max().unwrap_or(0);
            out.extend(rows.iter().filter(|e| (years.0..=years.1).contains(&labels::year_of(e.t0))).cloned());
            missing_years.extend((max_year + 1).max(years.0)..=years.1);
        } else {
            let mut files: Vec<String> = (years.0..=years.1).filter_map(|y| labels::spc_files(kind, y)).collect();
            files.dedup();
            let mut last_err = None;
            let mut any = false;
            for f in files {
                let ck = format!("{kind}/{f}");
                let cached = self.spc_cache.lock().get(&ck).cloned();
                let rows = match cached {
                    Some(r) => r,
                    None => {
                        let url = format!("https://www.spc.noaa.gov/wcm/data/{f}");
                        match self.cached_text(&format!("spc_{f}"), &url).await {
                            Ok(t) => {
                                let r = Arc::new(labels::parse_spc(t.as_bytes(), kind));
                                self.spc_cache.lock().insert(ck, r.clone());
                                r
                            }
                            Err(e) => {
                                tracing::info!("ml: SPC {f}: {e:#}");
                                last_err = Some(e);
                                Arc::new(vec![])
                            }
                        }
                    }
                };
                if rows.is_empty() {
                    if let Some(y) = f.split('_').next().and_then(|y| y.parse::<i32>().ok()) {
                        missing_years.push(y);
                    }
                } else {
                    any = true;
                }
                out.extend(rows.iter().filter(|e| (years.0..=years.1).contains(&labels::year_of(e.t0))).cloned());
            }
            if !any {
                if let Some(e) = last_err {
                    return Err(e.context(format!("SPC {kind} database unavailable")));
                }
            }
        }
        // the newest year(s) are not in the SPC database yet: use IEM storm reports
        for y in missing_years {
            if y > Utc::now().year() {
                continue;
            }
            let t0 = Utc.with_ymd_and_hms(y, 1, 1, 0, 0, 0).unwrap().timestamp_millis();
            let t1 = Utc.with_ymd_and_hms(y + 1, 1, 1, 0, 0, 0).unwrap().timestamp_millis().min(Utc::now().timestamp_millis());
            match self.lsr_range(t0, t1).await {
                Ok(l) => out.extend(l.into_iter().filter(|e| e.kind == kind)),
                Err(e) => tracing::info!("ml: IEM reports for {y}: {e:#}"),
            }
        }
        Ok(out)
    }

    async fn spc_tornadoes(&self) -> Result<Arc<Vec<Event>>> {
        if let Some(r) = self.spc_cache.lock().get("tornado/all").cloned() {
            return Ok(r);
        }
        // the overlays keep the same file (data/spc_tornadoes.csv); reuse when fresh
        let shared = self.data_dir.join("spc_tornadoes.csv");
        let fresh = std::fs::metadata(&shared).and_then(|m| m.modified()).ok().map(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(30 * 86400)).unwrap_or(false);
        let mut bytes = if fresh { tokio::fs::read(&shared).await.ok() } else { None };
        let mut err = String::new();
        if bytes.is_none() {
            let y = Utc::now().year();
            for yr in [y - 1, y - 2, y - 3] {
                let url = format!("https://www.spc.noaa.gov/wcm/data/1950-{yr}_actual_tornadoes.csv");
                match self.cached_text(&format!("spc_1950-{yr}_actual_tornadoes.csv"), &url).await {
                    Ok(t) if t.len() > 100_000 => {
                        bytes = Some(t.into_bytes());
                        break;
                    }
                    Ok(_) => err = format!("{url}: too small"),
                    Err(e) => err = format!("{e:#}"),
                }
            }
        }
        let b = bytes.or(tokio::fs::read(&shared).await.ok()).ok_or_else(|| anyhow!("SPC tornado database unavailable ({err})"))?;
        let rows = Arc::new(tokio::task::spawn_blocking(move || labels::parse_spc(&b, "tornado")).await?);
        self.spc_cache.lock().insert("tornado/all".into(), rows.clone());
        Ok(rows)
    }

    /// LSRs over any span, in ≤ 7-day requests (past weeks cached on disk).
    async fn lsr_range(&self, t0: i64, t1: i64) -> Result<Vec<Event>> {
        let week = 7 * 86_400_000;
        let mut out = vec![];
        let mut a = t0;
        let now = Utc::now().timestamp_millis();
        let mut errs = 0;
        while a < t1 {
            let b = (a + week).min(t1);
            let path = self.label_dir.join(format!("lsr_{a}_{b}.json.zst"));
            let v: Option<Vec<Event>> = std::fs::read(&path).ok().and_then(|z| zstd::decode_all(&z[..]).ok()).and_then(|d| serde_json::from_slice(&d).ok());
            let v = match v {
                Some(v) => v,
                None => {
                    let url = format!("https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts={}&ets={}", iem_ts(a), iem_ts(b));
                    match self.iem_json(&url).await {
                        Ok(j) => {
                            let ev = labels::parse_lsr(&j);
                            if b < now - 3 * 86_400_000 {
                                if let Ok(z) = zstd::encode_all(&serde_json::to_vec(&ev).unwrap_or_default()[..], 3) {
                                    crate::platform::write_atomic(&path, &z).ok();
                                }
                            }
                            ev
                        }
                        Err(e) => {
                            errs += 1;
                            tracing::warn!("ml: IEM storm reports {}–{}: {e:#}", iem_ts(a), iem_ts(b));
                            if errs > 2 {
                                return Err(e.context("IEM storm reports unavailable (cached weeks are kept; resume later)"));
                            }
                            vec![]
                        }
                    }
                }
            };
            out.extend(v);
            a = b;
        }
        Ok(out)
    }

    async fn load_storms(&self) -> Result<Arc<Vec<Storm>>> {
        if let Some(s) = self.storms_cache.lock().clone() {
            return Ok(s);
        }
        let mut all: Vec<Storm> = vec![];
        // the storm-history feature keeps parsed HURDAT2 here; reuse (and fill) the same files
        let tc_dir = self.data_dir.join("hist/tc");
        for src in ["al", "nepac"] {
            let p = tc_dir.join(format!("{src}.json.zst"));
            if let Some(v) = crate::hist::load_zst::<Vec<Storm>>(&p, Some(Duration::from_secs(60 * 86400))) {
                all.extend(v);
                continue;
            }
            let html = self.http.get("https://www.nhc.noaa.gov/data/").send().await?.text().await.unwrap_or_default();
            let names = crate::hist::tc::hurdat_names(&html);
            let file = if src == "al" { names.0 } else { names.1 }.ok_or_else(|| anyhow!("HURDAT2 file name not found on the NHC data page"))?;
            let txt = self.http.get(format!("https://www.nhc.noaa.gov/data/hurdat/{file}")).timeout(Duration::from_secs(180)).send().await?.text().await?;
            let v = crate::hist::tc::parse_hurdat(&txt);
            if v.is_empty() {
                bail!("no storms parsed from {file}");
            }
            crate::hist::save_zst(&p, &v).ok();
            all.extend(v);
        }
        let all = Arc::new(all);
        *self.storms_cache.lock() = Some(all.clone());
        Ok(all)
    }

    // ---------- environment ----------

    /// Newest MRMS object of `product` at or before `t` (+1 min), at most `max_age_min` old.
    async fn mrms_key(&self, product: &str, t: i64, realtime: bool, max_age_min: u32) -> Result<Option<String>> {
        let parse = |k: &str| -> Option<i64> {
            let stem = k.rsplit('_').next()?.trim_end_matches(".grib2.gz");
            chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d-%H%M%S").ok().map(|d| d.and_utc().timestamp_millis())
        };
        let d = chrono::DateTime::from_timestamp_millis(t).ok_or_else(|| anyhow!("bad time"))?;
        let max_age = max_age_min as i64 * 60_000;
        let mut best: Option<(i64, String)> = None;
        let mut days = vec![d.date_naive()];
        let early = (d - chrono::Duration::milliseconds(max_age + 60_000)).date_naive();
        if early != days[0] {
            days.push(early);
        }
        for dd in days {
            let prefix = format!("CONUS/{product}/{}/", dd.format("%Y%m%d"));
            let ttl = if realtime { Duration::from_secs(90) } else { Duration::from_secs(86400) };
            let l = self.listing(crate::grid::sources::MRMS_BUCKET, &prefix, ttl, parse).await?;
            for (ot, k) in l.iter() {
                if *ot <= t + 60_000 && t - ot <= max_age && best.as_ref().map(|b| *ot > b.0).unwrap_or(true) {
                    best = Some((*ot, k.clone()));
                }
            }
        }
        Ok(best.map(|b| b.1))
    }

    /// MRMS values at points (NaN = no data). Pass-2 QPE falls back to pass 1 in real time.
    pub(crate) async fn mrms_values(&self, product: &str, t: i64, realtime: bool, max_age_min: u32, q: Vec<(f64, f64)>) -> Result<Vec<f32>> {
        let mut key = self.mrms_key(product, t, realtime, max_age_min).await?;
        if key.is_none() && product.contains("_Pass2") {
            key = self.mrms_key(&product.replace("_Pass2", "_Pass1"), t, realtime, max_age_min).await?;
        }
        let key = key.ok_or_else(|| anyhow!("no {product} file near this time"))?;
        let b = self.get(&crate::s3::object_url(crate::grid::sources::MRMS_BUCKET, &key), None).await?;
        let opts = crate::grid::decode::DecodeOpts { nodata: vec![-9999.0, -999.0, -99.0], min_valid: None, transform: crate::grid::decode::Transform::None, max_dim: 0 };
        let _p = self.decode.sem.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
            let raw = crate::grid::decode::maybe_gunzip(&b)?;
            Ok(crate::grid::decode::decode_at(&raw, &opts, &q)?.0)
        })
        .await?
    }

    async fn mrms_env(&self, field: &str, t: i64, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let (_, product, age, fill) = *mrms_product(field).ok_or_else(|| anyhow!("unknown MRMS field"))?;
        let id = format!("mrms_{field}");
        let inside: Vec<bool> = pts.iter().map(|&(la, lo)| in_mrms_domain(la, lo)).collect();
        let n_in = inside.iter().filter(|x| **x).count();
        // outside the US: OPERA (Europe) stands in for reflectivity / rain rate where it exists
        if n_in < pts.len() {
            if let Some(layer) = opera_layer(field) {
                let outside: Vec<usize> = (0..pts.len()).filter(|&i| !inside[i] && in_opera_domain(pts[i].0, pts[i].1)).collect();
                if !outside.is_empty() {
                    match self.opera_values(layer, t, &outside.iter().map(|&i| pts[i]).collect::<Vec<_>>()).await {
                        Ok(v) => {
                            for (k, &i) in outside.iter().enumerate() {
                                out[i].set(&id, if v[k].is_finite() { v[k].max(fill) } else { fill });
                            }
                        }
                        Err(e) => tracing::debug!("ml: OPERA {layer}: {e:#}"),
                    }
                }
            }
            if n_in == 0 {
                return Ok(());
            }
        }
        // stencil: centre + 8 points 4 km away → max
        let q = stencil(pts, &[(4.0, 8)]);
        let k = q.len() / pts.len().max(1);
        let vals = self.mrms_values(product, t, realtime, age, q).await?;
        for (i, fm) in out.iter_mut().enumerate() {
            if !inside[i] {
                // no MRMS outside its domain: missing, not "no echo"
                continue;
            }
            let v = vals[i * k..(i + 1) * k].iter().copied().filter(|x| x.is_finite()).fold(f32::NAN, f32::max);
            // no echo / below the product floor counts as `fill` (0 for most fields)
            fm.set(&id, if v.is_finite() { v } else { fill });
        }
        Ok(())
    }

    /// OPERA composite values (max within 5 km) at points near time `t` (rolling 24 h archive).
    async fn opera_values(&self, layer: &str, t: i64, pts: &[(f64, f64)]) -> Result<Vec<f32>> {
        let now = Utc::now().timestamp_millis();
        if now - t > 23 * 3_600_000 {
            bail!("OPERA keeps only the last 24 h");
        }
        let fr = self.grids.frames(layer, 12, None, None, if now - t > 600_000 { Some(t + 60_000) } else { None }).await?;
        let f = fr.frames.iter().filter(|f| f.time <= t + 60_000 && t - f.time <= 20 * 60_000).max_by_key(|f| f.time).ok_or_else(|| anyhow!("no OPERA frame near this time"))?;
        let g = self.grids.grid(&f.key).await?;
        let q = stencil(pts, &[(4.0, 8)]);
        let k = q.len() / pts.len().max(1);
        let vals: Vec<f32> = q.iter().map(|p| g.sample(p.0, p.1).unwrap_or(f32::NAN)).collect();
        Ok((0..pts.len()).map(|i| vals[i * k..(i + 1) * k].iter().copied().filter(|x| x.is_finite()).fold(f32::NAN, f32::max)).collect())
    }

    async fn metar_env(&self, t: i64, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let now_obs = if realtime {
            self.grids.latest_metars().ok_or_else(|| anyhow!("no current METARs"))?
        } else {
            self.grids.metar_archive.snapshot(t / 3_600_000 * 3_600_000).await?.1
        };
        let prev = self.grids.metar_archive.snapshot((t - 3_600_000) / 3_600_000 * 3_600_000).await.ok().map(|x| x.1);
        let obs = now_obs.clone();
        let pts = pts.to_vec();
        let res = tokio::task::spawn_blocking(move || -> Vec<Vec<(String, f32)>> {
            let idx = ObsIndex::new(&obs);
            let pidx = prev.as_ref().map(|p| ObsIndex::new(p));
            pts.iter()
                .map(|&(la, lo)| {
                    let Some((o, d)) = idx.nearest(&obs, la, lo, 150.0) else { return vec![] };
                    let mut v = vec![
                        ("metar_t".to_string(), o.temp),
                        ("metar_td".to_string(), o.dew),
                        ("metar_spread".to_string(), o.temp - o.dew),
                        ("metar_wspd".to_string(), o.wspd),
                        ("metar_gust".to_string(), if o.gust.is_finite() { o.gust } else { o.wspd }),
                        ("metar_dist_km".to_string(), d as f32),
                    ];
                    if let (Some(p), Some(pi)) = (prev.as_ref(), pidx.as_ref()) {
                        if let Some((po, _)) = pi.nearest(p, o.lat as f64, o.lon as f64, 1.0) {
                            if po.id == o.id && o.alt.is_finite() && po.alt.is_finite() {
                                v.push(("metar_ptend".to_string(), o.alt - po.alt));
                            }
                            if po.id == o.id && o.temp.is_finite() && po.temp.is_finite() {
                                v.push(("metar_ttend".to_string(), o.temp - po.temp));
                            }
                        }
                    }
                    v
                })
                .collect()
        })
        .await?;
        for (fm, v) in out.iter_mut().zip(res) {
            for (k, x) in v {
                fm.set(&k, x);
            }
        }
        Ok(())
    }

    /// GRIB index of a model file (gfs | hrrr) for a run (init ms) and forecast hour.
    pub(crate) async fn nwp_idx(&self, model: &str, init: i64, fh: u32) -> Result<(String, Arc<IdxRows>)> {
        let c = chrono::DateTime::from_timestamp_millis(init).ok_or_else(|| anyhow!("bad run time"))?;
        let ymd = c.format("%Y%m%d").to_string();
        let hh = c.hour();
        let paths: Vec<(String, String)> = match model {
            "hrrr" => vec![("noaa-hrrr-bdp-pds".into(), format!("hrrr.{ymd}/conus/hrrr.t{hh:02}z.wrfsfcf{fh:02}.grib2"))],
            // layout since GFS v16 (2021-03), then the older one
            _ => vec![(GFS_BUCKET.into(), format!("gfs.{ymd}/{hh:02}/atmos/gfs.t{hh:02}z.pgrb2.0p25.f{fh:03}")), (GFS_BUCKET.into(), format!("gfs.{ymd}/{hh:02}/gfs.t{hh:02}z.pgrb2.0p25.f{fh:03}"))],
        };
        let mut last = anyhow!("no {model} file");
        for (bucket, path) in paths {
            let url = crate::s3::object_url(&bucket, &path);
            if let Some(i) = self.idx.lock().get(&url).cloned() {
                return Ok((url, i));
            }
            match self.get(&format!("{url}.idx"), None).await {
                Ok(b) => {
                    let rows = Arc::new(crate::grid::sources::parse_ncep_idx(&String::from_utf8_lossy(&b)));
                    if rows.is_empty() {
                        continue;
                    }
                    self.idx.lock().put(url.clone(), rows.clone());
                    return Ok((url, rows));
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    /// Newest run of `model` usable at `t` that has forecast hour `fh_for(init)` (tries a few cycles).
    async fn nwp_run(&self, model: &str, t: i64, realtime: bool, need_fh: impl Fn(i64) -> u32) -> Result<i64> {
        let (cyc, lat) = if model == "hrrr" { (3_600_000i64, 3_600_000i64) } else { (6 * 3_600_000i64, 4 * 3_600_000 + 1_800_000) };
        let c0 = (t - lat).div_euclid(cyc) * cyc;
        let tries = if realtime { 4 } else { 2 };
        let mut last = anyhow!("no {model} run");
        for k in 0..tries {
            let init = c0 - k * cyc;
            let fh = need_fh(init);
            if model == "hrrr" && fh > hrrr_max_fh(init) {
                bail!("HRRR does not reach forecast hour {fh}");
            }
            match self.nwp_idx(model, init, fh).await {
                Ok(_) => return Ok(init),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    async fn nwp_field(&self, url: &str, idx: &IdxRows, pat: &str, fh: u32, accum: bool, pts: Arc<Vec<(f64, f64)>>) -> Result<Vec<f32>> {
        let range = crate::grid::sources::find_ncep(idx, pat, fh, accum).ok_or_else(|| anyhow!("{pat} not in file"))?;
        let b = self.get(url, Some(range)).await?;
        let _p = self.decode.sem.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
            let opts = crate::grid::decode::DecodeOpts { nodata: vec![], min_valid: None, transform: crate::grid::decode::Transform::None, max_dim: 0 };
            Ok(crate::grid::decode::decode_at(&b, &opts, &pts)?.0)
        })
        .await?
    }

    #[allow(clippy::too_many_arguments)]
    async fn cached_field(&self, url: &str, idx: &IdxRows, pat: &str, fh: u32, accum: bool, pts: &Arc<Vec<(f64, f64)>>, cache: &mut HashMap<String, Arc<Vec<f32>>>) -> Result<Arc<Vec<f32>>> {
        let ck = format!("{url}|{pat}|{accum}");
        if let Some(v) = cache.get(&ck) {
            return Ok(v.clone());
        }
        let v = Arc::new(self.nwp_field(url, idx, pat, fh, accum, pts.clone()).await?);
        cache.insert(ck, v.clone());
        Ok(v)
    }

    /// One variable (patterns + combination kind) from one file, with a per-file field cache.
    async fn nwp_eval(&self, url: &str, idx: &IdxRows, pats: &[&str], kind: VarKind, fh: u32, pts: &Arc<Vec<(f64, f64)>>, cache: &mut HashMap<String, Arc<Vec<f32>>>) -> Result<Vec<f32>> {
        if pats.is_empty() {
            bail!("not available from this model");
        }
        let mut fields: Vec<Arc<Vec<f32>>> = vec![];
        if kind == VarKind::Alt {
            let mut err = anyhow!("none of {pats:?}");
            for p in pats {
                match self.cached_field(url, idx, p, fh, false, pts, cache).await {
                    Ok(v) => return Ok(v.to_vec()),
                    Err(e) => err = e,
                }
            }
            return Err(err);
        }
        for p in pats {
            fields.push(self.cached_field(url, idx, p, fh, kind == VarKind::Accum, pts, cache).await?);
        }
        let n = pts.len();
        let a = |k: usize, i: usize| fields.get(k).map(|f| f[i]).unwrap_or(f32::NAN);
        Ok((0..n)
            .map(|i| match kind {
                VarKind::Plain | VarKind::Alt | VarKind::Accum => a(0, i),
                VarKind::KToC => a(0, i) - 273.15,
                VarKind::PaToHpa => a(0, i) / 100.0,
                VarKind::Times1e5 => a(0, i) * 1e5,
                VarKind::Speed => (a(0, i).powi(2) + a(1, i).powi(2)).sqrt(),
                VarKind::Shear => ((a(2, i) - a(0, i)).powi(2) + (a(3, i) - a(1, i)).powi(2)).sqrt(),
                VarKind::Lapse => {
                    let dz = a(3, i) - a(2, i);
                    if dz.abs() > 10.0 { (a(0, i) - a(1, i)) / dz * 1000.0 } else { f32::NAN }
                }
                VarKind::Mean => (0..fields.len()).map(|k| a(k, i)).sum::<f32>() / fields.len().max(1) as f32,
                VarKind::Diff => a(1, i) - a(0, i),
            })
            .collect())
    }

    /// GFS analysis (f000 of the cycle at or before `t`).
    async fn gfs_env(&self, vars: &[String], t: i64, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let init = if realtime { self.nwp_run("gfs", t, true, |_| 0).await? } else { t.div_euclid(6 * 3_600_000) * 6 * 3_600_000 };
        let (url, idx) = self.nwp_idx("gfs", init, 0).await?;
        let pts = Arc::new(pts.to_vec());
        let mut cache = HashMap::new();
        let mut errs = vec![];
        let mut ok = 0;
        for id in vars {
            let Some(v) = model_var(id) else { continue };
            match self.nwp_eval(&url, &idx, v.pats, v.kind, 0, &pts, &mut cache).await {
                Ok(vals) => {
                    ok += 1;
                    let fid = format!("gfs_{}", v.id);
                    for (fm, x) in out.iter_mut().zip(vals) {
                        fm.set(&fid, x);
                    }
                }
                Err(e) => errs.push(format!("{id}: {e:#}")),
            }
        }
        if ok == 0 && !errs.is_empty() {
            bail!("{}", errs.join("; "));
        }
        Ok(())
    }

    /// HRRR "analysis": forecast hour 1 of the run an hour before `t`.
    async fn hrrr_env(&self, vars: &[String], t: i64, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let hour = t.div_euclid(3_600_000) * 3_600_000;
        let mut found = None;
        for k in 0..if realtime { 3 } else { 1 } {
            let init = hour - (k + 1) * 3_600_000;
            let fh = (k + 1) as u32;
            if let Ok(x) = self.nwp_idx("hrrr", init, fh).await {
                found = Some((x, fh));
                break;
            }
        }
        let ((url, idx), fh) = found.ok_or_else(|| anyhow!("no HRRR run for this time"))?;
        let pts = Arc::new(pts.to_vec());
        let mut cache = HashMap::new();
        let mut errs = vec![];
        let mut ok = 0;
        for id in vars {
            let Some(v) = hrrr_var(id) else { continue };
            match self.nwp_eval(&url, &idx, v.pats, v.kind, fh, &pts, &mut cache).await {
                Ok(vals) => {
                    ok += 1;
                    let fid = format!("hrrr_{}", v.id);
                    for (fm, x) in out.iter_mut().zip(vals) {
                        fm.set(&fid, x);
                    }
                }
                Err(e) => errs.push(format!("{id}: {e:#}")),
            }
        }
        if ok == 0 && !errs.is_empty() {
            bail!("{}", errs.join("; "));
        }
        Ok(())
    }

    /// Accumulated precipitation between forecast hours `fa` and `fb` of one run (bucket-aware).
    async fn apcp_window(&self, model: &str, init: i64, fa: u32, fb: u32, pts: &Arc<Vec<(f64, f64)>>) -> Result<Vec<f32>> {
        let n = pts.len();
        if fb <= fa {
            return Ok(vec![0.0; n]);
        }
        let mut acc = vec![0f32; n];
        let mut cur = fb;
        let mut guard = 0;
        while cur > fa && guard < 64 {
            guard += 1;
            let (url, idx) = self.nwp_idx(model, init, cur).await?;
            // APCP records ending at `cur`: (start, record)
            let mut recs: Vec<(u32, (u64, Option<u64>))> = idx
                .iter()
                .filter(|(_, _, f)| f.len() >= 6 && f[3] == "APCP" && f[4].starts_with("surface"))
                .filter_map(|(o, e, f)| {
                    let (a, b) = parse_acc(&f[5])?;
                    (b == cur && a >= fa && a < cur).then_some((a, (*o, *e)))
                })
                .collect();
            recs.sort_by_key(|r| r.0);
            if recs.is_empty() {
                // only a longer window ends here (e.g. 0-6 h while the window starts at 3 h):
                // take it and subtract the part before the window
                let longer: Option<(u32, (u64, Option<u64>))> = idx
                    .iter()
                    .filter(|(_, _, f)| f.len() >= 6 && f[3] == "APCP" && f[4].starts_with("surface"))
                    .filter_map(|(o, e, f)| {
                        let (a, b) = parse_acc(&f[5])?;
                        (b == cur && a < fa).then_some((a, (*o, *e)))
                    })
                    .max_by_key(|r| r.0);
                let Some((a0, range)) = longer else { bail!("no APCP window ending at f{cur:03}") };
                let b = self.get(&url, Some(range)).await?;
                let p2 = pts.clone();
                let vals = tokio::task::spawn_blocking(move || -> Result<Vec<f32>> { Ok(crate::grid::decode::decode_at(&b, &crate::grid::decode::DecodeOpts::default(), &p2)?.0) }).await??;
                let before = Box::pin(self.apcp_window(model, init, a0, fa, pts)).await?;
                for ((a, v), x) in acc.iter_mut().zip(vals).zip(before) {
                    *a += if v.is_finite() { (v - x).max(0.0) } else { f32::NAN };
                }
                return Ok(acc);
            }
            let (start, range) = recs[0];
            let b = self.get(&url, Some(range)).await?;
            let p2 = pts.clone();
            let _p = self.decode.sem.clone().acquire_owned().await?;
            let vals = tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
                let opts = crate::grid::decode::DecodeOpts::default();
                Ok(crate::grid::decode::decode_at(&b, &opts, &p2)?.0)
            })
            .await??;
            for (a, v) in acc.iter_mut().zip(vals) {
                *a += if v.is_finite() { v.max(0.0) } else { f32::NAN };
            }
            cur = start;
        }
        Ok(acc)
    }

    /// Forecast fields summarised over the window.
    async fn fcst_env(&self, s: &Sources, ctx: EnvCtx, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let t = ctx.t;
        let (a, b) = ctx.win.unwrap_or((t, t));
        let (a, b) = (a.min(b), a.max(b));
        let want_hrrr = match s.fcst_model.as_str() {
            "hrrr" => true,
            "auto" => b - t <= 16 * 3_600_000,
            _ => false,
        };
        let h = 3_600_000i64;
        let mut model = if want_hrrr { "hrrr" } else { "gfs" };
        let fh_of = |init: i64, x: i64| -> u32 { ((x - init) as f64 / h as f64).round().max(0.0) as u32 };
        let init = match self.nwp_run(model, t, realtime, |init| fh_of(init, b)).await {
            Ok(i) => i,
            Err(e) if model == "hrrr" && s.fcst_model == "auto" => {
                tracing::debug!("ml fcst: HRRR unavailable ({e:#}), using GFS");
                model = "gfs";
                self.nwp_run(model, t, realtime, |init| fh_of(init, b)).await?
            }
            Err(e) => return Err(e),
        };
        let gfs = model == "gfs";
        // GFS 0.25° is hourly to f120, then 3-hourly
        let snap = |fh: u32| -> u32 { if gfs && fh > 120 { (fh + 1) / 3 * 3 } else { fh } };
        let fa = snap(fh_of(init, a));
        let fb = snap(fh_of(init, b)).max(fa);
        let span = fb - fa;
        let step = if s.fcst_step_h > 0 {
            s.fcst_step_h
        } else if span <= 6 {
            if gfs { 3 } else { 1 }
        } else if span <= 24 {
            3
        } else if span <= 72 {
            6
        } else {
            12
        };
        let mut steps: Vec<u32> = (0..).map(|k| fa + k * step).take_while(|x| *x < fb).map(snap).collect();
        steps.push(fb);
        steps.dedup();
        let pts = Arc::new(pts.to_vec());
        let mut cache = HashMap::new();
        let mut errs = vec![];
        let mut ok = 0;
        for id in &s.fcst {
            let Some(v) = fc_var(id) else { continue };
            let (pats, kind) = if gfs { v.gfs } else { v.hrrr };
            let fid = format!("fc_{}", v.id);
            let res: Result<Vec<f32>> = async {
                if pats.is_empty() {
                    bail!("{} has no {}", model, v.id);
                }
                if v.agg == Agg::Acc {
                    return self.apcp_window(model, init, fa, fb, &pts).await;
                }
                let hours: Vec<u32> = if v.agg == Agg::At { vec![fb] } else { steps.clone() };
                let mut agg: Option<Vec<f32>> = None;
                let mut cnt = 0f32;
                for fh in hours {
                    let (url, idx) = match self.nwp_idx(model, init, fh).await {
                        Ok(x) => x,
                        Err(e) => {
                            if agg.is_none() && fh == fb {
                                return Err(e);
                            }
                            continue;
                        }
                    };
                    let vals = match self.nwp_eval(&url, &idx, pats, kind, fh, &pts, &mut cache).await {
                        Ok(v) => v,
                        Err(e) => {
                            if v.agg == Agg::At {
                                return Err(e);
                            }
                            continue;
                        }
                    };
                    cnt += 1.0;
                    agg = Some(match agg {
                        None => vals,
                        Some(mut cur) => {
                            for (c, x) in cur.iter_mut().zip(vals) {
                                *c = match v.agg {
                                    Agg::Max => c.max(x),
                                    Agg::Min => c.min(x),
                                    _ => *c + x,
                                };
                            }
                            cur
                        }
                    });
                }
                let mut r = agg.ok_or_else(|| anyhow!("no forecast hours for {}", v.id))?;
                if v.agg == Agg::Mean && cnt > 0.0 {
                    for x in r.iter_mut() {
                        *x /= cnt;
                    }
                }
                Ok(r)
            }
            .await;
            match res {
                Ok(vals) => {
                    ok += 1;
                    for (fm, x) in out.iter_mut().zip(vals) {
                        fm.set(&fid, x);
                    }
                }
                Err(e) => errs.push(format!("{id}: {e:#}")),
            }
        }
        if ok == 0 && !errs.is_empty() {
            bail!("{}", errs.join("; "));
        }
        Ok(())
    }

    /// US Drought Monitor class at points (weekly map valid on the Tuesday at or before `t`).
    async fn drought_env(&self, t: i64, pts: &[(f64, f64)], out: &mut [FeatMap]) -> Result<()> {
        let d = chrono::DateTime::from_timestamp_millis(t).ok_or_else(|| anyhow!("bad time"))?.date_naive();
        let back = (d.weekday().num_days_from_monday() + 7 - 1) % 7; // days since Tuesday
        let mut last = anyhow!("no drought map");
        for wk in 0..3 {
            let day = d - chrono::Duration::days(back as i64 + 7 * wk);
            let ymd = day.format("%Y%m%d").to_string();
            let cached = self.usdm.lock().get(&ymd).cloned();
            let polys = match cached {
                Some(p) => p,
                None => match self.cached_text(&format!("usdm_{ymd}.json"), &format!("https://droughtmonitor.unl.edu/data/json/usdm_{ymd}.json")).await {
                    Ok(txt) => {
                        let p = Arc::new(tokio::task::spawn_blocking(move || parse_usdm(&txt)).await?);
                        self.usdm.lock().put(ymd.clone(), p.clone());
                        p
                    }
                    Err(e) => {
                        last = e;
                        continue;
                    }
                },
            };
            for (fm, &(la, lo)) in out.iter_mut().zip(pts) {
                let mut cls = -1i8;
                for (c, ring) in polys.iter() {
                    if *c > cls && super::labels::point_in_poly(la, lo, ring) {
                        cls = *c;
                    }
                }
                fm.set("drought_class", cls as f32);
            }
            return Ok(());
        }
        Err(last)
    }

    /// Gridded truth at points; MRMS-based truth is unknown (NaN) outside the US.
    async fn truth_values(&self, req: &TruthReq, pts: &[(f64, f64)]) -> Result<Vec<f32>> {
        let mut v = self.truth_values_inner(req, pts).await?;
        if matches!(req.kind.as_str(), "qpe" | "cref_max" | "mesh_max") {
            for (x, p) in v.iter_mut().zip(pts) {
                if !in_mrms_domain(p.0, p.1) {
                    *x = f32::NAN;
                }
            }
        }
        Ok(v)
    }

    async fn truth_values_inner(&self, req: &TruthReq, pts: &[(f64, f64)]) -> Result<Vec<f32>> {
        let n = pts.len();
        let h = 3_600_000i64;
        let rings = radius_rings(req.radius_km);
        let q = stencil(pts, &rings);
        let k = q.len() / n.max(1);
        let reduce_max = |vals: &[f32], fill: f32| -> Vec<f32> {
            (0..n)
                .map(|i| {
                    let v = vals[i * k..(i + 1) * k].iter().copied().filter(|x| x.is_finite()).fold(f32::NAN, f32::max);
                    if v.is_finite() { v } else { fill }
                })
                .collect()
        };
        match req.kind.as_str() {
            "t2m" => self.t2m_truth(req.t1, pts, req.realtime).await,
            "qpe" => {
                let dur_h = ((req.t1 - req.t0) as f64 / h as f64).round().max(1.0) as i64;
                let end = req.t1.div_euclid(h) * h;
                let direct = match dur_h {
                    1 => Some("01H"),
                    3 => Some("03H"),
                    6 => Some("06H"),
                    12 => Some("12H"),
                    24 => Some("24H"),
                    48 => Some("48H"),
                    72 => Some("72H"),
                    _ => None,
                };
                let q = if req.radius_km > 0.0 { stencil(pts, &rings) } else { pts.to_vec() };
                let kk = q.len() / n.max(1);
                let fold = |vals: Vec<f32>| -> Vec<f32> { (0..n).map(|i| vals[i * kk..(i + 1) * kk].iter().copied().filter(|x| x.is_finite()).fold(f32::NAN, f32::max)).map(|v| if v.is_finite() { v.max(0.0) } else { f32::NAN }).collect() };
                if let Some(tag) = direct {
                    if let Ok(v) = self.mrms_values(&format!("MultiSensor_QPE_{tag}_Pass2_00.00"), end, req.realtime, 10, q.clone()).await {
                        return Ok(fold(v));
                    }
                }
                let mut acc = vec![0f32; n];
                for k in 0..dur_h {
                    let v = self.mrms_values("MultiSensor_QPE_01H_Pass2_00.00", end - k * h, req.realtime, 10, q.clone()).await?;
                    for (a, x) in acc.iter_mut().zip(fold(v)) {
                        *a += x;
                    }
                }
                Ok(acc)
            }
            "cref_max" | "mesh_max" => {
                let (hourly, inst) = if req.kind == "cref_max" { ("CREF_1HR_MAX_00.50", "MergedReflectivityQCComposite_00.50") } else { ("MESH_Max_60min_00.50", "MESH_00.50") };
                let mut best = vec![f32::NAN; n];
                let dur = req.t1 - req.t0;
                let mut ends: Vec<i64> = vec![];
                if dur >= 50 * 60_000 {
                    let mut e = req.t1;
                    while e > req.t0 + 10 * 60_000 {
                        ends.push(e);
                        e -= h;
                    }
                }
                let mut used_hourly = !ends.is_empty();
                for e in &ends {
                    match self.mrms_values(hourly, *e, req.realtime, 12, q.clone()).await {
                        Ok(v) => {
                            for (b, x) in best.iter_mut().zip(reduce_max(&v, f32::NAN)) {
                                *b = b.max(x);
                            }
                        }
                        Err(_) => {
                            used_hourly = false;
                            break;
                        }
                    }
                }
                if !used_hourly {
                    // instantaneous composites every 20 min
                    let mut e = req.t1;
                    let mut any = false;
                    while e > req.t0 {
                        if let Ok(v) = self.mrms_values(inst, e, req.realtime, 6, q.clone()).await {
                            any = true;
                            for (b, x) in best.iter_mut().zip(reduce_max(&v, f32::NAN)) {
                                *b = b.max(x);
                            }
                        }
                        e -= 20 * 60_000;
                    }
                    if !any {
                        bail!("no MRMS {inst} files in the window");
                    }
                }
                Ok(best.into_iter().map(|v| if v.is_finite() { v } else { 0.0 }).collect())
            }
            "glm_count" => {
                let fl = self.glm_flashes(req.t0, req.t1, pts, req.realtime).await?;
                Ok(super::sat::count_near(&fl, pts, req.radius_km.max(5.0), req.t0, req.t1))
            }
            k => bail!("unknown truth kind {k}"),
        }
    }

    /// 2 m temperature analysis (°C): URMA (RTMA when recent), METAR fallback.
    async fn t2m_truth(&self, t: i64, pts: &[(f64, f64)], realtime: bool) -> Result<Vec<f32>> {
        let hour = (t + 1_800_000).div_euclid(3_600_000) * 3_600_000;
        let recent = Utc::now().timestamp_millis() - hour < 8 * 3_600_000;
        let c = chrono::DateTime::from_timestamp_millis(hour).ok_or_else(|| anyhow!("bad time"))?;
        let (ymd, hh) = (c.format("%Y%m%d").to_string(), c.hour());
        let order: Vec<(&str, &str)> = if realtime || recent { vec![("noaa-rtma-pds", "rtma2p5"), ("noaa-urma-pds", "urma2p5")] } else { vec![("noaa-urma-pds", "urma2p5"), ("noaa-rtma-pds", "rtma2p5")] };
        let pts_a = Arc::new(pts.to_vec());
        let mut err = anyhow!("no 2 m temperature analysis");
        for (bucket, name) in order {
            let url = crate::s3::object_url(bucket, &format!("{name}.{ymd}/{name}.t{hh:02}z.2dvaranl_ndfd.grb2_wexp"));
            let res: Result<Vec<f32>> = async {
                let cached = self.idx.lock().get(&url).cloned();
                let rows = match cached {
                    Some(r) => Some(r),
                    None => match self.get(&format!("{url}.idx"), None).await {
                        Ok(b) => {
                            let r = Arc::new(crate::grid::sources::parse_ncep_idx(&String::from_utf8_lossy(&b)));
                            self.idx.lock().put(url.clone(), r.clone());
                            Some(r)
                        }
                        Err(_) => None,
                    },
                };
                let p2 = pts_a.clone();
                let opts = crate::grid::decode::DecodeOpts { transform: crate::grid::decode::Transform::KToC, ..Default::default() };
                if let Some(r) = rows.filter(|r| !r.is_empty()) {
                    let range = crate::grid::sources::find_ncep(&r, "TMP:2 m above ground", 0, false).ok_or_else(|| anyhow!("no TMP:2 m in {name}"))?;
                    let b = self.get(&url, Some(range)).await?;
                    let _p = self.decode.sem.clone().acquire_owned().await?;
                    return tokio::task::spawn_blocking(move || Ok(crate::grid::decode::decode_at(&b, &opts, &p2)?.0)).await?;
                }
                // older files have no index: whole file, temperature message
                let b = self.get(&url, None).await?;
                let _p = self.decode.sem.clone().acquire_owned().await?;
                tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
                    let msgs = crate::grid::decode::list_messages(&b)?;
                    let m = msgs.iter().find(|m| m.discipline == 0 && m.category == 0 && m.number == 0).ok_or_else(|| anyhow!("no temperature message"))?;
                    Ok(crate::grid::decode::decode_at_msg(&b, m.index, &opts, &p2)?.0)
                })
                .await?
            }
            .await;
            match res {
                Ok(mut v) => {
                    // outside the analysis domain (outside the US): nearest METAR
                    if v.iter().any(|x| !x.is_finite()) {
                        if let Ok(obs) = self.grids.metars_at(hour).await.map(|x| x.2) {
                            let idx = ObsIndex::new(&obs);
                            for (x, &(la, lo)) in v.iter_mut().zip(pts) {
                                if !x.is_finite() {
                                    *x = idx.nearest(&obs, la, lo, 40.0).map(|(o, _)| o.temp).unwrap_or(f32::NAN);
                                }
                            }
                        }
                    }
                    return Ok(v);
                }
                Err(e) => err = e,
            }
        }
        // METAR fallback: nearest station within 40 km
        let obs = self.grids.metars_at(hour).await.map(|x| x.2).map_err(|e| err.context(e))?;
        let idx = ObsIndex::new(&obs);
        Ok(pts.iter().map(|&(la, lo)| idx.nearest(&obs, la, lo, 40.0).map(|(o, _)| o.temp).unwrap_or(f32::NAN)).collect())
    }
}

/// Inside the MRMS CONUS grid (20–55° N, 130–60° W).
pub fn in_mrms_domain(lat: f64, lon: f64) -> bool {
    (20.0..=55.0).contains(&lat) && (-130.0..=-60.0).contains(&lon)
}

/// Roughly inside the OPERA composite (Europe).
pub fn in_opera_domain(lat: f64, lon: f64) -> bool {
    (31.0..=73.0).contains(&lat) && (-32.0..=46.0).contains(&lon)
}

/// OPERA layer standing in for an MRMS field outside the US.
pub fn opera_layer(field: &str) -> Option<&'static str> {
    match field {
        "cref" | "cref1h" => Some("opera_dbzh"),
        "prate" => Some("opera_rate"),
        _ => None,
    }
}

/// HRRR forecast length of a cycle.
pub fn hrrr_max_fh(init: i64) -> u32 {
    if init.rem_euclid(6 * 3_600_000) == 0 { 48 } else { 18 }
}

/// "a-b hour acc fcst" → (a, b).
pub fn parse_acc(s: &str) -> Option<(u32, u32)> {
    let w = s.split_whitespace().next()?;
    let (a, b) = w.split_once('-')?;
    let mult = if s.contains(" day ") { 24 } else if s.contains(" hour ") { 1 } else { return None };
    Some((a.parse::<u32>().ok()? * mult, b.parse::<u32>().ok()? * mult))
}

/// Rings (km, points) covering a radius: centre plus up to three rings.
pub fn radius_rings(r_km: f64) -> Vec<(f64, usize)> {
    if r_km <= 0.0 {
        return vec![];
    }
    if r_km <= 8.0 {
        return vec![(r_km, 8)];
    }
    vec![(r_km / 3.0, 8), (r_km * 2.0 / 3.0, 12), (r_km, 16)]
}

/// Each point followed by its ring points (rings of (radius km, count)).
pub fn stencil(pts: &[(f64, f64)], rings: &[(f64, usize)]) -> Vec<(f64, f64)> {
    let per = 1 + rings.iter().map(|r| r.1).sum::<usize>();
    let mut q = Vec::with_capacity(pts.len() * per);
    for &(la, lo) in pts {
        q.push((la, lo));
        let c = la.to_radians().cos().max(0.2);
        for &(r, k) in rings {
            for j in 0..k {
                let a = (j as f64 / k as f64) * std::f64::consts::TAU;
                q.push((la + a.cos() * r / 111.0, lo + a.sin() * r / 111.0 / c));
            }
        }
    }
    q
}

/// US Drought Monitor GeoJSON → (class, outer ring) polygons.
pub fn parse_usdm(txt: &str) -> Vec<(i8, Vec<[f32; 2]>)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(txt) else { return vec![] };
    let mut out = vec![];
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let c = p["DM"].as_i64().or_else(|| p["dm"].as_i64()).or_else(|| p["DM"].as_str().and_then(|s| s.parse().ok())).unwrap_or(-1) as i8;
        if c < 0 {
            continue;
        }
        let g = &f["geometry"];
        let polys: Vec<&serde_json::Value> = match g["type"].as_str() {
            Some("Polygon") => vec![&g["coordinates"]],
            Some("MultiPolygon") => g["coordinates"].as_array().map(|a| a.iter().collect()).unwrap_or_default(),
            _ => vec![],
        };
        for poly in polys {
            if let Some(ring) = poly[0].as_array() {
                let r: Vec<[f32; 2]> = ring.iter().filter_map(|c| Some([c[0].as_f64()? as f32, c[1].as_f64()? as f32])).collect();
                if r.len() >= 3 {
                    out.push((c, r));
                }
            }
        }
    }
    out
}

/// Spatial bucket index of METAR observations (1° cells).
struct ObsIndex {
    cells: HashMap<(i32, i32), Vec<usize>>,
}

impl ObsIndex {
    fn new(obs: &[crate::grid::metar::Obs]) -> Self {
        let mut cells: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        for (i, o) in obs.iter().enumerate() {
            if o.temp.is_finite() {
                cells.entry((o.lat.floor() as i32, o.lon.floor() as i32)).or_default().push(i);
            }
        }
        ObsIndex { cells }
    }
    fn nearest<'a>(&self, obs: &'a [crate::grid::metar::Obs], lat: f64, lon: f64, max_km: f64) -> Option<(&'a crate::grid::metar::Obs, f64)> {
        let r = (max_km / 111.0).ceil() as i32 + 1;
        let (ci, cj) = (lat.floor() as i32, lon.floor() as i32);
        let mut best: Option<(usize, f64)> = None;
        for di in -r..=r {
            for dj in -r * 2..=r * 2 {
                let Some(v) = self.cells.get(&(ci + di, cj + dj)) else { continue };
                for &k in v {
                    let o = &obs[k];
                    let d = crate::radar::geom::bearing_dist(lat, lon, o.lat as f64, o.lon as f64).1 / 1000.0;
                    if d <= max_km && best.map(|b| d < b.1).unwrap_or(true) {
                        best = Some((k, d));
                    }
                }
            }
        }
        best.map(|(k, d)| (&obs[k], d))
    }
}

fn iem_ts(t: i64) -> String {
    chrono::DateTime::from_timestamp_millis(t).map(|d| d.format("%Y-%m-%dT%H:%MZ").to_string()).unwrap_or_default()
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

impl Fetch for NetSource {
    fn sites(&self) -> Vec<Site> {
        (self.sites_fn)()
    }

    fn list_day<'a>(&'a self, site: &'a str, day: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
        Box::pin(async move {
            let v = self.radar.list_day(site, day.year(), day.month(), day.day()).await?;
            Ok(v.into_iter().filter(|e| l2_time_from_name(&e.key).is_some() || e.key.starts_with("aws:")).collect())
        })
    }

    fn latest<'a>(&'a self, site: &'a str) -> Bf<'a, Option<VolEntry>> {
        Box::pin(async move {
            let now = Utc::now().timestamp_millis();
            let a = self.radar.latest(site, 1).await.ok().and_then(|mut v| v.pop());
            let fresh = a.as_ref().map(|e| now - e.time < 20 * 60_000).unwrap_or(false);
            if fresh {
                return Ok(a);
            }
            // TDWRs (and late archive uploads): the real-time chunks bucket
            match self.chunks_latest(site).await {
                Ok(Some(c)) if a.as_ref().map(|e| c.time > e.time).unwrap_or(true) => Ok(Some(c)),
                _ => Ok(a),
            }
        })
    }

    fn volume<'a>(&'a self, key: &'a str) -> Bf<'a, Arc<Volume>> {
        Box::pin(async move {
            if key.starts_with("chunks:") {
                return self.chunks_volume(key).await;
            }
            let raw = self.radar.raw(key).await?;
            self.decode_volume(raw, key).await
        })
    }

    fn prefetch<'a>(&'a self, key: &'a str) -> Bf<'a, ()> {
        Box::pin(async move {
            if key.starts_with("aws:") {
                // the radar service keeps raw files in its disk cache
                self.radar.raw(key).await?;
            }
            Ok(())
        })
    }

    fn raw<'a>(&'a self, key: &'a str) -> Bf<'a, Bytes> {
        Box::pin(async move {
            if key.starts_with("chunks:") {
                return self.chunks_raw(key).await;
            }
            self.radar.raw(key).await
        })
    }

    fn set_decode_threads(&self, n: usize) {
        self.decode.resize(n.max(1));
    }

    fn spc<'a>(&'a self, kind: &'a str, years: (i32, i32)) -> Bf<'a, Vec<Event>> {
        Box::pin(self.spc_kind(kind, years))
    }

    fn lsr<'a>(&'a self, t0: i64, t1: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(self.lsr_range(t0, t1))
    }

    fn sbw<'a>(&'a self, t0: i64, t1: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async move {
            let week = 7 * 86_400_000;
            let mut out = vec![];
            let mut a = t0;
            let now = Utc::now().timestamp_millis();
            while a < t1 {
                let b = (a + week).min(t1);
                let path = self.label_dir.join(format!("sbw_{a}_{b}.json.zst"));
                let cached: Option<Vec<Event>> = std::fs::read(&path).ok().and_then(|z| zstd::decode_all(&z[..]).ok()).and_then(|d| serde_json::from_slice(&d).ok());
                let ev = match cached {
                    Some(v) => v,
                    None => {
                        let j = self.iem_json(&format!("https://mesonet.agron.iastate.edu/geojson/sbw.geojson?sts={}&ets={}", iem_ts(a), iem_ts(b))).await?;
                        let ev = labels::parse_sbw(&j);
                        if b < now - 3 * 86_400_000 {
                            if let Ok(z) = zstd::encode_all(&serde_json::to_vec(&ev).unwrap_or_default()[..], 3) {
                                crate::platform::write_atomic(&path, &z).ok();
                            }
                        }
                        ev
                    }
                };
                out.extend(ev);
                a = b;
            }
            Ok(out)
        })
    }

    fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
        Box::pin(self.load_storms())
    }

    fn fires(&self, day: NaiveDate) -> Bf<'_, Vec<Event>> {
        Box::pin(async move {
            let (y, m, ymd) = (day.format("%Y"), day.format("%m"), day.format("%Y%m%d"));
            let url = format!("https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Fire_Points/Text/{y}/{m}/hms_fire{ymd}.txt");
            let t = self.cached_text(&format!("hms_fire{ymd}.txt"), &url).await?;
            Ok(labels::parse_hms(&t))
        })
    }

    fn env<'a>(&'a self, s: &'a Sources, t: i64, pts: &'a [(f64, f64)], realtime: bool) -> Bf<'a, Vec<FeatMap>> {
        self.env_ctx(s, EnvCtx { t, win: None }, pts, realtime)
    }

    fn env_ctx<'a>(&'a self, s: &'a Sources, ctx: EnvCtx, pts: &'a [(f64, f64)], realtime: bool) -> Bf<'a, Vec<FeatMap>> {
        Box::pin(async move {
            let t = ctx.t;
            let mut out = vec![FeatMap::default(); pts.len()];
            if pts.is_empty() {
                return Ok(out);
            }
            let (mut tried, mut errs) = (0, vec![]);
            for m in &s.mrms {
                if mrms_product(m).is_none() {
                    continue;
                }
                tried += 1;
                if let Err(e) = self.mrms_env(m, t, pts, realtime, &mut out).await {
                    errs.push(format!("MRMS {m}: {e:#}"));
                }
            }
            if s.metar {
                tried += 1;
                if let Err(e) = self.metar_env(t, pts, realtime, &mut out).await {
                    errs.push(format!("METAR: {e:#}"));
                }
            }
            if !s.model.is_empty() {
                tried += 1;
                if let Err(e) = self.gfs_env(&s.model, t, pts, realtime, &mut out).await {
                    errs.push(format!("GFS: {e:#}"));
                }
            }
            if !s.hrrr.is_empty() {
                tried += 1;
                if let Err(e) = self.hrrr_env(&s.hrrr, t, pts, realtime, &mut out).await {
                    errs.push(format!("HRRR: {e:#}"));
                }
            }
            if !s.fcst.is_empty() {
                tried += 1;
                if let Err(e) = self.fcst_env(s, ctx, pts, realtime, &mut out).await {
                    errs.push(format!("forecast: {e:#}"));
                }
            }
            if !s.satellite.is_empty() {
                tried += 1;
                if let Err(e) = self.sat_env(&s.satellite, t, pts, realtime, &mut out).await {
                    errs.push(format!("GOES: {e:#}"));
                }
            }
            if s.other.iter().any(|o| o == "drought") {
                tried += 1;
                if let Err(e) = self.drought_env(t, pts, &mut out).await {
                    errs.push(format!("drought: {e:#}"));
                }
            }
            if !errs.is_empty() {
                tracing::debug!("ml env at {t}: {}", errs.join("; "));
                // every source failed: report it (partial results are still useful)
                if errs.len() == tried {
                    bail!("{}", errs.join("; "));
                }
            }
            Ok(out)
        })
    }

    fn truth<'a>(&'a self, req: &'a TruthReq, pts: &'a [(f64, f64)]) -> Bf<'a, Vec<f32>> {
        Box::pin(self.truth_values(req, pts))
    }

    fn pred_sink(&self) -> Option<Arc<dyn super::predict::PredSink>> {
        Some(self.grids.clone())
    }

    fn cache_bytes(&self) -> (usize, usize) {
        let g = self.raw.lock();
        (g.bytes, g.map.len())
    }

    fn clear_cache(&self) {
        let mut g = self.raw.lock();
        g.map.clear();
        g.bytes = 0;
        drop(g);
        self.listings.lock().clear();
        self.spc_cache.lock().clear();
        *self.storms_cache.lock() = None;
        self.glm.lock().clear();
        self.usdm.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_lru_caps_and_chunk_times() {
        let mut l = BytesLru::new(10);
        l.put("a".into(), Bytes::from_static(b"123456"));
        l.put("b".into(), Bytes::from_static(b"123456"));
        assert!(l.get("a").is_none() && l.get("b").is_some());
        assert_eq!(l.bytes, 6);
        assert_eq!(chunk_time("TORD/185/20240506-201530-001-S"), Some(Utc.with_ymd_and_hms(2024, 5, 6, 20, 15, 30).unwrap().timestamp_millis()));
        assert_eq!(iem_ts(Utc.with_ymd_and_hms(2024, 5, 6, 20, 15, 30).unwrap().timestamp_millis()), "2024-05-06T20:15Z");
        assert_eq!(parse_acc("0-6 hour acc fcst"), Some((0, 6)));
        assert_eq!(parse_acc("5-6 hour acc fcst"), Some((5, 6)));
        assert_eq!(parse_acc("0-1 day acc fcst"), Some((0, 24)));
        assert_eq!(parse_acc("6 hour fcst"), None);
        let st = stencil(&[(35.0, -97.0)], &radius_rings(40.0));
        assert_eq!(st.len(), 37);
        let far = st.iter().map(|p| crate::radar::geom::bearing_dist(35.0, -97.0, p.0, p.1).1 / 1000.0).fold(0.0, f64::max);
        assert!((far - 40.0).abs() < 1.5, "{far}");
        assert_eq!(hrrr_max_fh(Utc.with_ymd_and_hms(2024, 5, 6, 12, 0, 0).unwrap().timestamp_millis()), 48);
        assert_eq!(hrrr_max_fh(Utc.with_ymd_and_hms(2024, 5, 6, 13, 0, 0).unwrap().timestamp_millis()), 18);
        let u = parse_usdm(r#"{"features":[{"properties":{"DM":2},"geometry":{"type":"Polygon","coordinates":[[[-100,30],[-90,30],[-90,40],[-100,40],[-100,30]]]}}]}"#);
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].0, 2);
    }
}
