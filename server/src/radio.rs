//! Server-side NOAA Weather Radio monitor ("scanner"): decodes SAME from many streams at once so
//! no header is missed while the app plays one station. Each stream runs
//! `ffmpeg -i <url> -f s16le -ac 1 -ar 22050 -` and a [`crate::same::SameDecoder`] on its own
//! thread (≈1–2 % of a core per stream), reconnecting with backoff.
//!
//! API (token required):
//! * `GET  /api/radio/monitor` → `{enabled, ffmpeg, stations:[status…]}`
//! * `PUT  /api/radio/monitor {enabled, stations:[{id,url,name?}]}` → same as GET
//! * `GET  /api/radio/same?since=<unix ms>&limit=` → `{messages:[…], now}`
//! * `POST /api/radio/same/test {station?, event?, locations?}` → decodes a synthetic header
//!
//! Decoded events are broadcast on `/ws` as `{type:"same", station, …message}`.

use crate::api::AppState;
use crate::hub::Hub;
use crate::same::{SameDecoder, SameEvent, Tone};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const RATE: u32 = 22050;
const MAX_STATIONS: usize = 64;
const KEEP: usize = 1000;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct StationCfg {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MonitorCfg {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub stations: Vec<StationCfg>,
}

/// One decoded event, as stored and broadcast.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SameMsg {
    /// increasing per server run (unique together with `t`)
    pub id: u64,
    /// unix ms when decoded
    pub t: i64,
    pub station: String,
    pub station_name: String,
    /// header | eom | tone
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub raw: String,
    #[serde(default)]
    pub copies: usize,
    /// parsed header (org, org_name, event, event_name, level, locations[{code,part,state,county,fips,marine,name}],
    /// purge, purge_min, issued, expires, sender); null when the header didn't parse
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<Value>,
    /// 5-digit county FIPS codes of the header ("SS000" = whole state)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fips: Vec<String>,
    /// tone: "nwr" (1050 Hz) | "eas" (853+960 Hz)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tone: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub test: bool,
}

#[derive(Default)]
struct Live {
    connected: bool,
    level_db: f64,
    last_audio: i64,
    last_same: Option<SameMsg>,
    tone: Option<Tone>,
    error: String,
    since: i64,
    reconnects: u32,
}

struct Worker {
    cfg: StationCfg,
    stop: Arc<AtomicBool>,
    live: Arc<Mutex<Live>>,
    child: Arc<Mutex<Option<std::process::Child>>>,
    /// test clips injected into the decoder thread
    inject: Arc<Mutex<Vec<Vec<f32>>>>,
}

pub struct Radio {
    path: PathBuf,
    log_path: PathBuf,
    pub cfg: RwLock<MonitorCfg>,
    workers: Mutex<HashMap<String, Worker>>,
    pub log: RwLock<VecDeque<SameMsg>>,
    seq: AtomicU64,
    hub: Hub,
    ffmpeg: Mutex<Option<bool>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Radio {
    pub fn new(data: &std::path::Path, hub: Hub) -> Arc<Radio> {
        let path = data.join("radio_monitor.json");
        let log_path = data.join("radio_same.json");
        let cfg = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let log: VecDeque<SameMsg> = std::fs::read(&log_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let seq = log.iter().map(|m| m.id).max().unwrap_or(0) + 1;
        Arc::new(Radio { path, log_path, cfg: RwLock::new(cfg), workers: Mutex::new(HashMap::new()), log: RwLock::new(log), seq: AtomicU64::new(seq), hub, ffmpeg: Mutex::new(None) })
    }

    pub fn has_ffmpeg(&self) -> bool {
        let mut f = self.ffmpeg.lock();
        if f.is_none() {
            *f = Some(crate::platform::command_sync("ffmpeg").arg("-version").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false));
        }
        f.unwrap_or(false)
    }

    /// Start/stop workers to match the config.
    pub fn sync(self: &Arc<Self>) {
        let cfg = self.cfg.read().clone();
        let want: HashMap<String, StationCfg> = if cfg.enabled { cfg.stations.iter().map(|s| (s.id.clone(), s.clone())).collect() } else { HashMap::new() };
        let mut ws = self.workers.lock();
        let stale: Vec<String> = ws.iter().filter(|(id, w)| want.get(*id).map(|c| c.url != w.cfg.url).unwrap_or(true)).map(|(id, _)| id.clone()).collect();
        for id in stale {
            if let Some(w) = ws.remove(&id) {
                stop_worker(&w);
            }
        }
        if !want.is_empty() && !self.has_ffmpeg() {
            return;
        }
        for (id, c) in want {
            if let Some(w) = ws.get_mut(&id) {
                w.cfg.name = c.name.clone();
                continue;
            }
            let w = Worker { cfg: c, stop: Arc::new(AtomicBool::new(false)), live: Arc::new(Mutex::new(Live { level_db: -120.0, ..Default::default() })), child: Arc::new(Mutex::new(None)), inject: Arc::new(Mutex::new(vec![])) };
            let me = self.clone();
            let (cfg, stop, live, child, inject) = (w.cfg.clone(), w.stop.clone(), w.live.clone(), w.child.clone(), w.inject.clone());
            let r = std::thread::Builder::new().name(format!("radio-{id}")).spawn(move || me.run_station(cfg, stop, live, child, inject));
            if let Err(e) = r {
                tracing::warn!("radio monitor: can't start a thread for {id}: {e}");
                continue;
            }
            ws.insert(id, w);
        }
    }

    /// Stop every stream (shutdown / in-process restart).
    pub fn stop_all(&self) {
        for (_, w) in self.workers.lock().drain() {
            stop_worker(&w);
        }
    }

    fn run_station(self: Arc<Self>, cfg: StationCfg, stop: Arc<AtomicBool>, live: Arc<Mutex<Live>>, child_slot: Arc<Mutex<Option<std::process::Child>>>, inject: Arc<Mutex<Vec<Vec<f32>>>>) {
        let mut backoff = 2u64;
        let mut dec = SameDecoder::new(RATE as f64);
        while !stop.load(Ordering::SeqCst) {
            let started = Instant::now();
            let spawned = crate::platform::command_sync("ffmpeg")
                .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "http,https,tcp,tls,crypto,httpproxy,hls"])
                .args(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "20", "-rw_timeout", "20000000"])
                .arg("-i")
                .arg(&cfg.url)
                .args(["-vn", "-f", "s16le", "-ac", "1", "-ar", &RATE.to_string(), "-"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn();
            let mut child = match spawned {
                Ok(c) => c,
                Err(e) => {
                    live.lock().error = format!("can't run ffmpeg: {e}");
                    sleep_unless(&stop, Duration::from_secs(60));
                    continue;
                }
            };
            let mut out = child.stdout.take();
            let err = child.stderr.take();
            *child_slot.lock() = Some(child);
            // last ffmpeg error line, for the status
            let last_err = Arc::new(Mutex::new(String::new()));
            if let Some(mut e) = err {
                let le = last_err.clone();
                std::thread::spawn(move || {
                    let mut s = String::new();
                    let mut buf = [0u8; 2048];
                    while let Ok(n) = e.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if let Some(l) = s.lines().filter(|l| !l.trim().is_empty()).last() {
                            *le.lock() = l.chars().take(300).collect();
                        }
                        if s.len() > 8192 {
                            s = s[s.len() - 2048..].to_string();
                        }
                    }
                });
            }
            {
                let mut l = live.lock();
                l.since = now_ms();
            }
            let mut carry = None;
            let mut samples: Vec<f32> = Vec::with_capacity(8192);
            let mut buf = vec![0u8; 8820]; // 0.2 s
            let mut got_audio = false;
            let mut lvl = -120.0f64;
            if let Some(o) = out.as_mut() {
                loop {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let n = match o.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    samples.clear();
                    crate::same::s16le_to_f32(&mut carry, &buf[..n], &mut samples);
                    let evs = dec.push(&samples);
                    let tests: Vec<Vec<f32>> = std::mem::take(&mut *inject.lock());
                    let mut test_evs = vec![];
                    for clip in tests {
                        for c in clip.chunks(4096) {
                            test_evs.extend(dec.push(c));
                        }
                    }
                    if !samples.is_empty() {
                        let e: f64 = samples.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / samples.len() as f64;
                        let db = 10.0 * (e + 1e-12).log10();
                        lvl = if lvl < -100.0 { db } else { lvl * 0.7 + db * 0.3 };
                    }
                    {
                        let mut l = live.lock();
                        l.connected = true;
                        l.level_db = (lvl * 10.0).round() / 10.0;
                        l.last_audio = now_ms();
                        l.tone = dec.tone();
                        l.error.clear();
                    }
                    if !got_audio {
                        got_audio = true;
                        tracing::info!("radio monitor: {} connected", label(&cfg));
                    }
                    for e in evs {
                        self.event(&cfg, &live, e, false);
                    }
                    for e in test_evs {
                        self.event(&cfg, &live, e, true);
                    }
                }
            }
            // stream ended: reap ffmpeg
            if let Some(mut c) = child_slot.lock().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let ran = started.elapsed();
            {
                let mut l = live.lock();
                l.connected = false;
                l.tone = None;
                l.reconnects += 1;
                let e = last_err.lock().clone();
                l.error = if e.is_empty() { "stream ended".into() } else { e };
            }
            if ran > Duration::from_secs(120) {
                backoff = 2;
            }
            sleep_unless(&stop, Duration::from_secs(backoff));
            backoff = (backoff * 2).min(120);
            // a fresh decoder per connection (no half-received bursts across reconnects)
            dec = SameDecoder::new(RATE as f64);
        }
        let mut l = live.lock();
        l.connected = false;
        l.tone = None;
    }

    fn event(&self, cfg: &StationCfg, live: &Arc<Mutex<Live>>, e: SameEvent, test: bool) {
        let mut m = SameMsg { id: self.seq.fetch_add(1, Ordering::SeqCst), t: now_ms(), station: cfg.id.clone(), station_name: cfg.name.clone(), test, ..Default::default() };
        match e {
            SameEvent::Header { raw, header, copies, .. } => {
                m.kind = "header".into();
                m.raw = raw;
                m.copies = copies;
                if let Some(h) = &header {
                    m.fips = h.locations.iter().map(|l| l.fips.clone()).collect();
                }
                m.header = header.map(|h| serde_json::to_value(h).unwrap_or(Value::Null));
            }
            SameEvent::Eom { copies, .. } => {
                m.kind = "eom".into();
                m.copies = copies;
            }
            SameEvent::ToneStart { kind, .. } => {
                // not stored: only broadcast so a scanner can switch at once
                let k = tone_name(kind);
                self.hub.send(json!({"type": "same", "kind": "tone-start", "station": cfg.id, "station_name": cfg.name, "tone": k, "t": now_ms(), "test": test}));
                return;
            }
            SameEvent::ToneEnd { kind, duration, .. } => {
                if duration < 1.0 {
                    return;
                }
                m.kind = "tone".into();
                m.tone = tone_name(kind).into();
                m.duration = (duration * 10.0).round() / 10.0;
            }
        }
        if m.kind == "header" {
            tracing::info!("radio monitor: SAME on {}: {}", label(cfg), m.raw);
            live.lock().last_same = Some(m.clone());
        }
        let mut v = serde_json::to_value(&m).unwrap_or(Value::Null);
        v["type"] = json!("same");
        self.hub.send(v);
        {
            let mut log = self.log.write();
            log.push_back(m);
            while log.len() > KEEP {
                log.pop_front();
            }
        }
        self.save_log();
    }

    fn save_log(&self) {
        let b = serde_json::to_vec(&*self.log.read()).unwrap_or_default();
        let _ = crate::platform::write_atomic(&self.log_path, &b);
    }

    pub fn since(&self, since: i64, limit: usize) -> Vec<SameMsg> {
        let log = self.log.read();
        let mut v: Vec<SameMsg> = log.iter().filter(|m| m.t > since).cloned().collect();
        if v.len() > limit {
            v.drain(..v.len() - limit);
        }
        v
    }

    pub fn status(&self) -> Value {
        let cfg = self.cfg.read().clone();
        let ws = self.workers.lock();
        let now = now_ms();
        let stations: Vec<Value> = cfg
            .stations
            .iter()
            .map(|s| {
                let base = json!({"id": s.id, "url": s.url, "name": s.name});
                let Some(w) = ws.get(&s.id) else {
                    return merge(base, json!({"running": false, "connected": false, "level_db": null, "last_audio": null, "last_same": null, "tone_active": null, "error": if cfg.enabled { "not running (ffmpeg missing?)" } else { "" }}));
                };
                let l = w.live.lock();
                let connected = l.connected && now - l.last_audio < 10_000;
                merge(
                    base,
                    json!({
                        "running": true, "connected": connected,
                        "level_db": if connected { json!(l.level_db) } else { Value::Null },
                        "last_audio": if l.last_audio > 0 { json!(l.last_audio) } else { Value::Null },
                        "last_same": l.last_same, "tone_active": l.tone.map(tone_name),
                        "error": l.error, "since": l.since, "reconnects": l.reconnects,
                    }),
                )
            })
            .collect();
        json!({"enabled": cfg.enabled, "ffmpeg": self.has_ffmpeg(), "rate": RATE, "stations": stations})
    }

    pub fn set(self: &Arc<Self>, cfg: MonitorCfg) -> anyhow::Result<()> {
        crate::platform::write_atomic(&self.path, &serde_json::to_vec_pretty(&cfg)?)?;
        *self.cfg.write() = cfg;
        self.sync();
        Ok(())
    }

    /// Push a synthetic SAME message through a station's decoder (or a scratch decoder).
    pub fn test(&self, station: Option<&str>, event: &str, locations: &[String]) -> Result<Vec<SameMsg>, String> {
        let locs: Vec<&str> = locations.iter().map(|s| s.as_str()).collect();
        let hdr = crate::same::parse::build_header("WXR", event, &locs, "0030", chrono::Utc::now(), "KTBW/NWS");
        let mut clip = crate::same::encoder::encode_same(&crate::same::encoder::EncodeOpts { fs: RATE as f64, header: hdr, tone: "nwr", tone_sec: 2.0, message_sec: 0.5, eom: true, amp: 0.45, ..Default::default() });
        clip.extend(std::iter::repeat_n(0.0, RATE as usize * 5));
        if let Some(id) = station {
            let ws = self.workers.lock();
            if let Some(w) = ws.get(id) {
                if w.live.lock().connected {
                    w.inject.lock().push(clip);
                    return Ok(vec![]);
                }
            }
        }
        // no live stream: decode right here
        let cfg = self.cfg.read().stations.iter().find(|s| Some(s.id.as_str()) == station).cloned().unwrap_or(StationCfg { id: station.unwrap_or("test").into(), url: String::new(), name: "Test".into() });
        let live = Arc::new(Mutex::new(Live::default()));
        let mut dec = SameDecoder::new(RATE as f64);
        let before = self.seq.load(Ordering::SeqCst);
        for c in clip.chunks(4096) {
            for e in dec.push(c) {
                self.event(&cfg, &live, e, true);
            }
        }
        for e in dec.finish() {
            self.event(&cfg, &live, e, true);
        }
        Ok(self.log.read().iter().filter(|m| m.id >= before).cloned().collect())
    }
}

fn merge(mut a: Value, b: Value) -> Value {
    if let (Some(a), Value::Object(b)) = (a.as_object_mut(), b) {
        a.extend(b);
    }
    a
}

fn tone_name(t: Tone) -> &'static str {
    match t {
        Tone::Nwr => "nwr",
        Tone::Eas => "eas",
    }
}

fn label(c: &StationCfg) -> String {
    if c.name.is_empty() { c.id.clone() } else { format!("{} ({})", c.name, c.id) }
}

fn stop_worker(w: &Worker) {
    w.stop.store(true, Ordering::SeqCst);
    if let Some(c) = w.child.lock().as_mut() {
        let _ = c.kill();
    }
}

fn sleep_unless(stop: &AtomicBool, d: Duration) {
    let t0 = Instant::now();
    while t0.elapsed() < d && !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Station URLs ffmpeg may open: http(s) only (no file:, concat:, pipes…).
pub fn valid_url(u: &str) -> bool {
    reqwest::Url::parse(u.trim()).map(|x| (x.scheme() == "http" || x.scheme() == "https") && x.host_str().is_some()).unwrap_or(false)
}

// ---------- HTTP ----------

type St = State<Arc<AppState>>;

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

pub async fn get_monitor(State(st): St) -> Json<Value> {
    Json(st.radio.status())
}

#[derive(Deserialize)]
pub struct PutMonitor {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    stations: Option<Vec<StationCfg>>,
}

pub async fn put_monitor(State(st): St, Json(b): Json<PutMonitor>) -> Response {
    let mut cfg = st.radio.cfg.read().clone();
    if let Some(e) = b.enabled {
        cfg.enabled = e;
    }
    if let Some(list) = b.stations {
        if list.len() > MAX_STATIONS {
            return err(StatusCode::BAD_REQUEST, format!("at most {MAX_STATIONS} stations"));
        }
        let mut seen = std::collections::HashSet::new();
        for s in &list {
            if s.id.trim().is_empty() || s.id.len() > 100 || !seen.insert(s.id.clone()) {
                return err(StatusCode::BAD_REQUEST, format!("station ids must be unique and non-empty ({:?})", s.id));
            }
            if !valid_url(&s.url) {
                return err(StatusCode::BAD_REQUEST, format!("station {}: only http(s) stream URLs are allowed", s.id));
            }
        }
        cfg.stations = list;
    }
    if cfg.enabled && !cfg.stations.is_empty() && !st.radio.has_ffmpeg() {
        // saved anyway; the status says why nothing runs
        tracing::warn!("radio monitor enabled but ffmpeg is not installed");
    }
    let radio = st.radio.clone();
    match tokio::task::spawn_blocking(move || radio.set(cfg)).await {
        Ok(Ok(())) => {
            st.hub.send(json!({"type": "radio-monitor"}));
            Json(st.radio.status()).into_response()
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn get_same(State(st): St, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let since = q.get("since").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let limit = q.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(200).clamp(1, KEEP);
    Json(json!({"messages": st.radio.since(since, limit), "now": now_ms()}))
}

#[derive(Deserialize)]
pub struct TestReq {
    station: Option<String>,
    event: Option<String>,
    locations: Option<Vec<String>>,
}

pub async fn test_same(State(st): St, Json(b): Json<TestReq>) -> Response {
    let event = b.event.unwrap_or_else(|| "RWT".into()).to_ascii_uppercase();
    if event.len() != 3 || !event.chars().all(|c| c.is_ascii_alphanumeric()) {
        return err(StatusCode::BAD_REQUEST, "event must be a 3-letter SAME code");
    }
    let locations = b.locations.unwrap_or_else(|| vec!["040109".into()]);
    if locations.is_empty() || locations.len() > 31 || locations.iter().any(|l| l.len() != 6 || !l.chars().all(|c| c.is_ascii_digit())) {
        return err(StatusCode::BAD_REQUEST, "locations are 1-31 six-digit PSSCCC codes");
    }
    let radio = st.radio.clone();
    let station = b.station.clone();
    match tokio::task::spawn_blocking(move || radio.test(station.as_deref(), &event, &locations)).await {
        Ok(Ok(m)) => Json(json!({"ok": true, "injected": m.is_empty(), "messages": m})).into_response(),
        Ok(Err(e)) => err(StatusCode::BAD_REQUEST, e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert!(valid_url("https://example.com/stream.mp3"));
        assert!(valid_url("http://10.0.0.5:8000/wx"));
        assert!(!valid_url("file:///etc/passwd"));
        assert!(!valid_url("concat:a|b"));
    }

    #[test]
    fn self_test_decodes() {
        let d = std::env::temp_dir().join(format!("tbw-radio-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let r = Radio::new(&d, Hub::new());
        let m = r.test(None, "TOR", &["040109".into(), "040027".into()]).unwrap();
        let h = m.iter().find(|x| x.kind == "header").expect("header");
        assert_eq!(h.fips, vec!["40109", "40027"]);
        assert!(h.test);
        assert_eq!(h.header.as_ref().unwrap()["event_name"], "Tornado Warning");
        assert!(m.iter().any(|x| x.kind == "eom"));
        assert!(m.iter().any(|x| x.kind == "tone" && x.tone == "nwr"));
        assert_eq!(Radio::new(&d, Hub::new()).since(0, 100).len(), m.len());
        std::fs::remove_dir_all(&d).ok();
    }
}
