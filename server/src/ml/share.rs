//! 0.8.1: training jobs running at the same time share their data.
//!
//! * [`Inflight`]: request de-duplication. The first caller of a key runs the download / decode;
//!   callers of the same key meanwhile wait for that result instead of starting their own.
//! * [`SharedFetch`]: wraps the data source ([`Fetch`]) with in-flight de-duplication of radar
//!   volumes, raw files, listings, label databases, environment sampling and gridded truth, and
//!   a ref-counted on-disk store: each job announces at start the radar volumes it will read
//!   ([`Fetch::plan`]); a volume planned by two or more running jobs is kept on disk
//!   (`data/cache/ml/shared`) until the last of them finishes, so the second job never downloads
//!   it again even when the first one is far ahead.
//! * Per-job counters (`shared` requests / bytes) are reported in the job's usage and log.
//!
//! Gridded downloads (MRMS, GFS / HRRR ranges, GOES, …) go through `NetSource::get`, which
//! de-duplicates in-flight requests with the same [`Inflight`].

use super::features::{FeatMap, Sources};
use super::labels::Event;
use super::source::{Bf, EnvCtx, Fetch, TruthReq};
use crate::hist::tc::Storm;
use crate::radar::level2::Volume;
use crate::radar::service::VolEntry;
use crate::sites::Site;
use anyhow::{anyhow, Result};
use bytes::Bytes;
use chrono::NaiveDate;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

type Cell<T> = Arc<tokio::sync::OnceCell<std::result::Result<T, String>>>;

/// In-flight de-duplication: one run per key at a time, every concurrent caller gets its result.
pub struct Inflight<T> {
    map: Mutex<HashMap<String, Cell<T>>>,
}

impl<T> Default for Inflight<T> {
    fn default() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }
}

impl<T: Clone + Send + Sync + 'static> Inflight<T> {
    /// Run `f` for `key`, or wait for the run already in flight. Returns the result and whether
    /// it came from another caller's run.
    pub async fn run<F, Fut>(&self, key: &str, f: F) -> (Result<T>, bool)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let cell: Cell<T> = self.map.lock().entry(key.to_string()).or_default().clone();
        let mut ran = false;
        let r = cell
            .get_or_init(|| {
                ran = true;
                async move { f().await.map_err(|e| format!("{e:#}")) }
            })
            .await
            .clone();
        if ran {
            // done: later callers start a new run (results are not kept here)
            let mut g = self.map.lock();
            if g.get(key).map(|c| Arc::ptr_eq(c, &cell)).unwrap_or(false) {
                g.remove(key);
            }
        }
        (r.map_err(|e| anyhow!(e)), !ran)
    }

    pub fn in_flight(&self) -> usize {
        self.map.lock().len()
    }
}

/// Counts a request served by another job's download (current job's usage counters).
fn count_shared(bytes: u64) {
    if let Some(u) = super::jobs::current() {
        u.shared.fetch_add(1, Ordering::Relaxed);
        u.shared_bytes.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// The current job (its usage counters' address), if any.
fn job_id() -> Option<usize> {
    super::jobs::current().map(|u| Arc::as_ptr(&u) as usize)
}

fn hash_of(x: impl Hash) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    x.hash(&mut h);
    h.finish()
}

fn pts_key(pts: &[(f64, f64)]) -> u64 {
    hash_of(pts.iter().map(|p| (p.0.to_bits(), p.1.to_bits())).collect::<Vec<_>>())
}

/// Planned keys per job and jobs per key (the ref counts of the on-disk store).
#[derive(Default)]
struct Plans {
    by_job: HashMap<usize, HashSet<String>>,
    refs: HashMap<String, usize>,
    /// keys on disk → bytes
    pinned: HashMap<String, u64>,
    pinned_bytes: u64,
}

pub struct SharedFetch {
    inner: Arc<dyn Fetch>,
    vols: Inflight<Arc<Volume>>,
    raws: Inflight<Bytes>,
    lists: Inflight<Vec<VolEntry>>,
    events: Inflight<Vec<Event>>,
    envs: Inflight<Vec<FeatMap>>,
    truths: Inflight<Vec<f32>>,
    plans: Mutex<Plans>,
    dir: PathBuf,
    /// cap of the on-disk store
    pub max_pinned_bytes: AtomicU64,
    /// requests answered from another job's run (all jobs)
    pub shared_total: AtomicU64,
}

impl SharedFetch {
    pub fn wrap(inner: Arc<dyn Fetch>, dir: PathBuf) -> Arc<SharedFetch> {
        // left over from a previous process: no job holds them any more
        std::fs::remove_dir_all(&dir).ok();
        Arc::new(SharedFetch {
            inner,
            vols: Default::default(),
            raws: Default::default(),
            lists: Default::default(),
            events: Default::default(),
            envs: Default::default(),
            truths: Default::default(),
            plans: Mutex::new(Plans::default()),
            dir,
            max_pinned_bytes: AtomicU64::new(4 << 30),
            shared_total: AtomicU64::new(0),
        })
    }

    fn shared(&self, bytes: u64) {
        self.shared_total.fetch_add(1, Ordering::Relaxed);
        count_shared(bytes);
    }

    fn path_of(&self, key: &str) -> PathBuf {
        let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect();
        self.dir.join(format!("{:016x}-{}", hash_of(key), &safe[safe.len().saturating_sub(60)..]))
    }

    /// Jobs (other than the current one) that planned `key`.
    fn others(&self, key: &str) -> usize {
        let g = self.plans.lock();
        let me = job_id();
        let n = g.refs.get(key).copied().unwrap_or(0);
        let mine = me.and_then(|j| g.by_job.get(&j)).map(|s| s.contains(key)).unwrap_or(false);
        n.saturating_sub(mine as usize)
    }

    /// The current job finished: drop its plan; files no job needs any more are deleted.
    pub fn release_current(&self) {
        if let Some(j) = job_id() {
            self.release(j);
        }
    }

    fn release(&self, job: usize) {
        let mut g = self.plans.lock();
        let Some(keys) = g.by_job.remove(&job) else { return };
        let mut drop_files = vec![];
        for k in keys {
            let n = g.refs.get(&k).copied().unwrap_or(0);
            if n <= 1 {
                g.refs.remove(&k);
                if let Some(b) = g.pinned.remove(&k) {
                    g.pinned_bytes = g.pinned_bytes.saturating_sub(b);
                    drop_files.push(k);
                }
            } else {
                g.refs.insert(k, n - 1);
            }
        }
        drop(g);
        for k in drop_files {
            std::fs::remove_file(self.path_of(&k)).ok();
        }
    }

    /// (keys planned by 2+ jobs, files on disk, bytes on disk, requests shared)
    pub fn stats(&self) -> (usize, usize, u64, u64) {
        let g = self.plans.lock();
        (g.refs.values().filter(|n| **n >= 2).count(), g.pinned.len(), g.pinned_bytes, self.shared_total.load(Ordering::Relaxed))
    }

    /// Raw bytes of a volume key, kept on disk while another running job planned it too.
    async fn pinned_raw(&self, key: &str) -> Option<Bytes> {
        let on_disk = self.plans.lock().pinned.contains_key(key);
        if on_disk {
            if let Ok(b) = tokio::fs::read(self.path_of(key)).await {
                self.shared(b.len() as u64);
                return Some(Bytes::from(b));
            }
        }
        if self.others(key) == 0 {
            return None;
        }
        let (r, shared) = self.raws.run(key, || self.inner.raw(key)).await;
        let b = r.ok()?;
        if shared {
            self.shared(b.len() as u64);
        }
        let mut g = self.plans.lock();
        if !g.pinned.contains_key(key) && g.pinned_bytes + b.len() as u64 <= self.max_pinned_bytes.load(Ordering::Relaxed) {
            std::fs::create_dir_all(&self.dir).ok();
            if crate::platform::write_atomic(&self.path_of(key), &b).is_ok() {
                g.pinned.insert(key.to_string(), b.len() as u64);
                g.pinned_bytes += b.len() as u64;
            }
        }
        Some(b)
    }
}

impl Fetch for SharedFetch {
    fn sites(&self) -> Vec<Site> {
        self.inner.sites()
    }

    fn list_day<'a>(&'a self, site: &'a str, day: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
        Box::pin(async move {
            let (r, shared) = self.lists.run(&format!("{site}|{day}"), || self.inner.list_day(site, day)).await;
            if shared {
                self.shared(0);
            }
            r
        })
    }

    fn latest<'a>(&'a self, site: &'a str) -> Bf<'a, Option<VolEntry>> {
        self.inner.latest(site)
    }

    fn volume<'a>(&'a self, key: &'a str) -> Bf<'a, Arc<Volume>> {
        Box::pin(async move {
            let (r, shared) = self
                .vols
                .run(key, || async move {
                    // planned by another running job too: keep the raw file until both are done
                    if let Some(raw) = self.pinned_raw(key).await {
                        let k = key.to_string();
                        let decoded = tokio::task::spawn_blocking(move || -> Result<Volume> {
                            let base = k.rsplit(['/', ':']).next().unwrap_or("").to_string();
                            let mut v = crate::radar::service::decode_any(&raw, &base)?;
                            if v.site.is_empty() {
                                v.site = base.chars().take(4).collect::<String>().to_ascii_uppercase();
                            }
                            Ok(v)
                        })
                        .await;
                        if let Ok(Ok(v)) = decoded {
                            return Ok(Arc::new(v));
                        }
                    }
                    self.inner.volume(key).await
                })
                .await;
            if shared {
                self.shared(0);
            }
            r
        })
    }

    fn spc<'a>(&'a self, kind: &'a str, years: (i32, i32)) -> Bf<'a, Vec<Event>> {
        Box::pin(async move {
            let (r, s) = self.events.run(&format!("spc|{kind}|{years:?}"), || self.inner.spc(kind, years)).await;
            if s {
                self.shared(0);
            }
            r
        })
    }

    fn lsr<'a>(&'a self, t0: i64, t1: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async move {
            let (r, s) = self.events.run(&format!("lsr|{t0}|{t1}"), || self.inner.lsr(t0, t1)).await;
            if s {
                self.shared(0);
            }
            r
        })
    }

    fn sbw<'a>(&'a self, t0: i64, t1: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async move {
            let (r, s) = self.events.run(&format!("sbw|{t0}|{t1}"), || self.inner.sbw(t0, t1)).await;
            if s {
                self.shared(0);
            }
            r
        })
    }

    fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
        self.inner.storms()
    }

    fn fires(&self, day: NaiveDate) -> Bf<'_, Vec<Event>> {
        Box::pin(async move {
            let (r, s) = self.events.run(&format!("fires|{day}"), || self.inner.fires(day)).await;
            if s {
                self.shared(0);
            }
            r
        })
    }

    fn env<'a>(&'a self, s: &'a Sources, t: i64, pts: &'a [(f64, f64)], realtime: bool) -> Bf<'a, Vec<FeatMap>> {
        Box::pin(async move {
            let key = format!("env|{:x}|{t}|{realtime}|{:x}|{}", hash_of(format!("{s:?}")), pts_key(pts), pts.len());
            let (r, sh) = self.envs.run(&key, || self.inner.env(s, t, pts, realtime)).await;
            if sh {
                self.shared(0);
            }
            r
        })
    }

    fn env_ctx<'a>(&'a self, s: &'a Sources, ctx: EnvCtx, pts: &'a [(f64, f64)], realtime: bool) -> Bf<'a, Vec<FeatMap>> {
        Box::pin(async move {
            let key = format!("envc|{:x}|{}|{:?}|{realtime}|{:x}|{}", hash_of(format!("{s:?}")), ctx.t, ctx.win, pts_key(pts), pts.len());
            let (r, sh) = self.envs.run(&key, || self.inner.env_ctx(s, ctx, pts, realtime)).await;
            if sh {
                self.shared(0);
            }
            r
        })
    }

    fn truth<'a>(&'a self, req: &'a TruthReq, pts: &'a [(f64, f64)]) -> Bf<'a, Vec<f32>> {
        Box::pin(async move {
            let key = format!("truth|{}|{}|{}|{}|{}|{:x}|{}", req.kind, req.t0, req.t1, req.radius_km, req.realtime, pts_key(pts), pts.len());
            let (r, sh) = self.truths.run(&key, || self.inner.truth(req, pts)).await;
            if sh {
                self.shared(0);
            }
            r
        })
    }

    fn prefetch<'a>(&'a self, key: &'a str) -> Bf<'a, ()> {
        Box::pin(async move {
            // a volume another job keeps on disk needs no prefetch
            if self.plans.lock().pinned.contains_key(key) {
                return Ok(());
            }
            self.inner.prefetch(key).await
        })
    }

    fn raw<'a>(&'a self, key: &'a str) -> Bf<'a, Bytes> {
        Box::pin(async move {
            let (r, s) = self.raws.run(key, || self.inner.raw(key)).await;
            if s {
                self.shared(r.as_ref().map(|b| b.len() as u64).unwrap_or(0));
            }
            r
        })
    }

    fn set_decode_threads(&self, n: usize) {
        self.inner.set_decode_threads(n)
    }

    fn pred_sink(&self) -> Option<Arc<dyn super::predict::PredSink>> {
        self.inner.pred_sink()
    }

    fn cache_bytes(&self) -> (usize, usize) {
        self.inner.cache_bytes()
    }

    fn clear_cache(&self) {
        self.inner.clear_cache()
    }

    fn plan(&self, keys: &[String]) -> usize {
        let Some(j) = job_id() else { return 0 };
        let mut g = self.plans.lock();
        let mut new = vec![];
        {
            let mine = g.by_job.entry(j).or_default();
            for k in keys {
                if mine.insert(k.clone()) {
                    new.push(k.clone());
                }
            }
        }
        let mut overlap = 0;
        for k in new {
            let n = g.refs.entry(k).or_insert(0);
            if *n >= 1 {
                overlap += 1;
            }
            *n += 1;
        }
        overlap
    }

    fn release_plan(&self) {
        self.release_current();
    }

    fn shared_stats(&self) -> Option<serde_json::Value> {
        let (keys, files, bytes, n) = self.stats();
        Some(serde_json::json!({"keys_shared": keys, "files": files, "bytes": bytes, "requests_shared": n, "in_flight": self.vols.in_flight() + self.raws.in_flight() + self.envs.in_flight()}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn inflight_runs_once_for_concurrent_callers() {
        let f: Arc<Inflight<u32>> = Arc::new(Inflight::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let mut hs = vec![];
        for _ in 0..8 {
            let (f, runs) = (f.clone(), runs.clone());
            hs.push(tokio::spawn(async move {
                f.run("radar|KTLX|20240501_2300", || async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                    Ok(7)
                })
                .await
            }));
        }
        let mut shared = 0;
        for h in hs {
            let (r, s) = h.await.unwrap();
            assert_eq!(r.unwrap(), 7);
            shared += s as usize;
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1, "one download for 8 waiters");
        assert_eq!(shared, 7);
        // finished: the next call runs again (nothing is cached here)
        let (r, s) = f.run("radar|KTLX|20240501_2300", || async { Ok(8) }).await;
        assert_eq!((r.unwrap(), s), (8, false));
        assert_eq!(f.in_flight(), 0);
        // errors reach every waiter, and the key is free again
        let (r, _) = f.run("bad", || async { Err(anyhow!("HTTP 404")) }).await;
        assert!(r.unwrap_err().to_string().contains("404"));
        assert_eq!(f.in_flight(), 0);
    }

    #[tokio::test]
    async fn plans_ref_count_the_disk_store() {
        struct Src(AtomicUsize);
        impl Fetch for Src {
            fn sites(&self) -> Vec<Site> {
                vec![]
            }
            fn list_day<'a>(&'a self, _s: &'a str, _d: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
                Box::pin(async { Ok(vec![]) })
            }
            fn latest<'a>(&'a self, _s: &'a str) -> Bf<'a, Option<VolEntry>> {
                Box::pin(async { Ok(None) })
            }
            fn volume<'a>(&'a self, _k: &'a str) -> Bf<'a, Arc<Volume>> {
                Box::pin(async { Err(anyhow!("no volumes")) })
            }
            fn spc<'a>(&'a self, _k: &'a str, _y: (i32, i32)) -> Bf<'a, Vec<Event>> {
                Box::pin(async { Ok(vec![]) })
            }
            fn lsr<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
                Box::pin(async { Ok(vec![]) })
            }
            fn sbw<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
                Box::pin(async { Ok(vec![]) })
            }
            fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
                Box::pin(async { Ok(Arc::new(vec![])) })
            }
            fn fires(&self, _d: NaiveDate) -> Bf<'_, Vec<Event>> {
                Box::pin(async { Ok(vec![]) })
            }
            fn env<'a>(&'a self, _s: &'a Sources, _t: i64, pts: &'a [(f64, f64)], _r: bool) -> Bf<'a, Vec<FeatMap>> {
                Box::pin(async move { Ok(vec![FeatMap::default(); pts.len()]) })
            }
            fn raw<'a>(&'a self, _k: &'a str) -> Bf<'a, Bytes> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Bytes::from_static(b"not a radar file")) })
            }
        }
        let dir = std::env::temp_dir().join(format!("tbw-share-{}", rand::random::<u32>()));
        let src = Arc::new(Src(AtomicUsize::new(0)));
        let sf = SharedFetch::wrap(src.clone(), dir.clone());
        let (u1, u2) = (Arc::new(super::super::jobs::Usage::default()), Arc::new(super::super::jobs::Usage::default()));
        let keys = vec!["aws:KTLX/20240501_230000".to_string(), "aws:KTLX/20240501_230500".to_string()];
        let s1 = sf.clone();
        let k1 = keys.clone();
        assert_eq!(super::super::jobs::USAGE.scope(u1.clone(), async move { s1.plan(&k1) }).await, 0);
        let s2 = sf.clone();
        let k2 = keys[..1].to_vec();
        assert_eq!(super::super::jobs::USAGE.scope(u2.clone(), async move { s2.plan(&k2) }).await, 1, "job 2 overlaps job 1 on one volume");
        // job 1 reads the shared volume: kept on disk for job 2
        let s1 = sf.clone();
        let k = keys[0].clone();
        super::super::jobs::USAGE.scope(u1.clone(), async move { assert!(s1.pinned_raw(&k).await.is_some()) }).await;
        assert_eq!(sf.stats().1, 1);
        // job 2 gets it from disk without a download
        let s2 = sf.clone();
        let k = keys[0].clone();
        super::super::jobs::USAGE.scope(u2.clone(), async move { assert!(s2.pinned_raw(&k).await.is_some()) }).await;
        assert_eq!(src.0.load(Ordering::SeqCst), 1);
        assert_eq!(u2.shared.load(Ordering::Relaxed), 1);
        // the file stays until both jobs are done
        let s1 = sf.clone();
        super::super::jobs::USAGE.scope(u1, async move { s1.release_current() }).await;
        assert_eq!(sf.stats().1, 1);
        let s2 = sf.clone();
        super::super::jobs::USAGE.scope(u2, async move { s2.release_current() }).await;
        assert_eq!(sf.stats().1, 0);
        assert_eq!(std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0), 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
