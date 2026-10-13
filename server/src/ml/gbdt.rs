//! Histogram gradient-boosted decision trees: binary classification (log loss) and regression
//! (squared error, Huber, quantile / pinball), with warm start (continue boosting an existing
//! ensemble on new data).
//!
//! * features are bucketed into ≤ 254 quantile bins (bin 255 = missing);
//! * trees grow depth-wise; each node's split is the best (feature, bin) by second-order gain
//!   `½·[G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ)] − γ`, with both children ≥ `min_child_weight`;
//! * missing values follow a learned default direction (tried both ways at every split);
//! * row subsampling and per-tree column sampling (seeded), L2 on leaf weights, shrinkage;
//! * `scale_pos_weight` multiplies positive sample weights (class balance);
//! * early stopping on a validation set keeps the best iteration;
//! * feature importance = total split gain; per-prediction contributions follow the decision
//!   path (Saabas): each split credits its feature with the change in expected node value.
//!
//! Histograms are built per feature in parallel (rayon) with the sibling-subtraction trick.

use super::core::{sigmoid, Data, Loss, Progress, Rng};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

pub const MISSING: u8 = 255;
const NB: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GbdtParams {
    pub n_trees: usize,
    pub max_depth: usize,
    pub learning_rate: f64,
    pub min_child_weight: f64,
    pub subsample: f64,
    pub colsample: f64,
    pub lambda: f64,
    pub gamma: f64,
    pub max_bins: usize,
    /// weight multiplier for positives; 0 = automatic (negatives / positives, capped at 50)
    pub scale_pos_weight: f64,
    pub early_stopping_rounds: usize,
    pub seed: u64,
    /// auto | logloss | squared | huber | quantile (regression targets)
    pub loss: String,
    /// Huber threshold (target units)
    pub huber_delta: f64,
    /// quantile of the main model when `loss = quantile`
    pub alpha: f64,
    /// extra quantile models trained next to a regression model (e.g. [0.1, 0.9] → P10 / P90)
    pub quantiles: Vec<f64>,
}

impl Default for GbdtParams {
    fn default() -> Self {
        Self {
            n_trees: 400,
            max_depth: 5,
            learning_rate: 0.06,
            min_child_weight: 2.0,
            subsample: 0.85,
            colsample: 0.8,
            lambda: 1.0,
            gamma: 0.0,
            max_bins: 64,
            scale_pos_weight: 0.0,
            early_stopping_rounds: 40,
            seed: 42,
            loss: "auto".into(),
            huber_delta: 1.0,
            alpha: 0.5,
            quantiles: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    /// feature index (u32::MAX = leaf)
    pub f: u32,
    /// x ≤ thr goes left
    pub thr: f32,
    /// missing goes left
    pub dl: bool,
    pub l: u32,
    pub r: u32,
    /// expected output of this node (leaf value for leaves), already scaled by the learning rate
    pub v: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tree {
    pub nodes: Vec<Node>,
}

impl Tree {
    #[inline]
    pub fn predict(&self, x: &[f32]) -> f32 {
        let mut k = 0usize;
        loop {
            let n = &self.nodes[k];
            if n.f == u32::MAX {
                return n.v;
            }
            let v = x[n.f as usize];
            k = if v.is_nan() { if n.dl { n.l } else { n.r } } else if v <= n.thr { n.l } else { n.r } as usize;
        }
    }
    /// Adds path contributions to `contrib` (per feature); returns the root value (bias part).
    pub fn contrib(&self, x: &[f32], contrib: &mut [f64]) -> f64 {
        let mut k = 0usize;
        let root = self.nodes[0].v as f64;
        loop {
            let n = &self.nodes[k];
            if n.f == u32::MAX {
                return root;
            }
            let v = x[n.f as usize];
            let next = if v.is_nan() { if n.dl { n.l } else { n.r } } else if v <= n.thr { n.l } else { n.r } as usize;
            contrib[n.f as usize] += (self.nodes[next].v - n.v) as f64;
            k = next;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gbdt {
    pub base: f64,
    pub trees: Vec<Tree>,
    /// total split gain per feature
    pub importance: Vec<f64>,
    pub best_iter: usize,
    /// training loss ("" / "logloss" = classification)
    #[serde(default)]
    pub loss: String,
}

impl Gbdt {
    pub fn margin(&self, x: &[f32]) -> f64 {
        self.base + self.trees.iter().map(|t| t.predict(x) as f64).sum::<f64>()
    }
    pub fn predict(&self, x: &[f32]) -> f64 {
        sigmoid(self.margin(x))
    }
    /// Per-feature margin contributions (sum + bias = margin).
    pub fn contributions(&self, x: &[f32]) -> (Vec<f64>, f64) {
        let mut c = vec![0.0; x.len()];
        let mut bias = self.base;
        for t in &self.trees {
            bias += t.contrib(x, &mut c);
        }
        (c, bias)
    }
}

/// Quantile bin edges per feature.
#[derive(Debug, Clone)]
pub struct Binner {
    pub edges: Vec<Vec<f32>>,
}

impl Binner {
    pub fn fit(data: &Data, max_bins: usize) -> Binner {
        let max_bins = max_bins.clamp(2, 254);
        let n = data.n;
        // sample at most 50k rows for the quantiles
        let step = (n / 50_000).max(1);
        let edges = (0..data.d)
            .into_par_iter()
            .map(|j| {
                let mut v: Vec<f32> = (0..n).step_by(step).map(|i| data.at(i, j)).filter(|x| x.is_finite()).collect();
                if v.is_empty() {
                    return vec![];
                }
                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                v.dedup();
                if v.len() <= max_bins {
                    // midpoints between distinct values
                    return v.windows(2).map(|w| w[0] + (w[1] - w[0]) * 0.5).collect();
                }
                let mut e: Vec<f32> = (1..max_bins).map(|q| v[(q * v.len() / max_bins).min(v.len() - 1)]).collect();
                e.dedup();
                e
            })
            .collect();
        Binner { edges }
    }
    #[inline]
    pub fn bin(&self, j: usize, x: f32) -> u8 {
        if !x.is_finite() {
            return MISSING;
        }
        self.edges[j].partition_point(|e| *e < x) as u8
    }
    /// Column-major binned matrix.
    pub fn transform(&self, data: &Data) -> Vec<Vec<u8>> {
        (0..data.d).into_par_iter().map(|j| (0..data.n).map(|i| self.bin(j, data.at(i, j))).collect()).collect()
    }
    /// Upper edge of bin `b` (x ≤ edge goes left).
    pub fn threshold(&self, j: usize, b: u8) -> f32 {
        self.edges[j].get(b as usize).copied().unwrap_or(f32::INFINITY)
    }
}

type Hist = Vec<[f64; 2]>; // NB entries of (G, H)

struct Ctx<'a> {
    bins: &'a [Vec<u8>],
    binner: &'a Binner,
    g: &'a [f64],
    h: &'a [f64],
    feats: Vec<usize>,
    p: &'a GbdtParams,
}

fn build_hist(ctx: &Ctx, rows: &[u32]) -> Vec<Hist> {
    ctx.feats
        .par_iter()
        .map(|&j| {
            let col = &ctx.bins[j];
            let mut h = vec![[0.0f64; 2]; NB];
            for &r in rows {
                let e = &mut h[col[r as usize] as usize];
                e[0] += ctx.g[r as usize];
                e[1] += ctx.h[r as usize];
            }
            h
        })
        .collect()
}

struct Split {
    fi: usize,
    bin: u8,
    dl: bool,
    gain: f64,
}

fn best_split(ctx: &Ctx, hist: &[Hist], gt: f64, ht: f64) -> Option<Split> {
    let lam = ctx.p.lambda;
    let mcw = ctx.p.min_child_weight;
    let parent = gt * gt / (ht + lam);
    hist.par_iter()
        .enumerate()
        .filter_map(|(fi, h)| {
            let nb = ctx.binner.edges[ctx.feats[fi]].len() + 1;
            if nb < 2 {
                return None;
            }
            let (gm, hm) = (h[MISSING as usize][0], h[MISSING as usize][1]);
            let mut best: Option<Split> = None;
            let (mut gl, mut hl) = (0.0, 0.0);
            for b in 0..nb - 1 {
                gl += h[b][0];
                hl += h[b][1];
                for dl in [false, true] {
                    if dl && hm <= 0.0 {
                        continue;
                    }
                    let (g_l, h_l) = if dl { (gl + gm, hl + hm) } else { (gl, hl) };
                    let (g_r, h_r) = (gt - g_l, ht - h_l);
                    if h_l < mcw || h_r < mcw {
                        continue;
                    }
                    let gain = 0.5 * (g_l * g_l / (h_l + lam) + g_r * g_r / (h_r + lam) - parent);
                    if best.as_ref().map(|s| gain > s.gain).unwrap_or(true) {
                        // with no missing values seen, send future missing to the larger side
                        let dl = if hm <= 0.0 { h_l >= h_r } else { dl };
                        best = Some(Split { fi, bin: b as u8, dl, gain });
                    }
                }
            }
            best
        })
        .reduce_with(|a, b| if b.gain > a.gain || (b.gain == a.gain && b.fi < a.fi) { b } else { a })
}

fn grow(ctx: &Ctx, nodes: &mut Vec<Node>, rows: Vec<u32>, hist: Vec<Hist>, depth: usize, importance: &mut [f64]) -> u32 {
    let (gt, ht) = hist.first().map(|h| h.iter().fold((0.0, 0.0), |a, e| (a.0 + e[0], a.1 + e[1]))).unwrap_or((0.0, 0.0));
    let lr = ctx.p.learning_rate;
    let value = (-gt / (ht + ctx.p.lambda) * lr) as f32;
    let id = nodes.len() as u32;
    nodes.push(Node { f: u32::MAX, thr: 0.0, dl: false, l: 0, r: 0, v: value });
    if depth >= ctx.p.max_depth || ht < 2.0 * ctx.p.min_child_weight || rows.len() < 2 {
        return id;
    }
    let Some(s) = best_split(ctx, &hist, gt, ht) else { return id };
    if s.gain <= ctx.p.gamma.max(1e-12) {
        return id;
    }
    let j = ctx.feats[s.fi];
    importance[j] += s.gain;
    let col = &ctx.bins[j];
    let (mut lrows, mut rrows) = (Vec::with_capacity(rows.len() / 2), Vec::with_capacity(rows.len() / 2));
    for r in rows {
        let b = col[r as usize];
        let left = if b == MISSING { s.dl } else { b <= s.bin };
        if left {
            lrows.push(r)
        } else {
            rrows.push(r)
        }
    }
    // histogram of the smaller child, the other by subtraction
    let small_left = lrows.len() <= rrows.len();
    let hs = build_hist(ctx, if small_left { &lrows } else { &rrows });
    let hb: Vec<Hist> = hist
        .iter()
        .zip(&hs)
        .map(|(p, c)| p.iter().zip(c).map(|(a, b)| [a[0] - b[0], a[1] - b[1]]).collect())
        .collect();
    drop(hist);
    let (hl, hr) = if small_left { (hs, hb) } else { (hb, hs) };
    nodes[id as usize].f = j as u32;
    nodes[id as usize].thr = ctx.binner.threshold(j, s.bin);
    nodes[id as usize].dl = s.dl;
    let l = grow(ctx, nodes, lrows, hl, depth + 1, importance);
    let r = grow(ctx, nodes, rrows, hr, depth + 1, importance);
    nodes[id as usize].l = l;
    nodes[id as usize].r = r;
    id
}

/// Effective positive weight multiplier.
pub fn auto_spw(train: &Data, spw: f64) -> f64 {
    if spw > 0.0 {
        return spw;
    }
    let pos = train.y.iter().zip(&train.w).filter(|(y, _)| **y > 0.5).map(|(_, w)| *w as f64).sum::<f64>();
    let neg = train.y.iter().zip(&train.w).filter(|(y, _)| **y <= 0.5).map(|(_, w)| *w as f64).sum::<f64>();
    if pos <= 0.0 { 1.0 } else { (neg / pos).clamp(1.0, 50.0) }
}

/// Fit a classifier on `train`; `valid` (if non-empty) drives early stopping.
pub fn fit(train: &Data, valid: Option<&Data>, p: &GbdtParams, progress: Progress) -> Gbdt {
    fit_with(train, valid, p, Loss::Logistic, None, progress)
}

/// Fit with any loss. `init`: continue boosting that ensemble (its base and trees are kept and
/// new trees are added on the residuals of `train`; early stopping may keep zero new trees).
pub fn fit_with(train: &Data, valid: Option<&Data>, p: &GbdtParams, loss: Loss, init: Option<&Gbdt>, progress: Progress) -> Gbdt {
    let n = train.n;
    let d = train.d;
    let cls = loss == Loss::Logistic;
    let spw = if cls { auto_spw(train, p.scale_pos_weight) } else { 1.0 };
    let w: Vec<f64> = (0..n).map(|i| train.w[i] as f64 * if cls && train.y[i] > 0.5 { spw } else { 1.0 }).collect();
    let init = init.filter(|m| m.importance.len() == d || m.trees.is_empty());
    let base = match init {
        Some(m) => m.base,
        None => loss.base(&train.y, &w),
    };
    let binner = Binner::fit(train, p.max_bins);
    let bins = binner.transform(train);
    let mut margin: Vec<f64> = match init {
        Some(m) => (0..n).into_par_iter().map(|i| m.margin(train.row(i))).collect(),
        None => vec![base; n],
    };
    let mut vmargin: Vec<f64> = match (valid, init) {
        (Some(v), Some(m)) => (0..v.n).into_par_iter().map(|i| m.margin(v.row(i))).collect(),
        (Some(v), None) => vec![base; v.n],
        _ => vec![],
    };
    // validation loss uses the same class weighting as training
    let vw: Vec<f32> = valid.map(|v| (0..v.n).map(|i| v.w[i] * if cls && v.y[i] > 0.5 { spw as f32 } else { 1.0 }).collect()).unwrap_or_default();
    let n0 = init.map(|m| m.trees.len()).unwrap_or(0);
    let mut rng = Rng::new(p.seed ^ (n0 as u64).wrapping_mul(0x9E37_79B9));
    let mut model = Gbdt {
        base,
        trees: init.map(|m| m.trees.clone()).unwrap_or_default(),
        importance: init.map(|m| m.importance.clone()).unwrap_or_else(|| vec![0.0; d]),
        best_iter: 0,
        loss: if cls { String::new() } else { loss.name() },
    };
    let mut imps: Vec<Vec<f64>> = vec![];
    let has_valid = valid.map(|v| v.n > 0).unwrap_or(false);
    // a warm start must beat the existing ensemble to add trees
    let start_vl = match (valid, init) {
        (Some(v), Some(_)) if v.n > 0 => loss.mean(&v.y, &vw, &vmargin),
        _ => f64::INFINITY,
    };
    let mut best = (start_vl, 0usize);
    let mut g = vec![0.0; n];
    let mut h = vec![0.0; n];
    for it in 0..p.n_trees.max(1) {
        for i in 0..n {
            let (gi, hi) = loss.grad_hess(margin[i], train.y[i] as f64);
            g[i] = gi * w[i];
            h[i] = hi * w[i];
        }
        let rows: Vec<u32> = if p.subsample < 1.0 { (0..n as u32).filter(|_| rng.f64() < p.subsample).collect() } else { (0..n as u32).collect() };
        let mut feats: Vec<usize> = (0..d).collect();
        if p.colsample < 1.0 && d > 1 {
            rng.shuffle(&mut feats);
            feats.truncate(((d as f64 * p.colsample).ceil() as usize).clamp(1, d));
            feats.sort_unstable();
        }
        let ctx = Ctx { bins: &bins, binner: &binner, g: &g, h: &h, feats, p };
        let root = build_hist(&ctx, &rows);
        let mut nodes = vec![];
        let mut imp = vec![0.0; d];
        grow(&ctx, &mut nodes, rows, root, 0, &mut imp);
        let tree = Tree { nodes };
        margin.par_iter_mut().enumerate().for_each(|(i, m)| *m += tree.predict(train.row(i)) as f64);
        let tl = loss.mean(&train.y, &train.w, &margin);
        let vl = match valid {
            Some(v) if v.n > 0 => {
                vmargin.par_iter_mut().enumerate().for_each(|(i, m)| *m += tree.predict(v.row(i)) as f64);
                loss.mean(&v.y, &vw, &vmargin)
            }
            _ => tl,
        };
        model.trees.push(tree);
        imps.push(imp);
        if vl < best.0 - 1e-9 {
            best = (vl, it + 1);
        }
        let more = progress(it + 1, p.n_trees, tl, vl);
        if !more || (has_valid && p.early_stopping_rounds > 0 && it + 1 - best.1 >= p.early_stopping_rounds) {
            break;
        }
    }
    let added = model.trees.len() - n0;
    let keep = if has_valid { if init.is_some() { best.1 } else { best.1.max(1) } } else { added };
    model.trees.truncate(n0 + keep);
    for imp in imps.iter().take(keep) {
        for (a, b) in model.importance.iter_mut().zip(imp) {
            *a += b;
        }
    }
    model.best_iter = model.trees.len();
    model
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ml::core::{no_progress, synth};
    use crate::ml::metrics::roc_auc;

    #[test]
    fn learns_separable_and_nonlinear() {
        let tr = synth(4000, 8, 3, 0.3, 1);
        let te = synth(2000, 8, 3, 0.3, 2);
        let va = synth(1000, 8, 3, 0.3, 3);
        let m = fit(&tr, Some(&va), &GbdtParams::default(), &no_progress);
        let p: Vec<f64> = (0..te.n).map(|i| m.predict(te.row(i))).collect();
        let auc = roc_auc(&te.y, &p, None);
        assert!(auc > 0.9, "auc {auc}");
        // the informative features dominate importance
        let top: f64 = m.importance[..3].iter().sum();
        let rest: f64 = m.importance[3..].iter().sum();
        assert!(top > 3.0 * rest, "{:?}", m.importance);
        // contributions add up to the margin
        let (c, b) = m.contributions(te.row(0));
        assert!((c.iter().sum::<f64>() + b - m.margin(te.row(0))).abs() < 1e-4);
        // deterministic
        let m2 = fit(&tr, Some(&va), &GbdtParams::default(), &no_progress);
        assert_eq!(m.trees.len(), m2.trees.len());
        assert_eq!(m.predict(te.row(5)), m2.predict(te.row(5)));
    }

    #[test]
    fn pure_noise_stays_near_chance_and_stops_early() {
        let mut tr = synth(3000, 6, 0, 1.0, 4);
        let mut va = synth(1000, 6, 0, 1.0, 5);
        let mut r = Rng::new(9);
        for y in tr.y.iter_mut().chain(va.y.iter_mut()) {
            *y = if r.f64() < 0.3 { 1.0 } else { 0.0 };
        }
        let m = fit(&tr, Some(&va), &GbdtParams { n_trees: 500, ..Default::default() }, &no_progress);
        assert!(m.trees.len() < 150, "{}", m.trees.len());
        let p: Vec<f64> = (0..va.n).map(|i| m.predict(va.row(i))).collect();
        let auc = roc_auc(&va.y, &p, None);
        assert!((0.4..0.62).contains(&auc), "{auc}");
    }

    #[test]
    fn missing_values_take_learned_direction() {
        // positives have feature 0 missing; negatives have it present
        let mut d = Data::new(2);
        let mut r = Rng::new(3);
        for i in 0..2000 {
            let pos = i % 3 == 0;
            let x0 = if pos { f32::NAN } else { r.normal() as f32 };
            d.push(&[x0, r.normal() as f32], if pos { 1.0 } else { 0.0 }, 1.0);
        }
        let m = fit(&d, None, &GbdtParams { n_trees: 30, ..Default::default() }, &no_progress);
        assert!(m.predict(&[f32::NAN, 0.0]) > 0.9);
        assert!(m.predict(&[0.3, 0.0]) < 0.1);
    }

    #[test]
    fn regression_losses_and_warm_start() {
        use crate::ml::core::synth_reg;
        let tr = synth_reg(3000, 6, 0.5, 31);
        let va = synth_reg(800, 6, 0.5, 32);
        let te = synth_reg(1500, 6, 0.5, 33);
        let p = GbdtParams { n_trees: 300, learning_rate: 0.1, ..Default::default() };
        let m = fit_with(&tr, Some(&va), &p, Loss::Squared, None, &no_progress);
        let pred: Vec<f64> = (0..te.n).map(|i| m.margin(te.row(i))).collect();
        let r = crate::ml::metrics::evaluate_reg(&te.y, &pred, 10.0, None);
        assert!(r.r2 > 0.85 && r.rmse < 1.5, "{r:?}");
        assert!(r.bias.abs() < 0.2);
        assert_eq!(m.loss, "squared");
        // quantiles bracket the median
        let lo = fit_with(&tr, None, &GbdtParams { n_trees: 150, learning_rate: 0.1, ..Default::default() }, Loss::Quantile(0.1), None, &no_progress);
        let hi = fit_with(&tr, None, &GbdtParams { n_trees: 150, learning_rate: 0.1, ..Default::default() }, Loss::Quantile(0.9), None, &no_progress);
        let cover = (0..te.n).filter(|&i| (te.y[i] as f64) >= lo.margin(te.row(i)) && (te.y[i] as f64) <= hi.margin(te.row(i))).count() as f64 / te.n as f64;
        assert!(cover > 0.6 && cover < 0.95, "coverage {cover}");
        let hub = fit_with(&tr, Some(&va), &p, Loss::Huber(1.0), None, &no_progress);
        assert!((0..50).all(|i| hub.margin(te.row(i)).is_finite()));
        // warm start: a short model continued on more data lowers the training loss, keeps the old trees
        let short = fit_with(&tr, None, &GbdtParams { n_trees: 20, ..p.clone() }, Loss::Squared, None, &no_progress);
        let before = Loss::Squared.mean(&tr.y, &tr.w, &(0..tr.n).map(|i| short.margin(tr.row(i))).collect::<Vec<_>>());
        let cont = fit_with(&tr, None, &GbdtParams { n_trees: 40, ..p.clone() }, Loss::Squared, Some(&short), &no_progress);
        let after = Loss::Squared.mean(&tr.y, &tr.w, &(0..tr.n).map(|i| cont.margin(tr.row(i))).collect::<Vec<_>>());
        assert!(after < before * 0.8, "{before} -> {after}");
        assert_eq!(cont.trees.len(), 60);
        assert_eq!(cont.base, short.base);
        assert_eq!(cont.trees[0].nodes.len(), short.trees[0].nodes.len());
        // classification warm start too
        let c = synth(2000, 5, 3, 0.3, 41);
        let a = fit(&c, None, &GbdtParams { n_trees: 10, ..Default::default() }, &no_progress);
        let b = fit_with(&c, None, &GbdtParams { n_trees: 30, ..Default::default() }, Loss::Logistic, Some(&a), &no_progress);
        let ll = |m: &Gbdt| crate::ml::core::logloss(&c.y, &c.w, &(0..c.n).map(|i| m.margin(c.row(i))).collect::<Vec<_>>());
        assert!(ll(&b) < ll(&a));
    }

    #[test]
    fn stop_callback_keeps_trees() {
        let tr = synth(1000, 4, 2, 0.3, 7);
        let stop = |it: usize, _: usize, _: f64, _: f64| it < 5;
        let m = fit(&tr, None, &GbdtParams::default(), &stop);
        assert_eq!(m.trees.len(), 5);
    }
}
