//! `/api/ml/*` handlers (behind the normal auth middleware; share-link tokens are refused).

use crate::api::AppState;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

type St = State<Arc<AppState>>;

pub struct E(StatusCode, String);

impl IntoResponse for E {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

impl From<anyhow::Error> for E {
    fn from(e: anyhow::Error) -> Self {
        let m = format!("{e:#}");
        let code = if m.contains("not found") { StatusCode::NOT_FOUND } else { StatusCode::BAD_REQUEST };
        E(code, m)
    }
}

fn nf(what: &str) -> E {
    E(StatusCode::NOT_FOUND, format!("{what} not found"))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/ml/catalog", get(catalog))
        .route("/ml/train", post(train))
        .route("/ml/jobs", get(jobs))
        .route("/ml/jobs/{id}", get(job).delete(job_delete))
        .route("/ml/jobs/{id}/stop", post(job_stop))
        .route("/ml/jobs/{id}/resume", post(job_resume))
        .route("/ml/models", get(models))
        .route("/ml/models/import", post(import))
        .route("/ml/models/{id}", get(model).patch(model_patch).delete(model_delete))
        .route("/ml/models/{id}/export", get(export))
        .route("/ml/models/{id}/retrain", post(retrain))
        .route("/ml/models/{id}/continue", post(continue_))
        .route("/ml/models/{id}/history", get(history))
        .route("/ml/run", get(run_get).post(run_post))
        .route("/ml/run/test", post(run_test))
        .route("/ml/detections", get(detections))
        .route("/ml/outlook", get(outlook))
}

async fn catalog(State(st): St) -> Json<Value> {
    let mut c = super::spec::catalog();
    let cfg = st.ml.cfg.read().clone();
    c["server"] = json!({
        "enabled": cfg.enabled,
        "max_jobs": cfg.max_jobs.max(1),
        "download_concurrency": st.ml.download_concurrency(),
        "cpu_threads": st.profile.threads,
        "profile": st.profile.name,
        "version": crate::api::VERSION,
    });
    Json(c)
}

async fn train(State(st): St, body: Option<Json<Value>>) -> Result<Json<Value>, E> {
    let raw = body.map(|b| b.0).unwrap_or(json!({}));
    let id = st.ml.submit(&raw)?;
    Ok(Json(json!({"job_id": id})))
}

async fn jobs(State(st): St) -> Json<Value> {
    Json(json!(st.ml.jobs.list().iter().map(|c| c.json(false)).collect::<Vec<_>>()))
}

async fn job(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, E> {
    let c = st.ml.jobs.get(&id).ok_or_else(|| nf("job"))?;
    Ok(Json(c.json(true)))
}

async fn job_stop(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, E> {
    let c = st.ml.jobs.get(&id).ok_or_else(|| nf("job"))?;
    match c.state().as_str() {
        "running" | "stopping" => c.request_stop(),
        "queued" => {
            c.request_cancel();
        }
        s => return Err(E(StatusCode::CONFLICT, format!("job is {s}"))),
    }
    Ok(Json(c.json(false)))
}

async fn job_resume(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, E> {
    let new = st.ml.resume(&id)?;
    Ok(Json(json!({"job_id": new})))
}

async fn job_delete(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, E> {
    let c = st.ml.jobs.get(&id).ok_or_else(|| nf("job"))?;
    let active = matches!(c.state().as_str(), "queued" | "running" | "stopping");
    if active {
        // cancel; the record is removed once the worker has wound down
        c.request_cancel();
        let jobs = st.ml.jobs.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            for _ in 0..600 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if !matches!(c.state().as_str(), "queued" | "running" | "stopping") {
                    break;
                }
            }
            jobs.remove(&id2);
        });
    } else {
        st.ml.jobs.remove(&id);
    }
    Ok(Json(json!({"ok": true, "id": id, "cancelled": active})))
}

async fn models(State(st): St) -> Json<Value> {
    Json(json!(st.ml.store.list().iter().map(|m| m.summary()).collect::<Vec<_>>()))
}

async fn model(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, E> {
    let m = st.ml.store.get(&id).ok_or_else(|| nf("model"))?;
    Ok(Json(m.detail()))
}

async fn model_patch(State(st): St, Path(id): Path<String>, Json(body): Json<Value>) -> Result<Json<Value>, E> {
    let m = st.ml.store.patch(&id, &body)?;
    st.hub.send(json!({"type": "ml_model", "id": id, "action": "updated"}));
    Ok(Json(m.detail()))
}

async fn model_delete(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, E> {
    st.ml.store.delete(&id)?;
    // stop running it; drop its layers
    let mut c = st.ml.runner.cfg.read().clone();
    if c.has(&id) {
        c.models.retain(|m| m.id != id);
        st.ml.runner.set_cfg(c);
    }
    st.ml.runner.forget_model(&id);
    st.hub.send(json!({"type": "ml_model", "id": id, "action": "deleted"}));
    Ok(Json(json!({"ok": true, "id": id})))
}

fn file_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let s = s.trim_matches('_');
    format!("{}.tbwmodel", if s.is_empty() { "model" } else { s })
}

async fn export(State(st): St, Path(id): Path<String>) -> Result<Response, E> {
    let m = st.ml.store.get(&id).ok_or_else(|| nf("model"))?;
    let b = tokio::task::spawn_blocking(move || super::model::export(&m).map(|b| (b, file_name(&m.name)))).await.map_err(|e| E(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    let mut r = Response::new(Body::from(b.0));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", b.1)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(r)
}

async fn import(State(st): St, body: Bytes) -> Result<Json<Value>, E> {
    if body.is_empty() {
        return Err(E(StatusCode::BAD_REQUEST, "empty body: send the .tbwmodel file as the request body".into()));
    }
    let mut m = tokio::task::spawn_blocking(move || super::model::import(&body)).await.map_err(|e| E(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    if !super::model::valid_id(&m.id) || st.ml.store.get(&m.id).is_some() {
        m.id = super::model::new_id();
    }
    m.origin = if m.origin.is_empty() || m.origin == "trained" { "imported".into() } else { m.origin };
    m.updated = chrono::Utc::now().timestamp_millis();
    m.format = super::model::FORMAT_VERSION;
    m.history.push(super::model::HistEntry { version: m.version, at: m.updated, kind: "import".into(), metrics_summary: m.metrics_summary(), samples: m.metrics.get("dataset").and_then(|d| d.get("samples")).cloned().unwrap_or(Value::Null), job_id: None, from_model: None });
    let saved = st.ml.store.save(m)?;
    st.hub.send(json!({"type": "ml_model", "id": saved.id, "action": "imported"}));
    Ok(Json(saved.detail()))
}

async fn retrain(State(st): St, Path(id): Path<String>, body: Option<Json<Value>>) -> Result<Json<Value>, E> {
    let raw = body.map(|b| b.0).unwrap_or(json!({}));
    let job = st.ml.retrain(&id, &raw)?;
    Ok(Json(json!({"job_id": job, "kind": "retrain", "base_model": id, "mode": raw.get("mode").and_then(|v| v.as_str()).unwrap_or("replace")})))
}

async fn continue_(State(st): St, Path(id): Path<String>, body: Option<Json<Value>>) -> Result<Json<Value>, E> {
    let raw = body.map(|b| b.0).unwrap_or(json!({}));
    let job = st.ml.continue_training(&id, &raw)?;
    Ok(Json(json!({"job_id": job, "kind": "continue", "base_model": id, "mode": raw.get("mode").and_then(|v| v.as_str()).unwrap_or("replace")})))
}

async fn history(State(st): St, Path(id): Path<String>) -> Result<Json<Value>, E> {
    let m = st.ml.store.get(&id).ok_or_else(|| nf("model"))?;
    Ok(Json(json!({"id": m.id, "version": m.version, "history": m.history})))
}

async fn run_get(State(st): St) -> Json<Value> {
    let sites = st.sites.read().clone();
    Json(st.ml.runner.status(&sites))
}

fn parse_models(st: &AppState, m: &Value) -> Result<Vec<super::runner::ModelRun>, E> {
    let arr = m.as_array().ok_or_else(|| E(StatusCode::BAD_REQUEST, "models must be an array of model ids or {id, …options}".into()))?;
    let mut out = vec![];
    for x in arr {
        let r = super::runner::ModelRun::parse(x).map_err(|e| E(StatusCode::BAD_REQUEST, format!("{e:#}")))?;
        if st.ml.store.get(&r.id).is_none() {
            return Err(nf(&format!("model {}", r.id)));
        }
        if !out.iter().any(|o: &super::runner::ModelRun| o.id == r.id) {
            out.push(r);
        }
    }
    Ok(out)
}

async fn run_post(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, E> {
    let mut c = st.ml.runner.cfg.read().clone();
    if let Some(m) = body.get("models") {
        c.models = parse_models(&st, m)?;
    }
    if let Some(r) = body.get("radars") {
        if !(r.is_string() || r.is_array() || r.is_object()) {
            return Err(E(StatusCode::BAD_REQUEST, "radars: \"all\" | \"nexrad\" | \"tdwr\" | [ids] | {states:[…]}".into()));
        }
        c.radars = r.clone();
    }
    if let Some(e) = body.get("enabled").and_then(|v| v.as_bool()) {
        c.enabled = e;
    }
    if let Some(i) = body.get("interval_s").and_then(|v| v.as_u64()) {
        c.interval_s = i.clamp(15, 3600);
    }
    if let Some(n) = body.get("concurrency").and_then(|v| v.as_u64()) {
        c.concurrency = (n as usize).min(64);
    }
    if c.enabled && !st.ml.cfg.read().enabled {
        return Err(E(StatusCode::CONFLICT, "detection models are disabled in the server config ([ml] enabled = false)".into()));
    }
    st.ml.runner.set_cfg(c);
    let sites = st.sites.read().clone();
    Ok(Json(st.ml.runner.status(&sites)))
}

/// Run models once now. Radar-cell models: on one radar (newest volume, or a given volume
/// `key` such as a historical `aws:` key from `/api/radar/{site}/day/{date}`); grid / outlook
/// models: one prediction at `valid_time` (default now) / for `day`. Per-model options as in
/// `POST /api/ml/run`. Detections are returned (not stored); grid layers are published.
async fn run_test(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, E> {
    let runs: Vec<super::runner::ModelRun> = match body.get("models") {
        Some(m) => parse_models(&st, m)?,
        None => st.ml.runner.cfg.read().models.clone(),
    };
    let models: Vec<(Arc<super::model::ModelRecord>, super::runner::ModelRun)> = runs.into_iter().filter_map(|o| st.ml.store.get(&o.id).map(|m| (m, o))).collect();
    if models.is_empty() {
        return Err(E(StatusCode::BAD_REQUEST, "no models given".into()));
    }
    let fetch = st.ml.fetch.clone();
    let tmp = super::runner::Runner::new(None, 1);
    tmp.set_cfg(super::runner::RunCfg { models: models.iter().map(|m| m.1.clone()).collect(), ..Default::default() });
    *tmp.sink.write() = st.ml.runner.sink.read().clone();
    tmp.max_points.store(st.ml.runner.max_points.load(std::sync::atomic::Ordering::Relaxed), std::sync::atomic::Ordering::Relaxed);
    let radar: Vec<Arc<super::model::ModelRecord>> = models.iter().filter(|m| m.0.candidate == "radar_cell").map(|m| m.0.clone()).collect();
    let mut dets = vec![];
    let mut stats = Value::Null;
    if !radar.is_empty() {
        let key = body.get("key").and_then(|v| v.as_str()).map(str::to_string);
        let site = body.get("site").and_then(|v| v.as_str()).map(|s| s.to_ascii_uppercase());
        dets.extend(match (key, site) {
            (Some(k), _) => tmp.process_key(fetch.as_ref(), &k, &radar).await?,
            (None, Some(s)) => tmp.process_site(fetch.as_ref(), &s, &radar, true).await,
            _ if models.len() == radar.len() => return Err(E(StatusCode::BAD_REQUEST, "site or key required for radar-cell models".into())),
            _ => vec![],
        });
        stats = json!(tmp.per_radar.read().values().next().cloned());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let t = body.get("valid_time").and_then(|v| v.as_i64()).unwrap_or(now);
    let day = body.get("day").and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|d| d.to_string())));
    let mut layers = vec![];
    let mut outlooks = vec![];
    let mut errors = serde_json::Map::new();
    for (m, o) in models.iter().filter(|m| m.0.candidate == "grid_point") {
        let mut o = o.clone();
        if o.day.is_none() {
            o.day = day.clone();
        }
        if m.output() == "detections" {
            match tmp.process_grid(fetch.as_ref(), m, t).await {
                Ok(d) => dets.extend(d),
                Err(e) => {
                    errors.insert(m.id.clone(), json!(format!("{e:#}")));
                }
            }
            continue;
        }
        match tmp.run_grid_model(fetch.as_ref(), m, &o, t, None).await {
            Ok(out) => {
                // the live runner lists the layers too
                st.ml.runner.model_state.write().entry(m.id.clone()).or_default().layers = out.layers.clone();
                layers.extend(out.layers);
                if let Some(gj) = out.outlook {
                    let key = format!("{}|{}", m.id, gj["valid_from"].as_i64().unwrap_or(0));
                    st.ml.runner.outlooks.write().insert(key, gj.clone());
                    outlooks.push(gj);
                }
                dets.extend(out.detections);
            }
            Err(e) => {
                errors.insert(m.id.clone(), json!(format!("{e:#}")));
            }
        }
    }
    tmp.push_all(dets);
    let mut gj = tmp.geojson(0, &[], None);
    gj["stats"] = stats;
    gj["layers"] = json!(layers);
    gj["outlooks"] = json!(outlooks);
    gj["errors"] = Value::Object(errors);
    Ok(Json(gj))
}

/// `GET /api/ml/outlook?model=&day=1|2|3|4-7&from=&to=&hazard=` → outlook GeoJSON. Uses the
/// latest run for that window; computes one now when there is none.
async fn outlook(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, E> {
    let g = |k: &str| q.get(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let cfg_models = st.ml.runner.cfg.read().models.clone();
    let id = match g("model") {
        Some(id) => id,
        None => {
            // the first running outlook model (optionally of the hazard)
            let hz = g("hazard");
            cfg_models
                .iter()
                .filter_map(|o| st.ml.store.get(&o.id))
                .find(|m| m.output() == "outlook" && hz.as_ref().map(|h| m.spec["target_params"]["hazard"].as_str() == Some(h.as_str())).unwrap_or(true))
                .map(|m| m.id.clone())
                .ok_or_else(|| E(StatusCode::NOT_FOUND, "no outlook model is running; pass model=<id>".into()))?
        }
    };
    let m = st.ml.store.get(&id).ok_or_else(|| nf("model"))?;
    if m.output() != "outlook" {
        return Err(E(StatusCode::BAD_REQUEST, format!("model {id} is not an outlook model (output {})", m.output())));
    }
    if let Some(h) = g("hazard") {
        let mh = m.spec["target_params"]["hazard"].as_str().unwrap_or("any");
        if h != mh {
            return Err(E(StatusCode::BAD_REQUEST, format!("model {id} predicts hazard {mh}")));
        }
    }
    let num = |k: &str| -> Result<Option<i64>, E> { g(k).map(|v| v.parse::<i64>().map_err(|_| E(StatusCode::BAD_REQUEST, format!("{k} must be unix ms")))).transpose() };
    let (from, to) = (num("from")?, num("to")?);
    let day = g("day");
    if let Some(d) = &day {
        if !matches!(d.as_str(), "1" | "2" | "3" | "4-7" | "4") {
            return Err(E(StatusCode::BAD_REQUEST, "day must be 1, 2, 3 or 4-7".into()));
        }
    }
    let mut o = cfg_models.iter().find(|x| x.id == id).cloned().unwrap_or_else(|| super::runner::ModelRun::plain(&id));
    if day.is_some() {
        o.day = day.clone();
        o.valid_from = None;
        o.valid_to = None;
    }
    if from.is_some() {
        o.valid_from = from;
        o.valid_to = to.or(from.map(|f| f + 24 * 3_600_000));
    }
    // the window this request means
    let now = chrono::Utc::now().timestamp_millis();
    let spec = super::predict::model_spec(&m);
    let mut tp = super::gridds::TParams::of(&spec);
    if let Some(d) = &o.day {
        tp.day = d.clone();
    }
    let win = super::gridds::leads_for("outlook", &tp, now, None, o.valid_from.map(|a| (a, o.valid_to.unwrap_or(a + 24 * 3_600_000))))[0];
    let key = format!("{id}|{}", win.w0);
    if let Some(v) = st.ml.runner.outlooks.read().get(&key).cloned() {
        if now - v["issued"].as_i64().unwrap_or(0) < 6 * 3_600_000 {
            return Ok(Json(v));
        }
    }
    let out = st.ml.runner.run_grid_model(st.ml.fetch.as_ref(), &m, &o, now, Some(&st.hub)).await?;
    let mut gj = out.outlook.ok_or_else(|| E(StatusCode::INTERNAL_SERVER_ERROR, "no outlook produced".into()))?;
    gj["computed_now"] = json!(true);
    st.ml.runner.outlooks.write().insert(format!("{id}|{}", gj["valid_from"].as_i64().unwrap_or(win.w0)), gj.clone());
    Ok(Json(gj))
}

async fn detections(State(st): St, Query(q): Query<HashMap<String, String>>) -> Result<Json<Value>, E> {
    let since = match q.get("since").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(s) => s.parse::<i64>().map_err(|_| E(StatusCode::BAD_REQUEST, "since must be unix ms".into()))?,
        None => 0,
    };
    let models: Vec<String> = q.get("models").map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    let bbox = match q.get("bbox").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(b) => {
            let v: Vec<f64> = b.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            if v.len() != 4 {
                return Err(E(StatusCode::BAD_REQUEST, "bbox=w,s,e,n".into()));
            }
            Some([v[0], v[1], v[2], v[3]])
        }
        None => None,
    };
    Ok(Json(st.ml.runner.geojson(since, &models, bbox)))
}
