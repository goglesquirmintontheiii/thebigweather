//! Radar nowcast: extrapolates the latest MRMS reflectivity 10-60 minutes ahead.
//!
//! Motion comes from block matching between the last frames on a coarse (~6-7 km) copy of the
//! grid: ~60 km blocks every ~28 km, each searched for the shift that best maps the older frame
//! onto the newer one (sum of squared differences, sub-cell parabolic refinement). Vectors from
//! two frame pairs are averaged, then gaps are filled and the field smoothed with Gaussian
//! weights. Forecast frames are made by semi-Lagrangian (backward) advection of the newest frame
//! along that field in 5-minute steps. No growth or decay.

use super::Grid;
use rayon::prelude::*;

/// Motion field on a lattice of block centres, in source-grid cells per minute.
#[derive(Debug, Clone)]
pub struct Motion {
    /// source grid size
    pub nx: usize,
    pub ny: usize,
    /// coarse factor (source cells per coarse cell)
    pub f: usize,
    /// lattice: first centre (coarse cells), spacing (coarse cells), size
    pub c0: usize,
    pub step: usize,
    pub nbx: usize,
    pub nby: usize,
    pub u: Vec<f32>,
    pub v: Vec<f32>,
    /// blocks with a measured (not filled-in) vector
    pub measured: usize,
}

const HALF: isize = 4; // block = 9×9 coarse cells
const STEP: usize = 4;
const SEARCH: isize = 6;
/// coarse value: dBZ above this floor (weak echo / clutter ignored)
const FLOOR_DBZ: f32 = 10.0;

/// Coarse copy of a reflectivity grid: mean of (dBZ - floor, ≥ 0) per f×f block.
pub fn coarsen(g: &Grid, f: usize) -> (Vec<f32>, usize, usize) {
    let (cw, ch) = (g.nx / f, g.ny / f);
    let mut out = vec![0f32; cw * ch];
    out.par_chunks_mut(cw).enumerate().for_each(|(cj, row)| {
        for (ci, o) in row.iter_mut().enumerate() {
            let mut s = 0f32;
            for j in cj * f..(cj + 1) * f {
                let base = j * g.nx;
                for i in ci * f..(ci + 1) * f {
                    let r = g.data[base + i];
                    if r != 0 {
                        s += (g.value_raw(r) - FLOOR_DBZ).max(0.0);
                    }
                }
            }
            *o = s / (f * f) as f32;
        }
    });
    (out, cw, ch)
}

/// Best shift (coarse cells) moving `a` (older) onto `b` (newer) for each block centre, or None
/// where the block has too little echo or the match is unreliable.
pub fn match_blocks(a: &[f32], b: &[f32], cw: usize, ch: usize) -> (usize, usize, Vec<Option<(f32, f32)>>) {
    let nbx = if cw as isize > 2 * HALF { (cw - 2 * HALF as usize - 1) / STEP + 1 } else { 0 };
    let nby = if ch as isize > 2 * HALF { (ch - 2 * HALF as usize - 1) / STEP + 1 } else { 0 };
    let at = |g: &[f32], x: isize, y: isize| -> Option<f32> { if x < 0 || y < 0 || x as usize >= cw || y as usize >= ch { None } else { Some(g[y as usize * cw + x as usize]) } };
    let res: Vec<Option<(f32, f32)>> = (0..nbx * nby)
        .into_par_iter()
        .map(|k| {
            let (cx, cy) = ((HALF as usize + (k % nbx) * STEP) as isize, (HALF as usize + (k / nbx) * STEP) as isize);
            // enough echo in the newer frame's block (> ~25 dBZ over a fifth of it)
            let mut echo = 0;
            for y in cy - HALF..=cy + HALF {
                for x in cx - HALF..=cx + HALF {
                    if at(b, x, y).unwrap_or(0.0) > 15.0 {
                        echo += 1;
                    }
                }
            }
            if echo < 16 {
                return None;
            }
            let n = (2 * SEARCH + 1) as usize;
            let mut cost = vec![f32::INFINITY; n * n];
            for sy in -SEARCH..=SEARCH {
                for sx in -SEARCH..=SEARCH {
                    let mut ssd = 0f32;
                    let mut cnt = 0;
                    for y in cy - HALF..=cy + HALF {
                        for x in cx - HALF..=cx + HALF {
                            let (Some(bv), Some(av)) = (at(b, x, y), at(a, x - sx, y - sy)) else { continue };
                            ssd += (bv - av) * (bv - av);
                            cnt += 1;
                        }
                    }
                    if cnt > 40 {
                        cost[(sy + SEARCH) as usize * n + (sx + SEARCH) as usize] = ssd / cnt as f32;
                    }
                }
            }
            let (best, &bc) = cost.iter().enumerate().min_by(|x, y| x.1.total_cmp(y.1))?;
            if !bc.is_finite() {
                return None;
            }
            let (bx, by) = ((best % n) as isize - SEARCH, (best / n) as isize - SEARCH);
            // a best match on the edge of the search window is probably wrong
            if bx.abs() == SEARCH || by.abs() == SEARCH {
                return None;
            }
            let c = |dx: isize, dy: isize| cost[((by + dy + SEARCH) as usize) * n + (bx + dx + SEARCH) as usize];
            let para = |m: f32, z: f32, p: f32| {
                let d = m - 2.0 * z + p;
                if d.abs() < 1e-9 || !d.is_finite() { 0.0 } else { (0.5 * (m - p) / d).clamp(-0.5, 0.5) }
            };
            Some((bx as f32 + para(c(-1, 0), bc, c(1, 0)), by as f32 + para(c(0, -1), bc, c(0, 1))))
        })
        .collect();
    (nbx, nby, res)
}

/// Fill gaps and smooth: Gaussian-weighted mean of measured vectors (σ = 1.5 blocks, wider
/// where nothing was measured nearby), falling back to the mean of all measured vectors.
pub fn smooth_fill(nbx: usize, nby: usize, raw: &[Option<(f32, f32)>]) -> (Vec<f32>, Vec<f32>) {
    let pts: Vec<(usize, usize, f32, f32)> = raw.iter().enumerate().filter_map(|(k, v)| v.map(|(u, w)| (k % nbx, k / nbx, u, w))).collect();
    let (mu, mv) = if pts.is_empty() {
        (0.0, 0.0)
    } else {
        let n = pts.len() as f32;
        (pts.iter().map(|p| p.2).sum::<f32>() / n, pts.iter().map(|p| p.3).sum::<f32>() / n)
    };
    let out: Vec<(f32, f32)> = (0..nbx * nby)
        .into_par_iter()
        .map(|k| {
            let (x, y) = ((k % nbx) as isize, (k / nbx) as isize);
            for (rad, sig) in [(4isize, 1.5f32), (10, 4.0)] {
                let (mut su, mut sv, mut sw) = (0f32, 0f32, 0f32);
                for yy in (y - rad).max(0)..=(y + rad).min(nby as isize - 1) {
                    for xx in (x - rad).max(0)..=(x + rad).min(nbx as isize - 1) {
                        if let Some((u, v)) = raw[yy as usize * nbx + xx as usize] {
                            let d2 = ((xx - x) * (xx - x) + (yy - y) * (yy - y)) as f32;
                            let w = (-d2 / (2.0 * sig * sig)).exp();
                            su += w * u;
                            sv += w * v;
                            sw += w;
                        }
                    }
                }
                if sw > 0.05 {
                    // blend toward the domain mean where support is thin
                    let t = (sw / 3.0).min(1.0);
                    return (t * su / sw + (1.0 - t) * mu, t * sv / sw + (1.0 - t) * mv);
                }
            }
            (mu, mv)
        })
        .collect();
    (out.iter().map(|x| x.0).collect(), out.iter().map(|x| x.1).collect())
}

/// Motion (source cells per minute) from frames ordered oldest → newest with their times (ms).
/// Pairs are (frames[k], frames[k+1]); frames must share a grid.
pub fn motion(frames: &[(&Grid, i64)]) -> Option<Motion> {
    let g0 = frames.last()?.0;
    if frames.len() < 2 || frames.iter().any(|(g, _)| g.nx != g0.nx || g.ny != g0.ny) {
        return None;
    }
    let f = (g0.nx / 900).max(1);
    let coarse: Vec<(Vec<f32>, usize, usize)> = frames.iter().map(|(g, _)| coarsen(g, f)).collect();
    let (cw, ch) = (coarse[0].1, coarse[0].2);
    let mut acc: Vec<(f32, f32, u32)> = vec![];
    let (mut nbx, mut nby) = (0, 0);
    for k in 0..frames.len() - 1 {
        let dt = (frames[k + 1].1 - frames[k].1) as f32 / 60_000.0;
        if dt < 3.0 {
            continue;
        }
        let (bx, by, r) = match_blocks(&coarse[k].0, &coarse[k + 1].0, cw, ch);
        (nbx, nby) = (bx, by);
        if acc.is_empty() {
            acc = vec![(0.0, 0.0, 0); r.len()];
        }
        for (a, v) in acc.iter_mut().zip(r) {
            if let Some((u, w)) = v {
                a.0 += u / dt;
                a.1 += w / dt;
                a.2 += 1;
            }
        }
    }
    if nbx == 0 || nby == 0 {
        return None;
    }
    let raw: Vec<Option<(f32, f32)>> = acc.iter().map(|a| (a.2 > 0).then(|| (a.0 / a.2 as f32, a.1 / a.2 as f32))).collect();
    let measured = raw.iter().filter(|x| x.is_some()).count();
    let (u, v) = smooth_fill(nbx, nby, &raw);
    Some(Motion { nx: g0.nx, ny: g0.ny, f, c0: HALF as usize, step: STEP, nbx, nby, u: u.iter().map(|x| x * f as f32).collect(), v: v.iter().map(|x| x * f as f32).collect(), measured })
}

impl Motion {
    /// Velocity (source cells / minute) at a source-grid position (bilinear).
    #[inline]
    pub fn at(&self, x: f32, y: f32) -> (f32, f32) {
        let fx = ((x / self.f as f32 - self.c0 as f32) / self.step as f32).clamp(0.0, (self.nbx - 1) as f32);
        let fy = ((y / self.f as f32 - self.c0 as f32) / self.step as f32).clamp(0.0, (self.nby - 1) as f32);
        let (i0, j0) = (fx.floor() as usize, fy.floor() as usize);
        let (i1, j1) = ((i0 + 1).min(self.nbx - 1), (j0 + 1).min(self.nby - 1));
        let (tx, ty) = (fx - i0 as f32, fy - j0 as f32);
        let l = |g: &[f32]| {
            let a = g[j0 * self.nbx + i0] * (1.0 - tx) + g[j0 * self.nbx + i1] * tx;
            let b = g[j1 * self.nbx + i0] * (1.0 - tx) + g[j1 * self.nbx + i1] * tx;
            a * (1.0 - ty) + b * ty
        };
        (l(&self.u), l(&self.v))
    }

    /// Mean speed (source cells per minute) and direction-free summary for diagnostics.
    pub fn mean(&self) -> (f32, f32) {
        let n = self.u.len().max(1) as f32;
        (self.u.iter().sum::<f32>() / n, self.v.iter().sum::<f32>() / n)
    }
}

/// Advect `base` forward `lead_min` minutes along `m`; the output is decimated by `stride`
/// (same quantization as the base; raw 0 = no echo).
pub fn advect(base: &Grid, m: &Motion, lead_min: u32, stride: usize) -> Vec<u16> {
    let stride = stride.max(1);
    let (nx, ny) = (base.nx / stride, base.ny / stride);
    let steps = lead_min.div_ceil(5).max(1);
    let dt = lead_min as f32 / steps as f32;
    let mut out = vec![0u16; nx * ny];
    out.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
        for (i, o) in row.iter_mut().enumerate() {
            let (mut x, mut y) = ((i * stride) as f32, (j * stride) as f32);
            for _ in 0..steps {
                let (u, v) = m.at(x, y);
                x -= u * dt;
                y -= v * dt;
            }
            let (xi, yi) = (x.round(), y.round());
            if xi >= 0.0 && yi >= 0.0 && (xi as usize) < base.nx && (yi as usize) < base.ny {
                *o = base.data[yi as usize * base.nx + xi as usize];
            }
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::Proj;

    fn blob_grid(nx: usize, ny: usize, cx: f32, cy: f32) -> Grid {
        let mut vals = vec![f32::NAN; nx * ny];
        for j in 0..ny {
            for i in 0..nx {
                let d2 = (i as f32 - cx).powi(2) + (j as f32 - cy).powi(2);
                let z = 55.0 * (-d2 / (2.0 * 60.0f32.powi(2))).exp() + 10.0 * ((i as f32 * 0.21).sin() * (j as f32 * 0.17).cos());
                if z > 12.0 {
                    vals[j * nx + i] = z;
                }
            }
        }
        Grid::from_values(nx, ny, Proj::LatLon { lat0: 20.0, lon0: -130.0, dlat: 0.02, dlon: 0.02, nx, global: false }, &vals, 0, 0)
    }

    #[test]
    fn recovers_motion_and_advects() {
        // features moving +8 cells in x and -4 in y every 10 minutes (0.8, -0.4 cells/min);
        // the texture moves with the blob
        let (nx, ny) = (1800, 900);
        let mk = |k: f32| {
            let mut vals = vec![f32::NAN; nx * ny];
            let (ox, oy) = (8.0 * k, -4.0 * k);
            for j in 0..ny {
                for i in 0..nx {
                    let (x, y) = (i as f32 - ox, j as f32 - oy);
                    let d2 = (x - 700.0).powi(2) + (y - 450.0).powi(2);
                    let z = 55.0 * (-d2 / (2.0 * 90.0f32.powi(2))).exp() + 8.0 * ((x * 0.05).sin() * (y * 0.07).cos());
                    if z > 12.0 {
                        vals[j * nx + i] = z;
                    }
                }
            }
            Grid::from_values(nx, ny, Proj::LatLon { lat0: 20.0, lon0: -130.0, dlat: 0.02, dlon: 0.02, nx, global: false }, &vals, 0, 0)
        };
        let (a, b, c) = (mk(0.0), mk(1.0), mk(2.0));
        let m = motion(&[(&a, 0), (&b, 600_000), (&c, 1_200_000)]).unwrap();
        assert!(m.measured > 10, "{}", m.measured);
        let (u, v) = m.at(700.0 + 16.0, 450.0 - 8.0);
        assert!((u - 0.8).abs() < 0.2 && (v + 0.4).abs() < 0.2, "{u} {v}");
        // 30 minutes ahead ≈ frame k = 5
        let fc = advect(&c, &m, 30, 1);
        let truth = mk(5.0);
        let (mut hit, mut tot) = (0, 0);
        for k in (0..nx * ny).step_by(7) {
            if truth.data[k] != 0 {
                tot += 1;
                if fc[k] != 0 {
                    hit += 1;
                }
            }
        }
        assert!(hit as f32 / tot as f32 > 0.85, "{hit}/{tot}");
    }

    /// Real MRMS reflectivity shifted by a known amount (skipped without the test data).
    #[test]
    fn real_mrms_shift() {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        let Ok(b) = std::fs::read(format!("{base}/grib/MRMS_ReflectivityAtLowestAltitude_00.50_20230406-120039.grib2.gz")) else { return };
        let raw = crate::grid::decode::maybe_gunzip(&b).unwrap();
        let opts = crate::grid::decode::DecodeOpts { nodata: vec![-999.0, -99.0], min_valid: Some(-30.0), max_dim: 3500, ..Default::default() };
        let g = crate::grid::decode::decode(&raw, 0, &opts).unwrap();
        // features move +6 columns and -3 rows per 10 minutes
        let shift = |k: isize| {
            let mut d = vec![0u16; g.data.len()];
            for j in 0..g.ny as isize {
                for i in 0..g.nx as isize {
                    let (si, sj) = (i - 6 * k, j + 3 * k);
                    if si >= 0 && sj >= 0 && (si as usize) < g.nx && (sj as usize) < g.ny {
                        d[j as usize * g.nx + i as usize] = g.data[sj as usize * g.nx + si as usize];
                    }
                }
            }
            Grid { data: d, ..g.clone() }
        };
        let (a, b2, c) = (shift(0), shift(1), shift(2));
        let m = motion(&[(&a, 0), (&b2, 600_000), (&c, 1_200_000)]).unwrap();
        assert!(m.measured > 50, "{}", m.measured);
        let (u, v) = m.mean();
        assert!((u - 0.6).abs() < 0.1 && (v + 0.3).abs() < 0.1, "{u} {v}");
    }

    #[test]
    fn calm_without_echo() {
        let g = blob_grid(400, 200, -1000.0, -1000.0);
        let m = motion(&[(&g, 0), (&g, 600_000)]).unwrap();
        assert_eq!(m.measured, 0);
        assert_eq!(m.mean(), (0.0, 0.0));
        let out = advect(&g, &m, 10, 2);
        assert_eq!(out.len(), 200 * 100);
    }
}
