//! Detection models: train classifiers on historical radar / gridded data and run them live.
//!
//! * [`gbdt`], [`linear`], [`mlp`]: pure-Rust learners; [`metrics`]: verification + grouped CV.
//! * [`cells`]: storm-cell segmentation and features from a Level II volume.
//! * [`features`]: versioned feature schemas (radar cells, grid points, MRMS / METAR / GFS).
//! * [`labels`]: SPC / IEM / HURDAT2 / HMS event databases and matching rules.
//! * [`source`]: all outside data behind the [`source::Fetch`] trait (tests inject their own).
//! * [`dataset`]: builds training samples (cached per volume); [`train`]: fit + evaluate.
//! * [`jobs`]: background training jobs; [`model`]: model store, export / import.
//! * [`gridds`]: grid targets with leads / windows (instability, forecasts, outlooks, floods,
//!   tropical development); [`sat`]: GOES ABI / GLM features.
//! * [`runner`]: live inference over radars / regions; [`predict`]: grid prediction layers,
//!   area detections and outlook polygons; [`api`]: `/api/ml/*`.
//! * Retrain / continue: any stored model (trained or imported) carries its spec, so its data
//!   can be rebuilt (sample caches are keyed by volume / time) and it can be trained again from
//!   scratch or further (warm start).

pub mod api;
pub mod cells;
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
pub mod runner;
pub mod sat;
pub mod source;
pub mod spec;
pub mod train;

#[cfg(test)]
mod tests;

use anyhow::{bail, Result};
use jobs::{blank_state, Ctl, Jobs};
use model::{HistEntry, ModelRecord, Store};
use parking_lot::RwLock;
use runner::Runner;
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
    /// data/cache/ml
    pub cache_root: PathBuf,
    pub hub: Option<crate::hub::Hub>,
    pub cfg: RwLock<crate::config::MlCfg>,
    download_concurrency: AtomicUsize,
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

impl Ml {
    pub fn new(cfg: &crate::config::MlCfg, data_dir: &std::path::Path, fetch: Arc<dyn Fetch>, hub: Option<crate::hub::Hub>, full: bool, radar_mb: usize) -> Arc<Ml> {
        let root = data_dir.join("ml");
        let cache_root = data_dir.join("cache/ml");
        std::fs::create_dir_all(&cache_root).ok();
        let ml = Ml {
            store: Arc::new(Store::open(root.join("models"))),
            jobs: Arc::new(Jobs::open(root.join("jobs"), cfg.max_jobs.max(1), hub.clone())),
            runner: Arc::new(Runner::new(Some(root.join("runner.json")), auto(cfg.run_concurrency, 1, full, 3))),
            fetch,
            cache_root,
            hub,
            cfg: RwLock::new(cfg.clone()),
            download_concurrency: AtomicUsize::new(0),
            full,
            radar_mb: AtomicUsize::new(radar_mb),
        };
        *ml.runner.sink.write() = ml.fetch.pred_sink();
        ml.apply_concurrency();
        Arc::new(ml)
    }

    fn apply_concurrency(&self) {
        let c = self.cfg.read().clone();
        // decoded volumes are ~100–300 MB each: keep parallel downloads inside the radar budget
        let mem_cap = (self.radar_mb.load(Ordering::Relaxed) / 400).max(1);
        let d = auto(c.download_concurrency, 2, self.full, 4).min(mem_cap.max(1)).max(1);
        self.download_concurrency.store(d, Ordering::Relaxed);
        self.runner.max_points.store(auto(c.pred_max_points, 150_000, self.full, 400_000), Ordering::Relaxed);
    }

    /// Apply `[ml]` settings and the radar memory share live.
    pub fn configure(&self, cfg: &crate::config::MlCfg, radar_mb: usize) {
        *self.cfg.write() = cfg.clone();
        self.radar_mb.store(radar_mb, Ordering::Relaxed);
        self.apply_concurrency();
        self.jobs.sem.resize(cfg.max_jobs.max(1));
        self.runner.concurrency.resize(auto(cfg.run_concurrency, 1, self.full, 3));
    }

    pub fn download_concurrency(&self) -> usize {
        self.download_concurrency.load(Ordering::Relaxed)
    }

    /// Background tasks: the live runner and the sample-cache janitor.
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
                let cap = me.cfg.read().cache_disk_mb;
                let cap = if cap > 0 { cap } else { 2048 } << 20;
                let dir = me.cache_root.join("cells");
                tokio::task::spawn_blocking(move || evict(&dir, cap)).await.ok();
            }
        });
    }

    /// Queue a training job; returns its id.
    pub fn submit(self: &Arc<Self>, raw: &Value) -> Result<String> {
        self.submit_job(raw, JobKind::train())
    }

    /// Queue a train / retrain / continue job.
    pub fn submit_job(self: &Arc<Self>, raw: &Value, kind: JobKind) -> Result<String> {
        if !self.cfg.read().enabled {
            bail!("detection models are disabled in the server config ([ml] enabled = false)");
        }
        let spec = spec::resolve(raw)?;
        let base = match &kind.base {
            Some(b) => Some(self.store.get(b).ok_or_else(|| anyhow::anyhow!("model {b} not found"))?),
            None => None,
        };
        if kind.kind == "continue" {
            let b = base.as_ref().unwrap();
            check_continue(b, &spec)?;
        }
        let id = format!("j{}", model::radix36(chrono::Utc::now().timestamp_millis() as u64));
        let id = if self.jobs.get(&id).is_some() { format!("{id}{:x}", rand::random::<u16>()) } else { id };
        let st = blank_state(&id, serde_json::to_value(&spec)?, spec.time_limit_min);
        let ctl = Arc::new(Ctl::new(st, spec.candidate == "grid_point", Some(self.jobs.dir.clone()), self.hub.clone()));
        ctl.set_kind(&kind.kind, kind.base.clone(), &kind.mode);
        let what = match kind.kind.as_str() {
            "retrain" => format!("retrain of {} ({})", kind.base.as_deref().unwrap_or(""), kind.mode),
            "continue" => format!("continued training of {} ({})", kind.base.as_deref().unwrap_or(""), kind.mode),
            _ => "training".into(),
        };
        ctl.log(format!("queued {what}: {} ({}, {}, {} {}–{}, {} events max, {})", spec.name, spec.target, spec.task, spec.candidate, spec.years[0], spec.years[1], spec.max_events, spec.algo));
        self.jobs.insert(ctl.clone());
        let me = self.clone();
        tokio::spawn(async move { me.run_job(ctl, spec, kind).await });
        Ok(id)
    }

    /// Restart an interrupted / failed job with its spec (cached volumes make it fast).
    pub fn resume(self: &Arc<Self>, id: &str) -> Result<String> {
        let c = self.jobs.get(id).ok_or_else(|| anyhow::anyhow!("job not found"))?;
        let s = c.snapshot();
        if matches!(s.state.as_str(), "queued" | "running" | "stopping") {
            bail!("job is still active");
        }
        let mut raw = s.spec.clone();
        if let Some(o) = raw.as_object_mut() {
            o.remove("preset");
        }
        let kind = if s.kind.is_empty() || s.kind == "train" { JobKind::train() } else { JobKind { kind: s.kind.clone(), base: s.base_model.clone(), mode: s.mode.clone() } };
        let new = self.submit_job(&raw, kind)?;
        if let Some(n) = self.jobs.get(&new) {
            n.log(format!("resumed from job {id}"));
        }
        Ok(new)
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
        let m = self.store.get(id).ok_or_else(|| anyhow::anyhow!("model not found"))?;
        let mode = mode_of(body)?;
        let raw = Self::model_spec_with(&m, body, false);
        self.submit_job(&raw, JobKind { kind: "retrain".into(), base: Some(m.id.clone()), mode })
    }

    /// `POST /api/ml/models/{id}/continue`: warm start on the (possibly enlarged) dataset.
    pub fn continue_training(self: &Arc<Self>, id: &str, body: &Value) -> Result<String> {
        let m = self.store.get(id).ok_or_else(|| anyhow::anyhow!("model not found"))?;
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
        // wait for a slot (cancellable while queued)
        let sem = self.jobs.sem.sem.clone();
        let permit = loop {
            if ctl.cancelled() {
                ctl.finish(None, Some("cancelled while queued".into()), "cancelled");
                return;
            }
            match tokio::time::timeout(std::time::Duration::from_millis(500), sem.clone().acquire_owned()).await {
                Ok(Ok(p)) => break p,
                Ok(Err(_)) => return,
                Err(_) => continue,
            }
        };
        ctl.set_state("running");
        ctl.log(format!("started ({} parallel downloads)", self.download_concurrency()));
        let res = self.clone().job_body(ctl.clone(), spec, kind).await;
        drop(permit);
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
    }

    async fn job_body(self: Arc<Self>, ctl: Arc<Ctl>, spec: spec::TrainSpec, kind: JobKind) -> Result<String> {
        let base = kind.base.as_ref().and_then(|b| self.store.get(b));
        if kind.base.is_some() && base.is_none() {
            bail!("model {} no longer exists", kind.base.as_deref().unwrap_or(""));
        }
        let cont = kind.kind == "continue";
        let built = dataset::build(self.fetch.clone(), &spec, &ctl, &self.cache_root, self.download_concurrency()).await?;
        if ctl.cancelled() {
            bail!("cancelled");
        }
        ctl.phase("train", 0.0);
        let schema = match (&base, cont) {
            (Some(b), true) => b.feature_schema.clone(),
            _ => features::Schema::for_target(&spec.target, &spec.candidate, &spec.sources, &spec.features),
        };
        ctl.log(format!("training {} ({}) on {} samples × {} features", spec.algo, spec.task, built.samples.len(), schema.features.len()));
        let (c2, s2, sc2, b2) = (ctl.clone(), spec.clone(), schema.clone(), if cont { base.clone() } else { None });
        let (ids, samples) = (built.ids, built.samples);
        let trained = tokio::task::spawn_blocking(move || train::train_with(&s2, &sc2, &ids, &samples, &c2, b2.as_deref())).await??;
        if ctl.cancelled() {
            bail!("cancelled");
        }
        ctl.phase("save", 0.0);
        let now = chrono::Utc::now().timestamp_millis();
        let mut metrics = trained.metrics;
        metrics["dataset"]["build"] = built.stats;
        if ctl.stop_requested() {
            metrics["stopped_early"] = Value::Bool(true);
        }
        if let Some(b) = &base {
            // previous metrics stay available for comparison
            metrics["previous"] = json!({"version": b.version, "summary": b.metrics_summary(), "samples": b.metrics.get("dataset").and_then(|d| d.get("samples")).cloned()});
        }
        let output = spec::target(&spec.target).map(|t| t.output).unwrap_or("detections").to_string();
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
            h.send(serde_json::json!({"type": "ml_model", "id": saved.id, "action": if base.is_some() && replace { "updated" } else { "created" }, "version": saved.version}));
        }
        Ok(saved.id.clone())
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

/// Delete the oldest files under `dir` until it fits in `cap` bytes.
fn evict(dir: &std::path::Path, cap: u64) {
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
