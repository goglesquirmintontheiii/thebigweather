//! Dual-pol quality control, volume differences and ZDR columns, drawn as sweeps (TBWS, 8-bit
//! with a LUT) through `/api/radar/sweep?moment=…`:
//!
//! | id       | product                                              | unit | scale / offset |
//! |----------|------------------------------------------------------|------|----------------|
//! | `REFQC`  | reflectivity with non-meteorological echoes removed  | dBZ  | 2 / 66         |
//! | `BIO`    | non-meteorological echo mask: 1 = biological/other low-CC, 2 = clutter/AP | class | 1 / 2 |
//! | `DREF`   | reflectivity change vs the previous volume (same tilt angle) | dB | 2 / 128 |
//! | `DVEL`   | radial velocity change vs the previous volume        | m/s  | 2 / 128        |
//! | `ZDRCOL` | ZDR column depth above the freezing level            | km   | 10 / 2         |
//!
//! value = (raw − offset) / scale; raw 0 = no data.
//!
//! * Texture: TDBZ-style, √(mean of squared gate-to-gate reflectivity differences over 5 gates
//!   along the radial), dB.
//! * `REFQC` removes a gate when (CC < `cc_min` and Z < 45 dBZ) or (texture > `texture` and
//!   (CC missing or CC < 0.95)). Defaults: cc_min 0.88, texture 8 dB.
//! * `BIO` marks 2 where the texture test fires, else 1 where CC < `cc_min` and Z < 45 dBZ.
//! * `DREF`/`DVEL`: current − previous at the same azimuth / range (nearest previous tilt angle
//!   within 0.3°). For DREF a missing gate counts as 0 dBZ when the other side is ≥ 10 dBZ (new or
//!   vanished echo); otherwise both must be present.
//! * `ZDRCOL`: per column of the lowest ZDR tilt (beam centres, 4/3 earth), the tilts above the
//!   freezing level are walked upward from the first one; the column continues while
//!   1 ≤ ZDR ≤ 6 dB, Z ≥ 20 dBZ and CC ≥ 0.8 (Z / CC required when the tilt carries them). Depth = (top tilt beam height MSL − freezing level), km; nothing when the first
//!   tilt above the freezing level fails.

use super::encode::encode_l2_named;
use super::geom::{beam_height, PolarSweep, RE_EFF};
use super::level2::{tilts, Moment, MomentData, Radial, Sweep, Volume};
use anyhow::{anyhow, bail, Result};
use rayon::prelude::*;

pub const IDS: [&str; 5] = ["REFQC", "BIO", "DREF", "DVEL", "ZDRCOL"];

pub fn is_qc(m: &str) -> bool {
    IDS.iter().any(|x| x.eq_ignore_ascii_case(m))
}

/// Products needing the previous volume.
pub fn needs_prev(m: &str) -> bool {
    m.eq_ignore_ascii_case("DREF") || m.eq_ignore_ascii_case("DVEL")
}

#[derive(Debug, Clone)]
pub struct Opts {
    pub cc_min: f32,
    pub texture: f32,
    /// freezing level (km MSL)
    pub fzl_km: f32,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { cc_min: 0.88, texture: 8.0, fzl_km: 4.0 }
    }
}

impl Opts {
    /// Part of the sweep cache key (only what the product uses).
    pub fn key(&self, m: &str) -> String {
        match m {
            "REFQC" | "BIO" => format!("cc{:.3}t{:.1}", self.cc_min, self.texture),
            "ZDRCOL" => format!("fzl{:.2}", self.fzl_km),
            _ => String::new(),
        }
    }
}

pub fn quant(id: &str) -> (f32, f32) {
    match id {
        "BIO" => (1.0, 2.0),
        "DREF" | "DVEL" => (2.0, 128.0),
        "ZDRCOL" => (10.0, 2.0),
        _ => (2.0, 66.0),
    }
}

/// QC products a volume can provide (DREF/DVEL also need an earlier volume of the site).
pub fn available(v: &Volume) -> Vec<String> {
    let t = tilts(v);
    let has = |m: &str| t.iter().any(|x| x.sweeps.contains_key(m));
    let mut out = vec![];
    if has("REF") && has("RHO") {
        out.push("REFQC".to_string());
        out.push("BIO".to_string());
    }
    if has("REF") {
        out.push("DREF".to_string());
    }
    if has("VEL") {
        out.push("DVEL".to_string());
    }
    if has("ZDR") && has("REF") && t.iter().filter(|x| x.sweeps.contains_key("ZDR")).count() >= 3 {
        out.push("ZDRCOL".to_string());
    }
    out
}

#[inline]
fn q8(v: f32, (s, o): (f32, f32)) -> u8 {
    (v * s + o).round().clamp(2.0, 255.0) as u8
}

/// Sweep index of moment `m` in tilt `tilt`.
fn sweep_of(v: &Volume, tilt: usize, m: &str) -> Result<usize> {
    let t = tilts(v);
    let t = t.get(tilt).ok_or_else(|| anyhow!("tilt {tilt} not found"))?;
    t.sweeps.get(m).copied().ok_or_else(|| anyhow!("{m} not in tilt {tilt}"))
}

/// Texture (dB) of reflectivity along a radial at gate g.
fn texture(d: &MomentData, g: usize) -> Option<f32> {
    let n = d.ngates as usize;
    let lo = g.saturating_sub(2);
    let hi = (g + 2).min(n.saturating_sub(1));
    let (mut s, mut k) = (0.0f32, 0);
    let mut prev: Option<f32> = None;
    for i in lo..=hi {
        let x = d.value(i);
        if let (Some(a), Some(b)) = (prev, x) {
            s += (b - a).powi(2);
            k += 1;
        }
        prev = x;
    }
    (k >= 2).then(|| (s / k as f32).sqrt())
}

/// Build a synthetic sweep from per-radial rows on the geometry of `base` (moment `m`).
fn rebuild(base: &Sweep, m: Moment, rows: Vec<Vec<u8>>, q: (f32, f32)) -> Sweep {
    let rads: Vec<&Radial> = base.radials.iter().filter(|r| r.moment(m).is_some()).collect();
    let radials = rads
        .iter()
        .zip(rows)
        .map(|(r, data)| {
            let d = r.moment(m).unwrap();
            Radial {
                time_ms: r.time_ms,
                azimuth: r.azimuth,
                elevation: r.elevation,
                az_spacing: r.az_spacing,
                status: r.status,
                elev_num: r.elev_num,
                nyquist: 0.0,
                moments: vec![MomentData { moment: Moment::Ref, ngates: data.len() as u16, first_gate_m: d.first_gate_m, gate_m: d.gate_m, word_size: 8, scale: q.0, offset: q.1, data }],
            }
        })
        .collect();
    Sweep { elev_num: base.elev_num, radials, complete: base.complete }
}

/// REFQC or BIO on one tilt.
pub fn qc_sweep(v: &Volume, tilt: usize, id: &str, o: &Opts) -> Result<Sweep> {
    let si = sweep_of(v, tilt, "REF")?;
    let base = &v.sweeps[si];
    let cc = sweep_of(v, tilt, "RHO").ok().and_then(|ci| PolarSweep::new(&v.sweeps[ci], Moment::Rho));
    let q = quant(id);
    let bio = id == "BIO";
    let rads: Vec<&Radial> = base.radials.iter().filter(|r| r.moment(Moment::Ref).is_some()).collect();
    let rows: Vec<Vec<u8>> = rads
        .par_iter()
        .map(|r| {
            let d = r.moment(Moment::Ref).unwrap();
            let az = r.azimuth.rem_euclid(360.0) as f64;
            let ri = cc.as_ref().and_then(|c| c.radial_at(az));
            (0..d.ngates as usize)
                .map(|g| {
                    let Some(z) = d.value(g) else { return 0 };
                    let rr = d.first_gate_m as f64 + g as f64 * d.gate_m as f64;
                    let c = match (&cc, ri) {
                        (Some(c), Some(ri)) => c.gate_at(rr).and_then(|gi| c.value(ri, gi)),
                        _ => None,
                    };
                    let tex = texture(d, g).unwrap_or(0.0);
                    let clutter = tex > o.texture && c.map(|c| c < 0.95).unwrap_or(true);
                    let lowcc = c.map(|c| c < o.cc_min).unwrap_or(false) && z < 45.0;
                    if bio {
                        if clutter {
                            q8(2.0, q)
                        } else if lowcc {
                            q8(1.0, q)
                        } else {
                            0
                        }
                    } else if clutter || lowcc {
                        0
                    } else {
                        q8(z, q)
                    }
                })
                .collect()
        })
        .collect();
    Ok(rebuild(base, Moment::Ref, rows, q))
}

/// Tilt of `prev` closest in angle to tilt `tilt` of `cur` (within 0.3°) with moment `m`.
fn matching_tilt(cur: &Volume, tilt: usize, prev: &Volume, m: &str) -> Result<usize> {
    let ct = tilts(cur);
    let a = ct.get(tilt).ok_or_else(|| anyhow!("tilt {tilt} not found"))?.angle;
    let pt = tilts(prev);
    pt.iter()
        .filter(|t| t.sweeps.contains_key(m))
        .min_by(|x, y| (x.angle - a).abs().partial_cmp(&(y.angle - a).abs()).unwrap_or(std::cmp::Ordering::Equal))
        .filter(|t| (t.angle - a).abs() <= 0.3)
        .and_then(|t| t.sweeps.get(m).copied())
        .ok_or_else(|| anyhow!("previous volume has no {m} tilt near {a:.1}°"))
}

/// DREF / DVEL: current − previous volume on one tilt.
pub fn diff_sweep(cur: &Volume, prev: &Volume, tilt: usize, id: &str) -> Result<Sweep> {
    let (m, code) = if id == "DVEL" { (Moment::Vel, "VEL") } else { (Moment::Ref, "REF") };
    let si = sweep_of(cur, tilt, code)?;
    let pi = matching_tilt(cur, tilt, prev, code)?;
    let base = &cur.sweeps[si];
    let old = PolarSweep::new(&prev.sweeps[pi], m).ok_or_else(|| anyhow!("previous {code} sweep is empty"))?;
    let q = quant(id);
    let rads: Vec<&Radial> = base.radials.iter().filter(|r| r.moment(m).is_some()).collect();
    let rows: Vec<Vec<u8>> = rads
        .par_iter()
        .map(|r| {
            let d = r.moment(m).unwrap();
            let az = r.azimuth.rem_euclid(360.0) as f64;
            let ri = old.radial_at(az);
            (0..d.ngates as usize)
                .map(|g| {
                    let rr = d.first_gate_m as f64 + g as f64 * d.gate_m as f64;
                    let a = d.value(g);
                    let b = ri.and_then(|ri| old.gate_at(rr).and_then(|gi| old.value(ri, gi)));
                    let covered = ri.is_some() && old.gate_at(rr).is_some();
                    let diff = match (a, b) {
                        (Some(a), Some(b)) => Some(a - b),
                        (Some(a), None) if m == Moment::Ref && covered && a >= 10.0 => Some(a),
                        (None, Some(b)) if m == Moment::Ref && b >= 10.0 => Some(-b),
                        _ => None,
                    };
                    diff.map(|x| q8(x.clamp(-60.0, 60.0), q)).unwrap_or(0)
                })
                .collect()
        })
        .collect();
    Ok(rebuild(base, m, rows, q))
}

/// ZDR column depth above the freezing level (km).
pub fn zdrcol_sweep(v: &Volume, fzl_km: f32) -> Result<Sweep> {
    let t = tilts(v);
    let mut picked: Vec<(f32, usize, Option<usize>)> = vec![];
    for x in &t {
        let Some(&zi) = x.sweeps.get("ZDR") else { continue };
        if picked.iter().any(|(a, _, _)| (a - x.angle).abs() < 0.2) || v.sweeps[zi].radials.len() < 50 {
            continue;
        }
        picked.push((x.angle, zi, x.sweeps.get("REF").copied()));
    }
    picked.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    if picked.len() < 3 {
        bail!("ZDRCOL needs at least 3 ZDR tilts");
    }
    let zdr: Vec<PolarSweep> = picked.iter().filter_map(|p| PolarSweep::new(&v.sweeps[p.1], Moment::Zdr)).collect();
    let refl: Vec<Option<PolarSweep>> = picked.iter().map(|p| p.2.and_then(|ri| PolarSweep::new(&v.sweeps[ri], Moment::Ref))).collect();
    // CC of the same tilt (when present) screens non-meteorological echoes
    let ccs: Vec<Option<PolarSweep>> = picked
        .iter()
        .map(|p| t.iter().find(|x| (x.angle - p.0).abs() < 0.2).and_then(|x| x.sweeps.get("RHO")).and_then(|&ci| PolarSweep::new(&v.sweeps[ci], Moment::Rho)))
        .collect();
    if zdr.len() != picked.len() {
        bail!("empty ZDR tilt");
    }
    let base = &v.sweeps[picked[0].1];
    let e0 = zdr[0].elev;
    let rads: Vec<&Radial> = base.radials.iter().filter(|r| r.moment(Moment::Zdr).is_some()).collect();
    let d0 = rads.first().and_then(|r| r.moment(Moment::Zdr)).ok_or_else(|| anyhow!("empty ZDR tilt"))?;
    let ngates = rads.iter().filter_map(|r| r.moment(Moment::Zdr).map(|d| d.ngates as usize)).max().unwrap_or(0);
    let (first, gate) = (d0.first_gate_m as f64, d0.gate_m.max(1.0) as f64);
    let radar_h = v.height_m as f64;
    let fzl = fzl_km as f64 * 1000.0;
    let q = quant("ZDRCOL");
    // per gate: per tilt (slant range, beam height MSL)
    let geo: Vec<Vec<Option<(f64, f64)>>> = (0..ngates)
        .map(|g| {
            let (_, s) = beam_height(first + g as f64 * gate, e0);
            let phi = s / RE_EFF;
            zdr.iter()
                .map(|l| {
                    let th = l.elev.to_radians();
                    let c = (th + phi).cos();
                    (c > 0.01).then(|| (RE_EFF * phi.sin() / c, RE_EFF * th.cos() / c - RE_EFF + radar_h))
                })
                .collect()
        })
        .collect();
    let rows: Vec<Vec<u8>> = rads
        .par_iter()
        .map(|r| {
            let az = r.azimuth.rem_euclid(360.0) as f64;
            (0..ngates)
                .map(|g| {
                    let mut top: Option<f64> = None;
                    for (k, l) in zdr.iter().enumerate() {
                        let Some((rr, h)) = geo[g][k] else { break };
                        if h < fzl {
                            continue;
                        }
                        let zd = l.at(az, rr);
                        // reflectivity / CC must be there (and meteorological) when the tilt has them
                        let z_ok = refl[k].as_ref().map(|p| p.at(az, rr).map(|x| x >= 20.0).unwrap_or(false)).unwrap_or(true);
                        let cc_ok = ccs[k].as_ref().map(|p| p.at(az, rr).map(|x| x >= 0.8).unwrap_or(true)).unwrap_or(true);
                        let ok = zd.map(|x| (1.0..=6.0).contains(&x)).unwrap_or(false) && z_ok && cc_ok;
                        if !ok {
                            break;
                        }
                        top = Some(h);
                    }
                    top.map(|h| q8(((h - fzl) / 1000.0) as f32, q)).unwrap_or(0)
                })
                .collect()
        })
        .collect();
    Ok(rebuild(base, Moment::Zdr, rows, q))
}

/// Uncompressed TBWS bytes of a QC product (`prev` for DREF/DVEL).
pub fn encode(v: &Volume, prev: Option<&Volume>, tilt: usize, id: &str, o: &Opts) -> Result<Vec<u8>> {
    let id = id.to_ascii_uppercase();
    let s = product_sweep(v, prev, tilt, &id, o)?;
    let e = encode_l2_named(v, &s, Moment::Ref, &id).ok_or_else(|| anyhow!("empty product"))?;
    Ok(e.bytes)
}

/// The QC product as a synthetic sweep (data tagged REF; see `quant` for scaling).
pub fn product_sweep(v: &Volume, prev: Option<&Volume>, tilt: usize, id: &str, o: &Opts) -> Result<Sweep> {
    match id {
        "REFQC" | "BIO" => qc_sweep(v, tilt, id, o),
        "DREF" | "DVEL" => diff_sweep(v, prev.ok_or_else(|| anyhow!("{id} needs the previous volume"))?, tilt, id),
        "ZDRCOL" => zdrcol_sweep(v, o.fzl_km),
        _ => bail!("unknown QC product {id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radar::geom::tests::{enc, synth_volume};

    /// Add a RHO moment to every radial of a synthetic volume.
    fn with_cc(mut v: Volume, f: impl Fn(f64, f64) -> Option<f32>) -> Volume {
        for s in v.sweeps.iter_mut() {
            for r in s.radials.iter_mut() {
                let n = r.moments[0].ngates as usize;
                let data = (0..n).map(|g| enc(f(r.azimuth as f64, 2125.0 + g as f64 * 250.0), 300.0, -60.5)).collect();
                r.moments.push(MomentData { moment: Moment::Rho, ngates: n as u16, first_gate_m: 2125.0, gate_m: 250.0, word_size: 8, scale: 300.0, offset: -60.5, data });
            }
        }
        v
    }

    fn val(s: &Sweep, az: f32, r: f64) -> Option<f32> {
        let rad = s.radials.iter().min_by(|a, b| (a.azimuth - az).abs().partial_cmp(&(b.azimuth - az).abs()).unwrap()).unwrap();
        let d = rad.moment(Moment::Ref).unwrap();
        d.value(((r - d.first_gate_m as f64) / d.gate_m as f64).round() as usize)
    }

    #[test]
    fn refqc_and_bio() {
        // rain (CC 0.98) east, birds (CC 0.5, 15 dBZ) west, speckled clutter north near the radar
        let v = synth_volume(&[0.5, 1.5], 300, 30.0, |m, az, r, _| match m {
            Moment::Ref if (80.0..100.0).contains(&az) => Some(35.0),
            Moment::Ref if (260.0..280.0).contains(&az) => Some(15.0),
            Moment::Ref if (350.0..360.0).contains(&az) && r < 20_000.0 => Some(if ((r / 250.0) as i64) % 2 == 0 { 50.0 } else { 20.0 }),
            _ => None,
        });
        let v = with_cc(v, |az, _| Some(if (260.0..280.0).contains(&az) { 0.5 } else if (350.0..360.0).contains(&az) { 0.7 } else { 0.98 }));
        let o = Opts::default();
        let qc = qc_sweep(&v, 0, "REFQC", &o).unwrap();
        assert_eq!(val(&qc, 90.0, 50_000.0), Some(35.0));
        assert_eq!(val(&qc, 270.0, 50_000.0), None);
        assert_eq!(val(&qc, 355.0, 10_000.0), None);
        let bio = qc_sweep(&v, 0, "BIO", &o).unwrap();
        assert_eq!(val(&bio, 270.0, 50_000.0), Some(1.0));
        assert_eq!(val(&bio, 355.0, 10_000.0), Some(2.0));
        assert_eq!(val(&bio, 90.0, 50_000.0), None);
        assert_eq!(available(&v), vec!["REFQC", "BIO", "DREF", "DVEL"]);
        let b = encode(&v, None, 0, "refqc", &o).unwrap();
        assert_eq!(&b[64..69], b"REFQC");
    }

    #[test]
    fn dref_difference() {
        let cur = synth_volume(&[0.5], 300, 30.0, |m, az, _, _| (m == Moment::Ref && (80.0..100.0).contains(&az)).then_some(40.0));
        let prev = synth_volume(&[0.5], 300, 30.0, |m, az, _, _| (m == Moment::Ref && (85.0..120.0).contains(&az)).then_some(30.0));
        let d = diff_sweep(&cur, &prev, 0, "DREF").unwrap();
        assert_eq!(val(&d, 90.0, 40_000.0), Some(10.0));
        // new echo where nothing was before
        assert_eq!(val(&d, 82.0, 40_000.0), Some(40.0));
        // echo that vanished
        assert_eq!(val(&d, 110.0, 40_000.0), Some(-30.0));
        assert_eq!(val(&d, 200.0, 40_000.0), None);
        assert!(product_sweep(&cur, None, 0, "DREF", &Opts::default()).is_err());
    }

    #[test]
    fn zdr_column_depth() {
        // ZDR ≥ 1 up to 6 km MSL inside az 80–100 / 30–40 km, freezing level 4 km
        let elevs = [0.5f32, 1.5, 2.5, 3.5, 4.5, 6.0, 8.0, 10.0, 12.5];
        let v = synth_volume(&elevs, 400, 30.0, |m, az, r, el| {
            let (h, s) = beam_height(r, el);
            let h = h + 400.0;
            let inside = (80.0..100.0).contains(&az) && (30_000.0..40_000.0).contains(&s);
            match m {
                Moment::Ref if inside => Some(50.0),
                Moment::Zdr if inside && h < 6000.0 => Some(2.0),
                Moment::Zdr if inside => Some(0.2),
                Moment::Zdr => Some(0.3),
                _ => None,
            }
        });
        let s = zdrcol_sweep(&v, 4.0).unwrap();
        let d = val(&s, 90.0, 35_000.0).unwrap();
        assert!((0.5..=2.1).contains(&d), "depth {d}");
        assert_eq!(val(&s, 200.0, 35_000.0), None);
        // freezing level above the column top: nothing
        let s2 = zdrcol_sweep(&v, 7.0).unwrap();
        assert_eq!(val(&s2, 90.0, 35_000.0), None);
        assert!(available(&v).contains(&"ZDRCOL".to_string()));
    }
}
