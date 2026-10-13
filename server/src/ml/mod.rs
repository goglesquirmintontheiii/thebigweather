//! Detection models: train classifiers on historical radar / gridded data and run them live.
//!
//! * [`gbdt`], [`linear`], [`mlp`]: pure-Rust learners; [`metrics`]: verification + grouped CV.
//! * [`cells`]: storm-cell segmentation and features from a Level II volume.
//! * [`features`]: versioned feature schemas (radar cells, grid points, MRMS / METAR / GFS).
//! * [`labels`]: SPC / IEM / HURDAT2 / HMS event databases and matching rules.
//! * [`source`]: all outside data behind the [`source::Fetch`] trait (tests inject their own).
//! * [`dataset`]: builds training samples (cached per volume); [`train`]: fit + evaluate.
//! * [`jobs`]: background jobs (training slots, pause / resume, budgets, live usage);
//!   [`model`]: model store, ensembles, export / import.
//! * [`gridds`]: grid targets with leads / windows (instability, forecasts, outlooks, floods,
//!   tropical development); [`sat`]: GOES ABI / GLM features.
//! * [`runner`]: live inference over radars / regions (per-model run configs); [`predict`]: grid
//!   prediction layers, area detections and outlook polygons; [`reports`]: automatic model
//!   reports; [`compare`]: A/B scorecards; [`api`]: `/api/ml/*`.
//! * One-shot runs over all radars (`run_now`) and historical runs (`history`) are jobs too.
//! * Retrain / continue: any stored model (trained or imported) carries its spec, so its data
//!   can be rebuilt (sample caches are keyed by volume / time) and it can be trained again from
//!   scratch or further (warm start).

pub mod api;
pub mod cells;
pub mod compare;
pub mod core;
pub mod dataset;
pub mod features;
pub mod gbdt;
pub mod gridds;
pub mod jobs;
pub mod labels;
pub mod linear;
pub mod metrics;
pub mod mlp;
pub mod model;
pub mod predict;
pub mod reports;
pub mod runner;
pub mod sat;
pub mod source;
pub mod spec;
pub mod train;

#[cfg(test)]
mod tests;

use anyhow::{anyhow, bail, Result};
use jobs::{blank_state, Ctl, Jobs, Resources};
use model::{HistEntry, ModelRecord, Store};
use parking_lot::RwLock;
use runner::{ModelRun, Runner};
use serde_json::{json, Value};
use source::Fetch;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub struct Ml {
    pub store: Arc<Store>,
    pub jobs: Arc<Jobs>,
    pub runner: Arc<Runner>,
    pub fetch: Arc<dyn Fetch>,
    pub reports: Arc<reports::Reports>,
    /// data/cache/ml
    pub cache_root: PathBuf,
    /// data/ml
    pub root: PathBuf,
    pub hub: Option<crate::hub::Hub>,
    pub cfg: RwLock<crate::config::MlCfg>,
    full: bool,
    radar_mb: AtomicUsize,
}

fn auto(v: usize, lite: usize, full: bool, fullv: usize) -> usize {
    if v > 0 { v } else if full { fullv } else { lite }
}

/// How a job relates to existing models.
#[derive(Debug, Clone, Default)]
pub struct JobKind {
    /// train | retrain | continue
    pub kind: String,
    pub base: Option<String>,
    /// replace | new
    pub mode: String,
}

impl JobKind {
    pub fn train() -> JobKind {
        JobKind { kind: "train".into(), base: None, mode: String::new() }
    }
}

/// Parse `models: ["id" | {id, …options}]` into run options (unknown ids are errors).
pub fn parse_runs(store: &Store, v: &Value) -> Result<Vec<ModelRun>> {
    let arr = v.as_array().ok_or_else(|| anyhow!("models must be an array of model ids or {{id, …options}}"))?;
    let mut out: Vec<ModelRun> = vec![];
    for x in arr {
        let r = ModelRun::parse(x)?;
        if store.get(&r.id).is_none() {
            bail!("model {} not found", r.id);
        }
        if !out.iter().any(|o| o.id == r.id) {
            out.push(r);
        }
    }
    Ok(out)
}

impl Ml {
    pub fn new(cfg: &crate::config::MlCfg, data_dir: &std::path::Path, fetch: Arc<dyn Fetch>, hub: Option<crate::hub::Hub>, full: bool, radar_mb: usize) -> Arc<Ml> {
        let root = data_dir.join("ml");
        let cache_root = data_dir.join("cache/ml");
        std::fs::create_dir_all(&cache_root).ok();
        let reports = Arc::new(reports::Reports::open(root.join("reports"), hub.clone()));
        let ml = Ml {
            store: Arc::new(Store::open(root.join("models"))),
            jobs: Arc::new(Jobs::open(root.join("jobs"), cfg.max_jobs.clamp(1, 8), hub.clone())),
            runner: Arc::new(Runner::new(Some(root.join("runner.json")), auto(cfg.run_concurrency, 1, full, 3))),
            fetch,
            reports: reports.clone(),
            cache_root,
            root,
            hub: hub.clone(),
            cfg: RwLock::new(cfg.clone()),
            full,
            radar_mb: AtomicUsize::new(radar_mb),
        };
        *ml.runner.sink.write() = ml.fetch.pred_sink();
        *ml.runner.reports.write() = Some(reports);
        *ml.runner.hub.write() = hub;
        ml.apply_settings();
        Arc::new(ml)
    }

    fn apply_settings(&self) {
        let c = self.cfg.read().clone();
        self.runner.max_points.store(auto(c.pred_max_points, 150_000, self.full, 400_000), Ordering::Relaxed);
        self.runner.keep_ms.store(c.history_keep_min.clamp(10, 7 * 1440) as i64 * 60_000, Ordering::Relaxed);
        self.runner.hist_keep_ms.store(c.history_run_keep_h.clamp(1, 24 * 30) as i64 * 3_600_000, Ordering::Relaxed);
        self.runner.past_runs.store(c.history_grid_runs.min(48), Ordering::Relaxed);
        self.runner.report_cycles.store(c.report_cycles.clamp(1, 50), Ordering::Relaxed);
    }

    /// Apply `[ml]` settings and the radar memory share live.
    pub fn configure(&self, cfg: &crate::config::MlCfg, radar_mb: usize) {
        *self.cfg.write() = cfg.clone();
        self.radar_mb.store(radar_mb, Ordering::Relaxed);
        self.apply_settings();
        self.jobs.set_max(cfg.max_jobs.clamp(1, 8));
        self.runner.concurrency.resize(auto(cfg.run_concurrency, 1, self.full, 3));
    }

    /// (cores, server memory budget MB).
    pub fn machine(&self) -> (usize, usize) {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
        // the radar share is 40% of the server's memory budget
        let mem = self.radar_mb.load(Ordering::Relaxed) * 100 / 40;
        (cores, mem.max(1024))
    }

    /// Server-default job budget: most cores, about half the memory budget, downloads sized to
    /// the RAM (a decoded Level II volume plus extraction needs ~250 MB).
    pub fn default_resources(&self) -> Resources {
        let c = self.cfg.read().clone();
        let (cores, mem) = self.machine();
        let cpu = if c.cpu_threads > 0 { c.cpu_threads } else if self.full { cores.saturating_sub(1).max(1) } else { (cores / 2).max(1) };
        let ram = if c.ram_mb > 0 { c.ram_mb } else { (mem / 2).max(768) };
        let dl = if c.download_concurrency > 0 { c.download_concurrency } else { (ram / 300).clamp(2, 16) };
        let io = if c.io_concurrency > 0 { c.io_concurrency } else { (cpu / 2).clamp(3, 12) };
        Resources { cpu_threads: cpu, ram_mb: ram, download_concurrency: dl, io_concurrency: io }
    }

    /// A job's budget: its own values over the defaults, downloads capped by its RAM.
    pub fn job_resources(&self, r: &Resources) -> Resources {
        let mut x = r.or(&self.default_resources());
        x.download_concurrency = x.download_concurrency.min((x.ram_mb / 250).max(1)).max(1);
        x.cpu_threads = x.cpu_threads.max(1);
        x.io_concurrency = x.io_concurrency.max(1);
        x
    }

    pub fn download_concurrency(&self) -> usize {
        self.job_resources(&Resources::default()).download_concurrency
    }

    /// `GET /api/ml/settings`
    pub fn settings_json(&self) -> Value {
        let c = self.cfg.read().clone();
        let (cores, mem) = self.machine();
        json!({
            "max_jobs": self.jobs.max_jobs(), "max_jobs_range": [1, 8],
            "resources": {"cpu_threads": c.cpu_threads, "ram_mb": c.ram_mb, "download_concurrency": c.download_concurrency, "io_concurrency": c.io_concurrency},
            "resources_effective": self.default_resources(),
            "machine": {"cores": cores, "memory_budget_mb": mem},
            "history_keep_min": c.history_keep_min, "history_grid_runs": c.history_grid_runs, "history_run_keep_h": c.history_run_keep_h,
            "report_cycles": c.report_cycles, "cache_retention_days": c.cache_retention_days, "auto_resume": c.auto_resume,
            "jobs": self.jobs.counts(),
        })
    }

    /// Apply a `PUT /api/ml/settings` body to a config (validated); returns the changed keys.
    pub fn patch_settings(c: &mut crate::config::MlCfg, body: &Value) -> Result<Vec<String>> {
        let mut changed = vec![];
        let num = |v: &Value, k: &str, lo: u64, hi: u64| -> Result<u64> {
            let n = v.as_u64().ok_or_else(|| anyhow!("{k} must be a number"))?;
            if n < lo || n > hi {
                bail!("{k} must be {lo}–{hi}");
            }
            Ok(n)
        };
        if let Some(v) = body.get("max_jobs") {
            c.max_jobs = num(v, "max_jobs", 1, 8)? as usize;
            changed.push("max_jobs".into());
        }
        let r = body.get("resources").cloned().unwrap_or(Value::Null);
        for (k, src) in [("cpu_threads", r.get("cpu_threads").or(body.get("cpu_threads"))), ("ram_mb", r.get("ram_mb").or(body.get("ram_mb"))), ("download_concurrency", r.get("download_concurrency").or(body.get("download_concurrency"))), ("io_concurrency", r.get("io_concurrency").or(body.get("io_concurrency")))] {
            let Some(v) = src else { continue };
            let n = num(v, k, 0, if k == "ram_mb" { 4_000_000 } else { 1024 })? as usize;
            match k {
                "cpu_threads" => c.cpu_threads = n,
                "ram_mb" => c.ram_mb = n,
                "download_concurrency" => c.download_concurrency = n,
                _ => c.io_concurrency = n,
            }
            changed.push(k.into());
        }
        if let Some(v) = body.get("history_keep_min") {
            c.history_keep_min = num(v, "history_keep_min", 10, 10080)? as u32;
            changed.push("history_keep_min".into());
        }
        if let Some(v) = body.get("history_grid_runs") {
            c.history_grid_runs = num(v, "history_grid_runs", 0, 48)? as usize;
            changed.push("history_grid_runs".into());
        }
        if let Some(v) = body.get("history_run_keep_h") {
            c.history_run_keep_h = num(v, "history_run_keep_h", 1, 720)? as u32;
            changed.push("history_run_keep_h".into());
        }
        if let Some(v) = body.get("report_cycles") {
            c.report_cycles = num(v, "report_cycles", 1, 50)? as u32;
            changed.push("report_cycles".into());
        }
        if let Some(v) = body.get("cache_retention_days") {
            c.cache_retention_days = num(v, "cache_retention_days", 0, 3650)? as u32;
            changed.push("cache_retention_days".into());
        }
        if let Some(v) = body.get("auto_resume") {
            c.auto_resume = v.as_bool().ok_or_else(|| anyhow!("auto_resume must be true or false"))?;
            changed.push("auto_resume".into());
        }
        Ok(changed)
    }

    /// Background tasks: the live runner, the sample-cache janitor and auto-resume.
    pub fn spawn(self: &Arc<Self>) {
        if !self.cfg.read().enabled {
            return;
        }
        let r = self.runner.clone();
        let hub = self.hub.clone().unwrap_or_else(crate::hub::Hub::new);
        tokio::spawn(r.run_loop(self.fetch.clone(), self.store.clone(), hub));
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(600)).await;
                me.janitor().await;
            }
        });
        if self.cfg.read().auto_resume {
            let me = self.clone();
            tokio::spawn(async move {
                // give the services a moment to start
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let ids: Vec<String> = me.jobs.list().iter().map(|c| c.snapshot()).filter(|s| s.state == "interrupted" && s.resumable).map(|s| s.id).collect();
                for id in ids {
                    match me.resume(&id) {
                        Ok(_) => tracing::info!("ml: resumed interrupted job {id}"),
                        Err(e) => tracing::warn!("ml: could not resume job {id}: {e:#}"),
                    }
                }
            });
        }
    }

    /// Keep the sample cache under its cap. Data of unfinished / resumable jobs is never
    /// evicted; data unused for `cache_retention_days` is removed.
    pub async fn janitor(&self) {
        let c = self.cfg.read().clone();
        let cap = if c.cache_disk_mb > 0 { c.cache_disk_mb } else { 2048 } << 20;
        let keep_ms = (c.cache_retention_days.max(1) as i64) * 86_400_000;
        let pinned = self.jobs.oldest_pinned(keep_ms).map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64));
        let retention = (c.cache_retention_days > 0).then(|| std::time::Duration::from_secs(c.cache_retention_days as u64 * 86_400));
        let dir = self.cache_root.join("cells");
        tokio::task::spawn_blocking(move || evict(&dir, cap, pinned, retention)).await.ok();
    }

    /// Queue a training job; returns its id.
    pub fn submit(self: &Arc<Self>, raw: &Value) -> Result<String> {
        self.submit_job(raw, JobKind::train())
    }

    fn new_job_id(&self) -> String {
        let id = format!("j{}", model::radix36(chrono::Utc::now().timestamp_millis() as u64));
        if self.jobs.get(&id).is_some() { format!("{id}{:x}", rand::random::<u16>()) } else { id }
    }

    /// Queue a train / retrain / continue job.
    pub fn submit_job(self: &Arc<Self>, raw: &Value, kind: JobKind) -> Result<String> {
        if !self.cfg.read().enabled {
            bail!("detection models are disabled in the server config ([ml] enabled = false)");
        }
        let spec = spec::resolve(raw)?;
        let base = match &kind.base {
            Some(b) => Some(self.store.get(b).ok_or_else(|| anyhow!("model {b} not found"))?),
            None => None,
        };
        if let Some(b) = &base {
            if b.is_ensemble() {
                bail!("ensembles are combinations of models: retrain or continue their members instead");
            }
        }
        if kind.kind == "continue" {
            let b = base.as_ref().unwrap();
            check_continue(b, &spec)?;
        }
        let id = self.new_job_id();
        let st = blank_state(&id, serde_json::to_value(&spec)?, spec.time_limit_min);
        let ctl = Arc::new(Ctl::new(st, spec.candidate == "grid_point", Some(self.jobs.dir.clone()), self.hub.clone()));
        ctl.set_kind(&kind.kind, kind.base.clone(), &kind.mode);
        ctl.set_resources(self.job_resources(&spec.resources));
        let what = match kind.kind.as_str() {
            "retrain" => format!("retrain of {} ({})", kind.base.as_deref().unwrap_or(""), kind.mode),
            "continue" => format!("continued training of {} ({})", kind.base.as_deref().unwrap_or(""), kind.mode),
            _ => "training".into(),
        };
        ctl.log(format!("queued {what}: {} ({}, {}, {} {}–{}, {} events max, {}{})", spec.name, spec.target, spec.task, spec.candidate, spec.years[0], spec.years[1], spec.max_events, spec.algo, if spec.intensity.is_empty() { String::new() } else { format!(", {}", spec.intensity) }));
        self.jobs.insert(ctl.clone());
        let me = self.clone();
        tokio::spawn(async move { me.run_job(ctl, spec, kind).await });
        Ok(id)
    }

    /// Restart a failed / cancelled / interrupted job in place (same id and spec; cached data
    /// makes it fast). `retry` is the same.
    pub fn resume(self: &Arc<Self>, id: &str) -> Result<String> {
        let c = self.jobs.get(id).ok_or_else(|| anyhow!("job not found"))?;
        let s = c.snapshot();
        if jobs::is_active(&s.state) {
            bail!("job is still active ({})", s.state);
        }
        if s.state == "done" {
            bail!("job finished successfully; start a new one instead (retrain a model, or run again)");
        }
        let kind = c.kind();
        if jobs::is_training(&kind) {
            let mut raw = s.spec.clone();
            if let Some(o) = raw.as_object_mut() {
                o.remove("preset");
            }
            let spec = spec::resolve(&raw)?;
            let jk = if kind == "train" { JobKind::train() } else { JobKind { kind: kind.clone(), base: s.base_model.clone(), mode: s.mode.clone() } };
            if let Some(b) = &jk.base {
                if self.store.get(b).is_none() {
                    bail!("model {b} no longer exists");
                }
            }
            c.reset_for_resume();
            c.set_resources(self.job_resources(&spec.resources));
            c.log(format!("resumed ({} time{}); cached data is reused", s.resumes + 1, if s.resumes == 0 { "" } else { "s" }));
            let me = self.clone();
            tokio::spawn(async move { me.run_job(c, spec, jk).await });
        } else {
            c.reset_for_resume();
            c.log("restarted");
            self.spawn_task(c, kind, s.spec.clone());
        }
        Ok(id.to_string())
    }

    /// Spec of a stored model with overrides (`params` in the overrides replace the model's).
    fn model_spec_with(m: &ModelRecord, overrides: &Value, continue_mode: bool) -> Value {
        let mut raw = if m.spec.is_object() { m.spec.clone() } else { json!({}) };
        if let Some(o) = raw.as_object_mut() {
            o.remove("preset");
            o.entry("target").or_insert(json!(m.target));
            o.entry("candidate").or_insert(json!(m.candidate));
            o.insert("task".into(), json!(m.task));
            if continue_mode {
                // the learner's own parameters, then the requested changes
                o.insert("params".into(), m.params.clone());
                o.insert("algo".into(), json!(m.algo));
            }
        }
        let mut ov = overrides.clone();
        if let Some(o) = ov.as_object_mut() {
            for k in ["mode", "extra_events", "iterations", "n_trees", "epochs", "learning_rate"] {
                o.remove(k);
            }
            if let Some(p) = o.remove("params") {
                if continue_mode {
                    spec::merge(&mut raw["params"], &p);
                } else {
                    raw["params"] = p;
                }
            }
        }
        spec::merge(&mut raw, &ov);
        if continue_mode {
            let extra = overrides.get("extra_events").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            if extra > 0 {
                let cur = raw.get("max_events").and_then(|v| v.as_u64()).unwrap_or(150) as usize;
                raw["max_events"] = json!(cur + extra);
            }
            for (k, pk) in [("iterations", "n_trees"), ("n_trees", "n_trees"), ("epochs", "epochs"), ("learning_rate", "learning_rate")] {
                if let Some(v) = overrides.get(k).filter(|v| !v.is_null()) {
                    raw["params"][pk] = v.clone();
                    if pk == "n_trees" {
                        raw["params"]["max_iter"] = v.clone();
                    }
                }
            }
        }
        raw
    }

    /// `POST /api/ml/models/{id}/retrain`: rebuild the dataset from the model's spec (+ overrides)
    /// and train from scratch.
    pub fn retrain(self: &Arc<Self>, id: &str, body: &Value) -> Result<String> {
        let m = self.store.get(id).ok_or_else(|| anyhow!("model not found"))?;
        let mode = mode_of(body)?;
        let raw = Self::model_spec_with(&m, body, false);
        self.submit_job(&raw, JobKind { kind: "retrain".into(), base: Some(m.id.clone()), mode })
    }

    /// `POST /api/ml/models/{id}/continue`: warm start on the (possibly enlarged) dataset.
    pub fn continue_training(self: &Arc<Self>, id: &str, body: &Value) -> Result<String> {
        let m = self.store.get(id).ok_or_else(|| anyhow!("model not found"))?;
        let mode = mode_of(body)?;
        for k in ["sources", "features", "task", "target", "candidate"] {
            if body.get(k).is_some_and(|v| !v.is_null()) {
                let raw = Self::model_spec_with(&m, body, true);
                let s = spec::resolve(&raw)?;
                check_continue(&m, &s)?;
                break;
            }
        }
        if let Some(a) = body.get("algo").and_then(|v| v.as_str()) {
            if a != m.algo {
                bail!("continue keeps the model's algorithm ({}); use retrain to change it", m.algo);
            }
        }
        let raw = Self::model_spec_with(&m, body, true);
        self.submit_job(&raw, JobKind { kind: "continue".into(), base: Some(m.id.clone()), mode })
    }

    async fn run_job(self: Arc<Self>, ctl: Arc<Ctl>, spec: spec::TrainSpec, kind: JobKind) {
        let usage = ctl.usage.clone();
        jobs::USAGE
            .scope(usage, async move {
                // wait for a training slot (cancellable while queued)
                if !self.jobs.acquire(&ctl).await {
                    ctl.finish(None, Some("cancelled while queued".into()), "cancelled");
                    self.jobs.release(&ctl.id);
                    return;
                }
                ctl.set_state("running");
                ctl.start_clock();
                let r = ctl.resources();
                ctl.log(format!("started: {} CPU threads, {} MB RAM, {} radar volumes / {} gridded requests at once", r.cpu_threads, r.ram_mb, r.download_concurrency, r.io_concurrency));
                let res = self.clone().job_body(ctl.clone(), spec, kind).await;
                match res {
                    Ok(id) => {
                        ctl.log(format!("done: model {id}"));
                        ctl.finish(Some(id), None, "done");
                    }
                    Err(e) => {
                        let cancelled = ctl.cancelled();
                        ctl.log(format!("{}: {e:#}", if cancelled { "cancelled" } else { "failed" }));
                        ctl.finish(None, Some(format!("{e:#}")), if cancelled { "cancelled" } else { "failed" });
                    }
                }
                self.jobs.release(&ctl.id);
            })
            .await
    }

    /// The job's thread pool and dataset budget.
    fn budget(&self, r: &Resources) -> dataset::Budget {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(r.cpu_threads.max(1)).thread_name(|i| format!("tbw-ml-{i}")).build().ok().map(Arc::new);
        // gridded decodes follow the largest running budget
        self.fetch.set_decode_threads((r.cpu_threads / 2).max(2));
        dataset::Budget { download: r.download_concurrency.max(1), io: r.io_concurrency.max(1), pool }
    }

    async fn job_body(self: Arc<Self>, ctl: Arc<Ctl>, spec: spec::TrainSpec, kind: JobKind) -> Result<String> {
        let base = kind.base.as_ref().and_then(|b| self.store.get(b));
        if kind.base.is_some() && base.is_none() {
            bail!("model {} no longer exists", kind.base.as_deref().unwrap_or(""));
        }
        let cont = kind.kind == "continue";
        let res = ctl.resources();
        let budget = self.budget(&res);
        let built = dataset::build_with(self.fetch.clone(), &spec, &ctl, &self.cache_root, &budget).await?;
        if ctl.cancelled() {
            bail!("cancelled");
        }
        if !ctl.gate().await {
            bail!("cancelled");
        }
        ctl.phase("train", 0.0);
        let schema = match (&base, cont) {
            (Some(b), true) => b.feature_schema.clone(),
            _ => features::Schema::for_target(&spec.target, &spec.candidate, &spec.sources, &spec.features),
        };
        ctl.log(format!("training {} ({}) on {} samples × {} features ({} threads)", spec.algo, spec.task, built.samples.len(), schema.features.len(), res.cpu_threads));
        let (c2, s2, sc2, b2) = (ctl.clone(), spec.clone(), schema.clone(), if cont { base.clone() } else { None });
        let ids = Arc::new(built.ids);
        let samples = Arc::new(built.samples);
        let (ids2, samples2, pool) = (ids.clone(), samples.clone(), budget.pool.clone());
        let usage = ctl.usage.clone();
        let threads = res.cpu_threads.max(1) as u32;
        let (trained, aux, track_err) = tokio::task::spawn_blocking(move || -> Result<(train::Trained, Vec<model::AuxLearner>, Value)> {
            let t0 = std::time::Instant::now();
            let run = || -> Result<(train::Trained, Vec<model::AuxLearner>, Value)> {
                let main = train::train_with(&s2, &sc2, &ids2, &samples2, &c2, b2.as_deref())?;
                if s2.target != "storm_track" {
                    return Ok((main, vec![], Value::Null));
                }
                // storm tracks: north displacement and strength on the same samples
                let mut aux = vec![];
                let mut oofs = vec![];
                for (k, name) in [(0usize, "dy_km"), (1, "strength")] {
                    c2.log(format!("training the {name} output"));
                    let sv: Vec<dataset::Sample> = samples2.iter().map(|s| dataset::Sample { label: s.targets.get(k).copied().unwrap_or(f32::NAN), ..s.clone() }).collect();
                    let mut sa = s2.clone();
                    if name == "strength" {
                        sa.params["loss"] = json!("squared");
                    }
                    let t = train::train_with(&sa, &sc2, &ids2, &sv, &c2, None)?;
                    oofs.push(t.oof.clone());
                    aux.push(model::AuxLearner { name: name.into(), learner: t.learner, metrics: t.metrics.get("eval").cloned().unwrap_or(Value::Null) });
                }
                let err = track_errors(&ids2, &samples2, &main.oof, &oofs[0]);
                Ok((main, aux, err))
            };
            let r = match &pool {
                Some(p) => p.install(run),
                None => run(),
            };
            usage.add_busy(t0.elapsed() * threads);
            r
        })
        .await??;
        if ctl.cancelled() {
            bail!("cancelled");
        }
        ctl.phase("save", 0.0);
        let now = chrono::Utc::now().timestamp_millis();
        let mut metrics = trained.metrics;
        metrics["dataset"]["build"] = built.stats;
        if !track_err.is_null() {
            metrics["track_err_km"] = track_err["model"].clone();
            metrics["track_err_persistence_km"] = track_err["persistence"].clone();
            ctl.log(format!("track position error (km) by lead: model {} · persistence {}", track_err["model"], track_err["persistence"]));
        }
        if ctl.stop_requested() {
            metrics["stopped_early"] = Value::Bool(true);
        }
        if let Some(b) = &base {
            // previous metrics stay available for comparison
            metrics["previous"] = json!({"version": b.version, "summary": b.metrics_summary(), "samples": b.metrics.get("dataset").and_then(|d| d.get("samples")).cloned()});
        }
        let output = spec::target(&spec.target).map(|t| t.output).unwrap_or("detections").to_string();
        let cache_bytes = ctl.usage.cache_bytes.load(Ordering::Relaxed);
        let mut rec = ModelRecord {
            id: model::new_id(),
            name: spec.name.clone(),
            labels: spec.labels.clone(),
            target: spec.target.clone(),
            candidate: spec.candidate.clone(),
            created: now,
            updated: now,
            spec: serde_json::to_value(&spec)?,
            feature_schema: schema,
            algo: spec.algo.clone(),
            params: trained.params,
            metrics,
            threshold: trained.threshold,
            levels: trained.levels,
            version: 1,
            format: model::FORMAT_VERSION,
            task: spec.task.clone(),
            output,
            history: vec![],
            quantiles: trained.quantiles,
            notes: spec.notes.clone(),
            importance: trained.importance,
            calib: trained.calib,
            learner: trained.learner,
            origin: "trained".into(),
            job_id: Some(ctl.id.clone()),
            intensity: if spec.intensity.is_empty() { "custom".into() } else { spec.intensity.clone() },
            family_key: spec::family_key(&spec),
            aux,
            cache_bytes,
            size_bytes: 0,
        };
        let replace = kind.mode != "new";
        if let Some(b) = &base {
            rec.history = b.history.clone();
            if rec.history.is_empty() {
                // a model from before histories: record its own training first
                rec.history.push(HistEntry { version: b.version, at: b.created, kind: if b.origin == "imported" { "import".into() } else { "train".into() }, metrics_summary: b.metrics_summary(), samples: b.metrics.get("dataset").and_then(|d| d.get("samples")).cloned().unwrap_or(Value::Null), job_id: b.job_id.clone(), from_model: None });
            }
            if replace {
                rec.id = b.id.clone();
                rec.created = b.created;
                rec.version = b.version + 1;
                rec.name = b.name.clone();
                rec.labels = b.labels.clone();
                rec.notes = b.notes.clone();
                rec.origin = b.origin.clone();
            } else {
                if rec.name == b.name {
                    rec.name = format!("{} ({})", b.name, if cont { "continued" } else { "retrained" });
                }
                rec.origin = format!("{} from {}", if cont { "continued" } else { "retrained" }, b.id);
            }
        }
        rec.history.push(HistEntry {
            version: rec.version,
            at: now,
            kind: if kind.kind.is_empty() { "train".into() } else { kind.kind.clone() },
            metrics_summary: rec.metrics_summary(),
            samples: rec.metrics.get("dataset").and_then(|d| d.get("samples")).cloned().unwrap_or(Value::Null),
            job_id: Some(ctl.id.clone()),
            from_model: base.as_ref().filter(|_| !replace).map(|b| b.id.clone()),
        });
        let saved = self.store.save(rec)?;
        if let Some(h) = &self.hub {
            h.send(serde_json::json!({"type": "ml_model", "id": saved.id, "action": if base.is_some() && replace { "updated" } else { "created" }, "version": saved.version, "family_key": saved.family(), "intensity": saved.intensity()}));
        }
        Ok(saved.id.clone())
    }

    // ---------- run / history / compare jobs ----------

    /// Start a non-training job (`run_now`, `history`, `compare`) whose request is `req`.
    fn submit_task(self: &Arc<Self>, kind: &str, name: String, target: String, req: Value) -> Result<String> {
        if !self.cfg.read().enabled {
            bail!("detection models are disabled in the server config ([ml] enabled = false)");
        }
        let id = self.new_job_id();
        let mut st = blank_state(&id, req.clone(), None);
        st.name = name;
        st.target = target;
        let ctl = Arc::new(Ctl::new(st, false, Some(self.jobs.dir.clone()), self.hub.clone()));
        ctl.set_kind(kind, None, "");
        ctl.set_resources(self.job_resources(&Resources::default()));
        self.jobs.insert(ctl.clone());
        self.spawn_task(ctl, kind.to_string(), req);
        Ok(id)
    }

    fn spawn_task(self: &Arc<Self>, ctl: Arc<Ctl>, kind: String, req: Value) {
        let me = self.clone();
        let usage = ctl.usage.clone();
        tokio::spawn(jobs::USAGE.scope(usage, async move {
            ctl.set_state("running");
            ctl.start_clock();
            ctl.phase("run", 0.0);
            let res = match kind.as_str() {
                "run_now" => me.clone().run_now_body(ctl.clone(), req).await,
                "history" => me.clone().history_body(ctl.clone(), req).await,
                "compare" => me.clone().compare_body(ctl.clone(), req).await,
                k => Err(anyhow!("unknown job kind {k}")),
            };
            match res {
                Ok(v) => {
                    ctl.set_result(v);
                    ctl.log("done");
                    ctl.finish(None, None, "done");
                }
                Err(e) => {
                    let c = ctl.cancelled();
                    ctl.log(format!("{}: {e:#}", if c { "cancelled" } else { "failed" }));
                    ctl.finish(None, Some(format!("{e:#}")), if c { "cancelled" } else { "failed" });
                }
            }
        }));
    }

    /// Models + their run options for a run request (`models` omitted = the running models).
    fn runs_of(&self, req: &Value) -> Result<Vec<(Arc<ModelRecord>, ModelRun)>> {
        let cfg = self.runner.cfg.read().clone();
        let runs: Vec<ModelRun> = match req.get("models") {
            Some(m) => parse_runs(&self.store, m)?
                .into_iter()
                .map(|r| {
                    // the model's saved options, then the request's
                    let mut base = serde_json::to_value(cfg.options(&r.id)).unwrap_or_default();
                    spec::merge(&mut base, &serde_json::to_value(&r).unwrap_or_default());
                    serde_json::from_value(base).unwrap_or(r)
                })
                .collect(),
            None => cfg.models.clone(),
        };
        let out: Vec<(Arc<ModelRecord>, ModelRun)> = runs.into_iter().filter_map(|o| self.store.get(&o.id).map(|m| (m, o))).collect();
        if out.is_empty() {
            bail!("no models given");
        }
        Ok(out)
    }

    /// `POST /api/ml/run/now`: one pass over all (or the listed) radars and every grid model.
    pub fn run_now(self: &Arc<Self>, body: &Value) -> Result<String> {
        let runs = self.runs_of(body)?;
        let name = format!("Run now: {}", runs.iter().map(|r| r.0.name.clone()).collect::<Vec<_>>().join(", "));
        self.submit_task("run_now", name, runs[0].0.target.clone(), body.clone())
    }

    async fn run_now_body(self: Arc<Self>, ctl: Arc<Ctl>, req: Value) -> Result<Value> {
        let runs = self.runs_of(&req)?;
        let sel = req.get("radars").cloned().unwrap_or(json!("all"));
        let tmp = Runner::new(None, 1);
        tmp.set_cfg(runner::RunCfg { models: runs.iter().map(|r| r.1.clone()).collect(), radars: sel.clone(), enabled: true, ..Default::default() });
        *tmp.sink.write() = self.runner.sink.read().clone();
        tmp.max_points.store(self.runner.max_points.load(Ordering::Relaxed), Ordering::Relaxed);
        let radar: Vec<(Arc<ModelRecord>, ModelRun)> = runs.iter().filter(|r| r.0.candidate == "radar_cell").cloned().collect();
        let grid: Vec<(Arc<ModelRecord>, ModelRun)> = runs.iter().filter(|r| r.0.candidate == "grid_point").cloned().collect();
        let per_site = if radar.is_empty() { vec![] } else { tmp.sites_for(&radar, &sel, &self.fetch.sites()) };
        let total = per_site.len() + grid.len();
        ctl.counts(|c| c.volumes_total = total);
        ctl.log(format!("one-shot run: {} radars, {} grid models", per_site.len(), grid.len()));
        let done = AtomicUsize::new(0);
        let hub = self.hub.clone();
        let job = ctl.id.clone();
        let conc = (ctl.resources().download_concurrency * 2).clamp(2, 32);
        let mut per_model: std::collections::BTreeMap<String, usize> = Default::default();
        let mut errors = serde_json::Map::new();
        use futures::StreamExt;
        let results: Vec<(String, Vec<runner::Detection>, Option<String>)> = futures::stream::iter(per_site)
            .map(|(site, models)| {
                let (tmp, fetch, ctl, done, job) = (&tmp, self.fetch.clone(), ctl.clone(), &done, job.clone());
                async move {
                    if ctl.cancelled() {
                        return (site, vec![], None);
                    }
                    let mut d = tmp.process_site(fetch.as_ref(), &site, &models, true).await;
                    for x in d.iter_mut() {
                        x.run = Some(job.clone());
                    }
                    let err = tmp.per_radar.read().get(&site).and_then(|s| s.error.clone());
                    let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                    ctl.counts(|c| c.volumes_done = n);
                    ctl.set_progress(n as f64 / total.max(1) as f64);
                    (site, d, err)
                }
            })
            .buffer_unordered(conc)
            .collect()
            .await;
        for (site, d, err) in results {
            if let Some(e) = err {
                errors.insert(site, json!(e));
            }
            for x in &d {
                *per_model.entry(x.model_id.clone()).or_default() += 1;
            }
            self.runner.push_live(hub.as_ref(), d);
        }
        let now = chrono::Utc::now().timestamp_millis();
        let mut layers = vec![];
        for (m, o) in &grid {
            if ctl.cancelled() {
                break;
            }
            match self.runner.run_grid_model(self.fetch.as_ref(), m, o, now, hub.as_ref()).await {
                Ok(mut out) => {
                    for x in out.detections.iter_mut() {
                        x.run = Some(job.clone());
                    }
                    *per_model.entry(m.id.clone()).or_default() += out.detections.len();
                    layers.extend(out.layers.clone());
                    self.runner.push_live(hub.as_ref(), out.detections);
                }
                Err(e) => {
                    errors.insert(m.id.clone(), json!(format!("{e:#}")));
                }
            }
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            ctl.counts(|c| c.volumes_done = n);
            ctl.set_progress(n as f64 / total.max(1) as f64);
        }
        if ctl.cancelled() {
            bail!("cancelled");
        }
        let n: usize = per_model.values().sum();
        ctl.counts(|c| c.samples = n);
        ctl.log(format!("{n} detections from {} radars", done.load(Ordering::Relaxed)));
        let summary = json!({"detections": n, "per_model": per_model, "radars": total - grid.len(), "errors": errors.len()});
        Ok(json!({"summary": summary, "detections": n, "per_model": per_model, "errors": errors, "layers": layers, "run": job}))
    }

    /// `POST /api/ml/run/history`: run models over past data (`from`..`to`, unix ms).
    pub fn run_history(self: &Arc<Self>, body: &Value) -> Result<String> {
        let runs = self.runs_of(body)?;
        let (from, to) = history_range(body)?;
        for (m, _) in &runs {
            let (ok, why, earliest) = spec::history_info(&m.target, &m.candidate, &m.feature_schema.sources);
            if !ok {
                bail!("model {} cannot run on past data: {why}", m.name);
            }
            if from < earliest {
                bail!("model {} needs data from {} on ({why})", m.name, chrono::DateTime::from_timestamp_millis(earliest).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default());
            }
        }
        let name = format!("History {}–{}: {}", fmt_t(from), fmt_t(to), runs.iter().map(|r| r.0.name.clone()).collect::<Vec<_>>().join(", "));
        self.submit_task("history", name, runs[0].0.target.clone(), body.clone())
    }

    async fn history_body(self: Arc<Self>, ctl: Arc<Ctl>, req: Value) -> Result<Value> {
        use futures::StreamExt;
        let runs = self.runs_of(&req)?;
        let (from, to) = history_range(&req)?;
        let step_min = req.get("step_min").and_then(|v| v.as_u64());
        let sel = req.get("radars").cloned().unwrap_or(json!("all"));
        let job = ctl.id.clone();
        let tmp = Arc::new(Runner::new(None, 1));
        tmp.set_cfg(runner::RunCfg { models: runs.iter().map(|r| r.1.clone()).collect(), radars: sel.clone(), enabled: true, ..Default::default() });
        tmp.max_points.store(self.runner.max_points.load(Ordering::Relaxed), Ordering::Relaxed);
        let radar: Vec<(Arc<ModelRecord>, ModelRun)> = runs.iter().filter(|r| r.0.candidate == "radar_cell").cloned().collect();
        let grid: Vec<(Arc<ModelRecord>, ModelRun)> = runs.iter().filter(|r| r.0.candidate == "grid_point").cloned().collect();
        // radar: the archived volumes of each radar in the range (thinned to step_min)
        let per_site = if radar.is_empty() { vec![] } else { tmp.sites_for(&radar, &sel, &self.fetch.sites()) };
        if per_site.len() > 400 {
            bail!("{} radars selected: pick at most 400 for a historical run", per_site.len());
        }
        let mut plan: Vec<(String, Vec<Arc<ModelRecord>>, Vec<(String, i64)>)> = vec![];
        ctl.log(format!("listing archived volumes of {} radars", per_site.len()));
        for (site, models) in per_site {
            if ctl.cancelled() {
                bail!("cancelled");
            }
            let mut vols: Vec<(String, i64)> = vec![];
            let mut d = chrono::DateTime::from_timestamp_millis(from).map(|x| x.date_naive()).unwrap_or_default();
            let end = chrono::DateTime::from_timestamp_millis(to).map(|x| x.date_naive()).unwrap_or_default();
            while d <= end {
                match self.fetch.list_day(&site, d).await {
                    Ok(l) => vols.extend(l.into_iter().filter(|v| v.time >= from && v.time <= to).map(|v| (v.key, v.time))),
                    Err(e) => ctl.log(format!("list {site} {d}: {e:#}")),
                }
                d = d.succ_opt().unwrap_or(end + chrono::Duration::days(1));
            }
            vols.sort_by_key(|v| v.1);
            if let Some(s) = step_min.filter(|s| *s > 0) {
                let mut last = i64::MIN;
                vols.retain(|v| {
                    if v.1 - last >= s as i64 * 60_000 - 30_000 {
                        last = v.1;
                        true
                    } else {
                        false
                    }
                });
            }
            if !vols.is_empty() {
                plan.push((site, models, vols));
            }
        }
        // grid: one run every step (default: the model's cadence)
        let mut grid_plan: Vec<(Arc<ModelRecord>, ModelRun, Vec<i64>)> = vec![];
        for (m, o) in &grid {
            let every = step_min.filter(|s| *s > 0).or(o.cadence_min).unwrap_or_else(|| m.spec.get("grid").and_then(|g| g.get("run_every_min")).and_then(|v| v.as_u64()).unwrap_or(60)).max(5) as i64 * 60_000;
            let ts: Vec<i64> = (0..).map(|k| from + k * every).take_while(|t| *t <= to).take(500).collect();
            grid_plan.push((m.clone(), o.clone(), ts));
        }
        let total: usize = plan.iter().map(|p| p.2.len()).sum::<usize>() + grid_plan.iter().map(|g| g.2.len()).sum::<usize>();
        if total == 0 {
            bail!("nothing to run: no archived volumes / times in the range");
        }
        ctl.counts(|c| c.volumes_total = total);
        ctl.log(format!("{total} steps: {} radars, {} grid models", plan.len(), grid_plan.len()));
        let done = AtomicUsize::new(0);
        let n_det = AtomicUsize::new(0);
        let conc = ctl.resources().download_concurrency.clamp(1, 16);
        let fetch = self.fetch.clone();
        let _: Vec<()> = futures::stream::iter(plan)
            .map(|(site, models, vols)| {
                let (tmp, fetch, ctl, done, n_det, job, me) = (tmp.clone(), fetch.clone(), ctl.clone(), &done, &n_det, job.clone(), self.clone());
                async move {
                    let mut prev = None;
                    let mut batch = vec![];
                    for (key, _) in vols {
                        if ctl.cancelled() {
                            break;
                        }
                        match tmp.process_hist_volume(fetch.as_ref(), &key, &models, &mut prev).await {
                            Ok(d) => batch.extend(d),
                            Err(e) => {
                                prev = None;
                                ctl.log(format!("{site}: skip {key}: {e:#}"));
                            }
                        }
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        ctl.counts(|c| c.volumes_done = n);
                        ctl.set_progress(n as f64 / total.max(1) as f64);
                        if batch.len() >= 200 {
                            n_det.fetch_add(batch.len(), Ordering::Relaxed);
                            me.runner.push_hist(tag(std::mem::take(&mut batch), &job));
                        }
                    }
                    n_det.fetch_add(batch.len(), Ordering::Relaxed);
                    me.runner.push_hist(tag(batch, &job));
                }
            })
            .buffer_unordered(conc)
            .collect()
            .await;
        // grid models: one prediction per step; the first frame of each forms the history layer
        let mut layers = vec![];
        for (m, o, ts) in grid_plan {
            let mut frames: Vec<crate::grid::Grid> = vec![];
            for t in ts {
                if ctl.cancelled() {
                    break;
                }
                match tmp.process_grid_v2(self.fetch.as_ref(), &m, &o, t, false, false).await {
                    Ok(out) => {
                        if let Some(f) = out.pred.frames.first() {
                            frames.push(predict::to_grid(&out.pred.geom, &f.values, !m.is_regression(), f.lead.valid, out.pred.issue));
                        }
                        let first = out.pred.frames.first().map(|f| f.lead.w0);
                        let d: Vec<runner::Detection> = out.detections.into_iter().filter(|d| d.valid_from == first || d.kind != "area").collect();
                        n_det.fetch_add(d.len(), Ordering::Relaxed);
                        self.runner.push_hist(tag(d, &job));
                    }
                    Err(e) => ctl.log(format!("{} at {}: {e:#}", m.name, fmt_t(t))),
                }
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                ctl.counts(|c| c.volumes_done = n);
                ctl.set_progress(n as f64 / total.max(1) as f64);
            }
            if let Some(l) = self.runner.publish_history_layer(&m, frames, &job) {
                layers.push(l);
            }
        }
        if ctl.cancelled() {
            bail!("cancelled");
        }
        let n = n_det.load(Ordering::Relaxed);
        ctl.counts(|c| c.samples = n);
        if let Some(h) = &self.hub {
            h.send(json!({"type": "ml_history", "job_id": job, "detections": n, "from": from, "to": to, "layers": layers}));
        }
        let summary = json!({"detections": n, "steps": total, "from": from, "to": to, "layers": layers.iter().map(|l| l.layer_id.clone()).collect::<Vec<_>>()});
        Ok(json!({"summary": summary, "detections": n, "from": from, "to": to, "layers": layers, "run": job, "query": format!("/api/ml/detections?run={job}&from={from}&to={to}")}))
    }

    /// `POST /api/ml/compare`: A/B scorecards on the same historical events.
    pub fn compare(self: &Arc<Self>, body: &Value) -> Result<String> {
        let ids: Vec<String> = body.get("models").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string).or_else(|| x.get("id").and_then(|i| i.as_str()).map(str::to_string))).collect()).unwrap_or_default();
        if ids.is_empty() {
            bail!("models: [ids] required");
        }
        let models: Vec<Arc<ModelRecord>> = ids.iter().map(|id| self.store.get(id).ok_or_else(|| anyhow!("model {id} not found"))).collect::<Result<_>>()?;
        let m0 = &models[0];
        for m in &models[1..] {
            if m.target != m0.target || m.candidate != m0.candidate || m.task != m0.task {
                bail!("models must share the target, candidate and task ({} vs {})", m0.target, m.target);
            }
        }
        if let Some(j) = body.get("job_id").and_then(|v| v.as_str()) {
            self.jobs.get(j).ok_or_else(|| anyhow!("job {j} not found"))?;
        } else {
            // validate the events spec now
            compare::eval_spec(&models, body.get("events").unwrap_or(&Value::Null), None)?;
        }
        let name = format!("Compare: {}", models.iter().map(|m| m.name.clone()).collect::<Vec<_>>().join(" vs "));
        self.submit_task("compare", name, m0.target.clone(), json!({"models": ids, "events": body.get("events").cloned().unwrap_or(Value::Null), "job_id": body.get("job_id").cloned().unwrap_or(Value::Null)}))
    }

    async fn compare_body(self: Arc<Self>, ctl: Arc<Ctl>, req: Value) -> Result<Value> {
        let ids: Vec<String> = req.get("models").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let models: Vec<Arc<ModelRecord>> = ids.iter().map(|id| self.store.get(id).ok_or_else(|| anyhow!("model {id} not found"))).collect::<Result<_>>()?;
        let job_spec = req.get("job_id").and_then(|v| v.as_str()).and_then(|j| self.jobs.get(j)).map(|c| c.snapshot().spec);
        let budget = self.budget(&ctl.resources());
        let res = compare::run(self.fetch.clone(), models, req.get("events").cloned().unwrap_or(Value::Null), job_spec, &ctl, &self.cache_root, &budget).await?;
        let dir = self.root.join("compare");
        std::fs::create_dir_all(&dir).ok();
        crate::platform::write_atomic(&dir.join(format!("{}.json", ctl.id)), &serde_json::to_vec(&res)?).ok();
        Ok(res)
    }

    /// A compare job with its result (scorecards, events).
    pub fn compare_result(&self, id: &str) -> Option<Value> {
        let c = self.jobs.get(id);
        let stored = std::fs::read(self.root.join("compare").join(format!("{}.json", id.replace(['/', '\\', '.'], "")))).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if c.is_none() && stored.is_none() {
            return None;
        }
        let mut v = c.as_ref().map(|c| c.json(false)).unwrap_or(json!({"id": id, "kind": "compare", "state": "done"}));
        if let Some(r) = stored.or_else(|| c.and_then(|c| c.snapshot().result)) {
            v["result"] = r;
        }
        Some(v)
    }

    // ---------- ensembles ----------

    /// `POST /api/ml/ensembles {name, members, method, weights?}`: a virtual model combining
    /// stored models (members are embedded: the ensemble keeps working, and exports, when a
    /// member changes or is deleted).
    pub fn create_ensemble(&self, body: &Value) -> Result<Arc<ModelRecord>> {
        let ids: Vec<String> = body.get("members").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if ids.len() < 2 {
            bail!("an ensemble needs at least 2 members");
        }
        let method = body.get("method").and_then(|v| v.as_str()).unwrap_or("mean").to_string();
        if !matches!(method.as_str(), "mean" | "max" | "vote" | "weighted") {
            bail!("method must be mean, max, vote or weighted");
        }
        let members: Vec<Arc<ModelRecord>> = ids.iter().map(|id| self.store.get(id).ok_or_else(|| anyhow!("model {id} not found"))).collect::<Result<_>>()?;
        let weights: Vec<f64> = body.get("weights").and_then(|v| v.as_array()).map(|a| a.iter().map(|x| x.as_f64().unwrap_or(1.0)).collect()).unwrap_or_default();
        if method == "weighted" && weights.len() != members.len() {
            bail!("weighted ensembles need one weight per member");
        }
        let m0 = members[0].clone();
        for m in &members {
            if m.target != m0.target || m.candidate != m0.candidate || m.task != m0.task || m.output() != m0.output() {
                bail!("members must share the target, candidate, task and output");
            }
            if m.target == "storm_track" {
                bail!("storm-track models cannot be combined yet");
            }
        }
        if method == "vote" && m0.is_regression() {
            bail!("vote needs classification members");
        }
        let ens = build_ensemble(&members, &method, &weights)?;
        let now = chrono::Utc::now().timestamp_millis();
        let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Ensemble ({method}) of {}", members.iter().map(|m| m.name.clone()).collect::<Vec<_>>().join(", ")));
        let threshold = if m0.is_regression() { m0.threshold } else if method == "vote" { 0.5 } else { members.iter().map(|m| m.threshold).sum::<f64>() / members.len() as f64 };
        let mut spec = m0.spec.clone();
        spec["sources"] = serde_json::to_value(&ens.1.sources)?;
        spec["intensity"] = json!("custom");
        let rec = ModelRecord {
            id: model::new_id(),
            name,
            labels: vec!["ensemble".into()],
            target: m0.target.clone(),
            candidate: m0.candidate.clone(),
            created: now,
            updated: now,
            spec,
            feature_schema: ens.1,
            algo: "ensemble".into(),
            params: json!({"method": method, "weights": weights}),
            metrics: json!({"ensemble": true, "members": members.iter().map(|m| json!({"id": m.id, "name": m.name, "summary": m.metrics_summary()})).collect::<Vec<_>>()}),
            threshold,
            levels: if m0.is_regression() { m0.levels } else { model::Levels::from_threshold(threshold) },
            version: 1,
            format: model::FORMAT_VERSION,
            task: m0.task.clone(),
            output: m0.output().to_string(),
            history: vec![HistEntry { version: 1, at: now, kind: "ensemble".into(), metrics_summary: Value::Null, samples: Value::Null, job_id: None, from_model: None }],
            quantiles: vec![],
            notes: body.get("notes").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            importance: vec![],
            calib: Default::default(),
            learner: model::Learner::Ensemble(Box::new(ens.0)),
            origin: "ensemble".into(),
            job_id: None,
            intensity: "custom".into(),
            family_key: m0.family(),
            aux: vec![],
            cache_bytes: 0,
            size_bytes: 0,
        };
        let saved = self.store.save(rec)?;
        if let Some(h) = &self.hub {
            h.send(json!({"type": "ml_model", "id": saved.id, "action": "created", "kind": "ensemble"}));
        }
        Ok(saved)
    }

    // ---------- per-model run configs ----------

    /// `PUT /api/ml/models/{id}/run {enabled?, options?, radars?}`.
    pub fn set_model_run(&self, id: &str, body: &Value) -> Result<Value> {
        self.store.get(id).ok_or_else(|| anyhow!("model not found"))?;
        let mut c = self.runner.cfg.read().clone();
        let cur = c.options(id);
        let mut v = serde_json::to_value(&cur)?;
        if let Some(o) = body.get("options") {
            if !o.is_object() {
                bail!("options must be an object (see the catalog's run_params)");
            }
            // replace the options (keep the radars unless given)
            let radars = v.get("radars").cloned();
            v = o.clone();
            v["id"] = json!(id);
            if let Some(r) = radars {
                v["radars"] = r;
            }
        }
        if let Some(r) = body.get("radars") {
            v["radars"] = r.clone();
        }
        let run = ModelRun::parse(&v)?;
        let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(c.has(id));
        if enabled && !self.cfg.read().enabled {
            bail!("detection models are disabled in the server config ([ml] enabled = false)");
        }
        c.set_model(run, enabled);
        if enabled {
            c.enabled = true;
        }
        self.runner.set_cfg(c);
        if let Some(h) = &self.hub {
            h.send(json!({"type": "ml_run_state", "model_id": id, "enabled": enabled}));
        }
        Ok(self.runner.model_run(id))
    }

    pub fn cache_stats(&self) -> Vec<crate::caches::CacheInfo> {
        let (rb, rn) = self.runner.mem_bytes();
        let (fb, fn_) = self.fetch.cache_bytes();
        let (mb, mn) = self.store.count_bytes();
        vec![
            crate::caches::CacheInfo::mem("ml-detections", "Detection models: live detections & tracked cells", rb, rn, 0),
            crate::caches::CacheInfo::mem("ml-downloads", "Detection models: gridded / label downloads", fb, fn_, 0),
            crate::caches::CacheInfo::mem("ml-models", "Detection models: loaded models", mb, mn, 0),
        ]
    }

    pub fn clear_cache(&self, id: &str) -> bool {
        match id {
            "ml-detections" => self.runner.clear(),
            "ml-downloads" => self.fetch.clear_cache(),
            "ml-models" => {}
            _ => return false,
        }
        true
    }
}

fn fmt_t(t: i64) -> String {
    chrono::DateTime::from_timestamp_millis(t).map(|d| d.format("%Y-%m-%d %H:%MZ").to_string()).unwrap_or_default()
}

fn tag(mut d: Vec<runner::Detection>, job: &str) -> Vec<runner::Detection> {
    for x in d.iter_mut() {
        x.run = Some(job.to_string());
    }
    d
}

/// `from` / `to` of a history request (unix ms, ISO 8601 also accepted); at most 31 days.
pub fn history_range(body: &Value) -> Result<(i64, i64)> {
    let t = |k: &str| -> Result<i64> {
        let v = body.get(k).ok_or_else(|| anyhow!("{k} required (unix ms)"))?;
        if let Some(n) = v.as_i64() {
            return Ok(n);
        }
        v.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .ok_or_else(|| anyhow!("{k} must be unix ms or an RFC 3339 time"))
    };
    let (from, to) = (t("from")?, t("to")?);
    if to <= from {
        bail!("to must be after from");
    }
    if to - from > 31 * 86_400_000 {
        bail!("at most 31 days per historical run");
    }
    if to > chrono::Utc::now().timestamp_millis() + 3_600_000 {
        bail!("to is in the future: use the live runner / run now");
    }
    Ok((from, to))
}

/// Position error (km) per lead of storm-track out-of-sample predictions, and of the
/// persistence (motion extrapolation) forecast: `{model: {lead: km}, persistence: {…}}`.
fn track_errors(ids: &[String], samples: &[dataset::Sample], oof_dx: &[f64], oof_dy: &[f64]) -> Value {
    let col = |f: &str| ids.iter().position(|x| x == f);
    let (Some(il), ex, ey) = (col("lead_min"), col("ext_dx_km"), col("ext_dy_km")) else { return Value::Null };
    let mut by: std::collections::BTreeMap<i64, (f64, usize, f64, usize)> = Default::default();
    // oof vectors follow the samples with a finite label (all for dx / dy)
    for (i, s) in samples.iter().enumerate() {
        let (Some(px), Some(py)) = (oof_dx.get(i), oof_dy.get(i)) else { continue };
        let lead = s.features[il].round() as i64;
        let e = by.entry(lead).or_default();
        if px.is_finite() && py.is_finite() && s.label.is_finite() && s.targets[0].is_finite() {
            e.0 += (px - s.label as f64).powi(2) + (py - s.targets[0] as f64).powi(2);
            e.1 += 1;
            if let (Some(a), Some(b)) = (ex, ey) {
                let (x, y) = (s.features[a] as f64, s.features[b] as f64);
                let (x, y) = (if x.is_finite() { x } else { 0.0 }, if y.is_finite() { y } else { 0.0 });
                e.2 += (x - s.label as f64).powi(2) + (y - s.targets[0] as f64).powi(2);
                e.3 += 1;
            }
        }
    }
    let r = |s: f64, n: usize| if n > 0 { ((s / n as f64).sqrt() * 10.0).round() / 10.0 } else { f64::NAN };
    let model: serde_json::Map<String, Value> = by.iter().filter(|(_, v)| v.1 > 0).map(|(k, v)| (k.to_string(), json!(r(v.0, v.1)))).collect();
    let pers: serde_json::Map<String, Value> = by.iter().filter(|(_, v)| v.3 > 0).map(|(k, v)| (k.to_string(), json!(r(v.2, v.3)))).collect();
    json!({"model": model, "persistence": pers})
}

/// The ensemble learner and its schema (union of the members' features).
fn build_ensemble(members: &[Arc<ModelRecord>], method: &str, weights: &[f64]) -> Result<(model::Ensemble, features::Schema)> {
    let mut feats: Vec<features::FeatureDef> = vec![];
    let mut src = features::Sources::default();
    for m in members {
        src = src.union(&m.feature_schema.sources);
        for f in &m.feature_schema.features {
            if !feats.iter().any(|x| x.id == f.id) {
                feats.push(f.clone());
            }
        }
    }
    let ids: Vec<String> = feats.iter().map(|f| f.id.clone()).collect();
    let maps: Vec<Vec<usize>> = members.iter().map(|m| m.ids().iter().map(|f| ids.iter().position(|x| x == f).unwrap_or(0)).collect()).collect();
    let version = members.iter().map(|m| m.feature_schema.version).max().unwrap_or(1);
    let schema = features::Schema { candidate: members[0].candidate.clone(), version, sources: src, features: feats };
    let ens = model::Ensemble { method: method.into(), weights: weights.to_vec(), regression: members[0].is_regression(), n: ids.len(), members: members.iter().map(|m| (**m).clone()).collect(), maps };
    Ok((ens, schema))
}

fn mode_of(body: &Value) -> Result<String> {
    let m = body.get("mode").and_then(|v| v.as_str()).unwrap_or("replace");
    if !matches!(m, "replace" | "new") {
        bail!("mode must be replace or new");
    }
    Ok(m.to_string())
}

/// Continued training needs the same features (a new feature has no trees / weights yet).
fn check_continue(m: &ModelRecord, s: &spec::TrainSpec) -> Result<()> {
    if s.algo != m.algo {
        bail!("continue keeps the model's algorithm ({}); use retrain to change it", m.algo);
    }
    if s.task != m.task || s.target != m.target || s.candidate != m.candidate {
        bail!("continue keeps the model's target and task; use retrain to change them");
    }
    let want = features::Schema::for_target(&s.target, &s.candidate, &s.sources, &s.features).ids();
    let have = m.feature_schema.ids();
    let new: Vec<&String> = want.iter().filter(|f| !have.contains(f) && s.sources.normalized() != m.feature_schema.sources.normalized()).collect();
    if !new.is_empty() {
        bail!("continue needs the model's feature schema; new features ({}) need a full retrain (POST /api/ml/models/{}/retrain)", new.iter().take(6).map(|s| s.as_str()).collect::<Vec<_>>().join(", "), m.id);
    }
    Ok(())
}

/// Delete the oldest files under `dir` until it fits in `cap` bytes, never touching files
/// modified after `pinned` (data of unfinished jobs); files unused for `retention` go anyway.
fn evict(dir: &std::path::Path, cap: u64, pinned: Option<std::time::SystemTime>, retention: Option<std::time::Duration>) {
    let mut files = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else {
                files.push((m.modified().ok(), m.len(), e.path()));
            }
        }
    }
    let now = std::time::SystemTime::now();
    let is_pinned = |t: Option<std::time::SystemTime>| match (pinned, t) {
        (Some(p), Some(t)) => t >= p,
        (Some(_), None) => true,
        _ => false,
    };
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (t, len, p) in files {
        if is_pinned(t) {
            continue;
        }
        let expired = match (retention, t) {
            (Some(r), Some(t)) => now.duration_since(t).map(|d| d > r).unwrap_or(false),
            _ => false,
        };
        if total <= cap && !expired {
            continue;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod evict_tests {
    #[test]
    fn eviction_keeps_pinned_files() {
        let d = std::env::temp_dir().join(format!("tbw-evict-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        for i in 0..4 {
            std::fs::write(d.join(format!("f{i}")), vec![0u8; 1000]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // pinned since before f2 was written: f2/f3 stay even over the cap
        let pin = std::fs::metadata(d.join("f2")).unwrap().modified().unwrap();
        super::evict(&d, 500, Some(pin), None);
        let left: Vec<String> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(left.contains(&"f2".to_string()) && left.contains(&"f3".to_string()) && !left.contains(&"f0".to_string()), "{left:?}");
        std::fs::remove_dir_all(&d).ok();
    }
}
