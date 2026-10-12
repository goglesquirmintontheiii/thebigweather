//! L2-regularised logistic regression on standardised features (missing → feature mean), fitted
//! by Newton / IRLS. A fast, well-calibrated baseline. Also hosts the standardiser shared with
//! the MLP.

use super::core::{logit, logloss, sigmoid, Data, Progress};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Standardizer {
    pub mean: Vec<f32>,
    pub std: Vec<f32>,
}

impl Standardizer {
    pub fn fit(d: &Data) -> Standardizer {
        let mut mean = vec![0.0f32; d.d];
        let mut std = vec![1.0f32; d.d];
        for j in 0..d.d {
            let v: Vec<f64> = (0..d.n).map(|i| d.at(i, j) as f64).filter(|x| x.is_finite()).collect();
            if v.is_empty() {
                continue;
            }
            let m = v.iter().sum::<f64>() / v.len() as f64;
            let s = (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
            mean[j] = m as f32;
            std[j] = if s > 1e-9 { s as f32 } else { 1.0 };
        }
        Standardizer { mean, std }
    }
    /// Standardised value (missing → 0, clipped to ±8 σ).
    #[inline]
    pub fn z(&self, j: usize, x: f32) -> f64 {
        if !x.is_finite() {
            return 0.0;
        }
        (((x - self.mean[j]) / self.std[j]) as f64).clamp(-8.0, 8.0)
    }
    pub fn row(&self, x: &[f32]) -> Vec<f64> {
        x.iter().enumerate().map(|(j, v)| self.z(j, *v)).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogRegParams {
    /// L2 penalty on standardised coefficients
    pub l2: f64,
    pub max_iter: usize,
    /// weight multiplier for positives; 0 = automatic
    pub scale_pos_weight: f64,
}

impl Default for LogRegParams {
    fn default() -> Self {
        Self { l2: 1.0, max_iter: 50, scale_pos_weight: 0.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogReg {
    pub scaler: Standardizer,
    pub coef: Vec<f64>,
    pub intercept: f64,
}

impl LogReg {
    pub fn margin(&self, x: &[f32]) -> f64 {
        self.intercept + x.iter().enumerate().map(|(j, v)| self.coef[j] * self.scaler.z(j, *v)).sum::<f64>()
    }
    pub fn contributions(&self, x: &[f32]) -> (Vec<f64>, f64) {
        (x.iter().enumerate().map(|(j, v)| self.coef[j] * self.scaler.z(j, *v)).collect(), self.intercept)
    }
    pub fn importance(&self) -> Vec<f64> {
        self.coef.iter().map(|c| c.abs()).collect()
    }
}

/// Solve A x = b for symmetric positive definite A (Cholesky), in place on copies.
fn cholesky_solve(a: &[f64], b: &[f64], n: usize) -> Option<Vec<f64>> {
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..=i {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= l[i * n + k] * l[j * n + k];
            }
            if i == j {
                if s <= 0.0 {
                    return None;
                }
                l[i * n + i] = s.sqrt();
            } else {
                l[i * n + j] = s / l[j * n + j];
            }
        }
    }
    let mut y = vec![0.0; n];
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= l[i * n + k] * y[k];
        }
        y[i] = s / l[i * n + i];
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut s = y[i];
        for k in i + 1..n {
            s -= l[k * n + i] * x[k];
        }
        x[i] = s / l[i * n + i];
    }
    Some(x)
}

pub fn fit(train: &Data, valid: Option<&Data>, p: &LogRegParams, progress: Progress) -> LogReg {
    let scaler = Standardizer::fit(train);
    let d = train.d;
    let n = train.n;
    let spw = super::gbdt::auto_spw(train, p.scale_pos_weight);
    let w: Vec<f64> = (0..n).map(|i| train.w[i] as f64 * if train.y[i] > 0.5 { spw } else { 1.0 }).collect();
    let z: Vec<Vec<f64>> = (0..n).map(|i| scaler.row(train.row(i))).collect();
    let sw: f64 = w.iter().sum();
    let pos: f64 = (0..n).filter(|&i| train.y[i] > 0.5).map(|i| w[i]).sum();
    let mut beta = vec![0.0; d + 1];
    beta[d] = if sw > 0.0 { logit(pos / sw) } else { 0.0 };
    let m = d + 1;
    let mut best: (f64, Vec<f64>) = (f64::INFINITY, beta.clone());
    for it in 0..p.max_iter.max(1) {
        let mut hmat = vec![0.0; m * m];
        let mut grad = vec![0.0; m];
        for i in 0..n {
            let eta = beta[d] + (0..d).map(|j| beta[j] * z[i][j]).sum::<f64>();
            let pr = sigmoid(eta);
            let r = (pr - train.y[i] as f64) * w[i];
            let s = (pr * (1.0 - pr)).max(1e-9) * w[i];
            for j in 0..m {
                let zj = if j == d { 1.0 } else { z[i][j] };
                grad[j] += r * zj;
                for k in 0..=j {
                    let zk = if k == d { 1.0 } else { z[i][k] };
                    hmat[j * m + k] += s * zj * zk;
                }
            }
        }
        // L2 on coefficients (scaled by total weight so the penalty is per-sample)
        let lam = p.l2 * sw / n.max(1) as f64;
        for j in 0..d {
            grad[j] += lam * beta[j];
            hmat[j * m + j] += lam;
        }
        for j in 0..m {
            for k in 0..j {
                hmat[k * m + j] = hmat[j * m + k];
            }
            hmat[j * m + j] += 1e-9;
        }
        let Some(step) = cholesky_solve(&hmat, &grad, m) else { break };
        let mx = step.iter().fold(0.0f64, |a, s| a.max(s.abs()));
        let damp = if mx > 5.0 { 5.0 / mx } else { 1.0 };
        for j in 0..m {
            beta[j] -= step[j] * damp;
        }
        let model = LogReg { scaler: scaler.clone(), coef: beta[..d].to_vec(), intercept: beta[d] };
        let tm: Vec<f64> = (0..n).map(|i| model.margin(train.row(i))).collect();
        let tl = logloss(&train.y, &train.w, &tm);
        let vl = match valid {
            Some(v) if v.n > 0 => {
                let vm: Vec<f64> = (0..v.n).map(|i| model.margin(v.row(i))).collect();
                logloss(&v.y, &v.w, &vm)
            }
            _ => tl,
        };
        if vl < best.0 {
            best = (vl, beta.clone());
        }
        if !progress(it + 1, p.max_iter, tl, vl) || mx * damp < 1e-6 {
            break;
        }
    }
    let beta = best.1;
    LogReg { scaler, coef: beta[..d].to_vec(), intercept: beta[d] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ml::core::{no_progress, synth};
    use crate::ml::metrics::roc_auc;

    #[test]
    fn logistic_learns_linear_signal() {
        let tr = synth(3000, 6, 3, 0.2, 11);
        let te = synth(1500, 6, 3, 0.2, 12);
        let m = fit(&tr, None, &LogRegParams::default(), &no_progress);
        let p: Vec<f64> = (0..te.n).map(|i| sigmoid(m.margin(te.row(i)))).collect();
        let auc = roc_auc(&te.y, &p, None);
        assert!(auc > 0.88, "{auc}");
        assert!(m.coef[0] > 0.5 && m.coef[1] < -0.3, "{:?}", m.coef);
        assert!(m.coef[4].abs() < 0.3);
        let (c, b) = m.contributions(te.row(0));
        assert!((c.iter().sum::<f64>() + b - m.margin(te.row(0))).abs() < 1e-9);
    }
}
