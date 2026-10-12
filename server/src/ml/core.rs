//! Shared pieces of the learners: a deterministic RNG, the training matrix, logistic helpers and
//! the progress / stop callback.

/// SplitMix64: small, fast and fully deterministic for a seed (independent of the `rand` crate).
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Uniform integer in [0, n).
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_u64() % n as u64) as usize
    }
    /// Standard normal (Box-Muller).
    pub fn normal(&mut self) -> f64 {
        let u1 = self.f64().max(1e-300);
        let u2 = self.f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }
    pub fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = self.below(i + 1);
            v.swap(i, j);
        }
    }
}

/// Stable 64-bit hash of a string (FNV-1a), for seeds and fold assignment.
pub fn hash_str(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Row-major training matrix (NaN = missing) with labels, weights and group (event) ids.
#[derive(Clone, Debug, Default)]
pub struct Data {
    pub n: usize,
    pub d: usize,
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub w: Vec<f32>,
}

impl Data {
    pub fn new(d: usize) -> Self {
        Data { n: 0, d, ..Default::default() }
    }
    pub fn push(&mut self, row: &[f32], y: f32, w: f32) {
        debug_assert_eq!(row.len(), self.d);
        self.x.extend_from_slice(row);
        self.y.push(y);
        self.w.push(w);
        self.n += 1;
    }
    #[inline]
    pub fn row(&self, i: usize) -> &[f32] {
        &self.x[i * self.d..(i + 1) * self.d]
    }
    #[inline]
    pub fn at(&self, i: usize, j: usize) -> f32 {
        self.x[i * self.d + j]
    }
    /// Subset of rows.
    pub fn take(&self, idx: &[usize]) -> Data {
        let mut o = Data::new(self.d);
        o.x.reserve(idx.len() * self.d);
        for &i in idx {
            o.push(self.row(i), self.y[i], self.w[i]);
        }
        o
    }
    pub fn positives(&self) -> usize {
        self.y.iter().filter(|y| **y > 0.5).count()
    }
}

#[inline]
pub fn sigmoid(z: f64) -> f64 {
    if z >= 0.0 {
        1.0 / (1.0 + (-z).exp())
    } else {
        let e = z.exp();
        e / (1.0 + e)
    }
}

#[inline]
pub fn logit(p: f64) -> f64 {
    let p = p.clamp(1e-7, 1.0 - 1e-7);
    (p / (1.0 - p)).ln()
}

/// Weighted mean log loss of margins.
pub fn logloss(y: &[f32], w: &[f32], margin: &[f64]) -> f64 {
    let (mut s, mut sw) = (0.0, 0.0);
    for i in 0..y.len() {
        let p = sigmoid(margin[i]).clamp(1e-12, 1.0 - 1e-12);
        let l = if y[i] > 0.5 { -p.ln() } else { -(1.0 - p).ln() };
        s += l * w[i] as f64;
        sw += w[i] as f64;
    }
    if sw > 0.0 { s / sw } else { 0.0 }
}

/// Progress of an iterative fit: (iteration, max iterations, train loss, validation loss).
/// Returning `false` stops training (the best model so far is kept).
pub type Progress<'a> = &'a (dyn Fn(usize, usize, f64, f64) -> bool + Sync);

/// A callback that never stops.
pub fn no_progress(_: usize, _: usize, _: f64, _: f64) -> bool {
    true
}

/// Synthetic data for tests: `d` features, the first `informative` carry signal.
#[cfg(test)]
pub fn synth(n: usize, d: usize, informative: usize, noise: f64, seed: u64) -> Data {
    let mut r = Rng::new(seed);
    let mut data = Data::new(d);
    for _ in 0..n {
        let row: Vec<f32> = (0..d).map(|_| r.normal() as f32).collect();
        let mut z = 0.0;
        for (j, v) in row.iter().take(informative).enumerate() {
            z += *v as f64 * if j % 2 == 0 { 1.5 } else { -1.0 };
        }
        // a non-linear interaction the trees should find
        if informative >= 2 && row[0] > 0.5 && row[1] < 0.0 {
            z += 2.0;
        }
        z += r.normal() * noise - 1.0;
        let y = if r.f64() < sigmoid(z * 2.0) { 1.0 } else { 0.0 };
        data.push(&row, y, 1.0);
    }
    data
}
