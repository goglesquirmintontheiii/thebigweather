//! NOAA/NWS outlooks (via mapservices.weather.noaa.gov ArcGIS), NHC, IEM feeds, surface fronts.

use super::{fc, point, Overlays};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

const MAPSVC: &str = "https://mapservices.weather.noaa.gov";

/// Query one ArcGIS MapServer layer as GeoJSON features (tagged with `_layer`).
pub async fn arcgis(o: &Overlays, service: &str, layer: u32) -> Result<Vec<Value>> {
    let url = format!("{MAPSVC}/{service}/MapServer/{layer}/query?where=1%3D1&outFields=*&returnGeometry=true&geometryPrecision=4&outSR=4326&f=geojson");
    let v = o.get_json(&url).await?;
    if let Some(e) = v.get("error") {
        return Err(anyhow!("ArcGIS: {}", e["message"].as_str().unwrap_or("error")));
    }
    let mut feats = v["features"].as_array().cloned().unwrap_or_default();
    for f in feats.iter_mut() {
        if let Some(p) = f["properties"].as_object_mut() {
            p.insert("_layer".into(), json!(layer));
        }
    }
    Ok(feats)
}

async fn layers(o: &Overlays, service: &str, ids: &[u32]) -> Result<Vec<Value>> {
    let res = futures::future::join_all(ids.iter().map(|&l| arcgis(o, service, l))).await;
    let mut out = vec![];
    let mut err = None;
    for r in res {
        match r {
            Ok(mut f) => out.append(&mut f),
            Err(e) => err = Some(e),
        }
    }
    if out.is_empty() {
        if let Some(e) = err {
            return Err(e);
        }
    }
    Ok(out)
}

fn day(s: &str, max: u32) -> u32 {
    s.parse::<u32>().unwrap_or(1).clamp(1, max)
}

// ---------- SPC ----------

/// SPC convective outlook. kind: cat | torn | wind | hail | prob (day 3+).
pub async fn spc(o: &Overlays, d: &str, kind: &str) -> Result<Value> {
    let d = day(d, 8);
    let svc = "vector/rest/services/outlooks/SPC_wx_outlks";
    // (probability layer, conditional-intensity layer)
    let ids: Vec<u32> = match (d, kind) {
        (1, "torn") => vec![3, 2],
        (1, "hail") => vec![5, 4],
        (1, "wind") => vec![7, 6],
        (1, _) => vec![1],
        (2, "torn") => vec![11, 10],
        (2, "hail") => vec![13, 12],
        (2, "wind") => vec![15, 14],
        (2, _) => vec![9],
        (3, "cat") | (3, "") => vec![17],
        (3, _) => vec![19, 18],
        (d, _) => vec![21 + (d - 4)],
    };
    let mut feats = layers(o, svc, &ids).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        let label = p["label"].as_str().unwrap_or("").to_string();
        if label.starts_with("CIG") {
            p["_cig"] = json!(true);
        }
        // Day 4-8 has no colors in the data
        if p["fill"].is_null() {
            let dn = p["dn"].as_i64().unwrap_or(0);
            p["fill"] = json!(if dn >= 30 { "#ff9a5c" } else { "#ffe066" });
            p["stroke"] = json!(if dn >= 30 { "#d9480f" } else { "#e0a800" });
            if p["label2"].is_null() {
                p["label2"] = json!(format!("{dn}% severe probability"));
            }
        }
    }
    // draw low categories first
    feats.sort_by_key(|f| (f["properties"]["_cig"].as_bool().unwrap_or(false), f["properties"]["dn"].as_i64().unwrap_or(0)));
    Ok(fc(feats))
}

pub async fn spc_fire(o: &Overlays, d: &str, kind: &str) -> Result<Value> {
    let d = day(d, 8);
    let dry = kind == "dryt";
    let id = match d {
        1 => if dry { 2 } else { 1 },
        2 => if dry { 5 } else { 4 },
        d => {
            let base = 7 + (d - 3) * 3;
            if dry { base } else { base + 1 }
        }
    };
    let mut feats = arcgis(o, "vector/rest/services/fire_weather/SPC_firewx", id).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        let dn = p["dn"].as_i64().unwrap_or(0);
        let (fill, name) = match dn {
            5 => ("#e69800", "Elevated"),
            8 => ("#ff0000", "Critical"),
            10 => ("#e600a9", "Extremely critical"),
            40 => ("#e69800", "40% dry thunderstorms"),
            70 => ("#ff0000", "70% dry thunderstorms"),
            _ if dry => ("#c08040", "Isolated dry thunderstorms"),
            _ => ("#e69800", "Elevated"),
        };
        p["fill"] = json!(fill);
        p["stroke"] = json!(fill);
        p["label2"] = json!(name);
    }
    feats.sort_by_key(|f| f["properties"]["dn"].as_i64().unwrap_or(0));
    Ok(fc(feats))
}

// ---------- WPC ----------

pub async fn ero(o: &Overlays, d: &str) -> Result<Value> {
    let d = day(d, 5);
    let mut feats = arcgis(o, "vector/rest/services/hazards/wpc_precip_hazards", d - 1).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        let dn = p["dn"].as_i64().unwrap_or(0);
        let c = match dn {
            1 => "#38a800",
            2 => "#fffe00",
            3 => "#f50000",
            _ => "#ff69c5",
        };
        p["fill"] = json!(c);
        p["stroke"] = json!(c);
        p["label2"] = p["outlook"].clone();
    }
    feats.sort_by_key(|f| f["properties"]["dn"].as_i64().unwrap_or(0));
    Ok(fc(feats))
}

/// WPC Winter Storm Severity Index, overall impact. day: 1, 2, 3 or 13 (days 1-3).
pub async fn wssi(o: &Overlays, d: &str) -> Result<Value> {
    let layer = match d {
        "2" => 2,
        "3" => 3,
        "13" => 4,
        _ => 1,
    };
    let mut feats = arcgis(o, "vector/rest/services/outlooks/wpc_wssi", layer).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        // the impact level lives in a text field whose name varies; look through all strings
        let text = p.as_object().map(|m| m.values().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" ").to_lowercase()).unwrap_or_default();
        let (c, name, rank) = if text.contains("extreme") {
            ("#9c27b0", "Extreme impacts", 5)
        } else if text.contains("major") {
            ("#d32f2f", "Major impacts", 4)
        } else if text.contains("moderate") {
            ("#f57c00", "Moderate impacts", 3)
        } else if text.contains("minor") {
            ("#fbc02d", "Minor impacts", 2)
        } else {
            ("#9e9e9e", "Limited impacts", 1)
        };
        p["fill"] = json!(c);
        p["stroke"] = json!(c);
        p["label2"] = json!(name);
        p["dn"] = json!(rank);
    }
    feats.sort_by_key(|f| f["properties"]["dn"].as_i64().unwrap_or(0));
    Ok(fc(feats))
}

// ---------- CPC ----------

fn lerp(a: (f64, f64, f64), b: (f64, f64, f64), t: f64) -> String {
    let t = t.clamp(0.0, 1.0);
    format!("#{:02x}{:02x}{:02x}", (a.0 + (b.0 - a.0) * t) as u8, (a.1 + (b.1 - a.1) * t) as u8, (a.2 + (b.2 - a.2) * t) as u8)
}

/// CPC outlooks. period: 610 | 814 | month | season; var: temp | precip.
pub async fn cpc(o: &Overlays, period: &str, var: &str) -> Result<Value> {
    let precip = var == "precip";
    let (svc, layer) = match (period, precip) {
        ("814", false) => ("cpc_8_14_day_outlk", 0),
        ("814", true) => ("cpc_8_14_day_outlk", 1),
        ("month", false) => ("cpc_mthly_temp_outlk", 0),
        ("month", true) => ("cpc_mthly_precip_outlk", 0),
        ("season", false) => ("cpc_sea_temp_outlk", 0),
        ("season", true) => ("cpc_sea_precip_outlk", 0),
        (_, false) => ("cpc_6_10_day_outlk", 0),
        (_, true) => ("cpc_6_10_day_outlk", 1),
    };
    let mut feats = arcgis(o, &format!("vector/rest/services/outlooks/{svc}"), layer).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        let cat = p["cat"].as_str().unwrap_or("").to_lowercase();
        let prob = p["prob"].as_f64().or_else(|| p["prob"].as_str().and_then(|s| s.parse().ok())).unwrap_or(33.0);
        let t = (prob - 33.0) / 57.0;
        let fill = if cat.starts_with('a') {
            if precip { lerp((179.0, 230.0, 179.0), (0.0, 90.0, 0.0), t) } else { lerp((231.0, 177.0, 104.0), (112.0, 33.0, 0.0), t) }
        } else if cat.starts_with('b') {
            if precip { lerp((230.0, 204.0, 153.0), (102.0, 51.0, 0.0), t) } else { lerp((191.0, 203.0, 228.0), (34.0, 24.0, 82.0), t) }
        } else {
            "#a0a0a0".into()
        };
        let what = if precip { "precipitation" } else { "temperature" };
        let name = if cat.starts_with('a') {
            format!("{prob:.0}% chance above-normal {what}")
        } else if cat.starts_with('b') {
            format!("{prob:.0}% chance below-normal {what}")
        } else {
            format!("Near-normal {what}")
        };
        p["fill"] = json!(fill);
        p["stroke"] = json!(fill);
        p["label2"] = json!(name);
        p["dn"] = json!(prob);
    }
    feats.sort_by(|a, b| a["properties"]["dn"].as_f64().unwrap_or(0.0).total_cmp(&b["properties"]["dn"].as_f64().unwrap_or(0.0)));
    Ok(fc(feats))
}

/// CPC hazards outlook (3-7 or 8-14 day).
pub async fn cpc_hazards(o: &Overlays, period: &str) -> Result<Value> {
    let ids: &[u32] = if period == "814" { &[3, 6, 8] } else { &[1, 4, 7] };
    let mut feats = layers(o, "vector/rest/services/hazards/cpc_weather_hazards", ids).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        let l = p["label"].as_str().unwrap_or("").to_lowercase();
        let c = if l.contains("heat") {
            "#e53935"
        } else if l.contains("cold") || l.contains("freeze") || l.contains("frost") {
            "#1e88e5"
        } else if l.contains("snow") || l.contains("ice") {
            "#7e57c2"
        } else if l.contains("precip") || l.contains("rain") || l.contains("flood") {
            "#43a047"
        } else if l.contains("wind") || l.contains("wave") {
            "#8d6e63"
        } else if l.contains("fire") || l.contains("drought") {
            "#ff8f00"
        } else {
            "#757575"
        };
        p["fill"] = json!(c);
        p["stroke"] = json!(c);
        p["label2"] = p["label"].clone();
    }
    Ok(fc(feats))
}

// ---------- NHC ----------

const NHC_SVC: &str = "tropical/rest/services/tropical/NHC_tropical_weather";

fn bin_start(bin: &str) -> Option<u32> {
    let (basin, n) = bin.split_at(2);
    let n: u32 = n.parse().ok()?;
    if !(1..=5).contains(&n) {
        return None;
    }
    let b0 = match basin {
        "AT" => 4,
        "EP" => 134,
        "CP" => 264,
        _ => return None,
    };
    Some(b0 + (n - 1) * 26)
}

/// Active storms list (name, intensity, position) from NHC.
pub async fn storms(o: &Overlays) -> Result<Value> {
    let v = o.get_json("https://www.nhc.noaa.gov/CurrentStorms.json").await?;
    let mut feats = vec![];
    for s in v["activeStorms"].as_array().cloned().unwrap_or_default() {
        let (Some(lat), Some(lon)) = (s["latitudeNumeric"].as_f64(), s["longitudeNumeric"].as_f64()) else { continue };
        feats.push(point(
            lon,
            lat,
            json!({
                "id": s["id"], "name": s["name"], "bin": s["binNumber"], "class": s["classification"], "wind": s["intensity"], "pres": s["pressure"],
                "move": format!("{} {} mph", s["movementDir"].as_i64().unwrap_or(0), s["movementSpeed"].as_i64().unwrap_or(0)),
                "mdir": s["movementDir"], "mspd": s["movementSpeed"], "lat": lat, "lon": lon, "updated": s["lastUpdate"],
                "advnum": s["publicAdvisory"]["advNum"], "adv": s["publicAdvisory"]["url"], "fcstadv": s["forecastAdvisory"]["url"],
                "disc": s["forecastDiscussion"]["url"], "graphics": s["forecastGraphics"]["url"], "wsp": s["windSpeedProbabilities"]["url"],
            }),
        ));
    }
    Ok(fc(feats))
}

/// Cones, tracks, forecast points and coastal watches/warnings for every active storm.
pub async fn nhc(o: &Overlays) -> Result<Value> {
    let st = storms(o).await?;
    let mut ids = vec![];
    for f in st["features"].as_array().cloned().unwrap_or_default() {
        if let Some(b) = f["properties"]["bin"].as_str().and_then(bin_start) {
            // forecast points, track, cone, watch/warning, past track
            ids.extend([b + 4, b + 5, b + 8, b + 3, b + 2]);
        }
    }
    if ids.is_empty() {
        return Ok(fc(vec![]));
    }
    let mut feats = layers(o, NHC_SVC, &ids).await?;
    // which storm each NHC layer belongs to (by bin slot)
    let slots: Vec<(u32, Value)> = st["features"].as_array().map(|a| a.iter().filter_map(|f| Some((f["properties"]["bin"].as_str().and_then(bin_start)?, f["properties"].clone()))).collect()).unwrap_or_default();
    for f in feats.iter_mut() {
        let l = f["properties"]["_layer"].as_u64().unwrap_or(0) as u32;
        if let Some((_, sp)) = slots.iter().find(|(b, _)| l >= *b && l < *b + 26) {
            f["properties"]["_s"] = sp.clone();
        }
        let off = (l - 4) % 26;
        let kind = match off {
            2 => "point",
            3 => "track",
            4 => "cone",
            5 => "ww",
            8 => "past",
            _ => "other",
        };
        f["properties"]["_kind"] = json!(kind);
        if kind == "ww" {
            let c = match f["properties"]["tcww"].as_str().unwrap_or("") {
                "HWA" => "#ff7f7f",
                "HWR" => "#ff0000",
                "TWA" => "#ffff00",
                _ => "#004da8",
            };
            f["properties"]["stroke"] = json!(c);
        }
    }
    // cones underneath, then lines, then points
    feats.sort_by_key(|f| match f["properties"]["_kind"].as_str() {
        Some("cone") => 0,
        Some("ww") => 1,
        Some("past") | Some("track") => 2,
        _ => 3,
    });
    Ok(fc(feats))
}

/// Graphical Tropical Weather Outlook: development areas and disturbance points.
pub async fn gtwo(o: &Overlays) -> Result<Value> {
    let mut feats = layers(o, NHC_SVC, &[3, 1, 2]).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        let risk = p["risk7day"].as_str().or(p["risk2day"].as_str()).unwrap_or("").to_lowercase();
        let c = if risk.starts_with('h') {
            "#e53935"
        } else if risk.starts_with('m') {
            "#e69800"
        } else {
            "#ffd400"
        };
        p["fill"] = json!(c);
        p["stroke"] = json!(c);
        p["label2"] = json!(format!("2-day {} · 7-day {}", p["prob2day"].as_str().unwrap_or("?"), p["prob7day"].as_str().unwrap_or("?")));
    }
    Ok(fc(feats))
}

pub async fn river_flood(o: &Overlays) -> Result<Value> {
    let mut feats = arcgis(o, "vector/rest/services/outlooks/sig_riv_fld_outlk", 0).await?;
    for f in feats.iter_mut() {
        let p = &mut f["properties"];
        let text = p.as_object().map(|m| m.values().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" ").to_lowercase()).unwrap_or_default();
        let (c, n) = if text.contains("occurring") {
            ("#c62828", "Flooding occurring or imminent")
        } else if text.contains("likely") {
            ("#ef6c00", "Flooding likely")
        } else {
            ("#2e7d32", "Flooding possible")
        };
        p["fill"] = json!(c);
        p["stroke"] = json!(c);
        p["label2"] = json!(n);
    }
    Ok(fc(feats))
}

// ---------- fronts ----------

/// Surface fronts and pressure centers: current analysis (WPC coded bulletin) or WPC forecast chart.
pub async fn fronts(o: &Overlays, src: &str) -> Result<Value> {
    match src {
        "day1" | "day2" | "day3" => {
            let (fr, hl) = match src {
                "day2" => (14, 13),
                "day3" => (26, 25),
                _ => (2, 1),
            };
            let mut feats = layers(o, "vector/rest/services/outlooks/natl_fcst_wx_chart", &[fr, hl]).await?;
            for f in feats.iter_mut() {
                let t = f["properties"]["feat"].as_str().unwrap_or("").to_lowercase();
                let kind = if t.contains("cold") {
                    "cold"
                } else if t.contains("warm") {
                    "warm"
                } else if t.contains("stationary") {
                    "stationary"
                } else if t.contains("occluded") {
                    "occluded"
                } else if t.contains("trough") {
                    "trough"
                } else if t.contains("high") {
                    "high"
                } else if t.contains("low") {
                    "low"
                } else {
                    "other"
                };
                f["properties"]["kind"] = json!(kind);
            }
            Ok(fc(feats))
        }
        _ => {
            let text = o.get_text("https://tgftp.nws.noaa.gov/data/raw/as/asus02.kwbc.cod.sus.txt").await?;
            let feats = parse_codsus(&text);
            if feats.is_empty() {
                // fall back to the forecast chart
                return Box::pin(fronts(o, "day1")).await;
            }
            Ok(fc(feats))
        }
    }
}

/// WPC coded surface bulletin (CODSUS): "HIGHS 1026 5411240 …", "COLD 4271234 4251198 …".
/// Positions are 7 digits: latitude ×10 (3) and west longitude ×10 (4).
pub fn parse_codsus(text: &str) -> Vec<Value> {
    let pos = |t: &str| -> Option<(f64, f64)> {
        if t.len() != 7 || !t.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let lat = t[..3].parse::<f64>().ok()? / 10.0;
        let lon = -(t[3..].parse::<f64>().ok()? / 10.0);
        Some((lat, lon))
    };
    // records start with a keyword; continuation lines don't
    let mut recs: Vec<Vec<String>> = vec![];
    for line in text.lines() {
        let toks: Vec<String> = line.split_whitespace().map(|s| s.to_string()).collect();
        let Some(first) = toks.first() else { continue };
        let kw = ["VALID", "HIGHS", "LOWS", "COLD", "WARM", "STNRY", "OCFNT", "TROF", "DRYLINE"];
        if kw.contains(&first.as_str()) {
            recs.push(toks);
        } else if let Some(last) = recs.last_mut() {
            if first.chars().all(|c| c.is_ascii_digit()) {
                last.extend(toks);
            }
        }
    }
    let mut feats = vec![];
    for r in recs {
        let kw = r[0].as_str();
        match kw {
            "HIGHS" | "LOWS" => {
                let mut it = r[1..].iter();
                while let (Some(p), Some(loc)) = (it.next(), it.next()) {
                    if let (Ok(pres), Some((lat, lon))) = (p.parse::<i32>(), pos(loc)) {
                        feats.push(point(lon, lat, json!({"kind": if kw == "HIGHS" { "high" } else { "low" }, "pres": pres})));
                    }
                }
            }
            "COLD" | "WARM" | "STNRY" | "OCFNT" | "TROF" | "DRYLINE" => {
                let strength = r.get(1).filter(|s| !s.chars().all(|c| c.is_ascii_digit())).cloned().unwrap_or_default();
                let coords: Vec<[f64; 2]> = r[1..].iter().filter_map(|t| pos(t)).map(|(la, lo)| [lo, la]).collect();
                if coords.len() < 2 {
                    continue;
                }
                let kind = match kw {
                    "COLD" => "cold",
                    "WARM" => "warm",
                    "STNRY" => "stationary",
                    "OCFNT" => "occluded",
                    "DRYLINE" => "dryline",
                    _ => "trough",
                };
                feats.push(json!({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {"kind": kind, "strength": strength}}));
            }
            _ => {}
        }
    }
    feats
}

// ---------- IEM ----------

pub async fn iem_geojson(o: &Overlays, url: &str) -> Result<Value> {
    let v = o.get_json(url).await?;
    if v.is_null() {
        return Ok(fc(vec![]));
    }
    Ok(v)
}

pub async fn lsr(o: &Overlays, hours: &str) -> Result<Value> {
    let h = hours.parse::<u32>().unwrap_or(24).clamp(1, 72);
    let v = o.get_json(&format!("https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours={h}")).await?;
    // keep the fields the app shows
    let feats = v["features"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut f| {
            let p = f["properties"].take();
            f["properties"] = json!({
                "type": p["type"], "typetext": p["typetext"], "mag": p["magnitude"], "unit": p["unit"],
                "city": p["city"], "county": p["county"], "st": p["st"], "source": p["source"],
                "remark": p["remark"], "valid": p["valid"], "wfo": p["wfo"],
            });
            f
        })
        .collect();
    Ok(fc(feats))
}

/// NWS offices: the IEM list, with each point moved onto the office building from OpenStreetMap
/// when one is mapped within 25 km (IEM positions are station points, often ~1 km off).
pub async fn wfo(o: &Overlays) -> Result<Value> {
    let b = o.disk_cached("wfo.geojson", std::time::Duration::from_secs(86400 * 30), "https://mesonet.agron.iastate.edu/geojson/network.py?network=WFO").await?;
    let mut v: Value = serde_json::from_slice(&b)?;
    let osm = wfo_buildings(o).await.unwrap_or_default();
    if let Some(fs) = v["features"].as_array_mut() {
        for f in fs {
            let (Some(lon), Some(lat)) = (f["geometry"]["coordinates"][0].as_f64(), f["geometry"]["coordinates"][1].as_f64()) else { continue };
            let best = osm.iter().map(|(a, b)| (a, b, crate::overlays::km(lat, lon, *b, *a))).filter(|x| x.2 < 25.0).min_by(|x, y| x.2.total_cmp(&y.2));
            if let Some((blon, blat, _)) = best {
                f["geometry"]["coordinates"] = json!([super::round(*blon), super::round(*blat)]);
                f["properties"]["exact"] = json!(true);
            }
        }
    }
    Ok(v)
}

async fn wfo_buildings(o: &Overlays) -> Result<Vec<(f64, f64)>> {
    let q = r#"[out:json][timeout:90];nwr["name"~"National Weather Service|Weather Forecast Office",i](17,-180,72,-60);out center;"#;
    let url = format!("https://overpass-api.de/api/interpreter?data={}", q.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>());
    let b = o.disk_cached("wfo_osm.json", std::time::Duration::from_secs(86400 * 30), &url).await?;
    let v: Value = serde_json::from_slice(&b)?;
    Ok(v["elements"]
        .as_array()
        .map(|a| a.iter().filter_map(|e| Some((e["lon"].as_f64().or(e["center"]["lon"].as_f64())?, e["lat"].as_f64().or(e["center"]["lat"].as_f64())?))).collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codsus() {
        let t = "CODED SURFACE FRONTAL POSITIONS\nVALID 101118Z\nHIGHS 1026 5411240 1030 4561050\nLOWS 994 3821187\nCOLD WEAK 4271234 4251198 4211150\n4171120 4101090\nWARM 4271234 4301200\n";
        let f = parse_codsus(t);
        assert_eq!(f.len(), 5);
        assert_eq!(f[0]["properties"]["kind"], "high");
        assert_eq!(f[0]["geometry"]["coordinates"][1], 54.1);
        assert_eq!(f[0]["geometry"]["coordinates"][0], -124.0);
        let cold = f.iter().find(|x| x["properties"]["kind"] == "cold").unwrap();
        assert_eq!(cold["geometry"]["coordinates"].as_array().unwrap().len(), 5);
        assert_eq!(cold["properties"]["strength"], "WEAK");
    }

    #[test]
    fn nhc_bins() {
        assert_eq!(bin_start("AT1"), Some(4));
        assert_eq!(bin_start("EP2"), Some(160));
        assert_eq!(bin_start("CP5"), Some(368));
        assert_eq!(bin_start("XX1"), None);
    }
}
