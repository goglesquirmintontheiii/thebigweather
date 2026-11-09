//! 0.8.3 / 0.8.4: RainViewer (rainviewer.com) radar for places without an open national feed in
//! Stormiq (Australia, New Zealand, Asia, South America, …).
//!
//! * Single-site images: `https://data.rainviewer.com/images/<id>/` holds a radar's last few
//!   `<id>_<YYYYMMDD>_<HHMMSS>_0_source.<png|gif|jpeg|jpg|jfif|webp>` files, the agencies' own
//!   pictures. Other directories in the tree publish volumes Stormiq already has (`.h5` ODIM,
//!   `.bufr.gz`, `.n2a` NEXRAD) and are not listed here. `0_products.json`, where present, is a
//!   frozen August 2025 snapshot: its scans no longer exist, only its bounding box is useful.
//! * The site list is `rainviewer_sites.tsv`, generated from a full copy of the tree. `display`
//!   says how a radar can be shown: `map` (transparent image with a known extent, drawn on the
//!   map) or `panel` (a picture with its own basemap and legend, shown in a floating panel).
//! * Global composite: `https://api.rainviewer.com/public/weather-maps.json`, frames of the past
//!   2 h (tiles `{host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png`, zoom ≤ 7).
//!
//! data.rainviewer.com's robots.txt disallows crawlers, so nothing here walks the tree: a radar's
//! directory is read only when someone selects that radar (cached: frame list 3 min, images
//! 10 min, by `IntlRadar`). Free for personal / non-commercial use; attribution required.

use anyhow::{anyhow, bail, Result};
use chrono::{NaiveDateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub const DATA_BASE: &str = "https://data.rainviewer.com/images/";
pub const MAPS_JSON: &str = "https://api.rainviewer.com/public/weather-maps.json";
pub const TILE_HOST: &str = "https://tilecache.rainviewer.com";
/// hosts the image proxy may fetch from for RainViewer
pub const HOSTS: &[&str] = &["data.rainviewer.com", "tilecache.rainviewer.com"];
pub const ATTRIBUTION: &str = "RainViewer";
pub const LICENSE: &str = "rainviewer.com · personal / non-commercial use";
/// prefix of single-radar source ids (`rv_AU022`)
pub const PREFIX: &str = "rv_";

const SEED: &str = include_str!("rainviewer_sites.tsv");
/// most frames offered per radar (the directories hold about six)
const MAX_FRAMES: usize = 12;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Radar {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub state: String,
    /// ISO 3166 alpha-2
    pub country: String,
    pub country_name: String,
    pub lat: f64,
    pub lon: f64,
    pub range_km: f64,
    /// `map` (georeferenced overlay) or `panel` (agency picture in a floating panel)
    pub display: String,
    /// image extent [w, s, e, n] when known; otherwise a box of `range_km`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<[f64; 4]>,
    /// 0.8.4: another range of this physical site: the id of its main entry
    #[serde(skip_serializing_if = "String::is_empty")]
    pub of: String,
}

/// The bundled site list.
pub fn seed() -> Vec<Radar> {
    SEED.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() < 14 {
                return None;
            }
            let (lat, lon) = (f[5].parse::<f64>().ok()?, f[6].parse::<f64>().ok()?);
            let b: Vec<f64> = f[9..13].iter().filter_map(|x| x.parse().ok()).collect();
            Some(Radar {
                id: f[0].to_string(),
                name: f[1].to_string(),
                state: f[2].to_string(),
                country: f[3].to_string(),
                country_name: f[4].to_string(),
                lat,
                lon,
                range_km: f[7].parse().unwrap_or(250.0),
                display: f[8].to_string(),
                bounds: (b.len() == 4).then(|| [b[0], b[1], b[2], b[3]]),
                of: f[13].trim().to_string(),
            })
        })
        .collect()
}

/// A radar id as used in URLs (letters, digits, `_` `-` `.`; 2–32 chars).
pub fn valid_id(id: &str) -> bool {
    (2..=32).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c)) && !id.starts_with('.')
}

// ---------- directory index ----------

/// Entry of a directory index (nginx autoindex): name (directories end with `/`).
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
}

pub fn index_entries(body: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = vec![];
    for part in body.split("href=\"").skip(1) {
        let Some(href) = part.split('"').next() else { continue };
        if href.is_empty() || href.starts_with('/') || href.starts_with("..") || href.contains("://") || href.contains('?') {
            continue;
        }
        if clean_name(href) && !out.iter().any(|e| e.name == href) {
            out.push(Entry { name: href.to_string() });
        }
    }
    out
}

fn clean_name(n: &str) -> bool {
    let base = n.trim_end_matches('/');
    !base.is_empty() && !base.contains('/') && base != "." && base != ".." && base.chars().all(|c| c.is_ascii_alphanumeric() || "_-.+".contains(c))
}

/// Scan time (ms) in a file name: the `YYYYMMDD_HHMMSS` stamp.
pub fn name_time(name: &str) -> Option<i64> {
    let now = Utc::now().timestamp_millis();
    let runs: Vec<&str> = name.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).collect();
    runs.windows(2).find_map(|w| {
        if w[0].len() != 8 || w[1].len() != 6 {
            return None;
        }
        let t = NaiveDateTime::parse_from_str(&format!("{}{}", w[0], w[1]), "%Y%m%d%H%M%S").ok()?.and_utc().timestamp_millis();
        (t > 946_684_800_000 && t < now + 86_400_000).then_some(t)
    })
}

/// A radar's own picture (`…_0_source.<image>`): volumes and RainViewer's derived products aren't.
pub fn is_source_image(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.contains("_0_source.") && [".png", ".gif", ".jpg", ".jpeg", ".jfif", ".webp"].iter().any(|e| l.ends_with(e))
}

/// Frames of one radar directory (time, file name), oldest first, newest `MAX_FRAMES`.
pub fn frames_of(entries: &[Entry]) -> Vec<(i64, String)> {
    let mut out: Vec<(i64, String)> = entries.iter().filter(|e| is_source_image(&e.name)).filter_map(|e| Some((name_time(&e.name)?, e.name.clone()))).collect();
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out.dedup_by(|a, b| a.0 == b.0);
    if out.len() > MAX_FRAMES {
        out.drain(..out.len() - MAX_FRAMES);
    }
    out
}

/// Image extent: the known one, else a box of the radar's range around it (BoM images are exactly that).
pub fn radar_bounds(r: &Radar) -> ([f64; 4], bool) {
    match r.bounds {
        Some(b) => (b, false),
        None => (crate::intlradar::site_bounds(r.lat, r.lon, r.range_km), true),
    }
}

/// An `IntlRadar` source (kind "image") for one radar and its frames.
pub fn source_json(r: &Radar, frames: &[(i64, String)], ranges: &[String]) -> Value {
    let (b, approx) = radar_bounds(r);
    let dir = format!("{DATA_BASE}{}/", r.id);
    let fr: Vec<Value> = frames.iter().map(|(t, f)| json!({"t": t, "url": crate::intlradar::proxied(&format!("{dir}{f}"))})).collect();
    let step = if frames.len() >= 2 { ((frames[frames.len() - 1].0 - frames[0].0) / 60_000 / (frames.len() as i64 - 1)).clamp(2, 60) } else { 10 };
    let place = if r.name.is_empty() { r.id.clone() } else { format!("{}{}", r.name, if r.state.is_empty() { String::new() } else { format!(" {}", r.state) }) };
    json!({
        "id": format!("{PREFIX}{}", r.id),
        "name": format!("{} radar {place} ({})", r.country_name, r.id),
        "region": region_of(&r.country), "country": r.country, "kind": "image", "crs": "EPSG:4326",
        "site": {"id": r.id, "name": if r.name.is_empty() { &r.id } else { &r.name }, "province": r.state, "lat": r.lat, "lon": r.lon, "range_km": r.range_km},
        "attribution": ATTRIBUTION, "license_note": LICENSE,
        "minzoom": 3, "maxzoom": 11, "bounds": b, "approx_bounds": approx, "step_min": step,
        "frames": fr, "provider": "rainviewer", "display": r.display, "ranges": ranges,
    })
}

/// Layer-picker region of a country code (same grouping as the site filter in `rvcore.ts`).
pub fn region_of(cc: &str) -> &'static str {
    match cc {
        "AU" | "NZ" | "FJ" | "TO" | "MH" => "Oceania",
        "JP" => "Japan",
        "BR" | "AR" | "CO" | "CL" | "PE" | "VE" | "UY" | "BO" | "EC" => "South America",
        "MX" => "Mexico",
        "BB" | "BM" | "CW" | "DO" | "JM" | "KY" | "NI" | "PA" | "SV" | "CU" => "Central America",
        "ZA" | "MU" | "EG" | "MA" | "NG" | "KE" => "Africa",
        "ES" | "PT" | "FR" | "GR" | "RS" | "SK" | "IT" | "DE" | "GB" | "CH" | "HR" | "BG" | "RU" | "BY" | "UA" => "Europe",
        _ => "Asia",
    }
}

/// BoM images (`AU…`) carry a white banner and a text line on the radar's own raster: blank them
/// so the picture overlays cleanly. Anything that isn't a BoM PNG comes back unchanged (`None`).
pub fn clean_image(url: &str, bytes: &[u8]) -> Option<Vec<u8>> {
    let id = url.strip_prefix(DATA_BASE)?.split('/').next()?;
    if !id.starts_with("AU") || !url.to_ascii_lowercase().ends_with(".png") {
        return None;
    }
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::normalize_to_color8() | png::Transformations::ALPHA);
    let mut rd = dec.read_info().ok()?;
    let mut buf = vec![0; rd.output_buffer_size()?];
    let info = rd.next_frame(&mut buf).ok()?;
    // BoM publishes both palette (→ RGBA here) and grey + alpha images
    let (color, bpp) = match info.color_type {
        png::ColorType::Rgba => (png::ColorType::Rgba, 4),
        png::ColorType::GrayscaleAlpha => (png::ColorType::GrayscaleAlpha, 2),
        _ => return None,
    };
    if info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let (w, h) = (info.width as usize, info.height as usize);
    buf.truncate(info.buffer_size());
    for (y, row) in buf.chunks_mut(w * bpp).enumerate() {
        if y < 16 || y + 16 >= h {
            row.fill(0);
        }
    }
    let mut out = vec![];
    {
        let mut e = png::Encoder::new(&mut out, w as u32, h as u32);
        e.set_color(color);
        e.set_depth(png::BitDepth::Eight);
        e.write_header().ok()?.write_image_data(&buf).ok()?;
    }
    Some(out)
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

pub struct RainViewer {
    http: reqwest::Client,
    seed: Vec<Radar>,
}

impl RainViewer {
    pub fn new(http: reqwest::Client) -> Arc<Self> {
        Arc::new(Self { http, seed: seed() })
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

    /// Every range of a physical site, main entry first (empty when it has only one).
    fn ranges_of(&self, r: &Radar) -> Vec<String> {
        let main = if r.of.is_empty() { &r.id } else { &r.of };
        let mut v: Vec<String> = std::iter::once(main.clone()).chain(self.seed.iter().filter(|x| x.of == *main).map(|x| x.id.clone())).collect();
        if v.len() < 2 {
            v.clear();
        }
        v
    }

    /// `GET /api/rainviewer/radars`: one entry per physical site, from the bundled list (nothing is
    /// fetched; empty when the data source is off).
    pub fn radars(&self) -> Value {
        let on = crate::datasources::enabled("rainviewer");
        let out: Vec<Value> = self
            .seed
            .iter()
            .filter(|r| on && r.of.is_empty() && r.display != "data")
            .map(|r| {
                let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
                v["source"] = json!(format!("{PREFIX}{}", r.id));
                v["ranges"] = json!(self.ranges_of(r));
                v
            })
            .collect();
        json!({"radars": out, "attribution": ATTRIBUTION, "license_note": LICENSE})
    }

    /// One radar as an `IntlRadar` source (`rv_<id>`), with its recent frames.
    pub async fn source(&self, sid: &str) -> Result<Value> {
        let id = sid.strip_prefix(PREFIX).ok_or_else(|| anyhow!("not a RainViewer radar"))?;
        if !valid_id(id) {
            bail!("bad radar id (not found)");
        }
        let r = self.seed.iter().find(|r| r.id.eq_ignore_ascii_case(id)).ok_or_else(|| anyhow!("{id}: unknown radar (not found)"))?;
        let frames = frames_of(&index_entries(&self.text(&format!("{DATA_BASE}{}/", r.id)).await?));
        if frames.is_empty() {
            bail!("no images published right now");
        }
        Ok(source_json(r, &frames, &self.ranges_of(r)))
    }

    /// Composite + satellite sources from weather-maps.json (cached by the caller ≥ 3 min).
    pub async fn composite(&self) -> Result<Value> {
        let t = self.text(MAPS_JSON).await?;
        let v: Value = serde_json::from_str(&t)?;
        Ok(Value::Array(composite_sources(&v)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // real listing of data.rainviewer.com/images/AU022/
    const DIR_HTML: &str = include_str!("rainviewer_fixtures/index_radar.html");
    const MAPS: &str = include_str!("rainviewer_fixtures/weather-maps.json");

    #[test]
    fn site_list() {
        let s = seed();
        assert!(s.len() > 400, "{}", s.len());
        let mel = s.iter().find(|r| r.id == "AU022").unwrap();
        assert_eq!((mel.name.as_str(), mel.country.as_str(), mel.range_km, mel.display.as_str()), ("Melbourne (Laverton)", "AU", 256.0, "map"));
        assert!((mel.lat + 37.85).abs() < 0.02 && mel.bounds.is_none());
        let id = s.iter().find(|r| r.id == "IDAC3").unwrap();
        assert_eq!(id.display, "map");
        assert!(id.bounds.unwrap()[0] < id.lon && id.lon < id.bounds.unwrap()[2], "bbox is [w, s, e, n]");
        // pictures with their own basemap stay off the map
        assert_eq!(s.iter().find(|r| r.id == "CN9002B").unwrap().display, "data");
        assert_eq!(s.iter().find(|r| r.id == "CN9023B").unwrap().display, "panel", "no measured position yet");
        // Canada has Stormiq's own ECCC radars; dead directories of the old database are gone
        assert!(!s.iter().any(|r| r.country == "CA" || r.id == "AU02"));
        // a variant always points at a main entry that exists and is at the same place
        for v in s.iter().filter(|r| !r.of.is_empty()) {
            let m = s.iter().find(|r| r.id == v.of).unwrap_or_else(|| panic!("{} -> {}", v.id, v.of));
            assert!(m.of.is_empty() && km(m.lat, m.lon, v.lat, v.lon) < 26.0, "{}", v.id);
        }
        assert!(s.iter().all(|r| ["map", "panel", "data"].contains(&r.display.as_str())));
        assert!(!s.iter().any(|r| r.id == "GRCOMP3"), "Greece's entry is a composite: not listed");
        assert_eq!(s.iter().map(|r| &r.id).collect::<std::collections::HashSet<_>>().len(), s.len());
    }

    fn km(a: f64, b: f64, c: f64, d: f64) -> f64 {
        let x = (d - b).to_radians() * ((a + c) / 2.0).to_radians().cos();
        (x * x + (c - a).to_radians().powi(2)).sqrt() * 6371.0
    }

    /// Shipped sites near a radar Stormiq already serves are mistakes unless explained here.
    /// The OPERA rows named below are in OPERA's site list but not in its open bucket.
    const NOT_DUPLICATES: &[(&str, &str)] = &[
        ("ESAM2", "esalm: not in the OPERA bucket"), ("ESAM3", "esalm: not in the OPERA bucket"),
        ("ESCO2", "escor: not in the OPERA bucket"), ("ESCO3", "escor: not in the OPERA bucket"),
        ("ESMU2", "esmur: not in the OPERA bucket"), ("ESMU3", "esmur: not in the OPERA bucket"),
        ("ESPM2", "espma: not in the OPERA bucket"), ("ESPM3", "espma: not in the OPERA bucket"),
        ("ESSA2", "essan: not in the OPERA bucket"), ("ESSA3", "essan: not in the OPERA bucket"),
        ("ESVA2", "esval: not in the OPERA bucket"), ("ESVA3", "esval: not in the OPERA bucket"),
        ("PTFAR", "ptfar: not in the OPERA bucket"), ("PTLIS", "ptlis: not in the OPERA bucket"), ("PTPRT", "ptprt: not in the OPERA bucket"), ("PTPST", "ptpst: not in the OPERA bucket"),
        ("RSCOMP", "national composite, sited on a Serbian radar OPERA doesn't carry"),
        ("ILBG2C", "iltlv: not in the OPERA bucket"), ("ILBG2G", "iltlv: not in the OPERA bucket"),
        ("KRKSN2", "KMA's own Gunsan radar, 17 km from the US radar at Kunsan AB"),
    ];

    #[test]
    fn no_duplicates_of_stormiq_radars() {
        let mut existing: Vec<(String, f64, f64)> = vec![];
        for s in crate::sites::embedded() {
            existing.push((s.id, s.lat, s.lon));
        }
        for e in crate::intlradar::ECCC_SITES {
            existing.push((e.0.to_string(), e.3, e.4));
        }
        let t: Value = serde_json::from_str(include_str!("radar/odim_sites.json")).unwrap();
        for o in t["sites"].as_array().unwrap() {
            if o["status"] == 1 && o.get("rv").is_none() {
                existing.push((o["id"].as_str().unwrap().to_string(), o["lat"].as_f64().unwrap(), o["lon"].as_f64().unwrap()));
            }
        }
        assert!(existing.len() > 400);
        let mut bad = vec![];
        for r in seed() {
            if NOT_DUPLICATES.iter().any(|(id, _)| *id == r.id) {
                continue;
            }
            if let Some((id, _, _)) = existing.iter().find(|(_, la, lo)| km(r.lat, r.lon, *la, *lo) < 8.0) {
                bad.push(format!("{} near {id}", r.id));
            }
        }
        assert!(bad.is_empty(), "{bad:?}");
        // national layers / SMN radars that RainViewer also republishes stay out
        for id in ["JPCOMP", "TWCOMP3", "PHCOMP7", "MXCA6", "MXCC3", "MXLC6", "MXSA2", "SKKH", "ESBA2"] {
            assert!(!seed().iter().any(|r| r.id == id), "{id}");
        }
    }

    #[test]
    fn radar_dir_frames() {
        let e = index_entries(DIR_HTML);
        let f = frames_of(&e);
        assert_eq!(f.len(), 7, "{f:?}");
        assert!(f.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(f[0].1, "AU022_20261109_004400_0_source.png");
        assert_eq!(f[0].0, name_time("AU022_20261109_004400_0_source.png").unwrap());
        // volumes, derived products and the stale JSON aren't frames
        for n in ["X_20261109_004400_0_source.h5", "X_20261109_004400_0_source.bufr.gz", "X_20261109_004400_2_map.png", "0_products.json"] {
            assert!(!is_source_image(n), "{n}");
        }
        for n in ["BH02_20261108_234000_0_source.jfif", "X_20261108_234000_0_source.jpeg", "X_20261108_234000_0_source.webp"] {
            assert!(is_source_image(n), "{n}");
        }
    }

    #[test]
    fn frame_times() {
        // digits in the id don't confuse the stamp
        assert_eq!(name_time("CN9023B_20261108_234000_0_source.png"), name_time("X_20261108_234000_0_source.png"));
        assert_eq!(name_time("0_products.json"), None);
        let many: Vec<Entry> = (0..20).map(|i| Entry { name: format!("A_20261108_12{i:02}00_0_source.png") }).collect();
        let f = frames_of(&many);
        assert_eq!(f.len(), MAX_FRAMES);
        assert!(f[MAX_FRAMES - 1].1.contains("_121900_"), "newest kept");
    }

    #[test]
    fn source_and_composite() {
        let r = seed().into_iter().find(|r| r.id == "AU022").unwrap();
        let v = source_json(&r, &[(1_794_111_600_000, "a_20261108_120000_0_source.png".into()), (1_794_112_200_000, "a_20261108_121000_0_source.png".into())], &[]);
        assert_eq!(v["id"], "rv_AU022");
        assert_eq!(v["display"], "map");
        assert_eq!(v["region"], "Oceania");
        assert_eq!(v["step_min"], 10);
        let b = v["bounds"].as_array().unwrap();
        assert!(((b[3].as_f64().unwrap() - b[1].as_f64().unwrap()) * 111.2 / 2.0 - 256.0).abs() < 1.0, "256 km box");
        assert!(v["frames"][0]["url"].as_str().unwrap().starts_with("/api/intlradar/img?u=https%3A%2F%2Fdata.rainviewer.com%2Fimages%2FAU022%2F"));
        assert!(HOSTS.iter().all(|h| crate::intlradar::allowed(&format!("https://{h}/x"))));
        // a radar without a name still gets one
        let cn = seed().into_iter().find(|r| r.id == "CN9023B").unwrap();
        assert_eq!(source_json(&cn, &[], &[])["name"], "China radar Arxan (CN9023B)");
        let maps: Value = serde_json::from_str(MAPS).unwrap();
        let c = composite_sources(&maps).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0]["id"], "rainviewer");
        assert_eq!(c[0]["frames"].as_array().unwrap().len(), 4, "past + nowcast");
        assert!(c[0]["frames"][0]["url"].as_str().unwrap().ends_with("%2F256%2F{z}%2F{x}%2F{y}%2F2%2F1_1.png"));
        assert_eq!(c[1]["id"], "rainviewer_ir");
        assert!(composite_sources(&json!({"host": "https://evil.example", "radar": {"past": [{"time": 1, "path": "/v2/radar/1"}]}})).is_err());
    }

    #[test]
    fn bom_banner_is_blanked() {
        // a 40-row image with opaque pixels everywhere
        let (w, h) = (4usize, 40usize);
        let mut png_bytes = vec![];
        {
            let mut e = png::Encoder::new(&mut png_bytes, w as u32, h as u32);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().unwrap().write_image_data(&vec![200u8; w * h * 4]).unwrap();
        }
        let url = format!("{DATA_BASE}AU022/AU022_20261109_004400_0_source.png");
        let out = clean_image(&url, &png_bytes).expect("BoM png is rewritten");
        let mut rd = png::Decoder::new(std::io::Cursor::new(out)).read_info().unwrap();
        let mut buf = vec![0; rd.output_buffer_size().unwrap()];
        rd.next_frame(&mut buf).unwrap();
        let alpha = |y: usize| buf[y * w * 4 + 3];
        assert_eq!((alpha(0), alpha(15), alpha(16), alpha(23), alpha(24), alpha(39)), (0, 0, 200, 200, 0, 0));
        assert!(clean_image(&format!("{DATA_BASE}BRBE/x_0_source.png"), &png_bytes).is_none(), "other agencies untouched");
    }

    #[test]
    fn bom_banner_on_real_frames() {
        // a palette frame and a grey + alpha frame from the real tree
        for (name, bytes) in [("AU022", &include_bytes!("rainviewer_fixtures/au_palette.png")[..]), ("AU152", &include_bytes!("rainviewer_fixtures/au_grey.png")[..])] {
            let url = format!("{DATA_BASE}{name}/{name}_20261109_004400_0_source.png");
            let out = clean_image(&url, bytes).unwrap_or_else(|| panic!("{name} is rewritten"));
            let mut dec = png::Decoder::new(std::io::Cursor::new(out));
            dec.set_transformations(png::Transformations::normalize_to_color8() | png::Transformations::ALPHA);
            let mut rd = dec.read_info().unwrap();
            let mut buf = vec![0; rd.output_buffer_size().unwrap()];
            let i = rd.next_frame(&mut buf).unwrap();
            assert_eq!((i.width, i.height), (512, 512), "{name}");
            let bpp = i.line_size / i.width as usize;
            let row_alpha = |y: usize| (0..512).filter(|x| buf[y * i.line_size + x * bpp + bpp - 1] > 16).count();
            for y in [0, 15, 496, 511] {
                assert_eq!(row_alpha(y), 0, "{name} row {y} still drawn");
            }
        }
    }
}
