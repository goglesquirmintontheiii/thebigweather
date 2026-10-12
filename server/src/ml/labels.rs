//! Historical event databases used as labels and the rules matching them to candidates.
//!
//! Sources (see `catalog`): SPC tornado / hail / wind databases, IEM local storm reports and
//! storm-based warnings, HURDAT2 genesis / first fixes, NOAA HMS fire detections.

use crate::hist::tc::Storm;
use anyhow::{anyhow, Result};
use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One labelled event (point or short path, or a warning polygon).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub id: String,
    /// tornado | hail | wind | flood | warning | genesis | tc | fire | lsr:<type>
    pub kind: String,
    pub t0: i64,
    pub t1: i64,
    pub lat: f64,
    pub lon: f64,
    /// path end (0 = point)
    #[serde(default)]
    pub elat: f64,
    #[serde(default)]
    pub elon: f64,
    /// EF rating, hail inches, wind kt, FRP MW, wind kt (TC)...
    #[serde(default)]
    pub mag: f32,
    #[serde(default)]
    pub st: String,
    /// warning polygon (lon, lat)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub poly: Vec<[f32; 2]>,
}

/// Label-source catalog: id, name, targets, first year, notes.
pub const SOURCES: &[(&str, &str, &[&str], i32, &str)] = &[
    ("spc_tornado", "SPC tornado database (+ IEM reports for years not yet in it)", &["tornado", "supercell", "debris", "custom"], 1950, "https://www.spc.noaa.gov/wcm/data/1950-YYYY_actual_tornadoes.csv"),
    ("spc_hail", "SPC hail database", &["hail", "sighail", "supercell", "custom"], 1955, "https://www.spc.noaa.gov/wcm/data/YYYY_hail.csv"),
    ("spc_wind", "SPC damaging wind database", &["wind", "custom"], 1955, "https://www.spc.noaa.gov/wcm/data/YYYY_wind.csv"),
    ("iem_lsr", "IEM local storm reports", &["tornado", "hail", "sighail", "wind", "flash_flood", "custom"], 2003, "https://mesonet.agron.iastate.edu/geojson/lsr.geojson"),
    ("iem_sbw", "NWS storm-based warnings (IEM, weak labels)", &["tornado", "supercell", "hail", "wind", "flash_flood", "custom"], 2008, "https://mesonet.agron.iastate.edu/geojson/sbw.geojson"),
    ("hurdat_genesis", "HURDAT2 tropical-storm genesis", &["tropical_genesis", "custom"], 1851, "https://www.nhc.noaa.gov/data/hurdat/"),
    ("hurdat_first_fix", "HURDAT2 first fix (any tropical cyclone)", &["tropical_possible", "custom"], 1851, "https://www.nhc.noaa.gov/data/hurdat/"),
    ("hms_fire", "NOAA HMS satellite fire detections (new fires)", &["wildfire", "custom"], 2003, "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Fire_Points/Text/"),
];

/// Label filters (each applies to the sources it concerns).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Filters {
    /// tornado EF/F rating (≥)
    pub min_mag: Option<i32>,
    /// hail size inches (≥)
    pub min_size_in: Option<f64>,
    /// wind kt (≥)
    pub min_wind_kt: Option<f64>,
    /// IEM LSR type codes (T tornado, H hail, G gust, D wind damage, F flash flood, E flood …)
    pub lsr_types: Vec<String>,
    /// warning phenomena for iem_sbw (TO, SV, FF, …)
    pub phenomena: Vec<String>,
    /// months to keep (1–12, empty = all)
    pub months: Vec<u32>,
    /// HURDAT basins (al, ep)
    pub basins: Vec<String>,
    /// minimum HMS fire radiative power (MW)
    pub min_frp: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Region {
    pub states: Vec<String>,
    pub bbox: Option<[f64; 4]>,
}

pub const CONUS: [f64; 4] = [-125.0, 24.0, -66.5, 50.0];

/// Approximate state bounding boxes (w, s, e, n).
pub const STATE_BBOX: &[(&str, [f64; 4])] = &[
    ("AL", [-88.5, 30.2, -84.9, 35.0]), ("AZ", [-114.8, 31.3, -109.0, 37.0]), ("AR", [-94.6, 33.0, -89.6, 36.5]), ("CA", [-124.4, 32.5, -114.1, 42.0]),
    ("CO", [-109.1, 37.0, -102.0, 41.0]), ("CT", [-73.7, 41.0, -71.8, 42.1]), ("DE", [-75.8, 38.5, -75.0, 39.8]), ("FL", [-87.6, 24.5, -80.0, 31.0]),
    ("GA", [-85.6, 30.4, -80.8, 35.0]), ("ID", [-117.2, 42.0, -111.0, 49.0]), ("IL", [-91.5, 37.0, -87.5, 42.5]), ("IN", [-88.1, 37.8, -84.8, 41.8]),
    ("IA", [-96.6, 40.4, -90.1, 43.5]), ("KS", [-102.1, 37.0, -94.6, 40.0]), ("KY", [-89.6, 36.5, -81.9, 39.1]), ("LA", [-94.0, 29.0, -89.0, 33.0]),
    ("ME", [-71.1, 43.0, -66.9, 47.5]), ("MD", [-79.5, 37.9, -75.0, 39.7]), ("MA", [-73.5, 41.2, -69.9, 42.9]), ("MI", [-90.4, 41.7, -82.4, 48.3]),
    ("MN", [-97.2, 43.5, -89.5, 49.4]), ("MS", [-91.7, 30.2, -88.1, 35.0]), ("MO", [-95.8, 36.0, -89.1, 40.6]), ("MT", [-116.1, 44.4, -104.0, 49.0]),
    ("NE", [-104.1, 40.0, -95.3, 43.0]), ("NV", [-120.0, 35.0, -114.0, 42.0]), ("NH", [-72.6, 42.7, -70.6, 45.3]), ("NJ", [-75.6, 38.9, -73.9, 41.4]),
    ("NM", [-109.1, 31.3, -103.0, 37.0]), ("NY", [-79.8, 40.5, -71.9, 45.0]), ("NC", [-84.3, 33.8, -75.5, 36.6]), ("ND", [-104.1, 45.9, -96.6, 49.0]),
    ("OH", [-84.8, 38.4, -80.5, 42.0]), ("OK", [-103.0, 33.6, -94.4, 37.0]), ("OR", [-124.6, 42.0, -116.5, 46.3]), ("PA", [-80.5, 39.7, -74.7, 42.3]),
    ("RI", [-71.9, 41.1, -71.1, 42.0]), ("SC", [-83.4, 32.0, -78.5, 35.2]), ("SD", [-104.1, 42.5, -96.4, 45.9]), ("TN", [-90.3, 35.0, -81.6, 36.7]),
    ("TX", [-106.6, 25.8, -93.5, 36.5]), ("UT", [-114.1, 37.0, -109.0, 42.0]), ("VT", [-73.4, 42.7, -71.5, 45.0]), ("VA", [-83.7, 36.5, -75.2, 39.5]),
    ("WA", [-124.8, 45.5, -116.9, 49.0]), ("WV", [-82.6, 37.2, -77.7, 40.6]), ("WI", [-92.9, 42.5, -86.8, 47.1]), ("WY", [-111.1, 41.0, -104.1, 45.0]),
    ("DC", [-77.1, 38.8, -76.9, 39.0]), ("AK", [-170.0, 51.0, -130.0, 71.5]), ("HI", [-160.3, 18.9, -154.8, 22.3]), ("PR", [-67.3, 17.9, -65.2, 18.5]),
];

impl Region {
    /// Bounding box covering the region (bbox, else the states' union, else CONUS).
    pub fn bbox(&self) -> [f64; 4] {
        if let Some(b) = self.bbox {
            return b;
        }
        let mut out: Option<[f64; 4]> = None;
        for s in &self.states {
            if let Some((_, b)) = STATE_BBOX.iter().find(|(id, _)| id.eq_ignore_ascii_case(s)) {
                out = Some(match out {
                    None => *b,
                    Some(o) => [o[0].min(b[0]), o[1].min(b[1]), o[2].max(b[2]), o[3].max(b[3])],
                });
            }
        }
        out.unwrap_or(CONUS)
    }
    pub fn contains(&self, lat: f64, lon: f64, st: &str) -> bool {
        if let Some([w, s, e, n]) = self.bbox {
            if !(lon >= w && lon <= e && lat >= s && lat <= n) {
                return false;
            }
        }
        if self.states.is_empty() {
            return true;
        }
        if !st.trim().is_empty() {
            return self.states.iter().any(|x| x.eq_ignore_ascii_case(st.trim()));
        }
        // no state code: fall back to the states' boxes
        self.states.iter().any(|s| STATE_BBOX.iter().any(|(id, [w, so, e, n])| id.eq_ignore_ascii_case(s) && lon >= *w && lon <= *e && lat >= *so && lat <= *n))
    }
}

// ---------- SPC CSV (tornado / hail / wind share the column layout) ----------

/// Parse an SPC severe report CSV (om,yr,mo,dy,date,time,tz,st,stf,stn,mag,…,slat,slon,elat,elon,len,wid…).
/// Tornado `mag` is the (E)F rating, hail inches, wind knots. Times are CST unless tz = 9 (UTC).
pub fn parse_spc(bytes: &[u8], kind: &str) -> Vec<Event> {
    let mut rd = csv::ReaderBuilder::new().flexible(true).from_reader(bytes);
    let Ok(h) = rd.headers() else { return vec![] };
    let hdr: Vec<String> = h.iter().map(|h| h.trim().to_ascii_lowercase()).collect();
    let col = |n: &str| hdr.iter().position(|h| h == n);
    let (Some(c_slat), Some(c_slon), Some(c_mag)) = (col("slat"), col("slon"), col("mag")) else { return vec![] };
    let (c_elat, c_elon, c_date, c_time, c_tz, c_st, c_om, c_len) = (col("elat"), col("elon"), col("date"), col("time"), col("tz"), col("st"), col("om"), col("len"));
    let (c_yr, c_mo, c_dy) = (col("yr"), col("mo"), col("dy"));
    let mut out = vec![];
    for rec in rd.records() {
        let Ok(r) = rec else { continue };
        let g = |c: Option<usize>| c.and_then(|i| r.get(i)).unwrap_or("").trim();
        let n = |c: Option<usize>| g(c).parse::<f64>().ok();
        let date = match NaiveDate::parse_from_str(g(c_date), "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => match (n(c_yr), n(c_mo), n(c_dy)) {
                (Some(y), Some(m), Some(d)) => match NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32) {
                    Some(x) => x,
                    None => continue,
                },
                _ => continue,
            },
        };
        let time = chrono::NaiveTime::parse_from_str(g(c_time), "%H:%M:%S").or_else(|_| chrono::NaiveTime::parse_from_str(g(c_time), "%H:%M")).unwrap_or_default();
        let off_h = if g(c_tz) == "9" { 0 } else { 6 };
        let t0 = Utc.from_utc_datetime(&NaiveDateTime::new(date, time)).timestamp_millis() + off_h * 3_600_000;
        let (Some(slat), Some(slon)) = (n(Some(c_slat)), n(Some(c_slon))) else { continue };
        if slat == 0.0 || slon == 0.0 {
            continue;
        }
        let (mut elat, mut elon) = (n(c_elat).unwrap_or(0.0), n(c_elon).unwrap_or(0.0));
        if elat == 0.0 || elon == 0.0 {
            elat = 0.0;
            elon = 0.0;
        }
        let mag = n(Some(c_mag)).unwrap_or(-9.0) as f32;
        // tornado path duration from its length at ~35 mph (≥ 1 min)
        let len_mi = n(c_len).unwrap_or(0.0).max(0.0);
        let dur = if kind == "tornado" { ((len_mi / 35.0) * 3_600_000.0).max(60_000.0) as i64 } else { 0 };
        out.push(Event {
            id: format!("spc-{kind}-{}-{}", date.format("%Y%m%d"), g(c_om)),
            kind: kind.into(),
            t0,
            t1: t0 + dur,
            lat: slat,
            lon: slon,
            elat,
            elon,
            mag,
            st: g(c_st).to_string(),
            poly: vec![],
        });
    }
    out
}

/// SPC file names covering `year` (yearly files from 2008, multi-year before).
pub fn spc_files(kind: &str, year: i32) -> Option<String> {
    let k = match kind {
        "hail" => "hail",
        "wind" => "wind",
        _ => "torn",
    };
    Some(match year {
        2008.. => format!("{year}_{k}.csv"),
        2005..=2007 => format!("2005-2007_{k}.csv"),
        2000..=2004 => format!("2000-2004_{k}.csv"),
        1990..=1999 => format!("90-99_{k}.csv"),
        1980..=1989 => format!("80-89_{k}.csv"),
        1970..=1979 => format!("70-79_{k}.csv"),
        1960..=1969 => format!("60-69_{k}.csv"),
        1955..=1959 if k != "torn" => format!("55-59_{k}.csv"),
        1950..=1959 if k == "torn" => "50-59_torn.csv".into(),
        _ => return None,
    })
}

// ---------- IEM LSR / SBW ----------

/// IEM LSR GeoJSON → events (kind "lsr:<type>"; tornado/hail/wind/flood mapped too).
pub fn parse_lsr(v: &Value) -> Vec<Event> {
    let mut out = vec![];
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let (Some(lon), Some(lat)) = (f["geometry"]["coordinates"][0].as_f64().or(p["lon"].as_f64()), f["geometry"]["coordinates"][1].as_f64().or(p["lat"].as_f64())) else { continue };
        let Some(t) = p["valid"].as_str().and_then(crate::overlays::more::parse_time).map(|t| t.timestamp_millis()) else { continue };
        let ty = p["type"].as_str().unwrap_or("").to_string();
        let mag = p["magf"].as_f64().or_else(|| p["magnitude"].as_str().and_then(|s| s.parse().ok())).or_else(|| p["magnitude"].as_f64()).unwrap_or(f64::NAN) as f32;
        let kind = match ty.as_str() {
            "T" => "tornado".to_string(),
            "H" => "hail".to_string(),
            "G" | "D" | "M" => "wind".to_string(),
            "F" => "flood".to_string(),
            x => format!("lsr:{x}"),
        };
        // wind damage reports carry no speed: count them as severe (50 kt)
        let mag = if ty == "D" && !mag.is_finite() { 50.0 } else { mag };
        out.push(Event {
            id: format!("lsr-{}-{t}-{:.2}-{:.2}", ty, lat, lon),
            kind,
            t0: t,
            t1: t,
            lat,
            lon,
            elat: 0.0,
            elon: 0.0,
            mag: if ty == "T" { 0.0 } else { mag },
            st: p["state"].as_str().or(p["st"].as_str()).unwrap_or("").to_string(),
            poly: vec![],
        });
    }
    // stable ids
    for e in out.iter_mut() {
        e.id = format!("lsr-{}-{}-{:.3}-{:.3}", e.kind.replace(':', "_"), e.t0, e.lat, e.lon);
    }
    out
}

/// IEM SBW GeoJSON → warning events (polygon, issue..expire).
pub fn parse_sbw(v: &Value) -> Vec<Event> {
    let mut out = vec![];
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let ph = p["phenomena"].as_str().unwrap_or("");
        if p["significance"].as_str() != Some("W") {
            continue;
        }
        let tm = |k: &str| p[k].as_str().and_then(crate::overlays::more::parse_time).map(|t| t.timestamp_millis());
        let (Some(t0), Some(t1)) = (tm("polygon_begin").or(tm("issue")), tm("polygon_end").or(tm("expire"))) else { continue };
        let mut ring: Vec<[f32; 2]> = vec![];
        let g = &f["geometry"];
        let coords = match g["type"].as_str() {
            Some("Polygon") => g["coordinates"][0].as_array().cloned(),
            Some("MultiPolygon") => g["coordinates"][0][0].as_array().cloned(),
            _ => None,
        };
        for c in coords.into_iter().flatten() {
            if let (Some(x), Some(y)) = (c[0].as_f64(), c[1].as_f64()) {
                ring.push([x as f32, y as f32]);
            }
        }
        if ring.len() < 3 {
            continue;
        }
        let (cx, cy) = ring.iter().fold((0.0, 0.0), |a, p| (a.0 + p[0] as f64, a.1 + p[1] as f64));
        let n = ring.len() as f64;
        out.push(Event {
            id: format!("sbw-{}-{}-{}-{}", p["wfo"].as_str().unwrap_or(""), ph, p["eventid"], t0),
            kind: format!("warning:{ph}"),
            t0,
            t1,
            lat: cy / n,
            lon: cx / n,
            elat: 0.0,
            elon: 0.0,
            mag: if p["tornadotag"].as_str() == Some("OBSERVED") { 2.0 } else if p["tornadotag"].is_string() { 1.0 } else { 0.0 },
            st: String::new(),
            poly: ring,
        });
    }
    out
}

// ---------- HMS fires ----------

/// HMS fire text (`Lon, Lat, YearDay, Time, Satellite, Method, Ecosystem, FRP`).
pub fn parse_hms(txt: &str) -> Vec<Event> {
    let mut out = vec![];
    for l in txt.lines() {
        let f: Vec<&str> = l.split(',').map(str::trim).collect();
        if f.len() < 4 {
            continue;
        }
        let (Ok(lon), Ok(lat)) = (f[0].parse::<f64>(), f[1].parse::<f64>()) else { continue };
        let Some(t) = yday_ms(f[2], f[3]) else { continue };
        let frp = f.get(7).and_then(|s| s.parse::<f32>().ok()).filter(|v| *v >= 0.0).unwrap_or(f32::NAN);
        out.push(Event { id: format!("hms-{t}-{lat:.3}-{lon:.3}"), kind: "fire".into(), t0: t, t1: t, lat, lon, elat: 0.0, elon: 0.0, mag: frp, st: String::new(), poly: vec![] });
    }
    out
}

fn yday_ms(yd: &str, hhmm: &str) -> Option<i64> {
    let (y, d) = (yd.get(..4)?.parse::<i32>().ok()?, yd.get(4..)?.parse::<u32>().ok()?);
    let hhmm = format!("{:0>4}", hhmm.trim());
    let (h, mi) = (hhmm.get(..2)?.parse::<u32>().ok()?, hhmm.get(2..4)?.parse::<u32>().ok()?);
    Some(NaiveDate::from_yo_opt(y, d)?.and_hms_opt(h, mi, 0)?.and_utc().timestamp_millis())
}

/// Detections on `day` with no detection within `km` on the previous day ("new fires"),
/// thinned so no two are within `km` of each other.
pub fn new_fires(today: &[Event], yesterday: &[Event], km: f64) -> Vec<Event> {
    let cell = km / 111.0;
    let key = |lat: f64, lon: f64| ((lat / cell).floor() as i64, (lon / cell).floor() as i64);
    let mut prev: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();
    for e in yesterday {
        prev.insert(key(e.lat, e.lon));
    }
    let near_prev = |lat: f64, lon: f64| {
        let (a, b) = key(lat, lon);
        (-1..=1).any(|i| (-1..=1).any(|j| prev.contains(&(a + i, b + j))))
    };
    let mut taken: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();
    let mut sorted: Vec<&Event> = today.iter().collect();
    sorted.sort_by_key(|e| e.t0);
    let mut out = vec![];
    for e in sorted {
        let k = key(e.lat, e.lon);
        if near_prev(e.lat, e.lon) || (-1..=1).any(|i| (-1..=1).any(|j| taken.contains(&(k.0 + i, k.1 + j)))) {
            continue;
        }
        taken.insert(k);
        out.push(e.clone());
    }
    out
}

// ---------- tropical genesis ----------

/// Genesis events from best tracks. `first_fix`: the storm's first fix (any status);
/// otherwise the first fix at tropical-storm strength (≥ 34 kt, TS/HU/SS status).
/// The event location is where the system was; `t0` the genesis time.
pub fn genesis(storms: &[Storm], first_fix: bool, basins: &[String]) -> Vec<Event> {
    let mut out = vec![];
    for s in storms {
        if !basins.is_empty() && !basins.iter().any(|b| b.eq_ignore_ascii_case(&s.basin) || (b == "ep" && s.basin == "cp")) {
            continue;
        }
        let pt = if first_fix {
            s.pts.first()
        } else {
            s.pts.iter().find(|p| p.3 >= 34 && matches!(p.5.as_str(), "TS" | "HU" | "SS" | "TY" | "ST"))
        };
        let Some(p) = pt else { continue };
        out.push(Event {
            id: format!("tc-{}", s.id),
            kind: if first_fix { "tc".into() } else { "genesis".into() },
            t0: p.0 * 1000,
            t1: p.0 * 1000,
            lat: p.1 as f64,
            lon: p.2 as f64,
            elat: 0.0,
            elon: 0.0,
            mag: p.3 as f32,
            st: s.basin.clone(),
            poly: vec![],
        });
    }
    out
}

/// Location of a storm (by best track) at time `t` (ms), when it existed: the earliest fix for
/// earlier times (pre-genesis disturbance position approximated by the first fix).
pub fn storm_position(s: &Storm, t: i64) -> Option<(f64, f64)> {
    let ts = t / 1000;
    let first = s.pts.first()?;
    if ts <= first.0 {
        return Some((first.1 as f64, first.2 as f64));
    }
    for w in s.pts.windows(2) {
        if ts >= w[0].0 && ts <= w[1].0 {
            let f = (ts - w[0].0) as f64 / ((w[1].0 - w[0].0) as f64).max(1.0);
            return Some((w[0].1 as f64 + (w[1].1 - w[0].1) as f64 * f, w[0].2 as f64 + (w[1].2 - w[0].2) as f64 * f));
        }
    }
    None
}

// ---------- filtering ----------

pub fn year_of(t: i64) -> i32 {
    use chrono::Datelike;
    chrono::DateTime::from_timestamp_millis(t).map(|d| d.year()).unwrap_or(0)
}

fn month_of(t: i64) -> u32 {
    use chrono::Datelike;
    chrono::DateTime::from_timestamp_millis(t).map(|d| d.month()).unwrap_or(0)
}

/// Keep events matching the filters (magnitude thresholds by event kind) and years.
pub fn filter(events: &[Event], f: &Filters, years: (i32, i32)) -> Vec<Event> {
    events
        .iter()
        .filter(|e| {
            let y = year_of(e.t0);
            if y < years.0 || y > years.1 {
                return false;
            }
            if !f.months.is_empty() && !f.months.contains(&month_of(e.t0)) {
                return false;
            }
            match e.kind.as_str() {
                "tornado" => f.min_mag.map(|m| e.mag >= m as f32 || (e.mag < 0.0 && m <= 0)).unwrap_or(true),
                "hail" => f.min_size_in.map(|m| e.mag as f64 >= m - 1e-6).unwrap_or(true),
                "wind" => f.min_wind_kt.map(|m| e.mag as f64 >= m - 1e-6).unwrap_or(true),
                "fire" => f.min_frp.map(|m| e.mag.is_finite() && e.mag as f64 >= m).unwrap_or(true),
                k if k.starts_with("warning:") => f.phenomena.is_empty() || f.phenomena.iter().any(|p| k.ends_with(p.as_str())),
                _ => true,
            }
        })
        .cloned()
        .collect()
}

/// Matching rule for radar cells: within `radius_km` of the event point / path / polygon, and
/// the volume time within [t0 − after_min, t1 + before_min] (lead time `after_min`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MatchRule {
    pub radius_km: f64,
    pub before_min: f64,
    pub after_min: f64,
}

impl Default for MatchRule {
    fn default() -> Self {
        Self { radius_km: 10.0, before_min: 10.0, after_min: 30.0 }
    }
}

impl MatchRule {
    pub fn relaxed(&self) -> MatchRule {
        MatchRule { radius_km: self.radius_km * 2.5, before_min: self.before_min * 2.0 + 10.0, after_min: self.after_min * 1.5 + 15.0 }
    }
}

/// Distance (km) from a point to a segment on a local flat projection.
pub fn dist_to_path_km(lat: f64, lon: f64, e: &Event) -> f64 {
    let kx = 111.32 * lat.to_radians().cos();
    let ky = 110.57;
    let (px, py) = (lon * kx, lat * ky);
    let (ax, ay) = (e.lon * kx, e.lat * ky);
    if e.elat == 0.0 && e.elon == 0.0 {
        return ((px - ax).powi(2) + (py - ay).powi(2)).sqrt();
    }
    let (bx, by) = (e.elon * kx, e.elat * ky);
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    ((px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt()
}

pub fn point_in_poly(lat: f64, lon: f64, poly: &[[f32; 2]]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (xi, yi) = (poly[i][0] as f64, poly[i][1] as f64);
        let (xj, yj) = (poly[j][0] as f64, poly[j][1] as f64);
        if ((yi > lat) != (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Does an event match a candidate at (lat, lon, t)?
pub fn matches(e: &Event, lat: f64, lon: f64, t: i64, m: &MatchRule) -> bool {
    let lo = e.t0 - (m.after_min * 60_000.0) as i64;
    let hi = e.t1 + (m.before_min * 60_000.0) as i64;
    if t < lo || t > hi {
        return false;
    }
    if !e.poly.is_empty() {
        return point_in_poly(lat, lon, &e.poly);
    }
    dist_to_path_km(lat, lon, e) <= m.radius_km
}

/// Events indexed by day for quick time-window lookups.
pub struct EventIndex {
    by_day: std::collections::HashMap<i64, Vec<usize>>,
    pub events: Vec<Event>,
}

impl EventIndex {
    pub fn new(events: Vec<Event>) -> Self {
        let mut by_day: std::collections::HashMap<i64, Vec<usize>> = std::collections::HashMap::new();
        for (i, e) in events.iter().enumerate() {
            let (a, b) = (e.t0.div_euclid(86_400_000), e.t1.div_euclid(86_400_000));
            for d in a..=b.min(a + 3) {
                by_day.entry(d).or_default().push(i);
            }
        }
        EventIndex { by_day, events }
    }
    /// Events whose window could include `t` (± 1 day).
    pub fn near(&self, t: i64) -> impl Iterator<Item = &Event> {
        let d = t.div_euclid(86_400_000);
        let mut idx: Vec<usize> = (d - 1..=d + 1).flat_map(|k| self.by_day.get(&k).cloned().unwrap_or_default()).collect();
        idx.sort_unstable();
        idx.dedup();
        idx.into_iter().map(move |i| &self.events[i])
    }
    pub fn first_match(&self, lat: f64, lon: f64, t: i64, m: &MatchRule) -> Option<&Event> {
        self.near(t).find(|e| matches(e, lat, lon, t, m))
    }
}

pub fn ensure_years(years: (i32, i32)) -> Result<(i32, i32)> {
    if years.0 > years.1 || years.0 < 1950 || years.1 > 2100 {
        return Err(anyhow!("bad years {:?}", years));
    }
    Ok(years)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HAIL: &str = "om,yr,mo,dy,date,time,tz,st,stf,stn,mag,inj,fat,loss,closs,slat,slon,elat,elon,len,wid,ns,sn,sg,f1,f2,f3,f4\n\
        1,2023,5,6,2023-05-06,15:30:00,3,OK,40,0,1.75,0,0,0,0,35.5,-97.5,0,0,0,0,1,1,1,0,0,0,0\n\
        2,2023,5,6,2023-05-06,16:00:00,3,KS,20,0,0.75,0,0,0,0,38.5,-98.5,0,0,0,0,1,1,1,0,0,0,0\n";

    #[test]
    fn spc_hail_parse_and_filter() {
        let e = parse_spc(HAIL.as_bytes(), "hail");
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].mag, 1.75);
        assert_eq!(e[0].t0, Utc.with_ymd_and_hms(2023, 5, 6, 21, 30, 0).unwrap().timestamp_millis());
        let f = Filters { min_size_in: Some(1.0), ..Default::default() };
        assert_eq!(filter(&e, &f, (2023, 2023)).len(), 1);
        assert_eq!(filter(&e, &f, (2024, 2025)).len(), 0);
        assert_eq!(spc_files("hail", 2015).unwrap(), "2015_hail.csv");
        assert_eq!(spc_files("wind", 2006).unwrap(), "2005-2007_wind.csv");
        assert_eq!(spc_files("hail", 1957).unwrap(), "55-59_hail.csv");
    }

    #[test]
    fn matching_paths_and_windows() {
        let e = Event { id: "x".into(), kind: "tornado".into(), t0: 1_000_000_000_000, t1: 1_000_000_600_000, lat: 35.0, lon: -97.0, elat: 35.0, elon: -96.8, mag: 2.0, st: "OK".into(), poly: vec![] };
        let m = MatchRule::default();
        // 5 km north of the path middle, 20 min before the start: lead time inside 30 min
        assert!(matches(&e, 35.045, -96.9, e.t0 - 20 * 60_000, &m));
        // 40 min before: too early
        assert!(!matches(&e, 35.045, -96.9, e.t0 - 40 * 60_000, &m));
        // after the end + 10 min
        assert!(matches(&e, 35.0, -96.8, e.t1 + 9 * 60_000, &m));
        assert!(!matches(&e, 35.0, -96.8, e.t1 + 11 * 60_000, &m));
        // 20 km away
        assert!(!matches(&e, 35.18, -96.9, e.t0, &m));
        assert!(matches(&e, 35.18, -96.9, e.t0, &m.relaxed()));
        let idx = EventIndex::new(vec![e.clone()]);
        assert!(idx.first_match(35.0, -96.95, e.t0, &m).is_some());
        let poly = vec![[-98.0, 34.0], [-96.0, 34.0], [-96.0, 36.0], [-98.0, 36.0], [-98.0, 34.0]];
        assert!(point_in_poly(35.0, -97.0, &poly));
        assert!(!point_in_poly(37.0, -97.0, &poly));
    }

    #[test]
    fn lsr_sbw_hms_genesis() {
        let v: Value = serde_json::from_str(r#"{"features":[{"geometry":{"type":"Point","coordinates":[-94.23,43.07]},"properties":{"type":"H","magf":0.88,"valid":"2024-05-21T20:50:00Z","state":"IA","magnitude":"0.88"}},
            {"geometry":{"type":"Point","coordinates":[-94.0,43.0]},"properties":{"type":"T","valid":"2024-05-21T21:00:00Z","state":"IA","magnitude":"0"}}]}"#).unwrap();
        let e = parse_lsr(&v);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].kind, "hail");
        assert!((e[0].mag - 0.88).abs() < 1e-4);
        assert_eq!(e[1].kind, "tornado");
        assert_eq!(e[1].st, "IA");
        let s: Value = serde_json::from_str(r#"{"features":[{"properties":{"phenomena":"TO","significance":"W","wfo":"DMX","eventid":42,"polygon_begin":"2024-05-21T20:20:00Z","polygon_end":"2024-05-21T20:45:00Z","tornadotag":"OBSERVED"},"geometry":{"type":"MultiPolygon","coordinates":[[[[-94.5,41.2],[-94.3,41.3],[-94.2,41.2],[-94.5,41.2]]]]}}]}"#).unwrap();
        let w = parse_sbw(&s);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].kind, "warning:TO");
        assert_eq!(w[0].mag, 2.0);
        let f = filter(&w, &Filters { phenomena: vec!["SV".into()], ..Default::default() }, (2024, 2024));
        assert!(f.is_empty());
        let h = parse_hms("Lon, Lat, YearDay, Time, Satellite, Method, Ecosystem, FRP\n -120.0, 40.0, 2023200, 2010, GOES-18, FDC, 20, 55.0\n -120.001, 40.001, 2023200, 2015, GOES-18, FDC, 20, -999.0\n -110.0, 35.0, 2023200, 2015, GOES-18, FDC, 20, 5\n");
        assert_eq!(h.len(), 3);
        assert!(h[1].mag.is_nan());
        let y = parse_hms(" -110.01, 35.01, 2023199, 2010, GOES-18, FDC, 20, 5\n");
        let n = new_fires(&h, &y, 4.0);
        assert_eq!(n.len(), 1, "{n:?}");
        assert!((n[0].lat - 40.0).abs() < 0.01);
        use crate::hist::tc::Pt;
        let st = Storm { id: "AL052023".into(), name: "X".into(), basin: "al".into(), year: 2023, pts: vec![Pt(1_690_000_000, 12.0, -40.0, 25, 1009, "TD".into(), false), Pt(1_690_021_600, 12.5, -41.0, 35, 1005, "TS".into(), false)] };
        let g = genesis(&[st.clone()], false, &[]);
        assert_eq!(g[0].t0, 1_690_021_600_000);
        assert_eq!(genesis(&[st.clone()], true, &[])[0].t0, 1_690_000_000_000);
        assert!(genesis(&[st.clone()], false, &["ep".into()]).is_empty());
        let (la, _) = storm_position(&st, 1_690_010_800_000).unwrap();
        assert!((la - 12.25).abs() < 1e-6);
        let r = Region { states: vec!["OK".into()], bbox: None };
        assert!(r.contains(35.5, -97.5, "OK") && !r.contains(35.5, -97.5, "KS") && r.contains(35.5, -97.5, ""));
        assert_eq!(r.bbox()[0], -103.0);
    }
}
