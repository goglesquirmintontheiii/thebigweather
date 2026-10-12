//! Rotation (couplet) detection on Level II velocity, loosely after the WSR-88D TDA / MDA.
//!
//! For each of the lowest three velocity tilts the sweep is collapsed into 1 km range cells
//! (max outbound / max inbound / mean per radial and cell). Every radial is then used as the
//! inbound anchor of an azimuthal window of 1–8 km at the same range (±1 km), and the strongest
//! outbound value clockwise of it (cyclonic shear in the northern hemisphere) gives ΔV.
//! Candidates must be backed by reflectivity, by at least two of the three range cells, and must
//! not be a velocity-folding boundary (an abrupt ±Nyquist jump that continues in range).
//! Per-tilt detections are thinned within 3 km and associated across tilts, then classified:
//! `tvs` (≥ 45 m/s over ≤ 2.5 km low in the storm), `meso` (Vrot ≥ 15 m/s over 2–10 km, on
//! two tilts or Vrot ≥ 18), `weak` (Vrot ≥ 10 m/s).

use super::geom::{beam_height, destination, PolarSweep};
use super::level2::{tilts, Moment, Volume};
use rayon::prelude::*;
use serde::Serialize;
use serde_json::{json, Value};

const CELL_M: f64 = 1000.0;
const MIN_RANGE_KM: f64 = 10.0;
const MAX_RANGE_KM: f64 = 230.0;
const MAX_WINDOW_KM: f64 = 8.0;
const MIN_DV: f32 = 20.0;
const MIN_SHEAR: f32 = 3.0e-3; // s⁻¹
const MIN_REF: f32 = 20.0;
const CLUSTER_KM: f64 = 3.0;
const MAX_RESULTS: usize = 60;

#[derive(Debug, Clone, Serialize)]
pub struct Couplet {
    pub kind: &'static str,
    pub vrot: f64,
    pub dv: f64,
    pub diam_km: f64,
    pub range_km: f64,
    pub az: f64,
    pub height_km: f64,
    /// elevation angle of the tilt the reported values come from
    pub tilt: f64,
    /// number of tilts with a couplet here
    pub tilts: usize,
    pub score: f64,
    #[serde(skip)]
    pub lat: f64,
    #[serde(skip)]
    pub lon: f64,
}

#[derive(Debug, Clone)]
struct Cand {
    tilt_rank: usize,
    elev: f32,
    dv: f32,
    g2g: f32,
    diam_km: f32,
    range_km: f32,
    az: f32,
    height_km: f32,
    lat: f64,
    lon: f64,
}

fn dist_km(a: (f64, f64), b: (f64, f64)) -> f64 {
    super::geom::bearing_dist(a.0, a.1, b.0, b.1).1 / 1000.0
}

/// Detections on one tilt. `sign` = +1 for cyclonic in the northern hemisphere.
fn tilt_candidates(v: &Volume, vel: &PolarSweep, refl: Option<&PolarSweep>, tilt_rank: usize, sign: f32) -> Vec<Cand> {
    let nrad = vel.radials.len();
    let cg = ((CELL_M / vel.gate).round() as usize).max(1);
    let max_g = ((MAX_RANGE_KM * 1000.0 - vel.first_gate) / vel.gate) as usize;
    let ncell = vel.ngates.min(max_g) / cg;
    if ncell < 12 {
        return vec![];
    }
    let ng = ncell * cg;
    let mut nyqs: Vec<f32> = vel.radials.iter().map(|r| r.2).filter(|n| *n > 1.0).collect();
    nyqs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let vn = nyqs.get(nyqs.len() / 2).copied().unwrap_or(1000.0);
    let spacing = {
        let mut s: Vec<f32> = vel.radials.iter().map(|r| r.1).collect();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        s[s.len() / 2] as f64
    };
    let km_of = |c: usize| (vel.first_gate + (c as f64 + 0.5) * cg as f64 * vel.gate) / 1000.0;

    // 1. gate values (sign applied so cyclonic shear is always positive), NaN = none
    let mut raw = vec![f32::NAN; nrad * ng];
    raw.par_chunks_mut(ng).enumerate().for_each(|(ri, row)| {
        for (g, o) in row.iter_mut().enumerate() {
            if let Some(x) = vel.value(ri, g) {
                *o = x * sign;
            }
        }
    });

    // 2. alias-invariant local reference: circular mean of V·π/Vn over a ~±10 km × ±5 km box,
    //    then unfold every gate to within ±Vn of it (folds become continuous, a vortex keeps
    //    its full ΔV up to 2·Vn)
    let deal: Vec<f32> = if vn < 500.0 {
        let k = std::f32::consts::PI / vn;
        // per-cell sums
        let sums: Vec<(f32, f32, f32)> = (0..nrad * ncell)
            .into_par_iter()
            .map(|q| {
                let (ri, c) = (q / ncell, q % ncell);
                let mut s = (0.0, 0.0, 0.0);
                for &x in &raw[ri * ng + c * cg..ri * ng + (c + 1) * cg] {
                    if x.is_finite() {
                        s.0 += (x * k).cos();
                        s.1 += (x * k).sin();
                        s.2 += 1.0;
                    }
                }
                s
            })
            .collect();
        // range box (±5 cells) per radial
        let rbox: Vec<(f32, f32, f32)> = (0..nrad * ncell)
            .into_par_iter()
            .map(|q| {
                let (ri, c) = (q / ncell, q % ncell);
                let mut s = (0.0, 0.0, 0.0);
                for cc in c.saturating_sub(5)..=(c + 5).min(ncell - 1) {
                    let t = sums[ri * ncell + cc];
                    s.0 += t.0;
                    s.1 += t.1;
                    s.2 += t.2;
                }
                s
            })
            .collect();
        // azimuth box per cell column (prefix sums over the doubled ring)
        let refs: Vec<Vec<f32>> = (0..ncell)
            .into_par_iter()
            .map(|c| {
                let w = ((10.0 / (km_of(c) * spacing.to_radians())).round() as usize).clamp(3, 40.min(nrad / 4));
                let mut pre = vec![(0.0f64, 0.0f64, 0.0f64); 2 * nrad + 1];
                for t in 0..2 * nrad {
                    let s = rbox[(t % nrad) * ncell + c];
                    let p = pre[t];
                    pre[t + 1] = (p.0 + s.0 as f64, p.1 + s.1 as f64, p.2 + s.2 as f64);
                }
                let wrapped: Vec<f32> = (0..nrad)
                    .map(|i| {
                        let (a, b) = (i + nrad - w, i + nrad + w + 1);
                        let (a, b) = (a.min(2 * nrad), b.min(2 * nrad));
                        let (cs, sn, n) = (pre[b].0 - pre[a].0, pre[b].1 - pre[a].1, pre[b].2 - pre[a].2);
                        if n < 8.0 || (cs * cs + sn * sn).sqrt() < 0.05 * n {
                            f32::NAN
                        } else {
                            (sn.atan2(cs) as f32) / k
                        }
                    })
                    .collect();
                // the circular mean itself wraps at ±Vn: unwrap it around the ring, starting
                // where the environment is slowest (beam ⟂ wind, unambiguous)
                let Some(start) = (0..nrad).filter(|&i| wrapped[i].is_finite()).min_by(|&a, &b| wrapped[a].abs().partial_cmp(&wrapped[b].abs()).unwrap()) else {
                    return wrapped;
                };
                let mut out = vec![f32::NAN; nrad];
                let mut prev = wrapped[start];
                for t in 0..nrad {
                    let i = (start + t) % nrad;
                    let x = wrapped[i];
                    if x.is_finite() {
                        prev = x + 2.0 * vn * ((prev - x) / (2.0 * vn)).round();
                        out[i] = prev;
                    }
                }
                out
            })
            .collect();
        let mut d = raw.clone();
        d.par_chunks_mut(ng).enumerate().for_each(|(ri, row)| {
            for (g, x) in row.iter_mut().enumerate() {
                let r = refs[g / cg][ri];
                if x.is_finite() && r.is_finite() {
                    *x += 2.0 * vn * ((r - *x) / (2.0 * vn)).round();
                }
            }
        });
        d
    } else {
        raw
    };
    let gv = |ri: usize, g: usize| deal[(ri % nrad) * ng + g];

    // 3. robust per-(radial, cell) stats: 2nd highest, 2nd lowest, mean (NaN if under half valid)
    let cells: Vec<(f32, f32, f32)> = (0..nrad * ncell)
        .into_par_iter()
        .map(|q| {
            let (ri, c) = (q / ncell, q % ncell);
            let mut xs: Vec<f32> = deal[ri * ng + c * cg..ri * ng + (c + 1) * cg].iter().copied().filter(|x| x.is_finite()).collect();
            if xs.len() * 2 < cg.max(2) {
                return (f32::NAN, f32::NAN, f32::NAN);
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let n = xs.len();
            let (hi, lo) = if n >= 3 { (xs[n - 2], xs[1]) } else { (xs[n - 1], xs[0]) };
            (hi, lo, xs.iter().sum::<f32>() / n as f32)
        })
        .collect();
    let at = |ri: usize, c: usize| cells[(ri % nrad) * ncell + c];
    // ±1 km band (cells c-1..=c+1): outbound max, inbound min, mean
    let band = |ri: usize, c: usize| -> (f32, f32, f32) {
        let (mut hi, mut lo, mut sum, mut n) = (f32::MIN, f32::MAX, 0.0, 0);
        for cc in c.saturating_sub(1)..=(c + 1).min(ncell - 1) {
            let x = at(ri, cc);
            if x.0.is_finite() {
                hi = hi.max(x.0);
                lo = lo.min(x.1);
                sum += x.2;
                n += 1;
            }
        }
        (hi, lo, if n > 0 { sum / n as f32 } else { f32::NAN })
    };
    let bands: Vec<(f32, f32, f32)> = (0..nrad * ncell).into_par_iter().map(|q| band(q / ncell, q % ncell)).collect();
    let bd = |ri: usize, c: usize| bands[(ri % nrad) * ncell + c];

    // reflectivity support per (radial, cell)
    let refmax: Vec<f32> = (0..nrad * ncell)
        .into_par_iter()
        .map(|q| {
            let Some(rp) = refl else { return 99.0 };
            let (ri, c) = (q / ncell, q % ncell);
            let az = vel.radials[ri].0 as f64;
            let r0 = vel.first_gate + (c * cg) as f64 * vel.gate;
            let mut best = f32::MIN;
            for daz in [-0.5, 0.0, 0.5] {
                for f in [0.0, 0.5, 1.0] {
                    if let Some(x) = rp.at(az + daz, r0 + f * CELL_M) {
                        best = best.max(x);
                    }
                }
            }
            best
        })
        .collect();

    let elev = vel.elev;
    let cmin = ((MIN_RANGE_KM * 1000.0 - vel.first_gate) / (cg as f64 * vel.gate)).max(1.0) as usize;
    let found: Vec<Cand> = (cmin..ncell - 1)
        .into_par_iter()
        .flat_map_iter(|c| {
            let r_km = km_of(c);
            let arc = r_km * spacing.to_radians(); // km per radial
            let nmax = ((MAX_WINDOW_KM / arc).ceil() as usize).clamp(1, 60);
            let mut out = vec![];
            // sliding maximum of the outbound band over radials i+1..=i+nmax (monotonic deque)
            let bm = |j: usize| bd(j, c).0;
            let mut dq: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
            let mut next = 1usize;
            for i in 0..nrad {
                while next <= i + nmax {
                    while dq.back().map(|&b| bm(b) <= bm(next)).unwrap_or(false) {
                        dq.pop_back();
                    }
                    dq.push_back(next);
                    next += 1;
                }
                while dq.front().map(|&f| f <= i).unwrap_or(false) {
                    dq.pop_front();
                }
                let a = bd(i, c).1;
                if a == f32::MAX || dq.front().map(|&f| bm(f) - a < MIN_DV).unwrap_or(true) {
                    continue;
                }
                let mut best: Option<(f32, usize)> = None;
                for j in i + 1..=i + nmax {
                    let b = bm(j);
                    if b == f32::MIN {
                        continue;
                    }
                    let dv = b - a;
                    if dv < MIN_DV || best.map(|x| dv <= x.0).unwrap_or(false) {
                        continue;
                    }
                    let diam = ((j - i) as f64 * arc) as f32;
                    if dv / (diam.max(0.1) * 1000.0) < MIN_SHEAR {
                        continue;
                    }
                    best = Some((dv, j));
                }
                let Some((dv, j)) = best else { continue };
                // compact, not a shear line: velocities relax back outside the couplet
                let l = (j - i).max(2);
                let (after, before) = (bd(j + l, c).2, bd(i + nrad - l, c).2);
                if (after.is_finite() && after > bd(j, c).0 - 0.25 * dv) || (before.is_finite() && before < a + 0.25 * dv) {
                    continue;
                }
                // at least two of the three range cells must show the couplet themselves
                let support = [c - 1, c, c + 1]
                    .into_iter()
                    .filter(|&cc| {
                        let (b, a) = (at(j, cc).0, at(i, cc).1);
                        b.is_finite() && a.is_finite() && b - a >= 0.5 * dv
                    })
                    .count();
                if support < 2 {
                    continue;
                }
                if !(i..=j).any(|k| (c - 1..=c + 1).any(|cc| refmax[(k % nrad) * ncell + cc] >= MIN_REF)) {
                    continue;
                }
                // strongest true gate-to-gate (adjacent radials, same gate) shear, backed by a
                // neighbouring gate
                let mut g2g = 0.0f32;
                for k in i..j {
                    for g in (c - 1) * cg..((c + 2) * cg).min(ng) {
                        let d = gv(k + 1, g) - gv(k, g);
                        if !(d > g2g) {
                            continue;
                        }
                        let nb = |gg: usize| gg < ng && gv(k + 1, gg) - gv(k, gg) >= 0.5 * d;
                        if (g > 0 && nb(g - 1)) || nb(g + 1) {
                            g2g = d;
                        }
                    }
                }
                let (az_i, az_j) = (vel.radials[i % nrad].0 as f64, vel.radials[j % nrad].0 as f64);
                let mut daz = az_j - az_i;
                if daz < 0.0 {
                    daz += 360.0;
                }
                let az = (az_i + daz / 2.0).rem_euclid(360.0);
                let diam_km = (r_km * daz.to_radians()).max(arc) as f32;
                let (h, s) = beam_height(r_km * 1000.0, elev);
                let (lat, lon) = destination(v.lat as f64, v.lon as f64, az, s);
                out.push(Cand { tilt_rank, elev: elev as f32, dv, g2g, diam_km, range_km: r_km as f32, az: az as f32, height_km: (h / 1000.0) as f32, lat, lon });
            }
            out
        })
        .collect();
    // thin: strongest first, nothing else within the cluster radius
    let mut found = found;
    found.sort_by(|a, b| b.dv.partial_cmp(&a.dv).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Cand> = vec![];
    for c in found {
        if kept.iter().all(|k| dist_km((k.lat, k.lon), (c.lat, c.lon)) > CLUSTER_KM) {
            kept.push(c);
            if kept.len() >= 200 {
                break;
            }
        }
    }
    kept
}

/// Run detection on a volume.
pub fn detect(v: &Volume) -> Vec<Couplet> {
    let ts = tilts(v);
    let sign = if v.lat < 0.0 { -1.0 } else { 1.0 };
    // lowest three distinct velocity tilts (first sweep per angle)
    let mut picks: Vec<(f32, usize)> = vec![];
    for t in &ts {
        if let Some(&si) = t.sweeps.get("VEL") {
            if picks.iter().all(|p| (p.0 - t.angle).abs() >= 0.2) && v.sweeps[si].radials.len() >= 100 {
                picks.push((t.angle, si));
            }
        }
    }
    picks.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    picks.truncate(3);
    // reflectivity: the same tilt, else the nearest one
    let ref_for = |angle: f32| -> Option<usize> {
        ts.iter().filter(|t| t.sweeps.contains_key("REF")).min_by(|a, b| (a.angle - angle).abs().partial_cmp(&(b.angle - angle).abs()).unwrap()).map(|t| t.sweeps["REF"])
    };
    let mut cands: Vec<Cand> = vec![];
    for (rank, (angle, si)) in picks.iter().enumerate() {
        let Some(vel) = PolarSweep::new(&v.sweeps[*si], Moment::Vel) else { continue };
        let refl = ref_for(*angle).and_then(|ri| PolarSweep::new(&v.sweeps[ri], Moment::Ref));
        cands.extend(tilt_candidates(v, &vel, refl.as_ref(), rank, sign));
    }
    // associate across tilts (strongest first)
    cands.sort_by(|a, b| b.dv.partial_cmp(&a.dv).unwrap_or(std::cmp::Ordering::Equal));
    let mut groups: Vec<Vec<Cand>> = vec![];
    for c in cands {
        match groups.iter_mut().find(|g| dist_km((g[0].lat, g[0].lon), (c.lat, c.lon)) <= CLUSTER_KM + 1.0) {
            Some(g) => g.push(c),
            None => groups.push(vec![c]),
        }
    }
    let mut out: Vec<Couplet> = groups
        .into_iter()
        .filter_map(|g| {
            let mut ranks: Vec<usize> = g.iter().map(|c| c.tilt_rank).collect();
            ranks.sort_unstable();
            ranks.dedup();
            let ntilts = ranks.len();
            let tvs = g.iter().filter(|c| ntilts >= 2 && c.tilt_rank <= 1 && c.height_km <= 3.0 && ((c.g2g >= 45.0 && c.diam_km <= 4.0) || (c.dv >= 45.0 && c.diam_km <= 2.5))).max_by(|a, b| a.dv.max(a.g2g).partial_cmp(&b.dv.max(b.g2g)).unwrap());
            let rep = tvs.unwrap_or(&g[0]);
            let vrot = rep.dv / 2.0;
            let kind = if tvs.is_some() {
                "tvs"
            } else if vrot >= 15.0 && (1.0..=10.0).contains(&rep.diam_km) && (ntilts >= 2 || vrot >= 18.0) {
                "meso"
            } else if vrot >= 10.0 && rep.diam_km >= 0.5 {
                "weak"
            } else {
                return None;
            };
            let mut score = ((vrot - 10.0) / 25.0).clamp(0.0, 1.0) * 0.7 + 0.1 * (ntilts.saturating_sub(1)).min(2) as f32;
            if kind == "tvs" {
                score = score.max(0.6) + 0.2;
            }
            if rep.height_km > 3.0 {
                score -= 0.1 * ((rep.height_km - 3.0) / 2.0).min(1.0);
            }
            Some(Couplet {
                kind,
                vrot: round1(vrot),
                dv: round1(rep.dv),
                diam_km: round1(rep.diam_km),
                range_km: round1(rep.range_km),
                az: round1(rep.az),
                height_km: (rep.height_km as f64 * 100.0).round() / 100.0,
                tilt: (rep.elev as f64 * 100.0).round() / 100.0,
                tilts: ntilts,
                score: (score.clamp(0.0, 1.0) as f64 * 100.0).round() / 100.0,
                lat: rep.lat,
                lon: rep.lon,
            })
        })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(MAX_RESULTS);
    out
}

fn round1(x: f32) -> f64 {
    (x as f64 * 10.0).round() / 10.0
}

/// GeoJSON FeatureCollection of detections.
pub fn geojson(v: &Volume, key: &str) -> Value {
    let t = v.start_ms();
    let feats: Vec<Value> = detect(v)
        .into_iter()
        .map(|c| {
            let mut p = serde_json::to_value(&c).unwrap_or(json!({}));
            p["site"] = json!(v.site);
            p["t"] = json!(t);
            json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [crate::overlays::round(c.lon), crate::overlays::round(c.lat)]}, "properties": p})
        })
        .collect();
    json!({"type": "FeatureCollection", "site": v.site, "key": key, "t": t, "features": feats})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radar::geom::tests::synth_volume;
    use crate::radar::geom::{beam_height, bearing_dist};

    /// Radial velocity at (az, slant r) from a Rankine vortex centred at (vaz, vr) km.
    fn rankine(az: f64, r: f64, el: f64, vaz: f64, vr_km: f64, rmax_km: f64, vmax: f64) -> f64 {
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
        // counter-clockwise tangential wind
        let (ux, uy) = (-dy / d * vt, dx / d * vt);
        let n = (px * px + py * py).sqrt();
        (ux * px + uy * py) / n
    }

    #[test]
    fn finds_rankine_vortices() {
        let elevs = [0.5f32, 0.9, 1.3, 1.8];
        let v = synth_volume(&elevs, 800, 60.0, |m, az, r, el| match m {
            Moment::Ref => Some(if r < 150_000.0 { 45.0 } else { 5.0 }),
            Moment::Vel => {
                let a = rankine(az, r, el, 45.0, 60.0, 0.6, 40.0);
                let b = rankine(az, r, el, 200.0, 100.0, 2.5, 22.0);
                Some((a + b) as f32 + 3.0)
            }
            _ => None,
        });
        let t0 = std::time::Instant::now();
        let d = detect(&v);
        eprintln!("{:?} in {:?}", d, t0.elapsed());
        let near = |az: f32, rng: f32| {
            let (la, lo) = destination(35.0, -97.0, az as f64, rng as f64 * 1000.0);
            d.iter().find(|c| bearing_dist(la, lo, c.lat, c.lon).1 < 3000.0).cloned()
        };
        let t = near(45.0, 60.0).expect("tornado couplet");
        assert_eq!(t.kind, "tvs", "{t:?}");
        assert!(t.dv >= 45.0 && t.diam_km <= 2.5 && t.tilts >= 2, "{t:?}");
        let m = near(200.0, 100.0).expect("mesocyclone");
        assert_eq!(m.kind, "meso", "{m:?}");
        assert!((m.vrot - 22.0).abs() < 5.0 && (2.0..=8.0).contains(&m.diam_km), "{m:?}");
        assert!(d[0].kind == "tvs");
        assert!(d.len() <= 4, "spurious detections: {d:?}");
        let gj = geojson(&v, "test");
        assert_eq!(gj["features"][0]["properties"]["kind"], "tvs");
        assert_eq!(gj["features"][0]["properties"]["site"], "KTST");
    }

    #[test]
    fn ignores_folded_uniform_wind_and_weak_echo() {
        // 35 m/s westerly with a 26 m/s Nyquist: fold lines but no rotation
        let v = synth_volume(&[0.5, 0.9], 800, 26.0, |m, az, _, _| match m {
            Moment::Ref => Some(40.0),
            Moment::Vel => {
                let mut x = 35.0 * az.to_radians().sin();
                while x > 26.0 {
                    x -= 52.0;
                }
                while x < -26.0 {
                    x += 52.0;
                }
                Some(x as f32)
            }
            _ => None,
        });
        let d = detect(&v);
        assert!(d.iter().all(|c| c.kind == "weak") && d.len() <= 2, "{d:?}");
        // a strong vortex in clear air is ignored
        let v = synth_volume(&[0.5, 0.9], 600, 60.0, |m, az, r, el| match m {
            Moment::Ref => Some(5.0),
            Moment::Vel => Some(rankine(az, r, el, 90.0, 50.0, 1.0, 30.0) as f32),
            _ => None,
        });
        assert!(detect(&v).is_empty());
    }
}

#[cfg(test)]
mod real_tests {
    #[test]
    fn real_volumes_run_fast() {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        for f in ["KTLX20130420_205120_V06", "KLOT20200715_230602_V06", "KLOT20210625_075708_V06"] {
            let Ok(b) = std::fs::read(format!("{base}/level2/{f}")) else { continue };
            let v = crate::radar::level2::Decoder::decode_file(&b).unwrap();
            let t0 = std::time::Instant::now();
            let d = super::detect(&v);
            let dt = t0.elapsed();
            eprintln!("{f}: {} detections in {dt:?}", d.len());
            for c in d.iter().take(8) {
                eprintln!("  {c:?}");
            }
            let t0 = std::time::Instant::now();
            let body = crate::radar::volume3d::encode(&v, "REF", "hi").unwrap();
            eprintln!("  volume3d hi REF {} bytes in {:?}", body.len(), t0.elapsed());
            assert!(dt.as_secs_f64() < 5.0);
        }
    }
}
