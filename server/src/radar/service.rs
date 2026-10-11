//! Radar data service: history listing, download cache, decode cache, encoded-sweep cache.

use super::encode;
use super::level2::{tilts, Decoder, Moment, Volume};
use super::level3;
use crate::health::Health;
use crate::s3;
use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use chrono::{Datelike, TimeZone, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Serialize)]
pub struct VolEntry {
    pub key: String,
    pub time: i64,
    pub size: u64,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct TiltMeta {
    pub index: usize,
    pub angle: f32,
    pub moments: Vec<String>,
    pub time: i64,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VolMeta {
    pub key: String,
    pub site: String,
    pub vcp: u16,
    pub lat: f32,
    pub lon: f32,
    pub time: i64,
    pub end: i64,
    pub complete: bool,
    pub tilts: Vec<TiltMeta>,
}

pub fn vol_meta(key: &str, v: &Volume) -> VolMeta {
    let t = tilts(v);
    VolMeta {
        key: key.to_string(),
        site: v.site.clone(),
        vcp: v.vcp,
        lat: v.lat,
        lon: v.lon,
        time: v.start_ms(),
        end: v.end_ms(),
        complete: v.complete,
        tilts: t
            .iter()
            .map(|t| {
                let first = *t.sweeps.values().min().unwrap_or(&0);
                TiltMeta {
                    index: t.index,
                    angle: t.angle,
                    moments: t.sweeps.keys().cloned().collect(),
                    time: v.sweeps[first].start_ms(),
                    complete: t.sweeps.values().all(|&i| v.sweeps[i].complete),
                }
            })
            .collect(),
    }
}

/// Encode a sweep of a volume by tilt index + moment.
pub fn encode_tilt(v: &Volume, tilt: usize, moment: &str) -> Result<Vec<u8>> {
    let m = Moment::parse(moment).ok_or_else(|| anyhow!("unknown moment {moment}"))?;
    let t = tilts(v);
    let t = t.get(tilt).ok_or_else(|| anyhow!("tilt {tilt} not found"))?;
    let si = *t.sweeps.get(m.code()).ok_or_else(|| anyhow!("{moment} not in tilt {tilt}"))?;
    let e = encode::encode_l2(v, &v.sweeps[si], m).ok_or_else(|| anyhow!("empty sweep"))?;
    Ok(e.bytes)
}

/// Byte-budgeted LRU.
struct SizedLru<V> {
    map: lru::LruCache<String, (V, usize)>,
    bytes: usize,
    cap: usize,
}

impl<V: Clone> SizedLru<V> {
    fn new(cap: usize) -> Self {
        Self { map: lru::LruCache::unbounded(), bytes: 0, cap }
    }
    fn get(&mut self, k: &str) -> Option<V> {
        self.map.get(k).map(|(v, _)| v.clone())
    }
    fn put(&mut self, k: String, v: V, size: usize) {
        if let Some((_, s)) = self.map.put(k, (v, size)) {
            self.bytes -= s;
        }
        self.bytes += size;
        while self.bytes > self.cap {
            match self.map.pop_lru() {
                Some((_, (_, s))) => self.bytes -= s,
                None => break,
            }
        }
    }
}

fn volume_bytes(v: &Volume) -> usize {
    v.sweeps
        .iter()
        .map(|s| s.radials.iter().map(|r| 64 + r.moments.iter().map(|m| m.data.len() + 48).sum::<usize>()).sum::<usize>())
        .sum::<usize>()
        + 1024
}

pub struct RadarService {
    pub http: reqwest::Client,
    pub l2_buckets: Vec<String>,
    pub l3_buckets: Vec<String>,
    l2_bucket_idx: AtomicUsize,
    l3_bucket_idx: AtomicUsize,
    pub tgftp_base: String,
    pub cache_dir: PathBuf,
    pub upload_dir: PathBuf,
    pub local_dir: Option<PathBuf>,
    pub disk_cap: u64,
    volumes: Mutex<SizedLru<Arc<Volume>>>,
    encoded: Mutex<SizedLru<Bytes>>,
    decode_sem: Arc<Semaphore>,
    pub health: Arc<Health>,
    pub l3_catalog: Vec<serde_json::Value>,
}

fn safe_name(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// Parse time from a Level II filename like KTLX20130520_200356_V06(.gz)
pub fn l2_time_from_name(name: &str) -> Option<i64> {
    let base = name.rsplit('/').next()?;
    if base.len() < 19 {
        return None;
    }
    let d = &base[4..12];
    let t = &base[13..19];
    let (y, m, dd) = (d[0..4].parse().ok()?, d[4..6].parse().ok()?, d[6..8].parse().ok()?);
    let (hh, mi, ss) = (t[0..2].parse().ok()?, t[2..4].parse().ok()?, t[4..6].parse().ok()?);
    Utc.with_ymd_and_hms(y, m, dd, hh, mi, ss).single().map(|x| x.timestamp_millis())
}

/// Parse time from a Level III AWS key like LOT_N0B_2026_10_11_12_34_56
pub fn l3_time_from_key(key: &str) -> Option<i64> {
    let p: Vec<&str> = key.split('_').collect();
    if p.len() < 7 {
        return None;
    }
    let n = |i: usize| p.get(i).and_then(|s| s.parse::<u32>().ok());
    Utc.with_ymd_and_hms(n(2)? as i32, n(3)?, n(4)?, n(5)?, n(6)?, n(7).unwrap_or(0))
        .single()
        .map(|x| x.timestamp_millis())
}

impl RadarService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        http: reqwest::Client,
        cfg: &crate::config::RadarCfg,
        data_dir: &std::path::Path,
        memory_mb: usize,
        threads: usize,
        disk_cap: u64,
        health: Arc<Health>,
    ) -> Self {
        let cache_dir = data_dir.join("cache/raw");
        let upload_dir = data_dir.join("uploads");
        std::fs::create_dir_all(&cache_dir).ok();
        std::fs::create_dir_all(&upload_dir).ok();
        let local_dir = if cfg.local_archive_dir.is_empty() { None } else { Some(PathBuf::from(&cfg.local_archive_dir)) };
        let l3_catalog: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../data/level3_products.json")).unwrap_or_default();
        Self {
            http,
            l2_buckets: cfg.level2_buckets.clone(),
            l3_buckets: cfg.level3_buckets.clone(),
            l2_bucket_idx: AtomicUsize::new(0),
            l3_bucket_idx: AtomicUsize::new(0),
            tgftp_base: cfg.tgftp_base.clone(),
            cache_dir,
            upload_dir,
            local_dir,
            disk_cap,
            volumes: Mutex::new(SizedLru::new(memory_mb * 1024 * 1024 * 3 / 4)),
            encoded: Mutex::new(SizedLru::new(memory_mb * 1024 * 1024 / 4)),
            decode_sem: Arc::new(Semaphore::new(threads.max(1))),
            health,
            l3_catalog,
        }
    }

    // ---------- listing ----------

    fn local_entries(&self, site: &str, day: Option<(i32, u32, u32)>) -> Vec<VolEntry> {
        let mut out = vec![];
        let mut scan = |dir: &std::path::Path, prefix: &str, source: &'static str| {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !name.to_ascii_uppercase().starts_with(site) {
                        continue;
                    }
                    let Some(t) = l2_time_from_name(&name) else { continue };
                    if let Some((y, m, d)) = day {
                        let dt = Utc.timestamp_millis_opt(t).single().unwrap();
                        if (dt.year(), dt.month(), dt.day()) != (y, m, d) {
                            continue;
                        }
                    }
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    out.push(VolEntry { key: format!("{prefix}:{name}"), time: t, size, source });
                }
            }
        };
        if let Some(d) = &self.local_dir {
            scan(d, "local", "local");
        }
        scan(&self.upload_dir.clone(), "file", "upload");
        out
    }

    /// Volumes for a site on a UTC day.
    pub async fn list_day(&self, site: &str, y: i32, m: u32, d: u32) -> Result<Vec<VolEntry>> {
        let site = site.to_ascii_uppercase();
        let prefix = format!("{y:04}/{m:02}/{d:02}/{site}/");
        let mut out = self.local_entries(&site, Some((y, m, d)));
        let n = self.l2_buckets.len();
        let start = self.l2_bucket_idx.load(Ordering::Relaxed);
        let mut last_err = None;
        for i in 0..n {
            let bi = (start + i) % n;
            let bucket = &self.l2_buckets[bi];
            match s3::list(&self.http, bucket, &prefix, None, None, 5).await {
                Ok(l) => {
                    if l.objects.is_empty() && i + 1 < n {
                        // maybe the other bucket has this date
                        continue;
                    }
                    self.l2_bucket_idx.store(bi, Ordering::Relaxed);
                    self.health.ok("nexrad-l2", "NEXRAD Level II archive", format!("s3://{bucket}"));
                    for o in l.objects {
                        if o.key.ends_with("_MDM") || o.key.ends_with(".tar") {
                            continue;
                        }
                        if let Some(t) = l2_time_from_name(&o.key) {
                            out.push(VolEntry { key: format!("aws:{bucket}/{}", o.key), time: t, size: o.size, source: "aws" });
                        }
                    }
                    last_err = None;
                    break;
                }
                Err(e) => last_err = Some(e),
            }
        }
        if let Some(e) = last_err {
            self.health.err("nexrad-l2", "NEXRAD Level II archive", &e);
            if out.is_empty() {
                return Err(e);
            }
        }
        out.sort_by_key(|e| e.time);
        out.dedup_by_key(|e| e.time);
        Ok(out)
    }

    /// Most recent `n` volumes (looks back up to 2 days).
    pub async fn latest(&self, site: &str, n: usize) -> Result<Vec<VolEntry>> {
        let now = Utc::now();
        let mut all = vec![];
        for back in 0..3 {
            let day = now - chrono::Duration::days(back);
            let mut v = self.list_day(site, day.year(), day.month(), day.day()).await.unwrap_or_default();
            v.append(&mut all);
            all = v;
            if all.len() >= n {
                break;
            }
        }
        if all.is_empty() {
            // nothing on S3 (or offline): fall back to any local files for the site
            let mut l = self.local_entries(&site.to_ascii_uppercase(), None);
            l.sort_by_key(|e| e.time);
            all = l;
        }
        let k = all.len().saturating_sub(n);
        Ok(all.split_off(k))
    }

    // ---------- raw bytes ----------

    async fn cached_fetch(&self, bucket: &str, key: &str) -> Result<Bytes> {
        let path = self.cache_dir.join(safe_name(&format!("{bucket}/{key}")));
        if let Ok(b) = tokio::fs::read(&path).await {
            // touch for LRU eviction
            let _ = filetime_touch(&path);
            return Ok(Bytes::from(b));
        }
        let b = s3::get(&self.http, bucket, key).await?;
        let tmp = path.with_extension("part");
        if tokio::fs::write(&tmp, &b).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &path).await;
        }
        Ok(b)
    }

    pub async fn raw(&self, key: &str) -> Result<Bytes> {
        if let Some(rest) = key.strip_prefix("aws:") {
            let (bucket, k) = rest.split_once('/').ok_or_else(|| anyhow!("bad key"))?;
            if !self.l2_buckets.iter().any(|b| b == bucket) && !self.l3_buckets.iter().any(|b| b == bucket) {
                bail!("bucket not allowed");
            }
            return self.cached_fetch(bucket, k).await;
        }
        if let Some(name) = key.strip_prefix("local:") {
            let dir = self.local_dir.as_ref().ok_or_else(|| anyhow!("no local archive"))?;
            return Ok(Bytes::from(tokio::fs::read(dir.join(safe_name(name))).await?));
        }
        if let Some(name) = key.strip_prefix("file:") {
            return Ok(Bytes::from(tokio::fs::read(self.upload_dir.join(safe_name(name))).await?));
        }
        if let Some(rest) = key.strip_prefix("rec:") {
            // recordings: rec:<recording id>/<file>
            let (id, f) = rest.split_once('/').ok_or_else(|| anyhow!("bad key"))?;
            let dir = self.upload_dir.parent().map(|p| p.join("recordings")).ok_or_else(|| anyhow!("no recordings"))?;
            return Ok(Bytes::from(tokio::fs::read(dir.join(safe_name(id)).join(safe_name(f))).await?));
        }
        bail!("unknown key type")
    }

    // ---------- decode ----------

    pub async fn volume(&self, key: &str) -> Result<Arc<Volume>> {
        if let Some(v) = self.volumes.lock().get(key) {
            return Ok(v);
        }
        let raw = self.raw(key).await?;
        let _permit = self.decode_sem.clone().acquire_owned().await?;
        if let Some(v) = self.volumes.lock().get(key) {
            return Ok(v);
        }
        let k = key.to_string();
        let vol = tokio::task::spawn_blocking(move || -> Result<Volume> {
            let mut v = Decoder::decode_file(&raw).with_context(|| format!("decode {k}"))?;
            if v.site.is_empty() {
                // legacy files carry no ICAO; take it from the filename
                let base = k.rsplit(['/', ':']).next().unwrap_or("");
                v.site = base.chars().take(4).collect::<String>().to_ascii_uppercase();
            }
            Ok(v)
        })
        .await??;
        let size = volume_bytes(&vol);
        let vol = Arc::new(vol);
        self.volumes.lock().put(key.to_string(), vol.clone(), size);
        Ok(vol)
    }

    pub async fn meta(&self, key: &str) -> Result<VolMeta> {
        let v = self.volume(key).await?;
        Ok(vol_meta(key, &v))
    }

    /// zstd-compressed TBWS sweep
    pub async fn sweep(&self, key: &str, tilt: usize, moment: &str) -> Result<Bytes> {
        let ck = format!("{key}|{tilt}|{moment}");
        if let Some(b) = self.encoded.lock().get(&ck) {
            return Ok(b);
        }
        let v = self.volume(key).await?;
        let moment = moment.to_string();
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let raw = encode_tilt(&v, tilt, &moment)?;
            Ok(encode::zstd(&raw))
        })
        .await??;
        let b = Bytes::from(bytes);
        self.encoded.lock().put(ck, b.clone(), b.len());
        Ok(b)
    }

    pub async fn store_upload(&self, name: &str, body: Bytes) -> Result<String> {
        let mut name = safe_name(name);
        if name.is_empty() {
            name = format!("upload_{}", Utc::now().timestamp());
        }
        // ensure the name carries a site + time for listing; decode once to check
        let b2 = body.clone();
        let vol = tokio::task::spawn_blocking(move || Decoder::decode_file(&b2)).await??;
        if vol.sweeps.is_empty() {
            bail!("no radar sweeps found in file");
        }
        if l2_time_from_name(&name).is_none() && !vol.site.is_empty() {
            let t = Utc.timestamp_millis_opt(vol.start_ms()).single().unwrap_or_else(Utc::now);
            name = format!("{}{}_V06_{}", vol.site, t.format("%Y%m%d_%H%M%S"), name);
        }
        tokio::fs::write(self.upload_dir.join(&name), &body).await?;
        Ok(format!("file:{name}"))
    }

    // ---------- Level III ----------

    pub fn l3_product(&self, id: &str) -> Option<&serde_json::Value> {
        self.l3_catalog.iter().find(|p| p["id"].as_str() == Some(id))
    }

    pub async fn l3_list(&self, site3: &str, prod: &str, n: usize) -> Result<Vec<VolEntry>> {
        let site3 = site3.to_ascii_uppercase();
        let prod = prod.to_ascii_uppercase();
        let now = Utc::now();
        let mut all: Vec<VolEntry> = vec![];
        let nb = self.l3_buckets.len();
        let start = self.l3_bucket_idx.load(Ordering::Relaxed);
        let mut last_err = None;
        'outer: for i in 0..nb {
            let bi = (start + i) % nb;
            let bucket = &self.l3_buckets[bi];
            all.clear();
            for back in 0..2 {
                let d = now - chrono::Duration::days(back);
                let prefix = format!("{site3}_{prod}_{:04}_{:02}_{:02}", d.year(), d.month(), d.day());
                match s3::list(&self.http, bucket, &prefix, None, None, 3).await {
                    Ok(l) => {
                        let mut v: Vec<VolEntry> = l
                            .objects
                            .into_iter()
                            .filter_map(|o| {
                                l3_time_from_key(&o.key).map(|t| VolEntry { key: format!("aws:{bucket}/{}", o.key), time: t, size: o.size, source: "aws" })
                            })
                            .collect();
                        v.append(&mut all);
                        all = v;
                        if all.len() >= n {
                            break;
                        }
                    }
                    Err(e) => {
                        last_err = Some(e);
                        continue 'outer;
                    }
                }
            }
            if !all.is_empty() {
                self.l3_bucket_idx.store(bi, Ordering::Relaxed);
                self.health.ok("nexrad-l3", "NEXRAD Level III", format!("s3://{bucket}"));
                last_err = None;
                break;
            }
        }
        if all.is_empty() {
            // tgftp fallback: latest file only
            if let Some(p) = self.l3_product(&prod) {
                if let Some(ds) = p["tgftp"].as_str() {
                    let url = format!("{}/{}/SI.k{}/sn.last", self.tgftp_base, ds, site3.to_ascii_lowercase());
                    all.push(VolEntry { key: format!("tgftp:{url}"), time: now.timestamp_millis(), size: 0, source: "tgftp" });
                }
            }
        }
        if let Some(e) = last_err {
            self.health.err("nexrad-l3", "NEXRAD Level III", &e);
        }
        all.sort_by_key(|e| e.time);
        let k = all.len().saturating_sub(n);
        Ok(all.split_off(k))
    }

    /// Raw Level III file bytes for any L3 key (used by recordings).
    pub async fn l3_raw(&self, key: &str) -> Result<Bytes> {
        if let Some(url) = key.strip_prefix("tgftp:") {
            if !url.starts_with(&self.tgftp_base) {
                bail!("url not allowed");
            }
            let r = self.http.get(url).send().await?;
            if !r.status().is_success() {
                bail!("tgftp HTTP {}", r.status());
            }
            return Ok(r.bytes().await?);
        }
        self.raw(key).await
    }

    pub async fn l3_data(&self, key: &str) -> Result<Bytes> {
        let tg = key.starts_with("tgftp:");
        if !tg {
            if let Some(b) = self.encoded.lock().get(key) {
                return Ok(b);
            }
        }
        let raw = if let Some(url) = key.strip_prefix("tgftp:") {
            if !url.starts_with(&self.tgftp_base) {
                bail!("url not allowed");
            }
            let r = self.http.get(url).send().await?;
            if !r.status().is_success() {
                bail!("tgftp HTTP {}", r.status());
            }
            r.bytes().await?
        } else {
            self.raw(key).await?
        };
        let name: String = key.rsplit('/').next().unwrap_or("").split('_').nth(1).unwrap_or("L3").to_string();
        let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let p = level3::decode(&raw)?;
            Ok(encode::zstd(&encode::encode_l3(&p, &name).bytes))
        })
        .await??;
        let b = Bytes::from(bytes);
        if !tg {
            self.encoded.lock().put(key.to_string(), b.clone(), b.len());
        }
        Ok(b)
    }

    /// Keep the raw download cache under its cap (oldest files go first).
    pub fn spawn_cache_janitor(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let dir = me.cache_dir.clone();
                let cap = me.disk_cap;
                let _ = tokio::task::spawn_blocking(move || evict(&dir, cap)).await;
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            }
        });
    }
}

fn filetime_touch(p: &std::path::Path) -> std::io::Result<()> {
    let f = std::fs::OpenOptions::new().append(true).open(p)?;
    f.set_modified(std::time::SystemTime::now())
}

fn evict(dir: &std::path::Path, cap: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= cap {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, p) in files {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}

pub fn parse_date(s: &str) -> Result<(i32, u32, u32)> {
    let s = s.replace('-', "");
    if s.len() != 8 {
        bail!("date must be YYYYMMDD");
    }
    Ok((s[0..4].parse()?, s[4..6].parse()?, s[6..8].parse()?))
}
