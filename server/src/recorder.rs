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
fn is_youtube_video(url: &str) -> bool {
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
            "recording" if r.end.map(|e| now >= e).unwrap_or(false) => rec.stop(&r.id),
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

async fn camera_worker(st: &Arc<AppState>, r: &Rec, stop: &AtomicBool) -> Result<()> {
    let c = r.camera.clone().unwrap_or_default();
    let dir = st.rec.rec_dir(&r.id);
    let yt = is_youtube(&c.url);
    if c.kind == "hls" || yt {
        // copy the stream in 10-minute pieces so a dropped connection loses little
        let mut fails = 0;
        let mut short_runs = 0;
        while !stop.load(Ordering::SeqCst) {
            let left = r.end.map(|e| ((e - now_ms()) / 1000).max(1)).unwrap_or(600).min(600);
            let name = format!("{}.mp4", now_ms());
            let part = dir.join(format!("{name}.part"));
            // YouTube: yt-dlp resolves and downloads the stream, ffmpeg remuxes it into the same
            // 10-minute .mp4 pieces as other video cameras (so playback/export/timelapse just work)
            let (mut child, mut feeder) = if yt {
                let mut dl = crate::platform::command("yt-dlp")
                    .args(["-q", "--no-warnings", "--no-part", "--no-playlist", "-f", "best[height<=1080]/best", "-o", "-", &c.url])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .spawn()?;
                let out: std::process::Stdio = dl.stdout.take().ok_or_else(|| anyhow!("yt-dlp pipe"))?.try_into()?;
                let ff = crate::platform::command("ffmpeg")
                    .args(["-y", "-loglevel", "error", "-i", "pipe:0", "-c", "copy", "-t", &left.to_string(), "-f", "mp4", "-movflags", "+faststart"])
                    .arg(&part)
                    .stdin(out)
                    .kill_on_drop(true)
                    .spawn()?;
                (ff, Some(dl))
            } else {
                let ff = crate::platform::command("ffmpeg")
                    .args(["-y", "-loglevel", "error", "-rw_timeout", "15000000", "-i", &c.url, "-c", "copy", "-t", &left.to_string(), "-f", "mp4", "-movflags", "+faststart"])
                    .arg(&part)
                    // Windows: "q" on stdin is how ffmpeg is asked to finish the file (no SIGINT)
                    .stdin(if cfg!(unix) { std::process::Stdio::null() } else { std::process::Stdio::piped() })
                    .kill_on_drop(true)
                    .spawn()?;
                (ff, None)
            };
            let started = std::time::Instant::now();
            let mut clean_exit = false;
            loop {
                if stop.load(Ordering::SeqCst) {
                    // ask ffmpeg to finish the file cleanly; when yt-dlp feeds it, ending the feed
                    // (EOF on its stdin) does the same on every platform
                    if let Some(dl) = feeder.as_mut() {
                        if cfg!(unix) {
                            crate::platform::ffmpeg_finish(&mut child).await;
                        } else {
                            dl.start_kill().ok();
                        }
                    } else {
                        crate::platform::ffmpeg_finish(&mut child).await;
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
                    break;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    clean_exit = status.success();
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            // ffmpeg is done with this piece; yt-dlp is restarted for the next one
            if let Some(mut dl) = feeder.take() {
                dl.start_kill().ok();
                let _ = tokio::time::timeout(Duration::from_secs(5), dl.wait()).await;
            }
            let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            if size > 10_000 {
                std::fs::rename(&part, dir.join(&name))?;
                note_file(st, &r.id, size, now_ms());
                fails = 0;
                // the stream ended by itself (a video file, not a live feed): don't record it again
                if clean_exit && !stop.load(Ordering::SeqCst) && started.elapsed().as_secs() < (left as u64) / 2 {
                    short_runs += 1;
                    if short_runs >= 1 {
                        st.rec.update(&r.id, |x| {
                            x.status = "done".into();
                            x.end = Some(now_ms());
                        });
                        return Ok(());
                    }
                }
            } else {
                std::fs::remove_file(&part).ok();
                fails += 1;
                if fails >= 5 {
                    bail!("the stream couldn't be recorded (5 failed attempts)");
                }
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
            if started.elapsed() < Duration::from_secs(5) && fails > 0 {
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
        return Ok(());
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

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(rec.frames(&ids[0]).unwrap().len(), 1);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
