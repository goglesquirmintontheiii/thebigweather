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

static WH_URLS: once_cell::sync::Lazy<parking_lot::Mutex<std::collections::HashMap<String, Option<String>>>> = once_cell::sync::Lazy::new(Default::default);
static WH_STATUS: once_cell::sync::Lazy<parking_lot::Mutex<std::collections::HashMap<String, (std::time::Instant, &'static str)>>> = once_cell::sync::Lazy::new(Default::default);
const WH: &str = "https://locations.wafflehouse.com";

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Store page URL for an OSM Waffle House: its website tag, else the locator's
/// `{city}-{st}-{store number}` pattern, else a match by street number on the city page.
async fn wh_store_url(o: &Overlays, p: &Value) -> Option<String> {
    let web = p["web"].as_str().unwrap_or("").replace("http://", "https://");
    if let Some(rest) = web.strip_prefix(&format!("{WH}/")) {
        // a store page has a single path segment with the store number on the end
        let seg = rest.trim_end_matches('/');
        if !seg.is_empty() && !seg.contains('/') && seg.rsplit('-').next().map(|n| n.chars().all(|c| c.is_ascii_digit())).unwrap_or(false) {
            return Some(format!("{WH}/{seg}/"));
        }
    }
    let city = slug(p["city"].as_str().unwrap_or(""));
    let st = p["state"].as_str().unwrap_or("").trim().to_lowercase();
    if city.is_empty() || st.len() != 2 {
        return None;
    }
    let num: String = p["ref"].as_str().unwrap_or("").chars().filter(|c| c.is_ascii_digit()).collect();
    if !num.is_empty() {
        let u = format!("{WH}/{city}-{st}-{num}/");
        if let Ok(r) = o.http.get(&u).timeout(Duration::from_secs(20)).send().await {
            if r.status().is_success() {
                return Some(u);
            }
        }
    }
    // city page: each store block has its address followed by its "View Location" link
    let house = p["addr"].as_str().unwrap_or("").split_whitespace().next().unwrap_or("").to_string();
    if house.is_empty() {
        return None;
    }
    let page = o.get_text(&format!("{WH}/{st}/{city}/")).await.ok()?;
    let lower = page.to_lowercase();
    let pat = format!("{WH}/{city}-{st}-");
    let mut from = 0;
    let mut prev_end = 0;
    while let Some(k) = lower[from..].find(&pat) {
        let at = from + k;
        let end = lower[at..].find('"').map(|e| at + e).unwrap_or(at + pat.len() + 8);
        let block = &lower[prev_end..at];
        let url = &page[at..end];
        // the address text sits just before this store's link
        let tail = &block[block.len().saturating_sub(600)..];
        if tail.contains(&format!(">{house} ")) || tail.contains(&format!(" {house} ")) || tail.contains(&format!("\n{house} ")) {
            return Some(url.trim_end_matches('/').to_string() + "/");
        }
        prev_end = end;
        from = end;
    }
    None
}

fn wh_page_status(html: &str) -> &'static str {
    let l = html.to_lowercase();
    if l.contains("temporarily closed") || l.contains("closed until further notice") || l.contains("permanently closed") {
        return "closed";
    }
    // hours list: "<weekday>, YYYY-MM-DD: Open 24 Hours" — read today's entry (US Eastern-ish date)
    let today = (chrono::Utc::now() - chrono::Duration::hours(5)).format("%Y-%m-%d").to_string();
    if let Some(i) = l.find(&format!("{today}:")) {
        let seg: String = l[i + today.len() + 1..].chars().take(200).collect();
        let text = seg.split('<').next().unwrap_or(&seg).trim().to_string();
        let text = if text.is_empty() {
            // the value may be inside the next tag
            seg.split('>').nth(1).unwrap_or("").split('<').next().unwrap_or("").trim().to_string()
        } else {
            text
        };
        if text.starts_with("closed") {
            return "closed";
        }
        if text.contains("open 24") {
            return "open";
        }
        if !text.is_empty() {
            return "limited";
        }
    }
    if l.contains("limited menu") || l.contains("limited hours") {
        "limited"
    } else {
        "open"
    }
}

/// Best-effort open/closed check from the official store pages (only when the user turns it on).
/// `ids` are OSM ids from the waffle overlay; the answer maps id → open | limited | closed | unknown.
pub async fn waffle_status(o: &Overlays, ids: &str) -> Result<Value> {
    let all = waffle(o).await?;
    let by_id: std::collections::HashMap<&str, &Value> = all["features"].as_array().map(|a| a.iter().filter_map(|f| Some((f["properties"]["id"].as_str()?, &f["properties"]))).collect()).unwrap_or_default();
    let mut out = serde_json::Map::new();
    for id in ids.split(',').filter(|x| !x.is_empty()).take(30) {
        let Some(p) = by_id.get(id) else { continue };
        let cached_url = WH_URLS.lock().get(id).cloned();
        let url = match cached_url {
            Some(u) => u,
            None => {
                let u = wh_store_url(o, p).await;
                WH_URLS.lock().insert(id.to_string(), u.clone());
                tokio::time::sleep(Duration::from_millis(250)).await;
                u
            }
        };
        let Some(url) = url else {
            out.insert(id.to_string(), json!("unknown"));
            continue;
        };
        if let Some((t, st)) = WH_STATUS.lock().get(&url) {
            if t.elapsed() < Duration::from_secs(1200) {
                out.insert(id.to_string(), json!({"st": st, "url": url}));
                continue;
            }
        }
        let st = match o.get_text(&url).await {
            Ok(t) => wh_page_status(&t),
            Err(_) => "unknown",
        };
        WH_STATUS.lock().insert(url.clone(), (std::time::Instant::now(), st));
        out.insert(id.to_string(), json!({"st": st, "url": url}));
        // be gentle with their site
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    #[test]
    fn waffle_page() {
        let today = (chrono::Utc::now() - chrono::Duration::hours(5)).format("%Y-%m-%d").to_string();
        let open = format!("<li>Sunday, {today}: Open 24 Hours</li>");
        assert_eq!(super::wh_page_status(&open), "open");
        let closed = format!("<li>Sunday, {today}: <span>Closed</span></li>");
        assert_eq!(super::wh_page_status(&closed), "closed");
        let ltd = format!("<li>Sunday, {today}: 6:00 AM - 10:00 PM</li>");
        assert_eq!(super::wh_page_status(&ltd), "limited");
        assert_eq!(super::slug("St. Mary's"), "st-mary-s");
    }
}
