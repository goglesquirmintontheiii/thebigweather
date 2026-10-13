//! L2-regularised logistic regression on standardised features (missing → feature mean), fitted
//! by Newton / IRLS, and ridge (linear) regression in closed form. Both can be warm-started from
//! an existing model (continued training keeps its standardiser). Also hosts the standardiser
//! shared with the MLP.

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
    /// continued training (ridge): pull towards the previous coefficients with this weight
    pub prior: f64,
}

impl Default for LogRegParams {
    fn default() -> Self {
        Self { l2: 1.0, max_iter: 50, scale_pos_weight: 0.0, prior: 1.0 }
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
    fit_init(train, valid, p, None, progress)
}

/// Logistic fit, optionally continuing from `init` (its standardiser and coefficients).
pub fn fit_init(train: &Data, valid: Option<&Data>, p: &LogRegParams, init: Option<&LogReg>, progress: Progress) -> LogReg {
    let d = train.d;
    let init = init.filter(|m| m.coef.len() == d);
    let scaler = init.map(|m| m.scaler.clone()).unwrap_or_else(|| Standardizer::fit(train));
    let n = train.n;
    let spw = super::gbdt::auto_spw(train, p.scale_pos_weight);
    let w: Vec<f64> = (0..n).map(|i| train.w[i] as f64 * if train.y[i] > 0.5 { spw } else { 1.0 }).collect();
    let z: Vec<Vec<f64>> = (0..n).map(|i| scaler.row(train.row(i))).collect();
    let sw: f64 = w.iter().sum();
    let pos: f64 = (0..n).filter(|&i| train.y[i] > 0.5).map(|i| w[i]).sum();
    let mut beta = vec![0.0; d + 1];
    beta[d] = if sw > 0.0 { logit(pos / sw) } else { 0.0 };
    if let Some(m) = init {
        beta[..d].copy_from_slice(&m.coef);
        beta[d] = m.intercept;
    }
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

/// Ridge regression (weighted least squares on standardised features, unpenalised intercept).
/// With `init`, keeps its standardiser and shrinks towards its coefficients (`p.prior`), so
/// training further on new data updates rather than replaces the fit.
pub fn fit_ridge(train: &Data, valid: Option<&Data>, p: &LogRegParams, init: Option<&LogReg>, progress: Progress) -> LogReg {
    let d = train.d;
    let init = init.filter(|m| m.coef.len() == d);
    let scaler = init.map(|m| m.scaler.clone()).unwrap_or_else(|| Standardizer::fit(train));
    let n = train.n;
    let m = d + 1;
    let mut a = vec![0.0; m * m];
    let mut b = vec![0.0; m];
    let mut sw = 0.0;
    for i in 0..n {
        let wi = train.w[i] as f64;
        let mut z = scaler.row(train.row(i));
        z.push(1.0);
        let yi = train.y[i] as f64;
        sw += wi;
        for j in 0..m {
            b[j] += wi * z[j] * yi;
            for k in 0..=j {
                a[j * m + k] += wi * z[j] * z[k];
            }
        }
    }
    let lam = p.l2.max(0.0) * sw / n.max(1) as f64;
    let mu = if init.is_some() { p.prior.max(0.0) * sw / n.max(1) as f64 } else { 0.0 };
    for j in 0..m {
        for k in 0..j {
            a[k * m + j] = a[j * m + k];
        }
        if j < d {
            a[j * m + j] += lam + mu;
            if let Some(im) = init {
                b[j] += mu * im.coef[j];
            }
        }
        a[j * m + j] += 1e-9;
    }
    let beta = cholesky_solve(&a, &b, m).unwrap_or_else(|| {
        let mut v = vec![0.0; m];
        v[d] = if sw > 0.0 { (0..n).map(|i| train.y[i] as f64 * train.w[i] as f64).sum::<f64>() / sw } else { 0.0 };
        v
    });
    let model = LogReg { scaler, coef: beta[..d].to_vec(), intercept: beta[d] };
    let mse = |data: &Data| -> f64 {
        let (mut s, mut w) = (0.0, 0.0);
        for i in 0..data.n {
            s += (model.margin(data.row(i)) - data.y[i] as f64).powi(2) * data.w[i] as f64;
            w += data.w[i] as f64;
        }
        if w > 0.0 { s / w } else { 0.0 }
    };
    let tl = mse(train);
    let vl = valid.filter(|v| v.n > 0).map(mse).unwrap_or(tl);
    progress(1, 1, tl, vl);
    model
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
        // warm start keeps the scaler and does not get worse on the training data
        let short = fit(&tr, None, &LogRegParams { max_iter: 1, ..Default::default() }, &no_progress);
        let more = fit_init(&tr, None, &LogRegParams::default(), Some(&short), &no_progress);
        let ll = |m: &LogReg| crate::ml::core::logloss(&tr.y, &tr.w, &(0..tr.n).map(|i| m.margin(tr.row(i))).collect::<Vec<_>>());
        assert!(ll(&more) < ll(&short));
        assert_eq!(more.scaler.mean, short.scaler.mean);
    }

    #[test]
    fn ridge_regression_and_continue() {
        use crate::ml::core::synth_reg;
        let tr = synth_reg(2000, 5, 0.3, 5);
        let te = synth_reg(1000, 5, 0.3, 6);
        let m = fit_ridge(&tr, None, &LogRegParams { l2: 0.01, ..Default::default() }, None, &no_progress);
        let p: Vec<f64> = (0..te.n).map(|i| m.margin(te.row(i))).collect();
        let r = crate::ml::metrics::evaluate_reg(&te.y, &p, 10.0, None);
        assert!(r.r2 > 0.7, "{r:?}");
        assert!((m.intercept - 10.0).abs() < 0.3, "{}", m.intercept);
        // continue on shifted data moves towards it, but less than a fresh fit
        let mut sh = synth_reg(500, 5, 0.3, 7);
        for y in sh.y.iter_mut() {
            *y += 5.0;
        }
        let c = fit_ridge(&sh, None, &LogRegParams { l2: 0.01, prior: 1.0, ..Default::default() }, Some(&m), &no_progress);
        assert!(c.intercept > m.intercept + 3.0);
        assert_eq!(c.scaler.mean, m.scaler.mean);
    }
}
