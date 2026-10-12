//! Level II volume resampled onto a radar-centred 3D grid for the app's volumetric renderer.
//!
//! Binary layout (little-endian): `u32 L`, `L` bytes UTF-8 JSON header, then `nx*ny*nz` u8
//! voxels, x fastest (W→E), then y (S→N), then z (bottom→top). Byte 0 = no data,
//! value = (byte - offset) / scale.
//!
//! Horizontal grid: cell (i, j) centre is at x = (i + 0.5 - nx/2)·dx, y = (j + 0.5 - ny/2)·dy
//! metres from the radar, with lat = lat0 + y/R, lon = lon0 + x/(R·cos lat) (R = 6 371 000 m),
//! which is what the app's shader inverts. Layer k is centred z0 + k·dz metres above the radar.

use super::geom::{bearing_dist, destination, slant_from, PolarSweep, R_EARTH};
use super::level2::{tilts, Moment, Volume};
use anyhow::{anyhow, bail, Result};
use rayon::prelude::*;

/// Half the 3D beam width used to decide where a tilt still "covers" (deg).
const HALF_BEAM: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Ref,
    Vel,
    Sw,
    Zdr,
    Cc,
    Phi,
    Kdp,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s.to_ascii_uppercase().as_str() {
            "REF" => Kind::Ref,
            "VEL" => Kind::Vel,
            "SW" => Kind::Sw,
            "ZDR" => Kind::Zdr,
            "CC" | "RHO" => Kind::Cc,
            "PHI" => Kind::Phi,
            "KDP" => Kind::Kdp,
            _ => return None,
        })
    }
    pub fn code(self) -> &'static str {
        match self {
            Kind::Ref => "REF",
            Kind::Vel => "VEL",
            Kind::Sw => "SW",
            Kind::Zdr => "ZDR",
            Kind::Cc => "CC",
            Kind::Phi => "PHI",
            Kind::Kdp => "KDP",
        }
    }
    /// Level II moment the values come from.
    fn source(self) -> Moment {
        match self {
            Kind::Ref => Moment::Ref,
            Kind::Vel => Moment::Vel,
            Kind::Sw => Moment::Sw,
            Kind::Zdr => Moment::Zdr,
            Kind::Cc => Moment::Rho,
            Kind::Phi | Kind::Kdp => Moment::Phi,
        }
    }
    /// (scale, offset): byte = value·scale + offset, clamped to 1..=255.
    pub fn quant(self) -> (f32, f32) {
        match self {
            Kind::Ref => (2.0, 66.0),
            Kind::Vel => (2.0, 128.0),
            Kind::Sw => (8.0, 1.0),
            Kind::Zdr => (16.0, 128.0),
            Kind::Cc => (300.0, -59.0),
            Kind::Phi => (0.7, 1.0),
            Kind::Kdp => (20.0, 41.0),
        }
    }
    /// Velocity aliasing makes blending across tilts meaningless; use the nearest tilt instead.
    fn interpolates(self) -> bool {
        !matches!(self, Kind::Vel)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Spec {
    pub n: usize,
    pub dx: f64,
    pub nz: usize,
    pub dz: f64,
}

impl Spec {
    /// lo: 256×256×40 over ±256 km, dz 500 m; hi: 400×400×64 over ±200 km, dz 312.5 m.
    pub fn from_res(res: &str) -> Spec {
        if res.eq_ignore_ascii_case("hi") {
            Spec { n: 400, dx: 1000.0, nz: 64, dz: 312.5 }
        } else {
            Spec { n: 256, dx: 2000.0, nz: 40, dz: 500.0 }
        }
    }
    pub fn z0(&self) -> f64 {
        self.dz / 2.0
    }
}

/// One tilt quantized to output bytes (radial-major) with its lookup geometry.
struct Layer<'a> {
    elev: f64,
    polar: PolarSweep<'a>,
    bytes: Vec<u8>,
}

#[inline]
fn quantize(v: f32, scale: f32, offset: f32) -> u8 {
    if !v.is_finite() {
        return 0;
    }
    (v * scale + offset).round().clamp(1.0, 255.0) as u8
}

/// KDP (deg/km) along one radial of PHI: least-squares slope over a ~3 km window, half of dΦ/dr.
fn kdp_radial(phi: &[Option<f32>], gate_m: f64) -> Vec<f32> {
    let n = phi.len();
    let w = ((1500.0 / gate_m).round() as usize).clamp(2, 12);
    let mut out = vec![f32::NAN; n];
    for (g, o) in out.iter_mut().enumerate() {
        if phi[g].is_none() {
            continue;
        }
        let (a, b) = (g.saturating_sub(w), (g + w).min(n - 1));
        let (mut sx, mut sy, mut sxx, mut sxy, mut k) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0usize);
        // unwrap differential phase jumps through 360
        let mut prev: Option<f64> = None;
        for (i, p) in phi.iter().enumerate().take(b + 1).skip(a) {
            let Some(p) = *p else { continue };
            let mut y = p as f64;
            if let Some(q) = prev {
                while y - q > 180.0 {
                    y -= 360.0;
                }
                while y - q < -180.0 {
                    y += 360.0;
                }
            }
            prev = Some(y);
            let x = i as f64 * gate_m / 1000.0;
            sx += x;
            sy += y;
            sxx += x * x;
            sxy += x * y;
            k += 1;
        }
        if k * 10 < (b - a + 1) * 7 {
            continue;
        }
        let kf = k as f64;
        let den = kf * sxx - sx * sx;
        if den.abs() < 1e-9 {
            continue;
        }
        *o = (0.5 * (kf * sxy - sx * sy) / den) as f32;
    }
    out
}

fn layers<'a>(v: &'a Volume, kind: Kind) -> Vec<Layer<'a>> {
    let m = kind.source();
    let (scale, offset) = kind.quant();
    let mut picked: Vec<usize> = vec![];
    let mut angles: Vec<f32> = vec![];
    // ODIM volumes may carry KDP itself; prefer it over deriving it from PHI
    let native_kdp = kind == Kind::Kdp && tilts(v).iter().any(|t| t.sweeps.contains_key("KDP"));
    let m = if native_kdp { Moment::Kdp } else { m };
    for t in tilts(v) {
        let Some(&si) = t.sweeps.get(m.code()) else { continue };
        // SAILS / MESO-SAILS repeat low tilts: one sweep per angle is enough for 3D
        if angles.iter().any(|a| (a - t.angle).abs() < 0.2) {
            continue;
        }
        if v.sweeps[si].radials.len() < 100 {
            continue;
        }
        angles.push(t.angle);
        picked.push(si);
    }
    let mut out: Vec<Layer> = picked
        .par_iter()
        .filter_map(|&si| {
            let polar = PolarSweep::new(&v.sweeps[si], m)?;
            let ng = polar.ngates;
            let mut bytes = vec![0u8; polar.radials.len() * ng];
            for (ri, row) in bytes.chunks_mut(ng).enumerate() {
                if kind == Kind::Kdp && !native_kdp {
                    let phi: Vec<Option<f32>> = (0..ng).map(|g| polar.value(ri, g)).collect();
                    for (o, k) in row.iter_mut().zip(kdp_radial(&phi, polar.gate)) {
                        *o = quantize(k, scale, offset);
                    }
                } else {
                    for (g, o) in row.iter_mut().enumerate() {
                        if let Some(x) = polar.value(ri, g) {
                            *o = quantize(x, scale, offset);
                        }
                    }
                }
            }
            Some(Layer { elev: polar.elev, polar, bytes })
        })
        .collect();
    out.sort_by(|a, b| a.elev.partial_cmp(&b.elev).unwrap_or(std::cmp::Ordering::Equal));
    out
}

impl Layer<'_> {
    #[inline]
    fn at(&self, az: f64, r: f64) -> u8 {
        match (self.polar.radial_at(az), self.polar.gate_at(r)) {
            (Some(ri), Some(g)) => self.bytes[ri * self.polar.ngates + g],
            _ => 0,
        }
    }
}

/// Voxels for `kind` (no header). Returns (voxels, number of tilts used).
pub fn grid(v: &Volume, kind: Kind, spec: Spec) -> Result<(Vec<u8>, usize)> {
    if v.lat == 0.0 && v.lon == 0.0 {
        bail!("volume has no radar location");
    }
    let ls = layers(v, kind);
    if ls.is_empty() {
        bail!("{} not found in this volume", kind.code());
    }
    let n = spec.n;
    let (lat0, lon0) = (v.lat as f64, v.lon as f64);
    // per column: azimuth and ground distance from the radar
    let cols: Vec<(f64, f64)> = (0..n * n)
        .into_par_iter()
        .map(|c| {
            let (i, j) = (c % n, c / n);
            let x = (i as f64 + 0.5 - n as f64 / 2.0) * spec.dx;
            let y = (j as f64 + 0.5 - n as f64 / 2.0) * spec.dx;
            let lat = lat0 + (y / R_EARTH).to_degrees();
            let lon = lon0 + (x / (R_EARTH * lat.to_radians().cos())).to_degrees();
            bearing_dist(lat0, lon0, lat, lon)
        })
        .collect();
    let smp = Sampler::new(&ls, kind);
    let mut out = vec![0u8; n * n * spec.nz];
    out.par_chunks_mut(n * n).enumerate().for_each(|(k, slab)| {
        let h = spec.z0() + k as f64 * spec.dz;
        for (o, &(az, s)) in slab.iter_mut().zip(cols.iter()) {
            *o = smp.at(az, s, h);
        }
    });
    Ok((out, ls.len()))
}

/// Value byte at (azimuth, ground distance, height above the radar), interpolated between the
/// tilts above and below like a 3D volume voxel.
struct Sampler<'s, 'a> {
    ls: &'s [Layer<'a>],
    elevs: Vec<f64>,
    lo: f64,
    hi: f64,
    interp: bool,
}

impl<'s, 'a> Sampler<'s, 'a> {
    fn new(ls: &'s [Layer<'a>], kind: Kind) -> Self {
        let elevs: Vec<f64> = ls.iter().map(|l| l.elev).collect();
        let (lo, hi) = (elevs[0] - HALF_BEAM, elevs[elevs.len() - 1] + HALF_BEAM);
        Self { ls, elevs, lo, hi, interp: kind.interpolates() }
    }

    #[inline]
    fn at(&self, az: f64, s: f64, h: f64) -> u8 {
        let ls = self.ls;
        let (r, el) = slant_from(s, h);
        if el < self.lo || el > self.hi {
            return 0;
        }
        let kk = self.elevs.partition_point(|&e| e < el);
        if kk == 0 {
            ls[0].at(az, r)
        } else if kk >= ls.len() {
            ls[ls.len() - 1].at(az, r)
        } else {
            let (a, b) = (&ls[kk - 1], &ls[kk]);
            let w = (el - a.elev) / (b.elev - a.elev).max(1e-6);
            let (va, vb) = (a.at(az, r), b.at(az, r));
            match (va, vb) {
                (0, 0) => 0,
                (x, 0) => if el - a.elev <= HALF_BEAM { x } else { 0 },
                (0, y) => if b.elev - el <= HALF_BEAM { y } else { 0 },
                (x, y) if self.interp => (x as f64 + (y as f64 - x as f64) * w).round().clamp(1.0, 255.0) as u8,
                (x, y) => if w < 0.5 { x } else { y },
            }
        }
    }
}

/// Vertical cross-section request: the line from point 1 to point 2, `nx` columns, `nz` levels
/// from the ground (MSL 0) to `ztop` metres MSL.
#[derive(Debug, Clone, Copy)]
pub struct XSec {
    pub lat1: f64,
    pub lon1: f64,
    pub lat2: f64,
    pub lon2: f64,
    pub nx: usize,
    pub nz: usize,
    pub ztop: f64,
}

/// Cross-section body: `u32 L`, `L` bytes JSON header
/// `{nx, nz, dist_m, ztop, dz, z0, scale, offset, moment, time, site, lat1, lon1, lat2, lon2, radar_height_m, tilts}`,
/// then `nx*nz` u8 (x fastest from point 1 to point 2, then z bottom→top; level k is centred
/// at z0 + k·dz metres MSL; byte 0 = no data; value = (byte − offset) / scale).
pub fn xsection(v: &Volume, moment: &str, x: &XSec) -> Result<Vec<u8>> {
    let kind = Kind::parse(moment).ok_or_else(|| anyhow!("unknown moment {moment} (REF|VEL|ZDR|CC|SW|KDP|PHI)"))?;
    if v.lat == 0.0 && v.lon == 0.0 {
        bail!("volume has no radar location");
    }
    if !(2..=2000).contains(&x.nx) || !(2..=600).contains(&x.nz) || !(500.0..=30_000.0).contains(&x.ztop) {
        bail!("nx 2..2000, nz 2..600, ztop 500..30000 m");
    }
    let ls = layers(v, kind);
    if ls.is_empty() {
        bail!("{} not found in this volume", kind.code());
    }
    let smp = Sampler::new(&ls, kind);
    let (lat0, lon0) = (v.lat as f64, v.lon as f64);
    let (brg, dist) = bearing_dist(x.lat1, x.lon1, x.lat2, x.lon2);
    let cols: Vec<(f64, f64)> = (0..x.nx)
        .map(|i| {
            let (la, lo) = destination(x.lat1, x.lon1, brg, dist * (i as f64 + 0.5) / x.nx as f64);
            bearing_dist(lat0, lon0, la, lo)
        })
        .collect();
    let dz = x.ztop / x.nz as f64;
    let mut out = vec![0u8; x.nx * x.nz];
    out.par_chunks_mut(x.nx).enumerate().for_each(|(k, row)| {
        let h = (k as f64 + 0.5) * dz - v.height_m as f64;
        if h < 0.0 {
            return;
        }
        for (o, &(az, s)) in row.iter_mut().zip(cols.iter()) {
            *o = smp.at(az, s, h);
        }
    });
    let (scale, offset) = kind.quant();
    let hdr = serde_json::json!({
        "nx": x.nx, "nz": x.nz, "dist_m": dist, "ztop": x.ztop, "dz": dz, "z0": dz / 2.0, "z_ref": "msl",
        "scale": scale, "offset": offset, "moment": kind.code(), "time": v.start_ms(), "site": v.site,
        "lat1": x.lat1, "lon1": x.lon1, "lat2": x.lat2, "lon2": x.lon2,
        "radar_lat": v.lat, "radar_lon": v.lon, "radar_height_m": v.height_m, "tilts": ls.len(),
    });
    Ok(with_header(&hdr, &out))
}

/// Full response body: header + voxels.
pub fn encode(v: &Volume, moment: &str, res: &str) -> Result<Vec<u8>> {
    let kind = Kind::parse(moment).ok_or_else(|| anyhow!("unknown moment {moment} (REF|VEL|ZDR|CC|SW|KDP|PHI)"))?;
    let spec = Spec::from_res(res);
    let (vox, ntilts) = grid(v, kind, spec)?;
    let (scale, offset) = kind.quant();
    let hdr = serde_json::json!({
        "nx": spec.n, "ny": spec.n, "nz": spec.nz,
        "dx": spec.dx, "dy": spec.dx, "dz": spec.dz, "z0": spec.z0(),
        "lat": v.lat, "lon": v.lon, "proj": "aeqd",
        "scale": scale, "offset": offset,
        "moment": kind.code(), "time": v.start_ms(), "site": v.site, "elev_m": v.height_m,
        "tilts": ntilts,
    });
    Ok(with_header(&hdr, &vox))
}

pub fn with_header(hdr: &serde_json::Value, vox: &[u8]) -> Vec<u8> {
    let h = serde_json::to_vec(hdr).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + h.len() + vox.len());
    out.extend_from_slice(&(h.len() as u32).to_le_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(vox);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radar::geom::tests::synth_volume;
    use crate::radar::geom::{beam_height, destination};

    #[test]
    fn geometry_places_a_cell_at_its_true_height() {
        // a reflectivity "ball": 50 dBZ where the beam is 2–4 km above the radar and 60–80 km
        // north-east, 10 dBZ elsewhere
        let elevs: Vec<f32> = vec![0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5];
        let v = synth_volume(&elevs, 920, 30.0, |m, az, r, el| {
            if m != Moment::Ref {
                return None;
            }
            let (h, s) = beam_height(r, el);
            let inside = (2000.0..4000.0).contains(&h) && (60_000.0..80_000.0).contains(&s) && (30.0..60.0).contains(&az);
            Some(if inside { 50.0 } else { 10.0 })
        });
        let spec = Spec::from_res("lo");
        let (vox, nt) = grid(&v, Kind::Ref, spec).unwrap();
        assert_eq!(nt, elevs.len());
        assert_eq!(vox.len(), 256 * 256 * 40);
        let (sc, off) = Kind::Ref.quant();
        let val = |b: u8| (b as f32 - off) / sc;
        // voxel centre for a point 70 km at 45°, 2.75 km up (layer 5)
        let (lat, lon) = destination(35.0, -97.0, 45.0, 70_000.0);
        let y = (lat - 35.0).to_radians() * R_EARTH;
        let x = (lon + 97.0).to_radians() * R_EARTH * lat.to_radians().cos();
        let i = (x / spec.dx + 128.0).floor() as usize;
        let j = (y / spec.dx + 128.0).floor() as usize;
        let k = 5;
        let b = vox[k * 256 * 256 + j * 256 + i];
        assert!((val(b) - 50.0).abs() < 1.0, "inside {}", val(b));
        // same column 6 km up is outside the ball; 1 km up too
        for hz in [1000.0, 6000.0] {
            let k = ((hz - spec.z0()) / spec.dz).round() as usize;
            let b = vox[k * 256 * 256 + j * 256 + i];
            assert!(b != 0 && (val(b) - 10.0).abs() < 1.0, "{hz}: {}", val(b));
        }
        // right over the radar and high up is above the top beam: empty
        let k = 39; // 19.75 km
        let b = vox[k * 256 * 256 + 128 * 256 + 128];
        assert_eq!(b, 0, "above top beam over the radar");
        // below the lowest beam far away (west edge, 255 km out, 250 m up) is empty
        assert_eq!(vox[128 * 256], 0);
        // the encoded body parses back
        let body = encode(&v, "REF", "lo").unwrap();
        let l = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
        let h: serde_json::Value = serde_json::from_slice(&body[4..4 + l]).unwrap();
        assert_eq!(h["nx"], 256);
        assert_eq!(h["proj"], "aeqd");
        assert_eq!(h["z0"], 250.0);
        assert_eq!(body.len(), 4 + l + 256 * 256 * 40);
    }

    #[test]
    fn cross_section_through_a_cell() {
        // same ball as above: 50 dBZ 2–4 km above the radar (400 m MSL), 60–80 km out, az 30–60°
        let elevs: Vec<f32> = vec![0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5];
        let v = synth_volume(&elevs, 920, 30.0, |m, az, r, el| {
            if m != Moment::Ref {
                return None;
            }
            let (h, s) = beam_height(r, el);
            let inside = (2000.0..4000.0).contains(&h) && (60_000.0..80_000.0).contains(&s) && (30.0..60.0).contains(&az);
            Some(if inside { 50.0 } else { 10.0 })
        });
        // radial line along 45° from 40 km to 100 km
        let (la1, lo1) = destination(35.0, -97.0, 45.0, 40_000.0);
        let (la2, lo2) = destination(35.0, -97.0, 45.0, 100_000.0);
        let x = XSec { lat1: la1, lon1: lo1, lat2: la2, lon2: lo2, nx: 60, nz: 40, ztop: 10_000.0 };
        let body = xsection(&v, "REF", &x).unwrap();
        let l = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
        let h: serde_json::Value = serde_json::from_slice(&body[4..4 + l]).unwrap();
        assert_eq!(h["nx"], 60);
        assert!((h["dist_m"].as_f64().unwrap() - 60_000.0).abs() < 10.0);
        let px = &body[4 + l..];
        assert_eq!(px.len(), 60 * 40);
        let (sc, off) = Kind::Ref.quant();
        let val = |i: usize, z_msl: f64| {
            let k = (z_msl / 250.0 - 0.5).round() as usize;
            let b = px[k * 60 + i];
            if b == 0 { None } else { Some((b as f32 - off) / sc) }
        };
        // column i centre = 40 km + (i + 0.5) km; 70 km → i = 29; 3.4 km MSL = 3 km above radar
        assert_eq!(val(29, 3400.0).map(|x| x.round()), Some(50.0));
        assert_eq!(val(29, 6400.0).map(|x| x.round()), Some(10.0));
        assert_eq!(val(5, 3400.0).map(|x| x.round()), Some(10.0));
        // below the radar's height: empty
        assert_eq!(px[0], 0);
        assert!(xsection(&v, "XYZ", &x).is_err());
    }

    #[test]
    fn kdp_from_linear_phase() {
        // Φdp rising 4°/km → KDP 2 °/km
        let phi: Vec<Option<f32>> = (0..200).map(|g| Some(20.0 + 4.0 * g as f32 * 0.25)).collect();
        let k = kdp_radial(&phi, 250.0);
        assert!((k[100] - 2.0).abs() < 0.01, "{}", k[100]);
        let v = synth_volume(&[0.5, 1.5], 400, 30.0, |m, _, _, _| if m == Moment::Zdr { Some(1.0) } else { None });
        assert!(grid(&v, Kind::Kdp, Spec::from_res("lo")).is_err());
        let (vox, _) = grid(&v, Kind::Zdr, Spec::from_res("hi")).unwrap();
        assert_eq!(vox.len(), 400 * 400 * 64);
        assert!(vox.iter().any(|&b| b == 144));
    }
}
