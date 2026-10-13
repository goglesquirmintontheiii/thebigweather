//! A/B tests: several models of the same target evaluated on the same historical events. One
//! dataset is built with the union of the models' sources (cached like training data); each
//! model scores every sample with its own schema. Scorecards: ROC / PR AUC, CSI, POD, FAR,
//! Brier, reliability, lead-time statistics (radar cells) or MAE / RMSE / bias / skill
//! (regression), plus per-event outcomes.

use super::dataset::{Budget, Built};
use super::jobs::Ctl;
use super::metrics::{evaluate, evaluate_reg};
use super::model::ModelRecord;
use super::spec::{self, TrainSpec};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// Resolve the evaluation spec: a finished job's spec, or the first model's spec with the
/// `events` overrides (years, region, filters, max_events, null_days, seed …). By default the
/// events come from the year after the first model's training years when that year is over,
/// else from its last training year with another sample of cases.
pub fn eval_spec(models: &[Arc<ModelRecord>], events: &Value, job_spec: Option<&Value>) -> Result<(TrainSpec, bool)> {
    let m0 = &models[0];
    let mut raw = match job_spec {
        Some(s) => s.clone(),
        None => m0.spec.clone(),
    };
    if let Some(o) = raw.as_object_mut() {
        o.remove("preset");
        o.remove("intensity");
        o.insert("target".into(), json!(m0.target));
        o.insert("task".into(), json!(m0.task));
    }
    let base = super::predict::model_spec(m0);
    let now_y = chrono::Datelike::year(&chrono::Utc::now());
    let mut overlap = false;
    if job_spec.is_none() && events.get("years").is_none() {
        let next = base.years[1] + 1;
        if next < now_y {
            raw["years"] = json!([next, next]);
        } else {
            raw["years"] = json!([base.years[1], base.years[1]]);
            raw["seed"] = json!(base.seed.wrapping_add(7919));
            overlap = true;
        }
    }
    if let Some(e) = events.as_object() {
        for (k, v) in e {
            if matches!(k.as_str(), "years" | "region" | "filters" | "max_events" | "null_days" | "seed" | "max_samples" | "neg_ratio" | "volumes_per_event" | "radars_per_event" | "target_params" | "label_source") {
                if k == "target_params" {
                    spec::merge(&mut raw["target_params"], v);
                } else {
                    raw[k] = v.clone();
                }
            }
        }
    }
    // every model's inputs
    let mut src = super::features::Sources::default();
    for m in models {
        src = src.union(&m.feature_schema.sources);
    }
    raw["sources"] = serde_json::to_value(&src)?;
    raw["features"] = json!([]);
    raw["cv_folds"] = json!(0);
    let mut s: TrainSpec = serde_json::from_value(raw).map_err(|e| anyhow::anyhow!("bad evaluation spec: {e}"))?;
    s.validate()?;
    if job_spec.is_none() && events.get("years").is_some() {
        overlap = s.years[0] <= base.years[1] && s.years[1] >= base.years[0];
    }
    Ok((s, overlap))
}

fn round(x: f64, k: f64) -> f64 {
    if x.is_finite() { (x * k).round() / k } else { x }
}

/// Probabilities / values of a model for the dataset's samples.
fn predict(m: &ModelRecord, built: &Built) -> Vec<f64> {
    let cols: Vec<Option<usize>> = m.ids().iter().map(|f| built.ids.iter().position(|x| x == f)).collect();
    built
        .samples
        .iter()
        .map(|s| {
            let x: Vec<f32> = cols.iter().map(|c| c.and_then(|c| s.features.get(c).copied()).unwrap_or(f32::NAN)).collect();
            m.prob(&x)
        })
        .collect()
}

/// Scorecards and per-event outcomes of models on a built dataset.
pub fn scorecards(models: &[Arc<ModelRecord>], built: &Built) -> Value {
    let y: Vec<f32> = built.samples.iter().map(|s| s.label).collect();
    let reg = models[0].is_regression();
    let mut cards = vec![];
    let mut preds = vec![];
    for m in models {
        let p = predict(m, built);
        let card = if reg {
            let clim = y.iter().map(|v| *v as f64).sum::<f64>() / y.len().max(1) as f64;
            let r = evaluate_reg(&y, &p, clim, None);
            json!({"model_id": m.id, "name": m.name, "algo": m.algo, "intensity": m.intensity(), "version": m.version, "task": "regression", "metrics": r, "mae": r.mae, "rmse": r.rmse, "bias": r.bias, "r2": r.r2, "skill": r.skill})
        } else {
            let thr = m.threshold;
            let e = evaluate(&y, &p, thr);
            // lead time: earliest sample at / above the threshold before each event start
            let mut first: HashMap<&str, i64> = HashMap::new();
            for (s, pi) in built.samples.iter().zip(&p) {
                if *pi >= thr && s.label > 0.5 {
                    if let Some(ev) = &s.meta.event {
                        let f = first.entry(ev.as_str()).or_insert(s.meta.t);
                        *f = (*f).min(s.meta.t);
                    }
                }
            }
            let mut leads: Vec<f64> = first.iter().filter_map(|(ev, t)| built.event_times.get(*ev).map(|t0| (*t0 - *t) as f64 / 60_000.0)).collect();
            leads.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let q = |f: f64| if leads.is_empty() { Value::Null } else { json!(round(leads[((leads.len() - 1) as f64 * f).round() as usize], 10.0)) };
            let lead = json!({"n": leads.len(), "mean_min": if leads.is_empty() { Value::Null } else { json!(round(leads.iter().sum::<f64>() / leads.len() as f64, 10.0)) }, "median_min": q(0.5), "p10_min": q(0.1), "p90_min": q(0.9)});
            json!({"model_id": m.id, "name": m.name, "algo": m.algo, "intensity": m.intensity(), "version": m.version, "task": "classification", "threshold": thr,
                "roc_auc": e.roc_auc, "pr_auc": e.pr_auc, "csi": e.csi, "pod": e.pod, "far": e.far, "brier": e.brier, "best_csi": e.best_csi, "best_csi_threshold": e.best_csi_threshold,
                "reliability": e.reliability, "lead_time": lead, "metrics": e})
        };
        cards.push(card);
        preds.push(p);
    }
    // per-event (group) outcomes: max prediction per model; hit = max ≥ threshold
    let mut groups: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, s) in built.samples.iter().enumerate() {
        groups.entry(s.group.as_str()).or_default().push(i);
    }
    let mut events = vec![];
    for (g, idx) in groups.iter().take(3000) {
        let pos = idx.iter().any(|&i| y[i] > 0.5);
        let t = idx.iter().map(|&i| built.samples[i].meta.t).min().unwrap_or(0);
        let (lat, lon) = idx.first().map(|&i| (built.samples[i].meta.lat, built.samples[i].meta.lon)).unwrap_or((0.0, 0.0));
        let per: Vec<Value> = models
            .iter()
            .zip(&preds)
            .map(|(m, p)| {
                if reg {
                    let err = idx.iter().map(|&i| (p[i] - y[i] as f64).abs()).sum::<f64>() / idx.len().max(1) as f64;
                    json!({"model_id": m.id, "mae": round(err, 1000.0)})
                } else {
                    let mx = idx.iter().map(|&i| p[i]).fold(0.0, f64::max);
                    let hit = mx >= m.threshold;
                    json!({"model_id": m.id, "max_prob": round(mx, 1000.0), "detected": hit, "outcome": match (pos, hit) { (true, true) => "hit", (true, false) => "miss", (false, true) => "false_alarm", (false, false) => "correct_null" }})
                }
            })
            .collect();
        events.push(json!({"group": g, "positive": pos, "t": t, "lat": round(lat, 1e3), "lon": round(lon, 1e3), "samples": idx.len(), "models": per}));
    }
    // ranking by the headline score
    let key = if reg { "rmse" } else { "roc_auc" };
    let mut rank: Vec<(String, f64)> = cards.iter().map(|c| (c["model_id"].as_str().unwrap_or("").to_string(), c[key].as_f64().unwrap_or(f64::NAN))).collect();
    rank.sort_by(|a, b| if reg { a.1.partial_cmp(&b.1) } else { b.1.partial_cmp(&a.1) }.unwrap_or(std::cmp::Ordering::Equal));
    json!({"scorecards": cards, "events": events, "ranking": rank.iter().map(|r| json!({"model_id": r.0, key: r.1})).collect::<Vec<_>>(), "by": key,
        "samples": built.samples.len(), "positives": y.iter().filter(|v| **v > 0.5).count(), "groups": groups.len()})
}

/// Build the shared evaluation dataset and score every model.
pub async fn run(fetch: Arc<dyn super::source::Fetch>, models: Vec<Arc<ModelRecord>>, events: Value, job_spec: Option<Value>, ctl: &Ctl, cache_root: &std::path::Path, budget: &Budget) -> Result<Value> {
    if models.is_empty() {
        bail!("no models to compare");
    }
    let m0 = models[0].clone();
    for m in &models[1..] {
        if m.target != m0.target || m.candidate != m0.candidate || m.task != m0.task {
            bail!("models must share the target, candidate and task ({} vs {})", m0.target, m.target);
        }
    }
    let (spec, overlap) = eval_spec(&models, &events, job_spec.as_ref())?;
    ctl.log(format!("evaluating {} models on {} events {}–{} ({}){}", models.len(), spec.target, spec.years[0], spec.years[1], spec.label_source.join(", "), if overlap { " — overlaps the training years: scores are optimistic" } else { "" }));
    let built = super::dataset::build_with(fetch, &spec, ctl, cache_root, budget).await?;
    if ctl.cancelled() {
        bail!("cancelled");
    }
    ctl.phase("evaluate", 0.5);
    let ms = models.clone();
    let b2 = Arc::new(built);
    let b3 = b2.clone();
    let mut res = tokio::task::spawn_blocking(move || scorecards(&ms, &b3)).await?;
    res["spec"] = serde_json::to_value(&spec)?;
    res["overlaps_training"] = json!(overlap);
    res["dataset"] = b2.stats.clone();
    let summary = json!({"models": res["scorecards"].as_array().map(|a| a.iter().map(|c| json!({"model_id": c["model_id"], "name": c["name"], "roc_auc": c["roc_auc"], "csi": c["csi"], "pod": c["pod"], "far": c["far"], "rmse": c["rmse"], "mae": c["mae"]})).collect::<Vec<_>>()).unwrap_or_default(), "samples": res["samples"], "ranking": res["ranking"]});
    res["summary"] = summary;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ml::dataset::{Sample, SampleMeta};

    #[test]
    fn scorecards_rank_models() {
        // two logistic "models" on one feature: a good one and a noisy one
        let mut samples = vec![];
        for i in 0..400 {
            let x = (i % 100) as f32 / 10.0;
            let y = if x > 6.0 { 1.0 } else { 0.0 };
            samples.push(Sample { features: vec![x, ((i * 37) % 100) as f32 / 10.0], label: y, weight: 1.0, group: format!("g{}", i / 4), meta: SampleMeta { t: i as i64 * 60_000, event: (y > 0.5).then(|| format!("e{}", i / 4)), ..Default::default() }, targets: vec![] });
        }
        let built = Built { ids: vec!["a".into(), "b".into()], samples, stats: json!({}), event_times: (0..100).map(|g| (format!("e{g}"), (g * 4 + 3) as i64 * 60_000)).collect() };
        let mk = |feat: &str, id: &str| {
            let schema = crate::ml::features::Schema { candidate: "radar_cell".into(), version: 1, sources: Default::default(), features: vec![crate::ml::features::FeatureDef { id: feat.into(), name: feat.into(), unit: String::new(), group: String::new() }] };
            let l = crate::ml::linear::LogReg { scaler: crate::ml::linear::Standardizer { mean: vec![0.0], std: vec![1.0] }, coef: vec![2.0], intercept: -12.0 };
            Arc::new(ModelRecord {
                id: id.into(), name: id.into(), labels: vec![], target: "tornado".into(), candidate: "radar_cell".into(), created: 0, updated: 0, spec: json!({}), feature_schema: schema, algo: "logreg".into(), params: json!({}), metrics: json!({}),
                threshold: 0.5, levels: crate::ml::model::Levels::from_threshold(0.5), version: 1, format: 2, task: "classification".into(), output: String::new(), history: vec![], quantiles: vec![], notes: String::new(), importance: vec![],
                calib: Default::default(), learner: crate::ml::model::Learner::Logreg(l), origin: String::new(), job_id: None, intensity: String::new(), family_key: String::new(), aux: vec![], cache_bytes: 0, size_bytes: 0,
            })
        };
        let r = scorecards(&[mk("a", "good"), mk("b", "noisy")], &built);
        assert_eq!(r["ranking"][0]["model_id"], "good", "{}", r["ranking"]);
        let good = &r["scorecards"][0];
        assert!(good["roc_auc"].as_f64().unwrap() > 0.95);
        assert!(good["pod"].as_f64().unwrap() > 0.9);
        assert!(good["lead_time"]["n"].as_u64().unwrap() > 0);
        assert!(r["events"].as_array().unwrap().iter().any(|e| e["models"][0]["outcome"] == "hit"));
    }
}
