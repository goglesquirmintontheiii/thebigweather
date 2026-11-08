//! Recordings: radar (Level II volumes or Level III products of one site) and cameras (still
//! images per refresh, or video streams copied with ffmpeg — never re-encoded). Manual,
//! scheduled, or started by new warnings (record-on-alert). Recordings are never deleted
//! automatically; they can be exported as .zip and imported on another server.
//!
//! Layout: data/recordings/<id>/meta.json + files. Radar files are served to the app as
//! `rec:<id>/<file>` keys, so recorded loops play through the normal radar path.

use crate::api::AppState;
use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct RadarSpec {
    pub site: String,
    /// "L2" or "L3"
    pub source: String,
    /// L2 moments (REF, VEL…) are display hints — whole volumes are saved. L3: product ids (max 4).
    #[serde(default)]
    pub products: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CamSpec {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub url: String,
    /// img | hls
    pub kind: String,
    #[serde(default)]
    pub refresh: u32,
    #[serde(default)]
    pub lat: f64,
    #[serde(default)]
    pub lon: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Rec {
    pub id: String,
    /// radar | camera
    pub kind: String,
    pub title: String,
    pub created: i64,
    /// planned start/end (unix ms); end None = until stopped
    pub start: i64,
    pub end: Option<i64>,
    /// scheduled | recording | done | error
    pub status: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub radar: Option<RadarSpec>,
    #[serde(default)]
    pub camera: Option<CamSpec>,
    /// manual | schedule | alert: <event>
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub files: usize,
    #[serde(default)]
    pub bytes: u64,
    /// first/last frame time
    #[serde(default)]
    pub t0: i64,
    #[serde(default)]
    pub t1: i64,
    /// 0.8.2: came from an imported .zip (the Recordings tab groups these)
    #[serde(default)]
    pub imported: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Rules {
    /// record-on-alert
    pub enabled: bool,
    pub events: Vec<String>,
    pub minutes: u32,
    pub max_cams: usize,
    pub radar: bool,
    /// only alerts covering one of these points (empty = anywhere)
    #[serde(default)]
    pub points: Vec<(f64, f64)>,
}

impl Default for Rules {
    fn default() -> Self {
        Self { enabled: false, events: vec!["Tornado Warning".into(), "Severe Thunderstorm Warning".into()], minutes: 45, max_cams: 3, radar: true, points: vec![] }
    }
}

pub struct Recorder {
    pub dir: PathBuf,
    recs: Mutex<HashMap<String, Rec>>,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub rules: Mutex<Rules>,
    seen_alerts: Mutex<HashSet<String>>,
    max_cams: usize,
    pub ffmpeg: Mutex<Option<bool>>,
    pub ytdlp: Mutex<Option<bool>>,
}

/// Any YouTube URL.
fn is_youtube(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    l.contains("youtube.com") || l.contains("youtu.be") || l.contains("youtube-nocookie.com")
}

/// A YouTube URL that names one video / live stream (what yt-dlp can record).
pub fn is_youtube_video(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    is_youtube(url) && (l.contains("/watch") || l.contains("youtu.be/") || l.contains("/live/") || l.contains("/embed/") || l.contains("/shorts/"))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn safe(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

impl Recorder {
    pub fn new(data_dir: &Path, full: bool) -> Arc<Self> {
        let dir = data_dir.join("recordings");
        std::fs::create_dir_all(&dir).ok();
        let mut recs = HashMap::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(b) = std::fs::read(e.path().join("meta.json")) {
                    if let Ok(mut r) = serde_json::from_slice::<Rec>(&b) {
                        // a recording that was running when the server stopped picks up again
                        // if its end is still ahead; otherwise it's done
                        if r.status == "recording" && r.end.map(|e| e < now_ms()).unwrap_or(false) {
                            r.status = "done".into();
                        }
                        recs.insert(r.id.clone(), r);
                    }
                }
            }
        }
        let rules = std::fs::read(dir.join("rules.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Arc::new(Self {
            dir,
            recs: Mutex::new(recs),
            running: Mutex::new(HashMap::new()),
            rules: Mutex::new(rules),
            seen_alerts: Mutex::new(HashSet::new()),
            max_cams: if full { 8 } else { 2 },
            ffmpeg: Mutex::new(None),
            ytdlp: Mutex::new(None),
        })
    }

    pub fn has_ffmpeg(&self) -> bool {
        let mut f = self.ffmpeg.lock();
        if f.is_none() {
            *f = Some(crate::platform::command_sync("ffmpeg").arg("-version").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false));
        }
        f.unwrap_or(false)
    }

    /// yt-dlp on PATH (checked once), needed to record YouTube cameras.
    pub fn has_ytdlp(&self) -> bool {
        let mut f = self.ytdlp.lock();
        if f.is_none() {
            *f = Some(crate::platform::command_sync("yt-dlp").arg("--version").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false));
        }
        f.unwrap_or(false)
    }

    fn rec_dir(&self, id: &str) -> PathBuf {
        self.dir.join(safe(id))
    }

    fn save(&self, r: &Rec) {
        let d = self.rec_dir(&r.id);
        std::fs::create_dir_all(&d).ok();
        if let Ok(b) = serde_json::to_vec_pretty(r) {
            std::fs::write(d.join("meta.json"), b).ok();
        }
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Rec)) {
        let snapshot = {
            let mut m = self.recs.lock();
            let Some(r) = m.get_mut(id) else { return };
            f(r);
            r.clone()
        };
        self.save(&snapshot);
    }

    pub fn list(&self) -> Vec<Rec> {
        let mut v: Vec<Rec> = self.recs.lock().values().cloned().collect();
        v.sort_by(|a, b| b.created.cmp(&a.created));
        // 0.8.2: a video piece is only counted when it ends (up to 10 min): show the bytes of the
        // piece being written, so a running recording doesn't look empty
        for r in v.iter_mut().filter(|r| r.status == "recording" && r.kind == "camera") {
            if let Ok(rd) = std::fs::read_dir(self.rec_dir(&r.id)) {
                r.bytes += rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".part")).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum::<u64>();
            }
        }
        v
    }

    pub fn get(&self, id: &str) -> Option<Rec> {
        self.recs.lock().get(id).cloned()
    }

    pub fn save_rules(&self, r: Rules) {
        if let Ok(b) = serde_json::to_vec_pretty(&r) {
            std::fs::write(self.dir.join("rules.json"), b).ok();
        }
        *self.rules.lock() = r;
    }

    /// Create a recording (starts now unless `start` is in the future).
    pub fn create(&self, mut r: Rec) -> Result<Rec> {
        match r.kind.as_str() {
            "radar" => {
                let rs = r.radar.as_mut().ok_or_else(|| anyhow!("radar settings missing"))?;
                rs.site = rs.site.trim().to_ascii_uppercase();
                if !(3..=4).contains(&rs.site.len()) || !rs.site.chars().all(|c| c.is_ascii_alphanumeric()) {
                    bail!("bad radar site");
                }
                if rs.source != "L3" {
                    rs.source = "L2".into();
                }
                rs.products.truncate(4);
                if rs.source == "L3" && rs.products.is_empty() {
                    bail!("pick at least one Level III product");
                }
                if rs.products.iter().any(|p| p.len() > 4 || !p.chars().all(|c| c.is_ascii_alphanumeric())) {
                    bail!("bad product");
                }
            }
            "camera" => {
                let c = r.camera.as_ref().ok_or_else(|| anyhow!("camera settings missing"))?;
                if !c.url.starts_with("http") {
                    bail!("bad camera URL");
                }
                if is_youtube(&c.url) {
                    if !is_youtube_video(&c.url) {
                        bail!("record a YouTube video or live stream link (watch, youtu.be, /live/ or /embed/)");
                    }
                    if !self.has_ytdlp() {
                        bail!("Install yt-dlp on the server to record YouTube");
                    }
                    if !self.has_ffmpeg() {
                        bail!("recording video streams needs ffmpeg on the server (install it, e.g. sudo apt install ffmpeg)");
                    }
                } else if c.kind == "hls" && !self.has_ffmpeg() {
                    bail!("recording video streams needs ffmpeg on the server (install it, e.g. sudo apt install ffmpeg)");
                }
                let active = self.recs.lock().values().filter(|x| x.kind == "camera" && (x.status == "recording" || x.status == "scheduled")).count();
                if active >= self.max_cams * 2 {
                    bail!("too many camera recordings at once (limit {})", self.max_cams * 2);
                }
            }
            _ => bail!("unknown recording kind"),
        }
        let now = now_ms();
        r.id = format!("{}-{:04x}", chrono::Utc::now().format("%Y%m%d-%H%M%S"), rand::random::<u16>());
        r.created = now;
        if r.start <= 0 {
            r.start = now;
        }
        if let Some(e) = r.end {
            if e <= r.start {
                bail!("end must be after start");
            }
        }
        r.status = if r.start > now + 5000 { "scheduled".into() } else { "recording".into() };
        if r.title.trim().is_empty() {
            r.title = match (&r.radar, &r.camera) {
                (Some(rs), _) => format!("{} {}", rs.site, if rs.source == "L3" { rs.products.join("+") } else { "Level II".into() }),
                (_, Some(c)) => c.name.clone(),
                _ => "Recording".into(),
            };
        }
        if r.trigger.is_empty() {
            r.trigger = if r.status == "scheduled" { "schedule".into() } else { "manual".into() };
        }
        self.recs.lock().insert(r.id.clone(), r.clone());
        self.save(&r);
        Ok(r)
    }

    /// Change when a running (or scheduled) recording stops: `None` = until stopped by hand.
    pub fn set_end(&self, id: &str, end: Option<i64>, now: i64) -> Result<Rec> {
        let r = self.get(id).ok_or_else(|| anyhow!("recording not found"))?;
        if r.status != "recording" && r.status != "scheduled" {
            bail!("the recording has already stopped");
        }
        if let Some(e) = end {
            if e <= now.max(r.start) {
                bail!("the end must be in the future");
            }
        }
        self.update(id, |x| x.end = end);
        self.get(id).ok_or_else(|| anyhow!("recording not found"))
    }

    pub fn stop(&self, id: &str) {
        if let Some(f) = self.running.lock().remove(id) {
            f.store(true, Ordering::SeqCst);
        }
        self.update(id, |r| {
            if r.status == "recording" || r.status == "scheduled" {
                r.status = "done".into();
                r.end = Some(now_ms());
            }
        });
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.stop(id);
        self.recs.lock().remove(id);
        let d = self.rec_dir(id);
        if d.starts_with(&self.dir) && d != self.dir {
            std::fs::remove_dir_all(d).ok();
        }
        Ok(())
    }

    /// Frames of a recording: radar keys or camera files, with times.
    pub fn frames(&self, id: &str) -> Result<Vec<Value>> {
        let r = self.get(id).ok_or_else(|| anyhow!("recording not found"))?;
        let d = self.rec_dir(id);
        let mut out = vec![];
        for e in std::fs::read_dir(&d)?.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n == "meta.json" || n.starts_with('.') || n.ends_with(".part") {
                continue;
            }
            let t = file_time(&n);
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            if r.kind == "radar" {
                let product = n.strip_prefix("L3_").and_then(|x| x.split('_').next()).unwrap_or("");
                out.push(json!({"key": format!("rec:{}/{n}", r.id), "time": t, "product": product, "size": size}));
            } else {
                out.push(json!({"name": n, "time": t, "size": size, "video": n.ends_with(".mp4") || n.ends_with(".ts")}));
            }
        }
        out.sort_by_key(|v| v["time"].as_i64().unwrap_or(0));
        Ok(out)
    }

    pub fn file_path(&self, id: &str, name: &str) -> Result<PathBuf> {
        let p = self.rec_dir(id).join(safe(name));
        if !p.starts_with(&self.dir) || !p.exists() {
            bail!("file not found");
        }
        Ok(p)
    }

    // ---------- export / import ----------

    /// Write a .zip of the given recordings (all when empty) to `out`.
    pub fn export(&self, ids: &[String], out: &Path) -> Result<()> {
        let list: Vec<Rec> = if ids.is_empty() { self.list() } else { ids.iter().filter_map(|i| self.get(i)).collect() };
        if list.is_empty() {
            bail!("nothing to export");
        }
        let f = std::fs::File::create(out)?;
        let mut z = zip::ZipWriter::new(std::io::BufWriter::new(f));
        // radar files and images are already compressed: store them as-is
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
        for r in &list {
            let d = self.rec_dir(&r.id);
            for e in std::fs::read_dir(&d)?.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.ends_with(".part") {
                    continue;
                }
                z.start_file(format!("recordings/{}/{n}", r.id), opts)?;
                let mut src = std::fs::File::open(e.path())?;
                std::io::copy(&mut src, &mut z)?;
            }
        }
        z.finish()?.flush()?;
        Ok(())
    }

    /// Import a .zip made by `export` (recordings with an existing id get a new one).
    pub fn import(&self, zip_path: &Path) -> Result<Vec<String>> {
        let f = std::fs::File::open(zip_path)?;
        let mut a = zip::ZipArchive::new(f)?;
        let mut renames: HashMap<String, String> = HashMap::new();
        let mut imported: Vec<String> = vec![];
        for i in 0..a.len() {
            let mut e = a.by_index(i)?;
            let Some(path) = e.enclosed_name() else { continue };
            let parts: Vec<String> = path.iter().map(|p| p.to_string_lossy().to_string()).collect();
            if parts.len() != 3 || parts[0] != "recordings" || e.is_dir() {
                continue;
            }
            let old = safe(&parts[1]);
            let id = renames
                .entry(old.clone())
                .or_insert_with(|| if self.recs.lock().contains_key(&old) || self.rec_dir(&old).exists() { format!("{old}-i{:03x}", rand::random::<u16>() & 0xfff) } else { old.clone() })
                .clone();
            let d = self.rec_dir(&id);
            std::fs::create_dir_all(&d)?;
            let name = safe(&parts[2]);
            let mut buf = Vec::new();
            e.read_to_end(&mut buf)?;
            if name == "meta.json" {
                let mut r: Rec = serde_json::from_slice(&buf)?;
                r.id = id.clone();
                r.imported = true;
                if r.status == "recording" || r.status == "scheduled" {
                    r.status = "done".into();
                }
                std::fs::write(d.join("meta.json"), serde_json::to_vec_pretty(&r)?)?;
                self.recs.lock().insert(id.clone(), r);
                imported.push(id.clone());
            } else {
                std::fs::write(d.join(&name), &buf)?;
            }
        }
        if imported.is_empty() {
            bail!("no recordings in that file");
        }
        Ok(imported)
    }

    /// Timelapse MP4 from a still-image camera recording (cached next to the frames).
    pub async fn timelapse(&self, id: &str, fps: u32) -> Result<PathBuf> {
        let r = self.get(id).ok_or_else(|| anyhow!("recording not found"))?;
        if r.kind != "camera" {
            bail!("timelapse is for camera recordings");
        }
        if !self.has_ffmpeg() {
            bail!("making a timelapse needs ffmpeg on the server");
        }
        let d = self.rec_dir(id);
        let out = d.join(format!(".timelapse-{fps}.mp4"));
        let newest = std::fs::read_dir(&d)?.flatten().filter_map(|e| e.metadata().ok()?.modified().ok()).max();
        if let (Ok(m), Some(n)) = (std::fs::metadata(&out).and_then(|m| m.modified()), newest) {
            if m >= n {
                return Ok(out);
            }
        }
        let mut imgs: Vec<String> = std::fs::read_dir(&d)?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".jpg") || n.ends_with(".png") || n.ends_with(".webp")).collect();
        imgs.sort();
        if imgs.len() < 2 {
            bail!("need at least 2 images");
        }
        let list = d.join(".frames.txt");
        let dur = 1.0 / fps.clamp(1, 60) as f64;
        let mut txt = String::new();
        for n in &imgs {
            txt.push_str(&format!("file '{n}'\nduration {dur}\n"));
        }
        txt.push_str(&format!("file '{}'\n", imgs.last().unwrap()));
        std::fs::write(&list, txt)?;
        let st = crate::platform::command("ffmpeg")
            .args(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list)
            .args(["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-movflags", "+faststart"])
            .arg(&out)
            .current_dir(&d)
            .status()
            .await?;
        std::fs::remove_file(&list).ok();
        if !st.success() {
            bail!("ffmpeg failed");
        }
        Ok(out)
    }
}

/// Time from a recording file name: Level II names, L3_<prod>_<YYYYmmdd_HHMMSS>, or <unix ms>.<ext>.
fn file_time(n: &str) -> i64 {
    if let Some(t) = crate::radar::service::l2_time_from_name(n) {
        return t;
    }
    if let Some(rest) = n.strip_prefix("L3_") {
        let ts: String = rest.splitn(2, '_').nth(1).unwrap_or("").chars().take(15).collect();
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(&ts, "%Y%m%d_%H%M%S") {
            return t.and_utc().timestamp_millis();
        }
    }
    n.split(|c: char| !c.is_ascii_digit()).find(|x| x.len() >= 12).and_then(|x| x.parse().ok()).unwrap_or(0)
}

// ---------- workers ----------

/// A running recording whose end time has come (manual recordings have no end).
pub fn should_stop(r: &Rec, now: i64) -> bool {
    r.status == "recording" && r.end.map(|e| now >= e).unwrap_or(false)
}

/// Seconds of the next video piece: up to 10 minutes, never past the (current) end.
pub fn piece_secs(end: Option<i64>, now: i64) -> i64 {
    end.map(|e| ((e - now) / 1000).max(1)).unwrap_or(600).min(600)
}

/// Background loop: starts/stops scheduled recordings, runs record-on-alert.
pub fn spawn(st: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            tick(&st).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn tick(st: &Arc<AppState>) {
    let rec = st.rec.clone();
    let now = now_ms();
    let list = rec.list();
    for r in list {
        let running = rec.running.lock().contains_key(&r.id);
        match r.status.as_str() {
            "scheduled" if now >= r.start => {
                rec.update(&r.id, |x| x.status = "recording".into());
                start_worker(st, &r.id);
            }
            "recording" if should_stop(&r, now) => rec.stop(&r.id),
            "recording" if !running => start_worker(st, &r.id),
            _ => {}
        }
    }
    record_on_alert(st).await;
}

fn start_worker(st: &Arc<AppState>, id: &str) {
    let Some(r) = st.rec.get(id) else { return };
    let stop = Arc::new(AtomicBool::new(false));
    st.rec.running.lock().insert(id.to_string(), stop.clone());
    let st = st.clone();
    let id = id.to_string();
    tokio::spawn(async move {
        let res = match r.kind.as_str() {
            "radar" => radar_worker(&st, &r, &stop).await,
            _ => camera_worker(&st, &r, &stop).await,
        };
        st.rec.running.lock().remove(&id);
        match res {
            Ok(()) => {}
            Err(e) => {
                tracing::warn!("recording {id}: {e:#}");
                st.rec.update(&id, |x| {
                    x.status = "error".into();
                    x.error = format!("{e:#}");
                });
                // 0.8.2: let the app show the error right away
                st.hub.send(json!({"type": "recording", "id": id}));
            }
        }
    });
}

fn note_file(st: &AppState, id: &str, bytes: u64, t: i64) {
    st.rec.update(id, |x| {
        x.files += 1;
        x.bytes += bytes;
        if x.t0 == 0 || t < x.t0 {
            x.t0 = t;
        }
        x.t1 = x.t1.max(t);
    });
    st.hub.send(json!({"type": "recording", "id": id}));
}

/// How far before the start a radar frame may begin and still be recorded: the volume being
/// scanned (or just finished) when recording starts is the first frame.
const RADAR_LEAD_MS: i64 = 15 * 60_000;

/// Name a recorded Level II file: archive keys keep their file name; real-time chunk volumes get
/// the archive naming (`SITEyyyymmdd_HHMMSS_V06`).
fn l2_file_name(site: &str, key: &str, t: i64) -> String {
    if key.starts_with("chunks:") {
        let ts = chrono::DateTime::from_timestamp_millis(t).map(|d| d.format("%Y%m%d_%H%M%S").to_string()).unwrap_or_default();
        return format!("{}{ts}_V06", site.to_ascii_uppercase());
    }
    safe(key.rsplit(['/', ':']).next().unwrap_or(key))
}

/// Volumes / products to record now: newer than the start (minus the lead) and not recorded yet
/// (a chunk volume and its later archive copy are the same frame: times within 60 s).
fn radar_new(entries: Vec<crate::radar::service::VolEntry>, start: i64, have_t: &[i64]) -> Vec<crate::radar::service::VolEntry> {
    let mut v: Vec<crate::radar::service::VolEntry> = entries.into_iter().filter(|e| e.time >= start - RADAR_LEAD_MS && !have_t.iter().any(|t| (t - e.time).abs() < 60_000)).collect();
    v.sort_by_key(|e| e.time);
    v.dedup_by(|a, b| (a.time - b.time).abs() < 60_000);
    v
}

async fn radar_worker(st: &Arc<AppState>, r: &Rec, stop: &AtomicBool) -> Result<()> {
    let spec = r.radar.clone().unwrap_or_default();
    let dir = st.rec.rec_dir(&r.id);
    let mut have: HashSet<String> = std::fs::read_dir(&dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    // frame times already recorded, per L3 product ("" = Level II)
    let mut have_t: HashMap<String, Vec<i64>> = HashMap::new();
    for n in &have {
        let t = file_time(n);
        if t > 0 {
            let prod = n.strip_prefix("L3_").and_then(|x| x.split('_').next()).unwrap_or("").to_string();
            have_t.entry(prod).or_default().push(t);
        }
    }
    let mut fails = 0;
    while !stop.load(Ordering::SeqCst) {
        let mut ok = true;
        if spec.source == "L3" {
            let site3 = if spec.site.len() == 4 { spec.site[1..].to_string() } else { spec.site.clone() };
            for p in &spec.products {
                match st.radar.l3_list(&site3, p, 8).await {
                    Ok(list) => {
                        let ht = have_t.entry(p.clone()).or_default();
                        for v in radar_new(list, r.start, ht) {
                            let ts = chrono::DateTime::from_timestamp_millis(v.time).map(|t| t.format("%Y%m%d_%H%M%S").to_string()).unwrap_or_default();
                            let name = format!("L3_{p}_{ts}.bin");
                            if have.contains(&name) {
                                continue;
                            }
                            match st.radar.l3_raw(&v.key).await {
                                Ok(b) if !b.is_empty() => {
                                    tokio::fs::write(dir.join(&name), &b).await?;
                                    note_file(st, &r.id, b.len() as u64, v.time);
                                    have.insert(name);
                                    ht.push(v.time);
                                }
                                _ => ok = false,
                            }
                        }
                    }
                    Err(_) => ok = false,
                }
            }
        } else {
            // the archive (re-listed on every poll) plus the real-time chunks, whichever is newer
            st.radar.forget_recent_listing(&spec.site);
            let mut entries = match st.radar.latest(&spec.site, 6).await {
                Ok(l) => l,
                Err(_) => {
                    ok = false;
                    vec![]
                }
            };
            if let Ok(Some(e)) = st.ml.fetch.latest(&spec.site).await {
                entries.push(e);
            }
            if entries.is_empty() {
                ok = false;
            }
            let ht = have_t.entry(String::new()).or_default();
            for v in radar_new(entries, r.start, ht) {
                let name = l2_file_name(&spec.site, &v.key, v.time);
                if have.contains(&name) {
                    ht.push(v.time);
                    continue;
                }
                match st.ml.fetch.raw(&v.key).await {
                    Ok(b) if !b.is_empty() => {
                        tokio::fs::write(dir.join(&name), &b).await?;
                        note_file(st, &r.id, b.len() as u64, v.time);
                        have.insert(name);
                        ht.push(v.time);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::debug!("recording {}: {}: {e:#}", r.id, v.key);
                        ok = false;
                    }
                }
            }
        }
        fails = if ok { 0 } else { fails + 1 };
        if fails > 120 {
            bail!("radar data unavailable for an hour");
        }
        // volumes arrive every ~4–10 minutes; check every 30 s
        for _ in 0..6 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }
    Ok(())
}

// ---------- 0.8.2: video / YouTube capture ----------
//
// Each piece (up to 10 minutes) is written as *fragmented* MP4 (a fragment per keyframe), so a
// piece that ends badly (ffmpeg killed, server stopped, connection lost) still plays up to its last
// fragment; the old `+faststart` pieces needed a clean finish plus a second pass that rewrote the
// whole file, and a piece killed during that pass was unplayable.
//
// YouTube: `yt-dlp -j` resolves the stream (HLS for live streams, with the HTTP headers YouTube
// expects) and our own ffmpeg copies it. The resolved stream is reused for the next pieces (no gap
// for re-resolving) and resolved again after 30 minutes or after a failure. If reading the stream
// directly fails, the next attempt lets yt-dlp download it (`--downloader ffmpeg --hls-use-mpegts
// -o -`) and pipes that into ffmpeg; the two ways alternate until one works. yt-dlp runs in its own
// process group (Unix) / is killed with its child processes (Windows): the standalone yt-dlp
// builds are a launcher plus a child process, and killing only the launcher kept the real
// download (and its ffmpeg) running and writing into the pipe.
//
// Every failed attempt logs the tails of yt-dlp's and ffmpeg's stderr to the server log and shows
// the reason on the recording ("Retrying (n/5): …"); a recording that ends with nothing recorded
// becomes an error instead of an empty "done" recording, and empty pieces are deleted.

/// yt-dlp format choice: a single (audio+video) stream, HLS first (live streams), ≤ 1080p.
pub const YT_FORMAT: &str = "best[protocol^=m3u8][height<=1080]/best[protocol^=m3u8]/best[height<=1080]/best";

/// A YouTube stream resolved by yt-dlp.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct YtStream {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub is_live: bool,
    pub live_status: String,
    pub protocol: String,
    pub format: String,
}

/// How a YouTube piece is captured.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum YtMode {
    /// ffmpeg reads the stream yt-dlp resolved
    Direct,
    /// yt-dlp downloads, ffmpeg reads its output from a pipe
    Pipe,
}

fn strs<const N: usize>(a: [&str; N]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// `--ffmpeg-location` for yt-dlp when ffmpeg sits next to the server (not on PATH).
fn ffmpeg_location() -> Vec<String> {
    let t = crate::platform::tool("ffmpeg");
    if t.is_absolute() && t.is_file() {
        vec!["--ffmpeg-location".into(), t.to_string_lossy().to_string()]
    } else {
        vec![]
    }
}

/// yt-dlp arguments that print the chosen stream as JSON (url, http_headers, is_live…).
pub fn ytdlp_resolve_args(url: &str) -> Vec<String> {
    let mut a = strs(["--no-playlist", "--no-progress", "--socket-timeout", "20", "-f", YT_FORMAT, "-j"]);
    a.push("--".into());
    a.push(url.into());
    a
}

/// yt-dlp arguments that download the stream to stdout (MPEG-TS for HLS, so a pipe works).
pub fn ytdlp_pipe_args(url: &str, ffmpeg_loc: &[String]) -> Vec<String> {
    let mut a = strs(["--no-playlist", "--no-progress", "--no-part", "--socket-timeout", "20", "-f", YT_FORMAT, "--downloader", "ffmpeg", "--hls-use-mpegts"]);
    a.extend(ffmpeg_loc.iter().cloned());
    a.extend(strs(["-o", "-", "--"]));
    a.push(url.into());
    a
}

/// The stream yt-dlp printed with `-j` (the last JSON line of its output).
pub fn parse_resolve(out: &str) -> Result<YtStream> {
    let line = out.lines().rev().map(str::trim).find(|l| l.starts_with('{')).ok_or_else(|| anyhow!("yt-dlp printed no stream info"))?;
    let v: Value = serde_json::from_str(line).map_err(|e| anyhow!("yt-dlp output: {e}"))?;
    let url = v["url"].as_str().unwrap_or("").to_string();
    if !url.starts_with("http") {
        bail!("yt-dlp found no single stream (format {})", v["format_id"].as_str().unwrap_or("?"));
    }
    let headers = v["http_headers"]
        .as_object()
        .map(|m| m.iter().filter_map(|(k, x)| Some((k.clone(), x.as_str()?.to_string()))).filter(|(k, x)| !k.contains(['\r', '\n', ':']) && !x.contains(['\r', '\n'])).collect())
        .unwrap_or_default();
    let live_status = v["live_status"].as_str().unwrap_or("").to_string();
    let format = format!("{} {}", v["format_id"].as_str().unwrap_or("?"), v["height"].as_i64().map(|h| format!("{h}p")).unwrap_or_default()).trim().to_string();
    Ok(YtStream { url, headers, is_live: v["is_live"].as_bool().unwrap_or(false) || live_status == "is_live", live_status, protocol: v["protocol"].as_str().unwrap_or("").to_string(), format })
}

/// ffmpeg input options for HTTP headers (User-Agent separately, the rest as `-headers`).
pub fn ffmpeg_header_args(headers: &[(String, String)]) -> Vec<String> {
    let mut a = vec![];
    if let Some((_, ua)) = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("user-agent")) {
        a.extend(["-user_agent".to_string(), ua.clone()]);
    }
    let rest: String = headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("user-agent")).map(|(k, v)| format!("{k}: {v}\r\n")).collect();
    if !rest.is_empty() {
        a.extend(["-headers".to_string(), rest]);
    }
    a
}

/// Where ffmpeg reads a piece from.
pub enum PieceInput<'a> {
    Url { url: &'a str, headers: &'a [(String, String)], hls: bool },
    Pipe,
}

/// ffmpeg arguments for one piece: copy (never re-encode) into fragmented MP4.
/// `lenient_hls`: this ffmpeg has the HLS `extension_picky` check (7.1+), turned off because
/// stream segment URLs don't always end in a media extension.
pub fn ffmpeg_piece_args(input: &PieceInput, secs: Option<i64>, out: &str, lenient_hls: bool) -> Vec<String> {
    let mut a = strs(["-hide_banner", "-nostats", "-loglevel", "warning", "-y"]);
    match input {
        PieceInput::Url { url, headers, hls } => {
            a.extend(strs(["-rw_timeout", "15000000"]));
            a.extend(ffmpeg_header_args(headers));
            if *hls && lenient_hls {
                a.extend(strs(["-extension_picky", "0"]));
            }
            a.extend(["-i".to_string(), url.to_string()]);
        }
        PieceInput::Pipe => a.extend(strs(["-i", "pipe:0"])),
    }
    a.extend(strs(["-c", "copy"]));
    if let Some(t) = secs {
        a.extend(["-t".to_string(), t.max(1).to_string()]);
    }
    // no `empty_moov`: with it the header is written before the first packet, so ffmpeg can't
    // insert aac_adtstoasc for the ADTS AAC in HLS/MPEG-TS (YouTube live) and stops with
    // "Malformed AAC bitstream detected" after ~1 s (seen with ffmpeg 6.1)
    a.extend(strs(["-f", "mp4", "-movflags", "+frag_keyframe+default_base_moof"]));
    a.push(out.to_string());
    a
}

/// An MP4 that holds media: a `moov` box and an `mdat` box with data. ffmpeg may write a header
/// (ftyp, or ftyp + an empty moov) before any data arrives, so size alone can't tell.
pub fn mp4_has_media<R: Read + std::io::Seek>(mut r: R, len: u64) -> bool {
    use std::io::SeekFrom;
    let (mut pos, mut moov, mut media) = (0u64, false, false);
    for _ in 0..200_000 {
        if pos + 8 > len || r.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let mut h = [0u8; 8];
        if r.read_exact(&mut h).is_err() {
            break;
        }
        let (mut size, mut hdr) = (u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64, 8u64);
        if size == 1 {
            let mut l = [0u8; 8];
            if r.read_exact(&mut l).is_err() {
                break;
            }
            size = u64::from_be_bytes(l);
            hdr = 16;
        } else if size == 0 {
            size = len - pos;
        }
        if size < hdr {
            break;
        }
        match &h[4..8] {
            b"moov" => moov = true,
            b"mdat" if size > hdr && len > pos + hdr => media = true,
            _ => {}
        }
        if moov && media {
            return true;
        }
        pos = pos.saturating_add(size);
    }
    false
}

fn file_has_media(p: &Path) -> bool {
    let Ok(f) = std::fs::File::open(p) else { return false };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    mp4_has_media(std::io::BufReader::new(f), len)
}

/// A short reason for a failed piece, from the tails of yt-dlp's and ffmpeg's stderr.
pub fn fail_reason(dl: &[String], ff: &[String]) -> String {
    let pick = |v: &[String]| v.iter().rev().find(|l| l.contains("ERROR") || l.to_ascii_lowercase().contains("error")).or_else(|| v.last()).cloned();
    let l = dl.iter().rev().find(|l| l.contains("ERROR:")).cloned().or_else(|| pick(ff)).or_else(|| pick(dl)).unwrap_or_else(|| "no data from the stream".into());
    let mut s = l.trim().trim_start_matches("ERROR:").trim().to_string();
    // "[youtube] abc123: Sign in…" → "Sign in…"
    if s.starts_with('[') {
        if let Some(i) = s.find("]") {
            let rest = s[i + 1..].trim();
            s = rest.split_once(": ").map(|(id, m)| if id.contains(' ') { rest.to_string() } else { m.to_string() }).unwrap_or_else(|| rest.to_string());
        }
    }
    if s.chars().count() > 220 {
        s = s.chars().take(220).collect::<String>() + "…";
    }
    s
}

type Tail = Arc<Mutex<std::collections::VecDeque<String>>>;

/// Keep the last lines a process writes to stderr (split on \n and \r — ffmpeg progress lines end
/// in \r — and capped, so hours of output never grow memory). Reading also keeps the pipe from
/// filling up and blocking the process.
fn collect_tail<S: tokio::io::AsyncRead + Unpin + Send + 'static>(err: Option<S>) -> Tail {
    let t: Tail = Arc::new(Mutex::new(Default::default()));
    if let Some(mut e) = err {
        let t2 = t.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 4096];
            let mut line = Vec::<u8>::new();
            let push = |line: &mut Vec<u8>| {
                let s = String::from_utf8_lossy(line).trim().to_string();
                line.clear();
                if !s.is_empty() {
                    let mut q = t2.lock();
                    if q.len() >= 30 {
                        q.pop_front();
                    }
                    q.push_back(s);
                }
            };
            while let Ok(n) = e.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' {
                        push(&mut line);
                    } else if line.len() < 600 {
                        line.push(b);
                    }
                }
            }
            push(&mut line);
        });
    }
    t
}

fn tail_vec(t: &Tail) -> Vec<String> {
    t.lock().iter().cloned().collect()
}

/// Kill a process with everything it started (yt-dlp → its own child → ffmpeg).
fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        {
            // yt-dlp was started as the leader of its own process group
            let _ = std::process::Command::new("kill").args(["-s", "KILL", "--", &format!("-{pid}")]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(0x0800_0000).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
        }
    }
    child.start_kill().ok();
}

/// ffmpeg 7.1+ checks HLS segment extensions (`extension_picky`); checked once.
async fn ffmpeg_hls_lenient() -> bool {
    static V: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();
    *V.get_or_init(|| async {
        let out = tokio::time::timeout(Duration::from_secs(10), crate::platform::command("ffmpeg").args(["-hide_banner", "-h", "demuxer=hls"]).stdin(std::process::Stdio::null()).kill_on_drop(true).output()).await;
        matches!(out, Ok(Ok(o)) if String::from_utf8_lossy(&o.stdout).contains("extension_picky"))
    })
    .await
}

/// Resolve a YouTube URL with yt-dlp (`-j`); failures log yt-dlp's stderr.
pub async fn yt_resolve(url: &str) -> Result<YtStream> {
    let out = tokio::time::timeout(Duration::from_secs(90), crate::platform::command("yt-dlp").args(ytdlp_resolve_args(url)).stdin(std::process::Stdio::null()).kill_on_drop(true).output())
        .await
        .map_err(|_| anyhow!("yt-dlp timed out finding the stream"))??;
    let err: Vec<String> = String::from_utf8_lossy(&out.stderr).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let tail = err.iter().rev().take(12).rev().cloned().collect::<Vec<_>>().join("\n    ");
    if !out.status.success() {
        tracing::warn!("yt-dlp couldn't resolve {url} ({}):\n    {tail}", out.status);
        bail!("yt-dlp: {}", fail_reason(&err, &[]));
    }
    match parse_resolve(&String::from_utf8_lossy(&out.stdout)) {
        Ok(s) => {
            if !err.is_empty() {
                tracing::info!("yt-dlp {url}: {tail}");
            }
            Ok(s)
        }
        Err(e) => {
            tracing::warn!("yt-dlp {url}: {e:#}\n    {tail}");
            Err(e)
        }
    }
}

/// Sleep up to `secs`, returning early when the recording is stopped.
async fn wait_or_stop(stop: &AtomicBool, secs: u64) {
    for _ in 0..secs {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// `.part` pieces left by a server that stopped mid-piece: keep the playable ones (renamed to
/// their final name), delete the empty / unplayable ones. Returns the kept (name, size).
pub fn recover_parts(dir: &Path) -> Vec<(String, u64)> {
    let mut kept = vec![];
    let Ok(rd) = std::fs::read_dir(dir) else { return kept };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        let Some(base) = n.strip_suffix(".part") else { continue };
        if base.ends_with(".mp4") && file_has_media(&e.path()) && std::fs::rename(e.path(), dir.join(base)).is_ok() {
            kept.push((base.to_string(), std::fs::metadata(dir.join(base)).map(|m| m.len()).unwrap_or(0)));
        } else {
            std::fs::remove_file(e.path()).ok();
        }
    }
    kept
}

/// Video cameras (HLS) and YouTube: ffmpeg copies the stream in pieces of up to 10 minutes.
async fn video_worker(st: &Arc<AppState>, r: &Rec, stop: &AtomicBool) -> Result<()> {
    let c = r.camera.clone().unwrap_or_default();
    let dir = st.rec.rec_dir(&r.id);
    std::fs::create_dir_all(&dir).ok();
    for (n, size) in recover_parts(&dir) {
        note_file(st, &r.id, size, file_time(&n));
    }
    let yt = is_youtube(&c.url);
    let lenient = ffmpeg_hls_lenient().await;
    let mut mode = YtMode::Direct;
    let mut resolved: Option<(YtStream, std::time::Instant)> = None;
    let mut seen_live = false;
    let mut fails = 0u32;
    let mut last_reason = String::new();
    let id = r.id.clone();
    // a failed attempt: show why, back off, give up after 5 in a row (30 once something was recorded)
    macro_rules! failed {
        ($reason:expr) => {{
            last_reason = $reason;
            fails += 1;
            let have = st.rec.get(&id).map(|x| x.files).unwrap_or(0);
            let limit = if have > 0 { 30 } else { 5 };
            if fails >= limit {
                bail!("the stream couldn't be recorded: {last_reason}");
            }
            let msg = format!("Retrying ({fails}/{limit}): {last_reason}");
            st.rec.update(&id, |x| x.error = msg);
            st.hub.send(json!({"type": "recording", "id": id}));
            wait_or_stop(stop, [5u64, 10, 20, 30][(fails as usize - 1).min(3)]).await;
            continue;
        }};
    }
    while !stop.load(Ordering::SeqCst) {
        // the end can change while recording (Record for… / until stopped): read it each piece
        let end = st.rec.get(&id).map(|x| x.end).unwrap_or(r.end);
        let mut live = true;
        let mut what = if c.kind == "hls" { "HLS".to_string() } else { "stream".to_string() };
        let stream = if yt && mode == YtMode::Direct {
            let fresh = resolved.as_ref().filter(|(_, at)| at.elapsed() < Duration::from_secs(30 * 60)).map(|x| x.0.clone());
            let s = match fresh {
                Some(s) => s,
                None => match yt_resolve(&c.url).await {
                    Ok(s) => {
                        resolved = Some((s.clone(), std::time::Instant::now()));
                        s
                    }
                    Err(e) => {
                        resolved = None;
                        mode = YtMode::Pipe;
                        failed!(format!("{e:#}"))
                    }
                },
            };
            if seen_live && !s.is_live {
                // the live stream has ended (it is a replay now): don't record it from the start
                tracing::info!("recording {id}: the live stream ended ({})", s.live_status);
                st.rec.update(&id, |x| {
                    x.status = "done".into();
                    x.end = Some(now_ms());
                    x.error.clear();
                });
                break;
            }
            seen_live |= s.is_live;
            live = s.is_live;
            what = format!("yt-dlp {} {} (live: {}{})", s.protocol, s.format, s.is_live, if s.live_status.is_empty() { String::new() } else { format!(", {}", s.live_status) });
            Some(s)
        } else {
            if yt {
                live = resolved.as_ref().map(|x| x.0.is_live).unwrap_or(true);
                what = "yt-dlp pipe".into();
            }
            None
        };
        // live: 10-minute pieces; a video file: one piece (to the end time, if any)
        let secs = if live { Some(piece_secs(end, now_ms())) } else { end.map(|e| ((e - now_ms()) / 1000).max(1)) };
        let name = format!("{}.mp4", now_ms());
        let part = dir.join(format!("{name}.part"));
        let part_s = part.to_string_lossy().to_string();
        let input = match (&stream, yt) {
            (Some(s), _) => PieceInput::Url { url: &s.url, headers: &s.headers, hls: s.protocol.starts_with("m3u8") },
            (None, true) => PieceInput::Pipe,
            (None, false) => PieceInput::Url { url: &c.url, headers: &[], hls: true },
        };
        let piped = matches!(input, PieceInput::Pipe);
        let args = ffmpeg_piece_args(&input, secs, &part_s, lenient);
        let mut dl = None;
        let mut ffc = crate::platform::command("ffmpeg");
        ffc.args(&args).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        if piped {
            let mut d = crate::platform::command("yt-dlp");
            d.args(ytdlp_pipe_args(&c.url, &ffmpeg_location())).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
            #[cfg(unix)]
            d.process_group(0);
            let mut d = d.spawn().map_err(|e| anyhow!("yt-dlp: {e}"))?;
            let out: std::process::Stdio = d.stdout.take().ok_or_else(|| anyhow!("yt-dlp pipe"))?.try_into()?;
            ffc.stdin(out);
            dl = Some(d);
        } else {
            // Windows: "q" on stdin is how ffmpeg is asked to finish the file (no SIGINT)
            ffc.stdin(if cfg!(unix) { std::process::Stdio::null() } else { std::process::Stdio::piped() });
        }
        let mut ff = match ffc.spawn() {
            Ok(f) => f,
            Err(e) => {
                if let Some(mut d) = dl {
                    kill_tree(&mut d);
                }
                bail!("ffmpeg: {e}");
            }
        };
        let ff_tail = collect_tail(ff.stderr.take());
        let dl_tail = collect_tail(dl.as_mut().and_then(|d| d.stderr.take()));
        tracing::info!("recording {id}: piece {name} from {what}{}", secs.map(|s| format!(", {s} s")).unwrap_or_default());
        let started = std::time::Instant::now();
        let status;
        let mut stopped = false;
        loop {
            if stop.load(Ordering::SeqCst) {
                stopped = true;
                match dl.as_mut() {
                    // the pipe: on Windows ffmpeg's stdin is the pipe, so end the feed (EOF) instead
                    Some(d) if !cfg!(unix) => kill_tree(d),
                    _ => crate::platform::ffmpeg_finish(&mut ff).await,
                }
                status = tokio::time::timeout(Duration::from_secs(15), ff.wait()).await.ok().and_then(|x| x.ok());
                if status.is_none() {
                    // fragmented MP4: what was written so far still plays
                    ff.start_kill().ok();
                    let _ = tokio::time::timeout(Duration::from_secs(5), ff.wait()).await;
                }
                break;
            }
            if let Ok(Some(s)) = ff.try_wait() {
                status = Some(s);
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let mut dl_status = None;
        if let Some(mut d) = dl.take() {
            dl_status = d.try_wait().ok().flatten();
            kill_tree(&mut d);
            let _ = tokio::time::timeout(Duration::from_secs(5), d.wait()).await;
        }
        // let the stderr readers drain
        tokio::time::sleep(Duration::from_millis(300)).await;
        let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if file_has_media(&part) {
            std::fs::rename(&part, dir.join(&name))?;
            note_file(st, &id, size, now_ms());
            let clean = status.map(|s| s.success()).unwrap_or(false);
            if !stopped && started.elapsed().as_secs() + 30 < secs.unwrap_or(i64::MAX).max(0) as u64 {
                tracing::warn!("recording {id}: piece {name} ended early after {} s (ffmpeg {status:?}): {}", started.elapsed().as_secs(), tail_vec(&ff_tail).join(" | "));
                // ffmpeg keeps failing a few seconds in: don't spin out 1-second pieces
                if !clean && started.elapsed() < Duration::from_secs(30) {
                    failed!(fail_reason(&tail_vec(&dl_tail), &tail_vec(&ff_tail)))
                }
            }
            fails = 0;
            if st.rec.get(&id).map(|x| !x.error.is_empty()).unwrap_or(false) {
                st.rec.update(&id, |x| x.error.clear());
            }
            // a video file (not a live stream) ended by itself: don't record it again
            if clean && !stopped && !live {
                st.rec.update(&id, |x| {
                    x.status = "done".into();
                    x.end = Some(now_ms());
                });
                return Ok(());
            }
            // generic HLS: a stream that ended cleanly and quickly is a video file too
            if clean && !stopped && !yt && started.elapsed().as_secs() < (secs.unwrap_or(600) as u64) / 2 {
                st.rec.update(&id, |x| {
                    x.status = "done".into();
                    x.end = Some(now_ms());
                });
                return Ok(());
            }
        } else {
            std::fs::remove_file(&part).ok();
            let (dt, ft) = (tail_vec(&dl_tail), tail_vec(&ff_tail));
            let reason = fail_reason(&dt, &ft);
            tracing::warn!(
                "recording {id}: no data in piece {name} ({size} bytes, {} s) from {what}; ffmpeg exit {status:?}{}\n  ffmpeg stderr:\n    {}{}",
                started.elapsed().as_secs(),
                if piped { format!(", yt-dlp exit {dl_status:?}") } else { String::new() },
                if ft.is_empty() { "(nothing)".into() } else { ft.join("\n    ") },
                if piped { format!("\n  yt-dlp stderr:\n    {}", if dt.is_empty() { "(nothing)".into() } else { dt.join("\n    ") }) } else { String::new() },
            );
            if stopped {
                last_reason = reason;
                break;
            }
            if yt {
                // try the other way next time; the direct URL may have expired
                resolved = None;
                mode = if mode == YtMode::Direct { YtMode::Pipe } else { YtMode::Direct };
            }
            failed!(reason)
        }
    }
    if st.rec.get(&id).map(|x| x.files).unwrap_or(0) == 0 {
        bail!("Nothing was recorded{}", if last_reason.is_empty() { String::new() } else { format!(": {last_reason}") });
    }
    Ok(())
}

async fn camera_worker(st: &Arc<AppState>, r: &Rec, stop: &AtomicBool) -> Result<()> {
    let c = r.camera.clone().unwrap_or_default();
    let dir = st.rec.rec_dir(&r.id);
    if c.kind == "hls" || is_youtube(&c.url) {
        return video_worker(st, r, stop).await;
    }
    // still images: one per refresh; identical images (camera not updated) are skipped
    let every = Duration::from_secs(c.refresh.clamp(10, 900) as u64);
    let mut last_hash: u64 = 0;
    let mut fails = 0;
    while !stop.load(Ordering::SeqCst) {
        let url = if c.url == "proxy" { crate::overlays::cameras::image_url(&st.overlays, &c.id).await.unwrap_or_default() } else { c.url.clone() };
        let sep = if url.contains('?') { '&' } else { '?' };
        let res = st.overlays.http.get(format!("{url}{sep}_tbw={}", now_ms() / 1000)).timeout(Duration::from_secs(30)).send().await;
        let got = match res {
            Ok(r) if r.status().is_success() => r.bytes().await.ok(),
            _ => None,
        };
        match got {
            Some(b) if b.len() > 500 => {
                fails = 0;
                let h = {
                    use std::hash::{Hash, Hasher};
                    let mut s = std::collections::hash_map::DefaultHasher::new();
                    b.hash(&mut s);
                    s.finish()
                };
                if h != last_hash {
                    last_hash = h;
                    let ext = if b.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else if b.len() > 12 && &b[8..12] == b"WEBP" { "webp" } else { "jpg" };
                    let t = now_ms();
                    tokio::fs::write(dir.join(format!("{t}.{ext}")), &b).await?;
                    note_file(st, &r.id, b.len() as u64, t);
                }
            }
            _ => {
                fails += 1;
                if fails > 120 {
                    bail!("camera unreachable");
                }
            }
        }
        let t0 = std::time::Instant::now();
        while t0.elapsed() < every && !stop.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    // 0.8.2: never end as an empty "done" recording
    if st.rec.get(&r.id).map(|x| x.files).unwrap_or(0) == 0 {
        bail!("Nothing was recorded: the camera image didn't load");
    }
    Ok(())
}

// ---------- record-on-alert ----------

fn ring_contains(ring: &[Value], x: f64, y: f64) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (xi, yi) = (ring[i][0].as_f64().unwrap_or(0.0), ring[i][1].as_f64().unwrap_or(0.0));
        let (xj, yj) = (ring[j][0].as_f64().unwrap_or(0.0), ring[j][1].as_f64().unwrap_or(0.0));
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn geom_contains(g: &Value, x: f64, y: f64) -> bool {
    let polys: Vec<&Value> = match g["type"].as_str() {
        Some("Polygon") => vec![&g["coordinates"]],
        Some("MultiPolygon") => g["coordinates"].as_array().map(|a| a.iter().collect()).unwrap_or_default(),
        _ => vec![],
    };
    polys.iter().any(|p| {
        let rings = p.as_array().cloned().unwrap_or_default();
        !rings.is_empty() && ring_contains(rings[0].as_array().map(|a| a.as_slice()).unwrap_or(&[]), x, y) && !rings[1..].iter().any(|h| ring_contains(h.as_array().map(|a| a.as_slice()).unwrap_or(&[]), x, y))
    })
}

fn centroid(g: &Value) -> Option<(f64, f64)> {
    let ring = match g["type"].as_str()? {
        "Polygon" => g["coordinates"][0].as_array()?,
        "MultiPolygon" => g["coordinates"][0][0].as_array()?,
        _ => return None,
    };
    let n = ring.len().max(1) as f64;
    let (sx, sy) = ring.iter().fold((0.0, 0.0), |a, p| (a.0 + p[0].as_f64().unwrap_or(0.0), a.1 + p[1].as_f64().unwrap_or(0.0)));
    Some((sx / n, sy / n))
}

async fn record_on_alert(st: &Arc<AppState>) {
    let rules = st.rec.rules.lock().clone();
    let current: Vec<(String, Value)> = st.alerts.current.read().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut fresh = vec![];
    {
        let mut seen = st.rec.seen_alerts.lock();
        let first = seen.is_empty();
        for (id, f) in &current {
            if seen.insert(id.clone()) && !first {
                fresh.push(f.clone());
            }
        }
        // forget expired ids
        let ids: HashSet<&String> = current.iter().map(|x| &x.0).collect();
        seen.retain(|k| ids.contains(k));
        if seen.is_empty() && !current.is_empty() {
            seen.insert("_primed".into());
        }
    }
    if !rules.enabled || fresh.is_empty() {
        return;
    }
    for f in fresh {
        let p = &f["properties"];
        let event = p["event"].as_str().unwrap_or("");
        if !rules.events.iter().any(|e| e == event) {
            continue;
        }
        if p["messageType"].as_str().map(|m| m != "Alert").unwrap_or(false) {
            continue;
        }
        let g = &f["geometry"];
        if !rules.points.is_empty() && !rules.points.iter().any(|(lon, lat)| geom_contains(g, *lon, *lat)) {
            continue;
        }
        let Some((cx, cy)) = centroid(g) else { continue };
        let end = Some(now_ms() + rules.minutes.clamp(5, 360) as i64 * 60_000);
        let trigger = format!("alert: {event}");
        if rules.radar {
            let site = st.sites.read().iter().filter(|s| s.kind == "NEXRAD").min_by(|a, b| ((a.lat - cy).powi(2) + (a.lon - cx).powi(2)).total_cmp(&((b.lat - cy).powi(2) + (b.lon - cx).powi(2)))).map(|s| s.id.clone());
            if let Some(site) = site {
                let busy = st.rec.list().iter().any(|r| r.status == "recording" && r.radar.as_ref().map(|x| x.site == site && x.source == "L2").unwrap_or(false));
                if !busy {
                    let _ = st.rec.create(Rec { kind: "radar".into(), title: format!("{site} · {event}"), end, radar: Some(RadarSpec { site, source: "L2".into(), products: vec!["REF".into(), "VEL".into()] }), trigger: trigger.clone(), ..Default::default() });
                }
            }
        }
        if rules.max_cams > 0 {
            let idx = crate::overlays::cameras::index_now(&st.overlays).await;
            let mut cams: Vec<&crate::overlays::camdb::Cam> = idx.cams.iter().filter(|c| (c.t == "img" || c.t == "hls") && geom_contains(g, c.lon as f64, c.lat as f64)).collect();
            cams.sort_by(|a, b| ((a.lat as f64 - cy).powi(2) + (a.lon as f64 - cx).powi(2)).total_cmp(&((b.lat as f64 - cy).powi(2) + (b.lon as f64 - cx).powi(2))));
            for c in cams.into_iter().take(rules.max_cams) {
                let url = if c.t == "img" { c.img.clone().unwrap_or_default() } else { c.video.clone().unwrap_or_default() };
                if c.t == "hls" && !st.rec.has_ffmpeg() {
                    continue;
                }
                let _ = st.rec.create(Rec {
                    kind: "camera".into(),
                    title: format!("{} · {event}", c.name),
                    end,
                    camera: Some(CamSpec { id: c.id.clone(), name: c.name.clone(), url, kind: c.t.clone(), refresh: c.refresh.max(30), lat: c.lat as f64, lon: c.lon as f64 }),
                    trigger: trigger.clone(),
                    ..Default::default()
                });
            }
        }
        st.hub.send(json!({"type": "recording", "id": "alert"}));
    }
}

/// `POST /api/rec/{id}/end {end: <unix ms> | null}` or `{minutes: n}` (from now): change when a
/// running recording stops (null = keep recording until stopped).
pub async fn set_end_route(axum::extract::State(st): axum::extract::State<Arc<AppState>>, axum::extract::Path(id): axum::extract::Path<String>, axum::Json(b): axum::Json<Value>) -> axum::response::Response {
    use axum::response::IntoResponse;
    let now = now_ms();
    let end = match (b.get("minutes").and_then(|m| m.as_f64()), b.get("end")) {
        (Some(m), _) if m > 0.0 && m <= 60.0 * 24.0 * 366.0 => Some(now + (m * 60_000.0) as i64),
        (Some(_), _) => return (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({"error": "minutes must be 1 min – 1 year"}))).into_response(),
        (None, Some(Value::Null)) | (None, None) => None,
        (None, Some(v)) => match v.as_i64() {
            Some(e) => Some(e),
            None => return (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({"error": "end: unix ms or null"}))).into_response(),
        },
    };
    match st.rec.set_end(&id, end, now) {
        Ok(r) => {
            st.hub.send(json!({"type": "recording", "id": id}));
            axum::Json(json!({"ok": true, "rec": r})).into_response()
        }
        Err(e) => (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({"error": e.to_string()}))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_stop_logic() {
        let now = 1_800_000_000_000i64;
        let mut r = Rec { status: "recording".into(), start: now - 60_000, end: Some(now + 30 * 60_000), ..Default::default() };
        assert!(!should_stop(&r, now));
        assert!(should_stop(&r, now + 30 * 60_000));
        // manual (until stopped)
        r.end = None;
        assert!(!should_stop(&r, now + 365 * 86_400_000));
        // scheduled / done recordings aren't stopped by the clock
        r.end = Some(now - 1);
        r.status = "scheduled".into();
        assert!(!should_stop(&r, now));
        // video pieces: 10 min max, never past the end, at least 1 s
        assert_eq!(piece_secs(None, now), 600);
        assert_eq!(piece_secs(Some(now + 90_000), now), 90);
        assert_eq!(piece_secs(Some(now + 3_600_000), now), 600);
        assert_eq!(piece_secs(Some(now - 5_000), now), 1);

        // Record for… / until stopped on a running recording
        let tmp = std::env::temp_dir().join(format!("tbwrec-end-{}", rand::random::<u32>()));
        let rec = Recorder::new(&tmp, true);
        let x = rec.create(Rec { kind: "camera".into(), camera: Some(CamSpec { name: "Cam".into(), url: "https://example.com/a.jpg".into(), kind: "img".into(), ..Default::default() }), ..Default::default() }).unwrap();
        assert_eq!(x.status, "recording");
        assert_eq!(x.end, None, "manual start: until stopped");
        let t = now_ms();
        let y = rec.set_end(&x.id, Some(t + 120_000), t).unwrap();
        assert_eq!(y.end, Some(t + 120_000));
        assert!(should_stop(&y, t + 120_000));
        assert!(rec.set_end(&x.id, Some(t - 1), t).is_err(), "end in the past");
        assert_eq!(rec.set_end(&x.id, None, t).unwrap().end, None);
        rec.stop(&x.id);
        assert!(rec.set_end(&x.id, Some(t + 60_000), t).is_err(), "already stopped");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn contains_and_times() {
        let g = json!({"type": "Polygon", "coordinates": [[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]]]});
        assert!(geom_contains(&g, 5.0, 5.0));
        assert!(!geom_contains(&g, 15.0, 5.0));
        assert_eq!(file_time("1760000000000.jpg"), 1760000000000);
        assert!(file_time("L3_N0B_20261011_123456.bin") > 0);
        assert!(file_time("KTLX20130520_200356_V06") > 0);
    }

    #[test]
    fn radar_frames_include_the_current_one() {
        use crate::radar::service::VolEntry;
        let start = 1_760_000_000_000i64;
        let e = |t: i64, k: &str| VolEntry { key: k.into(), time: t, size: 0, source: "aws" };
        // the volume scanning when the recording started (6 min before) is the first frame;
        // the chunk copy of an archived volume is not recorded twice
        let got = radar_new(vec![e(start - 40 * 60_000, "a"), e(start - 6 * 60_000, "b"), e(start + 300_000, "c"), e(start + 300_020, "chunks:x/KTLX/12")], start, &[]);
        assert_eq!(got.iter().map(|v| v.key.as_str()).collect::<Vec<_>>(), vec!["b", "c"]);
        let got = radar_new(vec![e(start + 300_000, "c"), e(start + 600_000, "d")], start, &[start + 300_010]);
        assert_eq!(got.len(), 1);
        assert_eq!(l2_file_name("ktlx", "chunks:b/KTLX/12", 1_760_000_000_000), "KTLX20251009_085320_V06");
        assert_eq!(l2_file_name("KTLX", "aws:unidata-nexrad-level2/2025/10/09/KTLX/KTLX20251009_084320_V06", 0), "KTLX20251009_084320_V06");
        assert!(file_time("KTLX20251009_084320_V06") > 0);
    }

    fn mp4_box(t: &[u8; 4], payload: usize) -> Vec<u8> {
        let mut v = ((payload + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(t);
        v.extend(std::iter::repeat_n(0u8, payload));
        v
    }

    #[test]
    fn youtube_args() {
        let a = ytdlp_resolve_args("https://www.youtube.com/watch?v=abc");
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == YT_FORMAT));
        assert!(a.contains(&"-j".to_string()));
        assert_eq!(&a[a.len() - 2..], &["--".to_string(), "https://www.youtube.com/watch?v=abc".to_string()]);
        assert!(!a.contains(&"-q".to_string()) && !a.contains(&"--no-warnings".to_string()), "keep yt-dlp's messages for the log");
        assert!(YT_FORMAT.starts_with("best[protocol^=m3u8]"), "live HLS first");
        let p = ytdlp_pipe_args("https://youtu.be/x", &["--ffmpeg-location".into(), "/opt/ffmpeg".into()]);
        let j = p.join(" ");
        assert!(j.contains("--downloader ffmpeg --hls-use-mpegts"));
        assert!(j.contains("--ffmpeg-location /opt/ffmpeg"));
        assert!(j.ends_with("-o - -- https://youtu.be/x"));
        assert!(p.contains(&"--no-part".to_string()));

        // ffmpeg: copy into fragmented MP4 (playable when cut short), never +faststart
        let h = vec![("User-Agent".to_string(), "UA/1".to_string()), ("Accept".to_string(), "*/*".to_string())];
        let f = ffmpeg_piece_args(&PieceInput::Url { url: "https://m/x.m3u8", headers: &h, hls: true }, Some(600), "/r/1.mp4.part", true);
        let fj = f.join(" ");
        assert!(fj.contains("-user_agent UA/1"));
        assert!(fj.contains("-headers Accept: */*\r\n"));
        assert!(fj.contains("-extension_picky 0 -i https://m/x.m3u8"));
        assert!(fj.contains("-c copy -t 600 -f mp4 -movflags +frag_keyframe+default_base_moof /r/1.mp4.part"));
        assert!(!fj.contains("faststart") && !fj.contains("empty_moov"));
        // -headers / -user_agent are input options: before -i
        assert!(f.iter().position(|x| x == "-headers").unwrap() < f.iter().position(|x| x == "-i").unwrap());
        let f = ffmpeg_piece_args(&PieceInput::Url { url: "https://m/x.m3u8", headers: &[], hls: true }, None, "o", false);
        assert!(!f.contains(&"-extension_picky".to_string()) && !f.contains(&"-t".to_string()) && !f.contains(&"-headers".to_string()));
        let f = ffmpeg_piece_args(&PieceInput::Pipe, Some(90), "o", true);
        assert!(f.join(" ").contains("-i pipe:0 -c copy -t 90"));
        assert!(!f.contains(&"-rw_timeout".to_string()));
    }

    #[test]
    fn youtube_resolve_output() {
        let out = r#"{"id":"abc","url":"https://manifest.googlevideo.com/api/manifest/hls_playlist/id/abc/index.m3u8","protocol":"m3u8_native","is_live":true,"live_status":"is_live","format_id":"95","height":720,"http_headers":{"User-Agent":"Mozilla/5.0","Accept":"*/*","Bad":"a\r\nb"}}"#;
        let s = parse_resolve(&format!("[youtube] noise\n{out}\n")).unwrap();
        assert!(s.is_live);
        assert_eq!(s.protocol, "m3u8_native");
        assert_eq!(s.format, "95 720p");
        assert_eq!(s.headers.len(), 2, "headers with line breaks are dropped");
        let vod = parse_resolve(r#"{"url":"https://rr1.googlevideo.com/videoplayback?x","protocol":"https","is_live":false,"live_status":"was_live","format_id":"18"}"#).unwrap();
        assert!(!vod.is_live);
        assert_eq!(vod.live_status, "was_live");
        assert!(parse_resolve(r#"{"format_id":"137+140","requested_formats":[]}"#).is_err());
        assert!(parse_resolve("").is_err());
        assert!(parse_resolve("not json {").is_err());
    }

    #[test]
    fn empty_pieces_are_detected() {
        use std::io::Cursor;
        let header = [mp4_box(b"ftyp", 20), mp4_box(b"moov", 600)].concat();
        // what ffmpeg writes before any data arrives: the header only
        assert!(!mp4_has_media(Cursor::new(&header), header.len() as u64));
        let mut ok = header.clone();
        ok.extend(mp4_box(b"moof", 100));
        ok.extend(mp4_box(b"mdat", 5000));
        assert!(mp4_has_media(Cursor::new(&ok), ok.len() as u64));
        // a fragment cut off mid-way still counts
        let cut = &ok[..ok.len() - 3000];
        assert!(mp4_has_media(Cursor::new(cut), cut.len() as u64));
        let mut e = header.clone();
        e.extend(mp4_box(b"mdat", 0));
        assert!(!mp4_has_media(Cursor::new(&e), e.len() as u64), "empty mdat");
        // an old-style (+faststart) piece killed before its moov was written
        let killed = [mp4_box(b"ftyp", 20), mp4_box(b"free", 0), mp4_box(b"mdat", 9000)].concat();
        assert!(!mp4_has_media(Cursor::new(&killed), killed.len() as u64));
        // mdat with size 0 (to the end of the file) and with a 64-bit size
        let mut z = header.clone();
        z.extend([0, 0, 0, 0]);
        z.extend(b"mdat");
        z.extend([1u8; 50]);
        assert!(mp4_has_media(Cursor::new(&z), z.len() as u64));
        let mut l = header.clone();
        l.extend(1u32.to_be_bytes());
        l.extend(b"mdat");
        l.extend((16u64 + 40).to_be_bytes());
        l.extend([1u8; 40]);
        assert!(mp4_has_media(Cursor::new(&l), l.len() as u64));
        assert!(!mp4_has_media(Cursor::new(&[0u8; 4]), 4));
        assert!(!mp4_has_media(Cursor::new(&[0u8; 64]), 64), "garbage");

        // leftover .part pieces: playable ones are kept, empty ones deleted
        let d = std::env::temp_dir().join(format!("tbwrec-parts-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("1760000000000.mp4.part"), &ok).unwrap();
        std::fs::write(d.join("1760000600000.mp4.part"), &header).unwrap();
        std::fs::write(d.join("1760000900000.mp4.part"), b"").unwrap();
        let kept = recover_parts(&d);
        assert_eq!(kept, vec![("1760000000000.mp4".to_string(), ok.len() as u64)]);
        let mut left: Vec<String> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        left.sort();
        assert_eq!(left, vec!["1760000000000.mp4"]);
        assert!(file_has_media(&d.join("1760000000000.mp4")));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn failure_reasons() {
        let dl = vec!["[youtube] abc123: Downloading webpage".to_string(), "ERROR: [youtube] abc123: Sign in to confirm you're not a bot".to_string()];
        assert_eq!(fail_reason(&dl, &["pipe:0: Invalid data found when processing input".into()]), "Sign in to confirm you're not a bot");
        assert_eq!(fail_reason(&[], &["[hls @ 0x1] Opening 'x' for reading".into(), "https://m/x.m3u8: Server returned 403 Forbidden (access denied)".into()]), "https://m/x.m3u8: Server returned 403 Forbidden (access denied)");
        assert_eq!(fail_reason(&[], &[]), "no data from the stream");
        assert_eq!(fail_reason(&["ERROR: Requested format is not available".into()], &[]), "Requested format is not available");
        assert!(fail_reason(&[], &["x".repeat(500)]).chars().count() <= 221);
    }

    #[test]
    fn export_import_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("tbwrec-{}", rand::random::<u32>()));
        let rec = Recorder::new(&tmp, true);
        let r = rec.create(Rec { kind: "radar".into(), radar: Some(RadarSpec { site: "KTLX".into(), source: "L2".into(), products: vec![] }), ..Default::default() }).unwrap();
        std::fs::write(rec.rec_dir(&r.id).join("KTLX20260101_000000_V06"), b"x").unwrap();
        let z = tmp.join("out.zip");
        rec.export(&[], &z).unwrap();
        let ids = rec.import(&z).unwrap();
        assert_eq!(ids.len(), 1);
        assert_ne!(ids[0], r.id);
        assert!(rec.get(&ids[0]).unwrap().imported);
        assert!(!rec.get(&r.id).unwrap().imported);
        assert_eq!(rec.frames(&ids[0]).unwrap().len(), 1);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
