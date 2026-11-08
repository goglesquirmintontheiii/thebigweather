//! 0.8.3: one-click download of the helper tools YouTube recording needs: yt-dlp and Deno (its
//! JavaScript runtime). Official release binaries from GitHub (yt-dlp/yt-dlp, denoland/deno) for
//! this OS / CPU, checked against the release's SHA-256 sums, into `<server>/tools` (or
//! `<data>/tools` when the server folder is read-only, e.g. inside an AppImage). The recorder
//! finds them there through `platform::tool`.
//!
//! `GET /api/tools` → status of both; `POST /api/tools/{ytdlp|deno}/install` starts a download
//! (progress in the status).

use crate::api::AppState;
use anyhow::{anyhow, bail, Context, Result};
use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    YtDlp,
    Deno,
}

impl Tool {
    pub fn parse(s: &str) -> Option<Tool> {
        match s {
            "ytdlp" | "yt-dlp" => Some(Tool::YtDlp),
            "deno" => Some(Tool::Deno),
            _ => None,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Tool::YtDlp => "ytdlp",
            Tool::Deno => "deno",
        }
    }
    /// executable name (without the .exe suffix)
    fn exe(self) -> &'static str {
        match self {
            Tool::YtDlp => "yt-dlp",
            Tool::Deno => "deno",
        }
    }
}

/// yt-dlp's standalone build for an OS / CPU (`std::env::consts` names). None: no build (the
/// Python zipapp `yt-dlp` needs Python, so it is never picked).
pub fn ytdlp_asset(os: &str, arch: &str, musl: bool) -> Option<&'static str> {
    Some(match (os, arch) {
        ("linux", "x86_64") if musl => "yt-dlp_musllinux",
        ("linux", "x86_64") => "yt-dlp_linux",
        ("linux", "aarch64") if musl => "yt-dlp_musllinux_aarch64",
        ("linux", "aarch64") => "yt-dlp_linux_aarch64",
        ("macos", "x86_64" | "aarch64") => "yt-dlp_macos",
        ("windows", "x86_64") => "yt-dlp.exe",
        ("windows", "x86") => "yt-dlp_x86.exe",
        ("windows", "aarch64") => "yt-dlp_arm64.exe",
        _ => return None,
    })
}

/// Deno's release zip for an OS / CPU. Deno only ships glibc builds for Linux.
pub fn deno_asset(os: &str, arch: &str, musl: bool) -> Option<String> {
    let arch = match arch {
        "x86_64" | "aarch64" => arch,
        _ => return None,
    };
    let target = match os {
        "linux" if !musl => "unknown-linux-gnu",
        "macos" => "apple-darwin",
        "windows" => "pc-windows-msvc",
        _ => return None,
    };
    Some(format!("deno-{arch}-{target}.zip"))
}

/// The asset for this machine.
pub fn asset_for(t: Tool) -> Option<String> {
    let (os, arch, musl) = (std::env::consts::OS, std::env::consts::ARCH, cfg!(target_env = "musl"));
    match t {
        Tool::YtDlp => ytdlp_asset(os, arch, musl).map(str::to_string),
        Tool::Deno => deno_asset(os, arch, musl),
    }
}

fn release_url(t: Tool, file: &str) -> String {
    let repo = match t {
        Tool::YtDlp => "yt-dlp/yt-dlp",
        Tool::Deno => "denoland/deno",
    };
    format!("https://github.com/{repo}/releases/latest/download/{file}")
}

/// SHA-256 (lowercase hex) of `name` in a `sha256sum`-style list ("<hash>  <name>" or
/// "<hash> *<name>" per line).
pub fn sum_for(list: &str, name: &str) -> Option<String> {
    list.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let h = it.next()?;
        let n = it.next()?.trim_start_matches('*');
        (n == name && is_hex64(h)).then(|| h.to_ascii_lowercase())
    })
}

/// The first 64-hex-digit word of a checksum file (Deno's `.sha256sum` files are either
/// `sha256sum` output or PowerShell `Get-FileHash` output).
pub fn first_sum(text: &str) -> Option<String> {
    text.split(|c: char| !c.is_ascii_hexdigit()).find(|w| is_hex64(w)).map(|w| w.to_ascii_lowercase())
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Where downloads go: `<server>/tools` when writable, else `<data>/tools`.
pub fn tools_dir() -> PathBuf {
    if let Some(d) = crate::platform::exe_dir() {
        let t = d.join("tools");
        if writable(&t) {
            return t;
        }
    }
    crate::config::paths().data.join("tools")
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".tbw-write-test-{}", std::process::id()));
    let ok = std::fs::create_dir_all(dir).is_ok() && std::fs::write(&probe, b"x").is_ok();
    std::fs::remove_file(&probe).ok();
    ok
}

// ---------- jobs ----------

#[derive(Clone, Default)]
struct Job {
    running: bool,
    done: u64,
    total: u64,
    ok: Option<bool>,
    msg: String,
}

static JOBS: Mutex<Option<HashMap<&'static str, Job>>> = Mutex::new(None);

fn job(t: Tool) -> Job {
    JOBS.lock().get_or_insert_with(HashMap::new).get(t.id()).cloned().unwrap_or_default()
}
fn set_job(t: Tool, f: impl FnOnce(&mut Job)) {
    let mut g = JOBS.lock();
    f(g.get_or_insert_with(HashMap::new).entry(t.id()).or_default());
}

/// Path of a tool the recorder would run (absolute when found next to the server / in a tools
/// folder / on PATH), or None.
fn found(t: Tool) -> Option<PathBuf> {
    match t {
        Tool::Deno => crate::recorder::deno_path(),
        Tool::YtDlp => {
            let p = crate::platform::tool("yt-dlp");
            if p.is_absolute() {
                return p.is_file().then_some(p);
            }
            let file = format!("yt-dlp{}", std::env::consts::EXE_SUFFIX);
            std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join(&file)).find(|c| c.is_file()))
        }
    }
}

fn status_of(t: Tool) -> Value {
    let j = job(t);
    let path = found(t);
    json!({
        "found": path.is_some(),
        "path": path.map(|p| p.display().to_string()),
        "asset": asset_for(t),
        "running": j.running,
        "done": j.done,
        "total": j.total,
        "ok": j.ok,
        "msg": j.msg,
    })
}

pub async fn get(State(_st): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({"ytdlp": status_of(Tool::YtDlp), "deno": status_of(Tool::Deno), "dir": tools_dir().display().to_string()}))
}

pub async fn install(State(st): State<Arc<AppState>>, AxPath(name): AxPath<String>) -> Response {
    let Some(t) = Tool::parse(&name) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "unknown tool"}))).into_response();
    };
    let Some(asset) = asset_for(t) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("no {} build for {} {}", t.exe(), std::env::consts::OS, std::env::consts::ARCH)}))).into_response();
    };
    {
        let mut g = JOBS.lock();
        let j = g.get_or_insert_with(HashMap::new).entry(t.id()).or_default();
        if j.running {
            return Json(status_of_locked(j)).into_response();
        }
        *j = Job { running: true, msg: "Starting…".into(), ..Default::default() };
    }
    let rec = st.rec.clone();
    tokio::spawn(async move {
        let r = run(t, &asset).await;
        if t == Tool::YtDlp {
            *rec.ytdlp.lock() = None; // re-check on next use
        }
        match r {
            Ok(v) => {
                tracing::info!("{} installed: {v}", t.exe());
                set_job(t, |j| (j.running, j.ok, j.msg) = (false, Some(true), v));
            }
            Err(e) => {
                tracing::warn!("{} download failed: {e:#}", t.exe());
                set_job(t, |j| (j.running, j.ok, j.msg) = (false, Some(false), format!("{e:#}")));
            }
        }
    });
    Json(status_of(t)).into_response()
}

fn status_of_locked(j: &Job) -> Value {
    json!({"running": j.running, "done": j.done, "total": j.total, "ok": j.ok, "msg": j.msg})
}

const MAX_BYTES: u64 = 400 << 20;

/// Download, verify, unpack and test one tool; returns its version line.
async fn run(t: Tool, asset: &str) -> Result<String> {
    use futures::StreamExt;
    let http = reqwest::Client::builder()
        .user_agent(format!("Stormiq-server/{}", crate::api::VERSION))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()?;
    // checksum first (small)
    set_job(t, |j| j.msg = "Checking the release…".into());
    let sums_url = match t {
        Tool::YtDlp => release_url(t, "SHA2-256SUMS"),
        Tool::Deno => release_url(t, &format!("{asset}.sha256sum")),
    };
    let sums = http.get(&sums_url).timeout(Duration::from_secs(60)).send().await?.error_for_status().with_context(|| format!("checksums ({sums_url})"))?.text().await?;
    let want = match t {
        Tool::YtDlp => sum_for(&sums, asset),
        Tool::Deno => first_sum(&sums),
    }
    .ok_or_else(|| anyhow!("no checksum for {asset} in the release"))?;

    let dir = tools_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("can't create {}", dir.display()))?;
    let part = dir.join(format!(".{asset}.part"));
    let url = release_url(t, asset);
    set_job(t, |j| j.msg = format!("Downloading {asset}…"));
    let r = http.get(&url).send().await?.error_for_status().with_context(|| format!("download ({url})"))?;
    let total = r.content_length().unwrap_or(0);
    if total > MAX_BYTES {
        bail!("{asset} is unexpectedly large ({} MB)", total >> 20);
    }
    set_job(t, |j| j.total = total);
    let mut f = std::fs::File::create(&part).with_context(|| format!("can't write {}", part.display()))?;
    let mut ctx = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
    let mut n = 0u64;
    let mut s = r.bytes_stream();
    let res: Result<()> = async {
        while let Some(c) = s.next().await {
            let c = c?;
            n += c.len() as u64;
            if n > MAX_BYTES {
                bail!("download too large");
            }
            ctx.update(&c);
            f.write_all(&c)?;
            set_job(t, |j| j.done = n);
        }
        f.flush()?;
        Ok(())
    }
    .await;
    drop(f);
    if let Err(e) = res {
        std::fs::remove_file(&part).ok();
        return Err(e);
    }
    let got = hex::encode(ctx.finish().as_ref());
    if got != want {
        std::fs::remove_file(&part).ok();
        bail!("checksum mismatch for {asset}");
    }
    set_job(t, |j| j.msg = "Installing…".into());
    let dest = dir.join(format!("{}{}", t.exe(), std::env::consts::EXE_SUFFIX));
    let (p2, d2) = (part.clone(), dest.clone());
    let unpack = tokio::task::spawn_blocking(move || -> Result<()> {
        match t {
            Tool::YtDlp => place(&p2, &d2),
            Tool::Deno => {
                let r = unzip_one(&p2, &d2, &format!("deno{}", std::env::consts::EXE_SUFFIX));
                std::fs::remove_file(&p2).ok();
                r
            }
        }
    })
    .await?;
    if let Err(e) = unpack {
        std::fs::remove_file(&part).ok();
        return Err(e);
    }
    // it must run
    set_job(t, |j| j.msg = "Testing…".into());
    let out = tokio::time::timeout(Duration::from_secs(60), tokio::process::Command::new(&dest).arg("--version").stdin(std::process::Stdio::null()).kill_on_drop(true).output())
        .await
        .map_err(|_| anyhow!("{} --version timed out", t.exe()))?
        .with_context(|| format!("can't run {}", dest.display()))?;
    if !out.status.success() {
        bail!("{} --version failed ({})", t.exe(), out.status);
    }
    let v = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
    Ok(format!("{} {}", if v.is_empty() { t.exe().to_string() } else { v }, dest.display()))
}

/// Move a downloaded file into place and make it executable.
fn place(part: &Path, dest: &Path) -> Result<()> {
    make_exec(part)?;
    if dest.exists() {
        // Windows can't overwrite a running exe but can rename it
        let old = dest.with_extension("old");
        std::fs::remove_file(&old).ok();
        std::fs::rename(dest, &old).ok();
    }
    std::fs::rename(part, dest).with_context(|| format!("can't write {}", dest.display()))?;
    Ok(())
}

/// Extract the entry named `name` (at any depth) from a zip to `dest`.
fn unzip_one(zip_path: &Path, dest: &Path, name: &str) -> Result<()> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(zip_path)?).context("not a zip file")?;
    let idx = (0..z.len())
        .find(|&i| z.by_index(i).map(|e| e.is_file() && e.name().map(|n| n.rsplit('/').next() == Some(name)).unwrap_or(false)).unwrap_or(false))
        .ok_or_else(|| anyhow!("{name} not found in the zip"))?;
    let mut e = z.by_index(idx)?;
    let tmp = dest.with_file_name(format!(".{name}.new"));
    {
        let mut o = std::fs::File::create(&tmp)?;
        let n = std::io::copy(&mut e, &mut o)?;
        if n > MAX_BYTES {
            bail!("zip entry too large");
        }
    }
    place(&tmp, dest)
}

fn make_exec(p: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))?;
    }
    let _ = p;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ytdlp_assets() {
        assert_eq!(ytdlp_asset("linux", "x86_64", false), Some("yt-dlp_linux"));
        assert_eq!(ytdlp_asset("linux", "x86_64", true), Some("yt-dlp_musllinux"));
        assert_eq!(ytdlp_asset("linux", "aarch64", false), Some("yt-dlp_linux_aarch64"));
        assert_eq!(ytdlp_asset("linux", "aarch64", true), Some("yt-dlp_musllinux_aarch64"));
        assert_eq!(ytdlp_asset("macos", "aarch64", false), Some("yt-dlp_macos"));
        assert_eq!(ytdlp_asset("macos", "x86_64", false), Some("yt-dlp_macos"));
        assert_eq!(ytdlp_asset("windows", "x86_64", false), Some("yt-dlp.exe"));
        assert_eq!(ytdlp_asset("windows", "x86", false), Some("yt-dlp_x86.exe"));
        assert_eq!(ytdlp_asset("windows", "aarch64", false), Some("yt-dlp_arm64.exe"));
        assert_eq!(ytdlp_asset("linux", "arm", false), None);
        assert_eq!(ytdlp_asset("freebsd", "x86_64", false), None);
    }

    #[test]
    fn deno_assets() {
        assert_eq!(deno_asset("linux", "x86_64", false).as_deref(), Some("deno-x86_64-unknown-linux-gnu.zip"));
        assert_eq!(deno_asset("linux", "aarch64", false).as_deref(), Some("deno-aarch64-unknown-linux-gnu.zip"));
        assert_eq!(deno_asset("linux", "x86_64", true), None);
        assert_eq!(deno_asset("macos", "aarch64", false).as_deref(), Some("deno-aarch64-apple-darwin.zip"));
        assert_eq!(deno_asset("macos", "x86_64", false).as_deref(), Some("deno-x86_64-apple-darwin.zip"));
        assert_eq!(deno_asset("windows", "x86_64", false).as_deref(), Some("deno-x86_64-pc-windows-msvc.zip"));
        assert_eq!(deno_asset("windows", "aarch64", false).as_deref(), Some("deno-aarch64-pc-windows-msvc.zip"));
        assert_eq!(deno_asset("windows", "x86", false), None);
        assert_eq!(deno_asset("linux", "arm", false), None);
        // this machine has some answer for both on the common platforms
        if matches!((std::env::consts::OS, std::env::consts::ARCH), ("linux" | "windows" | "macos", "x86_64")) && !cfg!(target_env = "musl") {
            assert!(asset_for(Tool::YtDlp).is_some() && asset_for(Tool::Deno).is_some());
        }
    }

    #[test]
    fn checksums() {
        let h1 = "a".repeat(64);
        let h2 = "B".repeat(64);
        let list = format!("{h1}  yt-dlp\n{h2}  yt-dlp_linux\n{h1} *yt-dlp.exe\nbad  yt-dlp_macos\n");
        assert_eq!(sum_for(&list, "yt-dlp_linux"), Some("b".repeat(64)));
        assert_eq!(sum_for(&list, "yt-dlp"), Some(h1.clone()));
        assert_eq!(sum_for(&list, "yt-dlp.exe"), Some(h1.clone()));
        assert_eq!(sum_for(&list, "yt-dlp_macos"), None);
        assert_eq!(sum_for(&list, "yt-dlp_linux_aarch64"), None);
        assert_eq!(first_sum(&format!("{h2}  deno-x86_64-unknown-linux-gnu.zip\n")), Some("b".repeat(64)));
        assert_eq!(first_sum(&format!("\nAlgorithm : SHA256\nHash      : {h2}\nPath      : C:\\a\\deno.zip\n")), Some("b".repeat(64)));
        assert_eq!(first_sum("nothing here"), None);
        assert_eq!(Tool::parse("yt-dlp"), Some(Tool::YtDlp));
        assert_eq!(Tool::parse("deno"), Some(Tool::Deno));
        assert_eq!(Tool::parse("ffmpeg"), None);
    }

    /// Real downloads from GitHub (network): `cargo test --release tooldl -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn live_download() {
        for t in [Tool::YtDlp, Tool::Deno] {
            let a = asset_for(t).unwrap();
            let v = run(t, &a).await.unwrap_or_else(|e| panic!("{a}: {e:#}"));
            eprintln!("{a}: {v}");
            let p = tools_dir().join(format!("{}{}", t.exe(), std::env::consts::EXE_SUFFIX));
            assert!(p.is_file());
            std::fs::remove_file(&p).ok();
        }
    }

    #[test]
    fn unzip_and_place() {
        let d = std::env::temp_dir().join(format!("tbw-tooldl-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let zp = d.join("t.zip");
        {
            let mut w = zip::ZipWriter::new(std::fs::File::create(&zp).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            w.start_file("README", o).unwrap();
            w.write_all(b"x").unwrap();
            w.start_file("bin/deno", o).unwrap();
            w.write_all(b"#!/bin/sh\necho deno 9\n").unwrap();
            w.finish().unwrap();
        }
        let dest = d.join("deno");
        unzip_one(&zp, &dest, "deno").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"#!/bin/sh\necho deno 9\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o111, 0o111);
        }
        assert!(unzip_one(&zp, &d.join("x"), "yt-dlp").is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}
