//! GOES-R ABI Cloud & Moisture Imagery (L2 CMIP, NetCDF-4) → Grid in the fixed-grid projection.

use super::{Grid, Proj};
use anyhow::{anyhow, Context, Result};
use netcdf_reader::NcFile;

fn attr_f64(v: &netcdf_reader::NcVariable, name: &str) -> Option<f64> {
    v.attribute(name).and_then(|a| a.value.as_f64())
}

fn attr_str(v: &netcdf_reader::NcVariable, name: &str) -> Option<String> {
    v.attribute(name).and_then(|a| a.value.as_string())
}

/// Decode a CMIP file. `max_dim` decimates very large sectors (0.5 km visible).
pub fn decode_cmip(bytes: &[u8], max_dim: usize) -> Result<Grid> {
    let b = read_band(bytes, max_dim)?;
    Ok(Grid::from_values(b.nx, b.ny, b.proj, &b.vals, b.time, b.time))
}

/// Decode a CMIP file to physical values (K or reflectance factor), decimated so the larger
/// side is at most `max_dim` (0 = full resolution).
pub fn read_band(bytes: &[u8], max_dim: usize) -> Result<super::rgb::Band> {
    let f = NcFile::from_bytes(bytes).map_err(|e| anyhow!("netcdf: {e}"))?;
    let cmi = f.variable("CMI").map_err(|e| anyhow!("no CMI: {e}"))?;
    let shape = cmi.shape();
    if shape.len() != 2 {
        return Err(anyhow!("unexpected CMI shape {shape:?}"));
    }
    let (ny, nx) = (shape[0] as usize, shape[1] as usize);
    let scale = attr_f64(cmi, "scale_factor").unwrap_or(1.0) as f32;
    let offset = attr_f64(cmi, "add_offset").unwrap_or(0.0) as f32;
    let fill = attr_f64(cmi, "_FillValue").unwrap_or(-1.0) as i32;
    let unsigned = attr_str(cmi, "_Unsigned").map(|s| s == "true").unwrap_or(false);
    let raw: Vec<i16> = f.read_variable::<i16>("CMI").map_err(|e| anyhow!("read CMI: {e}"))?.into_raw_vec_and_offset().0;
    // decimate while converting so huge sectors (0.5 km full disk) never exist as f32
    let stride = if max_dim > 0 { nx.max(ny).div_ceil(max_dim) } else { 1 };
    let (onx, ony) = (nx / stride, ny / stride);
    let conv = |r: i16| -> f32 {
        if r as i32 == fill {
            return f32::NAN;
        }
        let v = if unsigned { (r as u16) as f32 } else { r as f32 };
        v * scale + offset
    };
    let mut vals = Vec::with_capacity(onx * ony);
    for j in 0..ony {
        let row = &raw[j * stride * nx..];
        for i in 0..onx {
            vals.push(conv(row[i * stride]));
        }
    }
    drop(raw);

    // fixed-grid coordinates: int16 * scale + offset (radians)
    let axis = |name: &str| -> Result<(f64, f64)> {
        let v = f.variable(name).map_err(|e| anyhow!("no {name}: {e}"))?;
        let s = attr_f64(v, "scale_factor").unwrap_or(1.0);
        let o = attr_f64(v, "add_offset").unwrap_or(0.0);
        let r: Vec<i16> = f.read_variable::<i16>(name).map_err(|e| anyhow!("read {name}: {e}"))?.into_raw_vec_and_offset().0;
        let first = r.first().copied().unwrap_or(0) as f64 * s + o;
        let step = if r.len() > 1 { (r[1] as f64 - r[0] as f64) * s } else { s };
        Ok((first, step))
    };
    let (x0, dx) = axis("x")?;
    let (y0, dy) = axis("y")?;
    let p = f.variable("goes_imager_projection").context("projection")?;
    let h = attr_f64(p, "perspective_point_height").unwrap_or(35_786_023.0);
    let r_eq = attr_f64(p, "semi_major_axis").unwrap_or(6_378_137.0);
    let r_pol = attr_f64(p, "semi_minor_axis").unwrap_or(6_356_752.31414);
    let lon0 = attr_f64(p, "longitude_of_projection_origin").unwrap_or(-75.0);
    let proj = Proj::Geos { h: h + r_eq, r_eq, r_pol, lon0, x0, dx, y0, dy };

    let time = f
        .global_attribute("time_coverage_start")
        .ok()
        .and_then(|a| a.value.as_string())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s.replace(".0Z", "Z")).ok().or_else(|| chrono::DateTime::parse_from_rfc3339(&s).ok()))
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    if stride <= 1 {
        return Ok(super::rgb::Band { nx, ny, proj, vals, time });
    }
    let proj = match proj {
        Proj::Geos { h, r_eq, r_pol, lon0, x0, dx, y0, dy } => Proj::Geos { h, r_eq, r_pol, lon0, x0, dx: dx * stride as f64, y0, dy: dy * stride as f64 },
        p => p,
    };
    Ok(super::rgb::Band { nx: onx, ny: ony, proj, vals, time })
}

/// Start time from an ABI file name: ..._sYYYYJJJHHMMSSt_...
pub fn time_from_name(name: &str) -> Option<i64> {
    let s = name.split('_').find(|p| p.starts_with('s') && p.len() >= 14)?;
    let y: i32 = s[1..5].parse().ok()?;
    let doy: u32 = s[5..8].parse().ok()?;
    let hh: u32 = s[8..10].parse().ok()?;
    let mm: u32 = s[10..12].parse().ok()?;
    let ss: u32 = s[12..14].parse().ok()?;
    let d = chrono::NaiveDate::from_yo_opt(y, doy)?;
    Some(d.and_hms_opt(hh, mm, ss)?.and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    #[test]
    fn synthetic_cmip() {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        let p = format!("{base}/goes/OR_ABI-L2-CMIPC-M6C13_G19_s20262831201180_e20262831203554_c20262831204004.nc");
        let Ok(b) = std::fs::read(&p) else { return };
        let g = super::decode_cmip(&b, 0).unwrap();
        assert_eq!((g.nx, g.ny), (1000, 600));
        assert_eq!(g.data[0], 0, "fill value must be no-data");
        // centre of the cold blob (i=500, j=300) should be ~210 K
        let v = g.value_raw(g.data[300 * 1000 + 500]);
        assert!((v - 210.0).abs() < 0.5, "{v}");
        assert!(g.valid_ms > 0);
        assert_eq!(super::time_from_name(&p).unwrap() / 1000, g.valid_ms / 1000 - 0);
    }
}
