//! Server-side rule evaluation (24/7, no app needed). Rules stay in the app's shape
//! (`GET/PUT /api/rules`, see app/src/rules/engine.ts); a rule runs here when it has
//! `run_on: "server"` or `"both"` (default "app"). Every 30 s the enabled server rules are
//! checked; each feed is fetched only when a rule needs it (and comes from the overlay cache).
//!
//! Server-only rule fields:
//! * `cond.at: {lat, lon, label?}` — the point to check (the app's saved points / GPS / route
//!   live on the device, so the app copies the point here). `cond.lat` / `cond.lon` also work.
//! * `act.channels: ["<channel id>" | "*"]` — notification channels (crate::notify)
//! * `act.webhook` — POSTed by the server (SSRF guard), `act.level`: low|normal|high|urgent
//! * `cooldown` (minutes) as in the app; quiet hours = the notification settings' quiet hours
//!   (messages are delivered silently).
//!
//! Condition kinds: the app's `alert rotation lightning eta aqi metar spc dbz mldet`, plus
//! `same` (SAME message from the radio monitor: `event` code/name substring, optional `fips`
//! list of 5-digit county codes ("SS000" = whole state), optional `station`) and `metar` with
//! `source: "pws"` (personal weather stations).
//!
//! * `GET  /api/rules/log?limit=` → `{log:[{t, rule_id, rule, msg, results, test}], state:{id:{hit,text,t}}, interval_s}`
//! * `POST /api/rules/server-test {id}` or `{rule}` → runs the condition now and the server actions as a test

use crate::api::AppState;
use crate::notify::Msg;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const INTERVAL_S: u64 = 30;
const MI: f64 = 1609.344;
const KEEP: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub key: String,
    pub msg: String,
    pub vars: Map<String, Value>,
}

pub struct ServerRules {
    path: PathBuf,
    pub log: RwLock<VecDeque<Value>>,
    pub state: RwLock<HashMap<String, Value>>,
    fired: Mutex<HashMap<String, i64>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl ServerRules {
    pub fn new(data: &std::path::Path) -> Arc<ServerRules> {
        let path = data.join("rules_log.json");
        let log = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(ServerRules { path, log: RwLock::new(log), state: RwLock::new(HashMap::new()), fired: Mutex::new(HashMap::new()) })
    }
    fn add_log(&self, e: Value) {
        {
            let mut l = self.log.write();
            l.push_front(e);
            l.truncate(KEEP);
        }
        let b = serde_json::to_vec(&*self.log.read()).unwrap_or_default();
        let _ = crate::platform::write_atomic(&self.path, &b);
    }
}

/// Rules from the shared store that run on the server.
pub fn server_rules(all: &Value) -> Vec<Value> {
    all.as_array()
        .map(|a| a.iter().filter(|r| r["on"].as_bool().unwrap_or(false) && matches!(r["run_on"].as_str(), Some("server") | Some("both"))).cloned().collect())
        .unwrap_or_default()
}

// ---------- geometry ----------

pub fn distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_008.8;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = p2 - p1;
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().atan2((1.0 - a).sqrt())
}

/// Distance (m) from a point to a GeoJSON polygon: 0 inside, else to its nearest vertex.
pub fn dist_to_geom(lat: f64, lon: f64, g: &Value) -> f64 {
    if g.is_null() {
        return f64::INFINITY;
    }
    if crate::recorder::geom_contains(g, lon, lat) {
        return 0.0;
    }
    fn walk(a: &Value, lat: f64, lon: f64, best: &mut f64) {
        if let Some(arr) = a.as_array() {
            if arr.len() >= 2 && arr[0].is_number() {
                let d = distance(lat, lon, arr[1].as_f64().unwrap_or(0.0), arr[0].as_f64().unwrap_or(0.0));
                if d < *best {
                    *best = d;
                }
            } else {
                for x in arr {
                    walk(x, lat, lon, best);
                }
            }
        }
    }
    let mut best = f64::INFINITY;
    walk(&g["coordinates"], lat, lon, &mut best);
    best
}

pub fn fmt_mi(m: f64) -> String {
    let mi = m / MI;
    if mi < 10.0 { format!("{:.1} mi", mi) } else { format!("{} mi", mi.round()) }
}

/// Minutes until a cell's projected track (dir_to / sknt) passes within `radius` of a point.
pub fn cell_eta(clat: f64, clon: f64, p: &Value, lat: f64, lon: f64, radius: f64, horizon_min: f64) -> Option<i64> {
    let k = (clat.to_radians()).cos() * 111_195.0;
    let dx = (lon - clon) * k;
    let dy = (lat - clat) * 111_195.0;
    if dx.hypot(dy) < radius {
        return Some(0);
    }
    let dir = p["dir_to"].as_f64()?;
    let sknt = p["sknt"].as_f64().filter(|v| *v > 0.0)?;
    let mpm = sknt * 1852.0 / 60.0;
    let a = dir.to_radians();
    let (ux, uy) = (a.sin(), a.cos());
    let along = dx * ux + dy * uy;
    let cross = (dx * uy - dy * ux).abs();
    if along < 0.0 || along > mpm * horizon_min + radius || cross > radius {
        return None;
    }
    Some((along / mpm).round().max(0.0) as i64)
}

pub fn meso_rank(p: &Value) -> i64 {
    match &p["meso"] {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.trim().chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0),
        _ => 0,
    }
}
pub fn has_tvs(p: &Value) -> bool {
    match &p["tvs"] {
        Value::String(s) => !s.is_empty() && !s.eq_ignore_ascii_case("NONE"),
        Value::Bool(b) => *b,
        Value::Null => false,
        _ => true,
    }
}

const SPC_NAME: [&str; 6] = ["general thunderstorms", "marginal", "slight", "enhanced", "moderate", "high"];
fn spc_level(label: &str) -> Option<usize> {
    ["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"].iter().position(|x| x.eq_ignore_ascii_case(label))
}

// ---------- feeds (fetched lazily, once per evaluation) ----------

/// Data a condition can read: the server's services, or fixtures in tests (`Ctx::fixed`).
pub struct Ctx<'a> {
    st: Option<&'a AppState>,
    /// overlay id + params → parsed JSON (cache for this evaluation round, or test fixtures)
    pub cache: HashMap<String, Value>,
    pub alerts: Option<Vec<Value>>,
    pub same: Option<Vec<crate::radio::SameMsg>>,
    pub ml: Option<Value>,
    pub dbz: HashMap<String, Option<f64>>,
}

impl<'a> Ctx<'a> {
    pub fn new(st: &'a AppState) -> Self {
        Ctx { st: Some(st), cache: HashMap::new(), alerts: None, same: None, ml: None, dbz: HashMap::new() }
    }
    /// For tests: everything comes from the given fixtures.
    pub fn fixed() -> Ctx<'static> {
        Ctx { st: None, cache: HashMap::new(), alerts: Some(vec![]), same: Some(vec![]), ml: Some(json!({"features": []})), dbz: HashMap::new() }
    }
    async fn overlay(&mut self, id: &str, params: &[(&str, String)]) -> Value {
        let ck = format!("{id}?{}", params.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
        if let Some(v) = self.cache.get(&ck).or_else(|| self.cache.get(id)) {
            return v.clone();
        }
        let v = match self.st {
            Some(st) => {
                let q: crate::overlays::Params = params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
                let keys = st.cfg.read().keys.clone();
                match st.overlays.get(id, &q, &keys).await {
                    Ok(b) => serde_json::from_slice(&b).unwrap_or(Value::Null),
                    Err(e) => {
                        tracing::debug!("server rules: {id}: {e:#}");
                        Value::Null
                    }
                }
            }
            None => Value::Null,
        };
        self.cache.insert(ck, v.clone());
        v
    }
    fn alerts(&mut self) -> Vec<Value> {
        if self.alerts.is_none() {
            self.alerts = Some(self.st.map(|st| st.alerts.current.read().values().cloned().collect()).unwrap_or_default());
        }
        self.alerts.clone().unwrap_or_default()
    }
    fn same(&mut self) -> Vec<crate::radio::SameMsg> {
        if self.same.is_none() {
            self.same = Some(self.st.map(|st| st.radio.since(now_ms() - 15 * 60_000, 500)).unwrap_or_default());
        }
        self.same.clone().unwrap_or_default()
    }
    fn ml(&mut self) -> Value {
        if self.ml.is_none() {
            self.ml = Some(self.st.map(|st| st.ml.runner.geojson(now_ms() - 20 * 60_000, &[], None)).unwrap_or(json!({"features": []})));
        }
        self.ml.clone().unwrap_or(Value::Null)
    }
    async fn dbz_at(&mut self, lat: f64, lon: f64) -> Option<f64> {
        let k = format!("{lat:.3},{lon:.3}");
        if let Some(v) = self.dbz.get(&k) {
            return *v;
        }
        let v = match self.st {
            Some(st) => {
                let key = match self.cache.get("_mrms_key").and_then(|v| v.as_str().map(str::to_string)) {
                    Some(k) => Some(k),
                    None => {
                        let k = st.grids.frames("cref", 1, None, None, None).await.ok().and_then(|f| f.frames.last().map(|x| x.key.clone()));
                        self.cache.insert("_mrms_key".into(), json!(k));
                        k
                    }
                };
                match key {
                    Some(key) => st.grids.value(&key, lat, lon).await.ok().flatten().map(|v| v as f64),
                    None => None,
                }
            }
            None => None,
        };
        self.dbz.insert(k, v);
        v
    }
}

fn feats(v: &Value) -> Vec<Value> {
    v["features"].as_array().cloned().unwrap_or_default()
}
fn pt(f: &Value) -> Option<(f64, f64)> {
    let c = &f["geometry"]["coordinates"];
    Some((c[1].as_f64()?, c[0].as_f64()?))
}
fn vars(pairs: &[(&str, String)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), json!(v))).collect()
}

/// The rule's point: `cond.at {lat, lon, label}` or `cond.lat/lon`.
pub fn rule_point(c: &Value) -> Option<(f64, f64, String)> {
    let at = &c["at"];
    let (lat, lon) = match (at["lat"].as_f64(), at["lon"].as_f64()) {
        (Some(a), Some(b)) => (a, b),
        _ => (c["lat"].as_f64()?, c["lon"].as_f64()?),
    };
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return None;
    }
    let label = at["label"].as_str().or(at["name"].as_str()).or(c["label"].as_str()).unwrap_or("the rule's point").to_string();
    Some((lat, lon, label))
}

/// Evaluate one rule's condition.
pub async fn check(rule: &Value, cx: &mut Ctx<'_>) -> Result<Option<Hit>, String> {
    let c = &rule["cond"];
    let kind = c["kind"].as_str().unwrap_or("");
    let num = |k: &str, d: f64| c[k].as_f64().unwrap_or(d);
    let r = num("mi", 10.0) * MI;
    if kind == "same" {
        return Ok(check_same(c, cx));
    }
    let Some((lat, lon, label)) = rule_point(c) else {
        return Err("no location: server rules need cond.at {lat, lon}".into());
    };
    match kind {
        "alert" => {
            let want = c["event"].as_str().unwrap_or("Warning").to_lowercase();
            for a in cx.alerts() {
                let p = &a["properties"];
                let ev = p["event"].as_str().unwrap_or("");
                if !ev.to_lowercase().contains(&want) {
                    continue;
                }
                let d = dist_to_geom(lat, lon, &a["geometry"]);
                if d <= r {
                    let area: Vec<&str> = p["areaDesc"].as_str().unwrap_or("").split(';').map(str::trim).take(3).collect();
                    let msg = if d > 0.0 { format!("{ev} {} from {label}", fmt_mi(d)) } else { format!("{ev} covers {label}") };
                    let key = p["id"].as_str().or(a["id"].as_str()).unwrap_or(ev).to_string();
                    return Ok(Some(Hit { key, msg, vars: vars(&[("event", ev.into()), ("dist", if d > 0.0 { fmt_mi(d) } else { "0".into() }), ("place", label.clone()), ("area", area.join(","))]) }));
                }
            }
            Ok(None)
        }
        "rotation" | "eta" => {
            let fc = cx.overlay("stormattr", &[]).await;
            for f in feats(&fc) {
                let Some((clat, clon)) = pt(&f) else { continue };
                let p = &f["properties"];
                let id = format!("{}-{}", p["nexrad"].as_str().unwrap_or(""), p["storm_id"].as_str().map(str::to_string).unwrap_or_else(|| p["storm_id"].to_string()));
                if kind == "rotation" {
                    let ok = if c["rot"].as_str() == Some("tvs") { has_tvs(p) } else { meso_rank(p) as f64 >= num("value", 5.0) || has_tvs(p) };
                    if !ok {
                        continue;
                    }
                    let d = distance(lat, lon, clat, clon);
                    if d <= r {
                        let what = if has_tvs(p) { "TVS".to_string() } else { format!("Mesocyclone rank {}", meso_rank(p)) };
                        return Ok(Some(Hit { key: id, msg: format!("{what} {} from {label}", fmt_mi(d)), vars: vars(&[("event", what), ("dist", fmt_mi(d)), ("place", label.clone())]) }));
                    }
                } else if let Some(m) = cell_eta(clat, clon, p, lat, lon, r.max(3000.0), 60.0) {
                    if m as f64 <= num("value", 20.0) {
                        let sid = p["storm_id"].as_str().unwrap_or("");
                        return Ok(Some(Hit { key: id, msg: format!("Storm {sid} reaches {label} in ~{m} min"), vars: vars(&[("event", "Storm".into()), ("min", m.to_string()), ("place", label.clone()), ("dist", String::new())]) }));
                    }
                }
            }
            Ok(None)
        }
        "lightning" => {
            let minutes = num("minutes", 15.0).clamp(5.0, 60.0).round();
            let fc = cx.overlay("glm", &[("minutes", (minutes as i64).to_string())]).await;
            let mut best: Option<(f64, f64)> = None;
            for f in feats(&fc) {
                let Some((flat, flon)) = pt(&f) else { continue };
                let age_min = f["properties"]["age"].as_f64().unwrap_or(0.0) / 60.0;
                if age_min > minutes {
                    continue;
                }
                let d = distance(lat, lon, flat, flon);
                if d <= r && best.map(|b| d < b.0).unwrap_or(true) {
                    best = Some((d, age_min));
                }
            }
            Ok(best.map(|(d, age)| Hit { key: String::new(), msg: format!("Lightning {} from {label} ({} min ago)", fmt_mi(d), age.round()), vars: vars(&[("event", "Lightning".into()), ("dist", fmt_mi(d)), ("place", label.clone())]) }))
        }
        "aqi" => {
            let fc = cx.overlay("airquality", &[]).await;
            let max = r.max(30_000.0);
            let mut best: Option<(f64, f64)> = None; // (aqi, dist)
            for f in feats(&fc) {
                let (Some((flat, flon)), Some(a)) = (pt(&f), f["properties"]["aqi"].as_f64().or_else(|| f["properties"]["aqi"].as_str().and_then(|s| s.parse().ok()))) else { continue };
                let d = distance(lat, lon, flat, flon);
                if d > max {
                    continue;
                }
                best = match best {
                    None => Some((a, d)),
                    Some((ba, bd)) if d < bd - 5000.0 || ((d - bd).abs() < 5000.0 && a > ba) => Some((a, d)),
                    b => b,
                };
            }
            if let Some((a, _)) = best {
                if a > num("value", 150.0) {
                    return Ok(Some(Hit { key: ((a / 50.0).floor() as i64).to_string(), msg: format!("AQI {} near {label}", a.round()), vars: vars(&[("event", "Air quality".into()), ("value", a.round().to_string()), ("place", label.clone())]) }));
                }
            }
            Ok(None)
        }
        "metar" => {
            let pws = c["source"].as_str() == Some("pws");
            let fc = if pws {
                let d = 0.5;
                cx.overlay("pws", &[("bbox", format!("{:.2},{:.2},{:.2},{:.2}", lon - d, lat - d, lon + d, lat + d)), ("minutes", "60".into())]).await
            } else {
                cx.overlay("metar", &[]).await
            };
            let mut best: Option<(f64, Value)> = None;
            for f in feats(&fc) {
                let Some((flat, flon)) = pt(&f) else { continue };
                let d = distance(lat, lon, flat, flon);
                if best.as_ref().map(|b| d < b.0).unwrap_or(true) {
                    best = Some((d, f["properties"].clone()));
                }
            }
            let Some((d, p)) = best else { return Ok(None) };
            if d > r.max(15_000.0) {
                return Ok(None);
            }
            let id = p["id"].as_str().map(str::to_string).unwrap_or_else(|| p["id"].to_string());
            let t_c = if pws { p["temp_c"].as_f64() } else { p["t"].as_f64() };
            let g_kt = if pws { p["gust_kt"].as_f64() } else { p["wg"].as_f64() };
            let t_f = t_c.map(|t| t * 1.8 + 32.0);
            let gust = g_kt.map(|g| g * 1.15078);
            let v = num("value", 50.0);
            match c["field"].as_str().unwrap_or("gust") {
                "gust" => Ok(gust.filter(|g| *g >= v).map(|g| Hit { key: String::new(), msg: format!("{id} gust {} mph near {label}", g.round()), vars: vars(&[("event", "Wind gust".into()), ("value", g.round().to_string()), ("place", label.clone())]) })),
                "temp_hi" => Ok(t_f.filter(|t| *t >= v).map(|t| Hit { key: String::new(), msg: format!("{id} temperature {}°F near {label}", t.round()), vars: vars(&[("event", "Temperature".into()), ("value", t.round().to_string()), ("place", label.clone())]) })),
                "temp_lo" => Ok(t_f.filter(|t| *t <= v).map(|t| Hit { key: String::new(), msg: format!("{id} temperature {}°F near {label}", t.round()), vars: vars(&[("event", "Temperature".into()), ("value", t.round().to_string()), ("place", label.clone())]) })),
                _ => Ok(None),
            }
        }
        "spc" => {
            let fc = cx.overlay("spc", &[("day", "1".into()), ("kind", "cat".into())]).await;
            let mut best: Option<(usize, String)> = None;
            for f in feats(&fc) {
                let lab = f["properties"]["label"].as_str().or(f["properties"]["LABEL"].as_str()).unwrap_or("").to_uppercase();
                let Some(lv) = spc_level(&lab) else { continue };
                if best.as_ref().map(|b| lv <= b.0).unwrap_or(false) {
                    continue;
                }
                if crate::recorder::geom_contains(&f["geometry"], lon, lat) {
                    best = Some((lv, lab));
                }
            }
            match best {
                Some((lv, lab)) if lv as f64 >= num("value", 2.0) => Ok(Some(Hit { key: lab.clone(), msg: format!("SPC day 1: {} risk ({lab}) for {label}", SPC_NAME[lv]), vars: vars(&[("event", format!("{} risk", SPC_NAME[lv])), ("value", lab), ("place", label.clone())]) })),
                _ => Ok(None),
            }
        }
        "dbz" => {
            let v = cx.dbz_at(lat, lon).await;
            match v {
                Some(v) if v >= num("value", 50.0) => Ok(Some(Hit { key: String::new(), msg: format!("Radar {} dBZ at {label}", v.round()), vars: vars(&[("event", "Radar".into()), ("value", v.round().to_string()), ("place", label.clone())]) })),
                _ => Ok(None),
            }
        }
        "mldet" => {
            let fc = cx.ml();
            let minp = num("value", 50.0) / 100.0;
            let maxp = c["maxp"].as_f64().map(|x| x / 100.0 + 1e-9);
            let model = c["model"].as_str().unwrap_or("");
            let cut = now_ms() - 20 * 60_000;
            for f in feats(&fc) {
                let p = &f["properties"];
                if p["kind"].as_str() == Some("outline") || p["test"].as_bool().unwrap_or(false) {
                    continue;
                }
                let prob = p["prob"].as_f64().unwrap_or(0.0);
                let t = p["t"].as_i64().or(p["created"].as_i64()).unwrap_or(0);
                if t < cut || prob < minp || maxp.map(|m| prob > m).unwrap_or(false) || (!model.is_empty() && p["model_id"].as_str() != Some(model)) {
                    continue;
                }
                let (dlat, dlon) = match (p["lat"].as_f64(), p["lon"].as_f64()) {
                    (Some(a), Some(b)) => (a, b),
                    _ => match pt(&f) {
                        Some(x) => x,
                        None => continue,
                    },
                };
                let d = distance(lat, lon, dlat, dlon);
                if d <= r {
                    let what = format!("{} detection ({}%, {})", p["target"].as_str().unwrap_or("model"), (prob * 100.0).round(), p["model_name"].as_str().unwrap_or(""));
                    let key = format!("{}|{}", p["model_id"].as_str().unwrap_or(""), p["cell_id"].as_str().or(p["site"].as_str()).unwrap_or(""));
                    return Ok(Some(Hit { key, msg: format!("{what} {} from {label}", fmt_mi(d)), vars: vars(&[("event", what), ("dist", fmt_mi(d)), ("place", label.clone()), ("value", (prob * 100.0).round().to_string())]) }));
                }
            }
            Ok(None)
        }
        k => Err(format!("condition {k:?} can't run on the server")),
    }
}

fn fips_match(want: &[String], got: &[String]) -> bool {
    want.is_empty()
        || want.iter().any(|w| {
            got.iter().any(|g| {
                g == w
                    || (g.len() == 5 && g.ends_with("000") && w.get(..2) == g.get(..2)) // message covers the whole state
                    || (w.len() == 5 && w.ends_with("000") && w.get(..2) == g.get(..2)) // rule watches a whole state
                    || g == "00000"
            })
        })
}

fn check_same(c: &Value, cx: &mut Ctx<'_>) -> Option<Hit> {
    let want = c["event"].as_str().unwrap_or("").trim().to_lowercase();
    let fips: Vec<String> = c["fips"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.trim().to_string())).collect()).unwrap_or_default();
    let station = c["station"].as_str().unwrap_or("");
    let msgs = cx.same();
    for m in msgs.iter().rev() {
        if m.kind != "header" || m.test || (!station.is_empty() && m.station != station) {
            continue;
        }
        let h = m.header.clone().unwrap_or(Value::Null);
        let code = h["event"].as_str().unwrap_or("").to_lowercase();
        let name = h["event_name"].as_str().unwrap_or("").to_string();
        if !want.is_empty() && code != want && !name.to_lowercase().contains(&want) {
            continue;
        }
        if !fips_match(&fips, &m.fips) {
            continue;
        }
        let areas: Vec<String> = h["locations"].as_array().map(|a| a.iter().filter_map(|l| l["name"].as_str().map(str::to_string)).take(4).collect()).unwrap_or_default();
        let st = if m.station_name.is_empty() { m.station.clone() } else { m.station_name.clone() };
        let ev = if name.is_empty() { m.raw.clone() } else { name };
        // keyed by the header text: the same warning heard again (re-broadcast, or on several
        // monitored stations) stays within the rule's cooldown
        return Some(Hit { key: format!("same|{}", m.raw), msg: format!("{ev} for {} (SAME on {st})", areas.join("; ")), vars: vars(&[("event", ev), ("place", areas.join("; ")), ("station", st), ("raw", m.raw.clone())]) });
    }
    None
}

pub fn fill(t: &str, rule: &Value, h: &Hit) -> String {
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('}') {
            Some(j) if after[..j].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
                let k = &after[..j];
                out.push_str(&match k {
                    "rule" => rule["name"].as_str().unwrap_or("").to_string(),
                    "msg" => h.msg.clone(),
                    _ => h.vars.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                });
                rest = &after[j + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Message for a rule hit (title = rule name, body = `act.tts` template or the hit text).
pub fn message(rule: &Value, h: &Hit, silent: bool, test: bool) -> Msg {
    let a = &rule["act"];
    let name = rule["name"].as_str().unwrap_or("Rule").to_string();
    let body = match a["text"].as_str().or(a["tts"].as_str()) {
        Some(t) if !t.trim().is_empty() => fill(t, rule, h),
        _ => h.msg.clone(),
    };
    let level = a["level"].as_str().map(str::to_string).unwrap_or_else(|| {
        let ev = h.vars.get("event").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if ev.contains("tornado") || ev.contains("tvs") || ev.contains("emergency") { "urgent".into() } else if ev.contains("warning") { "high".into() } else { "normal".into() }
    });
    Msg { title: name.clone(), body, level, silent, url: None, rule: name, vars: h.vars.clone(), test }
}

/// Run a rule's server actions; returns per-target results.
pub async fn run_actions(st: &AppState, rule: &Value, h: &Hit, test: bool) -> Vec<Value> {
    let silent = !test && st.notify.quiet_now();
    let m = message(rule, h, silent, test);
    let a = &rule["act"];
    let mut results = vec![];
    let chans: Vec<String> = a["channels"].as_array().map(|x| x.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    if !chans.is_empty() {
        results.extend(st.notify.send_to(&chans, &m).await);
    }
    if let Some(url) = a["webhook"].as_str().filter(|u| !u.trim().is_empty()) {
        let ch: crate::notify::Channel = json!({"id": "_rule_webhook", "kind": "webhook", "url": url}).as_object().cloned().unwrap_or_default();
        let r = crate::notify::send(&st.notify.http, &ch, &m).await;
        results.push(match r {
            Ok(s) => json!({"channel": "webhook", "ok": true, "status": s}),
            Err(e) => json!({"channel": "webhook", "ok": false, "error": e}),
        });
    }
    // the apps hear about it too (toast / their own actions for "both")
    st.hub.send(json!({"type": "rule_fired", "rule_id": rule["id"], "rule": m.rule, "msg": h.msg, "test": test, "t": now_ms()}));
    results
}

/// One evaluation round.
pub async fn evaluate(st: &AppState) {
    let (all, _) = st.rules.get();
    let rules = server_rules(&all);
    if rules.is_empty() {
        st.srules.state.write().clear();
        return;
    }
    let mut cx = Ctx::new(st);
    let mut state = HashMap::new();
    for r in &rules {
        let id = r["id"].as_str().unwrap_or("").to_string();
        let res = check(r, &mut cx).await;
        let h = match res {
            Ok(h) => h,
            Err(e) => {
                state.insert(id, json!({"hit": false, "text": format!("error: {e}"), "t": now_ms()}));
                continue;
            }
        };
        state.insert(id.clone(), json!({"hit": h.is_some(), "text": h.as_ref().map(|x| x.msg.clone()).unwrap_or_default(), "t": now_ms()}));
        let Some(h) = h else { continue };
        let cooldown = r["cooldown"].as_f64().unwrap_or(30.0).max(1.0) * 60_000.0;
        let k = format!("{id}|{}", h.key);
        {
            let mut fired = st.srules.fired.lock();
            let last = fired.get(&k).copied().unwrap_or(0).max(if h.key.is_empty() { fired.get(&format!("{id}|")).copied().unwrap_or(0) } else { 0 });
            if (now_ms() - last) as f64 <= cooldown {
                continue;
            }
            fired.insert(k, now_ms());
            fired.insert(format!("{id}|"), now_ms());
            let cut = now_ms() - 24 * 3600_000;
            fired.retain(|_, t| *t > cut);
        }
        let results = run_actions(st, r, &h, false).await;
        tracing::info!("server rule \"{}\": {}", r["name"].as_str().unwrap_or(""), h.msg);
        st.srules.add_log(json!({"t": now_ms(), "rule_id": id, "rule": r["name"], "msg": h.msg, "results": results, "test": false}));
    }
    *st.srules.state.write() = state;
}

pub fn spawn(st: Arc<AppState>) {
    tokio::spawn(async move {
        // let feeds and alerts come up first
        tokio::time::sleep(Duration::from_secs(20)).await;
        let mut last = std::time::Instant::now() - Duration::from_secs(INTERVAL_S);
        let mut same_seen = 0u64;
        loop {
            // SAME messages are acted on within seconds; everything else every 30 s
            let n = st.radio.log.read().back().map(|m| m.id).unwrap_or(0);
            if last.elapsed() >= Duration::from_secs(INTERVAL_S) || n != same_seen {
                same_seen = n;
                last = std::time::Instant::now();
                let r = tokio::time::timeout(Duration::from_secs(120), evaluate(&st)).await;
                if r.is_err() {
                    tracing::warn!("server rules: evaluation took over 2 minutes");
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

// ---------- HTTP ----------

type St = State<Arc<AppState>>;

pub async fn get_log(State(st): St, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let limit = q.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(100).clamp(1, KEEP);
    let log: Vec<Value> = st.srules.log.read().iter().take(limit).cloned().collect();
    let state: Map<String, Value> = st.srules.state.read().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let (all, _) = st.rules.get();
    Json(json!({"log": log, "state": state, "interval_s": INTERVAL_S, "server_rules": server_rules(&all).len(), "quiet_now": st.notify.quiet_now()}))
}

pub async fn server_test(State(st): St, Json(b): Json<Value>) -> Response {
    let rule = match (b.get("rule"), b.get("id").and_then(|v| v.as_str())) {
        (Some(r), _) if r.is_object() => r.clone(),
        (_, Some(id)) => match st.rules.get().0.as_array().and_then(|a| a.iter().find(|r| r["id"].as_str() == Some(id)).cloned()) {
            Some(r) => r,
            None => return (StatusCode::NOT_FOUND, Json(json!({"error": "no such rule"}))).into_response(),
        },
        _ => return (StatusCode::BAD_REQUEST, Json(json!({"error": "id or rule required"}))).into_response(),
    };
    if !st.shares.limit.allow("rule-test", 30, 600) {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error": "too many tests; wait a few minutes"}))).into_response();
    }
    let mut cx = Ctx::new(&st);
    let res = check(&rule, &mut cx).await;
    let (hit, err) = match &res {
        Ok(h) => (h.clone(), None),
        Err(e) => (None, Some(e.clone())),
    };
    let h = hit.clone().unwrap_or_else(|| Hit { key: "test".into(), msg: format!("Test of \"{}\" (condition is {} right now)", rule["name"].as_str().unwrap_or(""), if hit.is_some() { "TRUE" } else { "false" }), vars: vars(&[("event", "Test".into()), ("place", "Home".into())]) });
    let results = run_actions(&st, &rule, &h, true).await;
    st.srules.add_log(json!({"t": now_ms(), "rule_id": rule["id"], "rule": rule["name"], "msg": h.msg, "results": results, "test": true}));
    Json(json!({"ok": true, "hit": hit.is_some(), "msg": h.msg, "error": err, "results": results})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(cond: Value) -> Value {
        json!({"id": "r1", "name": "Test rule", "on": true, "run_on": "server", "cond": cond, "act": {"channels": ["*"], "tts": "{rule}: {event} at {place}"}, "cooldown": 30})
    }
    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }
    const AT: (f64, f64) = (35.47, -97.52);
    fn at() -> Value {
        json!({"lat": AT.0, "lon": AT.1, "label": "Home"})
    }

    #[test]
    fn selection() {
        let all = json!([{"id": "a", "on": true}, {"id": "b", "on": true, "run_on": "server"}, {"id": "c", "on": false, "run_on": "both"}, {"id": "d", "on": true, "run_on": "both"}]);
        let ids: Vec<String> = server_rules(&all).iter().map(|r| r["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["b", "d"]);
    }

    #[test]
    fn alert_rule() {
        let mut cx = Ctx::fixed();
        let poly = json!({"type": "Polygon", "coordinates": [[[-97.6, 35.4], [-97.4, 35.4], [-97.4, 35.6], [-97.6, 35.6], [-97.6, 35.4]]]});
        let far = json!({"type": "Polygon", "coordinates": [[[-96.0, 35.4], [-95.9, 35.4], [-95.9, 35.5], [-96.0, 35.4]]]});
        cx.alerts = Some(vec![
            json!({"id": "x", "geometry": far, "properties": {"id": "x", "event": "Tornado Warning", "areaDesc": "Far"}}),
            json!({"id": "y", "geometry": poly, "properties": {"id": "y", "event": "Tornado Warning", "areaDesc": "Oklahoma, OK; Cleveland, OK"}}),
        ]);
        let h = block(check(&rule(json!({"kind": "alert", "event": "Tornado", "mi": 5, "at": at()})), &mut cx)).unwrap().unwrap();
        assert_eq!(h.key, "y");
        assert_eq!(h.msg, "Tornado Warning covers Home");
        let m = message(&rule(json!({})), &h, false, false);
        assert_eq!(m.body, "Test rule: Tornado Warning at Home");
        assert_eq!(m.level, "urgent");
        assert!(block(check(&rule(json!({"kind": "alert", "event": "Flood", "mi": 50, "at": at()})), &mut cx)).unwrap().is_none());
        // no point → error, not a silent miss
        assert!(block(check(&rule(json!({"kind": "alert", "where": "gps"})), &mut cx)).is_err());
    }

    #[test]
    fn cells_lightning_spc_metar() {
        let mut cx = Ctx::fixed();
        // a cell 20 km west moving east at 30 kt, rank 6 meso
        cx.cache.insert("stormattr".into(), json!({"features": [{"geometry": {"type": "Point", "coordinates": [AT.1 - 0.22, AT.0]}, "properties": {"nexrad": "TLX", "storm_id": "K2", "meso": "6", "tvs": "NONE", "dir_to": 90, "sknt": 30}}]}));
        let h = block(check(&rule(json!({"kind": "rotation", "rot": "meso", "value": 5, "mi": 15, "at": at()})), &mut cx)).unwrap().unwrap();
        assert!(h.msg.starts_with("Mesocyclone rank 6 "), "{}", h.msg);
        assert!(block(check(&rule(json!({"kind": "rotation", "rot": "tvs", "mi": 15, "at": at()})), &mut cx)).unwrap().is_none());
        let h = block(check(&rule(json!({"kind": "eta", "value": 30, "mi": 3, "at": at()})), &mut cx)).unwrap().unwrap();
        // 20 km at 30 kt (926 m/min) ≈ 22 min
        assert_eq!(h.vars["min"], "22");
        cx.cache.insert("glm?minutes=10".into(), json!({"features": [{"geometry": {"coordinates": [AT.1 + 0.03, AT.0]}, "properties": {"age": 120}}, {"geometry": {"coordinates": [AT.1, AT.0]}, "properties": {"age": 900}}]}));
        let h = block(check(&rule(json!({"kind": "lightning", "mi": 5, "minutes": 10, "at": at()})), &mut cx)).unwrap().unwrap();
        assert!(h.msg.contains("1.7 mi") && h.msg.contains("2 min ago"), "{}", h.msg);
        cx.cache.insert("spc?day=1&kind=cat".into(), json!({"features": [{"geometry": {"type": "Polygon", "coordinates": [[[-98.0, 35.0], [-97.0, 35.0], [-97.0, 36.0], [-98.0, 36.0], [-98.0, 35.0]]]}, "properties": {"label": "ENH"}}]}));
        assert!(block(check(&rule(json!({"kind": "spc", "value": 3, "at": at()})), &mut cx)).unwrap().is_some());
        assert!(block(check(&rule(json!({"kind": "spc", "value": 4, "at": at()})), &mut cx)).unwrap().is_none());
        cx.cache.insert("metar".into(), json!({"features": [{"geometry": {"coordinates": [AT.1 + 0.05, AT.0]}, "properties": {"id": "KOKC", "t": 38.0, "wg": 50.0}}]}));
        let h = block(check(&rule(json!({"kind": "metar", "field": "gust", "value": 55, "mi": 10, "at": at()})), &mut cx)).unwrap().unwrap();
        assert_eq!(h.msg, "KOKC gust 58 mph near Home");
        assert!(block(check(&rule(json!({"kind": "metar", "field": "temp_hi", "value": 100, "mi": 10, "at": at()})), &mut cx)).unwrap().is_some());
        assert!(block(check(&rule(json!({"kind": "metar", "field": "temp_lo", "value": 32, "mi": 10, "at": at()})), &mut cx)).unwrap().is_none());
        cx.cache.insert("airquality".into(), json!({"features": [{"geometry": {"coordinates": [AT.1, AT.0 + 0.1]}, "properties": {"aqi": 180}}]}));
        assert!(block(check(&rule(json!({"kind": "aqi", "value": 150, "mi": 25, "at": at()})), &mut cx)).unwrap().is_some());
    }

    #[test]
    fn same_rule() {
        let mut cx = Ctx::fixed();
        let hdr = crate::same::parse::parse_header("ZCZC-WXR-TOR-040109-040027+0045-1402203-KOUN/NWS-", chrono::Utc::now()).unwrap();
        let m = crate::radio::SameMsg { id: 5, t: now_ms(), station: "KEC91".into(), station_name: "Oklahoma City".into(), kind: "header".into(), raw: hdr.raw.clone(), fips: vec!["40109".into(), "40027".into()], header: Some(serde_json::to_value(&hdr).unwrap()), ..Default::default() };
        let mut t = m.clone();
        t.test = true;
        cx.same = Some(vec![t.clone()]);
        assert!(block(check(&rule(json!({"kind": "same", "event": "TOR"})), &mut cx)).unwrap().is_none(), "test messages never fire");
        cx.same = Some(vec![m]);
        let h = block(check(&rule(json!({"kind": "same", "event": "tornado", "fips": ["40109"]})), &mut cx)).unwrap().unwrap();
        assert_eq!(h.key, format!("same|{}", hdr.raw));
        assert!(h.msg.starts_with("Tornado Warning for Oklahoma Co., OK; Cleveland Co., OK"), "{}", h.msg);
        assert!(block(check(&rule(json!({"kind": "same", "fips": ["40000"]})), &mut cx)).unwrap().is_some(), "whole-state watch");
        assert!(block(check(&rule(json!({"kind": "same", "fips": ["48113"]})), &mut cx)).unwrap().is_none());
        assert!(block(check(&rule(json!({"kind": "same", "event": "SVR"})), &mut cx)).unwrap().is_none());
        assert!(block(check(&rule(json!({"kind": "same", "station": "OTHER"})), &mut cx)).unwrap().is_none());
    }

    #[test]
    fn templates() {
        let h = Hit { key: "".into(), msg: "M".into(), vars: vars(&[("event", "E".into())]) };
        assert_eq!(fill("{rule}|{msg}|{event}|{nope}|{ x }", &json!({"name": "R"}), &h), "R|M|E||{ x }");
    }
}
