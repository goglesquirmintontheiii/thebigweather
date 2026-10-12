//! Gridded data service: frame listing, downloading, decoding, caching and viewport rendering.

use super::decode::{self, maybe_gunzip, DecodeOpts, MessageInfo};
use super::metar::{self, Obs};
use super::sources::{self, LayerDef, Match};
use super::rgb::{self, RgbImage};
use super::{encode_raster, goes, Grid};
use crate::health::Health;
use crate::s3;
use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use chrono::{Datelike, TimeZone, Timelike, Utc};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Serialize)]
pub struct FrameInfo {
    pub key: String,
    pub time: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunInfo {
    pub id: String,
    pub time: i64,
    pub fhs: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct FramesResp {
    pub frames: Vec<FrameInfo>,
    pub runs: Vec<RunInfo>,
    pub run: Option<String>,
    pub storms: Vec<String>,
    pub storm: Option<String>,
}

struct SizedLru {
    map: lru::LruCache<String, (Arc<Grid>, usize)>,
    bytes: usize,
    cap: usize,
}
impl SizedLru {
    fn get(&mut self, k: &str) -> Option<Arc<Grid>> {
        self.map.get(k).map(|(g, _)| g.clone())
    }
    fn put(&mut self, k: String, g: Arc<Grid>) {
        let n = g.bytes();
        if let Some((_, s)) = self.map.put(k, (g, n)) {
            self.bytes -= s;
        }
        self.bytes += n;
        while self.bytes > self.cap {
            match self.map.pop_lru() {
                Some((_, (_, s))) => self.bytes -= s,
                None => break,
            }
        }
    }
}

pub struct GridService {
    http: reqwest::Client,
    health: Arc<Health>,
    pub layers: Vec<LayerDef>,
    cache_dir: PathBuf,
    grids: Mutex<SizedLru>,
    listings: Mutex<HashMap<String, (Instant, Arc<Vec<s3::Object>>)>>,
    texts: Mutex<HashMap<String, (Instant, Arc<String>)>>,
    ndfd: tokio::sync::Mutex<HashMap<String, (Instant, i64, Bytes, Vec<MessageInfo>)>>,
    metar: RwLock<VecDeque<(i64, Arc<Vec<Obs>>)>>,
    metar_keep: usize,
    sem: Arc<Semaphore>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    max_dim_mrms: usize,
    max_dim_goes: usize,
    rgbs: Mutex<(lru::LruCache<String, (Arc<RgbImage>, usize)>, usize, usize)>, // (cache, bytes, cap)
    /// MRMS 3D cubes (header + voxels), byte-capped
    cubes: Mutex<(lru::LruCache<String, Bytes>, usize, usize)>,
    /// /api/grid/wind responses (short-lived, byte-capped): key → (made, body)
    winds: Mutex<(lru::LruCache<String, (Instant, Bytes)>, usize)>,
    /// optional folder of local files used as frames (offline use / case studies):
    /// files are named "<layer id with / as _>__<original name>"
    pub local_dir: RwLock<Option<PathBuf>>,
}

fn safe(k: &str) -> String {
    k.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn ymd(t: chrono::DateTime<Utc>) -> String {
    format!("{:04}{:02}{:02}", t.year(), t.month(), t.day())
}

/// Link targets in an HTML directory index.
fn hrefs(html: &str) -> impl Iterator<Item = &str> {
    html.split("href=\"").skip(1).filter_map(|s| s.split('"').next())
}

/// Forecast hours of one run from a directory listing: MSC lists one "HHH/" directory per
/// forecast hour; DWD lists files named "..._{YYYYMMDDHH}_{HHH}_{FIELD}.grib2.bz2".
fn listing_fhs(index: &str, html: &str, ymd: &str, hh: u32) -> Vec<u32> {
    let stamp = format!("_{ymd}{hh:02}_");
    let mut fhs: Vec<u32> = hrefs(html)
        .filter_map(|h| {
            let name = h.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            if index == "msc" {
                (name.len() == 3 && h.ends_with('/')).then(|| name.parse().ok()).flatten()
            } else {
                let p = name.find(&stamp)? + stamp.len();
                name.get(p..p + 3)?.parse().ok()
            }
        })
        .collect();
    fhs.sort_unstable();
    fhs.dedup();
    fhs
}

/// Header + interleaved u8 U/V for /api/grid/wind (see `GridService::wind`).
pub fn encode_wind(hdr: &serde_json::Value, uv: &[u8]) -> Vec<u8> {
    let h = serde_json::to_vec(hdr).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + h.len() + uv.len());
    out.extend_from_slice(&(h.len() as u32).to_le_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(uv);
    out
}

/// Pick the (run, forecast hour) whose valid time is nearest `t`; ties go to the newer run.
/// `runs` is newest first: (id, run time ms, forecast hours).
pub fn nearest_step(runs: &[(String, i64, Vec<u32>, Vec<String>)], t: i64) -> Option<(String, i64, u32)> {
    let mut best: Option<(i64, String, i64, u32)> = None;
    for (id, rt, fhs, _) in runs {
        for &fh in fhs {
            let d = (rt + fh as i64 * 3_600_000 - t).abs();
            if best.as_ref().map(|b| d < b.0).unwrap_or(true) {
                best = Some((d, id.clone(), *rt, fh));
            }
        }
    }
    best.map(|b| (b.1, b.2, b.3))
}

impl GridService {
    pub fn new(http: reqwest::Client, health: Arc<Health>, data_dir: &std::path::Path, memory_mb: usize, threads: usize, full: bool) -> Arc<Self> {
        let cache_dir = data_dir.join("cache/raw");
        std::fs::create_dir_all(&cache_dir).ok();
        Arc::new(Self {
            http,
            health,
            layers: sources::all_layers(),
            cache_dir,
            // 70% decoded grids, 30% RGB composites
            grids: Mutex::new(SizedLru { map: lru::LruCache::unbounded(), bytes: 0, cap: memory_mb * 1024 * 1024 * 7 / 10 }),
            listings: Mutex::new(HashMap::new()),
            texts: Mutex::new(HashMap::new()),
            ndfd: tokio::sync::Mutex::new(HashMap::new()),
            metar: RwLock::new(VecDeque::new()),
            metar_keep: if full { 18 } else { 6 },
            sem: Arc::new(Semaphore::new(threads.max(1))),
            inflight: Mutex::new(HashMap::new()),
            max_dim_mrms: if full { 7000 } else { 3500 },
            max_dim_goes: if full { 5424 } else { 2712 },
            rgbs: Mutex::new((lru::LruCache::unbounded(), 0, memory_mb * 1024 * 1024 * 3 / 10)),
            cubes: Mutex::new((lru::LruCache::unbounded(), 0, (memory_mb * 1024 * 1024 / 8).clamp(16 << 20, 64 << 20))),
            winds: Mutex::new((lru::LruCache::unbounded(), 0)),
            local_dir: RwLock::new(None),
        })
    }

    pub fn layer(&self, id: &str) -> Result<&LayerDef> {
        self.layers.iter().find(|l| l.id == id).ok_or_else(|| anyhow!("unknown layer {id}"))
    }

    pub fn catalog(&self) -> serde_json::Value {
        serde_json::json!({
            "layers": self.layers,
            "models": sources::MODELS.iter().filter(|m| m.group != "Hidden").collect::<Vec<_>>(),
        })
    }

    // ---------- fetch helpers ----------

    async fn list_cached(&self, bucket: &str, prefix: &str, ttl: u64) -> Result<Arc<Vec<s3::Object>>> {
        self.list_cached_at(&format!("https://{bucket}.s3.amazonaws.com"), prefix, ttl).await
    }

    /// Cached listing at any S3-compatible bucket URL.
    async fn list_cached_at(&self, base: &str, prefix: &str, ttl: u64) -> Result<Arc<Vec<s3::Object>>> {
        let k = format!("{base}/{prefix}");
        if let Some((t, v)) = self.listings.lock().get(&k) {
            if t.elapsed() < Duration::from_secs(ttl) {
                return Ok(v.clone());
            }
        }
        let l = s3::list_at(&self.http, base, prefix, None, None, 10).await?;
        let v = Arc::new(l.objects);
        let mut m = self.listings.lock();
        if m.len() > 300 {
            m.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(900));
        }
        m.insert(k, (Instant::now(), v.clone()));
        Ok(v)
    }

    async fn text_cached(&self, url: &str, ttl: u64) -> Result<Arc<String>> {
        if let Some((t, v)) = self.texts.lock().get(url) {
            if t.elapsed() < Duration::from_secs(ttl) {
                return Ok(v.clone());
            }
        }
        let r = self.http.get(url).send().await?;
        if !r.status().is_success() {
            bail!("HTTP {} for {url}", r.status());
        }
        let v = Arc::new(r.text().await?);
        let mut m = self.texts.lock();
        if m.len() > 400 {
            m.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(600));
        }
        m.insert(url.to_string(), (Instant::now(), v.clone()));
        Ok(v)
    }

    /// GET (optionally a byte range) with an on-disk cache for immutable objects.
    async fn fetch(&self, url: &str, range: Option<(u64, Option<u64>)>, cache: bool) -> Result<Bytes> {
        let ck = match range {
            Some((a, b)) => format!("{url}#{a}-{}", b.map(|x| x.to_string()).unwrap_or_default()),
            None => url.to_string(),
        };
        let path = self.cache_dir.join(safe(&ck));
        if cache {
            if let Ok(b) = tokio::fs::read(&path).await {
                return Ok(Bytes::from(b));
            }
        }
        let mut req = self.http.get(url);
        if let Some((a, b)) = range {
            let hdr = match b {
                Some(end) => format!("bytes={a}-{}", end - 1),
                None => format!("bytes={a}-"),
            };
            req = req.header(reqwest::header::RANGE, hdr);
        }
        let r = req.send().await?;
        if !r.status().is_success() {
            bail!("HTTP {} for {url}", r.status());
        }
        let b = r.bytes().await?;
        if cache {
            let tmp = path.with_extension("part");
            if tokio::fs::write(&tmp, &b).await.is_ok() {
                let _ = tokio::fs::rename(&tmp, &path).await;
            }
        }
        Ok(b)
    }

    // ---------- frames ----------

    pub async fn frames(&self, layer_id: &str, n: usize, run: Option<&str>, storm: Option<&str>, end: Option<i64>) -> Result<FramesResp> {
        let end = end.and_then(chrono::DateTime::from_timestamp_millis).filter(|t| *t < Utc::now());
        let l = self.layer(layer_id)?.clone();
        if let Some(local) = self.local_frames(&l) {
            return Ok(local);
        }
        let res = match l.source {
            "mrms" => self.mrms_frames(&l, n, end).await,
            "model" => self.model_frames(&l, run, storm).await,
            "ndfd" => self.ndfd_frames(&l).await,
            "metar" => Ok(self.metar_frames(&l, n)),
            "goes" => self.goes_frames(&l, n, end).await,
            "future" => self.future_frames(&l).await,
            "opera" => self.opera_frames(&l, n, end).await,
            "cwa" => self.cwa_frames(&l, n, end).await,
            _ => bail!("unknown source"),
        };
        let name = match l.source {
            "opera" => "OPERA European radar (EUMETNET)",
            "cwa" => "Taiwan CWA radar",
            "mrms" => "MRMS",
            "model" => "Models",
            "ndfd" => "NDFD",
            "metar" => "METAR analysis",
            "future" => "Future radar / snow",
            _ => "GOES satellite",
        };
        match &res {
            Ok(_) => self.health.ok(&format!("grid-{}", l.source), name, ""),
            Err(e) => self.health.err(&format!("grid-{}", l.source), name, e),
        }
        res
    }

    fn local_frames(&self, l: &LayerDef) -> Option<FramesResp> {
        let dir = self.local_dir.read().clone()?;
        let prefix = format!("{}__", l.id.replace('/', "_"));
        let mut names: Vec<String> = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with(&prefix)).collect();
        if names.is_empty() {
            return None;
        }
        names.sort();
        let mut frames = vec![];
        for n in names {
            let path = dir.join(&n);
            if l.source == "ndfd" {
                let b = std::fs::read(&path).ok()?;
                for m in decode::list_messages(&b).ok()? {
                    frames.push(FrameInfo { key: format!("local|{}|{}|{}", l.id, n, m.index), time: m.valid_ms, label: String::new() });
                }
            } else {
                let t = goes::time_from_name(&n).or_else(|| super::intl::opera_parse(n.split("__").last().unwrap_or("")).map(|x| x.0)).or_else(|| super::intl::cwa_time(n.split("__").last().unwrap_or(""))).or_else(|| {
                    let stem = n.rsplit('_').next()?.split('.').next()?;
                    chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d-%H%M%S").ok().map(|d| d.and_utc().timestamp_millis())
                });
                frames.push(FrameInfo { key: format!("local|{}|{}|0", l.id, n), time: t.unwrap_or(0), label: String::new() });
            }
        }
        frames.sort_by_key(|f| f.time);
        Some(FramesResp { frames, ..Default::default() })
    }

    async fn mrms_frames(&self, l: &LayerDef, n: usize, end: Option<chrono::DateTime<Utc>>) -> Result<FramesResp> {
        let now = end.unwrap_or_else(Utc::now);
        let end_ms = end.map(|t| t.timestamp_millis());
        let mut keys: Vec<s3::Object> = vec![];
        for back in 0..3 {
            let d = now - chrono::Duration::days(back);
            let prefix = format!("CONUS/{}/{}/", l.product, ymd(d));
            let objs = self.list_cached(sources::MRMS_BUCKET, &prefix, 50).await?;
            let mut v: Vec<s3::Object> = objs.iter().cloned().collect();
            v.extend(keys);
            keys = v;
            if keys.len() >= n {
                break;
            }
        }
        keys.retain(|o| o.key.ends_with(".grib2.gz"));
        if let Some(e) = end_ms {
            keys.retain(|o| {
                let stem = o.key.rsplit('_').next().unwrap_or("").trim_end_matches(".grib2.gz");
                chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d-%H%M%S").map(|t| t.and_utc().timestamp_millis() <= e).unwrap_or(false)
            });
        }
        let k = keys.len().saturating_sub(n);
        let frames = keys[k..]
            .iter()
            .filter_map(|o| {
                // MRMS_<product>_YYYYMMDD-HHMMSS.grib2.gz
                let stem = o.key.rsplit('_').next()?.trim_end_matches(".grib2.gz");
                let t = chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d-%H%M%S").ok()?.and_utc().timestamp_millis();
                Some(FrameInfo { key: format!("mrms|{}|{}", l.id, o.key), time: t, label: String::new() })
            })
            .collect();
        Ok(FramesResp { frames, ..Default::default() })
    }

    /// OPERA composites from the rolling 24 h archive (5-min DBZH, 15-min RATE).
    async fn opera_frames(&self, l: &LayerDef, n: usize, end: Option<chrono::DateTime<Utc>>) -> Result<FramesResp> {
        let now = end.unwrap_or_else(Utc::now);
        let end_ms = now.timestamp_millis();
        let mut frames: Vec<FrameInfo> = vec![];
        for back in 0..2 {
            let d = now - chrono::Duration::days(back);
            let prefix = format!("{:04}/{:02}/{:02}/OPERA/COMP/", d.year(), d.month(), d.day());
            let objs = self.list_cached_at(super::intl::OPERA_BASE, &prefix, 60).await?;
            let mut v: Vec<FrameInfo> = objs
                .iter()
                .filter_map(|o| {
                    let (t, p) = super::intl::opera_parse(&o.key)?;
                    (p == l.product && t <= end_ms).then(|| FrameInfo { key: format!("opera|{}|{}", l.id, o.key), time: t, label: String::new() })
                })
                .collect();
            v.extend(frames);
            frames = v;
            if frames.len() >= n {
                break;
            }
        }
        if frames.is_empty() {
            bail!("no OPERA {} files in the last 24 h", l.product);
        }
        frames.sort_by_key(|f| f.time);
        let k = frames.len().saturating_sub(n);
        Ok(FramesResp { frames: frames.split_off(k), ..Default::default() })
    }

    /// Taiwan CWA composite reflectivity (10-min; object names are Taipei local time).
    async fn cwa_frames(&self, l: &LayerDef, n: usize, end: Option<chrono::DateTime<Utc>>) -> Result<FramesResp> {
        let now = end.unwrap_or_else(Utc::now);
        let end_ms = now.timestamp_millis();
        let local = now + chrono::Duration::hours(8);
        let mut frames: Vec<FrameInfo> = vec![];
        for back in 0..3 {
            let d = local - chrono::Duration::days(back);
            let prefix = format!("history/Observation/{:04}{:02}{:02}", d.year(), d.month(), d.day());
            let objs = self.list_cached_at(super::intl::CWA_BASE, &prefix, 60).await?;
            let mut v: Vec<FrameInfo> = objs
                .iter()
                .filter_map(|o| {
                    let t = super::intl::cwa_time(&o.key)?;
                    (t <= end_ms).then(|| FrameInfo { key: format!("cwa|{}|{}", l.id, o.key), time: t, label: String::new() })
                })
                .collect();
            v.extend(frames);
            frames = v;
            if frames.len() >= n {
                break;
            }
        }
        if frames.is_empty() {
            bail!("no CWA radar files found");
        }
        frames.sort_by_key(|f| f.time);
        let k = frames.len().saturating_sub(n);
        Ok(FramesResp { frames: frames.split_off(k), ..Default::default() })
    }

    async fn model_runs(&self, m: &sources::ModelDef) -> Result<Vec<(String, i64, Vec<u32>, Vec<String>)>> {
        self.runs_for(m, m.cycles, 3).await
    }

    /// Recent runs of a model restricted to `cycles`, newest first: (id, run time, forecast hours, storms).
    async fn runs_for(&self, m: &sources::ModelDef, cycles: &[u32], max: usize) -> Result<Vec<(String, i64, Vec<u32>, Vec<String>)>> {
        let now = Utc::now();
        let mut out = vec![];
        let mut tried = 0;
        'outer: for back_h in 0..48 {
            let t = now - chrono::Duration::hours(back_h);
            let hh = t.hour();
            if !m.cycles.contains(&hh) || !cycles.contains(&hh) {
                continue;
            }
            tried += 1;
            if tried > 8 {
                break;
            }
            let d = ymd(t);
            let prefix = sources::fill_template(m.run_prefix, &d, hh, 0, "");
            let (fhs, storms) = if m.index == "msc" || m.index == "dwd" {
                let url = format!("{}/{}", m.bucket, prefix);
                let html = match self.text_cached(&url, 300).await {
                    Ok(h) => h,
                    Err(_) => continue,
                };
                (listing_fhs(m.index, &html, &d, hh), vec![])
            } else if m.index == "ecmwf" {
                let url = format!("{}/{}", m.bucket, prefix);
                let html = match self.text_cached(&url, 300).await {
                    Ok(h) => h,
                    Err(_) => continue,
                };
                let mut fhs: Vec<u32> = html
                    .split("href=\"")
                    .filter_map(|s| s.split('"').next())
                    .filter(|h| h.ends_with("-oper-fc.grib2"))
                    .filter_map(|h| h.rsplit('/').next()?.split('-').nth(1)?.trim_end_matches('h').parse().ok())
                    .collect();
                fhs.sort_unstable();
                fhs.dedup();
                (fhs, vec![])
            } else {
                let objs = match self.list_cached(m.bucket, &prefix, 120).await {
                    Ok(o) => o,
                    Err(_) => continue,
                };
                let mut fhs = vec![];
                let mut storms = vec![];
                for o in objs.iter() {
                    if o.key.ends_with(".idx") {
                        continue;
                    }
                    let name = o.key.rsplit('/').next().unwrap_or("");
                    if m.id.starts_with("hafs") {
                        if !name.contains(".parent.atm.f") {
                            continue;
                        }
                        storms.push(name.split('.').next().unwrap_or("").to_string());
                    }
                    // the forecast hour is the digit run after the last 'f' in the name
                    let fpos = if m.id.starts_with("hafs") { name.rfind(".f").map(|p| p + 1) } else { o.key.strip_prefix(&prefix).map(|_| 0) };
                    let rest = match fpos {
                        Some(p) if m.id.starts_with("hafs") => &name[p + 1..],
                        Some(_) => &o.key[prefix.len()..],
                        None => continue,
                    };
                    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(fh) = digits.parse::<u32>() {
                        // skip other products sharing the prefix (e.g. gfs .f000.idx handled above)
                        let tail = &rest[digits.len()..];
                        if tail.is_empty() || tail.starts_with('.') {
                            fhs.push(fh);
                        }
                    }
                }
                fhs.sort_unstable();
                fhs.dedup();
                storms.sort();
                storms.dedup();
                (fhs, storms)
            };
            if fhs.is_empty() {
                continue;
            }
            let run_t = Utc.with_ymd_and_hms(t.year(), t.month(), t.day(), hh, 0, 0).single().map(|x| x.timestamp_millis()).unwrap_or(0);
            out.push((format!("{d}{hh:02}"), run_t, fhs, storms));
            if out.len() >= max {
                break 'outer;
            }
        }
        if out.is_empty() {
            bail!("no recent {} runs found", m.name);
        }
        Ok(out)
    }

    async fn model_frames(&self, l: &LayerDef, run: Option<&str>, storm: Option<&str>) -> Result<FramesResp> {
        let m = sources::model_def(l.model.as_deref().unwrap_or("")).ok_or_else(|| anyhow!("unknown model"))?;
        let runs = self.model_runs(m).await?;
        // newest run that has at least a few hours out; or the requested one
        let chosen = match run {
            Some(r) => runs.iter().find(|x| x.0 == r).cloned(),
            None => runs.iter().find(|x| x.2.len() >= 3 || runs.len() == 1).cloned().or_else(|| runs.first().cloned()),
        }
        .ok_or_else(|| anyhow!("run not available"))?;
        let storm = storm.map(String::from).or_else(|| chosen.3.first().cloned()).unwrap_or_default();
        let var = sources::var_def(&l.product).ok_or_else(|| anyhow!("unknown variable"))?;
        let frames = chosen
            .2
            .iter()
            .filter(|&&fh| !(var.accum && fh == 0))
            .map(|&fh| FrameInfo {
                key: format!("model|{}|{}|{}|{}|{}", m.id, chosen.0, fh, l.product, storm),
                time: chosen.1 + fh as i64 * 3_600_000,
                label: format!("F{fh:03}"),
            })
            .collect();
        Ok(FramesResp {
            frames,
            runs: runs.iter().map(|r| RunInfo { id: r.0.clone(), time: r.1, fhs: r.2.clone() }).collect(),
            run: Some(chosen.0.clone()),
            storms: chosen.3.clone(),
            storm: if storm.is_empty() { None } else { Some(storm) },
        })
    }

    /// Frames from now to now+horizon from the freshest run that reaches furthest, walking the
    /// model chain until one has the field.
    async fn future_frames(&self, l: &LayerDef) -> Result<FramesResp> {
        let f = sources::future_def(&l.product).ok_or_else(|| anyhow!("unknown future layer"))?;
        let v = sources::var_def(f.var).ok_or_else(|| anyhow!("unknown variable"))?;
        let now = Utc::now().timestamp_millis();
        let end = now + f.horizon_h as i64 * 3_600_000;
        let mut errors = vec![];
        let _ = v.accum;
        for src in f.chain {
            let Some(m) = sources::model_def(src.model) else { continue };
            let sub = src.model == "hrrrsub";
            let runs = match self.runs_for(m, src.cycles, 3).await {
                Ok(r) => r,
                Err(e) => {
                    errors.push(format!("{}: {e}", m.name));
                    continue;
                }
            };
            // furthest-reaching run (ties → newest); in-progress runs count only what's published
            let best = runs.iter().filter(|r| !r.2.is_empty()).max_by_key(|r| ((r.1 + *r.2.iter().max().unwrap() as i64 * 3_600_000).min(end), r.1));
            let Some((run, run_t, fhs, _)) = best else { continue };
            let mut frames = vec![];
            let mut first_fh: Option<u32> = None;
            for (t, key_fh) in sources::future_steps(now, *run_t, fhs, src.step_min, f.horizon_h, sub) {
                let label = {
                    let ahead = (t - now).max(0) as f64 / 3_600_000.0;
                    if ahead < 0.99 { format!("+{}m", (ahead * 60.0).round() as i64) } else { format!("+{}h", ahead.round() as i64) }
                };
                let key = if f.accum_from_now {
                    let fh0 = *first_fh.get_or_insert(key_fh.saturating_sub(1));
                    format!("fdiff|{}|{run}|{key_fh}|{fh0}|{}", m.id, f.var)
                } else {
                    format!("model|{}|{run}|{key_fh}|{}|", m.id, f.var)
                };
                frames.push(FrameInfo { key, time: t, label: format!("{} {label}", m.name) });
            }
            if frames.is_empty() {
                errors.push(format!("{}: run {run} has no hours ahead yet", m.name));
                continue;
            }
            // make sure this model actually carries the field before committing to it
            let probe = frames.last().map(|fr| fr.key.clone()).unwrap_or_default();
            let parts: Vec<&str> = probe.split('|').collect();
            let fh: u32 = parts[3].parse().unwrap_or(0);
            let file_fh = if sub { fh.div_ceil(60) } else { fh };
            let file = sources::fill_template(m.file, &run[..8], run[8..].parse().unwrap_or(0), file_fh, "");
            let idx = match self.text_cached(&format!("{}.idx", s3::object_url(m.bucket, &file)), 3600).await {
                Ok(i) => i,
                Err(e) => {
                    errors.push(format!("{}: {e}", m.name));
                    continue;
                }
            };
            let rows = sources::parse_ncep_idx(&idx);
            let found = match &v.ncep {
                Match::Ncep(pats) => pats.iter().any(|p| if sub { sources::find_ncep_minutes(&rows, p, fh).is_some() } else { sources::find_ncep(&rows, p, fh, v.accum).is_some() }),
                _ => true,
            };
            if !found {
                errors.push(format!("{} has no {}", m.name, v.name));
                continue;
            }
            return Ok(FramesResp {
                frames,
                runs: vec![RunInfo { id: run.clone(), time: *run_t, fhs: fhs.clone() }],
                run: Some(run.clone()),
                storms: vec![],
                storm: None,
            });
        }
        bail!("no model run available ({})", errors.join("; "))
    }

    async fn ndfd_file(&self, elem: &str, vp: &str) -> Result<(i64, Bytes, Vec<MessageInfo>)> {
        let url = format!("{}/VP.{vp}/ds.{elem}.bin", sources::NDFD_BASE);
        let mut m = self.ndfd.lock().await;
        if let Some((t, v, b, msgs)) = m.get(&url) {
            if t.elapsed() < Duration::from_secs(1800) {
                return Ok((*v, b.clone(), msgs.iter().map(|x| MessageInfo { ..*x }).collect()));
            }
        }
        let b = self.fetch(&url, None, false).await?;
        let b2 = b.clone();
        let msgs = tokio::task::spawn_blocking(move || decode::list_messages(&b2)).await??;
        let version = Utc::now().timestamp();
        // keep only fresh NDFD files (each can be tens of MB)
        m.retain(|_, (t, ..)| t.elapsed() < Duration::from_secs(1800));
        while m.len() >= 12 {
            let oldest = m.iter().min_by_key(|(_, (t, ..))| *t).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    m.remove(&k);
                }
                None => break,
            }
        }
        m.insert(url, (Instant::now(), version, b.clone(), msgs.iter().map(|x| MessageInfo { ..*x }).collect()));
        Ok((version, b, msgs))
    }

    async fn ndfd_frames(&self, l: &LayerDef) -> Result<FramesResp> {
        let (elem, ext) = l.product.split_once('|').unwrap_or((&l.product, "0"));
        let mut frames = vec![];
        let mut vps = vec!["001-003"];
        if ext == "1" {
            vps.push("004-007");
        }
        for vp in vps {
            match self.ndfd_file(elem, vp).await {
                Ok((ver, _, msgs)) => {
                    for m in msgs {
                        frames.push(FrameInfo { key: format!("ndfd|{}|{vp}|{}|{ver}", l.id, m.index), time: m.valid_ms, label: String::new() });
                    }
                }
                Err(e) if vp == "004-007" => tracing::debug!("ndfd days 4-7: {e}"),
                Err(e) => return Err(e),
            }
        }
        frames.sort_by_key(|f| f.time);
        frames.dedup_by_key(|f| f.time);
        Ok(FramesResp { frames, ..Default::default() })
    }

    fn metar_frames(&self, l: &LayerDef, n: usize) -> FramesResp {
        let snaps = self.metar.read();
        let k = snaps.len().saturating_sub(n);
        let frames = snaps
            .iter()
            .skip(k)
            .map(|(t, _)| FrameInfo { key: format!("metar|{}|{t}", l.id), time: *t, label: String::new() })
            .collect();
        FramesResp { frames, ..Default::default() }
    }

    async fn goes_frames(&self, l: &LayerDef, n: usize, end: Option<chrono::DateTime<Utc>>) -> Result<FramesResp> {
        let mut p = l.product.split('|');
        let sat: u32 = p.next().unwrap_or("19").parse()?;
        let sector = p.next().unwrap_or("conus");
        let band_s = p.next().unwrap_or("13");
        let rgb_recipe = band_s.strip_prefix("rgb:").and_then(rgb::recipe);
        let band: u32 = match rgb_recipe {
            Some(r) => r.base as u32,
            None => band_s.parse()?,
        };
        let (_, _, dir, tag, _) = sources::GOES_SECTORS.iter().find(|s| s.0 == sat && s.1 == sector).ok_or_else(|| anyhow!("unknown sector"))?;
        let bucket = format!("noaa-goes{sat}");
        let now = end.unwrap_or_else(Utc::now);
        let end_ms = end.map(|t| t.timestamp_millis());
        let mut keys: Vec<s3::Object> = vec![];
        let want = format!("C{band:02}_G{sat}_");
        for back in 0..24 {
            let t = now - chrono::Duration::hours(back);
            let prefix = format!("{dir}/{:04}/{:03}/{:02}/OR_ABI-L2-{tag}-M", t.year(), t.ordinal(), t.hour());
            let objs = self.list_cached(&bucket, &prefix, 45).await.unwrap_or_default();
            let mut v: Vec<s3::Object> = objs.iter().filter(|o| o.key.contains(&want) && end_ms.map(|e| goes::time_from_name(&o.key).unwrap_or(0) <= e).unwrap_or(true)).cloned().collect();
            v.extend(keys);
            keys = v;
            if keys.len() >= n {
                break;
            }
        }
        if keys.is_empty() {
            bail!("no recent GOES-{sat} {sector} band {band} files");
        }
        let k = keys.len().saturating_sub(n);
        let frames = keys[k..]
            .iter()
            .map(|o| FrameInfo {
                key: format!("{}|{}|{bucket}|{}", if rgb_recipe.is_some() { "goesrgb" } else { "goes" }, l.id, o.key),
                time: goes::time_from_name(&o.key).unwrap_or(0),
                label: String::new(),
            })
            .collect();
        Ok(FramesResp { frames, ..Default::default() })
    }

    // ---------- decode ----------

    pub async fn grid(&self, key: &str) -> Result<Arc<Grid>> {
        if let Some(g) = self.grids.lock().get(key) {
            return Ok(g);
        }
        // one decode per key even if many requests arrive together (animation prefetch)
        let lock = self.inflight.lock().entry(key.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
        let _g = lock.lock().await;
        if let Some(g) = self.grids.lock().get(key) {
            return Ok(g);
        }
        let res = self.load(key).await;
        self.inflight.lock().remove(key);
        let g = Arc::new(res?);
        self.grids.lock().put(key.to_string(), g.clone());
        Ok(g)
    }

    async fn blocking<T: Send + 'static>(&self, f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
        let _p = self.sem.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(f).await?
    }

    async fn load(&self, key: &str) -> Result<Grid> {
        let parts: Vec<&str> = key.split('|').collect();
        match parts.first().copied() {
            Some("mrms") if parts.len() == 3 => {
                let l = self.layer(parts[1])?.clone();
                let url = s3::object_url(sources::MRMS_BUCKET, parts[2]);
                let b = self.fetch(&url, None, true).await?;
                let opts = DecodeOpts { nodata: l.nodata.clone(), min_valid: l.min_valid, transform: l.transform, max_dim: self.max_dim_mrms };
                self.blocking(move || {
                    let raw = maybe_gunzip(&b)?;
                    let mut g = decode::decode(&raw, 0, &opts)?;
                    if g.valid_ms == 0 {
                        g.valid_ms = g.ref_ms;
                    }
                    Ok(g)
                })
                .await
            }
            Some("opera") if parts.len() == 3 => {
                let l = self.layer(parts[1])?.clone();
                if super::intl::opera_parse(parts[2]).map(|x| x.1 != l.product).unwrap_or(true) || parts[2].contains("..") {
                    bail!("bad OPERA key");
                }
                let b = self.fetch(&format!("{}/{}", super::intl::OPERA_BASE, parts[2]), None, true).await?;
                let md = self.max_dim_mrms;
                self.blocking(move || super::intl::decode_odim(&b, &l.product, md, l.min_valid)).await
            }
            Some("cwa") if parts.len() == 3 => {
                let t = super::intl::cwa_time(parts[2]).filter(|_| parts[2].starts_with("history/Observation/") && !parts[2].contains("..")).ok_or_else(|| anyhow!("bad CWA key"))?;
                let b = self.fetch(&format!("{}/{}", super::intl::CWA_BASE, parts[2]), None, true).await?;
                self.blocking(move || super::intl::decode_cwa(&b, t)).await
            }
            Some("fdiff") if parts.len() == 6 => {
                // accumulation between two forecast hours of one run (e.g. snowfall from now)
                let fh: u32 = parts[3].parse()?;
                let fh0: u32 = parts[4].parse()?;
                let a = Box::pin(self.grid(&format!("model|{}|{}|{fh}|{}|", parts[1], parts[2], parts[5]))).await?;
                let b = if fh0 == 0 { None } else { Some(Box::pin(self.grid(&format!("model|{}|{}|{fh0}|{}|", parts[1], parts[2], parts[5]))).await?) };
                self.blocking(move || {
                    let vals: Vec<f32> = (0..a.data.len())
                        .map(|i| {
                            let ra = a.data[i];
                            if ra == 0 {
                                return f32::NAN;
                            }
                            let va = a.value_raw(ra);
                            let vb = match &b {
                                Some(b) if b.data.len() == a.data.len() && b.data[i] != 0 => b.value_raw(b.data[i]),
                                _ => 0.0,
                            };
                            let d = va - vb;
                            // hide trace amounts so bare ground stays clear
                            if d < 0.05 { f32::NAN } else { d }
                        })
                        .collect();
                    Ok(Grid::from_values(a.nx, a.ny, a.proj.clone(), &vals, a.valid_ms, a.ref_ms))
                })
                .await
            }
            Some("wcomp") if parts.len() == 6 => self.load_component(parts[1], parts[2], parts[3].parse()?, parts[4], parts[5]).await,
            Some("model") if parts.len() >= 5 => self.load_model(parts[1], parts[2], parts[3].parse()?, parts[4], parts.get(5).copied().unwrap_or("")).await,
            Some("ndfd") if parts.len() == 5 => {
                let l = self.layer(parts[1])?.clone();
                let elem = l.product.split('|').next().unwrap_or("");
                let (_, b, _) = self.ndfd_file(elem, parts[2]).await?;
                let idx: usize = parts[3].parse()?;
                let opts = DecodeOpts { nodata: l.nodata.clone(), min_valid: None, transform: l.transform, max_dim: 0 };
                self.blocking(move || decode::decode(&b, idx, &opts)).await
            }
            Some("metar") if parts.len() == 3 => {
                let l = self.layer(parts[1])?.clone();
                let t: i64 = parts[2].parse()?;
                let obs = self.metar.read().iter().find(|(x, _)| *x == t).map(|(_, o)| o.clone()).ok_or_else(|| anyhow!("observation snapshot expired"))?;
                let field = l.product.clone();
                self.blocking(move || Ok(metar::analyze(&obs, &field, t))).await
            }
            Some("goes") if parts.len() == 4 => {
                let url = s3::object_url(parts[2], parts[3]);
                let b = self.fetch(&url, None, true).await?;
                let md = self.max_dim_goes;
                self.blocking(move || goes::decode_cmip(&b, md)).await
            }
            Some("local") if parts.len() == 4 => {
                let l = self.layer(parts[1])?.clone();
                let dir = self.local_dir.read().clone().ok_or_else(|| anyhow!("no local dir"))?;
                if parts[2].contains('/') || parts[2].contains("..") {
                    bail!("bad name");
                }
                let b = tokio::fs::read(dir.join(parts[2])).await?;
                let idx: usize = parts[3].parse()?;
                let md = if l.source == "goes" { self.max_dim_goes } else { self.max_dim_mrms };
                let name = parts[2].to_string();
                self.blocking(move || {
                    if l.source == "goes" {
                        return goes::decode_cmip(&b, md);
                    }
                    if l.source == "opera" {
                        return super::intl::decode_odim(&b, &l.product, md, l.min_valid);
                    }
                    if l.source == "cwa" {
                        return super::intl::decode_cwa(&b, super::intl::cwa_time(name.split("__").last().unwrap_or("")).unwrap_or(0));
                    }
                    let raw = maybe_gunzip(&b)?;
                    let opts = DecodeOpts { nodata: l.nodata.clone(), min_valid: l.min_valid, transform: l.transform, max_dim: md };
                    let mut g = decode::decode(&raw, idx, &opts)?;
                    if g.valid_ms == 0 {
                        g.valid_ms = g.ref_ms;
                    }
                    Ok(g)
                })
                .await
            }
            _ => bail!("bad grid key"),
        }
    }

    async fn load_model(&self, model: &str, run: &str, fh: u32, var_id: &str, storm: &str) -> Result<Grid> {
        let m = sources::model_def(model).ok_or_else(|| anyhow!("unknown model"))?;
        let v = sources::var_def(var_id).ok_or_else(|| anyhow!("unknown variable"))?;
        if run.len() != 10 {
            bail!("bad run");
        }
        let (d, hh) = (&run[..8], run[8..].parse::<u32>()?);
        if m.index == "msc" || m.index == "dwd" {
            let (matcher, tf) = sources::alt_match(m.index, var_id).ok_or_else(|| anyhow!("{} not in {}", v.name, m.name))?;
            let opts = DecodeOpts { transform: tf.unwrap_or(v.transform), ..Default::default() };
            let mut g = match &matcher {
                Match::MscUv(a, b) => {
                    let (ma, mb) = (Match::Msc(a), Match::Msc(b));
                    let (bu, bv) = tokio::try_join!(self.alt_bytes(m, d, hh, fh, &ma), self.alt_bytes(m, d, hh, fh, &mb))?;
                    self.blocking(move || decode::decode_speed(&decode::maybe_bunzip2(&bu)?, &decode::maybe_bunzip2(&bv)?, &opts)).await?
                }
                Match::DwdUv(a, b) => {
                    let (ma, mb) = (Match::Dwd(a.0, a.1, a.2), Match::Dwd(b.0, b.1, b.2));
                    let (bu, bv) = tokio::try_join!(self.alt_bytes(m, d, hh, fh, &ma), self.alt_bytes(m, d, hh, fh, &mb))?;
                    self.blocking(move || decode::decode_speed(&decode::maybe_bunzip2(&bu)?, &decode::maybe_bunzip2(&bv)?, &opts)).await?
                }
                one => {
                    let b = self.alt_bytes(m, d, hh, fh, one).await?;
                    self.blocking(move || decode::decode(&decode::maybe_bunzip2(&b)?, 0, &opts)).await?
                }
            };
            g.ref_ms = run_time_ms(d, hh)?;
            g.valid_ms = g.ref_ms + fh as i64 * 3_600_000;
            return Ok(g);
        }
        // sub-hourly HRRR: `fh` is minutes; the file is the hour that step ends in
        let sub = m.id == "hrrrsub";
        let file = sources::fill_template(m.file, d, hh, if sub { fh.div_ceil(60) } else { fh }, storm);
        let (url, idx_url) = if m.index == "ecmwf" {
            let u = format!("{}/{}", m.bucket, file);
            let i = u.replace(".grib2", ".index");
            (u, i)
        } else {
            let u = s3::object_url(m.bucket, &file);
            (u.clone(), format!("{u}.idx"))
        };
        let idx = self.text_cached(&idx_url, 3600).await.with_context(|| format!("{} index", m.name))?;
        let opts = DecodeOpts { nodata: vec![], min_valid: None, transform: v.transform, max_dim: 0 };
        let step_ms: i64 = if sub { 60_000 } else { 3_600_000 };
        let run_ms = Utc.with_ymd_and_hms(d[..4].parse()?, d[4..6].parse()?, d[6..8].parse()?, hh, 0, 0).single().map(|t| t.timestamp_millis()).unwrap_or(0);
        let valid = run_ms + fh as i64 * step_ms;
        let matcher = if m.index == "ecmwf" { v.ecmwf.clone().ok_or_else(|| anyhow!("{} not in {}", v.name, m.name))? } else { v.ncep.clone() };
        let mut g = match matcher {
            Match::Ncep(pats) => {
                let rows = sources::parse_ncep_idx(&idx);
                let range = pats
                    .iter()
                    .find_map(|p| if sub { sources::find_ncep_minutes(&rows, p, fh) } else { sources::find_ncep(&rows, p, fh, v.accum) })
                    .ok_or_else(|| anyhow!("{} not found in {} F{fh:03}", v.name, m.name))?;
                let b = self.fetch(&url, Some(range), true).await?;
                self.blocking(move || decode::decode(&b, 0, &opts)).await?
            }
            Match::NcepUv(u, vv) => {
                let rows = sources::parse_ncep_idx(&idx);
                let ru = sources::find_ncep(&rows, u, fh, false).ok_or_else(|| anyhow!("U wind missing"))?;
                let rv = sources::find_ncep(&rows, vv, fh, false).ok_or_else(|| anyhow!("V wind missing"))?;
                let (bu, bv) = tokio::try_join!(self.fetch(&url, Some(ru), true), self.fetch(&url, Some(rv), true))?;
                self.blocking(move || decode::decode_speed(&bu, &bv, &opts)).await?
            }
            Match::Ec(param, levtype, level) => {
                let (o, n) = sources::find_ecmwf(&idx, param, levtype, level).ok_or_else(|| anyhow!("{} not found in ECMWF step {fh}", v.name))?;
                let b = self.fetch(&url, Some((o, Some(o + n))), true).await?;
                let opts = if param == "tp" { DecodeOpts { transform: decode::Transform::MToMm, ..opts } } else if param == "tcc" { DecodeOpts { transform: decode::Transform::FracToPct, ..opts } } else { opts };
                self.blocking(move || decode::decode(&b, 0, &opts)).await?
            }
            Match::EcUv(pu, pv) => {
                let (lt, lv) = if var_id == "wind250" { ("pl", "250") } else { ("sfc", "") };
                let (ou, nu) = sources::find_ecmwf(&idx, pu, lt, lv).ok_or_else(|| anyhow!("U wind missing"))?;
                let (ov, nv) = sources::find_ecmwf(&idx, pv, lt, lv).ok_or_else(|| anyhow!("V wind missing"))?;
                let (bu, bv) = tokio::try_join!(self.fetch(&url, Some((ou, Some(ou + nu))), true), self.fetch(&url, Some((ov, Some(ov + nv))), true))?;
                self.blocking(move || decode::decode_speed(&bu, &bv, &opts)).await?
            }
            _ => bail!("{} is not an index-based source", m.name),
        };
        g.valid_ms = valid;
        g.ref_ms = run_ms;
        Ok(g)
    }

    /// Raw bytes of one MSC / DWD field file (MSC: found by name in the forecast-hour listing).
    async fn alt_bytes(&self, m: &sources::ModelDef, d: &str, hh: u32, fh: u32, mt: &Match) -> Result<Bytes> {
        match mt {
            Match::Msc(tokens) => {
                let dir = format!("{}/{}{fh:03}/", m.bucket, sources::fill_template(m.run_prefix, d, hh, fh, ""));
                let html = self.text_cached(&dir, 600).await.with_context(|| format!("{} F{fh:03} listing", m.name))?;
                let name = hrefs(&html)
                    .map(|h| h.rsplit('/').next().unwrap_or(""))
                    .find(|n| n.ends_with(".grib2") && tokens.iter().any(|t| n.contains(t)))
                    .ok_or_else(|| anyhow!("field not found in {} F{fh:03}", m.name))?
                    .to_string();
                self.fetch(&format!("{dir}{name}"), None, true).await
            }
            Match::Dwd(dir, kind, name) => {
                let file = sources::fill_template(m.file, d, hh, fh, "").replace("{dir}", dir).replace("{kind}", kind).replace("{name}", name);
                self.fetch(&format!("{}/{file}", m.bucket), None, true).await
            }
            _ => bail!("not a file-per-field source"),
        }
    }

    /// One wind component ("u" | "v") at a level, as published (may be grid-relative).
    async fn load_component(&self, model: &str, run: &str, fh: u32, level: &str, comp: &str) -> Result<Grid> {
        let m = sources::model_def(model).ok_or_else(|| anyhow!("unknown model"))?;
        if run.len() != 10 {
            bail!("bad run");
        }
        let (d, hh) = (&run[..8], run[8..].parse::<u32>()?);
        let (mu, mv) = sources::wind_match(m.index, level).ok_or_else(|| anyhow!("no {level} wind for {}", m.name))?;
        let mt = if comp == "u" { mu } else { mv };
        let opts = DecodeOpts::default();
        let mut g = match &mt {
            Match::Ncep(pats) => {
                let url = s3::object_url(m.bucket, &sources::fill_template(m.file, d, hh, fh, ""));
                let idx = self.text_cached(&format!("{url}.idx"), 3600).await.with_context(|| format!("{} index", m.name))?;
                let rows = sources::parse_ncep_idx(&idx);
                let range = sources::find_ncep(&rows, pats[0], fh, false).ok_or_else(|| anyhow!("{level} wind not found in {} F{fh:03}", m.name))?;
                let b = self.fetch(&url, Some(range), true).await?;
                self.blocking(move || decode::decode(&b, 0, &opts)).await?
            }
            Match::Ec(param, levtype, lv) => {
                let url = format!("{}/{}", m.bucket, sources::fill_template(m.file, d, hh, fh, ""));
                let idx = self.text_cached(&url.replace(".grib2", ".index"), 3600).await.with_context(|| format!("{} index", m.name))?;
                let (o, n) = sources::find_ecmwf(&idx, param, levtype, lv).ok_or_else(|| anyhow!("{level} wind not found in ECMWF step {fh}"))?;
                let b = self.fetch(&url, Some((o, Some(o + n))), true).await?;
                self.blocking(move || decode::decode(&b, 0, &opts)).await?
            }
            other => {
                let b = self.alt_bytes(m, d, hh, fh, other).await?;
                self.blocking(move || decode::decode(&decode::maybe_bunzip2(&b)?, 0, &opts)).await?
            }
        };
        g.ref_ms = run_time_ms(d, hh)?;
        g.valid_ms = g.ref_ms + fh as i64 * 3_600_000;
        Ok(g)
    }

    /// Earth-relative U/V wind on a regular lat/lon grid over `bbox` (w, s, e, n) for particle
    /// animation. Body: u32 LE header length, JSON header, then nx*ny pairs of u8 (u, v),
    /// x fastest (W→E), rows S→N. Byte 0 = no data; otherwise
    /// value = min + (b - 1) / 254 * (max - min) m/s.
    pub async fn wind(&self, model: &str, level: &str, time: Option<i64>, bbox: [f64; 4], max: usize) -> Result<Bytes> {
        let m = sources::model_def(model).filter(|m| m.group != "Hidden" && !m.id.starts_with("hafs")).ok_or_else(|| anyhow!("unknown model {model}"))?;
        if !sources::WIND_LEVELS.contains(&level) || sources::wind_match(m.index, level).is_none() {
            bail!("level must be one of {}", sources::WIND_LEVELS.join("|"));
        }
        let runs = self.model_runs(m).await?;
        let t = time.unwrap_or_else(|| Utc::now().timestamp_millis());
        let (run, _, fh) = nearest_step(&runs, t).ok_or_else(|| anyhow!("no {} forecast hours available", m.name))?;
        let [w, s, e, n] = bbox;
        let ck = format!("{model}|{run}|{fh}|{level}|{w:.3},{s:.3},{e:.3},{n:.3}|{max}");
        {
            let mut c = self.winds.lock();
            if let Some((made, b)) = c.0.get(&ck) {
                if made.elapsed() < Duration::from_secs(600) {
                    return Ok(b.clone());
                }
            }
        }
        let ku = format!("wcomp|{model}|{run}|{fh}|{level}|u");
        let kv = format!("wcomp|{model}|{run}|{fh}|{level}|v");
        let (gu, gv) = tokio::try_join!(self.grid(&ku), self.grid(&kv))?;
        if gu.data.len() != gv.data.len() {
            bail!("U/V grids differ");
        }
        let (model_s, level_s) = (m.id.to_string(), level.to_string());
        let body = self
            .blocking(move || {
                let (sx, sy) = (e - w, n - s);
                let (nx, ny) = if sx >= sy { (max, ((max as f64 * sy / sx).round() as usize).max(2)) } else { (((max as f64 * sx / sy).round() as usize).max(2), max) };
                let (dlon, dlat) = (sx / (nx - 1) as f64, sy / (ny - 1) as f64);
                let mut u = vec![f32::NAN; nx * ny];
                let mut v = vec![f32::NAN; nx * ny];
                for j in 0..ny {
                    let lat = s + j as f64 * dlat;
                    for i in 0..nx {
                        let lon = w + i as f64 * dlon;
                        let (Some(a), Some(b)) = (gu.sample(lat, lon), gv.sample(lat, lon)) else { continue };
                        let (a, b) = if gu.grid_rel {
                            let r = gu.proj.north_angle(lat, lon) as f32;
                            (r.cos() * a + r.sin() * b, -r.sin() * a + r.cos() * b)
                        } else {
                            (a, b)
                        };
                        u[j * nx + i] = a;
                        v[j * nx + i] = b;
                    }
                }
                let range = |x: &[f32]| x.iter().filter(|z| z.is_finite()).fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &z| (lo.min(z), hi.max(z)));
                let ((umin, umax), (vmin, vmax)) = (range(&u), range(&v));
                if !umin.is_finite() {
                    bail!("bbox not found in the {} domain", model_s);
                }
                let q = |z: f32, lo: f32, hi: f32| -> u8 { if !z.is_finite() { 0 } else if hi > lo { 1 + ((z - lo) / (hi - lo) * 254.0).round().clamp(0.0, 254.0) as u8 } else { 1 } };
                let mut uv = Vec::with_capacity(nx * ny * 2);
                for k in 0..nx * ny {
                    uv.push(q(u[k], umin, umax));
                    uv.push(q(v[k], vmin, vmax));
                }
                let r3 = |x: f32| (x * 1000.0).round() / 1000.0;
                let hdr = serde_json::json!({
                    "nx": nx, "ny": ny, "lon0": w, "lat0": s, "dlon": dlon, "dlat": dlat,
                    "time": gu.valid_ms, "run": gu.ref_ms, "model": model_s, "level": level_s, "units": "m/s",
                    "umin": r3(umin), "umax": r3(umax), "vmin": r3(vmin), "vmax": r3(vmax), "nodata": 0,
                });
                Ok(encode_wind(&hdr, &uv))
            })
            .await?;
        let b = Bytes::from(body);
        let mut c = self.winds.lock();
        if let Some((_, old)) = c.0.put(ck, (Instant::now(), b.clone())) {
            c.1 -= old.len();
        }
        c.1 += b.len();
        while c.1 > 16 << 20 && c.0.len() > 1 {
            match c.0.pop_lru() {
                Some((_, (_, old))) => c.1 -= old.len(),
                None => break,
            }
        }
        Ok(b)
    }

    // ---------- render ----------

    /// RGB composite for a `goesrgb|layer|bucket|base-band-key` frame.
    pub async fn rgb(&self, key: &str) -> Result<Arc<RgbImage>> {
        if let Some((i, _)) = self.rgbs.lock().0.get(key) {
            return Ok(i.clone());
        }
        let lock = self.inflight.lock().entry(key.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
        let _g = lock.lock().await;
        if let Some((i, _)) = self.rgbs.lock().0.get(key) {
            return Ok(i.clone());
        }
        let res = self.load_rgb(key).await;
        self.inflight.lock().remove(key);
        let img = Arc::new(res?);
        {
            let n = img.rgba.len() + 256;
            let mut c = self.rgbs.lock();
            if let Some((_, old)) = c.0.put(key.to_string(), (img.clone(), n)) {
                c.1 -= old;
            }
            c.1 += n;
            while c.1 > c.2 && c.0.len() > 1 {
                match c.0.pop_lru() {
                    Some((_, (_, s))) => c.1 -= s,
                    None => break,
                }
            }
        }
        Ok(img)
    }

    async fn load_rgb(&self, key: &str) -> Result<RgbImage> {
        let parts: Vec<&str> = key.split('|').collect();
        if parts.len() != 4 {
            bail!("bad rgb key");
        }
        let l = self.layer(parts[1])?.clone();
        let recipe = l.product.split('|').nth(2).and_then(|p| p.strip_prefix("rgb:")).and_then(rgb::recipe).ok_or_else(|| anyhow!("unknown composite"))?;
        let (bucket, base_key) = (parts[2], parts[3]);
        let sat = l.product.split('|').next().unwrap_or("19");
        // the hour's listing has every band; match files by scan start time
        let name = base_key.rsplit('/').next().unwrap_or("");
        let start = name.split('_').find(|p| p.starts_with('s')).ok_or_else(|| anyhow!("bad file name"))?;
        let mpos = base_key.rfind("-M").ok_or_else(|| anyhow!("bad file name"))?;
        let prefix = &base_key[..mpos + 2];
        let objs = self.list_cached(bucket, prefix, 45).await?;
        let mut futs = vec![];
        for &b in recipe.bands {
            let want = format!("C{b:02}_G{sat}_{start}");
            let obj = objs.iter().find(|o| o.key.contains(&want)).ok_or_else(|| anyhow!("band {b} not published yet for this scan"))?;
            let url = s3::object_url(bucket, &obj.key);
            futs.push(async move { (b, self.fetch(&url, None, true).await) });
        }
        let got = futures::future::join_all(futs).await;
        let md = self.max_dim_goes;
        let mut files = vec![];
        for (b, r) in got {
            files.push((b, r?));
        }
        self.blocking(move || {
            let mut bands: [Option<rgb::Band>; 17] = Default::default();
            for (b, bytes) in files {
                bands[b as usize] = Some(goes::read_band(&bytes, md)?);
            }
            rgb::compose(recipe, &bands)
        })
        .await
    }

    pub async fn render(&self, key: &str, bbox: (f64, f64, f64, f64), w: usize, h: usize) -> Result<Bytes> {
        if key.starts_with("goesrgb|") {
            let img = self.rgb(key).await?;
            let out = self
                .blocking(move || {
                    let data = img.render(bbox, w, h);
                    Ok(crate::radar::encode::zstd(&super::encode_rgba(img.time, bbox, w, h, &data)))
                })
                .await?;
            return Ok(Bytes::from(out));
        }
        let g = self.grid(key).await?;
        let out = self
            .blocking(move || {
                let data = g.render(bbox, w, h);
                Ok(crate::radar::encode::zstd(&encode_raster(&g, bbox, w, h, &data)))
            })
            .await?;
        Ok(Bytes::from(out))
    }

    pub async fn value(&self, key: &str, lat: f64, lon: f64) -> Result<Option<f32>> {
        if key.starts_with("goesrgb|") {
            return Ok(None);
        }
        Ok(self.grid(key).await?.sample(lat, lon))
    }

    // ---------- MRMS 3D reflectivity cube ----------

    /// MergedReflectivityQC levels (km MSL) published on AWS.
    pub const MRMS_3D_LEVELS: [&'static str; 33] = [
        "00.50", "00.75", "01.00", "01.25", "01.50", "01.75", "02.00", "02.25", "02.50", "02.75", "03.00", "03.50", "04.00", "04.50", "05.00", "05.50", "06.00", "06.50", "07.00", "07.50", "08.00",
        "08.50", "09.00", "10.00", "11.00", "12.00", "13.00", "14.00", "15.00", "16.00", "17.00", "18.00", "19.00",
    ];

    /// Newest object of one 3D level at or before `t` (within 10 minutes).
    async fn mrms3d_key(&self, level: &str, t: chrono::DateTime<Utc>) -> Option<(String, i64)> {
        let t_ms = t.timestamp_millis() + 60_000;
        let mut best: Option<(String, i64)> = None;
        for back in 0..2 {
            let d = t - chrono::Duration::minutes(10 * back);
            if back == 1 && d.day() == t.day() {
                break;
            }
            let prefix = format!("CONUS/MergedReflectivityQC_{level}/{}/", ymd(d));
            let objs = self.list_cached(sources::MRMS_BUCKET, &prefix, 50).await.ok()?;
            for o in objs.iter() {
                let stem = o.key.rsplit('_').next().unwrap_or("").trim_end_matches(".grib2.gz");
                let Ok(ot) = chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d-%H%M%S") else { continue };
                let ot = ot.and_utc().timestamp_millis();
                if ot <= t_ms && t_ms - ot <= 11 * 60_000 && best.as_ref().map(|b| ot > b.1).unwrap_or(true) {
                    best = Some((o.key.clone(), ot));
                }
            }
        }
        best
    }

    /// 3D reflectivity cube over `bbox` (w, s, e, n) from the 33 MRMS levels nearest `time`.
    /// Same body layout as the Level II volume (u32 header length, JSON, u8 voxels), with a
    /// regular lat/lon grid: header `proj: "latlon"`, `lon0`/`lat0` = south-west cell centre.
    pub async fn mrms_volume3d(&self, time: Option<i64>, bbox: [f64; 4]) -> Result<Bytes> {
        const RES: f64 = 0.01;
        let [w, s, e, n] = [bbox[0].max(-129.995), bbox[1].max(20.005), bbox[2].min(-60.005), bbox[3].min(54.995)];
        if !(w < e && s < n) {
            bail!("bbox not found in the MRMS CONUS domain");
        }
        let kx = ((e - w) / RES / 400.0).ceil().max(1.0);
        let ky = ((n - s) / RES / 400.0).ceil().max(1.0);
        let (dlon, dlat) = (RES * kx, RES * ky);
        // snap to MRMS cell centres (…5 in the third decimal)
        let lon0 = ((w - 0.005) / RES).round() * RES + 0.005;
        let lat0 = ((s - 0.005) / RES).round() * RES + 0.005;
        let nx = (((e - lon0) / dlon).floor() as usize + 1).clamp(1, 400);
        let ny = (((n - lat0) / dlat).floor() as usize + 1).clamp(1, 400);
        let t = time.and_then(chrono::DateTime::from_timestamp_millis).filter(|t| *t <= Utc::now()).unwrap_or_else(Utc::now);
        let keys = futures::future::join_all(Self::MRMS_3D_LEVELS.iter().map(|l| self.mrms3d_key(l, t))).await;
        let base = keys.iter().flatten().map(|k| k.1).max().ok_or_else(|| anyhow!("no MRMS 3D reflectivity found near that time"))?;
        let ck = format!("{base}|{lon0:.3}|{lat0:.3}|{nx}|{ny}|{dlon:.3}|{dlat:.3}");
        if let Some(b) = self.cubes.lock().0.get(&ck) {
            return Ok(b.clone());
        }
        let lock = self.inflight.lock().entry(ck.clone()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
        let _g = lock.lock().await;
        if let Some(b) = self.cubes.lock().0.get(&ck) {
            return Ok(b.clone());
        }
        let res = self.build_cube(&keys, base, (lon0, lat0, dlon, dlat, nx, ny)).await;
        self.inflight.lock().remove(&ck);
        let b = Bytes::from(res?);
        let mut c = self.cubes.lock();
        if let Some(old) = c.0.put(ck, b.clone()) {
            c.1 -= old.len();
        }
        c.1 += b.len();
        while c.1 > c.2 && c.0.len() > 1 {
            match c.0.pop_lru() {
                Some((_, old)) => c.1 -= old.len(),
                None => break,
            }
        }
        Ok(b)
    }

    async fn build_cube(&self, keys: &[Option<(String, i64)>], base: i64, g: (f64, f64, f64, f64, usize, usize)) -> Result<Vec<u8>> {
        use futures::StreamExt;
        let (lon0, lat0, dlon, dlat, nx, ny) = g;
        // ignore levels from a different scan than the newest one
        let wanted: Vec<(usize, String)> = keys.iter().enumerate().filter_map(|(i, k)| k.as_ref().filter(|k| (base - k.1).abs() <= 150_000).map(|k| (i, k.0.clone()))).collect();
        let files: Vec<(usize, Result<Bytes>)> = futures::stream::iter(wanted.into_iter().map(|(i, k)| async move { (i, self.fetch(&s3::object_url(sources::MRMS_BUCKET, &k), None, true).await) }))
            .buffer_unordered(6)
            .collect()
            .await;
        let mut got = vec![];
        for (i, r) in files {
            match r {
                Ok(b) => got.push((i, b)),
                Err(e) => tracing::debug!("mrms 3d level {i}: {e}"),
            }
        }
        if got.is_empty() {
            bail!("MRMS 3D levels could not be downloaded");
        }
        let nz = Self::MRMS_3D_LEVELS.len();
        let out = self
            .blocking(move || {
                use rayon::prelude::*;
                let pts: Vec<(f64, f64)> = (0..nx * ny).map(|k| (lat0 + (k / nx) as f64 * dlat, lon0 + (k % nx) as f64 * dlon)).collect();
                let opts = DecodeOpts { nodata: vec![-999.0, -99.0], min_valid: Some(-30.0), ..Default::default() };
                let layers: Vec<(usize, Vec<u8>)> = got
                    .par_iter()
                    .filter_map(|(i, b)| {
                        let raw = maybe_gunzip(b).ok()?;
                        let (vals, _) = decode::decode_at(&raw, &opts, &pts).ok()?;
                        Some((*i, vals.iter().map(|&v| if v.is_finite() { (v * 2.0 + 66.0).round().clamp(1.0, 255.0) as u8 } else { 0 }).collect()))
                    })
                    .collect();
                let mut vox = vec![0u8; nx * ny * nz];
                for (i, l) in layers {
                    vox[i * nx * ny..(i + 1) * nx * ny].copy_from_slice(&l);
                }
                let levels: Vec<f64> = Self::MRMS_3D_LEVELS.iter().map(|l| l.parse::<f64>().unwrap_or(0.0) * 1000.0).collect();
                let hdr = serde_json::json!({
                    "nx": nx, "ny": ny, "nz": nz, "proj": "latlon",
                    "lon0": (lon0 * 1000.0).round() / 1000.0, "lat0": (lat0 * 1000.0).round() / 1000.0,
                    "dlon": dlon, "dlat": dlat, "levels": levels,
                    "scale": 2.0, "offset": 66.0, "moment": "REF", "time": base, "site": "MRMS", "elev_m": 0.0,
                });
                Ok(crate::radar::volume3d::with_header(&hdr, &vox))
            })
            .await;
        match &out {
            Ok(_) => self.health.ok("grid-mrms3d", "MRMS 3D reflectivity", ""),
            Err(e) => self.health.err("grid-mrms3d", "MRMS 3D reflectivity", e),
        }
        out
    }

    // ---------- background: METAR snapshots ----------

    pub fn spawn_metar(self: &Arc<Self>, url: String) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                match me.fetch(&url, None, false).await.and_then(|b| metar::parse_csv(&b)) {
                    Ok(obs) if !obs.is_empty() => {
                        let n = obs.len();
                        // snapshot time rounded to the minute
                        let t = Utc::now().timestamp_millis() / 60_000 * 60_000;
                        let mut q = me.metar.write();
                        q.push_back((t, Arc::new(obs)));
                        while q.len() > me.metar_keep {
                            q.pop_front();
                        }
                        drop(q);
                        me.health.ok("metar", "METAR observations", format!("{n} stations"));
                    }
                    Ok(_) => me.health.err("metar", "METAR observations", "empty file"),
                    Err(e) => me.health.err("metar", "METAR observations", e),
                }
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
        });
    }

    pub fn latest_metars(&self) -> Option<Arc<Vec<Obs>>> {
        self.metar.read().back().map(|(_, o)| o.clone())
    }

    /// Offline testing: seed METAR snapshots from a local CSV.
    pub fn load_metar_fixture(&self, bytes: &[u8]) -> Result<()> {
        let obs = metar::parse_csv(bytes)?;
        let t = Utc::now().timestamp_millis() / 60_000 * 60_000;
        self.metar.write().push_back((t, Arc::new(obs)));
        Ok(())
    }
}

impl Clone for MessageInfo {
    fn clone(&self) -> Self {
        MessageInfo { ..*self }
    }
}
impl Copy for MessageInfo {}

fn run_time_ms(d: &str, hh: u32) -> Result<i64> {
    Utc.with_ymd_and_hms(d.get(..4).unwrap_or("").parse()?, d.get(4..6).unwrap_or("").parse()?, d.get(6..8).unwrap_or("").parse()?, hh, 0, 0).single().map(|t| t.timestamp_millis()).ok_or_else(|| anyhow!("bad run time"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_listings() {
        let msc = r#"<a href="?C=N;O=D">Name</a> <a href="/20261011/WXO-DD/model_gdps/">Parent</a> <a href="000/">000/</a> <a href="003/">003/</a> <a href="240/">240/</a>"#;
        assert_eq!(listing_fhs("msc", msc, "20261011", 0), vec![0, 3, 240]);
        let dwd = r#"<a href="icon-eu_europe_regular-lat-lon_single-level_2026101112_000_T_2M.grib2.bz2">x</a>
<a href="icon-eu_europe_regular-lat-lon_single-level_2026101112_120_T_2M.grib2.bz2">x</a>
<a href="icon-eu_europe_regular-lat-lon_single-level_2026101012_005_T_2M.grib2.bz2">x</a>"#;
        assert_eq!(listing_fhs("dwd", dwd, "20261011", 12), vec![0, 120]);
        assert!(listing_fhs("dwd", dwd, "20261011", 0).is_empty());
    }

    #[test]
    fn nearest_run_step() {
        let h = 3_600_000i64;
        let runs = vec![("2026101112".to_string(), 12 * h, vec![0, 1, 2], vec![]), ("2026101106".to_string(), 6 * h, (0..=18).collect(), vec![])];
        // 13:20 → newest run F001
        assert_eq!(nearest_step(&runs, 13 * h + 20 * 60_000), Some(("2026101112".into(), 12 * h, 1)));
        // 20:00 beyond the newest run's hours → older run F014
        assert_eq!(nearest_step(&runs, 20 * h), Some(("2026101106".into(), 6 * h, 14)));
        let b = encode_wind(&serde_json::json!({"nx": 1}), &[1, 2]);
        assert_eq!(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize, b.len() - 6);
    }
}
