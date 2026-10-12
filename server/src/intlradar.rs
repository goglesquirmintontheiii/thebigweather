//! International radar drawn by the app as raster frames (tiles, georeferenced images or WMS),
//! plus an allowlisted image proxy so the frames can be used as WebGL textures.
//!
//! `GET /api/intlradar[?id=]` lists sources and their recent frames; frame URLs point at
//! `/api/intlradar/img?u=<percent-encoded upstream URL>`. Placeholders the client fills in are
//! left literal inside the encoded URL: `{z}` `{x}` `{y}` for tiles and `{bbox-epsg-3857}` for
//! WMS (MapLibre substitutes both natively).

use crate::health::Health;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use chrono::{DateTime, TimeZone, Utc};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Hosts the image proxy will fetch from (https only).
pub const ALLOWED_HOSTS: &[&str] = &["www.jma.go.jp", "geo.weather.gc.ca", "dd.weather.gc.ca", "dd.meteo.gc.ca", "maps.dwd.de", "smn.conagua.gob.mx", "cdn.panahon.gov.ph", "panahon.gov.ph"];

const LIST_TTL: Duration = Duration::from_secs(180);
const IMG_MAX_BYTES: usize = 12 * 1024 * 1024;
const HISTORY_MS: i64 = 3 * 3_600_000;

const JMA_BASE: &str = "https://www.jma.go.jp/bosai/jmatile/data/nowc";
const GEOMET: &str = "https://geo.weather.gc.ca/geomet";
const DWD_WMS: &str = "https://maps.dwd.de/geoserver/dwd/wms";
const PAGASA: &str = "https://cdn.panahon.gov.ph/api/v1";
const SMN_LIST: &str = "https://smn.conagua.gob.mx/tools/PHP/RDA/static/php/RDA_repository.php?dir=ecos&type=json";
const SMN_IMG_BASES: &[&str] = &["https://smn.conagua.gob.mx/tools/GUI/visor_radares_v3/ecos/", "https://smn.conagua.gob.mx/tools/PHP/RDA/static/visor_radares_v3/ecos/"];
const SMN_DB: &[&str] = &["https://smn.conagua.gob.mx/tools/GUI/visor_radares_v3/radarsDB.json", "https://smn.conagua.gob.mx/tools/PHP/RDA/static/visor_radares_v3/radarsDB.json"];

/// (id, name, health label)
const SOURCES: &[(&str, &str)] = &[
    ("jma", "Japan JMA radar nowcast"),
    ("geomet_rain", "Canada MSC GeoMet radar (rain)"),
    ("geomet_snow", "Canada MSC GeoMet radar (snow)"),
    ("dwd", "Germany DWD radar"),
    ("pagasa", "Philippines PAGASA radar"),
    ("smn", "Mexico SMN radars"),
    ("eccc", "Canada single-site radars (ECCC)"),
];

const DATAMART: &str = "https://dd.weather.gc.ca/today/radar";
/// Canadian S-band radars: (id, name, province, lat, lon).
pub const ECCC_SITES: &[(&str, &str, &str, f64, f64)] = &[
    ("CASAG", "Aldergrove", "BC", 49.01662, -122.48698),
    ("CASBE", "Bethune", "SK", 50.57118, -105.18290),
    ("CASBV", "Blainville", "QC", 45.70634, -73.85852),
    ("CASBI", "Britt", "ON", 45.79317, -80.53385),
    ("CASCV", "Carvel", "AB", 53.56056, -114.14495),
    ("CASCM", "Chipman", "NB", 46.22232, -65.69924),
    ("CASCL", "Cold Lake", "AB", 54.3785, -110.061378),
    ("CASDR", "Dryden", "ON", 49.85823, -92.79698),
    ("CASET", "Exeter", "ON", 43.37243, -81.38070),
    ("CASFM", "Fort McMurray", "AB", 56.375642, -111.215177),
    ("CASFW", "Foxwarren", "MB", 50.54887, -101.08570),
    ("CASFT", "Franktown", "ON", 45.04101, -76.11617),
    ("CASGO", "Gore", "NS", 45.09850, -63.70433),
    ("CASHP", "Halfmoon Peak", "BC", 49.527017, -123.853583),
    ("CASHR", "Holyrood", "NL", 47.32644, -53.12658),
    ("CASKR", "King City", "ON", 43.96393, -79.57388),
    ("CASLA", "Landrienne", "QC", 48.55136, -77.80809),
    ("CASMM", "Marble Mountain", "NL", 48.93028, -57.83417),
    ("CASMB", "Marion Bridge", "NS", 45.94972, -60.20521),
    ("CASMA", "Mont Apica", "QC", 47.977908, -71.430833),
    ("CASMR", "Montreal River", "ON", 47.24773, -84.59652),
    ("CASSS", "Silver Star", "BC", 50.36950, -119.06436),
    ("CASPG", "Prince George", "BC", 53.61308, -122.95441),
    ("CASRA", "Radisson", "SK", 52.52048, -107.44269),
    ("CASSF", "Sainte-Françoise", "QC", 46.449556, -71.913831),
    ("CASSU", "Schuler", "AB", 50.31250, -110.19556),
    ("CASRF", "Smooth Rock Falls", "ON", 49.28146, -81.79406),
    ("CASSR", "Spirit River", "AB", 55.69494, -119.23043),
    ("CASSM", "Strathmore", "AB", 51.20613, -113.39937),
    ("CASSN", "Superior West", "ON", 48.595876, -89.100129),
    ("CASVD", "Val d'Irène", "QC", 48.48028, -67.60111),
    ("CASWL", "Woodlands", "MB", 50.15389, -97.77833),
    ("CASTS", "Egbert (test)", "ON", 44.2305662, -79.7803300),
];
/// Range drawn around each Canadian radar (km)
const ECCC_RANGE_KM: f64 = 240.0;

/// [w, s, e, n] box of `km` around a point.
pub fn site_bounds(lat: f64, lon: f64, km: f64) -> [f64; 4] {
    let dlat = km / 111.2;
    let dlon = km / (111.32 * lat.to_radians().cos().max(0.05));
    [lon - dlon, lat - dlat, lon + dlon, lat + dlat]
}

/// GeoMet GetMap for one frame cropped to `b` (EPSG:4326; WMS 1.3.0 axis order lat,lon).
fn wms_getmap_4326(base: &str, layer: &str, b: [f64; 4], t: i64) -> String {
    format!(
        "{base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layer}&STYLES=&CRS=EPSG:4326&BBOX={:.4},{:.4},{:.4},{:.4}&WIDTH=640&HEIGHT=640&FORMAT=image/png&TRANSPARENT=TRUE&TIME={}",
        b[1], b[0], b[3], b[2], iso(t)
    )
}

/// Per-site GIF frames in a Datamart directory listing (DPQPE or CAPPI):
/// (time ms, file name, "rain" | "snow"), ascending; contingency composites are skipped.
pub fn datamart_frames(html: &str, site: &str) -> Vec<(i64, String, &'static str)> {
    let mut out = vec![];
    for part in html.split("href=\"").skip(1) {
        let Some(name) = part.split('"').next() else { continue };
        let name = name.rsplit('/').next().unwrap_or(name);
        if !name.ends_with(".gif") || !name.contains(site) || name.contains("Contingency") || name.contains("A11Y") || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        let precip = if lower.contains("snow") { "snow" } else if lower.contains("rain") { "rain" } else { continue };
        // 20201106T1050Z_MSC_Radar-DPQPE_CASBE_Rain.gif | 202010061050_CASFT_CAPPI_1.5_RAIN.gif
        let stamp = name.split('_').next().unwrap_or("");
        let t = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%MZ").or_else(|_| chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d%H%M"));
        if let Ok(t) = t {
            out.push((t.and_utc().timestamp_millis(), name.to_string(), precip));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out.dedup_by(|a, b| a.1 == b.1);
    out
}

pub struct IntlRadar {
    http: reqwest::Client,
    health: Arc<Health>,
    lists: Mutex<HashMap<String, (Instant, Value)>>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    imgs: Mutex<(lru::LruCache<String, (Instant, Bytes, String)>, usize)>,
    img_cap: std::sync::atomic::AtomicUsize,
}

/// Percent-encode a whole URL for use as a query value.
pub fn enc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 3 / 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

/// Proxy URL for an upstream URL; `{z}` `{x}` `{y}` `{bbox-epsg-3857}` stay literal.
pub fn proxied(upstream: &str) -> String {
    let mut e = enc(upstream);
    for p in ["z", "x", "y", "bbox-epsg-3857"] {
        e = e.replace(&format!("%7B{p}%7D"), &format!("{{{p}}}"));
    }
    format!("/api/intlradar/img?u={e}")
}

/// Is this URL allowed through the proxy?
pub fn allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    if auth.contains('@') || auth.contains(':') {
        return false;
    }
    ALLOWED_HOSTS.iter().any(|h| auth.eq_ignore_ascii_case(h))
}

fn iso(t: i64) -> String {
    Utc.timestamp_millis_opt(t).single().map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default()
}

/// ISO-8601 duration like PT6M / PT1H / PT30S / P1D → ms.
fn period_ms(p: &str) -> Option<i64> {
    let p = p.trim();
    let (days, t) = match p.strip_prefix('P')?.split_once('T') {
        Some((d, t)) => (d, t),
        None => (p.strip_prefix('P')?, ""),
    };
    let mut ms = 0i64;
    if let Some(d) = days.strip_suffix('D') {
        ms += d.parse::<i64>().ok()? * 86_400_000;
    }
    let mut num = String::new();
    for c in t.chars() {
        match c {
            '0'..='9' | '.' => num.push(c),
            'H' | 'M' | 'S' => {
                let v: f64 = num.parse().ok()?;
                ms += (v * match c {
                    'H' => 3_600_000.0,
                    'M' => 60_000.0,
                    _ => 1000.0,
                }) as i64;
                num.clear();
            }
            _ => return None,
        }
    }
    (ms > 0).then_some(ms)
}

/// Times listed by a WMS `<Dimension name="time">` (intervals and/or instants), ascending.
pub fn wms_times(caps: &str, layer: &str) -> Vec<i64> {
    // narrow to the layer's own block when several layers are listed
    let block = caps.find(&format!("<Name>{layer}</Name>")).map(|i| &caps[i..]).unwrap_or(caps);
    let Some(d0) = block.find("<Dimension").filter(|&i| block[i..].find('>').map(|j| block[i..i + j].contains("time")).unwrap_or(false)) else { return vec![] };
    let gt = d0 + block[d0..].find('>').unwrap_or(0) + 1;
    let Some(end) = block[gt..].find("</Dimension>") else { return vec![] };
    let body = &block[gt..gt + end];
    let parse = |s: &str| DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp_millis());
    let mut out = vec![];
    for item in body.split(',') {
        let parts: Vec<&str> = item.trim().split('/').collect();
        match parts.as_slice() {
            [a, b, p] => {
                if let (Some(a), Some(b), Some(p)) = (parse(a), parse(b), period_ms(p)) {
                    // only the last few hours, aligned to the series
                    let start = a.max(b - HISTORY_MS);
                    let mut t = a + ((start - a) + p - 1) / p * p;
                    while t <= b {
                        out.push(t);
                        t += p;
                    }
                }
            }
            [a] => out.extend(parse(a)),
            _ => {}
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn wms_getmap(base: &str, layer: &str, style: &str, t: i64) -> String {
    format!(
        "{base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layer}&STYLES={style}&CRS=EPSG:3857&BBOX={{bbox-epsg-3857}}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE&TIME={}",
        iso(t)
    )
}

impl IntlRadar {
    pub fn new(http: reqwest::Client, health: Arc<Health>) -> Arc<Self> {
        for (id, name) in SOURCES {
            health.register(&format!("intl-{id}"), name, "international radar (on demand)");
        }
        Arc::new(Self {
            http,
            health,
            lists: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            imgs: Mutex::new((lru::LruCache::unbounded(), 0)),
            img_cap: std::sync::atomic::AtomicUsize::new(48 << 20),
        })
    }

    /// Image cache cap from the "other" memory share (MB): 40%, 48 MB-1 GB.
    pub fn set_budget(&self, other_mb: usize) {
        let cap = (other_mb * 1024 * 1024 * 4 / 10).clamp(48 << 20, 1 << 30);
        self.img_cap.store(cap, std::sync::atomic::Ordering::Relaxed);
        self.trim_imgs();
    }

    fn trim_imgs(&self) {
        let cap = self.img_cap.load(std::sync::atomic::Ordering::Relaxed);
        let mut c = self.imgs.lock();
        while c.1 > cap {
            match c.0.pop_lru() {
                Some((_, (_, old, _))) => c.1 -= old.len(),
                None => break,
            }
        }
    }

    pub fn cache_stats(&self) -> crate::caches::CacheInfo {
        let c = self.imgs.lock();
        crate::caches::CacheInfo::mem("intl-images", "International radar images", c.1, c.0.len(), self.img_cap.load(std::sync::atomic::Ordering::Relaxed))
    }

    pub fn clear_cache(&self) {
        let mut c = self.imgs.lock();
        c.0.clear();
        c.1 = 0;
        self.lists.lock().clear();
    }

    async fn get(&self, url: &str, timeout: u64) -> Result<reqwest::Response> {
        let r = self.http.get(url).timeout(Duration::from_secs(timeout)).send().await?;
        if !r.status().is_success() {
            bail!("HTTP {} from {}", r.status(), crate::overlays::host(url));
        }
        Ok(r)
    }

    async fn text(&self, url: &str) -> Result<String> {
        Ok(self.get(url, 30).await?.text().await?)
    }

    /// All sources (or one by id). Each source is cached for a few minutes; sources that fail
    /// are left out (their error shows in /api/sources).
    pub async fn list(self: &Arc<Self>, id: Option<&str>) -> Result<Value> {
        let ids: Vec<&str> = match id {
            Some(i) => {
                if !SOURCES.iter().any(|s| s.0 == i) && eccc_site(i).is_none() {
                    bail!("unknown source {i} (not found)");
                }
                vec![i]
            }
            None => SOURCES.iter().map(|s| s.0).collect(),
        };
        let res = futures::future::join_all(ids.iter().map(|i| self.cached(i))).await;
        let mut out = vec![];
        let mut errors = serde_json::Map::new();
        for (i, r) in ids.iter().zip(res) {
            match r {
                Ok(Value::Array(a)) => out.extend(a),
                Ok(v) => out.push(v),
                Err(e) => {
                    errors.insert(i.to_string(), json!(format!("{e:#}")));
                }
            }
        }
        if id.is_some() && out.is_empty() {
            if let Some(e) = errors.values().next() {
                bail!("{}", e.as_str().unwrap_or("source unavailable"));
            }
        }
        Ok(json!({"sources": out, "errors": errors}))
    }

    async fn cached(self: &Arc<Self>, id: &str) -> Result<Value> {
        if let Some((t, v)) = self.lists.lock().get(id) {
            if t.elapsed() < LIST_TTL {
                return Ok(v.clone());
            }
        }
        let lock = self.inflight.lock().entry(id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
        let _g = lock.lock().await;
        if let Some((t, v)) = self.lists.lock().get(id) {
            if t.elapsed() < LIST_TTL {
                return Ok(v.clone());
            }
        }
        let name = SOURCES.iter().find(|s| s.0 == id).map(|s| s.1).unwrap_or(if eccc_site(id).is_some() { "Canada single-site radars (ECCC)" } else { id });
        let res = match id {
            "jma" => self.jma().await,
            "geomet_rain" => self.geomet("geomet_rain", "RADAR_1KM_RRAI", "Canada radar · rain (MSC GeoMet)").await,
            "geomet_snow" => self.geomet("geomet_snow", "RADAR_1KM_RSNO", "Canada radar · snow (MSC GeoMet)").await,
            "dwd" => self.dwd().await,
            "pagasa" => self.pagasa().await,
            "smn" => self.smn().await,
            "eccc" => self.eccc(None).await,
            _ if eccc_site(id).is_some() => self.eccc(eccc_site(id)).await,
            _ => Err(anyhow!("unknown source")),
        };
        let hid = if eccc_site(id).is_some() { "intl-eccc".to_string() } else { format!("intl-{id}") };
        match &res {
            Ok(v) => {
                let n = v.as_array().map(|a| a.len()).unwrap_or(1);
                self.health.ok(&hid, name, if id == "smn" || id == "eccc" { format!("{n} radars") } else { String::new() });
                self.lists.lock().insert(id.to_string(), (Instant::now(), v.clone()));
            }
            Err(e) => {
                self.health.err(&hid, name, format!("{e:#}"));
                // a stale list beats nothing
                if let Some((_, v)) = self.lists.lock().get(id) {
                    return Ok(v.clone());
                }
            }
        }
        res
    }

    // ---------- Japan: JMA high-resolution precipitation nowcast tiles ----------

    async fn jma(&self) -> Result<Value> {
        let v: Value = serde_json::from_str(&self.text(&format!("{JMA_BASE}/targetTimes_N1.json")).await?)?;
        let parse = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y%m%d%H%M%S").ok().map(|d| d.and_utc().timestamp_millis());
        let mut frames: Vec<(i64, String)> = v
            .as_array()
            .ok_or_else(|| anyhow!("JMA targetTimes is not a list"))?
            .iter()
            .filter_map(|e| {
                let (b, vt) = (e["basetime"].as_str()?, e["validtime"].as_str()?);
                if !b.chars().all(|c| c.is_ascii_digit()) || !vt.chars().all(|c| c.is_ascii_digit()) {
                    return None;
                }
                let t = parse(vt)?;
                Some((t, proxied(&format!("{JMA_BASE}/{b}/none/{vt}/surf/hrpns/{{z}}/{{x}}/{{y}}.png"))))
            })
            .collect();
        frames.sort_by_key(|f| f.0);
        frames.dedup_by_key(|f| f.0);
        if frames.is_empty() {
            bail!("JMA returned no frames");
        }
        Ok(json!({
            "id": "jma", "name": "Japan radar (JMA nowcast)", "region": "Japan", "kind": "tiles",
            "attribution": "Japan Meteorological Agency", "license_note": "JMA website content terms (CC BY 4.0 compatible); credit the Japan Meteorological Agency",
            "minzoom": 4, "maxzoom": 10, "evenZoomsOnly": true, "tileSize": 256,
            "bounds": [118.0, 20.0, 150.0, 48.0], "step_min": 5,
            "frames": frames.iter().map(|(t, u)| json!({"t": t, "url": u})).collect::<Vec<_>>(),
        }))
    }

    // ---------- Canada: MSC GeoMet WMS ----------

    async fn geomet(&self, id: &str, layer: &str, name: &str) -> Result<Value> {
        let caps = self.text(&format!("{GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer={layer}")).await?;
        let mut times = wms_times(&caps, layer);
        if times.is_empty() {
            bail!("no time dimension for {layer}");
        }
        let last = *times.last().unwrap();
        times.retain(|t| *t >= last - HISTORY_MS);
        Ok(json!({
            "id": id, "name": name, "region": "Canada / northern US", "kind": "wms",
            "attribution": "Environment and Climate Change Canada (MSC GeoMet)", "license_note": "Open Government Licence – Canada; attribution required",
            "minzoom": 2, "maxzoom": 11, "bounds": [-142.0, 41.0, -51.0, 70.0], "step_min": 6,
            "wms": {"url": GEOMET, "layers": layer, "styles": "", "format": "image/png", "version": "1.3.0", "crs": "EPSG:3857", "time_param": "TIME"},
            "frames": times.iter().map(|&t| json!({"t": t, "url": proxied(&wms_getmap(GEOMET, layer, "", t))})).collect::<Vec<_>>(),
        }))
    }

    // ---------- Germany: DWD GeoServer WMS ----------

    async fn dwd(&self) -> Result<Value> {
        let layer = "dwd:Niederschlagsradar";
        let caps = self.text("https://maps.dwd.de/geoserver/dwd/Niederschlagsradar/ows?service=WMS&version=1.3.0&request=GetCapabilities").await?;
        let mut times = wms_times(&caps, "Niederschlagsradar");
        if times.is_empty() {
            times = wms_times(&caps, layer);
        }
        let now = Utc::now().timestamp_millis();
        times.retain(|t| *t <= now + 60_000);
        if times.is_empty() {
            bail!("no time dimension for {layer}");
        }
        let last = *times.last().unwrap();
        times.retain(|t| *t >= last - HISTORY_MS);
        Ok(json!({
            "id": "dwd", "name": "Germany radar (DWD)", "region": "Germany", "kind": "wms",
            "attribution": "Deutscher Wetterdienst", "license_note": "DWD open data (GeoNutzV / CC BY 4.0); credit Deutscher Wetterdienst",
            "minzoom": 4, "maxzoom": 12, "bounds": [1.5, 45.5, 18.8, 56.5], "step_min": 5,
            "wms": {"url": DWD_WMS, "layers": layer, "styles": "", "format": "image/png", "version": "1.3.0", "crs": "EPSG:3857", "time_param": "TIME"},
            "frames": times.iter().map(|&t| json!({"t": t, "url": proxied(&wms_getmap(DWD_WMS, layer, "", t))})).collect::<Vec<_>>(),
        }))
    }

    // ---------- Philippines: PAGASA national mosaic (EPSG:4326 PNG) ----------

    async fn pagasa(&self) -> Result<Value> {
        let v: Value = serde_json::from_str(&self.text(&format!("{PAGASA}/radar/timeline")).await?)?;
        let entries = v["data"]["timeline"].as_array().ok_or_else(|| anyhow!("PAGASA timeline missing"))?;
        let mut frames: Vec<(i64, String)> = entries
            .iter()
            .enumerate()
            .filter_map(|(i, e)| {
                let t = e["observed_at_unix"].as_i64().or_else(|| e["observed_at_unix"].as_str()?.parse().ok())?;
                // the image endpoint is index based; the time keeps proxy / browser caches honest
                Some((t * 1000, proxied(&format!("{PAGASA}/radar-image?sublayer=hybrid-reflectivity&index={i}&t={t}"))))
            })
            .collect();
        frames.sort_by_key(|f| f.0);
        if frames.is_empty() {
            bail!("PAGASA timeline empty");
        }
        Ok(json!({
            "id": "pagasa", "name": "Philippines radar (PAGASA)", "region": "Philippines", "kind": "image",
            "attribution": "PAGASA / DOST", "license_note": "Philippine government work (RA 8293 §176); commercial use needs PAGASA approval",
            "minzoom": 4, "maxzoom": 11, "crs": "EPSG:4326", "step_min": 15,
            "bounds": [115.4154914129329, 3.8016540706290445, 129.51727937415484, 22.458510294136033],
            "frames": frames.iter().map(|(t, u)| json!({"t": t, "url": u})).collect::<Vec<_>>(),
        }))
    }

    // ---------- Mexico: SMN per-radar images ----------

    async fn smn(&self) -> Result<Value> {
        let listing: Value = serde_json::from_str(&self.text(SMN_LIST).await?)?;
        let mut files: Vec<String> = vec![];
        collect_files(&listing, &mut files);
        let mut db: Option<Value> = None;
        let mut last_err = None;
        for u in SMN_DB {
            match self.text(u).await.map(|t| serde_json::from_str::<Value>(&t)) {
                Ok(Ok(v)) => {
                    db = Some(v);
                    break;
                }
                Ok(Err(e)) => last_err = Some(anyhow!("radarsDB.json: {e}")),
                Err(e) => last_err = Some(e),
            }
        }
        let db = db.ok_or_else(|| last_err.unwrap_or_else(|| anyhow!("radarsDB.json unavailable")))?;
        // the image base that actually serves files
        let mut base = SMN_IMG_BASES[0];
        if let Some(f) = files.first() {
            for b in SMN_IMG_BASES {
                if self.http.head(format!("{b}{f}")).timeout(Duration::from_secs(10)).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
                    base = b;
                    break;
                }
            }
        }
        // group by station: STATION_PRODUCT_MOMENT_..._YYYYMMDD_HHMMSS.gif
        let mut by: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        for f in files {
            let p: Vec<&str> = f.trim_end_matches(".gif").trim_end_matches(".png").split('_').collect();
            if p.len() < 3 {
                continue;
            }
            let Ok(t) = chrono::NaiveDateTime::parse_from_str(&format!("{}{}", p[p.len() - 2], p[p.len() - 1]), "%Y%m%d%H%M%S") else { continue };
            by.entry(p[0].to_string()).or_default().push((t.and_utc().timestamp_millis(), f.clone()));
        }
        let mut out = vec![];
        let mut ids: Vec<String> = by.keys().cloned().collect();
        ids.sort();
        for st in ids {
            let Some(bounds) = smn_bounds(&db, &st) else { continue };
            let mut fr = by.remove(&st).unwrap_or_default();
            fr.sort_by_key(|f| f.0);
            let k = fr.len().saturating_sub(24);
            let frames: Vec<Value> = fr[k..].iter().map(|(t, f)| json!({"t": t, "url": proxied(&format!("{base}{f}"))})).collect();
            out.push(json!({
                "id": format!("smn_{}", st.to_ascii_lowercase()), "name": format!("Mexico radar {st} (SMN)"), "region": "Mexico", "kind": "image",
                "attribution": "Servicio Meteorológico Nacional (CONAGUA)", "license_note": "SMN: personal use",
                "minzoom": 4, "maxzoom": 11, "bounds": bounds, "step_min": 5, "frames": frames,
            }));
        }
        if out.is_empty() {
            bail!("no SMN radar could be georeferenced");
        }
        Ok(Value::Array(out))
    }

    // ---------- Canada: per-radar views (ECCC) ----------

    /// One image source per Canadian radar: the MSC GeoMet 1 km radar mosaic (rain and snow
    /// rate) cropped to the radar's 240 km range, georeferenced in EPSG:4326. ECCC publishes no
    /// open single-site volumes; with `site` the source also lists that radar's own pre-rendered
    /// Datamart GIFs (DPQPE, falling back to CAPPI), which carry a basemap and legend.
    async fn eccc(&self, site: Option<&'static (&'static str, &'static str, &'static str, f64, f64)>) -> Result<Value> {
        let mut times = HashMap::new();
        for layer in ["RADAR_1KM_RRAI", "RADAR_1KM_RSNO"] {
            let caps = self.text(&format!("{GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&layer={layer}")).await?;
            let mut t = wms_times(&caps, layer);
            if let Some(&last) = t.last() {
                t.retain(|x| *x >= last - HISTORY_MS);
            }
            times.insert(layer, t);
        }
        if times.values().all(|t| t.is_empty()) {
            bail!("no time dimension for the GeoMet radar layers");
        }
        let one = |s: &(&str, &str, &str, f64, f64)| {
            let (id, name, prov, lat, lon) = *s;
            let b = site_bounds(lat, lon, ECCC_RANGE_KM);
            let fr = |layer: &str| times[layer].iter().map(|&t| json!({"t": t, "url": proxied(&wms_getmap_4326(GEOMET, layer, b, t))})).collect::<Vec<_>>();
            json!({
                "id": format!("eccc_{}", id.to_ascii_lowercase()), "name": format!("Canada radar {name} {prov} ({id})"),
                "region": "Canada", "country": "CA", "group": "All Canada radars", "kind": "image", "crs": "EPSG:4326",
                "site": {"id": id, "name": name, "province": prov, "lat": lat, "lon": lon, "range_km": ECCC_RANGE_KM},
                "product": "precipitation rate (rain)", "units": "mm/h",
                "attribution": "Environment and Climate Change Canada (MSC GeoMet)", "license_note": "Open Government Licence – Canada; attribution required",
                "minzoom": 4, "maxzoom": 11, "bounds": b, "step_min": 6,
                "frames": fr("RADAR_1KM_RRAI"),
                "frames_snow": fr("RADAR_1KM_RSNO"),
            })
        };
        let Some(s) = site else {
            return Ok(Value::Array(ECCC_SITES.iter().map(one).collect()));
        };
        let mut v = one(s);
        // the radar's own images from the Datamart (best effort)
        let mut pics = vec![];
        let mut last_err = None;
        for prod in ["DPQPE", "CAPPI"] {
            let dir = format!("{DATAMART}/{prod}/GIF/{}/", s.0);
            match self.text(&dir).await {
                Ok(html) => {
                    let f = datamart_frames(&html, s.0);
                    let k = f.len().saturating_sub(60);
                    pics = f[k..].iter().map(|(t, n, p)| json!({"t": t, "precip": p, "url": proxied(&format!("{dir}{n}"))})).collect();
                    if !pics.is_empty() {
                        v["datamart"] = json!({"product": prod, "georeferenced": false, "note": "ECCC pre-rendered image (basemap + legend)", "frames": pics});
                        break;
                    }
                }
                Err(e) => last_err = Some(format!("{e:#}")),
            }
        }
        if pics.is_empty() {
            v["datamart"] = json!({"frames": [], "error": last_err.unwrap_or_else(|| "no images listed".into())});
        }
        Ok(v)
    }

    // ---------- image proxy ----------

    /// Fetch an allowlisted image (cached briefly). Returns (bytes, content type).
    pub async fn img(&self, url: &str) -> Result<(Bytes, String)> {
        if !allowed(url) {
            bail!("host not allowed");
        }
        {
            let mut c = self.imgs.lock();
            if let Some((t, b, ct)) = c.0.get(url) {
                // timestamped frames never change; give them longer
                if t.elapsed() < Duration::from_secs(600) {
                    return Ok((b.clone(), ct.clone()));
                }
            }
        }
        let r = self.get(url, 30).await?;
        let ct = r.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        if let Some(n) = r.content_length() {
            if n as usize > IMG_MAX_BYTES {
                bail!("image too large");
            }
        }
        let b = r.bytes().await?;
        if b.len() > IMG_MAX_BYTES {
            bail!("image too large");
        }
        let ct = sniff(&b).map(String::from).or_else(|| ct.starts_with("image/").then(|| ct.split(';').next().unwrap_or("").trim().to_string()));
        // WMS servers answer errors with XML and status 200
        let ct = ct.ok_or_else(|| anyhow!("upstream returned no image (not found)"))?;
        {
            let mut c = self.imgs.lock();
            if let Some((_, (_, old, _))) = c.0.push(url.to_string(), (Instant::now(), b.clone(), ct.clone())) {
                c.1 -= old.len();
            }
            c.1 += b.len();
        }
        self.trim_imgs();
        Ok((b, ct))
    }
}

/// `eccc_<site>` → the Canadian radar entry.
fn eccc_site(id: &str) -> Option<&'static (&'static str, &'static str, &'static str, f64, f64)> {
    let s = id.strip_prefix("eccc_")?;
    ECCC_SITES.iter().find(|x| x.0.eq_ignore_ascii_case(s))
}

fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.starts_with(&[0xff, 0xd8]) {
        Some("image/jpeg")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Every string in a JSON tree that looks like an SMN radar image file name.
fn collect_files(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            let name = s.rsplit('/').next().unwrap_or(s);
            if (name.ends_with(".gif") || name.ends_with(".png")) && name.split('_').count() >= 4 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-') {
                out.push(name.to_string());
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_files(x, out)),
        Value::Object(m) => m.values().for_each(|x| collect_files(x, out)),
        _ => {}
    }
}

/// Bounds [w, s, e, n] of a station's image from radarsDB.json: the first `bounds` found under
/// an object that mentions the station id. Accepts Leaflet [[s, w], [n, e]] or [w, s, e, n].
fn smn_bounds(db: &Value, station: &str) -> Option<[f64; 4]> {
    fn find(v: &Value, st: &str, inside: bool) -> Option<[f64; 4]> {
        match v {
            Value::Object(m) => {
                let here = inside || m.iter().any(|(k, x)| k.eq_ignore_ascii_case(st) || x.as_str().map(|s| s.eq_ignore_ascii_case(st)).unwrap_or(false));
                if here {
                    if let Some(b) = m.get("bounds").and_then(parse_bounds) {
                        return Some(b);
                    }
                }
                for (k, x) in m {
                    if let Some(b) = find(x, st, here || k.eq_ignore_ascii_case(st)) {
                        return Some(b);
                    }
                }
                None
            }
            Value::Array(a) => a.iter().find_map(|x| find(x, st, inside)),
            _ => None,
        }
    }
    fn parse_bounds(b: &Value) -> Option<[f64; 4]> {
        let a = b.as_array()?;
        let f = |v: &Value| v.as_f64().or_else(|| v.as_str()?.parse().ok());
        let r = if a.len() == 2 {
            let (p, q) = (a[0].as_array()?, a[1].as_array()?);
            let (s, w, n, e) = (f(&p[0])?, f(&p[1])?, f(&q[0])?, f(&q[1])?);
            [w.min(e), s.min(n), w.max(e), s.max(n)]
        } else if a.len() == 4 {
            [f(&a[0])?, f(&a[1])?, f(&a[2])?, f(&a[3])?]
        } else {
            return None;
        };
        (r[0] >= -125.0 && r[2] <= -80.0 && r[1] >= 8.0 && r[3] <= 38.0 && r[0] < r[2]).then_some(r)
    }
    find(db, station, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_urls_and_allowlist() {
        let p = proxied("https://www.jma.go.jp/bosai/jmatile/data/nowc/20261011153500/none/20261011153500/surf/hrpns/{z}/{x}/{y}.png");
        assert_eq!(p, "/api/intlradar/img?u=https%3A%2F%2Fwww.jma.go.jp%2Fbosai%2Fjmatile%2Fdata%2Fnowc%2F20261011153500%2Fnone%2F20261011153500%2Fsurf%2Fhrpns%2F{z}%2F{x}%2F{y}.png");
        let w = proxied(&wms_getmap(GEOMET, "RADAR_1KM_RRAI", "", 1_791_700_000_000));
        assert!(w.contains("BBOX%3D{bbox-epsg-3857}%26") && w.contains("TIME%3D2026-"), "{w}");
        assert!(allowed("https://www.jma.go.jp/x.png"));
        assert!(allowed("https://geo.weather.gc.ca/geomet?x=1"));
        assert!(!allowed("http://www.jma.go.jp/x.png"));
        assert!(!allowed("https://www.jma.go.jp@evil.com/x.png"));
        assert!(!allowed("https://evil.com/?https://www.jma.go.jp/"));
        assert!(!allowed("https://www.jma.go.jp.evil.com/x"));
        assert!(!allowed("https://localhost/x"));
    }

    #[test]
    fn wms_time_dimensions() {
        let caps = r#"<Layer><Name>RADAR_1KM_RRAI</Name><Dimension name="time" units="ISO8601" default="2026-10-11T15:36:00Z" nearestValue="0">2026-10-11T12:00:00Z/2026-10-11T15:36:00Z/PT6M</Dimension></Layer>"#;
        let t = wms_times(caps, "RADAR_1KM_RRAI");
        assert_eq!(*t.last().unwrap(), DateTime::parse_from_rfc3339("2026-10-11T15:36:00Z").unwrap().timestamp_millis());
        assert!(t.len() >= 31 && t.len() <= 37, "{}", t.len());
        assert!(t.windows(2).all(|w| w[1] - w[0] == 360_000));
        let caps2 = r#"<Name>Niederschlagsradar</Name><Dimension name="time" default="current" units="ISO8601">2026-10-11T15:25:00.000Z,2026-10-11T15:30:00.000Z,2026-10-11T15:35:00.000Z</Dimension>"#;
        assert_eq!(wms_times(caps2, "Niederschlagsradar").len(), 3);
        assert_eq!(period_ms("PT5M"), Some(300_000));
        assert_eq!(period_ms("PT1H30M"), Some(5_400_000));
        assert_eq!(period_ms("P1D"), Some(86_400_000));
    }

    #[test]
    fn smn_parsing() {
        let listing = json!({"files": ["CUN_PPIZ_DBZ_XXX_P005_20261011_150412.gif", "x.txt"], "more": [{"name": "CUN_PPIZ_DBZ_XXX_P005_20261011_150912.gif"}]});
        let mut f = vec![];
        collect_files(&listing, &mut f);
        assert_eq!(f.len(), 2);
        let db = json!({"radarsInfo": [{"id": "CUN", "map": {"bounds": [[18.9, -89.1], [23.3, -84.4]]}}, {"id": "MZT", "bounds": [-108, 21, -104, 25]}]});
        assert_eq!(smn_bounds(&db, "CUN"), Some([-89.1, 18.9, -84.4, 23.3]));
        assert_eq!(smn_bounds(&db, "MZT"), Some([-108.0, 21.0, -104.0, 25.0]));
        assert_eq!(smn_bounds(&db, "XXX"), None);
        assert_eq!(sniff(b"\x89PNG...."), Some("image/png"));
    }

    #[test]
    fn eccc_sites_and_datamart() {
        assert_eq!(eccc_site("eccc_caskr").map(|s| s.1), Some("King City"));
        assert!(eccc_site("eccc_kbuf").is_none() && eccc_site("smn_cun").is_none());
        let b = site_bounds(45.0, -75.0, 240.0);
        assert!((b[3] - b[1] - 4.317).abs() < 0.01 && (b[2] - b[0] - 6.105).abs() < 0.02, "{b:?}");
        let u = wms_getmap_4326(GEOMET, "RADAR_1KM_RRAI", b, 1_791_700_000_000);
        assert!(u.contains("CRS=EPSG:4326&BBOX=42.8417,-78.0490,47.1583,-71.9510&"), "{u}");
        assert!(allowed("https://dd.weather.gc.ca/today/radar/DPQPE/GIF/CASBV/x.gif"));
        let html = r#"<a href="20261011T1500Z_MSC_Radar-DPQPE_CASBV_Rain.gif">x</a> <a href="20261011T1454Z_MSC_Radar-DPQPE_CASBV_Snow.gif">x</a>
<a href="20261011T1500Z_MSC_Radar-DPQPE_CASBV_Rain-Contingency.gif">x</a> <a href="20261011T1500Z_MSC_Radar-DPQPE_CASBV_Rain_A11Y.gif">x</a>
<a href="202610111448_CASBV_CAPPI_1.5_RAIN.gif">x</a> <a href="../">up</a>"#;
        let f = datamart_frames(html, "CASBV");
        assert_eq!(f.len(), 3, "{f:?}");
        assert_eq!(f[0].1, "202610111448_CASBV_CAPPI_1.5_RAIN.gif");
        assert_eq!(f[1].2, "snow");
        assert_eq!(f[2].0, DateTime::parse_from_rfc3339("2026-10-11T15:00:00Z").unwrap().timestamp_millis());
    }
}
