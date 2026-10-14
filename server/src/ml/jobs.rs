//! Jobs: state, progress / ETA, log ring, stop / cancel / time limit, pause / resume, resource
//! budgets and live usage, persistence (`data/ml/jobs/<id>.json`; a restart marks unfinished
//! jobs `interrupted`, resumable in place).
//!
//! Training jobs (train / retrain / continue) share `max_jobs` slots: the scheduler grants the
//! oldest started jobs first, then queued ones in submission order. Lowering `max_jobs` below the
//! number running pauses the newest running jobs at their next checkpoint (state `paused`, all
//! in-memory data kept); raising it resumes paused jobs, then starts queued ones. Other job kinds
//! (`run_now`, `history`, `compare`) are not limited by `max_jobs`.

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const LOG_CAP: usize = 200;

/// Job kinds that use the training slots.
pub fn is_training(kind: &str) -> bool {
    matches!(kind, "" | "train" | "retrain" | "continue")
}

/// States of a job that has not finished.
pub fn is_active(state: &str) -> bool {
    matches!(state, "queued" | "running" | "stopping" | "paused")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Counts {
    pub events: usize,
    pub volumes_done: usize,
    pub volumes_total: usize,
    pub samples: usize,
    pub positives: usize,
}

/// Resource budget of one job (0 = server default).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Resources {
    pub cpu_threads: usize,
    pub ram_mb: usize,
    pub download_concurrency: usize,
    pub io_concurrency: usize,
}

impl Resources {
    /// Fill zero fields from `d`.
    pub fn or(&self, d: &Resources) -> Resources {
        let f = |a: usize, b: usize| if a > 0 { a } else { b };
        Resources { cpu_threads: f(self.cpu_threads, d.cpu_threads), ram_mb: f(self.ram_mb, d.ram_mb), download_concurrency: f(self.download_concurrency, d.download_concurrency), io_concurrency: f(self.io_concurrency, d.io_concurrency) }
    }
}

/// Live resource counters of a job (bytes downloaded, CPU busy time, RAM estimate).
#[derive(Debug, Default)]
pub struct Usage {
    pub net_bytes: AtomicU64,
    pub busy_ns: AtomicU64,
    /// estimated bytes held by the job's data (samples, decoded volumes in flight)
    pub ram_bytes: AtomicU64,
    /// decoded radar volumes in flight
    pub inflight: AtomicUsize,
    /// bytes of cached training data read or written by the job
    pub cache_bytes: AtomicU64,
    pub cache_hits: AtomicU64,
    pub downloads: AtomicU64,
    /// 0.8.1: requests answered by another job's download (in flight or kept on disk)
    pub shared: AtomicU64,
    pub shared_bytes: AtomicU64,
}

/// Approximate memory of one decoded Level II volume plus its extraction buffers.
pub const VOLUME_BYTES: u64 = 250 << 20;

tokio::task_local! {
    /// The usage counters of the job the current task works for.
    pub static USAGE: Arc<Usage>;
}

/// The current task's job usage counters (None outside a job).
pub fn current() -> Option<Arc<Usage>> {
    USAGE.try_with(|u| u.clone()).ok()
}

/// Count downloaded bytes for the current job.
pub fn add_net(n: u64) {
    let _ = USAGE.try_with(|u| {
        u.net_bytes.fetch_add(n, Ordering::Relaxed);
        u.downloads.fetch_add(1, Ordering::Relaxed);
    });
}

/// Count cached training data used by the current job.
pub fn add_cache(n: u64, hit: bool) {
    let _ = USAGE.try_with(|u| {
        u.cache_bytes.fetch_add(n, Ordering::Relaxed);
        if hit {
            u.cache_hits.fetch_add(1, Ordering::Relaxed);
        }
    });
}

impl Usage {
    /// Run CPU-bound work and count its time as busy.
    pub fn timed<T>(&self, f: impl FnOnce() -> T) -> T {
        let t0 = Instant::now();
        let r = f();
        self.busy_ns.fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
        r
    }
    pub fn add_busy(&self, d: Duration) {
        self.busy_ns.fetch_add(d.as_nanos() as u64, Ordering::Relaxed);
    }
}

/// Persisted / reported job state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobState {
    pub id: String,
    pub name: String,
    pub target: String,
    /// queued | running | stopping | paused | done | failed | cancelled | interrupted
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
    /// train | retrain | continue | run_now | history | compare
    #[serde(default)]
    pub kind: String,
    /// the model retrained / continued
    #[serde(default)]
    pub base_model: Option<String>,
    /// replace | new (retrain / continue)
    #[serde(default)]
    pub mode: String,
    /// resolved resource budget
    #[serde(default)]
    pub resources: Resources,
    /// result summary of run / history / compare jobs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// times this job was resumed
    #[serde(default)]
    pub resumes: u32,
    /// submission order (scheduling)
    #[serde(default)]
    pub queued_at: i64,
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
        ("run", _) | ("evaluate", _) => (0.0, 1.0),
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
    /// may run now (scheduler)
    granted: AtomicBool,
    wake: tokio::sync::Notify,
    pub usage: Arc<Usage>,
    /// (when, net bytes, busy ns) of the last usage sample + the computed rates
    sample: Mutex<(Instant, u64, u64, Value)>,
}

impl Ctl {
    pub fn new(st: JobState, grid: bool, dir: Option<PathBuf>, hub: Option<crate::hub::Hub>) -> Ctl {
        let limit = st.time_limit_min.map(|m| Duration::from_secs_f64(m * 60.0));
        let training = is_training(&st.kind);
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
            granted: AtomicBool::new(!training),
            wake: tokio::sync::Notify::new(),
            usage: Arc::new(Usage::default()),
            sample: Mutex::new((Instant::now(), 0, 0, json!({"cpu_pct": 0.0, "ram_mb": 0, "net_mbps": 0.0}))),
        }
    }

    /// A control not attached to any manager (tests, CLI).
    pub fn detached() -> Ctl {
        let c = Ctl::new(blank_state("detached", Value::Null, None), false, None, None);
        c.granted.store(true, Ordering::SeqCst);
        c
    }

    pub fn request_stop(&self) {
        let _ = self.flag.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
        let mut s = self.st.lock();
        if s.state == "running" {
            s.state = "stopping".into();
        }
        drop(s);
        self.log("stop requested: finishing the current phase quickly and keeping the best model");
        self.wake.notify_waiters();
    }
    pub fn request_cancel(&self) {
        self.flag.store(2, Ordering::SeqCst);
        self.wake.notify_waiters();
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

    pub fn granted(&self) -> bool {
        self.granted.load(Ordering::SeqCst)
    }

    pub(crate) fn set_granted(&self, g: bool) {
        if self.granted.swap(g, Ordering::SeqCst) != g {
            self.wake.notify_waiters();
        }
    }

    /// Checkpoint: wait while the scheduler holds this job back (queued, or paused because
    /// `max_jobs` was lowered). In-memory work is kept. Returns false when cancelled.
    pub async fn gate(&self) -> bool {
        if self.granted() || self.cancelled() {
            return !self.cancelled();
        }
        let prev = self.state();
        let was_running = matches!(prev.as_str(), "running" | "stopping");
        let t0 = Instant::now();
        if was_running {
            self.log("paused: more jobs are running than max_jobs allows (resumes automatically)");
            self.set_state("paused");
        }
        loop {
            if self.cancelled() {
                return false;
            }
            if self.granted() {
                break;
            }
            let _ = tokio::time::timeout(Duration::from_millis(500), self.wake.notified()).await;
        }
        if was_running {
            // paused time does not count against the time limit
            *self.started.lock() += t0.elapsed();
            self.set_state(if self.stop_requested() { "stopping" } else { "running" });
            self.log(format!("resumed after {:.0} s paused", t0.elapsed().as_secs_f64()));
        }
        true
    }

    /// [`gate`](Self::gate) for blocking threads (training).
    pub fn gate_blocking(&self) -> bool {
        if self.granted() || self.cancelled() {
            return !self.cancelled();
        }
        let t0 = Instant::now();
        self.log("paused: more jobs are running than max_jobs allows (resumes automatically)");
        self.set_state("paused");
        while !self.granted() && !self.cancelled() {
            std::thread::sleep(Duration::from_millis(250));
        }
        *self.started.lock() += t0.elapsed();
        if !self.cancelled() {
            self.set_state(if self.stop_requested() { "stopping" } else { "running" });
            self.log(format!("resumed after {:.0} s paused", t0.elapsed().as_secs_f64()));
        }
        !self.cancelled()
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
        }
        self.save(true);
        self.push(true);
    }

    /// Mark the job as started (clock for the time limit and ETA).
    pub fn start_clock(&self) {
        *self.started.lock() = Instant::now();
    }

    pub fn finish(&self, model_id: Option<String>, error: Option<String>, state: &str) {
        {
            let mut s = self.st.lock();
            s.model_id = model_id;
            s.error = error;
            s.resumable = state == "interrupted" || (matches!(state, "failed" | "cancelled") && is_training(&s.kind)) || (state == "failed" && s.counts.volumes_done > 0);
        }
        self.set_state(state);
    }

    pub fn set_kind(&self, kind: &str, base: Option<String>, mode: &str) {
        let training = is_training(kind);
        {
            let mut s = self.st.lock();
            s.kind = kind.into();
            s.base_model = base;
            s.mode = mode.into();
        }
        if !training {
            self.granted.store(true, Ordering::SeqCst);
        }
    }

    pub fn set_resources(&self, r: Resources) {
        self.st.lock().resources = r;
    }

    pub fn resources(&self) -> Resources {
        self.st.lock().resources
    }

    pub fn set_result(&self, v: Value) {
        self.st.lock().result = Some(v);
        self.save(true);
    }

    /// Back to `queued` for a resume in place (same id, log kept).
    pub fn reset_for_resume(&self) {
        self.flag.store(0, Ordering::SeqCst);
        {
            let mut s = self.st.lock();
            s.state = "queued".into();
            s.phase = "queued".into();
            s.progress = 0.0;
            s.error = None;
            s.finished = None;
            s.model_id = None;
            s.resumable = false;
            s.resumes += 1;
            s.counts = Counts::default();
            s.queued_at = chrono::Utc::now().timestamp_millis();
        }
        if is_training(&self.snapshot().kind) {
            self.granted.store(false, Ordering::SeqCst);
        }
        self.save(true);
        self.push(true);
    }

    pub fn snapshot(&self) -> JobState {
        self.st.lock().clone()
    }

    pub fn state(&self) -> String {
        self.st.lock().state.clone()
    }

    pub fn kind(&self) -> String {
        let k = self.st.lock().kind.clone();
        if k.is_empty() { "train".into() } else { k }
    }

    /// Live usage: CPU (% of the whole machine), RAM estimate (MB), download rate (Mbit/s).
    pub fn usage_json(&self) -> Value {
        let mut g = self.sample.lock();
        let el = g.0.elapsed().as_secs_f64();
        if el >= 1.0 {
            let net = self.usage.net_bytes.load(Ordering::Relaxed);
            let busy = self.usage.busy_ns.load(Ordering::Relaxed);
            let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
            let running = matches!(self.state().as_str(), "running" | "stopping");
            let cpu = if running { ((busy.saturating_sub(g.2)) as f64 / 1e9 / el / cores * 100.0).clamp(0.0, 100.0) } else { 0.0 };
            let mbps = if running { (net.saturating_sub(g.1)) as f64 * 8.0 / 1e6 / el } else { 0.0 };
            g.3 = json!({"cpu_pct": (cpu * 10.0).round() / 10.0, "net_mbps": (mbps * 100.0).round() / 100.0});
            *g = (Instant::now(), net, busy, g.3.clone());
        }
        let mut v = g.3.clone();
        let ram = self.usage.ram_bytes.load(Ordering::Relaxed) + self.usage.inflight.load(Ordering::Relaxed) as u64 * VOLUME_BYTES;
        v["ram_mb"] = json!(ram >> 20);
        v["net_total_mb"] = json!((self.usage.net_bytes.load(Ordering::Relaxed) as f64 / 1048576.0 * 10.0).round() / 10.0);
        v["downloads"] = json!(self.usage.downloads.load(Ordering::Relaxed));
        v["cache_hits"] = json!(self.usage.cache_hits.load(Ordering::Relaxed));
        v["shared"] = json!(self.usage.shared.load(Ordering::Relaxed));
        v["shared_bytes"] = json!(self.usage.shared_bytes.load(Ordering::Relaxed));
        v["cache_mb"] = json!(self.usage.cache_bytes.load(Ordering::Relaxed) >> 20);
        v["inflight_volumes"] = json!(self.usage.inflight.load(Ordering::Relaxed));
        v
    }

    /// API JSON (`full` includes the log and the spec).
    pub fn json(&self, full: bool) -> Value {
        let s = self.snapshot();
        let running = matches!(s.state.as_str(), "running" | "stopping");
        let elapsed = if running || s.state == "paused" { self.started.lock().elapsed().as_secs_f64() } else { ((s.finished.unwrap_or(s.started) - s.started) as f64 / 1000.0).max(0.0) };
        let eta = if running && s.progress > 0.02 { Some(((elapsed * (1.0 - s.progress) / s.progress).round()).max(0.0)) } else { None };
        // a time limit caps the estimate
        let eta = match (eta, s.time_limit_min) {
            (Some(e), Some(l)) => Some(e.min((l * 60.0 - elapsed).max(0.0))),
            (e, _) => e,
        };
        let kind = if s.kind.is_empty() { "train".to_string() } else { s.kind.clone() };
        let mut v = json!({
            "id": s.id, "name": s.name, "target": s.target, "state": s.state, "phase": s.phase,
            "progress": (s.progress * 1000.0).round() / 1000.0, "counts": s.counts, "eta_s": eta,
            "started": s.started, "finished": s.finished, "elapsed_s": elapsed.round(),
            "model_id": s.model_id, "error": s.error, "train": s.train, "time_limit_min": s.time_limit_min, "resumable": s.resumable,
            "retryable": matches!(s.state.as_str(), "failed" | "cancelled" | "interrupted"),
            "kind": kind, "training": is_training(&s.kind), "base_model": s.base_model, "mode": s.mode,
            "resources": s.resources, "usage": self.usage_json(), "resumes": s.resumes,
            "intensity": s.spec.get("intensity").cloned().unwrap_or(Value::Null),
        });
        if let Some(r) = &s.result {
            v["result"] = if full { r.clone() } else { r.get("summary").cloned().unwrap_or_else(|| r.clone()) };
        }
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
        let (id, state, phase, progress, model_id, kind) = {
            let s = self.st.lock();
            (s.id.clone(), s.state.clone(), s.phase.clone(), (s.progress * 1000.0).round() / 1000.0, s.model_id.clone(), if s.kind.is_empty() { "train".to_string() } else { s.kind.clone() })
        };
        hub.send(json!({"type": "ml_job", "id": id, "state": state, "phase": phase, "progress": progress, "model_id": model_id, "kind": kind, "usage": self.usage_json()}));
    }
}

pub fn blank_state(id: &str, spec: Value, limit: Option<f64>) -> JobState {
    let now = chrono::Utc::now().timestamp_millis();
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
        started: now,
        finished: None,
        spec,
        train: None,
        time_limit_min: limit,
        resumable: false,
        kind: "train".into(),
        base_model: None,
        mode: String::new(),
        resources: Resources::default(),
        result: None,
        resumes: 0,
        queued_at: now,
    }
}

/// All jobs (memory + disk) and the training-slot scheduler.
pub struct Jobs {
    pub dir: PathBuf,
    pub map: RwLock<BTreeMap<String, Arc<Ctl>>>,
    max: AtomicUsize,
    /// order in which jobs first started running (for "pause the newest")
    run_order: Mutex<Vec<String>>,
}

impl Jobs {
    pub fn open(dir: PathBuf, max_jobs: usize, hub: Option<crate::hub::Hub>) -> Jobs {
        std::fs::create_dir_all(&dir).ok();
        let mut map = BTreeMap::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let Ok(b) = std::fs::read(e.path()) else { continue };
                let Ok(mut s) = serde_json::from_slice::<JobState>(&b) else { continue };
                if is_active(&s.state) {
                    s.state = "interrupted".into();
                    s.error = Some("the server stopped while this job was running; resume to continue (downloaded data is cached)".into());
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
        Jobs { dir, map: RwLock::new(map), max: AtomicUsize::new(max_jobs.clamp(1, 8)), run_order: Mutex::new(vec![]) }
    }

    pub fn max_jobs(&self) -> usize {
        self.max.load(Ordering::SeqCst)
    }

    /// Change the number of training slots (1–8) and rebalance (pauses / resumes jobs).
    pub fn set_max(&self, n: usize) {
        self.max.store(n.clamp(1, 8), Ordering::SeqCst);
        self.rebalance();
    }

    /// Grant slots: jobs that already started (oldest first), then queued jobs in submission
    /// order, up to `max_jobs`.
    pub fn rebalance(&self) {
        let max = self.max_jobs();
        let list: Vec<Arc<Ctl>> = self.map.read().values().filter(|c| is_training(&c.snapshot().kind)).cloned().collect();
        let order = self.run_order.lock().clone();
        let mut started: Vec<(usize, Arc<Ctl>)> = vec![];
        let mut queued: Vec<(i64, Arc<Ctl>)> = vec![];
        for c in list {
            let s = c.snapshot();
            if !is_active(&s.state) || c.cancelled() {
                c.set_granted(false);
                continue;
            }
            match order.iter().position(|x| *x == c.id) {
                Some(p) if s.state != "queued" => started.push((p, c)),
                _ => queued.push((s.queued_at, c)),
            }
        }
        started.sort_by_key(|x| x.0);
        queued.sort_by_key(|x| x.0);
        let all: Vec<Arc<Ctl>> = started.into_iter().map(|x| x.1).chain(queued.into_iter().map(|x| x.1)).collect();
        for (i, c) in all.iter().enumerate() {
            c.set_granted(i < max);
        }
    }

    /// Wait for a training slot (cancellable). Records the start order.
    pub async fn acquire(&self, c: &Ctl) -> bool {
        self.rebalance();
        if !c.gate().await {
            return false;
        }
        let mut o = self.run_order.lock();
        if !o.contains(&c.id) {
            o.push(c.id.clone());
        }
        true
    }

    /// A job ended (or was cancelled): free its slot.
    pub fn release(&self, id: &str) {
        self.run_order.lock().retain(|x| x != id);
        self.rebalance();
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
            let mut fin: Vec<(i64, String)> = m.values().filter(|c| !is_active(&c.state())).map(|c| (c.snapshot().started, c.id.clone())).collect();
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
        self.release(id);
    }

    pub fn active(&self) -> usize {
        self.map.read().values().filter(|c| is_active(&c.state())).count()
    }

    /// Training jobs holding a slot / paused / queued.
    pub fn counts(&self) -> Value {
        let mut n = BTreeMap::new();
        for c in self.map.read().values() {
            let s = c.snapshot();
            if is_training(&s.kind) && is_active(&s.state) {
                *n.entry(s.state.clone()).or_insert(0usize) += 1;
            }
        }
        json!(n)
    }

    /// Earliest start (ms) of a job whose cached data must be kept: unfinished, or resumable
    /// (interrupted / failed) and finished less than `keep_ms` ago.
    pub fn oldest_pinned(&self, keep_ms: i64) -> Option<i64> {
        let now = chrono::Utc::now().timestamp_millis();
        self.map
            .read()
            .values()
            .map(|c| c.snapshot())
            .filter(|s| is_active(&s.state) || (s.resumable && matches!(s.state.as_str(), "interrupted" | "failed") && now - s.finished.unwrap_or(now) < keep_ms))
            .map(|s| s.started)
            .min()
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

    #[tokio::test]
    async fn scheduler_pauses_newest_and_resumes() {
        let dir = std::env::temp_dir().join(format!("tbw-ml-sched-{}", rand::random::<u32>()));
        let jobs = Arc::new(Jobs::open(dir.clone(), 2, None));
        let mk = |id: &str, q: i64| {
            let mut s = blank_state(id, json!({"name": id}), None);
            s.queued_at = q;
            let c = Arc::new(Ctl::new(s, false, Some(dir.clone()), None));
            jobs.insert(c.clone());
            c
        };
        let (a, b, c) = (mk("a", 1), mk("b", 2), mk("c", 3));
        assert!(jobs.acquire(&a).await);
        a.set_state("running");
        assert!(jobs.acquire(&b).await);
        b.set_state("running");
        jobs.rebalance();
        assert!(a.granted() && b.granted() && !c.granted(), "two slots");
        // lower to 1: the newest running (b) is paused at its next checkpoint
        jobs.set_max(1);
        assert!(a.granted() && !b.granted());
        let b2 = b.clone();
        let h = tokio::spawn(async move { b2.gate().await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(b.state(), "paused");
        // raise again: b resumes before the queued c starts
        jobs.set_max(2);
        assert!(h.await.unwrap());
        assert_eq!(b.state(), "running");
        assert!(!c.granted());
        a.set_state("done");
        jobs.release("a");
        assert!(c.granted());
        // usage counters
        USAGE.scope(c.usage.clone(), async { add_net(1000) }).await;
        assert_eq!(c.usage.net_bytes.load(Ordering::Relaxed), 1000);
        std::fs::remove_dir_all(&dir).ok();
    }
}
