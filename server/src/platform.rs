//! Platform glue: default paths, helper tools (ffmpeg / yt-dlp), shutdown signals, and the
//! Windows service entry point. Everything OS-specific lives here so the rest stays portable.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set when the server should stop (Windows service stop, console close).
static STOP: tokio::sync::Notify = tokio::sync::Notify::const_new();
static STOPPING: AtomicBool = AtomicBool::new(false);

/// Ask a running server to shut down (service control handler, tests).
pub fn request_stop() {
    STOPPING.store(true, Ordering::SeqCst);
    STOP.notify_waiters();
    STOP.notify_one();
}
pub fn stop_requested() -> bool {
    STOPPING.load(Ordering::SeqCst)
}

/// Resolves on Ctrl+C, SIGTERM (Unix), console close / logoff / shutdown (Windows) or a service stop.
pub async fn shutdown_signal() {
    if stop_requested() {
        return;
    }
    let stop = STOP.notified();
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {}, _ = stop => {} }
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        // these can fail when there is no console (service, GUI child): just don't wait on them
        let close = async {
            match windows::ctrl_close() {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        let shut = async {
            match windows::ctrl_shutdown() {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        let brk = async {
            match windows::ctrl_break() {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        tokio::select! { _ = ctrl_c => {}, _ = close => {}, _ = shut => {}, _ = brk => {}, _ = stop => {} }
    }
    #[cfg(not(any(unix, windows)))]
    tokio::select! { _ = ctrl_c => {}, _ = stop => {} }
}

/// Folder holding the server executable.
pub fn exe_dir() -> Option<PathBuf> {
    let p = std::env::current_exe().ok()?;
    let s = p.to_string_lossy();
    let p = match s.strip_suffix(" (deleted)") {
        Some(x) => PathBuf::from(x),
        None => p,
    };
    p.parent().map(simplify)
}

/// Drop Windows' `\\?\` verbatim prefix that `canonicalize` adds (keeps paths readable and
/// comparable with mount points); a no-op elsewhere.
pub fn simplify(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(r) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{r}"));
    }
    if let Some(r) = s.strip_prefix(r"\\?\") {
        if r.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(r);
        }
    }
    p.to_path_buf()
}

/// `canonicalize` without the Windows verbatim prefix.
pub fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).map(|c| simplify(&c)).unwrap_or_else(|_| p.to_path_buf())
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(".tbw-write-test");
    let ok = std::fs::create_dir_all(dir).is_ok() && std::fs::write(&probe, b"x").is_ok();
    std::fs::remove_file(&probe).ok();
    ok
}

/// Where the config lives when `--config` isn't given.
///
/// * `TBW_CONFIG` (file) or `TBW_HOME` (folder; config at `<home>/data/config.toml`) if set.
/// * Unix: `data/config.toml` relative to the working directory (what start.sh uses).
/// * Windows: portable mode `<exe folder>\data\config.toml` when that folder is writable,
///   otherwise `%ProgramData%\TheBigWeather\data\config.toml` (installed under Program Files).
pub fn default_config() -> PathBuf {
    if let Some(c) = std::env::var_os("TBW_CONFIG").filter(|v| !v.is_empty()) {
        return PathBuf::from(c);
    }
    if let Some(h) = std::env::var_os("TBW_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(h).join("data").join("config.toml");
    }
    #[cfg(windows)]
    {
        if let Some(d) = exe_dir() {
            if d.join("data").join("config.toml").is_file() || writable(&d.join("data")) {
                return d.join("data").join("config.toml");
            }
        }
        return program_data().join("data").join("config.toml");
    }
    #[allow(unreachable_code)]
    {
        let _ = writable;
        PathBuf::from("data/config.toml")
    }
}

/// `%ProgramData%\TheBigWeather` (Windows); `/var/lib/thebigweather` elsewhere (unused there).
pub fn program_data() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        return base.join("TheBigWeather");
    }
    #[allow(unreachable_code)]
    PathBuf::from("/var/lib/thebigweather")
}

/// Built web UI: `web_dir` from the config when it exists, else `web` next to the executable or
/// one folder up (`server/bin/tbw-server` with `server/web`, or a Windows install folder).
pub fn find_web_dir(configured: &Path) -> PathBuf {
    if configured.join("index.html").is_file() {
        return configured.to_path_buf();
    }
    if let Some(d) = exe_dir() {
        for c in [d.join("web"), d.join("..").join("web"), d.join("resources").join("web")] {
            if c.join("index.html").is_file() {
                return canon(&c);
            }
        }
    }
    configured.to_path_buf()
}

/// A helper program (ffmpeg, yt-dlp): next to the server executable (or in `tools/`) first,
/// then whatever is on PATH. Adds `.exe` on Windows.
pub fn tool(name: &str) -> PathBuf {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Some(d) = exe_dir() {
        for c in [d.join(&file), d.join("tools").join(&file)] {
            if c.is_file() {
                return c;
            }
        }
    }
    PathBuf::from(file)
}

/// Async command for a helper tool; no console window flashes up on Windows.
pub fn command(name: &str) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(tool(name));
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Blocking variant of [`command`].
pub fn command_sync(name: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(tool(name));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Ask ffmpeg to finish its output file cleanly: SIGINT on Unix, "q" on stdin on Windows
/// (stdin must have been piped).
pub async fn ffmpeg_finish(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let _ = std::process::Command::new("kill").args(["-INT", &pid.to_string()]).status();
    }
    #[cfg(not(unix))]
    {
        use tokio::io::AsyncWriteExt;
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(b"q").await;
            let _ = si.flush().await;
        }
    }
}

/// Write `data` to `path` through a temp file + rename. Windows refuses to replace a file that
/// another program holds open without delete sharing (editors, antivirus scans), so retry briefly.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).ok();
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, data)?;
    let mut last = None;
    for i in 0..10 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(50 * (i + 1)));
            }
        }
    }
    std::fs::remove_file(&tmp).ok();
    Err(last.unwrap())
}

/// Service name used by `tbw-server service` and start.ps1 -InstallService.
pub const SERVICE_NAME: &str = "TheBigWeather";

/// Windows service entry point (`tbw-server --config <file> service`): reports to the service
/// control manager, runs the server, and stops on a service stop / system shutdown.
#[cfg(windows)]
pub mod service {
    use super::*;
    use std::ffi::OsString;
    use std::time::Duration;
    use windows_service::service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType};
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    static RUN: once_cell::sync::OnceCell<Box<dyn Fn() -> anyhow::Result<()> + Send + Sync>> = once_cell::sync::OnceCell::new();

    define_windows_service!(ffi_service_main, service_main);

    /// Hand control to the service dispatcher; `run` is the server loop.
    pub fn start(run: Box<dyn Fn() -> anyhow::Result<()> + Send + Sync>) -> anyhow::Result<()> {
        let _ = RUN.set(run);
        service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(|e| anyhow::anyhow!("not started by the service manager ({e}); use start.ps1 -InstallService"))?;
        Ok(())
    }

    fn service_main(_args: Vec<OsString>) {
        let handler = move |ev| match ev {
            ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
                request_stop();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let Ok(h) = service_control_handler::register(SERVICE_NAME, handler) else { return };
        let status = |state, code: u32, wait: u64| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running { ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN } else { ServiceControlAccept::empty() },
            exit_code: ServiceExitCode::Win32(code),
            checkpoint: 0,
            wait_hint: Duration::from_secs(wait),
            process_id: None,
        };
        let _ = h.set_service_status(status(ServiceState::Running, 0, 0));
        let res = RUN.get().map(|f| f()).unwrap_or(Ok(()));
        if let Err(e) = &res {
            tracing::error!("service stopped with an error: {e:#}");
        }
        let _ = h.set_service_status(status(ServiceState::Stopped, if res.is_ok() { 0 } else { 1 }, 0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix() {
        assert_eq!(simplify(Path::new(r"\\?\C:\ProgramData\TheBigWeather")), PathBuf::from(r"C:\ProgramData\TheBigWeather"));
        assert_eq!(simplify(Path::new(r"\\?\UNC\srv\share\x")), PathBuf::from(r"\\srv\share\x"));
        assert_eq!(simplify(Path::new("/srv/tbw")), PathBuf::from("/srv/tbw"));
    }

    #[test]
    fn tool_names() {
        let t = tool("ffmpeg");
        assert!(t.to_string_lossy().ends_with(&format!("ffmpeg{}", std::env::consts::EXE_SUFFIX)));
    }

    #[test]
    fn atomic_write() {
        let d = std::env::temp_dir().join(format!("tbw-aw-{}", std::process::id()));
        let f = d.join("x.json");
        write_atomic(&f, b"1").unwrap();
        write_atomic(&f, b"22").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"22");
        std::fs::remove_dir_all(&d).ok();
    }
}
