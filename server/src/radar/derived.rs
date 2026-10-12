//! Volume-derived 2D products drawn like a single sweep on the lowest reflectivity tilt's polar
//! geometry (same TBWS format, 8-bit with a LUT):
//!
//! | id     | product                         | unit        | value = (raw − offset) / scale |
//! |--------|---------------------------------|-------------|--------------------------------|
//! | `CREF` | composite (column max) reflectivity | dBZ     | scale 2, offset 66 (−32 … 94.5) |
//! | `ET`   | 18 dBZ echo top                 | km MSL      | scale 10, offset 2 (0 … 25.3)  |
//! | `VIL`  | vertically integrated liquid    | kg/m²       | scale 2.5, offset 2 (0 … 101)  |
//!
//! Each gate of the lowest tilt is a column at that ground distance; every reflectivity tilt is
//! sampled where its beam centre crosses the column (4/3-earth geometry).
//! ET interpolates the 18 dBZ crossing between the highest tilt ≥ 18 dBZ and the tilt above it
//! (the top tilt's beam height when the echo reaches it). VIL follows Greene & Clark (1972):
//! Σ 3.44·10⁻⁶ · ((Zᵢ + Zᵢ₊₁)/2)^(4/7) · Δh with Z in mm⁶/m³ capped at 56 dBZ.

use super::encode::{encode_l2_named, HEADER_LEN};
use super::geom::{beam_height, PolarSweep, RE_EFF};
use super::level2::{tilts, Moment, MomentData, Radial, Sweep, Volume};
use anyhow::{anyhow, bail, Result};
use rayon::prelude::*;

pub const IDS: [&str; 3] = ["CREF", "ET", "VIL"];

pub fn is_derived(m: &str) -> bool {
    IDS.iter().any(|x| x.eq_ignore_ascii_case(m))
}

/// (scale, offset) of a derived product.
pub fn quant(id: &str) -> (f32, f32) {
    match id {
        "ET" => (10.0, 2.0),
        "VIL" => (2.5, 2.0),
        _ => (2.0, 66.0),
    }
}

/// Derived products a volume can provide.
pub fn available(v: &Volume) -> Vec<String> {
    let n = ref_tilts(v).len();
    let mut out = vec![];
    if n >= 1 {
        out.push("CREF".to_string());
    }
    if n >= 2 {
        out.push("ET".to_string());
        out.push("VIL".to_string());
    }
    out
}

/// Sweep indices of distinct-angle reflectivity tilts with enough radials, by elevation.
fn ref_tilts(v: &Volume) -> Vec<usize> {
    let mut picked: Vec<(f32, usize)> = vec![];
    for t in tilts(v) {
        let Some(&si) = t.sweeps.get("REF") else { continue };
        if picked.iter().any(|(a, _)| (a - t.angle).abs() < 0.2) || v.sweeps[si].radials.len() < 50 {
            continue;
        }
        picked.push((t.angle, si));
    }
    picked.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    picked.into_iter().map(|p| p.1).collect()
}

#[inline]
fn q8(v: f32, (s, o): (f32, f32)) -> u8 {
    (v * s + o).round().clamp(2.0, 255.0) as u8
}

/// Build the derived product as a synthetic sweep (one moment, tagged REF internally).
pub fn sweep(v: &Volume, id: &str) -> Result<Sweep> {
    let id = id.to_ascii_uppercase();
    if !is_derived(&id) {
        bail!("unknown derived product {id}");
    }
    let sis = ref_tilts(v);
    if sis.is_empty() || (id != "CREF" && sis.len() < 2) {
        bail!("{id} needs reflectivity tilts not found in this volume");
    }
    let layers: Vec<PolarSweep> = sis.iter().filter_map(|&si| PolarSweep::new(&v.sweeps[si], Moment::Ref)).collect();
    if layers.is_empty() {
        bail!("no reflectivity");
    }
    let base = &v.sweeps[sis[0]];
    let e0 = layers[0].elev;
    let base_rads: Vec<&Radial> = base.radials.iter().filter(|r| r.moment(Moment::Ref).is_some()).collect();
    let ngates = base_rads.iter().filter_map(|r| r.moment(Moment::Ref).map(|d| d.ngates as usize)).max().unwrap_or(0);
    let d0 = base_rads.first().and_then(|r| r.moment(Moment::Ref)).ok_or_else(|| anyhow!("empty base tilt"))?;
    let (first, gate) = (d0.first_gate_m as f64, d0.gate_m.max(1.0) as f64);
    let q = quant(&id);
    let radar_h = v.height_m as f64;
    // per gate: ground distance and, per layer, (slant range, beam height)
    let geo: Vec<Vec<Option<(f64, f64)>>> = (0..ngates)
        .map(|g| {
            let (_, s) = beam_height(first + g as f64 * gate, e0);
            let phi = s / RE_EFF;
            layers
                .iter()
                .map(|l| {
                    let th = l.elev.to_radians();
                    let c = (th + phi).cos();
                    (c > 0.01).then(|| (RE_EFF * phi.sin() / c, RE_EFF * th.cos() / c - RE_EFF))
                })
                .collect()
        })
        .collect();
    let rows: Vec<Vec<u8>> = base_rads
        .par_iter()
        .map(|r| {
            let az = r.azimuth.rem_euclid(360.0) as f64;
            let mut out = vec![0u8; ngates];
            let mut col: Vec<Option<(f32, f64)>> = Vec::with_capacity(layers.len());
            for (g, o) in out.iter_mut().enumerate() {
                col.clear();
                col.extend(layers.iter().zip(&geo[g]).map(|(l, rh)| rh.and_then(|(rr, h)| l.at(az, rr).map(|z| (z, h)))));
                let val: Option<f32> = match id.as_str() {
                    "CREF" => col.iter().flatten().map(|c| c.0).reduce(f32::max),
                    "ET" => {
                        let top = col.iter().rposition(|c| c.map(|c| c.0 >= 18.0).unwrap_or(false));
                        top.map(|k| {
                            let (zk, hk) = col[k].unwrap();
                            let h = match col.get(k + 1).copied().flatten() {
                                Some((z1, h1)) if z1 < zk => hk + (18.0 - zk as f64) / (z1 - zk) as f64 * (h1 - hk),
                                _ => hk,
                            };
                            ((h + radar_h) / 1000.0) as f32
                        })
                    }
                    _ => {
                        // VIL
                        let pts: Vec<(f64, f64)> = layers
                            .iter()
                            .enumerate()
                            .filter_map(|(i, _)| geo[g][i].map(|(_, h)| (h, col[i].map(|c| 10f64.powf(c.0.min(56.0) as f64 / 10.0)).unwrap_or(0.0))))
                            .collect();
                        let vil: f64 = pts.windows(2).map(|w| 3.44e-6 * ((w[0].1 + w[1].1) / 2.0).powf(4.0 / 7.0) * (w[1].0 - w[0].0).max(0.0)).sum();
                        (vil >= 0.1).then_some(vil as f32)
                    }
                };
                if let Some(x) = val {
                    *o = q8(x, q);
                }
            }
            out
        })
        .collect();
    let radials = base_rads
        .iter()
        .zip(rows)
        .map(|(r, data)| Radial {
            time_ms: r.time_ms,
            azimuth: r.azimuth,
            elevation: r.elevation,
            az_spacing: r.az_spacing,
            status: r.status,
            elev_num: r.elev_num,
            nyquist: 0.0,
            moments: vec![MomentData { moment: Moment::Ref, ngates: ngates as u16, first_gate_m: first as f32, gate_m: gate as f32, word_size: 8, scale: q.0, offset: q.1, data }],
        })
        .collect();
    Ok(Sweep { elev_num: base.elev_num, radials, complete: v.complete })
}

/// Uncompressed TBWS bytes of a derived product.
pub fn encode(v: &Volume, id: &str) -> Result<Vec<u8>> {
    let id = id.to_ascii_uppercase();
    let s = sweep(v, &id)?;
    let e = encode_l2_named(v, &s, Moment::Ref, &id).ok_or_else(|| anyhow!("empty product"))?;
    debug_assert!(e.bytes.len() > HEADER_LEN);
    Ok(e.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radar::geom::tests::synth_volume;

    #[test]
    fn cref_et_vil_of_a_tall_cell() {
        // 50 dBZ below 9 km in the column 40–60 km east, 20 dBZ below 3 km elsewhere
        let elevs = [0.5f32, 1.5, 2.5, 3.5, 4.5, 6.0, 8.0, 10.0, 12.5, 15.6, 19.5];
        let v = synth_volume(&elevs, 600, 30.0, |m, az, r, el| {
            if m != Moment::Ref {
                return None;
            }
            let (h, s) = beam_height(r, el);
            if (40_000.0..60_000.0).contains(&s) && (80.0..100.0).contains(&az) && h < 9000.0 {
                Some(50.0)
            } else if h < 3000.0 {
                Some(20.0)
            } else {
                None
            }
        });
        assert_eq!(available(&v), vec!["CREF", "ET", "VIL"]);
        let at = |id: &str, az: f32, s_m: f64| -> Option<f32> {
            let sw = sweep(&v, id).unwrap();
            let r = sw.radials.iter().min_by(|a, b| (a.azimuth - az).abs().partial_cmp(&(b.azimuth - az).abs()).unwrap()).unwrap();
            let d = r.moment(Moment::Ref).unwrap();
            let g = ((s_m - d.first_gate_m as f64) / d.gate_m as f64).round() as usize;
            d.value(g)
        };
        assert_eq!(at("CREF", 90.0, 50_000.0), Some(50.0));
        assert_eq!(at("CREF", 200.0, 50_000.0), Some(20.0));
        let et = at("ET", 90.0, 50_000.0).unwrap();
        // radar at 400 m: tops between the last tilt under 9 km and 9.4 km MSL
        assert!((7.0..=9.5).contains(&et), "ET {et}");
        let et2 = at("ET", 200.0, 50_000.0).unwrap();
        assert!(et2 < 3.6, "ET {et2}");
        let vil = at("VIL", 90.0, 50_000.0).unwrap();
        // 50 dBZ over ~8 km: 3.44e-6·(1e5)^(4/7)·8000 ≈ 20 kg/m²
        assert!((12.0..28.0).contains(&vil), "VIL {vil}");
        assert!(at("VIL", 200.0, 50_000.0).unwrap_or(0.0) < 1.0);
        let b = encode(&v, "vil").unwrap();
        assert_eq!(&b[64..67], b"VIL");
    }
}
