//! Small multilayer perceptron (1–2 ReLU hidden layers, sigmoid output) trained with Adam on
//! weighted log loss, mini-batches, early stopping on validation loss. Inputs are standardised
//! (missing → 0). Contributions are gradient × input (in standardised units).

use super::core::{logloss, Data, Progress, Rng};
use super::linear::Standardizer;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MlpParams {
    pub hidden1: usize,
    /// 0 = one hidden layer
    pub hidden2: usize,
    pub epochs: usize,
    pub batch: usize,
    pub learning_rate: f64,
    pub l2: f64,
    pub scale_pos_weight: f64,
    pub early_stopping_rounds: usize,
    pub seed: u64,
}

impl Default for MlpParams {
    fn default() -> Self {
        Self { hidden1: 32, hidden2: 16, epochs: 200, batch: 128, learning_rate: 0.003, l2: 1e-4, scale_pos_weight: 0.0, early_stopping_rounds: 20, seed: 42 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub w: Vec<f64>, // out × in
    pub b: Vec<f64>,
    pub nin: usize,
    pub nout: usize,
}

impl Layer {
    fn new(nin: usize, nout: usize, rng: &mut Rng) -> Self {
        let s = (2.0 / nin.max(1) as f64).sqrt();
        Layer { w: (0..nin * nout).map(|_| rng.normal() * s).collect(), b: vec![0.0; nout], nin, nout }
    }
    fn forward(&self, x: &[f64], relu: bool) -> Vec<f64> {
        (0..self.nout)
            .map(|o| {
                let v = self.b[o] + self.w[o * self.nin..(o + 1) * self.nin].iter().zip(x).map(|(w, x)| w * x).sum::<f64>();
                if relu { v.max(0.0) } else { v }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mlp {
    pub scaler: Standardizer,
    pub layers: Vec<Layer>,
}

impl Mlp {
    fn acts(&self, z: &[f64]) -> Vec<Vec<f64>> {
        let mut a = vec![z.to_vec()];
        for (k, l) in self.layers.iter().enumerate() {
            let next = l.forward(a.last().unwrap(), k + 1 < self.layers.len());
            a.push(next);
        }
        a
    }
    pub fn margin(&self, x: &[f32]) -> f64 {
        self.acts(&self.scaler.row(x)).last().unwrap()[0]
    }
    /// d margin / d input for the activations `a` (from `acts`).
    fn input_grad(&self, a: &[Vec<f64>]) -> Vec<f64> {
        let mut g = vec![1.0];
        for k in (0..self.layers.len()).rev() {
            let l = &self.layers[k];
            let mut gin = vec![0.0; l.nin];
            for o in 0..l.nout {
                for i in 0..l.nin {
                    gin[i] += g[o] * l.w[o * l.nin + i];
                }
            }
            if k > 0 {
                for (gi, ai) in gin.iter_mut().zip(&a[k]) {
                    if *ai <= 0.0 {
                        *gi = 0.0;
                    }
                }
            }
            g = gin;
        }
        g
    }
    pub fn contributions(&self, x: &[f32]) -> (Vec<f64>, f64) {
        let z = self.scaler.row(x);
        let a = self.acts(&z);
        let m = a.last().unwrap()[0];
        let g = self.input_grad(&a);
        let c: Vec<f64> = g.iter().zip(&z).map(|(g, z)| g * z).collect();
        let s: f64 = c.iter().sum();
        (c, m - s)
    }
    /// Mean |gradient × input| over a sample of rows.
    pub fn importance(&self, d: &Data) -> Vec<f64> {
        let step = (d.n / 2000).max(1);
        let mut imp = vec![0.0; d.d];
        for i in (0..d.n).step_by(step) {
            let (c, _) = self.contributions(d.row(i));
            for (a, b) in imp.iter_mut().zip(c) {
                *a += b.abs();
            }
        }
        imp
    }
}

struct Adam {
    m: Vec<Vec<f64>>,
    v: Vec<Vec<f64>>,
    t: i32,
}

fn params_mut(net: &mut Mlp) -> Vec<&mut Vec<f64>> {
    let mut out = vec![];
    for l in net.layers.iter_mut() {
        out.push(&mut l.w);
        out.push(&mut l.b);
    }
    out
}

pub fn fit(train: &Data, valid: Option<&Data>, p: &MlpParams, progress: Progress) -> Mlp {
    let scaler = Standardizer::fit(train);
    let d = train.d;
    let mut rng = Rng::new(p.seed);
    let mut sizes = vec![d, p.hidden1.max(1)];
    if p.hidden2 > 0 {
        sizes.push(p.hidden2);
    }
    sizes.push(1);
    let mut net = Mlp { scaler, layers: sizes.windows(2).map(|s| Layer::new(s[0], s[1], &mut rng)).collect() };
    let spw = super::gbdt::auto_spw(train, p.scale_pos_weight);
    let z: Vec<Vec<f64>> = (0..train.n).map(|i| net.scaler.row(train.row(i))).collect();
    let w: Vec<f64> = (0..train.n).map(|i| train.w[i] as f64 * if train.y[i] > 0.5 { spw } else { 1.0 }).collect();
    let wsum: f64 = w.iter().sum::<f64>().max(1e-9);
    let mut adam = Adam { m: vec![], v: vec![], t: 0 };
    for prm in params_mut(&mut net) {
        adam.m.push(vec![0.0; prm.len()]);
        adam.v.push(vec![0.0; prm.len()]);
    }
    let mut order: Vec<usize> = (0..train.n).collect();
    let mut best = (f64::INFINITY, net.clone(), 0usize);
    let vw: Vec<f32> = valid.map(|v| (0..v.n).map(|i| v.w[i] * if v.y[i] > 0.5 { spw as f32 } else { 1.0 }).collect()).unwrap_or_default();
    for ep in 0..p.epochs.max(1) {
        rng.shuffle(&mut order);
        for chunk in order.chunks(p.batch.max(8)) {
            // per-sample gradients in parallel, summed
            let grads: Vec<Vec<Vec<f64>>> = chunk
                .par_iter()
                .map(|&i| {
                    let a = net.acts(&z[i]);
                    let out = a.last().unwrap()[0];
                    let pr = super::core::sigmoid(out);
                    let mut delta = vec![(pr - train.y[i] as f64) * w[i] / wsum * train.n as f64];
                    let mut g: Vec<Vec<f64>> = vec![];
                    for k in (0..net.layers.len()).rev() {
                        let l = &net.layers[k];
                        let mut gw = vec![0.0; l.w.len()];
                        for o in 0..l.nout {
                            for ii in 0..l.nin {
                                gw[o * l.nin + ii] = delta[o] * a[k][ii];
                            }
                        }
                        let gb = delta.clone();
                        let mut din = vec![0.0; l.nin];
                        if k > 0 {
                            for o in 0..l.nout {
                                for ii in 0..l.nin {
                                    din[ii] += delta[o] * l.w[o * l.nin + ii];
                                }
                            }
                            for (dv, av) in din.iter_mut().zip(&a[k]) {
                                if *av <= 0.0 {
                                    *dv = 0.0;
                                }
                            }
                        }
                        g.push(gb);
                        g.push(gw);
                        delta = din;
                    }
                    g.reverse(); // [w0, b0, w1, b1, ...]
                    g
                })
                .collect();
            let bs = chunk.len() as f64;
            adam.t += 1;
            let (b1, b2, eps) = (0.9f64, 0.999f64, 1e-8);
            let lr = p.learning_rate * (1.0 - b2.powi(adam.t)).sqrt() / (1.0 - b1.powi(adam.t));
            let l2 = p.l2;
            for (pi, prm) in params_mut(&mut net).into_iter().enumerate() {
                for q in 0..prm.len() {
                    let mut gq: f64 = grads.iter().map(|g| g[pi][q]).sum::<f64>() / bs;
                    if pi % 2 == 0 {
                        gq += l2 * prm[q];
                    }
                    adam.m[pi][q] = b1 * adam.m[pi][q] + (1.0 - b1) * gq;
                    adam.v[pi][q] = b2 * adam.v[pi][q] + (1.0 - b2) * gq * gq;
                    prm[q] -= lr * adam.m[pi][q] / (adam.v[pi][q].sqrt() + eps);
                }
            }
        }
        let tm: Vec<f64> = (0..train.n).into_par_iter().map(|i| net.margin(train.row(i))).collect();
        let tl = logloss(&train.y, &train.w, &tm);
        let vl = match valid {
            Some(v) if v.n > 0 => {
                let vm: Vec<f64> = (0..v.n).into_par_iter().map(|i| net.margin(v.row(i))).collect();
                logloss(&v.y, &vw, &vm)
            }
            _ => tl,
        };
        if vl < best.0 - 1e-9 {
            best = (vl, net.clone(), ep);
        }
        if !progress(ep + 1, p.epochs, tl, vl) || (valid.is_some() && p.early_stopping_rounds > 0 && ep - best.2 >= p.early_stopping_rounds) {
            break;
        }
    }
    best.1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ml::core::{no_progress, sigmoid, synth};
    use crate::ml::metrics::roc_auc;

    #[test]
    fn mlp_learns() {
        let tr = synth(2000, 5, 3, 0.2, 21);
        let va = synth(500, 5, 3, 0.2, 22);
        let te = synth(1000, 5, 3, 0.2, 23);
        let m = fit(&tr, Some(&va), &MlpParams { epochs: 40, ..Default::default() }, &no_progress);
        let p: Vec<f64> = (0..te.n).map(|i| sigmoid(m.margin(te.row(i)))).collect();
        let auc = roc_auc(&te.y, &p, None);
        assert!(auc > 0.88, "{auc}");
        let (c, b) = m.contributions(te.row(0));
        assert!((c.iter().sum::<f64>() + b - m.margin(te.row(0))).abs() < 1e-9);
    }
}
