//! Hazard / emergency overlays: USGS ShakeMap contours (`shakemap`), NOAA tsunami messages
//! (`tsunami`), FEMA open shelters (`shelters`), hospitals (`hospitals`) and cooling / warming
//! centres from OpenStreetMap (`centers`).

use super::agsquery::{self, parse_bbox, Query};
use super::{fc, point, Overlays};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

// ---------- ShakeMap ----------

const USGS_DETAIL: &str = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail";
const USGS_SIGNIFICANT: &str = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson";
const USGS_45: &str = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson";

fn valid_event_id(s: &str) -> bool {
    (4..=20).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Contour features of one event's ShakeMap (`kind` = mmi | pga | pgv) plus an epicentre point.
pub async fn shakemap_event(o: &Overlays, id: &str, kind: &str) -> Result<Vec<Value>> {
    if !valid_event_id(id) {
        bail!("bad event id");
    }
    let d = o.get_json(&format!("{USGS_DETAIL}/{id}.geojson")).await?;
    let p = &d["properties"];
    let sm = &p["products"]["shakemap"][0];
    if sm.is_null() {
        bail!("event {id} has no ShakeMap");
    }
    let file = format!("download/cont_{kind}.json");
    let url = sm["contents"][&file]["url"].as_str().ok_or_else(|| anyhow!("ShakeMap for {id} has no {file}"))?;
    let c = o.get_json(url).await?;
    let sp = &sm["properties"];
    let num = |k: &str| sp[k].as_str().and_then(|s| s.parse::<f64>().ok()).or(sp[k].as_f64());
    let mut out = vec![];
    for mut f in c["features"].as_array().cloned().unwrap_or_default() {
        let fp = f["properties"].take();
        f["properties"] = json!({"kind": "contour", "event": id, "value": fp["value"], "units": fp["units"], "color": fp["color"], "weight": fp["weight"], "param": kind});
        out.push(f);
    }
    let g = &d["geometry"]["coordinates"];
    if let (Some(lon), Some(lat)) = (g[0].as_f64(), g[1].as_f64()) {
        out.push(point(lon, lat, json!({"kind": "epicenter", "event": id, "mag": p["mag"], "place": p["place"], "time": p["time"], "depth_km": g[2], "url": p["url"], "tsunami": p["tsunami"], "alert": p["alert"], "maxmmi": num("maxmmi"), "maxpga": num("maxpga"), "maxpgv": num("maxpgv")})));
    }
    Ok(out)
}

/// `event=<id>` or the newest `n` (default 5, max 10) significant events of the month that have a
/// ShakeMap (`recent=1`, the default); `kind=mmi|pga|pgv`; `min_mag` filters recent events.
pub async fn shakemap(o: &Overlays, event: &str, kind: &str, n: &str, min_mag: &str) -> Result<Value> {
    let kind = match kind {
        "" | "mmi" => "mmi",
        "pga" | "pgv" => kind,
        _ => bail!("kind must be mmi, pga or pgv"),
    };
    if !event.is_empty() {
        return Ok(fc(shakemap_event(o, event, kind).await?));
    }
    let n: usize = n.parse().unwrap_or(5usize).clamp(1, 10);
    let min_mag: f64 = min_mag.parse().unwrap_or(0.0);
    let (sig, big) = tokio::join!(o.get_json(USGS_SIGNIFICANT), o.get_json(USGS_45));
    let mut evs: Vec<(i64, String)> = vec![];
    for v in [sig.as_ref().ok(), big.as_ref().ok()].into_iter().flatten() {
        for f in v["features"].as_array().into_iter().flatten() {
            let p = &f["properties"];
            let has = p["types"].as_str().map(|t| t.contains(",shakemap,")).unwrap_or(false);
            let (Some(id), Some(t)) = (f["id"].as_str(), p["time"].as_i64()) else { continue };
            if has && p["mag"].as_f64().unwrap_or(0.0) >= min_mag && !evs.iter().any(|e| e.1 == id) {
                evs.push((t, id.to_string()));
            }
        }
    }
    if evs.is_empty() {
        if let Err(e) = sig {
            return Err(e);
        }
    }
    evs.sort_by_key(|e| -e.0);
    let mut feats = vec![];
    for (_, id) in evs.into_iter().take(n) {
        match shakemap_event(o, &id, kind).await {
            Ok(f) => feats.extend(f),
            Err(e) => tracing::debug!("shakemap {id}: {e:#}"),
        }
    }
    Ok(fc(feats))
}

// ---------- tsunami messages ----------

pub const TSUNAMI_FEEDS: &[(&str, &str)] = &[("NTWC", "https://www.tsunami.gov/events/xml/PAAQAtom.xml"), ("PTWC", "https://www.tsunami.gov/events/xml/PHEBAtom.xml")];

/// Text of the first `<tag ...>…</tag>` (tag may carry a namespace prefix) inside `s`.
fn tag<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}");
    let mut from = 0;
    while let Some(p) = s[from..].find(&open) {
        let start = from + p;
        let after = &s[start + open.len()..];
        // the tag name must end here (avoid <title> matching <titles>)
        if after.starts_with('>') || after.starts_with(' ') || after.starts_with('/') {
            let gt = start + open.len() + after.find('>')?;
            if s[..gt].ends_with('/') {
                return Some("");
            }
            let close = format!("</{name}>");
            let end = s[gt + 1..].find(&close)? + gt + 1;
            return Some(&s[gt + 1..end]);
        }
        from = start + open.len();
    }
    None
}

fn strip_tags(s: &str) -> String {
    let s = s.replace("<br/>", "\n").replace("<br />", "\n").replace("<br>", "\n");
    let mut out = String::new();
    let mut inside = false;
    for c in s.chars() {
        match c {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
}

fn attr<'a>(el: &'a str, name: &str) -> Option<&'a str> {
    let k = format!("{name}=\"");
    let p = el.find(&k)? + k.len();
    Some(&el[p..p + el[p..].find('"')?])
}

/// Message level from a summary / CAP text: warning | advisory | watch | threat | information | cancellation.
pub fn tsunami_level(s: &str) -> &'static str {
    let l = s.to_ascii_lowercase();
    let cat = l.split("category:").nth(1).map(|x| x.trim_start().to_string()).unwrap_or(l);
    for (k, v) in [("warning", "warning"), ("advisory", "advisory"), ("watch", "watch"), ("threat", "threat"), ("cancel", "cancellation"), ("information", "information")] {
        if cat.starts_with(k) {
            return v;
        }
    }
    let l = s.to_ascii_lowercase();
    for (k, v) in [("tsunami warning", "warning"), ("tsunami advisory", "advisory"), ("tsunami watch", "watch"), ("tsunami threat", "threat"), ("cancel", "cancellation")] {
        if l.contains(k) {
            return v;
        }
    }
    "information"
}

#[derive(Debug, Clone, PartialEq)]
pub struct TsuEntry {
    pub title: String,
    pub updated: i64,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub summary: String,
    pub level: &'static str,
    pub cap: Option<String>,
    pub bulletin: Option<String>,
    pub magnitude: Option<f64>,
}

pub fn parse_tsunami_atom(xml: &str) -> Vec<TsuEntry> {
    xml.split("<entry").skip(1)
        .filter_map(|e| {
            let e = &e[..e.find("</entry>").unwrap_or(e.len())];
            let title = strip_tags(tag(e, "title")?).trim().to_string();
            let updated = tag(e, "updated").and_then(|t| chrono::DateTime::parse_from_rfc3339(t.trim()).ok()).map(|t| t.timestamp_millis()).unwrap_or(0);
            let num = |n: &str| tag(e, n).and_then(|x| x.trim().parse::<f64>().ok());
            let summary = tag(e, "summary").map(strip_tags).unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
            let mut cap = None;
            let mut bulletin = None;
            for l in e.split("<link").skip(1) {
                let l = &l[..l.find('>').unwrap_or(l.len())];
                let href = attr(l, "href").map(String::from);
                let ty = attr(l, "type").unwrap_or("");
                if ty.contains("cap") || href.as_deref().map(|h| h.ends_with("CAP.xml")).unwrap_or(false) {
                    cap = href;
                } else if attr(l, "rel") == Some("alternate") || href.as_deref().map(|h| h.ends_with(".txt")).unwrap_or(false) {
                    bulletin = href;
                }
            }
            let magnitude = summary.split("Magnitude:").nth(1).and_then(|x| x.trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect::<String>().parse().ok());
            Some(TsuEntry { level: tsunami_level(&summary), title, updated, lat: num("geo:lat"), lon: num("geo:long"), summary, cap, bulletin, magnitude })
        })
        .collect()
}

/// CAP areas: (areaDesc, polygons as [[lon, lat]…]).
pub fn parse_cap_areas(xml: &str) -> Vec<(String, Vec<Vec<[f64; 2]>>)> {
    xml.split("<area>").skip(1)
        .map(|a| {
            let a = &a[..a.find("</area>").unwrap_or(a.len())];
            let desc = tag(a, "areaDesc").map(strip_tags).unwrap_or_default().trim().to_string();
            let polys = a
                .split("<polygon>")
                .skip(1)
                .filter_map(|p| {
                    let p = &p[..p.find("</polygon>")?];
                    let ring: Vec<[f64; 2]> = p.split_whitespace().filter_map(|pt| {
                        let (la, lo) = pt.split_once(',')?;
                        Some([lo.parse().ok()?, la.parse().ok()?])
                    }).collect();
                    (ring.len() >= 4).then_some(ring)
                })
                .collect();
            (desc, polys)
        })
        .collect()
}

fn https(u: &str) -> String {
    u.replacen("http://", "https://", 1)
}

/// `tsunami`: NTWC + PTWC Atom entries (points at the event, level, summary) with the bulletin
/// text and CAP areas of entries from the last `hours` (default 48, max 168).
pub async fn tsunami(o: &Overlays, hours: &str) -> Result<Value> {
    let hours: i64 = hours.parse().unwrap_or(48i64).clamp(1, 168);
    let cutoff = chrono::Utc::now().timestamp_millis() - hours * 3_600_000;
    let mut feats = vec![];
    let mut errs = vec![];
    let mut fetched = 0;
    for (center, url) in TSUNAMI_FEEDS {
        let xml = match o.get_text(url).await {
            Ok(x) => x,
            Err(e) => {
                errs.push(e);
                continue;
            }
        };
        for e in parse_tsunami_atom(&xml) {
            let recent = e.updated >= cutoff;
            let mut text = Value::Null;
            let mut areas: Vec<String> = vec![];
            if recent && fetched < 8 {
                fetched += 1;
                if let Some(b) = &e.bulletin {
                    if let Ok(t) = o.get_text(&https(b)).await {
                        text = json!(t.chars().take(12_000).collect::<String>());
                    }
                }
                if let Some(c) = &e.cap {
                    if let Ok(x) = o.get_text(&https(c)).await {
                        for (desc, polys) in parse_cap_areas(&x) {
                            for ring in polys {
                                feats.push(json!({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": {"kind": "area", "center": center, "level": e.level, "area": desc, "title": e.title, "updated": e.updated}}));
                            }
                            if !desc.is_empty() {
                                areas.push(desc);
                            }
                        }
                    }
                }
            }
            let props = json!({"kind": "message", "center": center, "level": e.level, "title": e.title, "updated": e.updated, "summary": e.summary, "magnitude": e.magnitude,
                               "bulletin_url": e.bulletin.as_deref().map(https), "cap_url": e.cap.as_deref().map(https), "text": text, "areas": areas, "recent": recent});
            match (e.lon, e.lat) {
                (Some(lon), Some(lat)) => feats.push(point(lon, lat, props)),
                _ => feats.push(json!({"type": "Feature", "geometry": null, "properties": props})),
            }
        }
    }
    if feats.is_empty() && errs.len() == TSUNAMI_FEEDS.len() {
        return Err(errs.remove(0));
    }
    Ok(fc(feats))
}

// ---------- shelters / hospitals / centres ----------

/// FEMA National Shelter System "Open Shelters" layer (fields: shelter_name, address, city, state,
/// zip, shelter_status, evacuation_capacity, post_impact_capacity, total_population, org_name,
/// pet_accommodations_code, ada_compliant, wheelchair_accessible, hours_open, hours_close,
/// latitude, longitude). 0.8.1: the MapServer copy of the same layer is the fallback.
pub const FEMA_SHELTERS: &str = "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/FeatureServer/0";
pub const FEMA_SHELTER_LAYERS: &[&str] = &[FEMA_SHELTERS, "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0"];
/// HIFLD hospitals (FEMA copy, 2021) and an older public HIFLD copy as fallback.
pub const HOSPITAL_LAYERS: &[&str] = &["https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_hifld/FeatureServer/0", "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Hospitals/FeatureServer/0"];

fn pick(p: &Value, keys: &[&str]) -> Value {
    keys.iter().map(|k| &p[*k]).find(|v| !v.is_null() && v.as_str().map(|s| !s.trim().is_empty() && s != "NOT AVAILABLE").unwrap_or(true)).cloned().unwrap_or(Value::Null)
}

/// Property `k` in any case (ArcGIS services have switched between lower- and upper-case names).
fn prop<'a>(p: &'a Value, k: &str) -> &'a Value {
    let v = &p[k];
    if !v.is_null() {
        return v;
    }
    let up = &p[k.to_ascii_uppercase().as_str()];
    if !up.is_null() {
        return up;
    }
    p.as_object().and_then(|m| m.iter().find(|(kk, _)| kk.eq_ignore_ascii_case(k)).map(|(_, v)| v)).unwrap_or(&Value::Null)
}

/// FEMA NSS GeoJSON features → shelter points (0.8.1: case-insensitive fields, points rebuilt from
/// the latitude / longitude fields when a feature comes without geometry, closed ones dropped).
pub fn parse_shelters(feats: Vec<Value>) -> Vec<Value> {
    feats
        .into_iter()
        .filter_map(|mut f| {
            let p = f["properties"].take();
            let g = |k: &str| prop(&p, k).clone();
            let status = prop(&p, "shelter_status").as_str().unwrap_or("").to_ascii_uppercase();
            if status.contains("CLOSED") {
                return None;
            }
            let props = json!({
                "kind": "shelter", "name": g("shelter_name"), "address": g("address"), "city": g("city"), "state": g("state"), "zip": g("zip"),
                "status": g("shelter_status"), "capacity": g("evacuation_capacity"), "post_impact_capacity": g("post_impact_capacity"), "population": g("total_population"),
                "org": g("org_name"), "pets": g("pet_accommodations_code"), "ada": g("ada_compliant"), "wheelchair": g("wheelchair_accessible"),
                "hours_open": g("hours_open"), "hours_close": g("hours_close"),
            });
            let has_geom = f["geometry"]["coordinates"].as_array().map(|c| c.len() >= 2 && c[0].is_number() && c[1].is_number()).unwrap_or(false);
            if has_geom {
                f["properties"] = props;
                return Some(f);
            }
            let num = |k: &str| prop(&p, k).as_f64().or_else(|| prop(&p, k).as_str().and_then(|s| s.trim().parse().ok()));
            match (num("longitude"), num("latitude")) {
                (Some(lon), Some(lat)) if lon.abs() <= 180.0 && lat.abs() <= 90.0 && (lon, lat) != (0.0, 0.0) => Some(point(lon, lat, props)),
                _ => None,
            }
        })
        .collect()
}

/// Short status for an empty answer, so "none open" reads differently from "broken".
pub fn shelters_status(in_view: usize, nationwide: Option<u64>) -> Option<String> {
    if in_view > 0 {
        return None;
    }
    Some(match nationwide {
        Some(0) => "FEMA: 0 open shelters now".to_string(),
        Some(n) => format!("0 here · {n} open in the US"),
        None => "FEMA: none open here".to_string(),
    })
}

/// FEMA National Shelter System open shelters (`bbox` optional). With nothing in the box, the
/// nationwide count is added as `_status` ("FEMA: 0 open shelters now" outside disasters).
pub async fn shelters(o: &Overlays, bbox: &str) -> Result<Value> {
    let bb = parse_bbox(bbox)?;
    let mut last = anyhow!("FEMA shelters unreachable");
    let mut got = None;
    for layer in FEMA_SHELTER_LAYERS {
        let q = Query { layer, bbox: bb, max: 5000, page: 2000, ..Default::default() };
        match agsquery::features(o, &q).await {
            Ok(f) => {
                got = Some((*layer, f));
                break;
            }
            Err(e) => {
                tracing::debug!("shelters {layer}: {e:#}");
                last = e;
            }
        }
    }
    let Some((layer, feats)) = got else { return Err(last) };
    let mut v = fc(parse_shelters(feats));
    let n = v["features"].as_array().map(|a| a.len()).unwrap_or(0);
    let nationwide = if n == 0 { o.get_json(&format!("{layer}/query?where=1%3D1&returnCountOnly=true&f=json")).await.ok().and_then(|c| c["count"].as_u64()) } else { None };
    if let Some(st) = shelters_status(n, nationwide) {
        v["_status"] = json!(st);
    }
    v["source"] = json!("FEMA National Shelter System");
    Ok(v)
}

/// HIFLD hospitals (`bbox` strongly recommended; at most 8000 without one).
pub async fn hospitals(o: &Overlays, bbox: &str) -> Result<Value> {
    let bb = parse_bbox(bbox)?;
    let mut last = anyhow!("no hospital layer reachable");
    for layer in HOSPITAL_LAYERS {
        let q = Query { layer, bbox: bb, max: 8000, page: 2000, fields: "NAME,ADDRESS,CITY,STATE,ZIP,TELEPHONE,TYPE,STATUS,BEDS,TRAUMA,HELIPAD,WEBSITE,OWNER,SOURCEDATE", ..Default::default() };
        match agsquery::features(o, &q).await {
            Ok(feats) => {
                return Ok(fc(feats
                    .into_iter()
                    .map(|mut f| {
                        let p = f["properties"].take();
                        let beds = p["BEDS"].as_i64().filter(|b| *b > 0);
                        f["properties"] = json!({
                            "kind": "hospital", "name": p["NAME"], "address": p["ADDRESS"], "city": p["CITY"], "state": p["STATE"], "zip": p["ZIP"],
                            "phone": pick(&p, &["TELEPHONE"]), "type": p["TYPE"], "status": p["STATUS"], "beds": beds, "trauma": pick(&p, &["TRAUMA"]),
                            "helipad": p["HELIPAD"], "website": pick(&p, &["WEBSITE"]), "owner": p["OWNER"], "source_date": p["SOURCEDATE"],
                        });
                        f
                    })
                    .collect()));
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Overpass QL for cooling / warming centres, emergency shelters and assembly points in one box.
/// Few cooling centres carry a dedicated tag, so names are matched too; the centres are output
/// first (own cap) so assembly points can't crowd them out.
pub fn centers_ql(w: f64, s: f64, e: f64, n: f64) -> String {
    let bb = format!("({s},{w},{n},{e})");
    let centres = [
        r#"nwr["cooling_center"]"#,
        r#"nwr["cooling_centre"]"#,
        r#"nwr["warming_center"]"#,
        r#"nwr["warming_centre"]"#,
        r#"nwr["emergency"~"^((cooling|warming)_cent(er|re)|emergency_shelter|shelter)$"]"#,
        r#"nwr["social_facility"~"^(cooling|warming)"]"#,
        r#"nwr["social_facility:for"~"displaced|disaster"]"#,
        r#"nwr["name"~"cooling (center|centre|station|site|shelter)|warming (center|centre|station|site|shelter)|heat relief|warming hut|emergency shelter",i]"#,
    ];
    let others = [r#"nwr["social_facility"="shelter"]"#, r#"nwr["amenity"="shelter"]["shelter_type"="storm_shelter"]"#, r#"nwr["emergency"="assembly_point"]"#];
    let a: String = centres.iter().map(|x| format!("{x}{bb};")).collect();
    let b: String = others.iter().map(|x| format!("{x}{bb};")).collect();
    format!("[out:json][timeout:40];({a})->.c;({b})->.o;(.o; - .c;)->.o;.c out center 300;.o out center 300;")
}

/// What a centre is, from its tags / name: cooling centre, warming centre, shelter, storm shelter
/// or assembly point (the map colours by "cooling" / "warming" in name + kind).
pub fn center_kind(t: &Value) -> String {
    let g = |k: &str| t[k].as_str().unwrap_or("").to_ascii_lowercase();
    let text = format!("{} {} {} {} {} {}", g("name"), g("description"), g("emergency"), g("social_facility"), g("social_facility:for"), g("shelter_type"));
    let key = |k: &str| !t[k].is_null();
    if key("cooling_center") || key("cooling_centre") || text.contains("cooling") || text.contains("heat relief") {
        "cooling centre".into()
    } else if key("warming_center") || key("warming_centre") || text.contains("warming") {
        "warming centre".into()
    } else if g("emergency") == "assembly_point" {
        "assembly point".into()
    } else if g("shelter_type") == "storm_shelter" {
        "storm shelter".into()
    } else {
        let f = g("social_facility:for");
        if f.is_empty() {
            "shelter".into()
        } else {
            format!("shelter ({})", f.replace(['_', ';'], " ").trim())
        }
    }
}

/// Overpass elements → centre points (deduplicated by OSM id).
pub fn parse_centers(v: &Value) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    v["elements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let lat = e["lat"].as_f64().or(e["center"]["lat"].as_f64())?;
            let lon = e["lon"].as_f64().or(e["center"]["lon"].as_f64())?;
            let ty = e["type"].as_str().unwrap_or("node");
            if !seen.insert(format!("{ty}/{}", e["id"])) {
                return None;
            }
            let t = &e["tags"];
            let kind = center_kind(t);
            let addr = [t["addr:housenumber"].as_str(), t["addr:street"].as_str(), t["addr:city"].as_str()].iter().flatten().cloned().collect::<Vec<_>>().join(" ");
            let name = t["name"].as_str().map(|s| s.to_string()).unwrap_or_else(|| {
                let mut k = kind.clone();
                k[..1].make_ascii_uppercase();
                k
            });
            Some(point(lon, lat, json!({"name": name, "kind": kind, "addr": addr, "phone": t["phone"], "web": t["website"], "hours": t["opening_hours"], "operator": t["operator"], "source": "OpenStreetMap", "osm": format!("https://www.openstreetmap.org/{ty}/{}", e["id"])})))
        })
        .collect()
}

/// Short status for an empty / centre-less answer.
pub fn centers_status(total: usize, centres: usize) -> Option<&'static str> {
    if total == 0 {
        Some("OSM: none mapped here")
    } else if centres == 0 {
        Some("No cooling/warming centres mapped here")
    } else {
        None
    }
}

/// Cooling / warming centres and emergency shelters mapped in OpenStreetMap (no national keyless
/// feed exists): `bbox` required, at most 25 deg², ≤ 600 results. `_status` explains an empty map.
pub async fn centers(o: &Overlays, bbox: &str) -> Result<Value> {
    let Some([w, s, e, n]) = parse_bbox(bbox)? else { bail!("bbox required (w,s,e,n)") };
    if (e - w) * (n - s) > 25.0 {
        bail!("zoom in a bit (search area too large)");
    }
    let v = super::extra::overpass_ql(o, &centers_ql(w, s, e, n)).await?;
    let feats = parse_centers(&v);
    let centres = feats.iter().filter(|f| f["properties"]["kind"].as_str().map(|k| k.ends_with("centre")).unwrap_or(false)).count();
    let total = feats.len();
    let mut out = fc(feats);
    if let Some(st) = centers_status(total, centres) {
        out["_status"] = json!(st);
    }
    out["note"] = json!("OpenStreetMap: cooling / warming centre tags and names, emergency shelters, assembly points; coverage varies");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#">
<id>urn:uuid:aba7</id><title>TSUNAMI INFORMATION STATEMENT NUMBER 1</title><updated>2026-10-09T20:34:14Z</updated>
<entry>
<title>PANAMA</title>
<updated>2026-10-09T20:34:14Z</updated>
<geo:lat>7.782</geo:lat>
<geo:long>-81.378</geo:long>
<summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><strong>Category:</strong> Information<br/><strong>Bulletin Issue Time: </strong> 2026.10.09 20:34:14 UTC<br/><strong>Preliminary Magnitude: </strong>6.9(Mwp)<br/></div></summary>
<id>urn:uuid:719a</id>
<link rel="related" title="CapXML document" href="https://www.tsunami.gov/events/PHEB/2026/10/09/26282001/1/WEGM42/PHEBCAP.xml" type="application/cap+xml" />
<link rel="alternate" title="Bulletin" href="https://www.tsunami.gov/events/PHEB/2026/10/09/26282001/1/WEGM42/WEGM42.txt" type="application/xml" />
</entry>
<entry><title>ALASKA</title><updated>2026-10-10T01:00:00Z</updated><summary>Category: Warning ...</summary></entry>
</feed>"#;

    #[test]
    fn tsunami_atom() {
        let e = parse_tsunami_atom(ATOM);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].title, "PANAMA");
        assert_eq!(e[0].level, "information");
        assert_eq!((e[0].lat, e[0].lon), (Some(7.782), Some(-81.378)));
        assert!(e[0].cap.as_deref().unwrap().ends_with("PHEBCAP.xml"));
        assert!(e[0].bulletin.as_deref().unwrap().ends_with("WEGM42.txt"));
        assert_eq!(e[0].updated, chrono::DateTime::parse_from_rfc3339("2026-10-09T20:34:14Z").unwrap().timestamp_millis());
        assert_eq!(e[0].magnitude, Some(6.9));
        assert_eq!(e[1].level, "warning");
        assert_eq!(e[1].lat, None);
        assert_eq!(tsunami_level("TSUNAMI ADVISORY IN EFFECT"), "advisory");
        let cap = r#"<alert><info><area><areaDesc>Coastal areas of Panama</areaDesc><polygon>7.0,-82.0 7.0,-80.0 8.0,-80.0 7.0,-82.0</polygon></area><area><areaDesc>Costa Rica</areaDesc></area></info></alert>"#;
        let a = parse_cap_areas(cap);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].0, "Coastal areas of Panama");
        assert_eq!(a[0].1[0][0], [-82.0, 7.0]);
        assert!(a[1].1.is_empty());
        assert!(valid_event_id("us6000u19w"));
        assert!(!valid_event_id("../x"));
    }

    /// FEMA NSS OpenShelters `f=geojson` answer (field names as published on gis.fema.gov).
    const NSS: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","id":1,"geometry":{"type":"Point","coordinates":[-82.4572,27.9506]},"properties":{"objectid":1,"shelter_id":401234,"shelter_name":"Middleton High School","address":"4801 N 22nd St","city":"Tampa","state":"FL","zip":"33610","shelter_status":"OPEN","evacuation_capacity":850,"post_impact_capacity":340,"total_population":212,"hours_open":null,"hours_close":null,"org_name":"Hillsborough County","org_id":7,"match_type":"Exact","subfacility_code":"GENERAL","ada_compliant":"Y","pet_accommodations_code":"PETS ALLOWED","wheelchair_accessible":"Y","latitude":27.9506,"longitude":-82.4572}},
      {"type":"Feature","id":2,"geometry":null,"properties":{"SHELTER_NAME":"Plant City Rec Center","CITY":"Plant City","STATE":"FL","SHELTER_STATUS":"Open","LATITUDE":"28.0186","LONGITUDE":"-82.1129"}},
      {"type":"Feature","id":3,"geometry":{"type":"Point","coordinates":[-82.0,28.0]},"properties":{"shelter_name":"Old Gym","shelter_status":"CLOSED"}},
      {"type":"Feature","id":4,"geometry":null,"properties":{"shelter_name":"No location"}}
    ]}"#;

    #[test]
    fn fema_shelters_parse() {
        let v: Value = serde_json::from_str(NSS).unwrap();
        let f = parse_shelters(v["features"].as_array().unwrap().clone());
        assert_eq!(f.len(), 2, "closed and unlocated shelters are dropped");
        let p = &f[0]["properties"];
        assert_eq!(p["name"], "Middleton High School");
        assert_eq!(p["capacity"], 850);
        assert_eq!(p["population"], 212);
        assert_eq!(p["pets"], "PETS ALLOWED");
        assert_eq!(p["status"], "OPEN");
        // upper-case fields + no geometry: rebuilt from LATITUDE / LONGITUDE
        assert_eq!(f[1]["properties"]["name"], "Plant City Rec Center");
        assert_eq!(f[1]["geometry"]["coordinates"][0].as_f64().unwrap(), -82.1129);
        assert_eq!(shelters_status(0, Some(0)).as_deref(), Some("FEMA: 0 open shelters now"));
        assert_eq!(shelters_status(0, Some(42)).as_deref(), Some("0 here · 42 open in the US"));
        assert_eq!(shelters_status(3, Some(42)), None);
        // the query the fetcher sends
        let q = Query { layer: FEMA_SHELTERS, bbox: Some([-84.0, 26.0, -80.0, 29.0]), max: 5000, page: 2000, ..Default::default() };
        let u = agsquery::query_url(&q, 0);
        assert!(u.starts_with("https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/FeatureServer/0/query?where=1%3D1&outFields=%2A"));
        assert!(u.contains("f=geojson") && u.contains("geometry=-84,26,-80,29"));
    }

    /// Overpass answer for a cooling / warming centre search.
    const OVERPASS: &str = r#"{"version":0.6,"elements":[
      {"type":"node","id":101,"lat":33.45,"lon":-112.07,"tags":{"amenity":"community_centre","name":"Heat Relief Station - Burton Barr Library"}},
      {"type":"way","id":202,"center":{"lat":41.88,"lon":-87.63},"tags":{"amenity":"social_facility","social_facility":"shelter","name":"Garfield Warming Center"}},
      {"type":"node","id":303,"lat":40.0,"lon":-75.0,"tags":{"cooling_centre":"yes","amenity":"library","name":"Main Library"}},
      {"type":"node","id":404,"lat":40.1,"lon":-75.1,"tags":{"amenity":"social_facility","social_facility":"shelter","social_facility:for":"homeless"}},
      {"type":"node","id":505,"lat":40.2,"lon":-75.2,"tags":{"emergency":"assembly_point"}},
      {"type":"node","id":101,"lat":33.45,"lon":-112.07,"tags":{"name":"dup"}},
      {"type":"relation","id":606,"tags":{"name":"no centre"}}
    ]}"#;

    #[test]
    fn osm_centers_parse() {
        let v: Value = serde_json::from_str(OVERPASS).unwrap();
        let f = parse_centers(&v);
        assert_eq!(f.len(), 5, "duplicates and elements without a position are dropped");
        let k: Vec<&str> = f.iter().map(|x| x["properties"]["kind"].as_str().unwrap()).collect();
        assert_eq!(k, ["cooling centre", "warming centre", "cooling centre", "shelter (homeless)", "assembly point"]);
        assert_eq!(f[1]["geometry"]["coordinates"][1].as_f64().unwrap(), 41.88);
        assert_eq!(f[3]["properties"]["name"], "Shelter (homeless)");
        assert_eq!(f[4]["properties"]["osm"], "https://www.openstreetmap.org/node/505");
        assert_eq!(centers_status(0, 0), Some("OSM: none mapped here"));
        assert_eq!(centers_status(2, 0), Some("No cooling/warming centres mapped here"));
        assert_eq!(centers_status(5, 3), None);
        let ql = centers_ql(-88.0, 41.0, -87.0, 42.0);
        assert!(ql.starts_with("[out:json]"));
        assert!(ql.contains(r#"nwr["cooling_centre"](41,-88,42,-87);"#));
        assert!(ql.contains(".c out center 300;.o out center 300;"));
        assert_eq!(ql.matches('(').count(), ql.matches(')').count());
        // a timed-out query is an error, not "nothing here"
        let to: Value = serde_json::json!({"elements": [], "remark": "runtime error: Query timed out in \"query\" at line 1 after 41 seconds."});
        assert!(crate::overlays::extra::overpass_error(&to).is_some());
        assert!(crate::overlays::extra::overpass_error(&v).is_none());
    }
}
