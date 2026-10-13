//! Verification metrics for probabilistic binary detections and grouped cross-validation folds.

use super::core::{hash_str, Rng};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Confusion {
    pub tp: f64,
    pub fp: f64,
    pub tn: f64,
    #[serde(rename = "fn")]
    pub fn_: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RelBin {
    pub lo: f64,
    pub hi: f64,
    pub n: usize,
    pub mean_pred: f64,
    pub obs_freq: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Metrics {
    pub n: usize,
    pub positives: usize,
    pub base_rate: f64,
    pub roc_auc: f64,
    pub pr_auc: f64,
    pub brier: f64,
    pub logloss: f64,
    pub threshold: f64,
    pub pod: f64,
    pub far: f64,
    pub csi: f64,
    pub pofd: f64,
    pub best_csi_threshold: f64,
    pub best_csi: f64,
    pub confusion: Confusion,
    pub reliability: Vec<RelBin>,
}

/// ROC AUC (weighted, ties averaged).
pub fn roc_auc(y: &[f32], p: &[f64], w: Option<&[f32]>) -> f64 {
    let mut idx: Vec<usize> = (0..y.len()).collect();
    idx.sort_by(|&a, &b| p[a].partial_cmp(&p[b]).unwrap_or(std::cmp::Ordering::Equal));
    let wt = |i: usize| w.map(|w| w[i] as f64).unwrap_or(1.0);
    let (mut tp, mut fp) = (0.0, 0.0);
    let pos: f64 = idx.iter().filter(|&&i| y[i] > 0.5).map(|&i| wt(i)).sum();
    let neg: f64 = idx.iter().filter(|&&i| y[i] <= 0.5).map(|&i| wt(i)).sum();
    if pos <= 0.0 || neg <= 0.0 {
        return 0.5;
    }
    // sweep from high to low scores, trapezoids per tie group
    let mut area = 0.0;
    let mut k = idx.len();
    while k > 0 {
        let s = p[idx[k - 1]];
        let (mut dtp, mut dfp) = (0.0, 0.0);
        while k > 0 && p[idx[k - 1]] == s {
            let i = idx[k - 1];
            if y[i] > 0.5 {
                dtp += wt(i)
            } else {
                dfp += wt(i)
            }
            k -= 1;
        }
        area += dfp * (tp + dtp / 2.0);
        tp += dtp;
        fp += dfp;
    }
    let _ = fp;
    area / (pos * neg)
}

/// Area under the precision–recall curve (average precision).
pub fn pr_auc(y: &[f32], p: &[f64], w: Option<&[f32]>) -> f64 {
    let mut idx: Vec<usize> = (0..y.len()).collect();
    idx.sort_by(|&a, &b| p[b].partial_cmp(&p[a]).unwrap_or(std::cmp::Ordering::Equal));
    let wt = |i: usize| w.map(|w| w[i] as f64).unwrap_or(1.0);
    let pos: f64 = idx.iter().filter(|&&i| y[i] > 0.5).map(|&i| wt(i)).sum();
    if pos <= 0.0 {
        return 0.0;
    }
    let (mut tp, mut fp, mut ap, mut last_recall) = (0.0, 0.0, 0.0, 0.0);
    let mut k = 0;
    while k < idx.len() {
        let s = p[idx[k]];
        while k < idx.len() && p[idx[k]] == s {
            let i = idx[k];
            if y[i] > 0.5 {
                tp += wt(i)
            } else {
                fp += wt(i)
            }
            k += 1;
        }
        let recall = tp / pos;
        let prec = if tp + fp > 0.0 { tp / (tp + fp) } else { 1.0 };
        ap += (recall - last_recall) * prec;
        last_recall = recall;
    }
    ap
}

pub fn confusion(y: &[f32], p: &[f64], w: Option<&[f32]>, thr: f64) -> Confusion {
    let mut c = Confusion::default();
    for i in 0..y.len() {
        let wt = w.map(|w| w[i] as f64).unwrap_or(1.0);
        match (p[i] >= thr, y[i] > 0.5) {
            (true, true) => c.tp += wt,
            (true, false) => c.fp += wt,
            (false, true) => c.fn_ += wt,
            (false, false) => c.tn += wt,
        }
    }
    c
}

fn scores(c: &Confusion) -> (f64, f64, f64, f64) {
    let pod = if c.tp + c.fn_ > 0.0 { c.tp / (c.tp + c.fn_) } else { 0.0 };
    let far = if c.tp + c.fp > 0.0 { c.fp / (c.tp + c.fp) } else { 0.0 };
    let csi = if c.tp + c.fp + c.fn_ > 0.0 { c.tp / (c.tp + c.fp + c.fn_) } else { 0.0 };
    let pofd = if c.fp + c.tn > 0.0 { c.fp / (c.fp + c.tn) } else { 0.0 };
    (pod, far, csi, pofd)
}

/// Threshold (0.02 steps) maximising CSI.
pub fn best_csi(y: &[f32], p: &[f64], w: Option<&[f32]>) -> (f64, f64) {
    let mut best = (0.5, -1.0);
    for k in 1..50 {
        let t = k as f64 * 0.02;
        let (_, _, csi, _) = scores(&confusion(y, p, w, t));
        if csi > best.1 + 1e-12 {
            best = (t, csi);
        }
    }
    (best.0, best.1.max(0.0))
}

pub fn reliability(y: &[f32], p: &[f64], bins: usize) -> Vec<RelBin> {
    let mut out: Vec<RelBin> = (0..bins).map(|b| RelBin { lo: b as f64 / bins as f64, hi: (b + 1) as f64 / bins as f64, ..Default::default() }).collect();
    let mut sums = vec![(0.0, 0.0); bins];
    for i in 0..y.len() {
        let b = ((p[i] * bins as f64) as usize).min(bins - 1);
        out[b].n += 1;
        sums[b].0 += p[i];
        sums[b].1 += y[i] as f64;
    }
    for (o, s) in out.iter_mut().zip(sums) {
        if o.n > 0 {
            o.mean_pred = round4(s.0 / o.n as f64);
            o.obs_freq = round4(s.1 / o.n as f64);
        }
    }
    out
}

fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

/// All metrics at `thr` (the best-CSI threshold is reported alongside).
pub fn evaluate(y: &[f32], p: &[f64], thr: f64) -> Metrics {
    let n = y.len();
    let positives = y.iter().filter(|v| **v > 0.5).count();
    let brier = if n > 0 { y.iter().zip(p).map(|(y, p)| (p - *y as f64).powi(2)).sum::<f64>() / n as f64 } else { 0.0 };
    let ll = if n > 0 {
        y.iter().zip(p).map(|(y, p)| {
            let p = p.clamp(1e-12, 1.0 - 1e-12);
            if *y > 0.5 { -p.ln() } else { -(1.0 - p).ln() }
        }).sum::<f64>() / n as f64
    } else {
        0.0
    };
    let c = confusion(y, p, None, thr);
    let (pod, far, csi, pofd) = scores(&c);
    let (bt, bc) = best_csi(y, p, None);
    Metrics {
        n,
        positives,
        base_rate: if n > 0 { round4(positives as f64 / n as f64) } else { 0.0 },
        roc_auc: round4(roc_auc(y, p, None)),
        pr_auc: round4(pr_auc(y, p, None)),
        brier: round4(brier),
        logloss: round4(ll),
        threshold: round4(thr),
        pod: round4(pod),
        far: round4(far),
        csi: round4(csi),
        pofd: round4(pofd),
        best_csi_threshold: round4(bt),
        best_csi: round4(bc),
        confusion: c,
        reliability: reliability(y, p, 10),
    }
}

/// Verification of a regression (continuous) forecast.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RegMetrics {
    pub n: usize,
    pub mean_obs: f64,
    pub mean_pred: f64,
    pub mae: f64,
    pub rmse: f64,
    /// mean(pred − obs)
    pub bias: f64,
    pub r2: f64,
    /// climatology baseline (training mean): RMSE and skill = 1 − MSE / MSE_clim
    pub rmse_clim: f64,
    pub skill_clim: f64,
    /// persistence baseline (the current observation), when known for the samples
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rmse_persistence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mae_persistence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_persistence: Option<f64>,
    /// samples where the persistence baseline was available
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n_persistence: Option<usize>,
    /// headline skill: vs persistence when known, else vs climatology
    pub skill: f64,
    /// mean observation per predicted-value decile (calibration of the forecast values)
    pub reliability: Vec<RelBin>,
}

/// Regression metrics; `clim` = climatological (training-mean) forecast, `persist` = the
/// persistence forecast per sample (NaN = unknown).
pub fn evaluate_reg(y: &[f32], p: &[f64], clim: f64, persist: Option<&[f64]>) -> RegMetrics {
    let n = y.len();
    if n == 0 {
        return RegMetrics::default();
    }
    let nf = n as f64;
    let mean_obs = y.iter().map(|v| *v as f64).sum::<f64>() / nf;
    let mean_pred = p.iter().sum::<f64>() / nf;
    let mut mae = 0.0;
    let mut mse = 0.0;
    let mut bias = 0.0;
    let mut sst = 0.0;
    let mut mse_c = 0.0;
    for i in 0..n {
        let e = p[i] - y[i] as f64;
        mae += e.abs();
        mse += e * e;
        bias += e;
        sst += (y[i] as f64 - mean_obs).powi(2);
        mse_c += (clim - y[i] as f64).powi(2);
    }
    mae /= nf;
    mse /= nf;
    bias /= nf;
    mse_c /= nf;
    let r2 = if sst > 0.0 { 1.0 - mse * nf / sst } else { 0.0 };
    let (mut rp, mut ap, mut sp, mut np) = (None, None, None, None);
    if let Some(ps) = persist {
        let idx: Vec<usize> = (0..n).filter(|&i| ps[i].is_finite()).collect();
        if !idx.is_empty() {
            let k = idx.len() as f64;
            let mse_p = idx.iter().map(|&i| (ps[i] - y[i] as f64).powi(2)).sum::<f64>() / k;
            let mae_p = idx.iter().map(|&i| (ps[i] - y[i] as f64).abs()).sum::<f64>() / k;
            let mse_m = idx.iter().map(|&i| (p[i] - y[i] as f64).powi(2)).sum::<f64>() / k;
            rp = Some(round4(mse_p.sqrt()));
            ap = Some(round4(mae_p));
            sp = Some(round4(if mse_p > 0.0 { 1.0 - mse_m / mse_p } else { 0.0 }));
            np = Some(idx.len());
        }
    }
    // reliability by predicted-value deciles
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| p[a].partial_cmp(&p[b]).unwrap_or(std::cmp::Ordering::Equal));
    let bins = 10.min(n);
    let reliability = (0..bins)
        .map(|b| {
            let part = &order[b * n / bins..(b + 1) * n / bins];
            let k = part.len().max(1) as f64;
            RelBin {
                lo: round4(part.first().map(|&i| p[i]).unwrap_or(0.0)),
                hi: round4(part.last().map(|&i| p[i]).unwrap_or(0.0)),
                n: part.len(),
                mean_pred: round4(part.iter().map(|&i| p[i]).sum::<f64>() / k),
                obs_freq: round4(part.iter().map(|&i| y[i] as f64).sum::<f64>() / k),
            }
        })
        .collect();
    RegMetrics {
        n,
        mean_obs: round4(mean_obs),
        mean_pred: round4(mean_pred),
        mae: round4(mae),
        rmse: round4(mse.sqrt()),
        bias: round4(bias),
        r2: round4(r2),
        rmse_clim: round4(mse_c.sqrt()),
        skill_clim: round4(if mse_c > 0.0 { 1.0 - mse / mse_c } else { 0.0 }),
        rmse_persistence: rp,
        mae_persistence: ap,
        skill_persistence: sp,
        n_persistence: np,
        skill: sp.unwrap_or(round4(if mse_c > 0.0 { 1.0 - mse / mse_c } else { 0.0 })),
        reliability,
    }
}

/// Fold (0..k) per sample such that every group lands in one fold; groups containing positives
/// are spread evenly first (stratified by group).
pub fn group_folds(groups: &[String], y: &[f32], k: usize, seed: u64) -> Vec<usize> {
    let k = k.max(2);
    let mut has_pos: HashMap<&str, bool> = HashMap::new();
    for (g, y) in groups.iter().zip(y) {
        let e = has_pos.entry(g.as_str()).or_insert(false);
        *e |= *y > 0.5;
    }
    let mut keys: Vec<(&str, bool)> = has_pos.into_iter().collect();
    keys.sort_by(|a, b| (!a.1).cmp(&(!b.1)).then(hash_str(a.0).wrapping_add(seed).cmp(&hash_str(b.0).wrapping_add(seed))).then(a.0.cmp(b.0)));
    let mut rng = Rng::new(seed);
    // shuffle within each stratum, then deal round-robin
    let split = keys.iter().position(|x| !x.1).unwrap_or(keys.len());
    rng.shuffle(&mut keys[..split]);
    rng.shuffle(&mut keys[split..]);
    let fold_of: HashMap<&str, usize> = keys.iter().enumerate().map(|(i, (g, _))| (*g, i % k)).collect();
    groups.iter().map(|g| fold_of[g.as_str()]).collect()
}

/// Split groups into (train, holdout) sample indices with about `frac` of groups held out.
pub fn group_holdout(groups: &[String], y: &[f32], frac: f64, seed: u64) -> (Vec<usize>, Vec<usize>) {
    let k = ((1.0 / frac.clamp(0.05, 0.5)).round() as usize).max(2);
    let f = group_folds(groups, y, k, seed);
    let (mut a, mut b) = (vec![], vec![]);
    for (i, fi) in f.iter().enumerate() {
        if *fi == 0 { b.push(i) } else { a.push(i) }
    }
    (a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auc_and_scores() {
        let y = [0.0, 0.0, 1.0, 1.0];
        assert_eq!(roc_auc(&y, &[0.1, 0.4, 0.35, 0.8], None), 0.75);
        assert_eq!(roc_auc(&y, &[0.1, 0.2, 0.8, 0.9], None), 1.0);
        assert_eq!(roc_auc(&y, &[0.5, 0.5, 0.5, 0.5], None), 0.5);
        assert!((pr_auc(&y, &[0.1, 0.2, 0.8, 0.9], None) - 1.0).abs() < 1e-9);
        let m = evaluate(&y, &[0.1, 0.6, 0.7, 0.9], 0.5);
        assert_eq!(m.confusion.tp, 2.0);
        assert_eq!(m.confusion.fp, 1.0);
        assert!((m.csi - 2.0 / 3.0).abs() < 1e-3 && (m.far - 1.0 / 3.0).abs() < 1e-3 && m.pod == 1.0);
        assert!(m.best_csi >= m.csi);
        assert!(m.best_csi_threshold > 0.6);
        assert_eq!(m.reliability.len(), 10);
    }

    #[test]
    fn regression_metrics() {
        let y = [1.0f32, 2.0, 3.0, 4.0];
        let r = evaluate_reg(&y, &[1.5, 2.5, 3.5, 4.5], 2.5, Some(&[0.0, 1.0, f64::NAN, 3.0]));
        assert_eq!(r.mae, 0.5);
        assert_eq!(r.bias, 0.5);
        assert_eq!(r.rmse, 0.5);
        assert!((r.r2 - 0.8).abs() < 1e-9);
        assert!((r.skill_clim - 0.8).abs() < 1e-9);
        assert_eq!(r.n_persistence, Some(3));
        assert_eq!(r.rmse_persistence, Some(1.0));
        assert!((r.skill_persistence.unwrap() - 0.75).abs() < 1e-9);
    }

    #[test]
    fn folds_keep_groups_together() {
        let groups: Vec<String> = (0..300).map(|i| format!("ev{}", i / 3)).collect();
        let y: Vec<f32> = (0..300).map(|i| if (i / 3) % 5 == 0 { 1.0 } else { 0.0 }).collect();
        let f = group_folds(&groups, &y, 5, 7);
        for i in 0..300 {
            assert_eq!(f[i], f[i / 3 * 3]);
        }
        // positives spread across all folds
        for k in 0..5 {
            assert!((0..300).any(|i| f[i] == k && y[i] > 0.5));
        }
        let (a, b) = group_holdout(&groups, &y, 0.2, 1);
        assert_eq!(a.len() + b.len(), 300);
        assert!(b.len() > 30 && b.len() < 90);
    }
}
