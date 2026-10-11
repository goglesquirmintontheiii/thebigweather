//! Gridded data service: frame listing, downloading, decoding, caching and viewport rendering.

use super::decode::{self, maybe_gunzip, DecodeOpts, MessageInfo};
use super::metar::{self, Obs};
use super::sources::{self, LayerDef, Match};
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

impl GridService {
    pub fn new(http: reqwest::Client, health: Arc<Health>, data_dir: &std::path::Path, memory_mb: usize, threads: usize, full: bool) -> Arc<Self> {
        let cache_dir = data_dir.join("cache/raw");
        std::fs::create_dir_all(&cache_dir).ok();
        Arc::new(Self {
            http,
            health,
            layers: sources::all_layers(),
            cache_dir,
            grids: Mutex::new(SizedLru { map: lru::LruCache::unbounded(), bytes: 0, cap: memory_mb * 1024 * 1024 }),
            listings: Mutex::new(HashMap::new()),
            texts: Mutex::new(HashMap::new()),
            ndfd: tokio::sync::Mutex::new(HashMap::new()),
            metar: RwLock::new(VecDeque::new()),
            metar_keep: if full { 18 } else { 6 },
            sem: Arc::new(Semaphore::new(threads.max(1))),
            inflight: Mutex::new(HashMap::new()),
            max_dim_mrms: if full { 7000 } else { 3500 },
            max_dim_goes: if full { 5424 } else { 2712 },
            local_dir: RwLock::new(None),
        })
    }

    pub fn layer(&self, id: &str) -> Result<&LayerDef> {
        self.layers.iter().find(|l| l.id == id).ok_or_else(|| anyhow!("unknown layer {id}"))
    }

    pub fn catalog(&self) -> serde_json::Value {
        serde_json::json!({
            "layers": self.layers,
            "models": sources::MODELS,
        })
    }

    // ---------- fetch helpers ----------

    async fn list_cached(&self, bucket: &str, prefix: &str, ttl: u64) -> Result<Arc<Vec<s3::Object>>> {
        let k = format!("{bucket}/{prefix}");
        if let Some((t, v)) = self.listings.lock().get(&k) {
            if t.elapsed() < Duration::from_secs(ttl) {
                return Ok(v.clone());
            }
        }
        let l = s3::list(&self.http, bucket, prefix, None, None, 10).await?;
        let v = Arc::new(l.objects);
        self.listings.lock().insert(k, (Instant::now(), v.clone()));
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

    pub async fn frames(&self, layer_id: &str, n: usize, run: Option<&str>, storm: Option<&str>) -> Result<FramesResp> {
        let l = self.layer(layer_id)?.clone();
        if let Some(local) = self.local_frames(&l) {
            return Ok(local);
        }
        let res = match l.source {
            "mrms" => self.mrms_frames(&l, n).await,
            "model" => self.model_frames(&l, run, storm).await,
            "ndfd" => self.ndfd_frames(&l).await,
            "metar" => Ok(self.metar_frames(&l, n)),
            "goes" => self.goes_frames(&l, n).await,
            _ => bail!("unknown source"),
        };
        let name = match l.source {
            "mrms" => "MRMS",
            "model" => "Models",
            "ndfd" => "NDFD",
            "metar" => "METAR analysis",
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
                let t = goes::time_from_name(&n).or_else(|| {
                    let stem = n.rsplit('_').next()?.split('.').next()?;
                    chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d-%H%M%S").ok().map(|d| d.and_utc().timestamp_millis())
                });
                frames.push(FrameInfo { key: format!("local|{}|{}|0", l.id, n), time: t.unwrap_or(0), label: String::new() });
            }
        }
        frames.sort_by_key(|f| f.time);
        Some(FramesResp { frames, ..Default::default() })
    }

    async fn mrms_frames(&self, l: &LayerDef, n: usize) -> Result<FramesResp> {
        let now = Utc::now();
        let mut keys: Vec<s3::Object> = vec![];
        for back in 0..2 {
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

    async fn model_runs(&self, m: &sources::ModelDef) -> Result<Vec<(String, i64, Vec<u32>, Vec<String>)>> {
        let now = Utc::now();
        let mut out = vec![];
        let mut tried = 0;
        'outer: for back_h in 0..48 {
            let t = now - chrono::Duration::hours(back_h);
            let hh = t.hour();
            if !m.cycles.contains(&hh) {
                continue;
            }
            tried += 1;
            if tried > 8 {
                break;
            }
            let d = ymd(t);
            let prefix = sources::fill_template(m.run_prefix, &d, hh, 0, "");
            let (fhs, storms) = if m.index == "ecmwf" {
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
            if out.len() >= 3 {
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

    async fn goes_frames(&self, l: &LayerDef, n: usize) -> Result<FramesResp> {
        let mut p = l.product.split('|');
        let sat: u32 = p.next().unwrap_or("19").parse()?;
        let sector = p.next().unwrap_or("conus");
        let band: u32 = p.next().unwrap_or("13").parse()?;
        let (_, _, dir, tag, _) = sources::GOES_SECTORS.iter().find(|s| s.0 == sat && s.1 == sector).ok_or_else(|| anyhow!("unknown sector"))?;
        let bucket = format!("noaa-goes{sat}");
        let now = Utc::now();
        let mut keys: Vec<s3::Object> = vec![];
        let want = format!("C{band:02}_G{sat}_");
        for back in 0..4 {
            let t = now - chrono::Duration::hours(back);
            let prefix = format!("{dir}/{:04}/{:03}/{:02}/OR_ABI-L2-{tag}-M", t.year(), t.ordinal(), t.hour());
            let objs = self.list_cached(&bucket, &prefix, 45).await.unwrap_or_default();
            let mut v: Vec<s3::Object> = objs.iter().filter(|o| o.key.contains(&want)).cloned().collect();
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
            .map(|o| FrameInfo { key: format!("goes|{}|{bucket}|{}", l.id, o.key), time: goes::time_from_name(&o.key).unwrap_or(0), label: String::new() })
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
                self.blocking(move || {
                    if l.source == "goes" {
                        return goes::decode_cmip(&b, md);
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
        let file = sources::fill_template(m.file, d, hh, fh, storm);
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
        let valid = Utc.with_ymd_and_hms(d[..4].parse()?, d[4..6].parse()?, d[6..8].parse()?, hh, 0, 0).single().map(|t| t.timestamp_millis()).unwrap_or(0) + fh as i64 * 3_600_000;
        let run_ms = valid - fh as i64 * 3_600_000;
        let matcher = if m.index == "ecmwf" { v.ecmwf.clone().ok_or_else(|| anyhow!("{} not in {}", v.name, m.name))? } else { v.ncep.clone() };
        let mut g = match matcher {
            Match::Ncep(pats) => {
                let rows = sources::parse_ncep_idx(&idx);
                let range = pats.iter().find_map(|p| sources::find_ncep(&rows, p, fh, v.accum)).ok_or_else(|| anyhow!("{} not found in {} F{fh:03}", v.name, m.name))?;
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
        };
        g.valid_ms = valid;
        g.ref_ms = run_ms;
        Ok(g)
    }

    // ---------- render ----------

    pub async fn render(&self, key: &str, bbox: (f64, f64, f64, f64), w: usize, h: usize) -> Result<Bytes> {
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
        Ok(self.grid(key).await?.sample(lat, lon))
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
