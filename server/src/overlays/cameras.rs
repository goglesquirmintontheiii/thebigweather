//! Traffic / weather cameras from many public sources, described in `data/camera_sources.json`
//! so lists can be fixed or extended without rebuilding (edit the copy in the server's data
//! folder; it is re-read when the camera list refreshes).

use super::{fc, point, Overlays};
use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEFAULT_SOURCES: &str = include_str!("../../data/camera_sources.json");

#[derive(Deserialize, Clone, Debug)]
pub struct Source {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub region: String,
    pub format: String,
    pub urls: Vec<String>,
    #[serde(default)]
    pub list: String,
    #[serde(default)]
    pub item: String,
    pub fields: HashMap<String, String>,
    #[serde(default)]
    pub img_template: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub paged: bool,
    #[serde(default)]
    pub geometry_xy: bool,
    #[serde(default)]
    pub require: Vec<String>,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub refresh: u32,
    #[serde(default)]
    pub ttl: u64,
    #[serde(default)]
    pub proxy_image: bool,
    #[serde(default)]
    pub default_off: bool,
    #[serde(default)]
    pub attribution: String,
}

#[derive(Default)]
pub struct Cameras {
    /// source id → (fetched, cameras as GeoJSON features)
    lists: Mutex<HashMap<String, (Instant, Vec<Value>)>>,
    /// raw items for sources whose image URLs expire (looked up at view time)
    images: Mutex<HashMap<String, String>>,
}

pub fn sources(o: &Overlays) -> Vec<Source> {
    let local = o.data_dir.parent().map(|d| d.join("camera_sources.json"));
    if let Some(p) = local {
        if let Ok(t) = std::fs::read_to_string(&p) {
            match serde_json::from_str::<Vec<Source>>(&t) {
                Ok(v) => return v,
                Err(e) => tracing::warn!("{}: {e}; using built-in camera list", p.display()),
            }
        }
    }
    serde_json::from_str(DEFAULT_SOURCES).unwrap_or_default()
}

/// Value at a dotted path ("location.latitude", "presets.0.id").
pub fn get_path<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(v);
    }
    let mut cur = v;
    for part in path.split('.') {
        cur = match cur {
            Value::Array(a) => a.get(part.parse::<usize>().ok()?)?,
            Value::Object(m) => m.get(part)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn as_text(v: Option<&Value>) -> Option<String> {
    let s = match v? {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    if s.is_empty() || s.eq_ignore_ascii_case("not reported") || s == "null" {
        None
    } else {
        Some(s)
    }
}

fn as_f64(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn truthy(v: Option<&Value>) -> Option<bool> {
    match v? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => Some(matches!(s.to_lowercase().as_str(), "true" | "yes" | "y" | "1")),
        Value::Number(n) => Some(n.as_f64().unwrap_or(0.0) != 0.0),
        _ => None,
    }
}

fn camera_type(img: &Option<String>, video: &Option<String>) -> &'static str {
    if let Some(v) = video {
        let l = v.to_lowercase();
        if l.contains("youtube.com") || l.contains("youtu.be") {
            return "yt";
        }
        if l.contains(".m3u8") {
            return "hls";
        }
    }
    if img.is_some() {
        "img"
    } else {
        "page"
    }
}

/// Turn one raw item into a camera feature (or None if unusable).
fn feature(src: &Source, item: &Value, props: &Value, coords: Option<(f64, f64)>) -> Option<Value> {
    let f = |k: &str| src.fields.get(k).and_then(|p| get_path(props, p));
    let id = as_text(f("id")).or_else(|| as_text(get_path(item, "id")))?;
    let (lat, lon) = match (as_f64(f("lat")), as_f64(f("lon"))) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            let (lo, la) = coords?;
            (la, lo)
        }
    };
    if !(lat.abs() <= 90.0 && lon.abs() <= 180.0) || (lat == 0.0 && lon == 0.0) {
        return None;
    }
    if truthy(f("on")) == Some(false) || truthy(f("stale")) == Some(true) || truthy(f("offline")) == Some(true) {
        return None;
    }
    for r in &src.require {
        as_text(src.fields.get(r).and_then(|p| get_path(props, p)))?;
    }
    let name = as_text(f("name")).unwrap_or_else(|| format!("{} {id}", src.name));
    let mut img = as_text(f("img"));
    if !src.img_template.is_empty() {
        let mut t = src.img_template.replace("{id}", &id);
        for (k, p) in &src.fields {
            if t.contains(&format!("{{{k}}}")) {
                let Some(v) = as_text(get_path(props, p)) else { return None };
                t = t.replace(&format!("{{{k}}}"), &v);
            }
        }
        img = Some(t);
    }
    // relative or protocol-less URLs
    if let Some(u) = &img {
        if u.starts_with("//") {
            img = Some(format!("https:{u}"));
        } else if !u.starts_with("http") {
            img = None;
        }
    }
    let video = as_text(f("video")).filter(|v| v.starts_with("http"));
    let page = as_text(f("page")).filter(|v| v.starts_with("http"));
    let t = camera_type(&img, &video);
    let refresh = as_f64(f("refresh_min")).map(|m| (m * 60.0) as u32).unwrap_or(if src.refresh > 0 { src.refresh } else { 120 });
    let gid = format!("{}:{id}", src.id);
    Some(point(
        lon,
        lat,
        json!({
            "id": gid, "n": name, "s": src.id, "sn": src.name, "t": t, "i": if src.proxy_image { json!("proxy") } else { json!(img) }, "v": video, "p": page,
            "r": refresh, "k": if src.kind.is_empty() { "traffic" } else { src.kind.as_str() }, "a": src.attribution,
        }),
    ))
}

async fn fetch_source(o: &Overlays, src: &Source) -> Result<(Vec<Value>, HashMap<String, String>)> {
    let mut out = vec![];
    let mut images = HashMap::new();
    for url in &src.urls {
        let mut offset = 0usize;
        loop {
            let u = if src.paged { format!("{url}&resultOffset={offset}&resultRecordCount=1000") } else { url.clone() };
            let mut req = o.http.get(&u).timeout(Duration::from_secs(60));
            for (k, v) in &src.headers {
                req = req.header(k, v);
            }
            let r = req.send().await?;
            if !r.status().is_success() {
                return Err(anyhow!("HTTP {} from {}", r.status(), super::host(&u)));
            }
            let body = r.bytes().await?;
            let mut more = false;
            match src.format.as_str() {
                "xml" => {
                    for m in parse_xml_items(&body, &src.item) {
                        let v = Value::Object(m.into_iter().map(|(k, v)| (k, Value::String(v))).collect());
                        if let Some(feat) = feature(src, &v, &v, None) {
                            out.push(feat);
                        }
                    }
                }
                "otcm" => {
                    let v: Value = serde_json::from_slice(&body)?;
                    for (_, counties) in v.as_object().cloned().unwrap_or_default() {
                        for (_, cams) in counties.as_object().cloned().unwrap_or_default() {
                            for (k, c) in cams.as_array().cloned().unwrap_or_default().into_iter().enumerate() {
                                let url = c["url"].as_str().unwrap_or("").to_string();
                                let (lat, lon) = (c["latitude"].as_f64(), c["longitude"].as_f64());
                                let (Some(lat), Some(lon)) = (lat, lon) else { continue };
                                if !url.starts_with("http") {
                                    continue;
                                }
                                let fmt = c["format"].as_str().unwrap_or("");
                                let hls = fmt.contains("M3U8") || url.contains(".m3u8");
                                let id = format!("otcm:{}", hex::encode(&url.as_bytes()[url.len().saturating_sub(24)..]) + &k.to_string());
                                out.push(point(
                                    lon,
                                    lat,
                                    json!({"id": id, "n": c["description"], "s": src.id, "sn": src.name, "t": if hls { "hls" } else { "img" }, "i": if hls { Value::Null } else { json!(url) }, "v": if hls { json!(url) } else { Value::Null }, "r": 120, "k": "traffic", "a": src.attribution}),
                                ));
                            }
                        }
                    }
                }
                fmt => {
                    let v: Value = serde_json::from_slice(&body)?;
                    let items: Vec<(Value, Value, Option<(f64, f64)>)> = match fmt {
                        "geojson" => v["features"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                            .into_iter()
                            .map(|f| {
                                let c = &f["geometry"]["coordinates"];
                                let xy = c[0].as_f64().zip(c[1].as_f64());
                                let mut props = f["properties"].clone();
                                if props.get("id").is_none() {
                                    if let Some(m) = props.as_object_mut() {
                                        m.insert("id".into(), f["id"].clone());
                                    }
                                }
                                (f.clone(), props, xy)
                            })
                            .collect(),
                        "arcgis" => {
                            more = v["exceededTransferLimit"].as_bool().unwrap_or(false);
                            v["features"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default()
                                .into_iter()
                                .map(|f| {
                                    let xy = if src.geometry_xy { f["geometry"]["x"].as_f64().zip(f["geometry"]["y"].as_f64()) } else { None };
                                    (f.clone(), f["attributes"].clone(), xy)
                                })
                                .collect()
                        }
                        _ => {
                            let list = get_path(&v, &src.list).cloned().unwrap_or(Value::Null);
                            list.as_array()
                                .cloned()
                                .unwrap_or_default()
                                .into_iter()
                                .map(|it| {
                                    let props = if src.item.is_empty() { it.clone() } else { it[&src.item].clone() };
                                    (it, props, None)
                                })
                                .collect()
                        }
                    };
                    for (item, props, xy) in items {
                        if let Some(feat) = feature(src, &item, &props, xy) {
                            if src.proxy_image {
                                if let (Some(id), Some(img)) = (feat["properties"]["id"].as_str(), as_text(src.fields.get("img").and_then(|p| get_path(&props, p)))) {
                                    images.insert(id.to_string(), img);
                                }
                            }
                            out.push(feat);
                        }
                    }
                }
            }
            if more && offset < 20_000 {
                offset += 1000;
                continue;
            }
            break;
        }
    }
    Ok((out, images))
}

/// Minimal XML reader: every <item> element becomes a map of its child elements' text.
fn parse_xml_items(body: &[u8], item: &str) -> Vec<HashMap<String, String>> {
    use quick_xml::events::Event;
    let mut rd = quick_xml::Reader::from_reader(body);
    rd.config_mut().trim_text(true);
    let mut out = vec![];
    let mut cur: Option<HashMap<String, String>> = None;
    let mut field: Option<String> = None;
    let mut buf = vec![];
    loop {
        match rd.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = AsRef::<str>::as_ref(&e.local_name()).to_string();
                if name == item {
                    let mut m = HashMap::new();
                    for a in e.attributes().flatten() {
                        m.insert(AsRef::<str>::as_ref(&a.key.local_name()).to_string(), a.value.to_string());
                    }
                    cur = Some(m);
                } else if cur.is_some() {
                    field = Some(name);
                }
            }
            Ok(Event::Text(t)) => {
                if let (Some(m), Some(f)) = (cur.as_mut(), field.as_ref()) {
                    let s = AsRef::<str>::as_ref(&t).replace("&amp;", "&");
                    m.entry(f.clone()).or_insert(s);
                }
            }
            Ok(Event::CData(t)) => {
                if let (Some(m), Some(f)) = (cur.as_mut(), field.as_ref()) {
                    m.entry(f.clone()).or_insert(AsRef::<str>::as_ref(&t).replace("&amp;", "&"));
                }
            }
            Ok(Event::End(e)) => {
                let name = AsRef::<str>::as_ref(&e.local_name()).to_string();
                if name == item {
                    if let Some(m) = cur.take() {
                        out.push(m);
                    }
                }
                field = None;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// All cameras from every source (each source cached separately; failures don't hide others).
pub async fn list(o: &Overlays) -> Result<Value> {
    let srcs = sources(o);
    let mut need = vec![];
    {
        let l = o.cams.lists.lock();
        for s in &srcs {
            let ttl = if s.ttl > 0 { s.ttl } else { 1800 };
            if l.get(&s.id).map(|(t, _)| t.elapsed().as_secs() >= ttl).unwrap_or(true) {
                need.push(s.clone());
            }
        }
    }
    let res = futures::future::join_all(need.iter().map(|s| async move { (s.clone(), fetch_source(o, s).await) })).await;
    for (s, r) in res {
        let hid = format!("cam-{}", s.id);
        let label = format!("Cameras · {}", s.name);
        match r {
            Ok((feats, imgs)) => {
                o.health.ok(&hid, &label, &format!("{} cameras", feats.len()));
                o.cams.lists.lock().insert(s.id.clone(), (Instant::now(), feats));
                o.cams.images.lock().extend(imgs);
            }
            Err(e) => {
                o.health.err(&hid, &label, &e);
                // keep the old list, but try again in 5 minutes
                let mut l = o.cams.lists.lock();
                let old = l.remove(&s.id).map(|x| x.1).unwrap_or_default();
                let ttl = if s.ttl > 0 { s.ttl } else { 1800 };
                l.insert(s.id.clone(), (Instant::now() - Duration::from_secs(ttl.saturating_sub(300)), old));
            }
        }
    }
    let l = o.cams.lists.lock();
    let mut feats = vec![];
    let mut srcs_out = vec![];
    for s in &srcs {
        let n = l.get(&s.id).map(|x| x.1.len()).unwrap_or(0);
        srcs_out.push(json!({"id": s.id, "name": s.name, "region": s.region, "count": n, "off": s.default_off, "attribution": s.attribution}));
        if let Some((_, v)) = l.get(&s.id) {
            feats.extend(v.iter().cloned());
        }
    }
    let mut out = fc(feats);
    out["sources"] = json!(srcs_out);
    Ok(out)
}

/// Current image URL for cameras whose links expire (e.g. Singapore's signed URLs).
pub async fn image_url(o: &Overlays, id: &str) -> Result<String> {
    let src_id = id.split(':').next().unwrap_or("");
    let stale = o.cams.lists.lock().get(src_id).map(|(t, _)| t.elapsed().as_secs() > 45).unwrap_or(true);
    if stale {
        if let Some(s) = sources(o).into_iter().find(|s| s.id == src_id) {
            if let Ok((feats, imgs)) = fetch_source(o, &s).await {
                o.cams.lists.lock().insert(s.id.clone(), (Instant::now(), feats));
                o.cams.images.lock().extend(imgs);
            }
        }
    }
    o.cams.images.lock().get(id).cloned().ok_or_else(|| anyhow!("camera not found"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builtin_sources_parse() {
        let v: Vec<Source> = serde_json::from_str(DEFAULT_SOURCES).unwrap();
        assert!(v.len() >= 18);
    }

    #[test]
    fn caltrans_item() {
        let srcs: Vec<Source> = serde_json::from_str(DEFAULT_SOURCES).unwrap();
        let s = srcs.iter().find(|s| s.id == "caltrans").unwrap();
        let item = json!({"cctv": {"index": "12", "inService": "true", "location": {"locationName": "I-5 at X", "latitude": "38.5", "longitude": "-121.5"}, "imageData": {"streamingVideoURL": "Not Reported", "static": {"currentImageURL": "https://cwwp2.dot.ca.gov/x.jpg", "currentImageUpdateFrequency": "5"}}}});
        let f = feature(s, &item, &item["cctv"], None).unwrap();
        assert_eq!(f["properties"]["id"], "caltrans:12");
        assert_eq!(f["properties"]["t"], "img");
        assert_eq!(f["properties"]["r"], 300);
        assert_eq!(f["geometry"]["coordinates"][1], 38.5);
    }

    #[test]
    fn xml_items() {
        let x = br#"<image-list><image><key>H1</key><description>Road</description><latitude>22.3</latitude><longitude>114.1</longitude><url>https://x/H1.JPG</url></image></image-list>"#;
        let items = parse_xml_items(x, "image");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["key"], "H1");
    }

    #[test]
    fn drivebc_template() {
        let srcs: Vec<Source> = serde_json::from_str(DEFAULT_SOURCES).unwrap();
        let s = srcs.iter().find(|s| s.id == "drivebc").unwrap();
        let item = json!({"id": 7, "name": "Hwy 1", "is_on": true, "marked_stale": false, "location": {"coordinates": [-123.1, 49.2]}});
        let f = feature(s, &item, &item, None).unwrap();
        assert_eq!(f["properties"]["i"], "https://www.drivebc.ca/images/7.jpg");
        let off = json!({"id": 8, "name": "x", "is_on": false, "location": {"coordinates": [-123.1, 49.2]}});
        assert!(feature(s, &off, &off, None).is_none());
    }
}
