//! Webcam auto-timelapses: still images captured on a schedule, one MP4 per camera per day
//! (ffmpeg), tagged with the warnings and storm reports near the camera that day.
//!
//! Files live in `data/recordings/tl_<cam>/` so the recordings file route serves them:
//! `GET /api/rec/tl_<cam>/file/<YYYY-MM-DD>.mp4` (+ `.json` chapters, `.jpg` poster). Stills are
//! kept in `tl_<cam>/stills/<date>/` until the day's video exists and are then removed.
//!
//! * `GET  /api/timelapse/cams` → `{cams, ffmpeg, status:{<cam>: {last_capture, frames_today, last_error, next_capture}}}`
//! * `PUT  /api/timelapse/cams {cams:[{id, name, url | cam_id, lat?, lon?, interval_min, daylight_only, retention_days, fps?, enabled?}]}`
//! * `GET  /api/timelapse/list?cam=` → `{items:[{cam, date, video, chapters_url, poster, frames, fps, duration_s, size, chapters}]}`
//! * `POST /api/timelapse/build {cam, date?}` → build (or rebuild) a day now (today = partial)

use crate::api::AppState;
use anyhow::{anyhow, bail, Result};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Datelike, Local, NaiveDate, TimeZone};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const MAX_CAMS: usize = 100;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct TlCam {
    pub id: String,
    pub name: String,
    /// still-image URL; or empty with `cam_id` (a camera from /api/ovl/cameras, resolved by the server)
    pub url: String,
    pub cam_id: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// minutes between stills
    pub interval_min: u32,
    /// only capture between civil dawn and dusk (needs lat/lon)
    pub daylight_only: bool,
    /// keep daily videos this many days
    pub retention_days: u32,
    pub fps: u32,
    pub enabled: bool,
    /// tag warnings / storm reports within this distance (mi)
    pub event_mi: f64,
}

impl Default for TlCam {
    fn default() -> Self {
        TlCam { id: String::new(), name: String::new(), url: String::new(), cam_id: String::new(), lat: None, lon: None, interval_min: 5, daylight_only: true, retention_days: 14, fps: 24, enabled: true, event_mi: 15.0 }
    }
}

#[derive(Default, Clone, Serialize)]
pub struct CamStatus {
    pub last_capture: i64,
    pub last_try: i64,
    pub frames_today: usize,
    pub last_error: String,
    pub last_hash: u64,
    pub building: bool,
}

pub struct Timelapse {
    cfg_path: PathBuf,
    pub dir: PathBuf,
    pub cams: RwLock<Vec<TlCam>>,
    pub status: Mutex<HashMap<String, CamStatus>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn safe(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// Recording id under which a camera's files are served.
pub fn rec_id(cam: &str) -> String {
    format!("tl_{}", safe(cam))
}

/// Solar elevation (degrees) at a place and time (low-precision almanac, ±0.5°).
pub fn sun_elevation(lat: f64, lon: f64, t_ms: i64) -> f64 {
    let d = t_ms as f64 / 86_400_000.0 + 2_440_587.5 - 2_451_545.0;
    let g = (357.529 + 0.985_600_28 * d).to_radians();
    let q = 280.459 + 0.985_647_36 * d;
    let l = (q + 1.915 * g.sin() + 0.020 * (2.0 * g).sin()).to_radians();
    let e = (23.439 - 0.000_000_36 * d).to_radians();
    let ra = (e.cos() * l.sin()).atan2(l.cos()).to_degrees();
    let dec = (e.sin() * l.sin()).asin();
    let gmst = (18.697_374_558 + 24.065_709_824_419_08 * d).rem_euclid(24.0);
    let ha = (gmst * 15.0 + lon - ra).to_radians();
    let lat = lat.to_radians();
    (lat.sin() * dec.sin() + lat.cos() * dec.cos() * ha.cos()).asin().to_degrees()
}

/// Is a still due now?
pub fn due(c: &TlCam, last_try: i64, now: i64) -> bool {
    if !c.enabled {
        return false;
    }
    if now - last_try < c.interval_min.clamp(1, 1440) as i64 * 60_000 {
        return false;
    }
    if c.daylight_only {
        if let (Some(lat), Some(lon)) = (c.lat, c.lon) {
            return sun_elevation(lat, lon, now) > -6.0;
        }
    }
    true
}

/// Days (local) that have stills but no video yet and are finished (before `today`).
pub fn days_to_build(still_days: &[String], videos: &[String], today: NaiveDate) -> Vec<String> {
    let mut v: Vec<String> = still_days.iter().filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").map(|x| x < today).unwrap_or(false) && !videos.contains(d)).cloned().collect();
    v.sort();
    v
}

/// Dates older than the retention window.
pub fn expired(days: &[String], today: NaiveDate, retention_days: u32) -> Vec<String> {
    days.iter().filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").map(|x| (today - x).num_days() > retention_days.max(1) as i64).unwrap_or(false)).cloned().collect()
}

/// Video offset (s) of a time, given the sorted frame times.
pub fn offset_of(frames: &[i64], t: i64, fps: u32) -> f64 {
    let i = frames.partition_point(|&x| x < t);
    let i = i.min(frames.len().saturating_sub(1));
    ((i as f64 / fps.max(1) as f64) * 10.0).round() / 10.0
}

fn day_of(t_ms: i64) -> String {
    Local.timestamp_millis_opt(t_ms).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

impl Timelapse {
    pub fn new(data: &Path) -> Arc<Timelapse> {
        let cfg_path = data.join("timelapse.json");
        let cams = std::fs::read(&cfg_path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| serde_json::from_value(v["cams"].clone()).ok()).unwrap_or_default();
        Arc::new(Timelapse { cfg_path, dir: data.join("recordings"), cams: RwLock::new(cams), status: Mutex::new(HashMap::new()) })
    }
    pub fn cam_dir(&self, cam: &str) -> PathBuf {
        self.dir.join(rec_id(cam))
    }
    fn stills(&self, cam: &str, day: &str) -> PathBuf {
        self.cam_dir(cam).join("stills").join(safe(day))
    }
    pub fn set(&self, cams: Vec<TlCam>) -> Result<()> {
        crate::platform::write_atomic(&self.cfg_path, &serde_json::to_vec_pretty(&json!({"cams": cams}))?)?;
        *self.cams.write() = cams;
        Ok(())
    }

    fn list_dirs(p: &Path) -> Vec<String> {
        std::fs::read_dir(p).map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default()
    }
    fn videos(&self, cam: &str) -> Vec<String> {
        std::fs::read_dir(self.cam_dir(cam)).map(|rd| rd.flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".mp4").map(str::to_string)).collect()).unwrap_or_default()
    }

    /// Daily videos of a camera (newest first).
    pub fn list(&self, cam: Option<&str>) -> Vec<Value> {
        let cams: Vec<String> = match cam {
            Some(c) => vec![c.to_string()],
            None => self.cams.read().iter().map(|c| c.id.clone()).collect(),
        };
        let mut out = vec![];
        for c in cams {
            let d = self.cam_dir(&c);
            let mut days = self.videos(&c);
            days.sort();
            days.reverse();
            for day in days {
                let meta: Value = std::fs::read(d.join(format!("{day}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
                let size = std::fs::metadata(d.join(format!("{day}.mp4"))).map(|m| m.len()).unwrap_or(0);
                let id = rec_id(&c);
                out.push(json!({
                    "cam": c, "date": day, "size": size,
                    "video": format!("/api/rec/{id}/file/{day}.mp4"),
                    "chapters_url": format!("/api/rec/{id}/file/{day}.json"),
                    "poster": if d.join(format!("{day}.jpg")).exists() { json!(format!("/api/rec/{id}/file/{day}.jpg")) } else { Value::Null },
                    "frames": meta["frames"], "fps": meta["fps"], "duration_s": meta["duration_s"], "start": meta["start"], "end": meta["end"],
                    "partial": meta["partial"], "chapters": meta["chapters"],
                }));
            }
        }
        out
    }

    /// Remember a warning near the camera on the day it was in effect.
    fn note_events(&self, cam: &TlCam, alerts: &[Value], now: i64) {
        let (Some(lat), Some(lon)) = (cam.lat, cam.lon) else { return };
        let r = cam.event_mi.max(0.0) * 1609.344;
        let day = day_of(now);
        let p = self.stills(&cam.id, &day).join("events.json");
        let mut ev: Vec<Value> = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut changed = false;
        for a in alerts {
            let pr = &a["properties"];
            let ev_name = pr["event"].as_str().unwrap_or("");
            if !(ev_name.ends_with("Warning") || ev_name.ends_with("Emergency")) {
                continue;
            }
            if crate::srules::dist_to_geom(lat, lon, &a["geometry"]) > r {
                continue;
            }
            let id = pr["id"].as_str().or(a["id"].as_str()).unwrap_or("").to_string();
            match ev.iter_mut().find(|e| e["id"].as_str() == Some(&id)) {
                Some(e) => {
                    e["last"] = json!(now);
                    changed = true;
                }
                None => {
                    ev.push(json!({"id": id, "kind": "warning", "title": ev_name, "t": now, "last": now}));
                    changed = true;
                }
            }
        }
        if changed {
            std::fs::create_dir_all(p.parent().unwrap()).ok();
            let _ = std::fs::write(&p, serde_json::to_vec(&ev).unwrap_or_default());
        }
    }
}

/// Image URL to fetch for a camera.
async fn image_url(st: &AppState, c: &TlCam) -> Result<String> {
    if !c.url.is_empty() && c.url != "proxy" {
        return Ok(c.url.clone());
    }
    if c.cam_id.is_empty() {
        bail!("camera has no url or cam_id");
    }
    crate::overlays::cameras::image_url(&st.overlays, &c.cam_id).await
}

async fn capture(st: &AppState, c: &TlCam) -> Result<bool> {
    let url = image_url(st, c).await?;
    let sep = if url.contains('?') { '&' } else { '?' };
    let r = st.overlays.http.get(format!("{url}{sep}_tbw={}", now_ms() / 1000)).timeout(Duration::from_secs(30)).send().await?;
    if !r.status().is_success() {
        bail!("HTTP {}", r.status());
    }
    let b = r.bytes().await?;
    if b.len() < 500 {
        bail!("image too small ({} bytes)", b.len());
    }
    let h = {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        b.hash(&mut s);
        s.finish()
    };
    if st.timelapse.status.lock().get(&c.id).map(|s| s.last_hash == h).unwrap_or(false) {
        return Ok(false); // camera hasn't updated
    }
    let ext = if b.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else if b.len() > 12 && &b[8..12] == b"WEBP" { "webp" } else { "jpg" };
    let t = now_ms();
    let d = st.timelapse.stills(&c.id, &day_of(t));
    tokio::fs::create_dir_all(&d).await?;
    tokio::fs::write(d.join(format!("{t}.{ext}")), &b).await?;
    let mut s = st.timelapse.status.lock();
    let e = s.entry(c.id.clone()).or_default();
    e.last_hash = h;
    e.last_capture = t;
    Ok(true)
}

/// Build the MP4 for one camera-day (stills → video, chapters, poster).
pub async fn build(st: &AppState, c: &TlCam, day: &str, partial: bool) -> Result<PathBuf> {
    if !st.rec.has_ffmpeg() {
        bail!("timelapses need ffmpeg on the server");
    }
    let tl = &st.timelapse;
    let sd = tl.stills(&c.id, day);
    let mut imgs: Vec<(i64, String)> = std::fs::read_dir(&sd)
        .map_err(|_| anyhow!("no stills for {day}"))?
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let t: i64 = n.split('.').next()?.parse().ok()?;
            (n.ends_with(".jpg") || n.ends_with(".png") || n.ends_with(".webp")).then_some((t, n))
        })
        .collect();
    imgs.sort();
    if imgs.len() < 2 {
        bail!("need at least 2 stills for {day}");
    }
    let fps = c.fps.clamp(1, 60);
    let out_dir = tl.cam_dir(&c.id);
    let list = sd.join("frames.txt");
    let dur = 1.0 / fps as f64;
    let mut txt = String::new();
    for (_, n) in &imgs {
        txt.push_str(&format!("file '{n}'\nduration {dur}\n"));
    }
    txt.push_str(&format!("file '{}'\n", imgs.last().unwrap().1));
    std::fs::write(&list, txt)?;
    let tmp = out_dir.join(format!(".{day}.mp4.part"));
    let status = crate::platform::command("ffmpeg")
        .args(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-vf", "scale='min(1280,iw)':-2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&tmp)
        .current_dir(&sd)
        .kill_on_drop(true)
        .status()
        .await?;
    std::fs::remove_file(&list).ok();
    if !status.success() {
        std::fs::remove_file(&tmp).ok();
        bail!("ffmpeg failed");
    }
    std::fs::rename(&tmp, out_dir.join(format!("{day}.mp4")))?;
    // poster: the middle still
    let mid = &imgs[imgs.len() / 2].1;
    if mid.ends_with(".jpg") {
        std::fs::copy(sd.join(mid), out_dir.join(format!("{day}.jpg"))).ok();
    }
    // chapters: warnings seen while capturing + storm reports near the camera that day
    let times: Vec<i64> = imgs.iter().map(|x| x.0).collect();
    let (start, end) = (times[0], *times.last().unwrap());
    let mut chapters: Vec<Value> = vec![];
    let evs: Vec<Value> = std::fs::read(sd.join("events.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    for e in evs {
        let t = e["t"].as_i64().unwrap_or(start);
        chapters.push(json!({"t": t, "end": e["last"], "offset_s": offset_of(&times, t, fps), "title": e["title"], "kind": "warning", "id": e["id"]}));
    }
    if let (Some(lat), Some(lon)) = (c.lat, c.lon) {
        let hours = ((now_ms() - start) / 3_600_000 + 2).clamp(1, 72);
        let keys = st.cfg.read().keys.clone();
        let q: crate::overlays::Params = [("hours".to_string(), hours.to_string())].into_iter().collect();
        if let Ok(b) = st.overlays.get("lsr", &q, &keys).await {
            let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
            for f in v["features"].as_array().cloned().unwrap_or_default() {
                let p = &f["properties"];
                let c2 = &f["geometry"]["coordinates"];
                let (Some(flon), Some(flat)) = (c2[0].as_f64(), c2[1].as_f64()) else { continue };
                if crate::srules::distance(lat, lon, flat, flon) > c.event_mi * 1609.344 {
                    continue;
                }
                let Some(t) = p["valid"].as_str().and_then(parse_time) else { continue };
                if t < start || t > end + 30 * 60_000 {
                    continue;
                }
                let mag = match (p["mag"].as_f64(), p["unit"].as_str()) {
                    (Some(m), Some(u)) if m > 0.0 => format!(" {m} {u}"),
                    _ => String::new(),
                };
                chapters.push(json!({"t": t, "offset_s": offset_of(&times, t, fps), "title": format!("{}{mag} — {}", p["typetext"].as_str().unwrap_or("Report"), p["city"].as_str().unwrap_or("")), "kind": "lsr", "remark": p["remark"]}));
            }
        }
    }
    chapters.sort_by_key(|c| c["t"].as_i64().unwrap_or(0));
    let meta = json!({"cam": c.id, "name": c.name, "date": day, "frames": imgs.len(), "fps": fps, "duration_s": ((imgs.len() as f64 / fps as f64) * 10.0).round() / 10.0, "start": start, "end": end, "partial": partial, "lat": c.lat, "lon": c.lon, "chapters": chapters, "built": now_ms()});
    std::fs::write(out_dir.join(format!("{day}.json")), serde_json::to_vec_pretty(&meta)?)?;
    if !partial {
        std::fs::remove_dir_all(&sd).ok();
    }
    tracing::info!("timelapse: {} {day} built ({} stills)", c.id, imgs.len());
    st.hub.send(json!({"type": "timelapse", "cam": c.id, "date": day}));
    Ok(out_dir.join(format!("{day}.mp4")))
}

fn parse_time(s: &str) -> Option<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(t.timestamp_millis());
    }
    for f in ["%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%MZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return Some(t.and_utc().timestamp_millis());
        }
    }
    None
}

/// Retention + finished days → videos.
async fn housekeeping(st: &AppState) {
    let today = Local::now().date_naive();
    let cams = st.timelapse.cams.read().clone();
    for c in cams {
        let tl = &st.timelapse;
        let still_days = Timelapse::list_dirs(&tl.cam_dir(&c.id).join("stills"));
        let videos = tl.videos(&c.id);
        // a day built early with POST /build (partial) still gets its full video
        let finished: Vec<String> = videos
            .iter()
            .filter(|d| {
                let meta: Value = std::fs::read(tl.cam_dir(&c.id).join(format!("{d}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
                !meta["partial"].as_bool().unwrap_or(false)
            })
            .cloned()
            .collect();
        if st.rec.has_ffmpeg() {
            for d in days_to_build(&still_days, &finished, today) {
                if let Err(e) = build(st, &c, &d, false).await {
                    tracing::warn!("timelapse {} {d}: {e:#}", c.id);
                    st.timelapse.status.lock().entry(c.id.clone()).or_default().last_error = format!("build {d}: {e}");
                    // a day that can't be built (one still) is dropped after a day
                    if (today - NaiveDate::parse_from_str(&d, "%Y-%m-%d").unwrap_or(today)).num_days() > 1 {
                        std::fs::remove_dir_all(tl.stills(&c.id, &d)).ok();
                    }
                }
            }
        }
        for d in expired(&videos, today, c.retention_days) {
            for ext in ["mp4", "json", "jpg"] {
                std::fs::remove_file(tl.cam_dir(&c.id).join(format!("{d}.{ext}"))).ok();
            }
        }
        for d in expired(&still_days, today, c.retention_days.max(2)) {
            std::fs::remove_dir_all(tl.stills(&c.id, &d)).ok();
        }
    }
}

pub fn spawn(st: Arc<AppState>) {
    tokio::spawn(async move {
        let mut last_house = std::time::Instant::now() - Duration::from_secs(3600);
        let mut last_day = Local::now().day();
        loop {
            let cams: Vec<TlCam> = st.timelapse.cams.read().iter().filter(|c| c.enabled).cloned().collect();
            if !cams.is_empty() {
                let now = now_ms();
                let alerts: Vec<Value> = st.alerts.current.read().values().cloned().collect();
                for c in cams {
                    let last_try = st.timelapse.status.lock().get(&c.id).map(|s| s.last_try).unwrap_or(0);
                    if !due(&c, last_try, now) {
                        continue;
                    }
                    st.timelapse.status.lock().entry(c.id.clone()).or_default().last_try = now;
                    st.timelapse.note_events(&c, &alerts, now);
                    let st2 = st.clone();
                    tokio::spawn(async move {
                        let r = capture(&st2, &c).await;
                        let mut s = st2.timelapse.status.lock();
                        let e = s.entry(c.id.clone()).or_default();
                        match r {
                            Ok(_) => e.last_error.clear(),
                            Err(err) => e.last_error = format!("{err:#}"),
                        }
                    });
                }
            }
            let day = Local::now().day();
            if day != last_day || last_house.elapsed() > Duration::from_secs(3600) {
                last_day = day;
                last_house = std::time::Instant::now();
                housekeeping(&st).await;
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

// ---------- HTTP ----------

type St = State<Arc<AppState>>;

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

fn cams_json(st: &AppState) -> Value {
    let cams = st.timelapse.cams.read().clone();
    let today = day_of(now_ms());
    let s = st.timelapse.status.lock().clone();
    let status: serde_json::Map<String, Value> = cams
        .iter()
        .map(|c| {
            let x = s.get(&c.id).cloned().unwrap_or_default();
            let frames = std::fs::read_dir(st.timelapse.stills(&c.id, &today)).map(|rd| rd.flatten().filter(|e| !e.file_name().to_string_lossy().ends_with(".json")).count()).unwrap_or(0);
            let daylight = match (c.lat, c.lon) {
                (Some(a), Some(b)) => json!(sun_elevation(a, b, now_ms()) > -6.0),
                _ => Value::Null,
            };
            (c.id.clone(), json!({"last_capture": x.last_capture, "frames_today": frames, "last_error": x.last_error, "next_capture": if x.last_try > 0 { x.last_try + c.interval_min as i64 * 60_000 } else { 0 }, "daylight": daylight}))
        })
        .collect();
    json!({"cams": cams, "ffmpeg": st.rec.has_ffmpeg(), "status": status})
}

pub async fn get_cams(State(st): St) -> Json<Value> {
    Json(cams_json(&st))
}

#[derive(Deserialize)]
pub struct PutCams {
    cams: Vec<TlCam>,
}

pub async fn put_cams(State(st): St, Json(b): Json<PutCams>) -> Response {
    if b.cams.len() > MAX_CAMS {
        return err(StatusCode::BAD_REQUEST, format!("at most {MAX_CAMS} cameras"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut cams = b.cams;
    for c in cams.iter_mut() {
        if c.id.trim().is_empty() || c.id.len() > 100 || !seen.insert(rec_id(&c.id)) {
            return err(StatusCode::BAD_REQUEST, format!("camera ids must be unique and non-empty ({:?})", c.id));
        }
        if c.url.is_empty() && c.cam_id.is_empty() {
            return err(StatusCode::BAD_REQUEST, format!("camera {}: url or cam_id required", c.id));
        }
        if !c.url.is_empty() && c.url != "proxy" && !crate::radio::valid_url(&c.url) {
            return err(StatusCode::BAD_REQUEST, format!("camera {}: url must be http(s)", c.id));
        }
        c.interval_min = c.interval_min.clamp(1, 1440);
        c.retention_days = c.retention_days.clamp(1, 3650);
        c.fps = c.fps.clamp(1, 60);
    }
    let tl = st.timelapse.clone();
    match tokio::task::spawn_blocking(move || tl.set(cams)).await {
        Ok(Ok(())) => Json(cams_json(&st)).into_response(),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

pub async fn list(State(st): St, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    Json(json!({"items": st.timelapse.list(q.get("cam").map(|s| s.as_str()).filter(|s| !s.is_empty()))}))
}

pub async fn build_now(State(st): St, Json(b): Json<Value>) -> Response {
    let Some(cam) = b["cam"].as_str() else { return err(StatusCode::BAD_REQUEST, "cam required") };
    let Some(c) = st.timelapse.cams.read().iter().find(|c| c.id == cam).cloned() else { return err(StatusCode::NOT_FOUND, "no such camera") };
    let today = day_of(now_ms());
    let day = b["date"].as_str().unwrap_or(&today).to_string();
    if NaiveDate::parse_from_str(&day, "%Y-%m-%d").is_err() {
        return err(StatusCode::BAD_REQUEST, "date must be YYYY-MM-DD");
    }
    match build(&st, &c, &day, day == today).await {
        Ok(_) => Json(json!({"ok": true, "items": st.timelapse.list(Some(cam)).into_iter().filter(|i| i["date"] == day).collect::<Vec<_>>()})).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, format!("{e:#}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sun() {
        // Oklahoma City, 2026-06-21: ~78° at solar noon (18:30 UTC), well below the horizon at 06:30 UTC
        let noon = chrono::Utc.with_ymd_and_hms(2026, 6, 21, 18, 30, 0).unwrap().timestamp_millis();
        let night = chrono::Utc.with_ymd_and_hms(2026, 6, 21, 6, 30, 0).unwrap().timestamp_millis();
        let e = sun_elevation(35.47, -97.52, noon);
        assert!((e - 78.0).abs() < 1.5, "{e}");
        assert!(sun_elevation(35.47, -97.52, night) < -20.0);
    }

    #[test]
    fn scheduling() {
        let mut c = TlCam { interval_min: 5, daylight_only: false, ..Default::default() };
        let t = 1_800_000_000_000i64;
        assert!(due(&c, 0, t));
        assert!(!due(&c, t - 4 * 60_000, t));
        assert!(due(&c, t - 5 * 60_000, t));
        c.daylight_only = true;
        c.lat = Some(35.47);
        c.lon = Some(-97.52);
        let night = chrono::Utc.with_ymd_and_hms(2026, 6, 21, 6, 30, 0).unwrap().timestamp_millis();
        let day = chrono::Utc.with_ymd_and_hms(2026, 6, 21, 18, 30, 0).unwrap().timestamp_millis();
        assert!(!due(&c, 0, night));
        assert!(due(&c, 0, day));
        c.enabled = false;
        assert!(!due(&c, 0, day));
        // without a location daylight_only can't apply
        let c2 = TlCam { daylight_only: true, ..Default::default() };
        assert!(due(&c2, 0, night));
    }

    #[test]
    fn days() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 13).unwrap();
        let stills = vec!["2026-10-11".to_string(), "2026-10-12".into(), "2026-10-13".into(), "junk".into()];
        let videos = vec!["2026-10-11".to_string()];
        assert_eq!(days_to_build(&stills, &videos, today), vec!["2026-10-12"]);
        let vids = vec!["2026-09-01".to_string(), "2026-09-28".into(), "2026-09-29".into(), "2026-10-12".into()];
        assert_eq!(expired(&vids, today, 14), vec!["2026-09-01", "2026-09-28"]);
        assert_eq!(offset_of(&[0, 10, 20, 30], 15, 2), 1.0);
        assert_eq!(offset_of(&[0, 10, 20, 30], 99, 2), 1.5);
        assert_eq!(rec_id("cam/1:a"), "tl_cam_1_a");
        assert_eq!(parse_time("2026-05-20T22:03:00Z"), Some(chrono::Utc.with_ymd_and_hms(2026, 5, 20, 22, 3, 0).unwrap().timestamp_millis()));
    }
}
