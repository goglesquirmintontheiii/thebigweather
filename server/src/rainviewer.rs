//! 0.8.3: RainViewer (rainviewer.com) radar for places without an open national feed in Stormiq
//! (Australia, New Zealand, Japan, Korea, Russia, …).
//!
//! * Single-site radar images: `https://data.rainviewer.com/images/<radar id>/` holds the radar's
//!   last six source images (`…0_source.png|gif|jpg`, no older than 48 h; `.nc` / `.h5` volumes are
//!   skipped), sometimes with JSON describing the scans. The directory index lists the radar ids.
//! * Global composite: `https://api.rainviewer.com/public/weather-maps.json` (frames of the past
//!   2 h + nowcast; tiles `{host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png`, zoom ≤ 7)
//!   and, when published, satellite infrared frames.
//!
//! Radar positions come from RainViewer's weather-radar-database (MIT, `rainviewer_sites.tsv`);
//! radars the index lists but the database doesn't know are probed slowly (one directory every few
//! seconds) for JSON with a position. Everything is cached: the index for 10 min, a radar's frame
//! list for 3 min (`IntlRadar` list cache), images 10 min (`IntlRadar` image proxy). Free for
//! personal / non-commercial use; attribution required.

use anyhow::{anyhow, bail, Result};
use chrono::{NaiveDateTime, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const DATA_BASE: &str = "https://data.rainviewer.com/images/";
pub const MAPS_JSON: &str = "https://api.rainviewer.com/public/weather-maps.json";
pub const TILE_HOST: &str = "https://tilecache.rainviewer.com";
/// hosts the image proxy may fetch from for RainViewer
pub const HOSTS: &[&str] = &["data.rainviewer.com", "tilecache.rainviewer.com"];
pub const ATTRIBUTION: &str = "RainViewer";
pub const LICENSE: &str = "rainviewer.com · personal / non-commercial use";
/// prefix of single-radar source ids (`rv_AU02`)
pub const PREFIX: &str = "rv_";

const SEED: &str = include_str!("rainviewer_sites.tsv");
const INDEX_TTL: Duration = Duration::from_secs(600);
const INDEX_RETRY: Duration = Duration::from_secs(120);
const PROBE_GAP: Duration = Duration::from_secs(3);
const PROBE_TTL: Duration = Duration::from_secs(24 * 3600);
const DEFAULT_RANGE_KM: f64 = 250.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Radar {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub state: String,
    /// ISO 3166 alpha-2 when known, else the country name
    pub country: String,
    pub country_name: String,
    pub lat: f64,
    pub lon: f64,
    pub range_km: f64,
    /// image extent from RainViewer's JSON ([w, s, e, n]); otherwise a box of `range_km`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<[f64; 4]>,
}

/// Countries of the radar database → ISO codes.
pub fn country_code(name: &str) -> String {
    let c = match name.trim() {
        "United States" => "US",
        "Australia" => "AU",
        "Canada" => "CA",
        "Russia" => "RU",
        "France" => "FR",
        "Italy" => "IT",
        "Germany" => "DE",
        "United Kingdom" => "GB",
        "Serbia" => "RS",
        "Spain" => "ES",
        "Sweden" => "SE",
        "New Zealand" => "NZ",
        "Norway" => "NO",
        "Finland" => "FI",
        "Greece" => "GR",
        "Poland" => "PL",
        "Romania" => "RO",
        "Austria" => "AT",
        "Denmark" => "DK",
        "Belgium" => "BE",
        "Hungary" => "HU",
        "Switzerland" => "CH",
        "Belarus" => "BY",
        "Bulgaria" => "BG",
        "Croatia" => "HR",
        "Czech Republic" => "CZ",
        "Estonia" => "EE",
        "Ireland" => "IE",
        "Netherlands" => "NL",
        "Portugal" => "PT",
        "Slovak Republic" | "Slovakia" => "SK",
        "Ukraine" => "UA",
        "Iceland" => "IS",
        "Latvia" => "LV",
        "Slovenia" => "SI",
        "Japan" => "JP",
        "South Korea" | "Korea" | "Republic of Korea" => "KR",
        "Taiwan" => "TW",
        "Brazil" => "BR",
        "Mexico" => "MX",
        "South Africa" => "ZA",
        "India" => "IN",
        "China" => "CN",
        "Philippines" => "PH",
        "Malaysia" => "MY",
        "Thailand" => "TH",
        "Indonesia" => "ID",
        "Vietnam" => "VN",
        "Argentina" => "AR",
        "Chile" => "CL",
        "Israel" => "IL",
        "Turkey" => "TR",
        other => return other.to_string(),
    };
    c.to_string()
}

/// The bundled radar database (operating radars outside the US: NEXRAD / TDWR are native).
pub fn seed() -> Vec<Radar> {
    SEED.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() < 8 || f[7].trim() != "1" || f[3] == "United States" {
                return None;
            }
            let (lat, lon) = (f[4].parse::<f64>().ok()?, f[5].parse::<f64>().ok()?);
            Some(Radar {
                id: f[0].to_string(),
                name: f[1].to_string(),
                state: f[2].to_string(),
                country: country_code(f[3]),
                country_name: f[3].to_string(),
                lat,
                lon,
                range_km: f[6].parse::<f64>().ok().filter(|r| *r > 10.0 && *r < 1000.0).unwrap_or(DEFAULT_RANGE_KM),
                bounds: None,
            })
        })
        .collect()
}

/// A radar id as used in URLs (letters, digits, `_` `-` `.`; 2–32 chars).
pub fn valid_id(id: &str) -> bool {
    (2..=32).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c)) && !id.starts_with('.')
}

// ---------- directory index ----------

/// Entry of a directory index: name (directories end with `/`) and modification time (ms).
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub mtime: Option<i64>,
}

/// Parse a directory index: an HTML page (nginx / Apache autoindex, S3-style links) or a JSON
/// listing (nginx `autoindex_format json`: `[{"name", "type", "mtime"}]`, or a plain array of names).
pub fn index_entries(body: &str) -> Vec<Entry> {
    let t = body.trim_start();
    if t.starts_with('[') || t.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(t) {
            let arr = v.as_array().cloned().or_else(|| ["files", "items", "entries", "list"].iter().find_map(|k| v.get(*k)?.as_array().cloned())).unwrap_or_default();
            return arr
                .iter()
                .filter_map(|e| {
                    if let Some(s) = e.as_str() {
                        return Some(Entry { name: s.to_string(), mtime: None });
                    }
                    let name = e.get("name").or_else(|| e.get("key")).and_then(|x| x.as_str())?;
                    let dir = e.get("type").and_then(|x| x.as_str()) == Some("directory");
                    let mtime = e.get("mtime").or_else(|| e.get("modified")).and_then(|x| x.as_str()).and_then(parse_http_date);
                    Some(Entry { name: if dir && !name.ends_with('/') { format!("{name}/") } else { name.to_string() }, mtime })
                })
                .filter(|e| clean_name(&e.name))
                .collect();
        }
    }
    let mut out = vec![];
    for part in body.split("href=\"").skip(1) {
        let Some(href) = part.split('"').next() else { continue };
        let href = href.trim_start_matches("./");
        // relative entries only (no parent, sorting links or absolute URLs)
        if href.is_empty() || href.starts_with('?') || href.starts_with('/') || href.starts_with("..") || href.contains("://") || href.contains('?') {
            continue;
        }
        let name = percent_decode(href);
        if !clean_name(&name) {
            continue;
        }
        // nginx: `<a href="x">x</a>    08-Nov-2026 04:50    1234`
        let after = part.split("</a>").nth(1).unwrap_or("");
        let mtime = after.split(['\n', '<']).next().and_then(|s| {
            let s = s.trim();
            let stamp: String = s.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
            NaiveDateTime::parse_from_str(&stamp, "%d-%b-%Y %H:%M").or_else(|_| NaiveDateTime::parse_from_str(&stamp, "%Y-%m-%d %H:%M")).ok().map(|d| d.and_utc().timestamp_millis())
        });
        if !out.iter().any(|e: &Entry| e.name == name) {
            out.push(Entry { name, mtime });
        }
    }
    out
}

fn clean_name(n: &str) -> bool {
    let base = n.trim_end_matches('/');
    !base.is_empty() && !base.contains('/') && base != "." && base != ".." && base.chars().all(|c| c.is_ascii_alphanumeric() || "_-.+".contains(c))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_http_date(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(s).or_else(|_| chrono::DateTime::parse_from_rfc3339(s)).ok().map(|d| d.timestamp_millis())
}

/// Radar ids in the root index (its sub-directories).
pub fn radar_ids(entries: &[Entry]) -> Vec<String> {
    let mut v: Vec<String> = entries.iter().filter(|e| e.name.ends_with('/')).map(|e| e.name.trim_end_matches('/').to_string()).filter(|n| valid_id(n)).collect();
    v.sort();
    v.dedup();
    v
}

/// Time (ms) in a file name: unix seconds / ms, or a `YYYYMMDDHHMM[SS]` stamp (optionally with
/// `T` / `_` / `-` between date and time).
pub fn name_time(name: &str) -> Option<i64> {
    let now = Utc::now().timestamp_millis();
    let plausible = |t: i64| t > 946_684_800_000 && t < now + 86_400_000;
    // runs of digits joined by a single T/_/- (20261108_0450 or 20261108T045000)
    let runs: Vec<&str> = name.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).collect();
    let mut cands: Vec<String> = runs.iter().map(|s| s.to_string()).collect();
    for w in runs.windows(2) {
        if w[0].len() == 8 && (4..=6).contains(&w[1].len()) {
            cands.insert(0, format!("{}{}", w[0], w[1]));
        }
    }
    for c in &cands {
        let t = match c.len() {
            10 => c.parse::<i64>().ok().map(|s| s * 1000),
            13 => c.parse::<i64>().ok(),
            12 => NaiveDateTime::parse_from_str(c, "%Y%m%d%H%M").ok().map(|d| d.and_utc().timestamp_millis()),
            14 => NaiveDateTime::parse_from_str(c, "%Y%m%d%H%M%S").ok().map(|d| d.and_utc().timestamp_millis()),
            _ => None,
        };
        if let Some(t) = t.filter(|t| plausible(*t)) {
            return Some(t);
        }
    }
    None
}

/// A drawable source image (the `.nc` / `.h5` volumes are not images).
pub fn is_image(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    [".png", ".gif", ".jpg", ".jpeg", ".webp"].iter().any(|e| l.ends_with(e))
}

// ---------- JSON metadata (format not documented: read defensively) ----------

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Meta {
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub name: Option<String>,
    pub range_km: Option<f64>,
    pub bounds: Option<[f64; 4]>,
    /// (time ms, file name or URL)
    pub scans: Vec<(i64, String)>,
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.trim().parse().ok()).filter(|x: &f64| x.is_finite())
}

fn get_ci<'a>(m: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    m.iter().find(|(k, _)| keys.iter().any(|x| k.eq_ignore_ascii_case(x))).map(|(_, v)| v)
}

/// [w, s, e, n] from `[w, s, e, n]`, `[[s, w], [n, e]]` (Leaflet), `{west, south, east, north}`
/// or `{minlon, minlat, maxlon, maxlat}`; rejected unless it is a sane lon/lat box.
pub fn parse_bounds(v: &Value) -> Option<[f64; 4]> {
    let b = if let Some(a) = v.as_array() {
        if a.len() == 4 {
            [num(&a[0])?, num(&a[1])?, num(&a[2])?, num(&a[3])?]
        } else if a.len() == 2 {
            let (p, q) = (a[0].as_array()?, a[1].as_array()?);
            if p.len() < 2 || q.len() < 2 {
                return None;
            }
            let (s, w, n, e) = (num(&p[0])?, num(&p[1])?, num(&q[0])?, num(&q[1])?);
            [w.min(e), s.min(n), w.max(e), s.max(n)]
        } else {
            return None;
        }
    } else if let Some(m) = v.as_object() {
        let g = |k: &[&str]| get_ci(m, k).and_then(num);
        [g(&["west", "w", "minlon", "lon_min", "left", "xmin"])?, g(&["south", "s", "minlat", "lat_min", "bottom", "ymin"])?, g(&["east", "e", "maxlon", "lon_max", "right", "xmax"])?, g(&["north", "n", "maxlat", "lat_max", "top", "ymax"])?]
    } else {
        return None;
    };
    let ok = b[0] < b[2] && b[1] < b[3] && b[0] >= -180.0 && b[2] <= 360.0 && b[1] >= -85.0 && b[3] <= 85.0 && b[2] - b[0] < 60.0 && b[3] - b[1] < 40.0;
    ok.then_some(b)
}

/// Read whatever a RainViewer radar JSON offers: position, name, range, image extent, scans.
pub fn parse_meta(v: &Value) -> Meta {
    let mut m = Meta::default();
    walk_meta(v, &mut m, 0);
    m.scans.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    m.scans.dedup_by(|a, b| a.1 == b.1);
    m
}

fn walk_meta(v: &Value, m: &mut Meta, depth: usize) {
    if depth > 6 {
        return;
    }
    match v {
        Value::Object(o) => {
            if m.lat.is_none() || m.lon.is_none() {
                let lat = get_ci(o, &["lat", "latitude"]).and_then(num).filter(|x| x.abs() <= 90.0);
                let lon = get_ci(o, &["lon", "lng", "long", "longitude"]).and_then(num).filter(|x| x.abs() <= 360.0);
                if let (Some(a), Some(b)) = (lat, lon) {
                    m.lat = Some(a);
                    m.lon = Some(if b > 180.0 { b - 360.0 } else { b });
                }
            }
            if m.name.is_none() {
                m.name = get_ci(o, &["location", "name", "title", "city"]).and_then(|x| x.as_str()).filter(|s| !s.is_empty() && s.len() < 80).map(String::from);
            }
            if m.range_km.is_none() {
                m.range_km = get_ci(o, &["max_range", "range", "range_km", "radius"]).and_then(num).filter(|r| *r > 10.0 && *r < 1000.0);
            }
            if m.bounds.is_none() {
                m.bounds = get_ci(o, &["bounds", "bbox", "extent", "boundingbox", "bounding_box"]).and_then(parse_bounds);
            }
            // a scan: an object with a time and a file
            let t = get_ci(o, &["time", "timestamp", "ts", "t", "date", "datetime", "scan_time"]).and_then(|x| {
                if let Some(n) = x.as_i64() {
                    Some(if n < 100_000_000_000 { n * 1000 } else { n })
                } else {
                    let s = x.as_str()?;
                    parse_http_date(s).or_else(|| name_time(s))
                }
            });
            let f = get_ci(o, &["file", "filename", "image", "url", "path", "src", "name"]).and_then(|x| x.as_str()).filter(|s| is_image(s));
            if let Some(f) = f {
                if let Some(t) = t.or_else(|| name_time(f)) {
                    m.scans.push((t, f.to_string()));
                }
            }
            for (_, x) in o {
                walk_meta(x, m, depth + 1);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| walk_meta(x, m, depth + 1)),
        Value::String(s) if is_image(s) => {
            if let Some(t) = name_time(s) {
                m.scans.push((t, s.clone()));
            }
        }
        _ => {}
    }
}

/// Radars described by a JSON document (objects with an id and a position), for a radar list
/// published next to the images.
pub fn parse_radar_list(v: &Value) -> Vec<Radar> {
    let mut out = vec![];
    fn walk(v: &Value, out: &mut Vec<Radar>, depth: usize) {
        if depth > 5 {
            return;
        }
        match v {
            Value::Object(o) => {
                let id = get_ci(o, &["id", "radar", "radar_id", "code", "station"]).and_then(|x| x.as_str()).filter(|s| valid_id(s));
                let lat = get_ci(o, &["lat", "latitude"]).and_then(num).filter(|x| x.abs() <= 90.0);
                let lon = get_ci(o, &["lon", "lng", "longitude"]).and_then(num).filter(|x| x.abs() <= 180.0);
                if let (Some(id), Some(lat), Some(lon)) = (id, lat, lon) {
                    let country_name = get_ci(o, &["country"]).and_then(|x| x.as_str()).unwrap_or("").to_string();
                    out.push(Radar {
                        id: id.to_string(),
                        name: get_ci(o, &["location", "name", "city"]).and_then(|x| x.as_str()).unwrap_or(id).to_string(),
                        state: get_ci(o, &["state", "region"]).and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        country: country_code(&country_name),
                        country_name,
                        lat,
                        lon,
                        range_km: get_ci(o, &["max_range", "range", "range_km"]).and_then(num).filter(|r| *r > 10.0 && *r < 1000.0).unwrap_or(DEFAULT_RANGE_KM),
                        bounds: get_ci(o, &["bounds", "bbox", "extent"]).and_then(parse_bounds),
                    });
                    return;
                }
                for (_, x) in o {
                    walk(x, out, depth + 1);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, out, depth + 1)),
            _ => {}
        }
    }
    walk(v, &mut out, 0);
    out
}

/// Frames of one radar directory: images with a time (from the scan JSON, the file name or the
/// index's modification time), oldest first.
pub fn frames_of(entries: &[Entry], meta: &Meta) -> Vec<(i64, String)> {
    let mut out: Vec<(i64, String)> = meta.scans.iter().map(|(t, f)| (*t, f.rsplit('/').next().unwrap_or(f).to_string())).filter(|(_, f)| clean_name(f)).collect();
    for e in entries {
        if e.name.ends_with('/') || !is_image(&e.name) || out.iter().any(|(_, f)| *f == e.name) {
            continue;
        }
        if let Some(t) = name_time(&e.name).or(e.mtime) {
            out.push((t, e.name.clone()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out.dedup_by(|a, b| a.0 == b.0);
    out
}

/// Image extent: RainViewer's own, else a box of the radar's range around it.
pub fn radar_bounds(r: &Radar) -> ([f64; 4], bool) {
    match r.bounds {
        Some(b) => (b, false),
        None => (crate::intlradar::site_bounds(r.lat, r.lon, r.range_km), true),
    }
}

/// An `IntlRadar` source (kind "image") for one radar and its frames.
pub fn source_json(r: &Radar, frames: &[(i64, String)]) -> Value {
    let (b, approx) = radar_bounds(r);
    let dir = format!("{DATA_BASE}{}/", r.id);
    let fr: Vec<Value> = frames.iter().map(|(t, f)| json!({"t": t, "url": crate::intlradar::proxied(&format!("{dir}{f}"))})).collect();
    let step = if frames.len() >= 2 { ((frames[frames.len() - 1].0 - frames[0].0) / 60_000 / (frames.len() as i64 - 1)).clamp(2, 60) } else { 10 };
    json!({
        "id": format!("{PREFIX}{}", r.id),
        "name": format!("{} radar {}{} ({})", if r.country.len() == 2 { &r.country_name } else { &r.country }, r.name, if r.state.is_empty() { String::new() } else { format!(" {}", r.state) }, r.id),
        "region": region_of(&r.country), "country": r.country, "kind": "image", "crs": "EPSG:4326",
        "site": {"id": r.id, "name": r.name, "province": r.state, "lat": r.lat, "lon": r.lon, "range_km": r.range_km},
        "attribution": ATTRIBUTION, "license_note": LICENSE,
        "minzoom": 3, "maxzoom": 11, "bounds": b, "approx_bounds": approx, "step_min": step,
        "frames": fr, "provider": "rainviewer",
    })
}

/// Layer-picker region of a country code.
pub fn region_of(cc: &str) -> &'static str {
    match cc {
        "AU" | "NZ" => "Oceania",
        "JP" => "Japan",
        "CA" => "Canada",
        "MX" => "Mexico",
        "KR" | "TW" | "CN" | "PH" | "MY" | "TH" | "ID" | "VN" | "IN" | "IL" | "TR" => "Asia",
        "RU" | "BY" | "UA" => "Europe",
        c if c.len() == 2 && "AT BE BG CH CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LV NL NO PL PT RO RS SE SI SK".contains(c) => "Europe",
        _ => "World",
    }
}

/// Composite sources from weather-maps.json: radar (past + nowcast) and satellite infrared.
pub fn composite_sources(maps: &Value) -> Result<Vec<Value>> {
    let host = maps.get("host").and_then(|h| h.as_str()).unwrap_or(TILE_HOST);
    if !crate::intlradar::allowed(&format!("{host}/")) {
        bail!("unexpected tile host {host}");
    }
    let frames = |v: Option<&Value>, tail: &str| -> Vec<Value> {
        v.and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|f| {
                        let t = f.get("time")?.as_i64()? * 1000;
                        let p = f.get("path")?.as_str()?;
                        (p.starts_with('/') && !p.contains("..") && p.chars().all(|c| c.is_ascii_alphanumeric() || "/_-.".contains(c))).then(|| json!({"t": t, "url": crate::intlradar::proxied(&format!("{host}{p}{tail}"))}))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let radar = maps.get("radar");
    let mut fr = frames(radar.and_then(|r| r.get("past")), "/256/{z}/{x}/{y}/2/1_1.png");
    fr.extend(frames(radar.and_then(|r| r.get("nowcast")), "/256/{z}/{x}/{y}/2/1_1.png"));
    let mut out = vec![];
    if !fr.is_empty() {
        out.push(json!({
            "id": "rainviewer", "name": "World radar composite (RainViewer)", "region": "World", "kind": "tiles",
            "attribution": ATTRIBUTION, "license_note": LICENSE, "minzoom": 0, "maxzoom": 7, "tileSize": 256, "step_min": 10,
            "product": "reflectivity", "units": "dBZ", "frames": fr, "provider": "rainviewer",
        }));
    }
    let ir = frames(maps.get("satellite").and_then(|s| s.get("infrared")), "/256/{z}/{x}/{y}/0/0_0.png");
    if !ir.is_empty() {
        out.push(json!({
            "id": "rainviewer_ir", "name": "World satellite infrared (RainViewer)", "region": "World", "kind": "tiles",
            "attribution": ATTRIBUTION, "license_note": LICENSE, "minzoom": 0, "maxzoom": 7, "tileSize": 256, "step_min": 10,
            "product": "infrared", "frames": ir, "provider": "rainviewer",
        }));
    }
    if out.is_empty() {
        bail!("weather-maps.json lists no frames");
    }
    Ok(out)
}

// ---------- service ----------

struct Index {
    at: Instant,
    ids: Option<Arc<Vec<String>>>,
    error: Option<String>,
}

pub struct RainViewer {
    http: reqwest::Client,
    seed: Vec<Radar>,
    index: tokio::sync::Mutex<Option<Index>>,
    /// radars found in JSON (the root's radar lists, or probed directories): id → (when, radar)
    found: Mutex<HashMap<String, (Instant, Option<Radar>)>>,
    probing: std::sync::atomic::AtomicBool,
}

impl RainViewer {
    pub fn new(http: reqwest::Client) -> Arc<Self> {
        Arc::new(Self { http, seed: seed(), index: tokio::sync::Mutex::new(None), found: Mutex::new(HashMap::new()), probing: Default::default() })
    }

    async fn text(&self, url: &str) -> Result<String> {
        let r = self.http.get(url).timeout(Duration::from_secs(25)).send().await?;
        if !r.status().is_success() {
            bail!("HTTP {} from {}", r.status(), crate::overlays::host(url));
        }
        let b = r.bytes().await?;
        if b.len() > 8 << 20 {
            bail!("listing too large");
        }
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    /// Radar ids in the image index (10 min cache; failures retried after 2 min, the last list kept).
    async fn ids(self: &Arc<Self>) -> (Option<Arc<Vec<String>>>, Option<String>) {
        let mut g = self.index.lock().await;
        if let Some(ix) = g.as_ref() {
            let ttl = if ix.error.is_some() { INDEX_RETRY } else { INDEX_TTL };
            if ix.at.elapsed() < ttl {
                return (ix.ids.clone(), ix.error.clone());
            }
        }
        let prev = g.as_ref().and_then(|i| i.ids.clone());
        let res = self.text(DATA_BASE).await.and_then(|body| {
            let e = index_entries(&body);
            let ids = radar_ids(&e);
            if ids.is_empty() {
                bail!("the RainViewer image index lists no radars");
            }
            Ok((ids, e))
        });
        let ix = match res {
            Ok((ids, entries)) => {
                // radar lists published as JSON next to the directories
                let jsons: Vec<String> = entries.iter().filter(|e| e.name.to_ascii_lowercase().ends_with(".json")).take(3).map(|e| e.name.clone()).collect();
                for j in jsons {
                    if let Ok(v) = self.text(&format!("{DATA_BASE}{j}")).await.and_then(|t| Ok(serde_json::from_str::<Value>(&t)?)) {
                        let mut f = self.found.lock();
                        for r in parse_radar_list(&v) {
                            f.insert(r.id.clone(), (Instant::now(), Some(r)));
                        }
                    }
                }
                Index { at: Instant::now(), ids: Some(Arc::new(ids)), error: None }
            }
            Err(e) => Index { at: Instant::now(), ids: prev, error: Some(format!("{e:#}")) },
        };
        let out = (ix.ids.clone(), ix.error.clone());
        *g = Some(ix);
        drop(g);
        if out.0.is_some() {
            self.probe_unknown();
        }
        out
    }

    fn known(&self, id: &str) -> Option<Radar> {
        if let Some((_, Some(r))) = self.found.lock().get(id) {
            return Some(r.clone());
        }
        self.seed.iter().find(|r| r.id.eq_ignore_ascii_case(id)).cloned()
    }

    /// Radars in the index that the database doesn't place: read their JSON, one every few seconds.
    fn probe_unknown(self: &Arc<Self>) {
        if self.probing.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let ids = me.index.lock().await.as_ref().and_then(|i| i.ids.clone()).unwrap_or_default();
            for id in ids.iter() {
                if !crate::datasources::enabled("rainviewer") {
                    break; // 0.8.4
                }
                let fresh = me.found.lock().get(id).map(|(t, _)| t.elapsed() < PROBE_TTL).unwrap_or(false);
                if fresh || me.seed.iter().any(|r| r.id.eq_ignore_ascii_case(id)) {
                    continue;
                }
                let r = me.dir(id).await.ok().and_then(|(_, meta)| {
                    Some(Radar {
                        id: id.clone(),
                        name: meta.name.clone().unwrap_or_else(|| id.clone()),
                        state: String::new(),
                        country: guess_country(id),
                        country_name: guess_country(id),
                        lat: meta.lat?,
                        lon: meta.lon?,
                        range_km: meta.range_km.unwrap_or(DEFAULT_RANGE_KM),
                        bounds: meta.bounds,
                    })
                });
                me.found.lock().insert(id.clone(), (Instant::now(), r));
                tokio::time::sleep(PROBE_GAP).await;
            }
            me.probing.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }

    /// One radar directory: its index and whatever its JSON says.
    async fn dir(&self, id: &str) -> Result<(Vec<Entry>, Meta)> {
        if !valid_id(id) {
            bail!("bad radar id");
        }
        let entries = index_entries(&self.text(&format!("{DATA_BASE}{id}/")).await?);
        let mut meta = Meta::default();
        for j in entries.iter().filter(|e| e.name.to_ascii_lowercase().ends_with(".json")).take(2) {
            if let Ok(v) = self.text(&format!("{DATA_BASE}{id}/{}", j.name)).await.and_then(|t| Ok(serde_json::from_str::<Value>(&t)?)) {
                let m = parse_meta(&v);
                meta.lat = meta.lat.or(m.lat);
                meta.lon = meta.lon.or(m.lon);
                meta.name = meta.name.or(m.name);
                meta.range_km = meta.range_km.or(m.range_km);
                meta.bounds = meta.bounds.or(m.bounds);
                meta.scans.extend(m.scans);
            }
        }
        Ok((entries, meta))
    }

    /// `GET /api/rainviewer/radars`: every placed radar outside the US (the database, plus radars
    /// found in RainViewer's JSON), flagged with whether the image index currently lists it.
    pub async fn radars(self: &Arc<Self>) -> Value {
        let (ids, err) = self.ids().await;
        let listed: std::collections::HashSet<String> = ids.as_deref().map(|v| v.iter().map(|s| s.to_ascii_uppercase()).collect()).unwrap_or_default();
        let mut out: Vec<Value> = vec![];
        let mut seen = std::collections::HashSet::new();
        let found: Vec<Radar> = self.found.lock().values().filter_map(|(_, r)| r.clone()).collect();
        for r in found.iter().chain(self.seed.iter()) {
            if r.country == "US" || !seen.insert(r.id.to_ascii_uppercase()) {
                continue;
            }
            let live = ids.is_none() || listed.contains(&r.id.to_ascii_uppercase());
            let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
            v["source"] = json!(format!("{PREFIX}{}", r.id));
            v["listed"] = json!(live);
            out.push(v);
        }
        let unplaced: Vec<&String> = ids.as_deref().map(|v| v.iter().filter(|id| !seen.contains(&id.to_ascii_uppercase())).collect()).unwrap_or_default();
        json!({"radars": out, "index": ids.as_ref().map(|v| v.len()), "unplaced": unplaced, "error": err, "attribution": ATTRIBUTION, "license_note": LICENSE})
    }

    /// One radar as an `IntlRadar` source (`rv_<id>`), with its recent frames.
    pub async fn source(self: &Arc<Self>, sid: &str) -> Result<Value> {
        let id = sid.strip_prefix(PREFIX).ok_or_else(|| anyhow!("not a RainViewer radar"))?;
        if !valid_id(id) {
            bail!("bad radar id (not found)");
        }
        let (entries, meta) = self.dir(id).await?;
        let mut r = match self.known(id) {
            Some(r) => r,
            None => Radar {
                id: id.to_string(),
                name: meta.name.clone().unwrap_or_else(|| id.to_string()),
                state: String::new(),
                country: guess_country(id),
                country_name: guess_country(id),
                lat: meta.lat.ok_or_else(|| anyhow!("{id}: no radar position known (not found)"))?,
                lon: meta.lon.ok_or_else(|| anyhow!("{id}: no radar position known (not found)"))?,
                range_km: meta.range_km.unwrap_or(DEFAULT_RANGE_KM),
                bounds: None,
            },
        };
        r.bounds = r.bounds.or(meta.bounds);
        if let Some(km) = meta.range_km {
            r.range_km = km;
        }
        let frames = frames_of(&entries, &meta);
        if frames.is_empty() {
            bail!("{id}: no radar images right now");
        }
        Ok(source_json(&r, &frames))
    }

    /// Composite + satellite sources from weather-maps.json (cached by the caller ≥ 3 min).
    pub async fn composite(&self) -> Result<Value> {
        let t = self.text(MAPS_JSON).await?;
        let v: Value = serde_json::from_str(&t)?;
        Ok(Value::Array(composite_sources(&v)?))
    }
}

/// Country from a RainViewer-style id prefix ("AU02" → AU); unknown → "".
pub fn guess_country(id: &str) -> String {
    let p: String = id.chars().take(2).collect::<String>().to_ascii_uppercase();
    match p.as_str() {
        "AU" | "NZ" | "JP" | "KR" | "TW" | "BR" | "ZA" | "IN" | "PH" | "MY" | "TH" | "ID" | "VN" | "AR" | "CL" | "IL" | "TR" | "CN" | "MX" => p,
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_HTML: &str = include_str!("rainviewer_fixtures/index_root.html");
    const DIR_HTML: &str = include_str!("rainviewer_fixtures/index_radar.html");
    const DIR_JSON: &str = include_str!("rainviewer_fixtures/index_radar.json");
    const SCANS_JSON: &str = include_str!("rainviewer_fixtures/scans.json");
    const MAPS: &str = include_str!("rainviewer_fixtures/weather-maps.json");

    #[test]
    fn seed_database() {
        let s = seed();
        assert!(s.len() > 250, "{}", s.len());
        assert!(s.iter().all(|r| r.country != "US"));
        let mel = s.iter().find(|r| r.id == "AU02").unwrap();
        assert_eq!((mel.name.as_str(), mel.country.as_str(), mel.range_km), ("Melbourne", "AU", 256.0));
        assert!((mel.lat + 37.852).abs() < 1e-3 && (mel.lon - 144.752).abs() < 1e-3);
        assert!(s.iter().any(|r| r.country == "NZ") && s.iter().any(|r| r.country == "RU"));
    }

    #[test]
    fn root_index() {
        let e = index_entries(ROOT_HTML);
        let ids = radar_ids(&e);
        assert_eq!(ids, vec!["AU02", "AU66", "JP0001", "KR005", "NZ01"]);
        assert!(e.iter().any(|x| x.name == "radars.json"));
        // a JSON autoindex gives the same
        let j = r#"[{"name":"AU02","type":"directory","mtime":"Sun, 08 Nov 2026 04:50:00 GMT"},{"name":"x.json","type":"file"}]"#;
        assert_eq!(radar_ids(&index_entries(j)), vec!["AU02"]);
    }

    #[test]
    fn radar_dir_frames() {
        let e = index_entries(DIR_HTML);
        let f = frames_of(&e, &Meta::default());
        assert_eq!(f.len(), 4, "{f:?}");
        assert!(f.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(f[0], (1_794_111_600_000, "1794111600_0_source.png".to_string()));
        // `.h5` volumes are not frames; a stamp-less image falls back to the index time
        assert!(f.iter().all(|(_, n)| !n.ends_with(".h5")));
        assert!(f.iter().any(|(_, n)| n == "latest_0_source.gif"));
        let ej = index_entries(DIR_JSON);
        assert_eq!(frames_of(&ej, &Meta::default()).len(), 2);
    }

    #[test]
    fn scan_json_meta() {
        let v: Value = serde_json::from_str(SCANS_JSON).unwrap();
        let m = parse_meta(&v);
        assert_eq!(m.lat, Some(35.6));
        assert_eq!(m.lon, Some(139.8));
        assert_eq!(m.bounds, Some([137.0, 33.4, 142.6, 37.8]));
        assert_eq!(m.scans.len(), 3);
        assert_eq!(m.scans[0].1, "20261108T043000_0_source.png");
        let list = parse_radar_list(&serde_json::from_str::<Value>(include_str!("rainviewer_fixtures/radars.json")).unwrap());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "JP0001");
        assert_eq!(list[1].country, "KR");
    }

    #[test]
    fn times_and_bounds() {
        assert_eq!(name_time("1794111600_0_source.png"), Some(1_794_111_600_000));
        assert_eq!(name_time("202611080430_0_source.png"), Some(1_794_112_200_000));
        assert_eq!(name_time("20261108_0430_0_source.png"), Some(1_794_112_200_000));
        assert_eq!(name_time("0_source.png"), None);
        assert_eq!(parse_bounds(&json!([[33.4, 137.0], [37.8, 142.6]])), Some([137.0, 33.4, 142.6, 37.8]));
        assert_eq!(parse_bounds(&json!({"west": 1, "south": 2, "east": 3, "north": 4})), Some([1.0, 2.0, 3.0, 4.0]));
        assert_eq!(parse_bounds(&json!([0, 0, 200, 80])), None, "not a radar-sized box");
        let r = seed().into_iter().find(|r| r.id == "AU02").unwrap();
        let (b, approx) = radar_bounds(&r);
        assert!(approx && b[0] < 144.752 && b[2] > 144.752 && ((b[3] - b[1]) * 111.2 / 2.0 - 256.0).abs() < 1.0);
        assert!(valid_id("AU02") && !valid_id("../x") && !valid_id("a/b") && !valid_id(".x"));
    }

    #[test]
    fn source_and_composite() {
        let r = seed().into_iter().find(|r| r.id == "AU02").unwrap();
        let v = source_json(&r, &[(1_794_111_600_000, "1794111600_0_source.png".into()), (1_794_112_200_000, "1794112200_0_source.png".into())]);
        assert_eq!(v["id"], "rv_AU02");
        assert_eq!(v["kind"], "image");
        assert_eq!(v["region"], "Oceania");
        assert_eq!(v["step_min"], 10);
        let u = v["frames"][0]["url"].as_str().unwrap();
        assert!(u.starts_with("/api/intlradar/img?u=https%3A%2F%2Fdata.rainviewer.com%2Fimages%2FAU02%2F1794111600_0_source.png"), "{u}");
        assert!(crate::intlradar::allowed("https://data.rainviewer.com/images/AU02/1794111600_0_source.png"));
        assert!(HOSTS.iter().all(|h| crate::intlradar::allowed(&format!("https://{h}/x"))));
        let maps: Value = serde_json::from_str(MAPS).unwrap();
        let c = composite_sources(&maps).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0]["id"], "rainviewer");
        assert_eq!(c[0]["frames"].as_array().unwrap().len(), 4, "past + nowcast");
        let t = c[0]["frames"][0]["url"].as_str().unwrap();
        assert!(t.ends_with("%2F256%2F{z}%2F{x}%2F{y}%2F2%2F1_1.png"), "{t}");
        assert_eq!(c[1]["id"], "rainviewer_ir");
        assert!(composite_sources(&json!({"host": "https://evil.example", "radar": {"past": [{"time": 1, "path": "/v2/radar/1"}]}})).is_err());
    }
}
