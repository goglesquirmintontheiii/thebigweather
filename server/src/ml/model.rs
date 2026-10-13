//! Trained models: the learner, calibration, schema and metadata; the on-disk store
//! (`data/ml/models/<id>/model.json`) and `.tbwmodel` export / import.

use super::core::sigmoid;
use super::features::{FeatMap, Schema};
use super::gbdt::Gbdt;
use super::linear::LogReg;
use super::mlp::Mlp;
use anyhow::{anyhow, bail, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// Model file format version (bump on incompatible changes). v2: regression learners, quantile
/// learners, history, `format` field (`version` became the training revision).
pub const FORMAT_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Learner {
    Gbdt(Gbdt),
    Logreg(LogReg),
    Mlp(Mlp),
}

impl Learner {
    pub fn margin(&self, x: &[f32]) -> f64 {
        match self {
            Learner::Gbdt(m) => m.margin(x),
            Learner::Logreg(m) => m.margin(x),
            Learner::Mlp(m) => m.margin(x),
        }
    }
    pub fn contributions(&self, x: &[f32]) -> (Vec<f64>, f64) {
        match self {
            Learner::Gbdt(m) => m.contributions(x),
            Learner::Logreg(m) => m.contributions(x),
            Learner::Mlp(m) => m.contributions(x),
        }
    }
    pub fn n_features(&self) -> Option<usize> {
        match self {
            Learner::Gbdt(m) => Some(m.importance.len()),
            Learner::Logreg(m) => Some(m.coef.len()),
            Learner::Mlp(m) => m.layers.first().map(|l| l.nin),
        }
    }
}

/// Platt scaling of the raw margin: p = σ(a·m + b).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Calib {
    pub a: f64,
    pub b: f64,
}

impl Default for Calib {
    fn default() -> Self {
        Calib { a: 1.0, b: 0.0 }
    }
}

impl Calib {
    /// Fit on (margin, label) pairs by Newton's method on log loss.
    pub fn fit(m: &[f64], y: &[f32]) -> Calib {
        let (mut a, mut b) = (1.0f64, 0.0f64);
        if m.len() < 20 || y.iter().all(|v| *v > 0.5) || y.iter().all(|v| *v <= 0.5) {
            return Calib::default();
        }
        // Platt's target smoothing
        let np = y.iter().filter(|v| **v > 0.5).count() as f64;
        let nn = y.len() as f64 - np;
        let (tp, tn) = ((np + 1.0) / (np + 2.0), 1.0 / (nn + 2.0));
        for _ in 0..50 {
            let (mut g1, mut g2, mut h11, mut h12, mut h22) = (0.0, 0.0, 1e-9, 0.0, 1e-9);
            for (mi, yi) in m.iter().zip(y) {
                let p = sigmoid(a * mi + b);
                let t = if *yi > 0.5 { tp } else { tn };
                let d = p - t;
                let w = (p * (1.0 - p)).max(1e-12);
                g1 += d * mi;
                g2 += d;
                h11 += w * mi * mi;
                h12 += w * mi;
                h22 += w;
            }
            let det = h11 * h22 - h12 * h12;
            if det.abs() < 1e-18 {
                break;
            }
            let da = (h22 * g1 - h12 * g2) / det;
            let db = (h11 * g2 - h12 * g1) / det;
            a -= da;
            b -= db;
            if da.abs() + db.abs() < 1e-9 {
                break;
            }
        }
        if !a.is_finite() || !b.is_finite() || a <= 0.0 {
            return Calib::default();
        }
        Calib { a, b }
    }
    pub fn apply(&self, margin: f64) -> f64 {
        sigmoid(self.a * margin + self.b)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Levels {
    pub low: f64,
    pub med: f64,
    pub high: f64,
}

impl Levels {
    pub fn from_threshold(t: f64) -> Levels {
        let t = t.clamp(0.01, 0.99);
        let r = |x: f64| (x * 1000.0).round() / 1000.0;
        Levels { low: r((t * 0.6).max(0.01)), med: r(t), high: r(t + (1.0 - t) * 0.5) }
    }
    pub fn level(&self, p: f64) -> Option<&'static str> {
        if p >= self.high {
            Some("high")
        } else if p >= self.med {
            Some("med")
        } else if p >= self.low {
            Some("low")
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Importance {
    pub id: String,
    pub name: String,
    pub gain: f64,
}

/// An extra quantile model (regression), e.g. q = 0.1 → P10.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuantLearner {
    pub q: f64,
    pub learner: Learner,
}

/// One training of a model (train / retrain / continue).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistEntry {
    pub version: u32,
    pub at: i64,
    /// train | retrain | continue | import
    pub kind: String,
    pub metrics_summary: Value,
    pub samples: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_model: Option<String>,
}

fn one() -> u32 {
    1
}

fn classification() -> String {
    "classification".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub target: String,
    pub candidate: String,
    pub created: i64,
    pub updated: i64,
    /// the training spec (as resolved)
    pub spec: Value,
    pub feature_schema: Schema,
    pub algo: String,
    pub params: Value,
    /// {holdout|cv: Metrics, train: {...}, dataset: {...}}
    pub metrics: Value,
    pub threshold: f64,
    pub levels: Levels,
    /// training revision (bumped by retrain / continue in replace mode)
    pub version: u32,
    /// file format (see [`FORMAT_VERSION`])
    #[serde(default = "one")]
    pub format: u32,
    /// classification | regression
    #[serde(default = "classification")]
    pub task: String,
    /// detections | grid | outlook ("" = the target's)
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub history: Vec<HistEntry>,
    /// regression: extra quantile learners (P10 / P90 …)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quantiles: Vec<QuantLearner>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub importance: Vec<Importance>,
    pub calib: Calib,
    pub learner: Learner,
    /// where it was trained / imported from
    #[serde(default)]
    pub origin: String,
    /// job that produced it
    #[serde(default)]
    pub job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Contribution {
    pub id: String,
    /// feature value (null = missing)
    pub value: Option<f64>,
    /// change of the calibrated log-odds attributed to this feature
    pub contribution: f64,
}

impl ModelRecord {
    pub fn ids(&self) -> Vec<String> {
        self.feature_schema.ids()
    }
    pub fn is_regression(&self) -> bool {
        self.task == "regression"
    }
    /// detections | grid | outlook
    pub fn output(&self) -> &str {
        if !self.output.is_empty() {
            return &self.output;
        }
        super::spec::target(&self.target).map(|t| t.output).unwrap_or("detections")
    }
    /// Grid-layer id of a grid / outlook model's output.
    pub fn layer_id(&self) -> Option<String> {
        (self.output() != "detections").then(|| format!("mlpred/{}", self.id))
    }
    /// Calibrated probability (classification) or predicted value (regression) and the top `k`
    /// feature contributions (by |margin change|).
    pub fn score(&self, fm: &FeatMap, k: usize) -> (f64, Vec<Contribution>) {
        let ids = self.ids();
        let x = fm.vector(&ids);
        let (c, bias) = self.learner.contributions(&x);
        let margin = bias + c.iter().sum::<f64>();
        let reg = self.is_regression();
        let p = if reg { margin } else { self.calib.apply(margin) };
        let a = if reg { 1.0 } else { self.calib.a };
        let mut top: Vec<Contribution> = c
            .iter()
            .enumerate()
            .map(|(i, v)| Contribution { id: ids[i].clone(), value: x[i].is_finite().then(|| (x[i] as f64 * 100.0).round() / 100.0), contribution: (v * a * 1000.0).round() / 1000.0 })
            .collect();
        top.sort_by(|a, b| b.contribution.abs().partial_cmp(&a.contribution.abs()).unwrap_or(std::cmp::Ordering::Equal));
        top.truncate(k);
        (p, top)
    }
    /// Probability (classification) or value (regression) of a feature vector in schema order.
    pub fn prob(&self, x: &[f32]) -> f64 {
        let m = self.learner.margin(x);
        if self.is_regression() { m } else { self.calib.apply(m) }
    }
    /// Short metrics for lists / history.
    pub fn metrics_summary(&self) -> Value {
        let m = self.metrics.get("eval").cloned().unwrap_or(json!({}));
        if self.is_regression() {
            json!({"mae": m["mae"], "rmse": m["rmse"], "bias": m["bias"], "r2": m["r2"], "skill": m["skill"], "skill_clim": m["skill_clim"], "skill_persistence": m["skill_persistence"], "n": m["n"]})
        } else {
            json!({"roc_auc": m["roc_auc"], "pr_auc": m["pr_auc"], "csi": m["csi"], "pod": m["pod"], "far": m["far"], "brier": m["brier"], "n": m["n"], "positives": m["positives"]})
        }
    }
    /// List entry (no learner / spec / reliability).
    pub fn summary(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "labels": self.labels, "target": self.target, "candidate": self.candidate,
            "task": self.task, "output": self.output(), "layer_id": self.layer_id(),
            "created": self.created, "updated": self.updated, "algo": self.algo, "threshold": self.threshold, "levels": self.levels,
            "version": self.version, "notes": self.notes, "origin": self.origin, "n_features": self.feature_schema.features.len(),
            "metrics": self.metrics_summary(),
            "samples": self.metrics.get("dataset").and_then(|d| d.get("samples")).cloned().unwrap_or(Value::Null),
            "history_len": self.history.len(),
            "history": self.history,
            "quantiles": self.quantiles.iter().map(|q| q.q).collect::<Vec<_>>(),
            "retrainable": self.spec.get("target").is_some(),
        })
    }
    /// Full JSON for `GET /api/ml/models/{id}` (learner omitted).
    pub fn detail(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        if let Some(o) = v.as_object_mut() {
            o.remove("learner");
            o.remove("quantiles");
            o.insert("quantile_levels".into(), json!(self.quantiles.iter().map(|q| q.q).collect::<Vec<_>>()));
            o.insert("output".into(), json!(self.output()));
            o.insert("layer_id".into(), json!(self.layer_id()));
            o.insert("learner_info".into(), match &self.learner {
                Learner::Gbdt(g) => json!({"type": "gbdt", "trees": g.trees.len(), "nodes": g.trees.iter().map(|t| t.nodes.len()).sum::<usize>()}),
                Learner::Logreg(l) => json!({"type": "logreg", "coef": self.ids().iter().zip(&l.coef).map(|(i, c)| json!({"id": i, "coef": c})).collect::<Vec<_>>(), "intercept": l.intercept}),
                Learner::Mlp(m) => json!({"type": "mlp", "layers": m.layers.iter().map(|l| l.nout).collect::<Vec<_>>()}),
            });
        }
        v
    }
    pub fn validate(&self) -> Result<()> {
        if self.format > FORMAT_VERSION {
            bail!("model format v{} is newer than this server supports (v{FORMAT_VERSION}); update the server", self.format);
        }
        if !matches!(self.task.as_str(), "classification" | "regression") {
            bail!("unknown task {}", self.task);
        }
        let cur = super::features::candidate_version(&self.candidate);
        if !matches!(self.candidate.as_str(), "radar_cell" | "grid_point") {
            bail!("unknown candidate type {}", self.candidate);
        }
        if self.feature_schema.version > cur {
            bail!("feature schema v{} is newer than this server's v{cur}", self.feature_schema.version);
        }
        if self.feature_schema.candidate != self.candidate {
            bail!("schema candidate mismatch");
        }
        if let Some(n) = self.learner.n_features() {
            if n != self.feature_schema.features.len() {
                bail!("learner expects {n} features, schema lists {}", self.feature_schema.features.len());
            }
        }
        Ok(())
    }
}

pub fn new_id() -> String {
    let t = chrono::Utc::now().timestamp_millis() as u64;
    format!("m{}{:04x}", radix36(t), rand::random::<u16>())
}

pub fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = vec![];
    loop {
        s.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Models on disk with an in-memory index.
pub struct Store {
    dir: PathBuf,
    models: RwLock<HashMap<String, Arc<ModelRecord>>>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Store {
        std::fs::create_dir_all(&dir).ok();
        let mut models = HashMap::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path().join("model.json");
                let Ok(b) = std::fs::read(&p) else { continue };
                match serde_json::from_slice::<ModelRecord>(&b) {
                    Ok(m) => {
                        models.insert(m.id.clone(), Arc::new(m));
                    }
                    Err(err) => tracing::warn!("ml: skipping {}: {err}", p.display()),
                }
            }
        }
        Store { dir, models: RwLock::new(models) }
    }
    pub fn list(&self) -> Vec<Arc<ModelRecord>> {
        let mut v: Vec<Arc<ModelRecord>> = self.models.read().values().cloned().collect();
        v.sort_by(|a, b| b.updated.cmp(&a.updated));
        v
    }
    pub fn get(&self, id: &str) -> Option<Arc<ModelRecord>> {
        self.models.read().get(id).cloned()
    }
    pub fn save(&self, m: ModelRecord) -> Result<Arc<ModelRecord>> {
        if !valid_id(&m.id) {
            bail!("bad model id");
        }
        let p = self.dir.join(&m.id).join("model.json");
        crate::platform::write_atomic(&p, &serde_json::to_vec(&m)?)?;
        let a = Arc::new(m);
        self.models.write().insert(a.id.clone(), a.clone());
        Ok(a)
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        if !valid_id(id) || self.models.write().remove(id).is_none() {
            bail!("model not found");
        }
        std::fs::remove_dir_all(self.dir.join(id)).ok();
        Ok(())
    }
    /// Apply `{name?, labels?, notes?, threshold?}`.
    pub fn patch(&self, id: &str, body: &Value) -> Result<Arc<ModelRecord>> {
        let mut m = (*self.get(id).ok_or_else(|| anyhow!("model not found"))?).clone();
        if let Some(n) = body.get("name").and_then(|v| v.as_str()) {
            let n = n.trim();
            if n.is_empty() || n.len() > 200 {
                bail!("name must be 1-200 characters");
            }
            m.name = n.to_string();
        }
        if let Some(l) = body.get("labels") {
            let a = l.as_array().ok_or_else(|| anyhow!("labels must be an array of strings"))?;
            let mut labels: Vec<String> = a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() <= 64).collect();
            labels.dedup();
            labels.truncate(32);
            m.labels = labels;
        }
        if let Some(n) = body.get("notes").and_then(|v| v.as_str()) {
            m.notes = n.chars().take(10_000).collect();
        }
        if let Some(t) = body.get("threshold") {
            if m.is_regression() {
                m.threshold = t.as_f64().filter(|t| t.is_finite()).ok_or_else(|| anyhow!("threshold must be a number"))?;
            } else {
                let t = t.as_f64().filter(|t| (0.01..=0.99).contains(t)).ok_or_else(|| anyhow!("threshold must be 0.01-0.99"))?;
                m.threshold = t;
                m.levels = Levels::from_threshold(t);
            }
        }
        if let Some(l) = body.get("levels") {
            let lv: Levels = serde_json::from_value(l.clone()).map_err(|e| anyhow!("levels: {e}"))?;
            if !(0.0 < lv.low && lv.low <= lv.med && lv.med <= lv.high && lv.high < 1.0) {
                bail!("levels must satisfy 0 < low ≤ med ≤ high < 1");
            }
            m.levels = lv;
        }
        m.updated = chrono::Utc::now().timestamp_millis();
        self.save(m)
    }
    pub fn count_bytes(&self) -> (usize, usize) {
        let g = self.models.read();
        (g.len() * 64 * 1024, g.len())
    }
}

/// `.tbwmodel`: zstd-compressed JSON `{format: "tbwmodel", format_version, exported, model}`.
pub fn export(m: &ModelRecord) -> Result<Vec<u8>> {
    let doc = json!({"format": "tbwmodel", "format_version": FORMAT_VERSION, "exported": chrono::Utc::now().timestamp_millis(), "app": "thebigweather", "model": m});
    Ok(zstd::encode_all(&serde_json::to_vec(&doc)?[..], 9)?)
}

/// Parse a `.tbwmodel` (zstd or plain JSON; a bare model record is accepted too).
pub fn import(bytes: &[u8]) -> Result<ModelRecord> {
    let raw = if bytes.starts_with(&[0x28, 0xB5, 0x2F, 0xFD]) {
        let mut out = vec![];
        zstd::stream::copy_decode(std::io::Read::take(bytes, 256 << 20), &mut out).map_err(|e| anyhow!("not a .tbwmodel file: {e}"))?;
        if out.len() > 200 << 20 {
            bail!("model file too large");
        }
        out
    } else {
        bytes.to_vec()
    };
    let v: Value = serde_json::from_slice(&raw).map_err(|e| anyhow!("not a .tbwmodel file: {e}"))?;
    let mv = if v.get("format").and_then(|f| f.as_str()) == Some("tbwmodel") {
        let fv = v.get("format_version").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        if fv == 0 || fv > FORMAT_VERSION {
            bail!("unsupported .tbwmodel format version {fv} (this server reads ≤ {FORMAT_VERSION})");
        }
        v.get("model").cloned().ok_or_else(|| anyhow!("no model in file"))?
    } else {
        v
    };
    let m: ModelRecord = serde_json::from_value(mv).map_err(|e| anyhow!("invalid model: {e}"))?;
    m.validate()?;
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calib_and_levels() {
        let m: Vec<f64> = (0..200).map(|i| (i as f64 - 100.0) / 20.0).collect();
        let y: Vec<f32> = m.iter().map(|v| if *v > 1.0 { 1.0 } else { 0.0 }).collect();
        let c = Calib::fit(&m, &y);
        assert!(c.a > 1.0, "{c:?}");
        assert!(c.apply(3.0) > 0.9 && c.apply(-2.0) < 0.05);
        let l = Levels::from_threshold(0.4);
        assert_eq!(l.level(0.3), Some("low"));
        assert_eq!(l.level(0.5), Some("med"));
        assert_eq!(l.level(0.8), Some("high"));
        assert_eq!(l.level(0.1), None);
        assert!(valid_id(&new_id()));
    }
}
