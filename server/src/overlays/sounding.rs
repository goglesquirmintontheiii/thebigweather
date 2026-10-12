//! Vertical soundings: observed radiosondes (IEM RAOB archive) and model profiles
//! (Open-Meteo pressure-level forecasts).
//!
//! Both come back as one shape: `levels` of {p hPa, z m MSL, t °C, td °C, wd deg, ws kt},
//! highest pressure (surface) first.

use super::{fc, km, point, Overlays, Params};
use anyhow::{anyhow, bail, Result};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(600);
const STATIONS_URL: &str = "https://mesonet.agron.iastate.edu/geojson/network/RAOB.geojson";
const RAOB_URL: &str = "https://mesonet.agron.iastate.edu/json/raob.py";
const OPEN_METEO: &str = "https://api.open-meteo.com/v1/forecast";

/// Pressure levels requested from Open-Meteo (hPa).
pub const MODEL_LEVELS: &[u32] = &[1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];

/// Upstream responses (parsed) for 10 minutes.
static CACHE: Lazy<Mutex<HashMap<String, (Instant, Value)>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_get(k: &str) -> Option<Value> {
    let c = CACHE.lock();
    c.get(k).filter(|(t, _)| t.elapsed() < TTL).map(|(_, v)| v.clone())
}

fn cache_put(k: String, v: Value) {
    let mut c = CACHE.lock();
    if c.len() > 300 {
        c.retain(|_, (t, _)| t.elapsed() < TTL);
    }
    c.insert(k, (Instant::now(), v));
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Level {
    pub p: f64,
    pub z: Option<f64>,
    pub t: Option<f64>,
    pub td: Option<f64>,
    pub wd: Option<f64>,
    pub ws: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Station {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

impl Station {
    /// Ids to ask IEM for: combined "_XXX" entries list their member stations after "--"
    /// (newest last); try those first, then the id itself.
    pub fn query_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = vec![];
        if self.id.starts_with('_') {
            if let Some((_, members)) = self.name.split_once("--") {
                v.extend(members.split_whitespace().rev().filter(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_alphanumeric())).map(String::from));
            }
        }
        v.push(self.id.clone());
        v
    }
}

fn r1(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite()).map(|x| (x * 10.0).round() / 10.0)
}

/// Active RAOB stations from the IEM network GeoJSON.
pub fn parse_stations(v: &Value) -> Vec<Station> {
    v["features"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    let p = &f["properties"];
                    if p["online"].as_bool() == Some(false) || !p["archive_end"].is_null() {
                        return None;
                    }
                    let c = f["geometry"]["coordinates"].as_array()?;
                    let id = p["sid"].as_str().or_else(|| f["id"].as_str())?.to_string();
                    Some(Station { id, name: p["sname"].as_str().unwrap_or("").to_string(), lon: c.first()?.as_f64()?, lat: c.get(1)?.as_f64()? })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn stations(o: &Overlays) -> Result<Vec<Station>> {
    let b = o.disk_cached("raob_stations.geojson", Duration::from_secs(86400 * 7), STATIONS_URL).await?;
    let v: Value = serde_json::from_slice(&b)?;
    let s = parse_stations(&v);
    if s.is_empty() {
        bail!("no RAOB stations in the IEM network list");
    }
    Ok(s)
}

/// RAOB stations as GeoJSON points (id, name).
pub async fn stations_geojson(o: &Overlays) -> Result<Value> {
    let s = stations(o).await?;
    Ok(fc(s.iter().map(|s| point(s.lon, s.lat, json!({"id": s.id, "name": s.name}))).collect()))
}

/// Sort by decreasing pressure, merge duplicate pressures, drop levels with nothing useful.
pub fn tidy(mut levels: Vec<Level>) -> Vec<Level> {
    levels.retain(|l| l.p.is_finite() && l.p > 0.0 && (l.t.is_some() || l.ws.is_some()));
    levels.sort_by(|a, b| b.p.partial_cmp(&a.p).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Level> = vec![];
    for l in levels {
        match out.last_mut() {
            Some(prev) if (prev.p - l.p).abs() < 0.05 => {
                prev.z = prev.z.or(l.z);
                prev.t = prev.t.or(l.t);
                prev.td = prev.td.or(l.td);
                prev.wd = prev.wd.or(l.wd);
                prev.ws = prev.ws.or(l.ws);
            }
            _ => out.push(l),
        }
    }
    out
}

/// IEM `json/raob.py` → (station, valid ms, levels).
/// Shape: {"profiles": [{"station", "valid": ISO, "profile": [{pres, hght, tmpc, dwpc, drct, sknt}]}]}
pub fn parse_raob(v: &Value) -> Option<(String, i64, Vec<Level>)> {
    let p = v["profiles"].as_array()?.iter().find(|p| p["profile"].as_array().map(|a| !a.is_empty()).unwrap_or(false))?;
    let valid = p["valid"].as_str().unwrap_or("");
    let t = chrono::DateTime::parse_from_rfc3339(valid)
        .map(|d| d.timestamp_millis())
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(valid.trim_end_matches('Z'), "%Y-%m-%dT%H:%M:%S").map(|d| d.and_utc().timestamp_millis()))
        .ok()?;
    let f = |r: &Value, k: &[&str]| k.iter().find_map(|k| r[*k].as_f64());
    let levels = p["profile"]
        .as_array()?
        .iter()
        .filter_map(|r| {
            Some(Level {
                p: f(r, &["pres", "pressure_mb"])?,
                z: r1(f(r, &["hght", "height_m"])),
                t: r1(f(r, &["tmpc"])),
                td: r1(f(r, &["dwpc"])),
                wd: r1(f(r, &["drct"])),
                ws: r1(f(r, &["sknt", "speed_kts"])),
            })
        })
        .collect();
    Some((p["station"].as_str().unwrap_or("").to_string(), t, tidy(levels)))
}

/// Map our model ids to Open-Meteo `models=` values (others pass through if well-formed).
pub fn open_meteo_model(m: &str) -> Option<&str> {
    Some(match m {
        "" | "best" | "auto" => "best_match",
        "hrrr" => "gfs_hrrr",
        "gfs" => "gfs_seamless",
        "ecmwf" => "ecmwf_ifs025",
        "icon" | "iconeu" => "icon_seamless",
        "gem" | "gdps" | "hrdps" => "gem_seamless",
        "nam" | "nam3" | "nam12" => "ncep_nam_conus",
        x if x.len() <= 40 && x.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') => x,
        _ => return None,
    })
}

pub fn open_meteo_url(lat: f64, lon: f64, om_model: &str) -> String {
    let mut vars: Vec<String> = ["temperature_2m", "dew_point_2m", "surface_pressure", "wind_speed_10m", "wind_direction_10m"].iter().map(|s| s.to_string()).collect();
    for l in MODEL_LEVELS {
        for v in ["temperature", "dew_point", "wind_speed", "wind_direction", "geopotential_height"] {
            vars.push(format!("{v}_{l}hPa"));
        }
    }
    let hours = if om_model.contains("hrrr") { 48 } else { 120 };
    format!(
        "{OPEN_METEO}?latitude={lat:.3}&longitude={lon:.3}&hourly={}&models={om_model}&wind_speed_unit=kn&timeformat=unixtime&past_hours=6&forecast_hours={hours}",
        vars.join(",")
    )
}

/// Index of the hour nearest `t` (ms) in Open-Meteo's `hourly.time` (unix seconds).
fn nearest_hour(times: &[i64], t: i64) -> Option<usize> {
    times.iter().enumerate().min_by_key(|(_, x)| (**x * 1000 - t).abs()).map(|(i, _)| i)
}

/// One model profile from an Open-Meteo hourly response. Levels below ground are dropped.
pub fn model_profile(v: &Value, t: i64) -> Result<(i64, Vec<i64>, Vec<Level>)> {
    let h = &v["hourly"];
    let times: Vec<i64> = h["time"].as_array().ok_or_else(|| anyhow!("no hourly data"))?.iter().filter_map(|x| x.as_i64()).collect();
    let i = nearest_hour(&times, t).ok_or_else(|| anyhow!("no forecast hours"))?;
    let at = |k: &str| h[k].as_array().and_then(|a| a.get(i)).and_then(|x| x.as_f64());
    let psfc = at("surface_pressure");
    let mut levels = vec![];
    if let Some(ps) = psfc {
        levels.push(Level { p: ps, z: r1(v["elevation"].as_f64()), t: r1(at("temperature_2m")), td: r1(at("dew_point_2m")), wd: r1(at("wind_direction_10m")), ws: r1(at("wind_speed_10m")) });
    }
    for &l in MODEL_LEVELS {
        let p = l as f64;
        if psfc.map(|ps| p >= ps).unwrap_or(false) {
            continue;
        }
        levels.push(Level {
            p,
            z: r1(at(&format!("geopotential_height_{l}hPa"))),
            t: r1(at(&format!("temperature_{l}hPa"))),
            td: r1(at(&format!("dew_point_{l}hPa"))),
            wd: r1(at(&format!("wind_direction_{l}hPa"))),
            ws: r1(at(&format!("wind_speed_{l}hPa"))),
        });
    }
    let levels = tidy(levels);
    if levels.len() < 3 {
        bail!("this model has no upper-air data here");
    }
    Ok((times[i] * 1000, times.iter().map(|x| x * 1000).collect(), levels))
}

fn parse_time(q: &Params) -> Option<i64> {
    if let Some(h) = q.get("hour").filter(|s| !s.is_empty()) {
        let h = h.trim_end_matches('Z');
        for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H"] {
            if let Ok(d) = chrono::NaiveDateTime::parse_from_str(h, f) {
                return Some(d.and_utc().timestamp_millis());
            }
        }
        if let Ok(d) = chrono::DateTime::parse_from_rfc3339(q.get("hour").map(|s| s.as_str()).unwrap_or("")) {
            return Some(d.timestamp_millis());
        }
    }
    q.get("time").and_then(|s| s.parse::<i64>().ok())
}

/// `/api/sounding`: src=raob|model, lat, lon, station, time (ms), hour (ISO), model.
pub async fn sounding(o: &Overlays, q: &Params) -> Result<Value> {
    let p = |k: &str| q.get(k).map(|s| s.trim()).unwrap_or("");
    let lat = p("lat").parse::<f64>().ok().filter(|v| (-90.0..=90.0).contains(v));
    let lon = p("lon").parse::<f64>().ok().filter(|v| (-180.0..=360.0).contains(v));
    let t = parse_time(q).unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let src = match p("src") {
        "" => if p("station").is_empty() { "model" } else { "raob" },
        s => s,
    };
    let res = match src {
        "raob" => raob(o, p("station"), lat, lon, t).await,
        "model" => {
            let (Some(lat), Some(lon)) = (lat, lon) else { bail!("lat and lon required") };
            model(o, lat, lon, p("model"), t).await
        }
        _ => bail!("src must be raob or model"),
    };
    match &res {
        Ok(_) => o.health.ok(&format!("sounding-{src}"), if src == "raob" { "Soundings (IEM RAOB)" } else { "Model soundings (Open-Meteo)" }, ""),
        Err(e) => o.health.err(&format!("sounding-{src}"), if src == "raob" { "Soundings (IEM RAOB)" } else { "Model soundings (Open-Meteo)" }, e),
    }
    res
}

async fn raob(o: &Overlays, station: &str, lat: Option<f64>, lon: Option<f64>, t: i64) -> Result<Value> {
    let station = station.to_ascii_uppercase();
    if station.len() > 5 || !station.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        bail!("bad station id");
    }
    let list = stations(o).await.unwrap_or_default();
    let st = if !station.is_empty() {
        list.iter()
            .find(|s| s.id == station || (station.len() == 3 && s.id.ends_with(&station)) || s.query_ids().contains(&station))
            .cloned()
            .unwrap_or(Station { id: station.clone(), name: String::new(), lat: lat.unwrap_or(f64::NAN), lon: lon.unwrap_or(f64::NAN) })
    } else {
        let (Some(la), Some(lo)) = (lat, lon) else { bail!("station or lat/lon required") };
        list.iter()
            .min_by(|a, b| km(la, lo, a.lat, a.lon).partial_cmp(&km(la, lo, b.lat, b.lon)).unwrap_or(std::cmp::Ordering::Equal))
            .cloned()
            .ok_or_else(|| anyhow!("RAOB station list unavailable"))?
    };
    // newest 00/12Z at or before t (launches go up ~1 h early), up to 2 days back
    let h12 = 12 * 3_600_000i64;
    let first = (t + 3_600_000).min(chrono::Utc::now().timestamp_millis() + 3_600_000);
    let first = first - first.rem_euclid(h12);
    let ids = st.query_ids();
    for k in 0..4 {
        let cyc = first - k * h12;
        let Some(d) = chrono::DateTime::from_timestamp_millis(cyc) else { continue };
        let ts = d.format("%Y%m%d%H%M").to_string();
        for id in &ids {
            let ck = format!("raob|{id}|{ts}");
            let v = match cache_get(&ck) {
                Some(v) => v,
                None => {
                    let url = format!("{RAOB_URL}?ts={ts}&station={id}");
                    let v = match o.get_json(&url).await {
                        Ok(v) => v,
                        Err(e) if k == 0 => {
                            tracing::debug!("raob {id} {ts}: {e:#}");
                            continue;
                        }
                        Err(e) => return Err(e),
                    };
                    cache_put(ck, v.clone());
                    v
                }
            };
            if let Some((_, vt, levels)) = parse_raob(&v) {
                if levels.len() >= 5 {
                    return Ok(json!({
                        "src": "raob", "station": st.id, "name": st.name,
                        "lat": if st.lat.is_finite() { json!(st.lat) } else { Value::Null },
                        "lon": if st.lon.is_finite() { json!(st.lon) } else { Value::Null },
                        "time": vt, "levels": levels,
                    }));
                }
            }
        }
    }
    bail!("no sounding found for {} in the last 2 days", st.id)
}

async fn model(o: &Overlays, lat: f64, lon: f64, model: &str, t: i64) -> Result<Value> {
    let om = open_meteo_model(model).ok_or_else(|| anyhow!("bad model"))?;
    let lon = if lon > 180.0 { lon - 360.0 } else { lon };
    let ck = format!("om|{om}|{lat:.2}|{lon:.2}");
    let v = match cache_get(&ck) {
        Some(v) => v,
        None => {
            let v = o.get_json(&open_meteo_url(lat, lon, om)).await?;
            if let Some(r) = v["reason"].as_str() {
                bail!("Open-Meteo: {r}");
            }
            cache_put(ck, v.clone());
            v
        }
    };
    let (time, hours, levels) = model_profile(&v, t)?;
    Ok(json!({
        "src": "model", "model": if model.is_empty() { om } else { model }, "om_model": om,
        "lat": v["latitude"].as_f64().unwrap_or(lat), "lon": v["longitude"].as_f64().unwrap_or(lon),
        "elevation": v["elevation"], "time": time, "hours": hours, "levels": levels,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raob_json() {
        let v = json!({"profiles": [{"station": "KOAX", "valid": "2026-10-11T12:00:00Z", "profile": [
            {"pres": 850.0, "hght": 1480.0, "tmpc": 12.4, "dwpc": 3.1, "drct": 200.0, "sknt": 25.0},
            {"pres": 968.0, "hght": 350.0, "tmpc": 15.2, "dwpc": 9.0, "drct": 180.0, "sknt": 10.0},
            {"pres": 925.0, "hght": 760.0, "tmpc": null, "dwpc": null, "drct": 190.0, "sknt": 20.0},
            {"pres": 925.0, "hght": 761.0, "tmpc": 14.0, "dwpc": 8.0, "drct": null, "sknt": null},
            {"pres": 500.0, "hght": null, "tmpc": null, "dwpc": null, "drct": null, "sknt": null}
        ]}]});
        let (st, t, l) = parse_raob(&v).unwrap();
        assert_eq!(st, "KOAX");
        assert_eq!(t, 1_791_720_000_000);
        assert_eq!(l.iter().map(|x| x.p).collect::<Vec<_>>(), vec![968.0, 925.0, 850.0]);
        assert_eq!(l[1].t, Some(14.0));
        assert_eq!(l[1].ws, Some(20.0));
        assert_eq!(l[0].z, Some(350.0));
        assert!(parse_raob(&json!({"profiles": []})).is_none());
    }

    #[test]
    fn stations_and_members() {
        let v = json!({"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": "_ABR", "properties": {"sid": "_ABR", "sname": "Aberdeen Area -- KHON KABR", "online": true, "archive_end": null}, "geometry": {"type": "Point", "coordinates": [-98.4, 44.9]}},
            {"type": "Feature", "id": "CWIQ", "properties": {"sid": "CWIQ", "sname": "Primrose Lake", "online": false, "archive_end": "2012-07-04"}, "geometry": {"type": "Point", "coordinates": [-110.0, 54.75]}},
            {"type": "Feature", "id": "KOAX", "properties": {"sid": "KOAX", "sname": "Omaha", "online": true, "archive_end": null}, "geometry": {"type": "Point", "coordinates": [-96.37, 41.32]}}
        ]});
        let s = parse_stations(&v);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].query_ids(), vec!["KABR", "KHON", "_ABR"]);
        assert_eq!(s[1].query_ids(), vec!["KOAX"]);
    }

    #[test]
    fn open_meteo_profile() {
        let mut hourly = serde_json::Map::new();
        hourly.insert("time".into(), json!([1791806400, 1791810000]));
        hourly.insert("surface_pressure".into(), json!([960.0, 958.0]));
        hourly.insert("temperature_2m".into(), json!([15.0, 16.0]));
        hourly.insert("dew_point_2m".into(), json!([10.0, 10.5]));
        hourly.insert("wind_speed_10m".into(), json!([8.0, 9.0]));
        hourly.insert("wind_direction_10m".into(), json!([170.0, 175.0]));
        for l in MODEL_LEVELS {
            let t = 15.0 - (1000.0 - *l as f64) * 0.07;
            hourly.insert(format!("temperature_{l}hPa"), json!([t, t + 1.0]));
            hourly.insert(format!("dew_point_{l}hPa"), json!([t - 5.0, t - 4.0]));
            hourly.insert(format!("wind_speed_{l}hPa"), json!([20.0, 21.0]));
            hourly.insert(format!("wind_direction_{l}hPa"), json!([250.0, 255.0]));
            hourly.insert(format!("geopotential_height_{l}hPa"), json!([null, 100.0]));
        }
        let v = json!({"latitude": 41.3, "longitude": -96.4, "elevation": 350.0, "hourly": Value::Object(hourly)});
        let (t, hours, l) = model_profile(&v, 1_791_810_000_000 + 600_000).unwrap();
        assert_eq!(t, 1_791_810_000_000);
        assert_eq!(hours.len(), 2);
        // surface 958 hPa first; 1000/975 are below ground
        assert_eq!(l[0].p, 958.0);
        assert_eq!(l[0].z, Some(350.0));
        assert_eq!(l[1].p, 950.0);
        assert_eq!(l.last().unwrap().p, 100.0);
        assert!(l.windows(2).all(|w| w[0].p > w[1].p));
        assert_eq!(open_meteo_model("hrrr"), Some("gfs_hrrr"));
        assert_eq!(open_meteo_model("x&y"), None);
        assert!(open_meteo_url(41.0, -96.0, "gfs_hrrr").contains("forecast_hours=48"));
        let mut q = Params::new();
        q.insert("hour".into(), "2026-10-12T13:00".into());
        assert_eq!(parse_time(&q), Some(1_791_810_000_000));
    }
}
