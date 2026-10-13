//! Data export helpers: a small netCDF-3 classic (CDF-1) writer and GeoJSON → CSV / KML
//! converters (used by `/api/radar/sweep.nc`, `/api/grid/export` and `/api/ovl/<id>?format=`).

use serde_json::Value;

// ---------- netCDF-3 classic ----------

#[derive(Debug, Clone)]
pub enum Attr {
    Text(String),
    F32(Vec<f32>),
    F64(Vec<f64>),
    I32(Vec<i32>),
}

#[derive(Debug, Clone)]
pub enum Data {
    I8(Vec<i8>),
    I16(Vec<i16>),
    I32(Vec<i32>),
    F32(Vec<f32>),
    F64(Vec<f64>),
}

impl Data {
    fn nc_type(&self) -> u32 {
        match self {
            Data::I8(_) => 1,
            Data::I16(_) => 3,
            Data::I32(_) => 4,
            Data::F32(_) => 5,
            Data::F64(_) => 6,
        }
    }
    fn len(&self) -> usize {
        match self {
            Data::I8(v) => v.len(),
            Data::I16(v) => v.len(),
            Data::I32(v) => v.len(),
            Data::F32(v) => v.len(),
            Data::F64(v) => v.len(),
        }
    }
    fn bytes(&self) -> Vec<u8> {
        let mut o = vec![];
        match self {
            Data::I8(v) => o.extend(v.iter().map(|x| *x as u8)),
            Data::I16(v) => v.iter().for_each(|x| o.extend_from_slice(&x.to_be_bytes())),
            Data::I32(v) => v.iter().for_each(|x| o.extend_from_slice(&x.to_be_bytes())),
            Data::F32(v) => v.iter().for_each(|x| o.extend_from_slice(&x.to_be_bytes())),
            Data::F64(v) => v.iter().for_each(|x| o.extend_from_slice(&x.to_be_bytes())),
        }
        pad4(&mut o);
        o
    }
}

pub struct Var {
    pub name: String,
    /// indices into `Nc::dims` (empty = scalar)
    pub dims: Vec<usize>,
    pub atts: Vec<(String, Attr)>,
    pub data: Data,
}

#[derive(Default)]
pub struct Nc {
    pub dims: Vec<(String, usize)>,
    pub atts: Vec<(String, Attr)>,
    pub vars: Vec<Var>,
}

fn pad4(o: &mut Vec<u8>) {
    while o.len() % 4 != 0 {
        o.push(0);
    }
}

fn put_name(o: &mut Vec<u8>, s: &str) {
    o.extend_from_slice(&(s.len() as u32).to_be_bytes());
    o.extend_from_slice(s.as_bytes());
    pad4(o);
}

fn put_atts(o: &mut Vec<u8>, atts: &[(String, Attr)]) {
    if atts.is_empty() {
        o.extend_from_slice(&[0u8; 8]);
        return;
    }
    o.extend_from_slice(&0x0Cu32.to_be_bytes());
    o.extend_from_slice(&(atts.len() as u32).to_be_bytes());
    for (n, a) in atts {
        put_name(o, n);
        match a {
            Attr::Text(t) => {
                o.extend_from_slice(&2u32.to_be_bytes());
                o.extend_from_slice(&(t.len() as u32).to_be_bytes());
                o.extend_from_slice(t.as_bytes());
            }
            Attr::F32(v) => {
                o.extend_from_slice(&5u32.to_be_bytes());
                o.extend_from_slice(&(v.len() as u32).to_be_bytes());
                v.iter().for_each(|x| o.extend_from_slice(&x.to_be_bytes()));
            }
            Attr::F64(v) => {
                o.extend_from_slice(&6u32.to_be_bytes());
                o.extend_from_slice(&(v.len() as u32).to_be_bytes());
                v.iter().for_each(|x| o.extend_from_slice(&x.to_be_bytes()));
            }
            Attr::I32(v) => {
                o.extend_from_slice(&4u32.to_be_bytes());
                o.extend_from_slice(&(v.len() as u32).to_be_bytes());
                v.iter().for_each(|x| o.extend_from_slice(&x.to_be_bytes()));
            }
        }
        pad4(o);
    }
}

pub fn text(s: &str) -> Attr {
    Attr::Text(s.to_string())
}

impl Nc {
    pub fn dim(&mut self, name: &str, len: usize) -> usize {
        self.dims.push((name.to_string(), len));
        self.dims.len() - 1
    }
    pub fn var(&mut self, name: &str, dims: &[usize], atts: Vec<(&str, Attr)>, data: Data) {
        self.vars.push(Var { name: name.into(), dims: dims.to_vec(), atts: atts.into_iter().map(|(k, v)| (k.to_string(), v)).collect(), data });
    }

    /// Serialize (CDF-1, no record dimension). Panics never; data length must match the dims
    /// (checked: mismatches are truncated / zero padded).
    pub fn to_bytes(&self) -> Vec<u8> {
        let header = |begins: &[u32]| -> Vec<u8> {
            let mut o = b"CDF\x01".to_vec();
            o.extend_from_slice(&0u32.to_be_bytes()); // numrecs
            if self.dims.is_empty() {
                o.extend_from_slice(&[0u8; 8]);
            } else {
                o.extend_from_slice(&0x0Au32.to_be_bytes());
                o.extend_from_slice(&(self.dims.len() as u32).to_be_bytes());
                for (n, l) in &self.dims {
                    put_name(&mut o, n);
                    o.extend_from_slice(&(*l as u32).to_be_bytes());
                }
            }
            put_atts(&mut o, &self.atts);
            if self.vars.is_empty() {
                o.extend_from_slice(&[0u8; 8]);
            } else {
                o.extend_from_slice(&0x0Bu32.to_be_bytes());
                o.extend_from_slice(&(self.vars.len() as u32).to_be_bytes());
                for (k, v) in self.vars.iter().enumerate() {
                    put_name(&mut o, &v.name);
                    o.extend_from_slice(&(v.dims.len() as u32).to_be_bytes());
                    for d in &v.dims {
                        o.extend_from_slice(&(*d as u32).to_be_bytes());
                    }
                    put_atts(&mut o, &v.atts);
                    o.extend_from_slice(&v.data.nc_type().to_be_bytes());
                    o.extend_from_slice(&(self.vsize(v) as u32).to_be_bytes());
                    o.extend_from_slice(&begins.get(k).copied().unwrap_or(0).to_be_bytes());
                }
            }
            o
        };
        let hlen = header(&vec![0; self.vars.len()]).len();
        let mut begins = vec![];
        let mut off = hlen;
        for v in &self.vars {
            begins.push(off as u32);
            off += self.vsize(v);
        }
        let mut out = header(&begins);
        for v in &self.vars {
            let mut b = v.data.bytes();
            b.resize(self.vsize(v), 0);
            out.extend_from_slice(&b);
        }
        out
    }

    fn vsize(&self, v: &Var) -> usize {
        let n: usize = v.dims.iter().map(|d| self.dims.get(*d).map(|x| x.1).unwrap_or(0)).product::<usize>().max(if v.dims.is_empty() { 1 } else { 0 });
        let w = match v.data {
            Data::I8(_) => 1,
            Data::I16(_) => 2,
            Data::I32(_) | Data::F32(_) => 4,
            Data::F64(_) => 8,
        };
        let _ = v.data.len();
        (n * w).div_ceil(4) * 4
    }
}

// ---------- GeoJSON → CSV / KML ----------

fn scalar(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Representative point of a geometry: the point itself, else the bbox centre of its coordinates.
pub fn rep_point(g: &Value) -> Option<(f64, f64)> {
    if g["type"] == "Point" {
        return Some((g["coordinates"][0].as_f64()?, g["coordinates"][1].as_f64()?));
    }
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    fn walk(v: &Value, b: &mut [f64; 4]) {
        if let Some(a) = v.as_array() {
            if a.len() >= 2 && a[0].is_number() && a[1].is_number() {
                let (x, y) = (a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0));
                b[0] = b[0].min(x);
                b[1] = b[1].min(y);
                b[2] = b[2].max(x);
                b[3] = b[3].max(y);
            } else {
                a.iter().for_each(|x| walk(x, b));
            }
        }
    }
    walk(&g["coordinates"], &mut b);
    if let Some(gs) = g["geometries"].as_array() {
        for x in gs {
            if let Some((px, py)) = rep_point(x) {
                walk(&serde_json::json!([px, py]), &mut b);
            }
        }
    }
    b[0].is_finite().then(|| ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0))
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

/// CSV: `lon,lat,geometry,<property columns…>` (lon/lat = point or bbox centre).
pub fn geojson_to_csv(v: &Value) -> String {
    let feats = v["features"].as_array().cloned().unwrap_or_default();
    let mut cols: Vec<String> = vec![];
    for f in &feats {
        if let Some(p) = f["properties"].as_object() {
            for k in p.keys() {
                if !cols.contains(k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    let mut out = String::from("lon,lat,geometry");
    for c in &cols {
        out.push(',');
        // property names that collide with the leading columns get a prefix
        let name = if ["lon", "lat", "geometry"].contains(&c.as_str()) { format!("prop_{c}") } else { c.clone() };
        out.push_str(&csv_field(&name));
    }
    out.push('\n');
    for f in &feats {
        let (x, y) = rep_point(&f["geometry"]).map(|(a, b)| (format!("{a}"), format!("{b}"))).unwrap_or_default();
        out.push_str(&format!("{x},{y},{}", f["geometry"]["type"].as_str().unwrap_or("")));
        for c in &cols {
            out.push(',');
            out.push_str(&csv_field(&scalar(&f["properties"][c])));
        }
        out.push('\n');
    }
    out
}

fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn kml_coords(c: &Value) -> String {
    c.as_array().map(|a| a.iter().filter_map(|p| Some(format!("{},{}", p[0].as_f64()?, p[1].as_f64()?))).collect::<Vec<_>>().join(" ")).unwrap_or_default()
}

fn kml_geom(g: &Value) -> String {
    let c = &g["coordinates"];
    let poly = |rings: &Value| -> String {
        let r = rings.as_array().cloned().unwrap_or_default();
        let mut s = String::from("<Polygon>");
        for (k, ring) in r.iter().enumerate() {
            let tag = if k == 0 { "outerBoundaryIs" } else { "innerBoundaryIs" };
            s.push_str(&format!("<{tag}><LinearRing><coordinates>{}</coordinates></LinearRing></{tag}>", kml_coords(ring)));
        }
        s + "</Polygon>"
    };
    match g["type"].as_str().unwrap_or("") {
        "Point" => format!("<Point><coordinates>{},{}</coordinates></Point>", c[0].as_f64().unwrap_or(0.0), c[1].as_f64().unwrap_or(0.0)),
        "LineString" => format!("<LineString><coordinates>{}</coordinates></LineString>", kml_coords(c)),
        "Polygon" => poly(c),
        "MultiPoint" => format!("<MultiGeometry>{}</MultiGeometry>", c.as_array().map(|a| a.iter().map(|p| format!("<Point><coordinates>{},{}</coordinates></Point>", p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0))).collect::<String>()).unwrap_or_default()),
        "MultiLineString" => format!("<MultiGeometry>{}</MultiGeometry>", c.as_array().map(|a| a.iter().map(|l| format!("<LineString><coordinates>{}</coordinates></LineString>", kml_coords(l))).collect::<String>()).unwrap_or_default()),
        "MultiPolygon" => format!("<MultiGeometry>{}</MultiGeometry>", c.as_array().map(|a| a.iter().map(poly).collect::<String>()).unwrap_or_default()),
        "GeometryCollection" => format!("<MultiGeometry>{}</MultiGeometry>", g["geometries"].as_array().map(|a| a.iter().map(kml_geom).collect::<String>()).unwrap_or_default()),
        _ => String::new(),
    }
}

/// KML document: one Placemark per feature (name from name/title/id/event properties,
/// ExtendedData with every property).
pub fn geojson_to_kml(v: &Value, title: &str) -> String {
    let mut out = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document><name>{}</name>\n", xml_esc(title));
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let name = ["name", "title", "event", "id", "place", "storm_id"].iter().map(|k| scalar(&p[*k])).find(|s| !s.is_empty()).unwrap_or_default();
        out.push_str(&format!("<Placemark><name>{}</name><ExtendedData>", xml_esc(&name)));
        if let Some(o) = p.as_object() {
            for (k, x) in o {
                out.push_str(&format!("<Data name=\"{}\"><value>{}</value></Data>", xml_esc(k), xml_esc(&scalar(x))));
            }
        }
        out.push_str("</ExtendedData>");
        out.push_str(&kml_geom(&f["geometry"]));
        out.push_str("</Placemark>\n");
    }
    out.push_str("</Document></kml>\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn netcdf3_roundtrip() {
        let mut nc = Nc::default();
        let y = nc.dim("y", 2);
        let x = nc.dim("x", 3);
        nc.atts.push(("title".into(), text("test")));
        nc.var("lat", &[y], vec![("units", text("degrees_north"))], Data::F64(vec![40.0, 41.0]));
        nc.var("v", &[y, x], vec![("units", text("mm")), ("_FillValue", Attr::F32(vec![-9999.0]))], Data::F32(vec![1.0, 2.0, 3.0, 4.0, 5.0, -9999.0]));
        nc.var("q", &[x], vec![], Data::I16(vec![7, 8, 9]));
        nc.var("one", &[], vec![], Data::I8(vec![5]));
        let b = nc.to_bytes();
        assert_eq!(&b[..4], b"CDF\x01");
        let f = netcdf_reader::NcFile::from_bytes(&b).expect("netcdf-reader parses our file");
        let v: Vec<f32> = f.read_variable::<f32>("v").unwrap().into_raw_vec_and_offset().0;
        assert_eq!(v, vec![1.0, 2.0, 3.0, 4.0, 5.0, -9999.0]);
        let lat: Vec<f64> = f.read_variable::<f64>("lat").unwrap().into_raw_vec_and_offset().0;
        assert_eq!(lat, vec![40.0, 41.0]);
        let q: Vec<i16> = f.read_variable::<i16>("q").unwrap().into_raw_vec_and_offset().0;
        assert_eq!(q, vec![7, 8, 9]);
        let units = f.variable("v").unwrap().attribute("units").and_then(|a| a.value.as_string()).unwrap();
        assert_eq!(units, "mm");
        assert_eq!(f.global_attribute("title").ok().and_then(|a| a.value.as_string()).unwrap(), "test");
    }

    #[test]
    fn csv_and_kml() {
        let g = json!({"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-97.5, 35.2]}, "properties": {"name": "A, \"x\"", "mag": 4.5}},
            {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[-98.0, 35.0], [-96.0, 35.0], [-96.0, 37.0], [-98.0, 35.0]]]}, "properties": {"level": "warning"}}
        ]});
        let c = geojson_to_csv(&g);
        let lines: Vec<&str> = c.lines().collect();
        // serde_json maps are sorted by key
        assert_eq!(lines[0], "lon,lat,geometry,mag,name,level");
        assert_eq!(lines[1], "-97.5,35.2,Point,4.5,\"A, \"\"x\"\"\",");
        assert_eq!(lines[2], "-97,36,Polygon,,,warning");
        let k = geojson_to_kml(&g, "t & u");
        assert!(k.contains("<name>t &amp; u</name>"));
        assert!(k.contains("<Point><coordinates>-97.5,35.2</coordinates></Point>"));
        assert!(k.contains("<outerBoundaryIs><LinearRing><coordinates>-98,35 -96,35 -96,37 -98,35</coordinates>"));
        assert!(k.contains("<Data name=\"level\"><value>warning</value></Data>"));
    }
}
