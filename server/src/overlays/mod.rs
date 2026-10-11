//! Map overlays (phase 3): outlooks, reports, observations, aviation, cameras, ships, space.
//!
//! Every overlay is served as GeoJSON from `/api/ovl/<id>`. Upstream data is fetched on demand
//! and cached briefly; feeds that need polling (lightning, recon, ships) only run while someone
//! has the overlay turned on.

pub mod aviation;
pub mod cameras;
pub mod camdb;
pub mod extra;
pub mod misc;
pub mod noaa;
pub mod obs;
pub mod ships;

use crate::grid::service::GridService;
use crate::health::Health;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub type Params = BTreeMap<String, String>;

pub struct Overlays {
    pub http: reqwest::Client,
    pub health: Arc<Health>,
    pub data_dir: PathBuf,
    pub grids: Arc<GridService>,
    cache: Mutex<HashMap<String, (Instant, Bytes)>>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// when each polled feed was last requested (pollers stop when idle)
    last_use: Mutex<HashMap<&'static str, Instant>>,
    pub glm: obs::Glm,
    pub recon: aviation::Recon,
    pub ships: ships::Ships,
    pub cams: cameras::Cameras,
    pub flights: aviation::Flights,
    pub full: bool,
    /// offline testing: `<id>.json` files served instead of live data
    pub fixtures: parking_lot::RwLock<Option<PathBuf>>,
}

/// Overlays and how long a fetched copy stays fresh (seconds).
pub const FEEDS: &[(&str, u64)] = &[
    ("spc", 300),
    ("spcfire", 600),
    ("ero", 600),
    ("wssi", 900),
    ("cpc", 3600),
    ("cpchaz", 3600),
    ("nhc", 300),
    ("gtwo", 600),
    ("riverflood", 1800),
    ("fronts", 900),
    ("mcd", 60),
    ("mpd", 120),
    ("watchbox", 60),
    ("lsr", 120),
    ("wfo", 86400 * 7),
    ("metar", 60),
    ("taf", 300),
    ("pirep", 120),
    ("sigmet", 120),
    ("gairmet", 600),
    ("airports", 86400 * 7),
    ("flights", 2),
    ("flighttrack", 20),
    ("recon", 30),
    ("buoys", 300),
    ("tides", 86400),
    ("tide", 3600),
    ("gauges", 900),
    ("quakes", 120),
    ("fires", 900),
    ("aurora", 600),
    ("glm", 15),
    ("waffle", 86400),
    ("wafflestatus", 1200),
    ("ships", 20),
    ("cameras", 0),
    ("tle", 7200),
    ("storms", 300),
    ("radio", 3600),
    ("radiomap", 600),
    ("spotters", 60),
    ("mping", 120),
    ("forecast", 0),
    ("geocode", 3600),
    ("overpass", 600),
];

pub fn ttl(id: &str) -> Option<u64> {
    FEEDS.iter().find(|f| f.0 == id).map(|f| f.1)
}

pub fn fc(features: Vec<Value>) -> Value {
    json!({"type": "FeatureCollection", "features": features})
}

pub fn point(lon: f64, lat: f64, props: Value) -> Value {
    json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon), round(lat)]}, "properties": props})
}

/// Great-circle distance in km.
pub fn km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (a1, a2) = (lat1.to_radians(), lat2.to_radians());
    let h = ((a2 - a1) / 2.0).sin().powi(2) + a1.cos() * a2.cos() * ((lon2 - lon1).to_radians() / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

pub fn round(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

/// Parse a number, treating NOAA missing markers as None.
pub fn num(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t == "MM" || t == "///" || t.eq_ignore_ascii_case("null") {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite() && *v > -9990.0)
}

impl Overlays {
    pub fn new(http: reqwest::Client, health: Arc<Health>, data_dir: &std::path::Path, grids: Arc<GridService>, full: bool) -> Arc<Self> {
        let dir = data_dir.join("overlays");
        std::fs::create_dir_all(&dir).ok();
        Arc::new(Self {
            http,
            health,
            data_dir: dir,
            grids,
            cache: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            last_use: Mutex::new(HashMap::new()),
            glm: obs::Glm::default(),
            recon: aviation::Recon::default(),
            ships: ships::Ships::default(),
            cams: cameras::Cameras::default(),
            flights: aviation::Flights::default(),
            full,
            fixtures: parking_lot::RwLock::new(None),
        })
    }

    pub fn touch(&self, id: &'static str) {
        self.last_use.lock().insert(id, Instant::now());
    }

    pub fn idle(&self, id: &str, secs: u64) -> bool {
        self.last_use.lock().get(id).map(|t| t.elapsed().as_secs() > secs).unwrap_or(true)
    }

    // ---------- fetch helpers ----------

    pub async fn get_bytes(&self, url: &str) -> Result<Bytes> {
        let r = self.http.get(url).timeout(Duration::from_secs(45)).send().await?;
        if r.status().as_u16() == 204 {
            return Ok(Bytes::new());
        }
        if !r.status().is_success() {
            bail!("HTTP {} from {}", r.status(), host(url));
        }
        Ok(r.bytes().await?)
    }

    pub async fn get_text(&self, url: &str) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.get_bytes(url).await?).to_string())
    }

    pub async fn get_json(&self, url: &str) -> Result<Value> {
        let b = self.get_bytes(url).await?;
        if b.is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_slice(&b)?)
    }

    /// Small on-disk cache for slow-changing lists (airports, stations, TLEs) so restarts and
    /// outages don't hit the source again.
    pub async fn disk_cached(&self, name: &str, max_age: Duration, url: &str) -> Result<Bytes> {
        let p = self.data_dir.join(name);
        let fresh = std::fs::metadata(&p).and_then(|m| m.modified()).ok().map(|t| t.elapsed().unwrap_or_default() < max_age).unwrap_or(false);
        if fresh {
            if let Ok(b) = tokio::fs::read(&p).await {
                return Ok(Bytes::from(b));
            }
        }
        match self.get_bytes(url).await {
            Ok(b) if !b.is_empty() => {
                tokio::fs::write(&p, &b).await.ok();
                Ok(b)
            }
            Ok(_) => bail!("empty response from {}", host(url)),
            Err(e) => {
                // stale copy beats nothing
                if let Ok(b) = tokio::fs::read(&p).await {
                    tracing::warn!("{name}: {e:#}; using cached copy");
                    return Ok(Bytes::from(b));
                }
                Err(e)
            }
        }
    }

    // ---------- dispatch ----------

    /// GeoJSON (or JSON for detail endpoints) for an overlay.
    pub async fn get(self: &Arc<Self>, id: &str, q: &Params, keys: &crate::config::Keys) -> Result<Bytes> {
        let ttl = ttl(id).ok_or_else(|| anyhow!("unknown overlay {id}"))?;
        let fixture = self.fixtures.read().as_ref().map(|d| d.join(format!("{id}.json")));
        if let Some(f) = fixture.filter(|f| f.exists()) {
            return Ok(Bytes::from(tokio::fs::read(f).await?));
        }
        let ck = format!("{id}?{}", q.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
        if ttl == 0 {
            // cheap in-memory queries (camera index): no response cache
            let v = self.build(id, q, keys).await?;
            return Ok(Bytes::from(serde_json::to_vec(&v)?));
        }
        if let Some((t, b)) = self.cache.lock().get(&ck) {
            if t.elapsed().as_secs() < ttl {
                return Ok(b.clone());
            }
        }
        let lock = self.inflight.lock().entry(ck.clone()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone();
        let _g = lock.lock().await;
        if let Some((t, b)) = self.cache.lock().get(&ck) {
            if t.elapsed().as_secs() < ttl {
                return Ok(b.clone());
            }
        }
        let res = self.build(id, q, keys).await;
        self.inflight.lock().remove(&ck);
        let name = format!("ovl-{id}");
        match res {
            Ok(v) => {
                self.health.ok(&name, &label(id), "");
                let b = Bytes::from(serde_json::to_vec(&v)?);
                let mut c = self.cache.lock();
                // keep the cache small: drop expired entries now and then
                if c.len() > 400 {
                    c.retain(|k, (t, _)| t.elapsed().as_secs() < ttl_for_key(k));
                }
                c.insert(ck, (Instant::now(), b.clone()));
                Ok(b)
            }
            Err(e) => {
                self.health.err(&name, &label(id), &e);
                // serve the last good copy if there is one
                if let Some((_, b)) = self.cache.lock().get(&ck) {
                    return Ok(b.clone());
                }
                Err(e)
            }
        }
    }

    async fn build(self: &Arc<Self>, id: &str, q: &Params, keys: &crate::config::Keys) -> Result<Value> {
        let ais_key = keys.aisstream.as_str();
        let p = |k: &str| q.get(k).map(|s| s.as_str()).unwrap_or("");
        match id {
            "spc" => noaa::spc(self, p("day"), p("kind")).await,
            "spcfire" => noaa::spc_fire(self, p("day"), p("kind")).await,
            "ero" => noaa::ero(self, p("day")).await,
            "wssi" => noaa::wssi(self, p("day")).await,
            "cpc" => noaa::cpc(self, p("period"), p("var")).await,
            "cpchaz" => noaa::cpc_hazards(self, p("period")).await,
            "nhc" => noaa::nhc(self).await,
            "storms" => noaa::storms(self).await,
            "gtwo" => noaa::gtwo(self).await,
            "riverflood" => noaa::river_flood(self).await,
            "fronts" => noaa::fronts(self, p("src")).await,
            "mcd" => noaa::iem_geojson(self, "https://mesonet.agron.iastate.edu/api/1/nws/spc_mcd.geojson").await,
            "mpd" => noaa::iem_geojson(self, "https://mesonet.agron.iastate.edu/api/1/nws/wpc_mpd.geojson").await,
            "watchbox" => noaa::iem_geojson(self, "https://mesonet.agron.iastate.edu/api/1/spc_watch_outline.geojson").await,
            "lsr" => noaa::lsr(self, p("hours")).await,
            "wfo" => noaa::wfo(self).await,
            "metar" => obs::metars(self),
            "taf" => aviation::taf(self, p("ids")).await,
            "pirep" => aviation::pireps(self).await,
            "sigmet" => aviation::sigmets(self).await,
            "gairmet" => aviation::gairmet(self, p("type"), p("fcst")).await,
            "airports" => aviation::airports(self, p("all") == "1").await,
            "flights" => {
                let lat: f64 = p("lat").parse().map_err(|_| anyhow!("lat"))?;
                let lon: f64 = p("lon").parse().map_err(|_| anyhow!("lon"))?;
                let r = p("r").parse::<f64>().unwrap_or(150.0).clamp(10.0, 250.0);
                Ok(aviation::Flights::near(self, lat, lon, r))
            }
            "flighttrack" => aviation::Flights::track(self, p("hex"), p("mode") == "seen").await,
            "recon" => {
                self.touch("recon");
                aviation::Recon::ensure(self);
                Ok(self.recon.geojson())
            }
            "buoys" => obs::buoys(self).await,
            "tides" => obs::tide_stations(self).await,
            "tide" => obs::tide_predictions(self, p("station")).await,
            "gauges" => obs::gauges(self).await,
            "quakes" => obs::quakes(self, p("period"), p("mag")).await,
            "fires" => obs::fires(self).await,
            "aurora" => obs::aurora(self).await,
            "glm" => {
                self.touch("glm");
                obs::Glm::ensure(self);
                Ok(self.glm.geojson(p("minutes").parse().unwrap_or(15)))
            }
            "waffle" => misc::waffle(self).await,
            "wafflestatus" => misc::waffle_status(self, p("ids")).await,
            "ships" => {
                self.touch("ships");
                ships::Ships::ensure(self, ais_key);
                Ok(self.ships.geojson(p("bbox")))
            }
            "cameras" => cameras::list(self, q).await,
            "tle" => misc::tle(self, p("group")).await,
            "radio" => extra::radio(self).await,
            "radiomap" => extra::radio_map(self).await,
            "spotters" => extra::spotters(self, p("streamers") == "1").await,
            "mping" => extra::mping(self, &keys.mping, p("hours")).await,
            "forecast" => {
                let lat: f64 = p("lat").parse().map_err(|_| anyhow!("lat"))?;
                let lon: f64 = p("lon").parse().map_err(|_| anyhow!("lon"))?;
                extra::forecast(self, lat, lon).await
            }
            "geocode" => extra::geocode(self, p("q")).await,
            "overpass" => extra::overpass(self, p("q"), p("bbox")).await,
            _ => bail!("unknown overlay {id}"),
        }
    }
}

fn ttl_for_key(k: &str) -> u64 {
    ttl(k.split('?').next().unwrap_or("")).unwrap_or(60)
}

pub fn host(url: &str) -> &str {
    url.split("//").nth(1).and_then(|s| s.split('/').next()).unwrap_or(url)
}

fn label(id: &str) -> String {
    let n = match id {
        "spc" => "SPC outlooks",
        "spcfire" => "SPC fire weather",
        "ero" => "WPC excessive rainfall",
        "wssi" => "WPC winter severity",
        "cpc" | "cpchaz" => "CPC outlooks",
        "nhc" | "storms" | "gtwo" => "NHC tropical",
        "riverflood" => "River flood outlook",
        "fronts" => "Surface fronts",
        "mcd" | "mpd" | "watchbox" | "lsr" | "wfo" => "Iowa Environmental Mesonet",
        "metar" => "METARs",
        "taf" | "pirep" | "sigmet" | "gairmet" => "aviationweather.gov",
        "airports" => "OurAirports",
        "flights" => "ADS-B (airplanes.live)",
        "recon" => "Recon (NHC HDOBs)",
        "buoys" => "NDBC buoys",
        "tides" | "tide" => "NOAA tides",
        "gauges" => "NWS river gauges",
        "quakes" => "USGS earthquakes",
        "fires" => "Wildfires (NIFC / FIRMS)",
        "aurora" => "SWPC aurora",
        "glm" => "GOES GLM lightning",
        "waffle" => "Waffle House (OSM)",
        "ships" => "Ships (AIS)",
        "cameras" => "Cameras",
        "tle" => "CelesTrak",
        "radio" | "radiomap" => "Weather radio (wxradio.org)",
        "spotters" => "Spotter Network",
        "mping" => "mPING",
        "forecast" => "Forecast (NWS / Open-Meteo)",
        "geocode" => "Place search (Nominatim)",
        "overpass" => "Map search (Overpass)",
        _ => id,
    };
    n.to_string()
}
