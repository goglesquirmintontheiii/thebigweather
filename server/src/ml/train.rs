//! Fit + evaluate a learner on a sample set: grouped k-fold CV (or a grouped holdout), early
//! stopping on an inner grouped validation split, Platt calibration on out-of-sample margins,
//! best-CSI threshold, metrics and feature importance.

use super::core::Data;
use super::dataset::Sample;
use super::features::Schema;
use super::jobs::Ctl;
use super::metrics::{evaluate, group_folds, group_holdout};
use super::model::{Calib, Importance, Learner, Levels};
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
    G(gbdt::GbdtParams),
    L(linear::LogRegParams),
    M(mlp::MlpParams),
}

impl P {
    fn json(&self) -> Value {
        match self {
            P::G(p) => serde_json::to_value(p).unwrap_or_default(),
            P::L(p) => serde_json::to_value(p).unwrap_or_default(),
            P::M(p) => serde_json::to_value(p).unwrap_or_default(),
        }
    }
    fn max_iter(&self) -> usize {
        match self {
            P::G(p) => p.n_trees,
            P::L(p) => p.max_iter,
            P::M(p) => p.epochs,
        }
    }
    /// The same parameters with a fixed iteration count and no early stopping.
    fn fixed(&self, iters: usize) -> P {
        match self {
            P::G(p) => P::G(gbdt::GbdtParams { n_trees: iters.max(1), early_stopping_rounds: 0, ..p.clone() }),
            P::L(p) => P::L(p.clone()),
            P::M(p) => P::M(mlp::MlpParams { epochs: iters.max(1), early_stopping_rounds: 0, ..p.clone() }),
        }
    }
}

fn fit(p: &P, tr: &Data, va: Option<&Data>, prog: super::core::Progress) -> (Learner, usize) {
    match p {
        P::G(p) => {
            let m = gbdt::fit(tr, va, p, prog);
            let n = m.best_iter;
            (Learner::Gbdt(m), n)
        }
        P::L(p) => (Learner::Logreg(linear::fit(tr, va, p, prog)), p.max_iter),
        P::M(p) => {
            // epochs used ≈ the epoch of the best validation loss; not tracked by the MLP, so keep the cap
            (Learner::Mlp(mlp::fit(tr, va, p, prog)), p.epochs)
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
fn inner_split(idx: &[usize], groups: &[String], y: &[f32], seed: u64) -> (Vec<usize>, Option<Vec<usize>>) {
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
    if vpos == 0 || b.len() < 10 {
        return (idx.to_vec(), None);
    }
    (a.iter().map(|&k| idx[k]).collect(), Some(b.iter().map(|&k| idx[k]).collect()))
}

/// `ids` = feature order of `samples[i].features`; the schema picks (and orders) the columns.
pub fn train(spec: &TrainSpec, schema: &Schema, ids: &[String], samples: &[Sample], ctl: &Ctl) -> Result<Trained> {
    let cols: Vec<Option<usize>> = schema.ids().iter().map(|f| ids.iter().position(|x| x == f)).collect();
    let mut data = Data::new(cols.len());
    let mut groups = Vec::with_capacity(samples.len());
    let mut row = vec![0f32; cols.len()];
    for s in samples {
        for (o, c) in row.iter_mut().zip(&cols) {
            *o = c.and_then(|c| s.features.get(c).copied()).unwrap_or(f32::NAN);
        }
        data.push(&row, s.label, s.weight);
        groups.push(s.group.clone());
    }
    let pos = data.positives();
    let neg = data.n - pos;
    if pos < 3 || neg < 3 {
        bail!("not enough samples to train ({pos} positive, {neg} negative); widen the years / region or add events");
    }
    let p = match spec.algo.as_str() {
        "logreg" => P::L(params_of(&spec.params)),
        "mlp" => P::M(params_of(&spec.params)),
        _ => P::G(params_of(&spec.params)),
    };
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
            let (a, v) = inner_split(&tr_idx, &groups, &data.y, seed + k as u64);
            let tr = data.take(&a);
            let va = v.map(|v| data.take(&v));
            let prog = mk_prog(k);
            let (m, n) = fit(&p, &tr, va.as_ref(), &prog);
            for &i in &te_idx {
                oof_m[i] = m.margin(data.row(i));
            }
            iters.push(n);
            ctl.log(format!("CV fold {}/{folds}: {} train / {} test samples, {} iterations", k + 1, a.len(), te_idx.len(), n));
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
            let pf = p.fixed(n);
            let prog = mk_prog(folds);
            ctl.log(format!("final fit on all {} samples ({n} iterations)", data.n));
            final_learner = fit(&pf, &data, None, &prog).0;
        }
    } else {
        let (tr_idx, te_idx) = group_holdout(&groups, &data.y, 0.2, seed);
        let te_pos = te_idx.iter().filter(|&&i| data.y[i] > 0.5).count();
        let (tr_idx, te_idx, kind) = if te_pos == 0 || tr_idx.iter().filter(|&&i| data.y[i] > 0.5).count() < 2 {
            (all.clone(), all.clone(), "training data (too few events for a holdout)".to_string())
        } else {
            (tr_idx, te_idx, "20% grouped holdout".to_string())
        };
        let (a, v) = inner_split(&tr_idx, &groups, &data.y, seed);
        let tr = data.take(&a);
        let va = v.as_ref().map(|v| data.take(v));
        let prog = mk_prog(0);
        let (m, n) = fit(&p, &tr, va.as_ref(), &prog);
        iters.push(n);
        ctl.log(format!("trained on {} samples ({} validation), {n} iterations", a.len(), v.as_ref().map(|v| v.len()).unwrap_or(0)));
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
    let calib = Calib::fit(&calib_m, &calib_y);
    let ev_idx: Vec<usize> = all.iter().copied().filter(|&i| oof_m[i].is_finite()).collect();
    let ey: Vec<f32> = ev_idx.iter().map(|&i| data.y[i]).collect();
    let ep: Vec<f64> = ev_idx.iter().map(|&i| calib.apply(oof_m[i])).collect();
    let pre = evaluate(&ey, &ep, 0.5);
    let threshold = if pre.best_csi > 0.0 { pre.best_csi_threshold } else { 0.5 };
    let m = evaluate(&ey, &ep, threshold);
    // training-set fit for reference
    let tp: Vec<f64> = (0..data.n).map(|i| calib.apply(final_learner.margin(data.row(i)))).collect();
    let tm = evaluate(&data.y, &tp, threshold);
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
    ctl.log(format!("{eval_kind}: ROC AUC {:.3}, PR AUC {:.3}, CSI {:.3} (POD {:.2}, FAR {:.2}) at threshold {:.2}", m.roc_auc, m.pr_auc, m.csi, m.pod, m.far, threshold));
    let metrics = json!({
        "eval": m,
        "eval_kind": eval_kind,
        "train_fit": {"roc_auc": tm.roc_auc, "pr_auc": tm.pr_auc, "brier": tm.brier, "csi": tm.csi},
        "iterations": iters,
        "dataset": {"samples": data.n, "positives": pos, "negatives": neg, "groups": groups_n},
        "calibration": calib,
    });
    Ok(Trained { learner: final_learner, calib, threshold, levels: Levels::from_threshold(threshold), metrics, importance, params: p.json() })
}

/// Quick fit without a job (tests / fixtures).
#[cfg(test)]
pub fn quick(spec: &TrainSpec, schema: &Schema, ids: &[String], samples: &[Sample]) -> Result<Trained> {
    train(spec, schema, ids, samples, &Ctl::detached())
}
