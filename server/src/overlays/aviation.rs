//! Aviation: TAFs, PIREPs, SIGMETs/AIRMETs, G-AIRMETs, airports, ADS-B flights, recon flights.

use super::{fc, num, point, Overlays};
use anyhow::{anyhow, bail, Result};
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const AWC: &str = "https://aviationweather.gov/api/data";

pub async fn taf(o: &Overlays, ids: &str) -> Result<Value> {
    if ids.is_empty() || ids.len() > 64 || !ids.chars().all(|c| c.is_ascii_alphanumeric() || c == ',') {
        bail!("bad station ids");
    }
    let v = o.get_json(&format!("{AWC}/taf?ids={ids}&format=json")).await?;
    Ok(if v.is_null() { json!([]) } else { v })
}

pub async fn pireps(o: &Overlays) -> Result<Value> {
    let v = o.get_json(&format!("{AWC}/pirep?format=geojson&age=3")).await?;
    Ok(if v.is_null() { fc(vec![]) } else { v })
}

pub async fn sigmets(o: &Overlays) -> Result<Value> {
    let (ua, ub) = (format!("{AWC}/airsigmet?format=geojson"), format!("{AWC}/isigmet?format=geojson"));
    let (a, b) = tokio::join!(o.get_json(&ua), o.get_json(&ub));
    let mut feats = vec![];
    for (kind, r) in [("us", &a), ("intl", &b)] {
        if let Ok(v) = r {
            for mut f in v["features"].as_array().cloned().unwrap_or_default() {
                f["properties"]["_src"] = json!(kind);
                feats.push(f);
            }
        }
    }
    if feats.is_empty() {
        if let Err(e) = a {
            return Err(e);
        }
    }
    Ok(fc(feats))
}

/// G-AIRMETs (type sierra = IFR/mountain obscuration, tango = turbulence/wind, zulu = icing),
/// one forecast hour (0, 3, 6, 9, 12).
pub async fn gairmet(o: &Overlays, kind: &str, fcst: &str) -> Result<Value> {
    let kind = match kind {
        "tango" | "zulu" => kind,
        _ => "sierra",
    };
    let want = fcst.parse::<i64>().unwrap_or(0);
    let v = o.get_json(&format!("{AWC}/gairmet?format=geojson&type={kind}")).await?;
    let feats = v["features"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|f| {
            let p = &f["properties"]["forecast"];
            p.as_i64().or_else(|| p.as_str().and_then(|s| s.parse().ok())).unwrap_or(0) == want
        })
        .collect();
    Ok(fc(feats))
}

/// Airports from OurAirports (large + medium; `all` adds small airports).
pub async fn airports(o: &Overlays, all: bool) -> Result<Value> {
    let b = o.disk_cached("airports.csv", Duration::from_secs(86400 * 14), "https://davidmegginson.github.io/ourairports-data/airports.csv").await?;
    let mut rd = csv::ReaderBuilder::new().from_reader(&b[..]);
    let hdr = rd.headers()?.clone();
    let col = |n: &str| hdr.iter().position(|h| h == n);
    let (it, iname, ila, ilo, iident, iiata, iel, icountry, imuni) =
        (col("type"), col("name"), col("latitude_deg"), col("longitude_deg"), col("ident"), col("iata_code"), col("elevation_ft"), col("iso_country"), col("municipality"));
    let mut feats = vec![];
    for rec in rd.records().flatten() {
        let g = |i: Option<usize>| i.and_then(|i| rec.get(i)).unwrap_or("");
        let t = g(it);
        let keep = matches!(t, "large_airport" | "medium_airport") || (all && t == "small_airport");
        if !keep {
            continue;
        }
        let (Some(lat), Some(lon)) = (num(g(ila)), num(g(ilo))) else { continue };
        feats.push(point(
            lon,
            lat,
            json!({"id": g(iident), "name": g(iname), "iata": g(iiata), "size": if t == "large_airport" { 3 } else if t == "medium_airport" { 2 } else { 1 }, "elev": num(g(iel)), "country": g(icountry), "city": g(imuni)}),
        ));
    }
    Ok(fc(feats))
}

/// Aircraft near a point (ADS-B Exchange-style APIs: airplanes.live, then adsb.lol).
pub async fn flights(o: &Overlays, lat: &str, lon: &str, r: &str) -> Result<Value> {
    let lat: f64 = lat.parse().map_err(|_| anyhow!("lat"))?;
    let lon: f64 = lon.parse().map_err(|_| anyhow!("lon"))?;
    let r = r.parse::<f64>().unwrap_or(150.0).clamp(10.0, 250.0).round();
    // the public APIs allow 1 request per second
    {
        let mut gate = o.flight_gate.lock().await;
        let wait = Duration::from_millis(1100).saturating_sub(gate.elapsed());
        tokio::time::sleep(wait).await;
        *gate = Instant::now();
    }
    let urls = [format!("https://api.airplanes.live/v2/point/{lat:.2}/{lon:.2}/{r}"), format!("https://api.adsb.lol/v2/point/{lat:.2}/{lon:.2}/{r}")];
    let mut last = anyhow!("no ADS-B source");
    for u in &urls {
        match o.get_json(u).await {
            Ok(v) => {
                let feats = v["ac"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|a| {
                        let la = a["lat"].as_f64()?;
                        let lo = a["lon"].as_f64()?;
                        let alt = a["alt_baro"].as_f64().map(|x| json!(x)).unwrap_or_else(|| json!(a["alt_baro"].as_str().unwrap_or("")));
                        Some(point(
                            lo,
                            la,
                            json!({
                                "hex": a["hex"], "cs": a["flight"].as_str().map(|s| s.trim()), "reg": a["r"], "type": a["t"],
                                "alt": alt, "gs": a["gs"], "trk": a["track"].as_f64().or(a["true_heading"].as_f64()).unwrap_or(0.0),
                                "sq": a["squawk"], "cat": a["category"], "emer": a["emergency"],
                            }),
                        ))
                    })
                    .collect();
                let mut out = fc(feats);
                out["src"] = json!(super::host(u));
                return Ok(out);
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

// ---------- recon (Hurricane Hunters) ----------

#[derive(Default)]
pub struct Recon {
    running: AtomicBool,
    /// mission id → (aircraft, storm, observations [time ms, lat, lon, fl wind kt, sfmr kt, pressure])
    missions: RwLock<HashMap<String, Mission>>,
}

#[derive(Clone)]
pub struct Mission {
    aircraft: String,
    storm: String,
    obs: Vec<Hdob>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hdob {
    pub t: i64,
    pub lat: f64,
    pub lon: f64,
    pub wind: Option<f64>,
    pub sfmr: Option<f64>,
    pub extrap: Option<f64>,
}

impl Recon {
    pub fn ensure(o: &Arc<Overlays>) {
        if o.recon.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let o = o.clone();
        tokio::spawn(async move {
            loop {
                if o.idle("recon", 1800) {
                    break;
                }
                for f in ["urnt15.knhc..txt", "urpn15.knhc..txt"] {
                    match o.get_text(&format!("https://tgftp.nws.noaa.gov/data/raw/ur/{f}")).await {
                        Ok(t) => {
                            if let Some((id, ac, storm, obs)) = parse_hdob(&t) {
                                let mut m = o.recon.missions.write();
                                let e = m.entry(id).or_insert(Mission { aircraft: ac, storm, obs: vec![] });
                                for ob in obs {
                                    if !e.obs.iter().any(|x| x.t == ob.t) {
                                        e.obs.push(ob);
                                    }
                                }
                                e.obs.sort_by_key(|x| x.t);
                            }
                        }
                        Err(e) => tracing::debug!("recon {f}: {e:#}"),
                    }
                }
                // forget missions with nothing in 12 hours
                let cutoff = chrono::Utc::now().timestamp_millis() - 12 * 3_600_000;
                o.recon.missions.write().retain(|_, m| m.obs.last().map(|x| x.t > cutoff).unwrap_or(false));
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            o.recon.running.store(false, Ordering::SeqCst);
        });
    }

    pub fn geojson(&self) -> Value {
        let m = self.missions.read();
        let mut feats = vec![];
        for (id, ms) in m.iter() {
            if ms.obs.len() > 1 {
                let coords: Vec<[f64; 2]> = ms.obs.iter().map(|o| [o.lon, o.lat]).collect();
                feats.push(json!({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {"mission": id, "_kind": "track"}}));
            }
            if let Some(last) = ms.obs.last() {
                let maxw = ms.obs.iter().filter_map(|o| o.wind).fold(0.0f64, f64::max);
                let maxs = ms.obs.iter().filter_map(|o| o.sfmr).fold(0.0f64, f64::max);
                let minp = ms.obs.iter().filter_map(|o| o.extrap).fold(f64::INFINITY, f64::min);
                feats.push(point(
                    last.lon,
                    last.lat,
                    json!({"_kind": "plane", "mission": id, "aircraft": ms.aircraft, "storm": ms.storm, "time": last.t, "wind": last.wind, "sfmr": last.sfmr, "maxwind": maxw, "maxsfmr": maxs, "minp": if minp.is_finite() { json!(minp) } else { Value::Null }}),
                ));
            }
        }
        fc(feats)
    }
}

/// Parse one HDOB message (URNT15/URPN15): header, then 30-second observation lines.
pub fn parse_hdob(text: &str) -> Option<(String, String, String, Vec<Hdob>)> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let hi = lines.iter().position(|l| l.contains("HDOB"))?;
    let h: Vec<&str> = lines[hi].split_whitespace().collect();
    let aircraft = h.first()?.to_string();
    let mission = h.get(1)?.to_string();
    let date = h.last()?;
    let day = chrono::NaiveDate::parse_from_str(date, "%Y%m%d").ok()?;
    let storm = h.get(2..h.len().saturating_sub(3)).map(|s| s.join(" ")).unwrap_or_default();
    let mut obs = vec![];
    for l in &lines[hi + 1..] {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 12 || f[0].len() != 6 || !f[0].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let tm = chrono::NaiveTime::parse_from_str(f[0], "%H%M%S").ok()?;
        let ll = |s: &str, deg_len: usize| -> Option<f64> {
            let hemi = s.chars().last()?;
            let d: f64 = s.get(..deg_len)?.parse().ok()?;
            let m: f64 = s.get(deg_len..s.len() - 1)?.parse().ok()?;
            let v = d + m / 60.0;
            Some(if hemi == 'S' || hemi == 'W' { -v } else { v })
        };
        let (Some(lat), Some(lon)) = (ll(f[1], 2), ll(f[2], 3)) else { continue };
        let wind = f.get(8).and_then(|w| w.get(3..)).and_then(num);
        let sfmr = f.get(10).and_then(|s| num(s));
        // extrapolated surface pressure (tenths hPa, leading 1 dropped) when below ~1100
        let extrap = f.get(5).and_then(|s| num(s)).map(|v| if v < 1000.0 { (v + 10000.0) / 10.0 } else { v / 10.0 }).filter(|v| (850.0..1100.0).contains(v));
        let mut t = day.and_time(tm).and_utc();
        // messages spanning midnight
        if let Some(prev) = obs.last().map(|o: &Hdob| o.t) {
            if t.timestamp_millis() < prev - 12 * 3_600_000 {
                t += chrono::Duration::days(1);
            }
        }
        obs.push(Hdob { t: t.timestamp_millis(), lat, lon, wind, sfmr, extrap });
    }
    if obs.is_empty() {
        return None;
    }
    Some((format!("{aircraft} {mission}"), aircraft, storm, obs))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hdob() {
        let t = "URNT15 KNHC 081741\nAF305 0709A ISAIAS             HDOB 49 20261008\n173100 2557N 09021W 4594 06492 0300 -080 -097 069008 011 /// /// 03\n173130 2558N 09020W 4594 06492 0302 -080 -097 070010 012 045 /// 03\n";
        let (id, ac, storm, obs) = parse_hdob(t).unwrap();
        assert_eq!(id, "AF305 0709A");
        assert_eq!(ac, "AF305");
        assert_eq!(storm, "ISAIAS");
        assert_eq!(obs.len(), 2);
        assert!((obs[0].lat - (25.0 + 57.0 / 60.0)).abs() < 1e-9);
        assert!((obs[0].lon + (90.0 + 21.0 / 60.0)).abs() < 1e-9);
        assert_eq!(obs[0].wind, Some(8.0));
        assert_eq!(obs[1].sfmr, Some(45.0));
    }
}
