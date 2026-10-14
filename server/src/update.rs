//! Server self-update from GitHub: the latest release, or the repository's `builds` branch
//! (tools/publish-builds.sh) when that is newer (local admin API, see admin.rs).
//!
//! * `GET  /api/admin/update[?refresh=1]` → `{current, latest, source, update_available, notes, html_url,
//!   published_at, assets:[{name,size,url}], asset, managed, can_update, error?}` (cached 1 h)
//! * `POST /api/admin/update` → downloads the server binary for this platform
//!   (`tbw-server-<v>-linux-x86_64` / `-linux-aarch64` / `tbw-server-<v>-windows-x86_64.exe`), checks its
//!   SHA-256 (release: `SHA256SUMS`; builds branch: every part and the joined file, from `manifest.json`),
//!   replaces the running binary (the old one is kept as `<exe>.old`), updates the web app folder from
//!   `tbw-web-<v>.zip` when it's writable, and restarts.
//!
//! Sources (`source`): `"release"` = GitHub release; `"repo"` = `builds` branch, read from
//! raw.githubusercontent.com and pinned to the branch's commit when the GitHub API answers. The newer
//! one wins; a tie goes to the release.
//! Overrides: `TBW_UPDATE_REPO=owner/repo`, `TBW_UPDATE_RAW_BASE` (default
//! `https://raw.githubusercontent.com/<repo>`), `TBW_UPDATE_API_BASE` (default `https://api.github.com`).
//! A server started by the desktop app (`TBW_MANAGED=desktop`) is updated with the app instead.

use crate::api::AppState;
use anyhow::{anyhow, bail, Context, Result};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const DEFAULT_REPO: &str = "goglesquirmintontheiii/thebigweather";
pub const BUILDS_BRANCH: &str = "builds";
const MAX_DOWNLOAD: u64 = 300 * 1024 * 1024;

static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);

pub fn repo() -> String {
    std::env::var("TBW_UPDATE_REPO").ok().filter(|r| r.split('/').count() == 2 && !r.contains(' ')).unwrap_or_else(|| DEFAULT_REPO.into())
}
fn raw_base() -> String {
    std::env::var("TBW_UPDATE_RAW_BASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("https://raw.githubusercontent.com/{}", repo())).trim_end_matches('/').to_string()
}
fn api_base() -> String {
    std::env::var("TBW_UPDATE_API_BASE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "https://api.github.com".into()).trim_end_matches('/').to_string()
}
fn ua() -> String {
    format!("TheBigWeather-server/{}", crate::api::VERSION)
}

// ---------- versions ----------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Ident {
    Num(u64),
    Alpha(String),
}

/// "v1.2.3-beta.1+meta" → ([1, 2, 3], ["beta", 1]); missing minor/patch are 0.
fn semver(s: &str) -> Option<([u64; 3], Vec<Ident>)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let s = s.split('+').next()?;
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let mut v = [0u64; 3];
    let parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        v[i] = p.parse().ok()?;
    }
    let mut ids = Vec::new();
    if let Some(pre) = pre {
        for x in pre.split('.') {
            if x.is_empty() || !x.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return None;
            }
            ids.push(if x.bytes().all(|b| b.is_ascii_digit()) { Ident::Num(x.parse().ok()?) } else { Ident::Alpha(x.to_string()) });
        }
    }
    Some((v, ids))
}

/// Semver order: a prerelease sorts before its release, numeric identifiers compare as numbers,
/// build metadata is ignored. Invalid versions sort lowest.
pub fn cmp_versions(a: &str, b: &str) -> Ordering {
    let (x, y) = match (semver(a), semver(b)) {
        (Some(x), Some(y)) => (x, y),
        (Some(_), None) => return Ordering::Greater,
        (None, Some(_)) => return Ordering::Less,
        (None, None) => return Ordering::Equal,
    };
    x.0.cmp(&y.0).then_with(|| match (x.1.is_empty(), y.1.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (p, q) in x.1.iter().zip(y.1.iter()) {
                let o = match (p, q) {
                    (Ident::Num(a), Ident::Num(b)) => a.cmp(b),
                    (Ident::Num(_), Ident::Alpha(_)) => Ordering::Less,
                    (Ident::Alpha(_), Ident::Num(_)) => Ordering::Greater,
                    (Ident::Alpha(a), Ident::Alpha(b)) => a.cmp(b),
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
            x.1.len().cmp(&y.1.len())
        }
    })
}

pub fn newer(latest: &str, current: &str) -> bool {
    semver(latest).is_some() && semver(current).is_some() && cmp_versions(latest, current) == Ordering::Greater
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Release,
    Repo,
}
impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Release => "release",
            Source::Repo => "repo",
        }
    }
}

/// The newer of the two (a tie goes to the release), only when newer than `current`.
pub fn pick(current: &str, release: Option<&str>, repo: Option<&str>) -> Option<(Source, String)> {
    let mut best: Option<(Source, String)> = release.filter(|v| semver(v).is_some()).map(|v| (Source::Release, v.trim_start_matches(['v', 'V']).to_string()));
    if let Some(r) = repo.filter(|v| semver(v).is_some()) {
        if best.as_ref().map(|(_, b)| cmp_versions(r, b) == Ordering::Greater).unwrap_or(true) {
            best = Some((Source::Repo, r.trim_start_matches(['v', 'V']).to_string()));
        }
    }
    best.filter(|(_, v)| newer(v, current))
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

// ---------- builds branch manifest ----------

#[derive(Debug, Clone, Deserialize)]
pub struct Part {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct FileEntry {
    pub size: u64,
    pub sha256: String,
    pub parts: Vec<Part>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub commit: String,
    pub files: HashMap<String, FileEntry>,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Parse + check a manifest.json (versions, hashes, part paths, sizes adding up).
pub fn parse_manifest(text: &str) -> Result<Manifest> {
    let mut m: Manifest = serde_json::from_str(text).context("manifest.json")?;
    if semver(&m.version).is_none() {
        bail!("manifest: bad version {:?}", m.version);
    }
    m.version = m.version.trim_start_matches(['v', 'V']).to_string();
    for (name, f) in &m.files {
        if !is_hex64(&f.sha256) || f.parts.is_empty() {
            bail!("manifest: bad entry {name}");
        }
        for p in &f.parts {
            if !p.path.starts_with("parts/") || p.path.contains("..") || p.path.contains('\\') || !is_hex64(&p.sha256) {
                bail!("manifest: bad part of {name}");
            }
        }
        if f.parts.iter().map(|p| p.size).sum::<u64>() != f.size {
            bail!("manifest: parts of {name} don't add up");
        }
    }
    Ok(m)
}

/// Join downloaded parts after checking each one and the result. Pure (used by `download_parts`).
pub fn join_parts(entry: &FileEntry, parts: &[Vec<u8>]) -> Result<Vec<u8>> {
    if parts.len() != entry.parts.len() {
        bail!("{} of {} parts", parts.len(), entry.parts.len());
    }
    let mut out = Vec::with_capacity(entry.size as usize);
    for (p, b) in entry.parts.iter().zip(parts) {
        check_part(p, b)?;
        out.extend_from_slice(b);
    }
    if out.len() as u64 != entry.size || sha256_hex(&out) != entry.sha256 {
        bail!("the joined file doesn't match its checksum");
    }
    Ok(out)
}
fn check_part(p: &Part, b: &[u8]) -> Result<()> {
    if b.len() as u64 != p.size || sha256_hex(b) != p.sha256 {
        bail!("checksum mismatch in {}", p.path);
    }
    Ok(())
}

async fn get_text(http: &reqwest::Client, url: &str, accept: Option<&str>, secs: u64) -> Result<(u16, String)> {
    let mut rq = http.get(url).header("User-Agent", ua()).timeout(Duration::from_secs(secs));
    if let Some(a) = accept {
        rq = rq.header("Accept", a);
    }
    let r = rq.send().await.with_context(|| format!("can't reach {url}"))?;
    let st = r.status().as_u16();
    Ok((st, if r.status().is_success() { r.text().await? } else { String::new() }))
}

/// The builds branch: (base URL for part paths, manifest); None when the branch has no manifest.
pub async fn fetch_builds(http: &reqwest::Client) -> Result<Option<(String, Manifest)>> {
    fetch_builds_from(http, &raw_base(), &api_base(), &repo(), BUILDS_BRANCH).await
}
async fn fetch_builds_from(http: &reqwest::Client, raw: &str, api: &str, repo: &str, branch: &str) -> Result<Option<(String, Manifest)>> {
    // pin to the branch's commit, so a publish during the download can't mix versions (rate-limited
    // API: fall back to the branch name; parts are checked one by one anyway)
    let mut refs = vec![branch.to_string()];
    if let Ok((200, sha)) = get_text(http, &format!("{api}/repos/{repo}/commits/{branch}"), Some("application/vnd.github.sha"), 10).await {
        let sha = sha.trim();
        if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            refs.insert(0, sha.to_string());
        }
    }
    let mut last = None;
    for r in refs {
        let base = format!("{raw}/{r}");
        match get_text(http, &format!("{base}/manifest.json"), None, 20).await {
            Ok((200, t)) => return Ok(Some((base, parse_manifest(&t)?))),
            Ok((404, _)) => last = Some(Ok(None)),
            Ok((st, _)) => last = Some(Err(anyhow!("builds branch: HTTP {st}"))),
            Err(e) => last = Some(Err(e)),
        }
    }
    last.unwrap_or(Ok(None))
}

/// Download every part (3 tries each), check it, join, check the whole file.
pub async fn download_parts(http: &reqwest::Client, base: &str, entry: &FileEntry, max: u64) -> Result<Vec<u8>> {
    if entry.size > max {
        bail!("download larger than {} MB", max >> 20);
    }
    let mut parts = Vec::with_capacity(entry.parts.len());
    for p in &entry.parts {
        let url = format!("{base}/{}", p.path);
        let mut tries = 0;
        let b = loop {
            tries += 1;
            let r = match download(http, &url, p.size).await {
                Ok(b) => check_part(p, &b).map(|_| b),
                Err(e) => Err(e),
            };
            match r {
                Ok(b) => break b,
                Err(e) if tries >= 3 => return Err(e.context(format!("{} (if a new build was just published, try again)", p.path))),
                Err(_) => tokio::time::sleep(Duration::from_secs(tries)).await,
            }
        };
        parts.push(b);
    }
    join_parts(entry, &parts)
}

// ---------- GitHub release ----------

async fn fetch_release(http: &reqwest::Client) -> Result<Option<Value>> {
    let url = format!("{}/repos/{}/releases/latest", api_base(), repo());
    let r = http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", ua())
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .with_context(|| format!("can't reach GitHub ({url})"))?;
    if r.status().as_u16() == 404 {
        return Ok(None); // no published release yet
    }
    if !r.status().is_success() {
        bail!("GitHub API: HTTP {}", r.status());
    }
    Ok(Some(r.json().await?))
}

fn rel_version(rel: &Value) -> String {
    rel["tag_name"].as_str().unwrap_or("").trim_start_matches(['v', 'V']).to_string()
}

/// Both sources; errors only when neither answered.
async fn fetch_both(http: &reqwest::Client) -> Result<(Option<Value>, Option<(String, Manifest)>)> {
    let (rel, builds) = tokio::join!(fetch_release(http), fetch_builds(http));
    match (rel, builds) {
        (Err(e), Err(_)) => Err(e),
        (r, b) => Ok((r.unwrap_or(None), b.unwrap_or(None))),
    }
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
    let mut v = json!({"current": current, "repo": repo(), "managed": managed(), "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)});
    let (rel, builds) = match fetch_both(http).await {
        Ok(x) => x,
        Err(e) => {
            v["error"] = json!(format!("{e:#}"));
            v["update_available"] = json!(false);
            v["can_update"] = json!(false);
            // don't cache failures for long
            *CACHE.lock() = Some((Instant::now() - Duration::from_secs(3300), v.clone()));
            return v;
        }
    };
    let rel_v = rel.as_ref().map(rel_version);
    let repo_v = builds.as_ref().map(|(_, m)| m.version.clone());
    let picked = pick(current, rel_v.as_deref(), repo_v.as_deref());
    // what to describe: the update, or the newest thing known when up to date
    let source = picked.as_ref().map(|p| p.0).unwrap_or(if rel_v.is_some() && (repo_v.is_none() || cmp_versions(rel_v.as_deref().unwrap_or(""), repo_v.as_deref().unwrap_or("")) != Ordering::Less) { Source::Release } else { Source::Repo });
    let o = v.as_object_mut().unwrap();
    let (latest, has_asset) = match (source, &rel, &builds) {
        (Source::Release, Some(rel), _) => {
            let latest = rel_version(rel);
            let assets: Vec<Value> = rel["assets"].as_array().cloned().unwrap_or_default().iter().map(|a| json!({"name": a["name"], "size": a["size"], "url": a["browser_download_url"]})).collect();
            let want = asset_name(&latest);
            let has = want.as_ref().map(|w| assets.iter().any(|a| a["name"].as_str() == Some(w))).unwrap_or(false);
            o.insert("tag".into(), rel["tag_name"].clone());
            o.insert("notes".into(), rel["body"].clone());
            o.insert("name".into(), rel["name"].clone());
            o.insert("html_url".into(), rel["html_url"].clone());
            o.insert("published_at".into(), rel["published_at"].clone());
            o.insert("assets".into(), json!(assets));
            o.insert("asset".into(), json!(if has { want } else { None }));
            (latest, has)
        }
        (Source::Repo, _, Some((_, m))) => {
            let want = asset_name(&m.version);
            let has = want.as_ref().map(|w| m.files.contains_key(w)).unwrap_or(false);
            let short = &m.commit[..m.commit.len().min(7)];
            o.insert("notes".into(), json!(format!("Repository build{}.", if short.is_empty() || m.commit == "unknown" { String::new() } else { format!(" (commit {short})") })));
            o.insert("html_url".into(), json!(format!("https://github.com/{}/tree/{BUILDS_BRANCH}", repo())));
            o.insert("published_at".into(), json!(m.date));
            o.insert("assets".into(), json!(m.files.iter().map(|(n, f)| json!({"name": n, "size": f.size})).collect::<Vec<_>>()));
            o.insert("asset".into(), json!(if has { want } else { None }));
            (m.version.clone(), has)
        }
        _ => (String::new(), false),
    };
    let upd = picked.is_some();
    if !latest.is_empty() {
        o.insert("latest".into(), json!(latest));
        o.insert("source".into(), json!(source.as_str()));
    } else {
        o.insert("reason".into(), json!("nothing published yet"));
    }
    o.insert("update_available".into(), json!(upd));
    o.insert("can_update".into(), json!(upd && has_asset && managed().is_none() && exe_ok));
    if !exe_ok {
        o.insert("reason".into(), json!("the server's folder isn't writable by the server"));
    } else if managed().is_some() {
        o.insert("reason".into(), json!("this server is bundled with the desktop app and updates with it"));
    } else if upd && !has_asset {
        o.insert("reason".into(), json!("this version has no server binary for this platform"));
    }
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
    let r = http.get(url).header("User-Agent", ua()).timeout(Duration::from_secs(900)).send().await?.error_for_status()?;
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

/// The new server binary (checked) and, when available and checked, the web app zip.
async fn download_update(http: &reqwest::Client) -> Result<(String, Vec<u8>, Option<Vec<u8>>)> {
    let (rel, builds) = fetch_both(http).await?;
    let rel_v = rel.as_ref().map(rel_version);
    let (source, latest) = pick(crate::api::VERSION, rel_v.as_deref(), builds.as_ref().map(|(_, m)| m.version.as_str())).ok_or_else(|| anyhow!("already up to date ({})", crate::api::VERSION))?;
    let want = asset_name(&latest).ok_or_else(|| anyhow!("no server builds for this platform"))?;
    let web_name = format!("tbw-web-{latest}.zip");
    match (source, rel, builds) {
        (Source::Release, Some(rel), _) => {
            let assets = rel["assets"].as_array().cloned().unwrap_or_default();
            let url_of = |n: &str| assets.iter().find(|a| a["name"].as_str() == Some(n)).and_then(|a| a["browser_download_url"].as_str().map(str::to_string));
            let bin_url = url_of(&want).ok_or_else(|| anyhow!("release v{latest} has no {want}"))?;
            let sums_url = url_of("SHA256SUMS").ok_or_else(|| anyhow!("release v{latest} has no SHA256SUMS"))?;
            let sums = String::from_utf8_lossy(&download(http, &sums_url, 1 << 20).await?).to_string();
            let expect = sum_for(&sums, &want).ok_or_else(|| anyhow!("SHA256SUMS has no entry for {want}"))?;
            tracing::info!("update: downloading {want} (release)");
            let bin = download(http, &bin_url, MAX_DOWNLOAD).await?;
            let got = sha256_hex(&bin);
            if got != expect {
                bail!("checksum mismatch for {want} (expected {expect}, got {got})");
            }
            let mut web = None;
            if let (Some(u), Some(h)) = (url_of(&web_name), sum_for(&sums, &web_name)) {
                match download(http, &u, MAX_DOWNLOAD).await {
                    Ok(z) if sha256_hex(&z) == h => web = Some(z),
                    Ok(_) => tracing::warn!("update: {web_name} checksum mismatch; web app not replaced"),
                    Err(e) => tracing::warn!("update: {web_name}: {e:#}"),
                }
            }
            Ok((latest, bin, web))
        }
        (Source::Repo, _, Some((base, m))) => {
            let entry = m.files.get(&want).ok_or_else(|| anyhow!("build {latest} has no {want}"))?;
            tracing::info!("update: downloading {want} ({} parts from the {BUILDS_BRANCH} branch)", entry.parts.len());
            let bin = download_parts(http, &base, entry, MAX_DOWNLOAD).await?;
            let mut web = None;
            if let Some(e) = m.files.get(&web_name) {
                match download_parts(http, &base, e, MAX_DOWNLOAD).await {
                    Ok(z) => web = Some(z),
                    Err(e) => tracing::warn!("update: {web_name}: {e:#}"),
                }
            }
            Ok((latest, bin, web))
        }
        _ => bail!("nothing to update from"),
    }
}

/// Download + verify + install. Returns the installed version.
pub async fn apply(http: &reqwest::Client) -> Result<(String, bool)> {
    if let Some(m) = managed() {
        bail!("this server is managed by the {m} app and updates with it");
    }
    let (latest, bin, web_zip) = download_update(http).await?;
    let exe = crate::admin::exe_path()?;
    // web app (optional)
    let mut web_ok = false;
    if let Some(z) = web_zip {
        let web = crate::config::paths().web;
        if web.join("index.html").is_file() && !web.to_string_lossy().contains(".asar") {
            let web2 = web.clone();
            match tokio::task::spawn_blocking(move || replace_web(&web2, &z)).await? {
                Ok(()) => web_ok = true,
                Err(e) => tracing::warn!("update: web app not replaced: {e:#}"),
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
        assert_eq!(semver("v0.8.1").unwrap().0, [0, 8, 1]);
        assert_eq!(semver("0.8").unwrap().0, [0, 8, 0]);
        assert_eq!(semver("1.2.3-beta.1").unwrap(), ([1, 2, 3], vec![Ident::Alpha("beta".into()), Ident::Num(1)]));
        assert!(semver("1.2.3.4").is_none() && semver("x").is_none() && semver("1.2.3-").is_none());
        assert!(newer("v0.10.0", "0.9.9"));
        assert!(!newer("0.7.0", "0.7.0"));
        assert!(!newer("garbage", "0.7.0"));
        assert!(newer("0.8.1", "0.8.1-rc.1"));
        assert!(!newer("0.8.1-beta", "0.8.1"));
        assert_eq!(cmp_versions("1.0.0+build.5", "1.0.0"), Ordering::Equal);
        assert_eq!(cmp_versions("1.0.0-1", "1.0.0-a"), Ordering::Less);
        assert_eq!(cmp_versions("garbage", "0.0.1"), Ordering::Less);
        // the semver spec's example order
        let order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0"];
        for w in order.windows(2) {
            assert_eq!(cmp_versions(w[0], w[1]), Ordering::Less, "{} < {}", w[0], w[1]);
            assert_eq!(cmp_versions(w[1], w[0]), Ordering::Greater);
        }
    }

    #[test]
    fn picking() {
        assert_eq!(pick("0.8.0", Some("v0.8.1"), Some("0.8.1")), Some((Source::Release, "0.8.1".into())));
        assert_eq!(pick("0.8.0", Some("0.8.1"), Some("0.8.2")), Some((Source::Repo, "0.8.2".into())));
        assert_eq!(pick("0.8.0", None, Some("0.8.1")), Some((Source::Repo, "0.8.1".into())));
        assert_eq!(pick("0.8.1", Some("0.8.1"), Some("0.8.1-rc.2")), None);
        assert_eq!(pick("0.8.1", None, None), None);
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

    /// manifest.json + parts for `data` split into `n`-byte parts
    fn fake(name: &str, data: &[u8], n: usize) -> (String, Vec<(String, Vec<u8>)>) {
        let mut parts = vec![];
        let mut js = vec![];
        for (i, c) in data.chunks(n).enumerate() {
            let p = format!("parts/{name}.part{i:02}");
            js.push(json!({"path": p, "size": c.len(), "sha256": sha256_hex(c)}));
            parts.push((p, c.to_vec()));
        }
        let m = json!({"version": "0.9.0", "date": "2026-10-14T00:00:00Z", "commit": "abc", "files": {name: {"size": data.len(), "sha256": sha256_hex(data), "parts": js}}});
        (m.to_string(), parts)
    }

    #[test]
    fn manifest_and_join() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let (m, parts) = fake("tbw-server-0.9.0-linux-x86_64", &data, 4096);
        let man = parse_manifest(&m).unwrap();
        let e = &man.files["tbw-server-0.9.0-linux-x86_64"];
        assert_eq!(e.parts.len(), 3);
        let bufs: Vec<Vec<u8>> = parts.iter().map(|p| p.1.clone()).collect();
        assert_eq!(join_parts(e, &bufs).unwrap(), data);
        let mut broken = bufs.clone();
        broken[1][0] ^= 1;
        assert!(join_parts(e, &broken).unwrap_err().to_string().contains("part01"));
        assert!(join_parts(e, &bufs[..2]).is_err());
        // bad manifests
        let mut v: Value = serde_json::from_str(&m).unwrap();
        v["files"]["tbw-server-0.9.0-linux-x86_64"]["parts"][0]["path"] = json!("../x");
        assert!(parse_manifest(&v.to_string()).is_err());
        let mut v: Value = serde_json::from_str(&m).unwrap();
        v["files"]["tbw-server-0.9.0-linux-x86_64"]["size"] = json!(1);
        assert!(parse_manifest(&v.to_string()).unwrap_err().to_string().contains("add up"));
        assert!(parse_manifest(r#"{"version":"x","files":{}}"#).is_err());
    }

    /// Serves a builds branch (pinned commit + API) over HTTP and downloads from it.
    #[tokio::test]
    async fn builds_download() {
        use axum::extract::Path as AxPath;
        use axum::routing::get;
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 253) as u8).collect();
        let name = "tbw-server-0.9.0-linux-x86_64";
        let (m, parts) = fake(name, &data, 30_000);
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let mut files: HashMap<String, Vec<u8>> = HashMap::new();
        files.insert(format!("raw/{sha}/manifest.json"), m.into_bytes());
        for (p, b) in parts {
            files.insert(format!("raw/{sha}/{p}"), b);
        }
        files.insert("api/repos/o/r/commits/builds".into(), sha.as_bytes().to_vec());
        let files = Arc::new(files);
        let hits = Arc::new(Mutex::new(0usize));
        let (f2, h2) = (files.clone(), hits.clone());
        let app = axum::Router::new().route(
            "/{*p}",
            get(move |AxPath(p): AxPath<String>| {
                let (files, hits) = (f2.clone(), h2.clone());
                async move {
                    // the second part is corrupted the first time it's asked for
                    if p.ends_with(".part01") {
                        let mut h = hits.lock();
                        *h += 1;
                        if *h == 1 {
                            return (StatusCode::OK, vec![0u8; 30_000]).into_response();
                        }
                    }
                    match files.get(&p) {
                        Some(b) => (StatusCode::OK, b.clone()).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.ok() });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{addr}");
        let (b, man) = fetch_builds_from(&http, &format!("{base}/raw"), &format!("{base}/api"), "o/r", "builds").await.unwrap().unwrap();
        assert_eq!(b, format!("{base}/raw/{sha}"));
        assert_eq!(man.version, "0.9.0");
        let got = download_parts(&http, &b, &man.files[name], MAX_DOWNLOAD).await.unwrap();
        assert_eq!(got, data);
        assert_eq!(*hits.lock(), 2, "the corrupted part was fetched again");
        // no branch → None; API down → branch name (404 here → None)
        assert!(fetch_builds_from(&http, &format!("{base}/raw"), &format!("{base}/nope"), "o/r", "builds").await.unwrap().is_none());
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
