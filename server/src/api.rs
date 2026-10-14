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
use axum::routing::{delete, get, post, put};
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
    pub grids: Arc<crate::grid::service::GridService>,
    pub overlays: Arc<crate::overlays::Overlays>,
    pub rec: Arc<crate::recorder::Recorder>,
    pub intl: Arc<crate::intlradar::IntlRadar>,
    pub shares: Arc<crate::share::Shares>,
    pub collab: Arc<crate::collab::Collab>,
    pub rules: Arc<crate::rules::Rules>,
    pub ml: Arc<crate::ml::Ml>,
    pub radio: Arc<crate::radio::Radio>,
    pub notify: Arc<crate::notify::Notify>,
    pub srules: Arc<crate::srules::ServerRules>,
    pub timelapse: Arc<crate::timelapse::Timelapse>,
}

/// Marks a request made with a share link's read-only token.
#[derive(Clone)]
pub struct ShareScope(pub String);

enum Access {
    Full,
    Share(String),
    Denied,
}

fn request_token(req: &Request) -> Option<String> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v).to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=").map(str::to_string))))
}

fn access(st: &AppState, req: &Request) -> Access {
    if st.cfg.read().server.local_no_auth && is_local(req) {
        return Access::Full;
    }
    let token = st.cfg.read().server.token.clone();
    // the header and the query may both be present (WebSockets): either one matching is enough
    let hdr = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(|v| v.strip_prefix("Bearer ").unwrap_or(v) == token).unwrap_or(false);
    let q = req.uri().query().map(|q| q.split('&').any(|kv| kv == format!("token={token}"))).unwrap_or(false);
    if !token.is_empty() && (hdr || q) {
        return Access::Full;
    }
    match request_token(req).filter(|t| t.starts_with("shr_")).and_then(|t| st.shares.by_token(&t)) {
        Some(id) => Access::Share(id),
        None => Access::Denied,
    }
}

/// Full (owner) access: the server token, or this machine with `local_no_auth`.
pub(crate) fn full_access(st: &AppState, req: &Request) -> bool {
    matches!(access(st, req), Access::Full)
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

/// True for requests made directly from this machine (not forwarded by a proxy like Caddy).
pub(crate) fn is_local(req: &Request) -> bool {
    let direct = !req.headers().contains_key("x-forwarded-for") && !req.headers().contains_key("forwarded") && !req.headers().contains_key("x-real-ip");
    let peer = req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>().map(|c| c.0.ip());
    // to_canonical: a dual-stack listener ("[::]:8787", common on Windows) reports IPv4
    // loopback as ::ffff:127.0.0.1, which is_loopback() alone doesn't recognise
    direct && peer.map(|ip| ip.to_canonical().is_loopback()).unwrap_or(false)
}

async fn auth(State(st): St, mut req: Request, next: Next) -> Result<Response, StatusCode> {
    match access(&st, &req) {
        Access::Full => Ok(next.run(req).await),
        Access::Share(id) => {
            if !crate::share::allowed(req.method(), req.uri().path()) {
                return Ok((StatusCode::FORBIDDEN, Json(json!({"error": "not available in a shared view"}))).into_response());
            }
            // generous: a radar loop is a few hundred requests
            if !st.shares.limit.allow(&format!("tok:{id}"), 3000, 60) {
                return Ok((StatusCode::TOO_MANY_REQUESTS, Json(json!({"error": "too many requests for this share link"}))).into_response());
            }
            req.extensions_mut().insert(ShareScope(id));
            Ok(next.run(req).await)
        }
        Access::Denied => Err(StatusCode::UNAUTHORIZED),
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
        .route("/radar/sweep.nc", get(radar_sweep_nc))
        .route("/radar/blockage", get(radar_blockage))
        .route("/radar/upload", post(radar_upload))
        .route("/radar/rotation", get(radar_rotation))
        .route("/radar/volume3d", get(radar_volume3d))
        .route("/radar/xsection", get(radar_xsection))
        .route("/live/{site}", get(live_status))
        .route("/l3/{site}/{prod}/list", get(l3_list))
        .route("/l3/data", get(l3_data))
        .route("/alerts", get(alerts))
        .route("/sources", get(sources))
        .route("/keys", get(keys_get).put(keys_put))
        .route("/stats", get(stats))
        .route("/grid/catalog", get(grid_catalog))
        .route("/grid/frames", get(grid_frames))
        .route("/grid/render", get(grid_render))
        .route("/grid/value", get(grid_value))
        .route("/grid/export", get(grid_export))
        .route("/grid/volume3d", get(grid_volume3d))
        .route("/grid/wind", get(grid_wind))
        .route("/sounding", get(sounding))
        .route("/sounding/stations", get(sounding_stations))
        .route("/placefile", get(placefile))
        .route("/placefile/asset", get(placefile_asset))
        .route("/climate", get(climate))
        .route("/climate/records", get(climate_records))
        .route("/grid/contours", get(grid_contours))
        .route("/grid/barbs", get(grid_barbs))
        .route("/arcgis/{service}/legend", get(arcgis_legend))
        .route("/arcgis/{service}/{z}/{x}/{y}", get(arcgis_tile))
        .route("/metars", get(metars))
        .route("/ovl/{id}", get(overlay))
        .route("/camimg", get(camimg))
        .route("/intlradar", get(intl_list))
        .route("/intlradar/img", get(intl_img))
        .route("/shake/channels", get(shake_channels))
        .route("/shake/data", get(shake_data))
        .route("/hist/warnings", get(hist_warnings))
        .route("/hist/warning", get(hist_warning))
        .route("/hist/tropical", get(hist_tropical))
        .route("/hist/tropical/{id}", get(hist_tropical_track))
        .route("/traffic/incidents", get(traffic_incidents))
        .route("/traffic/{z}/{x}/{y}", get(traffic_tile))
        .route("/rec", get(rec_list).post(rec_create))
        .route("/rec/rules", put(rec_rules))
        .route("/rec/export", get(rec_export))
        .route("/rec/import", post(rec_import).layer(DefaultBodyLimit::disable()))
        .route("/rec/{id}", delete(rec_delete))
        .route("/rec/{id}/stop", post(rec_stop))
        .route("/rec/{id}/end", post(crate::recorder::set_end_route)) // 0.8.1: Record for… / until stopped
        .route("/rec/{id}/frames", get(rec_frames))
        .route("/rec/{id}/file/{name}", get(rec_file))
        .route("/rec/{id}/timelapse", get(rec_timelapse))
        .route("/ws", get(ws))
        // share links, live collaboration, notification rules (Phase 6)
        .route("/share", post(crate::share::create))
        .route("/shares", get(crate::share::list))
        .route("/collab/rooms", get(crate::collab::list_rooms).post(crate::collab::create_room))
        .route("/collab/rooms/{code}", get(crate::collab::get_room).delete(crate::collab::delete_room))
        .route("/collab/ws", get(crate::collab::ws))
        .route("/rules", get(crate::rules::get).put(crate::rules::put))
        .route("/rules/webhook-test", post(crate::rules::webhook_test))
        // server-side rules, notification channels, radio monitor, webcam timelapses (p8)
        .route("/rules/log", get(crate::srules::get_log))
        .route("/rules/server-test", post(crate::srules::server_test))
        .route("/notify/channels", get(crate::notify::get_channels).put(crate::notify::put_channels))
        .route("/notify/test", post(crate::notify::test))
        .route("/radio/monitor", get(crate::radio::get_monitor).put(crate::radio::put_monitor))
        .route("/radio/same", get(crate::radio::get_same))
        .route("/radio/same/test", post(crate::radio::test_same))
        .route("/timelapse/cams", get(crate::timelapse::get_cams).put(crate::timelapse::put_cams))
        .route("/timelapse/list", get(crate::timelapse::list))
        .route("/timelapse/build", post(crate::timelapse::build_now))
        // detection models (training jobs, model store, live runs)
        .merge(crate::ml::api::router())
        // local admin API (Server settings): loopback only, see admin.rs
        .merge(crate::admin::router(st.clone()))
        .layer(DefaultBodyLimit::max(400 * 1024 * 1024))
        .route_layer(middleware::from_fn_with_state(st.clone(), auth));

    let web_dir = crate::config::paths().web;
    let static_files = tower_http::services::ServeDir::new(&web_dir)
        .fallback(tower_http::services::ServeFile::new(web_dir.join("index.html")));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/local", get(local_check))
        // public share endpoint (GET); PUT/DELETE check the owner token themselves
        .route("/api/share/{id}", get(crate::share::public_get).put(crate::share::update).delete(crate::share::delete))
        .route("/s/{id}", get(crate::share::open))
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

async fn info(State(st): St, req: Request) -> Json<Value> {
    let same_host = is_local(&req);
    let shared = req.extensions().get::<ShareScope>().is_some();
    let c = st.cfg.read();
    let keys: HashMap<&str, bool> = Keys::NAMES.iter().map(|k| (*k, c.keys.get(k).map(|v| !v.is_empty()).unwrap_or(false))).collect();
    Json(json!({
        "version": VERSION,
        "name": c.server.name,
        "public_url": c.server.public_url,
        "profile": st.profile,
        "uptime_s": st.started.elapsed().as_secs(),
        "keys_set": keys,
        // a share link's viewers never see the owner's keys
        "google_maps_key": if shared { "" } else { c.keys.google_maps.as_str() },
        "live_sites": st.live.active_sites(),
        "same_host": same_host && !shared,
        "shared": shared,
    }))
}

async fn sites(State(st): St) -> Json<Value> {
    let mut v = st.sites.read().clone();
    v.extend(st.radar.odim.sites());
    Json(json!(v))
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

// ---------- European ODIM sites (5-letter OPERA ids such as "deess"; keys "odim:…") ----------

async fn odim_latest(st: &AppState, site: &str, n: usize) -> Result<Json<Value>, ApiError> {
    let v = st.radar.odim.latest(site, n).await?;
    Ok(Json(json!({"site": site, "volumes": v, "live": {"site": site, "active": false}})))
}

async fn odim_day(st: &AppState, site: &str, date: &str) -> Result<Json<Value>, ApiError> {
    let (y, m, d) = parse_date(date).map_err(|e| bad(&e.to_string()))?;
    let v = st.radar.odim.day(site, y, m, d).await?;
    Ok(Json(json!({"site": site, "date": date, "volumes": v})))
}

#[derive(Deserialize)]
struct XsecQ {
    key: String,
    moment: Option<String>,
    lat1: f64,
    lon1: f64,
    lat2: f64,
    lon2: f64,
    nx: Option<usize>,
    nz: Option<usize>,
    ztop: Option<f64>,
}

/// Vertical cross-section of a Level II / ODIM volume along a line (u32 header length, JSON header, u8 cells).
async fn radar_xsection(State(st): St, Query(q): Query<XsecQ>) -> Result<Response, ApiError> {
    let moment = q.moment.unwrap_or_else(|| "REF".into());
    if crate::radar::volume3d::Kind::parse(&moment).is_none() {
        return Err(bad("moment must be REF|VEL|ZDR|CC|SW|KDP|PHI"));
    }
    let x = crate::radar::volume3d::XSec { lat1: q.lat1, lon1: q.lon1, lat2: q.lat2, lon2: q.lon2, nx: q.nx.unwrap_or(400), nz: q.nz.unwrap_or(120), ztop: q.ztop.unwrap_or(18_000.0) };
    if !(2..=2000).contains(&x.nx) || !(2..=600).contains(&x.nz) || !(500.0..=30_000.0).contains(&x.ztop) || [x.lat1, x.lat2].iter().any(|l| l.abs() > 90.0) || [x.lon1, x.lon2].iter().any(|l| l.abs() > 360.0) {
        return Err(bad("nx 2..2000, nz 2..600, ztop 500..30000, valid lat/lon"));
    }
    let live = q.key.starts_with("live:");
    let body = if live {
        let lm = st.live.clone();
        let k = q.key.clone();
        Bytes::from(
            tokio::task::spawn_blocking(move || lm.with_volume(&k, |v| crate::radar::volume3d::xsection(v, &moment, &x)))
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??,
        )
    } else {
        st.radar.xsection(&q.key, &moment, x).await?
    };
    Ok(volume_response(body, !live && crate::radar::odim_src::settled(&q.key)))
}

async fn radar_latest(State(st): St, Path(site): Path<String>, Query(q): Query<NQ>) -> Result<Json<Value>, ApiError> {
    if let Some(id) = st.radar.odim.canonical(&site) {
        return odim_latest(&st, &id, q.n.unwrap_or(1).clamp(1, 200)).await;
    }
    let site = valid_site(&site)?;
    st.live.touch(&site);
    let n = q.n.unwrap_or(1).clamp(1, 200);
    let v = st.radar.latest(&site, n).await?;
    Ok(Json(json!({"site": site, "volumes": v, "live": st.live.status(&site)})))
}

async fn radar_day(State(st): St, Path((site, date)): Path<(String, String)>) -> Result<Json<Value>, ApiError> {
    if let Some(id) = st.radar.odim.canonical(&site) {
        return odim_day(&st, &id, &date).await;
    }
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
    /// ZDRCOL: freezing level km MSL (default: HRRR / RAP / GFS at the radar)
    fzl: Option<f32>,
    /// REFQC / BIO: correlation-coefficient threshold (default 0.88)
    cc_min: Option<f32>,
    /// REFQC / BIO: reflectivity texture threshold, dB (default 8)
    texture: Option<f32>,
    /// DREF / DVEL: earlier volume key (default: the site's previous volume)
    prev: Option<String>,
}

/// QC options for a sweep request (freezing level looked up when ZDRCOL needs it).
async fn qc_opts(st: &AppState, q: &SweepQ) -> Result<(crate::radar::qc::Opts, Option<String>), ApiError> {
    let mut o = crate::radar::qc::Opts::default();
    if let Some(c) = q.cc_min {
        o.cc_min = c.clamp(0.3, 0.99);
    }
    if let Some(t) = q.texture {
        o.texture = t.clamp(1.0, 50.0);
    }
    let mut src = None;
    if q.moment.eq_ignore_ascii_case("ZDRCOL") {
        match q.fzl {
            Some(f) => {
                o.fzl_km = f.clamp(0.0, 8.0);
                src = Some("request".to_string());
            }
            None => {
                let v = st.radar.volume(&q.key).await?;
                match st.grids.freezing_level(v.lat as f64, v.lon as f64, Some(v.start_ms())).await {
                    Ok((km, s)) => {
                        o.fzl_km = km.max(0.0);
                        src = Some(s);
                    }
                    Err(e) => {
                        tracing::debug!("freezing level: {e:#}");
                        src = Some("default 4.0 km".to_string());
                    }
                }
            }
        }
    }
    Ok((o, src))
}

async fn radar_sweep(State(st): St, headers: HeaderMap, Query(q): Query<SweepQ>) -> Result<Response, ApiError> {
    if crate::radar::qc::is_qc(&q.moment) {
        if q.key.starts_with("live:") {
            return Err(bad("QC / difference products are not available for live streams; use an archived volume key"));
        }
        let (o, fzl_src) = qc_opts(&st, &q).await?;
        let (b, prev) = st.radar.sweep_qc(&q.key, q.tilt, &q.moment, &o, q.prev.as_deref()).await.map_err(input_err)?;
        let mut r = sweep_response(&headers, b, crate::radar::odim_src::settled(&q.key));
        if let Some(p) = prev.and_then(|p| HeaderValue::from_str(&p).ok()) {
            r.headers_mut().insert("x-tbw-prev-key", p);
        }
        if q.moment.eq_ignore_ascii_case("ZDRCOL") {
            if let Ok(h) = HeaderValue::from_str(&format!("{:.2}", o.fzl_km)) {
                r.headers_mut().insert("x-tbw-fzl-km", h);
            }
            if let Some(h) = fzl_src.and_then(|s| HeaderValue::from_str(&s).ok()) {
                r.headers_mut().insert("x-tbw-fzl-source", h);
            }
        }
        return Ok(r);
    }
    if q.key.starts_with("live:") {
        let b = st.live.sweep(&q.key, q.tilt, &q.moment)?;
        return Ok(sweep_response(&headers, b, false));
    }
    let b = st.radar.sweep(&q.key, q.tilt, &q.moment).await?;
    Ok(sweep_response(&headers, b, crate::radar::odim_src::settled(&q.key)))
}

/// One sweep (any moment incl. derived / QC) as CF/Radial-style netCDF-3.
async fn radar_sweep_nc(State(st): St, Query(q): Query<SweepQ>) -> Result<Response, ApiError> {
    if q.key.starts_with("live:") {
        return Err(bad("netCDF export needs an archived volume key"));
    }
    let (o, _) = qc_opts(&st, &q).await?;
    let b = st.radar.sweep_nc(&q.key, q.tilt, &q.moment, &o, q.prev.as_deref()).await.map_err(input_err)?;
    let name = format!("{}_{}_t{}.nc", q.key.rsplit(['/', ':']).next().unwrap_or("sweep").replace(|c: char| !c.is_ascii_alphanumeric() && c != '_', "_"), q.moment.to_ascii_uppercase(), q.tilt);
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-netcdf"));
    if let Ok(h) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        r.headers_mut().insert(header::CONTENT_DISPOSITION, h);
    }
    Ok(r)
}

/// Terrain beam blockage for a radar site: `site`, `tilt` (deg, 0.5), `tower` (m, 20),
/// `format=sweep|png|geojson` (sweep: TBWS "BLK" %, png: RGBA with `X-TBW-Bounds: w,s,e,n`,
/// geojson: coverage polygon where blockage first reaches `pct`, default 50).
async fn radar_blockage(State(st): St, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let site = valid_site(q.get("site").map(|s| s.as_str()).unwrap_or(""))?;
    let s = st.sites.read().iter().find(|x| x.id.eq_ignore_ascii_case(&site)).cloned().ok_or_else(|| bad("unknown site"))?;
    let tilt: f64 = q.get("tilt").and_then(|t| t.parse().ok()).unwrap_or(0.5f64).clamp(0.0, 20.0);
    let tower: f64 = q.get("tower").and_then(|t| t.parse().ok()).unwrap_or(20.0f64).clamp(0.0, 200.0);
    let cbb = st.radar.blockage(&s.id, s.lat, s.lon, s.elev_m, tower, tilt).await?;
    let fmt = q.get("format").map(|s| s.as_str()).unwrap_or("sweep");
    let cache = HeaderValue::from_static("private, max-age=86400");
    match fmt {
        "sweep" => {
            let raw = crate::radar::blockage::encode_sweep(&s.id, s.lat, s.lon, s.elev_m + tower, tilt, &cbb)?;
            let mut r = sweep_response(&headers, Bytes::from(crate::radar::encode::zstd(&raw)), false);
            r.headers_mut().insert(header::CACHE_CONTROL, cache);
            Ok(r)
        }
        "png" => {
            let size = q.get("size").and_then(|t| t.parse::<usize>().ok()).unwrap_or(512).clamp(64, 2048);
            let (png, b) = crate::radar::blockage::png(s.lat, s.lon, &cbb, size)?;
            let mut r = Response::new(Body::from(png));
            r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
            r.headers_mut().insert(header::CACHE_CONTROL, cache);
            if let Ok(h) = HeaderValue::from_str(&format!("{:.5},{:.5},{:.5},{:.5}", b[0], b[1], b[2], b[3])) {
                r.headers_mut().insert("x-tbw-bounds", h);
            }
            Ok(r)
        }
        "geojson" => {
            let pct = q.get("pct").and_then(|t| t.parse::<u8>().ok()).unwrap_or(50).clamp(1, 100);
            let mut v = crate::radar::blockage::geojson(s.lat, s.lon, &cbb, pct);
            v["site"] = json!(s.id);
            v["tilt"] = json!(tilt);
            Ok(Json(v).into_response())
        }
        _ => Err(bad("format must be sweep, png or geojson")),
    }
}

#[derive(Deserialize)]
struct RotQ {
    key: Option<String>,
    site: Option<String>,
}

/// Rotation (TVS / mesocyclone) detections for a Level II volume, or the newest volume of a site.
async fn radar_rotation(State(st): St, Query(q): Query<RotQ>) -> Result<Response, ApiError> {
    let key = match (q.key.filter(|k| !k.is_empty()), q.site) {
        (Some(k), _) => k,
        (None, Some(site)) => {
            let v = match st.radar.odim.canonical(&site) {
                Some(id) => st.radar.odim.latest(&id, 1).await?,
                None => st.radar.latest(&valid_site(&site)?, 1).await?,
            };
            v.last().map(|e| e.key.clone()).ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no volumes found for {site}")))?
        }
        _ => return Err(bad("key or site required")),
    };
    let body = if key.starts_with("live:") {
        let live = st.live.clone();
        let k = key.clone();
        Bytes::from(
            tokio::task::spawn_blocking(move || live.with_volume(&k, |v| Ok(serde_json::to_vec(&crate::radar::rotation::geojson(v, &k))?)))
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??,
        )
    } else {
        st.radar.rotation(&key).await?
    };
    let mut r = Response::new(Body::from(body));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(r)
}

#[derive(Deserialize)]
struct Vol3dQ {
    key: String,
    moment: Option<String>,
    res: Option<String>,
}

/// Level II volume resampled to a 3D grid (u32 header length, JSON header, u8 voxels).
async fn radar_volume3d(State(st): St, Query(q): Query<Vol3dQ>) -> Result<Response, ApiError> {
    let moment = q.moment.unwrap_or_else(|| "REF".into());
    if crate::radar::volume3d::Kind::parse(&moment).is_none() {
        return Err(bad("moment must be REF|VEL|ZDR|CC|SW|KDP|PHI"));
    }
    let res = q.res.unwrap_or_else(|| "lo".into());
    let live = q.key.starts_with("live:");
    let body = if live {
        let lm = st.live.clone();
        let k = q.key.clone();
        Bytes::from(
            tokio::task::spawn_blocking(move || lm.with_volume(&k, |v| crate::radar::volume3d::encode(v, &moment, &res)))
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??,
        )
    } else {
        st.radar.volume3d(&q.key, &moment, &res).await?
    };
    Ok(volume_response(body, !live && crate::radar::odim_src::settled(&q.key)))
}

fn volume_response(body: Bytes, cacheable: bool) -> Response {
    let mut r = Response::new(Body::from(body));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(if cacheable { "private, max-age=86400, immutable" } else { "no-store" }));
    r
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

/// Lets the app on the same machine discover that no token is needed.
async fn local_check(State(st): St, req: Request) -> Json<Value> {
    let local = st.cfg.read().server.local_no_auth && is_local(&req);
    Json(json!({"local": local, "name": st.cfg.read().server.name}))
}

async fn overlay(State(st): St, Path(id): Path<String>, Query(q): Query<std::collections::BTreeMap<String, String>>) -> Result<Response, ApiError> {
    let mut q = q;
    q.remove("token");
    let format = q.remove("format").unwrap_or_default();
    let keys = st.cfg.read().keys.clone();
    let b = st.overlays.get(&id, &q, &keys).await.map_err(input_err)?;
    if format == "csv" || format == "kml" {
        let v: Value = serde_json::from_slice(&b).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("overlay is not JSON: {e}")))?;
        if v["type"] != "FeatureCollection" {
            return Err(bad("this overlay is not a GeoJSON FeatureCollection"));
        }
        let (body, ct, ext) = if format == "csv" { (crate::export::geojson_to_csv(&v), "text/csv", "csv") } else { (crate::export::geojson_to_kml(&v, &id), "application/vnd.google-earth.kml+xml", "kml") };
        let mut r = Response::new(Body::from(body));
        r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(ct));
        if let Ok(h) = HeaderValue::from_str(&format!("attachment; filename=\"{id}.{ext}\"")) {
            r.headers_mut().insert(header::CONTENT_DISPOSITION, h);
        }
        r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok(r);
    }
    if !format.is_empty() && format != "geojson" && format != "json" {
        return Err(bad("format must be geojson, csv or kml"));
    }
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(r)
}

// ---------- history archives (see crate::hist) ----------

fn json_bytes(b: Bytes) -> Response {
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

fn hist_err(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.starts_with("bad ") || msg.contains("must ") || msg.contains("limited to") || msg.contains("too large") || msg.contains("archive starts") {
        ApiError(StatusCode::BAD_REQUEST, msg)
    } else if msg.contains("try again in a few minutes") {
        ApiError(StatusCode::SERVICE_UNAVAILABLE, msg)
    } else {
        e.into()
    }
}

/// Historical NWS warnings search (IEM VTEC archive).
async fn hist_warnings(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(crate::hist::warn::search(&st.overlays, &q).await.map_err(hist_err)?))
}

/// One historical warning as GeoJSON (`vtec=OUN.TO.W.0042&year=2024`).
async fn hist_warning(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let vtec = q.get("vtec").ok_or_else(|| bad("vtec required"))?;
    let year = q.get("year").map(|y| y.parse::<i32>().map_err(|_| bad("bad year"))).transpose()?;
    Ok(json_bytes(crate::hist::warn::detail(&st.overlays, vtec, year).await.map_err(hist_err)?))
}

/// Historical tropical cyclones (HURDAT2 / IBTrACS).
async fn hist_tropical(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(crate::hist::tc::list(&st.overlays, &q).await.map_err(hist_err)?))
}

/// One storm's best track as GeoJSON.
async fn hist_tropical_track(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(crate::hist::tc::track(&st.overlays, &id).await.map_err(hist_err)?))
}

#[derive(Deserialize)]
struct IntlQ {
    id: Option<String>,
}

/// International radar sources drawn as raster frames (tiles / images / WMS).
async fn intl_list(State(st): St, Query(q): Query<IntlQ>) -> Result<Json<Value>, ApiError> {
    Ok(Json(st.intl.list(q.id.as_deref().filter(|s| !s.is_empty())).await?))
}

#[derive(Deserialize)]
struct ImgQ {
    u: String,
}

/// Allowlisted image proxy for international radar frames (same-origin textures for WebGL).
async fn intl_img(State(st): St, Query(q): Query<ImgQ>) -> Result<Response, ApiError> {
    if !crate::intlradar::allowed(&q.u) {
        return Err(ApiError(StatusCode::FORBIDDEN, "host not allowed".into()));
    }
    let (b, ct) = st.intl.img(&q.u).await?;
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&ct).unwrap_or(HeaderValue::from_static("image/png")));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(r)
}

#[derive(Deserialize)]
struct CamQ {
    id: String,
}

/// Redirect to a camera's current image (for sources whose image links expire).
async fn camimg(State(st): St, Query(q): Query<CamQ>) -> Result<Response, ApiError> {
    let url = crate::overlays::cameras::image_url(&st.overlays, &q.id).await?;
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::FOUND;
    r.headers_mut().insert(header::LOCATION, HeaderValue::from_str(&url).map_err(|_| bad("bad url"))?);
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(r)
}

// ---------- Raspberry Shake ----------

/// Channels of one Raspberry Shake station.
async fn shake_channels(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    let net = q.get("net").map(|s| s.trim().to_ascii_uppercase()).filter(|s| !s.is_empty()).unwrap_or_else(|| "AM".into());
    let sta = q.get("sta").map(|s| s.trim().to_ascii_uppercase()).unwrap_or_default();
    if !crate::shake::valid_code(&net, 1, 2) || !crate::shake::valid_code(&sta, 1, 5) {
        return Err(bad("bad or missing net/sta"));
    }
    Ok(Json(crate::shake::channels(&st.overlays, &net, &sta).await?))
}

/// Waveform samples for one channel and window (≤ 2 h), decoded from miniSEED.
async fn shake_data(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let r = crate::shake::DataReq::from_query(&q).map_err(|e| bad(&e))?;
    let b = crate::shake::data(&st.overlays, &r).await?;
    let mut resp = Response::new(Body::from(b));
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(resp)
}

// ---------- traffic (TomTom) ----------

fn tomtom_key(st: &AppState) -> Result<String, ApiError> {
    let k = st.cfg.read().keys.tomtom.clone();
    if k.is_empty() {
        return Err(ApiError(StatusCode::NOT_FOUND, "Add a TomTom key in Settings → API keys".into()));
    }
    Ok(k)
}

/// TomTom traffic-flow tile (PNG). `style`: relative0 | relative0-dark (default) | absolute | relative-delay …
async fn traffic_tile(State(st): St, Path((z, x, y)): Path<(u32, u32, String)>, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let key = tomtom_key(&st)?;
    let y: u32 = y.trim_end_matches(".png").parse().map_err(|_| bad("bad tile"))?;
    if z > 22 || x >= (1u32 << z) || y >= (1u32 << z) {
        return Err(bad("bad tile"));
    }
    let style = q.get("style").map(|s| s.as_str()).unwrap_or("relative0-dark");
    if !crate::overlays::more::TRAFFIC_STYLES.contains(&style) {
        return Err(bad("bad style"));
    }
    let b = crate::overlays::more::traffic_tile(&st.overlays, &key, style, z, x, y).await?;
    let mut resp = Response::new(Body::from(b));
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=120"));
    Ok(resp)
}

/// TomTom traffic incidents in `bbox=w,s,e,n` (≤ 10,000 km²) as GeoJSON.
async fn traffic_incidents(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    let key = tomtom_key(&st)?;
    let b: Vec<f64> = q.get("bbox").map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect()).unwrap_or_default();
    if b.len() != 4 || b[0] >= b[2] || b[1] >= b[3] || b[1] < -90.0 || b[3] > 90.0 {
        return Err(bad("bbox=w,s,e,n required"));
    }
    let km2 = (b[2] - b[0]) * 111.32 * ((b[1] + b[3]) / 2.0).to_radians().cos() * (b[3] - b[1]) * 110.57;
    if km2 > 10_000.0 {
        return Err(bad("area too large for traffic incidents (max 10,000 km²); zoom in"));
    }
    Ok(Json(crate::overlays::more::traffic_incidents(&st.overlays, &key, [b[0], b[1], b[2], b[3]]).await?))
}

async fn grid_catalog(State(st): St) -> Json<Value> {
    Json(st.grids.catalog())
}

#[derive(Deserialize)]
struct FramesQ {
    layer: String,
    n: Option<usize>,
    run: Option<String>,
    storm: Option<String>,
    /// history: newest frame time (unix ms) for observation layers
    end: Option<i64>,
    /// ensemble probability threshold (layer `params.thr.units`)
    thr: Option<f64>,
}

async fn grid_frames(State(st): St, Query(q): Query<FramesQ>) -> Result<Json<Value>, ApiError> {
    let r = st.grids.frames_thr(&q.layer, q.n.unwrap_or(12).clamp(1, 240), q.run.as_deref(), q.storm.as_deref(), q.end, q.thr).await?;
    Ok(Json(json!(r)))
}

#[derive(Deserialize)]
struct RenderQ {
    key: String,
    bbox: String,
    w: usize,
    h: usize,
    /// ensemble probability threshold (replaces the one in the key)
    thr: Option<f64>,
}

async fn grid_render(State(st): St, headers: HeaderMap, Query(q): Query<RenderQ>) -> Result<Response, ApiError> {
    let b: Vec<f64> = q.bbox.split(',').filter_map(|x| x.parse().ok()).collect();
    if b.len() != 4 || q.w == 0 || q.h == 0 || q.w > 4096 || q.h > 4096 {
        return Err(bad("bad bbox or size"));
    }
    let key = crate::grid::ens_key_thr(&q.key, q.thr);
    let bytes = st.grids.render(&key, (b[0], b[1], b[2], b[3]), q.w, q.h).await?;
    Ok(sweep_response(&headers, bytes, !q.key.starts_with("metar|")))
}

#[derive(Deserialize)]
struct ValueQ {
    key: String,
    lat: f64,
    lon: f64,
    thr: Option<f64>,
}

async fn grid_value(State(st): St, Query(q): Query<ValueQ>) -> Result<Json<Value>, ApiError> {
    let key = crate::grid::ens_key_thr(&q.key, q.thr);
    Ok(Json(json!({"value": st.grids.value(&key, q.lat, q.lon).await?})))
}

/// A grid frame over a bbox as csv | geojson | nc (see `grid::export`).
async fn grid_export(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let e = crate::grid::export::export(&st.grids, &q).await.map_err(input_err)?;
    let mut r = Response::new(Body::from(e.body));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(e.content_type));
    if let Ok(h) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", e.filename)) {
        r.headers_mut().insert(header::CONTENT_DISPOSITION, h);
    }
    Ok(r)
}

#[derive(Deserialize)]
struct Cube3dQ {
    time: Option<i64>,
    bbox: String,
    probe: Option<String>,
}

/// MRMS 3D reflectivity cube for a map area (`bbox=w,s,e,n`, `time` ms optional).
async fn grid_volume3d(State(st): St, Query(q): Query<Cube3dQ>) -> Result<Response, ApiError> {
    let b: Vec<f64> = q.bbox.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if b.len() != 4 || b[0] >= b[2] || b[1] >= b[3] {
        return Err(bad("bbox=w,s,e,n required"));
    }
    if q.probe.is_some() {
        return Ok(Json(json!({"ok": true, "levels": crate::grid::service::GridService::MRMS_3D_LEVELS.len()})).into_response());
    }
    let body = st.grids.mrms_volume3d(q.time, [b[0], b[1], b[2], b[3]]).await?;
    // a cube from the last few minutes may still be missing levels: don't let browsers keep it
    let settled = q.time.map(|t| chrono::Utc::now().timestamp_millis() - t > 15 * 60_000).unwrap_or(false);
    Ok(volume_response(body, settled))
}

#[derive(Deserialize)]
struct WindQ {
    layer: String,
    level: Option<String>,
    time: Option<i64>,
    bbox: Option<String>,
    max: Option<usize>,
}

/// Earth-relative U/V wind for particle animation (u32 header length, JSON, u8 u/v pairs).
async fn grid_wind(State(st): St, Query(q): Query<WindQ>) -> Result<Response, ApiError> {
    let b: Vec<f64> = q.bbox.as_deref().unwrap_or("-180,-85,180,85").split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if b.len() != 4 || b[0] >= b[2] || b[1] >= b[3] || b[2] - b[0] > 360.0 || b[1] < -90.0 || b[3] > 90.0 {
        return Err(bad("bbox=w,s,e,n required"));
    }
    let model = q.layer.trim_start_matches("model/").split('/').next().unwrap_or("").to_string();
    let max = q.max.unwrap_or(256).clamp(8, 512);
    let body = st.grids.wind(&model, q.level.as_deref().unwrap_or("10m"), q.time, [b[0], b[1], b[2], b[3]], max).await.map_err(|e| {
        let msg = format!("{e:#}");
        if msg.starts_with("unknown model") || msg.starts_with("level must") { bad(&msg) } else { ApiError::from(e) }
    })?;
    let mut r = Response::new(Body::from(body));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(r)
}

/// Observed (src=raob) or model (src=model) sounding as JSON levels.
async fn sounding(State(st): St, Query(q): Query<std::collections::BTreeMap<String, String>>) -> Result<Response, ApiError> {
    let mut q = q;
    q.remove("token");
    let v = crate::overlays::sounding::sounding(&st.overlays, &q).await.map_err(|e| {
        let msg = format!("{e:#}");
        if msg.contains("required") || msg.contains("bad ") || msg.contains("must be") { bad(&msg) } else { ApiError::from(e) }
    })?;
    let mut r = Json(v).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(r)
}

/// RAOB stations (GeoJSON points with id, name).
async fn sounding_stations(State(st): St) -> Result<Response, ApiError> {
    let keys = st.cfg.read().keys.clone();
    let b = st.overlays.get("raobsta", &Default::default(), &keys).await?;
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    Ok(r)
}

/// NOAA ArcGIS raster tile (PNG): service nohrsc (layer=depth|swe) or heatrisk (day=1..7).
async fn arcgis_tile(State(st): St, Path((service, z, x, y)): Path<(String, u32, u32, String)>, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    if crate::overlays::arcgis::service(&service).is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "unknown service".into()));
    }
    let y: u32 = y.trim_end_matches(".png").parse().map_err(|_| bad("bad tile"))?;
    if z > 16 || x >= (1u32 << z) || y >= (1u32 << z) {
        return Err(bad("bad tile"));
    }
    let g = |k: &str| q.get(k).map(|s| s.as_str()).unwrap_or("");
    let b = crate::overlays::arcgis::tile(&st.overlays, &service, z, x, y, g("layer"), g("day")).await.map_err(|e| {
        let msg = format!("{e:#}");
        if msg.contains("must be") { bad(&msg) } else { ApiError::from(e) }
    })?;
    let mut resp = Response::new(Body::from(b));
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=600"));
    Ok(resp)
}

async fn arcgis_legend(State(st): St, Path(service): Path<String>) -> Result<Response, ApiError> {
    if crate::overlays::arcgis::service(&service).is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "unknown service".into()));
    }
    let b = crate::overlays::arcgis::legend(&st.overlays, &service).await?;
    let mut resp = Response::new(Body::from(b));
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=3600"));
    Ok(resp)
}

// ---------- phase 6: placefiles, climate, contours / barbs ----------

fn input_err(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.starts_with("blocked") {
        ApiError(StatusCode::FORBIDDEN, msg)
    } else if ["bad url", "url must", "required", "must be", "too large", "not an image", "not a placefile", "bbox", "out of range", "unknown layer", "unknown model", "level must", "interval", "no frame", "bad station", "at most", "unknown station", "stations required", "sat must", "sector must", "kind must", "format must", "bad event id", "bad thr", "needs the previous volume", "no earlier", "more than 30 minutes"].iter().any(|k| msg.contains(k)) {
        bad(&msg)
    } else {
        ApiError::from(e)
    }
}

async fn placefile_get(st: &AppState, q: HashMap<String, String>, req: Request, asset: bool) -> Result<Response, ApiError> {
    let url = q.get("url").cloned().unwrap_or_default();
    if url.is_empty() {
        return Err(bad("url=<http(s) url> required"));
    }
    // private / loopback targets only for an app on this machine
    let local = is_local(&req);
    let (b, ct) = st.overlays.placefile(&url, asset, local).await.map_err(input_err)?;
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&ct).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(if asset { "private, max-age=3600" } else { "no-store" }));
    r.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    Ok(r)
}

/// Placefile text (`url=`, URL-encoded), fetched by the server; the app parses it.
async fn placefile(State(st): St, Query(q): Query<HashMap<String, String>>, req: Request) -> Result<Response, ApiError> {
    placefile_get(&st, q, req, false).await
}

/// An icon sheet / image a placefile refers to (`url=`; images only).
async fn placefile_asset(State(st): St, Query(q): Query<HashMap<String, String>>, req: Request) -> Result<Response, ApiError> {
    placefile_get(&st, q, req, true).await
}

async fn ovl_json(st: &AppState, id: &str, q: std::collections::BTreeMap<String, String>) -> Result<Response, ApiError> {
    let mut q = q;
    q.remove("token");
    let keys = st.cfg.read().keys.clone();
    let b = st.overlays.get(id, &q, &keys).await.map_err(input_err)?;
    let mut r = json_bytes(b);
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600"));
    Ok(r)
}

/// Nearest ACIS station: recent days, normals, departures, records (`lat`, `lon`).
async fn climate(State(st): St, Query(q): Query<std::collections::BTreeMap<String, String>>) -> Result<Response, ApiError> {
    ovl_json(&st, "climate", q).await
}

/// Daily records set or tied in an area (`date=MM-DD|YYYY-MM-DD`, `bbox`).
async fn climate_records(State(st): St, Query(q): Query<std::collections::BTreeMap<String, String>>) -> Result<Response, ApiError> {
    ovl_json(&st, "climaterec", q).await
}

/// Contour lines of a grid frame (GeoJSON).
async fn grid_contours(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let v = crate::grid::contour::contours_api(&st.grids, &q).await.map_err(input_err)?;
    let mut r = Json(v).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(r)
}

/// Wind barbs thinned to a screen-space grid (GeoJSON points).
async fn grid_barbs(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let v = crate::grid::contour::barbs_api(&st.grids, &q).await.map_err(input_err)?;
    let mut r = Json(v).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(r)
}

async fn metars(State(st): St) -> Json<Value> {
    Json(json!(st.grids.latest_metars().map(|v| v.as_ref().clone()).unwrap_or_default()))
}

// ---------- recordings ----------

async fn rec_list(State(st): St) -> Json<Value> {
    Json(json!({"recs": st.rec.list(), "rules": *st.rec.rules.lock(), "ffmpeg": st.rec.has_ffmpeg(), "ytdlp": st.rec.has_ytdlp()}))
}

async fn rec_create(State(st): St, Json(r): Json<crate::recorder::Rec>) -> Result<Json<Value>, ApiError> {
    let r = st.rec.create(r)?;
    st.hub.send(json!({"type": "recording", "id": r.id}));
    Ok(Json(json!(r)))
}

async fn rec_rules(State(st): St, Json(r): Json<crate::recorder::Rules>) -> Json<Value> {
    st.rec.save_rules(r);
    Json(json!({"ok": true}))
}

async fn rec_stop(State(st): St, Path(id): Path<String>) -> Json<Value> {
    st.rec.stop(&id);
    st.hub.send(json!({"type": "recording", "id": id}));
    Json(json!({"ok": true}))
}

async fn rec_delete(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    st.rec.delete(&id)?;
    st.hub.send(json!({"type": "recording", "id": id}));
    Ok(Json(json!({"ok": true})))
}

async fn rec_frames(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"frames": st.rec.frames(&id)?, "rec": st.rec.get(&id)})))
}

async fn serve_file(p: std::path::PathBuf, headers: &HeaderMap) -> Result<Response, ApiError> {
    let ct = match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    let len = tokio::fs::metadata(&p).await.map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?.len();
    // byte ranges so video players can seek
    if let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("bytes=")) {
        let (a, b) = r.split_once('-').unwrap_or((r, ""));
        let start: u64 = a.parse().unwrap_or(0);
        let end: u64 = b.parse().unwrap_or(len.saturating_sub(1)).min(len.saturating_sub(1));
        if start <= end && start < len {
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            let mut f = tokio::fs::File::open(&p).await.map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?;
            f.seek(std::io::SeekFrom::Start(start)).await.ok();
            let n = (end - start + 1).min(8 * 1024 * 1024);
            let mut buf = vec![0u8; n as usize];
            f.read_exact(&mut buf).await.map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            let mut resp = Response::new(Body::from(buf));
            *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
            let h = resp.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ct));
            h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            h.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {start}-{}/{len}", start + n - 1)).unwrap());
            return Ok(resp);
        }
    }
    let f = tokio::fs::File::open(&p).await.map_err(|e| ApiError(StatusCode::NOT_FOUND, e.to_string()))?;
    let mut resp = Response::new(Body::from_stream(tokio_util_stream(f)));
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ct));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from_str(&len.to_string()).unwrap());
    Ok(resp)
}

/// File → body stream in 256 KB chunks.
fn tokio_util_stream(f: tokio::fs::File) -> impl futures::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    futures::stream::unfold(f, |mut f| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 256 * 1024];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(buf), f))
            }
            Err(e) => Some((Err(e), f)),
        }
    })
}

async fn rec_file(State(st): St, headers: HeaderMap, Path((id, name)): Path<(String, String)>) -> Result<Response, ApiError> {
    let p = st.rec.file_path(&id, &name)?;
    serve_file(p, &headers).await
}

#[derive(Deserialize)]
struct FpsQ {
    fps: Option<u32>,
}

async fn rec_timelapse(State(st): St, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<FpsQ>) -> Result<Response, ApiError> {
    let p = st.rec.timelapse(&id, q.fps.unwrap_or(10)).await?;
    serve_file(p, &headers).await
}

#[derive(Deserialize)]
struct IdsQ {
    ids: Option<String>,
}

async fn rec_export(State(st): St, headers: HeaderMap, Query(q): Query<IdsQ>) -> Result<Response, ApiError> {
    let ids: Vec<String> = q.ids.unwrap_or_default().split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
    let out = st.rec.dir.join(format!(".export-{}.zip", rand::random::<u32>()));
    let rec = st.rec.clone();
    let o2 = out.clone();
    tokio::task::spawn_blocking(move || rec.export(&ids, &o2)).await.map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    let mut resp = serve_file(out.clone(), &headers).await?;
    resp.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=\"TheBigWeather-recordings.zip\""));
    // the stream holds the file open; remove it a little later
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        tokio::fs::remove_file(out).await.ok();
    });
    Ok(resp)
}

async fn rec_import(State(st): St, body: Body) -> Result<Json<Value>, ApiError> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    // stream to disk: exports can be many GB
    let tmp = st.rec.dir.join(format!(".import-{}.zip", rand::random::<u32>()));
    let ie = |e: String| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e);
    let mut f = tokio::fs::File::create(&tmp).await.map_err(|e| ie(e.to_string()))?;
    let mut s = body.into_data_stream();
    let mut total = 0usize;
    while let Some(chunk) = s.next().await {
        let c = chunk.map_err(|e| ie(e.to_string()))?;
        total += c.len();
        f.write_all(&c).await.map_err(|e| ie(e.to_string()))?;
    }
    f.flush().await.ok();
    drop(f);
    if total < 22 {
        tokio::fs::remove_file(&tmp).await.ok();
        return Err(bad("empty file"));
    }
    let rec = st.rec.clone();
    let t2 = tmp.clone();
    let res = tokio::task::spawn_blocking(move || rec.import(&t2)).await.map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    tokio::fs::remove_file(&tmp).await.ok();
    let ids = res?;
    st.hub.send(json!({"type": "recording", "id": "import"}));
    Ok(Json(json!({"imported": ids})))
}
