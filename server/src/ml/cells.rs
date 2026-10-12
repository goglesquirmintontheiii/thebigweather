//! Storm-cell segmentation and per-cell features from one Level II volume.
//!
//! 1. Composite reflectivity (column max) on the lowest reflectivity tilt's polar grid.
//! 2. Cells = 8-connected components ≥ `thr_dbz` (azimuth wraps) with ≥ `min_area_km2`; large
//!    components (≥ `split_area_km2`) are re-segmented at +10 / +15 dB to separate cores.
//! 3. Per cell: reflectivity / column (VIL, echo tops, MESH, BWER proxy) from every reflectivity
//!    tilt sampled at the column; low-level dual-pol; rotation couplets (rotation.rs) and
//!    azimuthal shear / radial convergence from the velocity tilts; geometry and context.
//! 4. Trends / motion by matching to the previous volume's cells ([`apply_trends`]).

use super::features::{day_of_year, solar_hour, FeatMap};
use crate::radar::geom::{beam_height, bearing_dist, destination, PolarSweep, RE_EFF};
use crate::radar::level2::{tilts, Moment, Volume};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CellParams {
    pub thr_dbz: f32,
    pub min_area_km2: f32,
    pub split_area_km2: f32,
    pub max_range_km: f64,
    pub min_range_km: f64,
}

impl Default for CellParams {
    fn default() -> Self {
        Self { thr_dbz: 40.0, min_area_km2: 8.0, split_area_km2: 500.0, max_range_km: 230.0, min_range_km: 5.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub id: String,
    pub lat: f64,
    pub lon: f64,
    pub t: i64,
    pub feats: FeatMap,
    /// outline (lon, lat), convex hull
    pub hull: Vec<[f32; 2]>,
    /// motion toward (deg) and speed (kt), when matched to the previous volume
    #[serde(default)]
    pub motion: Option<(f32, f32)>,
}

/// Cells of one volume (the unit cached on disk).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VolCells {
    pub key: String,
    pub site: String,
    pub t: i64,
    pub lat: f64,
    pub lon: f64,
    pub cells: Vec<Cell>,
}

/// Slant range (m) at which a beam at `elev` (deg) is above ground distance `s` (m).
#[inline]
fn slant_for(s: f64, elev: f64) -> Option<(f64, f64)> {
    let phi = s / RE_EFF;
    let th = elev.to_radians();
    let c = (th + phi).cos();
    (c > 0.01).then(|| (RE_EFF * phi.sin() / c, RE_EFF * th.cos() / c - RE_EFF))
}

/// Distinct-angle sweeps carrying `m` (first sweep per angle), sorted by elevation.
fn tilt_sweeps(v: &Volume, m: Moment) -> Vec<(f64, usize)> {
    let mut out: Vec<(f64, usize)> = vec![];
    for t in tilts(v) {
        let Some(&si) = t.sweeps.get(m.code()) else { continue };
        if out.iter().any(|(a, _)| (a - t.angle as f64).abs() < 0.2) || v.sweeps[si].radials.len() < 50 {
            continue;
        }
        out.push((t.angle as f64, si));
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    out
}

fn pct(v: &mut [f32], q: f64) -> f32 {
    if v.is_empty() {
        return f32::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * q).round() as usize]
}

/// KDP (°/km) at (az, slant range): least-squares slope of ΦDP over ±2 km along the radial,
/// using gates with CC ≥ 0.9 (when CC is available); half the two-way phase slope.
fn kdp_at(phi: &PolarSweep, rho: Option<&PolarSweep>, az: f64, r: f64) -> Option<f32> {
    let ri = phi.radial_at(az)?;
    let g0 = phi.gate_at(r)?;
    let half = (2000.0 / phi.gate).round().max(2.0) as usize;
    let (a, b) = (g0.saturating_sub(half), (g0 + half).min(phi.ngates.saturating_sub(1)));
    let (mut n, mut sx, mut sy, mut sxx, mut sxy) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
    for g in a..=b {
        let Some(p) = phi.value(ri, g) else { continue };
        if let Some(rs) = rho {
            let rr = phi.first_gate + g as f64 * phi.gate;
            if rs.at(az, rr).map(|c| c < 0.9).unwrap_or(false) {
                continue;
            }
        }
        let x = (g as f64 - g0 as f64) * phi.gate / 1000.0;
        n += 1.0;
        sx += x;
        sy += p as f64;
        sxx += x * x;
        sxy += x * p as f64;
    }
    if n < (half as f64).max(6.0) {
        return None;
    }
    let den = n * sxx - sx * sx;
    if den.abs() < 1e-9 {
        return None;
    }
    let slope = (n * sxy - sx * sy) / den;
    Some(((slope / 2.0) as f32).clamp(-2.0, 15.0))
}

/// Polar grid (radials sorted by azimuth) of the composite reflectivity.
struct Grid {
    az: Vec<f64>,
    spacing: Vec<f64>,
    first: f64,
    gate: f64,
    ng: usize,
    elev: f64,
    val: Vec<f32>,
}

impl Grid {
    #[inline]
    fn at(&self, r: usize, g: usize) -> f32 {
        self.val[r * self.ng + g]
    }
    /// ground distance (m) of gate g on the base tilt
    fn ground(&self, g: usize) -> f64 {
        beam_height(self.first + g as f64 * self.gate, self.elev).1
    }
}

fn components(grid: &Grid, mask: &dyn Fn(usize, usize) -> bool, rows: Option<&[(usize, usize)]>) -> Vec<Vec<(usize, usize)>> {
    let nr = grid.az.len();
    let ng = grid.ng;
    let mut seen = vec![false; nr * ng];
    let mut out = vec![];
    let starts: Vec<(usize, usize)> = match rows {
        Some(r) => r.to_vec(),
        None => (0..nr).flat_map(|r| (0..ng).map(move |g| (r, g))).collect(),
    };
    let allowed: Option<std::collections::HashSet<(usize, usize)>> = rows.map(|r| r.iter().copied().collect());
    for (r0, g0) in starts {
        if seen[r0 * ng + g0] || !mask(r0, g0) {
            continue;
        }
        let mut comp = vec![];
        let mut stack = vec![(r0, g0)];
        seen[r0 * ng + g0] = true;
        while let Some((r, g)) = stack.pop() {
            comp.push((r, g));
            for dr in [nr - 1, 0, 1] {
                for dg in [-1i64, 0, 1] {
                    let rr = (r + dr) % nr;
                    let gg = g as i64 + dg;
                    if gg < 0 || gg as usize >= ng {
                        continue;
                    }
                    let gg = gg as usize;
                    let k = rr * ng + gg;
                    if seen[k] || !mask(rr, gg) {
                        continue;
                    }
                    if let Some(a) = &allowed {
                        if !a.contains(&(rr, gg)) {
                            continue;
                        }
                    }
                    seen[k] = true;
                    stack.push((rr, gg));
                }
            }
        }
        out.push(comp);
    }
    out
}

fn gate_area_km2(grid: &Grid, r: usize, g: usize) -> f64 {
    grid.ground(g) * grid.spacing[r].to_radians() * grid.gate / 1e6
}

fn area(grid: &Grid, c: &[(usize, usize)]) -> f64 {
    c.iter().map(|&(r, g)| gate_area_km2(grid, r, g)).sum()
}

/// Convex hull (monotone chain) of points.
fn hull(mut pts: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    let mut lower: Vec<(f64, f64)> = vec![];
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<(f64, f64)> = vec![];
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Segment the volume into cells and compute their (volume-only) features.
pub fn extract(v: &Volume, key: &str, p: &CellParams) -> VolCells {
    let t = v.start_ms();
    let mut out = VolCells { key: key.to_string(), site: v.site.clone(), t, lat: v.lat as f64, lon: v.lon as f64, cells: vec![] };
    let Ok(cref) = crate::radar::derived::sweep(v, "CREF") else { return out };
    // grid sorted by azimuth
    let mut rad: Vec<&crate::radar::level2::Radial> = cref.radials.iter().filter(|r| r.moment(Moment::Ref).is_some()).collect();
    if rad.len() < 50 {
        return out;
    }
    rad.sort_by(|a, b| a.azimuth.rem_euclid(360.0).partial_cmp(&b.azimuth.rem_euclid(360.0)).unwrap());
    let d0 = rad[0].moment(Moment::Ref).unwrap();
    let (first, gate) = (d0.first_gate_m as f64, d0.gate_m.max(1.0) as f64);
    let base_elev = rad[0].elevation as f64;
    let max_g = (((p.max_range_km * 1000.0 - first) / gate).max(0.0) as usize).min(rad.iter().map(|r| r.moment(Moment::Ref).unwrap().ngates as usize).max().unwrap_or(0));
    let ng = max_g;
    if ng < 20 {
        return out;
    }
    let mut val = vec![f32::NAN; rad.len() * ng];
    for (ri, r) in rad.iter().enumerate() {
        let d = r.moment(Moment::Ref).unwrap();
        for g in 0..ng.min(d.ngates as usize) {
            if let Some(x) = d.value(g) {
                val[ri * ng + g] = x;
            }
        }
    }
    let grid = Grid {
        az: rad.iter().map(|r| r.azimuth.rem_euclid(360.0) as f64).collect(),
        spacing: rad.iter().map(|r| r.az_spacing.clamp(0.25, 2.0) as f64).collect(),
        first,
        gate,
        ng,
        elev: base_elev,
        val,
    };
    let min_g = ((p.min_range_km * 1000.0 - first) / gate).max(0.0) as usize;
    let thr = p.thr_dbz;
    let mask = |r: usize, g: usize| g >= min_g && grid.at(r, g) >= thr;
    let mut comps: Vec<Vec<(usize, usize)>> = vec![];
    for c in components(&grid, &mask, None) {
        let a = area(&grid, &c);
        if (a as f32) < p.min_area_km2 {
            continue;
        }
        if (a as f32) >= p.split_area_km2 {
            // look for cores inside the big area
            let mut subs = vec![];
            for dt in [10.0f32, 15.0] {
                let m2 = |r: usize, g: usize| grid.at(r, g) >= thr + dt;
                subs = components(&grid, &m2, Some(&c)).into_iter().filter(|s| area(&grid, s) as f32 >= p.min_area_km2 * 0.5).collect::<Vec<_>>();
                if subs.len() >= 2 || subs.iter().all(|s| (area(&grid, s) as f32) < p.split_area_km2) {
                    break;
                }
            }
            if subs.len() >= 2 {
                comps.extend(subs);
                continue;
            }
        }
        comps.push(c);
    }
    if comps.is_empty() {
        return out;
    }

    // shared lookups
    let refs: Vec<(f64, PolarSweep)> = tilt_sweeps(v, Moment::Ref).into_iter().filter_map(|(a, si)| PolarSweep::new(&v.sweeps[si], Moment::Ref).map(|ps| (a, ps))).collect();
    let low = |m: Moment| tilt_sweeps(v, m).first().and_then(|&(a, si)| PolarSweep::new(&v.sweeps[si], m).map(|ps| (a, ps)));
    let (zdr, rho, phi, sw) = (low(Moment::Zdr), low(Moment::Rho), low(Moment::Phi), low(Moment::Sw));
    let vels: Vec<(f64, PolarSweep)> = tilt_sweeps(v, Moment::Vel).into_iter().filter_map(|(a, si)| PolarSweep::new(&v.sweeps[si], Moment::Vel).map(|ps| (a, ps))).collect();
    let couplets = if vels.is_empty() { vec![] } else { crate::radar::rotation::detect(v) };
    let sign = if v.lat < 0.0 { -1.0 } else { 1.0 };
    let radar_h = v.height_m as f64;
    let (vlat, vlon) = (v.lat as f64, v.lon as f64);

    let mut cells: Vec<Cell> = comps
        .iter()
        .enumerate()
        .map(|(k, c)| {
            let mut fm = FeatMap::default();
            // centroid (Z-weighted) in local x/y
            let (mut sx, mut sy, mut swt) = (0.0, 0.0, 0.0);
            let (mut rmax, mut rsum) = (f32::MIN, 0.0f64);
            let mut a50 = 0.0;
            let mut a_total = 0.0;
            let mut pts = vec![];
            for &(r, g) in c {
                let z = grid.at(r, g);
                let s = grid.ground(g);
                let az = grid.az[r].to_radians();
                let (x, y) = (s * az.sin(), s * az.cos());
                let w = 10f64.powf(z as f64 / 10.0);
                sx += x * w;
                sy += y * w;
                swt += w;
                rmax = rmax.max(z);
                rsum += z as f64;
                let ga = gate_area_km2(&grid, r, g);
                a_total += ga;
                if z >= 50.0 {
                    a50 += ga;
                }
                pts.push((x, y));
            }
            let (cx, cy) = (sx / swt, sy / swt);
            let crange = (cx * cx + cy * cy).sqrt();
            let caz = cx.atan2(cy).to_degrees().rem_euclid(360.0);
            let (lat, lon) = destination(vlat, vlon, caz, crange);
            fm.set("ref_max", rmax);
            fm.set("ref_mean", (rsum / c.len() as f64) as f32);
            fm.set("area_km2", a_total as f32);
            fm.set("area50_km2", a50 as f32);
            fm.set("range_km", (crange / 1000.0) as f32);
            fm.set("beam_h_km", (beam_height(slant_for(crange, base_elev).map(|x| x.0).unwrap_or(crange), base_elev).0 / 1000.0) as f32);
            fm.set("solar_hour", solar_hour(t, lon));
            fm.set("doy", day_of_year(t));
            fm.set("lat", lat as f32);

            // columns (subsampled for big cells)
            let step = (c.len() / 3000).max(1);
            let (mut vil_max, mut et_max, mut h50_max, mut mesh_max, mut core_h, mut core_z, mut low_max) = (0.0f32, f32::NAN, f32::NAN, 0.0f32, f32::NAN, f32::MIN, f32::NAN);
            let mut overhangs: Vec<f32> = vec![];
            let (h0, hm20) = (4000.0, 7000.0); // default melting / −20 °C heights (m MSL)
            let mut col: Vec<(f64, f32)> = Vec::with_capacity(refs.len());
            for &(r, g) in c.iter().step_by(step) {
                let s = grid.ground(g);
                let az = grid.az[r];
                col.clear();
                let mut lowest_ok = false;
                for (k, (el, ps)) in refs.iter().enumerate() {
                    if let Some((rr, h)) = slant_for(s, *el) {
                        if let Some(z) = ps.at(az, rr) {
                            col.push((h + radar_h, z));
                            lowest_ok |= k == 0;
                        }
                    }
                }
                if col.is_empty() {
                    continue;
                }
                let zlow = col[0].1;
                low_max = if low_max.is_nan() { zlow } else { low_max.max(zlow) };
                for &(h, z) in &col {
                    if z > core_z {
                        core_z = z;
                        core_h = (h / 1000.0) as f32;
                    }
                }
                // echo tops
                if let Some(kt) = col.iter().rposition(|c| c.1 >= 18.0) {
                    let (hk, zk) = col[kt];
                    let h = match col.get(kt + 1) {
                        Some(&(h1, z1)) if z1 < zk => hk + (18.0 - zk as f64) / (z1 - zk) as f64 * (h1 - hk),
                        _ => hk,
                    };
                    let e = (h / 1000.0) as f32;
                    et_max = if et_max.is_nan() { e } else { et_max.max(e) };
                }
                if let Some(kt) = col.iter().rposition(|c| c.1 >= 50.0) {
                    let e = (col[kt].0 / 1000.0) as f32;
                    h50_max = if h50_max.is_nan() { e } else { h50_max.max(e) };
                }
                // VIL (Greene & Clark) and SHI (Witt et al. 1998)
                let mut vil = 0.0f64;
                let mut shi = 0.0f64;
                for w in col.windows(2) {
                    let (ha, za) = w[0];
                    let (hb, zb) = w[1];
                    let dh = (hb - ha).max(0.0);
                    let za_l = 10f64.powf(za.min(56.0) as f64 / 10.0);
                    let zb_l = 10f64.powf(zb.min(56.0) as f64 / 10.0);
                    vil += 3.44e-6 * ((za_l + zb_l) / 2.0).powf(4.0 / 7.0) * dh;
                    let zm = (za + zb) as f64 / 2.0;
                    let hm = (ha + hb) / 2.0;
                    let wz = ((zm - 40.0) / 10.0).clamp(0.0, 1.0);
                    let wh = ((hm - h0) / (hm20 - h0)).clamp(0.0, 1.0);
                    let e = 5e-6 * 10f64.powf(0.084 * zm) * wz;
                    shi += 0.1 * wh * e * dh;
                }
                vil_max = vil_max.max(vil as f32);
                if shi > 0.0 {
                    mesh_max = mesh_max.max((2.54 * shi.sqrt()) as f32);
                }
                // bounded weak echo region proxy: mid-level (3–7 km AGL) max minus the lowest-tilt
                // value, in strong columns sampled by the lowest tilt (90th percentile over the cell)
                if lowest_ok && zlow >= 20.0 && col.iter().any(|c| c.1 >= 45.0) {
                    let mid = col.iter().filter(|c| (3000.0..=7000.0).contains(&(c.0 - radar_h))).map(|c| c.1).fold(f32::NAN, f32::max);
                    if mid.is_finite() {
                        overhangs.push(mid - zlow);
                    }
                }
            }
            fm.set("ref_low_max", low_max);
            fm.set("core_h_km", core_h);
            fm.set("overhang_db", pct(&mut overhangs, 0.9));
            fm.set("vil_max", vil_max);
            fm.set("et18_km", et_max);
            fm.set("h50_km", h50_max);
            fm.set("mesh_mm", mesh_max);
            fm.set("vil_density", if et_max.is_finite() && et_max > 0.5 { vil_max / et_max } else { f32::NAN });

            // low-level dual-pol (gates with reflectivity ≥ 30 on the lowest tilt)
            let mut zdrs = vec![];
            let (mut ccs, mut cc_low, mut cc_n, mut kdps) = (vec![], 0usize, 0usize, vec![]);
            let (mut swmax, mut velmax) = (f32::NAN, f32::NAN);
            let low_ref = refs.first();
            for &(r, g) in c.iter().step_by(step) {
                let s = grid.ground(g);
                let az = grid.az[r];
                let zl = low_ref.and_then(|(el, ps)| slant_for(s, *el).and_then(|(rr, _)| ps.at(az, rr))).unwrap_or(f32::NAN);
                if !(zl >= 20.0) {
                    continue;
                }
                if let Some((el, ps)) = &rho {
                    if let Some(cc) = slant_for(s, *el).and_then(|(rr, _)| ps.at(az, rr)) {
                        cc_n += 1;
                        if cc < 0.85 {
                            cc_low += 1;
                        }
                        if zl >= 30.0 {
                            ccs.push(cc);
                        }
                    }
                }
                if zl >= 30.0 {
                    if let Some((el, ps)) = &zdr {
                        if let Some(x) = slant_for(s, *el).and_then(|(rr, _)| ps.at(az, rr)) {
                            zdrs.push(x);
                        }
                    }
                }
                if zl >= 35.0 {
                    if let Some((el, ps)) = &phi {
                        if let Some(k) = slant_for(s, *el).and_then(|(rr, _)| kdp_at(ps, rho.as_ref().map(|x| &x.1), az, rr)) {
                            kdps.push(k);
                        }
                    }
                }
                if let Some((el, ps)) = &sw {
                    if let Some(x) = slant_for(s, *el).and_then(|(rr, _)| ps.at(az, rr)) {
                        swmax = if swmax.is_nan() { x } else { swmax.max(x) };
                    }
                }
                if let Some((el, ps)) = vels.first() {
                    if let Some(x) = slant_for(s, *el).and_then(|(rr, _)| ps.at(az, rr)) {
                        velmax = if velmax.is_nan() { x.abs() } else { velmax.max(x.abs()) };
                    }
                }
            }
            if !zdrs.is_empty() {
                fm.set("zdr_core", zdrs.iter().sum::<f32>() / zdrs.len() as f32);
                fm.set("zdr_max", pct(&mut zdrs, 0.98));
            }
            fm.set("cc_min", pct(&mut ccs, 0.01));
            fm.set("cc_low_frac", if cc_n > 0 { cc_low as f32 / cc_n as f32 } else { f32::NAN });
            fm.set("kdp_max", pct(&mut kdps, 0.95));
            fm.set("sw_max_low", swmax);
            fm.set("vel_max_low", velmax);

            // shear / convergence on velocity tilts chosen by beam height at the cell
            if !vels.is_empty() {
                let height_at = |el: f64| slant_for(crange, el).map(|x| x.1).unwrap_or(f64::MAX);
                let pick = |target: f64, lo: f64, hi: f64| vels.iter().filter(|(el, _)| (lo..=hi).contains(&height_at(*el))).min_by(|a, b| (height_at(a.0) - target).abs().partial_cmp(&(height_at(b.0) - target).abs()).unwrap());
                let shear_stats = |el: f64, ps: &PolarSweep| -> (f32, f32, f32) {
                    let (mut sh, mut dv) = (vec![], vec![]);
                    for &(r, g) in c.iter().step_by(step) {
                        if grid.at(r, g) < 30.0 {
                            continue;
                        }
                        let s = grid.ground(g);
                        let Some((rr, _)) = slant_for(s, el) else { continue };
                        let Some(ri) = ps.radial_at(grid.az[r]) else { continue };
                        let Some(gi) = ps.gate_at(rr) else { continue };
                        let n = ps.radials.len();
                        let (ra, rb) = ((ri + n - 1) % n, (ri + 1) % n);
                        let nyq = ps.radials[ri].2.max(1.0);
                        if let (Some(a), Some(b)) = (ps.value(ra, gi), ps.value(rb, gi)) {
                            let d = b - a;
                            if d.abs() < 1.5 * nyq {
                                let span = ((ps.radials[rb].0 - ps.radials[ra].0).rem_euclid(360.0) as f64).to_radians().max(1e-3);
                                sh.push((sign * d as f64 / (s.max(1000.0) * span) * 1000.0) as f32);
                            }
                        }
                        let k = (1000.0 / ps.gate).round().max(1.0) as usize;
                        if gi >= k && gi + k < ps.ngates {
                            if let (Some(a), Some(b)) = (ps.value(ri, gi - k), ps.value(ri, gi + k)) {
                                let d = b - a;
                                if d.abs() < 1.5 * nyq {
                                    dv.push((d as f64 / (2.0 * k as f64 * ps.gate) * 1000.0) as f32);
                                }
                            }
                        }
                    }
                    let shp = pct(&mut sh, 0.98);
                    let conv = if dv.is_empty() { f32::NAN } else { -pct(&mut dv, 0.02) };
                    let div = if dv.is_empty() { f32::NAN } else { pct(&mut dv, 0.98) };
                    (shp, conv, div)
                };
                let (el0, ps0) = &vels[0];
                let (s_low, conv, _) = shear_stats(*el0, ps0);
                fm.set("azshear_low", s_low);
                fm.set("conv_low", conv);
                if let Some((el, ps)) = pick(4500.0, 2500.0, 7500.0) {
                    fm.set("azshear_mid", shear_stats(*el, ps).0);
                }
                let et = fm.get("et18_km");
                let top = if et.is_finite() { (et as f64 * 850.0).max(5000.0) } else { 9000.0 };
                if let Some((el, ps)) = pick(top, 4000.0, 16_000.0) {
                    fm.set("div_top", shear_stats(*el, ps).2);
                }
                for kf in ["vrot_max", "vrot_low", "rot_tvs", "rot_meso", "rot_score"] {
                    fm.set(kf, 0.0);
                }
            }

            let hull_pts = hull(pts);
            let hull_ll: Vec<[f32; 2]> = hull_pts
                .iter()
                .map(|(x, y)| {
                    let (la, lo) = destination(vlat, vlon, x.atan2(*y).to_degrees().rem_euclid(360.0), (x * x + y * y).sqrt());
                    [((lo * 1e4).round() / 1e4) as f32, ((la * 1e4).round() / 1e4) as f32]
                })
                .collect();
            Cell { id: format!("{}-{}-{k}", v.site, t / 1000), lat, lon, t, feats: fm, hull: hull_ll, motion: None }
        })
        .collect();

    // rotation couplets → nearest cell
    for cp in &couplets {
        let best = cells
            .iter_mut()
            .map(|c| {
                let d = bearing_dist(c.lat, c.lon, cp.lat, cp.lon).1 / 1000.0;
                let rad = ((c.feats.get("area_km2") as f64) / std::f64::consts::PI).sqrt();
                (d, rad, c)
            })
            .filter(|(d, rad, _)| *d <= (rad + 4.0).max(6.0))
            .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let Some((_, _, c)) = best else { continue };
        let f = &mut c.feats;
        let vrot = cp.vrot as f32;
        if vrot > f.get("vrot_max") || f.get("vrot_max").is_nan() {
            f.set("vrot_max", vrot);
            f.set("rot_dv", cp.dv as f32);
            f.set("rot_diam_km", cp.diam_km as f32);
            f.set("rot_tilts", cp.tilts as f32);
            f.set("rot_h_km", cp.height_km as f32);
            f.set("rot_score", cp.score as f32);
        }
        if cp.height_km <= 3.0 && vrot > f.get("vrot_low") {
            f.set("vrot_low", vrot);
        }
        if cp.kind == "tvs" {
            f.set("rot_tvs", 1.0);
        }
        if cp.kind == "meso" || cp.kind == "tvs" {
            f.set("rot_meso", 1.0);
        }
    }
    cells.sort_by(|a, b| b.feats.get("ref_max").partial_cmp(&a.feats.get("ref_max")).unwrap_or(std::cmp::Ordering::Equal));
    for (k, c) in cells.iter_mut().enumerate() {
        c.id = format!("{}-{}-{k}", v.site, t / 1000);
    }
    out.cells = cells;
    out
}

/// Match cells to the previous volume's cells (greedy nearest) and add motion / trend features.
/// Returns the matched previous index per current cell.
pub fn apply_trends(cur: &mut VolCells, prev: &VolCells) -> Vec<Option<usize>> {
    let dt = (cur.t - prev.t) as f64 / 1000.0;
    let mut matched = vec![None; cur.cells.len()];
    if !(60.0..=1200.0).contains(&dt) {
        return matched;
    }
    let max_km = (35.0 * dt / 1000.0).max(8.0);
    let mut pairs: Vec<(f64, usize, usize)> = vec![];
    for (i, c) in cur.cells.iter().enumerate() {
        for (j, p) in prev.cells.iter().enumerate() {
            let d = bearing_dist(p.lat, p.lon, c.lat, c.lon).1 / 1000.0;
            if d <= max_km {
                pairs.push((d, i, j));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut used = vec![false; prev.cells.len()];
    for (_, i, j) in pairs {
        if matched[i].is_some() || used[j] {
            continue;
        }
        matched[i] = Some(j);
        used[j] = true;
    }
    for (i, m) in matched.iter().enumerate() {
        let Some(j) = *m else { continue };
        let p = &prev.cells[j];
        let (brg, d) = bearing_dist(p.lat, p.lon, cur.cells[i].lat, cur.cells[i].lon);
        let kt = (d / dt * 1.943_844) as f32;
        let c = &mut cur.cells[i];
        c.feats.set("motion_kt", kt);
        c.motion = Some((brg as f32, kt));
        for (k, src) in [("ref_trend", "ref_max"), ("vil_trend", "vil_max"), ("vrot_trend", "vrot_max")] {
            let (a, b) = (c.feats.get(src), p.feats.get(src));
            if a.is_finite() && b.is_finite() {
                c.feats.set(k, a - b);
            }
        }
        let (a, b) = (c.feats.get("area_km2"), p.feats.get("area_km2"));
        if a.is_finite() && b > 0.0 {
            c.feats.set("area_trend", a / b);
        }
    }
    matched
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::radar::geom::tests::synth_volume;

    /// Rankine vortex radial velocity (same as rotation.rs tests).
    pub fn rankine(az: f64, r: f64, el: f64, vaz: f64, vr_km: f64, rmax_km: f64, vmax: f64) -> f64 {
        let (_, s) = beam_height(r, el);
        let (px, py) = (s * az.to_radians().sin(), s * az.to_radians().cos());
        let (cx, cy) = (vr_km * 1000.0 * vaz.to_radians().sin(), vr_km * 1000.0 * vaz.to_radians().cos());
        let (dx, dy) = (px - cx, py - cy);
        let d = (dx * dx + dy * dy).sqrt();
        if d < 1.0 {
            return 0.0;
        }
        let rm = rmax_km * 1000.0;
        let vt = if d <= rm { vmax * d / rm } else { vmax * rm / d };
        let (ux, uy) = (-dy / d * vt, dx / d * vt);
        let n = (px * px + py * py).sqrt();
        (ux * px + uy * py) / n
    }

    /// Distance (km) from (az, ground km) polar point.
    fn dist_km(az: f64, s: f64, caz: f64, cr_km: f64) -> f64 {
        let (px, py) = (s * az.to_radians().sin(), s * az.to_radians().cos());
        let (cx, cy) = (cr_km * 1000.0 * caz.to_radians().sin(), cr_km * 1000.0 * caz.to_radians().cos());
        ((px - cx).powi(2) + (py - cy).powi(2)).sqrt() / 1000.0
    }

    /// A synthetic volume with storms at (az, range km, core dBZ, top km, vortex vmax (0 = none)).
    pub fn storm_volume(storms: &[(f64, f64, f32, f64, f64)], t_ms: i64) -> Volume {
        let elevs = [0.5f32, 0.9, 1.5, 2.4, 3.4, 4.3, 6.0, 8.0, 10.0, 12.5, 15.6, 19.5];
        let st = storms.to_vec();
        let mut v = synth_volume(&elevs, 720, 30.0, move |m, az, r, el| {
            let (h, s) = beam_height(r, el);
            match m {
                Moment::Ref => {
                    let mut best: Option<f32> = None;
                    for &(caz, cr, z, top, _) in &st {
                        let d = dist_km(az, s, caz, cr);
                        if d < 9.0 && h < top * 1000.0 {
                            let zz = z - (d as f32) * 2.5;
                            best = Some(best.map_or(zz, |b: f32| b.max(zz)));
                        }
                    }
                    best.or(Some(5.0))
                }
                Moment::Vel => {
                    let mut v = 5.0;
                    for &(caz, cr, _, _, vmax) in &st {
                        if vmax > 0.0 {
                            v += rankine(az, r, el, caz, cr, 1.0, vmax);
                        }
                    }
                    Some(v as f32)
                }
                Moment::Zdr => Some(1.5),
                _ => None,
            }
        });
        v.header_time_ms = t_ms;
        let shift = t_ms - 1_700_000_000_000;
        for s in v.sweeps.iter_mut() {
            for r in s.radials.iter_mut() {
                r.time_ms += shift;
            }
        }
        v
    }

    #[test]
    fn segments_cells_and_features() {
        let v = storm_volume(&[(45.0, 60.0, 62.0, 13.0, 35.0), (200.0, 90.0, 48.0, 7.0, 0.0)], 1_700_000_000_000);
        let t0 = std::time::Instant::now();
        let vc = extract(&v, "test", &CellParams::default());
        eprintln!("{} cells in {:?}", vc.cells.len(), t0.elapsed());
        assert_eq!(vc.cells.len(), 2, "{:?}", vc.cells.iter().map(|c| (&c.id, c.lat, c.lon)).collect::<Vec<_>>());
        let strong = &vc.cells[0];
        let weak = &vc.cells[1];
        let f = &strong.feats;
        assert!(f.get("ref_max") >= 58.0, "{}", f.get("ref_max"));
        assert!(f.get("vil_max") > weak.feats.get("vil_max"));
        assert!(f.get("et18_km") > 10.0 && weak.feats.get("et18_km") < f.get("et18_km") - 3.0, "{} {}", f.get("et18_km"), weak.feats.get("et18_km"));
        assert!(f.get("mesh_mm") > 20.0, "mesh {}", f.get("mesh_mm"));
        assert!(f.get("vrot_max") > 20.0, "vrot {}", f.get("vrot_max"));
        assert_eq!(weak.feats.get("vrot_max"), 0.0);
        assert!(f.get("azshear_low") > weak.feats.get("azshear_low") + 2.0, "{} {}", f.get("azshear_low"), weak.feats.get("azshear_low"));
        assert!((f.get("range_km") - 60.0).abs() < 4.0);
        assert!((f.get("zdr_core") - 1.5).abs() < 0.2);
        assert!(f.get("area_km2") > 50.0 && f.get("area_km2") < 400.0, "{}", f.get("area_km2"));
        assert!(strong.hull.len() >= 4);
        // the strong cell is ~60 km NE of the radar
        let (b, d) = bearing_dist(35.0, -97.0, strong.lat, strong.lon);
        assert!((b - 45.0).abs() < 4.0 && (d / 1000.0 - 60.0).abs() < 4.0, "{b} {d}");

        // the next volume 5 min later, storm moved 5 km east
        let v2 = storm_volume(&[(47.0, 62.0, 64.0, 13.0, 35.0), (200.0, 90.0, 48.0, 7.0, 0.0)], 1_700_000_300_000);
        let mut vc2 = extract(&v2, "test2", &CellParams::default());
        let m = apply_trends(&mut vc2, &vc);
        assert_eq!(m, vec![Some(0), Some(1)]);
        let kt = vc2.cells[0].feats.get("motion_kt");
        assert!(kt > 5.0 && kt < 40.0, "{kt}");
        assert!(vc2.cells[0].feats.get("ref_trend") > 0.0);
    }
}

#[cfg(test)]
mod real_tests {
    #[test]
    fn real_volumes_extract() {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        for f in ["KTLX20130420_205120_V06", "KLOT20200715_230602_V06", "KLOT20210625_075708_V06", "KLOT20220317_000842_V06"] {
            let Ok(b) = std::fs::read(format!("{base}/level2/{f}")) else { continue };
            let v = crate::radar::level2::Decoder::decode_file(&b).unwrap();
            let t0 = std::time::Instant::now();
            let vc = super::extract(&v, f, &super::CellParams::default());
            if std::env::var_os("TBW_DBG").is_some() {
                let ts = crate::radar::level2::tilts(&v);
                for t in &ts { eprintln!("  tilt {} {:?}", t.angle, t.sweeps.keys().collect::<Vec<_>>()); }
                let vels = super::tilt_sweeps(&v, crate::radar::level2::Moment::Vel);
                eprintln!("  vel tilts {:?}", vels.iter().map(|x| x.0).collect::<Vec<_>>());
                if let Ok(c) = crate::radar::derived::sweep(&v, "CREF") {
                    let mx = c.radials.iter().filter_map(|r| r.moment(crate::radar::level2::Moment::Ref)).flat_map(|d| (0..d.ngates as usize).filter_map(move |g| d.value(g))).fold(f32::MIN, f32::max);
                    eprintln!("  cref max {mx}");
                } else { eprintln!("  no CREF"); }
            }
            let dt = t0.elapsed();
            eprintln!("{f}: {} cells in {dt:?}", vc.cells.len());
            for c in vc.cells.iter().take(4) {
                let mut kv: Vec<(String, f32)> = c.feats.0.iter().map(|(k, v)| (k.clone(), (*v * 100.0).round() / 100.0)).collect();
                kv.sort_by(|a, b| a.0.cmp(&b.0));
                eprintln!("  {} ({:.3}, {:.3}) {:?}", c.id, c.lat, c.lon, kv);
            }
            assert!(dt.as_secs_f64() < 20.0);
            for c in &vc.cells {
                assert!(c.feats.get("ref_max") >= 40.0);
                assert!(c.feats.get("range_km") <= 231.0);
            }
        }
    }
}
