//! Observations: METARs, buoys, tides, river gauges, earthquakes, wildfires, aurora, GLM lightning.

use super::{fc, num, point, round, Overlays};
use anyhow::{anyhow, Result};
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn f32j(v: f32, scale: f32) -> Value {
    if v.is_finite() {
        json!(((v * scale) * 10.0).round() / 10.0)
    } else {
        Value::Null
    }
}

/// Every station in the latest METAR snapshot (the same feed the surface analysis uses), or
/// with `time` (unix ms) each station's latest report in the hour before that time
/// (live snapshots when close enough, else the IEM archive).
pub async fn metars(o: &Overlays, time: &str) -> Result<Value> {
    let (snap, archived, obs) = if time.is_empty() {
        let obs = o.grids.latest_metars().ok_or_else(|| anyhow!("METARs not loaded yet"))?;
        (obs.iter().map(|m| m.time).max().unwrap_or(0), false, obs)
    } else {
        let t: i64 = time.trim().parse().map_err(|_| anyhow!("bad time (unix ms required)"))?;
        o.grids.metars_at(t).await?
    };
    let feats = obs
        .iter()
        .map(|m| {
            point(
                m.lon as f64,
                m.lat as f64,
                json!({
                    "id": m.id, "t": f32j(m.temp, 1.0), "td": f32j(m.dew, 1.0),
                    "wd": f32j(m.wdir, 1.0), "ws": f32j(m.wspd, 1.943844), "wg": f32j(m.gust, 1.943844),
                    "vis": f32j(m.vis, 1.0), "alt": f32j(m.alt, 1.0), "cat": m.cat, "time": m.time, "raw": m.raw,
                }),
            )
        })
        .collect();
    let mut v = fc(feats);
    v["time"] = json!(snap);
    v["source"] = json!(if archived { "archive" } else { "live" });
    Ok(v)
}

// ---------- cache stats (admin API) ----------

impl Overlays {
    /// Overlay response cache (time-limited, no byte cap).
    pub fn cache_stats(&self) -> crate::caches::CacheInfo {
        let c = self.cache.lock();
        let b: usize = c.iter().map(|(k, (_, v))| k.len() + v.len()).sum();
        crate::caches::CacheInfo::mem("overlays", "Overlay responses", b, c.len(), 0)
    }
    pub fn clear_cache(&self) {
        self.cache.lock().clear();
    }
}

// ---------- NDBC ----------

pub async fn buoys(o: &Overlays) -> Result<Value> {
    let (txt, cams) = tokio::join!(o.get_text("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"), o.get_json("https://www.ndbc.noaa.gov/buoycams.php"));
    let txt = txt?;
    let cam_ids: HashSet<String> = cams.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter(|c| !c["img"].is_null()).filter_map(|c| c["id"].as_str().map(|s| s.to_string())).collect();
    let mut feats = vec![];
    for line in txt.lines() {
        if line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 22 {
            continue;
        }
        let (Some(lat), Some(lon)) = (num(f[1]), num(f[2])) else { continue };
        let time = format!("{}-{}-{}T{}:{}:00Z", f[3], f[4], f[5], f[6], f[7]);
        let v = |i: usize| num(f[i]).map(|x| json!(x)).unwrap_or(Value::Null);
        feats.push(point(
            lon,
            lat,
            json!({
                "id": f[0], "time": time, "wd": v(8), "ws": v(9), "wg": v(10), "wvht": v(11), "dpd": v(12),
                "mwd": v(14), "pres": v(15), "atmp": v(17), "wtmp": v(18), "dewp": v(19), "vis": v(20), "tide": v(21),
                "cam": cam_ids.contains(f[0]),
            }),
        ));
    }
    Ok(fc(feats))
}

// ---------- tides ----------

pub async fn tide_stations(o: &Overlays) -> Result<Value> {
    let b = o.disk_cached("tide_stations.json", Duration::from_secs(86400 * 7), "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions").await?;
    let v: Value = serde_json::from_slice(&b)?;
    let feats = v["stations"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|s| {
            let lat = s["lat"].as_f64()?;
            let lon = s["lng"].as_f64()?;
            Some(point(lon, lat, json!({"id": s["id"], "name": s["name"], "state": s["state"], "ref": s["type"].as_str() == Some("R")})))
        })
        .collect();
    Ok(fc(feats))
}

/// Next 48 hours of high/low tides for one station (JSON, not GeoJSON).
pub async fn tide_predictions(o: &Overlays, station: &str) -> Result<Value> {
    if station.is_empty() || !station.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(anyhow!("bad station"));
    }
    let begin = chrono::Utc::now().format("%Y%m%d %H:%M").to_string().replace(' ', "%20");
    let url = format!(
        "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=thebigweather&begin_date={begin}&range=48&datum=MLLW&station={station}&time_zone=gmt&units=metric&interval=hilo&format=json"
    );
    let v = o.get_json(&url).await?;
    if let Some(e) = v.get("error") {
        return Err(anyhow!("{}", e["message"].as_str().unwrap_or("tide error")));
    }
    let preds: Vec<Value> = v["predictions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|p| {
            let t = chrono::NaiveDateTime::parse_from_str(p["t"].as_str().unwrap_or(""), "%Y-%m-%d %H:%M").map(|d| d.and_utc().timestamp_millis()).unwrap_or(0);
            json!({"t": t, "v": p["v"].as_str().and_then(|s| s.parse::<f64>().ok()), "type": p["type"]})
        })
        .collect();
    Ok(json!({"station": station, "predictions": preds}))
}

// ---------- river gauges ----------

pub async fn gauges(o: &Overlays) -> Result<Value> {
    let v = o.get_json("https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-180&bbox.ymin=10&bbox.xmax=-60&bbox.ymax=72&srid=EPSG_4326").await?;
    let feats = v["gauges"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|g| {
            let lat = g["latitude"].as_f64()?;
            let lon = g["longitude"].as_f64()?;
            let ob = &g["status"]["observed"];
            let fc_ = &g["status"]["forecast"];
            let val = |x: &Value| x.as_f64().filter(|v| *v > -998.0);
            Some(point(
                lon,
                lat,
                json!({
                    "id": g["lid"], "name": g["name"],
                    "cat": ob["floodCategory"], "fcat": fc_["floodCategory"],
                    "stage": val(&ob["primary"]), "unit": ob["primaryUnit"], "flow": val(&ob["secondary"]), "funit": ob["secondaryUnit"],
                    "time": ob["validTime"], "wfo": g["wfo"]["abbreviation"],
                }),
            ))
        })
        .collect();
    Ok(fc(feats))
}

// ---------- earthquakes ----------

pub async fn quakes(o: &Overlays, period: &str, mag: &str) -> Result<Value> {
    let period = match period {
        "hour" | "week" | "month" => period,
        _ => "day",
    };
    let mag = match mag {
        "all" | "1.0" | "4.5" | "significant" => mag,
        _ => "2.5",
    };
    let v = o.get_json(&format!("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{mag}_{period}.geojson")).await?;
    let feats = v["features"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut f| {
            let p = f["properties"].take();
            let depth = f["geometry"]["coordinates"][2].clone();
            f["properties"] = json!({"mag": p["mag"], "place": p["place"], "time": p["time"], "url": p["url"], "tsunami": p["tsunami"], "alert": p["alert"], "depth": depth});
            f
        })
        .collect();
    Ok(fc(feats))
}

// ---------- wildfires ----------

pub async fn fires(o: &Overlays) -> Result<Value> {
    let perim = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&outFields=poly_IncidentName,poly_GISAcres,attr_PercentContained,attr_FireDiscoveryDateTime,attr_IncidentTypeCategory&geometryPrecision=4&maxAllowableOffset=0.002&outSR=4326&f=geojson";
    let firms = [
        "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
        "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
    ];
    let (p, a, b) = tokio::join!(o.get_json(perim), o.get_text(firms[0]), o.get_text(firms[1]));
    let mut feats = vec![];
    if let Ok(v) = &p {
        for mut f in v["features"].as_array().cloned().unwrap_or_default() {
            let pr = f["properties"].take();
            f["properties"] = json!({"_kind": "perimeter", "name": pr["poly_IncidentName"], "acres": pr["poly_GISAcres"], "contained": pr["attr_PercentContained"], "start": pr["attr_FireDiscoveryDateTime"], "type": pr["attr_IncidentTypeCategory"]});
            feats.push(f);
        }
    }
    for (src, r) in [("VIIRS S-NPP", &a), ("VIIRS NOAA-20", &b)] {
        let Ok(text) = r else { continue };
        let mut rd = csv::ReaderBuilder::new().from_reader(text.as_bytes());
        let hdr = rd.headers().cloned().unwrap_or_default();
        let col = |n: &str| hdr.iter().position(|h| h == n);
        let (Some(ila), Some(ilo)) = (col("latitude"), col("longitude")) else { continue };
        let (ifrp, idate, itime, iconf) = (col("frp"), col("acq_date"), col("acq_time"), col("confidence"));
        for rec in rd.records().flatten() {
            let (Some(lat), Some(lon)) = (rec.get(ila).and_then(num), rec.get(ilo).and_then(num)) else { continue };
            let g = |i: Option<usize>| i.and_then(|i| rec.get(i)).unwrap_or("").to_string();
            feats.push(point(lon, lat, json!({"_kind": "hotspot", "src": src, "frp": ifrp.and_then(|i| rec.get(i)).and_then(num), "date": g(idate), "time": g(itime), "conf": g(iconf)})));
        }
    }
    if feats.is_empty() {
        if let Err(e) = p {
            return Err(e);
        }
    }
    Ok(fc(feats))
}

// ---------- aurora ----------

pub async fn aurora(o: &Overlays) -> Result<Value> {
    let v = o.get_json("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json").await?;
    let time = v["Forecast Time"].clone();
    let feats = v["coordinates"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            let lon = c[0].as_f64()?;
            let lat = c[1].as_f64()?;
            let a = c[2].as_f64()?;
            if a < 4.0 {
                return None;
            }
            let lon = if lon > 180.0 { lon - 360.0 } else { lon };
            Some(point(lon, lat, json!({"p": a})))
        })
        .collect();
    let mut out = fc(feats);
    out["time"] = time;
    Ok(out)
}

// ---------- GOES GLM lightning ----------

#[derive(Default)]
pub struct Glm {
    running: AtomicBool,
    /// (file start ms, flashes [lon, lat, energy fJ])
    files: RwLock<VecDeque<(i64, String, Vec<[f32; 3]>)>>,
}

impl Glm {
    /// Start the poller if needed; it stops by itself 15 minutes after the last request.
    pub fn ensure(o: &Arc<Overlays>) {
        if o.glm.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let o = o.clone();
        tokio::spawn(async move {
            loop {
                if o.idle("glm", 900) {
                    break;
                }
                if let Err(e) = Self::poll(&o).await {
                    o.health.err("ovl-glm", "GOES GLM lightning", &e);
                } else {
                    o.health.ok("ovl-glm", "GOES GLM lightning", "");
                }
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
            o.glm.files.write().clear();
            o.glm.running.store(false, Ordering::SeqCst);
        });
    }

    async fn poll(o: &Arc<Overlays>) -> Result<()> {
        let now = chrono::Utc::now();
        let keep_ms = 31 * 60_000;
        for sat in [19u32, 18] {
            let bucket = format!("noaa-goes{sat}");
            let mut keys = vec![];
            for back in [1i64, 0] {
                let t = now - chrono::Duration::hours(back);
                use chrono::{Datelike, Timelike};
                let prefix = format!("GLM-L2-LCFA/{:04}/{:03}/{:02}/", t.year(), t.ordinal(), t.hour());
                if let Ok(l) = crate::s3::list(&o.http, &bucket, &prefix, None, None, 2).await {
                    keys.extend(l.objects.into_iter().map(|x| x.key));
                }
            }
            let have: HashSet<String> = o.glm.files.read().iter().map(|f| f.1.clone()).collect();
            let cutoff = now.timestamp_millis() - keep_ms;
            let new: Vec<String> = keys
                .into_iter()
                .filter(|k| !have.contains(k))
                .filter(|k| crate::grid::goes::time_from_name(k).map(|t| t > cutoff).unwrap_or(false))
                .collect();
            for k in new.into_iter().rev().take(100) {
                let url = crate::s3::object_url(&bucket, &k);
                let Ok(b) = o.get_bytes(&url).await else { continue };
                let t = crate::grid::goes::time_from_name(&k).unwrap_or(0);
                let flashes = tokio::task::spawn_blocking(move || read_glm(&b)).await??;
                o.glm.files.write().push_back((t, k, flashes));
            }
        }
        let cutoff = chrono::Utc::now().timestamp_millis() - keep_ms;
        o.glm.files.write().retain(|f| f.0 > cutoff);
        Ok(())
    }

    pub fn geojson(&self, minutes: i64) -> Value {
        let now = chrono::Utc::now().timestamp_millis();
        let cutoff = now - minutes.clamp(1, 30) * 60_000;
        let files = self.files.read();
        let mut feats = vec![];
        for (t, _, fl) in files.iter().filter(|f| f.0 >= cutoff) {
            let age = ((now - t) / 1000).max(0);
            for f in fl {
                feats.push(json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(f[0] as f64), round(f[1] as f64)]}, "properties": {"age": age, "e": f[2]}}));
            }
        }
        let mut out = fc(feats);
        out["loading"] = json!(files.is_empty());
        out
    }
}

fn read_glm(b: &[u8]) -> Result<Vec<[f32; 3]>> {
    let f = netcdf_reader::NcFile::from_bytes(b).map_err(|e| anyhow!("glm netcdf: {e}"))?;
    let lat: Vec<f32> = f.read_variable::<f32>("flash_lat").map_err(|e| anyhow!("flash_lat: {e}"))?.into_raw_vec_and_offset().0;
    let lon: Vec<f32> = f.read_variable::<f32>("flash_lon").map_err(|e| anyhow!("flash_lon: {e}"))?.into_raw_vec_and_offset().0;
    // energy is packed u16 × scale (J); report femtojoules
    let energy: Vec<f32> = match (f.read_variable::<i16>("flash_energy"), f.variable("flash_energy")) {
        (Ok(raw), Ok(v)) => {
            let s = v.attribute("scale_factor").and_then(|a| a.value.as_f64()).unwrap_or(1.526e-15);
            let off = v.attribute("add_offset").and_then(|a| a.value.as_f64()).unwrap_or(0.0);
            raw.into_raw_vec_and_offset().0.iter().map(|&r| (((r as u16) as f64 * s + off) * 1e15) as f32).collect()
        }
        _ => vec![0.0; lat.len()],
    };
    Ok(lat.iter().zip(&lon).enumerate().filter(|(_, (a, b))| a.is_finite() && b.is_finite()).map(|(i, (a, b))| [*b, *a, energy.get(i).copied().unwrap_or(0.0)]).collect())
}
