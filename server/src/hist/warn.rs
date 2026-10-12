//! Historical NWS warning search over the Iowa Environmental Mesonet VTEC archive (2005–now,
//! some earlier). Sources (all keyless, IEM terms: free use with attribution):
//! - `json/vtec_events_bystate.py?state=XX&year=YYYY` — every VTEC event touching a state
//! - `json/vtec_events.py?wfo=XXX&year=YYYY` — every VTEC event issued by an office
//! - `api/1/vtec/sbw_interval.geojson?begints&endts[&wfo&ph&only_new]` — storm-based polygons
//! - `json/vtec_event.py` + `geojson/vtec_event.py` — one event's text and county/zone shapes
//! - `json/vtec_pds.py`, `api/1/nws/emergencies.json` — PDS / emergency flags
//! - NWS zone–county correlation file (`bpDDmmYY.dbx`) for county/zone centroids

use super::{fname, load_zst, save_zst, Hist};
use crate::overlays::more::{parse_time, round_geom, vtec_event};
use crate::overlays::Overlays;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use chrono::{DateTime, Datelike, Duration as CDuration, NaiveDate, TimeZone, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

const IEM: &str = "https://mesonet.agron.iastate.edu";
/// Current (still changing) lists are re-fetched after this long.
const LIVE_TTL: Duration = Duration::from_secs(900);
/// Phenomena issued as storm-based polygons (served by IEM's SBW tables).
const POLY: &[&str] = &["TO", "SV", "FF", "MA", "SQ", "EW", "DS", "FA", "FL"];
/// States, territories and marine areas searched for nationwide county/zone-based products.
const ALL_STATES: &[&str] = &[
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
    "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR",
    "VI", "GU", "AS",
];

/// One VTEC event (compact; cached on disk).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Ev {
    pub wfo: String,
    pub ph: String,
    pub sig: String,
    pub eid: u32,
    pub year: i32,
    /// unix ms
    pub issue: i64,
    pub expire: i64,
    /// "Name [ST], Name [ST]"
    #[serde(default)]
    pub loc: String,
    /// polygon centroid [lon, lat]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c: Option<[f32; 2]>,
    /// polygon bbox [w, s, e, n]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bb: Option<[f32; 4]>,
    /// states (from UGC codes) when known
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub st: Vec<String>,
}

impl Ev {
    fn key(&self) -> String {
        format!("{}.{}.{}.{}.{}", self.wfo, self.ph, self.sig, self.eid, self.year)
    }
    fn vtec(&self) -> String {
        format!("{}.{}.{}.{:04}", self.wfo, self.ph, self.sig, self.eid)
    }
    fn states(&self) -> Vec<String> {
        let mut s: Vec<String> = self.st.clone();
        for (_, st) in loc_parts(&self.loc) {
            if !s.contains(&st) {
                s.push(st);
            }
        }
        s
    }
    fn size(&self) -> usize {
        96 + self.loc.len() + self.st.len() * 26
    }
}

/// Lookup tables shared by searches.
#[derive(Default)]
pub struct Aux {
    /// "ST|lower-case name" → [lon, lat] (zone and county centroids)
    zones: Option<(Instant, Arc<HashMap<String, [f32; 2]>>)>,
    flags: Option<(Instant, Arc<Flags>)>,
}

#[derive(Default)]
pub struct Flags {
    pds: HashSet<String>,
    emergency: HashSet<String>,
}

// ---------- helpers ----------

fn ms(v: &Value) -> Option<i64> {
    v.as_str().and_then(parse_time).map(|t| t.timestamp_millis())
}

fn iem_ts(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%MZ").to_string()
}

/// The 4-letter office id used in IEM links.
fn wfo4(wfo: &str) -> String {
    match wfo {
        "AFC" | "AFG" | "AJK" | "HFO" | "GUM" | "PPG" => format!("P{wfo}"),
        "SJU" => "TJSJ".into(),
        w if w.len() == 4 => w.into(),
        w => format!("K{w}"),
    }
}

fn link(e: &Ev) -> String {
    format!("{IEM}/vtec/event/{}-O-NEW-{}-{}-{}-{:04}", e.year, wfo4(&e.wfo), e.ph, e.sig, e.eid)
}

/// "Seminole [OK], Pottawatomie [OK]" → [(Seminole, OK), …]
pub fn loc_parts(s: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut rest = s;
    while let Some(a) = rest.find('[') {
        let Some(b) = rest[a..].find(']').map(|b| a + b) else { break };
        let name = rest[..a].trim().trim_start_matches(',').trim();
        let st = rest[a + 1..b].trim();
        if !name.is_empty() && st.len() == 2 {
            out.push((name.to_string(), st.to_ascii_uppercase()));
        }
        rest = &rest[b + 1..];
    }
    out
}

/// Area-weighted centroid and bbox of a (Multi)Polygon's outer rings.
pub fn geom_stats(g: &Value) -> Option<([f64; 2], [f64; 4])> {
    let polys: Vec<&Value> = match g["type"].as_str()? {
        "Polygon" => vec![&g["coordinates"]],
        "MultiPolygon" => g["coordinates"].as_array()?.iter().collect(),
        _ => return None,
    };
    let (mut ax, mut ay, mut aa) = (0.0, 0.0, 0.0);
    let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for p in polys {
        let Some(ring) = p.get(0).and_then(|r| r.as_array()) else { continue };
        let pts: Vec<(f64, f64)> = ring.iter().filter_map(|c| Some((c.get(0)?.as_f64()?, c.get(1)?.as_f64()?))).collect();
        for w in pts.windows(2) {
            let ((x0, y0), (x1, y1)) = (w[0], w[1]);
            let cr = x0 * y1 - x1 * y0;
            aa += cr;
            ax += (x0 + x1) * cr;
            ay += (y0 + y1) * cr;
        }
        for &(x, y) in &pts {
            sx += x;
            sy += y;
            n += 1.0;
            bb = [bb[0].min(x), bb[1].min(y), bb[2].max(x), bb[3].max(y)];
        }
    }
    if n == 0.0 {
        return None;
    }
    let c = if aa.abs() > 1e-12 { [ax / (3.0 * aa), ay / (3.0 * aa)] } else { [sx / n, sy / n] };
    Some((c, bb))
}

/// f32 → f64 for JSON output without float noise (35.099998 → 35.1).
fn jf(v: f32) -> f64 {
    d4(v as f64)
}

fn d4(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

fn r4(v: f64) -> f32 {
    ((v * 1e4).round() / 1e4) as f32
}

// ---------- parsing ----------

/// `vtec_events_bystate.py` / `vtec_events.py` JSON → events.
pub fn parse_events(v: &Value, year: i32) -> Vec<Ev> {
    let mut out = vec![];
    for e in v["events"].as_array().into_iter().flatten() {
        let (Some(wfo), Some(ph)) = (e["wfo"].as_str(), e["phenomena"].as_str()) else { continue };
        let Some(issue) = ms(&e["issue"]).or(ms(&e["product_issue"])) else { continue };
        let expire = ms(&e["expire"]).or(ms(&e["init_expire"])).unwrap_or(issue);
        // the VTEC year is in the link; it can differ from the list's year around New Year
        let y = e["uri"].as_str().and_then(|u| u.split("year=").nth(1)).and_then(|s| s.get(..4)).and_then(|s| s.parse().ok()).unwrap_or(year);
        out.push(Ev {
            wfo: wfo.to_string(),
            ph: ph.to_string(),
            sig: e["significance"].as_str().unwrap_or("").to_string(),
            eid: e["eventid"].as_u64().unwrap_or(0) as u32,
            year: y,
            issue,
            expire,
            loc: e["locations"].as_str().unwrap_or("").to_string(),
            c: None,
            bb: None,
            st: vec![],
        });
    }
    out
}

/// `sbw_interval.geojson` → one event per (first) polygon, with centroid/bbox.
pub fn parse_sbw(v: &Value) -> Vec<Ev> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let (Some(wfo), Some(ph)) = (p["wfo"].as_str(), p["phenomena"].as_str()) else { continue };
        let Some(issue) = ms(&p["utc_issue"]).or(ms(&p["issue"])) else { continue };
        let sig = p["significance"].as_str().unwrap_or("").to_string();
        let eid = p["eventid"].as_u64().unwrap_or(0) as u32;
        let year = p["year"].as_i64().map(|y| y as i32).unwrap_or_else(|| DateTime::from_timestamp_millis(issue).map(|t| t.year()).unwrap_or(0));
        if !seen.insert(format!("{wfo}.{ph}.{sig}.{eid}.{year}")) {
            continue;
        }
        let ugcs: Vec<String> = match &p["ugclist"] {
            Value::Array(a) => a.iter().filter_map(|s| s.as_str().map(String::from)).collect(),
            Value::String(s) => s.split(|c: char| c == ',' || c.is_whitespace()).filter(|s| !s.is_empty()).map(String::from).collect(),
            _ => vec![],
        };
        let mut st: Vec<String> = vec![];
        for u in &ugcs {
            if let Some(s) = u.get(..2) {
                if !st.iter().any(|x| x == s) {
                    st.push(s.to_string());
                }
            }
        }
        let stats = geom_stats(&f["geometry"]);
        out.push(Ev {
            wfo: wfo.to_string(),
            ph: ph.to_string(),
            sig,
            eid,
            year,
            issue,
            expire: ms(&p["utc_expire"]).or(ms(&p["expire"])).unwrap_or(issue),
            loc: p["locations"].as_str().unwrap_or("").to_string(),
            c: stats.map(|(c, _)| [r4(c[0]), r4(c[1])]),
            bb: stats.map(|(_, b)| [r4(b[0]), r4(b[1]), r4(b[2]), r4(b[3])]),
            st,
        });
    }
    out
}

/// NWS zone–county correlation file → centroid lookup ("ST|name" for zone and county names).
pub fn parse_zones(txt: &str) -> HashMap<String, [f32; 2]> {
    let mut acc: HashMap<String, (f64, f64, u32)> = HashMap::new();
    for line in txt.lines() {
        let f: Vec<&str> = line.split('|').collect();
        if f.len() < 11 {
            continue;
        }
        let (Ok(lat), Ok(lon)) = (f[9].trim().parse::<f64>(), f[10].trim().parse::<f64>()) else { continue };
        let st = f[0].trim();
        let mut add = |name: &str| {
            let k = format!("{st}|{}", name.trim().to_lowercase());
            let e = acc.entry(k).or_insert((0.0, 0.0, 0));
            e.0 += lon;
            e.1 += lat;
            e.2 += 1;
        };
        add(f[3]);
        if f[5].trim() != f[3].trim() {
            add(f[5]);
        }
    }
    acc.into_iter().map(|(k, (x, y, n))| (k, [r4(x / n as f64), r4(y / n as f64)])).collect()
}

/// Which `bpDDmmYY.dbx` to use: the newest one listed whose date has passed.
pub fn pick_zone_file(html: &str, today: NaiveDate) -> Option<String> {
    const MON: [&str; 12] = ["ja", "fe", "mr", "ap", "my", "jn", "jl", "au", "se", "oc", "no", "de"];
    let mut best: Option<(NaiveDate, String)> = None;
    let mut i = 0;
    while let Some(p) = html[i..].find(".dbx") {
        let end = i + p;
        i = end + 4;
        if end < 8 || &html[end - 8..end - 6] != "bp" {
            continue;
        }
        let s = &html[end - 8..end];
        let (dd, mm, yy) = (&s[2..4], &s[4..6], &s[6..8]);
        let (Ok(d), Some(m), Ok(y)) = (dd.parse::<u32>(), MON.iter().position(|x| *x == mm), yy.parse::<i32>()) else { continue };
        let Some(date) = NaiveDate::from_ymd_opt(2000 + y, m as u32 + 1, d) else { continue };
        if date <= today && best.as_ref().map(|(bd, _)| date > *bd).unwrap_or(true) {
            best = Some((date, format!("{s}.dbx")));
        }
    }
    best.map(|b| b.1)
}

/// Flags from the text of a warning and its follow-ups: (pds, emergency, damage threat, detection).
pub fn text_flags(text: &str) -> (bool, bool, Option<String>, Option<String>) {
    let t = text.to_ascii_uppercase();
    let pds = t.contains("PARTICULARLY DANGEROUS SITUATION");
    let emergency = t.contains("TORNADO EMERGENCY") || t.contains("FLASH FLOOD EMERGENCY");
    let rank = |s: &str| match s {
        "CATASTROPHIC" => 3,
        "DESTRUCTIVE" => 2,
        "CONSIDERABLE" => 1,
        _ => 0,
    };
    let mut dmg: Option<String> = None;
    let mut i = 0;
    while let Some(p) = t[i..].find("DAMAGE THREAT...") {
        let s = i + p + "DAMAGE THREAT...".len();
        let w: String = t[s..].chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        if rank(&w) > dmg.as_deref().map(rank).unwrap_or(0) {
            dmg = Some(w);
        }
        i = s;
    }
    let det = t.find("TORNADO...").map(|p| t[p + 10..].lines().next().unwrap_or("").trim().to_string()).filter(|s| !s.is_empty() && s.len() < 40);
    (pds, emergency, dmg, det)
}

/// First "...HEADLINE..." line of a product.
pub fn headline(text: &str) -> Option<String> {
    text.lines().map(|l| l.trim()).find(|l| l.len() > 12 && l.starts_with("...") && l.ends_with("...")).map(|l| l.trim_matches('.').trim().to_string())
}

// ---------- fetching ----------

#[derive(Clone, Debug, PartialEq)]
enum Unit {
    State(String, i32),
    Wfo(String, i32),
    /// storm-based polygons issued on one UTC day, nationwide
    Day(NaiveDate),
}

impl Unit {
    fn key(&self) -> String {
        match self {
            Unit::State(s, y) => format!("st-{s}-{y}"),
            Unit::Wfo(w, y) => format!("wfo-{w}-{y}"),
            Unit::Day(d) => format!("sbw-{}", d.format("%Y%m%d")),
        }
    }
    fn url(&self) -> String {
        match self {
            Unit::State(s, y) => format!("{IEM}/json/vtec_events_bystate.py?state={s}&year={y}"),
            Unit::Wfo(w, y) => format!("{IEM}/json/vtec_events.py?wfo={w}&year={y}"),
            Unit::Day(d) => {
                let a = d.and_hms_opt(0, 0, 0).unwrap().and_utc();
                format!("{IEM}/api/1/vtec/sbw_interval.geojson?begints={}&endts={}", iem_ts(a), iem_ts(a + CDuration::days(1)))
            }
        }
    }
    /// True once the list can no longer change (kept on disk for good).
    fn permanent(&self, now: DateTime<Utc>) -> bool {
        match self {
            Unit::State(_, y) | Unit::Wfo(_, y) => *y < now.year() && now.ordinal() > 20 || *y < now.year() - 1,
            Unit::Day(d) => d.and_hms_opt(0, 0, 0).unwrap().and_utc() < now - CDuration::days(3),
        }
    }
}

async fn unit(o: &Arc<Overlays>, u: &Unit) -> Result<Arc<Vec<Ev>>> {
    let h: &Hist = &o.hist;
    let k = u.key();
    let perm = u.permanent(Utc::now());
    let age = if perm { None } else { Some(LIVE_TTL) };
    if let Some(v) = h.warn_units.get(&k, age) {
        return Ok(v);
    }
    let lock = h.lock_for(&k);
    let _g = lock.lock().await;
    if let Some(v) = h.warn_units.get(&k, age) {
        return Ok(v);
    }
    let path = h.dir.join("warn").join(format!("{}.json.zst", fname(&k)));
    if perm {
        if let Some(v) = load_zst::<Vec<Ev>>(&path, None) {
            let v = Arc::new(v);
            h.warn_units.put(k, v.clone(), v.iter().map(Ev::size).sum());
            return Ok(v);
        }
    }
    let res = o.get_json(&u.url()).await.map(|j| match u {
        Unit::Day(_) => parse_sbw(&j),
        Unit::State(_, y) | Unit::Wfo(_, y) => parse_events(&j, *y),
    });
    match res {
        Ok(v) => {
            if perm {
                save_zst(&path, &v).map_err(|e| tracing::warn!("hist cache: {e:#}")).ok();
            }
            let v = Arc::new(v);
            h.warn_units.put(k, v.clone(), v.iter().map(Ev::size).sum::<usize>() + 64);
            Ok(v)
        }
        Err(e) => h.warn_units.get(&k, None).ok_or(e),
    }
}

async fn zones(o: &Arc<Overlays>) -> Arc<HashMap<String, [f32; 2]>> {
    if let Some((t, z)) = o.hist.warn_aux.lock().zones.clone() {
        if !z.is_empty() || t.elapsed() < Duration::from_secs(3600) {
            return z;
        }
    }
    let lock = o.hist.lock_for("zones");
    let _g = lock.lock().await;
    if let Some((t, z)) = o.hist.warn_aux.lock().zones.clone() {
        if !z.is_empty() || t.elapsed() < Duration::from_secs(3600) {
            return z;
        }
    }
    let file = match o.get_text("https://www.weather.gov/gis/ZoneCounty").await {
        Ok(html) => pick_zone_file(&html, Utc::now().date_naive()),
        Err(_) => None,
    }
    .unwrap_or_else(|| "bp16ap26.dbx".into());
    let url = format!("https://www.weather.gov/source/gis/Shapefiles/County/{file}");
    let z = match o.disk_cached("hist-zones.dbx", Duration::from_secs(86400 * 30), &url).await {
        Ok(b) => parse_zones(&String::from_utf8_lossy(&b)),
        Err(e) => {
            tracing::warn!("zone centroids: {e:#}");
            HashMap::new()
        }
    };
    let z = Arc::new(z);
    o.hist.warn_aux.lock().zones = Some((Instant::now(), z.clone()));
    z
}

async fn flags(o: &Arc<Overlays>) -> Arc<Flags> {
    if let Some((t, f)) = o.hist.warn_aux.lock().flags.clone() {
        if t.elapsed() < Duration::from_secs(3 * 3600) {
            return f;
        }
    }
    let mut f = Flags::default();
    let day = Duration::from_secs(86400);
    if let Ok(b) = o.disk_cached("hist-pds.json", day, &format!("{IEM}/json/vtec_pds.py")).await {
        let v: Value = serde_json::from_slice(&b).unwrap_or_default();
        for e in v["events"].as_array().into_iter().flatten() {
            f.pds.insert(format!("{}.{}.{}.{}.{}", e["wfo"].as_str().unwrap_or(""), e["phenomena"].as_str().unwrap_or(""), e["significance"].as_str().unwrap_or(""), e["eventid"].as_u64().unwrap_or(0), e["year"].as_i64().unwrap_or(0)));
        }
    }
    if let Ok(b) = o.disk_cached("hist-emergencies.json", day, &format!("{IEM}/api/1/nws/emergencies.json")).await {
        let v: Value = serde_json::from_slice(&b).unwrap_or_default();
        for e in v["data"].as_array().into_iter().flatten() {
            f.emergency.insert(format!("{}.{}.{}.{}.{}", e["wfo"].as_str().unwrap_or(""), e["phenomena"].as_str().unwrap_or(""), e["significance"].as_str().unwrap_or(""), e["eventid"].as_u64().unwrap_or(0), e["year"].as_i64().unwrap_or(0)));
        }
    }
    let f = Arc::new(f);
    o.hist.warn_aux.lock().flags = Some((Instant::now(), f.clone()));
    f
}

// ---------- search ----------

fn list(p: &HashMap<String, String>, k: &str, len: usize) -> Vec<String> {
    p.get(k)
        .map(|s| s.split(',').map(|x| x.trim().to_ascii_uppercase()).filter(|x| !x.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|x| if len == 3 && x.len() == 4 { x[1..].to_string() } else { x })
        .filter(|x| x.len() == len && x.chars().all(|c| c.is_ascii_alphanumeric()))
        .collect()
}

/// Search window: `sts`/`ets` (ISO or unix ms), or `year=YYYY[-YYYY]`; default the last year
/// (state/WFO) or the last 7 days (nationwide).
fn window(p: &HashMap<String, String>, nationwide: bool) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let now = Utc::now();
    let g = |k: &str| p.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let jan1 = |y: i32| Utc.with_ymd_and_hms(y, 1, 1, 0, 0, 0).single();
    let (mut s, mut e) = (None, None);
    if let Some(y) = g("year") {
        let (a, b) = y.split_once('-').unwrap_or((y, y));
        let (a, b): (i32, i32) = (a.trim().parse().map_err(|_| anyhow!("bad year"))?, b.trim().parse().map_err(|_| anyhow!("bad year"))?);
        s = jan1(a.min(b));
        e = jan1(a.max(b) + 1);
    }
    if let Some(v) = g("sts") {
        s = Some(parse_time(v).ok_or_else(|| anyhow!("bad sts (ISO 8601 UTC or unix ms)"))?);
    }
    if let Some(v) = g("ets") {
        e = Some(parse_time(v).ok_or_else(|| anyhow!("bad ets (ISO 8601 UTC or unix ms)"))?);
    }
    let e = e.unwrap_or(now).min(now);
    let s = s.unwrap_or(e - CDuration::days(if nationwide { 7 } else { 365 }));
    if s >= e {
        bail!("sts must be before ets");
    }
    if s.year() < 1986 {
        bail!("the archive starts in 1986");
    }
    Ok((s, e))
}

/// `GET /api/hist/warnings` — see module docs; newest first.
pub async fn search(o: &Arc<Overlays>, p: &HashMap<String, String>) -> Result<Value> {
    let states = list(p, "state", 2);
    let wfos = list(p, "wfo", 3);
    let phen = list(p, "phen", 2);
    let sig = list(p, "sig", 1);
    let q = p.get("q").map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let limit = p.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(200).clamp(1, 1000);
    let offset = p.get("offset").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
    let nationwide = states.is_empty() && wfos.is_empty();
    let (s, e) = window(p, nationwide)?;
    let years: Vec<i32> = (s.year()..=e.year()).collect();
    let mut note = None;
    let units: Vec<Unit> = if !wfos.is_empty() {
        wfos.iter().flat_map(|w| years.iter().map(move |y| Unit::Wfo(w.clone(), *y))).collect()
    } else if !states.is_empty() {
        states.iter().flat_map(|st| years.iter().map(move |y| Unit::State(st.clone(), *y))).collect()
    } else {
        if e - s > CDuration::days(31) {
            bail!("nationwide searches are limited to 31 days; add state= or wfo=, or narrow sts/ets");
        }
        if phen.is_empty() || phen.iter().all(|x| POLY.contains(&x.as_str())) {
            if phen.is_empty() {
                note = Some("nationwide search without phen: storm-based (polygon) products only");
            }
            let mut d = s.date_naive();
            let mut v = vec![];
            while d <= e.date_naive() {
                v.push(Unit::Day(d));
                d = d.succ_opt().unwrap();
            }
            v
        } else {
            ALL_STATES.iter().flat_map(|st| years.iter().map(move |y| Unit::State(st.to_string(), *y))).collect()
        }
    };
    if units.len() > 120 {
        bail!("search too large ({} state/office-years); narrow the years or the list of states/offices", units.len());
    }
    let results: Vec<(Unit, Result<Arc<Vec<Ev>>>)> = futures::stream::iter(units.into_iter().map(|u| async move {
        let r = unit(o, &u).await;
        (u, r)
    }))
    .buffer_unordered(6)
    .collect()
    .await;
    let mut errors = vec![];
    let mut sets = vec![];
    for (u, r) in results {
        match r {
            Ok(v) => sets.push(v),
            Err(err) => errors.push(format!("{}: {err:#}", u.key())),
        }
    }
    if sets.is_empty() && !errors.is_empty() {
        bail!("IEM: {}", errors[0]);
    }
    let f = Filter {
        phen,
        sig,
        // a WFO's events can span states: filter them when both are given
        states: if wfos.is_empty() { vec![] } else { states },
        q,
        sts: s.timestamp_millis(),
        ets: e.timestamp_millis(),
    };
    let evs = select(&sets, &f);
    let total = evs.len();
    let page: Vec<&Ev> = evs.iter().skip(offset).take(limit).collect();
    let fl = flags(o).await;
    let zs = if page.iter().any(|e| e.c.is_none()) { zones(o).await } else { Arc::new(HashMap::new()) };
    let items: Vec<Value> = page.iter().map(|e| item(e, &fl, &zs)).collect();
    Ok(json!({
        "total": total, "offset": offset, "limit": limit,
        "sts": s.timestamp_millis(), "ets": e.timestamp_millis(),
        "note": note, "errors": if errors.is_empty() { Value::Null } else { json!(errors) },
        "items": items,
    }))
}

pub struct Filter {
    pub phen: Vec<String>,
    pub sig: Vec<String>,
    pub states: Vec<String>,
    /// lower-case words that must all appear in the area, event name, office or VTEC id
    pub q: String,
    pub sts: i64,
    pub ets: i64,
}

/// Merge event lists (an event listed by several states becomes one, with all its areas), filter,
/// and sort newest first.
pub fn select(sets: &[Arc<Vec<Ev>>], f: &Filter) -> Vec<Ev> {
    let mut merged: HashMap<String, Ev> = HashMap::new();
    for ev in sets.iter().flat_map(|v| v.iter()) {
        if ev.issue > f.ets || ev.expire < f.sts || (!f.phen.is_empty() && !f.phen.contains(&ev.ph)) || (!f.sig.is_empty() && !f.sig.contains(&ev.sig)) {
            continue;
        }
        match merged.get_mut(&ev.key()) {
            Some(m) => {
                m.issue = m.issue.min(ev.issue);
                m.expire = m.expire.max(ev.expire);
                for part in ev.loc.split(", ") {
                    if !part.is_empty() && !m.loc.split(", ").any(|x| x == part) {
                        if !m.loc.is_empty() {
                            m.loc.push_str(", ");
                        }
                        m.loc.push_str(part);
                    }
                }
                if m.c.is_none() {
                    m.c = ev.c;
                    m.bb = ev.bb;
                }
            }
            None => {
                merged.insert(ev.key(), ev.clone());
            }
        }
    }
    let mut evs: Vec<Ev> = merged.into_values().collect();
    if !f.states.is_empty() {
        evs.retain(|e| e.states().iter().any(|s| f.states.contains(s)));
    }
    if !f.q.is_empty() {
        evs.retain(|e| {
            let hay = format!("{} {} {} {}", e.loc, vtec_event(&e.ph, &e.sig), e.wfo, e.vtec()).to_lowercase();
            f.q.split_whitespace().all(|w| hay.contains(w))
        });
    }
    evs.sort_by(|a, b| b.issue.cmp(&a.issue).then(a.wfo.cmp(&b.wfo)));
    evs
}

/// Area centroid and bbox of a location list from zone/county centroids.
fn area_center(loc: &str, zs: &HashMap<String, [f32; 2]>) -> Option<([f32; 2], [f32; 4])> {
    let pts: Vec<[f32; 2]> = loc_parts(loc).iter().filter_map(|(n, st)| zs.get(&format!("{st}|{}", n.to_lowercase())).copied()).collect();
    if pts.is_empty() {
        return None;
    }
    let n = pts.len() as f32;
    let c = [pts.iter().map(|p| p[0]).sum::<f32>() / n, pts.iter().map(|p| p[1]).sum::<f32>() / n];
    // county centroids → pad by ~half a county
    let pad = 0.25;
    let bb = pts.iter().fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |b, p| [b[0].min(p[0] - pad), b[1].min(p[1] - pad), b[2].max(p[0] + pad), b[3].max(p[1] + pad)]);
    Some(([r4(c[0] as f64), r4(c[1] as f64)], bb.map(|v| r4(v as f64))))
}

fn item(e: &Ev, fl: &Flags, zs: &HashMap<String, [f32; 2]>) -> Value {
    let (c, bb) = match (e.c, e.bb) {
        (Some(c), bb) => (Some(c), bb),
        _ => area_center(&e.loc, zs).map(|(c, b)| (Some(c), Some(b))).unwrap_or((None, None)),
    };
    let k = e.key();
    json!({
        "id": format!("{}-{}", e.year, e.vtec()),
        "vtec": e.vtec(),
        "event": vtec_event(&e.ph, &e.sig),
        "phen": e.ph, "sig": e.sig, "wfo": e.wfo, "year": e.year, "eventid": e.eid,
        "issue": e.issue, "expire": e.expire,
        "areaDesc": e.loc,
        "states": e.states(),
        "lat": c.map(|c| jf(c[1])), "lon": c.map(|c| jf(c[0])),
        "bbox": bb.map(|b| b.map(jf)),
        "flags": {"pds": fl.pds.contains(&k), "emergency": fl.emergency.contains(&k)},
        "link": link(e),
    })
}

// ---------- one warning ----------

/// "OUN.TO.W.0042" (also "KOUN.TO.W.42") → (wfo, ph, sig, eventid)
pub fn parse_vtec(s: &str) -> Option<(String, String, String, u32)> {
    let f: Vec<&str> = s.trim().split(['.', '-']).collect();
    if f.len() != 4 {
        return None;
    }
    let w = f[0].trim().to_ascii_uppercase();
    let wfo = if w.len() == 4 { w[1..].to_string() } else { w };
    let (ph, sig) = (f[1].trim().to_ascii_uppercase(), f[2].trim().to_ascii_uppercase());
    let ok = wfo.len() == 3 && ph.len() == 2 && sig.len() == 1 && format!("{wfo}{ph}{sig}").chars().all(|c| c.is_ascii_alphanumeric());
    if !ok {
        return None;
    }
    Some((wfo, ph, sig, f[3].trim().parse().ok()?))
}

/// `GET /api/hist/warning?vtec=OUN.TO.W.0042&year=2024` — GeoJSON of the warning's polygons (every
/// update) or, for county/zone products, its county/zone shapes, with `properties` describing it.
pub async fn detail(o: &Arc<Overlays>, vtec: &str, year: Option<i32>) -> Result<Bytes> {
    let (wfo, ph, sig, eid) = parse_vtec(vtec).ok_or_else(|| anyhow!("vtec must look like OUN.TO.W.0042"))?;
    let now = Utc::now();
    let year = year.unwrap_or(now.year());
    let k = format!("det-{year}-{wfo}-{ph}-{sig}-{eid}");
    let perm = year < now.year() && now.ordinal() > 20 || year < now.year() - 1;
    let age = if perm { None } else { Some(LIVE_TTL) };
    if let Some(b) = o.hist.warn_detail.get(&k, age) {
        return Ok((*b).clone());
    }
    let path = o.hist.dir.join("warn").join(format!("{k}.json.zst"));
    if perm {
        if let Some(v) = load_zst::<Value>(&path, None) {
            let b = Bytes::from(serde_json::to_vec(&v)?);
            o.hist.warn_detail.put(k, Arc::new(b.clone()), b.len());
            return Ok(b);
        }
    }
    let ev = o.get_json(&format!("{IEM}/json/vtec_event.py?wfo={wfo}&year={year}&phenomena={ph}&significance={sig}&etn={eid}")).await?;
    if !ev["event_exists"].as_bool().unwrap_or(false) {
        bail!("warning not found");
    }
    let issue = ms(&ev["utc_issue"]).ok_or_else(|| anyhow!("IEM: no issue time"))?;
    let expire = ms(&ev["utc_expire"]).unwrap_or(issue);
    let a = DateTime::from_timestamp_millis(issue).unwrap() - CDuration::hours(1);
    let b = DateTime::from_timestamp_millis(expire).unwrap() + CDuration::minutes(1);
    let polys = if POLY.contains(&ph.as_str()) {
        o.get_json(&format!("{IEM}/api/1/vtec/sbw_interval.geojson?begints={}&endts={}&wfo={wfo}&ph={ph}&only_new=false", iem_ts(a), iem_ts(b)))
            .await
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let mut v = detail_json(&ev, &polys, &wfo, &ph, &sig, eid, year);
    if v["features"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
        // county/zone based (or a polygon missing upstream): draw the counties/zones
        if let Ok(g) = o.get_json(&format!("{IEM}/geojson/vtec_event.py?wfo={wfo}&year={year}&phenomena={ph}&significance={sig}&etn={eid}")).await {
            add_ugc_shapes(&mut v, &g);
        }
    }
    let fl = flags(o).await;
    let key = format!("{wfo}.{ph}.{sig}.{eid}.{year}");
    if fl.pds.contains(&key) {
        v["properties"]["flags"]["pds"] = json!(true);
    }
    if fl.emergency.contains(&key) {
        v["properties"]["flags"]["emergency"] = json!(true);
    }
    if v["properties"]["lat"].is_null() {
        let zs = zones(o).await;
        if let Some((c, bb)) = area_center(v["properties"]["areaDesc"].as_str().unwrap_or(""), &zs) {
            v["properties"]["lon"] = json!(jf(c[0]));
            v["properties"]["lat"] = json!(jf(c[1]));
            v["properties"]["bbox"] = json!(bb.map(jf));
        }
    }
    if perm && expire < now.timestamp_millis() {
        save_zst(&path, &v).map_err(|e| tracing::warn!("hist cache: {e:#}")).ok();
    }
    let out = Bytes::from(serde_json::to_vec(&v)?);
    o.hist.warn_detail.put(k, Arc::new(out.clone()), out.len());
    Ok(out)
}

/// Build the detail FeatureCollection from `json/vtec_event.py` + `sbw_interval.geojson`.
pub fn detail_json(ev: &Value, polys: &Value, wfo: &str, ph: &str, sig: &str, eid: u32, year: i32) -> Value {
    let issue = ms(&ev["utc_issue"]).unwrap_or(0);
    let expire = ms(&ev["utc_expire"]).unwrap_or(issue);
    let mut loc: Vec<String> = vec![];
    let mut states: Vec<String> = vec![];
    for u in ev["ugcs"].as_array().into_iter().flatten() {
        let st = u["ugc"].as_str().and_then(|s| s.get(..2)).unwrap_or("").to_string();
        let name = format!("{} [{st}]", u["name"].as_str().unwrap_or(""));
        if !loc.contains(&name) {
            loc.push(name);
        }
        if !st.is_empty() && !states.contains(&st) {
            states.push(st);
        }
    }
    let mut texts = vec![ev["report"]["text"].as_str().unwrap_or("").to_string()];
    texts.extend(ev["svs"].as_array().into_iter().flatten().filter_map(|s| s["text"].as_str().map(String::from)));
    let (pds, emergency, dmg, det) = text_flags(&texts.join("\n"));
    let mut feats = vec![];
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut first_c: Option<[f64; 2]> = None;
    let mut fs: Vec<&Value> = polys["features"].as_array().into_iter().flatten().filter(|f| f["properties"]["eventid"].as_u64() == Some(eid as u64) && f["properties"]["significance"].as_str() == Some(sig)).collect();
    fs.sort_by_key(|f| ms(&f["properties"]["utc_polygon_begin"]).unwrap_or(0));
    for f in fs {
        let p = &f["properties"];
        let mut g = f["geometry"].clone();
        round_geom(&mut g, 4);
        if let Some((c, b)) = geom_stats(&g) {
            first_c.get_or_insert(c);
            bb = [bb[0].min(b[0]), bb[1].min(b[1]), bb[2].max(b[2]), bb[3].max(b[3])];
        }
        feats.push(json!({"type": "Feature", "geometry": g, "properties": {
            "kind": "polygon", "status": p["status"], "t0": ms(&p["utc_polygon_begin"]), "t1": ms(&p["utc_polygon_end"]), "product_id": p["product_id"],
        }}));
    }
    let event = vtec_event(ph, sig);
    let e = Ev { wfo: wfo.into(), ph: ph.into(), sig: sig.into(), eid, year, issue, expire, loc: String::new(), c: None, bb: None, st: vec![] };
    json!({
        "type": "FeatureCollection",
        "features": feats,
        "properties": {
            "id": format!("{year}-{}", e.vtec()), "vtec": e.vtec(), "event": event,
            "phen": ph, "sig": sig, "wfo": wfo, "year": year, "eventid": eid,
            "issue": issue, "expire": expire,
            "headline": headline(&texts[0]),
            "areaDesc": loc.join(", "), "states": states,
            "lat": first_c.map(|c| d4(c[1])), "lon": first_c.map(|c| d4(c[0])),
            "bbox": if bb[0] <= bb[2] { json!([d4(bb[0]), d4(bb[1]), d4(bb[2]), d4(bb[3])]) } else { Value::Null },
            "flags": {"pds": pds, "emergency": emergency, "damage_threat": dmg, "tornado_detection": det},
            "updates": ev["svs"].as_array().map(|a| a.len()).unwrap_or(0),
            "text": texts[0],
            "link": link(&e),
        }
    })
}

fn add_ugc_shapes(v: &mut Value, g: &Value) {
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
    let mut out = vec![];
    for f in g["features"].as_array().into_iter().flatten() {
        let mut geom = f["geometry"].clone();
        round_geom(&mut geom, 3);
        if let Some((c, b)) = geom_stats(&geom) {
            sx += c[0];
            sy += c[1];
            n += 1.0;
            bb = [bb[0].min(b[0]), bb[1].min(b[1]), bb[2].max(b[2]), bb[3].max(b[3])];
        }
        out.push(json!({"type": "Feature", "geometry": geom, "properties": {"kind": "ugc", "ugc": f["id"]}}));
    }
    if n > 0.0 {
        v["properties"]["lon"] = json!(d4(sx / n));
        v["properties"]["lat"] = json!(d4(sy / n));
        v["properties"]["bbox"] = json!([d4(bb[0]), d4(bb[1]), d4(bb[2]), d4(bb[3])]);
    }
    if let Some(a) = v["features"].as_array_mut() {
        a.extend(out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYSTATE: &str = r#"{"state":"OK","year":2024,"events":[
      {"ph_name":"Blizzard","sig_name":"Warning","phenomena":"BZ","significance":"W","eventid":1,"hvtec_nwsli":null,"area":14777.0,
       "locations":"Texas [OK], Cimarron [OK], Beaver [OK]","issue":"2024-01-08T09:00:00Z","product_issue":"2024-01-07T19:33:00Z",
       "expire":"2024-01-09T12:00:00Z","init_expire":"2024-01-09T12:00:00Z","uri":"/vtec/?year=2024&wfo=KAMA&phenomena=BZ&significance=W&eventid=0001","wfo":"AMA"},
      {"ph_name":"Tornado","sig_name":"Warning","phenomena":"TO","significance":"W","eventid":1,"hvtec_nwsli":null,"area":519.0,
       "locations":"Seminole [OK]","issue":"2024-03-14T17:18:00Z","product_issue":"2024-03-14T17:18:00Z","expire":"2024-03-14T17:45:00Z",
       "init_expire":"2024-03-14T17:45:00Z","uri":"/vtec/?year=2024&wfo=KOUN&phenomena=TO&significance=W&eventid=0001","wfo":"OUN"}]}"#;

    const SBW: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":[[[[-96.8,35.1],[-96.5,35.1],[-96.5,35.3],[-96.8,35.3],[-96.8,35.1]]]]},
       "properties":{"ugclist":"OKC133","locations":"Seminole [OK]","utc_issue":"2024-03-14T17:18:00Z","utc_expire":"2024-03-14T17:45:00Z",
       "utc_polygon_begin":"2024-03-14T17:18:00Z","utc_polygon_end":"2024-03-14T17:30:00Z","ph_sig":"TO.W","wfo":"OUN","eventid":1,
       "phenomena":"TO","significance":"W","status":"NEW","product_id":"202403141718-KOUN-WFUS54-TOROUN","year":2024}},
      {"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":[[[[-96.7,35.15],[-96.5,35.15],[-96.5,35.3],[-96.7,35.3],[-96.7,35.15]]]]},
       "properties":{"ugclist":"OKC133","locations":"Seminole [OK]","utc_issue":"2024-03-14T17:18:00Z","utc_expire":"2024-03-14T17:45:00Z",
       "utc_polygon_begin":"2024-03-14T17:30:00Z","utc_polygon_end":"2024-03-14T17:39:00Z","wfo":"OUN","eventid":1,
       "phenomena":"TO","significance":"W","status":"CON","product_id":"202403141730-KOUN-WWUS54-SVSOUN","year":2024}}]}"#;

    #[test]
    fn bystate() {
        let v: Value = serde_json::from_str(BYSTATE).unwrap();
        let e = parse_events(&v, 2024);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].wfo, "AMA");
        assert_eq!(e[0].issue, parse_time("2024-01-08T09:00:00Z").unwrap().timestamp_millis());
        assert_eq!(e[1].vtec(), "OUN.TO.W.0001");
        assert_eq!(e[0].states(), vec!["OK".to_string()]);
        assert_eq!(link(&e[1]), "https://mesonet.agron.iastate.edu/vtec/event/2024-O-NEW-KOUN-TO-W-0001");
    }

    #[test]
    fn sbw() {
        let v: Value = serde_json::from_str(SBW).unwrap();
        let e = parse_sbw(&v);
        assert_eq!(e.len(), 1, "follow-up polygons collapse into the event");
        let c = e[0].c.unwrap();
        assert!((c[0] + 96.65).abs() < 0.01 && (c[1] - 35.2).abs() < 0.01);
        assert_eq!(e[0].bb.unwrap().map(jf), [-96.8, 35.1, -96.5, 35.3]);
        assert_eq!(e[0].st, vec!["OK".to_string()]);
    }

    #[test]
    fn locations_and_zones() {
        assert_eq!(loc_parts("Texas [OK], Cimarron [OK]"), vec![("Texas".into(), "OK".into()), ("Cimarron".into(), "OK".into())]);
        let z = parse_zones("OK|001|AMA|Cimarron|OK001|Cimarron|40025|C|pa|36.7483|-102.5178\nNM|201|ABQ|Northwest Plateau|NM201|McKinley|35031|M|nw|36.4270|-108.4064\nNM|201|ABQ|Northwest Plateau|NM201|San Juan|35045|M|nw|36.4270|-108.4064\n");
        assert_eq!(z["OK|cimarron"], [-102.5178, 36.7483]);
        assert_eq!(z["NM|northwest plateau"], [-108.4064, 36.427]);
        assert!(z.contains_key("NM|san juan"));
        let (c, bb) = area_center("Cimarron [OK], Nowhere [OK]", &z).unwrap();
        assert_eq!(c, [-102.5178, 36.7483]);
        assert!(bb[0] < c[0] && bb[2] > c[0]);
    }

    #[test]
    fn zone_file_pick() {
        let html = r#"<a href="/source/gis/Shapefiles/County/bp18mr25.dbx">bp18mr25.dbx</a> <a href="x/bp16ap26.dbx">"#;
        assert_eq!(pick_zone_file(html, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()).as_deref(), Some("bp18mr25.dbx"));
        assert_eq!(pick_zone_file(html, NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()).as_deref(), Some("bp16ap26.dbx"));
    }

    #[test]
    fn vtec_ids() {
        assert_eq!(parse_vtec("OUN.TO.W.0042"), Some(("OUN".into(), "TO".into(), "W".into(), 42)));
        assert_eq!(parse_vtec("koun.to.w.42"), Some(("OUN".into(), "TO".into(), "W".into(), 42)));
        assert_eq!(parse_vtec("OUN.TO.W"), None);
    }

    #[test]
    fn text() {
        let t = "...TORNADO EMERGENCY FOR MOORE...\nTHIS IS A PARTICULARLY DANGEROUS SITUATION.\nTORNADO...OBSERVED\nTORNADO DAMAGE THREAT...CONSIDERABLE\nTORNADO DAMAGE THREAT...CATASTROPHIC\n";
        let (pds, em, dmg, det) = text_flags(t);
        assert!(pds && em);
        assert_eq!(dmg.as_deref(), Some("CATASTROPHIC"));
        assert_eq!(det.as_deref(), Some("OBSERVED"));
        assert_eq!(headline(t).as_deref(), Some("TORNADO EMERGENCY FOR MOORE"));
    }

    #[test]
    fn detail_shape() {
        let ev: Value = serde_json::from_str(r#"{"event_exists":true,"utc_issue":"2024-03-14T17:18:00Z","utc_expire":"2024-03-14T17:45:00Z",
            "report":{"text":"TORNADO...RADAR INDICATED\nMAX HAIL SIZE...1.00 IN"},"svs":[{"text":"x"},{"text":"TORNADO DAMAGE THREAT...CONSIDERABLE"}],
            "ugcs":[{"ugc":"OKC133","name":"Seminole"}]}"#).unwrap();
        let polys: Value = serde_json::from_str(SBW).unwrap();
        let v = detail_json(&ev, &polys, "OUN", "TO", "W", 1, 2024);
        assert_eq!(v["features"].as_array().unwrap().len(), 2);
        assert_eq!(v["features"][1]["properties"]["status"], "CON");
        let p = &v["properties"];
        assert_eq!(p["vtec"], "OUN.TO.W.0001");
        assert_eq!(p["areaDesc"], "Seminole [OK]");
        assert_eq!(p["flags"]["damage_threat"], "CONSIDERABLE");
        assert_eq!(p["flags"]["tornado_detection"], "RADAR INDICATED");
        assert_eq!(p["bbox"], json!([-96.8, 35.1, -96.5, 35.3]));
        assert_eq!(p["updates"], 2);
    }

    #[test]
    fn merge_and_filter() {
        let v: Value = serde_json::from_str(BYSTATE).unwrap();
        let ok = Arc::new(parse_events(&v, 2024));
        // the same blizzard listed by the Texas query with Texas counties
        let mut tx = ok[0].clone();
        tx.loc = "Dallam [TX], Texas [OK]".into();
        let tx = Arc::new(vec![tx]);
        let all = Filter { phen: vec![], sig: vec![], states: vec![], q: String::new(), sts: 0, ets: i64::MAX };
        let r = select(&[ok.clone(), tx.clone()], &all);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].ph, "TO", "newest first");
        assert_eq!(r[1].loc, "Texas [OK], Cimarron [OK], Beaver [OK], Dallam [TX]");
        assert_eq!(r[1].states(), vec!["OK".to_string(), "TX".to_string()]);
        let f = Filter { phen: vec!["BZ".into()], ..all };
        assert_eq!(select(&[ok.clone()], &f).len(), 1);
        let f = Filter { phen: vec![], q: "seminole tornado".into(), ..f };
        assert_eq!(select(&[ok.clone()], &f)[0].eid, 1);
        let f = Filter { q: "oun.to.w.0001".into(), ..f };
        assert_eq!(select(&[ok.clone()], &f).len(), 1);
        let t = parse_time("2024-03-01T00:00:00Z").unwrap().timestamp_millis();
        let f = Filter { q: String::new(), sts: t, ..f };
        assert_eq!(select(&[ok.clone()], &f).len(), 1, "time window");
        let f = Filter { states: vec!["TX".into()], sts: 0, ..f };
        assert_eq!(select(&[ok, tx], &f).len(), 1, "state filter");
    }

    #[test]
    fn units() {
        let now = parse_time("2026-10-12T00:00:00Z").unwrap();
        assert!(Unit::State("OK".into(), 2024).permanent(now));
        assert!(!Unit::State("OK".into(), 2026).permanent(now));
        assert!(Unit::Day(NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()).permanent(now));
        assert!(!Unit::Day(NaiveDate::from_ymd_opt(2026, 10, 11).unwrap()).permanent(now));
        assert!(Unit::Day(NaiveDate::from_ymd_opt(2024, 5, 1).unwrap()).url().contains("begints=2024-05-01T00:00Z&endts=2024-05-02T00:00Z"));
    }
}
