//! Server self-update from GitHub releases (local admin API, see admin.rs).
//!
//! * `GET  /api/admin/update[?refresh=1]` → `{current, latest, update_available, notes, html_url,
//!   published_at, assets:[{name,size,url}], asset, managed, can_update, error?}` (GitHub API, cached 1 h)
//! * `POST /api/admin/update` → downloads the server asset for this platform
//!   (`tbw-server-<v>-linux-x86_64` / `-linux-aarch64` / `tbw-server-<v>-windows-x86_64.exe`), checks its SHA-256 against
//!   the release's `SHA256SUMS`, replaces the running binary (the old one is kept as `<exe>.old`),
//!   updates the web app folder from `tbw-web-<v>.zip` when it's writable, and restarts.
//!
//! The repository is `goglesquirmintontheiii/thebigweather` (override: `TBW_UPDATE_REPO=owner/repo`).
//! A server started by the desktop app (`TBW_MANAGED=desktop`) is updated with the app instead.

use crate::api::AppState;
use anyhow::{anyhow, bail, Context, Result};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const DEFAULT_REPO: &str = "goglesquirmintontheiii/thebigweather";
const MAX_DOWNLOAD: u64 = 300 * 1024 * 1024;

static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);

pub fn repo() -> String {
    std::env::var("TBW_UPDATE_REPO").ok().filter(|r| r.split('/').count() == 2 && !r.contains(' ')).unwrap_or_else(|| DEFAULT_REPO.into())
}

/// "v0.8.1" / "0.8.1-beta" → (0, 8, 1)
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let core = s.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|x| x.parse::<u64>());
    let a = it.next()?.ok()?;
    let b = it.next().unwrap_or(Ok(0)).ok()?;
    let c = it.next().unwrap_or(Ok(0)).ok()?;
    Some((a, b, c))
}

pub fn newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// Server asset name for this platform and version.
pub fn asset_name(version: &str) -> Option<String> {
    let v = version.trim_start_matches(['v', 'V']);
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    match std::env::consts::OS {
        "linux" => Some(format!("tbw-server-{v}-linux-{arch}")),
        "windows" => Some(format!("tbw-server-{v}-windows-{arch}.exe")),
        _ => None,
    }
}

/// "<hex>  <name>" lines → hash for `name`.
pub fn sum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let h = it.next()?;
        let n = it.next()?.trim_start_matches('*');
        (n == name && h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| h.to_ascii_lowercase())
    })
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, b).as_ref())
}

pub fn managed() -> Option<String> {
    std::env::var("TBW_MANAGED").ok().filter(|v| !v.is_empty())
}

async fn fetch_release(http: &reqwest::Client) -> Result<Value> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo());
    let r = http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", format!("TheBigWeather-server/{}", crate::api::VERSION))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .with_context(|| format!("can't reach GitHub ({url})"))?;
    if r.status().as_u16() == 404 {
        bail!("no published release yet");
    }
    if !r.status().is_success() {
        bail!("GitHub API: HTTP {}", r.status());
    }
    Ok(r.json().await?)
}

/// Status JSON (cached for an hour unless `refresh`).
pub async fn status(http: &reqwest::Client, refresh: bool) -> Value {
    let current = crate::api::VERSION;
    if !refresh {
        if let Some((t, v)) = CACHE.lock().clone() {
            if t.elapsed() < Duration::from_secs(3600) {
                return v;
            }
        }
    }
    let exe_ok = crate::admin::exe_path().ok().and_then(|p| p.parent().map(writable)).unwrap_or(false);
    let base = json!({"current": current, "repo": repo(), "managed": managed(), "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)});
    let v = match fetch_release(http).await {
        Ok(rel) => {
            let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
            let latest = tag.trim_start_matches(['v', 'V']).to_string();
            let assets: Vec<Value> = rel["assets"].as_array().cloned().unwrap_or_default().iter().map(|a| json!({"name": a["name"], "size": a["size"], "url": a["browser_download_url"]})).collect();
            let want = asset_name(&latest);
            let has_asset = want.as_ref().map(|w| assets.iter().any(|a| a["name"].as_str() == Some(w))).unwrap_or(false);
            let upd = newer(&latest, current);
            let mut v = base;
            let o = v.as_object_mut().unwrap();
            o.insert("latest".into(), json!(latest));
            o.insert("tag".into(), json!(tag));
            o.insert("update_available".into(), json!(upd));
            o.insert("notes".into(), rel["body"].clone());
            o.insert("name".into(), rel["name"].clone());
            o.insert("html_url".into(), rel["html_url"].clone());
            o.insert("published_at".into(), rel["published_at"].clone());
            o.insert("assets".into(), json!(assets));
            o.insert("asset".into(), json!(if has_asset { want } else { None }));
            o.insert("can_update".into(), json!(upd && has_asset && managed().is_none() && exe_ok));
            if !exe_ok {
                o.insert("reason".into(), json!("the server's folder isn't writable by the server"));
            } else if managed().is_some() {
                o.insert("reason".into(), json!("this server is bundled with the desktop app and updates with it"));
            } else if upd && !has_asset {
                o.insert("reason".into(), json!("the release has no server binary for this platform"));
            }
            v
        }
        Err(e) => {
            let mut v = base;
            v["error"] = json!(format!("{e:#}"));
            v["update_available"] = json!(false);
            v["can_update"] = json!(false);
            // don't cache failures for long
            *CACHE.lock() = Some((Instant::now() - Duration::from_secs(3300), v.clone()));
            return v;
        }
    };
    *CACHE.lock() = Some((Instant::now(), v.clone()));
    v
}

fn writable(dir: &Path) -> bool {
    let p = dir.join(format!(".tbw-write-test-{}", std::process::id()));
    let ok = std::fs::write(&p, b"x").is_ok();
    std::fs::remove_file(&p).ok();
    ok
}

async fn download(http: &reqwest::Client, url: &str, max: u64) -> Result<Vec<u8>> {
    use futures::StreamExt;
    let r = http.get(url).header("User-Agent", format!("TheBigWeather-server/{}", crate::api::VERSION)).timeout(Duration::from_secs(900)).send().await?.error_for_status()?;
    let mut out = Vec::with_capacity(r.content_length().unwrap_or(0).min(max) as usize);
    let mut s = r.bytes_stream();
    while let Some(c) = s.next().await {
        let c = c?;
        if out.len() as u64 + c.len() as u64 > max {
            bail!("download larger than {} MB", max >> 20);
        }
        out.extend_from_slice(&c);
    }
    Ok(out)
}

/// Swap in a new binary: `<exe>` → `<exe>.old`, new file → `<exe>` (works for a running exe on
/// Windows too: it can be renamed, not overwritten).
pub fn replace_binary(exe: &Path, data: &[u8]) -> Result<()> {
    let dir = exe.parent().ok_or_else(|| anyhow!("no folder"))?;
    let name = exe.file_name().ok_or_else(|| anyhow!("no file name"))?.to_string_lossy().to_string();
    let tmp = dir.join(format!(".{name}.new"));
    std::fs::write(&tmp, data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    let old = dir.join(format!("{name}.old"));
    std::fs::remove_file(&old).ok();
    std::fs::rename(exe, &old).context("can't move the current binary aside")?;
    if let Err(e) = std::fs::rename(&tmp, exe) {
        // put the old one back
        std::fs::rename(&old, exe).ok();
        return Err(e).context("can't install the new binary");
    }
    Ok(())
}

/// Replace the web app folder with the files of a zip (keeps `<web>.old`).
fn replace_web(web: &Path, zip: &[u8]) -> Result<()> {
    if !web.join("index.html").is_file() || !web.parent().map(writable).unwrap_or(false) {
        bail!("web folder not writable");
    }
    let parent = web.parent().unwrap();
    let name = web.file_name().unwrap().to_string_lossy().to_string();
    let new = parent.join(format!(".{name}.new"));
    std::fs::remove_dir_all(&new).ok();
    std::fs::create_dir_all(&new)?;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip))?;
    for i in 0..z.len() {
        let mut f = z.by_index(i)?;
        let Some(rel) = f.enclosed_name() else { continue };
        // archives may wrap the files in a dist/ folder
        let rel: PathBuf = rel.strip_prefix("dist").map(|p| p.to_path_buf()).unwrap_or(rel);
        let out = new.join(&rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p)?;
        }
        let mut w = std::fs::File::create(&out)?;
        std::io::copy(&mut f, &mut w)?;
    }
    if !new.join("index.html").is_file() {
        std::fs::remove_dir_all(&new).ok();
        bail!("web archive has no index.html");
    }
    let old = parent.join(format!("{name}.old"));
    std::fs::remove_dir_all(&old).ok();
    std::fs::rename(web, &old)?;
    if let Err(e) = std::fs::rename(&new, web) {
        std::fs::rename(&old, web).ok();
        return Err(e.into());
    }
    Ok(())
}

/// Download + verify + install. Returns the installed version.
pub async fn apply(http: &reqwest::Client) -> Result<(String, bool)> {
    if let Some(m) = managed() {
        bail!("this server is managed by the {m} app and updates with it");
    }
    let rel = fetch_release(http).await?;
    let latest = rel["tag_name"].as_str().unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    if !newer(&latest, crate::api::VERSION) {
        bail!("already up to date ({})", crate::api::VERSION);
    }
    let want = asset_name(&latest).ok_or_else(|| anyhow!("no server builds for this platform"))?;
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    let url_of = |n: &str| assets.iter().find(|a| a["name"].as_str() == Some(n)).and_then(|a| a["browser_download_url"].as_str().map(str::to_string));
    let bin_url = url_of(&want).ok_or_else(|| anyhow!("release v{latest} has no {want}"))?;
    let sums_url = url_of("SHA256SUMS").ok_or_else(|| anyhow!("release v{latest} has no SHA256SUMS"))?;
    let sums = String::from_utf8_lossy(&download(http, &sums_url, 1 << 20).await?).to_string();
    let expect = sum_for(&sums, &want).ok_or_else(|| anyhow!("SHA256SUMS has no entry for {want}"))?;
    tracing::info!("update: downloading {want}");
    let bin = download(http, &bin_url, MAX_DOWNLOAD).await?;
    let got = sha256_hex(&bin);
    if got != expect {
        bail!("checksum mismatch for {want} (expected {expect}, got {got})");
    }
    let exe = crate::admin::exe_path()?;
    // web app (optional): same checksum rule
    let web_name = format!("tbw-web-{latest}.zip");
    let mut web_ok = false;
    if let (Some(u), Some(h)) = (url_of(&web_name), sum_for(&sums, &web_name)) {
        let web = crate::config::paths().web;
        if web.join("index.html").is_file() && !web.to_string_lossy().contains(".asar") {
            match download(http, &u, MAX_DOWNLOAD).await {
                Ok(z) if sha256_hex(&z) == h => {
                    let web2 = web.clone();
                    match tokio::task::spawn_blocking(move || replace_web(&web2, &z)).await? {
                        Ok(()) => web_ok = true,
                        Err(e) => tracing::warn!("update: web app not replaced: {e:#}"),
                    }
                }
                Ok(_) => tracing::warn!("update: {web_name} checksum mismatch; web app not replaced"),
                Err(e) => tracing::warn!("update: {web_name}: {e:#}"),
            }
        }
    }
    tokio::task::spawn_blocking(move || replace_binary(&exe, &bin)).await??;
    // check the new binary runs before restarting into it
    let exe = crate::admin::exe_path()?;
    let ok = std::process::Command::new(&exe).arg("--version").stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).output();
    match ok {
        Ok(o) if o.status.success() => {}
        _ => {
            let old = exe.with_file_name(format!("{}.old", exe.file_name().unwrap().to_string_lossy()));
            std::fs::remove_file(&exe).ok();
            std::fs::rename(&old, &exe).ok();
            bail!("the downloaded server doesn't run on this system; kept the current version");
        }
    }
    *CACHE.lock() = None;
    Ok((latest, web_ok))
}

// ---------- HTTP (mounted under the local-only admin router) ----------

type St = State<Arc<AppState>>;

pub async fn get(State(st): St, Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let http = st.notify.http.clone();
    Json(status(&http, q.get("refresh").map(|v| v == "1" || v == "true").unwrap_or(false)).await)
}

pub async fn post(State(st): St) -> Response {
    {
        let mut b = BUSY.lock();
        if *b {
            return (StatusCode::CONFLICT, Json(json!({"error": "an update is already running"}))).into_response();
        }
        *b = true;
    }
    let http = st.notify.http.clone();
    let r = apply(&http).await;
    *BUSY.lock() = false;
    match r {
        Ok((v, web)) => {
            tracing::info!("updated to {v}; restarting");
            st.hub.send(json!({"type": "server_update", "version": v}));
            crate::admin::request_restart(true);
            Json(json!({"ok": true, "version": v, "web_updated": web, "restarting": true})).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": format!("{e:#}")}))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.8.1"), Some((0, 8, 1)));
        assert_eq!(parse_version("0.8"), Some((0, 8, 0)));
        assert_eq!(parse_version("1.2.3-beta.1"), Some((1, 2, 3)));
        assert!(newer("v0.10.0", "0.9.9"));
        assert!(!newer("0.7.0", "0.7.0"));
        assert!(!newer("garbage", "0.7.0"));
    }

    #[test]
    fn sums_and_names() {
        let h = "a".repeat(64);
        let s = format!("{h}  tbw-server-0.8.0-linux-x86_64\n{}  *TheBigWeather-0.8.0-setup.exe\n", "b".repeat(64));
        assert_eq!(sum_for(&s, "tbw-server-0.8.0-linux-x86_64"), Some(h));
        assert_eq!(sum_for(&s, "TheBigWeather-0.8.0-setup.exe"), Some("b".repeat(64)));
        assert_eq!(sum_for(&s, "nope"), None);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert_eq!(asset_name("v0.8.0").unwrap(), "tbw-server-0.8.0-linux-x86_64");
        }
    }

    #[test]
    fn swap_binary() {
        let d = std::env::temp_dir().join(format!("tbw-upd-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let exe = d.join("tbw-server");
        std::fs::write(&exe, b"old").unwrap();
        replace_binary(&exe, b"new").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert_eq!(std::fs::read(d.join("tbw-server.old")).unwrap(), b"old");
        std::fs::remove_dir_all(&d).ok();
    }
}
