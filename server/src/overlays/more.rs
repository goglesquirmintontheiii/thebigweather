//! More overlays: severe-weather history (IEM warnings, reports, watches, MDs), NEXRAD storm
//! attributes, volcanoes, drought, social vulnerability, smoke/fire (HMS), air quality, Kp,
//! tropical model tracks (ATCF a-decks), Raspberry Shake stations, and TomTom traffic tiles.

use super::{fc, num, point, Overlays};
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use chrono::{DateTime, Datelike, Duration as CDuration, NaiveDate, NaiveDateTime, Utc};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::BufRead;
use std::time::{Duration, Instant};

const IEM: &str = "https://mesonet.agron.iastate.edu";

// ---------- time helpers ----------

/// Parse a time: unix ms, RFC 3339, or "YYYY-MM-DD[THH:MM[:SS]][Z]" (UTC).
pub fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if s.len() >= 10 && s.chars().all(|c| c.is_ascii_digit()) {
        return s.parse::<i64>().ok().and_then(DateTime::from_timestamp_millis);
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Some(t.with_timezone(&Utc));
    }
    let t = s.trim_end_matches('Z');
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(t, f) {
            return Some(d.and_utc());
        }
    }
    NaiveDate::parse_from_str(t, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|d| d.and_utc())
}

/// A JSON time string as unix ms.
fn ms(v: &Value) -> Option<i64> {
    v.as_str().and_then(parse_time).map(|t| t.timestamp_millis())
}

fn iso(t_ms: i64) -> Value {
    DateTime::from_timestamp_millis(t_ms).map(|t| json!(t.format("%Y-%m-%dT%H:%M:%SZ").to_string())).unwrap_or(Value::Null)
}

/// IEM's time format for sts/ets/valid parameters.
fn iem_ts(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%MZ").to_string()
}

/// History window from `sts`/`ets` (default: the last 24 h, ending now), at most `max_days` long
/// (a longer window keeps its end and is cut at the start).
fn window(sts: &str, ets: &str, max_days: i64) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let now = Utc::now();
    let e = if ets.is_empty() { now } else { parse_time(ets).ok_or_else(|| anyhow!("bad ets (use ISO 8601 UTC)"))? }.min(now);
    let s = if sts.is_empty() { e - CDuration::hours(24) } else { parse_time(sts).ok_or_else(|| anyhow!("bad sts (use ISO 8601 UTC)"))? };
    if s >= e {
        bail!("sts must be before ets");
    }
    Ok((s.max(e - CDuration::days(max_days)), e))
}

/// A number that may arrive as a JSON number or string.
fn fnum(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(num))
}

fn round_to(v: f64, d: i32) -> f64 {
    let m = 10f64.powi(d);
    (v * m).round() / m
}

/// Round every coordinate of a (Multi)Polygon/LineString geometry, dropping repeated points and
/// rings that collapse.
fn round_geom(g: &mut Value, d: i32) {
    fn ring(r: &Value, d: i32) -> Vec<Value> {
        let mut out: Vec<[f64; 2]> = vec![];
        for p in r.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let (Some(x), Some(y)) = (p[0].as_f64(), p[1].as_f64()) else { continue };
            let q = [round_to(x, d), round_to(y, d)];
            if out.last() != Some(&q) {
                out.push(q);
            }
        }
        out.into_iter().map(|p| json!(p)).collect()
    }
    fn poly(p: &Value, d: i32) -> Vec<Value> {
        p.as_array().map(|a| a.as_slice()).unwrap_or(&[]).iter().map(|r| ring(r, d)).filter(|r| r.len() >= 4).map(Value::Array).collect()
    }
    let c = g["coordinates"].take();
    g["coordinates"] = match g["type"].as_str().unwrap_or("") {
        "Polygon" => Value::Array(poly(&c, d)),
        "MultiPolygon" => Value::Array(c.as_array().map(|a| a.as_slice()).unwrap_or(&[]).iter().map(|p| poly(p, d)).filter(|p| !p.is_empty()).map(Value::Array).collect()),
        "LineString" => Value::Array(ring(&c, d)),
        _ => c,
    };
}

// ---------- storm-based warning history (IEM) ----------

fn sig_name(sig: &str) -> &str {
    match sig {
        "W" => "Warning",
        "A" => "Watch",
        "Y" => "Advisory",
        "S" => "Statement",
        _ => sig,
    }
}

/// NWS event name from a VTEC phenomena + significance pair.
pub fn vtec_event(ph: &str, sig: &str) -> String {
    let base = match ph {
        "TO" => "Tornado",
        "SV" => "Severe Thunderstorm",
        "FF" => "Flash Flood",
        "FA" | "FL" => "Flood",
        "MA" if sig == "W" => return "Special Marine Warning".into(),
        "MA" => "Marine",
        "EW" => "Extreme Wind",
        "SQ" => "Snow Squall",
        "DS" => "Dust Storm",
        "DU" => "Blowing Dust",
        "SS" => "Storm Surge",
        "HU" => "Hurricane",
        "TR" => "Tropical Storm",
        _ => ph,
    };
    format!("{base} {}", sig_name(sig))
}

/// An IEM tag (string or number) as text, None when empty.
fn tag(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => n.as_f64().map(|f| if f.fract() == 0.0 { format!("{f:.0}") } else { format!("{f:.2}") }),
        _ => None,
    }
}

/// One IEM storm-based warning polygon → a feature shaped like an NWS API alert.
fn sbw_feature(f: &Value) -> Option<Value> {
    let p = &f["properties"];
    let (ph, sig) = (p["phenomena"].as_str()?, p["significance"].as_str().unwrap_or(""));
    let wfo = p["wfo"].as_str().unwrap_or("");
    let eventid = p["eventid"].as_i64().unwrap_or(0);
    let year = p["year"].as_i64().unwrap_or(0);
    let event = p["ps"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()).unwrap_or_else(|| vtec_event(ph, sig));
    let issue = ms(&p["issue"]);
    let expire = ms(&p["expire_utc"]).or(ms(&p["expire"]));
    // polygons are re-drawn by follow-up statements: their own valid span is polygon_begin/end
    let t0 = ms(&p["polygon_begin"]).or(issue)?;
    let t1 = ms(&p["polygon_end"]).or(expire).unwrap_or(t0);
    let fmt = |t: i64| DateTime::from_timestamp_millis(t).map(|d| d.format("%b %-d at %-I:%M%p UTC").to_string()).unwrap_or_default();
    // NWS API puts these in `parameters` as arrays of strings
    let mut params = Map::new();
    let has_ffdt = tag(&p["floodtag_damage"]).is_some();
    let mut put = |k: &str, v: Option<String>| {
        if let Some(v) = v {
            params.insert(k.into(), json!([v]));
        }
    };
    put("tornadoDetection", tag(&p["tornadotag"]));
    put("waterspoutDetection", tag(&p["waterspouttag"]));
    put("maxHailSize", tag(&p["hailtag"]).or(tag(&p["max_hailtag"])));
    put("maxWindGust", tag(&p["windtag"]).or(tag(&p["max_windtag"])).map(|w| format!("{w} MPH")));
    put("hailThreat", tag(&p["hailthreat"]));
    put("windThreat", tag(&p["windthreat"]));
    put("snowSquallDetection", tag(&p["squalltag"]));
    put("flashFloodDamageThreat", tag(&p["floodtag_damage"]));
    let dmg = tag(&p["damagetag"]);
    match ph {
        "TO" => put("tornadoDamageThreat", dmg),
        "SV" => put("thunderstormDamageThreat", dmg),
        "FF" if !has_ffdt => put("flashFloodDamageThreat", dmg),
        _ => {}
    }
    let vtec = format!("{wfo}.{ph}.{sig}.{eventid:04}");
    put("VTEC", Some(format!("/O.{}.K{wfo}.{ph}.{sig}.{eventid:04}/", p["status"].as_str().unwrap_or("NEW"))));
    let first = |k: &str| params.get(k).and_then(|v| v[0].as_str()).unwrap_or("").to_ascii_uppercase();
    let emergency = p["is_emergency"].as_bool().unwrap_or(false);
    // same `flags` the live alert feed adds (the app styles and tags alerts from them)
    let flags = json!({
        "tornado_emergency": emergency && ph == "TO",
        "flash_flood_emergency": emergency && ph == "FF",
        "pds": p["is_pds"].as_bool().unwrap_or(false),
        "tornado_detection": first("tornadoDetection"),
        "tornado_damage_threat": first("tornadoDamageThreat"),
        "thunderstorm_damage_threat": first("thunderstormDamageThreat"),
        "flash_flood_damage_threat": first("flashFloodDamageThreat"),
        "max_hail": first("maxHailSize"),
        "max_wind": first("maxWindGust"),
        "warning": event.ends_with("Warning"),
    });
    let id = format!("{wfo}-{ph}-{sig}-{eventid}-{year}-{}", t0 / 60000);
    let props = json!({
        "id": id,
        "vtec_id": format!("{wfo}-{ph}-{sig}-{eventid}-{year}"),
        "vtec": vtec,
        "event": event,
        "status": p["status"],
        "headline": format!("{event} issued {} until {} by NWS {wfo}", fmt(issue.unwrap_or(t0)), fmt(expire.unwrap_or(t1))),
        "areaDesc": "",
        "senderName": format!("NWS {wfo}"),
        "sent": iso(issue.unwrap_or(t0)),
        "effective": iso(issue.unwrap_or(t0)),
        "onset": iso(issue.unwrap_or(t0)),
        "expires": iso(expire.unwrap_or(t1)),
        "ends": iso(expire.unwrap_or(t1)),
        "messageType": if p["status"] == "NEW" { "Alert" } else { "Update" },
        "t0": t0,
        "t1": t1,
        "parameters": params,
        "flags": flags,
        "link": p["href"],
    });
    Some(json!({"type": "Feature", "id": id, "geometry": f["geometry"], "properties": props}))
}

/// Storm-based warnings (and other polygon products) in effect during a window (max 7 days).
pub async fn sbw_hist(o: &Overlays, sts: &str, ets: &str) -> Result<Value> {
    let (a, b) = window(sts, ets, 7)?;
    let v = o.get_json(&format!("{IEM}/geojson/sbw.geojson?sts={}&ets={}", iem_ts(a), iem_ts(b))).await?;
    Ok(fc(v["features"].as_array().map(|a| a.iter().filter_map(sbw_feature).collect()).unwrap_or_default()))
}

// ---------- storm reports history ----------

/// Local storm reports in a window (max 7 days); same fields as the `lsr` overlay plus `t` (ms).
pub async fn lsr_hist(o: &Overlays, sts: &str, ets: &str) -> Result<Value> {
    let (a, b) = window(sts, ets, 7)?;
    let v = o.get_json(&format!("{IEM}/geojson/lsr.geojson?sts={}&ets={}", iem_ts(a), iem_ts(b))).await?;
    Ok(fc(v["features"].as_array().map(|a| a.iter().map(lsr_feature).collect()).unwrap_or_default()))
}

fn lsr_feature(f: &Value) -> Value {
    let p = &f["properties"];
    json!({"type": "Feature", "geometry": f["geometry"], "properties": {
        "type": p["type"], "typetext": p["typetext"], "mag": p["magnitude"], "unit": p["unit"],
        "city": p["city"], "county": p["county"], "st": p["st"], "source": p["source"],
        "remark": p["remark"], "valid": p["valid"], "wfo": p["wfo"], "t": ms(&p["valid"]),
    }})
}

// ---------- SPC watch history ----------

/// Times at which to ask for watch outlines so every watch is caught at least once: each watch is
/// sampled ≤ 1 h after issue (before an early cancellation is likely) unless an earlier sample
/// already falls inside it.
fn watch_samples(mut spans: Vec<(i64, i64)>) -> Vec<i64> {
    spans.sort();
    let mut pts: Vec<i64> = vec![];
    for (t0, t1) in spans {
        if !pts.iter().any(|&p| p >= t0 && p < t1) {
            pts.push(t0 + ((t1 - t0) / 2).clamp(60_000, 3_600_000));
        }
    }
    pts
}

/// SPC watches in effect during a window (max 7 days): outlines from IEM's watch outline service,
/// details (probabilities, hail/wind, PDS) from IEM's yearly watch list.
pub async fn watch_hist(o: &Overlays, sts: &str, ets: &str) -> Result<Value> {
    use futures::StreamExt;
    let (a, b) = window(sts, ets, 7)?;
    let (a_ms, b_ms) = (a.timestamp_millis(), b.timestamp_millis());
    let mut list = vec![];
    for y in a.year()..=b.year() {
        let v = o.get_json(&format!("{IEM}/json/watches.py?year={y}")).await?;
        list.extend(v["events"].as_array().cloned().unwrap_or_default());
    }
    let list: Vec<(i64, i64, Value)> = list
        .into_iter()
        .filter_map(|w| {
            let (t0, t1) = (ms(&w["issue"])?, ms(&w["expire"])?);
            (t0 < b_ms && t1 > a_ms).then_some((t0, t1, w))
        })
        .collect();
    let mut times = watch_samples(list.iter().map(|w| (w.0, w.1)).collect());
    times.truncate(80);
    let outlines: Vec<Value> = futures::stream::iter(times)
        .map(|t| async move {
            let ts = DateTime::from_timestamp_millis(t).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default();
            o.get_json(&format!("{IEM}/api/1/spc_watch_outline.geojson?valid={ts}")).await.ok().and_then(|v| v["features"].as_array().cloned()).unwrap_or_default()
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect();
    Ok(fc(merge_watches(&list, &outlines)))
}

/// Join watch-list entries with outline features (by year + number).
fn merge_watches(list: &[(i64, i64, Value)], outlines: &[Value]) -> Vec<Value> {
    let mut geo: HashMap<(i64, i64), &Value> = HashMap::new();
    for f in outlines {
        let p = &f["properties"];
        let y = ms(&p["utc_issued"]).and_then(DateTime::from_timestamp_millis).map(|d| d.year() as i64).unwrap_or(0);
        if let Some(n) = p["num"].as_i64() {
            geo.entry((y, n)).or_insert(f);
        }
    }
    let mut out = vec![];
    for (t0, t1, w) in list {
        let (Some(y), Some(n)) = (w["year"].as_i64(), w["num"].as_i64()) else { continue };
        let Some(f) = geo.get(&(y, n)) else { continue };
        let mut p = w.as_object().cloned().unwrap_or_default();
        p.remove("product_id_sel");
        p.remove("product_id_wwp");
        p.insert("sel".into(), f["properties"]["sel"].clone());
        if p.get("type").map(|t| t.is_null()).unwrap_or(true) {
            p.insert("type".into(), f["properties"]["type"].clone());
        }
        // the watch-probability names the `watchbox` popup knows
        if let Some(v) = w.get("tornadoes_1m_strong").filter(|v| !v.is_null()) {
            p.insert("prob_sigtor".into(), v.clone());
        }
        if let Some(v) = w.get("hail_1m_2inch").filter(|v| !v.is_null()) {
            p.insert("prob_sighail".into(), v.clone());
        }
        p.insert("t0".into(), json!(t0));
        p.insert("t1".into(), json!(t1));
        out.push(json!({"type": "Feature", "geometry": f["geometry"], "properties": p}));
    }
    out
}

// ---------- SPC mesoscale discussion history ----------

/// SPC mesoscale discussions in effect during a window (max 7 days); same fields as `mcd` plus
/// `t0`/`t1` (issue/expire, ms).
pub async fn mcd_hist(o: &Overlays, sts: &str, ets: &str) -> Result<Value> {
    let (a, b) = window(sts, ets, 7)?;
    // MDs issued up to 6 h before the window can still be in effect at its start
    let hours = ((b - a).num_minutes() + 59) / 60 + 6;
    let ts = b.format("%Y-%m-%dT%H:%M:%SZ");
    let v = o.get_json(&format!("{IEM}/api/1/nws/spc_mcd.geojson?valid={ts}&hours={hours}")).await?;
    Ok(fc(mcd_filter(&v, a.timestamp_millis(), b.timestamp_millis())))
}

fn mcd_filter(v: &Value, a: i64, b: i64) -> Vec<Value> {
    v["features"]
        .as_array()
        .map(|fs| fs.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|f| {
            let (t0, t1) = (ms(&f["properties"]["issue"])?, ms(&f["properties"]["expire"])?);
            if t0 >= b || t1 <= a {
                return None;
            }
            let mut f = f.clone();
            f["properties"]["t0"] = json!(t0);
            f["properties"]["t1"] = json!(t1);
            Some(f)
        })
        .collect()
}

// ---------- NEXRAD storm attributes ----------

/// Storm cell attributes from every WSR-88D (IEM's copy of the Level III storm attribute tables),
/// latest or at `valid`. Fields:
/// - `range` / `range_km`: distance from the radar in **km** (checked against cell positions;
///   IEM converts the table's nautical miles), `azimuth` degrees from the radar
/// - `tvs`: "NONE" or the TVS/ETVS detection id
/// - `meso`: "NONE" or the Mesocyclone Detection Algorithm strength rank "1".."25"
///   (rank ≥ 5 is a mesocyclone; 1–4 are weak shear circulations)
/// - `posh`/`poh` %, `max_size` hail inches, `vil` kg/m², `max_dbz` at `max_dbz_height` kft, `top` kft
/// - `drct`: storm motion direction the cell moves **from** (deg, as in the radar table),
///   `dir_to` = heading it moves toward (null when stationary/new), `sknt` speed kt
pub async fn storm_attr(o: &Overlays, valid: &str) -> Result<Value> {
    let mut url = format!("{IEM}/geojson/nexrad_attr.geojson");
    if !valid.is_empty() {
        let t = parse_time(valid).ok_or_else(|| anyhow!("bad valid time"))?;
        url = format!("{url}?valid={}", iem_ts(t));
    }
    let v = o.get_json(&url).await?;
    Ok(fc(v["features"].as_array().map(|a| a.iter().filter_map(storm_feature).collect()).unwrap_or_default()))
}

fn storm_feature(f: &Value) -> Option<Value> {
    let p = &f["properties"];
    let c = &f["geometry"]["coordinates"];
    let (lon, lat) = (c[0].as_f64()?, c[1].as_f64()?);
    let n = |k: &str| fnum(&p[k]);
    let s = |k: &str| p[k].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "NONE".into());
    let sknt = n("sknt");
    let drct = n("drct");
    let dir_to = match (drct, sknt) {
        (Some(d), Some(k)) if k > 0.0 => Some((d + 180.0) % 360.0),
        _ => None,
    };
    Some(point(
        lon,
        lat,
        json!({
            "nexrad": p["nexrad"], "storm_id": p["storm_id"], "t": ms(&p["valid"]),
            "azimuth": n("azimuth"), "range": n("range"), "range_km": n("range"),
            "tvs": s("tvs"), "meso": s("meso"), "posh": n("posh"), "poh": n("poh"), "max_size": n("max_size"),
            "vil": n("vil"), "max_dbz": n("max_dbz"), "max_dbz_height": n("max_dbz_height"), "top": n("top"),
            "drct": drct, "dir_to": dir_to, "sknt": sknt,
        }),
    ))
}

// ---------- volcanoes (USGS HANS) ----------

const HANS: &str = "https://volcanoes.usgs.gov/hans-public/api/volcano";

/// Every US volcano (USGS list, positions) with its current alert level: elevated ones from
/// getElevatedVolcanoes, the rest from getMonitoredVolcanoes; unmonitored ones get "UNASSIGNED".
pub async fn volcanoes(o: &Overlays) -> Result<Value> {
    let (u_us, u_mon, u_elev) = (format!("{HANS}/getUSVolcanoes"), format!("{HANS}/getMonitoredVolcanoes"), format!("{HANS}/getElevatedVolcanoes"));
    let (us, mon, elev) = tokio::join!(o.disk_cached("usgs_volcanoes.json", Duration::from_secs(86400 * 7), &u_us), o.get_json(&u_mon), o.get_json(&u_elev));
    let us: Value = serde_json::from_slice(&us?)?;
    Ok(fc(merge_volcanoes(&us, &mon.unwrap_or(Value::Null), &elev?)))
}

fn merge_volcanoes(us: &Value, mon: &Value, elev: &Value) -> Vec<Value> {
    let mut level: HashMap<String, &Value> = HashMap::new();
    for v in mon.as_array().into_iter().flatten().chain(elev.as_array().into_iter().flatten()) {
        if let Some(n) = v["vnum"].as_str() {
            level.insert(n.to_string(), v); // elevated list last: it wins
        }
    }
    us.as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let (lat, lon) = (fnum(&v["latitude"])?, fnum(&v["longitude"])?);
            let vnum = v["vnum"].as_str().unwrap_or("");
            let l = level.get(vnum);
            let g = |k: &str| l.and_then(|l| l[k].as_str()).map(|s| s.to_string());
            let obs = g("obs_abbr").or(v["obs_abbr"].as_str().map(|s| s.to_string())).unwrap_or_default();
            Some(point(
                lon,
                lat,
                json!({
                    "name": v["volcano_name"], "vnum": vnum, "region": v["region"], "elev": fnum(&v["elevation_meters"]),
                    "alert": g("alert_level").unwrap_or_else(|| "UNASSIGNED".into()),
                    "color": g("color_code").unwrap_or_else(|| "UNASSIGNED".into()),
                    "obs": obs.to_ascii_uppercase(),
                    "notice_url": g("notice_url"),
                    "updated": l.and_then(|l| l["sent_unixtime"].as_i64()).map(|t| t * 1000),
                    "threat": v["nvews_threat"], "url": v["volcano_url"],
                }),
            ))
        })
        .collect()
}

// ---------- drought ----------

/// Current US Drought Monitor polygons (via IEM): `dm` 0–4 (D0–D4), `date` (map valid date).
pub async fn drought(o: &Overlays) -> Result<Value> {
    let v = o.get_json(&format!("{IEM}/geojson/usdm.py")).await?;
    Ok(fc(drought_features(v)))
}

fn drought_features(mut v: Value) -> Vec<Value> {
    let mut out = vec![];
    for mut f in v["features"].as_array_mut().map(std::mem::take).unwrap_or_default() {
        round_geom(&mut f["geometry"], 3);
        let p = &f["properties"];
        out.push(json!({"type": "Feature", "geometry": f["geometry"], "properties": {"dm": p["dm"], "date": p["date"]}}));
    }
    out
}

// ---------- social vulnerability (CDC SVI) ----------

const SVI: &str = "https://services3.arcgis.com/ZvidGQkLaDJxRSJ2/ArcGIS/rest/services/CDC_ATSDR_Social_Vulnerability_Index_2022_USA/FeatureServer/1";

/// CDC/ATSDR Social Vulnerability Index 2022 by county (simplified shapes, ~3 MB), cached on disk
/// for 30 days. `svi` = overall percentile (0–1, higher = more vulnerable), `t1`..`t4` theme
/// percentiles (socioeconomic, household, minority/language, housing/transport), `pop`.
pub async fn svi(o: &Overlays) -> Result<Value> {
    let p = o.data_dir.join("svi.geojson");
    let fresh = std::fs::metadata(&p).and_then(|m| m.modified()).ok().map(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(86400 * 30)).unwrap_or(false);
    if fresh {
        if let Some(v) = tokio::fs::read(&p).await.ok().and_then(|b| serde_json::from_slice(&b).ok()) {
            return Ok(v);
        }
    }
    match svi_fetch(o).await {
        Ok(v) => {
            tokio::fs::write(&p, serde_json::to_vec(&v)?).await.ok();
            Ok(v)
        }
        Err(e) => match tokio::fs::read(&p).await.ok().and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(v) => {
                tracing::warn!("svi: {e:#}; using cached copy");
                Ok(v)
            }
            None => Err(e),
        },
    }
}

async fn svi_fetch(o: &Overlays) -> Result<Value> {
    let mut feats = vec![];
    let mut off = 0;
    loop {
        let url = format!(
            "{SVI}/query?where=1%3D1&outFields=COUNTY,ST_ABBR,STCNTY,E_TOTPOP,RPL_THEMES,RPL_THEME1,RPL_THEME2,RPL_THEME3,RPL_THEME4\
             &returnGeometry=true&maxAllowableOffset=0.01&geometryPrecision=3&outSR=4326&orderByFields=STCNTY\
             &resultOffset={off}&resultRecordCount=1000&f=geojson"
        );
        let v = o.get_json(&url).await?;
        if let Some(e) = v.get("error") {
            bail!("ArcGIS: {}", e["message"].as_str().unwrap_or("error"));
        }
        let page = v["features"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        let n = page.len();
        feats.extend(page.iter().map(svi_feature));
        let more = v["exceededTransferLimit"].as_bool().or(v["properties"]["exceededTransferLimit"].as_bool()).unwrap_or(false);
        off += n;
        if n == 0 || !more || off > 20_000 {
            break;
        }
    }
    if feats.is_empty() {
        bail!("no counties returned");
    }
    Ok(fc(feats))
}

fn svi_feature(f: &Value) -> Value {
    let p = &f["properties"];
    // -999 marks "no data"
    let r = |k: &str| fnum(&p[k]).filter(|v| *v >= 0.0).map(|v| round_to(v, 4));
    let mut g = f["geometry"].clone();
    round_geom(&mut g, 3);
    json!({"type": "Feature", "geometry": g, "properties": {
        "name": p["COUNTY"], "st": p["ST_ABBR"], "fips": p["STCNTY"], "pop": p["E_TOTPOP"],
        "svi": r("RPL_THEMES"), "t1": r("RPL_THEME1"), "t2": r("RPL_THEME2"), "t3": r("RPL_THEME3"), "t4": r("RPL_THEME4"),
    }})
}

// ---------- NOAA HMS fire & smoke ----------

const HMS: &str = "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS";

/// HMS satellite fire detections (points) or analyst smoke polygons for today (UTC), or yesterday
/// while today's file is still empty.
pub async fn hms(o: &Overlays, kind: &str) -> Result<Value> {
    let today = Utc::now().date_naive();
    let mut last_err = None;
    for d in [today, today - CDuration::days(1)] {
        let (y, m, ymd) = (d.format("%Y"), d.format("%m"), d.format("%Y%m%d"));
        let res = if kind == "smoke" {
            o.get_text(&format!("{HMS}/Smoke_Polygons/KML/{y}/{m}/hms_smoke{ymd}.kml")).await.map(|t| parse_smoke(&t))
        } else {
            o.get_text(&format!("{HMS}/Fire_Points/Text/{y}/{m}/hms_fire{ymd}.txt")).await.map(|t| parse_fire(&t))
        };
        match res {
            Ok(f) if !f.is_empty() => return Ok(fc(f)),
            Ok(_) => {}
            Err(e) => last_err = Some(e),
        }
    }
    match last_err {
        Some(e) => Err(e),
        None => Ok(fc(vec![])),
    }
}

/// "2025213" + "0520" (year, day of year, HHMM UTC) → unix ms.
fn yday_ms(yd: &str, hhmm: &str) -> Option<i64> {
    let (y, d) = (yd.get(..4)?.parse::<i32>().ok()?, yd.get(4..)?.parse::<u32>().ok()?);
    let hhmm = format!("{:0>4}", hhmm.trim());
    let (h, mi) = (hhmm.get(..2)?.parse::<u32>().ok()?, hhmm.get(2..4)?.parse::<u32>().ok()?);
    Some(NaiveDate::from_yo_opt(y, d)?.and_hms_opt(h, mi, 0)?.and_utc().timestamp_millis())
}

/// HMS fire text: `Lon, Lat, YearDay, Time, Satellite, Method, Ecosystem, FRP` (FRP MW, -999 = none).
fn parse_fire(txt: &str) -> Vec<Value> {
    txt.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            if f.len() < 8 {
                return None;
            }
            let (lon, lat) = (num(f[0])?, num(f[1])?);
            let frp = num(f[7]).filter(|v| *v >= 0.0);
            Some(json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round_to(lon, 3), round_to(lat, 3)]},
                "properties": {"sat": f[4], "method": f[5], "frp": frp, "t": yday_ms(f[2], f[3])}}))
        })
        .collect()
}

/// HMS smoke KML: one Placemark per polygon, times/density in the description text
/// ("Start Time: 2025213 1200UTC<br>End Time: 2025213 1430UTC<br>Density: Light<br>Satellite: …").
fn parse_smoke(kml: &str) -> Vec<Value> {
    use quick_xml::events::Event;
    let mut rd = quick_xml::Reader::from_str(kml);
    rd.config_mut().trim_text(true);
    let mut out = vec![];
    let (mut in_pm, mut in_inner) = (false, false);
    let mut field = String::new();
    let mut desc = String::new();
    let mut polys: Vec<Vec<Vec<[f64; 2]>>> = vec![];
    let ring = |s: &str| -> Vec<[f64; 2]> {
        s.split_whitespace()
            .filter_map(|p| {
                let mut it = p.split(',');
                Some([round_to(it.next()?.parse().ok()?, 3), round_to(it.next()?.parse().ok()?, 3)])
            })
            .collect()
    };
    loop {
        match rd.read_event() {
            Ok(Event::Start(e)) => {
                let n = AsRef::<str>::as_ref(&e.local_name()).to_string();
                match n.as_str() {
                    "Placemark" => {
                        in_pm = true;
                        desc.clear();
                        polys.clear();
                    }
                    "innerBoundaryIs" => in_inner = true,
                    _ => {}
                }
                field = n;
            }
            Ok(Event::Text(t)) if in_pm => {
                let s = AsRef::<str>::as_ref(&t).to_string();
                if field == "description" {
                    desc.push_str(&s);
                } else if field == "coordinates" {
                    let r = ring(&s);
                    if r.len() >= 4 {
                        match polys.last_mut() {
                            Some(p) if in_inner => p.push(r),
                            _ => polys.push(vec![r]),
                        }
                    }
                }
            }
            Ok(Event::CData(t)) if in_pm && field == "description" => desc.push_str(AsRef::<str>::as_ref(&t)),
            Ok(Event::End(e)) => {
                match AsRef::<str>::as_ref(&e.local_name()) {
                    "innerBoundaryIs" => in_inner = false,
                    "Placemark" => {
                        in_pm = false;
                        if !polys.is_empty() {
                            let txt = desc.replace("<br>", "\n").replace("<br/>", "\n");
                            let get = |k: &str| txt.lines().find_map(|l| strip_tags(l).split_once(':').filter(|(a, _)| a.trim() == k).map(|(_, b)| b.trim().to_string()));
                            let tm = |k: &str| get(k).and_then(|v| v.split_once(' ').and_then(|(yd, hm)| yday_ms(yd, hm.trim_end_matches("UTC"))));
                            let geom = if polys.len() == 1 { json!({"type": "Polygon", "coordinates": polys[0]}) } else { json!({"type": "MultiPolygon", "coordinates": polys}) };
                            out.push(json!({"type": "Feature", "geometry": geom, "properties": {
                                "density": get("Density"), "sat": get("Satellite"), "t0": tm("Start Time"), "t1": tm("End Time"),
                            }}));
                        }
                    }
                    _ => {}
                }
                field.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut tag = false;
    for c in s.chars() {
        match c {
            '<' => tag = true,
            '>' => tag = false,
            _ if !tag => out.push(c),
            _ => {}
        }
    }
    out
}

// ---------- air quality (AirNow reporting areas) ----------

/// AirNow reporting areas: latest hourly AQI observation per area + pollutant (`kind` "obs") and
/// today's forecast (`kind` "fcst"). No key needed for this file.
pub async fn air_quality(o: &Overlays) -> Result<Value> {
    let t = o.get_text("https://files.airnowtech.org/airnow/today/reportingarea.dat").await?;
    Ok(fc(parse_airnow(&t)))
}

fn aqi_cat(name: &str, aqi: Option<f64>) -> Option<u8> {
    let n = name.to_ascii_lowercase();
    let c = if n.starts_with("good") {
        1
    } else if n.starts_with("moderate") {
        2
    } else if n.contains("sensitive") {
        3
    } else if n.starts_with("unhealthy") {
        4
    } else if n.starts_with("very") {
        5
    } else if n.starts_with("hazardous") {
        6
    } else {
        let a = aqi?;
        [50.0, 100.0, 150.0, 200.0, 300.0].iter().position(|&x| a <= x).map(|i| i as u8 + 1).unwrap_or(6)
    };
    Some(c)
}

/// reportingarea.dat columns: issue date | valid date | valid time | tz | seq | type (F/O/Y) |
/// primary | area | state | lat | lon | parameter | AQI | category | action day | discussion | source
fn parse_airnow(txt: &str) -> Vec<Value> {
    struct Row<'a> {
        f: Vec<&'a str>,
        date: NaiveDate,
    }
    let rows: Vec<Row> = txt
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('|').collect();
            if f.len() < 14 {
                return None;
            }
            let date = NaiveDate::parse_from_str(f[1].trim(), "%m/%d/%y").ok()?;
            Some(Row { f, date })
        })
        .collect();
    // "today" in the file's local dates: the newest observation date
    let today = rows.iter().filter(|r| r.f[5] == "O").map(|r| r.date).max().or_else(|| rows.iter().filter_map(|r| NaiveDate::parse_from_str(r.f[0].trim(), "%m/%d/%y").ok()).max());
    let mut obs: HashMap<String, (NaiveDate, String, usize)> = HashMap::new();
    let mut fcst: HashMap<String, (NaiveDate, usize)> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        let key = format!("{}|{}|{}", r.f[7], r.f[8], r.f[11]);
        match r.f[5] {
            "O" => {
                let tm = r.f[2].trim().to_string();
                let newer = obs.get(&key).map(|(d, t, _)| (r.date, &tm) > (*d, t)).unwrap_or(true);
                if newer {
                    obs.insert(key, (r.date, tm, i));
                }
            }
            "F" if today.map(|t| r.date >= t).unwrap_or(true) => {
                let sooner = fcst.get(&key).map(|(d, _)| r.date < *d).unwrap_or(true);
                if sooner {
                    fcst.insert(key, (r.date, i));
                }
            }
            _ => {}
        }
    }
    let mut idx: Vec<(usize, &str)> = obs.values().map(|v| (v.2, "obs")).chain(fcst.values().filter(|v| Some(v.0) == today || today.is_none()).map(|v| (v.1, "fcst"))).collect();
    idx.sort();
    idx.into_iter()
        .filter_map(|(i, kind)| {
            let r = &rows[i];
            let (lat, lon) = (num(r.f[9])?, num(r.f[10])?);
            let aqi = num(r.f[12]);
            Some(point(
                lon,
                lat,
                json!({
                    "area": r.f[7].trim(), "st": r.f[8].trim(), "aqi": aqi, "cat": aqi_cat(r.f[13].trim(), aqi),
                    "catname": r.f[13].trim(), "param": r.f[11].trim(), "kind": kind, "date": r.date.format("%Y-%m-%d").to_string(),
                    "time": if kind == "obs" { format!("{} {}", r.f[2].trim(), r.f[3].trim()) } else { String::new() },
                    "primary": r.f[6].trim() == "Y",
                    "action_day": r.f.get(14).map(|s| s.trim() == "Yes").unwrap_or(false),
                }),
            ))
        })
        .collect()
}

// ---------- planetary K index ----------

/// G-scale from Kp (Kp 5 = G1 … Kp 9 = G5; thirds rounded, so 5- counts as G1).
fn g_scale(kp: f64) -> String {
    format!("G{}", (kp.round() as i64 - 4).clamp(0, 5))
}

/// 3-hourly Kp rows: either `[{"time_tag":..,"Kp":..}]` or the older `[["time_tag","Kp",..],[..]]`.
fn parse_kp3(v: &Value) -> Vec<(i64, f64)> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let (t, k) = if r.is_array() { (&r[0], &r[1]) } else { (&r["time_tag"], if r["Kp"].is_null() { &r["kp"] } else { &r["Kp"] }) };
            Some((ms(t)?, fnum(k)?))
        })
        .collect()
}

/// SWPC planetary K: latest estimate (1-minute product), its G level, and the 3-hourly series of
/// the last 3 days. `{kp, t, g, series: [[ms, kp], …], kp3h, t3h}`
pub async fn kp(o: &Overlays) -> Result<Value> {
    let (k3, k1) = tokio::join!(
        o.get_json("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"),
        o.get_json("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json"),
    );
    let series = parse_kp3(&k3?);
    let latest1 = k1.ok().and_then(|v| v.as_array().and_then(|a| a.iter().rev().find_map(|r| Some((ms(&r["time_tag"])?, fnum(&r["estimated_kp"]).or(fnum(&r["kp_index"]))?)))));
    Ok(kp_json(series, latest1))
}

fn kp_json(series: Vec<(i64, f64)>, latest1: Option<(i64, f64)>) -> Value {
    let last3 = series.last().copied();
    let cut = last3.map(|l| l.0 - 3 * 86_400_000).unwrap_or(0);
    let (t, k) = match (latest1, last3) {
        (Some(a), Some(b)) if a.0 >= b.0 => a,
        (_, Some(b)) => b,
        (Some(a), None) => a,
        (None, None) => return json!({"kp": null, "t": null, "g": "G0", "series": []}),
    };
    json!({
        "kp": k, "t": t, "g": g_scale(k),
        "kp3h": last3.map(|l| l.1), "t3h": last3.map(|l| l.0),
        "series": series.iter().filter(|s| s.0 >= cut).map(|s| json!([s.0, s.1])).collect::<Vec<_>>(),
    })
}

// ---------- ATCF model tracks ----------

struct Track {
    tech: String,
    init: i64,
    /// (tau h, lat, lon, vmax kt, mslp mb)
    pts: Vec<(i64, f64, f64, Option<i64>, Option<i64>)>,
}

/// Model family for coloring spaghetti plots.
pub fn model_kind(tech: &str) -> &'static str {
    let t = tech.to_ascii_uppercase();
    let numbered = |p: &[&str]| t.len() == 4 && t.is_ascii() && p.iter().any(|x| t.starts_with(x)) && t[2..].chars().all(|c| c.is_ascii_digit());
    match t.as_str() {
        "OFCL" | "OFCI" | "OFC2" | "JTWC" | "JTWI" => "official",
        "TVCN" | "TVCA" | "TVCE" | "TVCX" | "TVCC" | "TVDG" | "IVCN" | "IVCR" | "IVDR" | "HCCA" | "FSSE" | "GFEX" | "ICON" | "RVCN" | "TCON" | "TCCN" | "CONU" | "GUNA" | "CGUN" | "NNIC" | "NNIB" | "CTCI" | "IVRI" => "consensus",
        "CLP5" | "CLIP" | "TCLP" | "SHIP" | "DSHP" | "LGEM" | "SHF5" | "DSF5" | "OCD5" | "XTRP" | "BAMS" | "BAMM" | "BAMD" | "DRCL" | "SHFR" | "SSHP" | "RI25" | "RI30" | "RI35" | "RI40" | "MRCL" | "TABS" | "TABM" | "TABD" | "LBAR" => "statistical",
        _ if numbered(&["AP", "AC", "EN", "EP", "EE", "CP", "NP", "UE", "UK", "CC", "NC"]) => "ensemble",
        "AEMN" | "AEMI" | "AEM2" | "EEMN" | "EMN2" | "EMNI" | "CEMN" | "CEMI" | "CEM2" | "NEMN" | "NEMI" | "UEMN" | "UEMI" => "ensemble",
        _ => "dynamical",
    }
}

/// "345N" / "851W" (tenths of a degree) → degrees.
fn atcf_ll(s: &str) -> Option<f64> {
    let s = s.trim();
    let (n, h) = s.split_at(s.len().checked_sub(1)?);
    let v = n.parse::<f64>().ok()? / 10.0;
    match h {
        "N" | "E" => Some(v),
        "S" | "W" => Some(-v),
        _ => None,
    }
}

/// a-deck lines → newest run of each model (wind-radii repeats and CARQ/WRNG dropped). Runs more
/// than 24 h older than the newest one in the file are left out (stale models).
fn parse_adeck(r: impl BufRead) -> Vec<Track> {
    let mut by: HashMap<String, Track> = HashMap::new();
    for line in r.lines().map_while(|l| l.ok()) {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.len() < 8 {
            continue;
        }
        let tech = f[4];
        if tech.is_empty() || tech == "CARQ" || tech == "WRNG" {
            continue;
        }
        let Some(init) = NaiveDateTime::parse_from_str(&format!("{}00", f[2]), "%Y%m%d%H%M").ok().map(|d| d.and_utc().timestamp_millis()) else { continue };
        let (Ok(tau), Some(lat), Some(lon)) = (f[5].parse::<i64>(), atcf_ll(f[6]), atcf_ll(f[7])) else { continue };
        if lat == 0.0 && lon == 0.0 {
            continue;
        }
        let pos = |i: usize| f.get(i).and_then(|s| s.parse::<i64>().ok()).filter(|v| *v > 0);
        let t = by.entry(tech.to_string()).or_insert_with(|| Track { tech: tech.to_string(), init, pts: vec![] });
        if init > t.init {
            t.init = init;
            t.pts.clear();
        } else if init < t.init {
            continue;
        }
        if t.pts.iter().any(|p| p.0 == tau) {
            continue;
        }
        t.pts.push((tau, lat, lon, pos(8), pos(9)));
    }
    let newest = by.values().map(|t| t.init).max().unwrap_or(0);
    let mut v: Vec<Track> = by.into_values().filter(|t| t.init >= newest - 86_400_000).collect();
    for t in v.iter_mut() {
        t.pts.sort_by_key(|p| p.0);
    }
    v.sort_by(|a, b| a.tech.cmp(&b.tech));
    v
}

fn track_features(storm: &str, name: &str, tracks: &[Track]) -> Vec<Value> {
    let mut out = vec![];
    for t in tracks {
        let base = json!({"storm": storm, "name": name, "tech": t.tech, "init": t.init, "kind": model_kind(&t.tech)});
        if t.pts.len() >= 2 {
            let coords: Vec<Value> = t.pts.iter().map(|p| json!([round_to(p.2, 2), round_to(p.1, 2)])).collect();
            out.push(json!({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": base}));
        }
        for p in t.pts.iter().filter(|p| p.0 % 12 == 0) {
            let mut props = base.clone();
            props["tau"] = json!(p.0);
            props["vmax"] = json!(p.3);
            props["mslp"] = json!(p.4);
            out.push(json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round_to(p.2, 2), round_to(p.1, 2)]}, "properties": props}));
        }
    }
    out
}

/// Model tracks ("spaghetti") for active NHC/CPHC storms from the public ATCF a-decks.
/// `storm` (e.g. "AL09") limits it to one storm.
pub async fn atcf(o: &Overlays, storm: &str) -> Result<Value> {
    let cur = o.get_json("https://www.nhc.noaa.gov/CurrentStorms.json").await?;
    let want = storm.trim().to_ascii_uppercase();
    let storms: Vec<(String, String)> = cur["activeStorms"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let id = s["id"].as_str()?.to_ascii_lowercase();
            (id.len() == 8 && id.is_ascii()).then(|| (id, s["name"].as_str().unwrap_or("").to_string()))
        })
        .filter(|(id, _)| want.is_empty() || id[..4].eq_ignore_ascii_case(&want))
        .collect();
    let urls: Vec<String> = storms.iter().map(|(id, _)| format!("https://ftp.nhc.noaa.gov/atcf/aid_public/a{id}.dat.gz")).collect();
    let res = futures::future::join_all(urls.iter().map(|u| o.get_bytes(u))).await;
    let mut feats = vec![];
    for ((id, name), r) in storms.iter().zip(res) {
        let b = match r {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("atcf {id}: {e:#}");
                continue;
            }
        };
        let tracks = if b.starts_with(&[0x1f, 0x8b]) { parse_adeck(std::io::BufReader::new(flate2::read::MultiGzDecoder::new(&b[..]))) } else { parse_adeck(&b[..]) };
        feats.extend(track_features(&id[..4].to_ascii_uppercase(), name, &tracks));
    }
    Ok(fc(feats))
}

// ---------- Raspberry Shake stations ----------

/// Public Raspberry Shake stations (network AM) still operating, from the FDSN station service
/// (cached on disk for a day).
pub async fn shake_stations(o: &Overlays) -> Result<Value> {
    let today = Utc::now().format("%Y-%m-%d");
    let url = format!("{}/fdsnws/station/1/query?network=AM&level=station&format=text&endafter={today}", crate::shake::FDSN);
    let b = o.disk_cached("shake_stations.txt", Duration::from_secs(86400), &url).await?;
    Ok(fc(parse_fdsn_stations(&String::from_utf8_lossy(&b))))
}

/// FDSN station text: `Network|Station|Latitude|Longitude|Elevation|SiteName|StartTime|EndTime`.
fn parse_fdsn_stations(txt: &str) -> Vec<Value> {
    txt.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let f: Vec<&str> = l.split('|').collect();
            if f.len() < 8 {
                return None;
            }
            let (lat, lon) = (num(f[2])?, num(f[3])?);
            let s = |i: usize| f[i].trim();
            Some(point(lon, lat, json!({"net": s(0), "sta": s(1), "name": s(5), "elev": num(f[4]), "start": s(6), "end": if s(7).is_empty() { Value::Null } else { json!(s(7)) }})))
        })
        .collect()
}

// ---------- TomTom traffic ----------

/// Small in-memory cache for proxied traffic tiles/incidents (bytes-capped, short-lived).
pub struct TileCache {
    inner: Mutex<(lru::LruCache<String, (Instant, Bytes)>, usize)>,
}

const TILE_CACHE_BYTES: usize = 32 * 1024 * 1024;
const TILE_TTL: Duration = Duration::from_secs(120);

impl Default for TileCache {
    fn default() -> Self {
        Self { inner: Mutex::new((lru::LruCache::unbounded(), 0)) }
    }
}

impl TileCache {
    fn get(&self, k: &str) -> Option<Bytes> {
        let mut g = self.inner.lock();
        match g.0.get(k) {
            Some((t, b)) if t.elapsed() < TILE_TTL => Some(b.clone()),
            _ => None,
        }
    }
    fn put(&self, k: String, b: Bytes) {
        let mut g = self.inner.lock();
        let n = b.len();
        if let Some((_, old)) = g.0.put(k, (Instant::now(), b)) {
            g.1 -= old.len();
        }
        g.1 += n;
        while g.1 > TILE_CACHE_BYTES {
            match g.0.pop_lru() {
                Some((_, (_, old))) => g.1 -= old.len(),
                None => break,
            }
        }
    }
}

pub const TRAFFIC_STYLES: &[&str] = &["relative0", "relative0-dark", "absolute", "relative-delay", "relative", "reduced-sensitivity"];

/// One TomTom traffic-flow raster tile (PNG, 256 px).
pub async fn traffic_tile(o: &Overlays, key: &str, style: &str, z: u32, x: u32, y: u32) -> Result<Bytes> {
    let ck = format!("{style}/{z}/{x}/{y}");
    if let Some(b) = o.tiles.get(&ck) {
        return Ok(b);
    }
    let url = format!("https://api.tomtom.com/traffic/map/4/tile/flow/{style}/{z}/{x}/{y}.png?key={key}&tileSize=256");
    // errors must not echo the URL: it carries the key
    let r = o.http.get(&url).timeout(Duration::from_secs(20)).send().await.map_err(|e| anyhow!("TomTom: {}", e.without_url()))?;
    if !r.status().is_success() {
        bail!("HTTP {} from api.tomtom.com", r.status());
    }
    let b = r.bytes().await.map_err(|e| anyhow!("TomTom: {}", e.without_url()))?;
    o.tiles.put(ck, b.clone());
    Ok(b)
}

/// TomTom incidents in a bbox (w,s,e,n; TomTom allows ≤ 10,000 km²) as GeoJSON: LineString/Point
/// features with `category` (TomTom iconCategory), `magnitude` 0–4, `desc`, `from`, `to`,
/// `delay` s, `length` m, `start`/`end` ISO, `roads`.
pub async fn traffic_incidents(o: &Overlays, key: &str, bbox: [f64; 4]) -> Result<Value> {
    let bb = bbox.iter().map(|v| format!("{v:.4}")).collect::<Vec<_>>().join(",");
    let ck = format!("inc:{bb}");
    if let Some(b) = o.tiles.get(&ck) {
        return Ok(serde_json::from_slice(&b)?);
    }
    let fields = "{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description},startTime,endTime,from,to,length,delay,roadNumbers}}}";
    let url = format!("https://api.tomtom.com/traffic/services/5/incidentDetails?key={key}&bbox={bb}&fields={}&language=en-US&timeValidityFilter=present", fields.replace('{', "%7B").replace('}', "%7D").replace(',', "%2C"));
    let r = o.http.get(&url).timeout(Duration::from_secs(20)).send().await.map_err(|e| anyhow!("TomTom: {}", e.without_url()))?;
    if !r.status().is_success() {
        bail!("HTTP {} from api.tomtom.com", r.status());
    }
    let v: Value = r.json().await.map_err(|e| anyhow!("TomTom: {}", e.without_url()))?;
    let out = fc(v["incidents"].as_array().into_iter().flatten().map(incident_feature).collect());
    o.tiles.put(ck, Bytes::from(serde_json::to_vec(&out)?));
    Ok(out)
}

fn incident_feature(i: &Value) -> Value {
    let p = &i["properties"];
    let desc: Vec<&str> = p["events"].as_array().into_iter().flatten().filter_map(|e| e["description"].as_str()).collect();
    json!({"type": "Feature", "geometry": i["geometry"], "properties": {
        "category": p["iconCategory"], "magnitude": p["magnitudeOfDelay"], "desc": desc.join("; "),
        "from": p["from"], "to": p["to"], "delay": p["delay"], "length": p["length"],
        "start": p["startTime"], "end": p["endTime"], "roads": p["roadNumbers"],
    }})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times() {
        assert_eq!(parse_time("2024-05-21T20:00Z").unwrap().timestamp(), 1716321600);
        assert_eq!(parse_time("2024-05-21T20:00:00Z").unwrap().timestamp(), 1716321600);
        assert_eq!(parse_time("1716321600000").unwrap().timestamp(), 1716321600);
        assert_eq!(parse_time("2026-10-04T03:00:00").unwrap().timestamp(), 1791082800);
        assert!(window("2024-05-21T20:00Z", "2024-05-21T19:00Z", 7).is_err());
        let (a, b) = window("2024-05-01T00:00Z", "2024-05-21T00:00Z", 7).unwrap();
        assert_eq!((b - a).num_days(), 7);
    }

    #[test]
    fn sbw() {
        let f: Value = serde_json::from_str(r#"{"type": "Feature", "id": "DMX.TO.W.0042.2024-05-21T20:03:00Z", "properties": {"status": "CON", "phenomena": "TO", "significance": "W", "ps": "Tornado Warning", "wfo": "DMX", "eventid": 42, "polygon_begin": "2024-05-21T20:20:00Z", "polygon_end": "2024-05-21T20:45:00Z", "expire": "2024-05-21T20:45:00Z", "hvtec_nwsli": "00000", "year": 2024, "product_id": "202405212020-KDMX-WWUS53-SVSDMX", "issue": "2024-05-21T20:03:00Z", "expire_utc": "2024-05-21T20:45:00Z", "href": "https://mesonet.agron.iastate.edu/vtec/?year=2024", "windtag": null, "hailtag": 1.75, "tornadotag": "OBSERVED", "damagetag": "CONSIDERABLE", "waterspouttag": null, "is_emergency": false, "is_pds": true, "windthreat": null, "hailthreat": "RADAR INDICATED", "squalltag": null, "max_windtag": null, "max_hailtag": 1.75, "floodtag_damage": null}, "geometry": {"type": "MultiPolygon", "coordinates": [[[[-94.5, 41.2], [-94.3, 41.3], [-94.2, 41.2], [-94.5, 41.2]]]]}}"#).unwrap();
        let o = sbw_feature(&f).unwrap();
        let p = &o["properties"];
        assert_eq!(p["event"], "Tornado Warning");
        assert_eq!(p["senderName"], "NWS DMX");
        assert_eq!(p["t0"], 1716322800000i64);
        assert_eq!(p["t1"], 1716324300000i64);
        assert_eq!(p["sent"], "2024-05-21T20:03:00Z");
        assert_eq!(p["expires"], "2024-05-21T20:45:00Z");
        assert_eq!(p["parameters"]["tornadoDetection"][0], "OBSERVED");
        assert_eq!(p["parameters"]["maxHailSize"][0], "1.75");
        assert_eq!(p["parameters"]["tornadoDamageThreat"][0], "CONSIDERABLE");
        assert_eq!(p["flags"]["pds"], true);
        assert_eq!(p["flags"]["tornado_damage_threat"], "CONSIDERABLE");
        assert_eq!(p["messageType"], "Update");
        assert!(p["id"].as_str().unwrap().starts_with("DMX-TO-W-42-2024-"));
        assert_eq!(vtec_event("SQ", "W"), "Snow Squall Warning");
        assert_eq!(vtec_event("MA", "W"), "Special Marine Warning");
        assert_eq!(vtec_event("ZZ", "Y"), "ZZ Advisory");
        // wind tag as a number of mph
        let mut g = f.clone();
        g["properties"]["phenomena"] = json!("SV");
        g["properties"]["ps"] = json!("");
        g["properties"]["windtag"] = json!(70.0);
        g["properties"]["damagetag"] = json!("DESTRUCTIVE");
        let p = sbw_feature(&g).unwrap()["properties"].clone();
        assert_eq!(p["event"], "Severe Thunderstorm Warning");
        assert_eq!(p["parameters"]["maxWindGust"][0], "70 MPH");
        assert_eq!(p["parameters"]["thunderstormDamageThreat"][0], "DESTRUCTIVE");
    }

    #[test]
    fn lsr() {
        let f: Value = serde_json::from_str(r#"{"type":"Feature","id":"0","properties":{"valid":"2024-05-21T20:50:00Z","type":"H","magnitude":0.88,"magf":0.88,"city":"Algona","county":"Kossuth","st":"IA","source":"Emergency Mngr","remark":null,"wfo":"DMX","typetext":"HAIL","unit":"INCH","qualifier":"E"},"geometry":{"type":"Point","coordinates":[-94.23,43.07]}}"#).unwrap();
        let p = lsr_feature(&f)["properties"].clone();
        assert_eq!(p["mag"], 0.88);
        assert_eq!(p["t"], 1716324600000i64);
        assert_eq!(p["typetext"], "HAIL");
    }

    #[test]
    fn watches() {
        let spans = vec![(0, 7 * 3_600_000), (3_600_000, 8 * 3_600_000), (10 * 3_600_000, 16 * 3_600_000)];
        let s = watch_samples(spans);
        assert_eq!(s, vec![3_600_000, 11 * 3_600_000]);
        let list = vec![(
            1716315000000,
            1716343380000,
            json!({"year": 2024, "num": 277, "type": "TOR", "issue": "2024-05-21T18:10:00Z", "expire": "2024-05-22T02:03:00Z", "product_id_sel": "x", "tornadoes_1m_strong": 40, "hail_1m_2inch": 30, "max_hail_size": 2.0, "max_wind_gust_knots": 60.0, "is_pds": false}),
        )];
        let outl = vec![json!({"type": "Feature", "properties": {"sel": "SEL7", "utc_issued": "2024-05-21T18:10:00Z", "utc_expired": "2024-05-22T02:03:00Z", "type": "TOR", "num": 277}, "geometry": {"type": "MultiPolygon", "coordinates": []}})];
        let m = merge_watches(&list, &outl);
        assert_eq!(m.len(), 1);
        let p = &m[0]["properties"];
        assert_eq!(p["sel"], "SEL7");
        assert_eq!(p["prob_sigtor"], 40);
        assert_eq!(p["issue"], "2024-05-21T18:10:00Z");
        assert_eq!(p["t1"], 1716343380000i64);
        assert!(p.get("product_id_sel").is_none());
    }

    #[test]
    fn mcds() {
        let v: Value = serde_json::from_str(r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"product_id":"202405202254-KWNS-ACUS11-SWOMCD","year":2024,"num":855,"issue":"2024-05-20T22:54:00Z","expire":"2024-05-21T01:00:00Z","watch_confidence":40.0,"concerning":"SEVERE POTENTIAL...WATCH POSSIBLE"},"geometry":null},{"type":"Feature","properties":{"num":856,"issue":"2024-05-21T05:00:00Z","expire":"2024-05-21T07:00:00Z"},"geometry":null}]}"#).unwrap();
        let a = parse_time("2024-05-21T00:00Z").unwrap().timestamp_millis();
        let b = parse_time("2024-05-21T04:00Z").unwrap().timestamp_millis();
        let f = mcd_filter(&v, a, b);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0]["properties"]["num"], 855);
        assert_eq!(f[0]["properties"]["t0"], 1716245640000i64);
    }

    #[test]
    fn storm_attrs() {
        let f: Value = serde_json::from_str(r#"{"type":"Feature","id":0,"properties":{"nexrad":"ABR","storm_id":"H8","azimuth":114,"range":122,"tvs":"NONE","meso":"5","posh":10,"poh":40,"max_size":0.75,"vil":7,"max_dbz":49,"max_dbz_height":9.3,"top":12.4,"drct":211,"sknt":12,"valid":"2024-05-21T20:28:45Z"},"geometry":{"type":"Point","coordinates":[-96.983,45.01]}}"#).unwrap();
        let p = storm_feature(&f).unwrap()["properties"].clone();
        assert_eq!(p["dir_to"], 31.0);
        assert_eq!(p["range_km"], 122.0);
        assert_eq!(p["meso"], "5");
        assert_eq!(p["t"], 1716323325000i64);
        let mut g = f.clone();
        g["properties"]["sknt"] = json!(0);
        assert!(storm_feature(&g).unwrap()["properties"]["dir_to"].is_null());
    }

    #[test]
    fn volcano_merge() {
        let us = json!([{"obs_abbr":"avo","vnum":"311120","volcano_name":"Great Sitkin","region":"Alaska","latitude":52.0765,"longitude":-176.1109,"elevation_meters":1740,"nvews_threat":"High"},
                        {"obs_abbr":"cvo","vnum":"321050","volcano_name":"Mount St. Helens","latitude":"46.2","longitude":"-122.18","elevation_meters":2549},
                        {"obs_abbr":"avo","vnum":"999","volcano_name":"Nowhere","latitude":55.0,"longitude":-160.0}]);
        let mon = json!([{"vnum":"321050","alert_level":"NORMAL","color_code":"GREEN","obs_abbr":"cvo","sent_unixtime":1700000000,"notice_url":"u1"},{"vnum":"311120","alert_level":"NORMAL","color_code":"GREEN"}]);
        let elev = json!([{"vnum":"311120","alert_level":"WATCH","color_code":"ORANGE","obs_abbr":"avo","sent_unixtime":1791749898,"notice_url":"u2"}]);
        let f = merge_volcanoes(&us, &mon, &elev);
        assert_eq!(f.len(), 3);
        assert_eq!(f[0]["properties"]["alert"], "WATCH");
        assert_eq!(f[0]["properties"]["color"], "ORANGE");
        assert_eq!(f[0]["properties"]["updated"], 1791749898000i64);
        assert_eq!(f[1]["properties"]["alert"], "NORMAL");
        assert_eq!(f[1]["properties"]["obs"], "CVO");
        assert_eq!(f[2]["properties"]["alert"], "UNASSIGNED");
    }

    #[test]
    fn drought_round() {
        let v = json!({"type":"FeatureCollection","features":[{"id":0,"properties":{"date":"2026-10-06","dm":0},"geometry":{"type":"MultiPolygon","coordinates":[[[[-65.732587881,18.153899156],[-65.73259,18.15391],[-65.8,18.2],[-65.9,18.1],[-65.732587881,18.153899156]]]]}}]});
        let f = drought_features(v);
        assert_eq!(f[0]["properties"]["dm"], 0);
        let ring = &f[0]["geometry"]["coordinates"][0][0];
        assert_eq!(ring[0], json!([-65.733, 18.154]));
        assert_eq!(ring.as_array().unwrap().len(), 4); // repeated point after rounding dropped
    }

    #[test]
    fn svi_props() {
        let f = json!({"type":"Feature","properties":{"COUNTY":"Autauga County","ST_ABBR":"AL","STCNTY":"01001","E_TOTPOP":58761,"RPL_THEMES":0.5254,"RPL_THEME1":0.3,"RPL_THEME2":-999,"RPL_THEME3":0.6,"RPL_THEME4":0.7},"geometry":{"type":"Polygon","coordinates":[[[-86.9,32.6],[-86.4,32.6],[-86.4,32.3],[-86.9,32.6]]]}});
        let p = svi_feature(&f)["properties"].clone();
        assert_eq!(p["name"], "Autauga County");
        assert_eq!(p["svi"], 0.5254);
        assert!(p["t2"].is_null());
        assert_eq!(p["pop"], 58761);
    }

    #[test]
    fn hms_fire() {
        let t = "        Lon,        Lat, YearDay, Time,       Satellite,           Method, Ecosystem,        FRP\n -70.842628,  18.924887, 2025213, 0520,       SUOMI NPP,            VIIRS,        41,      2.682\n -71.056797,  19.095408, 2025213, 0543,         NOAA 20,         ANALYSIS,        13,   -999.000\n";
        let f = parse_fire(t);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0]["properties"]["sat"], "SUOMI NPP");
        assert_eq!(f[0]["properties"]["frp"], 2.682);
        assert!(f[1]["properties"]["frp"].is_null());
        assert_eq!(f[0]["properties"]["t"], 1754025600000i64);
        assert_eq!(f[0]["geometry"]["coordinates"], json!([-70.843, 18.925]));
    }

    #[test]
    fn hms_smoke() {
        let k = r##"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>HMS Smoke Mapping-20250801</name>
<Folder><name>Smoke (Light)</name>
<Placemark><description><![CDATA[<div style="width:170px;">Start Time: 2025213 1200UTC<br>End Time: 2025213 1430UTC<br>Density: Light<br>Satellite: GOES-WEST</div>]]></description>
<styleUrl>#Smoke_Light_style</styleUrl><Polygon><tessellate>1</tessellate><gx:drawOrder>0</gx:drawOrder><outerBoundaryIs><LinearRing><coordinates>
-115.017360,56.192694,0 -115.128720,56.225449,0 -115.473740,56.371754,0 -115.017360,56.192694,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><description><![CDATA[Start Time: 2025213 1700UTC<br>End Time: 2025213 2330UTC<br>Density: Heavy<br>Satellite: GOES-EAST]]></description>
<Polygon><outerBoundaryIs><LinearRing><coordinates>-100,40,0 -99,40,0 -99,41,0 -100,40,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder></Document></kml>"##;
        let f = parse_smoke(k);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0]["properties"]["density"], "Light");
        assert_eq!(f[0]["properties"]["sat"], "GOES-WEST");
        assert_eq!(f[0]["properties"]["t0"], 1754049600000i64);
        assert_eq!(f[0]["properties"]["t1"], 1754058600000i64);
        assert_eq!(f[0]["geometry"]["type"], "Polygon");
        assert_eq!(f[0]["geometry"]["coordinates"][0][0], json!([-115.017, 56.193]));
        assert_eq!(f[1]["properties"]["density"], "Heavy");
    }

    #[test]
    fn airnow() {
        let t = "10/12/26|10/12/26|09:00|PDT|0|O|Y|Bakersfield|CA|35.3733|-119.0187|PM2.5|61|Moderate|No||San Joaquin Valley APCD\n\
10/12/26|10/12/26|10:00|PDT|0|O|Y|Bakersfield|CA|35.3733|-119.0187|PM2.5|72|Moderate|No||San Joaquin Valley APCD\n\
10/12/26|10/12/26|10:00|PDT|0|O|N|Bakersfield|CA|35.3733|-119.0187|OZONE|30|Good|No||San Joaquin Valley APCD\n\
10/12/26|10/11/26||| -1|Y|Y|Bakersfield|CA|35.3733|-119.0187|PM2.5|80|Moderate|No||x\n\
10/12/26|10/12/26|||0|F|Y|Bakersfield|CA|35.3733|-119.0187|PM2.5|105|Unhealthy for Sensitive Groups|Yes|Smoke.|x\n\
10/12/26|10/13/26|||1|F|Y|Bakersfield|CA|35.3733|-119.0187|PM2.5|90|Moderate|No||x\n";
        let f = parse_airnow(t);
        assert_eq!(f.len(), 3);
        let pm = f.iter().find(|x| x["properties"]["kind"] == "obs" && x["properties"]["param"] == "PM2.5").unwrap();
        assert_eq!(pm["properties"]["aqi"], 72.0);
        assert_eq!(pm["properties"]["cat"], 2);
        let fc_ = f.iter().find(|x| x["properties"]["kind"] == "fcst").unwrap();
        assert_eq!(fc_["properties"]["cat"], 3);
        assert_eq!(fc_["properties"]["date"], "2026-10-12");
        assert_eq!(fc_["properties"]["action_day"], true);
    }

    #[test]
    fn kp_parse() {
        let v: Value = serde_json::from_str(r#"[{"time_tag":"2026-10-04T00:00:00","Kp":3.00,"a_running":15,"station_count":8},{"time_tag":"2026-10-11T12:00:00","Kp":2.33},{"time_tag":"2026-10-11T15:00:00","Kp":5.67}]"#).unwrap();
        let s = parse_kp3(&v);
        assert_eq!(s.len(), 3);
        let old: Value = serde_json::from_str(r#"[["time_tag","Kp","a_running","station_count"],["2026-10-11 15:00:00.000","4.67","9","8"]]"#).unwrap();
        assert_eq!(parse_kp3(&old), vec![(parse_time("2026-10-11T15:00Z").unwrap().timestamp_millis(), 4.67)]);
        let j = kp_json(s, None);
        assert_eq!(j["kp"], 5.67);
        assert_eq!(j["g"], "G2");
        assert_eq!(j["series"].as_array().unwrap().len(), 2); // only the last 3 days
        let j = kp_json(parse_kp3(&v), Some((parse_time("2026-10-11T16:30Z").unwrap().timestamp_millis(), 3.0)));
        assert_eq!(j["kp"], 3.0);
        assert_eq!(j["g"], "G0");
        assert_eq!(j["kp3h"], 5.67);
        assert_eq!(g_scale(4.67), "G1");
        assert_eq!(g_scale(9.0), "G5");
    }

    #[test]
    fn adeck() {
        let t = "AL, 09, 2026100906, 03, OFCL,   0, 280N,  880W,  50, 1000, TS\n\
AL, 09, 2026100912, 03, OFCL,   0, 285N,  875W,  55,  998, TS,  34, NEQ,  100,   80,   50,   90\n\
AL, 09, 2026100912, 03, OFCL,   0, 285N,  875W,  55,  998, TS,  50, NEQ,   40,   30,    0,   20\n\
AL, 09, 2026100912, 03, OFCL,  12, 300N,  870W,  65,  990, HU,  34, NEQ,  100,   80,   50,   90\n\
AL, 09, 2026100912, 03, OFCL,  24, 320N,  860W,  70,  985, HU\n\
AL, 09, 2026100912, 01, CARQ,   0, 285N,  875W,  55,  998, TS\n\
AL, 09, 2026100912, 03, AP05,   0, 285N,  875W,  55,    0, TS\n\
AL, 09, 2026100912, 03, AP05,   6, 290N,  873W,  55,    0, TS\n\
AL, 09, 2026100912, 03, TVCN,   0, 285N,  875W,   0,    0, XX\n\
AL, 09, 2026100912, 03, TVCN,  12, 301N,  869W,   0,    0, XX\n\
AL, 09, 2026100700, 03, OLDM,  12, 301N,  869W,   0,    0, XX\n";
        let tr = parse_adeck(t.as_bytes());
        let techs: Vec<&str> = tr.iter().map(|t| t.tech.as_str()).collect();
        assert_eq!(techs, vec!["AP05", "OFCL", "TVCN"]);
        let ofcl = tr.iter().find(|t| t.tech == "OFCL").unwrap();
        assert_eq!(ofcl.pts.len(), 3);
        assert_eq!(ofcl.pts[1], (12, 30.0, -87.0, Some(65), Some(990)));
        assert_eq!(ofcl.init, parse_time("2026-10-09T12:00Z").unwrap().timestamp_millis());
        let f = track_features("AL09", "ISAIAS", &tr);
        // 3 lines + OFCL taus 0/12/24 + AP05 tau 0 + TVCN 0/12
        assert_eq!(f.len(), 9);
        let l = f.iter().find(|x| x["properties"]["tech"] == "OFCL" && x["geometry"]["type"] == "LineString").unwrap();
        assert_eq!(l["properties"]["kind"], "official");
        assert_eq!(l["geometry"]["coordinates"][0], json!([-87.5, 28.5]));
        assert_eq!(model_kind("AP05"), "ensemble");
        assert_eq!(model_kind("TVCN"), "consensus");
        assert_eq!(model_kind("SHIP"), "statistical");
        assert_eq!(model_kind("HAFA"), "dynamical");
        assert_eq!(model_kind("AEMN"), "ensemble");
        assert!(atcf_ll("1234E") == Some(123.4) && atcf_ll("50S") == Some(-5.0));
    }

    #[test]
    fn fdsn_stations() {
        let t = "#Network|Station|Latitude|Longitude|Elevation|SiteName|StartTime|EndTime\nAM|R000D|37.62162162162162|-122.43223759547045|120.0|Raspberry Shake Citizen Science Station|2026-10-05T03:00:14.373|\nAM|R0038|46.5045045045045|7.304520133546625|1279.0|Raspberry Shake Citizen Science Station|2022-04-14T15:59:59.505|2030-01-01T00:00:00\n";
        let f = parse_fdsn_stations(t);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0]["properties"]["sta"], "R000D");
        assert!(f[0]["properties"]["end"].is_null());
        assert_eq!(f[1]["properties"]["elev"], 1279.0);
    }

    #[test]
    fn tile_cache_cap() {
        let c = TileCache::default();
        for i in 0..40 {
            c.put(format!("k{i}"), Bytes::from(vec![0u8; 1024 * 1024]));
        }
        assert!(c.inner.lock().1 <= TILE_CACHE_BYTES);
        assert!(c.get("k39").is_some());
        assert!(c.get("k0").is_none());
    }
}
