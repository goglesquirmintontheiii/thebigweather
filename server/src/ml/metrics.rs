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
