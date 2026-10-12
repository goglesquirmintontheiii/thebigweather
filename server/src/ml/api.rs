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
        .route("/ml/run", get(run_get).post(run_post))
        .route("/ml/run/test", post(run_test))
        .route("/ml/detections", get(detections))
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
    // stop running it
    let mut c = st.ml.runner.cfg.read().clone();
    if c.models.contains(&id) {
        c.models.retain(|m| m != &id);
        st.ml.runner.set_cfg(c);
    }
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
    let saved = st.ml.store.save(m)?;
    st.hub.send(json!({"type": "ml_model", "id": saved.id, "action": "imported"}));
    Ok(Json(saved.detail()))
}

async fn run_get(State(st): St) -> Json<Value> {
    let sites = st.sites.read().clone();
    Json(st.ml.runner.status(&sites))
}

async fn run_post(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, E> {
    let mut c = st.ml.runner.cfg.read().clone();
    if let Some(m) = body.get("models") {
        let ids: Vec<String> = m.as_array().ok_or_else(|| E(StatusCode::BAD_REQUEST, "models must be an array of model ids".into()))?.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
        for id in &ids {
            if st.ml.store.get(id).is_none() {
                return Err(nf(&format!("model {id}")));
            }
        }
        c.models = ids;
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
    if c.enabled && !st.ml.cfg.read().enabled {
        return Err(E(StatusCode::CONFLICT, "detection models are disabled in the server config ([ml] enabled = false)".into()));
    }
    st.ml.runner.set_cfg(c);
    let sites = st.sites.read().clone();
    Ok(Json(st.ml.runner.status(&sites)))
}

/// Run models once on one radar now (newest volume, or a given volume `key` such as a
/// historical `aws:` key from `/api/radar/{site}/day/{date}`). Detections are returned (not stored).
async fn run_test(State(st): St, Json(body): Json<Value>) -> Result<Json<Value>, E> {
    let ids: Vec<String> = match body.get("models") {
        Some(m) => m.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
        None => st.ml.runner.cfg.read().models.clone(),
    };
    let models: Vec<_> = ids.iter().filter_map(|id| st.ml.store.get(id)).filter(|m| m.candidate == "radar_cell").collect();
    if models.is_empty() {
        return Err(E(StatusCode::BAD_REQUEST, "no radar-cell models given".into()));
    }
    let key = body.get("key").and_then(|v| v.as_str()).map(str::to_string);
    let site = body.get("site").and_then(|v| v.as_str()).map(|s| s.to_ascii_uppercase());
    let fetch = st.ml.fetch.clone();
    let tmp = super::runner::Runner::new(None, 1);
    let dets = match (key, site) {
        (Some(k), _) => tmp.process_key(fetch.as_ref(), &k, &models).await?,
        (None, Some(s)) => tmp.process_site(fetch.as_ref(), &s, &models, true).await,
        _ => return Err(E(StatusCode::BAD_REQUEST, "site or key required".into())),
    };
    let stat = tmp.per_radar.read().values().next().cloned();
    tmp.push_all(dets);
    let mut gj = tmp.geojson(0, &[], None);
    gj["stats"] = json!(stat);
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
