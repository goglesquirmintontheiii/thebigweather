//! Shared helpers for cache reporting / clearing (admin API) and live-resizable limits.

use serde::Serialize;
use std::path::Path;
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
    /// 0 = no byte cap (count- or time-limited)
    pub cap_bytes: u64,
}

impl CacheInfo {
    pub fn mem(id: &str, name: &str, bytes: usize, items: usize, cap: usize) -> Self {
        Self { id: id.into(), name: name.into(), kind: "memory", bytes: bytes as u64, items: items as u64, cap_bytes: cap as u64 }
    }
}

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
