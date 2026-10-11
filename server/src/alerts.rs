//! NWS active alerts: polled, zone geometry resolved and simplified, deltas pushed to apps.

use crate::health::Health;
use crate::hub::Hub;
use anyhow::{bail, Result};
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct Alerts {
    http: reqwest::Client,
    url: String,
    hub: Hub,
    health: Arc<Health>,
    zone_dir: PathBuf,
    /// id -> GeoJSON feature (with resolved geometry)
    pub current: RwLock<HashMap<String, Value>>,
    zone_cache: RwLock<HashMap<String, Option<Value>>>,
    poll_secs: u64,
}

const NAME: &str = "NWS alerts";

fn simplify_ring(pts: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    if pts.len() <= 4 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (ax, ay) = (pts[a][0], pts[a][1]);
        let (bx, by) = (pts[b][0], pts[b][1]);
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let mut best = (0.0, a);
        for (i, p) in pts.iter().enumerate().take(b).skip(a + 1) {
            let d = if len2 == 0.0 {
                ((p[0] - ax).powi(2) + (p[1] - ay).powi(2)).sqrt()
            } else {
                ((dy * p[0] - dx * p[1] + bx * ay - by * ax).abs()) / len2.sqrt()
            };
            if d > best.0 {
                best = (d, i);
            }
        }
        if best.0 > tol {
            keep[best.1] = true;
            stack.push((a, best.1));
            stack.push((best.1, b));
        }
    }
    let out: Vec<[f64; 2]> = pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| [(p[0] * 1e4).round() / 1e4, (p[1] * 1e4).round() / 1e4]).collect();
    if out.len() < 4 {
        pts.to_vec()
    } else {
        out
    }
}

fn simplify_geom(g: &Value, tol: f64) -> Value {
    let ring = |r: &Value| -> Value {
        let pts: Vec<[f64; 2]> = r
            .as_array()
            .map(|a| a.iter().filter_map(|p| Some([p.get(0)?.as_f64()?, p.get(1)?.as_f64()?])).collect())
            .unwrap_or_default();
        json!(simplify_ring(&pts, tol))
    };
    let poly = |p: &Value| -> Value { json!(p.as_array().map(|rs| rs.iter().map(ring).collect::<Vec<_>>()).unwrap_or_default()) };
    match g["type"].as_str() {
        Some("Polygon") => json!({"type": "Polygon", "coordinates": poly(&g["coordinates"])}),
        Some("MultiPolygon") => json!({"type": "MultiPolygon", "coordinates": g["coordinates"].as_array().map(|ps| ps.iter().map(poly).collect::<Vec<_>>()).unwrap_or_default()}),
        _ => g.clone(),
    }
}

fn flags(p: &Value) -> Value {
    let text = format!(
        "{} {}",
        p["description"].as_str().unwrap_or(""),
        p["headline"].as_str().unwrap_or("")
    )
    .to_ascii_uppercase();
    let params = &p["parameters"];
    let first = |k: &str| params[k][0].as_str().unwrap_or("").to_ascii_uppercase();
    let event = p["event"].as_str().unwrap_or("");
    json!({
        "tornado_emergency": text.contains("TORNADO EMERGENCY"),
        "flash_flood_emergency": text.contains("FLASH FLOOD EMERGENCY"),
        "pds": text.contains("PARTICULARLY DANGEROUS SITUATION"),
        "tornado_detection": first("tornadoDetection"),
        "tornado_damage_threat": first("tornadoDamageThreat"),
        "thunderstorm_damage_threat": first("thunderstormDamageThreat"),
        "flash_flood_damage_threat": first("flashFloodDamageThreat"),
        "max_hail": first("maxHailSize"),
        "max_wind": first("maxWindGust"),
        "warning": event.ends_with("Warning"),
    })
}

impl Alerts {
    pub fn new(http: reqwest::Client, url: String, hub: Hub, health: Arc<Health>, data_dir: &std::path::Path, poll_secs: u64) -> Arc<Self> {
        let zone_dir = data_dir.join("zones");
        std::fs::create_dir_all(&zone_dir).ok();
        Arc::new(Self {
            http,
            url,
            hub,
            health,
            zone_dir,
            current: RwLock::new(HashMap::new()),
            zone_cache: RwLock::new(HashMap::new()),
            poll_secs,
        })
    }

    pub fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) = me.poll().await {
                    me.health.err("nws-alerts", NAME, e);
                }
                tokio::time::sleep(Duration::from_secs(me.poll_secs)).await;
            }
        });
    }

    async fn zone(&self, url: &str) -> Option<Value> {
        let id = url.rsplit('/').next()?.to_string();
        if let Some(z) = self.zone_cache.read().get(&id) {
            return z.clone();
        }
        let path = self.zone_dir.join(format!("{id}.json"));
        if let Ok(s) = tokio::fs::read_to_string(&path).await {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                self.zone_cache.write().insert(id, Some(v.clone()));
                return Some(v);
            }
        }
        let r = self.http.get(url).header("Accept", "application/geo+json").send().await.ok()?;
        if !r.status().is_success() {
            self.zone_cache.write().insert(id, None);
            return None;
        }
        let v: Value = r.json().await.ok()?;
        let g = simplify_geom(&v["geometry"], 0.004);
        if g.is_null() {
            return None;
        }
        let _ = tokio::fs::write(&path, g.to_string()).await;
        self.zone_cache.write().insert(id, Some(g.clone()));
        Some(g)
    }

    /// Build a MultiPolygon from an alert's affected zones.
    async fn zones_geometry(&self, zones: &[String]) -> Option<Value> {
        let mut polys: Vec<Value> = vec![];
        let mut results = vec![];
        // simple sequential-with-concurrency approach
        let mut it = zones.iter().take(400);
        loop {
            let batch: Vec<&String> = it.by_ref().take(8).collect();
            if batch.is_empty() {
                break;
            }
            let rs = futures::future::join_all(batch.iter().map(|z| self.zone(z))).await;
            results.extend(rs);
        }
        for g in results.into_iter().flatten() {
            match g["type"].as_str() {
                Some("Polygon") => polys.push(g["coordinates"].clone()),
                Some("MultiPolygon") => {
                    if let Some(a) = g["coordinates"].as_array() {
                        polys.extend(a.iter().cloned());
                    }
                }
                _ => {}
            }
        }
        if polys.is_empty() {
            None
        } else {
            Some(json!({"type": "MultiPolygon", "coordinates": polys}))
        }
    }

    async fn poll(&self) -> Result<()> {
        let r = self.http.get(&self.url).header("Accept", "application/geo+json").send().await?;
        if !r.status().is_success() {
            bail!("HTTP {}", r.status());
        }
        let v: Value = r.json().await?;
        let feats = v["features"].as_array().cloned().unwrap_or_default();
        let mut next: HashMap<String, Value> = HashMap::new();
        let mut added = vec![];
        let mut updated = vec![];
        for f in feats {
            let p = &f["properties"];
            let Some(id) = p["id"].as_str().map(|s| s.to_string()) else { continue };
            let prev = self.current.read().get(&id).cloned();
            let sent = p["sent"].as_str().unwrap_or("").to_string();
            if let Some(prev) = &prev {
                if prev["properties"]["sent"].as_str() == Some(&sent) {
                    next.insert(id, prev.clone());
                    continue;
                }
            }
            let mut geom = f["geometry"].clone();
            let from_zones = geom.is_null();
            if from_zones {
                let zones: Vec<String> = p["affectedZones"].as_array().map(|a| a.iter().filter_map(|z| z.as_str().map(String::from)).collect()).unwrap_or_default();
                geom = self.zones_geometry(&zones).await.unwrap_or(Value::Null);
            } else {
                geom = simplify_geom(&geom, 0.0005);
            }
            let props = json!({
                "id": id,
                "event": p["event"],
                "severity": p["severity"],
                "urgency": p["urgency"],
                "certainty": p["certainty"],
                "headline": p["headline"],
                "description": p["description"],
                "instruction": p["instruction"],
                "areaDesc": p["areaDesc"],
                "sent": p["sent"],
                "effective": p["effective"],
                "onset": p["onset"],
                "expires": p["expires"],
                "ends": p["ends"],
                "senderName": p["senderName"],
                "messageType": p["messageType"],
                "vtec": p["parameters"]["VTEC"][0],
                "nws_headline": p["parameters"]["NWSheadline"][0],
                "from_zones": from_zones,
                "flags": flags(p),
            });
            let feat = json!({"type": "Feature", "id": id, "geometry": geom, "properties": props});
            if prev.is_some() {
                updated.push(feat.clone());
            } else {
                added.push(feat.clone());
            }
            next.insert(id, feat);
        }
        let removed: Vec<String> = self.current.read().keys().filter(|k| !next.contains_key(*k)).cloned().collect();
        let total = next.len();
        *self.current.write() = next;
        if !added.is_empty() || !updated.is_empty() || !removed.is_empty() {
            self.hub.send(json!({"type": "alerts", "added": added, "updated": updated, "removed": removed}));
        }
        self.health.ok("nws-alerts", NAME, format!("{total} active"));
        Ok(())
    }

    pub fn collection(&self) -> Value {
        let feats: Vec<Value> = self.current.read().values().cloned().collect();
        json!({"type": "FeatureCollection", "features": feats})
    }

    /// Load a saved GeoJSON alert set (demo / offline testing).
    pub fn load_fixture(&self, path: &std::path::Path) -> Result<()> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        let mut m = self.current.write();
        for f in v["features"].as_array().cloned().unwrap_or_default() {
            if let Some(id) = f["properties"]["id"].as_str() {
                m.insert(id.to_string(), f);
            }
        }
        Ok(())
    }
}
