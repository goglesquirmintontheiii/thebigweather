//! GRIB2 → Grid.

use super::{earth_radius, Grid, Proj};
use anyhow::{anyhow, bail, Result};
use grib::GridDefinitionTemplateValues as G;
use serde::{Deserialize, Serialize};
use std::io::Read;

/// Unit conversion applied while decoding.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transform {
    #[default]
    None,
    /// Kelvin → °C
    KToC,
    /// Pa → hPa
    PaToHpa,
    /// m → km
    MToKm,
    /// m → mm (e.g. ECMWF total precip)
    MToMm,
    /// m → cm (snow depth)
    MToCm,
    /// fraction (0–1) → percent
    FracToPct,
}

impl Transform {
    #[inline]
    pub fn apply(self, v: f32) -> f32 {
        match self {
            Transform::None => v,
            Transform::KToC => v - 273.15,
            Transform::PaToHpa => v / 100.0,
            Transform::MToKm => v / 1000.0,
            Transform::MToMm => v * 1000.0,
            Transform::MToCm => v * 100.0,
            Transform::FracToPct => v * 100.0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct DecodeOpts {
    /// exact values treated as missing (MRMS uses -999 / -99)
    pub nodata: Vec<f32>,
    /// values at or below this are missing
    pub min_valid: Option<f32>,
    pub transform: Transform,
    /// decimate grids larger than this in either dimension
    pub max_dim: usize,
}

/// Decompress .gz if needed.
pub fn maybe_gunzip(bytes: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>> {
    if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut out = Vec::with_capacity(bytes.len() * 4);
        flate2::read::MultiGzDecoder::new(bytes).read_to_end(&mut out)?;
        Ok(std::borrow::Cow::Owned(out))
    } else {
        Ok(std::borrow::Cow::Borrowed(bytes))
    }
}

fn earth_r(shape: u8, scale: u8, value: u32) -> f64 {
    match shape {
        0 => 6_367_470.0,
        1 => {
            let r = value as f64 / 10f64.powi(scale as i32);
            if r > 6_000_000.0 && r < 7_000_000.0 {
                r
            } else {
                earth_radius()
            }
        }
        6 => 6_371_229.0,
        8 => 6_371_200.0,
        _ => earth_radius(),
    }
}

fn norm_lon(l: f64) -> f64 {
    let mut l = l % 360.0;
    if l > 180.0 {
        l -= 360.0;
    }
    if l < -180.0 {
        l += 360.0;
    }
    l
}

/// Geometry of a GRIB2 grid: (nx, ny, proj, column_major)
/// Returns (nx, ny, projection, scanning-mode flags).
fn geometry(def: &G) -> Result<(usize, usize, Proj, u8)> {
    match def {
        G::Template0(t) => {
            let g = &t.lat_lon.grid;
            let unit = if g.initial_production_domain_basic_angle == 0 || g.initial_production_domain_basic_angle == u32::MAX || g.basic_angle_subdivisions == 0 || g.basic_angle_subdivisions == u32::MAX {
                1e-6
            } else {
                g.initial_production_domain_basic_angle as f64 / g.basic_angle_subdivisions as f64
            };
            let scan = t.lat_lon.scanning_mode.0;
            let (nx, ny) = (g.ni as usize, g.nj as usize);
            let di = t.lat_lon.i_direction_inc as f64 * unit;
            let dj = t.lat_lon.j_direction_inc as f64 * unit;
            let lat0 = g.first_point_lat as f64 * unit;
            let lon0 = norm_lon(g.first_point_lon as f64 * unit);
            let dlon = if scan & 0x80 != 0 { -di } else { di };
            let dlat = if scan & 0x40 != 0 { dj } else { -dj };
            let global = di * nx as f64 >= 359.0;
            Ok((nx, ny, Proj::LatLon { lat0, lon0, dlat, dlon, nx, global }, scan))
        }
        G::Template30(t) => {
            let e = &t.earth_shape;
            let r = earth_r(e.shape, e.spherical_earth_radius.scale_factor, e.spherical_earth_radius.scaled_value);
            let scan = t.scanning_mode.0;
            let dx = t.dx as f64 / 1000.0 * if scan & 0x80 != 0 { -1.0 } else { 1.0 };
            let dy = t.dy as f64 / 1000.0 * if scan & 0x40 != 0 { 1.0 } else { -1.0 };
            let p = Proj::lambert(
                t.first_point_lat as f64 * 1e-6,
                norm_lon(t.first_point_lon as f64 * 1e-6),
                t.latin1 as f64 * 1e-6,
                t.latin2 as f64 * 1e-6,
                norm_lon(t.lov as f64 * 1e-6),
                dx,
                dy,
                r,
            );
            Ok((t.ni as usize, t.nj as usize, p, scan))
        }
        G::Template20(t) => {
            let e = &t.earth_shape;
            let r = earth_r(e.shape, e.spherical_earth_radius.scale_factor, e.spherical_earth_radius.scaled_value);
            let scan = t.scanning_mode.0;
            let south = t.projection_centre.0 & 0x80 != 0;
            let dx = t.dx as f64 / 1000.0 * if scan & 0x80 != 0 { -1.0 } else { 1.0 };
            let dy = t.dy as f64 / 1000.0 * if scan & 0x40 != 0 { 1.0 } else { -1.0 };
            let p = Proj::polar(
                t.first_point_lat as f64 * 1e-6,
                norm_lon(t.first_point_lon as f64 * 1e-6),
                t.lov as f64 * 1e-6,
                t.lad as f64 * 1e-6,
                south,
                dx,
                dy,
                r,
            );
            Ok((t.ni as usize, t.nj as usize, p, scan))
        }
        _ => bail!("unsupported grid template"),
    }
}

pub struct MessageInfo {
    pub index: usize,
    pub discipline: u8,
    pub category: u8,
    pub number: u8,
    pub valid_ms: i64,
    pub ref_ms: i64,
}

/// List messages with their parameter codes and times (cheap: no unpacking).
pub fn list_messages(bytes: &[u8]) -> Result<Vec<MessageInfo>> {
    let g = grib::from_bytes(bytes).map_err(|e| anyhow!("grib: {e}"))?;
    let mut out = vec![];
    for (k, (_, sub)) in g.iter().enumerate() {
        let pd = sub.prod_def();
        let t = sub.temporal_info();
        out.push(MessageInfo {
            index: k,
            discipline: sub.indicator().discipline,
            category: pd.parameter_category().unwrap_or(0),
            number: pd.parameter_number().unwrap_or(0),
            valid_ms: t.forecast_time_target.map(|d| d.timestamp_millis()).unwrap_or(0),
            ref_ms: t.ref_time.map(|d| d.timestamp_millis()).unwrap_or(0),
        });
    }
    Ok(out)
}

/// Decode message `index` (0-based submessage order) into a Grid.
pub fn decode(bytes: &[u8], index: usize, opts: &DecodeOpts) -> Result<Grid> {
    let g = grib::from_bytes(bytes).map_err(|e| anyhow!("grib: {e}"))?;
    let (_, sub) = g.iter().nth(index).ok_or_else(|| anyhow!("message {index} not found"))?;
    let def = G::try_from(sub.grid_def()).map_err(|e| anyhow!("grid def: {e}"))?;
    let (nx, ny, proj, scan) = geometry(&def)?;
    let col_major = scan & 0x20 != 0;
    let t = sub.temporal_info();
    let valid_ms = t.forecast_time_target.map(|d| d.timestamp_millis()).unwrap_or(0);
    let ref_ms = t.ref_time.map(|d| d.timestamp_millis()).unwrap_or(0);
    let decoder = grib::Grib2SubmessageDecoder::from(sub).map_err(|e| anyhow!("decoder: {e}"))?;
    let iter = decoder.dispatch().map_err(|e| anyhow!("unpack: {e}"))?;
    let mut vals: Vec<f32> = Vec::with_capacity(nx * ny);
    for v in iter {
        let mut v = v;
        if !v.is_finite() || opts.nodata.iter().any(|n| (v - n).abs() < 1e-3) || opts.min_valid.map(|m| v <= m).unwrap_or(false) || v.abs() > 9.0e20 {
            v = f32::NAN;
        } else {
            v = opts.transform.apply(v);
        }
        vals.push(v);
    }
    if vals.len() != nx * ny {
        bail!("value count {} != {}x{}", vals.len(), nx, ny);
    }
    // 0x10: adjacent rows (or columns) alternate direction ("boustrophedon"), used by NDFD
    if scan & 0x10 != 0 {
        let (len, n) = if col_major { (ny, nx) } else { (nx, ny) };
        for k in (1..n).step_by(2) {
            vals[k * len..(k + 1) * len].reverse();
        }
    }
    if col_major {
        let mut t = vec![f32::NAN; nx * ny];
        for i in 0..nx {
            for j in 0..ny {
                t[j * nx + i] = vals[i * ny + j];
            }
        }
        vals = t;
    }
    let grid = Grid::from_values(nx, ny, proj, &vals, valid_ms, ref_ms);
    let stride = if opts.max_dim > 0 { nx.max(ny).div_ceil(opts.max_dim) } else { 1 };
    Ok(grid.decimate(stride))
}

/// Decode only the grid points nearest to `pts` (lat, lon) from the first message: avoids
/// holding a whole national grid when just a small window is needed (MRMS 3D cube).
/// Missing / outside → NaN.
pub fn decode_at(bytes: &[u8], opts: &DecodeOpts, pts: &[(f64, f64)]) -> Result<(Vec<f32>, i64)> {
    let g = grib::from_bytes(bytes).map_err(|e| anyhow!("grib: {e}"))?;
    let (_, sub) = g.iter().next().ok_or_else(|| anyhow!("empty grib"))?;
    let def = G::try_from(sub.grid_def()).map_err(|e| anyhow!("grid def: {e}"))?;
    let (nx, ny, proj, scan) = geometry(&def)?;
    if scan & 0x30 != 0 {
        bail!("unsupported scanning mode {scan:#x}");
    }
    let t = sub.temporal_info();
    let valid_ms = t.forecast_time_target.or(t.ref_time).map(|d| d.timestamp_millis()).unwrap_or(0);
    let mut order: Vec<(usize, usize)> = pts
        .iter()
        .enumerate()
        .filter_map(|(k, &(lat, lon))| {
            let (fi, fj) = proj.ij(lat, lon)?;
            let (i, j) = (fi.round(), fj.round());
            (i >= 0.0 && j >= 0.0 && (i as usize) < nx && (j as usize) < ny).then(|| (j as usize * nx + i as usize, k))
        })
        .collect();
    order.sort_unstable();
    let mut out = vec![f32::NAN; pts.len()];
    if order.is_empty() {
        return Ok((out, valid_ms));
    }
    let decoder = grib::Grib2SubmessageDecoder::from(sub).map_err(|e| anyhow!("decoder: {e}"))?;
    let iter = decoder.dispatch().map_err(|e| anyhow!("unpack: {e}"))?;
    let mut p = 0;
    for (n, v) in iter.enumerate() {
        if order[p].0 > n {
            continue;
        }
        let ok = v.is_finite() && !opts.nodata.iter().any(|x| (v - x).abs() < 1e-3) && !opts.min_valid.map(|m| v <= m).unwrap_or(false) && v.abs() < 9.0e20;
        while p < order.len() && order[p].0 == n {
            out[order[p].1] = if ok { opts.transform.apply(v) } else { f32::NAN };
            p += 1;
        }
        if p == order.len() {
            break;
        }
    }
    Ok((out, valid_ms))
}

/// Decode two messages (U and V) and combine into wind speed.
pub fn decode_speed(u_bytes: &[u8], v_bytes: &[u8], opts: &DecodeOpts) -> Result<Grid> {
    let o = DecodeOpts { transform: Transform::None, ..opts.clone() };
    let u = decode(u_bytes, 0, &DecodeOpts { max_dim: 0, ..o.clone() })?;
    let v = decode(v_bytes, 0, &DecodeOpts { max_dim: 0, ..o })?;
    if u.data.len() != v.data.len() {
        bail!("U/V grids differ");
    }
    let vals: Vec<f32> = u
        .data
        .iter()
        .zip(&v.data)
        .map(|(&a, &b)| if a == 0 || b == 0 { f32::NAN } else { (u.value_raw(a).powi(2) + v.value_raw(b).powi(2)).sqrt() })
        .collect();
    let g = Grid::from_values(u.nx, u.ny, u.proj.clone(), &vals, u.valid_ms, u.ref_ms);
    let stride = if opts.max_dim > 0 { g.nx.max(g.ny).div_ceil(opts.max_dim) } else { 1 };
    Ok(g.decimate(stride))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn td(p: &str) -> Option<Vec<u8>> {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        std::fs::read(format!("{base}/grib/{p}")).ok()
    }

    #[test]
    fn mrms_reflectivity() {
        let Some(b) = td("MRMS_ReflectivityAtLowestAltitude_00.50_20230406-120039.grib2.gz") else { return };
        let b = maybe_gunzip(&b).unwrap();
        let g = decode(&b, 0, &DecodeOpts { nodata: vec![-999.0, -99.0], ..Default::default() }).unwrap();
        assert_eq!((g.nx, g.ny), (7000, 3500));
        // MRMS CONUS grid: 54.995N, -129.995 first point, 0.01 deg
        let (i, j) = g.proj.ij(54.995, -129.995).unwrap();
        assert!(i.abs() < 0.01 && j.abs() < 0.01, "{i} {j}");
        let (i, j) = g.proj.ij(20.005, -60.005).unwrap();
        assert!((i - 6999.0).abs() < 0.01 && (j - 3499.0).abs() < 0.01, "{i} {j}");
        assert!(g.data.iter().any(|&r| r != 0));
        // point sampling agrees with the full decode
        let opts = DecodeOpts { nodata: vec![-999.0, -99.0], ..Default::default() };
        let pts: Vec<(f64, f64)> = (0..400).map(|k| (30.0 + (k / 20) as f64 * 0.5, -100.0 + (k % 20) as f64 * 0.7)).chain([(60.0, -100.0)]).collect();
        let (vals, t) = decode_at(&b, &opts, &pts).unwrap();
        assert!(t > 0);
        assert!(vals[400].is_nan());
        for (k, &(lat, lon)) in pts.iter().enumerate().take(400) {
            match (g.sample(lat, lon), vals[k]) {
                (None, v) => assert!(v.is_nan()),
                (Some(a), v) => assert!((a - v).abs() < 0.01, "{lat},{lon}: {a} vs {v}"),
            }
        }
    }

    #[test]
    fn ndfd_lambert() {
        let Some(b) = td("ds.minrh.bin") else { return };
        let msgs = list_messages(&b).unwrap();
        assert!(!msgs.is_empty());
        let g = decode(&b, 0, &DecodeOpts::default()).unwrap();
        assert_eq!((g.nx, g.ny), (2145, 1377));
        let (i, j) = g.proj.ij(20.19, -121.550004).unwrap();
        assert!(i.abs() < 0.5 && j.abs() < 0.5, "{i} {j}");
        // a value somewhere in Kansas should exist (RH 0..100)
        let v = g.sample(38.5, -98.0).unwrap();
        assert!((0.0..=100.0).contains(&v), "{v}");
    }

    #[test]
    fn gfs_quarter_degree() {
        let Some(b) = td("gdas.t12z.pgrb2.0p25.f000.0-10") else { return };
        let g = decode(&b, 0, &DecodeOpts::default()).unwrap();
        assert_eq!((g.nx, g.ny), (1440, 721));
        assert!(g.sample(40.0, -100.0).is_some());
        assert!(g.sample(-30.0, 150.0).is_some());
    }

    #[test]
    fn ecmwf_ccsds() {
        let Some(b) = td("20240101000000-0h-oper-fc.grib2.0-10") else { return };
        let g = decode(&b, 0, &DecodeOpts::default()).unwrap();
        assert!(g.nx >= 900, "{}", g.nx);
        assert!(g.sample(51.5, -0.1).is_some());
    }
}

