//! Live inference: for the selected radars, process each new Level II volume (cells → features
//! → every enabled radar-cell model) and run grid-point models over their region at their
//! cadence. Detections are kept for 2 h and pushed on the `/ws` hub.

use super::cells::{self, CellParams, VolCells};
use super::features::{day_of_year, solar_hour, Sources};
use super::model::{ModelRecord, Store};
use super::source::Fetch;
use futures::StreamExt;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

pub const KEEP_MS: i64 = 2 * 3_600_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RunCfg {
    pub models: Vec<String>,
    /// "all" | "nexrad" | "tdwr" | ["KTLX", …] | {"states": ["OK", …]} | {"bbox": [w, s, e, n]}
    pub radars: Value,
    pub enabled: bool,
    pub interval_s: u64,
}

impl Default for RunCfg {
    fn default() -> Self {
        Self { models: vec![], radars: json!("all"), enabled: false, interval_s: 60 }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RadarStat {
    pub t: Option<i64>,
    pub cells: usize,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub detections: usize,
    pub checked: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Detection {
    pub id: String,
    pub model_id: String,
    pub model_name: String,
    pub target: String,
    pub prob: f64,
    pub level: &'static str,
    pub site: Option<String>,
    pub t: i64,
    pub created: i64,
    pub cell_id: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub top_features: Vec<super::model::Contribution>,
    pub motion: Option<Value>,
    pub outline: Vec<[f32; 2]>,
}

impl Detection {
    fn props(&self) -> Value {
        json!({
            "id": self.id, "model_id": self.model_id, "model_name": self.model_name, "target": self.target,
            "prob": (self.prob * 1000.0).round() / 1000.0, "level": self.level, "site": self.site, "t": self.t, "created": self.created,
            "cell_id": self.cell_id, "top_features": self.top_features, "motion": self.motion,
        })
    }
    pub fn ws(&self) -> Value {
        let mut p = self.props();
        p["type"] = json!("ml_detection");
        p["lat"] = json!(self.lat);
        p["lon"] = json!(self.lon);
        if !self.outline.is_empty() {
            p["outline"] = json!(self.outline);
        }
        p
    }
}

/// Resolve a radar selection to site ids.
pub fn resolve_sites(sel: &Value, sites: &[crate::sites::Site]) -> Vec<String> {
    let us = |s: &&crate::sites::Site| s.kind == "NEXRAD" || s.kind == "TDWR";
    let mut v: Vec<String> = match sel {
        Value::String(s) => match s.to_ascii_lowercase().as_str() {
            "nexrad" => sites.iter().filter(|s| s.kind == "NEXRAD").map(|s| s.id.clone()).collect(),
            "tdwr" => sites.iter().filter(|s| s.kind == "TDWR").map(|s| s.id.clone()).collect(),
            "all" => sites.iter().filter(us).map(|s| s.id.clone()).collect(),
            one => sites.iter().filter(|x| x.id.eq_ignore_ascii_case(one)).map(|s| s.id.clone()).collect(),
        },
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).filter_map(|id| sites.iter().find(|s| s.id.eq_ignore_ascii_case(id)).map(|s| s.id.clone())).collect(),
        Value::Object(o) => {
            let mut out = vec![];
            if let Some(st) = o.get("states").and_then(|x| x.as_array()) {
                let st: Vec<String> = st.iter().filter_map(|x| x.as_str().map(|s| s.to_ascii_uppercase())).collect();
                // the embedded site table has no states: fall back to the states' boxes
                let region = super::labels::Region { states: st.clone(), bbox: None };
                out.extend(sites.iter().filter(us).filter(|s| if s.state.trim().is_empty() { region.contains(s.lat, s.lon, "") } else { st.contains(&s.state.to_ascii_uppercase()) }).map(|s| s.id.clone()));
            }
            if let Some(b) = o.get("bbox").and_then(|x| x.as_array()).filter(|b| b.len() == 4) {
                let b: Vec<f64> = b.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
                out.extend(sites.iter().filter(us).filter(|s| s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3]).map(|s| s.id.clone()));
            }
            if let Some(ids) = o.get("sites").and_then(|x| x.as_array()) {
                out.extend(ids.iter().filter_map(|x| x.as_str()).filter_map(|id| sites.iter().find(|s| s.id.eq_ignore_ascii_case(id)).map(|s| s.id.clone())));
            }
            out
        }
        _ => vec![],
    };
    v.sort();
    v.dedup();
    v
}

pub struct Runner {
    pub cfg: RwLock<RunCfg>,
    pub per_radar: RwLock<HashMap<String, RadarStat>>,
    prev: Mutex<HashMap<String, VolCells>>,
    last_key: Mutex<HashMap<String, String>>,
    pub dets: RwLock<VecDeque<Detection>>,
    pub last_cycle: Mutex<Option<i64>>,
    grid_last: Mutex<HashMap<String, i64>>,
    pub wake: tokio::sync::Notify,
    pub concurrency: crate::caches::Limiter,
    seq: std::sync::atomic::AtomicU64,
    path: Option<std::path::PathBuf>,
}

impl Runner {
    pub fn new(path: Option<std::path::PathBuf>, concurrency: usize) -> Runner {
        let cfg: RunCfg = path.as_ref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Runner {
            cfg: RwLock::new(cfg),
            per_radar: RwLock::new(HashMap::new()),
            prev: Mutex::new(HashMap::new()),
            last_key: Mutex::new(HashMap::new()),
            dets: RwLock::new(VecDeque::new()),
            last_cycle: Mutex::new(None),
            grid_last: Mutex::new(HashMap::new()),
            wake: tokio::sync::Notify::new(),
            concurrency: crate::caches::Limiter::new(concurrency),
            seq: std::sync::atomic::AtomicU64::new(0),
            path,
        }
    }

    pub fn set_cfg(&self, c: RunCfg) {
        if let Some(p) = &self.path {
            crate::platform::write_atomic(p, &serde_json::to_vec_pretty(&c).unwrap_or_default()).ok();
        }
        *self.cfg.write() = c;
        self.wake.notify_one();
    }

    pub fn status(&self, sites: &[crate::sites::Site]) -> Value {
        let c = self.cfg.read().clone();
        let resolved = resolve_sites(&c.radars, sites);
        json!({
            "enabled": c.enabled, "models": c.models, "radars": c.radars, "interval_s": c.interval_s,
            "sites": resolved, "last_cycle": *self.last_cycle.lock(),
            "per_radar": self.per_radar.read().clone(),
            "detections": self.dets.read().len(),
        })
    }

    pub fn mem_bytes(&self) -> (usize, usize) {
        let d = self.dets.read();
        let p = self.prev.lock();
        let cells: usize = p.values().map(|v| v.cells.len()).sum();
        (d.len() * 1500 + cells * 3000, d.len() + p.len())
    }

    pub fn clear(&self) {
        self.dets.write().clear();
        self.prev.lock().clear();
    }

    fn prune(&self, now: i64) {
        let mut d = self.dets.write();
        while d.front().map(|x| now - x.created > KEEP_MS).unwrap_or(false) {
            d.pop_front();
        }
    }

    fn push(&self, hub: Option<&crate::hub::Hub>, mut new: Vec<Detection>) {
        if new.is_empty() {
            return;
        }
        new.sort_by_key(|d| d.created);
        if let Some(h) = hub {
            for d in &new {
                h.send(d.ws());
            }
        }
        let mut g = self.dets.write();
        g.extend(new);
        while g.len() > 50_000 {
            g.pop_front();
        }
    }

    /// GeoJSON of detections created at/after `since` (ms), optionally filtered by models / bbox.
    pub fn geojson(&self, since: i64, models: &[String], bbox: Option<[f64; 4]>) -> Value {
        let d = self.dets.read();
        let mut feats = vec![];
        for x in d.iter() {
            if x.created < since || (!models.is_empty() && !models.contains(&x.model_id)) {
                continue;
            }
            if let Some([w, s, e, n]) = bbox {
                if !(x.lon >= w && x.lon <= e && x.lat >= s && x.lat <= n) {
                    continue;
                }
            }
            let mut p = x.props();
            p["kind"] = json!("point");
            feats.push(json!({"type": "Feature", "id": x.id, "geometry": {"type": "Point", "coordinates": [x.lon, x.lat]}, "properties": p}));
            if x.outline.len() >= 3 {
                let mut ring: Vec<[f32; 2]> = x.outline.clone();
                ring.push(ring[0]);
                let mut p = x.props();
                p["kind"] = json!("outline");
                feats.push(json!({"type": "Feature", "id": format!("{}-outline", x.id), "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": p}));
            }
        }
        json!({"type": "FeatureCollection", "features": feats, "count": feats.len()})
    }

    /// Environment features for a volume's cells (sources of all models).
    async fn add_env(fetch: &dyn Fetch, models: &[Arc<ModelRecord>], vc: &mut VolCells, realtime: bool) {
        let mut src = Sources::default();
        for m in models {
            let s = &m.feature_schema.sources;
            src.mrms.extend(s.mrms.iter().cloned());
            src.metar |= s.metar;
            src.model.extend(s.model.iter().cloned());
        }
        let src = src.normalized();
        if !src.is_empty() && !vc.cells.is_empty() {
            let pts: Vec<(f64, f64)> = vc.cells.iter().map(|c| (c.lat, c.lon)).collect();
            if let Ok(env) = fetch.env(&src, vc.t, &pts, realtime).await {
                for (c, e) in vc.cells.iter_mut().zip(env) {
                    c.feats.0.extend(e.0);
                }
            }
        }
    }

    fn score_cells(&self, vc: &VolCells, models: &[Arc<ModelRecord>]) -> Vec<Detection> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut out = vec![];
        for c in &vc.cells {
            for m in models {
                let (p, top) = m.score(&c.feats, 5);
                let Some(level) = m.levels.level(p) else { continue };
                let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                out.push(Detection {
                    id: format!("d{}-{n}", super::model::radix36(now as u64)),
                    model_id: m.id.clone(),
                    model_name: m.name.clone(),
                    target: m.target.clone(),
                    prob: p,
                    level,
                    site: Some(vc.site.clone()),
                    t: vc.t,
                    created: now,
                    cell_id: Some(c.id.clone()),
                    lat: c.lat,
                    lon: c.lon,
                    top_features: top,
                    motion: c.motion.map(|(d, kt)| json!({"dir": (d * 10.0).round() / 10.0, "kt": (kt * 10.0).round() / 10.0})),
                    outline: c.hull.clone(),
                });
            }
        }
        out
    }

    /// Score one specific volume (e.g. a historical archive key); no tracking state is touched.
    pub async fn process_key(&self, fetch: &dyn Fetch, key: &str, models: &[Arc<ModelRecord>]) -> anyhow::Result<Vec<Detection>> {
        let t0 = std::time::Instant::now();
        let vol = fetch.volume(key).await?;
        let k = key.to_string();
        let cp = models.first().and_then(|m| serde_json::from_value::<CellParams>(m.spec.get("cell").cloned().unwrap_or(Value::Null)).ok()).unwrap_or_default();
        let mut vc = tokio::task::spawn_blocking(move || cells::extract(&vol, &k, &cp)).await?;
        Self::add_env(fetch, models, &mut vc, false).await;
        let out = self.score_cells(&vc, models);
        self.per_radar.write().insert(vc.site.clone(), RadarStat { t: Some(vc.t), cells: vc.cells.len(), ms: t0.elapsed().as_millis() as u64, error: None, key: Some(key.to_string()), detections: out.len(), checked: chrono::Utc::now().timestamp_millis() });
        Ok(out)
    }

    pub fn push_all(&self, d: Vec<Detection>) {
        self.push(None, d);
    }

    /// Process one site's newest volume with the radar models. Returns new detections.
    pub async fn process_site(&self, fetch: &dyn Fetch, site: &str, models: &[Arc<ModelRecord>], force: bool) -> Vec<Detection> {
        let t0 = std::time::Instant::now();
        let now = chrono::Utc::now().timestamp_millis();
        let mut stat = RadarStat { checked: now, ..self.per_radar.read().get(site).cloned().unwrap_or_default() };
        let res: anyhow::Result<Option<Vec<Detection>>> = async {
            let Some(e) = fetch.latest(site).await? else { anyhow::bail!("no volumes") };
            if !force && self.last_key.lock().get(site) == Some(&e.key) {
                return Ok(None);
            }
            if !force && now - e.time > 30 * 60_000 {
                self.last_key.lock().insert(site.to_string(), e.key.clone());
                anyhow::bail!("newest volume is {} min old", (now - e.time) / 60_000);
            }
            let vol = fetch.volume(&e.key).await?;
            let key = e.key.clone();
            let cp = models.first().and_then(|m| serde_json::from_value::<CellParams>(m.spec.get("cell").cloned().unwrap_or(Value::Null)).ok()).unwrap_or_default();
            let mut vc = tokio::task::spawn_blocking(move || cells::extract(&vol, &key, &cp)).await?;
            let prev = self.prev.lock().get(site).cloned();
            let matched = match &prev {
                Some(p) => cells::apply_trends(&mut vc, p),
                None => vec![None; vc.cells.len()],
            };
            // keep track ids across volumes
            if let Some(p) = &prev {
                for (c, m) in vc.cells.iter_mut().zip(&matched) {
                    if let Some(j) = m {
                        c.id = p.cells[*j].id.clone();
                    }
                }
            }
            Self::add_env(fetch, models, &mut vc, true).await;
            let out = self.score_cells(&vc, models);
            stat.cells = vc.cells.len();
            stat.t = Some(vc.t);
            stat.key = Some(e.key.clone());
            self.last_key.lock().insert(site.to_string(), e.key);
            self.prev.lock().insert(site.to_string(), vc);
            Ok(Some(out))
        }
        .await;
        let out = match res {
            Ok(Some(d)) => {
                stat.error = None;
                stat.ms = t0.elapsed().as_millis() as u64;
                stat.detections = d.len();
                d
            }
            Ok(None) => vec![],
            Err(e) => {
                stat.error = Some(format!("{e:#}"));
                vec![]
            }
        };
        self.per_radar.write().insert(site.to_string(), stat);
        out
    }

    /// Run a grid-point model over its region (newest gridded data).
    pub async fn process_grid(&self, fetch: &dyn Fetch, m: &ModelRecord, t: i64) -> anyhow::Result<Vec<Detection>> {
        let region: super::labels::Region = serde_json::from_value(m.spec.get("region").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        let grid: super::spec::GridOpts = serde_json::from_value(m.spec.get("grid").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        let [w, s, e, n] = region.bbox();
        let step = grid.run_spacing_deg.clamp(0.05, 5.0);
        let mut pts = vec![];
        let mut lat = s;
        while lat <= n && pts.len() < 60_000 {
            let mut lon = w;
            while lon <= e && pts.len() < 60_000 {
                if region.contains(lat, lon, "") {
                    pts.push((lat, lon));
                }
                lon += step;
            }
            lat += step;
        }
        let env = fetch.env(&m.feature_schema.sources, t, &pts, true).await?;
        let mut cand: Vec<(f64, usize, Vec<super::model::Contribution>)> = vec![];
        for (i, (p, mut fm)) in pts.iter().zip(env).enumerate() {
            fm.set("lat", p.0 as f32);
            fm.set("lon", p.1 as f32);
            fm.set("doy", day_of_year(t));
            fm.set("solar_hour", solar_hour(t, p.1));
            let (pr, top) = m.score(&fm, 5);
            if pr >= m.levels.low {
                cand.push((pr, i, top));
            }
        }
        // keep local maxima (no stronger point within 2 grid steps)
        cand.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let mut kept: Vec<(f64, usize, Vec<super::model::Contribution>)> = vec![];
        for c in cand {
            let (la, lo) = pts[c.1];
            if kept.iter().any(|k| (pts[k.1].0 - la).abs() <= 2.0 * step && (pts[k.1].1 - lo).abs() <= 2.0 * step) {
                continue;
            }
            kept.push(c);
            if kept.len() >= 200 {
                break;
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        Ok(kept
            .into_iter()
            .map(|(p, i, top)| {
                let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Detection {
                    id: format!("d{}-{n}", super::model::radix36(now as u64)),
                    model_id: m.id.clone(),
                    model_name: m.name.clone(),
                    target: m.target.clone(),
                    prob: p,
                    level: m.levels.level(p).unwrap_or("low"),
                    site: None,
                    t,
                    created: now,
                    cell_id: None,
                    lat: pts[i].0,
                    lon: pts[i].1,
                    top_features: top,
                    motion: None,
                    outline: vec![],
                }
            })
            .collect())
    }

    /// One pass over every selected radar and due grid model.
    pub async fn cycle(&self, fetch: &dyn Fetch, store: &Store, hub: Option<&crate::hub::Hub>) {
        let cfg = self.cfg.read().clone();
        let now = chrono::Utc::now().timestamp_millis();
        self.prune(now);
        let models: Vec<Arc<ModelRecord>> = cfg.models.iter().filter_map(|id| store.get(id)).collect();
        let radar_models: Vec<Arc<ModelRecord>> = models.iter().filter(|m| m.candidate == "radar_cell").cloned().collect();
        if !radar_models.is_empty() {
            let sites = resolve_sites(&cfg.radars, &fetch.sites());
            let sem = self.concurrency.sem.clone();
            let rm = &radar_models;
            let res: Vec<Vec<Detection>> = futures::stream::iter(sites)
                .map(|site| {
                    let sem = sem.clone();
                    async move {
                        let _p = sem.acquire_owned().await;
                        if !self.cfg.read().enabled {
                            return vec![];
                        }
                        self.process_site(fetch, &site, rm, false).await
                    }
                })
                .buffer_unordered(32)
                .collect()
                .await;
            for d in res {
                self.push(hub, d);
            }
        }
        for m in models.iter().filter(|m| m.candidate == "grid_point") {
            let every = m.spec.get("grid").and_then(|g| g.get("run_every_min")).and_then(|v| v.as_u64()).unwrap_or(360).max(1) as i64 * 60_000;
            let last = self.grid_last.lock().get(&m.id).copied().unwrap_or(0);
            if now - last < every {
                continue;
            }
            self.grid_last.lock().insert(m.id.clone(), now);
            match self.process_grid(fetch, m, now).await {
                Ok(d) => self.push(hub, d),
                Err(e) => {
                    self.per_radar.write().insert(format!("grid:{}", m.id), RadarStat { checked: now, error: Some(format!("{e:#}")), ..Default::default() });
                }
            }
        }
        *self.last_cycle.lock() = Some(now);
    }

    /// Background loop (runs while enabled; wakes on configuration changes).
    pub async fn run_loop(self: Arc<Self>, fetch: Arc<dyn Fetch>, store: Arc<Store>, hub: crate::hub::Hub) {
        loop {
            let (enabled, iv) = {
                let c = self.cfg.read();
                (c.enabled && !c.models.is_empty(), c.interval_s.clamp(15, 3600))
            };
            if !enabled {
                self.wake.notified().await;
                continue;
            }
            self.cycle(fetch.as_ref(), &store, Some(&hub)).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(iv)) => {}
                _ = self.wake.notified() => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_selection() {
        let mk = |id: &str, kind: &str, lat: f64, lon: f64, st: &str| crate::sites::Site { id: id.into(), name: String::new(), state: st.into(), lat, lon, elev_m: 0.0, kind: kind.into(), country: None, region: None, format: None, source: None };
        let sites = vec![mk("KTLX", "NEXRAD", 35.33, -97.28, ""), mk("TOKC", "TDWR", 35.28, -97.51, "OK"), mk("KLOT", "NEXRAD", 41.6, -88.08, "IL"), mk("deess", "ODIM", 51.4, 6.9, "")];
        assert_eq!(resolve_sites(&json!("all"), &sites), vec!["KLOT", "KTLX", "TOKC"]);
        assert_eq!(resolve_sites(&json!("tdwr"), &sites), vec!["TOKC"]);
        assert_eq!(resolve_sites(&json!("nexrad"), &sites), vec!["KLOT", "KTLX"]);
        assert_eq!(resolve_sites(&json!(["ktlx", "nope"]), &sites), vec!["KTLX"]);
        // KTLX has no state in the table: matched by the state's box
        assert_eq!(resolve_sites(&json!({"states": ["ok"]}), &sites), vec!["KTLX", "TOKC"]);
        assert_eq!(resolve_sites(&json!({"bbox": [-90.0, 40.0, -87.0, 42.0]}), &sites), vec!["KLOT"]);
    }

    #[test]
    fn detection_json() {
        let d = Detection { id: "d1".into(), model_id: "m".into(), model_name: "M".into(), target: "tornado".into(), prob: 0.8123, level: "high", site: Some("KTLX".into()), t: 1, created: 2, cell_id: Some("c".into()), lat: 35.0, lon: -97.0, top_features: vec![], motion: Some(json!({"dir": 45.0, "kt": 30.0})), outline: vec![[-97.0, 35.0], [-96.9, 35.0], [-96.9, 35.1]] };
        let w = d.ws();
        assert_eq!(w["type"], "ml_detection");
        assert_eq!(w["prob"], 0.812);
        let r = Runner::new(None, 1);
        r.push_all(vec![d]);
        let g = r.geojson(0, &["m".into()], Some([-98.0, 34.0, -96.0, 36.0]));
        assert_eq!(g["count"], 2);
        assert_eq!(g["features"][1]["geometry"]["type"], "Polygon");
        assert_eq!(g["features"][1]["geometry"]["coordinates"][0].as_array().unwrap().len(), 4);
        assert_eq!(r.geojson(3, &[], None)["count"], 0);
        assert_eq!(r.geojson(0, &["x".into()], None)["count"], 0);
    }
}
