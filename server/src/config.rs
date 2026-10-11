//! Server configuration (TOML) and hardware profile detection.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerCfg,
    pub profile: ProfileCfg,
    pub radar: RadarCfg,
    pub alerts: AlertsCfg,
    pub keys: Keys,
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
    /// worker threads for decoding; 0 = auto (~60% of cores)
    pub threads: usize,
    /// decoded-volume memory budget MB; 0 = auto
    pub memory_mb: usize,
    /// raw download cache on disk MB; 0 = auto (sized from free disk)
    pub disk_cache_mb: u64,
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
}

impl Keys {
    pub const NAMES: [&'static str; 11] = [
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
        Self { mode: "auto".into(), threads: 0, memory_mb: 0, disk_cache_mb: 0 }
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
            alerts: AlertsCfg::default(),
            keys: Keys::default(),
        }
    }
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
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).ok();
        }
        let body = toml::to_string_pretty(self)?;
        let header = "# TheBigWeather server config. Edit and restart, or change keys from the app.\n\n";
        std::fs::write(path, format!("{header}{body}"))?;
        Ok(())
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
    pub threads: usize,
    pub memory_mb: usize,
    pub max_live_sites: usize,
    pub live_poll_secs: u64,
    pub alert_poll_secs: u64,
    pub stats_interval_ms: u64,
}

pub fn detect_profile(cfg: &Config) -> Profile {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let ram_gb = sys.total_memory() as f64 / 1e9;
    let full = match cfg.profile.mode.as_str() {
        "full" => true,
        "lite" => false,
        _ => cores >= 8 && ram_gb >= 24.0,
    };
    let threads = if cfg.profile.threads > 0 {
        cfg.profile.threads
    } else if full {
        ((cores as f64) * 0.6).round().max(2.0) as usize
    } else {
        (cores / 2).max(1)
    };
    let memory_mb = if cfg.profile.memory_mb > 0 {
        cfg.profile.memory_mb
    } else if full {
        ((ram_gb * 1000.0 * 0.10) as usize).clamp(2048, 12_000)
    } else {
        ((ram_gb * 1000.0 * 0.08) as usize).clamp(384, 1536)
    };
    Profile {
        name: if full { "full" } else { "lite" },
        cores,
        ram_gb: (ram_gb * 10.0).round() / 10.0,
        threads,
        memory_mb,
        max_live_sites: if cfg.radar.max_live_sites > 0 { cfg.radar.max_live_sites } else if full { 8 } else { 2 },
        live_poll_secs: if cfg.radar.live_poll_secs > 0 { cfg.radar.live_poll_secs } else if full { 3 } else { 8 },
        alert_poll_secs: if cfg.alerts.poll_secs > 0 { cfg.alerts.poll_secs } else if full { 30 } else { 60 },
        stats_interval_ms: if full { 1500 } else { 3000 },
    }
}
