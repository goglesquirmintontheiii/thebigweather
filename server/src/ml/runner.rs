//! Live inference: for the selected radars, process each new Level II volume (cells → features
//! → every enabled radar-cell model) and run grid-point models over their region at their
//! cadence. Grid / outlook models publish prediction layers (`mlpred/<model_id>`) and area /
//! outlook polygons. Per-model run options gate, filter and shape the output. Detections are
//! kept for 2 h and pushed on the `/ws` hub.

use super::cells::{self, CellParams, VolCells};
use super::features::{day_of_year, solar_hour, Sources};
use super::labels::Region;
use super::model::{Levels, ModelRecord, Store};
use super::predict::{self, OutlookLevel, PredGrid, PredSink, PredictOpts};
use super::source::Fetch;
use futures::StreamExt;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

pub const KEEP_MS: i64 = 2 * 3_600_000;

fn day_str<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// Per-model run options (see the catalog's `run_params`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct ModelRun {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_prob: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_prob: Option<f64>,
    /// regression outputs: hide values outside [min_value, max_value]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistence: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_cell_dbz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_area_km2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_range_km: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<Region>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leads: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_to: Option<i64>,
    #[serde(deserialize_with = "day_str", skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_res_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoothing_km: Option<f64>,
    /// mean | max (true = mean)
    #[serde(deserialize_with = "ens_de", skip_serializing_if = "Option::is_none")]
    pub ensemble: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadence_min: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_detections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outlook_levels: Option<Vec<OutlookLevel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantiles: Option<bool>,
}

impl ModelRun {
    pub fn plain(id: &str) -> ModelRun {
        ModelRun { id: id.to_string(), ..Default::default() }
    }
    /// Parse one entry: a model id string or an options object.
    pub fn parse(v: &Value) -> anyhow::Result<ModelRun> {
        match v {
            Value::String(s) => Ok(ModelRun::plain(s)),
            Value::Object(_) => {
                let r: ModelRun = serde_json::from_value(v.clone()).map_err(|e| anyhow::anyhow!("bad model options: {e}"))?;
                if r.id.is_empty() {
                    anyhow::bail!("model options need an id");
                }
                r.validate()?;
                Ok(r)
            }
            _ => anyhow::bail!("models: [\"id\" | {{id, …options}}]"),
        }
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        for (n, v) in [("min_prob", self.min_prob), ("max_prob", self.max_prob)] {
            if let Some(x) = v {
                if !(0.0..=1.0).contains(&x) {
                    anyhow::bail!("{n} must be 0–1");
                }
            }
        }
        if let Some(t) = self.threshold {
            if !(t.is_finite()) {
                anyhow::bail!("threshold must be a number");
            }
        }
        if let Some(e) = &self.ensemble {
            if !matches!(e.as_str(), "mean" | "max") {
                anyhow::bail!("ensemble must be mean or max");
            }
        }
        if let (Some(a), Some(b)) = (self.valid_from, self.valid_to) {
            if b <= a {
                anyhow::bail!("valid_to must be after valid_from");
            }
        }
        if let Some(d) = &self.day {
            if !matches!(d.as_str(), "1" | "2" | "3" | "4-7" | "4") {
                anyhow::bail!("day must be 1, 2, 3 or 4-7");
            }
        }
        Ok(())
    }
    fn levels(&self, m: &ModelRecord) -> Levels {
        match self.threshold {
            Some(t) if !m.is_regression() => Levels::from_threshold(t),
            _ => m.levels,
        }
    }
    fn gate_ok(&self, p: f64) -> bool {
        p >= self.min_prob.unwrap_or(0.0) && p <= self.max_prob.unwrap_or(1.0)
    }
    fn window(&self) -> Option<(i64, i64)> {
        match (self.valid_from, self.valid_to) {
            (Some(a), Some(b)) => Some((a, b)),
            (Some(a), None) => Some((a, a)),
            _ => None,
        }
    }
}

fn ens_de<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Bool(true) => Some("mean".into()),
        Value::String(s) if !s.trim().is_empty() && s != "none" && s != "off" => Some(s.trim().to_ascii_lowercase()),
        Value::Number(n) if n.as_f64().unwrap_or(0.0) != 0.0 => Some("mean".into()),
        _ => None,
    })
}

fn models_de<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<ModelRun>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_array().map(|a| a.iter().filter_map(|x| ModelRun::parse(x).ok()).collect()).unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RunCfg {
    /// model ids or per-model options
    #[serde(deserialize_with = "models_de")]
    pub models: Vec<ModelRun>,
    /// "all" | "nexrad" | "tdwr" | ["KTLX", …] | {"states": ["OK", …]} | {"bbox": [w, s, e, n]}
    pub radars: Value,
    pub enabled: bool,
    pub interval_s: u64,
    /// radars processed at once (0 = server default)
    pub concurrency: usize,
}

impl Default for RunCfg {
    fn default() -> Self {
        Self { models: vec![], radars: json!("all"), enabled: false, interval_s: 60, concurrency: 0 }
    }
}

impl RunCfg {
    pub fn ids(&self) -> Vec<String> {
        self.models.iter().map(|m| m.id.clone()).collect()
    }
    pub fn has(&self, id: &str) -> bool {
        self.models.iter().any(|m| m.id == id)
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RadarStat {
    pub t: Option<i64>,
    pub cells: usize,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub detections: usize,
    pub checked: i64,
}

/// A prediction layer produced by a model run.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LayerInfo {
    pub model_id: String,
    pub layer_id: String,
    pub name: String,
    /// grid | outlook
    pub kind: String,
    pub field: String,
    pub units: String,
    pub cmap: String,
    pub run: i64,
    pub valid_times: Vec<i64>,
}

/// Run state of one model.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ModelState {
    /// idle | ok | error | running
    pub state: String,
    pub last_run: Option<i64>,
    pub last_ok: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub ms: u64,
    pub detections: usize,
    pub layers: Vec<LayerInfo>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run: Option<i64>,
    /// valid times of the main layer (grid / outlook models)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub valid_times: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Detection {
    pub id: String,
    pub model_id: String,
    pub model_name: String,
    pub target: String,
    pub prob: f64,
    pub level: &'static str,
    pub site: Option<String>,
    pub t: i64,
    pub created: i64,
    pub cell_id: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub top_features: Vec<super::model::Contribution>,
    pub motion: Option<Value>,
    pub outline: Vec<[f32; 2]>,
    /// cell | point | area
    pub kind: &'static str,
    pub valid_from: Option<i64>,
    pub valid_to: Option<i64>,
    /// area polygon: outer ring + holes (lon, lat)
    pub rings: Vec<Vec<[f64; 2]>>,
    /// regression outputs: the max predicted value in the area (layer units)
    pub value: Option<f64>,
}

impl Detection {
    fn props(&self) -> Value {
        let mut p = json!({
            "id": self.id, "model_id": self.model_id, "model_name": self.model_name, "target": self.target,
            "prob": (self.prob.clamp(0.0, 1.0) * 1000.0).round() / 1000.0, "level": self.level, "site": self.site, "t": self.t, "created": self.created,
            "cell_id": self.cell_id, "top_features": self.top_features, "motion": self.motion, "kind": self.kind,
        });
        if self.valid_from.is_some() {
            p["valid_from"] = json!(self.valid_from);
            p["valid_to"] = json!(self.valid_to);
        }
        if let Some(v) = self.value {
            p["value"] = json!((v * 100.0).round() / 100.0);
        }
        p
    }
    pub fn ws(&self) -> Value {
        let mut p = self.props();
        p["type"] = json!("ml_detection");
        p["lat"] = json!(self.lat);
        p["lon"] = json!(self.lon);
        if !self.outline.is_empty() {
            p["outline"] = json!(self.outline);
        }
        if !self.rings.is_empty() {
            p["rings"] = json!(self.rings);
        }
        p
    }
}

/// Resolve a radar selection to site ids.
pub fn resolve_sites(sel: &Value, sites: &[crate::sites::Site]) -> Vec<String> {
    let us = |s: &&crate::sites::Site| s.kind == "NEXRAD" || s.kind == "TDWR";
    let mut v: Vec<String> = match sel {
        Value::String(s) => match s.to_ascii_lowercase().as_str() {
            "nexrad" => sites.iter().filter(|s| s.kind == "NEXRAD").map(|s| s.id.clone()).collect(),
            "tdwr" => sites.iter().filter(|s| s.kind == "TDWR").map(|s| s.id.clone()).collect(),
            "all" => sites.iter().filter(us).map(|s| s.id.clone()).collect(),
            one => sites.iter().filter(|x| x.id.eq_ignore_ascii_case(one)).map(|s| s.id.clone()).collect(),
        },
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).filter_map(|id| sites.iter().find(|s| s.id.eq_ignore_ascii_case(id)).map(|s| s.id.clone())).collect(),
        Value::Object(o) => {
            let mut out = vec![];
            if let Some(st) = o.get("states").and_then(|x| x.as_array()) {
                let st: Vec<String> = st.iter().filter_map(|x| x.as_str().map(|s| s.to_ascii_uppercase())).collect();
                // the embedded site table has no states: fall back to the states' boxes
                let region = super::labels::Region { states: st.clone(), bbox: None };
                out.extend(sites.iter().filter(us).filter(|s| if s.state.trim().is_empty() { region.contains(s.lat, s.lon, "") } else { st.contains(&s.state.to_ascii_uppercase()) }).map(|s| s.id.clone()));
            }
            if let Some(b) = o.get("bbox").and_then(|x| x.as_array()).filter(|b| b.len() == 4) {
                let b: Vec<f64> = b.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
                out.extend(sites.iter().filter(us).filter(|s| s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3]).map(|s| s.id.clone()));
            }
            if let Some(ids) = o.get("sites").and_then(|x| x.as_array()) {
                out.extend(ids.iter().filter_map(|x| x.as_str()).filter_map(|id| sites.iter().find(|s| s.id.eq_ignore_ascii_case(id)).map(|s| s.id.clone())));
            }
            out
        }
        _ => vec![],
    };
    v.sort();
    v.dedup();
    v
}

/// Output of one grid-model run.
pub struct GridRunOut {
    pub detections: Vec<Detection>,
    pub layers: Vec<LayerInfo>,
    pub outlook: Option<Value>,
    pub pred: Arc<PredGrid>,
}

pub struct Runner {
    pub cfg: RwLock<RunCfg>,
    pub per_radar: RwLock<HashMap<String, RadarStat>>,
    prev: Mutex<HashMap<String, VolCells>>,
    last_key: Mutex<HashMap<String, String>>,
    pub dets: RwLock<VecDeque<Detection>>,
    pub last_cycle: Mutex<Option<i64>>,
    /// last run time per model (cadence)
    model_last: Mutex<HashMap<String, i64>>,
    pub model_state: RwLock<HashMap<String, ModelState>>,
    /// latest outlook GeoJSON per (model, window start)
    pub outlooks: RwLock<HashMap<String, Value>>,
    /// persistence: (model, key) → consecutive hits, last time
    streak: Mutex<HashMap<(String, String), (u32, i64)>>,
    /// persistence of grid areas: model → recent area rings
    area_hist: Mutex<HashMap<String, VecDeque<Vec<Vec<[f64; 2]>>>>>,
    pub sink: RwLock<Option<Arc<dyn PredSink>>>,
    pub max_points: std::sync::atomic::AtomicUsize,
    pub wake: tokio::sync::Notify,
    pub concurrency: crate::caches::Limiter,
    seq: std::sync::atomic::AtomicU64,
    path: Option<std::path::PathBuf>,
}

impl Runner {
    pub fn new(path: Option<std::path::PathBuf>, concurrency: usize) -> Runner {
        let cfg: RunCfg = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Runner {
            cfg: RwLock::new(cfg),
            per_radar: RwLock::new(HashMap::new()),
            prev: Mutex::new(HashMap::new()),
            last_key: Mutex::new(HashMap::new()),
            dets: RwLock::new(VecDeque::new()),
            last_cycle: Mutex::new(None),
            model_last: Mutex::new(HashMap::new()),
            model_state: RwLock::new(HashMap::new()),
            outlooks: RwLock::new(HashMap::new()),
            streak: Mutex::new(HashMap::new()),
            area_hist: Mutex::new(HashMap::new()),
            sink: RwLock::new(None),
            max_points: std::sync::atomic::AtomicUsize::new(150_000),
            wake: tokio::sync::Notify::new(),
            concurrency: crate::caches::Limiter::new(concurrency),
            seq: std::sync::atomic::AtomicU64::new(0),
            path,
        }
    }

    pub fn set_cfg(&self, c: RunCfg) {
        if let Some(p) = &self.path {
            crate::platform::write_atomic(p, &serde_json::to_vec_pretty(&c).unwrap_or_default()).ok();
        }
        // models no longer run lose their layers and state
        let old = self.cfg.read().ids();
        for id in old.iter().filter(|id| !c.has(id)) {
            self.forget_model(id);
        }
        if c.concurrency > 0 {
            self.concurrency.resize(c.concurrency);
        }
        *self.cfg.write() = c;
        self.wake.notify_one();
    }

    /// Drop a model's layers, outlooks and run state.
    pub fn forget_model(&self, id: &str) {
        if let Some(s) = self.sink.read().as_ref() {
            s.remove(&format!("mlpred/{id}"));
        }
        self.model_state.write().remove(id);
        self.model_last.lock().remove(id);
        self.outlooks.write().retain(|k, _| !k.starts_with(&format!("{id}|")));
        self.area_hist.lock().remove(id);
    }

    fn opts(&self, id: &str) -> ModelRun {
        self.cfg.read().models.iter().find(|m| m.id == id).cloned().unwrap_or_else(|| ModelRun::plain(id))
    }

    /// Every produced layer.
    pub fn layers(&self) -> Vec<LayerInfo> {
        let mut v: Vec<LayerInfo> = self.model_state.read().values().flat_map(|s| s.layers.clone()).collect();
        v.sort_by(|a, b| a.layer_id.cmp(&b.layer_id));
        v.dedup_by(|a, b| a.layer_id == b.layer_id);
        v
    }

    pub fn status(&self, sites: &[crate::sites::Site]) -> Value {
        let c = self.cfg.read().clone();
        let resolved = resolve_sites(&c.radars, sites);
        let ms = self.model_state.read().clone();
        let per_model: serde_json::Map<String, Value> = c
            .models
            .iter()
            .map(|m| {
                let mut s = serde_json::to_value(ms.get(&m.id).cloned().unwrap_or_else(|| ModelState { state: if c.enabled { "waiting".into() } else { "idle".into() }, ..Default::default() })).unwrap_or_default();
                s["options"] = serde_json::to_value(m).unwrap_or_default();
                (m.id.clone(), s)
            })
            .collect();
        // models: ids, or {id, …options} when options are set (the POST format)
        let models: Vec<Value> = c.models.iter().map(|m| if *m == ModelRun::plain(&m.id) { json!(m.id) } else { serde_json::to_value(m).unwrap_or_default() }).collect();
        let opts: serde_json::Map<String, Value> = c.models.iter().map(|m| {
            let mut v = serde_json::to_value(m).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.remove("id");
            }
            (m.id.clone(), v)
        }).collect();
        json!({
            "enabled": c.enabled, "models": models, "model_ids": c.ids(), "model_opts": opts, "radars": c.radars, "interval_s": c.interval_s,
            "concurrency": self.concurrency.permits(),
            "sites": resolved, "last_cycle": *self.last_cycle.lock(),
            "per_radar": self.per_radar.read().clone(),
            "per_model": per_model.clone(),
            "models_state": per_model,
            "layers": self.layers(),
            "outlooks": self.outlooks.read().keys().cloned().collect::<Vec<_>>(),
            "detections": self.dets.read().len(),
        })
    }

    pub fn mem_bytes(&self) -> (usize, usize) {
        let d = self.dets.read();
        let p = self.prev.lock();
        let cells: usize = p.values().map(|v| v.cells.len()).sum();
        let o: usize = self.outlooks.read().values().map(|v| v.to_string().len()).sum();
        (d.len() * 1500 + cells * 3000 + o, d.len() + p.len())
    }

    pub fn clear(&self) {
        self.dets.write().clear();
        self.prev.lock().clear();
        self.streak.lock().clear();
    }

    fn prune(&self, now: i64) {
        let mut d = self.dets.write();
        while d.front().map(|x| now - x.created > KEEP_MS).unwrap_or(false) {
            d.pop_front();
        }
        drop(d);
        self.streak.lock().retain(|_, v| now - v.1 < 3_600_000);
    }

    fn push(&self, hub: Option<&crate::hub::Hub>, mut new: Vec<Detection>) {
        if new.is_empty() {
            return;
        }
        new.sort_by_key(|d| d.created);
        if let Some(h) = hub {
            for d in &new {
                h.send(d.ws());
                if self.opts(&d.model_id).notify.unwrap_or(false) && matches!(d.level, "med" | "high") {
                    h.send(json!({"type": "ml_notify", "model_id": d.model_id, "model_name": d.model_name, "target": d.target, "prob": (d.prob * 1000.0).round() / 1000.0, "level": d.level, "lat": d.lat, "lon": d.lon, "site": d.site, "kind": d.kind, "t": d.t}));
                }
            }
        }
        let mut g = self.dets.write();
        g.extend(new);
        while g.len() > 50_000 {
            g.pop_front();
        }
    }

    /// GeoJSON of detections created at/after `since` (ms), optionally filtered by models / bbox.
    /// Cells: a point (+ an outline polygon); grid areas: a polygon with `kind: "area"`.
    pub fn geojson(&self, since: i64, models: &[String], bbox: Option<[f64; 4]>) -> Value {
        let d = self.dets.read();
        let mut feats = vec![];
        for x in d.iter() {
            if x.created < since || (!models.is_empty() && !models.contains(&x.model_id)) {
                continue;
            }
            if let Some([w, s, e, n]) = bbox {
                if !(x.lon >= w && x.lon <= e && x.lat >= s && x.lat <= n) {
                    continue;
                }
            }
            if x.kind == "area" && !x.rings.is_empty() {
                let mut p = x.props();
                p["kind"] = json!("area");
                p["lat"] = json!(x.lat);
                p["lon"] = json!(x.lon);
                feats.push(json!({"type": "Feature", "id": x.id, "geometry": {"type": "Polygon", "coordinates": x.rings}, "properties": p}));
                continue;
            }
            let mut p = x.props();
            p["kind"] = json!("point");
            feats.push(json!({"type": "Feature", "id": x.id, "geometry": {"type": "Point", "coordinates": [x.lon, x.lat]}, "properties": p}));
            if x.outline.len() >= 3 {
                let mut ring: Vec<[f32; 2]> = x.outline.clone();
                ring.push(ring[0]);
                let mut p = x.props();
                p["kind"] = json!("outline");
                feats.push(json!({"type": "Feature", "id": format!("{}-outline", x.id), "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": p}));
            }
        }
        json!({"type": "FeatureCollection", "features": feats, "count": feats.len()})
    }

    /// Environment features for a volume's cells (sources of all models).
    async fn add_env(fetch: &dyn Fetch, models: &[Arc<ModelRecord>], vc: &mut VolCells, realtime: bool) {
        let mut src = Sources::default();
        for m in models {
            src = src.union(&m.feature_schema.sources);
        }
        let src = src.normalized();
        if !src.is_empty() && !vc.cells.is_empty() {
            let pts: Vec<(f64, f64)> = vc.cells.iter().map(|c| (c.lat, c.lon)).collect();
            if let Ok(env) = fetch.env(&src, vc.t, &pts, realtime).await {
                for (c, e) in vc.cells.iter_mut().zip(env) {
                    c.feats.0.extend(e.0);
                }
            }
        }
    }

    fn next_id(&self, now: i64) -> String {
        let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("d{}-{n}", super::model::radix36(now as u64))
    }

    /// Consecutive-hit counter for persistence; returns the count after this hit.
    fn hit(&self, model: &str, key: &str, now: i64) -> u32 {
        let mut g = self.streak.lock();
        let e = g.entry((model.to_string(), key.to_string())).or_insert((0, now));
        // a gap of more than 20 min breaks the streak
        e.0 = if now - e.1 > 20 * 60_000 && e.0 > 0 { 1 } else { e.0 + 1 };
        e.1 = now;
        e.0
    }

    fn score_cells(&self, vc: &VolCells, models: &[Arc<ModelRecord>], track: bool) -> Vec<Detection> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut out = vec![];
        // ensemble groups: (target, mode) → per cell probabilities
        let mut ens: HashMap<(String, String), Vec<Vec<f64>>> = HashMap::new();
        let mut thr_sum: HashMap<(String, String), (f64, usize)> = HashMap::new();
        for m in models {
            let o = self.opts(&m.id);
            let levels = o.levels(m);
            let mut mine = vec![];
            let mut probs = vec![];
            for c in &vc.cells {
                let (p, top) = m.score(&c.feats, 5);
                probs.push(p);
                let pers = o.persistence.filter(|n| *n > 1).is_some() && track;
                let Some(level) = levels.level(p).filter(|_| o.gate_ok(p)) else {
                    if pers {
                        self.streak.lock().remove(&(m.id.clone(), format!("{}:{}", vc.site, c.id)));
                    }
                    continue;
                };
                if o.min_cell_dbz.map(|x| (c.feats.get("ref_max") as f64) < x).unwrap_or(false)
                    || o.max_range_km.map(|x| (c.feats.get("range_km") as f64) > x).unwrap_or(false)
                    || o.min_area_km2.map(|x| (c.feats.get("area_km2") as f64) < x).unwrap_or(false)
                    || o.region.as_ref().map(|r| !r.contains(c.lat, c.lon, "")).unwrap_or(false)
                {
                    continue;
                }
                if let Some(n) = o.persistence.filter(|n| *n > 1) {
                    if track && self.hit(&m.id, &format!("{}:{}", vc.site, c.id), now) < n {
                        continue;
                    }
                }
                mine.push(Detection {
                    id: self.next_id(now),
                    model_id: m.id.clone(),
                    model_name: m.name.clone(),
                    target: m.target.clone(),
                    prob: p,
                    level,
                    site: Some(vc.site.clone()),
                    t: vc.t,
                    created: now,
                    cell_id: Some(c.id.clone()),
                    lat: c.lat,
                    lon: c.lon,
                    top_features: top,
                    motion: c.motion.map(|(d, kt)| json!({"dir": (d * 10.0).round() / 10.0, "kt": (kt * 10.0).round() / 10.0})),
                    outline: c.hull.clone(),
                    kind: "cell",
                    valid_from: None,
                    valid_to: None,
                    rings: vec![],
                    value: None,
                });
            }
            if let Some(k) = o.max_detections {
                mine.sort_by(|a, b| b.prob.partial_cmp(&a.prob).unwrap_or(std::cmp::Ordering::Equal));
                mine.truncate(k);
            }
            out.extend(mine);
            if let Some(mode) = &o.ensemble {
                let key = (m.target.clone(), mode.clone());
                ens.entry(key.clone()).or_default().push(probs);
                let e = thr_sum.entry(key).or_insert((0.0, 0));
                e.0 += levels.med;
                e.1 += 1;
            }
        }
        for ((target, mode), members) in ens {
            if members.len() < 2 {
                continue;
            }
            let (ts, tn) = thr_sum[&(target.clone(), mode.clone())];
            let levels = Levels::from_threshold(ts / tn as f64);
            for (i, c) in vc.cells.iter().enumerate() {
                let ps: Vec<f64> = members.iter().map(|v| v[i]).collect();
                let p = if mode == "max" { ps.iter().copied().fold(0.0, f64::max) } else { ps.iter().sum::<f64>() / ps.len() as f64 };
                let Some(level) = levels.level(p) else { continue };
                out.push(Detection {
                    id: self.next_id(now),
                    model_id: format!("ensemble:{target}:{mode}"),
                    model_name: format!("Ensemble ({mode}) · {target}"),
                    target: target.clone(),
                    prob: p,
                    level,
                    site: Some(vc.site.clone()),
                    t: vc.t,
                    created: now,
                    cell_id: Some(c.id.clone()),
                    lat: c.lat,
                    lon: c.lon,
                    top_features: vec![],
                    motion: None,
                    outline: c.hull.clone(),
                    kind: "cell",
                    valid_from: None,
                    valid_to: None,
                    rings: vec![],
                    value: None,
                });
            }
        }
        out
    }

    /// Score one specific volume (e.g. a historical archive key); no tracking state is touched.
    pub async fn process_key(&self, fetch: &dyn Fetch, key: &str, models: &[Arc<ModelRecord>]) -> anyhow::Result<Vec<Detection>> {
        let t0 = std::time::Instant::now();
        let vol = fetch.volume(key).await?;
        let k = key.to_string();
        let cp = models.first().and_then(|m| serde_json::from_value::<CellParams>(m.spec.get("cell").cloned().unwrap_or(Value::Null)).ok()).unwrap_or_default();
        let mut vc = tokio::task::spawn_blocking(move || cells::extract(&vol, &k, &cp)).await?;
        Self::add_env(fetch, models, &mut vc, false).await;
        let out = self.score_cells(&vc, models, false);
        self.per_radar.write().insert(vc.site.clone(), RadarStat { t: Some(vc.t), cells: vc.cells.len(), ms: t0.elapsed().as_millis() as u64, error: None, key: Some(key.to_string()), detections: out.len(), checked: chrono::Utc::now().timestamp_millis() });
        Ok(out)
    }

    pub fn push_all(&self, d: Vec<Detection>) {
        self.push(None, d);
    }

    /// Process one site's newest volume with the radar models. Returns new detections.
    pub async fn process_site(&self, fetch: &dyn Fetch, site: &str, models: &[Arc<ModelRecord>], force: bool) -> Vec<Detection> {
        let t0 = std::time::Instant::now();
        let now = chrono::Utc::now().timestamp_millis();
        let mut stat = RadarStat { checked: now, ..self.per_radar.read().get(site).cloned().unwrap_or_default() };
        let res: anyhow::Result<Option<Vec<Detection>>> = async {
            let Some(e) = fetch.latest(site).await? else { anyhow::bail!("no volumes") };
            if !force && self.last_key.lock().get(site) == Some(&e.key) {
                return Ok(None);
            }
            if !force && now - e.time > 30 * 60_000 {
                self.last_key.lock().insert(site.to_string(), e.key.clone());
                anyhow::bail!("newest volume is {} min old", (now - e.time) / 60_000);
            }
            let vol = fetch.volume(&e.key).await?;
            let key = e.key.clone();
            let cp = models.first().and_then(|m| serde_json::from_value::<CellParams>(m.spec.get("cell").cloned().unwrap_or(Value::Null)).ok()).unwrap_or_default();
            let mut vc = tokio::task::spawn_blocking(move || cells::extract(&vol, &key, &cp)).await?;
            let prev = self.prev.lock().get(site).cloned();
            let matched = match &prev {
                Some(p) => cells::apply_trends(&mut vc, p),
                None => vec![None; vc.cells.len()],
            };
            // keep track ids across volumes
            if let Some(p) = &prev {
                for (c, m) in vc.cells.iter_mut().zip(&matched) {
                    if let Some(j) = m {
                        c.id = p.cells[*j].id.clone();
                    }
                }
            }
            Self::add_env(fetch, models, &mut vc, true).await;
            let out = self.score_cells(&vc, models, true);
            stat.cells = vc.cells.len();
            stat.t = Some(vc.t);
            stat.key = Some(e.key.clone());
            self.last_key.lock().insert(site.to_string(), e.key);
            self.prev.lock().insert(site.to_string(), vc);
            Ok(Some(out))
        }
        .await;
        let out = match res {
            Ok(Some(d)) => {
                stat.error = None;
                stat.ms = t0.elapsed().as_millis() as u64;
                stat.detections = d.len();
                d
            }
            Ok(None) => vec![],
            Err(e) => {
                stat.error = Some(format!("{e:#}"));
                vec![]
            }
        };
        self.per_radar.write().insert(site.to_string(), stat);
        out
    }

    /// Run a legacy grid-point detection model over its region (newest gridded data).
    pub async fn process_grid(&self, fetch: &dyn Fetch, m: &ModelRecord, t: i64) -> anyhow::Result<Vec<Detection>> {
        let o = self.opts(&m.id);
        let region: super::labels::Region = o.region.clone().unwrap_or_else(|| serde_json::from_value(m.spec.get("region").cloned().unwrap_or(Value::Null)).unwrap_or_default());
        let grid: super::spec::GridOpts = serde_json::from_value(m.spec.get("grid").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        let [w, s, e, n] = region.bbox();
        let step = o.grid_res_deg.unwrap_or(grid.run_spacing_deg).clamp(0.05, 5.0);
        let mut pts = vec![];
        let mut lat = s;
        while lat <= n && pts.len() < 60_000 {
            let mut lon = w;
            while lon <= e && pts.len() < 60_000 {
                if region.contains(lat, lon, "") {
                    pts.push((lat, lon));
                }
                lon += step;
            }
            lat += step;
        }
        let env = fetch.env(&m.feature_schema.sources, t, &pts, true).await?;
        let levels = o.levels(m);
        let mut cand: Vec<(f64, usize, Vec<super::model::Contribution>)> = vec![];
        for (i, (p, mut fm)) in pts.iter().zip(env).enumerate() {
            fm.set("lat", p.0 as f32);
            fm.set("lon", p.1 as f32);
            fm.set("doy", day_of_year(t));
            fm.set("solar_hour", solar_hour(t, p.1));
            super::features::set_context(&mut fm, p.0, p.1, t);
            let (pr, top) = m.score(&fm, 5);
            if pr >= levels.low && o.gate_ok(pr) {
                cand.push((pr, i, top));
            }
        }
        // keep local maxima (no stronger point within 2 grid steps)
        cand.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let mut kept: Vec<(f64, usize, Vec<super::model::Contribution>)> = vec![];
        let cap = o.max_detections.unwrap_or(200);
        for c in cand {
            let (la, lo) = pts[c.1];
            if kept.iter().any(|k| (pts[k.1].0 - la).abs() <= 2.0 * step && (pts[k.1].1 - lo).abs() <= 2.0 * step) {
                continue;
            }
            kept.push(c);
            if kept.len() >= cap {
                break;
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        Ok(kept
            .into_iter()
            .map(|(p, i, top)| Detection {
                id: self.next_id(now),
                model_id: m.id.clone(),
                model_name: m.name.clone(),
                target: m.target.clone(),
                prob: p,
                level: levels.level(p).unwrap_or("low"),
                site: None,
                t,
                created: now,
                cell_id: None,
                lat: pts[i].0,
                lon: pts[i].1,
                top_features: top,
                motion: None,
                outline: vec![],
                kind: "point",
                valid_from: None,
                valid_to: None,
                rings: vec![],
                value: None,
            })
            .collect())
    }

    /// Run a grid / outlook model: prediction grid → layers (published when a sink is set),
    /// area detections, outlook polygons.
    pub async fn process_grid_v2(&self, fetch: &dyn Fetch, m: &ModelRecord, o: &ModelRun, t: i64, realtime: bool, publish: bool) -> anyhow::Result<GridRunOut> {
        let is_outlook = m.output() == "outlook";
        let po = PredictOpts {
            res_deg: o.grid_res_deg,
            region: o.region.clone(),
            smoothing_km: o.smoothing_km.unwrap_or(if is_outlook { 40.0 } else { 0.0 }),
            leads: o.leads.clone(),
            window: o.window(),
            day: o.day.clone(),
            max_points: self.max_points.load(std::sync::atomic::Ordering::Relaxed),
        };
        let mut pred = predict::predict_grid(fetch, m, &po, t, realtime).await?;
        let reg = m.is_regression();
        for f in pred.frames.iter_mut() {
            if reg {
                predict::gate(&mut f.values, o.min_value.unwrap_or(f64::NEG_INFINITY), o.max_value.unwrap_or(f64::INFINITY));
            } else {
                predict::gate(&mut f.values, o.min_prob.unwrap_or(0.0), o.max_prob.unwrap_or(1.0));
            }
        }
        let geom = pred.geom;
        let (field, units, cmap) = super::spec::output_field(&m.target, &m.task);
        let lid = format!("mlpred/{}", m.id);
        let step_min = if pred.frames.len() > 1 { (((pred.frames[1].lead.valid - pred.frames[0].lead.valid).abs() / 60_000).max(1)) as u32 } else { 60 };
        let mut layers = vec![];
        let sink = if publish { self.sink.read().clone() } else { None };
        let valid_times: Vec<i64> = pred.frames.iter().map(|f| f.lead.valid).collect();
        let grids: Vec<crate::grid::Grid> = pred.frames.iter().map(|f| predict::to_grid(&geom, &f.values, !reg, f.lead.valid, pred.issue)).collect();
        if let Some(s) = &sink {
            s.publish(&lid, &m.name, units, cmap, step_min, pred.issue, grids);
        }
        layers.push(LayerInfo { model_id: m.id.clone(), layer_id: lid.clone(), name: m.name.clone(), kind: if is_outlook { "outlook".into() } else { "grid".into() }, field: field.into(), units: units.into(), cmap: cmap.into(), run: pred.issue, valid_times: valid_times.clone() });
        if reg && o.quantiles.unwrap_or(true) {
            for (qi, ql) in m.quantiles.iter().enumerate() {
                let qid = format!("{lid}/p{:02}", (ql.q * 100.0).round() as i64);
                if let Some(s) = &sink {
                    let qg: Vec<crate::grid::Grid> = pred.frames.iter().map(|f| predict::to_grid(&geom, &f.quantiles[qi].1, false, f.lead.valid, pred.issue)).collect();
                    s.publish(&qid, &format!("{} (P{:.0})", m.name, ql.q * 100.0), units, cmap, step_min, pred.issue, qg);
                }
                layers.push(LayerInfo { model_id: m.id.clone(), layer_id: qid, name: format!("{} (P{:.0})", m.name, ql.q * 100.0), kind: "grid".into(), field: format!("{field}_p{:.0}", ql.q * 100.0), units: units.into(), cmap: cmap.into(), run: pred.issue, valid_times: valid_times.clone() });
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        let mut dets = vec![];
        let mut outlook = None;
        if is_outlook {
            let f = &pred.frames[0];
            let tp = super::gridds::TParams::of(&predict::model_spec(m));
            let hazard = tp.hazard.clone();
            let day = o.day.clone().unwrap_or_else(|| if o.window().is_some() { "custom".into() } else { tp.day.clone() });
            let levels = o.outlook_levels.clone().unwrap_or_else(|| predict::default_levels(&hazard));
            let vals = f.values.clone();
            let (w0, w1, mid) = (f.lead.w0, f.lead.w1, m.id.clone());
            let mut gj = tokio::task::spawn_blocking(move || predict::outlook_geojson(&geom, &vals, &levels, &hazard, &day, w0, w1, &mid)).await?;
            gj["model_id"] = json!(m.id);
            gj["model_name"] = json!(m.name);
            gj["prob_layer"] = json!(lid);
            gj["issued"] = json!(pred.issue);
            gj["valid_from"] = json!(f.lead.w0);
            gj["valid_to"] = json!(f.lead.w1);
            gj["hazard"] = json!(tp.hazard);
            gj["day"] = json!(o.day.clone().unwrap_or(tp.day.clone()));
            gj["levels"] = json!(o.outlook_levels.clone().unwrap_or_else(|| predict::default_levels(&tp.hazard)));
            outlook = Some(gj);
        } else if !reg || m.target == "storm_forecast" {
            // area detections where the probability (or value) exceeds the threshold
            let levels = o.levels(m);
            let thr = if reg { o.threshold.unwrap_or(m.threshold) } else { o.threshold.unwrap_or(levels.med) };
            let mut areas: Vec<Detection> = vec![];
            for f in &pred.frames {
                let vals = f.values.clone();
                let polys = tokio::task::spawn_blocking(move || predict::polygons(&geom, &vals, thr as f32)).await?;
                for rings in polys {
                    let outer = &rings[0];
                    if let Some(min) = o.min_area_km2 {
                        if predict::ring_area_km2(outer) < min {
                            continue;
                        }
                    }
                    let p = predict::max_inside(&geom, &f.values, outer) as f64;
                    if !p.is_finite() {
                        continue;
                    }
                    let (cx, cy) = outer.iter().fold((0.0, 0.0), |a, q| (a.0 + q[0], a.1 + q[1]));
                    let nn = outer.len().max(1) as f64;
                    let prob = if reg { 1.0 } else { p };
                    areas.push(Detection {
                        id: self.next_id(now),
                        model_id: m.id.clone(),
                        model_name: m.name.clone(),
                        target: m.target.clone(),
                        prob,
                        level: if reg { "high" } else { levels.level(p).unwrap_or("low") },
                        site: None,
                        t: pred.issue,
                        created: now,
                        cell_id: None,
                        lat: cy / nn,
                        lon: cx / nn,
                        top_features: vec![],
                        motion: None,
                        outline: outer.iter().map(|q| [q[0] as f32, q[1] as f32]).collect(),
                        kind: "area",
                        valid_from: Some(f.lead.w0),
                        valid_to: Some(f.lead.w1),
                        rings: rings.clone(),
                        value: reg.then_some(p),
                    });
                }
            }
            // persistence: the area must overlap areas of the previous N−1 runs
            if let Some(n) = o.persistence.filter(|n| *n > 1) {
                let mut h = self.area_hist.lock();
                let hist = h.entry(m.id.clone()).or_default();
                let keep: Vec<bool> = areas
                    .iter()
                    .map(|a| {
                        hist.len() + 1 >= n as usize
                            && hist.iter().rev().take(n as usize - 1).all(|prev| prev.iter().any(|r| {
                                let poly: Vec<[f32; 2]> = r.iter().map(|q| [q[0] as f32, q[1] as f32]).collect();
                                super::labels::point_in_poly(a.lat, a.lon, &poly)
                            }))
                    })
                    .collect();
                hist.push_back(areas.iter().map(|a| a.rings[0].clone()).collect());
                while hist.len() > 10 {
                    hist.pop_front();
                }
                let mut k = 0;
                areas.retain(|_| {
                    k += 1;
                    keep[k - 1]
                });
            }
            if let Some(r) = &o.region {
                areas.retain(|a| r.contains(a.lat, a.lon, ""));
            }
            areas.sort_by(|a, b| b.prob.partial_cmp(&a.prob).unwrap_or(std::cmp::Ordering::Equal));
            areas.truncate(o.max_detections.unwrap_or(200));
            dets = areas;
        }
        Ok(GridRunOut { detections: dets, layers, outlook, pred: Arc::new(pred) })
    }

    fn set_state(&self, id: &str, f: impl FnOnce(&mut ModelState)) {
        let mut g = self.model_state.write();
        f(g.entry(id.to_string()).or_default());
    }

    /// Run a grid / outlook model now and record its state, layers and outlook.
    pub async fn run_grid_model(&self, fetch: &dyn Fetch, m: &ModelRecord, o: &ModelRun, t: i64, hub: Option<&crate::hub::Hub>) -> anyhow::Result<GridRunOut> {
        let t0 = std::time::Instant::now();
        let now = chrono::Utc::now().timestamp_millis();
        self.set_state(&m.id, |s| {
            s.state = "running".into();
            s.last_run = Some(now);
        });
        let realtime = now - t < 2 * 3_600_000;
        match self.process_grid_v2(fetch, m, o, t, realtime, true).await {
            Ok(out) => {
                let n = out.detections.len();
                if let Some(gj) = &out.outlook {
                    let key = format!("{}|{}", m.id, gj["valid_from"].as_i64().unwrap_or(0));
                    let mut g = self.outlooks.write();
                    g.insert(key, gj.clone());
                    // keep at most 8 outlooks per model
                    let mut mine: Vec<String> = g.keys().filter(|k| k.starts_with(&format!("{}|", m.id))).cloned().collect();
                    mine.sort();
                    while mine.len() > 8 {
                        g.remove(&mine.remove(0));
                    }
                }
                self.set_state(&m.id, |s| {
                    s.state = "ok".into();
                    s.last_ok = Some(now);
                    s.error = None;
                    s.ms = t0.elapsed().as_millis() as u64;
                    s.detections = n;
                    s.valid_times = out.layers.first().map(|l| l.valid_times.clone()).unwrap_or_default();
                    s.layers = out.layers.clone();
                    s.warnings = out.pred.warnings.clone();
                });
                if let Some(h) = hub {
                    for l in &out.layers {
                        h.send(json!({"type": "ml_layer", "model_id": l.model_id, "layer_id": l.layer_id, "kind": l.kind, "valid_times": l.valid_times, "run": l.run}));
                    }
                }
                Ok(out)
            }
            Err(e) => {
                self.set_state(&m.id, |s| {
                    s.state = "error".into();
                    s.error = Some(format!("{e:#}"));
                    s.ms = t0.elapsed().as_millis() as u64;
                });
                Err(e)
            }
        }
    }

    /// Combine same-target grid outputs whose ensemble mode matches into `mlpred/ensemble/…`.
    fn publish_ensembles(&self, runs: &[(Arc<ModelRecord>, ModelRun, Arc<PredGrid>)]) {
        let Some(sink) = self.sink.read().clone() else { return };
        let mut groups: HashMap<(String, String), Vec<&(Arc<ModelRecord>, ModelRun, Arc<PredGrid>)>> = HashMap::new();
        for r in runs {
            if let Some(mode) = &r.1.ensemble {
                groups.entry((r.0.target.clone(), mode.clone())).or_default().push(r);
            }
        }
        for ((target, mode), members) in groups {
            if members.len() < 2 {
                continue;
            }
            let g0 = &members[0].2;
            if members.iter().any(|m| m.2.geom != g0.geom || m.2.frames.len() != g0.frames.len() || m.0.task != members[0].0.task) {
                tracing::info!("ml ensemble {target}/{mode}: members differ in grid or leads; skipped");
                continue;
            }
            let reg = members[0].0.is_regression();
            let (_, units, cmap) = super::spec::output_field(&target, &members[0].0.task);
            let frames: Vec<crate::grid::Grid> = (0..g0.frames.len())
                .map(|fi| {
                    let n = g0.frames[fi].values.len();
                    let vals: Vec<f32> = (0..n)
                        .map(|i| {
                            let xs: Vec<f32> = members.iter().map(|m| m.2.frames[fi].values[i]).filter(|v| v.is_finite()).collect();
                            if xs.is_empty() {
                                f32::NAN
                            } else if mode == "max" {
                                xs.iter().copied().fold(f32::MIN, f32::max)
                            } else {
                                xs.iter().sum::<f32>() / xs.len() as f32
                            }
                        })
                        .collect();
                    predict::to_grid(&g0.geom, &vals, !reg, g0.frames[fi].lead.valid, g0.issue)
                })
                .collect();
            let id = format!("mlpred/ensemble/{target}");
            sink.publish(&id, &format!("Ensemble ({mode}) · {target}"), units, cmap, 60, g0.issue, frames);
            for m in &members {
                self.set_state(&m.0.id, |s| {
                    if !s.layers.iter().any(|l| l.layer_id == id) {
                        s.layers.push(LayerInfo { model_id: format!("ensemble:{target}:{mode}"), layer_id: id.clone(), name: format!("Ensemble ({mode}) · {target}"), kind: "grid".into(), field: "ensemble".into(), units: units.into(), cmap: cmap.into(), run: g0.issue, valid_times: g0.frames.iter().map(|f| f.lead.valid).collect() });
                    }
                });
            }
        }
    }

    fn due(&self, id: &str, every_ms: i64, now: i64) -> bool {
        let last = self.model_last.lock().get(id).copied().unwrap_or(0);
        if now - last < every_ms {
            self.set_state(id, |s| s.next_run = Some(last + every_ms));
            return false;
        }
        self.model_last.lock().insert(id.to_string(), now);
        self.set_state(id, |s| s.next_run = Some(now + every_ms));
        true
    }

    /// One pass over every selected radar and due grid model.
    pub async fn cycle(&self, fetch: &dyn Fetch, store: &Store, hub: Option<&crate::hub::Hub>) {
        let cfg = self.cfg.read().clone();
        let now = chrono::Utc::now().timestamp_millis();
        self.prune(now);
        let models: Vec<(Arc<ModelRecord>, ModelRun)> = cfg.models.iter().filter_map(|o| store.get(&o.id).map(|m| (m, o.clone()))).collect();
        // radar models (respecting their cadence)
        let radar_models: Vec<Arc<ModelRecord>> = models
            .iter()
            .filter(|(m, _)| m.candidate == "radar_cell")
            .filter(|(m, o)| match o.cadence_min {
                Some(c) if c > 0 => self.due(&m.id, c as i64 * 60_000, now),
                _ => true,
            })
            .map(|(m, _)| m.clone())
            .collect();
        if !radar_models.is_empty() {
            let sites = resolve_sites(&cfg.radars, &fetch.sites());
            let sem = self.concurrency.sem.clone();
            let rm = &radar_models;
            let res: Vec<Vec<Detection>> = futures::stream::iter(sites)
                .map(|site| {
                    let sem = sem.clone();
                    async move {
                        let _p = sem.acquire_owned().await;
                        if !self.cfg.read().enabled {
                            return vec![];
                        }
                        self.process_site(fetch, &site, rm, false).await
                    }
                })
                .buffer_unordered(32)
                .collect()
                .await;
            let mut counts: HashMap<String, usize> = HashMap::new();
            for d in res {
                for x in &d {
                    *counts.entry(x.model_id.clone()).or_default() += 1;
                }
                self.push(hub, d);
            }
            for m in &radar_models {
                let n = counts.get(&m.id).copied().unwrap_or(0);
                self.set_state(&m.id, |s| {
                    s.state = "ok".into();
                    s.last_run = Some(now);
                    s.last_ok = Some(now);
                    s.detections = n;
                });
            }
        }
        let mut grid_runs: Vec<(Arc<ModelRecord>, ModelRun, Arc<PredGrid>)> = vec![];
        for (m, o) in models.iter().filter(|(m, _)| m.candidate == "grid_point") {
            let default_every = m.spec.get("grid").and_then(|g| g.get("run_every_min")).and_then(|v| v.as_u64()).unwrap_or(360);
            let every = o.cadence_min.unwrap_or(default_every).max(1) as i64 * 60_000;
            if !self.due(&m.id, every, now) {
                continue;
            }
            if m.output() == "detections" {
                match self.process_grid(fetch, m, now).await {
                    Ok(d) => {
                        let n = d.len();
                        self.push(hub, d);
                        self.set_state(&m.id, |s| {
                            s.state = "ok".into();
                            s.last_run = Some(now);
                            s.last_ok = Some(now);
                            s.detections = n;
                            s.error = None;
                        });
                    }
                    Err(e) => {
                        self.per_radar.write().insert(format!("grid:{}", m.id), RadarStat { checked: now, error: Some(format!("{e:#}")), ..Default::default() });
                        self.set_state(&m.id, |s| {
                            s.state = "error".into();
                            s.last_run = Some(now);
                            s.error = Some(format!("{e:#}"));
                        });
                    }
                }
                continue;
            }
            match self.run_grid_model(fetch, m, o, now, hub).await {
                Ok(out) => {
                    self.push(hub, out.detections);
                    grid_runs.push((m.clone(), o.clone(), out.pred));
                }
                Err(e) => tracing::info!("ml grid model {}: {e:#}", m.id),
            }
        }
        if grid_runs.len() >= 2 {
            self.publish_ensembles(&grid_runs);
        }
        *self.last_cycle.lock() = Some(now);
    }

    /// Background loop (runs while enabled; wakes on configuration changes).
    pub async fn run_loop(self: Arc<Self>, fetch: Arc<dyn Fetch>, store: Arc<Store>, hub: crate::hub::Hub) {
        loop {
            let (enabled, iv) = {
                let c = self.cfg.read();
                (c.enabled && !c.models.is_empty(), c.interval_s.clamp(15, 3600))
            };
            if !enabled {
                self.wake.notified().await;
                continue;
            }
            self.cycle(fetch.as_ref(), &store, Some(&hub)).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(iv)) => {}
                _ = self.wake.notified() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_selection() {
        let mk = |id: &str, kind: &str, lat: f64, lon: f64, st: &str| crate::sites::Site { id: id.into(), name: String::new(), state: st.into(), lat, lon, elev_m: 0.0, kind: kind.into(), country: None, region: None, format: None, source: None };
        let sites = vec![mk("KTLX", "NEXRAD", 35.33, -97.28, ""), mk("TOKC", "TDWR", 35.28, -97.51, "OK"), mk("KLOT", "NEXRAD", 41.6, -88.08, "IL"), mk("deess", "ODIM", 51.4, 6.9, "")];
        assert_eq!(resolve_sites(&json!("all"), &sites), vec!["KLOT", "KTLX", "TOKC"]);
        assert_eq!(resolve_sites(&json!("tdwr"), &sites), vec!["TOKC"]);
        assert_eq!(resolve_sites(&json!("nexrad"), &sites), vec!["KLOT", "KTLX"]);
        assert_eq!(resolve_sites(&json!(["ktlx", "nope"]), &sites), vec!["KTLX"]);
        // KTLX has no state in the table: matched by the state's box
        assert_eq!(resolve_sites(&json!({"states": ["ok"]}), &sites), vec!["KTLX", "TOKC"]);
        assert_eq!(resolve_sites(&json!({"bbox": [-90.0, 40.0, -87.0, 42.0]}), &sites), vec!["KLOT"]);
    }

    #[test]
    fn run_config_parsing() {
        // plain ids and option objects; old runner.json files still load
        let c: RunCfg = serde_json::from_value(json!({"models": ["m1", {"id": "m2", "min_prob": 0.3, "day": 2, "leads": [1, 3]}], "enabled": true})).unwrap();
        assert_eq!(c.ids(), vec!["m1", "m2"]);
        assert_eq!(c.models[1].day.as_deref(), Some("2"));
        assert_eq!(c.models[1].min_prob, Some(0.3));
        assert!(ModelRun::parse(&json!({"id": "x", "min_prob": 2.0})).is_err());
        assert!(ModelRun::parse(&json!({"id": "x", "ensemble": "median"})).is_err());
        assert!(ModelRun::parse(&json!({"id": "x", "day": "4-7"})).is_ok());
        assert_eq!(ModelRun::parse(&json!({"id": "x", "ensemble": true})).unwrap().ensemble.as_deref(), Some("mean"));
        let r = Runner::new(None, 1);
        r.set_cfg(c.clone());
        let st = r.status(&[]);
        assert_eq!(st["models"][0], "m1");
        assert_eq!(st["models"][1]["id"], "m2");
        assert_eq!(st["model_ids"], json!(["m1", "m2"]));
        assert_eq!(st["model_opts"]["m2"]["min_prob"], 0.3);
        assert_eq!(st["models_state"]["m1"]["state"], "waiting");
        let back = serde_json::to_value(&c).unwrap();
        assert_eq!(back["models"][0], json!({"id": "m1"}));
    }

    #[test]
    fn detection_json() {
        let d = Detection { id: "d1".into(), model_id: "m".into(), model_name: "M".into(), target: "tornado".into(), prob: 0.8123, level: "high", site: Some("KTLX".into()), t: 1, created: 2, cell_id: Some("c".into()), lat: 35.0, lon: -97.0, top_features: vec![], motion: Some(json!({"dir": 45.0, "kt": 30.0})), outline: vec![[-97.0, 35.0], [-96.9, 35.0], [-96.9, 35.1]], kind: "cell", valid_from: None, valid_to: None, rings: vec![], value: None };
        let w = d.ws();
        assert_eq!(w["type"], "ml_detection");
        assert_eq!(w["prob"], 0.812);
        let r = Runner::new(None, 1);
        r.push_all(vec![d]);
        let g = r.geojson(0, &["m".into()], Some([-98.0, 34.0, -96.0, 36.0]));
        assert_eq!(g["count"], 2);
        assert_eq!(g["features"][1]["geometry"]["type"], "Polygon");
        assert_eq!(g["features"][1]["geometry"]["coordinates"][0].as_array().unwrap().len(), 4);
        assert_eq!(r.geojson(3, &[], None)["count"], 0);
        assert_eq!(r.geojson(0, &["x".into()], None)["count"], 0);
        // area detections are polygons with kind "area" and their window
        let a = Detection { id: "a1".into(), model_id: "g".into(), model_name: "G".into(), target: "instability".into(), prob: 0.6, level: "med", site: None, t: 5, created: 6, cell_id: None, lat: 35.0, lon: -97.0, top_features: vec![], motion: None, outline: vec![], kind: "area", valid_from: Some(10), valid_to: Some(20), rings: vec![vec![[-97.5, 34.5], [-96.5, 34.5], [-96.5, 35.5], [-97.5, 34.5]]], value: None };
        r.push_all(vec![a]);
        let g = r.geojson(0, &["g".into()], None);
        assert_eq!(g["count"], 1);
        assert_eq!(g["features"][0]["properties"]["kind"], "area");
        assert_eq!(g["features"][0]["properties"]["valid_to"], 20);
        assert_eq!(g["features"][0]["properties"]["prob"], 0.6);
    }
}
