//! Waffle House locations (OpenStreetMap) and satellite orbital elements (CelesTrak).

use super::{fc, point, Overlays};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::time::Duration;

/// Waffle House restaurants from OpenStreetMap (brand:wikidata=Q1701206), refreshed weekly.
pub async fn waffle(o: &Overlays) -> Result<Value> {
    let p = o.data_dir.join("wafflehouse.json");
    let fresh = std::fs::metadata(&p).and_then(|m| m.modified()).ok().map(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(86400 * 7)).unwrap_or(false);
    let raw: Value = if fresh {
        serde_json::from_slice(&tokio::fs::read(&p).await?)?
    } else {
        let q = "[out:json][timeout:120];nwr[\"brand:wikidata\"=\"Q1701206\"];out center tags;";
        let body = format!("data={}", q.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>());
        let r = o
            .http
            .post("https://overpass-api.de/api/interpreter")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .timeout(Duration::from_secs(150))
            .send()
            .await;
        match r {
            Ok(r) if r.status().is_success() => {
                let b = r.bytes().await?;
                tokio::fs::write(&p, &b).await.ok();
                serde_json::from_slice(&b)?
            }
            other => {
                if let Ok(b) = tokio::fs::read(&p).await {
                    serde_json::from_slice(&b)?
                } else {
                    match other {
                        Ok(r) => bail!("Overpass HTTP {}", r.status()),
                        Err(e) => return Err(e.into()),
                    }
                }
            }
        }
    };
    let feats = raw["elements"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            let lat = e["lat"].as_f64().or(e["center"]["lat"].as_f64())?;
            let lon = e["lon"].as_f64().or(e["center"]["lon"].as_f64())?;
            let t = &e["tags"];
            let addr = [t["addr:housenumber"].as_str(), t["addr:street"].as_str()].iter().flatten().cloned().collect::<Vec<_>>().join(" ");
            Some(point(
                lon,
                lat,
                json!({"id": format!("{}{}", &e["type"].as_str().unwrap_or("n")[..1], e["id"]), "addr": addr, "city": t["addr:city"], "state": t["addr:state"], "ref": t["ref"], "hours": t["opening_hours"], "web": t["website"]}),
            ))
        })
        .collect();
    Ok(fc(feats))
}

/// Two-line elements for a CelesTrak group (stations, weather, visual), cached ≥ 2 hours.
pub async fn tle(o: &Overlays, group: &str) -> Result<Value> {
    let group = match group {
        "weather" | "visual" | "noaa" | "goes" => group,
        _ => "stations",
    };
    // CelesTrak allows one download per 2-hour update; the disk cache enforces that
    let b = o.disk_cached(&format!("tle_{group}.txt"), Duration::from_secs(3 * 3600), &format!("https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=TLE")).await?;
    let text = String::from_utf8_lossy(&b);
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end()).filter(|l| !l.is_empty()).collect();
    let mut sats = vec![];
    for c in lines.chunks(3) {
        if c.len() == 3 && c[1].starts_with("1 ") && c[2].starts_with("2 ") {
            sats.push(json!({"name": c[0].trim(), "l1": c[1], "l2": c[2]}));
        }
    }
    if sats.is_empty() {
        bail!("no orbital elements in CelesTrak response");
    }
    Ok(json!({"group": group, "sats": sats}))
}

/// Best-effort open/closed check from the official store pages (only when the user turns it on).
/// The locator publishes hours, not a live status, so this looks for closure notices.
pub async fn waffle_status(o: &Overlays, urls: &str) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for u in urls.split(',').filter(|u| u.starts_with("https://locations.wafflehouse.com/")).take(30) {
        let status = match o.get_text(u).await {
            Ok(t) => {
                let l = t.to_lowercase();
                if l.contains("temporarily closed") || l.contains("closed until further notice") {
                    "closed"
                } else if l.contains("limited menu") || l.contains("limited hours") {
                    "limited"
                } else {
                    "open"
                }
            }
            Err(_) => "unknown",
        };
        out.insert(u.to_string(), json!(status));
        // be gentle with their site
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Ok(Value::Object(out))
}
