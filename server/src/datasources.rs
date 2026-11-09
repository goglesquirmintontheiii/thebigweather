//! 0.8.4: data sources the user can switch off (Settings -> Data sources).
//!
//! A source is a provider of data: the hosts it lives on, plus the overlay feeds and weather
//! layers it supplies. Everything defaults to on; the sources switched off are kept in
//! `datasources.json` in the data folder.
//!
//! Requests are stopped at three levels: the fetch helpers call [`check`], feeds and pollers ask
//! [`enabled`], and the DNS resolver on the shared HTTP client ([`GuardResolver`]) refuses new
//! connections to a disabled host, which also covers code paths with no check of their own.

use parking_lot::RwLock;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Part of the error text of a blocked request (health shows these as "off", not as failures).
pub const DISABLED: &str = "data source is off";

#[derive(Debug, Clone, Serialize)]
pub struct Source {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    #[serde(skip)]
    pub hosts: &'static [&'static str],
}

const fn s(id: &'static str, name: &'static str, group: &'static str, hosts: &'static [&'static str]) -> Source {
    Source { id, name, group, hosts }
}

/// Every source. A host entry matches that host and its subdomains. Sources with no hosts are
/// fetched by the app itself, or from many sites at once, and are stopped by their feed.
pub const SOURCES: &[Source] = &[
    s("nexrad-l2", "NEXRAD Level II", "Radar", &[]), // buckets come from the config
    s("nexrad-chunks", "NEXRAD live chunks", "Radar", &[]),
    s("nexrad-l3", "NEXRAD Level III & NDFD", "Radar", &["tgftp.nws.noaa.gov"]),
    s("opera", "OPERA Europe radars", "Radar", &["s3.waw3-1.cloudferro.com"]),
    s("fmi", "FMI Finland radars", "Radar", &["fmi-opendata-radar-volume-hdf5.s3.amazonaws.com"]),
    s("mzzu", "MZZU (University of Missouri)", "Radar", &["weather.missouri.edu"]),
    s("rainviewer", "RainViewer radars", "Radar", &["data.rainviewer.com", "api.rainviewer.com", "tilecache.rainviewer.com"]),
    s("eccc", "Environment Canada", "Radar", &["dd.weather.gc.ca", "geo.weather.gc.ca", "api.weather.gc.ca", "weather.gc.ca"]),
    s("dwd", "DWD Germany", "Radar", &["opendata.dwd.de", "maps.dwd.de"]),
    s("jma", "JMA Japan", "Radar", &["www.jma.go.jp"]),
    s("cwa", "CWA Taiwan", "Radar", &["cwaopendata.s3.ap-northeast-1.amazonaws.com"]),
    s("smn", "SMN Mexico", "Radar", &["smn.conagua.gob.mx"]),
    s("pagasa", "PAGASA Philippines", "Radar", &["cdn.panahon.gov.ph"]),
    s("mrms", "MRMS", "Models & grids", &["noaa-mrms-pds.s3.amazonaws.com"]),
    s("hrrr", "HRRR", "Models & grids", &["noaa-hrrr-bdp-pds.s3.amazonaws.com"]),
    s("rrfs", "RRFS", "Models & grids", &["noaa-rrfs-ops-pds.s3.amazonaws.com"]),
    s("nam", "NAM", "Models & grids", &["noaa-nam-pds.s3.amazonaws.com"]),
    s("rap", "RAP", "Models & grids", &["noaa-rap-pds.s3.amazonaws.com"]),
    s("nbm", "NBM", "Models & grids", &["noaa-nbm-grib2-pds.s3.amazonaws.com"]),
    s("gfs", "GFS", "Models & grids", &["noaa-gfs-bdp-pds.s3.amazonaws.com"]),
    s("gefs", "GEFS", "Models & grids", &["noaa-gefs-pds.s3.amazonaws.com"]),
    s("hafs", "HAFS", "Models & grids", &["noaa-nws-hafs-pds.s3.amazonaws.com"]),
    s("urma", "URMA / RTMA", "Models & grids", &["noaa-urma-pds.s3.amazonaws.com", "noaa-rtma-pds.s3.amazonaws.com"]),
    s("ecmwf", "ECMWF", "Models & grids", &["data.ecmwf.int"]),
    s("goes", "GOES satellites", "Satellite", &["noaa-goes16.s3.amazonaws.com", "noaa-goes17.s3.amazonaws.com", "noaa-goes18.s3.amazonaws.com", "noaa-goes19.s3.amazonaws.com"]),
    s("gibs", "NASA GIBS imagery", "Satellite", &[]),
    s("eumetview", "EUMETView imagery", "Satellite", &[]),
    s("awc", "Aviation Weather Center (METARs, TAFs)", "Observations", &["aviationweather.gov", "tfr.faa.gov"]),
    s("iem", "Iowa Environmental Mesonet", "Observations", &["mesonet.agron.iastate.edu"]),
    s("pws", "CWOP weather stations", "Observations", &[]),
    s("ndbc", "NDBC buoys & tides", "Observations", &["www.ndbc.noaa.gov", "api.tidesandcurrents.noaa.gov"]),
    s("acis", "ACIS climate", "Observations", &["data.rcc-acis.org"]),
    s("airnow", "AirNow air quality", "Observations", &["files.airnowtech.org"]),
    s("open-meteo", "Open-Meteo", "Observations", &["api.open-meteo.com", "air-quality-api.open-meteo.com", "marine-api.open-meteo.com", "ensemble-api.open-meteo.com"]),
    s("shake", "Raspberry Shake", "Observations", &["data.raspberryshake.org"]),
    s("nws", "NWS alerts & API", "Hazards", &["api.weather.gov"]),
    s("spc", "Storm Prediction Center", "Hazards", &["www.spc.noaa.gov"]),
    s("nhc", "National Hurricane Center", "Hazards", &["www.nhc.noaa.gov", "ftp.nhc.noaa.gov"]),
    s("noaa-gis", "NOAA / NWS map services", "Hazards", &["mapservices.weather.noaa.gov", "maps.water.noaa.gov", "api.water.noaa.gov", "www.weather.gov", "services.dat.noaa.gov", "satepsanone.nesdis.noaa.gov"]),
    s("usgs", "USGS quakes, volcanoes & tsunami", "Hazards", &["earthquake.usgs.gov", "volcanoes.usgs.gov", "www.tsunami.gov"]),
    s("firms", "NASA FIRMS fires", "Hazards", &["firms.modaps.eosdis.nasa.gov"]),
    s("swpc", "NOAA space weather", "Hazards", &["services.swpc.noaa.gov"]),
    s("fema", "FEMA shelters & facilities", "Hazards", &["gis.fema.gov"]),
    s("flights", "ADS-B flights", "Tracking", &["api.adsb.lol", "globe.adsb.lol", "api.airplanes.live"]),
    s("ships", "Ships (AIS)", "Tracking", &["meri.digitraffic.fi", "stream.aisstream.io"]),
    s("iss", "Satellite tracking (CelesTrak)", "Tracking", &["celestrak.org"]),
    s("spotter", "Spotter Network", "Tracking", &["www.spotternetwork.org"]),
    s("mping", "mPING", "Tracking", &["mping.ou.edu"]),
    s("cameras", "Traffic cameras", "Roads & places", &[]),
    s("traffic", "Road events & traffic", "Roads & places", &["api.tomtom.com"]),
    s("outages", "Power outages", "Roads & places", &["kubra.io", "pannes.hydroquebec.com"]),
    s("overpass", "OpenStreetMap Overpass", "Roads & places", &["overpass-api.de", "overpass.private.coffee", "overpass.kumi.systems"]),
    s("waffle", "Waffle House", "Roads & places", &["locations.wafflehouse.com"]),
    s("carto", "CARTO basemaps", "Basemaps", &[]),
    s("openfreemap", "OpenFreeMap basemaps", "Basemaps", &[]),
    s("esri", "Esri imagery & terrain", "Basemaps", &[]),
    s("google", "Google Map Tiles", "Basemaps", &[]),
    s("faa-charts", "FAA aeronautical charts", "Basemaps", &[]),
];

/// Overlay feed -> source. Feeds not listed have no toggle of their own.
pub const FEEDS: &[(&str, &str)] = &[
    ("spc", "spc"), ("spcfire", "spc"), ("mcd", "spc"), ("watchbox", "spc"), ("tornadohist", "spc"),
    ("ero", "noaa-gis"), ("wssi", "noaa-gis"), ("cpc", "noaa-gis"), ("cpchaz", "noaa-gis"), ("riverflood", "noaa-gis"),
    ("fronts", "noaa-gis"), ("mpd", "noaa-gis"), ("wfo", "noaa-gis"), ("gauges", "noaa-gis"), ("hms", "noaa-gis"), ("dat", "noaa-gis"),
    ("nhc", "nhc"), ("gtwo", "nhc"), ("atcf", "nhc"), ("nhcwsp", "nhc"), ("storms", "nhc"), ("vdm", "nhc"), ("recon", "nhc"),
    ("lsr", "iem"), ("sbwhist", "iem"), ("lsrhist", "iem"), ("watchhist", "iem"), ("mcdhist", "iem"), ("raobsta", "iem"),
    ("metar", "awc"), ("taf", "awc"), ("pirep", "awc"), ("sigmet", "awc"), ("gairmet", "awc"), ("airports", "awc"), ("airspace", "awc"), ("airadv", "awc"),
    ("flights", "flights"), ("flighttrack", "flights"),
    ("buoys", "ndbc"), ("tides", "ndbc"), ("tide", "ndbc"),
    ("quakes", "usgs"), ("volcanoes", "usgs"), ("shakemap", "usgs"), ("tsunami", "usgs"),
    ("fires", "firms"),
    ("aurora", "swpc"), ("kp", "swpc"), ("swpc", "swpc"),
    ("glm", "goes"), ("goesfire", "goes"), ("ot", "goes"), ("ljump", "goes"),
    ("waffle", "waffle"), ("wafflestatus", "waffle"),
    ("ships", "ships"),
    ("cameras", "cameras"),
    ("tle", "iss"),
    ("spotters", "spotter"),
    ("mping", "mping"),
    ("overpass", "overpass"),
    ("airquality", "airnow"),
    ("roadwork", "traffic"), ("trafficflow", "traffic"), ("roadcond", "traffic"),
    ("climate", "acis"), ("climaterec", "acis"),
    ("pws", "pws"),
    ("outages", "outages"),
    ("shelters", "fema"), ("hospitals", "fema"), ("centers", "fema"),
    ("shake", "shake"), ("shakeevents", "shake"),
    ("stormattr", "nexrad-l3"),
];

pub fn feed_source(feed: &str) -> Option<&'static str> {
    FEEDS.iter().find(|f| f.0 == feed).map(|f| f.1)
}

/// Source of a gridded weather layer, from the catalog's `source` / `model` and the layer id.
pub fn grid_source(source: &str, model: Option<&str>, id: &str) -> Option<&'static str> {
    let by_model = |m: &str| match m {
        x if x.starts_with("hrrr") => Some("hrrr"),
        "rrfs" => Some("rrfs"),
        x if x.starts_with("nam") => Some("nam"),
        "rap" => Some("rap"),
        "nbm" => Some("nbm"),
        x if x.starts_with("gefs") => Some("gefs"),
        x if x.starts_with("gfs") => Some("gfs"),
        x if x.starts_with("ecmwf") => Some("ecmwf"),
        x if x.starts_with("hafs") => Some("hafs"),
        "gdps" | "hrdps" | "rdps" => Some("eccc"),
        x if x.starts_with("icon") => Some("dwd"),
        _ => None,
    };
    match source {
        "mrms" | "nowcast" => Some("mrms"),
        "goes" | "goesfog" => Some("goes"),
        "metar" => Some("awc"),
        "ndfd" => Some("nexrad-l3"), // same NWS file server (tgftp)
        "opera" => Some("opera"),
        "cwa" => Some("cwa"),
        "mlpred" => None,
        _ => model.and_then(by_model).or_else(|| id.split('/').nth(1).and_then(by_model)),
    }
}

/// Source of a status row in the Data sources list.
pub fn health_source(id: &str) -> Option<&'static str> {
    if let Some(f) = id.strip_prefix("ovl-") {
        return feed_source(f);
    }
    if let Some(g) = id.strip_prefix("grid-") {
        return grid_source(g, None, "");
    }
    if let Some(i) = id.strip_prefix("intl-") {
        return match i {
            "jma" | "dwd" | "pagasa" | "smn" | "eccc" | "rainviewer" => SOURCES.iter().find(|s| s.id == i).map(|s| s.id),
            x if x.starts_with("geomet") => Some("eccc"),
            _ => None,
        };
    }
    match id {
        "nexrad-l2" => Some("nexrad-l2"),
        "nexrad-chunks" => Some("nexrad-chunks"),
        "nexrad-l3" => Some("nexrad-l3"),
        "odim-opera" => Some("opera"),
        "odim-fmi" => Some("fmi"),
        "odim-rv" => Some("rainviewer"),
        "odim-mzzu" => Some("mzzu"),
        "metar" => Some("awc"),
        "nws-alerts" => Some("nws"),
        "cam-db" => Some("cameras"),
        "outages-src" => Some("outages"),
        "radar-blockage" | "site-table" => None,
        _ => None,
    }
}

/// `https://a.b:1/x` -> `a.b`
pub fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|x| x.1).unwrap_or(url);
    let auth = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let auth = auth.rsplit('@').next().unwrap_or(auth);
    auth.split(':').next().unwrap_or(auth)
}

fn host_matches(host: &str, pat: &str) -> bool {
    host.eq_ignore_ascii_case(pat) || (host.len() > pat.len() && host[host.len() - pat.len()..].eq_ignore_ascii_case(pat) && host.as_bytes()[host.len() - pat.len() - 1] == b'.')
}

#[derive(Default)]
pub struct Gate {
    off: RwLock<BTreeSet<String>>,
    /// source -> S3 bucket hosts from the config
    extra: RwLock<Vec<(&'static str, String)>>,
    path: RwLock<Option<PathBuf>>,
}

impl Gate {
    fn load(&self, data_dir: &Path, radar: &crate::config::RadarCfg) {
        let path = data_dir.join("datasources.json");
        let saved: BTreeSet<String> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok()).unwrap_or_default().into_iter().collect();
        *self.off.write() = saved;
        *self.path.write() = Some(path);
        let bucket = |ds: &'static str, v: &[String]| v.iter().map(move |b| (ds, format!("{b}.s3.amazonaws.com"))).collect::<Vec<_>>();
        let mut extra = bucket("nexrad-l2", &radar.level2_buckets);
        extra.extend(bucket("nexrad-chunks", &radar.chunk_buckets));
        extra.extend(bucket("nexrad-l3", &radar.level3_buckets));
        *self.extra.write() = extra;
    }
    pub fn is_on(&self, id: &str) -> bool {
        !self.off.read().contains(id)
    }
    fn off_list(&self) -> Vec<String> {
        self.off.read().iter().cloned().collect()
    }
    /// The disabled source a host belongs to, if any.
    pub fn blocked_host(&self, host: &str) -> Option<&'static str> {
        let off = self.off.read();
        if off.is_empty() {
            return None;
        }
        for s in SOURCES.iter().filter(|s| off.contains(s.id)) {
            if s.hosts.iter().any(|p| host_matches(host, p)) {
                return Some(s.id);
            }
        }
        self.extra.read().iter().find(|(ds, h)| off.contains(*ds) && host_matches(host, h)).map(|x| x.0)
    }
    fn set(&self, id: &str, on: bool) -> std::io::Result<()> {
        let list = {
            let mut g = self.off.write();
            if on {
                g.remove(id);
            } else {
                g.insert(id.to_string());
            }
            g.iter().cloned().collect::<Vec<_>>()
        };
        if let Some(p) = self.path.read().clone() {
            let tmp = p.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&list)?)?;
            std::fs::rename(&tmp, &p)?;
        }
        Ok(())
    }
}

static GATE: once_cell::sync::Lazy<Gate> = once_cell::sync::Lazy::new(Gate::default);

/// Read the saved state; call once at startup.
pub fn init(data_dir: &Path, radar: &crate::config::RadarCfg) {
    GATE.load(data_dir, radar);
}

pub fn enabled(id: &str) -> bool {
    GATE.is_on(id)
}

pub fn off_list() -> Vec<String> {
    GATE.off_list()
}

/// Switch a source on or off and save. False if there is no such source.
pub fn set_enabled(id: &str, on: bool) -> std::io::Result<bool> {
    if !SOURCES.iter().any(|s| s.id == id) {
        return Ok(false);
    }
    GATE.set(id, on)?;
    Ok(true)
}

/// Error for a request to a disabled source.
pub fn off_error(id: &str) -> anyhow::Error {
    let name = SOURCES.iter().find(|s| s.id == id).map(|s| s.name).unwrap_or(id);
    anyhow::anyhow!("{name}: {DISABLED}")
}

/// Refuse a URL on a disabled source (called before fetches).
pub fn check(url: &str) -> anyhow::Result<()> {
    match GATE.blocked_host(host_of(url)) {
        Some(ds) => Err(off_error(ds)),
        None => Ok(()),
    }
}

/// Refuse a feed whose source is disabled.
pub fn check_feed(feed: &str) -> anyhow::Result<()> {
    match feed_source(feed).filter(|ds| !enabled(ds)) {
        Some(ds) => Err(off_error(ds)),
        None => Ok(()),
    }
}

/// DNS for the shared HTTP client: no new connections to a disabled source's hosts.
pub struct GuardResolver;

impl Resolve for GuardResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            if let Some(ds) = GATE.blocked_host(name.as_str()) {
                let e: Box<dyn std::error::Error + Send + Sync> = off_error(ds).to_string().into();
                return Err(e);
            }
            let addrs = tokio::net::lookup_host((name.as_str(), 0)).await?;
            let addrs: Addrs = Box::new(addrs.collect::<Vec<_>>().into_iter());
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(off: &[&str]) -> Gate {
        let g = Gate::default();
        *g.off.write() = off.iter().map(|s| s.to_string()).collect();
        *g.extra.write() = vec![("nexrad-l2", "unidata-nexrad-level2.s3.amazonaws.com".to_string()), ("nexrad-chunks", "unidata-nexrad-level2-chunks.s3.amazonaws.com".to_string())];
        g
    }

    #[test]
    fn hosts_block_only_their_own_source() {
        let g = gate(&["mrms", "nexrad-l2", "eccc"]);
        assert_eq!(g.blocked_host("noaa-mrms-pds.s3.amazonaws.com"), Some("mrms"));
        assert_eq!(g.blocked_host("NOAA-MRMS-PDS.s3.amazonaws.com"), Some("mrms"));
        assert_eq!(g.blocked_host("noaa-hrrr-bdp-pds.s3.amazonaws.com"), None);
        // config bucket hosts, and a bucket whose name starts the same stays separate
        assert_eq!(g.blocked_host("unidata-nexrad-level2.s3.amazonaws.com"), Some("nexrad-l2"));
        assert_eq!(g.blocked_host("unidata-nexrad-level2-chunks.s3.amazonaws.com"), None);
        // subdomains match, look-alike domains don't
        assert_eq!(g.blocked_host("dd.weather.gc.ca"), Some("eccc"));
        assert_eq!(g.blocked_host("evilweather.gc.ca"), None);
        assert!(gate(&[]).blocked_host("noaa-mrms-pds.s3.amazonaws.com").is_none());
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://a.b.c:8443/x?y=1"), "a.b.c");
        assert_eq!(host_of("http://user:p@a.b/x"), "a.b");
        assert_eq!(host_of("a.b/x"), "a.b");
    }

    #[test]
    fn tables_point_at_real_sources() {
        for (f, ds) in FEEDS {
            assert!(SOURCES.iter().any(|s| s.id == *ds), "{f} -> {ds}");
        }
        let mut ids: Vec<_> = SOURCES.iter().map(|s| s.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), SOURCES.len(), "duplicate source id");
    }

    #[test]
    fn layers_map_to_sources() {
        assert_eq!(grid_source("mrms", None, "mrms/cref"), Some("mrms"));
        assert_eq!(grid_source("model", Some("hrrrsub"), "x"), Some("hrrr"));
        assert_eq!(grid_source("future", Some("gfswave"), "x"), Some("gfs"));
        assert_eq!(grid_source("model", Some("gefsens"), "x"), Some("gefs"));
        assert_eq!(grid_source("svr", None, "svr/rap/stp"), Some("rap"));
        assert_eq!(grid_source("mlpred", None, "mlpred/x"), None);
        assert_eq!(health_source("ovl-flights"), Some("flights"));
        assert_eq!(health_source("grid-mrms"), Some("mrms"));
        assert_eq!(health_source("intl-geomet_rain"), Some("eccc"));
        assert_eq!(health_source("intl-dwd"), Some("dwd"));
    }

    #[test]
    fn state_persists() {
        let d = std::env::temp_dir().join(format!("tbw-ds-test-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        let g = Gate::default();
        let radar = crate::config::RadarCfg::default();
        g.load(&d, &radar);
        assert!(g.is_on("mrms"));
        g.set("mrms", false).unwrap();
        let g2 = Gate::default();
        g2.load(&d, &radar);
        assert!(!g2.is_on("mrms"));
        g2.set("mrms", true).unwrap();
        let g3 = Gate::default();
        g3.load(&d, &radar);
        assert!(g3.is_on("mrms"));
        std::fs::remove_dir_all(&d).ok();
    }
}
