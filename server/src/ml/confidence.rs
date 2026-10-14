//! 0.8.1: probability vs confidence of a detection.
//!
//! * **probability** = the model's output for the event (calibrated; for regression models the
//!   predicted value takes its place).
//! * **confidence** (0–1) = how far to trust that number here and now. It combines:
//!   - *skill*: validation skill of the model (ROC AUC, regression skill, storm-track position
//!     error at the longest lead);
//!   - *calibration*: how well predicted probabilities matched observed frequencies in the
//!     validation reliability bin of this probability (shrunk toward 0.5 when the bin is thin);
//!   - *inputs*: importance-weighted share of the model's features that have data (missing
//!     sources, non-US dropouts);
//!   - *coverage*: outside the training region / outside the US with US-only inputs → lower;
//!   - *agreement*: ensembles only, 1 − 2·(spread of the members).

use super::features::FeatMap;
use super::model::ModelRecord;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Per-model inputs of the confidence (computed once per run).
#[derive(Debug, Clone)]
pub struct ConfModel {
    /// reliability bins: (lo, hi, n, mean_pred, obs_freq)
    rel: Vec<(f64, f64, usize, f64, f64)>,
    skill: f64,
    regression: bool,
    weights: Vec<(String, f64)>,
    ids: Vec<String>,
    /// training region (w, s, e, n)
    trained: [f64; 4],
    conus_only: bool,
}

fn clamp01(x: f64) -> f64 {
    if x.is_finite() { x.clamp(0.0, 1.0) } else { 0.5 }
}

/// Position error (km) of a storm-track model at `lead` from `{"15": km, …}`.
fn err_at(e: &Value, lead: f64) -> Option<f64> {
    let mut pts: Vec<(f64, f64)> = e.as_object()?.iter().filter_map(|(k, v)| Some((k.parse::<f64>().ok()?, v.as_f64()?))).collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let l = *pts.iter().rev().find(|p| p.0 <= lead + 1e-9).or(pts.first())?;
    Some(l.1 * lead / l.0.max(1.0))
}

impl ConfModel {
    pub fn of(m: &ModelRecord) -> ConfModel {
        let eval = m.metrics.get("eval").or_else(|| m.metrics.get("cv")).or_else(|| m.metrics.get("holdout")).cloned().unwrap_or(Value::Null);
        let rel = eval
            .get("reliability")
            .and_then(|r| r.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|b| Some((b.get("lo")?.as_f64()?, b.get("hi")?.as_f64()?, b.get("n")?.as_u64()? as usize, b.get("mean_pred").and_then(|x| x.as_f64()).unwrap_or(f64::NAN), b.get("obs_freq").and_then(|x| x.as_f64()).unwrap_or(f64::NAN))))
                    .collect()
            })
            .unwrap_or_default();
        let regression = m.is_regression();
        let skill = if m.target == "storm_track" {
            // 0 km error at an hour → 1; 60 km → 0
            match m.metrics.get("track_err_km").and_then(|e| err_at(e, 60.0)) {
                Some(e) => (1.0 - e / 60.0).clamp(0.05, 1.0),
                None => 0.5,
            }
        } else if regression {
            match eval.get("skill").and_then(|v| v.as_f64()) {
                Some(s) => clamp01(0.3 + 0.7 * s),
                None => 0.5,
            }
        } else {
            match eval.get("roc_auc").and_then(|v| v.as_f64()) {
                Some(a) if a > 0.0 => ((a - 0.5) / 0.45).clamp(0.05, 1.0),
                _ => 0.5,
            }
        };
        let tot: f64 = m.importance.iter().map(|i| i.gain.max(0.0)).sum();
        let weights = if tot > 0.0 { m.importance.iter().map(|i| (i.id.clone(), i.gain.max(0.0) / tot)).collect() } else { vec![] };
        let spec = super::predict::model_spec(m);
        let trained = spec.region.bbox();
        let conus_only = !super::spec::conus_only_sources(&m.feature_schema.sources).is_empty();
        ConfModel { rel, skill, regression, weights, ids: m.ids(), trained, conus_only }
    }

    pub fn skill(&self) -> f64 {
        self.skill
    }

    /// Calibration at probability `p` (validation reliability bin).
    pub fn calibration(&self, p: f64) -> f64 {
        if self.regression {
            return 1.0;
        }
        let Some(b) = self.rel.iter().find(|b| p >= b.0 - 1e-9 && p < b.1 + 1e-9) else { return 0.5 };
        if b.2 < 3 || !b.3.is_finite() || !b.4.is_finite() {
            return 0.5;
        }
        let c = 1.0 - ((b.4 - b.3).abs() * 2.5).min(1.0);
        let w = b.2 as f64 / (b.2 as f64 + 30.0);
        w * c + (1.0 - w) * 0.5
    }

    /// Importance-weighted share of the model's inputs that have data.
    pub fn inputs(&self, fm: &FeatMap) -> f64 {
        if !self.weights.is_empty() {
            let have: f64 = self.weights.iter().filter(|(id, _)| fm.get(id).is_finite()).map(|(_, w)| *w).sum();
            return clamp01(have);
        }
        if self.ids.is_empty() {
            return 1.0;
        }
        let ids = &self.ids;
        ids.iter().filter(|id| fm.get(id).is_finite()).count() as f64 / ids.len() as f64
    }

    /// Coverage at a point: outside the training region (by > 1°) or outside the US with
    /// US-only inputs → lower.
    pub fn coverage(&self, lat: f64, lon: f64) -> f64 {
        let t = self.trained;
        let mut c: f64 = 1.0;
        if lon < t[0] - 1.0 || lon > t[2] + 1.0 || lat < t[1] - 1.0 || lat > t[3] + 1.0 {
            c *= 0.8;
        }
        if self.conus_only && !super::spec::inside_conus(&[lon, lat, lon, lat]) && super::spec::inside_conus(&t) {
            c *= 0.75;
        }
        c
    }

    /// Combine the parts into the confidence and its breakdown.
    pub fn combine(&self, p: Option<f64>, inputs: f64, coverage: f64, agreement: Option<f64>) -> (f64, Value) {
        let cal = p.map(|p| self.calibration(p)).unwrap_or(1.0);
        let v = self.skill.powf(0.45) * cal.powf(0.3) * clamp01(inputs).powf(0.7) * clamp01(coverage) * agreement.map(clamp01).unwrap_or(1.0);
        let r = |x: f64| (x * 1000.0).round() / 1000.0;
        let mut parts = json!({"skill": r(self.skill), "inputs": r(inputs), "coverage": r(coverage)});
        if p.is_some() && !self.regression {
            parts["calibration"] = json!(r(cal));
        }
        if let Some(a) = agreement {
            parts["agreement"] = json!(r(a));
        }
        (r(clamp01(v)), parts)
    }
}

/// Cache of [`ConfModel`] per model id + version (cheap to rebuild, but called per detection).
#[derive(Default)]
pub struct ConfCache(parking_lot::Mutex<HashMap<String, (u32, i64, std::sync::Arc<ConfModel>)>>);

impl ConfCache {
    pub fn get(&self, m: &ModelRecord) -> std::sync::Arc<ConfModel> {
        let mut g = self.0.lock();
        if let Some((v, u, c)) = g.get(&m.id) {
            if *v == m.version && *u == m.updated {
                return c.clone();
            }
        }
        let c = std::sync::Arc::new(ConfModel::of(m));
        if g.len() > 500 {
            g.clear();
        }
        g.insert(m.id.clone(), (m.version, m.updated, c.clone()));
        c
    }
}

/// Agreement of ensemble members: 1 − 2·standard deviation (≥ 0.2).
pub fn agreement(ps: &[f64]) -> f64 {
    if ps.len() < 2 {
        return 1.0;
    }
    let n = ps.len() as f64;
    let mean = ps.iter().sum::<f64>() / n;
    let sd = (ps.iter().map(|p| (p - mean).powi(2)).sum::<f64>() / n).sqrt();
    (1.0 - 2.0 * sd).clamp(0.2, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_and_bounds() {
        let c = ConfModel { rel: vec![(0.0, 0.5, 200, 0.2, 0.21), (0.5, 1.0, 2, 0.8, 0.1)], skill: 0.8, regression: false, weights: vec![("a".into(), 0.75), ("b".into(), 0.25)], ids: vec![], trained: [-105.0, 30.0, -90.0, 40.0], conus_only: true };
        // well-calibrated, populated bin vs a thin one
        assert!(c.calibration(0.2) > 0.9);
        assert_eq!(c.calibration(0.9), 0.5);
        let mut fm = FeatMap::default();
        fm.set("a", 1.0);
        assert!((c.inputs(&fm) - 0.75).abs() < 1e-9);
        assert_eq!(c.coverage(35.0, -97.0), 1.0);
        // Europe: outside the training region and outside the US with US-only inputs
        assert!(c.coverage(50.0, 8.0) < 0.65);
        let (hi, parts) = c.combine(Some(0.2), 1.0, 1.0, None);
        let (lo, _) = c.combine(Some(0.2), 0.3, 0.6, Some(0.4));
        assert!(hi > lo && hi <= 1.0 && lo >= 0.0, "{hi} {lo}");
        assert!(parts["calibration"].as_f64().is_some());
        assert!(agreement(&[0.9, 0.1]) < agreement(&[0.5, 0.52]));
    }
}
