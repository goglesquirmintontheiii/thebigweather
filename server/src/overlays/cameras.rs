//! Traffic / weather cameras from many public sources, described in `data/camera_sources.json`
//! so lists can be fixed or extended without rebuilding (edit the copy in the server's data
//! folder; it is re-read when the camera list refreshes).

use super::{fc, point, Overlays};
use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;
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
    /// the camera database from data/uploads (loaded in the background)
    db: parking_lot::RwLock<Option<Arc<super::camdb::CamDb>>>,
    db_state: Mutex<(bool, Option<Instant>, String)>, // (loading, last check, message)
    /// combined live + database index, rebuilt when either changes
    index: Mutex<Option<(u64, Arc<super::camdb::Index>)>>,
    version: std::sync::atomic::AtomicU64,
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
/// Load (or reload, when the files changed) the camera database in the background.
fn ensure_db(o: &Arc<Overlays>) {
    {
        let mut st = o.cams.db_state.lock();
        if st.0 || st.1.map(|t| t.elapsed() < Duration::from_secs(60)).unwrap_or(false) {
            return;
        }
        st.0 = true;
        st.1 = Some(Instant::now());
    }
    let o = o.clone();
    tokio::spawn(async move {
        let root = o.data_dir.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let current = o.cams.db.read().as_ref().map(|d| d.stamp.clone());
        let res = tokio::task::spawn_blocking(move || {
            // cheap check first: same files as what's loaded → nothing to do
            let files = super::camdb::find_files(&root.join("uploads"));
            if files.is_empty() {
                return Ok(None);
            }
            if let Some(cur) = &current {
                let stamp = files
                    .iter()
                    .map(|p| {
                        let m = std::fs::metadata(p).ok();
                        let t = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                        format!("{}:{}:{}", p.file_name().and_then(|n| n.to_str()).unwrap_or(""), m.map(|m| m.len()).unwrap_or(0), t)
                    })
                    .collect::<Vec<_>>()
                    .join("|");
                if &stamp == cur {
                    return Ok(Some(None));
                }
            }
            super::camdb::load(&root).map(|d| d.map(Some))
        })
        .await;
        let mut st = o.cams.db_state.lock();
        st.0 = false;
        match res {
            Ok(Ok(Some(Some(db)))) => {
                let s = &db.stats;
                st.2 = format!("{} cameras from {} ({} records; {} inactive, {} duplicates removed)", s.kept, s.file, s.records, s.inactive, s.marked_duplicate + s.duplicate_in_file);
                o.health.ok("cam-db", "Camera database", &st.2);
                *o.cams.db.write() = Some(Arc::new(db));
                o.cams.version.fetch_add(1, Ordering::SeqCst);
            }
            Ok(Ok(Some(None))) => {}
            Ok(Ok(None)) => {
                if o.cams.db.write().take().is_some() {
                    o.cams.version.fetch_add(1, Ordering::SeqCst);
                }
                st.2 = "no camera database file in data/uploads".into();
            }
            Ok(Err(e)) => {
                st.2 = format!("{e:#}");
                o.health.err("cam-db", "Camera database", &e);
            }
            Err(e) => st.2 = e.to_string(),
        }
    });
}

fn to_cam(f: &Value) -> Option<super::camdb::Cam> {
    let p = &f["properties"];
    let c = &f["geometry"]["coordinates"];
    let s = |k: &str| p[k].as_str().map(|x| x.to_string());
    Some(super::camdb::Cam {
        id: s("id")?,
        name: s("n").unwrap_or_default(),
        src: s("s").unwrap_or_default(),
        lat: c[1].as_f64()? as f32,
        lon: c[0].as_f64()? as f32,
        t: s("t").unwrap_or_else(|| "img".into()),
        img: s("i"),
        video: s("v"),
        page: s("p"),
        refresh: p["r"].as_u64().unwrap_or(120) as u32,
        dir: None,
        nb: false,
        stale: false,
    })
}

/// Refresh live source lists that are due.
async fn refresh_sources(o: &Overlays, srcs: &[Source]) {
    let mut need = vec![];
    {
        let l = o.cams.lists.lock();
        for s in srcs {
            let ttl = if s.ttl > 0 { s.ttl } else { 1800 };
            if l.get(&s.id).map(|(t, _)| t.elapsed().as_secs() >= ttl).unwrap_or(true) {
                need.push(s.clone());
            }
        }
    }
    if need.is_empty() {
        return;
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
    o.cams.version.fetch_add(1, Ordering::SeqCst);
}

fn index(o: &Overlays, srcs: &[Source]) -> Arc<super::camdb::Index> {
    let ver = o.cams.version.load(Ordering::SeqCst);
    if let Some((g, idx)) = o.cams.index.lock().as_ref() {
        if *g == ver {
            return idx.clone();
        }
    }
    let live: Vec<super::camdb::Cam> = {
        let l = o.cams.lists.lock();
        srcs.iter().filter_map(|s| l.get(&s.id)).flat_map(|(_, v)| v.iter().filter_map(to_cam)).collect()
    };
    let db = o.cams.db.read().clone();
    let idx = Arc::new(super::camdb::Index::build(live, db.as_deref()));
    *o.cams.index.lock() = Some((ver, idx.clone()));
    idx
}

/// The combined camera index right now (for record-on-alert).
pub async fn index_now(o: &Arc<Overlays>) -> Arc<super::camdb::Index> {
    ensure_db(o);
    let srcs = sources(o);
    refresh_sources(o, &srcs).await;
    index(o, &srcs)
}

/// Cameras. With `bbox` (+ `z`, `off`, `kinds`) answers from the combined live + database index
/// (clustered when zoomed out); without it, every live camera (older apps).
pub async fn list(o: &Arc<Overlays>, q: &super::Params) -> Result<Value> {
    ensure_db(o);
    let srcs = sources(o);
    refresh_sources(o, &srcs).await;
    let idx = index(o, &srcs);
    // source list for the settings: live sources, then database sources
    let mut srcs_out = vec![];
    {
        let l = o.cams.lists.lock();
        for s in &srcs {
            let n = l.get(&s.id).map(|x| x.1.len()).unwrap_or(0);
            srcs_out.push(json!({"id": s.id, "name": s.name, "region": s.region, "count": n, "off": s.default_off, "attribution": s.attribution}));
        }
    }
    let db = o.cams.db.read().clone();
    let mut db_info = json!(null);
    if let Some(db) = &db {
        let kept: HashMap<&str, usize> = idx.cams.iter().filter(|c| c.src.starts_with("db:")).fold(HashMap::new(), |mut m, c| {
            *m.entry(c.src.as_str()).or_default() += 1;
            m
        });
        for (src, _) in &db.stats.sources {
            let n = kept.get(src.as_str()).copied().unwrap_or(0);
            srcs_out.push(json!({"id": src, "name": src.trim_start_matches("db:"), "region": "Camera database", "count": n, "off": false, "attribution": "Camera database"}));
        }
        db_info = json!({"stats": db.stats, "overlap_dropped": idx.dropped_overlap});
    }
    let msg = o.cams.db_state.lock().2.clone();
    let feats = match q.get("bbox") {
        Some(b) => {
            let v: Vec<f32> = b.split(',').filter_map(|x| x.parse().ok()).collect();
            if v.len() != 4 {
                return Err(anyhow!("bad bbox"));
            }
            let z: f32 = q.get("z").and_then(|z| z.parse().ok()).unwrap_or(6.0);
            let off: HashSet<String> = match q.get("off") {
                Some(x) => x.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                None => srcs.iter().filter(|s| s.default_off).map(|s| s.id.clone()).collect(),
            };
            idx.query([v[0], v[1], v[2], v[3]], z, &off, q.get("kinds").map(|s| s.as_str()).unwrap_or("all"))
        }
        None => idx.cams.iter().filter(|c| !c.src.starts_with("db:")).map(super::camdb::feature).collect(),
    };
    let mut out = fc(feats);
    out["sources"] = json!(srcs_out);
    out["db"] = db_info;
    out["db_msg"] = json!(msg);
    out["total"] = json!(idx.cams.len());
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
