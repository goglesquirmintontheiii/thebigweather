//! `/api/radar/sweep.nc`: one sweep as a CF/Radial-style netCDF-3 classic file
//! (dims time × range; azimuth, elevation, time per ray; the moment as float with _FillValue).

use super::level2::{tilts, Moment, Sweep, Volume};
use crate::export::{text, Attr, Data, Nc};
use anyhow::{anyhow, Result};

pub fn units(moment: &str) -> &'static str {
    match moment {
        "REF" | "CREF" | "REFQC" => "dBZ",
        "VEL" | "SW" | "DVEL" => "m/s",
        "ZDR" | "DREF" => "dB",
        "PHI" => "degrees",
        "KDP" => "degrees/km",
        "ET" | "ZDRCOL" => "km",
        "VIL" => "kg/m2",
        "BIO" => "1",
        _ => "1",
    }
}

/// The sweep and the moment its data is stored under, for any moment id (raw, derived or QC).
pub fn sweep_for(v: &Volume, prev: Option<&Volume>, tilt: usize, moment: &str, o: &super::qc::Opts) -> Result<(Sweep, Moment)> {
    let m = moment.to_ascii_uppercase();
    if super::derived::is_derived(&m) {
        return Ok((super::derived::sweep(v, &m)?, Moment::Ref));
    }
    if super::qc::is_qc(&m) {
        return Ok((super::qc::product_sweep(v, prev, tilt, &m, o)?, Moment::Ref));
    }
    let mm = Moment::parse(&m).ok_or_else(|| anyhow!("unknown moment {moment}"))?;
    let t = tilts(v);
    let t = t.get(tilt).ok_or_else(|| anyhow!("tilt {tilt} not found"))?;
    let si = *t.sweeps.get(mm.code()).ok_or_else(|| anyhow!("{moment} not in tilt {tilt}"))?;
    Ok((v.sweeps[si].clone(), mm))
}

/// netCDF bytes of one sweep.
pub fn sweep_nc(v: &Volume, s: &Sweep, m: Moment, name: &str) -> Result<Vec<u8>> {
    let mut rads: Vec<_> = s.radials.iter().filter_map(|r| r.moment(m).map(|d| (r, d))).collect();
    if rads.is_empty() {
        anyhow::bail!("empty sweep");
    }
    rads.sort_by(|a, b| a.0.azimuth.partial_cmp(&b.0.azimuth).unwrap_or(std::cmp::Ordering::Equal));
    let ngates = rads.iter().map(|(_, d)| d.ngates as usize).max().unwrap_or(0);
    let (first, gate) = (rads[0].1.first_gate_m, rads[0].1.gate_m);
    let t0 = rads.iter().map(|(r, _)| r.time_ms).filter(|t| *t > 0).min().unwrap_or(v.header_time_ms);
    let iso = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default();
    let mut nc = Nc::default();
    let dt = nc.dim("time", rads.len());
    let dr = nc.dim("range", ngates);
    for (k, val) in [
        ("Conventions", "CF/Radial"),
        ("version", "1.4"),
        ("title", &format!("{} {name}", v.site)),
        ("instrument_name", &v.site),
        ("source", "TheBigWeather"),
        ("time_coverage_start", &iso(t0)),
        ("time_coverage_end", &iso(rads.iter().map(|(r, _)| r.time_ms).max().unwrap_or(t0))),
    ] {
        nc.atts.push((k.into(), text(val)));
    }
    nc.var("time", &[dt], vec![("units", text(&format!("seconds since {}", iso(t0)))), ("standard_name", text("time"))], Data::F64(rads.iter().map(|(r, _)| (r.time_ms - t0) as f64 / 1000.0).collect()));
    nc.var("range", &[dr], vec![("units", text("meters")), ("long_name", text("range to centre of gate"))], Data::F32((0..ngates).map(|g| first + g as f32 * gate).collect()));
    nc.var("azimuth", &[dt], vec![("units", text("degrees"))], Data::F32(rads.iter().map(|(r, _)| r.azimuth).collect()));
    nc.var("elevation", &[dt], vec![("units", text("degrees"))], Data::F32(rads.iter().map(|(r, _)| r.elevation).collect()));
    nc.var("latitude", &[], vec![("units", text("degrees_north"))], Data::F64(vec![v.lat as f64]));
    nc.var("longitude", &[], vec![("units", text("degrees_east"))], Data::F64(vec![v.lon as f64]));
    nc.var("altitude", &[], vec![("units", text("meters"))], Data::F64(vec![v.height_m as f64]));
    nc.var("fixed_angle", &[], vec![("units", text("degrees"))], Data::F32(vec![s.elevation()]));
    let mut vals = Vec::with_capacity(rads.len() * ngates);
    for (_, d) in &rads {
        for g in 0..ngates {
            vals.push(if g < d.ngates as usize { d.value(g).unwrap_or(-9999.0) } else { -9999.0 });
        }
    }
    nc.var(name, &[dt, dr], vec![("units", text(units(name))), ("_FillValue", Attr::F32(vec![-9999.0])), ("coordinates", text("elevation azimuth range"))], Data::F32(vals));
    Ok(nc.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radar::geom::tests::synth_volume;

    #[test]
    fn sweep_netcdf_reads_back() {
        let v = synth_volume(&[0.5, 1.5], 100, 30.0, |m, az, _, _| (m == Moment::Ref && az < 10.0).then_some(42.0));
        let (s, m) = sweep_for(&v, None, 0, "REF", &Default::default()).unwrap();
        let b = sweep_nc(&v, &s, m, "REF").unwrap();
        let f = netcdf_reader::NcFile::from_bytes(&b).unwrap();
        let x: Vec<f32> = f.read_variable::<f32>("REF").unwrap().into_raw_vec_and_offset().0;
        assert_eq!(x.len(), 720 * 100);
        assert_eq!(x[0], 42.0);
        assert_eq!(x[100 * 100], -9999.0);
        let az: Vec<f32> = f.read_variable::<f32>("azimuth").unwrap().into_raw_vec_and_offset().0;
        assert!((az[0] - 0.25).abs() < 1e-6);
        let (s2, m2) = sweep_for(&v, None, 0, "CREF", &Default::default()).unwrap();
        assert!(sweep_nc(&v, &s2, m2, "CREF").is_ok());
    }
}
