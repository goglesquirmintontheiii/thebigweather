//! Data access for training and inference behind one trait, so tests can inject synthetic data.
//! [`NetSource`] is the real implementation: Level II archive / chunks, SPC / IEM / NHC / HMS
//! label databases and MRMS / METAR / GFS environment sampling.

use super::features::{model_var, FeatMap, Sources, VarKind, MRMS_FIELDS};
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
    /// Bytes held in memory caches (bytes, items).
    fn cache_bytes(&self) -> (usize, usize) {
        (0, 0)
    }
    fn clear_cache(&self) {}
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
    decode: Arc<tokio::sync::Semaphore>,
    iem_gate: tokio::sync::Mutex<Option<Instant>>,
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
            decode: Arc::new(tokio::sync::Semaphore::new(decode_threads.max(1))),
            iem_gate: tokio::sync::Mutex::new(None),
        }
    }

    pub fn set_mem(&self, mem_mb: usize) {
        let mut g = self.raw.lock();
        g.cap = mem_mb.clamp(32, 512) << 20;
    }

    async fn get(&self, url: &str, range: Option<(u64, Option<u64>)>) -> Result<Bytes> {
        let ck = format!("{url}#{range:?}");
        if let Some(b) = self.raw.lock().get(&ck) {
            return Ok(b);
        }
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
        self.raw.lock().put(ck, b.clone());
        Ok(b)
    }

    /// IEM asks for ~1 request/s per client.
    async fn iem_json(&self, url: &str) -> Result<serde_json::Value> {
        {
            let mut g = self.iem_gate.lock().await;
            if let Some(t) = *g {
                let wait = Duration::from_millis(1100).saturating_sub(t.elapsed());
                tokio::time::sleep(wait).await;
            }
            *g = Some(Instant::now());
        }
        let r = self.http.get(url).timeout(Duration::from_secs(120)).send().await?;
        if !r.status().is_success() {
            bail!("{url}: HTTP {}", r.status());
        }
        Ok(r.json().await?)
    }

    /// Text file cached on disk (immutable historical files).
    async fn cached_text(&self, name: &str, url: &str) -> Result<String> {
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
        if let Ok(z) = zstd::encode_all(&b[..], 9) {
            crate::platform::write_atomic(&path, &z).ok();
        }
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    /// Sorted (time, key) of an S3 prefix, cached (refreshed after `max_age`).
    async fn listing(&self, bucket: &str, prefix: &str, max_age: Duration, parse: fn(&str) -> Option<i64>) -> Result<Arc<Vec<(i64, String)>>> {
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
        let _p = self.decode.clone().acquire_owned().await?;
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
            parts.push(crate::s3::get(&self.http, bucket, k).await?);
        }
        let _p = self.decode.clone().acquire_owned().await?;
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
                            if errs > 5 {
                                return Err(e);
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

    async fn mrms_key(&self, product: &str, t: i64, realtime: bool) -> Result<Option<String>> {
        let parse = |k: &str| -> Option<i64> {
            let stem = k.rsplit('_').next()?.trim_end_matches(".grib2.gz");
            chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d-%H%M%S").ok().map(|d| d.and_utc().timestamp_millis())
        };
        let d = chrono::DateTime::from_timestamp_millis(t).ok_or_else(|| anyhow!("bad time"))?;
        let mut best: Option<(i64, String)> = None;
        for back in 0..2 {
            let dd = d - chrono::Duration::minutes(15 * back);
            if back == 1 && dd.day() == d.day() {
                break;
            }
            let prefix = format!("CONUS/{product}/{}/", dd.format("%Y%m%d"));
            let max_age = if realtime { Duration::from_secs(90) } else { Duration::from_secs(86400) };
            let l = self.listing(crate::grid::sources::MRMS_BUCKET, &prefix, max_age, parse).await?;
            for (ot, k) in l.iter() {
                if *ot <= t + 60_000 && t - ot <= 12 * 60_000 && best.as_ref().map(|b| *ot > b.0).unwrap_or(true) {
                    best = Some((*ot, k.clone()));
                }
            }
        }
        Ok(best.map(|b| b.1))
    }

    async fn mrms_env(&self, field: &str, t: i64, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let layer = crate::grid::sources::mrms_layers().into_iter().find(|l| l.id == format!("mrms/{field}")).ok_or_else(|| anyhow!("unknown MRMS field"))?;
        let key = self.mrms_key(&layer.product, t, realtime).await?.ok_or_else(|| anyhow!("no {} file near this time", layer.product))?;
        let b = self.get(&crate::s3::object_url(crate::grid::sources::MRMS_BUCKET, &key), None).await?;
        // stencil: centre + 8 points 4 km away → max
        let ring: Vec<(f64, f64)> = (0..8).map(|k| ((k as f64 * 45.0).to_radians().cos() * 0.036, (k as f64 * 45.0).to_radians().sin() * 0.036)).collect();
        let mut q = Vec::with_capacity(pts.len() * 9);
        for &(la, lo) in pts {
            q.push((la, lo));
            for (dy, dx) in &ring {
                q.push((la + dy, lo + dx / la.to_radians().cos().max(0.2)));
            }
        }
        let opts = crate::grid::decode::DecodeOpts { nodata: layer.nodata.clone(), min_valid: layer.min_valid, transform: layer.transform, max_dim: 0 };
        let _p = self.decode.clone().acquire_owned().await?;
        let vals = tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
            let raw = crate::grid::decode::maybe_gunzip(&b)?;
            Ok(crate::grid::decode::decode_at(&raw, &opts, &q)?.0)
        })
        .await??;
        let id = format!("mrms_{field}");
        for (i, fm) in out.iter_mut().enumerate() {
            let v = vals[i * 9..(i + 1) * 9].iter().copied().filter(|x| x.is_finite()).fold(f32::NAN, f32::max);
            // no echo / below the product floor counts as 0 for these fields
            fm.set(&id, if v.is_finite() { v } else { 0.0 });
        }
        Ok(())
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

    /// GFS f000 file of the 6-hourly cycle at or before `t` (newest available when `realtime`).
    async fn gfs_idx(&self, t: i64, realtime: bool) -> Result<(String, Arc<IdxRows>)> {
        let c0 = t.div_euclid(6 * 3_600_000) * 6 * 3_600_000;
        let tries = if realtime { 4 } else { 1 };
        let mut last = anyhow!("no GFS analysis");
        for k in 0..tries {
            let c = chrono::DateTime::from_timestamp_millis(c0 - k * 6 * 3_600_000).unwrap();
            let ymd = c.format("%Y%m%d").to_string();
            let hh = c.hour();
            // layout since GFS v16 (2021-03), then the older one
            for path in [format!("gfs.{ymd}/{hh:02}/atmos/gfs.t{hh:02}z.pgrb2.0p25.f000"), format!("gfs.{ymd}/{hh:02}/gfs.t{hh:02}z.pgrb2.0p25.f000")] {
                let url = crate::s3::object_url(GFS_BUCKET, &path);
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
        }
        Err(last)
    }

    async fn gfs_field(&self, url: &str, idx: &IdxRows, pat: &str, pts: Arc<Vec<(f64, f64)>>) -> Result<Vec<f32>> {
        let range = crate::grid::sources::find_ncep(idx, pat, 0, false).ok_or_else(|| anyhow!("{pat} not in GFS"))?;
        let b = self.get(url, Some(range)).await?;
        let _p = self.decode.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
            let opts = crate::grid::decode::DecodeOpts { nodata: vec![], min_valid: None, transform: crate::grid::decode::Transform::None, max_dim: 0 };
            Ok(crate::grid::decode::decode_at(&b, &opts, &pts)?.0)
        })
        .await?
    }

    async fn gfs_env(&self, vars: &[String], t: i64, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let (url, idx) = self.gfs_idx(t, realtime).await?;
        let pts = Arc::new(pts.to_vec());
        let mut fields: HashMap<&'static str, Vec<f32>> = HashMap::new();
        let mut errs = vec![];
        for id in vars {
            let Some(v) = model_var(id) else { continue };
            for p in v.pats {
                if !fields.contains_key(p) {
                    match self.gfs_field(&url, &idx, p, pts.clone()).await {
                        Ok(x) => {
                            fields.insert(p, x);
                        }
                        Err(e) => errs.push(format!("{p}: {e:#}")),
                    }
                }
            }
            let get = |k: usize| v.pats.get(k).and_then(|p| fields.get(p));
            let fid = format!("gfs_{}", v.id);
            for (i, fm) in out.iter_mut().enumerate() {
                let a = |k: usize| get(k).map(|f| f[i]).unwrap_or(f32::NAN);
                let val = match v.kind {
                    VarKind::Plain => a(0),
                    VarKind::KToC => a(0) - 273.15,
                    VarKind::PaToHpa => a(0) / 100.0,
                    VarKind::Times1e5 => a(0) * 1e5,
                    VarKind::Speed => (a(0).powi(2) + a(1).powi(2)).sqrt(),
                    VarKind::Shear => ((a(2) - a(0)).powi(2) + (a(3) - a(1)).powi(2)).sqrt(),
                };
                fm.set(&fid, val);
            }
        }
        if fields.is_empty() && !errs.is_empty() {
            bail!("{}", errs.join("; "));
        }
        Ok(())
    }
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
        Box::pin(async move {
            let mut out = vec![FeatMap::default(); pts.len()];
            if pts.is_empty() {
                return Ok(out);
            }
            let (mut tried, mut errs) = (0, vec![]);
            for m in &s.mrms {
                if !MRMS_FIELDS.iter().any(|f| f.0 == m) {
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
    }
}
