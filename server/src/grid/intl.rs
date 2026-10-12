//! International gridded radar composites served as normal grid layers:
//! EUMETNET OPERA (ODIM HDF5, LAEA) and Taiwan CWA QPESUMS (XML text grid).

use super::sources::LayerDef;
use super::{Grid, Laea, Proj};
use super::decode::Transform;
use anyhow::{anyhow, bail, Context, Result};
use hdf5_reader::{Datatype, Hdf5File, SliceInfo, SliceInfoElem};

/// OPERA rolling 24 h archive (anonymous, path-style S3 on CloudFerro).
pub const OPERA_BASE: &str = "https://s3.waw3-1.cloudferro.com/openradar-24h";
/// CWA open data bucket (ap-northeast-1).
pub const CWA_BASE: &str = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com";

pub fn layers() -> Vec<LayerDef> {
    let l = |id: &str, name: &str, product: &str, units: &'static str, cmap: &'static str, source: &'static str, step: u32, min_valid: Option<f32>| LayerDef {
        id: id.into(),
        group: "International radar".into(),
        name: name.into(),
        units,
        cmap,
        product: product.into(),
        transform: Transform::None,
        nodata: vec![],
        min_valid,
        source,
        model: None,
        step_min: step,
    };
    vec![
        l("opera_dbzh", "Europe · OPERA Reflectivity", "DBZH", "dBZ", "REF", "opera", 5, Some(-30.0)),
        l("opera_rate", "Europe · OPERA Rain Rate", "RATE", "mm/h", "PRATE", "opera", 15, Some(0.0)),
        l("cwa_ref", "Taiwan · CWA Composite Reflectivity", "compref_mosaic", "dBZ", "REF", "cwa", 10, Some(-30.0)),
    ]
}

/// "…/OPERA@20261011T0005@0@DBZH.h5" → (time ms, product)
pub fn opera_parse(key: &str) -> Option<(i64, &str)> {
    let name = key.rsplit('/').next()?;
    let mut p = name.split('@');
    if p.next()? != "OPERA" {
        return None;
    }
    let t = chrono::NaiveDateTime::parse_from_str(p.next()?, "%Y%m%dT%H%M").ok()?.and_utc().timestamp_millis();
    let _ = p.next()?;
    let prod = p.next()?.strip_suffix(".h5")?;
    Some((t, prod))
}

/// "history/Observation/202610111200compref_mosaic.xml" (Taipei time, UTC+8) → UTC ms
pub fn cwa_time(key: &str) -> Option<i64> {
    let name = key.rsplit('/').next()?;
    let stem = name.strip_suffix("compref_mosaic.xml")?;
    let t = chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d%H%M").ok()?.and_utc().timestamp_millis();
    Some(t - 8 * 3_600_000)
}

fn attr_f64(g: &hdf5_reader::group::Group, name: &str) -> Option<f64> {
    g.attribute(name).ok()?.read_as_f64().ok()
}

fn attr_str(g: &hdf5_reader::group::Group, name: &str) -> Option<String> {
    let a = g.attribute(name).ok()?;
    a.read_string().ok().or_else(|| a.read_strings().ok().and_then(|v| v.into_iter().next())).map(|s| s.trim_end_matches('\0').trim().to_string())
}

/// Parse "+proj=laea +lat_0=55 +lon_0=10 +ellps=WGS84 ..." → (lat0, lon0, a, e)
fn parse_projdef(p: &str) -> Result<(f64, f64, f64, f64)> {
    let kv = |k: &str| p.split_whitespace().find_map(|t| t.strip_prefix('+').unwrap_or(t).strip_prefix(&format!("{k}=")).map(|v| v.to_string()));
    let proj = kv("proj").unwrap_or_default();
    if proj != "laea" {
        bail!("unsupported projection '{proj}'");
    }
    let num = |k: &str| kv(k).and_then(|v| v.parse::<f64>().ok());
    let lat0 = num("lat_0").ok_or_else(|| anyhow!("projdef lacks lat_0"))?;
    let lon0 = num("lon_0").ok_or_else(|| anyhow!("projdef lacks lon_0"))?;
    let (a, e) = if let Some(r) = num("R") {
        (r, 0.0)
    } else if let (Some(a), Some(b)) = (num("a"), num("b")) {
        (a, (1.0 - (b * b) / (a * a)).max(0.0).sqrt())
    } else {
        match kv("ellps").as_deref() {
            Some("sphere") => (6_370_997.0, 0.0),
            // WGS84 / GRS80
            _ => (6_378_137.0, 0.0818191908426215),
        }
    };
    Ok((lat0, lon0, a, e))
}

/// Read rows [r0, r1) (every `stride`-th row and column) of a 2D dataset as f64.
fn read_rows(ds: &hdf5_reader::Dataset, r0: u64, r1: u64, nx: u64, stride: u64) -> Result<Vec<f64>> {
    let sel = SliceInfo { selections: vec![SliceInfoElem::Slice { start: r0, end: r1, step: stride }, SliceInfoElem::Slice { start: 0, end: nx, step: stride }] };
    macro_rules! rd {
        ($t:ty) => {
            ds.read_slice::<$t>(&sel).map_err(|e| anyhow!("hdf5 read: {e}"))?.iter().map(|&v| v as f64).collect()
        };
    }
    Ok(match ds.dtype() {
        Datatype::FloatingPoint { size: 8, .. } => rd!(f64),
        Datatype::FloatingPoint { .. } => rd!(f32),
        Datatype::FixedPoint { size: 1, signed: false, .. } => rd!(u8),
        Datatype::FixedPoint { size: 1, signed: true, .. } => rd!(i8),
        Datatype::FixedPoint { size: 2, signed: false, .. } => rd!(u16),
        Datatype::FixedPoint { size: 2, signed: true, .. } => rd!(i16),
        Datatype::FixedPoint { size: 4, signed: true, .. } => rd!(i32),
        Datatype::FixedPoint { size: 4, signed: false, .. } => rd!(u32),
        d => bail!("unsupported ODIM data type {d:?}"),
    })
}

/// Decode an ODIM HDF5 composite (first `dataN/dataM` whose quantity is `quantity`, else
/// dataset1/data1). nodata/undetect → missing. Decimates to at most `max_dim` per side.
pub fn decode_odim(bytes: &[u8], quantity: &str, max_dim: usize, min_valid: Option<f32>) -> Result<Grid> {
    let f = Hdf5File::from_bytes(bytes).map_err(|e| anyhow!("hdf5: {e}"))?;
    let wh = f.group("/where").map_err(|e| anyhow!("ODIM /where: {e}"))?;
    let projdef = attr_str(&wh, "projdef").ok_or_else(|| anyhow!("ODIM projdef missing"))?;
    let (lat0, lon0, a, e) = parse_projdef(&projdef)?;
    let xscale = attr_f64(&wh, "xscale").ok_or_else(|| anyhow!("xscale missing"))?;
    let yscale = attr_f64(&wh, "yscale").ok_or_else(|| anyhow!("yscale missing"))?;
    let (ul_lon, ul_lat) = (attr_f64(&wh, "UL_lon").ok_or_else(|| anyhow!("UL_lon missing"))?, attr_f64(&wh, "UL_lat").ok_or_else(|| anyhow!("UL_lat missing"))?);
    // data group for the quantity
    let mut path = "dataset1/data1".to_string();
    'find: for d in 1..=4 {
        for q in 1..=8 {
            let p = format!("dataset{d}/data{q}");
            match f.group(&format!("/{p}/what")) {
                Ok(w) => {
                    if attr_str(&w, "quantity").map(|s| s.eq_ignore_ascii_case(quantity)).unwrap_or(false) {
                        path = p;
                        break 'find;
                    }
                }
                Err(_) => break,
            }
        }
    }
    let what = f.group(&format!("/{path}/what")).map_err(|e| anyhow!("ODIM {path}/what: {e}"))?;
    let gain = attr_f64(&what, "gain").unwrap_or(1.0);
    let offset = attr_f64(&what, "offset").unwrap_or(0.0);
    let nodata = attr_f64(&what, "nodata");
    let undetect = attr_f64(&what, "undetect");
    let ds = f.dataset(&format!("/{path}/data")).map_err(|e| anyhow!("ODIM {path}/data: {e}"))?;
    let shape = ds.shape().to_vec();
    if shape.len() != 2 {
        bail!("ODIM data is not 2D");
    }
    let (ny, nx) = (shape[0], shape[1]);
    let stride = if max_dim > 0 { (nx.max(ny) as usize).div_ceil(max_dim).max(1) as u64 } else { 1 };
    let (onx, ony) = (nx.div_ceil(stride) as usize, ny.div_ceil(stride) as usize);
    let mut vals: Vec<f32> = Vec::with_capacity(onx * ony);
    let band = 256 * stride;
    let mut r = 0;
    while r < ny {
        let r1 = (r + band).min(ny);
        for raw in read_rows(&ds, r, r1, nx, stride)? {
            let miss = |s: Option<f64>| s.map(|s| (raw - s).abs() <= 1e-6 * s.abs().max(1.0)).unwrap_or(false);
            let v = if miss(nodata) || miss(undetect) || !raw.is_finite() { f32::NAN } else { (raw * gain + offset) as f32 };
            vals.push(if min_valid.map(|m| v <= m).unwrap_or(false) { f32::NAN } else { v });
        }
        r = r1;
    }
    if vals.len() != onx * ony {
        bail!("ODIM read {} values, expected {}", vals.len(), onx * ony);
    }
    // time: /what date + time (nominal), fall back to dataset end time
    let tw = f.group("/what").ok();
    let t = tw
        .as_ref()
        .and_then(|w| Some(format!("{}{}", attr_str(w, "date")?, attr_str(w, "time")?)))
        .and_then(|s| chrono::NaiveDateTime::parse_from_str(&s, "%Y%m%d%H%M%S").ok())
        .map(|d| d.and_utc().timestamp_millis())
        .unwrap_or(0);
    let mut l = Laea::new(lat0, lon0, a, e);
    let (ulx, uly) = l.xy(ul_lat, ul_lon);
    l.x0 = ulx + xscale / 2.0;
    l.y0 = uly - yscale / 2.0;
    l.dx = xscale * stride as f64;
    l.dy = -yscale * stride as f64;
    Ok(Grid::from_values(onx, ony, Proj::Laea(l), &vals, t, t))
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("<{name}");
    let mut from = 0;
    let open = loop {
        let o = from + xml[from..].find(&pat)?;
        let next = xml[o + pat.len()..].chars().next()?;
        if next == '>' || next == ' ' || next == '/' {
            break o;
        }
        from = o + pat.len();
    };
    let gt = open + xml[open..].find('>')? + 1;
    let close = gt + xml[gt..].find(&format!("</{name}>"))?;
    Some(&xml[gt..close])
}

/// Decode a CWA `compref_mosaic.xml` (O-A0059-001): comma-separated dBZ, first value at the
/// south-west corner, rows south→north. -99 / -999 = missing.
pub fn decode_cwa(bytes: &[u8], valid_ms: i64) -> Result<Grid> {
    let xml = std::str::from_utf8(bytes).context("CWA XML is not UTF-8")?;
    let num = |n: &str| tag(xml, n).and_then(|s| s.trim().parse::<f64>().ok());
    let nx = num("GridDimensionX").map(|v| v as usize).unwrap_or(921);
    let ny = num("GridDimensionY").map(|v| v as usize).unwrap_or(881);
    let res = num("GridResolution").filter(|r| *r > 0.0 && *r < 1.0).unwrap_or(0.0125);
    let lon0 = num("StartPointLongitude").unwrap_or(115.0);
    let lat0 = num("StartPointLatitude").unwrap_or(18.0);
    let content = tag(xml, "content").ok_or_else(|| anyhow!("CWA XML has no <content>"))?;
    let mut vals: Vec<f32> = Vec::with_capacity(nx * ny);
    for t in content.split(|c: char| c == ',' || c.is_whitespace()) {
        if t.is_empty() {
            continue;
        }
        let v: f32 = t.parse().map_err(|_| anyhow!("bad CWA value '{t}'"))?;
        vals.push(if v <= -99.0 || v < -30.0 { f32::NAN } else { v });
    }
    if vals.len() != nx * ny {
        bail!("CWA grid has {} values, expected {nx}x{ny}", vals.len());
    }
    let proj = Proj::LatLon { lat0, lon0, dlat: res, dlon: res, nx, global: false };
    Ok(Grid::from_values(nx, ny, proj, &vals, valid_ms, valid_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hdf5_writer::{AttributeBuilder, DatasetBuilder, Hdf5Builder, WriteOptions};

    #[test]
    fn laea_opera_corners() {
        // OPERA composite grid: centre 55N 10E; the grid's upper-left corner is 1950 km west and
        // 2100 km north of it (x_0 = 1 950 000, y_0 = -2 100 000 with the grid starting at 0, 0)
        let l = Laea::new(55.0, 10.0, 6_378_137.0, 0.0818191908426215);
        let (x, y) = l.xy(55.0, 10.0);
        assert!(x.abs() < 1e-6 && y.abs() < 1e-6);
        // published corner coordinates of the OPERA 3800 × 4400 km grid
        let (x, y) = l.xy(67.02, -39.535);
        assert!((x + 1_950_000.0).abs() < 6000.0 && (y - 2_100_000.0).abs() < 6000.0, "UL {x} {y}");
        let (x, y) = l.xy(31.746, -10.434);
        assert!((x + 1_950_000.0).abs() < 6000.0 && (y + 2_300_000.0).abs() < 6000.0, "LL {x} {y}");
    }

    fn odim(nx: usize, ny: usize, values: &[f64]) -> Vec<u8> {
        let b = Hdf5Builder::new()
            .dataset(
                DatasetBuilder::typed_data("dataset1/data1/data", vec![ny as u64, nx as u64], values)
                    .unwrap()
                    .chunked(vec![2, nx as u64]),
            )
            .group_attribute("what", AttributeBuilder::fixed_string("date", "20261011"))
            .group_attribute("what", AttributeBuilder::fixed_string("time", "120500"))
            .group_attribute("where", AttributeBuilder::fixed_string("projdef", "+proj=laea +lat_0=55.0 +lon_0=10.0 +x_0=1950000.0 +y_0=-2100000.0 +units=m +ellps=WGS84"))
            .group_attribute("where", AttributeBuilder::scalar("xscale", 1000.0f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("yscale", 1000.0f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("xsize", nx as i64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("ysize", ny as i64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("UL_lon", 9.0f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("UL_lat", 56.0f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::fixed_string("quantity", "DBZH"))
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("gain", 1.0f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("offset", 0.0f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("nodata", -9999000.0f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("undetect", -8888000.0f64).unwrap());
        b.into_plan().unwrap().encode(WriteOptions::default()).unwrap()
    }

    #[test]
    fn odim_decode() {
        let (nx, ny) = (6, 5);
        let mut v = vec![-8888000.0f64; nx * ny];
        v[0] = 42.5; // top-left (north-west) pixel
        v[nx * ny - 1] = -9999000.0;
        v[nx + 2] = 10.0;
        let bytes = odim(nx, ny, &v);
        let g = decode_odim(&bytes, "DBZH", 0, Some(-30.0)).unwrap();
        assert_eq!((g.nx, g.ny), (6, 5));
        assert_eq!(g.valid_ms, chrono::NaiveDate::from_ymd_opt(2026, 10, 11).unwrap().and_hms_opt(12, 5, 0).unwrap().and_utc().timestamp_millis());
        // the NW pixel's centre is half a km in from the UL corner
        let l = Laea::new(55.0, 10.0, 6_378_137.0, 0.0818191908426215);
        let (ux, uy) = l.xy(56.0, 9.0);
        // find the lat/lon of the first pixel centre by inverting numerically: sample around it
        let x = g.sample(56.0 - 0.003, 9.0 + 0.008).unwrap();
        assert!((x - 42.5).abs() < 0.01, "{x}");
        assert!(g.sample(56.5, 9.0).is_none());
        let _ = (ux, uy);
        assert!(g.data.iter().filter(|&&r| r != 0).count() == 2);
        // decimated
        let g2 = decode_odim(&bytes, "DBZH", 3, None).unwrap();
        assert_eq!((g2.nx, g2.ny), (3, 3));
    }

    #[test]
    fn cwa_decode_and_names() {
        let xml = "<?xml version=\"1.0\"?><cwaopendata xmlns=\"urn:cwa:gov:tw:cwacommon:0.1\"><dataset><datasetInfo><parameterSet><GridDimensionX>3</GridDimensionX><GridDimensionY>2</GridDimensionY></parameterSet></datasetInfo><contents><content>1.00E+01,-9.90E+01,2.50E+01,\n-9.99E+02,4.00E+01,5.0E+00</content></contents></dataset></cwaopendata>";
        let g = decode_cwa(xml.as_bytes(), 5).unwrap();
        assert_eq!((g.nx, g.ny), (3, 2));
        assert!((g.sample(18.0, 115.0).unwrap() - 10.0).abs() < 0.01);
        assert!((g.sample(18.0125, 115.0125).unwrap() - 40.0).abs() < 0.01);
        assert!(g.sample(18.0, 115.0125).is_none());
        assert_eq!(cwa_time("history/Observation/202610111200compref_mosaic.xml"), Some(chrono::NaiveDate::from_ymd_opt(2026, 10, 11).unwrap().and_hms_opt(4, 0, 0).unwrap().and_utc().timestamp_millis()));
        assert_eq!(cwa_time("history/Observation/202610111200.QPESUMS_GAUGE.10M.xml"), None);
        let (t, p) = opera_parse("2026/10/11/OPERA/COMP/OPERA@20261011T0005@0@DBZH.h5").unwrap();
        assert_eq!(p, "DBZH");
        assert_eq!(t % 3_600_000, 5 * 60_000);
        assert!(opera_parse("2026/10/11/OPERA/COMP/OPERA@20261011T0005@0@DBZH.tiff").is_none());
    }
}

/// `TBW_WRITE_FIXTURES=<dir> cargo test --release write_fixtures -- --ignored` writes small
/// OPERA / CWA sample files usable with `--grid-dir` (offline testing of the grid layers).
#[cfg(test)]
mod fixtures {
    use hdf5_writer::{AttributeBuilder, DatasetBuilder, Hdf5Builder, WriteOptions};

    #[test]
    #[ignore]
    fn write_fixtures() {
        let Ok(dir) = std::env::var("TBW_WRITE_FIXTURES") else { return };
        std::fs::create_dir_all(&dir).unwrap();
        // OPERA: real projection and corners, 10 km cells (380 × 440); a 45 dBZ blob over Germany
        let (nx, ny) = (380usize, 440usize);
        let l = super::Laea::new(55.0, 10.0, 6_378_137.0, 0.0818191908426215);
        let (cx, cy) = l.xy(50.5, 10.0);
        let mut v = vec![-8888000.0f64; nx * ny];
        for j in 0..ny {
            for i in 0..nx {
                let x = -1_950_000.0 + (i as f64 + 0.5) * 10_000.0;
                let y = 2_100_000.0 - (j as f64 + 0.5) * 10_000.0;
                let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                if d < 150_000.0 {
                    v[j * nx + i] = 45.0 - d / 10_000.0;
                }
                if x < -1_700_000.0 {
                    v[j * nx + i] = -9999000.0;
                }
            }
        }
        let b = Hdf5Builder::new()
            .dataset(DatasetBuilder::typed_data("dataset1/data1/data", vec![ny as u64, nx as u64], &v).unwrap().chunked(vec![40, nx as u64]))
            .group_attribute("what", AttributeBuilder::fixed_string("date", "20261011"))
            .group_attribute("what", AttributeBuilder::fixed_string("time", "120000"))
            .group_attribute("where", AttributeBuilder::fixed_string("projdef", "+proj=laea +lat_0=55.0 +lon_0=10.0 +x_0=1950000.0 +y_0=-2100000.0 +units=m +ellps=WGS84"))
            .group_attribute("where", AttributeBuilder::scalar("xscale", 10000.0f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("yscale", 10000.0f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("UL_lon", -39.535f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("UL_lat", 67.02f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::fixed_string("quantity", "DBZH"))
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("gain", 1.0f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("offset", 0.0f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("nodata", -9999000.0f64).unwrap())
            .group_attribute("dataset1/data1/what", AttributeBuilder::scalar("undetect", -8888000.0f64).unwrap());
        std::fs::write(format!("{dir}/opera_dbzh__OPERA@20261011T1200@0@DBZH.h5"), b.into_plan().unwrap().encode(WriteOptions::default()).unwrap()).unwrap();
        // CWA: same layout as O-A0059-001 at 0.125° (93 × 89), a 50 dBZ cell east of Taiwan
        let (nx, ny) = (93usize, 89usize);
        let mut vals = vec![];
        for j in 0..ny {
            for i in 0..nx {
                let (lat, lon) = (18.0 + j as f64 * 0.125, 115.0 + i as f64 * 0.125);
                let d = ((lat - 23.5).powi(2) + (lon - 122.0).powi(2)).sqrt();
                vals.push(if d < 1.0 { format!("{:.2E}", 50.0 - d * 20.0) } else if d > 5.0 { "-9.99E+02".into() } else { "-9.90E+01".into() });
            }
        }
        let xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<cwaopendata xmlns=\"urn:cwa:gov:tw:cwacommon:0.1\"><dataset><datasetInfo><parameterSet><StartPointLongitude>115.0</StartPointLongitude><StartPointLatitude>18.0</StartPointLatitude><GridResolution>0.125</GridResolution><GridDimensionX>{nx}</GridDimensionX><GridDimensionY>{ny}</GridDimensionY></parameterSet></datasetInfo><contents><content>{}</content></contents></dataset></cwaopendata>\n", vals.join(","));
        std::fs::write(format!("{dir}/cwa_ref__202610112000compref_mosaic.xml"), xml).unwrap();
    }
}
