//! Gridded data (MRMS, models, NDFD, METAR analyses, satellite).
//!
//! Every source is decoded into a [`Grid`]: values quantized to u16 (0 = no data) in the
//! source's own projection. Apps ask for a viewport; the server samples the grid onto a
//! Web Mercator raster of the requested size, so any projection renders the same way and
//! the app can still read exact values and apply color tables on the GPU.

pub mod contour;
pub mod decode;
pub mod goes;
pub mod intl;
pub mod rgb;
pub mod metar;
pub mod nowcast;
pub mod service;
pub mod sources;

use rayon::prelude::*;
use serde::Serialize;

const R_EARTH: f64 = 6_371_229.0;

#[derive(Debug, Clone)]
pub enum Proj {
    /// value(i, j) is at lat = lat0 + j*dlat, lon = lon0 + i*dlon
    LatLon { lat0: f64, lon0: f64, dlat: f64, dlon: f64, nx: usize, global: bool },
    /// Lambert conformal conic (spherical earth)
    Lambert { n: f64, f: f64, r: f64, lov: f64, x0: f64, y0: f64, dx: f64, dy: f64 },
    /// Polar stereographic (north or south)
    PolarStereo { r: f64, lov: f64, lad: f64, south: bool, x0: f64, y0: f64, dx: f64, dy: f64 },
    /// GOES fixed grid: scan angles (radians) x = x0 + i*dx, y = y0 + j*dy
    Geos { h: f64, r_eq: f64, r_pol: f64, lon0: f64, x0: f64, dx: f64, y0: f64, dy: f64 },
    /// Lambert azimuthal equal-area (ellipsoidal, Snyder): x = x0 + i*dx, y = y0 + j*dy (m)
    Laea(Laea),
    /// Rotated lat/lon (GRIB template 3.1): rotated lat = lat0 + j*dlat, lon = lon0 + i*dlon,
    /// with the rotated south pole at (sp_lat, sp_lon)
    RotLatLon { lat0: f64, lon0: f64, dlat: f64, dlon: f64, sp_lat: f64, sp_lon: f64 },
}

/// Geographic → rotated lat/lon (degrees) for a grid whose south pole sits at (sp_lat, sp_lon).
/// The rotated origin (0, 0) is the geographic point (sp_lat + 90, sp_lon).
pub fn to_rotated(lat: f64, lon: f64, sp_lat: f64, sp_lon: f64) -> (f64, f64) {
    let (p, l) = (lat.to_radians(), (lon - sp_lon).to_radians());
    let (x, y, z) = (p.cos() * l.cos(), p.cos() * l.sin(), p.sin());
    let th = (90.0 + sp_lat).to_radians();
    let x2 = th.cos() * x + th.sin() * z;
    let z2 = -th.sin() * x + th.cos() * z;
    (z2.clamp(-1.0, 1.0).asin().to_degrees(), y.atan2(x2).to_degrees())
}

/// Ellipsoidal LAEA parameters (oblique aspect) plus the grid placement.
#[derive(Debug, Clone, Copy)]
pub struct Laea {
    pub lon0: f64,
    pub a: f64,
    pub e: f64,
    qp: f64,
    rq: f64,
    d: f64,
    sb1: f64,
    cb1: f64,
    /// projected (no false easting) coordinates of cell (0,0) centre and cell sizes
    pub x0: f64,
    pub y0: f64,
    pub dx: f64,
    pub dy: f64,
}

impl Laea {
    /// `a`/`e`: ellipsoid (e = 0 for a sphere); angles in degrees.
    pub fn new(lat0: f64, lon0: f64, a: f64, e: f64) -> Laea {
        let q = |phi: f64| -> f64 {
            let s = phi.sin();
            if e < 1e-12 {
                return 2.0 * s;
            }
            (1.0 - e * e) * (s / (1.0 - e * e * s * s) - (1.0 / (2.0 * e)) * ((1.0 - e * s) / (1.0 + e * s)).ln())
        };
        let p1 = lat0.to_radians();
        let qp = q(std::f64::consts::FRAC_PI_2);
        let b1 = (q(p1) / qp).clamp(-1.0, 1.0).asin();
        let rq = a * (qp / 2.0).sqrt();
        let m1 = p1.cos() / (1.0 - e * e * p1.sin().powi(2)).sqrt();
        let d = a * m1 / (rq * b1.cos());
        Laea { lon0: lon0.to_radians(), a, e, qp, rq, d, sb1: b1.sin(), cb1: b1.cos(), x0: 0.0, y0: 0.0, dx: 1.0, dy: 1.0 }
    }

    /// Projected x, y (m) of a lat/lon (degrees).
    pub fn xy(&self, lat: f64, lon: f64) -> (f64, f64) {
        let e = self.e;
        let s = lat.to_radians().sin();
        let q = if e < 1e-12 { 2.0 * s } else { (1.0 - e * e) * (s / (1.0 - e * e * s * s) - (1.0 / (2.0 * e)) * ((1.0 - e * s) / (1.0 + e * s)).ln()) };
        let beta = (q / self.qp).clamp(-1.0, 1.0).asin();
        let dl = wrap180(lon - self.lon0.to_degrees()).to_radians();
        let den = 1.0 + self.sb1 * beta.sin() + self.cb1 * beta.cos() * dl.cos();
        if den <= 1e-12 {
            return (f64::NAN, f64::NAN);
        }
        let b = self.rq * (2.0 / den).sqrt();
        (b * self.d * beta.cos() * dl.sin(), (b / self.d) * (self.cb1 * beta.sin() - self.sb1 * beta.cos() * dl.cos()))
    }
}

fn wrap180(mut d: f64) -> f64 {
    while d > 180.0 {
        d -= 360.0;
    }
    while d < -180.0 {
        d += 360.0;
    }
    d
}

impl Proj {
    /// The projection of every `stride`-th cell (cell 0 unchanged); `nx` = new row length.
    pub fn strided(&self, stride: usize, nx: usize) -> Proj {
        let k = stride as f64;
        match *self {
            Proj::LatLon { lat0, lon0, dlat, dlon, global, .. } => Proj::LatLon { lat0, lon0, dlat: dlat * k, dlon: dlon * k, nx, global },
            Proj::Lambert { n, f, r, lov, x0, y0, dx, dy } => Proj::Lambert { n, f, r, lov, x0, y0, dx: dx * k, dy: dy * k },
            Proj::PolarStereo { r, lov, lad, south, x0, y0, dx, dy } => Proj::PolarStereo { r, lov, lad, south, x0, y0, dx: dx * k, dy: dy * k },
            Proj::Geos { h, r_eq, r_pol, lon0, x0, dx, y0, dy } => Proj::Geos { h, r_eq, r_pol, lon0, x0, dx: dx * k, y0, dy: dy * k },
            Proj::Laea(l) => Proj::Laea(Laea { dx: l.dx * k, dy: l.dy * k, ..l }),
            Proj::RotLatLon { lat0, lon0, dlat, dlon, sp_lat, sp_lon } => Proj::RotLatLon { lat0, lon0, dlat: dlat * k, dlon: dlon * k, sp_lat, sp_lon },
        }
    }

    pub fn lambert(lat1: f64, lon1: f64, latin1: f64, latin2: f64, lov: f64, dx: f64, dy: f64, r: f64) -> Proj {
        let r1 = latin1.to_radians();
        let r2 = latin2.to_radians();
        let t = |p: f64| (std::f64::consts::FRAC_PI_4 + p / 2.0).tan();
        let n = if (latin1 - latin2).abs() < 1e-6 { r1.sin() } else { (r1.cos() / r2.cos()).ln() / (t(r2) / t(r1)).ln() };
        let f = r1.cos() * t(r1).powf(n) / n;
        let mut p = Proj::Lambert { n, f, r, lov: lov.to_radians(), x0: 0.0, y0: 0.0, dx, dy };
        let (x, y) = p.lambert_xy(lat1, lon1);
        if let Proj::Lambert { x0, y0, .. } = &mut p {
            *x0 = x;
            *y0 = y;
        }
        p
    }

    fn lambert_xy(&self, lat: f64, lon: f64) -> (f64, f64) {
        if let Proj::Lambert { n, f, r, lov, .. } = *self {
            let rho = r * f / (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0).tan().powf(n);
            let th = n * wrap180(lon - lov.to_degrees()).to_radians();
            (rho * th.sin(), -rho * th.cos())
        } else {
            (0.0, 0.0)
        }
    }

    pub fn polar(lat1: f64, lon1: f64, lov: f64, lad: f64, south: bool, dx: f64, dy: f64, r: f64) -> Proj {
        let mut p = Proj::PolarStereo { r, lov: lov.to_radians(), lad: lad.to_radians(), south, x0: 0.0, y0: 0.0, dx, dy };
        let (x, y) = p.polar_xy(lat1, lon1);
        if let Proj::PolarStereo { x0, y0, .. } = &mut p {
            *x0 = x;
            *y0 = y;
        }
        p
    }

    fn polar_xy(&self, lat: f64, lon: f64) -> (f64, f64) {
        if let Proj::PolarStereo { r, lov, lad, south, .. } = *self {
            let k = 1.0 + lad.abs().sin();
            let (phi, dl) = (lat.to_radians(), lon.to_radians() - lov);
            if south {
                let rho = r * k * (std::f64::consts::FRAC_PI_4 + phi / 2.0).tan();
                (rho * dl.sin(), rho * dl.cos())
            } else {
                let rho = r * k * (std::f64::consts::FRAC_PI_4 - phi / 2.0).tan();
                (rho * dl.sin(), -rho * dl.cos())
            }
        } else {
            (0.0, 0.0)
        }
    }

    /// Angle (radians) between true north and the grid's +y axis at a point: winds given
    /// relative to the grid rotate to earth-relative with
    /// u = cos a * ug + sin a * vg, v = -sin a * ug + cos a * vg. 0 for regular lat/lon.
    pub fn north_angle(&self, lat: f64, lon: f64) -> f64 {
        let xy = |la: f64| -> Option<(f64, f64)> {
            match *self {
                Proj::Lambert { .. } => Some(self.lambert_xy(la, lon)),
                Proj::PolarStereo { .. } => Some(self.polar_xy(la, lon)),
                Proj::RotLatLon { sp_lat, sp_lon, .. } => {
                    let (rl, ro) = to_rotated(la, lon, sp_lat, sp_lon);
                    Some((ro * rl.to_radians().cos(), rl))
                }
                _ => None,
            }
        };
        let (Some(a), Some(b)) = (xy(lat - 0.005), xy(lat + 0.005)) else { return 0.0 };
        let (mut dx, dy) = (b.0 - a.0, b.1 - a.1);
        if let Proj::RotLatLon { .. } = self {
            // longitudes wrap at ±180 in rotated coordinates
            if dx > 180.0 {
                dx -= 360.0;
            } else if dx < -180.0 {
                dx += 360.0;
            }
        }
        if dx == 0.0 && dy == 0.0 {
            return 0.0;
        }
        (-dx).atan2(dy)
    }

    /// Fractional grid index of a lat/lon, or None outside the projection's domain.
    #[inline]
    pub fn ij(&self, lat: f64, lon: f64) -> Option<(f64, f64)> {
        match *self {
            Proj::LatLon { lat0, lon0, dlat, dlon, nx, global } => {
                let mut dl = lon - lon0;
                if dlon > 0.0 {
                    dl = dl.rem_euclid(360.0);
                    if !global && dl > dlon * nx as f64 + 1.0 {
                        dl -= 360.0;
                    }
                } else {
                    dl = -((-dl).rem_euclid(360.0));
                }
                Some((dl / dlon, (lat - lat0) / dlat))
            }
            Proj::Lambert { x0, y0, dx, dy, .. } => {
                let (x, y) = self.lambert_xy(lat, lon);
                Some(((x - x0) / dx, (y - y0) / dy))
            }
            Proj::PolarStereo { x0, y0, dx, dy, .. } => {
                let (x, y) = self.polar_xy(lat, lon);
                Some(((x - x0) / dx, (y - y0) / dy))
            }
            Proj::RotLatLon { lat0, lon0, dlat, dlon, sp_lat, sp_lon } => {
                let (rl, ro) = to_rotated(lat, lon, sp_lat, sp_lon);
                Some((wrap180(ro - lon0) / dlon, (rl - lat0) / dlat))
            }
            Proj::Laea(ref l) => {
                let (x, y) = l.xy(lat, lon);
                if !x.is_finite() {
                    return None;
                }
                Some(((x - l.x0) / l.dx, (y - l.y0) / l.dy))
            }
            Proj::Geos { h, r_eq, r_pol, lon0, x0, dx, y0, dy } => {
                let phi = lat.to_radians();
                let lam = (lon - lon0).to_radians();
                let e2 = (r_eq * r_eq - r_pol * r_pol) / (r_eq * r_eq);
                let phic = ((r_pol * r_pol) / (r_eq * r_eq) * phi.tan()).atan();
                let rc = r_pol / (1.0 - e2 * phic.cos().powi(2)).sqrt();
                let sx = h - rc * phic.cos() * lam.cos();
                let sy = -rc * phic.cos() * lam.sin();
                let sz = rc * phic.sin();
                // hidden behind the earth's limb
                if h * (h - sx) < sy * sy + (r_eq * r_eq) / (r_pol * r_pol) * sz * sz {
                    return None;
                }
                let x = (-sy / (sx * sx + sy * sy + sz * sz).sqrt()).asin();
                let y = (sz / sx).atan();
                Some(((x - x0) / dx, (y - y0) / dy))
            }
        }
    }
}

/// A decoded field, quantized to u16. raw 0 = no data, value = offset + (raw - 1) * scale.
#[derive(Debug, Clone)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    pub proj: Proj,
    pub data: Vec<u16>,
    pub scale: f32,
    pub offset: f32,
    pub valid_ms: i64,
    pub ref_ms: i64,
    /// vector components are relative to the grid axes (GRIB resolution/component flag 0x08)
    pub grid_rel: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GridInfo {
    pub nx: usize,
    pub ny: usize,
    pub valid: i64,
    pub reference: i64,
    pub min: f32,
    pub max: f32,
}

impl Grid {
    /// Quantize float values (NaN = missing) in storage order.
    pub fn from_values(nx: usize, ny: usize, proj: Proj, values: &[f32], valid_ms: i64, ref_ms: i64) -> Grid {
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for &v in values {
            if v.is_finite() {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        if !lo.is_finite() {
            lo = 0.0;
            hi = 1.0;
        }
        let scale = ((hi - lo) / 65533.0).max(1e-9);
        let data: Vec<u16> = values
            .par_iter()
            .map(|&v| if v.is_finite() { 1 + ((v - lo) / scale).round().clamp(0.0, 65533.0) as u16 } else { 0 })
            .collect();
        Grid { nx, ny, proj, data, scale, offset: lo, valid_ms, ref_ms, grid_rel: false }
    }

    #[inline]
    pub fn value_raw(&self, raw: u16) -> f32 {
        self.offset + (raw as f32 - 1.0) * self.scale
    }

    pub fn info(&self) -> GridInfo {
        GridInfo {
            nx: self.nx,
            ny: self.ny,
            valid: self.valid_ms,
            reference: self.ref_ms,
            min: self.offset,
            max: self.offset + 65533.0 * self.scale,
        }
    }

    pub fn bytes(&self) -> usize {
        self.data.len() * 2 + 256
    }

    #[inline]
    fn at(&self, i: isize, j: isize) -> u16 {
        if i < 0 || j < 0 || i as usize >= self.nx || j as usize >= self.ny {
            return 0;
        }
        self.data[j as usize * self.nx + i as usize]
    }

    /// Value at a lat/lon (nearest grid point).
    pub fn sample(&self, lat: f64, lon: f64) -> Option<f32> {
        let (fi, fj) = self.proj.ij(lat, lon)?;
        let r = self.at(fi.round() as isize, fj.round() as isize);
        if r == 0 {
            None
        } else {
            Some(self.value_raw(r))
        }
    }

    /// Sample onto a Web Mercator raster. bbox = (x0, y0, x1, y1) in 0..1 mercator units.
    /// Output keeps this grid's quantization (raw 0 = no data).
    pub fn render(&self, bbox: (f64, f64, f64, f64), w: usize, h: usize) -> Vec<u16> {
        let idx = sample_indices(&self.proj, self.nx, self.ny, bbox, w, h);
        idx.par_iter().map(|&i| if i == u32::MAX { 0 } else { self.data[i as usize] }).collect()
    }

    /// Reduce resolution by an integer stride (keeps memory in check for huge grids).
    pub fn decimate(self, stride: usize) -> Grid {
        if stride <= 1 {
            return self;
        }
        let nx = self.nx / stride;
        let ny = self.ny / stride;
        let mut data = vec![0u16; nx * ny];
        data.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
            for (i, o) in row.iter_mut().enumerate() {
                *o = self.data[(j * stride) * self.nx + i * stride];
            }
        });
        let proj = self.proj.strided(stride, nx);
        Grid { nx, ny, proj, data, ..self }
    }
}

/// For each pixel of a Web Mercator viewport (bbox in 0..1 mercator units), the index of the
/// nearest source cell in a grid of `nx`×`ny` in `proj` (u32::MAX = outside).
pub fn sample_indices(proj: &Proj, nx: usize, ny: usize, bbox: (f64, f64, f64, f64), w: usize, h: usize) -> Vec<u32> {
    let (x0, y0, x1, y1) = bbox;
    let lon_of = |px: usize| -> f64 { (x0 + (px as f64 + 0.5) / w as f64 * (x1 - x0)) * 360.0 - 180.0 };
    let lat_of = |py: usize| -> f64 {
        let y = y0 + (py as f64 + 0.5) / h as f64 * (y1 - y0);
        (std::f64::consts::PI * (1.0 - 2.0 * y)).sinh().atan().to_degrees()
    };
    let at = |i: isize, j: isize| -> u32 {
        if i < 0 || j < 0 || i as usize >= nx || j as usize >= ny {
            u32::MAX
        } else {
            (j as usize * nx + i as usize) as u32
        }
    };
    let mut out = vec![u32::MAX; w * h];
    match proj {
        Proj::LatLon { .. } => {
            // separable: columns depend only on lon, rows only on lat
            let cols: Vec<isize> = (0..w).map(|px| proj.ij(0.0, lon_of(px)).map(|(i, _)| i.round() as isize).unwrap_or(-1)).collect();
            out.par_chunks_mut(w).enumerate().for_each(|(py, row)| {
                let j = proj.ij(lat_of(py), 0.0).map(|(_, j)| j.round() as isize).unwrap_or(-1);
                for (px, o) in row.iter_mut().enumerate() {
                    *o = at(cols[px], j);
                }
            });
        }
        _ => {
            let lons: Vec<f64> = (0..w).map(lon_of).collect();
            out.par_chunks_mut(w).enumerate().for_each(|(py, row)| {
                let lat = lat_of(py);
                for (px, o) in row.iter_mut().enumerate() {
                    if let Some((fi, fj)) = proj.ij(lat, lons[px]) {
                        *o = at(fi.round() as isize, fj.round() as isize);
                    }
                }
            });
        }
    }
    out
}

/// Binary raster sent to apps ("TBWG"), little-endian:
/// 0 "TBWG", 4 u16 version, 6 u16 flags, 8 u32 w, 12 u32 h,
/// 16 f64 x0, 24 f64 y0, 32 f64 x1, 40 f64 y1 (mercator 0..1),
/// 48 f32 scale, 52 f32 offset, 56 f64 valid ms, 64 f64 reference ms, 72 [u8;8] reserved,
/// 80 u16[w*h] raw (0 = no data, value = offset + (raw-1)*scale)
pub fn encode_raster(g: &Grid, bbox: (f64, f64, f64, f64), w: usize, h: usize, data: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(80 + data.len() * 2);
    out.extend_from_slice(b"TBWG");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    for v in [bbox.0, bbox.1, bbox.2, bbox.3] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&g.scale.to_le_bytes());
    out.extend_from_slice(&g.offset.to_le_bytes());
    out.extend_from_slice(&(g.valid_ms as f64).to_le_bytes());
    out.extend_from_slice(&(g.ref_ms as f64).to_le_bytes());
    out.extend_from_slice(&[0u8; 8]);
    for v in data {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// RGBA raster ("TBWG" with flags bit 0 set): same 80-byte header, then w*h*4 bytes.
pub fn encode_rgba(time: i64, bbox: (f64, f64, f64, f64), w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(80 + rgba.len());
    out.extend_from_slice(b"TBWG");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    for v in [bbox.0, bbox.1, bbox.2, bbox.3] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&1f32.to_le_bytes());
    out.extend_from_slice(&0f32.to_le_bytes());
    out.extend_from_slice(&(time as f64).to_le_bytes());
    out.extend_from_slice(&(time as f64).to_le_bytes());
    out.extend_from_slice(&[0u8; 8]);
    out.extend_from_slice(rgba);
    out
}

pub fn earth_radius() -> f64 {
    R_EARTH
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lambert_ndfd_corners() {
        // NDFD CONUS 2.5 km: first point 20.19N 121.55W, LoV 265, latin 25
        let p = Proj::lambert(20.19, -121.550004, 25.0, 25.0, 265.0, 2539.703, 2539.703, 6_371_200.0);
        let (i, j) = p.ij(20.19, -121.550004).unwrap();
        assert!(i.abs() < 1e-6 && j.abs() < 1e-6);
        // last point from pygrib: (50.1024611, -60.88202274) at i=2144, j=1376
        let (i, j) = p.ij(50.1024611, -60.88202274).unwrap();
        assert!((i - 2144.0).abs() < 0.05 && (j - 1376.0).abs() < 0.05, "{i} {j}");
    }

    #[test]
    fn rotated_hrdps_corner() {
        // HRDPS continental: first point rotated (-12.302501, 345.17878), south pole
        // (-36.08852, 245.305142); MSC documents the first point as about 39N 134W
        let p = Proj::RotLatLon { lat0: -12.302501, lon0: 345.17878 - 360.0, dlat: 0.0225, dlon: 0.0225, sp_lat: -36.08852, sp_lon: 245.305142 - 360.0 };
        let (i, j) = p.ij(39.0, -134.0).unwrap();
        assert!(i.abs() < 40.0 && j.abs() < 40.0, "{i} {j}");
        // rotated origin is (sp_lat + 90, sp_lon)
        let (a, b) = to_rotated(90.0 - 36.08852, 245.305142, -36.08852, 245.305142);
        assert!(a.abs() < 1e-6 && b.abs() < 1e-6);
        // wind rotation angle is small near the centre meridian and grows away from it
        assert!(p.north_angle(53.9, -114.7).abs() < 0.01);
        assert!(p.north_angle(45.0, -70.0).abs() > 0.3);
    }

    #[test]
    fn lambert_north_angle() {
        let p = Proj::lambert(21.138, -122.72, 38.5, 38.5, -97.5, 3000.0, 3000.0, 6_371_229.0);
        let n = 38.5f64.to_radians().sin();
        for lon in [-120.0, -97.5, -75.0] {
            let a = p.north_angle(40.0, lon);
            assert!((a - n * (lon + 97.5f64).to_radians()).abs() < 1e-3, "{lon}: {a}");
        }
    }

    #[test]
    fn geos_nadir() {
        let p = Proj::Geos { h: 42_164_160.0, r_eq: 6_378_137.0, r_pol: 6_356_752.31414, lon0: -75.0, x0: -0.101332, dx: 5.6e-5, y0: 0.128212, dy: -5.6e-5 };
        let (i, j) = p.ij(0.0, -75.0).unwrap();
        assert!((i - 0.101332 / 5.6e-5).abs() < 1.0 && (j - 0.128212 / 5.6e-5).abs() < 1.0);
        assert!(p.ij(0.0, 105.0).is_none());
    }
}
