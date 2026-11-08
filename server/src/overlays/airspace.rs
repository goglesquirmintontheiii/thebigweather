//! 0.8.2 aviation: airspace layers.
//!
//! * `airspace` — US Class B / C / D / E (surface) airspace and special-use airspace (MOA,
//!   restricted, prohibited, warning, alert, danger) from the FAA Aeronautical Information Services
//!   open-data feature services (ArcGIS Online, org ssFJjBXIUyZDrSYZ). The national layers are
//!   downloaded once and kept on disk for a week (the FAA updates them every 56 days); requests
//!   are answered from memory for the map box, generalised for the zoom (Douglas–Peucker, ~1 px)
//!   with small airspaces dropped at low zoom, so a response stays small.
//! * `airadv` — airspace advisories not shown elsewhere: TFRs (tfr.faa.gov: GeoServer WFS shapes +
//!   the TFR list + each NOTAM's XML for times / altitudes / text, cached per NOTAM revision) and
//!   Center Weather Advisories (aviationweather.gov). SIGMETs (US + international) and G-AIRMETs
//!   already have their own layers.

use super::agsquery::{self, parse_bbox, Query};
use super::{fc, Overlays};
use anyhow::{bail, Result};
use futures::StreamExt;
use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CLASS_LAYER: &str = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0";
const SUA_LAYER: &str = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0";
const CLASS_WHERE: &str = "TYPE_CODE='CLASS' AND LOCAL_TYPE IN ('CLASS_B','CLASS_C','CLASS_D','CLASS_E2','CLASS_E3','CLASS_E4')";
const CLASS_FIELDS: &str = "NAME,IDENT,ICAO_ID,CLASS,LOCAL_TYPE,SECTOR,UPPER_DESC,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_DESC,LOWER_VAL,LOWER_UOM,LOWER_CODE,WKHR_CODE,WKHR_RMK,CITY,STATE";
const SUA_FIELDS: &str = "NAME,TYPE_CODE,UPPER_DESC,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_DESC,LOWER_VAL,LOWER_UOM,LOWER_CODE,TIMESOFUSE,CONT_AGENT,CITY,STATE,REMARKS";
/// on-disk copy lifetime (data changes every 56 days)
const DISK_AGE: Duration = Duration::from_secs(7 * 86400);
/// most features in one response
const MAX_FEATURES: usize = 2500;

type Ring = Vec<[f64; 2]>;

pub struct Shape {
    /// "B" "C" "D" "E" (class) or "MOA" "R" "P" "W" "A" "D!" (special use; danger = "DA")
    pub kind: &'static str,
    pub sua: bool,
    pub bbox: [f64; 4],
    pub polys: Vec<Vec<Ring>>,
    pub props: Map<String, Value>,
}

#[derive(Default)]
pub struct Store {
    pub shapes: Vec<Shape>,
}

static STORE: Lazy<RwLock<Option<(Instant, Arc<Store>)>>> = Lazy::new(Default::default);
static LOADING: Lazy<tokio::sync::Mutex<()>> = Lazy::new(Default::default);

// ---------- geometry ----------

fn ring_of(v: &Value) -> Option<Ring> {
    let r: Ring = v.as_array()?.iter().filter_map(|p| Some([p.get(0)?.as_f64()?, p.get(1)?.as_f64()?])).collect();
    (r.len() >= 4).then_some(r)
}

/// GeoJSON Polygon / MultiPolygon → polygons of rings.
pub fn polys_of(g: &Value) -> Vec<Vec<Ring>> {
    let poly = |p: &Value| -> Option<Vec<Ring>> {
        let rings: Vec<Ring> = p.as_array()?.iter().filter_map(ring_of).collect();
        (!rings.is_empty()).then_some(rings)
    };
    match g["type"].as_str() {
        Some("Polygon") => poly(&g["coordinates"]).into_iter().collect(),
        Some("MultiPolygon") => g["coordinates"].as_array().map(|a| a.iter().filter_map(poly).collect()).unwrap_or_default(),
        _ => vec![],
    }
}

fn bbox_of(polys: &[Vec<Ring>]) -> [f64; 4] {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for p in polys {
        for pt in p.first().into_iter().flatten() {
            b[0] = b[0].min(pt[0]);
            b[1] = b[1].min(pt[1]);
            b[2] = b[2].max(pt[0]);
            b[3] = b[3].max(pt[1]);
        }
    }
    b
}

/// Douglas–Peucker on a closed ring (first == last); keeps at least 4 points when possible.
pub fn simplify(r: &[[f64; 2]], tol: f64) -> Ring {
    if r.len() <= 4 || tol <= 0.0 {
        return r.to_vec();
    }
    let n = r.len();
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    // a closed ring: split at the point farthest from the start so both halves are open chains
    let far = (1..n - 1).max_by(|&a, &b| d2(r[a], r[0]).total_cmp(&d2(r[b], r[0]))).unwrap_or(n / 2);
    keep[far] = true;
    let mut stack = vec![(0usize, far), (far, n - 1)];
    let t2 = tol * tol;
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (mut best, mut bi) = (0.0, 0);
        for i in a + 1..b {
            let d = seg_d2(r[i], r[a], r[b]);
            if d > best {
                best = d;
                bi = i;
            }
        }
        if best > t2 {
            keep[bi] = true;
            stack.push((a, bi));
            stack.push((bi, b));
        }
    }
    let out: Ring = r.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect();
    if out.len() < 4 { r.to_vec() } else { out }
}

fn d2(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)
}

fn seg_d2(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l = dx * dx + dy * dy;
    if l == 0.0 {
        return d2(p, a);
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l).clamp(0.0, 1.0);
    d2(p, [a[0] + t * dx, a[1] + t * dy])
}

// ---------- altitudes / labels ----------

fn sval(p: &Value, k: &str) -> String {
    agsquery::s(p, k)
}

/// "SFC", "FL180", "7,000 ft MSL", "1,200 ft AGL", "UNL".
pub fn alt_text(val: Option<f64>, uom: &str, code: &str) -> String {
    let code = code.to_ascii_uppercase();
    let uom = uom.to_ascii_uppercase();
    match val {
        _ if code == "SFC" || code == "GND" => "SFC".into(),
        _ if code == "UNL" || code == "UNLTD" => "UNL".into(),
        None => if code.is_empty() { "—".into() } else { code },
        Some(v) if v <= -9000.0 => "UNL".into(),
        Some(v) if uom == "FL" => format!("FL{}", v.round() as i64),
        Some(v) if v == 0.0 && (code == "AGL" || code == "HEI") => "SFC".into(),
        Some(v) => format!("{} ft {}", thousands(v.round() as i64), if code == "HEI" { "AGL" } else if code == "ALT" || code.is_empty() { "MSL" } else { code.as_str() }),
    }
}

fn thousands(v: i64) -> String {
    let s = v.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if v < 0 { format!("-{out}") } else { out }
}

/// VFR-chart style altitude in hundreds of feet ("70", "SFC", "180" for FL180).
pub fn hundreds(val: Option<f64>, uom: &str, code: &str) -> String {
    let code = code.to_ascii_uppercase();
    match val {
        _ if code == "SFC" || code == "GND" => "SFC".into(),
        Some(v) if v <= -9000.0 => "UNL".into(),
        Some(v) if uom.eq_ignore_ascii_case("FL") => format!("{}", v.round() as i64),
        Some(v) if v == 0.0 => "SFC".into(),
        Some(v) => format!("{}", (v / 100.0).round() as i64),
        None => "—".into(),
    }
}

/// "7,000 ft MSL" → "7,000", "1,200 ft AGL" → "1,200 AGL"; SFC / FL / UNL unchanged.
fn short_alt(s: &str) -> String {
    s.replace(" (excl.)", "").replace(" ft MSL", "").replace(" ft AGL", " AGL")
}

fn sua_kind(t: &str) -> Option<&'static str> {
    Some(match t.trim().to_ascii_uppercase().as_str() {
        "MOA" => "MOA",
        "R" => "R",
        "P" => "P",
        "W" => "W",
        "A" => "A",
        "D" => "DA",
        _ => return None,
    })
}

fn class_kind(local: &str) -> Option<&'static str> {
    Some(match local {
        "CLASS_B" => "B",
        "CLASS_C" => "C",
        "CLASS_D" => "D",
        "CLASS_E2" | "CLASS_E3" | "CLASS_E4" => "E",
        _ => return None,
    })
}

/// One FAA feature → a stored shape with display properties.
pub fn shape_of(f: &Value, sua: bool) -> Option<Shape> {
    let p = &f["properties"];
    let kind = if sua { sua_kind(&sval(p, "TYPE_CODE"))? } else { class_kind(&sval(p, "LOCAL_TYPE"))? };
    let polys = polys_of(&f["geometry"]);
    if polys.is_empty() {
        return None;
    }
    let (lv, hv) = (agsquery::f(p, "LOWER_VAL"), agsquery::f(p, "UPPER_VAL"));
    let (lu, lc, hu, hc) = (sval(p, "LOWER_UOM"), sval(p, "LOWER_CODE"), sval(p, "UPPER_UOM"), sval(p, "UPPER_CODE"));
    let lo = alt_text(lv, &lu, &lc);
    let mut hi = alt_text(hv, &hu, &hc);
    if sval(p, "UPPER_DESC") == "TI" && hi != "UNL" && hi != "—" {
        // "to, but not including"
        hi = format!("{hi} (excl.)");
    }
    let name = sval(p, "NAME");
    let (h100, l100) = (hundreds(hv, &hu, &hc), hundreds(lv, &lu, &lc));
    let lbl = match kind {
        "B" | "C" => format!("{h100}\n{l100}"),
        "D" => format!("[{h100}]"),
        "E" => String::new(),
        _ => format!("{name}\n{}–{}", short_alt(&lo), short_alt(&hi)),
    };
    let mut m = Map::new();
    m.insert("k".into(), json!(kind));
    m.insert("name".into(), json!(name));
    m.insert("lo".into(), json!(lo));
    m.insert("hi".into(), json!(hi));
    m.insert("lbl".into(), json!(lbl));
    let put = |m: &mut Map<String, Value>, k: &str, src: &str| {
        let v = sval(p, src);
        if !v.is_empty() {
            m.insert(k.into(), json!(v));
        }
    };
    put(&mut m, "city", "CITY");
    put(&mut m, "state", "STATE");
    if sua {
        put(&mut m, "times", "TIMESOFUSE");
        put(&mut m, "agency", "CONT_AGENT");
        put(&mut m, "rmk", "REMARKS");
    } else {
        put(&mut m, "ident", "ICAO_ID");
        put(&mut m, "sector", "SECTOR");
        put(&mut m, "times", "WKHR_CODE");
        put(&mut m, "times_rmk", "WKHR_RMK");
        let local = sval(p, "LOCAL_TYPE");
        if kind == "E" {
            m.insert("sub".into(), json!(if local == "CLASS_E2" { "Surface area" } else { "Surface extension" }));
        }
    }
    let bbox = bbox_of(&polys);
    Some(Shape { kind, sua, bbox, polys, props: m })
}

// ---------- national store ----------

/// Features of one layer: disk copy if younger than a week, else the FAA service (paged), with the
/// stale copy as a fallback.
async fn layer(o: &Overlays, file: &str, layer: &str, where_: &str, fields: &str) -> Result<Vec<Value>> {
    let p = o.data_dir.join(file);
    let fresh = std::fs::metadata(&p).and_then(|m| m.modified()).ok().map(|t| t.elapsed().unwrap_or_default() < DISK_AGE).unwrap_or(false);
    let read = || async { tokio::fs::read(&p).await.ok().and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok()).filter(|v| !v.is_empty()) };
    if fresh {
        if let Some(v) = read().await {
            return Ok(v);
        }
    }
    // ~10 m generalisation at the source keeps the national download a few MB
    let q = Query { layer, where_, fields, max: 20_000, page: 2000, simplify: 0.0001, ..Default::default() };
    match agsquery::features(o, &q).await {
        Ok(v) if !v.is_empty() => {
            if let Ok(b) = serde_json::to_vec(&v) {
                tokio::fs::write(&p, b).await.ok();
            }
            Ok(v)
        }
        r => {
            if let Some(v) = read().await {
                tracing::warn!("{file}: {}; using the cached copy", r.err().map(|e| format!("{e:#}")).unwrap_or_else(|| "empty".into()));
                return Ok(v);
            }
            match r {
                Err(e) => Err(e),
                Ok(_) => bail!("FAA airspace service returned nothing"),
            }
        }
    }
}

async fn store(o: &Overlays) -> Result<Arc<Store>> {
    let cur = |max: Duration| STORE.read().as_ref().filter(|(t, _)| t.elapsed() < max).map(|(_, s)| s.clone());
    if let Some(s) = cur(Duration::from_secs(86400)) {
        return Ok(s);
    }
    let _g = LOADING.lock().await;
    if let Some(s) = cur(Duration::from_secs(86400)) {
        return Ok(s);
    }
    let (a, b) = tokio::join!(layer(o, "airspace_class.json", CLASS_LAYER, CLASS_WHERE, CLASS_FIELDS), layer(o, "airspace_sua.json", SUA_LAYER, "1=1", SUA_FIELDS));
    if let (Err(e), Err(_)) = (&a, &b) {
        // keep serving an older copy if there is one
        if let Some(s) = cur(Duration::MAX) {
            return Ok(s);
        }
        bail!("{e:#}");
    }
    let mut shapes: Vec<Shape> = vec![];
    shapes.extend(a.unwrap_or_default().iter().filter_map(|f| shape_of(f, false)));
    shapes.extend(b.unwrap_or_default().iter().filter_map(|f| shape_of(f, true)));
    // draw order: big first, so smaller airspace (and its label) sits on top
    shapes.sort_by(|x, y| area(&y.bbox).total_cmp(&area(&x.bbox)));
    let s = Arc::new(Store { shapes });
    *STORE.write() = Some((Instant::now(), s.clone()));
    Ok(s)
}

fn area(b: &[f64; 4]) -> f64 {
    (b[2] - b[0]) * (b[3] - b[1])
}

/// Lowest zoom each kind is sent at (keeps the national view light).
fn min_zoom(kind: &str) -> f64 {
    match kind {
        "B" | "MOA" | "R" | "P" | "W" | "A" | "DA" => 0.0,
        "C" => 5.0,
        _ => 7.0,
    }
}

fn round_to(v: f64, dec: i32) -> f64 {
    let m = 10f64.powi(dec);
    (v * m).round() / m
}

/// Features for a box at a zoom. `cls` / `sua`: include class / special-use airspace.
pub fn query(st: &Store, bb: [f64; 4], z: f64, cls: bool, sua: bool) -> Value {
    let z = z.clamp(0.0, 16.0);
    // one screen pixel in degrees (at the equator; generous further north)
    let px = 360.0 / (256.0 * 2f64.powf(z.floor()));
    let tol = px * 0.8;
    let dec = ((z / 3.0).floor() as i32 + 2).clamp(3, 5);
    let mut out = vec![];
    let mut more = false;
    for s in &st.shapes {
        if (s.sua && !sua) || (!s.sua && !cls) || z < min_zoom(s.kind) {
            continue;
        }
        let b = s.bbox;
        if b[2] < bb[0] || b[0] > bb[2] || b[3] < bb[1] || b[1] > bb[3] {
            continue;
        }
        // smaller than ~3 px on screen: not worth drawing
        if (b[2] - b[0]).max(b[3] - b[1]) < px * 3.0 {
            continue;
        }
        if out.len() >= MAX_FEATURES {
            more = true;
            break;
        }
        let polys: Vec<Value> = s
            .polys
            .iter()
            .map(|p| {
                Value::Array(
                    p.iter()
                        .map(|r| Value::Array(simplify(r, tol).iter().map(|q| json!([round_to(q[0], dec), round_to(q[1], dec)])).collect()))
                        .collect(),
                )
            })
            .collect();
        let geom = if polys.len() == 1 { json!({"type": "Polygon", "coordinates": polys[0]}) } else { json!({"type": "MultiPolygon", "coordinates": polys}) };
        out.push(json!({"type": "Feature", "geometry": geom, "properties": Value::Object(s.props.clone())}));
    }
    let mut v = fc(out);
    if more {
        v["_status"] = json!("Zoom in for all airspace");
    }
    v
}

pub async fn airspace(o: &Overlays, bbox: &str, z: &str, cls: &str, sua: &str) -> Result<Value> {
    let bb = parse_bbox(bbox)?.unwrap_or([-180.0, -85.0, 180.0, 85.0]);
    let z: f64 = z.parse().unwrap_or(6.0);
    let st = store(o).await?;
    Ok(query(&st, bb, z, cls != "off", sua != "off"))
}

// ---------- advisories: TFRs + CWAs ----------

const TFR_WFS: &str = "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=500&outputFormat=application/json&srsname=EPSG:4326";
const TFR_LIST: &str = "https://tfr.faa.gov/tfrapi/getTfrList";
const CWA: &str = "https://aviationweather.gov/api/data/cwa?format=geojson";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TfrDetail {
    pub from: String,
    pub to: String,
    /// "SFC – 17,999 ft MSL" per area
    pub alts: Vec<String>,
    pub text: String,
    /// merged area outline (lon, lat) when the NOTAM has one
    pub outline: Ring,
}

/// NOTAM id → (revision, detail)
static TFR_DETAIL: Lazy<Mutex<HashMap<String, (String, TfrDetail)>>> = Lazy::new(Default::default);

fn tag<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let a = s.find(&open)? + open.len();
    let b = s[a..].find(&close)? + a;
    Some(s[a..b].trim())
}

fn blocks<'a>(s: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut out = vec![];
    let mut rest = s;
    while let Some(i) = rest.find(&open) {
        let a = i + open.len();
        let Some(j) = rest[a..].find(&close) else { break };
        out.push(&rest[a..a + j]);
        rest = &rest[a + j + close.len()..];
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&")
}

/// "39.30098401N" / "121.4375W" → signed degrees.
pub fn coord(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num, hemi) = s.split_at(s.len().checked_sub(1)?);
    let v: f64 = num.parse().ok()?;
    match hemi {
        "N" | "E" => Some(v),
        "S" | "W" => Some(-v),
        _ => s.parse().ok(),
    }
}

pub fn parse_tfr_xml(x: &str) -> TfrDetail {
    let mut d = TfrDetail { from: tag(x, "dateEffective").unwrap_or("").to_string(), to: tag(x, "dateExpire").unwrap_or("").to_string(), ..Default::default() };
    for a in blocks(x, "aseTFRArea") {
        let v = |k: &str| tag(a, k).unwrap_or("");
        let lo = alt_text(v("valDistVerLower").parse().ok(), v("uomDistVerLower"), v("codeDistVerLower"));
        let hi = alt_text(v("valDistVerUpper").parse().ok(), v("uomDistVerUpper"), v("codeDistVerUpper"));
        let s = format!("{lo} – {hi}");
        if !d.alts.contains(&s) {
            d.alts.push(s);
        }
    }
    d.text = unescape(tag(x, "txtDescrTraditional").unwrap_or(""));
    if d.text.len() > 4000 {
        let mut i = 4000;
        while !d.text.is_char_boundary(i) {
            i -= 1;
        }
        d.text.truncate(i);
        d.text.push('…');
    }
    if let Some(m) = blocks(x, "abdMergedArea").first() {
        d.outline = blocks(m, "Avx").iter().filter_map(|v| Some([coord(tag(v, "geoLong")?)?, coord(tag(v, "geoLat")?)?])).collect();
        if d.outline.len() >= 3 && d.outline.first() != d.outline.last() {
            let f = d.outline[0];
            d.outline.push(f);
        }
    }
    d
}

/// "6/2547-1-FDC-F" → "6/2547"
fn notam_of(key: &str) -> String {
    key.split('-').next().unwrap_or(key).trim().to_string()
}

async fn tfr_details(o: &Overlays, want: Vec<(String, String)>) {
    let missing: Vec<(String, String)> = {
        let c = TFR_DETAIL.lock();
        want.into_iter().filter(|(id, rev)| c.get(id).map(|(r, _)| r != rev).unwrap_or(true)).collect()
    };
    if missing.is_empty() {
        return;
    }
    let jobs = futures::stream::iter(missing)
        .map(|(id, rev)| async move {
            let url = format!("https://tfr.faa.gov/download/detail_{}.xml", id.replace('/', "_"));
            if let Ok(x) = o.get_text(&url).await {
                if x.contains("<XNOTAM") || x.contains("<Not>") {
                    TFR_DETAIL.lock().insert(id, (rev, parse_tfr_xml(&x)));
                }
            }
        })
        .buffer_unordered(6)
        .collect::<Vec<()>>();
    // whatever isn't done in time is fetched on the next request
    let _ = tokio::time::timeout(Duration::from_secs(20), jobs).await;
}

/// "2026-11-01T10:00:00" (UTC) → "2026-11-01T10:00:00Z"
fn utc(s: &str) -> Value {
    if s.is_empty() {
        Value::Null
    } else if s.ends_with('Z') || s.contains('+') {
        json!(s)
    } else {
        json!(format!("{s}Z"))
    }
}

pub async fn advisories(o: &Overlays, tfr: &str, cwa: &str) -> Result<Value> {
    let (want_tfr, want_cwa) = (tfr != "off", cwa != "off");
    let (wfs, list, cw) = tokio::join!(
        async { if want_tfr { Some(o.get_json(TFR_WFS).await) } else { None } },
        async { if want_tfr { Some(o.get_json(TFR_LIST).await) } else { None } },
        async { if want_cwa { Some(o.get_json(CWA).await) } else { None } },
    );
    let mut feats = vec![];
    let mut notes: Vec<&str> = vec![];
    let mut errs = 0;
    if want_tfr {
        let list = match list {
            Some(Ok(v)) => v.as_array().cloned().unwrap_or_default(),
            _ => vec![],
        };
        let shapes = match wfs {
            Some(Ok(v)) => v["features"].as_array().cloned().unwrap_or_default(),
            _ => {
                errs += 1;
                notes.push("TFR shapes unavailable");
                vec![]
            }
        };
        let mut want: Vec<(String, String)> = list.iter().map(|t| (agsquery::s(t, "notam_id"), agsquery::s(t, "mod_abs_time"))).filter(|(i, _)| !i.is_empty()).collect();
        for f in &shapes {
            let id = notam_of(&agsquery::s(&f["properties"], "NOTAM_KEY"));
            if !id.is_empty() && !want.iter().any(|(i, _)| *i == id) {
                want.push((id, agsquery::s(&f["properties"], "LAST_MODIFICATION_DATETIME")));
            }
        }
        want.truncate(300);
        tfr_details(o, want).await;
        let det = TFR_DETAIL.lock().clone();
        let mut shown = std::collections::HashSet::new();
        let props = |id: &str, ty: &str, title: &str, fac: &str, state: &str| -> Value {
            let d = det.get(id).map(|(_, d)| d.clone()).unwrap_or_default();
            json!({
                "k": "tfr", "notam": id, "type": ty, "title": title, "facility": fac, "state": state,
                "from": utc(&d.from), "to": utc(&d.to), "alt": d.alts.join("; "), "text": d.text,
                "url": format!("https://tfr.faa.gov/tfr3/?page=detail_{}", id.replace('/', "_")),
            })
        };
        for f in shapes {
            let p = &f["properties"];
            let id = notam_of(&agsquery::s(p, "NOTAM_KEY"));
            if id.is_empty() || f["geometry"].is_null() {
                continue;
            }
            shown.insert(id.clone());
            feats.push(json!({"type": "Feature", "geometry": f["geometry"], "properties": props(&id, &agsquery::s(p, "LEGAL"), &agsquery::s(p, "TITLE"), &agsquery::s(p, "CNS_LOCATION_ID"), &agsquery::s(p, "STATE"))}));
        }
        // listed TFRs without a WFS shape: the NOTAM's own merged outline
        for t in &list {
            let id = agsquery::s(t, "notam_id");
            if shown.contains(&id) {
                continue;
            }
            let Some((_, d)) = det.get(&id) else { continue };
            if d.outline.len() < 4 {
                continue;
            }
            let ring: Vec<Value> = d.outline.iter().map(|p| json!([p[0], p[1]])).collect();
            feats.push(json!({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": props(&id, &agsquery::s(t, "type"), &agsquery::s(t, "description"), &agsquery::s(t, "facility"), &agsquery::s(t, "state"))}));
        }
    }
    if want_cwa {
        match cw {
            Some(Ok(v)) => {
                for mut f in v["features"].as_array().cloned().unwrap_or_default() {
                    f["properties"]["k"] = json!("cwa");
                    feats.push(f);
                }
            }
            Some(Err(e)) => {
                errs += 1;
                notes.push("CWAs unavailable");
                tracing::debug!("cwa: {e:#}");
            }
            None => {}
        }
    }
    let wanted = want_tfr as i32 + want_cwa as i32;
    if errs > 0 && errs >= wanted && feats.is_empty() {
        bail!("{}", notes.join(", "));
    }
    let mut v = fc(feats);
    if !notes.is_empty() {
        v["_status"] = json!(notes.join(" · "));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(x0: f64, y0: f64, s: f64) -> Value {
        json!({"type": "Polygon", "coordinates": [[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]]})
    }

    #[test]
    fn altitudes_and_labels() {
        assert_eq!(alt_text(Some(0.0), "FT", "SFC"), "SFC");
        assert_eq!(alt_text(Some(7000.0), "FT", "MSL"), "7,000 ft MSL");
        assert_eq!(alt_text(Some(180.0), "FL", "STD"), "FL180");
        assert_eq!(alt_text(Some(4100.0), "FT", "ALT"), "4,100 ft MSL");
        assert_eq!(alt_text(Some(0.0), "FT", "HEI"), "SFC");
        assert_eq!(alt_text(Some(-9998.0), "FT", "MSL"), "UNL");
        assert_eq!(hundreds(Some(10000.0), "FT", "MSL"), "100");
        assert_eq!(hundreds(Some(0.0), "FT", "SFC"), "SFC");
        let f = json!({"type": "Feature", "geometry": sq(-71.0, 42.0, 0.5), "properties": {"NAME": "BOSTON CLASS B", "LOCAL_TYPE": "CLASS_B", "UPPER_VAL": 7000, "UPPER_UOM": "FT", "UPPER_CODE": "MSL", "UPPER_DESC": "TI", "LOWER_VAL": 0, "LOWER_UOM": "FT", "LOWER_CODE": "SFC"}});
        let s = shape_of(&f, false).unwrap();
        assert_eq!(s.kind, "B");
        assert_eq!(s.props["lbl"], "70\nSFC");
        assert_eq!(s.props["hi"], "7,000 ft MSL (excl.)");
        let r = json!({"type": "Feature", "geometry": sq(-86.0, 33.0, 0.1), "properties": {"NAME": "R-2101", "TYPE_CODE": "R", "UPPER_VAL": "5000", "UPPER_UOM": "FT", "UPPER_CODE": "MSL", "LOWER_VAL": "0", "LOWER_UOM": "FT", "LOWER_CODE": "SFC", "TIMESOFUSE": "0700 - 1800, MON - FRI"}});
        let s = shape_of(&r, true).unwrap();
        assert_eq!(s.kind, "R");
        assert_eq!(s.props["lbl"], "R-2101\nSFC–5,000");
        assert_eq!(s.props["times"], "0700 - 1800, MON - FRI");
        // not a wanted class
        let e5 = json!({"type": "Feature", "geometry": sq(0.0, 0.0, 1.0), "properties": {"LOCAL_TYPE": "CLASS_E5"}});
        assert!(shape_of(&e5, false).is_none());
    }

    #[test]
    fn simplify_keeps_shape() {
        // a circle of 360 points collapses to far fewer at a coarse tolerance, stays closed
        let mut r: Ring = (0..360).map(|i| {
            let a = (i as f64).to_radians();
            [a.cos(), a.sin()]
        }).collect();
        r.push(r[0]);
        let s = simplify(&r, 0.01);
        assert!(s.len() < 60 && s.len() >= 8, "{}", s.len());
        assert_eq!(s.first(), s.last());
        assert_eq!(simplify(&r, 0.0).len(), r.len());
    }

    #[test]
    fn query_filters_by_box_zoom_and_toggle() {
        let mk = |local: &str, x: f64, s: f64| shape_of(&json!({"type": "Feature", "geometry": sq(x, 40.0, s), "properties": {"LOCAL_TYPE": local, "NAME": local}}), false).unwrap();
        let mut st = Store::default();
        st.shapes.push(mk("CLASS_B", -100.0, 0.6));
        st.shapes.push(mk("CLASS_D", -99.0, 0.1));
        st.shapes.push(shape_of(&json!({"type": "Feature", "geometry": sq(-98.0, 40.0, 1.0), "properties": {"TYPE_CODE": "MOA", "NAME": "X MOA"}}), true).unwrap());
        let n = |v: &Value| v["features"].as_array().unwrap().len();
        let bb = [-101.0, 39.0, -96.0, 42.0];
        assert_eq!(n(&query(&st, bb, 5.0, true, true)), 2, "class D hidden below z7");
        assert_eq!(n(&query(&st, bb, 8.0, true, true)), 3);
        assert_eq!(n(&query(&st, bb, 8.0, false, true)), 1);
        assert_eq!(n(&query(&st, bb, 8.0, true, false)), 2);
        assert_eq!(n(&query(&st, [-90.0, 30.0, -80.0, 35.0], 8.0, true, true)), 0);
        // too small on screen at z1
        assert_eq!(n(&query(&st, bb, 1.0, true, true)), 0);
    }

    #[test]
    fn tfr_xml() {
        let x = r#"<XNOTAM-Update><Group><Add><Not><dateEffective>2026-11-01T10:00:00</dateEffective><dateExpire>2027-03-14T09:59:00</dateExpire>
        <txtDescrTraditional>!FDC 6/2547 ZOA CA..AIRSPACE BEALE AFB, CA &amp; VICINITY</txtDescrTraditional>
        <TfrNot><TFRAreaGroup><aseTFRArea><valDistVerLower>4100</valDistVerLower><uomDistVerLower>FT</uomDistVerLower><codeDistVerLower>ALT</codeDistVerLower>
        <valDistVerUpper>180</valDistVerUpper><uomDistVerUpper>FL</uomDistVerUpper><codeDistVerUpper>STD</codeDistVerUpper></aseTFRArea>
        <abdMergedArea><Avx><geoLat>39.3N</geoLat><geoLong>121.4W</geoLong></Avx><Avx><geoLat>39.4N</geoLat><geoLong>121.4W</geoLong></Avx><Avx><geoLat>39.4N</geoLat><geoLong>121.3W</geoLong></Avx></abdMergedArea>
        </TFRAreaGroup></TfrNot></Not></Add></Group></XNOTAM-Update>"#;
        let d = parse_tfr_xml(x);
        assert_eq!(d.from, "2026-11-01T10:00:00");
        assert_eq!(d.to, "2027-03-14T09:59:00");
        assert_eq!(d.alts, vec!["4,100 ft MSL – FL180".to_string()]);
        assert!(d.text.contains("BEALE AFB, CA & VICINITY"));
        assert_eq!(d.outline.len(), 4);
        assert_eq!(d.outline[0], [-121.4, 39.3]);
        assert_eq!(coord("121.4375W"), Some(-121.4375));
        assert_eq!(notam_of("6/6654-1-FDC-F"), "6/6654");
        assert_eq!(utc("2026-11-01T10:00:00"), json!("2026-11-01T10:00:00Z"));
    }
}
