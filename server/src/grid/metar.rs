//! METAR observations and Barnes-interpolated surface analyses.

use super::{Grid, Proj};
use anyhow::{bail, Result};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, Serialize)]
pub struct Obs {
    pub id: String,
    pub lat: f32,
    pub lon: f32,
    pub time: i64,
    pub temp: f32,
    pub dew: f32,
    pub wdir: f32,
    pub wspd: f32,
    pub gust: f32,
    pub vis: f32,
    pub alt: f32,
    pub slp: f32,
    pub cat: String,
    pub raw: String,
}

fn num(s: Option<&&str>) -> f32 {
    s.and_then(|v| v.trim().trim_end_matches('+').parse::<f32>().ok()).unwrap_or(f32::NAN)
}

/// Parse aviationweather.gov metars.cache.csv(.gz)
pub fn parse_csv(bytes: &[u8]) -> Result<Vec<Obs>> {
    let text = if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut s = String::new();
        flate2::read::MultiGzDecoder::new(bytes).read_to_string(&mut s)?;
        s
    } else {
        String::from_utf8_lossy(bytes).to_string()
    };
    let mut lines = text.lines();
    let header = loop {
        match lines.next() {
            Some(l) if l.starts_with("raw_text") => break l,
            Some(_) => continue,
            None => bail!("no CSV header"),
        }
    };
    let cols: HashMap<&str, usize> = header.split(',').enumerate().map(|(i, c)| (c.trim(), i)).collect();
    let c = |n: &str| cols.get(n).copied();
    let (Some(ci), Some(clat), Some(clon)) = (c("station_id"), c("latitude"), c("longitude")) else { bail!("missing columns") };
    let mut out: HashMap<String, Obs> = HashMap::new();
    for l in lines {
        let f: Vec<&str> = l.split(',').collect();
        let g = |k: Option<usize>| k.and_then(|i| f.get(i));
        let lat = num(f.get(clat));
        let lon = num(f.get(clon));
        if !lat.is_finite() || !lon.is_finite() {
            continue;
        }
        let time = g(c("observation_time"))
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        let o = Obs {
            id: f.get(ci).unwrap_or(&"").to_string(),
            lat,
            lon,
            time,
            temp: num(g(c("temp_c")).as_ref().map(|s| *s)),
            dew: num(g(c("dewpoint_c")).as_ref().map(|s| *s)),
            wdir: num(g(c("wind_dir_degrees")).as_ref().map(|s| *s)),
            wspd: num(g(c("wind_speed_kt")).as_ref().map(|s| *s)) * 0.514444,
            gust: num(g(c("wind_gust_kt")).as_ref().map(|s| *s)) * 0.514444,
            vis: num(g(c("visibility_statute_mi")).as_ref().map(|s| *s)) * 1.609344,
            alt: num(g(c("altim_in_hg")).as_ref().map(|s| *s)) * 33.8639,
            slp: num(g(c("sea_level_pressure_mb")).as_ref().map(|s| *s)),
            cat: g(c("flight_category")).map(|s| s.to_string()).unwrap_or_default(),
            raw: f.first().unwrap_or(&"").to_string(),
        };
        match out.get(&o.id) {
            Some(prev) if prev.time >= o.time => {}
            _ => {
                out.insert(o.id.clone(), o);
            }
        }
    }
    Ok(out.into_values().collect())
}

fn rh(t: f32, td: f32) -> f32 {
    let es = |x: f32| (17.625 * x / (243.04 + x)).exp();
    (100.0 * es(td) / es(t)).clamp(0.0, 100.0)
}

/// Apparent temperature (°C): heat index when warm/humid, wind chill when cold/windy.
fn feels(t: f32, td: f32, wind_ms: f32) -> f32 {
    let tf = t * 9.0 / 5.0 + 32.0;
    let mph = wind_ms * 2.236936;
    let f = if tf >= 80.0 {
        let r = rh(t, td);
        -42.379 + 2.04901523 * tf + 10.14333127 * r - 0.22475541 * tf * r - 0.00683783 * tf * tf - 0.05481717 * r * r + 0.00122874 * tf * tf * r + 0.00085282 * tf * r * r
            - 0.00000199 * tf * tf * r * r
    } else if tf <= 50.0 && mph > 3.0 {
        35.74 + 0.6215 * tf - 35.75 * mph.powf(0.16) + 0.4275 * tf * mph.powf(0.16)
    } else {
        tf
    };
    (f - 32.0) * 5.0 / 9.0
}

pub const FIELDS: [&str; 9] = ["temp", "dew", "rh", "wind", "gust", "pres", "vis", "feels", "spread"];

pub fn field_value(o: &Obs, field: &str) -> f32 {
    match field {
        "temp" => o.temp,
        "dew" => o.dew,
        "rh" => {
            if o.temp.is_finite() && o.dew.is_finite() {
                rh(o.temp, o.dew)
            } else {
                f32::NAN
            }
        }
        "wind" => o.wspd,
        "gust" => {
            if o.gust.is_finite() {
                o.gust
            } else {
                o.wspd
            }
        }
        "pres" => {
            if o.slp.is_finite() {
                o.slp
            } else {
                o.alt
            }
        }
        "vis" => o.vis.min(16.1),
        "feels" => {
            if o.temp.is_finite() && o.dew.is_finite() {
                feels(o.temp, o.dew, o.wspd.max(0.0))
            } else {
                o.temp
            }
        }
        "spread" => o.temp - o.dew,
        _ => f32::NAN,
    }
}

const RES: f64 = 0.1;
const RADIUS_DEG: f64 = 1.6;

/// Two-pass Barnes analysis on a global 0.1° grid (cells far from any station stay empty).
pub fn analyze(obs: &[Obs], field: &str, time: i64) -> Grid {
    let pts: Vec<(f64, f64, f32)> = obs
        .iter()
        .filter_map(|o| {
            let v = field_value(o, field);
            if v.is_finite() && (-90.0..=90.0).contains(&o.lat) {
                Some((o.lat as f64, o.lon as f64, v))
            } else {
                None
            }
        })
        .collect();
    let nx = (360.0 / RES) as usize;
    let lat_n = 75.0;
    let lat_s = -60.0;
    let ny = ((lat_n - lat_s) / RES) as usize;
    let proj = Proj::LatLon { lat0: lat_n - RES / 2.0, lon0: -180.0 + RES / 2.0, dlat: -RES, dlon: RES, nx, global: true };
    let k0 = (0.6f64).powi(2); // weight length scale (deg²)
    let pass = |values: &[(f64, f64, f32)], k: f64| -> (Vec<f32>, Vec<f32>) {
        let mut wsum = vec![0f32; nx * ny];
        let mut vsum = vec![0f32; nx * ny];
        let r_cells = (RADIUS_DEG / RES).ceil() as isize;
        for &(lat, lon, v) in values {
            let cj = ((lat_n - lat) / RES) as isize;
            let ci = ((lon + 180.0) / RES) as isize;
            let coslat = lat.to_radians().cos().max(0.2);
            let ri = (r_cells as f64 / coslat).ceil() as isize;
            for dj in -r_cells..=r_cells {
                let j = cj + dj;
                if j < 0 || j >= ny as isize {
                    continue;
                }
                let glat = lat_n - (j as f64 + 0.5) * RES;
                for di in -ri..=ri {
                    let i = (ci + di).rem_euclid(nx as isize);
                    let glon = -180.0 + (i as f64 + 0.5) * RES;
                    let mut dlon = glon - lon;
                    if dlon > 180.0 {
                        dlon -= 360.0;
                    }
                    if dlon < -180.0 {
                        dlon += 360.0;
                    }
                    let d2 = (glat - lat).powi(2) + (dlon * coslat).powi(2);
                    if d2 > RADIUS_DEG * RADIUS_DEG {
                        continue;
                    }
                    let w = (-d2 / k).exp() as f32;
                    let idx = j as usize * nx + i as usize;
                    wsum[idx] += w;
                    vsum[idx] += w * v;
                }
            }
        }
        (wsum, vsum)
    };
    let (w1, v1) = pass(&pts, k0);
    let first: Vec<f32> = w1.par_iter().zip(&v1).map(|(&w, &v)| if w > 0.005 { v / w } else { f32::NAN }).collect();
    // residuals at stations (nearest cell)
    let at = |lat: f64, lon: f64| -> f32 {
        let j = ((lat_n - lat) / RES) as isize;
        let i = (((lon + 180.0) / RES) as isize).rem_euclid(nx as isize);
        if j < 0 || j >= ny as isize {
            return f32::NAN;
        }
        first[j as usize * nx + i as usize]
    };
    let resid: Vec<(f64, f64, f32)> = pts
        .iter()
        .filter_map(|&(la, lo, v)| {
            let a = at(la, lo);
            if a.is_finite() {
                Some((la, lo, v - a))
            } else {
                None
            }
        })
        .collect();
    let (w2, v2) = pass(&resid, k0 * 0.35);
    let vals: Vec<f32> = (0..nx * ny)
        .into_par_iter()
        .map(|i| {
            let a = first[i];
            if !a.is_finite() {
                return f32::NAN;
            }
            if w2[i] > 1e-3 {
                a + v2[i] / w2[i]
            } else {
                a
            }
        })
        .collect();
    Grid::from_values(nx, ny, proj, &vals, time, time)
}

// ---------- raw METAR text ----------

/// Values decoded from a raw METAR / SPECI report (NaN when absent).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawMetar {
    pub temp: f32,
    pub dew: f32,
    pub wdir: f32,
    /// m/s
    pub wspd: f32,
    pub gust: f32,
    /// km
    pub vis: f32,
    /// hPa
    pub alt: f32,
    /// lowest BKN/OVC/VV layer, ft (NaN = none)
    pub ceiling_ft: f32,
}

fn temp_group(s: &str) -> f32 {
    let (neg, d) = match s.strip_prefix('M') {
        Some(r) => (true, r),
        None => (false, s),
    };
    if d.len() != 2 || !d.chars().all(|c| c.is_ascii_digit()) {
        return f32::NAN;
    }
    let v: f32 = d.parse().unwrap_or(f32::NAN);
    if neg { -v } else { v }
}

/// Decode the main body of a METAR (wind, visibility, sky, temperature, pressure).
pub fn decode_raw(raw: &str) -> RawMetar {
    let mut m = RawMetar { temp: f32::NAN, dew: f32::NAN, wdir: f32::NAN, wspd: f32::NAN, gust: f32::NAN, vis: f32::NAN, alt: f32::NAN, ceiling_ft: f32::NAN };
    let toks: Vec<&str> = raw.split_whitespace().collect();
    let mut i = 0;
    let mut whole_mi: Option<f32> = None;
    while i < toks.len() {
        let t = toks[i];
        if t == "RMK" || t == "TEMPO" || t == "BECMG" || t == "NOSIG" {
            break;
        }
        // wind dddff(f)(Gff)KT|MPS|KMH
        let unit = [("KT", 0.514444f32), ("MPS", 1.0), ("KMH", 1.0 / 3.6)].into_iter().find(|(u, _)| t.ends_with(u) && t.len() >= 5 + u.len());
        if let (Some((u, k)), true) = (unit, m.wspd.is_nan()) {
            let body = &t[..t.len() - u.len()];
            let (main, gust) = match body.split_once('G') {
                Some((a, g)) => (a, g.parse::<f32>().ok()),
                None => (body, None),
            };
            if main.len() >= 5 && main[3..].chars().all(|c| c.is_ascii_digit()) {
                if let Ok(s) = main[3..].parse::<f32>() {
                    m.wspd = s * k;
                    m.wdir = main[..3].parse::<f32>().unwrap_or(f32::NAN);
                    m.gust = gust.map(|g| g * k).unwrap_or(f32::NAN);
                    i += 1;
                    continue;
                }
            }
        }
        // visibility: 10SM, 1/2SM, "1 1/2SM", P6SM, M1/4SM, or 4-digit metres
        if let Some(v) = t.strip_suffix("SM") {
            let v = v.trim_start_matches(['P', 'M']);
            let mi = match v.split_once('/') {
                Some((a, b)) => a.parse::<f32>().ok().zip(b.parse::<f32>().ok()).map(|(a, b)| a / b),
                None => v.parse::<f32>().ok(),
            };
            if let Some(mi) = mi {
                m.vis = (mi + whole_mi.take().unwrap_or(0.0)) * 1.609344;
            }
            i += 1;
            continue;
        }
        if t.len() == 1 && t.chars().all(|c| c.is_ascii_digit()) && toks.get(i + 1).map(|n| n.ends_with("SM") && n.contains('/')).unwrap_or(false) {
            whole_mi = t.parse().ok();
            i += 1;
            continue;
        }
        if t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()) && m.vis.is_nan() && i > 1 {
            let metres: f32 = t.parse().unwrap_or(f32::NAN);
            m.vis = if metres >= 9999.0 { 10.0 } else { metres / 1000.0 };
            i += 1;
            continue;
        }
        if t == "CAVOK" {
            m.vis = 10.0;
        }
        // sky: BKN015 OVC100 VV002
        for p in ["BKN", "OVC", "VV"] {
            if let Some(h) = t.strip_prefix(p) {
                if let Ok(h) = h.get(..3).unwrap_or("").parse::<f32>() {
                    let ft = h * 100.0;
                    if m.ceiling_ft.is_nan() || ft < m.ceiling_ft {
                        m.ceiling_ft = ft;
                    }
                }
            }
        }
        // temperature / dew point: 12/08, M02/M05, 12/
        if let Some((a, b)) = t.split_once('/') {
            if !t.ends_with("SM") && (a.len() == 2 || a.len() == 3) && b.len() <= 3 && !a.is_empty() && a.trim_start_matches('M').chars().all(|c| c.is_ascii_digit()) {
                let ta = temp_group(a);
                if ta.is_finite() {
                    m.temp = ta;
                    m.dew = temp_group(b);
                }
            }
        }
        // pressure: A2992 (inHg) or Q1013 (hPa)
        if t.len() == 5 && t[1..].chars().all(|c| c.is_ascii_digit()) {
            let v: f32 = t[1..].parse().unwrap_or(f32::NAN);
            if t.starts_with('A') {
                m.alt = v / 100.0 * 33.8639;
            } else if t.starts_with('Q') {
                m.alt = v;
            }
        }
        i += 1;
    }
    m
}

/// FAA flight category from visibility (km) and ceiling (ft).
pub fn flight_category(vis_km: f32, ceiling_ft: f32) -> &'static str {
    let mi = vis_km / 1.609344;
    let c = if ceiling_ft.is_finite() { ceiling_ft } else { f32::INFINITY };
    let v = if mi.is_finite() { mi } else { f32::INFINITY };
    if c < 500.0 || v < 1.0 {
        "LIFR"
    } else if c < 1000.0 || v < 3.0 {
        "IFR"
    } else if c <= 3000.0 || v <= 5.0 {
        "MVFR"
    } else if vis_km.is_finite() || ceiling_ft.is_finite() {
        "VFR"
    } else {
        ""
    }
}

// ---------- archived METARs (Iowa Environmental Mesonet) ----------

/// Data columns requested from IEM asos.py.
const IEM_FIELDS: [&str; 15] = ["tmpf", "dwpf", "drct", "sknt", "gust", "vsby", "alti", "mslp", "skyc1", "skyc2", "skyc3", "skyl1", "skyl2", "skyl3", "metar"];

/// IEM asos.py request for every station's routine + special reports in (t - 60 min, t].
pub fn iem_url(base: &str, t: i64) -> String {
    let fmt = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%dT%H:%M:00Z").to_string()).unwrap_or_default();
    let data: String = IEM_FIELDS.iter().map(|f| format!("data={f}&")).collect();
    format!(
        "{base}?{data}tz=Etc%2FUTC&format=onlycomma&latlon=yes&elev=no&missing=M&trace=T&direct=no&report_type=3&report_type=4&sts={}&ets={}",
        fmt(t - 59 * 60_000),
        fmt(t + 60_000)
    )
}

/// Parse IEM asos.py `onlycomma` output (station,valid,lon,lat,<fields>…); newest report per
/// station wins. Missing values ("M") fall back to the decoded raw METAR.
pub fn parse_iem(text: &str) -> Result<Vec<Obs>> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#'));
    let header = lines.next().ok_or_else(|| anyhow::anyhow!("empty archive response"))?;
    if !header.starts_with("station,") {
        bail!("unexpected archive response: {}", header.chars().take(120).collect::<String>());
    }
    let cols: HashMap<&str, usize> = header.split(',').enumerate().map(|(i, c)| (c.trim(), i)).collect();
    let c = |n: &str| cols.get(n).copied();
    let (Some(cst), Some(cv), Some(clat), Some(clon)) = (c("station"), c("valid"), c("lat"), c("lon")) else { bail!("archive columns missing") };
    let cm = c("metar");
    let mut out: HashMap<String, Obs> = HashMap::new();
    for l in lines {
        // the raw METAR is the last column and never contains commas
        let f: Vec<&str> = l.split(',').collect();
        let g = |n: &str| c(n).and_then(|i| f.get(i)).map(|s| s.trim()).filter(|s| !s.is_empty() && *s != "M");
        let n = |n: &str| g(n).and_then(|s| s.parse::<f32>().ok()).unwrap_or(f32::NAN);
        let lat = num(f.get(clat));
        let lon = num(f.get(clon));
        if !lat.is_finite() || !lon.is_finite() {
            continue;
        }
        let Some(time) = f.get(cv).and_then(|s| chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M").ok()).map(|d| d.and_utc().timestamp_millis()) else { continue };
        let raw = cm.and_then(|i| f.get(i)).map(|s| s.trim()).filter(|s| *s != "M").unwrap_or("").to_string();
        let r = decode_raw(&raw);
        // ICAO id from the report itself (IEM drops the K of US sites)
        let id = raw
            .split_whitespace()
            .find(|w| *w != "METAR" && *w != "SPECI" && *w != "COR")
            .filter(|w| w.len() == 4 && w.chars().all(|c| c.is_ascii_alphanumeric()))
            .map(|s| s.to_string())
            .unwrap_or_else(|| f.get(cst).unwrap_or(&"").trim().to_string());
        if id.is_empty() {
            continue;
        }
        let pick = |a: f32, b: f32| if a.is_finite() { a } else { b };
        let f2c = |v: f32| (v - 32.0) * 5.0 / 9.0;
        let kt = 0.514444;
        // ceiling from IEM sky layers, else the report
        let mut ceil = f32::NAN;
        for k in 1..=3 {
            if let (Some(cov), Some(h)) = (g(&format!("skyc{k}")), g(&format!("skyl{k}")).and_then(|s| s.parse::<f32>().ok())) {
                if matches!(cov, "BKN" | "OVC" | "VV") && (ceil.is_nan() || h < ceil) {
                    ceil = h;
                }
            }
        }
        let ceil = pick(ceil, r.ceiling_ft);
        let vis = pick(n("vsby") * 1.609344, r.vis);
        let o = Obs {
            id: id.clone(),
            lat,
            lon,
            time,
            temp: pick(f2c(n("tmpf")), r.temp),
            dew: pick(f2c(n("dwpf")), r.dew),
            wdir: pick(n("drct"), r.wdir),
            wspd: pick(n("sknt") * kt, r.wspd),
            gust: pick(n("gust") * kt, r.gust),
            vis,
            alt: pick(n("alti") * 33.8639, r.alt),
            slp: n("mslp"),
            cat: flight_category(vis, ceil).to_string(),
            raw,
        };
        match out.get(&id) {
            Some(prev) if prev.time > o.time => {}
            _ => {
                out.insert(id, o);
            }
        }
    }
    Ok(out.into_values().collect())
}

/// Archived METAR snapshots: one IEM request per snapshot time, cached in memory and on disk (gz).
pub struct MetarArchive {
    http: reqwest::Client,
    dir: std::path::PathBuf,
    url: parking_lot::RwLock<String>,
    disk_cap: std::sync::atomic::AtomicU64,
    /// snapshot time → (fetched, observations)
    mem: parking_lot::Mutex<lru::LruCache<i64, (std::time::Instant, std::sync::Arc<Vec<Obs>>)>>,
    /// IEM allows ~1 request/s per address
    gate: tokio::sync::Mutex<Option<std::time::Instant>>,
    inflight: parking_lot::Mutex<HashMap<i64, std::sync::Arc<tokio::sync::Mutex<()>>>>,
}

/// Snapshots newer than this may still gain late reports: keep them only briefly in memory.
const SETTLE_MS: i64 = 90 * 60_000;

impl MetarArchive {
    pub fn new(http: reqwest::Client, data_dir: &std::path::Path) -> Self {
        let dir = data_dir.join("cache/metar_archive");
        std::fs::create_dir_all(&dir).ok();
        Self {
            http,
            dir,
            url: parking_lot::RwLock::new(crate::config::GridCfg::default().metar_archive_url),
            disk_cap: std::sync::atomic::AtomicU64::new(512 << 20),
            mem: parking_lot::Mutex::new(lru::LruCache::new(std::num::NonZeroUsize::new(24).unwrap())),
            gate: tokio::sync::Mutex::new(None),
            inflight: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    /// Apply `[grid]` settings and the "other" memory share (MB). Safe to call live.
    pub fn configure(&self, cfg: &crate::config::GridCfg, other_mb: usize) {
        if !cfg.metar_archive_url.is_empty() {
            *self.url.write() = cfg.metar_archive_url.clone();
        }
        let disk = if cfg.metar_archive_disk_mb > 0 { cfg.metar_archive_disk_mb } else { 512 };
        self.disk_cap.store(disk << 20, std::sync::atomic::Ordering::Relaxed);
        // ~5 MB per snapshot; half of the "other" share
        let n = (other_mb / 10).clamp(6, 256);
        self.mem.lock().resize(std::num::NonZeroUsize::new(n).unwrap());
    }

    pub fn dir(&self) -> &std::path::Path {
        &self.dir
    }

    pub fn mem_stats(&self) -> (usize, usize, usize) {
        let m = self.mem.lock();
        let bytes = m.iter().map(|(_, (_, v))| v.iter().map(|o| 96 + o.id.len() + o.raw.len() + o.cat.len()).sum::<usize>()).sum();
        (bytes, m.len(), m.cap().get())
    }

    pub fn clear_mem(&self) {
        self.mem.lock().clear();
    }

    fn path(&self, t: i64) -> std::path::PathBuf {
        let d = chrono::DateTime::from_timestamp_millis(t).unwrap_or_default();
        self.dir.join(format!("{}.csv.gz", d.format("%Y%m%d%H%M")))
    }

    /// Every station's latest report in (t - 60 min, t] (t is rounded down to 10 minutes).
    pub async fn snapshot(&self, t: i64) -> Result<(i64, std::sync::Arc<Vec<Obs>>)> {
        let t = t / 600_000 * 600_000;
        let now = chrono::Utc::now().timestamp_millis();
        let settled = now - t > SETTLE_MS;
        if let Some((made, v)) = self.mem.lock().get(&t) {
            if settled || made.elapsed() < std::time::Duration::from_secs(300) {
                return Ok((t, v.clone()));
            }
        }
        let lock = self.inflight.lock().entry(t).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone();
        let _g = lock.lock().await;
        let res = self.load(t, settled).await;
        self.inflight.lock().remove(&t);
        let v = std::sync::Arc::new(res?);
        self.mem.lock().put(t, (std::time::Instant::now(), v.clone()));
        Ok((t, v))
    }

    async fn load(&self, t: i64, settled: bool) -> Result<Vec<Obs>> {
        let path = self.path(t);
        if settled {
            if let Ok(b) = tokio::fs::read(&path).await {
                let parsed = tokio::task::spawn_blocking(move || -> Result<Vec<Obs>> {
                    let mut s = String::new();
                    flate2::read::GzDecoder::new(&b[..]).read_to_string(&mut s)?;
                    parse_iem(&s)
                })
                .await?;
                if let Ok(v) = parsed {
                    return Ok(v);
                }
            }
        }
        let url = iem_url(&self.url.read().clone(), t);
        let text = self.fetch(&url).await.map_err(|e| anyhow::anyhow!("METAR archive unreachable (IEM): {e:#}"))?;
        let obs = parse_iem(&text).map_err(|e| anyhow::anyhow!("METAR archive: {e:#}"))?;
        if settled && !obs.is_empty() {
            let cap = self.disk_cap.load(std::sync::atomic::Ordering::Relaxed);
            let dir = self.dir.clone();
            tokio::task::spawn_blocking(move || {
                use std::io::Write;
                let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                if gz.write_all(text.as_bytes()).is_ok() {
                    if let Ok(b) = gz.finish() {
                        let tmp = path.with_extension("part");
                        if std::fs::write(&tmp, b).is_ok() {
                            let _ = std::fs::rename(&tmp, &path);
                        }
                    }
                }
                evict_oldest(&dir, cap);
            });
        }
        Ok(obs)
    }

    async fn fetch(&self, url: &str) -> Result<String> {
        for attempt in 0..3 {
            {
                let mut g = self.gate.lock().await;
                if let Some(last) = *g {
                    let wait = std::time::Duration::from_millis(1100).saturating_sub(last.elapsed());
                    tokio::time::sleep(wait).await;
                }
                *g = Some(std::time::Instant::now());
            }
            let r = self.http.get(url).timeout(std::time::Duration::from_secs(90)).send().await?;
            let st = r.status();
            if st.as_u16() == 429 || st.as_u16() == 503 {
                tokio::time::sleep(std::time::Duration::from_secs(2 << attempt)).await;
                continue;
            }
            if !st.is_success() {
                bail!("HTTP {st}");
            }
            return Ok(r.text().await?);
        }
        bail!("archive busy (HTTP 429/503), try again shortly")
    }
}

fn evict_oldest(dir: &std::path::Path, cap: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, std::path::PathBuf)> =
        rd.flatten().filter_map(|e| e.metadata().ok().and_then(|m| Some((m.modified().ok()?, m.len(), e.path())))).collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, p) in files {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn barnes_recovers_station_values() {
        let mk = |id: &str, lat: f32, lon: f32, t: f32| super::Obs {
            id: id.into(),
            lat,
            lon,
            time: 0,
            temp: t,
            dew: t - 5.0,
            wdir: 0.0,
            wspd: 3.0,
            gust: f32::NAN,
            vis: 16.0,
            alt: 1013.0,
            slp: 1013.0,
            cat: String::new(),
            raw: String::new(),
        };
        let obs = vec![mk("A", 40.0, -100.0, 10.0), mk("B", 40.5, -99.0, 20.0), mk("C", 39.5, -98.5, 15.0)];
        let g = super::analyze(&obs, "temp", 0);
        let v = g.sample(40.0, -100.0).unwrap();
        assert!((v - 10.0).abs() < 3.0, "{v}");
        assert!(g.sample(0.0, 0.0).is_none());
    }

    #[test]
    fn parse_cache_csv() {
        let csv = "No errors\nNo warnings\n5 ms\ndata source=metars\n1 results\nraw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wind_dir_degrees,wind_speed_kt,wind_gust_kt,visibility_statute_mi,altim_in_hg,sea_level_pressure_mb,flight_category\nKOKC 101152Z 18012G20KT 10SM CLR 22/12 A2992,KOKC,2026-10-10T11:52:00Z,35.39,-97.6,22,12,180,12,20,10+,29.92,1013.2,VFR\n";
        let o = super::parse_csv(csv.as_bytes()).unwrap();
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].id, "KOKC");
        assert!((o[0].vis - 16.09).abs() < 0.1);
        assert!((o[0].gust - 10.29).abs() < 0.1);
    }

    #[test]
    fn raw_metar_decode() {
        let r = super::decode_raw("KOKC 111353Z 18012G20KT 1 1/2SM -RA BR BKN008 OVC015 M02/M05 A2992 RMK AO2 SLP135 T00220011");
        assert_eq!(r.wdir, 180.0);
        assert!((r.wspd - 6.17).abs() < 0.05 && (r.gust - 10.29).abs() < 0.05);
        assert!((r.vis - 2.414).abs() < 0.01, "{}", r.vis);
        assert_eq!(r.ceiling_ft, 800.0);
        assert_eq!((r.temp, r.dew), (-2.0, -5.0));
        assert!((r.alt - 1013.2).abs() < 0.1);
        assert_eq!(super::flight_category(r.vis, r.ceiling_ft), "IFR");
        let e = super::decode_raw("METAR EGLL 111350Z AUTO 24008MPS 9999 FEW030 14/09 Q1008 NOSIG");
        assert_eq!((e.wspd, e.vis, e.temp, e.dew, e.alt), (8.0, 10.0, 14.0, 9.0, 1008.0));
        assert_eq!(super::flight_category(e.vis, e.ceiling_ft), "VFR");
    }

    #[test]
    fn iem_archive_parse() {
        let csv = "station,valid,lon,lat,tmpf,dwpf,drct,sknt,gust,vsby,alti,mslp,skyc1,skyc2,skyc3,skyl1,skyl2,skyl3,metar\n\
OKC,2026-10-11 12:52,-97.6007,35.3931,71.60,53.60,180.00,12.00,20.00,10.00,29.92,1013.20,FEW,BKN,M,5000.00,25000.00,M,KOKC 111252Z 18012G20KT 10SM FEW050 BKN250 22/12 A2992 RMK AO2\n\
OKC,2026-10-11 13:52,-97.6007,35.3931,73.40,53.60,190.00,14.00,M,10.00,29.91,1012.90,OVC,M,M,800.00,M,M,KOKC 111352Z 19014KT 10SM OVC008 23/12 A2991 RMK AO2\n\
EGLL,2026-10-11 13:50,-0.4614,51.4775,M,M,M,M,M,M,M,M,M,M,M,M,M,M,EGLL 111350Z 24016KT 9999 FEW030 14/09 Q1008 NOSIG\n\
BAD,2026-10-11 13:50,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M,M\n";
        let mut o = super::parse_iem(csv).unwrap();
        o.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(o.len(), 2);
        let ok = &o[1];
        assert_eq!(ok.id, "KOKC");
        assert!((ok.temp - 23.0).abs() < 0.01);
        assert_eq!(ok.wdir, 190.0);
        assert!(ok.gust.is_nan());
        assert_eq!(ok.cat, "IFR");
        assert_eq!(ok.time, chrono::NaiveDate::from_ymd_opt(2026, 10, 11).unwrap().and_hms_opt(13, 52, 0).unwrap().and_utc().timestamp_millis());
        // missing decoded columns come from the raw report
        let eg = &o[0];
        assert_eq!(eg.id, "EGLL");
        assert_eq!((eg.temp, eg.dew, eg.alt), (14.0, 9.0, 1008.0));
        assert!((eg.wspd - 8.23).abs() < 0.01);
        assert!(super::parse_iem("<html>error</html>").is_err());
        let u = super::iem_url("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py", 1_791_806_400_000 + 3_600_000);
        assert!(u.contains("sts=2026-10-12T12:01:00Z&ets=2026-10-12T13:01:00Z"), "{u}");
        assert!(u.contains("data=metar&") && u.contains("report_type=3&report_type=4"));
    }
}
