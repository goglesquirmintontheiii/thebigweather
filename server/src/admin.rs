//! Local admin API behind the app's "Server settings" menu.
//!
//! Every route needs a request from this machine (loopback peer, no proxy headers) and passes
//! the normal token check (or `local_no_auth`); anything else gets 403.

use crate::api::AppState;
use crate::config::{self, Config, Keys};
use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

type St = State<Arc<AppState>>;

/// Fields that only take effect after a restart.
pub const RESTART_FIELDS: &[&str] = &[
    "server.bind",
    "server.data_dir",
    "server.web_dir",
    "server.metar_url",
    "profile.mode",
    "profile.threads",
    "profile.cpu_percent",
    "radar.level2_buckets",
    "radar.chunk_buckets",
    "radar.level3_buckets",
    "radar.tgftp_base",
    "radar.always_live",
    "radar.max_live_sites",
    "radar.live_poll_secs",
    "radar.local_archive_dir",
    "radar.sites_url",
    "alerts.enabled",
    "alerts.poll_secs",
    "alerts.url",
    "alerts.user_agent",
];

/// Sections of `Config` editable through PUT (keys and recorder are handled separately).
const SECTIONS: &[&str] = &["server", "profile", "radar", "grid", "alerts"];

static RESTART: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);
static NOTIFY: tokio::sync::Notify = tokio::sync::Notify::const_new();
static ARGS: once_cell::sync::OnceCell<Vec<OsString>> = once_cell::sync::OnceCell::new();

pub fn set_args(a: Vec<OsString>) {
    let _ = ARGS.set(a);
}
/// Clear the restart flags after an in-process restart (Windows, service).
pub fn reset_restart() {
    RESTART.store(false, Ordering::SeqCst);
    PENDING.store(false, Ordering::SeqCst);
}
pub fn restart_requested() -> bool {
    RESTART.load(Ordering::SeqCst)
}
/// Resolves when a restart has been requested.
pub async fn restart_signal() {
    NOTIFY.notified().await
}

fn exe_path() -> std::io::Result<std::path::PathBuf> {
    let p = std::env::current_exe()?;
    // Linux reports "<path> (deleted)" when the binary was replaced by a rebuild: use the new one
    let s = p.to_string_lossy();
    let p = match s.strip_suffix(" (deleted)") {
        Some(x) => std::path::PathBuf::from(x),
        None => p,
    };
    if !p.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("{} not found", p.display())));
    }
    Ok(p)
}

/// Replace this process with a fresh copy of the server binary (same arguments). Unix uses
/// exec (same PID); elsewhere a new process is started and this one exits (Windows normally
/// restarts in-process instead, see `main::serve`).
pub fn reexec() -> anyhow::Result<()> {
    let exe = exe_path()?;
    let args: Vec<OsString> = ARGS.get().cloned().unwrap_or_default().into_iter().skip(1).collect();
    tracing::info!("restarting {}", exe.display());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new(&exe).args(&args).exec();
        tracing::error!("exec failed: {e}; starting a new process instead");
    }
    std::process::Command::new(&exe).args(&args).spawn()?;
    Ok(())
}

pub fn router(_st: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/admin/config", get(config_get).put(config_put))
        .route("/admin/restart", post(restart))
        .route("/admin/token", post(token))
        .route("/admin/caches", get(caches))
        .route("/admin/caches/clear", post(caches_clear))
        .route("/admin/logs", get(logs))
        .route_layer(middleware::from_fn(local_only))
}

/// Loopback host name ("localhost", "127.0.0.1", "[::1]", optional port).
fn loopback_host(h: &str) -> bool {
    let h = h.trim();
    let host = if let Some(r) = h.strip_prefix('[') { r.split(']').next().unwrap_or("") } else { h.rsplit_once(':').map(|(a, _)| a).unwrap_or(h) };
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// Blocks other web pages open in a browser on this machine (CORS is permissive and
/// `local_no_auth` skips the token): the Origin must be the app itself or a loopback page, and the
/// Host must be loopback (DNS rebinding).
fn trusted_origin(req: &Request) -> bool {
    let hdr = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    if let Some(h) = hdr("host") {
        if !loopback_host(&h) {
            return false;
        }
    }
    match hdr("origin") {
        None => true,
        Some(o) if o == "null" || o.starts_with("app://") || o.starts_with("file://") => true,
        Some(o) => o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")).map(loopback_host).unwrap_or(false),
    }
}

async fn local_only(req: Request, next: Next) -> Response {
    if crate::api::is_local(&req) && trusted_origin(&req) {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, Json(json!({"error": "server settings are only available on the server's own computer"}))).into_response()
    }
}

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

// ---------- config ----------

fn config_json(st: &AppState) -> Value {
    let c = st.cfg.read().clone();
    let now = config::detect_profile(&c);
    let p = config::paths();
    let keys: Map<String, Value> = Keys::NAMES.iter().map(|k| (k.to_string(), json!(c.keys.get(k).map(|v| !v.is_empty()).unwrap_or(false)))).collect();
    json!({
        "server": {
            "name": c.server.name, "bind": c.server.bind, "public_url": c.server.public_url,
            "local_no_auth": c.server.local_no_auth, "data_dir": c.server.data_dir, "web_dir": c.server.web_dir,
            "metar_url": c.server.metar_url,
        },
        "profile": c.profile,
        "radar": c.radar,
        "grid": c.grid,
        "alerts": c.alerts,
        "recorder": *st.rec.rules.lock(),
        "effective": {
            "profile": st.profile.name,
            "cpus": st.profile.cores,
            "ram_total_mb": now.ram_mb,
            "memory_mb": now.memory_mb,
            "memory_default_mb": config::default_memory_mb(now.ram_mb),
            "budget": now.budget,
            "threads": st.profile.threads,
            "decode_threads": now.threads,
            "cpu_percent": now.cpu_percent,
            "cpu_threads": now.cpu_threads,
            "disk_cache_mb": st.radar.disk_cap.load(Ordering::Relaxed) / (1024 * 1024),
            "max_live_sites": st.profile.max_live_sites,
            "live_poll_secs": st.profile.live_poll_secs,
            "alert_poll_secs": st.profile.alert_poll_secs,
        },
        "keys": keys,
        "paths": {"config": p.config, "data": p.data, "cache": p.cache, "web": p.web},
        "restart_required_fields": RESTART_FIELDS,
        "pending_restart": PENDING.load(Ordering::Relaxed),
        "version": crate::api::VERSION,
        "pid": std::process::id(),
    })
}

async fn config_get(State(st): St) -> Json<Value> {
    Json(config_json(&st))
}

/// Same JSON kind (numbers must stay non-negative integers where the old value was one).
fn same_kind(old: &Value, new: &Value) -> bool {
    match (old, new) {
        (Value::Number(o), Value::Number(n)) => !(o.is_u64() && !n.is_u64()),
        (Value::String(_), Value::String(_)) | (Value::Bool(_), Value::Bool(_)) => true,
        (Value::Array(_), Value::Array(a)) => a.iter().all(|x| x.is_string()),
        _ => false,
    }
}

fn is_url(s: &str) -> bool {
    (s.starts_with("https://") || s.starts_with("http://")) && s.len() > 10 && !s.contains(char::is_whitespace)
}

/// Field-level checks on a candidate config.
pub fn validate(c: &Config, ram_mb: u64, errors: &mut Map<String, Value>) {
    let mut e = |f: &str, m: &str| {
        errors.insert(f.into(), json!(m));
    };
    if c.server.bind.parse::<std::net::SocketAddr>().is_err() {
        e("server.bind", "address:port, e.g. 0.0.0.0:8787");
    }
    let n = c.server.name.trim();
    if n.is_empty() || n.chars().count() > 64 {
        e("server.name", "1-64 characters");
    }
    if !c.server.public_url.is_empty() && !is_url(&c.server.public_url) {
        e("server.public_url", "must start with http:// or https://");
    }
    if c.server.data_dir.as_os_str().is_empty() {
        e("server.data_dir", "required");
    }
    for (f, u) in [
        ("server.metar_url", &c.server.metar_url),
        ("radar.tgftp_base", &c.radar.tgftp_base),
        ("radar.sites_url", &c.radar.sites_url),
        ("alerts.url", &c.alerts.url),
        ("grid.metar_archive_url", &c.grid.metar_archive_url),
    ] {
        if !is_url(u) {
            e(f, "must be an http(s) URL");
        }
    }
    if !["auto", "full", "lite"].contains(&c.profile.mode.as_str()) {
        e("profile.mode", "auto, full or lite");
    }
    if c.profile.threads > 1024 {
        e("profile.threads", "0 (auto) to 1024");
    }
    if !(1..=100).contains(&c.profile.cpu_percent) {
        e("profile.cpu_percent", "1 to 100");
    }
    if c.profile.memory_mb != 0 && (c.profile.memory_mb < 256 || c.profile.memory_mb as u64 > ram_mb.max(512)) {
        e("profile.memory_mb", &format!("0 (auto) or 256 to {ram_mb} MB"));
    }
    if c.profile.disk_cache_mb != 0 && c.profile.disk_cache_mb < 256 {
        e("profile.disk_cache_mb", "0 (auto) or at least 256 MB");
    }
    let bucket_ok = |b: &String| !b.is_empty() && b.len() <= 63 && b.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.');
    for (f, v) in [("radar.level2_buckets", &c.radar.level2_buckets), ("radar.chunk_buckets", &c.radar.chunk_buckets), ("radar.level3_buckets", &c.radar.level3_buckets)] {
        if v.is_empty() || !v.iter().all(bucket_ok) {
            e(f, "one or more S3 bucket names");
        }
    }
    if !c.radar.always_live.iter().all(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_alphanumeric())) {
        e("radar.always_live", "4-letter radar ids, e.g. KTLX");
    }
    if c.radar.max_live_sites > 64 {
        e("radar.max_live_sites", "0 (auto) to 64");
    }
    if c.radar.live_poll_secs > 300 {
        e("radar.live_poll_secs", "0 (auto) to 300");
    }
    if !c.radar.local_archive_dir.is_empty() && !std::path::Path::new(&c.radar.local_archive_dir).is_dir() {
        e("radar.local_archive_dir", "folder not found");
    }
    if c.alerts.poll_secs != 0 && !(10..=3600).contains(&c.alerts.poll_secs) {
        e("alerts.poll_secs", "0 (auto) or 10 to 3600");
    }
    if c.alerts.user_agent.trim().is_empty() {
        e("alerts.user_agent", "required (NWS asks for a contact)");
    }
    if c.grid.metar_archive_disk_mb > 1_000_000 {
        e("grid.metar_archive_disk_mb", "0 (auto) to 1000000");
    }
}

/// Apply a partial `{section: {field: value}}` patch. Returns the new config, the changed
/// "section.field" names and the new recorder rules (if given), or field errors.
#[allow(clippy::type_complexity)]
pub fn apply_patch(old: &Config, rules: &crate::recorder::Rules, body: &Value, ram_mb: u64) -> Result<(Config, Vec<String>, Option<crate::recorder::Rules>), Map<String, Value>> {
    let mut errors = Map::new();
    let Some(obj) = body.as_object() else {
        errors.insert("_".into(), json!("body must be a JSON object"));
        return Err(errors);
    };
    let mut cur = serde_json::to_value(old).unwrap_or_default();
    let mut keys: Vec<(String, String)> = vec![];
    let mut new_rules = None;
    for (sec, v) in obj {
        let Some(fields) = v.as_object() else {
            errors.insert(sec.clone(), json!("must be an object"));
            continue;
        };
        match sec.as_str() {
            s if SECTIONS.contains(&s) => {
                for (f, val) in fields {
                    let name = format!("{s}.{f}");
                    if f == "token" {
                        errors.insert(name, json!("use POST /api/admin/token"));
                        continue;
                    }
                    match cur[s].get(f) {
                        Some(o) if same_kind(o, val) => cur[s][f] = val.clone(),
                        Some(_) => {
                            errors.insert(name, json!("wrong type"));
                        }
                        None => {
                            errors.insert(name, json!("unknown setting"));
                        }
                    }
                }
            }
            "keys" => {
                for (k, val) in fields {
                    match val.as_str() {
                        Some(s) if Keys::NAMES.contains(&k.as_str()) => keys.push((k.clone(), s.trim().to_string())),
                        Some(_) => {
                            errors.insert(format!("keys.{k}"), json!("unknown key"));
                        }
                        None => {
                            errors.insert(format!("keys.{k}"), json!("must be a string"));
                        }
                    }
                }
            }
            "recorder" => {
                let mut r = serde_json::to_value(rules).unwrap_or_default();
                for (f, val) in fields {
                    if r.get(f).is_none() {
                        errors.insert(format!("recorder.{f}"), json!("unknown setting"));
                    } else {
                        r[f] = val.clone();
                    }
                }
                match serde_json::from_value::<crate::recorder::Rules>(r) {
                    Ok(r) => new_rules = Some(r),
                    Err(e) => {
                        errors.insert("recorder".into(), json!(e.to_string()));
                    }
                }
            }
            "effective" | "paths" | "restart_required_fields" | "pending_restart" | "version" | "pid" => {}
            _ => {
                errors.insert(sec.clone(), json!("unknown section"));
            }
        }
    }
    let mut new: Config = match serde_json::from_value(cur) {
        Ok(c) => c,
        Err(e) => {
            errors.insert("_".into(), json!(e.to_string()));
            return Err(errors);
        }
    };
    for (k, v) in keys {
        new.keys.set(&k, v);
    }
    validate(&new, ram_mb, &mut errors);
    if !errors.is_empty() {
        return Err(errors);
    }
    let (a, b) = (serde_json::to_value(old).unwrap_or_default(), serde_json::to_value(&new).unwrap_or_default());
    let mut changed = vec![];
    if let (Some(a), Some(b)) = (a.as_object(), b.as_object()) {
        for (sec, bv) in b {
            if let (Some(bo), Some(ao)) = (bv.as_object(), a.get(sec).and_then(|x| x.as_object())) {
                for (f, x) in bo {
                    if ao.get(f) != Some(x) {
                        changed.push(format!("{sec}.{f}"));
                    }
                }
            }
        }
    }
    if let Some(r) = &new_rules {
        if serde_json::to_value(r).ok() != serde_json::to_value(rules).ok() {
            changed.push("recorder".into());
        }
    }
    Ok((new, changed, new_rules))
}

/// Push live-applicable settings into the running services.
fn apply_live(st: &AppState, c: &Config, changed: &[String]) -> Vec<String> {
    let mut applied = vec![];
    let has = |p: &str| changed.iter().any(|f| f.starts_with(p));
    let eff = config::detect_profile(c);
    if has("profile.memory_mb") || has("profile.mode") || has("grid.") {
        st.radar.set_budget(eff.budget.radar_mb);
        st.grids.set_budget(eff.budget.grid_mb);
        st.grids.metar_archive.configure(&c.grid, eff.budget.other_mb);
        st.intl.set_budget(eff.budget.other_mb);
        if has("profile.memory_mb") {
            applied.push("profile.memory_mb".into());
        }
        applied.extend(changed.iter().filter(|f| f.starts_with("grid.")).cloned());
    }
    if has("profile.disk_cache_mb") {
        st.radar.disk_cap.store(crate::disk_cap_bytes(c.profile.disk_cache_mb, &config::paths().data), Ordering::Relaxed);
        applied.push("profile.disk_cache_mb".into());
    }
    if has("profile.cpu_percent") || has("profile.threads") {
        // concurrent decodes follow now; the thread pools are sized at start
        st.radar.set_threads(eff.threads);
        st.grids.set_threads(eff.threads);
        applied.push("profile.decode_threads".into());
    }
    for f in ["server.name", "server.public_url", "server.local_no_auth"] {
        if has(f) {
            applied.push(f.into());
        }
    }
    applied.extend(changed.iter().filter(|f| f.starts_with("keys.")).cloned());
    applied
}

async fn config_put(State(st): St, Json(body): Json<Value>) -> Response {
    let old = st.cfg.read().clone();
    let rules = st.rec.rules.lock().clone();
    let ram = config::total_ram_mb();
    let (new, changed, new_rules) = match apply_patch(&old, &rules, &body, ram) {
        Ok(x) => x,
        Err(errors) => return Json(json!({"ok": false, "restart_required": false, "applied": [], "changed": [], "errors": errors})).into_response(),
    };
    let cfg_changed = changed.iter().any(|f| f != "recorder");
    if cfg_changed {
        let path = st.cfg_path.clone();
        let c2 = new.clone();
        match tokio::task::spawn_blocking(move || c2.save(&path)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Json(json!({"ok": false, "restart_required": false, "applied": [], "changed": [], "errors": {"_save": e.to_string()}})).into_response(),
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
        }
        *st.cfg.write() = new.clone();
    }
    let mut applied = apply_live(&st, &new, &changed);
    if let Some(r) = new_rules.filter(|_| changed.iter().any(|f| f == "recorder")) {
        st.rec.save_rules(r);
        applied.push("recorder".into());
    }
    let restart_required = changed.iter().any(|f| RESTART_FIELDS.contains(&f.as_str()));
    if restart_required {
        PENDING.store(true, Ordering::Relaxed);
    }
    if !changed.is_empty() {
        tracing::info!("settings changed: {}", changed.join(", "));
    }
    Json(json!({"ok": true, "restart_required": restart_required, "pending_restart": PENDING.load(Ordering::Relaxed), "applied": applied, "changed": changed, "errors": {}})).into_response()
}

// ---------- restart / token ----------

async fn restart() -> Response {
    let exe = match exe_path() {
        Ok(p) => p,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("can't restart: {e}")),
    };
    if RESTART.swap(true, Ordering::SeqCst) {
        return Json(json!({"ok": true, "restarting": true})).into_response();
    }
    tokio::spawn(async {
        // let this response reach the app first
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        NOTIFY.notify_one();
    });
    Json(json!({"ok": true, "restarting": true, "exe": exe})).into_response()
}

async fn token(State(st): St) -> Response {
    let mut c = st.cfg.read().clone();
    c.server.token = config::new_token();
    let path = st.cfg_path.clone();
    let c2 = c.clone();
    match tokio::task::spawn_blocking(move || c2.save(&path)).await {
        Ok(Ok(())) => {
            let t = c.server.token.clone();
            *st.cfg.write() = c;
            tracing::info!("access token regenerated");
            Json(json!({"token": t})).into_response()
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------- caches ----------

/// Disk cache folders: (id, name, path, cap bytes).
fn disk_caches(st: &AppState) -> Vec<(String, String, std::path::PathBuf, u64)> {
    let p = config::paths();
    let mut v = vec![
        ("disk:raw".to_string(), "Disk: raw downloads (radar, grids)".to_string(), p.cache.join("raw"), st.radar.disk_cap.load(Ordering::Relaxed)),
        ("disk:metar_archive".into(), "Disk: archived METAR hours".into(), st.grids.metar_archive.dir().to_path_buf(), {
            let c = st.cfg.read().grid.metar_archive_disk_mb;
            (if c > 0 { c } else { 512 }) << 20
        }),
        ("disk:overlays".into(), "Disk: overlay lists".into(), p.data.join("overlays"), 0),
    ];
    if let Ok(rd) = std::fs::read_dir(&p.cache) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !v.iter().any(|x| x.0 == format!("disk:{name}")) {
                v.push((format!("disk:{name}"), format!("Disk: {name}"), e.path(), 0));
            }
        }
    }
    v
}

fn mem_caches(st: &AppState) -> Vec<crate::caches::CacheInfo> {
    let mut v = st.radar.cache_stats();
    v.extend(st.grids.cache_stats());
    v.push(st.intl.cache_stats());
    v.push(st.overlays.cache_stats());
    v.extend(st.overlays.extra_cache_stats());
    v
}

async fn caches(State(st): St) -> Response {
    let mut out = mem_caches(&st);
    let dirs = disk_caches(&st);
    let disk = tokio::task::spawn_blocking(move || {
        dirs.into_iter()
            .map(|(id, name, p, cap)| {
                let (bytes, items) = crate::caches::dir_size(&p);
                crate::caches::CacheInfo { id, name, kind: "disk", bytes, items, cap_bytes: cap }
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    out.extend(disk);
    Json(json!(out)).into_response()
}

async fn caches_clear(State(st): St, Query(q): Query<HashMap<String, String>>) -> Response {
    let id = q.get("id").map(|s| s.as_str()).unwrap_or("");
    if id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "id=<cache id>|all required");
    }
    let all = id == "all";
    let mut cleared = vec![];
    for c in mem_caches(&st) {
        if all || c.id == id {
            let ok = match c.id.as_str() {
                "intl-images" => {
                    st.intl.clear_cache();
                    true
                }
                "overlays" => {
                    st.overlays.clear_cache();
                    true
                }
                x => st.radar.clear_cache(x) || st.grids.clear_cache(x) || st.overlays.clear_extra(x),
            };
            if ok {
                cleared.push(c.id);
            }
        }
    }
    let dirs: Vec<_> = disk_caches(&st).into_iter().filter(|d| all || d.0 == id).collect();
    cleared.extend(dirs.iter().map(|d| d.0.clone()));
    let freed = tokio::task::spawn_blocking(move || dirs.iter().map(|d| crate::caches::clear_dir(&d.2)).sum::<u64>()).await.unwrap_or(0);
    if cleared.is_empty() {
        return err(StatusCode::NOT_FOUND, format!("unknown cache {id}"));
    }
    tracing::info!("cleared caches: {}", cleared.join(", "));
    Json(json!({"ok": true, "cleared": cleared, "disk_bytes_freed": freed})).into_response()
}

// ---------- logs ----------

async fn logs(Query(q): Query<HashMap<String, String>>) -> Json<Value> {
    let n = q.get("n").and_then(|s| s.parse::<usize>().ok()).unwrap_or(200).clamp(1, crate::logbuf::CAP);
    Json(json!({"lines": crate::logbuf::tail(n)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_validate_and_roundtrip() {
        let existing = "# header kept\n[server]\n# listen here\nbind = \"0.0.0.0:8787\"\nname = \"Home\"\n\n[profile]\nmode = \"auto\" # comment\nmemory_mb = 0\n";
        let old: Config = toml::from_str(existing).unwrap();
        let rules = crate::recorder::Rules::default();
        let body = json!({
            "server": {"name": "Cabin", "bind": "127.0.0.1:9000"},
            "profile": {"cpu_percent": 50, "memory_mb": 8192},
            "keys": {"tomtom": " abc "},
            "recorder": {"minutes": 30},
            "effective": {"memory_mb": 1},
        });
        let (new, changed, r) = apply_patch(&old, &rules, &body, 32_000).unwrap();
        assert_eq!(new.server.name, "Cabin");
        assert_eq!(new.keys.tomtom, "abc");
        assert_eq!(r.unwrap().minutes, 30);
        for f in ["server.name", "server.bind", "profile.cpu_percent", "profile.memory_mb", "keys.tomtom", "recorder"] {
            assert!(changed.iter().any(|c| c == f), "{f} in {changed:?}");
        }
        assert!(changed.iter().any(|f| RESTART_FIELDS.contains(&f.as_str())));
        let out = new.merge_into(existing).unwrap();
        assert!(out.starts_with("# header kept\n[server]\n# listen here\nbind = \"127.0.0.1:9000\"\n"), "{out}");
        assert!(out.contains("mode = \"auto\" # comment"), "{out}");
        assert!(out.contains("memory_mb = 8192") && out.contains("cpu_percent = 50") && out.contains("tomtom = \"abc\""), "{out}");
        let back: Config = toml::from_str(&out).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&new).unwrap());

        // errors are per field and nothing is applied
        let bad = json!({"server": {"bind": "nope", "token": "x", "zzz": 1}, "profile": {"cpu_percent": 0, "threads": "four"}, "keys": {"nokey": "1"}, "bogus": {}});
        let e = apply_patch(&old, &rules, &bad, 32_000).unwrap_err();
        for f in ["server.bind", "server.token", "server.zzz", "profile.cpu_percent", "profile.threads", "keys.nokey", "bogus"] {
            assert!(e.contains_key(f), "{f} in {e:?}");
        }
        let e = apply_patch(&old, &rules, &json!({"profile": {"memory_mb": 100}}), 32_000).unwrap_err();
        assert!(e.contains_key("profile.memory_mb"));
        // no-op patch changes nothing
        let (_, changed, _) = apply_patch(&old, &rules, &json!({"server": {"name": "Home"}}), 32_000).unwrap();
        assert!(changed.is_empty(), "{changed:?}");
    }

    #[test]
    fn origin_guard() {
        let mk = |host: &str, origin: Option<&str>| {
            let mut b = axum::http::Request::builder().uri("/api/admin/config").header("host", host);
            if let Some(o) = origin {
                b = b.header("origin", o);
            }
            trusted_origin(&b.body(axum::body::Body::empty()).unwrap())
        };
        assert!(mk("127.0.0.1:8787", None));
        assert!(mk("localhost:8787", Some("app://tbw")));
        assert!(mk("[::1]:8787", Some("http://localhost:5173")));
        assert!(mk("127.0.0.1:8787", Some("http://127.0.0.1:8787")));
        assert!(!mk("127.0.0.1:8787", Some("https://evil.example")));
        assert!(!mk("evil.example:8787", None));
    }
}
