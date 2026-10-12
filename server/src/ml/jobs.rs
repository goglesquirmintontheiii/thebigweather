//! Training jobs: state, progress / ETA, log ring, stop / cancel / time limit, persistence
//! (`data/ml/jobs/<id>.json`; a restart marks unfinished jobs `interrupted`, resumable).

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const LOG_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Counts {
    pub events: usize,
    pub volumes_done: usize,
    pub volumes_total: usize,
    pub samples: usize,
    pub positives: usize,
}

/// Persisted / reported job state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobState {
    pub id: String,
    pub name: String,
    pub target: String,
    /// queued | running | stopping | done | failed | cancelled | interrupted
    pub state: String,
    pub phase: String,
    pub progress: f64,
    pub counts: Counts,
    pub log: VecDeque<String>,
    pub model_id: Option<String>,
    pub error: Option<String>,
    pub started: i64,
    pub finished: Option<i64>,
    pub spec: Value,
    #[serde(default)]
    pub train: Option<Value>,
    #[serde(default)]
    pub time_limit_min: Option<f64>,
    #[serde(default)]
    pub resumable: bool,
}

/// Overall progress span of each phase.
fn phase_span(phase: &str, grid: bool) -> (f64, f64) {
    match (phase, grid) {
        ("queued", _) => (0.0, 0.0),
        ("collect events", false) => (0.0, 0.04),
        ("list volumes", _) => (0.04, 0.10),
        ("fetch & extract", _) => (0.10, 0.76),
        ("environment", false) => (0.76, 0.86),
        ("collect events", true) => (0.0, 0.15),
        ("environment", true) => (0.15, 0.86),
        ("label", _) => (0.86, 0.87),
        ("train", _) => (0.87, 0.99),
        ("save", _) => (0.99, 1.0),
        _ => (0.0, 1.0),
    }
}

/// Live control + status of one job, shared between the worker and the API.
pub struct Ctl {
    pub id: String,
    /// 0 run, 1 stop (graceful), 2 cancel
    flag: AtomicU8,
    started: Mutex<Instant>,
    limit: Mutex<Option<Duration>>,
    /// share of the time limit the current phase may use (dataset 0.8, training 1.0)
    phase_frac: Mutex<f64>,
    st: Mutex<JobState>,
    phase_start: Mutex<(Instant, f64)>,
    grid: bool,
    dir: Option<PathBuf>,
    last_save: Mutex<Instant>,
    hub: Option<crate::hub::Hub>,
    last_push: Mutex<Instant>,
}

impl Ctl {
    pub fn new(st: JobState, grid: bool, dir: Option<PathBuf>, hub: Option<crate::hub::Hub>) -> Ctl {
        let limit = st.time_limit_min.map(|m| Duration::from_secs_f64(m * 60.0));
        Ctl {
            id: st.id.clone(),
            flag: AtomicU8::new(0),
            started: Mutex::new(Instant::now()),
            limit: Mutex::new(limit),
            phase_frac: Mutex::new(0.8),
            st: Mutex::new(st),
            phase_start: Mutex::new((Instant::now(), 0.0)),
            grid,
            dir,
            last_save: Mutex::new(Instant::now() - Duration::from_secs(60)),
            hub,
            last_push: Mutex::new(Instant::now() - Duration::from_secs(60)),
        }
    }

    /// A control not attached to any manager (tests, CLI).
    pub fn detached() -> Ctl {
        Ctl::new(blank_state("detached", Value::Null, None), false, None, None)
    }

    pub fn request_stop(&self) {
        let _ = self.flag.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
        let mut s = self.st.lock();
        if s.state == "running" {
            s.state = "stopping".into();
        }
        drop(s);
        self.log("stop requested: finishing the current phase quickly and keeping the best model");
    }
    pub fn request_cancel(&self) {
        self.flag.store(2, Ordering::SeqCst);
    }
    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst) >= 2
    }
    /// Stop requested, cancelled, or the current phase's share of the time limit is used up.
    pub fn stopping(&self) -> bool {
        if self.flag.load(Ordering::SeqCst) >= 1 {
            return true;
        }
        if let Some(l) = *self.limit.lock() {
            if self.started.lock().elapsed() >= l.mul_f64(*self.phase_frac.lock()) {
                return true;
            }
        }
        false
    }
    pub fn stop_requested(&self) -> bool {
        self.flag.load(Ordering::SeqCst) == 1
    }

    pub fn log(&self, line: impl Into<String>) {
        let line = line.into();
        tracing::info!("ml job {}: {line}", self.id);
        let ts = chrono::Utc::now().format("%H:%M:%S");
        {
            let mut s = self.st.lock();
            s.log.push_back(format!("{ts} {line}"));
            while s.log.len() > LOG_CAP {
                s.log.pop_front();
            }
        }
        self.save_soon();
    }

    pub fn phase(&self, name: &str, p: f64) {
        {
            let mut s = self.st.lock();
            s.phase = name.to_string();
            s.progress = phase_span(name, self.grid).0 + p * (phase_span(name, self.grid).1 - phase_span(name, self.grid).0);
        }
        *self.phase_start.lock() = (Instant::now(), p);
        *self.phase_frac.lock() = if name == "train" || name == "save" { 1.0 } else { 0.8 };
        self.save(true);
        self.push(true);
    }

    /// Progress within the current phase (0–1).
    pub fn set_progress(&self, p: f64) {
        {
            let mut s = self.st.lock();
            let (a, b) = phase_span(&s.phase.clone(), self.grid);
            s.progress = (a + p.clamp(0.0, 1.0) * (b - a)).max(s.progress);
        }
        self.save_soon();
        self.push(false);
    }

    pub fn train_progress(&self, frac: f64, it: usize, tl: f64, vl: f64) {
        {
            let mut s = self.st.lock();
            s.train = Some(json!({"iteration": it, "train_loss": (tl * 1e5).round() / 1e5, "val_loss": (vl * 1e5).round() / 1e5}));
        }
        self.set_progress(frac);
    }

    pub fn counts(&self, f: impl FnOnce(&mut Counts)) {
        f(&mut self.st.lock().counts);
    }

    pub fn set_state(&self, state: &str) {
        {
            let mut s = self.st.lock();
            s.state = state.into();
            if matches!(state, "done" | "failed" | "cancelled" | "interrupted") {
                s.finished = Some(chrono::Utc::now().timestamp_millis());
                if state == "done" {
                    s.progress = 1.0;
                }
            }
            if state == "running" {
                *self.started.lock() = Instant::now();
            }
        }
        self.save(true);
        self.push(true);
    }

    pub fn finish(&self, model_id: Option<String>, error: Option<String>, state: &str) {
        {
            let mut s = self.st.lock();
            s.model_id = model_id;
            s.error = error;
            s.resumable = state == "interrupted" || (state == "failed" && s.counts.volumes_done > 0);
        }
        self.set_state(state);
    }

    pub fn snapshot(&self) -> JobState {
        self.st.lock().clone()
    }

    pub fn state(&self) -> String {
        self.st.lock().state.clone()
    }

    /// API JSON (`full` includes the log and the spec).
    pub fn json(&self, full: bool) -> Value {
        let s = self.snapshot();
        let running = matches!(s.state.as_str(), "running" | "stopping");
        let elapsed = if running { self.started.lock().elapsed().as_secs_f64() } else { ((s.finished.unwrap_or(s.started) - s.started) as f64 / 1000.0).max(0.0) };
        let eta = if running && s.progress > 0.02 { Some(((elapsed * (1.0 - s.progress) / s.progress).round()).max(0.0)) } else { None };
        // a time limit caps the estimate
        let eta = match (eta, s.time_limit_min) {
            (Some(e), Some(l)) => Some(e.min((l * 60.0 - elapsed).max(0.0))),
            (e, _) => e,
        };
        let mut v = json!({
            "id": s.id, "name": s.name, "target": s.target, "state": s.state, "phase": s.phase,
            "progress": (s.progress * 1000.0).round() / 1000.0, "counts": s.counts, "eta_s": eta,
            "started": s.started, "finished": s.finished, "elapsed_s": elapsed.round(),
            "model_id": s.model_id, "error": s.error, "train": s.train, "time_limit_min": s.time_limit_min, "resumable": s.resumable,
        });
        if full {
            v["log"] = json!(s.log);
            v["spec"] = s.spec.clone();
        } else {
            v["log"] = json!(s.log.iter().rev().take(3).rev().collect::<Vec<_>>());
        }
        v
    }

    fn save_soon(&self) {
        let due = self.last_save.lock().elapsed() > Duration::from_secs(10);
        if due {
            self.save(false);
        }
    }

    pub fn save(&self, _force: bool) {
        let Some(dir) = &self.dir else { return };
        *self.last_save.lock() = Instant::now();
        let s = self.snapshot();
        if let Ok(b) = serde_json::to_vec(&s) {
            crate::platform::write_atomic(&dir.join(format!("{}.json", s.id)), &b).ok();
        }
    }

    fn push(&self, force: bool) {
        let Some(hub) = &self.hub else { return };
        {
            let mut lp = self.last_push.lock();
            if !force && lp.elapsed() < Duration::from_secs(2) {
                return;
            }
            *lp = Instant::now();
        }
        let s = self.st.lock();
        hub.send(json!({"type": "ml_job", "id": s.id, "state": s.state, "phase": s.phase, "progress": (s.progress * 1000.0).round() / 1000.0, "model_id": s.model_id}));
    }
}

pub fn blank_state(id: &str, spec: Value, limit: Option<f64>) -> JobState {
    JobState {
        id: id.into(),
        name: spec.get("name").and_then(|v| v.as_str()).unwrap_or("").into(),
        target: spec.get("target").and_then(|v| v.as_str()).unwrap_or("").into(),
        state: "queued".into(),
        phase: "queued".into(),
        progress: 0.0,
        counts: Counts::default(),
        log: VecDeque::new(),
        model_id: None,
        error: None,
        started: chrono::Utc::now().timestamp_millis(),
        finished: None,
        spec,
        train: None,
        time_limit_min: limit,
        resumable: false,
    }
}

/// All jobs (memory + disk).
pub struct Jobs {
    pub dir: PathBuf,
    pub map: RwLock<BTreeMap<String, Arc<Ctl>>>,
    pub sem: crate::caches::Limiter,
}

impl Jobs {
    pub fn open(dir: PathBuf, max_jobs: usize, hub: Option<crate::hub::Hub>) -> Jobs {
        std::fs::create_dir_all(&dir).ok();
        let mut map = BTreeMap::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let Ok(b) = std::fs::read(e.path()) else { continue };
                let Ok(mut s) = serde_json::from_slice::<JobState>(&b) else { continue };
                if matches!(s.state.as_str(), "queued" | "running" | "stopping") {
                    s.state = "interrupted".into();
                    s.error = Some("the server stopped while this job was running; resume to continue (downloaded volumes are cached)".into());
                    s.finished = Some(chrono::Utc::now().timestamp_millis());
                    s.resumable = true;
                    s.log.push_back("interrupted by a server restart".into());
                }
                let grid = s.spec.get("candidate").and_then(|v| v.as_str()) == Some("grid_point");
                let c = Arc::new(Ctl::new(s, grid, Some(dir.clone()), hub.clone()));
                c.save(true);
                map.insert(c.id.clone(), c);
            }
        }
        Jobs { dir, map: RwLock::new(map), sem: crate::caches::Limiter::new(max_jobs.max(1)) }
    }

    pub fn get(&self, id: &str) -> Option<Arc<Ctl>> {
        self.map.read().get(id).cloned()
    }

    pub fn list(&self) -> Vec<Arc<Ctl>> {
        let mut v: Vec<Arc<Ctl>> = self.map.read().values().cloned().collect();
        v.sort_by_key(|c| std::cmp::Reverse(c.snapshot().started));
        v
    }

    pub fn insert(&self, c: Arc<Ctl>) {
        c.save(true);
        let mut m = self.map.write();
        // keep the newest 100 finished jobs
        if m.len() >= 150 {
            let mut fin: Vec<(i64, String)> = m.values().filter(|c| !matches!(c.state().as_str(), "queued" | "running" | "stopping")).map(|c| (c.snapshot().started, c.id.clone())).collect();
            fin.sort();
            for (_, id) in fin.into_iter().take(m.len().saturating_sub(100)) {
                m.remove(&id);
                std::fs::remove_file(self.dir.join(format!("{id}.json"))).ok();
            }
        }
        m.insert(c.id.clone(), c);
    }

    pub fn remove(&self, id: &str) {
        self.map.write().remove(id);
        std::fs::remove_file(self.dir.join(format!("{id}.json"))).ok();
    }

    pub fn active(&self) -> usize {
        self.map.read().values().filter(|c| matches!(c.state().as_str(), "queued" | "running" | "stopping")).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctl_progress_stop_and_persist() {
        let dir = std::env::temp_dir().join(format!("tbw-ml-jobs-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = Ctl::new(blank_state("j1", json!({"name": "T", "target": "tornado"}), Some(0.0001)), false, Some(dir.clone()), None);
        c.set_state("running");
        c.phase("fetch & extract", 0.0);
        c.set_progress(0.5);
        let j = c.json(true);
        assert!((j["progress"].as_f64().unwrap() - 0.43).abs() < 0.01, "{j}");
        std::thread::sleep(Duration::from_millis(20));
        // the tiny time limit is used up
        assert!(c.stopping());
        assert!(!c.cancelled());
        c.log("hello");
        c.save(true);
        // a restart marks it interrupted
        let jobs = Jobs::open(dir.clone(), 1, None);
        let r = jobs.get("j1").unwrap().snapshot();
        assert_eq!(r.state, "interrupted");
        assert!(r.resumable);
        std::fs::remove_dir_all(&dir).ok();
    }
}
