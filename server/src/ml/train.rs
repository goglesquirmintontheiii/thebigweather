//! Fit + evaluate a learner on a sample set: grouped k-fold CV (or a grouped holdout), early
//! stopping on an inner grouped validation split, Platt calibration on out-of-sample margins,
//! best-CSI threshold, metrics and feature importance. Regression targets use squared / Huber /
//! quantile losses (GBDT), ridge or an MLP and are verified with MAE / RMSE / bias / R² and skill
//! against climatology and persistence. Every learner can continue from an existing model
//! (warm start: more trees / more optimisation steps on the new data, same feature schema).

use super::core::{Data, Loss};
use super::dataset::Sample;
use super::features::Schema;
use super::jobs::Ctl;
use super::metrics::{evaluate, evaluate_reg, group_folds, group_holdout};
use super::model::{Calib, Importance, Learner, Levels, QuantLearner};
use super::spec::TrainSpec;
use super::{gbdt, linear, mlp};
use anyhow::{bail, Result};
use serde_json::{json, Value};

pub struct Trained {
    pub learner: Learner,
    pub calib: Calib,
    pub threshold: f64,
    pub levels: Levels,
    pub metrics: Value,
    pub importance: Vec<Importance>,
    pub params: Value,
    pub quantiles: Vec<QuantLearner>,
}

fn params_of<T: serde::de::DeserializeOwned + serde::Serialize + Default>(v: &Value) -> T {
    let mut base = serde_json::to_value(T::default()).unwrap_or_default();
    if let (Some(b), Some(o)) = (base.as_object_mut(), v.as_object()) {
        for (k, x) in o {
            if b.contains_key(k) {
                b.insert(k.clone(), x.clone());
            }
        }
    }
    serde_json::from_value(base).unwrap_or_default()
}

enum P {
    G(gbdt::GbdtParams, Loss),
    L(linear::LogRegParams, bool),
    M(mlp::MlpParams, bool),
}

impl P {
    fn json(&self) -> Value {
        match self {
            P::G(p, _) => serde_json::to_value(p).unwrap_or_default(),
            P::L(p, _) => serde_json::to_value(p).unwrap_or_default(),
            P::M(p, _) => serde_json::to_value(p).unwrap_or_default(),
        }
    }
    fn max_iter(&self) -> usize {
        match self {
            P::G(p, _) => p.n_trees,
            P::L(p, _) => p.max_iter,
            P::M(p, _) => p.epochs,
        }
    }
    /// The same parameters with a fixed iteration count and no early stopping.
    fn fixed(&self, iters: usize) -> P {
        match self {
            P::G(p, l) => P::G(gbdt::GbdtParams { n_trees: iters.max(1), early_stopping_rounds: 0, ..p.clone() }, *l),
            P::L(p, r) => P::L(p.clone(), *r),
            P::M(p, r) => P::M(mlp::MlpParams { epochs: iters.max(1), early_stopping_rounds: 0, ..p.clone() }, *r),
        }
    }
}

/// Fit; returns the learner and the number of iterations it added (new trees for a warm start).
fn fit(p: &P, tr: &Data, va: Option<&Data>, prog: super::core::Progress, init: Option<&Learner>) -> (Learner, usize) {
    match p {
        P::G(p, loss) => {
            let ig = match init {
                Some(Learner::Gbdt(g)) => Some(g),
                _ => None,
            };
            let n0 = ig.map(|g| g.trees.len()).unwrap_or(0);
            let m = gbdt::fit_with(tr, va, p, *loss, ig, prog);
            let n = m.best_iter.saturating_sub(n0);
            (Learner::Gbdt(m), n)
        }
        P::L(p, reg) => {
            let il = match init {
                Some(Learner::Logreg(l)) => Some(l),
                _ => None,
            };
            if *reg {
                (Learner::Logreg(linear::fit_ridge(tr, va, p, il, prog)), 1)
            } else {
                (Learner::Logreg(linear::fit_init(tr, va, p, il, prog)), p.max_iter)
            }
        }
        P::M(p, reg) => {
            let im = match init {
                Some(Learner::Mlp(m)) => Some(m),
                _ => None,
            };
            // epochs used ≈ the epoch of the best validation loss; not tracked by the MLP, so keep the cap
            (Learner::Mlp(mlp::fit_with(tr, va, p, *reg, im, prog)), p.epochs)
        }
    }
}

fn importance(l: &Learner, data: &Data) -> Vec<f64> {
    match l {
        Learner::Gbdt(g) => g.importance.clone(),
        Learner::Logreg(m) => m.importance(),
        Learner::Mlp(m) => m.importance(data),
    }
}

/// Inner grouped split for early stopping (None when there are too few groups).
fn inner_split(idx: &[usize], groups: &[String], y: &[f32], seed: u64, reg: bool) -> (Vec<usize>, Option<Vec<usize>>) {
    let g: Vec<String> = idx.iter().map(|&i| groups[i].clone()).collect();
    let yy: Vec<f32> = idx.iter().map(|&i| y[i]).collect();
    let ngroups = {
        let mut s = g.clone();
        s.sort();
        s.dedup();
        s.len()
    };
    if ngroups < 8 {
        return (idx.to_vec(), None);
    }
    let (a, b) = group_holdout(&g, &yy, 0.15, seed ^ 0x55);
    let vpos = b.iter().filter(|&&k| yy[k] > 0.5).count();
    if (!reg && vpos == 0) || b.len() < 10 {
        return (idx.to_vec(), None);
    }
    (a.iter().map(|&k| idx[k]).collect(), Some(b.iter().map(|&k| idx[k]).collect()))
}

/// `ids` = feature order of `samples[i].features`; the schema picks (and orders) the columns.
pub fn train(spec: &TrainSpec, schema: &Schema, ids: &[String], samples: &[Sample], ctl: &Ctl) -> Result<Trained> {
    train_with(spec, schema, ids, samples, ctl, None)
}

/// Train, or (with `init`) continue training an existing model on these samples.
pub fn train_with(spec: &TrainSpec, schema: &Schema, ids: &[String], samples: &[Sample], ctl: &Ctl, init: Option<&super::model::ModelRecord>) -> Result<Trained> {
    let reg = spec.task == "regression";
    let cols: Vec<Option<usize>> = schema.ids().iter().map(|f| ids.iter().position(|x| x == f)).collect();
    let mut data = Data::new(cols.len());
    let mut groups = Vec::with_capacity(samples.len());
    let mut row = vec![0f32; cols.len()];
    for s in samples {
        if !s.label.is_finite() {
            continue;
        }
        for (o, c) in row.iter_mut().zip(&cols) {
            *o = c.and_then(|c| s.features.get(c).copied()).unwrap_or(f32::NAN);
        }
        data.push(&row, s.label, s.weight);
        groups.push(s.group.clone());
    }
    let pos = data.positives();
    let neg = data.n - pos;
    if reg {
        if data.n < 20 {
            bail!("not enough samples to train ({}); widen the years / region or add cases", data.n);
        }
    } else if pos < 3 || neg < 3 {
        bail!("not enough samples to train ({pos} positive, {neg} negative); widen the years / region or add events");
    }
    let loss = {
        let g: gbdt::GbdtParams = params_of(&spec.params);
        Loss::parse(reg, &g.loss, g.huber_delta, g.alpha)
    };
    let p = match spec.algo.as_str() {
        "logreg" => P::L(params_of(&spec.params), reg),
        "mlp" => P::M(params_of(&spec.params), reg),
        _ => P::G(params_of(&spec.params), loss),
    };
    let init_l = init.map(|m| &m.learner);
    if let Some(m) = init {
        if m.learner.n_features() != Some(cols.len()) {
            bail!("the model's learner does not match its feature schema; retrain instead");
        }
        ctl.log(format!("continuing from model {} v{} ({})", m.id, m.version, m.algo));
    }
    let seed = spec.seed;
    let all: Vec<usize> = (0..data.n).collect();
    let max_iter = p.max_iter();
    let folds = if spec.cv_folds >= 2 { spec.cv_folds } else { 0 };
    // progress: CV folds + the final fit share the train phase
    let parts = (folds + 1) as f64;
    let mk_prog = |part: usize| {
        move |it: usize, max: usize, tl: f64, vl: f64| -> bool {
            let f = (part as f64 + it as f64 / max.max(1) as f64) / parts;
            ctl.train_progress(f, it, tl, vl);
            !ctl.stopping()
        }
    };
    let mut oof_m = vec![f64::NAN; data.n];
    let mut iters = vec![];
    let eval_kind;
    let final_learner;
    let mut calib_m: Vec<f64> = vec![];
    let mut calib_y: Vec<f32> = vec![];
    if folds >= 2 {
        let f = group_folds(&groups, &data.y, folds, seed);
        let mut last: Option<Learner> = None;
        for k in 0..folds {
            if ctl.stopping() && last.is_some() {
                ctl.log(format!("stop requested: skipping CV folds {}–{folds}", k + 1));
                break;
            }
            let tr_idx: Vec<usize> = all.iter().copied().filter(|&i| f[i] != k).collect();
            let te_idx: Vec<usize> = all.iter().copied().filter(|&i| f[i] == k).collect();
            let (a, v) = inner_split(&tr_idx, &groups, &data.y, seed + k as u64, reg);
            let tr = data.take(&a);
            let va = v.map(|v| data.take(&v));
            let prog = mk_prog(k);
            let (m, n) = fit(&p, &tr, va.as_ref(), &prog, init_l);
            for &i in &te_idx {
                oof_m[i] = m.margin(data.row(i));
            }
            iters.push(n);
            ctl.log(format!("CV fold {}/{folds}: {} train / {} test samples, {} iterations{}", k + 1, a.len(), te_idx.len(), n, if init.is_some() { " added" } else { "" }));
            last = Some(m);
        }
        let done: Vec<usize> = all.iter().copied().filter(|&i| oof_m[i].is_finite()).collect();
        calib_m = done.iter().map(|&i| oof_m[i]).collect();
        calib_y = done.iter().map(|&i| data.y[i]).collect();
        eval_kind = if iters.len() == folds { format!("{folds}-fold grouped CV") } else { format!("{} of {folds} grouped CV folds (stopped early)", iters.len()) };
        if ctl.stopping() {
            final_learner = last.unwrap();
            ctl.log("stop requested: keeping the last CV fold model as the final model");
        } else {
            let mut it = iters.clone();
            it.sort_unstable();
            let n = it.get(it.len() / 2).copied().unwrap_or(max_iter);
            if init.is_some() && n == 0 && matches!(p, P::G(..)) {
                ctl.log("no added trees improved validation loss: keeping the existing ensemble");
                final_learner = init.unwrap().learner.clone();
            } else {
                let pf = p.fixed(n);
                let prog = mk_prog(folds);
                ctl.log(format!("final fit on all {} samples ({n} iterations)", data.n));
                final_learner = fit(&pf, &data, None, &prog, init_l).0;
            }
        }
    } else {
        let (tr_idx, te_idx) = group_holdout(&groups, &data.y, 0.2, seed);
        let te_pos = te_idx.iter().filter(|&&i| data.y[i] > 0.5).count();
        let few = if reg { te_idx.len() < 10 || tr_idx.len() < 10 } else { te_pos == 0 || tr_idx.iter().filter(|&&i| data.y[i] > 0.5).count() < 2 };
        let (tr_idx, te_idx, kind) = if few { (all.clone(), all.clone(), "training data (too few cases for a holdout)".to_string()) } else { (tr_idx, te_idx, "20% grouped holdout".to_string()) };
        let (a, v) = inner_split(&tr_idx, &groups, &data.y, seed, reg);
        let tr = data.take(&a);
        let va = v.as_ref().map(|v| data.take(v));
        let prog = mk_prog(0);
        let (m, n) = fit(&p, &tr, va.as_ref(), &prog, init_l);
        iters.push(n);
        ctl.log(format!("trained on {} samples ({} validation), {n} iterations{}", a.len(), v.as_ref().map(|v| v.len()).unwrap_or(0), if init.is_some() { " added" } else { "" }));
        for &i in &te_idx {
            oof_m[i] = m.margin(data.row(i));
        }
        // calibrate on the validation split when there is one, else on the test margins
        if let Some(v) = &v {
            calib_m = v.iter().map(|&i| m.margin(data.row(i))).collect();
            calib_y = v.iter().map(|&i| data.y[i]).collect();
        } else {
            calib_m = te_idx.iter().map(|&i| oof_m[i]).collect();
            calib_y = te_idx.iter().map(|&i| data.y[i]).collect();
        }
        eval_kind = kind;
        final_learner = m;
    }
    let ev_idx: Vec<usize> = all.iter().copied().filter(|&i| oof_m[i].is_finite()).collect();
    let ey: Vec<f32> = ev_idx.iter().map(|&i| data.y[i]).collect();
    let imp = importance(&final_learner, &data);
    let tot: f64 = imp.iter().map(|x| x.abs()).sum::<f64>().max(1e-12);
    let mut importance: Vec<Importance> = schema.features.iter().zip(&imp).map(|(f, g)| Importance { id: f.id.clone(), name: f.name.clone(), gain: ((g.abs() / tot) * 10_000.0).round() / 10_000.0 }).collect();
    importance.sort_by(|a, b| b.gain.partial_cmp(&a.gain).unwrap_or(std::cmp::Ordering::Equal));
    let groups_n = {
        let mut g = groups.clone();
        g.sort();
        g.dedup();
        g.len()
    };
    if reg {
        // persistence baseline: the current observation, when the schema has it
        let pc = schema.ids().iter().position(|f| f == "obs_now");
        let clim = data.y.iter().map(|y| *y as f64).sum::<f64>() / data.n.max(1) as f64;
        let ep: Vec<f64> = ev_idx.iter().map(|&i| oof_m[i]).collect();
        let persist: Option<Vec<f64>> = pc.map(|c| ev_idx.iter().map(|&i| data.at(i, c) as f64).collect());
        let m = evaluate_reg(&ey, &ep, clim, persist.as_deref());
        let tp: Vec<f64> = (0..data.n).map(|i| final_learner.margin(data.row(i))).collect();
        let tm = evaluate_reg(&data.y, &tp, clim, None);
        ctl.log(format!("{eval_kind}: MAE {:.3}, RMSE {:.3}, bias {:+.3}, R² {:.3}, skill vs climatology {:.3}{}", m.mae, m.rmse, m.bias, m.r2, m.skill_clim, m.skill_persistence.map(|s| format!(", vs persistence {s:.3}")).unwrap_or_default()));
        // extra quantile learners (GBDT)
        let mut quantiles = vec![];
        if let P::G(gp, _) = &p {
            let qs: Vec<f64> = gp.quantiles.iter().copied().filter(|q| *q > 0.0 && *q < 1.0).collect();
            let n_trees = match &final_learner {
                Learner::Gbdt(g) => g.trees.len().max(50),
                _ => gp.n_trees,
            };
            for q in qs {
                if ctl.stopping() {
                    break;
                }
                let prev = init.and_then(|m| m.quantiles.iter().find(|x| (x.q - q).abs() < 1e-6)).and_then(|x| match &x.learner {
                    Learner::Gbdt(g) => Some(g),
                    _ => None,
                });
                let qp = gbdt::GbdtParams { n_trees: if prev.is_some() { gp.n_trees.min(n_trees) } else { n_trees }, early_stopping_rounds: 0, ..gp.clone() };
                let g = gbdt::fit_with(&data, None, &qp, Loss::Quantile(q), prev, &super::core::no_progress);
                ctl.log(format!("quantile model P{:.0}: {} trees", q * 100.0, g.trees.len()));
                quantiles.push(QuantLearner { q, learner: Learner::Gbdt(g) });
            }
        }
        let cover: Vec<Value> = quantiles
            .iter()
            .map(|ql| {
                let below = (0..data.n).filter(|&i| (data.y[i] as f64) <= ql.learner.margin(data.row(i))).count() as f64 / data.n.max(1) as f64;
                json!({"q": ql.q, "train_fraction_below": (below * 1000.0).round() / 1000.0})
            })
            .collect();
        let metrics = json!({
            "task": "regression",
            "eval": m,
            "eval_kind": eval_kind,
            "train_fit": {"mae": tm.mae, "rmse": tm.rmse, "bias": tm.bias, "r2": tm.r2},
            "iterations": iters,
            "loss": loss.name(),
            "climatology": (clim * 1000.0).round() / 1000.0,
            "quantiles": cover,
            "dataset": {"samples": data.n, "groups": groups_n, "label_mean": (clim * 1000.0).round() / 1000.0},
        });
        let thr = spec.target_params.get("dbz").and_then(|v| v.as_f64()).filter(|_| spec.target == "storm_forecast").unwrap_or(if spec.target == "precip_forecast" { 1.0 } else { 0.0 });
        return Ok(Trained { learner: final_learner, calib: Calib::default(), threshold: thr, levels: Levels::from_threshold(0.5), metrics, importance, params: p.json(), quantiles });
    }
    let calib = Calib::fit(&calib_m, &calib_y);
    let ep: Vec<f64> = ev_idx.iter().map(|&i| calib.apply(oof_m[i])).collect();
    let pre = evaluate(&ey, &ep, 0.5);
    let threshold = if pre.best_csi > 0.0 { pre.best_csi_threshold } else { 0.5 };
    let m = evaluate(&ey, &ep, threshold);
    // training-set fit for reference
    let tp: Vec<f64> = (0..data.n).map(|i| calib.apply(final_learner.margin(data.row(i)))).collect();
    let tm = evaluate(&data.y, &tp, threshold);
    ctl.log(format!("{eval_kind}: ROC AUC {:.3}, PR AUC {:.3}, CSI {:.3} (POD {:.2}, FAR {:.2}) at threshold {:.2}", m.roc_auc, m.pr_auc, m.csi, m.pod, m.far, threshold));
    let metrics = json!({
        "task": "classification",
        "eval": m,
        "eval_kind": eval_kind,
        "train_fit": {"roc_auc": tm.roc_auc, "pr_auc": tm.pr_auc, "brier": tm.brier, "csi": tm.csi},
        "iterations": iters,
        "dataset": {"samples": data.n, "positives": pos, "negatives": neg, "groups": groups_n},
        "calibration": calib,
    });
    Ok(Trained { learner: final_learner, calib, threshold, levels: Levels::from_threshold(threshold), metrics, importance, params: p.json(), quantiles: vec![] })
}

/// Quick fit without a job (tests / fixtures).
#[cfg(test)]
pub fn quick(spec: &TrainSpec, schema: &Schema, ids: &[String], samples: &[Sample]) -> Result<Trained> {
    train(spec, schema, ids, samples, &Ctl::detached())
}
