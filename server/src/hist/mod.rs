//! Historical archives: NWS warnings (IEM VTEC database) and tropical cyclone best tracks
//! (NHC HURDAT2 + NOAA IBTrACS).
//!
//! Upstream lists are fetched on demand. Anything that can no longer change (past years, past
//! days) is kept on disk under `<data>/hist/` (zstd-compressed JSON); everything is also
//! kept in a small byte-capped in-memory LRU.

pub mod tc;
pub mod warn;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Byte-capped LRU of shared values (each entry carries its approximate size and fetch time).
pub struct ByteLru<V> {
    inner: Mutex<(lru::LruCache<String, (Instant, Arc<V>, usize)>, usize)>,
    cap: usize,
}

impl<V> ByteLru<V> {
    pub fn new(cap: usize) -> Self {
        Self { inner: Mutex::new((lru::LruCache::unbounded(), 0)), cap }
    }
    /// A value no older than `max_age` (None = any age).
    pub fn get(&self, k: &str, max_age: Option<Duration>) -> Option<Arc<V>> {
        let mut g = self.inner.lock();
        match g.0.get(k) {
            Some((t, v, _)) if max_age.map(|m| t.elapsed() < m).unwrap_or(true) => Some(v.clone()),
            _ => None,
        }
    }
    pub fn put(&self, k: String, v: Arc<V>, size: usize) {
        let mut g = self.inner.lock();
        if let Some((_, _, old)) = g.0.put(k, (Instant::now(), v, size)) {
            g.1 -= old;
        }
        g.1 += size;
        while g.1 > self.cap && g.0.len() > 1 {
            match g.0.pop_lru() {
                Some((_, (_, _, n))) => g.1 -= n,
                None => break,
            }
        }
    }
    pub fn bytes(&self) -> usize {
        self.inner.lock().1
    }
}

/// Shared state for the history endpoints.
pub struct Hist {
    pub dir: PathBuf,
    /// parsed warning lists (per state/WFO-year or per day of polygons)
    pub warn_units: ByteLru<Vec<warn::Ev>>,
    /// serialized responses for single warnings
    pub warn_detail: ByteLru<bytes::Bytes>,
    /// lookup tables (zone centroids, PDS/emergency lists)
    pub warn_aux: Mutex<warn::Aux>,
    /// parsed best-track sources, by source id
    pub tc: Mutex<HashMap<&'static str, (Instant, Arc<Vec<tc::Storm>>)>>,
    /// best-track sources being downloaded / last failure (backoff)
    pub tc_state: Mutex<(std::collections::HashSet<&'static str>, HashMap<&'static str, (Instant, String)>)>,
    /// one download per key at a time
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Hist {
    pub fn new(data_dir: &Path) -> Self {
        let dir = data_dir.join("hist");
        std::fs::create_dir_all(dir.join("warn")).ok();
        std::fs::create_dir_all(dir.join("tc")).ok();
        Self {
            dir,
            warn_units: ByteLru::new(48 * 1024 * 1024),
            warn_detail: ByteLru::new(16 * 1024 * 1024),
            warn_aux: Mutex::new(warn::Aux::default()),
            tc: Mutex::new(HashMap::new()),
            tc_state: Mutex::new(Default::default()),
            locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn lock_for(&self, k: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut m = self.locks.lock();
        if m.len() > 256 {
            m.retain(|_, l| Arc::strong_count(l) > 1);
        }
        m.entry(k.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }
}

/// Write a value as zstd-compressed JSON (atomically).
pub fn save_zst<T: Serialize + ?Sized>(p: &Path, v: &T) -> Result<()> {
    let json = serde_json::to_vec(v)?;
    let z = zstd::bulk::compress(&json, 9)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, z)?;
    std::fs::rename(&tmp, p)?;
    Ok(())
}

/// Read a zstd-compressed JSON value, if present and younger than `max_age` (None = any age).
pub fn load_zst<T: DeserializeOwned>(p: &Path, max_age: Option<Duration>) -> Option<T> {
    let m = std::fs::metadata(p).ok()?;
    if let Some(a) = max_age {
        if m.modified().ok()?.elapsed().unwrap_or_default() > a {
            return None;
        }
    }
    let z = std::fs::read(p).ok()?;
    let mut d = zstd::stream::Decoder::new(&z[..]).ok()?;
    let mut out = vec![];
    std::io::copy(&mut d, &mut out).ok()?;
    serde_json::from_slice(&out).with_context(|| format!("{}", p.display())).map_err(|e| tracing::warn!("{e:#}")).ok()
}

/// A safe file name piece.
pub fn fname(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_cap() {
        let c: ByteLru<u32> = ByteLru::new(100);
        c.put("a".into(), Arc::new(1), 60);
        c.put("b".into(), Arc::new(2), 60);
        assert!(c.get("a", None).is_none());
        assert_eq!(*c.get("b", None).unwrap(), 2);
        assert_eq!(c.bytes(), 60);
    }

    #[test]
    fn zst_roundtrip() {
        let d = std::env::temp_dir().join(format!("tbw-hist-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("x.json.zst");
        save_zst(&p, &vec![1, 2, 3]).unwrap();
        let v: Vec<i32> = load_zst(&p, None).unwrap();
        assert_eq!(v, vec![1, 2, 3]);
        std::fs::remove_dir_all(&d).ok();
    }
}
