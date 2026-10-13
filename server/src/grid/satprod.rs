//! GOES ABI derived products:
//! * night fog / low-cloud index grid layer `goes/<sat>/fog` (CONUS / PACUS sector, 2 km);
//! * overshooting-top / cloud-top-cooling detection on band 13 (overlay `ot`);
//! * fire detections from ABI L2 FDC (overlay `goesfire`).
//!
//! Fog index (0–100, heuristic):
//! * night (solar zenith ≥ 90°): BTD = BT13 − BT7 (water clouds emit less at 3.9 µm);
//!   index = clamp((BTD − 1 K) / 4 K) × clamp((BT13 − 245 K) / 10 K) × 100 (warm, low tops only);
//! * day (zenith ≤ 80°): band 2 reflectance and the 3.9 µm solar reflection of water droplets:
//!   clamp((R2 − 0.2) / 0.3) × clamp((BT13 − 265 K) / 10 K) × clamp((BT7 − BT13 − 5 K) / 10 K) × 100;
//! * twilight (80–90°): linear blend.
//!
//! Overshooting tops (band 13 at native 2 km): pixel BT < `max_bt` (default 215 K) that is the
//! minimum of its 5×5 box and at least `delta` K (default 6.5) colder than the mean of the ring of
//! pixels 4–6 px (≈ 8–12 km) away; detections closer than 5 px keep the coldest.
//! Cloud-top cooling: BT13 drop ≥ 6 K between the newest scan and the one ~15 min earlier
//! (minimum over a 3 px neighbourhood of the older scan, to tolerate motion), for pixels colder
//! than 260 K; reported as local maxima of cooling on a 6 px grid.

use super::rgb::{geos_latlon, solar_zenith, Band};
use super::sources::LayerDef;
use super::{Grid, Proj};
use anyhow::{anyhow, bail, Result};

pub const FOG_SATS: &[(u32, &str)] = &[(19, "GOES-19 (East) · CONUS"), (18, "GOES-18 (West) · PACUS")];

pub fn fog_layers() -> Vec<LayerDef> {
    FOG_SATS
        .iter()
        .map(|(sat, name)| LayerDef {
            id: format!("goes/{sat}/fog"),
            group: format!("Satellite · {name}"),
            name: "Fog / Low Cloud Index".into(),
            units: "%",
            cmap: "FOG",
            product: format!("{sat}|conus|13"),
            source: "goesfog",
            step_min: 5,
            contour: Some(serde_json::json!({"interval": 25, "base": 0})),
            ..Default::default()
        })
        .collect()
}

#[inline]
fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// Fog / low-cloud index (0–100) of one pixel; NaN inputs where unavailable.
pub fn fog_index(bt13: f32, bt7: f32, r2: f32, sza: f32) -> f32 {
    if !bt13.is_finite() || !bt7.is_finite() {
        return f32::NAN;
    }
    let night = clamp01((bt13 - bt7 - 1.0) / 4.0) * clamp01((bt13 - 245.0) / 10.0);
    let day = if r2.is_finite() { clamp01((r2 - 0.2) / 0.3) * clamp01((bt13 - 265.0) / 10.0) * clamp01((bt7 - bt13 - 5.0) / 10.0) } else { 0.0 };
    let w = clamp01((sza - 80.0) / 10.0);
    100.0 * (day * (1.0 - w) + night * w)
}

/// Column / row lookup tables from a base fixed grid onto another band's grid.
fn align(base: &Band, b: &Band) -> Result<(Vec<i32>, Vec<i32>)> {
    let (Proj::Geos { x0: bx0, dx: bdx, y0: by0, dy: bdy, .. }, Proj::Geos { x0, dx, y0, dy, .. }) = (&base.proj, &b.proj) else { bail!("not a fixed grid") };
    let cols = (0..base.nx).map(|i| ((bx0 + i as f64 * bdx - x0) / dx).round() as i32).map(|c| if c >= 0 && (c as usize) < b.nx { c } else { -1 }).collect();
    let rows = (0..base.ny).map(|j| ((by0 + j as f64 * bdy - y0) / dy).round() as i32).map(|c| if c >= 0 && (c as usize) < b.ny { c } else { -1 }).collect();
    Ok((cols, rows))
}

/// Fog index grid from band 13 (base), band 7 and (optional) band 2.
pub fn fog_grid(b13: &Band, b7: &Band, b2: Option<&Band>) -> Result<Grid> {
    use rayon::prelude::*;
    let (c7, r7) = align(b13, b7)?;
    let m2 = match b2 {
        Some(b) => Some((align(b13, b)?, b)),
        None => None,
    };
    let nx = b13.nx;
    let mut vals = vec![f32::NAN; b13.nx * b13.ny];
    vals.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
        for (i, o) in row.iter_mut().enumerate() {
            let t13 = b13.vals[j * nx + i];
            let (c, r) = (c7[i], r7[j]);
            if c < 0 || r < 0 || !t13.is_finite() {
                continue;
            }
            let t7 = b7.vals[r as usize * b7.nx + c as usize];
            let Some((lat, lon)) = geos_latlon(&b13.proj, i, j) else { continue };
            let sza = solar_zenith(b13.time, lat, lon) as f32;
            let r2 = match &m2 {
                Some(((cc, rr), b)) if sza < 90.0 && cc[i] >= 0 && rr[j] >= 0 => b.vals[rr[j] as usize * b.nx + cc[i] as usize],
                _ => f32::NAN,
            };
            let v = fog_index(t13, t7, r2, sza);
            if v.is_finite() && v >= 1.0 {
                *o = v;
            }
        }
    });
    Ok(Grid::from_values(b13.nx, b13.ny, b13.proj.clone(), &vals, b13.time, b13.time))
}

/// One overshooting-top candidate: pixel (i, j), BT (K), BT − ring mean (K, negative).
#[derive(Debug, Clone, PartialEq)]
pub struct Ot {
    pub i: usize,
    pub j: usize,
    pub bt: f32,
    pub delta: f32,
}

pub fn detect_ot(b: &Band, max_bt: f32, delta: f32) -> Vec<Ot> {
    let (nx, ny) = (b.nx, b.ny);
    let at = |i: isize, j: isize| -> f32 {
        if i < 0 || j < 0 || i as usize >= nx || j as usize >= ny {
            f32::NAN
        } else {
            b.vals[j as usize * nx + i as usize]
        }
    };
    let mut c: Vec<Ot> = vec![];
    for j in 6..ny.saturating_sub(6) {
        for i in 6..nx.saturating_sub(6) {
            let v = b.vals[j * nx + i];
            if !(v < max_bt) {
                continue;
            }
            let (ii, jj) = (i as isize, j as isize);
            let mut is_min = true;
            'b: for dj in -2..=2 {
                for di in -2..=2 {
                    if (di, dj) != (0, 0) && at(ii + di, jj + dj) < v {
                        is_min = false;
                        break 'b;
                    }
                }
            }
            if !is_min {
                continue;
            }
            let (mut s, mut n) = (0.0f32, 0);
            for dj in -6isize..=6 {
                for di in -6isize..=6 {
                    let r2 = di * di + dj * dj;
                    if (16..=36).contains(&r2) {
                        let x = at(ii + di, jj + dj);
                        if x.is_finite() {
                            s += x;
                            n += 1;
                        }
                    }
                }
            }
            if n < 20 {
                continue;
            }
            let d = v - s / n as f32;
            if d <= -delta {
                c.push(Ot { i, j, bt: v, delta: d });
            }
        }
    }
    // keep the coldest within 5 px
    c.sort_by(|a, b| a.bt.partial_cmp(&b.bt).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Ot> = vec![];
    for o in c {
        if out.iter().all(|k| (k.i as isize - o.i as isize).abs() > 5 || (k.j as isize - o.j as isize).abs() > 5) {
            out.push(o);
        }
        if out.len() >= 2000 {
            break;
        }
    }
    out
}

/// Cooling (K, positive = colder now) at pixel (i, j) of `now` vs `before` (aligned by
/// fixed-grid angles; min over a 3 px neighbourhood of the older scan).
pub fn cooling_at(now: &Band, before: &Band, i: usize, j: usize) -> Option<f32> {
    let (Proj::Geos { x0, dx, y0, dy, .. }, Proj::Geos { x0: bx0, dx: bdx, y0: by0, dy: bdy, .. }) = (&now.proj, &before.proj) else { return None };
    let ci = ((x0 + i as f64 * dx - bx0) / bdx).round() as isize;
    let cj = ((y0 + j as f64 * dy - by0) / bdy).round() as isize;
    let mut m = f32::INFINITY;
    for dj in -3..=3 {
        for di in -3..=3 {
            let (a, b) = (ci + di, cj + dj);
            if a >= 0 && b >= 0 && (a as usize) < before.nx && (b as usize) < before.ny {
                let v = before.vals[b as usize * before.nx + a as usize];
                if v.is_finite() {
                    m = m.min(v);
                }
            }
        }
    }
    let v = now.vals[j * now.nx + i];
    (m.is_finite() && v.is_finite()).then(|| m - v)
}

/// Cloud-top cooling points: (i, j, BT now, cooling K) local maxima on a 6 px grid.
pub fn cooling_points(now: &Band, before: &Band, min_cool: f32) -> Vec<(usize, usize, f32, f32)> {
    let mut out = vec![];
    let step = 6;
    let mut j = step;
    while j + step < now.ny {
        let mut i = step;
        while i + step < now.nx {
            let mut best: Option<(usize, usize, f32, f32)> = None;
            for jj in j..j + step {
                for ii in i..i + step {
                    let v = now.vals[jj * now.nx + ii];
                    if !(v < 260.0) {
                        continue;
                    }
                    if let Some(c) = cooling_at(now, before, ii, jj) {
                        if c >= min_cool && best.map(|b| c > b.3).unwrap_or(true) {
                            best = Some((ii, jj, v, c));
                        }
                    }
                }
            }
            out.extend(best);
            i += step;
        }
        j += step;
        if out.len() > 5000 {
            break;
        }
    }
    out
}

/// One FDC fire pixel.
#[derive(Debug, Clone)]
pub struct Fire {
    pub lat: f64,
    pub lon: f64,
    /// fire radiative power (MW)
    pub frp: Option<f32>,
    /// fire temperature (K)
    pub temp: Option<f32>,
    /// fire area (km²)
    pub area: Option<f32>,
    pub mask: u8,
}

/// ABI FDC mask code → class text (10–15 instantaneous, 30–35 temporally filtered).
pub fn fire_class(mask: u8) -> Option<&'static str> {
    Some(match mask % 20 {
        10 => "processed",
        11 => "saturated",
        12 => "cloud contaminated",
        13 => "high probability",
        14 => "medium probability",
        15 => "low probability",
        _ => return None,
    })
    .filter(|_| (10..=15).contains(&mask) || (30..=35).contains(&mask))
}

/// Fire pixels of an ABI-L2-FDC file (NetCDF-4).
pub fn read_fdc(bytes: &[u8]) -> Result<(i64, Vec<Fire>)> {
    let f = netcdf_reader::NcFile::from_bytes(bytes).map_err(|e| anyhow!("netcdf: {e}"))?;
    let mv = f.variable("Mask").map_err(|e| anyhow!("no Mask: {e}"))?;
    let shape = mv.shape();
    if shape.len() != 2 {
        bail!("unexpected Mask shape");
    }
    let (ny, nx) = (shape[0] as usize, shape[1] as usize);
    let mask: Vec<i16> = f.read_variable::<i16>("Mask").map_err(|e| anyhow!("read Mask: {e}"))?.into_raw_vec_and_offset().0;
    let fl = |name: &str| -> Option<(Vec<f32>, f32, f32, f32)> {
        let v = f.variable(name).ok()?;
        let s = v.attribute("scale_factor").and_then(|a| a.value.as_f64()).unwrap_or(1.0) as f32;
        let o = v.attribute("add_offset").and_then(|a| a.value.as_f64()).unwrap_or(0.0) as f32;
        let fill = v.attribute("_FillValue").and_then(|a| a.value.as_f64()).unwrap_or(-1.0) as f32;
        if let Ok(x) = f.read_variable::<f32>(name) {
            return Some((x.into_raw_vec_and_offset().0, 1.0, 0.0, fill));
        }
        let unsigned = v.attribute("_Unsigned").and_then(|a| a.value.as_string()).map(|s| s == "true").unwrap_or(false);
        let raw: Vec<i16> = f.read_variable::<i16>(name).ok()?.into_raw_vec_and_offset().0;
        Some((raw.iter().map(|&r| if unsigned { (r as u16) as f32 } else { r as f32 }).collect(), s, o, fill))
    };
    let (power, temp, area) = (fl("Power"), fl("Temp"), fl("Area"));
    let val = |x: &Option<(Vec<f32>, f32, f32, f32)>, k: usize| -> Option<f32> {
        let (v, s, o, fill) = x.as_ref()?;
        let r = *v.get(k)?;
        (r.is_finite() && r != *fill).then(|| r * s + o).filter(|y| *y > 0.0)
    };
    let axis = |name: &str| -> Result<(f64, f64)> {
        let v = f.variable(name).map_err(|e| anyhow!("no {name}: {e}"))?;
        let s = v.attribute("scale_factor").and_then(|a| a.value.as_f64()).unwrap_or(1.0);
        let o = v.attribute("add_offset").and_then(|a| a.value.as_f64()).unwrap_or(0.0);
        let r: Vec<i16> = f.read_variable::<i16>(name).map_err(|e| anyhow!("read {name}: {e}"))?.into_raw_vec_and_offset().0;
        let first = r.first().copied().unwrap_or(0) as f64 * s + o;
        let step = if r.len() > 1 { (r[1] as f64 - r[0] as f64) * s } else { s };
        Ok((first, step))
    };
    let (x0, dx) = axis("x")?;
    let (y0, dy) = axis("y")?;
    let p = f.variable("goes_imager_projection").map_err(|_| anyhow!("no projection"))?;
    let a = |k: &str, d: f64| p.attribute(k).and_then(|a| a.value.as_f64()).unwrap_or(d);
    let r_eq = a("semi_major_axis", 6_378_137.0);
    let proj = Proj::Geos { h: a("perspective_point_height", 35_786_023.0) + r_eq, r_eq, r_pol: a("semi_minor_axis", 6_356_752.31414), lon0: a("longitude_of_projection_origin", -75.0), x0, dx, y0, dy };
    let time = f
        .global_attribute("time_coverage_start")
        .ok()
        .and_then(|a| a.value.as_string())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s.replace(".0Z", "Z")).ok().or_else(|| chrono::DateTime::parse_from_rfc3339(&s).ok()))
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    let mut out = vec![];
    for (k, &m) in mask.iter().enumerate().take(nx * ny) {
        let m = m as i32;
        if !(0..=255).contains(&m) || fire_class(m as u8).is_none() {
            continue;
        }
        let Some((lat, lon)) = geos_latlon(&proj, k % nx, k / nx) else { continue };
        out.push(Fire { lat, lon, frp: val(&power, k), temp: val(&temp, k), area: val(&area, k), mask: m as u8 });
        if out.len() >= 20000 {
            break;
        }
    }
    Ok((time, out))
}

// ---------- service glue (fog layer) ----------

impl super::service::GridService {
    /// `goesfog|layer|bucket|band-13 key` → fog index grid.
    pub(super) async fn fog_load(&self, layer: &str, bucket: &str, key13: &str) -> Result<Grid> {
        let l = self.layer(layer)?;
        if l.source != "goesfog" || !bucket.starts_with("noaa-goes") || key13.contains("..") {
            bail!("bad fog key");
        }
        let name = key13.rsplit('/').next().unwrap_or("");
        let start = name.split('_').find(|p| p.starts_with('s')).ok_or_else(|| anyhow!("bad file name"))?.to_string();
        let mpos = key13.rfind("-M").ok_or_else(|| anyhow!("bad file name"))?;
        let prefix = &key13[..mpos + 2];
        let sat = l.product.split('|').next().unwrap_or("19").to_string();
        let objs = self.list_cached(bucket, prefix, 45).await?;
        let find = |b: u32| objs.iter().find(|o| o.key.contains(&format!("C{b:02}_G{sat}_{start}"))).map(|o| o.key.clone());
        let k7 = find(7).ok_or_else(|| anyhow!("band 7 not published yet for this scan"))?;
        let k2 = find(2);
        let (u13, u7) = (crate::s3::object_url(bucket, key13), crate::s3::object_url(bucket, &k7));
        let (b13, b7) = tokio::try_join!(self.fetch(&u13, None, true), self.fetch(&u7, None, true))?;
        // band 2 only matters in daylight; a failure just means night-only logic
        let b2 = match k2 {
            Some(k) => self.fetch(&crate::s3::object_url(bucket, &k), None, true).await.ok(),
            None => None,
        };
        let out = self
            .run_blocking(move || {
                let t13 = super::goes::read_band(&b13, 0)?;
                let t7 = super::goes::read_band(&b7, 0)?;
                let r2 = b2.and_then(|b| super::goes::read_band(&b, t13.nx.max(t13.ny)).ok());
                fog_grid(&t13, &t7, r2.as_ref())
            })
            .await;
        match &out {
            Ok(_) => self.health.ok("grid-goesfog", "GOES fog / low cloud", ""),
            Err(e) => self.health.err("grid-goesfog", "GOES fog / low cloud", e),
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band(nx: usize, ny: usize, f: impl Fn(usize, usize) -> f32) -> Band {
        let proj = Proj::Geos { h: 42_164_160.0, r_eq: 6_378_137.0, r_pol: 6_356_752.31414, lon0: -75.0, x0: -0.02, dx: 56e-6, y0: 0.10, dy: -56e-6 };
        let vals = (0..nx * ny).map(|k| f(k % nx, k / nx)).collect();
        Band { nx, ny, proj, vals, time: 1_791_700_000_000 }
    }

    #[test]
    fn fog_index_regimes() {
        // night: warm low cloud with 3 K BTD → half-ish; clear land (BTD 0) → 0
        assert!((fog_index(280.0, 277.0, f32::NAN, 120.0) - 50.0).abs() < 0.1);
        assert_eq!(fog_index(280.0, 280.5, f32::NAN, 120.0), 0.0);
        // night cold cirrus: no fog
        assert_eq!(fog_index(230.0, 220.0, f32::NAN, 120.0), 0.0);
        // day: bright, warm, strong 3.9 µm reflection
        assert!((fog_index(278.0, 298.0, 0.6, 40.0) - 100.0).abs() < 0.1);
        // day: dark surface
        assert_eq!(fog_index(290.0, 300.0, 0.08, 40.0), 0.0);
        assert!(fog_index(f32::NAN, 1.0, 0.5, 10.0).is_nan());
    }

    #[test]
    fn overshooting_top_and_cooling() {
        // anvil at 220 K with a 205 K dome around (40, 30)
        let anvil = |i: usize, j: usize| {
            let d2 = (i as f32 - 40.0).powi(2) + (j as f32 - 30.0).powi(2);
            220.0 - 15.0 * (-d2 / 4.0).exp()
        };
        let b = band(80, 60, anvil);
        let ot = detect_ot(&b, 215.0, 6.5);
        assert_eq!(ot.len(), 1, "{ot:?}");
        assert_eq!((ot[0].i, ot[0].j), (40, 30));
        assert!(ot[0].delta < -10.0);
        // a flat 210 K anvil has no OT
        assert!(detect_ot(&band(80, 60, |_, _| 210.0), 215.0, 6.5).is_empty());
        // cooling: 15 min earlier the same area was 10 K warmer
        let before = band(80, 60, |i, j| anvil(i, j) + 10.0);
        let c = cooling_at(&b, &before, 40, 30).unwrap();
        assert!(c > 9.0 && c < 25.0, "{c}");
        let pts = cooling_points(&b, &before, 6.0);
        assert!(!pts.is_empty());
        assert!(pts.iter().all(|p| p.3 >= 6.0));
        let g = fog_grid(&band(20, 10, |_, _| 280.0), &band(20, 10, |_, _| 276.0), None).unwrap();
        assert_eq!((g.nx, g.ny), (20, 10));
    }

    #[test]
    fn fire_classes() {
        assert_eq!(fire_class(10), Some("processed"));
        assert_eq!(fire_class(33), Some("high probability"));
        assert_eq!(fire_class(40), None);
        assert_eq!(fire_class(0), None);
        assert_eq!(fire_class(16), None);
        assert_eq!(fog_layers()[0].id, "goes/19/fog");
    }
}
