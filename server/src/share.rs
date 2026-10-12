//! Share links: a read-only live view of a saved workspace for friends and family.
//!
//! `POST /api/share` stores the workspace and returns `<public url>/s/<id>`. Opening that link
//! redirects to the web UI with `?share=<id>`; the page fetches `GET /api/share/<id>` (no auth)
//! for the workspace and a scoped token that may only GET data endpoints (radar, grids,
//! overlays, alerts, sites, catalog) — never settings, keys, recordings, shares or admin.

use crate::api::AppState;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

/// Largest workspace accepted (JSON bytes).
pub const MAX_WORKSPACE: usize = 512 * 1024;
/// Most shares kept at once.
pub const MAX_SHARES: usize = 200;
/// Longest expiry (hours); 0 = never expires.
pub const MAX_HOURS: u64 = 24 * 90;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Share {
    pub id: String,
    pub name: String,
    pub workspace: Value,
    /// ms since epoch
    pub created: i64,
    pub updated: i64,
    /// ms since epoch; 0 = never
    pub expires: i64,
    /// the owner keeps updating the workspace (viewers poll for changes)
    pub live: bool,
    /// scoped read-only token handed to viewers
    pub token: String,
    #[serde(default)]
    pub views: u64,
}

impl Share {
    fn expired(&self, now: i64) -> bool {
        self.expires > 0 && now >= self.expires
    }
    fn summary(&self, base: &str) -> Value {
        json!({
            "id": self.id, "name": self.name, "created": self.created, "updated": self.updated,
            "expires": self.expires, "live": self.live, "views": self.views,
            "url": format!("{base}/s/{}", self.id),
        })
    }
}

/// Fixed-window request counter.
#[derive(Default)]
pub struct Limiter {
    map: Mutex<HashMap<String, (i64, u32)>>,
}

impl Limiter {
    /// True while `key` has made at most `max` calls in the current `window_s` window.
    pub fn allow(&self, key: &str, max: u32, window_s: i64) -> bool {
        let now = now_ms() / 1000;
        let win = now / window_s.max(1);
        let mut m = self.map.lock();
        if m.len() > 10_000 {
            m.retain(|_, (w, _)| *w == win);
        }
        let e = m.entry(key.to_string()).or_insert((win, 0));
        if e.0 != win {
            *e = (win, 0);
        }
        e.1 += 1;
        e.1 <= max
    }
}

pub struct Shares {
    path: PathBuf,
    map: RwLock<HashMap<String, Share>>,
    pub limit: Limiter,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Random id from an unambiguous alphabet.
pub fn rand_id(n: usize) -> String {
    const A: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    (0..n).map(|_| A[rand::random::<u32>() as usize % A.len()] as char).collect()
}

impl Shares {
    pub fn new(data: &std::path::Path) -> Arc<Shares> {
        let path = data.join("shares.json");
        let list: Vec<Share> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let now = now_ms();
        let map = list.into_iter().filter(|s| !s.expired(now)).map(|s| (s.id.clone(), s)).collect();
        Arc::new(Shares { path, map: RwLock::new(map), limit: Limiter::default() })
    }

    fn save(&self) {
        let list: Vec<Share> = self.map.read().values().cloned().collect();
        if let Ok(b) = serde_json::to_vec(&list) {
            if let Err(e) = crate::platform::write_atomic(&self.path, &b) {
                tracing::warn!("saving shares: {e}");
            }
        }
    }

    /// Share id for a scoped token (only while the share exists and hasn't expired).
    pub fn by_token(&self, token: &str) -> Option<String> {
        let now = now_ms();
        self.map.read().values().find(|s| s.token == token && !s.expired(now)).map(|s| s.id.clone())
    }

    pub fn create(&self, name: &str, workspace: Value, expires_h: u64, live: bool) -> Result<Share, String> {
        let size = serde_json::to_vec(&workspace).map(|v| v.len()).unwrap_or(usize::MAX);
        if size > MAX_WORKSPACE {
            return Err(format!("workspace too large ({} KB, max {} KB)", size / 1024, MAX_WORKSPACE / 1024));
        }
        if !workspace.is_object() {
            return Err("workspace must be a JSON object".into());
        }
        let now = now_ms();
        let mut m = self.map.write();
        m.retain(|_, s| !s.expired(now));
        if m.len() >= MAX_SHARES {
            return Err(format!("too many shares ({MAX_SHARES}); delete some first"));
        }
        let mut id = rand_id(10);
        while m.contains_key(&id) {
            id = rand_id(10);
        }
        let s = Share {
            id: id.clone(),
            name: clean_name(name),
            workspace,
            created: now,
            updated: now,
            expires: if expires_h == 0 { 0 } else { now + expires_h.min(MAX_HOURS) as i64 * 3_600_000 },
            live,
            token: format!("shr_{}", hex::encode(rand::random::<[u8; 20]>())),
            views: 0,
        };
        m.insert(id, s.clone());
        drop(m);
        self.save();
        Ok(s)
    }

    pub fn update(&self, id: &str, workspace: Option<Value>, name: Option<&str>) -> Result<Share, String> {
        if let Some(w) = &workspace {
            if serde_json::to_vec(w).map(|v| v.len()).unwrap_or(usize::MAX) > MAX_WORKSPACE {
                return Err("workspace too large".into());
            }
        }
        let s = {
            let mut m = self.map.write();
            let s = m.get_mut(id).ok_or("no such share")?;
            if let Some(w) = workspace {
                s.workspace = w;
            }
            if let Some(n) = name {
                s.name = clean_name(n);
            }
            s.updated = now_ms();
            s.clone()
        };
        self.save();
        Ok(s)
    }

    pub fn get(&self, id: &str, count_view: bool) -> Option<Share> {
        let now = now_ms();
        let mut m = self.map.write();
        let s = m.get_mut(id).filter(|s| !s.expired(now))?;
        if count_view {
            s.views += 1;
        }
        Some(s.clone())
    }

    pub fn delete(&self, id: &str) -> bool {
        let gone = self.map.write().remove(id).is_some();
        if gone {
            self.save();
        }
        gone
    }

    pub fn list(&self) -> Vec<Share> {
        let now = now_ms();
        let mut v: Vec<Share> = self.map.read().values().filter(|s| !s.expired(now)).cloned().collect();
        v.sort_by_key(|s| -s.created);
        v
    }

    fn purge(&self) {
        let now = now_ms();
        let n = {
            let mut m = self.map.write();
            let before = m.len();
            m.retain(|_, s| !s.expired(now));
            before - m.len()
        };
        if n > 0 {
            self.save();
        }
    }
}

fn clean_name(n: &str) -> String {
    let n: String = n.trim().chars().filter(|c| !c.is_control()).take(80).collect();
    if n.is_empty() { "Shared view".into() } else { n }
}

pub fn spawn_janitor(s: Arc<Shares>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            s.purge();
        }
    });
}

/// Endpoints (below /api) a share token may GET.
const ALLOWED: &[&str] = &[
    "/info", "/sites", "/l3/", "/radar/", "/live/", "/alerts", "/sources", "/grid/", "/ovl/", "/metars", "/intlradar", "/arcgis/", "/camimg", "/sounding", "/ws",
    // phase 6 data: climate (ACIS), placefiles (SSRF-guarded proxy)
    "/climate", "/placefile",
];
/// Never allowed even below an allowed prefix.
const DENIED: &[&str] = &["/radar/upload"];

pub fn allowed(method: &Method, path: &str) -> bool {
    let p = path.strip_prefix("/api").filter(|r| r.starts_with('/')).unwrap_or(path);
    if (method != Method::GET && method != Method::HEAD) || p.contains("..") {
        return false;
    }
    if DENIED.iter().any(|d| p.starts_with(d)) {
        return false;
    }
    ALLOWED.iter().any(|a| if a.ends_with('/') { p.starts_with(a) } else { p == *a || p.starts_with(&format!("{a}/")) })
}

/// Base URL for links: `public_url` from the config, else the request's Host.
pub fn base_url(st: &AppState, headers: &HeaderMap) -> String {
    let pu = st.cfg.read().server.public_url.trim().trim_end_matches('/').to_string();
    if !pu.is_empty() {
        return pu;
    }
    let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(|s| s.split(',').next().unwrap_or("").trim().to_string());
    let host = h("x-forwarded-host").or_else(|| h("host")).unwrap_or_else(|| "localhost:8787".into());
    let proto = h("x-forwarded-proto").unwrap_or_else(|| "http".into());
    let proto = if proto == "https" { "https" } else { "http" };
    format!("{proto}://{host}")
}

/// Who is asking (for rate limits): the bearer/query token, or the local machine.
fn caller(req_headers: &HeaderMap, query: Option<&str>) -> String {
    let t = req_headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v).to_string())
        .or_else(|| query.and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=").map(str::to_string))))
        .unwrap_or_else(|| "local".into());
    // don't keep tokens around as map keys
    hex::encode(&t.as_bytes()[..t.len().min(12)])
}

fn err(code: StatusCode, msg: impl std::fmt::Display) -> Response {
    (code, Json(json!({"error": msg.to_string()}))).into_response()
}

type St = State<Arc<AppState>>;

#[derive(Deserialize)]
pub struct CreateReq {
    #[serde(default)]
    name: String,
    workspace: Value,
    #[serde(default = "default_hours")]
    expires_h: u64,
    #[serde(default)]
    live: bool,
}
fn default_hours() -> u64 {
    24
}

/// POST /api/share (auth)
pub async fn create(State(st): St, headers: HeaderMap, req: Request) -> Response {
    let who = caller(&headers, req.uri().query());
    if !st.shares.limit.allow(&format!("create:{who}"), 30, 3600) {
        return err(StatusCode::TOO_MANY_REQUESTS, "too many shares created; try again later");
    }
    let body = match axum::body::to_bytes(req.into_body(), MAX_WORKSPACE + 4096).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::PAYLOAD_TOO_LARGE, "workspace too large"),
    };
    let r: CreateReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("bad request: {e}")),
    };
    match st.shares.create(&r.name, r.workspace, r.expires_h, r.live) {
        Ok(s) => {
            let base = base_url(&st, &headers);
            let mut v = s.summary(&base);
            v["url"] = json!(format!("{base}/s/{}", s.id));
            Json(v).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

/// GET /api/shares (auth)
pub async fn list(State(st): St, headers: HeaderMap) -> Json<Value> {
    let base = base_url(&st, &headers);
    Json(json!(st.shares.list().iter().map(|s| s.summary(&base)).collect::<Vec<_>>()))
}

/// GET /api/share/{id} (public): the workspace + the scoped viewer token.
pub async fn public_get(State(st): St, Path(id): Path<String>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|s| s.split(',').next()).map(|s| s.trim().to_string()).unwrap_or_else(|| peer.ip().to_string());
    if !st.shares.limit.allow(&format!("view:{ip}"), 120, 60) {
        return err(StatusCode::TOO_MANY_REQUESTS, "slow down");
    }
    let first = headers.get("x-tbw-share-poll").is_none();
    match st.shares.get(&id, first) {
        Some(s) => {
            let mut r = Json(json!({
                "id": s.id, "name": s.name, "workspace": s.workspace, "live": s.live,
                "created": s.created, "updated": s.updated, "expires": s.expires, "token": s.token,
                "server": st.cfg.read().server.name,
            }))
            .into_response();
            r.headers_mut().insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
            r
        }
        None => err(StatusCode::NOT_FOUND, "this share link has expired or was removed"),
    }
}

/// PUT /api/share/{id} (full auth, checked here): replace the workspace of a live share.
pub async fn update(State(st): St, Path(id): Path<String>, req: Request) -> Response {
    if !crate::api::full_access(&st, &req) {
        return err(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let body: Bytes = match axum::body::to_bytes(req.into_body(), MAX_WORKSPACE + 4096).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::PAYLOAD_TOO_LARGE, "workspace too large"),
    };
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("bad json: {e}")),
    };
    let ws = v.get("workspace").cloned().filter(|w| w.is_object());
    match st.shares.update(&id, ws, v.get("name").and_then(|n| n.as_str())) {
        Ok(s) => Json(json!({"ok": true, "updated": s.updated})).into_response(),
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

/// DELETE /api/share/{id} (full auth, checked here)
pub async fn delete(State(st): St, Path(id): Path<String>, req: Request) -> Response {
    if !crate::api::full_access(&st, &req) {
        return err(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if st.shares.delete(&id) { Json(json!({"ok": true})).into_response() } else { err(StatusCode::NOT_FOUND, "no such share") }
}

/// GET /s/{id}: open the web UI in viewer mode.
pub async fn open(Path(id): Path<String>) -> Response {
    let id: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(32).collect();
    Redirect::temporary(&format!("/?share={id}")).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_paths() {
        let g = Method::GET;
        assert!(allowed(&g, "/radar/sweep"));
        assert!(allowed(&g, "/api/radar/sweep"));
        assert!(allowed(&g, "/alerts"));
        assert!(allowed(&g, "/sites"));
        assert!(allowed(&g, "/grid/catalog"));
        assert!(allowed(&g, "/ovl/spc_outlook"));
        assert!(allowed(&g, "/ws"));
        assert!(allowed(&g, "/climate"));
        assert!(allowed(&g, "/placefile/asset"));
        assert!(!allowed(&g, "/keys"));
        assert!(!allowed(&g, "/rec"));
        assert!(!allowed(&g, "/shares"));
        assert!(!allowed(&g, "/share/abc"));
        assert!(!allowed(&g, "/rules"));
        assert!(!allowed(&g, "/admin/config"));
        assert!(!allowed(&g, "/collab/ws"));
        assert!(!allowed(&g, "/alertsx"));
        assert!(!allowed(&g, "/radar/upload"));
        assert!(!allowed(&Method::POST, "/radar/sweep"));
        assert!(!allowed(&Method::PUT, "/alerts"));
    }

    #[test]
    fn lifecycle() {
        let d = std::env::temp_dir().join(format!("tbw-share-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let s = Shares::new(&d);
        let a = s.create("  Chase\n day ", json!({"data": {"view": {"zoom": 6}}}), 2, true).unwrap();
        assert_eq!(a.name, "Chase day");
        assert!(a.token.starts_with("shr_"));
        assert_eq!(s.by_token(&a.token).as_deref(), Some(a.id.as_str()));
        assert!(s.create("x", json!([1]), 1, false).is_err());
        let big = json!({"x": "a".repeat(MAX_WORKSPACE)});
        assert!(s.create("x", big, 1, false).is_err());
        s.update(&a.id, Some(json!({"data": {}})), None).unwrap();
        // persisted
        let s2 = Shares::new(&d);
        assert_eq!(s2.list().len(), 1);
        assert_eq!(s2.get(&a.id, true).unwrap().views, 1);
        assert!(s2.delete(&a.id));
        assert!(s2.by_token(&a.token).is_none());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn limiter() {
        let l = Limiter::default();
        for _ in 0..5 {
            assert!(l.allow("k", 5, 3600));
        }
        assert!(!l.allow("k", 5, 3600));
        assert!(l.allow("other", 5, 3600));
    }
}
