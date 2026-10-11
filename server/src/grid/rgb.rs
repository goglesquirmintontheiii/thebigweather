//! GOES ABI RGB composites (Air Mass, Dust, GeoColor-style, …) built from CMIP bands.
//!
//! Recipes follow the CIRA/RAMMB quick guides. Bands are decoded at their own resolution,
//! resampled onto the recipe's base band grid via fixed-grid scan angles (all ABI bands share
//! one geometry), and combined into RGBA8.

use super::{sample_indices, Proj};
use rayon::prelude::*;

/// Decoded CMIP band: physical values (K or reflectance factor), NaN = missing.
pub struct Band {
    pub nx: usize,
    pub ny: usize,
    pub proj: Proj,
    pub vals: Vec<f32>,
    pub time: i64,
}

pub struct RgbImage {
    pub nx: usize,
    pub ny: usize,
    pub proj: Proj,
    pub rgba: Vec<u8>,
    pub time: i64,
}

impl RgbImage {
    pub fn bytes(&self) -> usize {
        self.rgba.len()
    }
    /// RGBA8 viewport raster (same sampling as gridded layers).
    pub fn render(&self, bbox: (f64, f64, f64, f64), w: usize, h: usize) -> Vec<u8> {
        let idx = sample_indices(&self.proj, self.nx, self.ny, bbox, w, h);
        let mut out = vec![0u8; w * h * 4];
        out.par_chunks_mut(4).zip(idx.par_iter()).for_each(|(o, &i)| {
            if i != u32::MAX {
                let k = i as usize * 4;
                o.copy_from_slice(&self.rgba[k..k + 4]);
            }
        });
        out
    }
}

#[derive(Clone, Copy)]
enum Ch {
    /// band value scaled lo→hi (lo > hi inverts), gamma
    One(u8, f32, f32, f32),
    /// band a − band b
    Diff(u8, u8, f32, f32, f32),
}

pub struct Recipe {
    pub id: &'static str,
    pub name: &'static str,
    /// grid the composite is built on
    pub base: u8,
    pub bands: &'static [u8],
    kind: Kind,
}

enum Kind {
    Channels([Ch; 3]),
    TrueColor,
    GeoColor,
}

const C: f32 = 273.15;

pub const RECIPES: &[Recipe] = &[
    Recipe { id: "geocolor", name: "GeoColor", base: 1, bands: &[1, 2, 3, 7, 13], kind: Kind::GeoColor },
    Recipe { id: "truecolor", name: "True Color (day)", base: 1, bands: &[1, 2, 3], kind: Kind::TrueColor },
    Recipe {
        id: "airmass",
        name: "Air Mass RGB",
        base: 8,
        bands: &[8, 10, 12, 13],
        kind: Kind::Channels([Ch::Diff(8, 10, -26.2, 0.6, 1.0), Ch::Diff(12, 13, -43.2, 6.7, 1.0), Ch::One(8, -29.25 + C, -64.65 + C, 1.0)]),
    },
    Recipe {
        id: "dust",
        name: "Dust RGB",
        base: 13,
        bands: &[11, 13, 14, 15],
        kind: Kind::Channels([Ch::Diff(15, 13, -6.7, 2.6, 1.0), Ch::Diff(14, 11, -0.5, 20.0, 2.5), Ch::One(13, -11.95 + C, 15.55 + C, 1.0)]),
    },
    Recipe {
        id: "daycloudphase",
        name: "Day Cloud Phase",
        base: 5,
        bands: &[2, 5, 13],
        kind: Kind::Channels([Ch::One(13, 7.5 + C, -53.5 + C, 1.0), Ch::One(2, 0.0, 0.78, 1.0), Ch::One(5, 0.01, 0.59, 1.0)]),
    },
    Recipe {
        id: "firetemp",
        name: "Fire Temperature",
        base: 7,
        bands: &[5, 6, 7],
        kind: Kind::Channels([Ch::One(7, 0.0 + C, 60.0 + C, 0.4), Ch::One(6, 0.0, 1.0, 1.0), Ch::One(5, 0.0, 0.75, 1.0)]),
    },
    Recipe {
        id: "nightmicro",
        name: "Night Microphysics",
        base: 13,
        bands: &[7, 13, 15],
        kind: Kind::Channels([Ch::Diff(15, 13, -6.7, 2.6, 1.0), Ch::Diff(13, 7, -3.1, 5.2, 1.0), Ch::One(13, -29.6 + C, 19.5 + C, 1.0)]),
    },
    Recipe {
        id: "dayconvection",
        name: "Day Convection",
        base: 7,
        bands: &[2, 5, 7, 8, 10, 13],
        kind: Kind::Channels([Ch::Diff(8, 10, -35.0, 5.0, 1.0), Ch::Diff(7, 13, -5.0, 60.0, 1.0), Ch::Diff(5, 2, -0.75, 0.25, 1.0)]),
    },
];

pub fn recipe(id: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|r| r.id == id)
}

fn scale(v: f32, lo: f32, hi: f32, gamma: f32) -> f32 {
    let t = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
    if gamma != 1.0 {
        t.powf(1.0 / gamma)
    } else {
        t
    }
}

/// Inverse fixed-grid projection: scan angles → (lat, lon) degrees.
pub fn geos_latlon(proj: &Proj, i: usize, j: usize) -> Option<(f64, f64)> {
    let Proj::Geos { h, r_eq, r_pol, lon0, x0, dx, y0, dy } = *proj else { return None };
    let x = x0 + i as f64 * dx;
    let y = y0 + j as f64 * dy;
    let (sx, cx, sy, cy) = (x.sin(), x.cos(), y.sin(), y.cos());
    let q = (r_eq * r_eq) / (r_pol * r_pol);
    let a = sx * sx + cx * cx * (cy * cy + q * sy * sy);
    let b = -2.0 * h * cx * cy;
    let c = h * h - r_eq * r_eq;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return None;
    }
    let rs = (-b - disc.sqrt()) / (2.0 * a);
    let (px, py, pz) = (rs * cx * cy, -rs * sx, rs * cx * sy);
    let lat = (q * pz / ((h - px).powi(2) + py * py).sqrt()).atan().to_degrees();
    let lon = lon0 - (py / (h - px)).atan().to_degrees();
    Some((lat, lon))
}

/// Solar zenith angle (degrees) for a time and place (NOAA approximation).
pub fn solar_zenith(t_ms: i64, lat: f64, lon: f64) -> f64 {
    let days = t_ms as f64 / 86_400_000.0;
    let doy = (days.rem_euclid(365.2422)) as f64;
    let g = 2.0 * std::f64::consts::PI / 365.0 * (doy + ((days.fract() * 24.0) - 12.0) / 24.0);
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos() + 0.000907 * (2.0 * g).sin() - 0.002697 * (3.0 * g).cos() + 0.00148 * (3.0 * g).sin();
    let eqt = 229.18 * (0.000075 + 0.001868 * g.cos() - 0.032077 * g.sin() - 0.014615 * (2.0 * g).cos() - 0.040849 * (2.0 * g).sin());
    let minutes = days.fract() * 1440.0;
    let tst = minutes + eqt + 4.0 * lon;
    let ha = (tst / 4.0 - 180.0).to_radians();
    let phi = lat.to_radians();
    let cosz = phi.sin() * decl.sin() + phi.cos() * decl.cos() * ha.cos();
    cosz.clamp(-1.0, 1.0).acos().to_degrees()
}

/// Build a composite. `bands` must contain every band in `r.bands` (index = band number).
pub fn compose(r: &Recipe, bands: &[Option<Band>; 17]) -> anyhow::Result<RgbImage> {
    let base = bands[r.base as usize].as_ref().ok_or_else(|| anyhow::anyhow!("base band missing"))?;
    let (nx, ny) = (base.nx, base.ny);
    let Proj::Geos { x0: bx0, dx: bdx, y0: by0, dy: bdy, .. } = base.proj else { anyhow::bail!("not a fixed grid") };
    // per band: column and row lookup tables onto the base grid
    let mut maps: Vec<Option<(Vec<i32>, Vec<i32>, &Band)>> = (0..17).map(|_| None).collect();
    for &b in r.bands {
        let band = bands[b as usize].as_ref().ok_or_else(|| anyhow::anyhow!("band {b} missing"))?;
        let Proj::Geos { x0, dx, y0, dy, .. } = band.proj else { anyhow::bail!("band {b} not fixed grid") };
        let cols = (0..nx).map(|i| ((bx0 + i as f64 * bdx - x0) / dx).round() as i32).map(|c| if c >= 0 && (c as usize) < band.nx { c } else { -1 }).collect();
        let rows = (0..ny).map(|j| ((by0 + j as f64 * bdy - y0) / dy).round() as i32).map(|c| if c >= 0 && (c as usize) < band.ny { c } else { -1 }).collect();
        maps[b as usize] = Some((cols, rows, band));
    }
    let get = |b: u8, i: usize, j: usize| -> f32 {
        let Some((cols, rows, band)) = &maps[b as usize] else { return f32::NAN };
        let (c, rr) = (cols[i], rows[j]);
        if c < 0 || rr < 0 {
            return f32::NAN;
        }
        band.vals[rr as usize * band.nx + c as usize]
    };
    let time = base.time;
    let mut rgba = vec![0u8; nx * ny * 4];
    rgba.par_chunks_mut(nx * 4).enumerate().for_each(|(j, row)| {
        for i in 0..nx {
            let px = &mut row[i * 4..i * 4 + 4];
            let ch = |c: Ch| -> f32 {
                match c {
                    Ch::One(b, lo, hi, g) => scale(get(b, i, j), lo, hi, g),
                    Ch::Diff(a, b, lo, hi, g) => scale(get(a, i, j) - get(b, i, j), lo, hi, g),
                }
            };
            let (rgb, alpha) = match &r.kind {
                Kind::Channels(chs) => {
                    let v = [ch(chs[0]), ch(chs[1]), ch(chs[2])];
                    if v.iter().any(|x| x.is_nan()) {
                        continue;
                    }
                    (v, 1.0)
                }
                Kind::TrueColor | Kind::GeoColor => {
                    let Some((lat, lon)) = geos_latlon(&base.proj, i, j) else { continue };
                    let sza = solar_zenith(time, lat, lon) as f32;
                    let day = true_color(get(1, i, j), get(2, i, j), get(3, i, j), sza);
                    if matches!(r.kind, Kind::TrueColor) {
                        match day {
                            // fade out through twilight
                            Some(c) => (c, (1.0 - (sza - 80.0) / 8.0).clamp(0.0, 1.0)),
                            None => continue,
                        }
                    } else {
                        let night = night_color(get(13, i, j), get(7, i, j));
                        let w = ((sza - 78.0) / 10.0).clamp(0.0, 1.0);
                        match (day, night) {
                            (Some(d), Some(n)) => ([d[0] * (1.0 - w) + n[0] * w, d[1] * (1.0 - w) + n[1] * w, d[2] * (1.0 - w) + n[2] * w], 1.0),
                            (None, Some(n)) if w > 0.5 => (n, 1.0),
                            (Some(d), None) if w < 0.5 => (d, 1.0),
                            _ => continue,
                        }
                    }
                }
            };
            px[0] = (rgb[0] * 255.0) as u8;
            px[1] = (rgb[1] * 255.0) as u8;
            px[2] = (rgb[2] * 255.0) as u8;
            px[3] = (alpha * 255.0) as u8;
        }
    });
    Ok(RgbImage { nx, ny, proj: base.proj.clone(), rgba, time })
}

/// CIMSS natural true color with simulated green, sun-angle normalised, gamma 2.2.
fn true_color(blue: f32, red: f32, nir: f32, sza: f32) -> Option<[f32; 3]> {
    if blue.is_nan() || red.is_nan() || nir.is_nan() {
        return None;
    }
    let mu = (sza.min(85.0)).to_radians().cos().max(0.08);
    let green = 0.45 * red + 0.1 * nir + 0.45 * blue;
    let f = |v: f32| ((v / mu).clamp(0.0, 1.1) / 1.1).powf(1.0 / 2.2);
    Some([f(red), f(green), f(blue)])
}

/// Night side: cold cloud tops in white over a dark blue background, low water clouds/fog
/// (positive 10.3 − 3.9 µm difference) tinted light blue.
fn night_color(t13: f32, t07: f32) -> Option<[f32; 3]> {
    if t13.is_nan() {
        return None;
    }
    let cloud = ((285.0 - t13) / 80.0).clamp(0.0, 1.0).powf(0.8);
    let fog = if t07.is_nan() { 0.0 } else { ((t13 - t07 - 1.0) / 4.0).clamp(0.0, 1.0) * (1.0 - cloud) };
    let bg = [0.03, 0.05, 0.12];
    let low = [0.35, 0.55, 0.85];
    let mix = |k: usize| bg[k] * (1.0 - cloud - fog * 0.6).max(0.0) + cloud * 0.95 + low[k] * fog * 0.6;
    Some([mix(0).min(1.0), mix(1).min(1.0), mix(2).min(1.0)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geos_round_trip() {
        let p = Proj::Geos { h: 42_164_160.0, r_eq: 6_378_137.0, r_pol: 6_356_752.31414, lon0: -75.0, x0: -0.101332, dx: 5.6e-5, y0: 0.128212, dy: -5.6e-5 };
        let (lat, lon) = geos_latlon(&p, 1500, 1200).unwrap();
        let (fi, fj) = p.ij(lat, lon).unwrap();
        assert!((fi - 1500.0).abs() < 0.01 && (fj - 1200.0).abs() < 0.01, "{fi} {fj}");
    }

    #[test]
    fn sun_angles() {
        // 2026-06-21 17:00Z over Kansas: high sun; 2026-06-21 05:00Z: night
        let noon = chrono::NaiveDate::from_ymd_opt(2026, 6, 21).unwrap().and_hms_opt(18, 0, 0).unwrap().and_utc().timestamp_millis();
        assert!(solar_zenith(noon, 38.5, -98.0) < 25.0);
        let night = chrono::NaiveDate::from_ymd_opt(2026, 6, 21).unwrap().and_hms_opt(6, 0, 0).unwrap().and_utc().timestamp_millis();
        assert!(solar_zenith(night, 38.5, -98.0) > 100.0);
    }

    #[test]
    fn airmass_compose() {
        let p = Proj::Geos { h: 42_164_160.0, r_eq: 6_378_137.0, r_pol: 6_356_752.31414, lon0: -75.0, x0: -0.05, dx: 1e-4, y0: 0.1, dy: -1e-4 };
        let mk = |v: f32| Some(Band { nx: 4, ny: 3, proj: p.clone(), vals: vec![v; 12], time: 0 });
        let mut bands: [Option<Band>; 17] = Default::default();
        bands[8] = mk(230.0);
        bands[10] = mk(240.0);
        bands[12] = mk(250.0);
        bands[13] = mk(270.0);
        let img = compose(recipe("airmass").unwrap(), &bands).unwrap();
        assert_eq!(img.rgba.len(), 48);
        assert_eq!(img.rgba[3], 255);
        // R: (230-240 = -10 → (−10+26.2)/26.8 ≈ 0.60)
        assert!((img.rgba[0] as i32 - 154).abs() <= 2, "{}", img.rgba[0]);
    }
}
