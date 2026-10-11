//! HTTP + WebSocket API.

use crate::alerts::Alerts;
use crate::config::{Config, Keys, Profile};
use crate::health::Health;
use crate::hub::Hub;
use crate::radar::live::LiveManager;
use crate::radar::service::{parse_date, RadarService};
use crate::sites::Site;
use crate::stats::Stats;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct AppState {
    pub cfg: RwLock<Config>,
    pub cfg_path: PathBuf,
    pub profile: Profile,
    pub radar: Arc<RadarService>,
    pub live: Arc<LiveManager>,
    pub alerts: Arc<Alerts>,
    pub hub: Hub,
    pub health: Arc<Health>,
    pub sites: RwLock<Vec<Site>>,
    pub stats: Arc<RwLock<Stats>>,
    pub started: Instant,
}

type St = State<Arc<AppState>>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        let msg = format!("{e:#}");
        let code = if msg.contains("not found") || msg.contains("No such file") || msg.contains("404") || msg.contains("expired") {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_GATEWAY
        };
        ApiError(code, msg)
    }
}
fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

async fn auth(State(st): St, req: Request, next: Next) -> Result<Response, StatusCode> {
    let token = st.cfg.read().server.token.clone();
    let hdr_ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v) == token)
        .unwrap_or(false);
    let q_ok = req
        .uri()
        .query()
        .map(|q| q.split('&').any(|kv| kv == format!("token={token}")))
        .unwrap_or(false);
    if hdr_ok || q_ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Binary sweep response: zstd passthrough when the client accepts it.
fn sweep_response(headers: &HeaderMap, body: Bytes, cacheable: bool) -> Response {
    let accepts_zstd = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("zstd"))
        .unwrap_or(false);
    let mut resp = if accepts_zstd {
        let mut r = Response::new(Body::from(body));
        r.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("zstd"));
        r
    } else {
        let raw = zstd::bulk::decompress(&body, 64 * 1024 * 1024).unwrap_or_default();
        Response::new(Body::from(raw))
    };
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if cacheable { "private, max-age=86400, immutable" } else { "no-store" }),
    );
    h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    resp
}

pub fn router(st: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/info", get(info))
        .route("/sites", get(sites))
        .route("/l3/products", get(l3_products))
        .route("/radar/{site}/latest", get(radar_latest))
        .route("/radar/{site}/day/{date}", get(radar_day))
        .route("/radar/meta", get(radar_meta))
        .route("/radar/sweep", get(radar_sweep))
        .route("/radar/upload", post(radar_upload))
        .route("/live/{site}", get(live_status))
        .route("/l3/{site}/{prod}/list", get(l3_list))
        .route("/l3/data", get(l3_data))
        .route("/alerts", get(alerts))
        .route("/sources", get(sources))
        .route("/keys", get(keys_get).put(keys_put))
        .route("/stats", get(stats))
        .route("/ws", get(ws))
        .layer(DefaultBodyLimit::max(400 * 1024 * 1024))
        .route_layer(middleware::from_fn_with_state(st.clone(), auth));

    let web_dir = st.cfg.read().server.web_dir.clone();
    let static_files = tower_http::services::ServeDir::new(&web_dir)
        .fallback(tower_http::services::ServeFile::new(web_dir.join("index.html")));

    Router::new()
        .route("/api/health", get(health))
        .nest("/api", api)
        .fallback_service(static_files)
        .layer(
            tower_http::compression::CompressionLayer::new()
                .compress_when(tower_http::compression::predicate::SizeAbove::new(1024)),
        )
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(st)
}

async fn health(State(st): St) -> Json<Value> {
    Json(json!({"ok": true, "app": "thebigweather", "version": VERSION, "name": st.cfg.read().server.name}))
}

async fn info(State(st): St) -> Json<Value> {
    let c = st.cfg.read();
    let keys: HashMap<&str, bool> = Keys::NAMES.iter().map(|k| (*k, c.keys.get(k).map(|v| !v.is_empty()).unwrap_or(false))).collect();
    Json(json!({
        "version": VERSION,
        "name": c.server.name,
        "public_url": c.server.public_url,
        "profile": st.profile,
        "uptime_s": st.started.elapsed().as_secs(),
        "keys_set": keys,
        "google_maps_key": c.keys.google_maps,
        "live_sites": st.live.active_sites(),
    }))
}

async fn sites(State(st): St) -> Json<Value> {
    Json(json!(*st.sites.read()))
}

async fn l3_products(State(st): St) -> Json<Value> {
    Json(json!(st.radar.l3_catalog))
}

#[derive(Deserialize)]
struct NQ {
    n: Option<usize>,
}

fn valid_site(s: &str) -> Result<String, ApiError> {
    let s = s.to_ascii_uppercase();
    if s.len() < 3 || s.len() > 4 || !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(bad("bad site id"));
    }
    Ok(s)
}

async fn radar_latest(State(st): St, Path(site): Path<String>, Query(q): Query<NQ>) -> Result<Json<Value>, ApiError> {
    let site = valid_site(&site)?;
    st.live.touch(&site);
    let n = q.n.unwrap_or(1).clamp(1, 200);
    let v = st.radar.latest(&site, n).await?;
    Ok(Json(json!({"site": site, "volumes": v, "live": st.live.status(&site)})))
}

async fn radar_day(State(st): St, Path((site, date)): Path<(String, String)>) -> Result<Json<Value>, ApiError> {
    let site = valid_site(&site)?;
    let (y, m, d) = parse_date(&date).map_err(|e| bad(&e.to_string()))?;
    let v = st.radar.list_day(&site, y, m, d).await?;
    Ok(Json(json!({"site": site, "date": date, "volumes": v})))
}

#[derive(Deserialize)]
struct KeyQ {
    key: String,
}

async fn radar_meta(State(st): St, Query(q): Query<KeyQ>) -> Result<Json<Value>, ApiError> {
    if q.key.starts_with("live:") {
        return Ok(Json(json!(st.live.meta(&q.key)?)));
    }
    Ok(Json(json!(st.radar.meta(&q.key).await?)))
}

#[derive(Deserialize)]
struct SweepQ {
    key: String,
    tilt: usize,
    moment: String,
}

async fn radar_sweep(State(st): St, headers: HeaderMap, Query(q): Query<SweepQ>) -> Result<Response, ApiError> {
    if q.key.starts_with("live:") {
        let b = st.live.sweep(&q.key, q.tilt, &q.moment)?;
        return Ok(sweep_response(&headers, b, false));
    }
    let b = st.radar.sweep(&q.key, q.tilt, &q.moment).await?;
    Ok(sweep_response(&headers, b, true))
}

#[derive(Deserialize)]
struct UploadQ {
    name: Option<String>,
}

async fn radar_upload(State(st): St, Query(q): Query<UploadQ>, body: Bytes) -> Result<Json<Value>, ApiError> {
    if body.len() < 100 {
        return Err(bad("empty file"));
    }
    let key = st.radar.store_upload(q.name.as_deref().unwrap_or(""), body).await?;
    let meta = st.radar.meta(&key).await?;
    Ok(Json(json!({"key": key, "meta": meta})))
}

async fn live_status(State(st): St, Path(site): Path<String>) -> Result<Json<Value>, ApiError> {
    let site = valid_site(&site)?;
    st.live.touch(&site);
    Ok(Json(st.live.status(&site)))
}

async fn l3_list(State(st): St, Path((site, prod)): Path<(String, String)>, Query(q): Query<NQ>) -> Result<Json<Value>, ApiError> {
    let site = valid_site(&site)?;
    let site3 = if site.len() == 4 { site[1..].to_string() } else { site };
    if !prod.chars().all(|c| c.is_ascii_alphanumeric()) || prod.len() > 4 {
        return Err(bad("bad product"));
    }
    let v = st.radar.l3_list(&site3, &prod, q.n.unwrap_or(1).clamp(1, 120)).await?;
    Ok(Json(json!({"site": site3, "product": prod, "volumes": v})))
}

async fn l3_data(State(st): St, headers: HeaderMap, Query(q): Query<KeyQ>) -> Result<Response, ApiError> {
    let b = st.radar.l3_data(&q.key).await?;
    Ok(sweep_response(&headers, b, !q.key.starts_with("tgftp:")))
}

async fn alerts(State(st): St) -> Json<Value> {
    Json(st.alerts.collection())
}

async fn sources(State(st): St) -> Json<Value> {
    Json(json!(st.health.list()))
}

async fn stats(State(st): St) -> Json<Value> {
    Json(json!(*st.stats.read()))
}

async fn keys_get(State(st): St) -> Json<Value> {
    let c = st.cfg.read();
    let m: HashMap<&str, String> = Keys::NAMES
        .iter()
        .map(|k| {
            let v = c.keys.get(k).cloned().unwrap_or_default();
            let masked = if v.len() > 6 { format!("{}…{}", &v[..3], &v[v.len() - 3..]) } else if v.is_empty() { String::new() } else { "••••".into() };
            (*k, masked)
        })
        .collect();
    Json(json!(m))
}

async fn keys_put(State(st): St, Json(body): Json<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    let mut c = st.cfg.write();
    for (k, v) in body {
        if !c.keys.set(&k, v.trim().to_string()) {
            return Err(bad(&format!("unknown key {k}")));
        }
    }
    c.save(&st.cfg_path).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

async fn ws(State(st): St, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |sock| ws_conn(st, sock))
}

async fn ws_conn(st: Arc<AppState>, mut sock: WebSocket) {
    let mut rx = st.hub.subscribe();
    let hello = json!({
        "type": "hello",
        "version": VERSION,
        "profile": st.profile,
        "stats": *st.stats.read(),
        "sources": st.health.list(),
    });
    if sock.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }
    let mut watching: Vec<String> = vec![];
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Ok(txt) => {
                    if sock.send(Message::Text(txt.to_string().into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            incoming = sock.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        if v["type"] == "watch" {
                            watching = v["sites"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_ascii_uppercase())).take(8).collect()).unwrap_or_default();
                            for s in &watching { st.live.touch(s); }
                        } else if v["type"] == "ping" {
                            let _ = sock.send(Message::Text(json!({"type":"pong"}).to_string().into())).await;
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = tick.tick() => {
                for s in &watching { st.live.touch(s); }
            }
        }
    }
}
