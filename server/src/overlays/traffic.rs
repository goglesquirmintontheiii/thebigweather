//! Keyless road events and traffic flow (TomTom stays available separately with a key).
//!
//! `roadwork` — work zones, closures and incidents:
//! - US DOT WZDx feed registry (data.transportation.gov dataset 69qe-yiui, public domain) → every
//!   active v4.x feed that needs no API key (≈30 state/county DOT feeds; licences per feed, most
//!   CC0/public domain).
//! - California Highway Patrol CAD incidents (`media.chp.ca.gov/sa_xml/sa.xml`, public).
//! - Maryland CHART incidents/closures (`chartexp1.sha.maryland.gov` JSON export, public).
//!
//! `trafficflow` — measured speeds:
//! - Finland Fintraffic Digitraffic TMS stations (CC BY 4.0, "Source: Fintraffic / digitraffic.fi"):
//!   5-min average speed and % of free-flow speed per direction.
//! - Maryland CHART traffic speed sensors (mph per direction, no free-flow reference).
//! - NYC DOT real-time link speeds (NYC Open Data i4gi-tjb9, mph, no free-flow reference).
//!
//! Feeds are only fetched while someone requests the overlay (each source refreshes at most every
//! 5–15 minutes); everything is dropped from memory after 30 idle minutes.

use super::{num, Overlays};
use anyhow::{bail, Result};
use chrono::{Datelike, NaiveDate, NaiveDateTime, Weekday};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const REGISTRY: &str = "https://data.transportation.gov/resource/69qe-yiui.json";
const CHP: &str = "https://media.chp.ca.gov/sa_xml/sa.xml";
const CHART_EVENTS: &str = "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getEventMapDataJSON.do";
const CHART_TSS: &str = "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getTSSMapDataJSON.do";
const DT_STATIONS: &str = "https://tie.digitraffic.fi/api/tms/v1/stations";
const DT_DATA: &str = "https://tie.digitraffic.fi/api/tms/v1/stations/data";
const NYC: &str = "https://data.cityofnewyork.us/resource/i4gi-tjb9.json?$limit=3000&$order=data_as_of%20DESC";
const MAX_FEATURES: usize = 5000;
const MAX_LINE_PTS: usize = 80;

#[derive(Clone, Debug, PartialEq)]
pub enum Geom {
    Pt([f32; 2]),
    Line(Vec<[f32; 2]>),
    Multi(Vec<Vec<[f32; 2]>>),
}

impl Geom {
    fn bbox(&self) -> [f32; 4] {
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
        let mut add = |p: &[f32; 2]| b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        match self {
            Geom::Pt(p) => add(p),
            Geom::Line(l) => l.iter().for_each(&mut add),
            Geom::Multi(m) => m.iter().flatten().for_each(&mut add),
        }
        b
    }
    fn json(&self) -> Value {
        // f32 → f64 without float noise (-122.80289 rather than -122.80289459228516)
        let p = |p: &[f32; 2]| p.map(|v| ((v as f64) * 1e5).round() / 1e5);
        let l = |l: &Vec<[f32; 2]>| l.iter().map(p).collect::<Vec<_>>();
        match self {
            Geom::Pt(x) => json!({"type": "Point", "coordinates": p(x)}),
            Geom::Line(x) => json!({"type": "LineString", "coordinates": l(x)}),
            Geom::Multi(m) => json!({"type": "MultiLineString", "coordinates": m.iter().map(l).collect::<Vec<_>>()}),
        }
    }
}

/// A road event.
#[derive(Clone, Debug)]
pub struct Road {
    /// workzone | closure | incident
    pub kind: &'static str,
    pub desc: String,
    pub road: String,
    pub dir: String,
    /// unix ms
    pub start: Option<i64>,
    pub end: Option<i64>,
    /// 1 minor … 3 major
    pub sev: u8,
    pub source: Arc<str>,
    pub geom: Geom,
    bb: [f32; 4],
}

/// A speed measurement.
#[derive(Clone, Debug)]
pub struct Flow {
    /// km/h
    pub speed: f32,
    /// km/h, when the source publishes a free-flow reference
    pub free: Option<f32>,
    pub road: String,
    pub dir: String,
    pub source: &'static str,
    pub t: Option<i64>,
    pub geom: Geom,
    bb: [f32; 4],
}

enum Data {
    Road(Arc<Vec<Road>>),
    Flow(Arc<Vec<Flow>>),
}

#[derive(Default)]
struct Src {
    data: Option<Data>,
    tried: Option<Instant>,
    ok: Option<Instant>,
    busy: bool,
    err: Option<String>,
    name: String,
}

/// A keyless WZDx feed from the registry.
#[derive(Clone, Debug, PartialEq)]
pub struct Feed {
    pub id: String,
    pub name: String,
    pub url: String,
}

pub struct Traffic {
    srcs: Mutex<HashMap<String, Src>>,
    registry: Mutex<Option<(Instant, Arc<Vec<Feed>>)>>,
    sem: Arc<tokio::sync::Semaphore>,
    reaper: AtomicBool,
}

impl Default for Traffic {
    fn default() -> Self {
        Self { srcs: Mutex::new(HashMap::new()), registry: Mutex::new(None), sem: Arc::new(tokio::sync::Semaphore::new(6)), reaper: AtomicBool::new(false) }
    }
}

// ---------- small helpers ----------

fn r5(v: f64) -> f32 {
    ((v * 1e5).round() / 1e5) as f32
}

fn trunc(s: &str, n: usize) -> String {
    let s = s.trim();
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Coordinates → points, decimated to at most MAX_LINE_PTS.
fn line(c: &Value) -> Vec<[f32; 2]> {
    let pts: Vec<[f32; 2]> = c.as_array().into_iter().flatten().filter_map(|p| Some([r5(p.get(0)?.as_f64()?), r5(p.get(1)?.as_f64()?)])).filter(|p| p[0].abs() <= 180.0 && p[1].abs() <= 90.0).collect();
    if pts.len() <= MAX_LINE_PTS {
        return pts;
    }
    let step = pts.len().div_ceil(MAX_LINE_PTS - 1);
    let mut out: Vec<[f32; 2]> = pts.iter().step_by(step).copied().collect();
    if out.last() != pts.last() {
        out.push(*pts.last().unwrap());
    }
    out
}

fn geom(g: &Value) -> Option<Geom> {
    let c = &g["coordinates"];
    let gm = match g["type"].as_str()? {
        "Point" => Geom::Pt(*line(&json!([c])).first()?),
        "LineString" => Geom::Line(line(c)),
        // WZDx uses MultiPoint for start/end points
        "MultiPoint" => {
            let l = line(c);
            if l.len() == 1 { Geom::Pt(l[0]) } else { Geom::Line(l) }
        }
        "MultiLineString" => Geom::Multi(c.as_array()?.iter().map(line).filter(|l| l.len() >= 2).collect()),
        _ => return None,
    };
    match &gm {
        Geom::Line(l) if l.is_empty() => None,
        Geom::Line(l) if l.len() == 1 => Some(Geom::Pt(l[0])),
        Geom::Multi(m) if m.is_empty() => None,
        _ => Some(gm),
    }
}

fn ms(v: &Value) -> Option<i64> {
    v.as_str().and_then(super::more::parse_time).map(|t| t.timestamp_millis())
}

/// US daylight saving time (second Sunday of March .. first Sunday of November), local date.
fn us_dst(d: NaiveDate) -> bool {
    let nth_sunday = |m: u32, n: u8| NaiveDate::from_weekday_of_month_opt(d.year(), m, Weekday::Sun, n);
    match (nth_sunday(3, 2), nth_sunday(11, 1)) {
        (Some(a), Some(b)) => d >= a && d < b,
        _ => false,
    }
}

/// Local US time (standard offset in hours, e.g. -8 for Pacific) → unix ms.
fn us_local_ms(t: NaiveDateTime, std_offset: i64) -> i64 {
    let off = std_offset + if us_dst(t.date()) { 1 } else { 0 };
    t.and_utc().timestamp_millis() - off * 3_600_000
}

// ---------- WZDx ----------

/// Keyless, active WZDx v4 feeds from the registry.
pub fn parse_registry(v: &Value) -> Vec<Feed> {
    let mut out = vec![];
    for r in v.as_array().into_iter().flatten() {
        let yes = |k: &str| r[k].as_bool().unwrap_or_else(|| r[k].as_str().map(|s| s.eq_ignore_ascii_case("true")).unwrap_or(false));
        let url = r["url"]["url"].as_str().or(r["url"].as_str()).unwrap_or("").trim();
        let version = r["version"].as_str().map(String::from).or(r["version"].as_f64().map(|f| f.to_string())).unwrap_or_default();
        if !yes("active") || yes("needapikey") || !url.starts_with("https://") || !version.trim().starts_with('4') {
            continue;
        }
        // placeholders for keys that the registry forgot to flag
        if ["INSERT", "<key>", "%3ckey", "[Your", "YOUR-", "apiKey=&", "api_key=&"].iter().any(|p| url.contains(p)) || url.ends_with('=') {
            continue;
        }
        let id = r["feedname"].as_str().unwrap_or("").trim().to_lowercase();
        if id.is_empty() || out.iter().any(|f: &Feed| f.id == id) {
            continue;
        }
        let org = r["issuingorganization"].as_str().unwrap_or(&id).trim().to_string();
        out.push(Feed { id, name: format!("{org} (WZDx)"), url: url.to_string() });
    }
    out
}

/// A WZDx (v4.x, tolerant of v3) feed → road events active now or starting within a day.
pub fn parse_wzdx(v: &Value, source: &str, now_ms: i64) -> Vec<Road> {
    let src: Arc<str> = Arc::from(source);
    let mut out = vec![];
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let cd = if p["core_details"].is_object() { &p["core_details"] } else { p };
        let etype = cd["event_type"].as_str().unwrap_or("work-zone");
        if etype == "detour" || p["event_status"].as_str() == Some("completed") {
            continue;
        }
        let (start, end) = (ms(&p["start_date"]), ms(&p["end_date"]));
        if end.map(|e| e < now_ms).unwrap_or(false) || start.map(|s| s > now_ms + 86_400_000).unwrap_or(false) {
            continue;
        }
        let Some(g) = geom(&f["geometry"]) else { continue };
        let impact = p["vehicle_impact"].as_str().unwrap_or("unknown");
        let (kind, sev) = match impact {
            "all-lanes-closed" => ("closure", 3),
            "unknown" | "all-lanes-open" | "" => ("workzone", 1),
            _ => ("workzone", 2),
        };
        let kind = if etype == "incident" && kind != "closure" { "incident" } else { kind };
        let road = match &cd["road_names"] {
            Value::Array(a) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" / "),
            _ => cd["road_name"].as_str().unwrap_or("").to_string(),
        };
        let mut desc = cd["description"].as_str().or(cd["name"].as_str()).unwrap_or("").to_string();
        if desc.is_empty() {
            desc = format!("Work zone ({})", impact.replace('-', " "));
        }
        let bb = g.bbox();
        out.push(Road { kind, desc: trunc(&desc, 300), road: trunc(&road, 80), dir: cd["direction"].as_str().unwrap_or("").to_string(), start, end, sev, source: src.clone(), geom: g, bb });
    }
    out
}

// ---------- CHP ----------

fn tag<'a>(s: &'a str, t: &str) -> &'a str {
    let open = format!("<{t}>");
    let close = format!("</{t}>");
    let Some(a) = s.find(&open).map(|a| a + open.len()) else { return "" };
    let Some(b) = s[a..].find(&close).map(|b| a + b) else { return "" };
    s[a..b].trim().trim_matches('"').trim().trim_end_matches('\\').trim()
}

/// CHP CAD "sa.xml" → incidents (lat/lon are "LAT:LON" in micro-degrees, longitude unsigned west).
pub fn parse_chp(xml: &str) -> Vec<Road> {
    let src: Arc<str> = Arc::from("California Highway Patrol");
    let mut out = vec![];
    for block in xml.split("<Log ID").skip(1) {
        let block = block.split("</Log>").next().unwrap_or(block);
        let ll = tag(block, "LATLON");
        let Some((a, b)) = ll.split_once(':') else { continue };
        let (Ok(a), Ok(b)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) else { continue };
        if a == 0.0 || b == 0.0 {
            continue;
        }
        let (lat, lon) = (a / 1e6, -(b / 1e6));
        if !(32.0..=42.5).contains(&lat) || !(-125.0..=-113.0).contains(&lon) {
            continue;
        }
        let ty = tag(block, "LogType");
        let t = NaiveDateTime::parse_from_str(&tag(block, "LogTime").split_whitespace().collect::<Vec<_>>().join(" "), "%b %d %Y %I:%M%p").ok().map(|t| us_local_ms(t, -8));
        let u = ty.to_ascii_uppercase();
        let sev = if u.contains("FATAL") || u.contains("SIG ALERT") || u.contains("1144") {
            3
        } else if u.contains("COLLISION") || u.contains("FIRE") || u.contains("CLOSURE") || u.contains("1183") || u.contains("1179") {
            2
        } else {
            1
        };
        let kind = if u.contains("CLOSURE") { "closure" } else { "incident" };
        let ld = tag(block, "LocationDesc");
        let area = tag(block, "Area");
        let mut desc = ty.split_once('-').map(|x| x.1).unwrap_or(ty).to_string();
        if !ld.is_empty() {
            desc = format!("{desc} — {ld}");
        }
        if !area.is_empty() {
            desc = format!("{desc} ({area})");
        }
        let g = Geom::Pt([r5(lon), r5(lat)]);
        out.push(Road { kind, desc: trunc(&desc, 300), road: trunc(tag(block, "Location"), 80), dir: String::new(), start: t, end: None, sev, source: src.clone(), bb: g.bbox(), geom: g });
    }
    out
}

// ---------- Maryland CHART ----------

pub fn parse_chart_events(v: &Value) -> Vec<Road> {
    let src: Arc<str> = Arc::from("Maryland CHART");
    let mut out = vec![];
    for e in v["data"].as_array().into_iter().flatten() {
        let (Some(lat), Some(lon)) = (e["lat"].as_f64(), e["lon"].as_f64()) else { continue };
        if lat == 0.0 || lon == 0.0 {
            continue;
        }
        let closed = e["closed"].as_bool().unwrap_or(false);
        let lanes = e["lanesStatus"].as_str().unwrap_or("").to_lowercase();
        let (kind, sev) = if closed { ("closure", 3) } else if lanes.contains("clos") || lanes.contains("block") { ("incident", 2) } else { ("incident", 1) };
        let desc = e["description"].as_str().or(e["name"].as_str()).unwrap_or("");
        let road = desc.split_once(" @ ").map(|x| x.1).unwrap_or("");
        let dir = e["direction"].as_str().filter(|d| *d != "None" && *d != "N/A").unwrap_or("");
        let g = Geom::Pt([r5(lon), r5(lat)]);
        out.push(Road {
            kind,
            desc: trunc(&format!("{}{}", desc, if lanes.is_empty() { String::new() } else { format!(" — {lanes}") }), 300),
            road: trunc(road, 80),
            dir: dir.to_lowercase(),
            start: e["startDateTime"].as_i64(),
            end: None,
            sev,
            source: src.clone(),
            bb: g.bbox(),
            geom: g,
        });
    }
    out
}

pub fn parse_chart_tss(v: &Value) -> Vec<Flow> {
    let mut out = vec![];
    for s in v["data"].as_array().into_iter().flatten() {
        if s["opStatus"].as_str() != Some("OK") {
            continue;
        }
        let (Some(lat), Some(lon)) = (s["lat"].as_f64(), s["lon"].as_f64()) else { continue };
        for z in s["zones"].as_array().into_iter().flatten() {
            let Some(mph) = z["speed"].as_f64().filter(|v| *v > 0.0 && *v <= 100.0) else { continue };
            let g = Geom::Pt([r5(lon), r5(lat)]);
            out.push(Flow {
                speed: (mph * 1.609344) as f32,
                free: None,
                road: s["description"].as_str().unwrap_or("").to_string(),
                dir: z["direction"].as_str().unwrap_or("").to_lowercase(),
                source: "Maryland CHART",
                t: s["lastUpdateTime"].as_i64(),
                bb: g.bbox(),
                geom: g,
            });
        }
    }
    out
}

// ---------- Digitraffic (Finland) ----------

/// TMS station GeoJSON + data → one flow point per direction.
pub fn parse_digitraffic(stations: &Value, data: &Value) -> Vec<Flow> {
    let mut loc: HashMap<i64, ([f32; 2], String)> = HashMap::new();
    for f in stations["features"].as_array().into_iter().flatten() {
        let id = f["id"].as_i64().or(f["properties"]["id"].as_i64());
        let c = &f["geometry"]["coordinates"];
        if let (Some(id), Some(x), Some(y)) = (id, c[0].as_f64(), c[1].as_f64()) {
            loc.insert(id, ([r5(x), r5(y)], f["properties"]["name"].as_str().unwrap_or("").to_string()));
        }
    }
    let mut out = vec![];
    for s in data["stations"].as_array().into_iter().flatten() {
        let Some((p, name)) = s["id"].as_i64().and_then(|id| loc.get(&id)) else { continue };
        let vals: HashMap<&str, (f64, Option<i64>)> = s["sensorValues"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| Some((v["name"].as_str()?, (v["value"].as_f64()?, ms(&v["measuredTime"])))))
            .collect();
        for d in [1, 2] {
            let Some(&(speed, t)) = vals.get(format!("KESKINOPEUS_5MIN_LIUKUVA_SUUNTA{d}").as_str()) else { continue };
            if speed <= 0.0 {
                continue;
            }
            let pct = vals.get(format!("KESKINOPEUS_5MIN_LIUKUVA_SUUNTA{d}_VVAPAAS{d}").as_str()).map(|v| v.0).filter(|p| *p > 0.0);
            let road = name.split('_').next().unwrap_or("").to_string();
            let g = Geom::Pt(*p);
            out.push(Flow {
                speed: speed as f32,
                free: pct.map(|pc| (speed / (pc / 100.0)) as f32),
                road: if road.is_empty() { name.clone() } else { format!("{road} ({})", name.replace('_', " ")) },
                dir: d.to_string(),
                source: "Fintraffic Digitraffic",
                t: t.or(ms(&s["dataUpdatedTime"])),
                bb: g.bbox(),
                geom: g,
            });
        }
    }
    out
}

// ---------- NYC DOT ----------

pub fn parse_nyc(v: &Value, now_ms: i64) -> Vec<Flow> {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for r in v.as_array().into_iter().flatten() {
        let id = r["link_id"].as_str().or(r["id"].as_str()).unwrap_or("");
        if !seen.insert(id.to_string()) {
            continue;
        }
        if r["status"].as_str().map(|s| s != "0").unwrap_or(false) {
            continue;
        }
        let Some(mph) = r["speed"].as_str().and_then(num).or(r["speed"].as_f64()).filter(|v| *v > 0.0 && *v < 100.0) else { continue };
        let t = r["data_as_of"].as_str().and_then(|s| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()).map(|t| us_local_ms(t, -5));
        if t.map(|t| now_ms - t > 12 * 3_600_000).unwrap_or(true) {
            continue;
        }
        let pts: Vec<[f32; 2]> = r["link_points"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .filter_map(|p| {
                let (a, b) = p.split_once(',')?;
                let (lat, lon) = (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?);
                ((40.0..42.0).contains(&lat) && (-75.0..-72.0).contains(&lon)).then(|| [r5(lon), r5(lat)])
            })
            .collect();
        let Some(g) = geom(&json!({"type": "LineString", "coordinates": pts})) else { continue };
        out.push(Flow {
            speed: (mph * 1.609344) as f32,
            free: None,
            road: r["link_name"].as_str().unwrap_or("").to_string(),
            dir: String::new(),
            source: "NYC DOT",
            t,
            bb: g.bbox(),
            geom: g,
        });
    }
    out
}

// ---------- fetching ----------

const ROAD_STATIC: &[(&str, &str, u64)] = &[("chp", "California Highway Patrol", 300), ("chart", "Maryland CHART", 300)];
const FLOW_SRCS: &[(&str, &str, u64)] = &[("digitraffic", "Fintraffic Digitraffic (Finland)", 300), ("chart-tss", "Maryland CHART speeds", 300), ("nyc", "NYC DOT speeds", 300)];
const WZDX_TTL: u64 = 900;

async fn registry(o: &Arc<Overlays>) -> Arc<Vec<Feed>> {
    if let Some((t, f)) = o.traffic.registry.lock().clone() {
        if t.elapsed() < Duration::from_secs(6 * 3600) {
            return f;
        }
    }
    let feeds = match o.disk_cached("wzdx-registry.json", Duration::from_secs(86400), REGISTRY).await {
        Ok(b) => parse_registry(&serde_json::from_slice(&b).unwrap_or_default()),
        Err(e) => {
            o.health.err("ovl-roadwork-registry", "WZDx feed registry", &e);
            vec![]
        }
    };
    let f = Arc::new(feeds);
    o.traffic.registry.lock().replace((Instant::now(), f.clone()));
    f
}

async fn digitraffic_get(o: &Overlays, url: &str) -> Result<Value> {
    let r = o.http.get(url).header("Digitraffic-User", "TheBigWeather/self-hosted").timeout(Duration::from_secs(45)).send().await?;
    if !r.status().is_success() {
        bail!("HTTP {} from tie.digitraffic.fi", r.status());
    }
    Ok(r.json().await?)
}

async fn fetch(o: &Arc<Overlays>, id: &str, url: &str) -> Result<Data> {
    let now = chrono::Utc::now().timestamp_millis();
    Ok(match id {
        "chp" => Data::Road(Arc::new(parse_chp(&o.get_text(url).await?))),
        "chart" => Data::Road(Arc::new(parse_chart_events(&o.get_json(url).await?))),
        "chart-tss" => Data::Flow(Arc::new(parse_chart_tss(&o.get_json(url).await?))),
        "nyc" => Data::Flow(Arc::new(parse_nyc(&o.get_json(url).await?, now))),
        "digitraffic" => {
            let st_path = o.data_dir.join("digitraffic-tms-stations.json");
            let fresh = std::fs::metadata(&st_path).and_then(|m| m.modified()).ok().map(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(86400)).unwrap_or(false);
            let stations = match fresh.then(|| std::fs::read(&st_path).ok()).flatten() {
                Some(b) => serde_json::from_slice(&b)?,
                None => {
                    let v = digitraffic_get(o, DT_STATIONS).await?;
                    tokio::fs::write(&st_path, serde_json::to_vec(&v)?).await.ok();
                    v
                }
            };
            Data::Flow(Arc::new(parse_digitraffic(&stations, &digitraffic_get(o, DT_DATA).await?)))
        }
        _ => {
            let name = id.strip_prefix("wzdx:").unwrap_or(id);
            Data::Road(Arc::new(parse_wzdx(&o.get_json(url).await?, name, now)))
        }
    })
}

/// Refresh stale sources (in the background); waits a little on the very first request.
async fn ensure(o: &Arc<Overlays>, flow: bool) {
    let mut want: Vec<(String, String, String, u64)> = vec![];
    if flow {
        for (id, name, ttl) in FLOW_SRCS {
            let url = match *id {
                "digitraffic" => DT_DATA,
                "chart-tss" => CHART_TSS,
                _ => NYC,
            };
            want.push((id.to_string(), name.to_string(), url.to_string(), *ttl));
        }
    } else {
        for (id, name, ttl) in ROAD_STATIC {
            want.push((id.to_string(), name.to_string(), if *id == "chp" { CHP } else { CHART_EVENTS }.to_string(), *ttl));
        }
        for f in registry(o).await.iter() {
            want.push((format!("wzdx:{}", f.id), f.name.clone(), f.url.clone(), WZDX_TTL));
        }
    }
    let mut handles = vec![];
    let mut first = true;
    {
        let mut m = o.traffic.srcs.lock();
        for (id, name, url, ttl) in want {
            let s = m.entry(id.clone()).or_default();
            s.name = name;
            if s.data.is_some() {
                first = false;
            }
            let stale = s.ok.map(|t| t.elapsed().as_secs() >= ttl).unwrap_or(true);
            // after a failure wait 2 minutes before retrying
            let backoff = s.err.is_some() && s.tried.map(|t| t.elapsed().as_secs() < 120).unwrap_or(false);
            if !stale || s.busy || backoff {
                continue;
            }
            s.busy = true;
            s.tried = Some(Instant::now());
            let o2 = o.clone();
            let sem = o.traffic.sem.clone();
            handles.push(tokio::spawn(async move {
                let _p = sem.acquire().await;
                let r = fetch(&o2, &id, &url).await;
                let mut m = o2.traffic.srcs.lock();
                let s = m.entry(id.clone()).or_default();
                s.busy = false;
                match r {
                    Ok(d) => {
                        s.data = Some(d);
                        s.ok = Some(Instant::now());
                        s.err = None;
                    }
                    Err(e) => {
                        tracing::debug!("traffic {id}: {e:#}");
                        s.err = Some(format!("{e:#}"));
                    }
                }
            }));
        }
    }
    if first && !handles.is_empty() {
        let _ = tokio::time::timeout(Duration::from_secs(25), futures::future::join_all(handles)).await;
    }
    start_reaper(o);
}

/// Free everything after 30 idle minutes.
fn start_reaper(o: &Arc<Overlays>) {
    if o.traffic.reaper.swap(true, Ordering::SeqCst) {
        return;
    }
    let o = o.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            if o.idle("roadwork", 1800) && o.idle("trafficflow", 1800) {
                o.traffic.srcs.lock().clear();
                o.traffic.reaper.store(false, Ordering::SeqCst);
                break;
            }
        }
    });
}

fn parse_bbox(s: &str) -> Option<[f32; 4]> {
    let b: Vec<f32> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    (b.len() == 4 && b[0] < b[2] && b[1] < b[3]).then(|| [b[0], b[1], b[2], b[3]])
}

fn hits(a: &[f32; 4], b: &Option<[f32; 4]>) -> bool {
    b.map(|b| a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]).unwrap_or(true)
}

/// Source status list (shared by both overlays) and health update.
fn status(o: &Overlays, flow: bool) -> Vec<Value> {
    let m = o.traffic.srcs.lock();
    let mut out = vec![];
    let (mut ok, mut bad, mut n) = (0, 0, 0usize);
    for (id, s) in m.iter() {
        let is_flow = matches!(s.data, Some(Data::Flow(_))) || FLOW_SRCS.iter().any(|f| f.0 == id);
        if is_flow != flow {
            continue;
        }
        let count = match &s.data {
            Some(Data::Road(v)) => v.len(),
            Some(Data::Flow(v)) => v.len(),
            None => 0,
        };
        n += count;
        if s.err.is_some() { bad += 1 } else if s.ok.is_some() { ok += 1 }
        out.push(json!({"id": id, "name": s.name, "count": count, "age": s.ok.map(|t| t.elapsed().as_secs()), "error": s.err}));
    }
    let (hid, label) = if flow { ("ovl-trafficflow", "Traffic speeds (keyless)") } else { ("ovl-roadwork", "Road work & incidents (keyless)") };
    if ok > 0 {
        o.health.ok(hid, label, format!("{ok} sources ok, {bad} failing, {n} items"));
    } else if bad > 0 {
        o.health.err(hid, label, format!("all {bad} sources failing"));
    }
    out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    out
}

/// `roadwork` overlay: `?bbox=w,s,e,n&kinds=workzone,closure,incident`
pub async fn roadwork(o: &Arc<Overlays>, bbox: &str, kinds: &str) -> Result<Value> {
    o.touch("roadwork");
    ensure(o, false).await;
    let bb = parse_bbox(bbox);
    let kinds: Vec<&str> = kinds.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let sets: Vec<Arc<Vec<Road>>> = o.traffic.srcs.lock().values().filter_map(|s| match &s.data {
        Some(Data::Road(v)) => Some(v.clone()),
        _ => None,
    }).collect();
    let mut sel: Vec<&Road> = sets.iter().flat_map(|v| v.iter()).filter(|r| hits(&r.bb, &bb) && (kinds.is_empty() || kinds.contains(&r.kind))).collect();
    let total = sel.len();
    sel.sort_by(|a, b| b.sev.cmp(&a.sev));
    sel.truncate(MAX_FEATURES);
    let feats: Vec<Value> = sel.iter().map(|r| json!({"type": "Feature", "geometry": r.geom.json(), "properties": {
        "kind": r.kind, "desc": r.desc, "road": r.road, "dir": r.dir, "start": r.start, "end": r.end, "severity": r.sev, "source": &*r.source,
    }})).collect();
    Ok(json!({"type": "FeatureCollection", "features": feats, "total": total, "truncated": total > MAX_FEATURES, "sources": status(o, false)}))
}

/// `trafficflow` overlay: `?bbox=w,s,e,n`
pub async fn trafficflow(o: &Arc<Overlays>, bbox: &str) -> Result<Value> {
    o.touch("trafficflow");
    ensure(o, true).await;
    let bb = parse_bbox(bbox);
    let sets: Vec<Arc<Vec<Flow>>> = o.traffic.srcs.lock().values().filter_map(|s| match &s.data {
        Some(Data::Flow(v)) => Some(v.clone()),
        _ => None,
    }).collect();
    let sel: Vec<&Flow> = sets.iter().flat_map(|v| v.iter()).filter(|f| hits(&f.bb, &bb)).collect();
    let total = sel.len();
    let feats: Vec<Value> = sel.iter().take(MAX_FEATURES).map(|f| {
        let ratio = f.free.filter(|v| *v > 0.0).map(|ff| ((f.speed / ff).min(1.5) * 100.0).round() / 100.0);
        json!({"type": "Feature", "geometry": f.geom.json(), "properties": {
            "speed": f.speed.round(), "free_flow": f.free.map(|v| v.round()), "ratio": ratio.map(|r| ((r as f64) * 100.0).round() / 100.0),
            "road": f.road, "dir": f.dir, "source": f.source, "t": f.t,
        }})
    }).collect();
    Ok(json!({"type": "FeatureCollection", "features": feats, "total": total, "truncated": total > MAX_FEATURES, "sources": status(o, true)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry() {
        let v: Value = serde_json::from_str(r#"[
          {"state":"utah","issuingorganization":"Utah DOT","feedname":"udot","url":{"url":"https://udottraffic.utah.gov/wzdx/udot/v40/data"},"format":"geojson","active":true,"version":"4","needapikey":false},
          {"state":"colorado","issuingorganization":"Colorado DOT","feedname":"cdot","url":{"url":"https://data.cotrip.org/api/v1/wzdx?apiKey="},"active":true,"version":"4.2","needapikey":true},
          {"state":"x","issuingorganization":"PBS","feedname":"pbs","url":{"url":"https://feeds.purposebuilt.systems/cwz"},"active":true,"version":"CWZ 1.0","needapikey":false},
          {"state":"michigan","issuingorganization":"Michigan DOT","feedname":"michigandot","active":false,"needapikey":false},
          {"state":"ny","issuingorganization":"New York DOT","feedname":"nysdot","url":{"url":"https://511ny.org/api/wzdx"},"active":"true","version":"4.1","needapikey":"false"}]"#).unwrap();
        let f = parse_registry(&v);
        assert_eq!(f.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["udot", "nysdot"]);
        assert_eq!(f[0].name, "Utah DOT (WZDx)");
    }

    #[test]
    fn wzdx() {
        let now = super::super::more::parse_time("2026-10-12T00:00:00Z").unwrap().timestamp_millis();
        let v: Value = serde_json::from_str(r#"{"road_event_feed_info":{},"type":"FeatureCollection","features":[
          {"id":"a","type":"Feature","geometry":{"type":"LineString","coordinates":[[-111.8,40.7],[-111.79,40.71]]},
           "properties":{"core_details":{"event_type":"work-zone","data_source_id":"x","road_names":["I-80"],"direction":"eastbound","description":"Lane shifts"},
           "start_date":"2026-10-01T07:00:00Z","end_date":"2026-12-31T07:00:00Z","vehicle_impact":"some-lanes-closed","event_status":"active"}},
          {"id":"b","type":"Feature","geometry":{"type":"MultiPoint","coordinates":[[-93.1,45.0]]},
           "properties":{"core_details":{"event_type":"work-zone","road_names":["MN 9"],"direction":"northbound","description":"Closed"},
           "start_date":"2026-10-11T12:00:00Z","end_date":"2026-10-13T23:00:00Z","vehicle_impact":"all-lanes-closed"}},
          {"id":"c","type":"Feature","geometry":{"type":"LineString","coordinates":[[-93.1,45.0],[-93.2,45.1]]},
           "properties":{"core_details":{"event_type":"detour","road_names":["MN 9"]}}},
          {"id":"d","type":"Feature","geometry":{"type":"LineString","coordinates":[[-122.6,47.0],[-122.5,47.1]]},
           "properties":{"core_details":{"event_type":"work-zone","road_names":["005"],"direction":"southbound","description":"old"},
           "start_date":"2026-08-21T00:00:00+00:00","end_date":"2026-08-22T00:00:00+00:00","vehicle_impact":"unknown"}},
          {"id":"e","type":"Feature","geometry":{"type":"LineString","coordinates":[[-122.6,47.0],[-122.5,47.1]]},
           "properties":{"core_details":{"event_type":"work-zone","road_names":["005"]},"start_date":"2026-11-21T00:00:00Z","vehicle_impact":"unknown"}}]}"#).unwrap();
        let r = parse_wzdx(&v, "udot", now);
        assert_eq!(r.len(), 2, "detour, ended and far-future events dropped");
        assert_eq!((r[0].kind, r[0].sev, r[0].road.as_str(), r[0].dir.as_str()), ("workzone", 2, "I-80", "eastbound"));
        assert_eq!(r[0].bb, [-111.8, 40.7, -111.79, 40.71]);
        assert_eq!((r[1].kind, r[1].sev), ("closure", 3));
        assert_eq!(r[1].geom, Geom::Pt([-93.1, 45.0]));
    }

    #[test]
    fn decimate() {
        let c: Vec<[f64; 2]> = (0..1000).map(|i| [i as f64 * 0.001, 0.0]).collect();
        let l = line(&json!(c));
        assert!(l.len() <= MAX_LINE_PTS);
        assert_eq!(l.last().unwrap()[0], 0.999);
    }

    #[test]
    fn chp() {
        let xml = r#"<State><Center ID = "SAHB"><Dispatch ID = "UKCC"><Log ID = "261010UK0112">
            <LogTime>"Oct 10 2026  3:25PM"</LogTime><LogType>"1179-Trfc Collision-1141 Enrt"</LogType>
            <Location>"5829-5898 Sr20"</Location><LocationDesc>""</LocationDesc><Area>"Clear Lake"</Area>
            <ThomasBrothers>""</ThomasBrothers><LATLON>"39097865:122802891"</LATLON>
            <LogDetails><details><DetailTime>"Oct 10 2026  3:25PM"</DetailTime><IncidentDetail>"[1] VEH WAS RAN OFF THE RDWY\"</IncidentDetail></details></LogDetails></Log>
            <Log ID = "x"><LogType>"Hazard"</LogType><LATLON>"0:0"</LATLON></Log></Dispatch></Center>"#;
        let r = parse_chp(xml);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].geom, Geom::Pt([-122.80289, 39.09787]));
        assert_eq!((r[0].kind, r[0].sev, r[0].road.as_str()), ("incident", 2, "5829-5898 Sr20"));
        assert_eq!(r[0].desc, "Trfc Collision-1141 Enrt (Clear Lake)");
        // 3:25 PM PDT = 22:25 UTC
        assert_eq!(r[0].start, Some(super::super::more::parse_time("2026-10-10T22:25:00Z").unwrap().timestamp_millis()));
    }

    #[test]
    fn dst() {
        assert!(us_dst(NaiveDate::from_ymd_opt(2026, 10, 10).unwrap()));
        assert!(!us_dst(NaiveDate::from_ymd_opt(2026, 12, 1).unwrap()));
        assert!(!us_dst(NaiveDate::from_ymd_opt(2026, 3, 7).unwrap()));
        assert!(us_dst(NaiveDate::from_ymd_opt(2026, 3, 8).unwrap()));
        assert!(!us_dst(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap()));
    }

    #[test]
    fn chart() {
        let v: Value = serde_json::from_str(r#"{"data":[{"closed":false,"county":"Anne Arundel","description":"Weather Service Event @ MD 177 AT GEORGE WILLING AVE","direction":"None","lanesStatus":"","lat":39.129375,"lon":-76.55166,"startDateTime":1791733446000,"incidentType":"Other"},
            {"closed":true,"description":"Collision @ I-95","direction":"North","lanesStatus":"All lanes closed","lat":39.3,"lon":-76.6}],"success":true}"#).unwrap();
        let r = parse_chart_events(&v);
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].kind, r[0].sev, r[0].road.as_str(), r[0].dir.as_str()), ("incident", 1, "MD 177 AT GEORGE WILLING AVE", ""));
        assert_eq!(r[0].start, Some(1791733446000));
        assert_eq!((r[1].kind, r[1].sev), ("closure", 3));
        let t: Value = serde_json::from_str(r#"{"data":[{"description":"I-95 PRIOR TO I-295","lat":38.79,"lon":-77.02,"opStatus":"OK","lastUpdateTime":1791659860000,
            "zones":[{"bearing":41,"direction":"NORTH","speed":55},{"direction":"SOUTH","speed":-1},{"direction":"SOUTH","speed":65535}]},
            {"description":"x","lat":38.0,"lon":-77.0,"opStatus":"COMM_FAILURE","zones":[{"direction":"NORTH","speed":40}]}]}"#).unwrap();
        let f = parse_chart_tss(&t);
        assert_eq!(f.len(), 1);
        assert!((f[0].speed - 88.51).abs() < 0.1);
        assert_eq!(f[0].dir, "north");
    }

    #[test]
    fn digitraffic() {
        let st: Value = serde_json::from_str(r#"{"type":"FeatureCollection","features":[{"type":"Feature","id":23001,"geometry":{"type":"Point","coordinates":[24.94,60.17,0.0]},"properties":{"id":23001,"tmsNumber":1,"name":"vt1_Espoo_Vanttila"}}]}"#).unwrap();
        let d: Value = serde_json::from_str(r#"{"dataUpdatedTime":"2026-10-12T05:00:00Z","stations":[{"id":23001,"tmsNumber":1,"sensorValues":[
            {"id":5122,"stationId":23001,"name":"KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1","shortName":"km/h1","measuredTime":"2026-10-12T04:59:00Z","unit":"km/h","value":80},
            {"id":5158,"stationId":23001,"name":"KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1_VVAPAAS1","unit":"***","value":80.0},
            {"id":5125,"stationId":23001,"name":"KESKINOPEUS_5MIN_LIUKUVA_SUUNTA2","unit":"km/h","value":0}]}]}"#).unwrap();
        let f = parse_digitraffic(&st, &d);
        assert_eq!(f.len(), 1);
        assert_eq!((f[0].speed, f[0].free, f[0].dir.as_str()), (80.0, Some(100.0), "1"));
        assert_eq!(f[0].road, "vt1 (vt1 Espoo Vanttila)");
        assert_eq!(f[0].geom, Geom::Pt([24.94, 60.17]));
    }

    #[test]
    fn nyc() {
        let now = super::super::more::parse_time("2026-10-11T23:00:00Z").unwrap().timestamp_millis();
        let v: Value = serde_json::from_str(r#"[
          {"id":"211","speed":"33.55","travel_time":"489","status":"0","data_as_of":"2026-10-11T17:51:06.000","link_id":"4362250","link_points":"40.78795,-73.790191 40.78647,-73.78812 40.7862104,-73.787781 40.78","borough":"Queens","link_name":"CVE NB GCP - WILLETS PT BLVD"},
          {"id":"211","speed":"20","status":"0","data_as_of":"2026-10-11T17:46:06.000","link_id":"4362250","link_points":"40.78795,-73.790191 40.78647,-73.78812"},
          {"id":"311","speed":"0","status":"-101","data_as_of":"2026-10-11T17:51:06.000","link_id":"4362342","link_points":"40.72966,-73.87775 40.730165,-73.87643"}]"#).unwrap();
        let f = parse_nyc(&v, now);
        assert_eq!(f.len(), 1);
        assert!((f[0].speed - 54.0).abs() < 0.1);
        assert_eq!(f[0].geom, Geom::Line(vec![[-73.79019, 40.78795], [-73.78812, 40.78647], [-73.78778, 40.78621]]));
        // 17:51 EDT = 21:51 UTC
        assert_eq!(f[0].t, Some(super::super::more::parse_time("2026-10-11T21:51:06Z").unwrap().timestamp_millis()));
    }

    #[test]
    fn bbox() {
        assert_eq!(parse_bbox("-100,30,-90,40"), Some([-100.0, 30.0, -90.0, 40.0]));
        assert_eq!(parse_bbox("1,2,3"), None);
        assert!(hits(&[-95.0, 35.0, -94.0, 36.0], &parse_bbox("-100,30,-90,40")));
        assert!(!hits(&[-85.0, 35.0, -84.0, 36.0], &parse_bbox("-100,30,-90,40")));
    }
}
