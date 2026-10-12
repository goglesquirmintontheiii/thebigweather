#![allow(dead_code)]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod admin;
mod alerts;
mod caches;
mod logbuf;
mod overlays;
mod platform;
mod share;
mod collab;
mod rules;
mod grid;
mod api;
mod config;
mod health;
mod hist;
mod ml;
mod hub;
mod intlradar;
mod radar;
mod recorder;
mod s3;
mod shake;
mod sites;
mod stats;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "tbw-server", version, about = "TheBigWeather data server")]
struct Cli {
    /// Config file (created on first run). Default: data/config.toml (Unix, relative to the
    /// working directory); on Windows <exe folder>\data\config.toml when writable, else
    /// %ProgramData%\TheBigWeather\data\config.toml. TBW_CONFIG / TBW_HOME override it.
    #[arg(short, long)]
    config: Option<PathBuf>,
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
    /// Run as a Windows service (started by the service manager; see start.ps1 -InstallService)
    Service,
    /// Local detection-model worker for the desktop app ("train / run on this computer"):
    /// the full server bound to 127.0.0.1:<port> with <data> as the data folder, no token for
    /// this machine and no NWS alert polling. Same /api/ml/* API as the main server.
    MlWorker {
        /// Data folder (config.toml, models, caches); created when missing
        #[arg(long)]
        data: PathBuf,
        /// Port on 127.0.0.1
        #[arg(long, default_value_t = 8790)]
        port: u16,
    },
}

fn main() -> anyhow::Result<()> {
    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;
        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn".into()))
            .with(tracing_subscriber::fmt::layer().with_target(false).with_ansi(std::env::var_os("NO_COLOR").is_none() && !cfg!(windows)))
            .with(logbuf::RingLayer)
            .init();
    }
    let mut cli = Cli::parse();
    if let Some(Cmd::MlWorker { data, .. }) = &cli.cmd {
        if cli.config.is_none() {
            std::fs::create_dir_all(data).ok();
            cli.config = Some(data.join("config.toml"));
        }
    }
    let config = cli.config.clone().unwrap_or_else(platform::default_config);
    cli.config = Some(config);
    if matches!(cli.cmd, Some(Cmd::Service)) {
        #[cfg(windows)]
        {
            let cli = Arc::new(parking_lot::Mutex::new(Some(cli)));
            return platform::service::start(Box::new(move || {
                let c = cli.lock().take().ok_or_else(|| anyhow::anyhow!("service already ran"))?;
                // the service manager starts us in System32: work from the config's folder
                if let Some(root) = cfg_path(&c).parent().and_then(|p| p.parent()) {
                    std::env::set_current_dir(root).ok();
                }
                serve(c, true)
            }));
        }
        #[cfg(not(windows))]
        anyhow::bail!("`service` is for Windows; on Linux use the systemd unit from start.sh --install-service");
    }
    // Windows restarts inside the process: a new process would lose the console, the service
    // manager's handle, and the PID the desktop app watches.
    serve(cli, cfg!(windows))
}

fn cfg_path(cli: &Cli) -> &std::path::Path {
    cli.config.as_deref().unwrap_or(std::path::Path::new("data/config.toml"))
}

/// Load the config, build the runtime and run until stopped. A restart from Server settings
/// either re-executes the binary (Unix) or loops here (`in_process`).
fn serve(cli: Cli, in_process: bool) -> anyhow::Result<()> {
    loop {
        // the CPU share is needed before the async runtime exists
        let pre = config::Config::load(cfg_path(&cli))?;
        let prof = config::detect_profile(&pre);
        let mut rt = tokio::runtime::Builder::new_multi_thread();
        rt.enable_all().worker_threads(prof.cpu_threads.max(1));
        if prof.cpu_percent < 100 {
            // blocking pool also serves file I/O, so leave it some slack over the decode limit
            rt.max_blocking_threads((prof.cpu_threads * 2).max(4));
        }
        let rt = rt.build()?;
        let res = rt.block_on(run(&cli, pre));
        rt.shutdown_timeout(std::time::Duration::from_secs(5));
        match res {
            Ok(true) if in_process && !platform::stop_requested() => {
                tracing::info!("restarting in this process");
                admin::reset_restart();
                continue;
            }
            Ok(true) => return admin::reexec(),
            Ok(false) => return Ok(()),
            Err(e) => return Err(e),
        }
    }
}

/// Runs the server; Ok(true) means "restart requested".
async fn run(cli: &Cli, cfg: config::Config) -> anyhow::Result<bool> {
    let mut cfg = cfg;
    match cli.cmd.as_ref().unwrap_or(&Cmd::Run) {
        Cmd::Token => {
            println!("{}", cfg.server.token);
            return Ok(false);
        }
        Cmd::NewToken => {
            cfg.server.token = config::new_token();
            cfg.save(cfg_path(cli))?;
            println!("{}", cfg.server.token);
            return Ok(false);
        }
        Cmd::Profile => {
            println!("{}", serde_json::to_string_pretty(&config::detect_profile(&cfg))?);
            return Ok(false);
        }
        Cmd::Inspect { files } => return inspect(files).map(|_| false),
        Cmd::MlWorker { data, port } => {
            // in-memory overrides only (the worker's config file keeps its own values)
            let data = if data.is_absolute() { data.clone() } else { std::env::current_dir()?.join(data) };
            cfg.server.data_dir = data;
            cfg.server.bind = format!("127.0.0.1:{port}");
            cfg.server.local_no_auth = true;
            cfg.alerts.enabled = false;
            cfg.ml.enabled = true;
            if cfg.server.name == "TheBigWeather" {
                cfg.server.name = "TheBigWeather ML worker".into();
            }
        }
        Cmd::Run | Cmd::Camdb | Cmd::Service => {}
    }

    // Resolve paths relative to the config file's directory's parent (the server root)
    let root = cfg_path(cli).parent().and_then(|p| p.parent()).map(|p| p.to_path_buf()).unwrap_or_default();
    let abs = |p: &PathBuf| if p.is_absolute() { p.clone() } else { root.join(p) };
    if let Some(Cmd::Camdb) = cli.cmd.as_ref() {
        let data = abs(&cfg.server.data_dir);
        std::fs::remove_file(data.join("cache/camdb.json.zst")).ok();
        match overlays::camdb::load(&data)? {
            Some(db) => println!("{}", serde_json::to_string_pretty(&db.stats)?),
            None => println!("No camera file found in {}", data.join("uploads").display()),
        }
        return Ok(false);
    }
    let data_dir = abs(&cfg.server.data_dir);
    std::fs::create_dir_all(&data_dir)?;
    config::set_paths(config::Paths {
        config: platform::canon(cfg_path(cli)),
        data: platform::canon(&data_dir),
        cache: data_dir.join("cache"),
        web: platform::find_web_dir(&abs(&cfg.server.web_dir)),
    });
    admin::set_args(std::env::args_os().collect());

    let profile = config::detect_profile(&cfg);
    tracing::info!(
        "profile: {} ({} cores, {} GB RAM, cpu {}% = {} threads) -> {} decode threads, {} MB cache (grid {} / radar {} / other {})",
        profile.name, profile.cores, profile.ram_gb, profile.cpu_percent, profile.cpu_threads, profile.threads, profile.memory_mb,
        profile.budget.grid_mb, profile.budget.radar_mb, profile.budget.other_mb
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
    let disk_cap = disk_cap_bytes(cfg.profile.disk_cache_mb, &data_dir);
    tracing::info!("raw cache cap: {} GB", disk_cap / (1 << 30));

    let grids = grid::service::GridService::new(http.clone(), health.clone(), &data_dir, profile.budget.grid_mb, profile.threads, profile.name == "full");
    grids.metar_archive.configure(&cfg.grid, profile.budget.other_mb);
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
        profile.budget.radar_mb,
        profile.threads,
        disk_cap,
        health.clone(),
    ));
    radar.spawn_cache_janitor();
    radar.odim.spawn();

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
    // TBW_NO_STATS=1 skips the system stats sampler (Wine lacks some PDH calls sysinfo uses)
    if std::env::var_os("TBW_NO_STATS").is_none() {
        stats::spawn(hub.clone(), data_dir.clone(), profile.stats_interval_ms, stats_latest.clone());
    }

    // detection models: data access shares the radar / grid services; sites come from AppState
    let ml_state: Arc<std::sync::OnceLock<std::sync::Weak<api::AppState>>> = Arc::new(std::sync::OnceLock::new());
    let ml = {
        let s = ml_state.clone();
        let sites_fn: Box<dyn Fn() -> Vec<sites::Site> + Send + Sync> = Box::new(move || s.get().and_then(|w| w.upgrade()).map(|st| st.sites.read().clone()).unwrap_or_else(sites::embedded));
        let net = ml::source::NetSource::new(http.clone(), radar.clone(), grids.clone(), cfg.radar.chunk_buckets.clone(), &data_dir, profile.budget.other_mb / 4, profile.threads.div_ceil(2).max(1), sites_fn);
        ml::Ml::new(&cfg.ml, &data_dir, Arc::new(net), Some(hub.clone()), profile.name == "full", profile.budget.radar_mb)
    };

    let bind = cfg.server.bind.clone();
    let other_mb = profile.budget.other_mb;
    let profile_full = profile.name == "full";
    let state = Arc::new(api::AppState {
        cfg: parking_lot::RwLock::new(cfg.clone()),
        cfg_path: cfg_path(cli).to_path_buf(),
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
        intl: {
            let i = intlradar::IntlRadar::new(http.clone(), health.clone());
            i.set_budget(other_mb);
            i
        },
        rec: recorder::Recorder::new(&data_dir, profile_full),
        shares: share::Shares::new(&data_dir),
        collab: collab::Collab::new(&data_dir),
        rules: rules::Rules::new(&data_dir),
        overlays: {
            let o = overlays::Overlays::new(http.clone(), health.clone(), &data_dir, grids, profile_full);
            *o.fixtures.write() = cli.overlay_fixtures.clone();
            o
        },
        ml: ml.clone(),
    });
    ml_state.set(Arc::downgrade(&state)).ok();
    ml.spawn();

    recorder::spawn(state.clone());
    collab::spawn_janitor(state.collab.clone());
    share::spawn_janitor(state.shares.clone());

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

    let collab = state.collab.clone();
    let app = api::router(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{bind}");
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let server = axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).with_graceful_shutdown(async move {
        shutdown().await;
        let _ = stop_tx.send(true);
    });
    // open WebSockets would hold a graceful shutdown forever: give connections a few seconds
    tokio::select! {
        r = server => r?,
        _ = async {
            let _ = stop_rx.wait_for(|v| *v).await;
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        } => {}
    }
    // rooms are saved every 30 s; don't lose the last changes on shutdown/restart
    collab.save();
    Ok(admin::restart_requested())
}

async fn shutdown() {
    let restart = admin::restart_signal();
    tokio::select! { _ = platform::shutdown_signal() => {}, _ = restart => {} }
    tracing::info!("shutting down{}", if admin::restart_requested() { " for restart" } else { "" });
}

/// Raw download cache cap: configured MB, or 20% of free disk (1-50 GB).
pub fn disk_cap_bytes(mb: u64, data_dir: &std::path::Path) -> u64 {
    if mb > 0 {
        mb * 1024 * 1024
    } else {
        (free_space(data_dir) / 5).clamp(1 << 30, 50 << 30)
    }
}

fn free_space(p: &std::path::Path) -> u64 {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let p = platform::canon(p);
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
