//! Detection models: train classifiers on historical radar / gridded data and run them live.
//!
//! * [`gbdt`], [`linear`], [`mlp`]: pure-Rust learners; [`metrics`]: verification + grouped CV.
//! * [`cells`]: storm-cell segmentation and features from a Level II volume.
//! * [`features`]: versioned feature schemas (radar cells, grid points, MRMS / METAR / GFS).
//! * [`labels`]: SPC / IEM / HURDAT2 / HMS event databases and matching rules.
//! * [`source`]: all outside data behind the [`source::Fetch`] trait (tests inject their own).
//! * [`dataset`]: builds training samples (cached per volume); [`train`]: fit + evaluate.
//! * [`jobs`]: background training jobs; [`model`]: model store, export / import.
//! * [`runner`]: live inference over radars / regions; [`api`]: `/api/ml/*`.

pub mod api;
pub mod cells;
pub mod core;
pub mod dataset;
pub mod features;
pub mod gbdt;
pub mod jobs;
pub mod labels;
pub mod linear;
pub mod metrics;
pub mod mlp;
pub mod model;
pub mod runner;
pub mod source;
pub mod spec;
pub mod train;

#[cfg(test)]
mod tests;

use anyhow::{bail, Result};
use jobs::{blank_state, Ctl, Jobs};
use model::{ModelRecord, Store};
use parking_lot::RwLock;
use runner::Runner;
use serde_json::Value;
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
        ml.apply_concurrency();
        Arc::new(ml)
    }

    fn apply_concurrency(&self) {
        let c = self.cfg.read().clone();
        // decoded volumes are ~100–300 MB each: keep parallel downloads inside the radar budget
        let mem_cap = (self.radar_mb.load(Ordering::Relaxed) / 400).max(1);
        let d = auto(c.download_concurrency, 2, self.full, 4).min(mem_cap.max(1)).max(1);
        self.download_concurrency.store(d, Ordering::Relaxed);
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
        if !self.cfg.read().enabled {
            bail!("detection models are disabled in the server config ([ml] enabled = false)");
        }
        let spec = spec::resolve(raw)?;
        let id = format!("j{}", model::radix36(chrono::Utc::now().timestamp_millis() as u64));
        let id = if self.jobs.get(&id).is_some() { format!("{id}{:x}", rand::random::<u16>()) } else { id };
        let st = blank_state(&id, serde_json::to_value(&spec)?, spec.time_limit_min);
        let ctl = Arc::new(Ctl::new(st, spec.candidate == "grid_point", Some(self.jobs.dir.clone()), self.hub.clone()));
        ctl.log(format!("queued: {} ({}, {} {}–{}, {} events max, {})", spec.name, spec.target, spec.candidate, spec.years[0], spec.years[1], spec.max_events, spec.algo));
        self.jobs.insert(ctl.clone());
        let me = self.clone();
        tokio::spawn(async move { me.run_job(ctl, spec).await });
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
        let new = self.submit(&raw)?;
        if let Some(n) = self.jobs.get(&new) {
            n.log(format!("resumed from job {id}"));
        }
        Ok(new)
    }

    async fn run_job(self: Arc<Self>, ctl: Arc<Ctl>, spec: spec::TrainSpec) {
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
        let res = self.clone().job_body(ctl.clone(), spec).await;
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

    async fn job_body(self: Arc<Self>, ctl: Arc<Ctl>, spec: spec::TrainSpec) -> Result<String> {
        let built = dataset::build(self.fetch.clone(), &spec, &ctl, &self.cache_root, self.download_concurrency()).await?;
        if ctl.cancelled() {
            bail!("cancelled");
        }
        ctl.phase("train", 0.0);
        let schema = features::Schema::new(&spec.candidate, &spec.sources, &spec.features);
        ctl.log(format!("training {} on {} samples × {} features", spec.algo, built.samples.len(), schema.features.len()));
        let (c2, s2, sc2) = (ctl.clone(), spec.clone(), schema.clone());
        let (ids, samples) = (built.ids, built.samples);
        let trained = tokio::task::spawn_blocking(move || train::train(&s2, &sc2, &ids, &samples, &c2)).await??;
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
        let rec = ModelRecord {
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
            version: model::FORMAT_VERSION,
            notes: spec.notes.clone(),
            importance: trained.importance,
            calib: trained.calib,
            learner: trained.learner,
            origin: "trained".into(),
            job_id: Some(ctl.id.clone()),
        };
        let saved = self.store.save(rec)?;
        if let Some(h) = &self.hub {
            h.send(serde_json::json!({"type": "ml_model", "id": saved.id, "action": "created"}));
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
