#![allow(dead_code)]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod alerts;
mod overlays;
mod grid;
mod api;
mod config;
mod health;
mod hub;
mod radar;
mod s3;
mod sites;
mod stats;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "tbw-server", version, about = "TheBigWeather data server")]
struct Cli {
    /// Config file (created on first run)
    #[arg(short, long, default_value = "data/config.toml")]
    config: PathBuf,
    /// Replay a folder of Level II chunk files as a live site (offline RapidSweep testing)
    #[arg(long)]
    replay_dir: Option<PathBuf>,
    /// Site id used for --replay-dir
    #[arg(long, default_value = "KTLX")]
    replay_site: String,
    /// Delay between replayed chunks (ms)
    #[arg(long, default_value_t = 1000)]
    replay_ms: u64,
    /// Load alerts from a GeoJSON file instead of only polling NWS (testing)
    #[arg(long)]
    alerts_fixture: Option<PathBuf>,
    /// Seed METAR observations from a local metars.cache.csv (testing)
    #[arg(long)]
    metar_fixture: Option<PathBuf>,
    /// Folder of local gridded files used as frames ("<layer id with / as _>__<name>")
    #[arg(long)]
    grid_dir: Option<PathBuf>,
    /// Folder of overlay fixtures ("<overlay id>.json") served instead of live feeds (testing)
    #[arg(long)]
    overlay_fixtures: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the server (default)
    Run,
    /// Print the access token and exit
    Token,
    /// Generate a new access token and exit
    NewToken,
    /// Print hardware profile and exit
    Profile,
    /// Decode radar files and print a summary
    Inspect { files: Vec<PathBuf> },
    /// (Re)build the camera database from data/uploads and print what was kept
    Camdb,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn".into()))
        .with_target(false)
        .init();
    let cli = Cli::parse();
    let mut cfg = config::Config::load(&cli.config)?;
    match cli.cmd.as_ref().unwrap_or(&Cmd::Run) {
        Cmd::Token => {
            println!("{}", cfg.server.token);
            return Ok(());
        }
        Cmd::NewToken => {
            cfg.server.token = config::new_token();
            cfg.save(&cli.config)?;
            println!("{}", cfg.server.token);
            return Ok(());
        }
        Cmd::Profile => {
            println!("{}", serde_json::to_string_pretty(&config::detect_profile(&cfg))?);
            return Ok(());
        }
        Cmd::Inspect { files } => return inspect(files),
        Cmd::Run | Cmd::Camdb => {}
    }

    // Resolve paths relative to the config file's directory's parent (the server root)
    let root = cli.config.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf()).unwrap_or_default();
    let abs = |p: &PathBuf| if p.is_absolute() { p.clone() } else { root.join(p) };
    if let Some(Cmd::Camdb) = cli.cmd.as_ref() {
        let data = abs(&cfg.server.data_dir);
        std::fs::remove_file(data.join("cache/camdb.json.zst")).ok();
        match overlays::camdb::load(&data)? {
            Some(db) => println!("{}", serde_json::to_string_pretty(&db.stats)?),
            None => println!("No camera file found in {}", data.join("uploads").display()),
        }
        return Ok(());
    }
    let data_dir = abs(&cfg.server.data_dir);
    cfg.server.web_dir = abs(&cfg.server.web_dir);
    std::fs::create_dir_all(&data_dir)?;

    let profile = config::detect_profile(&cfg);
    tracing::info!(
        "profile: {} ({} cores, {} GB RAM) -> {} decode threads, {} MB cache",
        profile.name, profile.cores, profile.ram_gb, profile.threads, profile.memory_mb
    );
    rayon::ThreadPoolBuilder::new().num_threads(profile.threads).build_global().ok();

    let http = reqwest::Client::builder()
        .user_agent(cfg.alerts.user_agent.clone())
        .timeout(std::time::Duration::from_secs(60))
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(16)
        .build()?;

    let hub = hub::Hub::new();
    let health = Arc::new(health::Health::new(hub.clone()));

    // disk cache cap
    let disk_cap = if cfg.profile.disk_cache_mb > 0 {
        cfg.profile.disk_cache_mb * 1024 * 1024
    } else {
        let free = free_space(&data_dir);
        (free / 5).clamp(1 << 30, 50 << 30)
    };
    tracing::info!("raw cache cap: {} GB", disk_cap / (1 << 30));

    let grids = grid::service::GridService::new(http.clone(), health.clone(), &data_dir, profile.memory_mb * 55 / 100, profile.threads, profile.name == "full");
    *grids.local_dir.write() = cli.grid_dir.clone();
    if let Some(f) = &cli.metar_fixture {
        grids.load_metar_fixture(&std::fs::read(f)?)?;
    } else {
        grids.spawn_metar(cfg.server.metar_url.clone());
    }

    let radar = Arc::new(radar::service::RadarService::new(
        http.clone(),
        &cfg.radar,
        &data_dir,
        profile.memory_mb * 45 / 100,
        profile.threads,
        disk_cap,
        health.clone(),
    ));
    radar.spawn_cache_janitor();

    let replay = cli.replay_dir.clone().map(|dir| radar::live::ReplayCfg {
        site: cli.replay_site.to_ascii_uppercase(),
        dir,
        interval_ms: cli.replay_ms,
    });
    let live = radar::live::LiveManager::new(
        http.clone(),
        cfg.radar.chunk_buckets.clone(),
        health.clone(),
        hub.clone(),
        profile.live_poll_secs,
        profile.max_live_sites,
        cfg.radar.always_live.clone(),
        replay,
        if profile.name == "full" { 40 } else { 8 },
    );
    live.spawn();

    let alerts = alerts::Alerts::new(http.clone(), cfg.alerts.url.clone(), hub.clone(), health.clone(), &data_dir, profile.alert_poll_secs);
    if let Some(f) = &cli.alerts_fixture {
        alerts.load_fixture(f)?;
        tracing::info!("loaded alert fixture {}", f.display());
    }
    if cfg.alerts.enabled {
        alerts.spawn();
    } else {
        health.disabled("nws-alerts", "NWS alerts", "disabled in config");
    }

    // radar sites: cached file, embedded fallback, refresh in background
    let site_cache = data_dir.join("sites.json");
    let mut site_list = sites::embedded();
    if let Ok(s) = std::fs::read_to_string(&site_cache) {
        if let Ok(v) = serde_json::from_str::<Vec<sites::Site>>(&s) {
            if !v.is_empty() {
                site_list = v;
            }
        }
    }
    let stats_latest = Arc::new(parking_lot::RwLock::new(stats::Stats::default()));
    stats::spawn(hub.clone(), data_dir.clone(), profile.stats_interval_ms, stats_latest.clone());

    let bind = cfg.server.bind.clone();
    let profile_full = profile.name == "full";
    let state = Arc::new(api::AppState {
        cfg: parking_lot::RwLock::new(cfg.clone()),
        cfg_path: cli.config.clone(),
        profile,
        radar,
        live,
        alerts,
        hub,
        health: health.clone(),
        sites: parking_lot::RwLock::new(site_list),
        stats: stats_latest,
        started: std::time::Instant::now(),
        grids: grids.clone(),
        overlays: {
            let o = overlays::Overlays::new(http.clone(), health.clone(), &data_dir, grids, profile_full);
            *o.fixtures.write() = cli.overlay_fixtures.clone();
            o
        },
    });

    {
        let st = state.clone();
        let url = cfg.radar.sites_url.clone();
        let http = http.clone();
        tokio::spawn(async move {
            match http.get(&url).send().await.and_then(|r| r.error_for_status()) {
                Ok(r) => {
                    if let Ok(t) = r.text().await {
                        let fresh = sites::parse_homr(&t);
                        if fresh.len() > 100 {
                            let merged = sites::merge(sites::embedded(), fresh);
                            let _ = std::fs::write(&site_cache, serde_json::to_string(&merged).unwrap_or_default());
                            *st.sites.write() = merged;
                            st.health.ok("site-table", "Radar site table", "NCEI HOMR");
                        }
                    }
                }
                Err(e) => st.health.err("site-table", "Radar site table", e),
            }
        });
    }

    let app = api::router(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    ctrl_c.await.ok();
    tracing::info!("shutting down");
}

fn free_space(p: &std::path::Path) -> u64 {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let p = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    disks
        .list()
        .iter()
        .filter(|d| p.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
        .unwrap_or(10 << 30)
}

fn inspect(files: &[PathBuf]) -> anyhow::Result<()> {
    use radar::level2::*;
    let mut d = Decoder::new();
    for f in files {
        let b = std::fs::read(f)?;
        if b.len() > 30 && (b.starts_with(b"SDUS") || b.starts_with(b"NXUS")) {
            let p = radar::level3::decode(&b)?;
            println!("{}: L3 code {} {} el {} gates {}x{}m radials {}", f.display(), p.code, p.awips, p.elevation, p.ngates, p.gate_m, p.radials.len());
            continue;
        }
        d.feed(&b)?;
    }
    d.finish();
    let v = &d.vol;
    if v.sweeps.is_empty() {
        return Ok(());
    }
    println!("site {} {} vcp {} at {},{} sweeps {} complete {}", v.site, v.version, v.vcp, v.lat, v.lon, v.sweeps.len(), v.complete);
    for t in tilts(v) {
        println!("  tilt {:2} {:5.1}°  {:?}", t.index, t.angle, t.sweeps.keys().collect::<Vec<_>>());
    }
    Ok(())
}
