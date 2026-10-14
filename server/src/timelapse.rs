//! Webcam auto-timelapses: frames captured on a schedule (still-image cameras, or one frame
//! grabbed from a video stream with ffmpeg — HLS, or YouTube through yt-dlp), one MP4 per camera
//! per segment (ffmpeg), tagged with the warnings and storm reports near the camera.
//!
//! A segment is one day by default (key `YYYY-MM-DD`); `length_min` sets another rolling length
//! (key `YYYY-MM-DD_HHMM` = segment start, local time, aligned so days start at midnight and
//! weeks on Monday), and `until` makes one single timelapse that ends at that time (key
//! `to_YYYY-MM-DD_HHMM`).
//!
//! Files live in `data/recordings/tl_<cam>/` so the recordings file route serves them:
//! `GET /api/rec/tl_<cam>/file/<key>.mp4` (+ `.json` chapters, `.jpg` poster). Stills are
//! kept in `tl_<cam>/stills/<key>/` until the segment's video exists and are then removed.
//!
//! * `GET  /api/timelapse/cams` → `{cams, ffmpeg, ytdlp, status:{<cam>: {last_capture, frames_today, last_error, next_capture, segment, segment_end}}}`
//! * `PUT  /api/timelapse/cams {cams:[{id, name, kind?, url | cam_id, lat?, lon?, interval_min, interval_s?, length_min?, until?, daylight_only, retention_days, fps?, enabled?}]}`
//! * `GET  /api/timelapse/list?cam=` → `{items:[{cam, date (= key), label, video, chapters_url, poster, frames, fps, duration_s, size, chapters}]}`
//! * `POST /api/timelapse/build {cam, date?}` → build (or rebuild) a segment now (the open one = partial)

use crate::api::AppState;
use anyhow::{anyhow, bail, Result};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const MAX_CAMS: usize = 100;
const DAY_MIN: u32 = 1440;
/// longest rolling segment: one year
const MAX_LEN_MIN: u32 = 366 * DAY_MIN;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct TlCam {
    pub id: String,
    pub name: String,
    /// img (still image) | hls (video stream) | yt (YouTube video / live stream): video cameras
    /// get one frame grabbed with ffmpeg per capture
    pub kind: String,
    /// img: still-image URL; or empty with `cam_id` (a camera from /api/ovl/cameras, resolved by
    /// the server). hls / yt: the stream URL
    pub url: String,
    pub cam_id: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// minutes between stills
    pub interval_min: u32,
    /// seconds between stills (overrides `interval_min` when > 0)
    pub interval_s: u32,
    /// minutes per video (rolling); 1440 = one video per day (default)
    pub length_min: u32,
    /// one single timelapse ending at this time (unix ms) instead of rolling videos
    pub until: Option<i64>,
    /// only capture between civil dawn and dusk (needs lat/lon)
    pub daylight_only: bool,
    /// keep videos this many days (counted from the end of their segment)
    pub retention_days: u32,
    pub fps: u32,
    pub enabled: bool,
    /// tag warnings / storm reports within this distance (mi)
    pub event_mi: f64,
}

impl Default for TlCam {
    fn default() -> Self {
        TlCam { id: String::new(), name: String::new(), kind: "img".into(), url: String::new(), cam_id: String::new(), lat: None, lon: None, interval_min: 5, interval_s: 0, length_min: DAY_MIN, until: None, daylight_only: true, retention_days: 14, fps: 24, enabled: true, event_mi: 15.0 }
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
    if !c.enabled || c.until.map(|u| now >= u).unwrap_or(false) {
        return false;
    }
    if now - last_try < interval_ms(c) {
        return false;
    }
    if c.daylight_only {
        if let (Some(lat), Some(lon)) = (c.lat, c.lon) {
            return sun_elevation(lat, lon, now) > -6.0;
        }
    }
    true
}

/// Time between captures (ms).
pub fn interval_ms(c: &TlCam) -> i64 {
    if c.interval_s > 0 {
        c.interval_s.clamp(5, 86_400) as i64 * 1000
    } else {
        c.interval_min.clamp(1, 1440) as i64 * 60_000
    }
}

/// Is this a video camera (a frame is grabbed from the stream)?
pub fn is_video(c: &TlCam) -> bool {
    c.kind == "hls" || c.kind == "yt"
}

fn len_min(c_len: u32) -> u32 {
    if c_len == 0 { DAY_MIN } else { c_len.clamp(5, MAX_LEN_MIN) }
}

/// Segments are aligned to a Monday midnight (local), so days start at midnight and weeks on Monday.
fn anchor() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2000, 1, 3).unwrap().and_hms_opt(0, 0, 0).unwrap()
}

/// Start of the rolling segment holding `t` (local naive time).
pub fn seg_start(length_min: u32, t: NaiveDateTime) -> NaiveDateTime {
    let len = len_min(length_min) as i64;
    let m = (t - anchor()).num_minutes();
    anchor() + chrono::Duration::minutes(m.div_euclid(len) * len)
}

/// Segment key for local time `t`: `YYYY-MM-DD` (one day), `YYYY-MM-DD_HHMM` (other lengths) or
/// `to_YYYY-MM-DD_HHMM` (a single timelapse ending at `until`).
pub fn seg_key_naive(length_min: u32, until: Option<NaiveDateTime>, t: NaiveDateTime) -> String {
    if let Some(u) = until {
        return format!("to_{}", u.format("%Y-%m-%d_%H%M"));
    }
    let s = seg_start(length_min, t);
    if len_min(length_min) == DAY_MIN { s.format("%Y-%m-%d").to_string() } else { s.format("%Y-%m-%d_%H%M").to_string() }
}

fn local_naive(t_ms: i64) -> NaiveDateTime {
    match Local.timestamp_millis_opt(t_ms).single() {
        Some(d) => d.naive_local(),
        None => chrono::DateTime::from_timestamp_millis(t_ms).unwrap_or_default().naive_utc(),
    }
}

fn naive_ms(n: NaiveDateTime) -> i64 {
    Local.from_local_datetime(&n).earliest().map(|d| d.timestamp_millis()).unwrap_or_else(|| n.and_utc().timestamp_millis())
}

/// The segment frames taken at `t_ms` go into; None once a single timelapse has ended.
pub fn open_seg(c: &TlCam, t_ms: i64) -> Option<String> {
    if let Some(u) = c.until {
        if t_ms >= u {
            return None;
        }
    }
    Some(seg_key_naive(c.length_min, c.until.map(local_naive), local_naive(t_ms)))
}

/// When the open segment ends (unix ms).
pub fn seg_end_ms(c: &TlCam, t_ms: i64) -> Option<i64> {
    if let Some(u) = c.until {
        return (t_ms < u).then_some(u);
    }
    Some(naive_ms(seg_start(c.length_min, local_naive(t_ms)) + chrono::Duration::minutes(len_min(c.length_min) as i64)))
}

/// Start (local) of a segment key; None for anything that isn't one.
pub fn key_start(key: &str) -> Option<NaiveDateTime> {
    let k = key.strip_prefix("to_").unwrap_or(key);
    match k.len() {
        10 if !key.starts_with("to_") => NaiveDate::parse_from_str(k, "%Y-%m-%d").ok()?.and_hms_opt(0, 0, 0),
        15 => NaiveDateTime::parse_from_str(k, "%Y-%m-%d_%H%M").ok(),
        _ => None,
    }
}

/// Human label of a segment key.
pub fn key_label(key: &str) -> String {
    match (key.strip_prefix("to_"), key_start(key)) {
        (_, None) => key.to_string(),
        (Some(_), Some(t)) => format!("until {}", t.format("%Y-%m-%d %H:%M")),
        (None, Some(t)) if key.len() == 10 => t.format("%Y-%m-%d").to_string(),
        (None, Some(t)) => t.format("%Y-%m-%d %H:%M").to_string(),
    }
}

/// Segments that have stills but no finished video and are closed (not the open one).
pub fn days_to_build(still_keys: &[String], videos: &[String], open: Option<&str>) -> Vec<String> {
    let mut v: Vec<String> = still_keys.iter().filter(|d| key_start(d).is_some() && Some(d.as_str()) != open && !videos.contains(d)).cloned().collect();
    v.sort();
    v
}

/// Keys whose (start) date is older than the retention window.
pub fn expired(days: &[String], today: NaiveDate, retention_days: u32) -> Vec<String> {
    days.iter().filter(|d| key_start(d).map(|x| (today - x.date()).num_days() > retention_days.max(1) as i64).unwrap_or(false)).cloned().collect()
}

/// Extra days a segment's start lies before its end (0 for one day or less).
fn extra_days(c: &TlCam) -> u32 {
    if c.until.is_some() { 0 } else { (len_min(c.length_min) - 1) / DAY_MIN }
}

/// Video offset (s) of a time, given the sorted frame times.
pub fn offset_of(frames: &[i64], t: i64, fps: u32) -> f64 {
    let i = frames.partition_point(|&x| x < t);
    let i = i.min(frames.len().saturating_sub(1));
    ((i as f64 / fps.max(1) as f64) * 10.0).round() / 10.0
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
            days.sort_by_key(|k| std::cmp::Reverse((key_start(k), k.clone())));
            for day in days {
                let meta: Value = std::fs::read(d.join(format!("{day}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
                let size = std::fs::metadata(d.join(format!("{day}.mp4"))).map(|m| m.len()).unwrap_or(0);
                let id = rec_id(&c);
                out.push(json!({
                    "cam": c, "date": day, "label": key_label(&day), "size": size,
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
        let Some(day) = open_seg(cam, now) else { return };
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
    /// Add storm reports to the open segment's events (deduplicated by time + title).
    fn note_reports(&self, cam: &TlCam, reports: Vec<Value>, now: i64) {
        let Some(day) = open_seg(cam, now) else { return };
        let p = self.stills(&cam.id, &day).join("events.json");
        let mut ev: Vec<Value> = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let n = ev.len();
        for r in reports {
            if !ev.iter().any(|e| e["kind"] == "lsr" && e["t"] == r["t"] && e["title"] == r["title"]) {
                ev.push(r);
            }
        }
        if ev.len() != n {
            std::fs::create_dir_all(p.parent().unwrap()).ok();
            let _ = std::fs::write(&p, serde_json::to_vec(&ev).unwrap_or_default());
        }
    }
}

/// Storm reports (LSR GeoJSON) within `mi` of a point between `from` and `to` (ms) as events.
pub fn lsr_events(v: &Value, lat: f64, lon: f64, mi: f64, from: i64, to: i64) -> Vec<Value> {
    let mut out = vec![];
    for f in v["features"].as_array().cloned().unwrap_or_default() {
        let p = &f["properties"];
        let c2 = &f["geometry"]["coordinates"];
        let (Some(flon), Some(flat)) = (c2[0].as_f64(), c2[1].as_f64()) else { continue };
        if crate::srules::distance(lat, lon, flat, flon) > mi * 1609.344 {
            continue;
        }
        let Some(t) = p["valid"].as_str().and_then(parse_time) else { continue };
        if t < from || t > to {
            continue;
        }
        let mag = match (p["mag"].as_f64(), p["unit"].as_str()) {
            (Some(m), Some(u)) if m > 0.0 => format!(" {m} {u}"),
            _ => String::new(),
        };
        out.push(json!({"t": t, "title": format!("{}{mag} — {}", p["typetext"].as_str().unwrap_or("Report"), p["city"].as_str().unwrap_or("")), "kind": "lsr", "remark": p["remark"]}));
    }
    out
}

async fn fetch_lsr(st: &AppState, hours: i64) -> Option<Value> {
    let keys = st.cfg.read().keys.clone();
    let q: crate::overlays::Params = [("hours".to_string(), hours.clamp(1, 72).to_string())].into_iter().collect();
    let b = st.overlays.get("lsr", &q, &keys).await.ok()?;
    serde_json::from_slice(&b).ok()
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

/// YouTube page URL → direct stream URL (yt-dlp -g), cached for 20 minutes.
async fn youtube_direct(st: &AppState, url: &str) -> Result<String> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, (String, std::time::Instant)>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((u, at)) = cache.lock().get(url) {
        if at.elapsed() < Duration::from_secs(20 * 60) {
            return Ok(u.clone());
        }
    }
    if !st.rec.has_ytdlp() {
        bail!("YouTube timelapses need yt-dlp on the server");
    }
    let out = tokio::time::timeout(Duration::from_secs(60), crate::platform::command("yt-dlp").args(["-g", "-q", "--no-warnings", "--no-playlist", "-f", "best[height<=1080]/best", url]).kill_on_drop(true).output()).await.map_err(|_| anyhow!("yt-dlp timed out"))??;
    let direct = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
    if !out.status.success() || !direct.starts_with("http") {
        bail!("yt-dlp: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("no stream URL"));
    }
    let mut c = cache.lock();
    c.retain(|_, v| v.1.elapsed() < Duration::from_secs(20 * 60));
    c.insert(url.to_string(), (direct.clone(), std::time::Instant::now()));
    Ok(direct)
}

/// One JPEG frame from a video stream (ffmpeg -frames:v 1).
async fn grab_frame(st: &AppState, c: &TlCam) -> Result<bytes::Bytes> {
    if !st.rec.has_ffmpeg() {
        bail!("video timelapses need ffmpeg on the server");
    }
    let src = if c.kind == "yt" { youtube_direct(st, &c.url).await? } else { c.url.clone() };
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        crate::platform::command("ffmpeg")
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-rw_timeout", "15000000", "-i", &src, "-an", "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1"])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("ffmpeg timed out reading the stream"))??;
    if !out.status.success() || out.stdout.len() < 500 {
        bail!("ffmpeg: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("no frame"));
    }
    Ok(out.stdout.into())
}

async fn capture(st: &AppState, c: &TlCam) -> Result<bool> {
    let b = if is_video(c) {
        grab_frame(st, c).await?
    } else {
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
        b
    };
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
    let Some(seg) = open_seg(c, t) else { return Ok(false) };
    let d = st.timelapse.stills(&c.id, &seg);
    tokio::fs::create_dir_all(&d).await?;
    tokio::fs::write(d.join(format!("{t}.{ext}")), &b).await?;
    let mut s = st.timelapse.status.lock();
    let e = s.entry(c.id.clone()).or_default();
    e.last_hash = h;
    e.last_capture = t;
    Ok(true)
}

/// Build the MP4 for one camera segment (stills → video, chapters, poster).
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
    // chapters: warnings seen while capturing + storm reports near the camera (collected along
    // the way for long segments, plus the last 72 h from the report feed)
    let times: Vec<i64> = imgs.iter().map(|x| x.0).collect();
    let (start, end) = (times[0], *times.last().unwrap());
    let mut chapters: Vec<Value> = vec![];
    let evs: Vec<Value> = std::fs::read(sd.join("events.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    for e in evs {
        let t = e["t"].as_i64().unwrap_or(start);
        if e["kind"] == "lsr" {
            if t >= start && t <= end + 30 * 60_000 {
                chapters.push(json!({"t": t, "offset_s": offset_of(&times, t, fps), "title": e["title"], "kind": "lsr", "remark": e["remark"]}));
            }
            continue;
        }
        chapters.push(json!({"t": t, "end": e["last"], "offset_s": offset_of(&times, t, fps), "title": e["title"], "kind": "warning", "id": e["id"]}));
    }
    if let (Some(lat), Some(lon)) = (c.lat, c.lon) {
        let hours = (now_ms() - start) / 3_600_000 + 2;
        if let Some(v) = fetch_lsr(st, hours).await {
            for r in lsr_events(&v, lat, lon, c.event_mi, start, end + 30 * 60_000) {
                if chapters.iter().any(|x| x["kind"] == "lsr" && x["t"] == r["t"] && x["title"] == r["title"]) {
                    continue;
                }
                let t = r["t"].as_i64().unwrap_or(start);
                chapters.push(json!({"t": t, "offset_s": offset_of(&times, t, fps), "title": r["title"], "kind": "lsr", "remark": r["remark"]}));
            }
        }
    }
    chapters.sort_by_key(|c| c["t"].as_i64().unwrap_or(0));
    let meta = json!({"cam": c.id, "name": c.name, "date": day, "label": key_label(day), "frames": imgs.len(), "fps": fps, "duration_s": ((imgs.len() as f64 / fps as f64) * 10.0).round() / 10.0, "start": start, "end": end, "partial": partial, "lat": c.lat, "lon": c.lon, "chapters": chapters, "built": now_ms()});
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

/// Retention + finished segments → videos (+ storm reports for segments longer than 2 days).
async fn housekeeping(st: &AppState) {
    let today = Local::now().date_naive();
    let now = now_ms();
    let cams = st.timelapse.cams.read().clone();
    let mut lsr: Option<Option<Value>> = None;
    for c in cams {
        let tl = &st.timelapse;
        let open = open_seg(&c, now);
        // the report feed only goes back 72 h: collect reports for long segments as they come in
        if let (true, Some(lat), Some(lon), Some(_)) = (c.enabled && (c.until.is_some() || len_min(c.length_min) > 2 * DAY_MIN), c.lat, c.lon, &open) {
            if lsr.is_none() {
                lsr = Some(fetch_lsr(st, 3).await);
            }
            if let Some(Some(v)) = &lsr {
                tl.note_reports(&c, lsr_events(v, lat, lon, c.event_mi, now - 3 * 3_600_000, now), now);
            }
        }
        let still_days = Timelapse::list_dirs(&tl.cam_dir(&c.id).join("stills"));
        let videos = tl.videos(&c.id);
        // a segment built early with POST /build (partial) still gets its full video
        let finished: Vec<String> = videos
            .iter()
            .filter(|d| {
                let meta: Value = std::fs::read(tl.cam_dir(&c.id).join(format!("{d}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
                !meta["partial"].as_bool().unwrap_or(false)
            })
            .cloned()
            .collect();
        if st.rec.has_ffmpeg() {
            for d in days_to_build(&still_days, &finished, open.as_deref()) {
                if let Err(e) = build(st, &c, &d, false).await {
                    tracing::warn!("timelapse {} {d}: {e:#}", c.id);
                    st.timelapse.status.lock().entry(c.id.clone()).or_default().last_error = format!("build {}: {e}", key_label(&d));
                    // a segment that can't be built (one still) is dropped after a day
                    if key_start(&d).map(|s| (today - s.date()).num_days() > 1 + extra_days(&c) as i64).unwrap_or(true) {
                        std::fs::remove_dir_all(tl.stills(&c.id, &d)).ok();
                    }
                }
            }
        }
        for d in expired(&videos, today, c.retention_days + extra_days(&c)) {
            for ext in ["mp4", "json", "jpg"] {
                std::fs::remove_file(tl.cam_dir(&c.id).join(format!("{d}.{ext}"))).ok();
            }
        }
        for d in expired(&still_days, today, c.retention_days.max(2) + extra_days(&c)) {
            if Some(&d) != open.as_ref() {
                std::fs::remove_dir_all(tl.stills(&c.id, &d)).ok();
            }
        }
    }
}

pub fn spawn(st: Arc<AppState>) {
    tokio::spawn(async move {
        let mut last_house = std::time::Instant::now() - Duration::from_secs(3600);
        // the open segment of each camera: a change (segment ended) builds its video
        let mut last_seg: HashMap<String, Option<String>> = HashMap::new();
        loop {
            let all: Vec<TlCam> = st.timelapse.cams.read().clone();
            let now = now_ms();
            let mut rolled = false;
            for c in &all {
                let s = open_seg(c, now);
                if last_seg.get(&c.id).map(|x| *x != s).unwrap_or(false) {
                    rolled = true;
                }
                last_seg.insert(c.id.clone(), s);
            }
            last_seg.retain(|k, _| all.iter().any(|c| &c.id == k));
            let cams: Vec<TlCam> = all.into_iter().filter(|c| c.enabled).collect();
            if !cams.is_empty() {
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
            if rolled || last_house.elapsed() > Duration::from_secs(3600) {
                last_house = std::time::Instant::now();
                housekeeping(&st).await;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

/// Why a video camera can't be captured on this server (None = fine / not a video camera).
pub fn video_problem(c: &TlCam, ffmpeg: bool, ytdlp: bool) -> Option<&'static str> {
    if !is_video(c) {
        return None;
    }
    if !crate::radio::valid_url(&c.url) {
        return Some("video timelapses need the stream's http(s) URL");
    }
    if !ffmpeg {
        return Some("video timelapses need ffmpeg on the server");
    }
    if c.kind == "yt" {
        if !crate::recorder::is_youtube_video(&c.url) {
            return Some("pick a single YouTube video or live stream (watch, youtu.be, /live/)");
        }
        if !ytdlp {
            return Some("YouTube timelapses need yt-dlp on the server");
        }
    }
    None
}

// ---------- HTTP ----------

type St = State<Arc<AppState>>;

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

fn cams_json(st: &AppState) -> Value {
    let cams = st.timelapse.cams.read().clone();
    let now = now_ms();
    let s = st.timelapse.status.lock().clone();
    let status: serde_json::Map<String, Value> = cams
        .iter()
        .map(|c| {
            let x = s.get(&c.id).cloned().unwrap_or_default();
            let seg = open_seg(c, now);
            let frames = seg.as_ref().and_then(|k| std::fs::read_dir(st.timelapse.stills(&c.id, k)).ok()).map(|rd| rd.flatten().filter(|e| !e.file_name().to_string_lossy().ends_with(".json") && !e.file_name().to_string_lossy().ends_with(".txt")).count()).unwrap_or(0);
            let daylight = match (c.lat, c.lon) {
                (Some(a), Some(b)) => json!(sun_elevation(a, b, now_ms()) > -6.0),
                _ => Value::Null,
            };
            (
                c.id.clone(),
                json!({
                    "last_capture": x.last_capture, "frames_today": frames, "last_error": x.last_error,
                    "next_capture": if x.last_try > 0 && seg.is_some() { x.last_try + interval_ms(c) } else { 0 },
                    "daylight": daylight, "segment": seg, "segment_label": seg.as_deref().map(key_label),
                    "segment_end": seg.as_ref().and_then(|_| seg_end_ms(c, now)), "ended": seg.is_none(),
                }),
            )
        })
        .collect();
    json!({"cams": cams, "ffmpeg": st.rec.has_ffmpeg(), "ytdlp": st.rec.has_ytdlp(), "status": status})
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
    let old = st.timelapse.cams.read().clone();
    for c in cams.iter_mut() {
        if c.kind.is_empty() {
            c.kind = "img".into();
        }
        if !["img", "hls", "yt"].contains(&c.kind.as_str()) {
            return err(StatusCode::BAD_REQUEST, format!("camera {}: kind must be img, hls or yt", c.id));
        }
        // video cameras need ffmpeg (YouTube also yt-dlp); cameras saved earlier stay as they are
        let known = old.iter().any(|o| o.id == c.id && o.kind == c.kind && o.url == c.url);
        if let Some(why) = video_problem(c, st.rec.has_ffmpeg(), st.rec.has_ytdlp()).filter(|_| !known) {
            return err(StatusCode::BAD_REQUEST, format!("{}: {why}", if c.name.is_empty() { &c.id } else { &c.name }));
        }
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
        if c.interval_s > 0 {
            c.interval_s = c.interval_s.clamp(5, 86_400);
        }
        c.length_min = len_min(c.length_min);
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
    let open = open_seg(&c, now_ms());
    // default: the open segment, or (a single timelapse that has ended) its own key
    let fallback = open.clone().or_else(|| c.until.map(|u| seg_key_naive(c.length_min, Some(local_naive(u)), local_naive(u)))).unwrap_or_default();
    let day = b["date"].as_str().map(str::to_string).unwrap_or(fallback);
    if key_start(&day).is_none() {
        return err(StatusCode::BAD_REQUEST, "date must be a segment key (YYYY-MM-DD, YYYY-MM-DD_HHMM or to_YYYY-MM-DD_HHMM)");
    }
    let partial = open.as_deref() == Some(day.as_str());
    match build(&st, &c, &day, partial).await {
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
        assert_eq!(days_to_build(&stills, &videos, Some("2026-10-13")), vec!["2026-10-12"]);
        let vids = vec!["2026-09-01".to_string(), "2026-09-28".into(), "2026-09-29".into(), "2026-10-12".into()];
        assert_eq!(expired(&vids, today, 14), vec!["2026-09-01", "2026-09-28"]);
        assert_eq!(offset_of(&[0, 10, 20, 30], 15, 2), 1.0);
        assert_eq!(offset_of(&[0, 10, 20, 30], 99, 2), 1.5);
        assert_eq!(rec_id("cam/1:a"), "tl_cam_1_a");
        assert_eq!(parse_time("2026-05-20T22:03:00Z"), Some(chrono::Utc.with_ymd_and_hms(2026, 5, 20, 22, 3, 0).unwrap().timestamp_millis()));
    }

    fn nt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn segments_by_length() {
        // default: one per day, same keys as before
        assert_eq!(seg_key_naive(1440, None, nt("2026-10-14 13:45")), "2026-10-14");
        assert_eq!(seg_key_naive(0, None, nt("2026-10-14 00:00")), "2026-10-14");
        assert_eq!(seg_key_naive(1440, None, nt("2026-10-13 23:59")), "2026-10-13");
        // hours
        assert_eq!(seg_key_naive(60, None, nt("2026-10-14 13:45")), "2026-10-14_1300");
        assert_eq!(seg_key_naive(6 * 60, None, nt("2026-10-14 13:45")), "2026-10-14_1200");
        assert_eq!(seg_key_naive(6 * 60, None, nt("2026-10-14 05:59")), "2026-10-14_0000");
        // minutes
        assert_eq!(seg_key_naive(15, None, nt("2026-10-14 13:44")), "2026-10-14_1330");
        // weeks start on Monday (2026-10-12 is a Monday)
        assert_eq!(seg_key_naive(7 * 1440, None, nt("2026-10-14 13:45")), "2026-10-12_0000");
        assert_eq!(seg_key_naive(7 * 1440, None, nt("2026-10-18 23:59")), "2026-10-12_0000");
        assert_eq!(seg_key_naive(7 * 1440, None, nt("2026-10-19 00:00")), "2026-10-19_0000");
        // 2 days: consecutive, non-overlapping
        let a = seg_start(2 * 1440, nt("2026-10-14 10:00"));
        let b = seg_start(2 * 1440, a + chrono::Duration::minutes(2 * 1440));
        assert_eq!((b - a).num_minutes(), 2 * 1440);
        // single timelapse ending at a time
        assert_eq!(seg_key_naive(60, Some(nt("2026-10-20 18:00")), nt("2026-10-14 13:45")), "to_2026-10-20_1800");
        // keys parse back; labels
        assert_eq!(key_start("2026-10-14"), Some(nt("2026-10-14 00:00")));
        assert_eq!(key_start("2026-10-14_1300"), Some(nt("2026-10-14 13:00")));
        assert_eq!(key_start("to_2026-10-20_1800"), Some(nt("2026-10-20 18:00")));
        assert_eq!(key_start("to_2026-10-20"), None);
        assert_eq!(key_start("stills"), None);
        assert_eq!(key_label("2026-10-14"), "2026-10-14");
        assert_eq!(key_label("2026-10-14_1300"), "2026-10-14 13:00");
        assert_eq!(key_label("to_2026-10-20_1800"), "until 2026-10-20 18:00");
        // closed segments get built, the open one doesn't; a length change builds the old ones too
        let keys = vec!["2026-10-14_1200".to_string(), "2026-10-14_1300".into(), "2026-10-13".into(), "to_2026-10-20_1800".into()];
        assert_eq!(days_to_build(&keys, &[], Some("2026-10-14_1300")), vec!["2026-10-13", "2026-10-14_1200", "to_2026-10-20_1800"]);
        assert_eq!(days_to_build(&keys, &["2026-10-13".into()], Some("to_2026-10-20_1800")), vec!["2026-10-14_1200", "2026-10-14_1300"]);
        assert_eq!(expired(&keys, NaiveDate::from_ymd_opt(2026, 10, 28).unwrap(), 14), vec!["2026-10-13"]);
    }

    #[test]
    fn single_timelapse_ends() {
        let t = chrono::Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap().timestamp_millis();
        let c = TlCam { daylight_only: false, until: Some(t + 3_600_000), ..Default::default() };
        assert!(open_seg(&c, t).unwrap().starts_with("to_"));
        assert_eq!(seg_end_ms(&c, t), Some(t + 3_600_000));
        assert!(due(&c, 0, t));
        assert!(!due(&c, 0, t + 3_600_000), "no captures after the end");
        assert_eq!(open_seg(&c, t + 3_600_000), None, "closed: its video gets built");
        // rolling: the open segment ends within one length
        let d = TlCam { daylight_only: false, length_min: 60, ..Default::default() };
        let e = seg_end_ms(&d, t).unwrap();
        assert!(e > t && e <= t + 3_600_000, "{e} {t}");
        // seconds between frames (video cameras)
        let v = TlCam { kind: "hls".into(), interval_s: 10, url: "https://example.com/a.m3u8".into(), daylight_only: false, ..Default::default() };
        assert_eq!(interval_ms(&v), 10_000);
        assert!(!due(&v, t - 9_000, t) && due(&v, t - 10_000, t));
        assert_eq!(video_problem(&v, false, false), Some("video timelapses need ffmpeg on the server"));
        assert_eq!(video_problem(&v, true, false), None);
        let y = TlCam { kind: "yt".into(), url: "https://www.youtube.com/watch?v=abc".into(), ..Default::default() };
        assert_eq!(video_problem(&y, true, false), Some("YouTube timelapses need yt-dlp on the server"));
        assert_eq!(video_problem(&TlCam::default(), false, false), None);
    }

    #[test]
    fn reports_near_camera() {
        let v = json!({"features": [
            {"geometry": {"coordinates": [-97.5, 35.5]}, "properties": {"valid": "2026-10-14T12:00:00Z", "typetext": "HAIL", "mag": 1.75, "unit": "INCH", "city": "Moore"}},
            {"geometry": {"coordinates": [-90.0, 35.5]}, "properties": {"valid": "2026-10-14T12:00:00Z", "typetext": "TORNADO", "city": "Far"}},
        ]});
        let t = chrono::Utc.with_ymd_and_hms(2026, 10, 14, 12, 0, 0).unwrap().timestamp_millis();
        let r = lsr_events(&v, 35.47, -97.52, 15.0, t - 1000, t + 1000);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["title"], "HAIL 1.75 INCH — Moore");
        assert!(lsr_events(&v, 35.47, -97.52, 15.0, t + 1, t + 1000).is_empty());
    }
}
