//! Server configuration (TOML) and hardware profile detection.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerCfg,
    pub profile: ProfileCfg,
    pub radar: RadarCfg,
    pub grid: GridCfg,
    pub alerts: AlertsCfg,
    pub keys: Keys,
    pub ml: MlCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCfg {
    /// Listen address. Behind Caddy use 127.0.0.1; for LAN use 0.0.0.0.
    pub bind: String,
    /// Access token required by apps.
    pub token: String,
    /// Where caches, zone shapes and uploads live.
    pub data_dir: PathBuf,
    /// Public URL shown to apps (e.g. https://wx.example.com)
    pub public_url: String,
    /// Directory with the built desktop UI, served at / for browser access.
    pub web_dir: PathBuf,
    /// Name shown in the app's server list
    pub name: String,
    /// Skip the token for apps running on this same machine (not applied to proxied requests)
    pub local_no_auth: bool,
    /// METAR bulk file (aviationweather.gov cache)
    pub metar_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfileCfg {
    /// auto | full | lite
    pub mode: String,
    /// worker threads for decoding; 0 = auto (~60% of cores on full, half on lite)
    pub threads: usize,
    /// in-memory cache budget MB; 0 = auto (40% of RAM, at least 4 GB, never above 85% of RAM)
    pub memory_mb: usize,
    /// raw download cache on disk MB; 0 = auto (sized from free disk)
    pub disk_cache_mb: u64,
    /// share of CPU cores the server may keep busy (1-100). Caps decode threads, the
    /// rayon pool, tokio workers and concurrent decodes; min 1 thread.
    pub cpu_percent: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GridCfg {
    /// Iowa Environmental Mesonet ASOS/METAR archive (METAR layers in history mode)
    pub metar_archive_url: String,
    /// disk cap for archived METAR hours (MB); 0 = auto (512)
    pub metar_archive_disk_mb: u64,
}

impl Default for GridCfg {
    fn default() -> Self {
        Self { metar_archive_url: "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py".into(), metar_archive_disk_mb: 0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RadarCfg {
    pub level2_buckets: Vec<String>,
    pub chunk_buckets: Vec<String>,
    pub level3_buckets: Vec<String>,
    pub tgftp_base: String,
    /// Sites kept live all the time (chunks streamed even with no app open)
    pub always_live: Vec<String>,
    /// Max sites streaming live at once; 0 = auto (full 8, lite 2)
    pub max_live_sites: usize,
    /// Chunk poll interval seconds; 0 = auto (full 3, lite 8)
    pub live_poll_secs: u64,
    /// Optional folder of Level II files offered as extra history (case studies, offline use)
    pub local_archive_dir: String,
    /// Station table refreshed from NCEI HOMR at startup
    pub sites_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AlertsCfg {
    pub enabled: bool,
    pub poll_secs: u64,
    pub url: String,
    /// NWS asks for a contact in the User-Agent.
    pub user_agent: String,
}

/// Detection models (training jobs and live runs, `/api/ml/*`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MlCfg {
    /// Allow training and running detection models
    pub enabled: bool,
    /// Training jobs run at the same time (more are queued)
    pub max_jobs: usize,
    /// Radar volumes downloaded / processed at once while building a dataset; 0 = auto (full 4, lite 2)
    pub download_concurrency: usize,
    /// Radars processed at once when running models live; 0 = auto (full 3, lite 1)
    pub run_concurrency: usize,
    /// Disk cap for cached extracted samples (MB); 0 = auto (2048)
    pub cache_disk_mb: u64,
    /// Max grid points of one prediction layer (grid models are coarsened to fit); 0 = auto
    /// (full 400000, lite 150000)
    pub pred_max_points: usize,
}

impl Default for MlCfg {
    fn default() -> Self {
        Self { enabled: true, max_jobs: 1, download_concurrency: 0, run_concurrency: 0, cache_disk_mb: 0, pred_max_points: 0 }
    }
}

/// Optional API keys. Missing keys just disable that source.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Keys {
    pub google_maps: String,
    pub synoptic: String,
    pub airnow: String,
    pub aisstream: String,
    pub mping: String,
    pub spotter_network: String,
    pub eumetsat: String,
    pub kma: String,
    pub trafikverket: String,
    pub nsw_transport: String,
    pub trafficvision: String,
    /// TomTom traffic flow tiles (/api/traffic)
    pub tomtom: String,
}

impl Keys {
    pub const NAMES: [&'static str; 12] = [
        "google_maps",
        "synoptic",
        "airnow",
        "aisstream",
        "mping",
        "spotter_network",
        "eumetsat",
        "kma",
        "trafikverket",
        "nsw_transport",
        "trafficvision",
        "tomtom",
    ];
    pub fn get(&self, k: &str) -> Option<&String> {
        Some(match k {
            "google_maps" => &self.google_maps,
            "synoptic" => &self.synoptic,
            "airnow" => &self.airnow,
            "aisstream" => &self.aisstream,
            "mping" => &self.mping,
            "spotter_network" => &self.spotter_network,
            "eumetsat" => &self.eumetsat,
            "kma" => &self.kma,
            "trafikverket" => &self.trafikverket,
            "nsw_transport" => &self.nsw_transport,
            "trafficvision" => &self.trafficvision,
            "tomtom" => &self.tomtom,
            _ => return None,
        })
    }
    pub fn set(&mut self, k: &str, v: String) -> bool {
        let slot = match k {
            "google_maps" => &mut self.google_maps,
            "synoptic" => &mut self.synoptic,
            "airnow" => &mut self.airnow,
            "aisstream" => &mut self.aisstream,
            "mping" => &mut self.mping,
            "spotter_network" => &mut self.spotter_network,
            "eumetsat" => &mut self.eumetsat,
            "kma" => &mut self.kma,
            "trafikverket" => &mut self.trafikverket,
            "nsw_transport" => &mut self.nsw_transport,
            "trafficvision" => &mut self.trafficvision,
            "tomtom" => &mut self.tomtom,
            _ => return false,
        };
        *slot = v;
        true
    }
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0:8787".into(),
            token: String::new(),
            data_dir: PathBuf::from("data"),
            public_url: String::new(),
            web_dir: PathBuf::from("web"),
            name: "TheBigWeather".into(),
            local_no_auth: true,
            metar_url: "https://aviationweather.gov/data/cache/metars.cache.csv.gz".into(),
        }
    }
}
impl Default for ProfileCfg {
    fn default() -> Self {
        Self { mode: "auto".into(), threads: 0, memory_mb: 0, disk_cache_mb: 0, cpu_percent: 100 }
    }
}
impl Default for RadarCfg {
    fn default() -> Self {
        Self {
            level2_buckets: vec!["unidata-nexrad-level2".into(), "noaa-nexrad-level2".into()],
            chunk_buckets: vec!["unidata-nexrad-level2-chunks".into(), "noaa-nexrad-level2-chunks".into()],
            level3_buckets: vec!["unidata-nexrad-level3".into(), "noaa-nexrad-level3".into()],
            tgftp_base: "https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar".into(),
            always_live: vec![],
            max_live_sites: 0,
            live_poll_secs: 0,
            local_archive_dir: String::new(),
            sites_url: "https://www.ncei.noaa.gov/access/homr/file/nexrad-stations.txt".into(),
        }
    }
}
impl Default for AlertsCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            poll_secs: 0,
            url: "https://api.weather.gov/alerts/active?status=actual".into(),
            user_agent: "TheBigWeather/0.1 (self-hosted weather app)".into(),
        }
    }
}
impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerCfg::default(),
            profile: ProfileCfg::default(),
            radar: RadarCfg::default(),
            grid: GridCfg::default(),
            alerts: AlertsCfg::default(),
            keys: Keys::default(),
            ml: MlCfg::default(),
        }
    }
}

/// Commented template written on first run; values are then filled in from `Config`.
pub const TEMPLATE: &str = r#"# TheBigWeather server config.
# Edit and restart, or change settings from the app (Settings -> Server settings on this computer).
# Comments and layout here are kept when the app saves changes.

[server]
# Listen address. Behind Caddy use 127.0.0.1:8787; for LAN use 0.0.0.0:8787. (restart)
bind = "0.0.0.0:8787"
# Access token required by apps (regenerate with `tbw-server new-token` or from the app).
token = ""
# Where caches, zone shapes, recordings and uploads live. (restart)
data_dir = "data"
# Public URL shown to apps (e.g. https://wx.example.com)
public_url = ""
# Built desktop UI served at / for browser access. (restart)
web_dir = "web"
# Name shown in the app's server list
name = "TheBigWeather"
# Apps on this same machine need no token (never applied to proxied requests)
local_no_auth = true
# Latest METARs (aviationweather.gov bulk cache). (restart)
metar_url = "https://aviationweather.gov/data/cache/metars.cache.csv.gz"

[profile]
# auto | full | lite  (auto = full with >= 8 cores and >= 24 GB RAM). (restart)
mode = "auto"
# Decode worker threads; 0 = auto (~60% of cores on full, half on lite). (restart)
threads = 0
# In-memory cache budget in MB; 0 = auto: 40% of RAM, at least 4 GB, never above 85% of RAM.
# Split: ~50% gridded data, ~40% radar, ~10% other (images, archives). Applied live.
memory_mb = 0
# Raw download cache on disk in MB; 0 = auto (20% of free disk, 1-50 GB). Applied live.
disk_cache_mb = 0
# Share of CPU cores the server may use (1-100). Caps decode threads, the rayon pool,
# tokio workers and concurrent decodes (min 1). Decode limits apply live; pools on restart.
cpu_percent = 100

[radar]
level2_buckets = ["unidata-nexrad-level2", "noaa-nexrad-level2"]
chunk_buckets = ["unidata-nexrad-level2-chunks", "noaa-nexrad-level2-chunks"]
level3_buckets = ["unidata-nexrad-level3", "noaa-nexrad-level3"]
tgftp_base = "https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar"
# Sites kept live all the time (chunks streamed even with no app open)
always_live = []
# Max sites streaming live at once; 0 = auto (full 8, lite 2)
max_live_sites = 0
# Chunk poll interval seconds; 0 = auto (full 3, lite 8)
live_poll_secs = 0
# Optional folder of Level II files offered as extra history (case studies, offline use)
local_archive_dir = ""
# Station table refreshed from NCEI HOMR at startup
sites_url = "https://www.ncei.noaa.gov/access/homr/file/nexrad-stations.txt"

[grid]
# Archived METARs for history mode (Iowa Environmental Mesonet ASOS/METAR archive)
metar_archive_url = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
# Disk cap for cached archive hours in MB; 0 = auto (512)
metar_archive_disk_mb = 0

[alerts]
enabled = true
# 0 = auto (full 30 s, lite 60 s)
poll_secs = 0
url = "https://api.weather.gov/alerts/active?status=actual"
# NWS asks for a contact in the User-Agent.
user_agent = "TheBigWeather/0.1 (self-hosted weather app)"

[ml]
# Detection models: train on historical radar / gridded data and run them live
enabled = true
# Training jobs at the same time (more are queued)
max_jobs = 1
# Radar volumes processed at once while building a training set; 0 = auto (full 4, lite 2)
download_concurrency = 0
# Radars processed at once when running models live; 0 = auto (full 3, lite 1)
run_concurrency = 0
# Disk cap for cached extracted samples in MB; 0 = auto (2048)
cache_disk_mb = 0
# Max grid points of one model prediction layer (coarsened to fit); 0 = auto (full 400000, lite 150000)
pred_max_points = 0

# Optional API keys. Missing keys just disable that source.
[keys]
google_maps = ""
synoptic = ""
airnow = ""
aisstream = ""
mping = ""
spotter_network = ""
eumetsat = ""
kma = ""
trafikverket = ""
nsw_transport = ""
trafficvision = ""
tomtom = ""
"#;

/// Resolved file locations (set once at startup).
#[derive(Debug, Clone, Default, Serialize)]
pub struct Paths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub web: PathBuf,
}

// a lock rather than a once-cell: an in-process restart (Windows) may move the data folder
static PATHS: parking_lot::RwLock<Option<Paths>> = parking_lot::RwLock::new(None);

pub fn set_paths(p: Paths) {
    *PATHS.write() = Some(p);
}
pub fn paths() -> Paths {
    PATHS.read().clone().unwrap_or_default()
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Config> {
        if !path.exists() {
            let mut c = Config::default();
            c.server.token = new_token();
            c.save(path)?;
            tracing::info!("created new config at {}", path.display());
            return Ok(c);
        }
        let s = std::fs::read_to_string(path)?;
        let mut c: Config = toml::from_str(&s)?;
        if c.server.token.trim().is_empty() {
            c.server.token = new_token();
            c.save(path)?;
        }
        Ok(c)
    }

    /// Write the config, keeping comments, ordering and unknown keys of the existing file
    /// (or the commented template for a new file). Only values that changed are rewritten.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).ok();
        }
        let existing = std::fs::read_to_string(path).unwrap_or_else(|_| TEMPLATE.to_string());
        let out = self.merge_into(&existing)?;
        crate::platform::write_atomic(path, out.as_bytes())?;
        Ok(())
    }

    /// `existing` TOML text with this config's values merged in (formatting preserved).
    pub fn merge_into(&self, existing: &str) -> anyhow::Result<String> {
        let mut doc: toml_edit::DocumentMut = existing.parse().or_else(|_| TEMPLATE.parse())?;
        let new: toml_edit::DocumentMut = toml::to_string(self)?.parse()?;
        merge_table(doc.as_table_mut(), new.as_table());
        Ok(doc.to_string())
    }
}

/// Same TOML value ignoring formatting.
fn same_value(a: &toml_edit::Value, b: &toml_edit::Value) -> bool {
    let p = |v: &toml_edit::Value| toml::from_str::<toml::Table>(&format!("x = {}", v.to_string().trim())).ok();
    match (p(a), p(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn merge_table(dst: &mut toml_edit::Table, src: &toml_edit::Table) {
    for (k, sv) in src.iter() {
        match dst.get_mut(k) {
            Some(dv) if dv.is_table() && sv.is_table() => merge_table(dv.as_table_mut().unwrap(), sv.as_table().unwrap()),
            Some(toml_edit::Item::Value(dv)) if sv.is_value() => {
                let svv = sv.as_value().unwrap();
                if !same_value(dv, svv) {
                    let decor = dv.decor().clone();
                    *dv = svv.clone();
                    *dv.decor_mut() = decor;
                }
            }
            _ => {
                dst.insert(k, sv.clone());
            }
        }
    }
}

pub fn new_token() -> String {
    let b: [u8; 24] = rand::random();
    hex::encode(b)
}

#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub name: &'static str,
    pub cores: usize,
    pub ram_gb: f64,
    pub ram_mb: u64,
    pub threads: usize,
    /// CPU share in use (1-100) and the thread cap it gives
    pub cpu_percent: u32,
    pub cpu_threads: usize,
    pub memory_mb: usize,
    pub budget: Budget,
    pub max_live_sites: usize,
    pub live_poll_secs: u64,
    pub alert_poll_secs: u64,
    pub stats_interval_ms: u64,
}

/// How the memory budget is split between the cache groups (MB).
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Budget {
    /// decoded grids, RGB composites, MRMS cubes, wind fields
    pub grid_mb: usize,
    /// decoded radar volumes, encoded sweeps, 3D volumes, rotation products
    pub radar_mb: usize,
    /// international radar images, archived METAR hours
    pub other_mb: usize,
}

impl Budget {
    pub fn split(total_mb: usize) -> Budget {
        let grid_mb = total_mb * 50 / 100;
        let radar_mb = total_mb * 40 / 100;
        Budget { grid_mb, radar_mb, other_mb: total_mb - grid_mb - radar_mb }
    }
}

/// Default memory budget: 40% of RAM, at least 4 GB, but never more than 85% of RAM.
pub fn default_memory_mb(ram_mb: u64) -> usize {
    let v = (ram_mb * 40 / 100).max(4096);
    let ceiling = (ram_mb * 85 / 100).max(256);
    v.min(ceiling) as usize
}

/// Threads allowed by a CPU share (min 1).
pub fn cpu_cap(cores: usize, percent: u32) -> usize {
    ((cores as f64 * percent.clamp(1, 100) as f64 / 100.0).floor() as usize).max(1)
}

pub fn total_ram_mb() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory() / (1024 * 1024)
}

pub fn detect_profile(cfg: &Config) -> Profile {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let ram_mb = total_ram_mb();
    let ram_gb = ram_mb as f64 / 1024.0;
    let full = match cfg.profile.mode.as_str() {
        "full" => true,
        "lite" => false,
        _ => cores >= 8 && ram_gb >= 24.0,
    };
    let cpu_percent = cfg.profile.cpu_percent.clamp(1, 100);
    let cpu_threads = cpu_cap(cores, cpu_percent);
    let threads = if cfg.profile.threads > 0 {
        cfg.profile.threads
    } else if full {
        ((cores as f64) * 0.6).round().max(2.0) as usize
    } else {
        (cores / 2).max(1)
    }
    .min(cpu_threads)
    .max(1);
    let memory_mb = if cfg.profile.memory_mb > 0 { cfg.profile.memory_mb } else { default_memory_mb(ram_mb) };
    Profile {
        name: if full { "full" } else { "lite" },
        cores,
        ram_gb: (ram_gb * 10.0).round() / 10.0,
        ram_mb,
        threads,
        cpu_percent,
        cpu_threads,
        memory_mb,
        budget: Budget::split(memory_mb),
        max_live_sites: if cfg.radar.max_live_sites > 0 { cfg.radar.max_live_sites } else if full { 8 } else { 2 },
        live_poll_secs: if cfg.radar.live_poll_secs > 0 { cfg.radar.live_poll_secs } else if full { 3 } else { 8 },
        alert_poll_secs: if cfg.alerts.poll_secs > 0 { cfg.alerts.poll_secs } else if full { 30 } else { 60 },
        stats_interval_ms: if full { 1500 } else { 3000 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_defaults() {
        // 8 GB: 40% = 3.2 GB -> raised to the 4 GB floor
        assert_eq!(default_memory_mb(8192), 4096);
        // 64 GB: 40%
        assert_eq!(default_memory_mb(65536), 26214);
        // 2 GB machine: 4 GB floor is capped at 85% of RAM
        assert_eq!(default_memory_mb(2048), 1740);
        let b = Budget::split(10_000);
        assert_eq!(b.grid_mb + b.radar_mb + b.other_mb, 10_000);
        assert_eq!(cpu_cap(8, 50), 4);
        assert_eq!(cpu_cap(2, 10), 1);
        assert_eq!(cpu_cap(16, 100), 16);
    }

    #[test]
    fn save_keeps_comments_and_layout() {
        let existing = "# my header\n\n[server]\n# where to listen\nbind = \"0.0.0.0:8899\"   # trailing note\nname = \"Home\"\nextra_unknown = 5\n\n[radar]\nlevel2_buckets = [\n    \"a\",\n    \"b\",\n]\n";
        let mut c: Config = toml::from_str(existing).unwrap();
        assert_eq!(c.server.bind, "0.0.0.0:8899");
        c.radar.level2_buckets = vec!["a".into(), "b".into()];
        c.server.name = "Cabin".into();
        c.profile.cpu_percent = 50;
        let out = c.merge_into(existing).unwrap();
        assert!(out.starts_with("# my header\n"), "{out}");
        assert!(out.contains("# where to listen\nbind = \"0.0.0.0:8899\"   # trailing note"), "{out}");
        assert!(out.contains("name = \"Cabin\""), "{out}");
        assert!(out.contains("extra_unknown = 5"));
        // unchanged multi-line array kept as written
        assert!(out.contains("level2_buckets = [\n    \"a\",\n    \"b\",\n]"), "{out}");
        assert!(out.contains("cpu_percent = 50"));
        let back: Config = toml::from_str(&out).unwrap();
        assert_eq!(back.profile.cpu_percent, 50);
        assert_eq!(back.server.name, "Cabin");
        // a second save is a no-op
        assert_eq!(back.merge_into(&out).unwrap(), out);
    }

    #[test]
    fn template_matches_defaults() {
        let c: Config = toml::from_str(TEMPLATE).unwrap();
        let d = Config::default();
        assert_eq!(serde_json::to_value(&c.profile).unwrap(), serde_json::to_value(&d.profile).unwrap());
        assert_eq!(serde_json::to_value(&c.radar).unwrap(), serde_json::to_value(&d.radar).unwrap());
        assert_eq!(serde_json::to_value(&c.grid).unwrap(), serde_json::to_value(&d.grid).unwrap());
        assert_eq!(serde_json::to_value(&c.ml).unwrap(), serde_json::to_value(&d.ml).unwrap());
        let out = d.merge_into(TEMPLATE).unwrap();
        assert!(out.contains("# Share of CPU cores"));
    }
}
