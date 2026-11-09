//! Shared helpers for cache reporting / clearing (admin API) and live-resizable limits.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Serialize)]
pub struct CacheInfo {
    pub id: String,
    pub name: String,
    /// "memory" | "disk"
    pub kind: &'static str,
    pub bytes: u64,
    pub items: u64,
    /// the limit now in force; 0 = no byte cap (count- or time-limited)
    pub cap_bytes: u64,
    /// the size used when no budget is set (0 = no byte cap)
    pub default_bytes: u64,
    /// the user's budget, when one is set
    pub budget: Option<u64>,
    /// false: live or loaded data with no "oldest" to drop, so no slider
    pub evictable: bool,
}

impl CacheInfo {
    pub fn mem(id: &str, name: &str, bytes: usize, items: usize, cap: usize) -> Self {
        Self { id: id.into(), name: name.into(), kind: "memory", bytes: bytes as u64, items: items as u64, cap_bytes: cap as u64, default_bytes: cap as u64, budget: None, evictable: false }
    }
    /// The default size when `cap_bytes` is a budget rather than the default.
    pub fn default(mut self, bytes: usize) -> Self {
        self.default_bytes = bytes as u64;
        self
    }
}

/* ---------- 0.8.4: per-cache budgets and a shared maximum ---------- */

/// Memory caches that can drop their oldest entries. Disk caches ("disk:*") always can.
/// The others hold live state or loaded tables with no "oldest" entry to drop.
pub const EVICTABLE: &[&str] = &[
    "radar-volumes",
    "radar-sweeps",
    "radar-3d",
    "radar-rotation",
    "grid-decoded",
    "grid-rgb",
    "grid-cubes",
    "grid-wind",
    "metar-live",
    "metar-archive",
    "nowcast",
    "intl-images",
    "overlays",
    "placefiles",
    "ml-downloads",
];

pub fn evictable(id: &str) -> bool {
    id.starts_with("disk:") || EVICTABLE.contains(&id)
}

/// Smallest budget (a smaller one would just empty the cache on every insert).
pub const MIN_BUDGET: u64 = 1 << 20;
/// Smallest shared maximum.
pub const MIN_SHARED: u64 = 16 << 20;
/// What an uncapped cache counts as when scaling, at least.
const UNCAPPED_SHARE: u64 = 64 << 20;
/// Smallest limit scaling can hand a cache.
const SCALED_FLOOR: u64 = 64 << 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct BudgetFile {
    /// bytes across all caches; 0 = no shared limit
    pub shared_max: u64,
    /// cache id -> bytes
    pub per: BTreeMap<String, u64>,
}

/// User budgets, kept in `cache_budgets.json` in the data folder.
pub struct Budgets {
    path: PathBuf,
    inner: RwLock<BudgetFile>,
}

impl Budgets {
    pub fn load(data_dir: &Path) -> Arc<Self> {
        let path = data_dir.join("cache_budgets.json");
        let inner = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(Self { path, inner: RwLock::new(inner) })
    }
    pub fn get(&self) -> BudgetFile {
        self.inner.read().clone()
    }
    /// Nothing set: the caches run on their defaults.
    pub fn active(&self) -> bool {
        let g = self.inner.read();
        g.shared_max > 0 || !g.per.is_empty()
    }
    /// Replace the budgets and save them (written beside the target, then renamed).
    pub fn set(&self, f: BudgetFile) -> std::io::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&f)?)?;
        std::fs::rename(&tmp, &self.path)?;
        *self.inner.write() = f;
        Ok(())
    }
}

/// One cache as the budget calculation sees it.
#[derive(Debug, Clone)]
pub struct BudgetItem {
    pub id: String,
    pub evictable: bool,
    pub bytes: u64,
    /// the default size, 0 = no byte cap
    pub default: u64,
    pub budget: Option<u64>,
}

/// The limit each evictable cache should run at: its budget (else its default), scaled down
/// together so that the caches fit the shared maximum. `None` leaves a cache on its default.
/// Caches that can't evict still count against the shared maximum, using what they hold now.
pub fn effective_limits(items: &[BudgetItem], shared_max: u64) -> BTreeMap<String, Option<u64>> {
    let mut out: BTreeMap<String, Option<u64>> = items.iter().filter(|i| i.evictable).map(|i| (i.id.clone(), i.budget)).collect();
    if shared_max == 0 {
        return out;
    }
    let fixed: u64 = items.iter().filter(|i| !i.evictable).map(|i| i.bytes).sum();
    let room = shared_max.saturating_sub(fixed);
    // an uncapped cache counts as what it holds now, with some room to fill
    let base = |i: &BudgetItem| i.budget.unwrap_or(if i.default > 0 { i.default } else { i.bytes.max(UNCAPPED_SHARE) });
    let total: u64 = items.iter().filter(|i| i.evictable).map(base).sum();
    if total <= room {
        return out;
    }
    // every cache gets a small floor (0 would read as "no limit"); the floors come out of the
    // room first, so the limits still add up to the shared maximum
    let n = items.iter().filter(|i| i.evictable).count() as u64;
    let rest = room.saturating_sub(n * SCALED_FLOOR);
    for i in items.iter().filter(|i| i.evictable) {
        let scaled = (base(i) as u128 * rest as u128 / total.max(1) as u128) as u64;
        out.insert(i.id.clone(), Some(scaled + SCALED_FLOOR));
    }
    out
}

/// Delete the oldest files under a directory until it fits `cap` bytes. Returns bytes freed.
pub fn evict_dir(dir: &Path, cap: u64) -> u64 {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                if let Ok(m) = e.metadata() {
                    files.push((m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()));
                }
            }
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= cap {
        return 0;
    }
    files.sort_by_key(|f| f.0);
    let mut freed = 0;
    for (_, len, p) in files {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
            freed += len;
        }
    }
    freed
}
/* ---------- end 0.8.4 ---------- */

/// A semaphore whose permit count can change at runtime.
pub struct Limiter {
    pub sem: Arc<Semaphore>,
    n: AtomicUsize,
}

impl Limiter {
    pub fn new(n: usize) -> Self {
        let n = n.max(1);
        Self { sem: Arc::new(Semaphore::new(n)), n: AtomicUsize::new(n) }
    }
    pub fn permits(&self) -> usize {
        self.n.load(Ordering::Relaxed)
    }
    /// Grow at once; shrink as running work finishes.
    pub fn resize(&self, n: usize) {
        let n = n.max(1);
        let cur = self.n.swap(n, Ordering::Relaxed);
        if n > cur {
            self.sem.add_permits(n - cur);
        } else if n < cur {
            let sem = self.sem.clone();
            let k = (cur - n) as u32;
            tokio::spawn(async move {
                if let Ok(p) = sem.acquire_many_owned(k).await {
                    p.forget();
                }
            });
        }
    }
}

/// (bytes, files) under a directory, recursively.
pub fn dir_size(p: &Path) -> (u64, u64) {
    let mut bytes = 0;
    let mut files = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// Delete every file under a directory (folders are kept). Returns bytes freed.
pub fn clear_dir(p: &Path) -> u64 {
    let mut freed = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else {
                let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                if std::fs::remove_file(e.path()).is_ok() {
                    freed += len;
                }
            }
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn limiter_resizes() {
        let l = Limiter::new(2);
        l.resize(4);
        assert_eq!(l.sem.available_permits(), 4);
        l.resize(1);
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(l.sem.available_permits(), 1);
        assert_eq!(l.permits(), 1);
    }

    #[test]
    fn budgets_scale_into_the_shared_maximum() {
        let it = |id: &str, ev, bytes, default, budget| BudgetItem { id: id.into(), evictable: ev, bytes, default, budget };
        let gb = 1u64 << 30;
        // under the shared maximum: budgets only
        let l = effective_limits(&[it("a", true, 0, gb, None), it("b", true, 0, 2 * gb, Some(gb))], 10 * gb);
        assert_eq!(l["a"], None);
        assert_eq!(l["b"], Some(gb));
        // over it: scaled together, and a cache that can't evict uses up part of the room
        let items = [it("a", true, 0, 2 * gb, None), it("b", true, 0, 2 * gb, None), it("fix", false, gb, 0, None), it("uncapped", true, gb, 0, None)];
        let l = effective_limits(&items, 3 * gb);
        let (a, b, u) = (l["a"].unwrap(), l["b"].unwrap(), l["uncapped"].unwrap());
        assert_eq!(a, b);
        assert!(a + b + u <= 2 * gb, "{a} {b} {u}");
        assert!(!l.contains_key("fix"));
        // tiny maximum, many caches: the limits still add up to it
        let many: Vec<BudgetItem> = (0..20).map(|i| it(&format!("c{i}"), true, 0, if i % 2 == 0 { 0 } else { gb }, None)).collect();
        let l = effective_limits(&many, 32 << 20);
        assert!(l.values().all(|v| v.unwrap() > 0));
        assert!(l.values().map(|v| v.unwrap()).sum::<u64>() <= 32 << 20);
        // no shared maximum: nothing scaled
        assert_eq!(effective_limits(&items, 0)["a"], None);
    }

    #[test]
    fn budgets_persist() {
        let d = std::env::temp_dir().join(format!("tbw-budget-test-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        let b = Budgets::load(&d);
        assert!(!b.active());
        let mut f = BudgetFile { shared_max: 1 << 30, ..Default::default() };
        f.per.insert("radar-volumes".into(), 5 << 20);
        b.set(f.clone()).unwrap();
        assert_eq!(Budgets::load(&d).get(), f);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn evict_dir_drops_oldest_first() {
        let d = std::env::temp_dir().join(format!("tbw-evict-test-{}", rand::random::<u32>()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let mid = std::time::UNIX_EPOCH + std::time::Duration::from_secs(2_000_000);
        for (name, t) in [("oldest", old), ("sub/mid", mid), ("newest", std::time::SystemTime::now())] {
            std::fs::write(d.join(name), b"0123456789").unwrap();
            std::fs::File::options().write(true).open(d.join(name)).unwrap().set_modified(t).unwrap();
        }
        assert_eq!(evict_dir(&d, 15), 20);
        assert!(!d.join("oldest").exists() && !d.join("sub/mid").exists() && d.join("newest").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn dir_size_and_clear() {
        let d = std::env::temp_dir().join(format!("tbw-cache-test-{}", rand::random::<u32>()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("a"), b"12345").unwrap();
        std::fs::write(d.join("sub/b"), b"123").unwrap();
        assert_eq!(dir_size(&d), (8, 2));
        assert_eq!(clear_dir(&d), 8);
        assert_eq!(dir_size(&d), (0, 0));
        std::fs::remove_dir_all(&d).ok();
    }
}
