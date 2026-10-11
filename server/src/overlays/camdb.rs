//! Camera database: a large user-supplied camera list (`data/uploads/filtereddb.json`, or any
//! `*cam*.json` / `filtereddb*.json` there) merged into the cameras overlay.
//!
//! The file can be hundreds of MB, so it is stream-parsed once (records are never held as a whole
//! JSON tree), filtered (inactive, ignored, marked duplicates), de-duplicated within itself, and
//! cached as a compact zstd file in `data/cache/`. At query time cameras that repeat one of the
//! live sources (same image URL, or the same spot from the same agency) are dropped, so nothing
//! shows twice. Queries are by bounding box with clustering when zoomed out.

use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

/// One camera, compact.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Cam {
    pub id: String,
    pub name: String,
    /// source id ("caltrans", or "db:castlerock" for database cameras)
    pub src: String,
    pub lat: f32,
    pub lon: f32,
    /// img | hls | yt | page
    pub t: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub img: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// seconds between image refreshes
    pub refresh: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// the URL breaks if a cache-buster query is added
    #[serde(default)]
    pub nb: bool,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct DbStats {
    pub file: String,
    pub records: usize,
    pub kept: usize,
    pub inactive: usize,
    pub marked_duplicate: usize,
    pub duplicate_in_file: usize,
    pub unusable: usize,
    pub sources: Vec<(String, usize)>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct CamDb {
    pub cams: Vec<Cam>,
    pub stats: DbStats,
    /// source file size + mtime the cache was built from
    pub stamp: String,
}

/// Raw record as found in the file. Every field optional and loosely typed; unknown fields
/// (search vectors, hashes…) are skipped without being stored.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Rec {
    id: Value,
    camera_code: Value,
    name: Value,
    city: Value,
    state: Value,
    lat: Value,
    lng: Value,
    lon: Value,
    longitude: Value,
    latitude: Value,
    feed_url: Value,
    url: Value,
    feed_type: Value,
    update_rate: Value,
    source: Value,
    direction: Value,
    active: Value,
    deactivated_at: Value,
    duplicate_of: Value,
    ignored: Value,
    cache_buster_breaks_url: Value,
    feed_stale_since: Value,
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() && s != "null" => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// true/1/"true"/"1" → Some(true); false/0 → Some(false); null/missing → None
fn flag(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => Some(n.as_f64().unwrap_or(0.0) != 0.0),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "1" | "yes" | "y" => Some(true),
            "false" | "f" | "0" | "no" | "n" | "" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn present(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.trim().is_empty() && s != "null",
        Value::Bool(b) => *b,
        _ => true,
    }
}

/// URL key for duplicate detection: no scheme, no "www.", lower case, cache-buster params removed.
pub fn url_key(u: &str) -> String {
    let l = u.trim().to_ascii_lowercase();
    let l = l.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.");
    let (path, query) = l.split_once('?').unwrap_or((l, ""));
    const BUST: &[&str] = &["t", "_", "ts", "time", "timestamp", "rand", "random", "r", "cb", "cachebuster", "nocache", "dt", "_tbw", "v"];
    let mut keep: Vec<&str> = query.split('&').filter(|p| !p.is_empty() && !BUST.contains(&p.split('=').next().unwrap_or(""))).collect();
    keep.sort_unstable();
    let path = path.trim_end_matches('/');
    if keep.is_empty() { path.to_string() } else { format!("{path}?{}", keep.join("&")) }
}

fn kind_for(feed_type: &str, url: &str) -> &'static str {
    let ft = feed_type.to_ascii_lowercase();
    let u = url.to_ascii_lowercase();
    if u.contains("youtube.com") || u.contains("youtu.be") || ft == "youtube" {
        "yt"
    } else if ft == "m3u8" || ft == "hls" || ft == "mp4" || ft == "video" || u.contains(".m3u8") || u.ends_with(".mp4") {
        "hls"
    } else if ft == "iframe" || ft == "page" || ft == "html" || ft == "embed" {
        "page"
    } else {
        // "image", "jpeg", "mjpeg" (an <img> plays MJPEG streams), unknown
        "img"
    }
}

struct Builder {
    cams: Vec<Cam>,
    stats: DbStats,
    urls: HashSet<String>,
    spots: HashSet<(i32, i32, String)>,
    ids: HashSet<String>,
}

impl Builder {
    fn new(file: &str) -> Self {
        Self { cams: vec![], stats: DbStats { file: file.to_string(), ..Default::default() }, urls: HashSet::new(), spots: HashSet::new(), ids: HashSet::new() }
    }

    fn add(&mut self, r: Rec) {
        self.stats.records += 1;
        if flag(&r.active) == Some(false) || flag(&r.ignored) == Some(true) || present(&r.deactivated_at) {
            self.stats.inactive += 1;
            return;
        }
        if present(&r.duplicate_of) && flag(&r.duplicate_of) != Some(false) {
            self.stats.marked_duplicate += 1;
            return;
        }
        let lat = num(&r.lat).or_else(|| num(&r.latitude));
        let lon = num(&r.lng).or_else(|| num(&r.lon)).or_else(|| num(&r.longitude));
        let url = text(&r.feed_url).or_else(|| text(&r.url)).filter(|u| u.starts_with("http"));
        let (Some(lat), Some(lon), Some(url)) = (lat, lon, url) else {
            self.stats.unusable += 1;
            return;
        };
        if !(lat.abs() <= 90.0 && lon.abs() <= 180.0) || (lat.abs() < 1e-6 && lon.abs() < 1e-6) {
            self.stats.unusable += 1;
            return;
        }
        let name = text(&r.name).unwrap_or_else(|| [text(&r.city), text(&r.state)].into_iter().flatten().collect::<Vec<_>>().join(", "));
        let src = text(&r.source).unwrap_or_else(|| "other".into()).to_ascii_lowercase();
        let uk = url_key(&url);
        let spot = ((lat * 1e4).round() as i32, (lon * 1e4).round() as i32, name.to_ascii_lowercase());
        if self.urls.contains(&uk) || (!name.is_empty() && self.spots.contains(&spot)) {
            self.stats.duplicate_in_file += 1;
            return;
        }
        self.urls.insert(uk);
        self.spots.insert(spot);
        let mut id = text(&r.id).or_else(|| text(&r.camera_code)).unwrap_or_else(|| format!("{}", self.cams.len()));
        if self.ids.contains(&id) {
            id = format!("{id}-{}", self.cams.len());
        }
        self.ids.insert(id.clone());
        let ft = text(&r.feed_type).unwrap_or_default();
        let t = kind_for(&ft, &url);
        let refresh = num(&r.update_rate).map(|ms| if ms > 1000.0 { ms / 1000.0 } else { ms }).unwrap_or(60.0).clamp(5.0, 3600.0) as u32;
        let (img, video, page) = match t {
            "img" => (Some(url), None, None),
            "page" => (None, None, Some(url)),
            _ => (None, Some(url), None),
        };
        self.cams.push(Cam {
            id: format!("db:{id}"),
            name: if name.is_empty() { format!("Camera {id}") } else { name },
            src: format!("db:{src}"),
            lat: lat as f32,
            lon: lon as f32,
            t: t.into(),
            img,
            video,
            page,
            refresh,
            dir: text(&r.direction),
            nb: flag(&r.cache_buster_breaks_url) == Some(true),
            stale: present(&r.feed_stale_since),
        });
    }

    fn finish(mut self, stamp: String) -> CamDb {
        self.stats.kept = self.cams.len();
        let mut by: HashMap<String, usize> = HashMap::new();
        for c in &self.cams {
            *by.entry(c.src.clone()).or_default() += 1;
        }
        let mut v: Vec<(String, usize)> = by.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        self.stats.sources = v;
        CamDb { cams: self.cams, stats: self.stats, stamp }
    }
}

// ---------- streaming JSON ----------

/// Walks any JSON container: arrays of objects are camera records; objects are searched for
/// arrays (e.g. {"cameras": [...]}, {"data": {"rows": [...]}}). Nothing else is kept.
struct Walk<'a>(&'a mut Builder);

impl<'de> DeserializeSeed<'de> for Walk<'_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Walk<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("JSON")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(item) = seq.next_element::<Item>()? {
            if let Item::Rec(r) = item {
                self.0.add(*r);
            }
        }
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(_k) = map.next_key::<IgnoredAny>()? {
            map.next_value_seed(Walk(self.0))?;
        }
        Ok(())
    }
    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }
}

/// An array element: a record object, or anything else (skipped).
enum Item {
    Rec(Box<Rec>),
    Other,
}

impl<'de> Deserialize<'de> for Item {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(match v {
            Value::Object(_) => serde_json::from_value::<Rec>(v).map(|r| Item::Rec(Box::new(r))).unwrap_or(Item::Other),
            _ => Item::Other,
        })
    }
}

/// Parse a camera file (JSON array, object holding arrays, or newline-delimited JSON).
pub fn parse_reader<R: Read>(r: R, file: &str, stamp: String) -> anyhow::Result<CamDb> {
    let mut br = BufReader::with_capacity(1 << 20, r);
    // peek: NDJSON has a complete object on the first line
    let first_line = {
        let buf = br.fill_buf()?;
        let end = buf.iter().position(|&b| b == b'\n').unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).trim().trim_start_matches('\u{feff}').to_string()
    };
    let mut b = Builder::new(file);
    let ndjson = first_line.starts_with('{') && first_line.ends_with('}') && serde_json::from_str::<Value>(&first_line).map(|v| v.get("feed_url").is_some() || v.get("lat").is_some()).unwrap_or(false);
    if ndjson {
        for line in br.lines() {
            let line = line?;
            let l = line.trim();
            if l.is_empty() {
                continue;
            }
            if let Ok(r) = serde_json::from_str::<Rec>(l) {
                b.add(r);
            } else {
                b.stats.records += 1;
                b.stats.unusable += 1;
            }
        }
    } else {
        let mut de = serde_json::Deserializer::from_reader(br);
        Walk(&mut b).deserialize(&mut de)?;
    }
    Ok(b.finish(stamp))
}

/// Camera list files in the uploads folder.
pub fn find_files(uploads: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(uploads)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
                    (n.ends_with(".json") || n.ends_with(".ndjson") || n.ends_with(".json.gz") || n.ends_with(".json.zst")) && (n.starts_with("filtereddb") || n.contains("camera") || n.contains("cams"))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn stamp_of(files: &[PathBuf]) -> String {
    files
        .iter()
        .map(|p| {
            let m = std::fs::metadata(p).ok();
            let t = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            format!("{}:{}:{}", p.file_name().and_then(|n| n.to_str()).unwrap_or(""), m.map(|m| m.len()).unwrap_or(0), t)
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// Load the database: from the compact cache when it matches the files, else by parsing them
/// (then the cache is written). Returns None when there's no camera file.
pub fn load(data_root: &Path) -> anyhow::Result<Option<CamDb>> {
    let uploads = data_root.join("uploads");
    let files = find_files(&uploads);
    if files.is_empty() {
        return Ok(None);
    }
    let stamp = stamp_of(&files);
    let cache = data_root.join("cache").join("camdb.json.zst");
    if let Ok(f) = std::fs::File::open(&cache) {
        if let Ok(dec) = zstd::Decoder::new(f) {
            if let Ok(db) = serde_json::from_reader::<_, CamDb>(BufReader::new(dec)) {
                if db.stamp == stamp {
                    tracing::info!("camera database: {} cameras (cached)", db.cams.len());
                    return Ok(Some(db));
                }
            }
        }
    }
    let t0 = std::time::Instant::now();
    let mut all = CamDb { stamp: stamp.clone(), ..Default::default() };
    let mut seen_urls: HashSet<String> = HashSet::new();
    for p in &files {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let f = std::fs::File::open(p)?;
        let reader: Box<dyn Read> = if name.ends_with(".gz") {
            Box::new(flate2::read::MultiGzDecoder::new(f))
        } else if name.ends_with(".zst") {
            Box::new(zstd::Decoder::new(f)?)
        } else {
            Box::new(f)
        };
        match parse_reader(reader, &name, stamp.clone()) {
            Ok(db) => {
                let s = &db.stats;
                tracing::info!(
                    "camera database {name}: {} records → {} kept ({} inactive, {} marked duplicate, {} duplicate in file, {} unusable)",
                    s.records, s.kept, s.inactive, s.marked_duplicate, s.duplicate_in_file, s.unusable
                );
                // several files: drop repeats across them too
                for c in db.cams {
                    let k = url_key(c.img.as_deref().or(c.video.as_deref()).or(c.page.as_deref()).unwrap_or(""));
                    if seen_urls.insert(k) {
                        all.cams.push(c);
                    }
                }
                let st = &mut all.stats;
                st.file = if st.file.is_empty() { name.clone() } else { format!("{}, {name}", st.file) };
                st.records += db.stats.records;
                st.inactive += db.stats.inactive;
                st.marked_duplicate += db.stats.marked_duplicate;
                st.duplicate_in_file += db.stats.duplicate_in_file;
                st.unusable += db.stats.unusable;
            }
            Err(e) => tracing::warn!("camera database {name}: {e:#}"),
        }
    }
    all.stats.kept = all.cams.len();
    let mut by: HashMap<String, usize> = HashMap::new();
    for c in &all.cams {
        *by.entry(c.src.clone()).or_default() += 1;
    }
    let mut v: Vec<(String, usize)> = by.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    all.stats.sources = v;
    tracing::info!("camera database: {} cameras in {:.1}s", all.cams.len(), t0.elapsed().as_secs_f32());
    std::fs::create_dir_all(data_root.join("cache")).ok();
    let tmp = cache.with_extension("tmp");
    if let Ok(f) = std::fs::File::create(&tmp) {
        if let Ok(mut enc) = zstd::Encoder::new(f, 6) {
            if serde_json::to_writer(&mut enc, &all).is_ok() && enc.finish().is_ok() {
                std::fs::rename(&tmp, &cache).ok();
            }
        }
    }
    Ok(Some(all))
}

// ---------- combined index (live sources + database) ----------

/// Which live source a database "source" value belongs to (same agency → same cameras).
pub fn family(db_src: &str) -> Option<&'static str> {
    let s = db_src.trim_start_matches("db:");
    const MAP: &[(&str, &str)] = &[
        ("caltrans", "caltrans"),
        ("wsdot", "wsdot"),
        ("tripcheck", "tripcheck"),
        ("odot", "tripcheck"),
        ("oregon", "tripcheck"),
        ("iowa", "iowadot"),
        ("kytc", "kytc"),
        ("kentucky", "kytc"),
        ("modot", "modot"),
        ("missouri", "modot"),
        ("algo", "algo"),
        ("aldot", "algo"),
        ("alabama", "algo"),
        ("nycdot", "nycdot"),
        ("nyc", "nycdot"),
        ("drivebc", "drivebc"),
        ("quebec", "quebec"),
        ("digitraffic", "digitraffic"),
        ("finland", "digitraffic"),
        ("iceland", "iceland"),
        ("vegagerdin", "iceland"),
        ("hongkong", "hongkong"),
        ("hong kong", "hongkong"),
        ("singapore", "singapore"),
        ("lta", "singapore"),
        ("nzta", "nzta"),
        ("nsw", "nsw"),
        ("qld", "qld"),
        ("queensland", "qld"),
        ("opentrafficcam", "otcm"),
        ("ndbc", "buoycam"),
        ("buoycam", "buoycam"),
    ];
    MAP.iter().find(|(k, _)| s.contains(k)).map(|(_, v)| *v)
}

fn words(s: &str) -> HashSet<String> {
    s.to_ascii_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| w.len() > 1).map(|w| w.to_string()).collect()
}

fn similar(a: &str, b: &str) -> bool {
    let (x, y) = (words(a), words(b));
    if x.is_empty() || y.is_empty() {
        return false;
    }
    let common = x.intersection(&y).count();
    common as f32 / (x.len().min(y.len()) as f32) >= 0.6
}

fn meters(a: &Cam, lat: f32, lon: f32) -> f32 {
    let dy = (a.lat - lat) * 111_320.0;
    let dx = (a.lon - lon) * 111_320.0 * (lat.to_radians().cos());
    (dx * dx + dy * dy).sqrt()
}

const CELL: f32 = 0.5;

pub struct Index {
    pub cams: Vec<Cam>,
    grid: HashMap<(i32, i32), Vec<u32>>,
    /// database cameras dropped because a live source already has them
    pub dropped_overlap: usize,
}

fn cell(lat: f32, lon: f32, size: f32) -> (i32, i32) {
    ((lat / size).floor() as i32, (lon / size).floor() as i32)
}

impl Index {
    /// Live cameras first; database cameras are added unless they repeat a live one.
    pub fn build(live: Vec<Cam>, db: Option<&CamDb>) -> Index {
        let mut near: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        let mut urls: HashSet<String> = HashSet::new();
        const FINE: f32 = 0.01;
        for (i, c) in live.iter().enumerate() {
            near.entry(cell(c.lat, c.lon, FINE)).or_default().push(i as u32);
            for u in [&c.img, &c.video, &c.page].into_iter().flatten() {
                urls.insert(url_key(u));
            }
        }
        let mut cams = live;
        let n_live = cams.len();
        let mut dropped = 0;
        if let Some(db) = db {
            for c in &db.cams {
                let u = c.img.as_deref().or(c.video.as_deref()).or(c.page.as_deref()).unwrap_or("");
                if urls.contains(&url_key(u)) {
                    dropped += 1;
                    continue;
                }
                let fam = family(&c.src);
                let (cy, cx) = cell(c.lat, c.lon, FINE);
                let mut dup = false;
                'look: for dy in -1..=1 {
                    for dx in -1..=1 {
                        if let Some(ix) = near.get(&(cy + dy, cx + dx)) {
                            for &i in ix {
                                let l = &cams[i as usize];
                                let d = meters(l, c.lat, c.lon);
                                // same spot from the same agency, or practically the same spot with a similar name
                                if d < 12.0 || (d < 80.0 && (fam == Some(l.src.as_str()) || similar(&l.name, &c.name))) {
                                    dup = true;
                                    break 'look;
                                }
                            }
                        }
                    }
                }
                if dup {
                    dropped += 1;
                } else {
                    cams.push(c.clone());
                }
            }
        }
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, c) in cams.iter().enumerate() {
            grid.entry(cell(c.lat, c.lon, CELL)).or_default().push(i as u32);
        }
        tracing::debug!("camera index: {n_live} live + {} database ({dropped} overlapping dropped)", cams.len() - n_live);
        Index { cams, grid, dropped_overlap: dropped }
    }

    /// Cameras in a box (west, south, east, north). Zoomed out (or too many): clusters.
    pub fn query(&self, bbox: [f32; 4], zoom: f32, off: &HashSet<String>, kinds: &str) -> Vec<Value> {
        let [w, s, e, n] = bbox;
        let (c0, c1) = (cell(s, w, CELL), cell(n, e, CELL));
        let want = |c: &Cam| {
            !off.contains(&c.src)
                && c.lat >= s
                && c.lat <= n
                && c.lon >= w
                && c.lon <= e
                && match kinds {
                    "img" => c.t == "img",
                    "video" => c.t == "hls" || c.t == "yt",
                    _ => true,
                }
        };
        let mut hits: Vec<&Cam> = vec![];
        for y in c0.0..=c1.0 {
            for x in c0.1..=c1.1 {
                if let Some(ix) = self.grid.get(&(y, x)) {
                    hits.extend(ix.iter().map(|&i| &self.cams[i as usize]).filter(|c| want(c)));
                }
            }
        }
        if zoom >= 8.0 || (zoom >= 6.0 && hits.len() <= 3000) || hits.len() <= 400 {
            return hits.into_iter().take(8000).map(feature).collect();
        }
        // clusters on a screen-sized grid (~60 px cells)
        let size = (360.0 / 2f32.powf(zoom)) * (60.0 / 256.0);
        let mut groups: HashMap<(i32, i32), (f64, f64, usize, &Cam)> = HashMap::new();
        for c in hits {
            let k = cell(c.lat, c.lon, size);
            let e = groups.entry(k).or_insert((0.0, 0.0, 0, c));
            e.0 += c.lat as f64;
            e.1 += c.lon as f64;
            e.2 += 1;
        }
        groups
            .into_values()
            .map(|(la, lo, k, one)| if k == 1 { feature(one) } else { super::point(lo / k as f64, la / k as f64, json!({"cl": k})) })
            .collect()
    }
}

pub fn feature(c: &Cam) -> Value {
    let mut p = json!({"id": c.id, "n": c.name, "s": c.src, "t": c.t, "i": c.img, "v": c.video, "p": c.page, "r": c.refresh});
    if let Some(d) = &c.dir {
        p["dir"] = json!(d);
    }
    if c.nb {
        p["nb"] = json!(1);
    }
    if c.stale {
        p["stale"] = json!(1);
    }
    super::point(c.lon as f64, c.lat as f64, p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        r#"[
 {"id": 1, "camera_code": "cr-MN-477839", "name": "I-35 at 5th", "city": "Duluth", "state": "MN", "country": "US", "lat": 46.78, "lng": -92.1, "feed_url": "https://ex.com/cam/477839.jpg?t=123", "feed_type": "image", "update_rate": 60000, "source": "castlerock", "active": 1, "ignored": 0, "duplicate_of": null, "deactivated_at": null, "search_vector": "'i':1 '35':2"},
 {"id": 2, "camera_code": "cr-MN-478757", "name": "I-35 at 5th", "lat": 46.78, "lng": -92.1, "feed_url": "https://ex.com/cam/477839.jpg?t=999", "feed_type": "image", "source": "castlerock", "active": 1},
 {"id": 3, "name": "Gone", "lat": 40, "lng": -100, "feed_url": "https://ex.com/3.jpg", "active": 0},
 {"id": 4, "name": "Dup mark", "lat": 40, "lng": -100, "feed_url": "https://ex.com/4.jpg", "active": 1, "duplicate_of": 1},
 {"id": 5, "name": "HLS", "lat": 34.1, "lng": -118.2, "feed_url": "https://ex.com/live/5.m3u8", "feed_type": "m3u8", "source": "caltrans", "active": true, "cache_buster_breaks_url": true},
 {"id": 6, "name": "No coords", "feed_url": "https://ex.com/6.jpg"},
 {"id": 7, "name": "Old", "lat": 41, "lng": -101, "feed_url": "https://ex.com/7.jpg", "deactivated_at": "2025-01-01"}
]"#
        .to_string()
    }

    #[test]
    fn parses_and_filters() {
        let db = parse_reader(sample().as_bytes(), "t.json", "s".into()).unwrap();
        assert_eq!(db.stats.records, 7);
        assert_eq!(db.cams.len(), 2);
        assert_eq!(db.stats.inactive, 2);
        assert_eq!(db.stats.marked_duplicate, 1);
        assert_eq!(db.stats.duplicate_in_file, 1);
        assert_eq!(db.stats.unusable, 1);
        let h = db.cams.iter().find(|c| c.t == "hls").unwrap();
        assert!(h.nb);
        assert_eq!(h.src, "db:caltrans");
        assert_eq!(db.cams[0].refresh, 60);
    }

    #[test]
    fn wrapped_and_ndjson() {
        let wrapped = format!(r#"{{"meta": {{"n": 7}}, "cameras": {}}}"#, sample());
        assert_eq!(parse_reader(wrapped.as_bytes(), "w", "s".into()).unwrap().cams.len(), 2);
        let nd = "{\"id\":1,\"lat\":1.5,\"lng\":2.5,\"feed_url\":\"https://a/1.jpg\"}\n{\"id\":2,\"lat\":1.6,\"lng\":2.6,\"feed_url\":\"https://a/2.jpg\"}\n";
        assert_eq!(parse_reader(nd.as_bytes(), "n", "s".into()).unwrap().cams.len(), 2);
    }

    #[test]
    fn overlap_with_live_sources() {
        let db = parse_reader(sample().as_bytes(), "t.json", "s".into()).unwrap();
        let live = vec![
            // same Caltrans camera 30 m away → the database copy goes
            Cam { id: "caltrans:1".into(), name: "LA cam".into(), src: "caltrans".into(), lat: 34.10027, lon: -118.2, t: "img".into(), img: Some("https://cwwp2.dot.ca.gov/1.jpg".into()), video: None, page: None, refresh: 60, dir: None, nb: false, stale: false },
        ];
        let idx = Index::build(live, Some(&db));
        assert_eq!(idx.cams.len(), 2);
        assert_eq!(idx.dropped_overlap, 1);
        let all = idx.query([-180.0, -90.0, 180.0, 90.0], 10.0, &HashSet::new(), "all");
        assert_eq!(all.len(), 2);
        let none = idx.query([-180.0, -90.0, 180.0, 90.0], 10.0, &["db:castlerock".to_string()].into_iter().collect(), "all");
        assert_eq!(none.len(), 1);
    }

    #[test]
    fn url_keys() {
        assert_eq!(url_key("https://www.Ex.com/a.jpg?t=1&id=5"), url_key("http://ex.com/a.jpg?id=5&_=9"));
        assert_ne!(url_key("https://ex.com/a.jpg?id=5"), url_key("https://ex.com/a.jpg?id=6"));
    }

    #[test]
    fn clusters_when_zoomed_out() {
        let mut live = vec![];
        for i in 0..1000 {
            live.push(Cam { id: format!("x:{i}"), name: format!("c{i}"), src: "x".into(), lat: 35.0 + (i % 40) as f32 * 0.05, lon: -97.0 + (i / 40) as f32 * 0.05, t: "img".into(), img: Some(format!("https://a/{i}")), video: None, page: None, refresh: 60, dir: None, nb: false, stale: false });
        }
        let idx = Index::build(live, None);
        let f = idx.query([-100.0, 30.0, -90.0, 40.0], 4.0, &HashSet::new(), "all");
        assert!(f.len() < 100);
        assert_eq!(f.iter().map(|x| x["properties"]["cl"].as_u64().unwrap_or(1)).sum::<u64>(), 1000);
    }
}
