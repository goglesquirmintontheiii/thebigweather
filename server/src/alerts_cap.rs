//! 0.8.2: CAP 1.2 alerts from outside the US — a small XML tree, a generic CAP parser, RSS / Atom
//! feed parsing (links to CAP documents, MeteoAlarm's Atom entries with inline CAP fields), the
//! ECCC GeoMet alert features, and geocode → geometry tables (MeteoAlarm EMMA_ID, BoM AMOC).
//! Every source ends up as GeoJSON features shaped like the NWS ones (see alerts.rs).

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use std::collections::HashMap;

/* ---------------------------------------------------------------- XML tree */

#[derive(Debug, Clone, Default)]
pub struct XNode {
    /// local name (namespace prefix dropped)
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub text: String,
    pub kids: Vec<XNode>,
}

impl XNode {
    pub fn child(&self, n: &str) -> Option<&XNode> {
        self.kids.iter().find(|k| k.name.eq_ignore_ascii_case(n))
    }
    pub fn children<'a>(&'a self, n: &'a str) -> impl Iterator<Item = &'a XNode> + 'a {
        self.kids.iter().filter(move |k| k.name.eq_ignore_ascii_case(n))
    }
    /// trimmed text of the first child named `n` ("" when missing)
    pub fn t(&self, n: &str) -> &str {
        self.child(n).map(|c| c.text.trim()).unwrap_or("")
    }
    pub fn attr(&self, n: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str())
    }
    /// every descendant (depth first, self included) named `n`
    pub fn find_all<'a>(&'a self, n: &str, out: &mut Vec<&'a XNode>) {
        if self.name.eq_ignore_ascii_case(n) {
            out.push(self);
        }
        for k in &self.kids {
            k.find_all(n, out);
        }
    }
}

fn local(s: &str) -> String {
    s.rsplit(':').next().unwrap_or(s).to_string()
}

fn entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        _ => return None,
    })
}

/// Parse a document into its root element (lenient: unknown entities are dropped, a truncated
/// document returns what was read).
pub fn parse_xml(s: &str) -> Option<XNode> {
    use quick_xml::events::Event;
    let mut rd = quick_xml::Reader::from_str(s);
    rd.config_mut().check_end_names = false;
    let mut stack: Vec<XNode> = vec![XNode { name: "#doc".into(), ..Default::default() }];
    let open = |e: &quick_xml::events::BytesStart| XNode {
        name: local(AsRef::<str>::as_ref(&e.name())),
        attrs: e.attributes().flatten().map(|a| (local(AsRef::<str>::as_ref(&a.key)), a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map(|v| v.into_owned()).unwrap_or_else(|_| a.value.to_string()))).collect(),
        ..Default::default()
    };
    loop {
        match rd.read_event() {
            Ok(Event::Start(e)) => stack.push(open(&e)),
            Ok(Event::Empty(e)) => {
                let n = open(&e);
                stack.last_mut()?.kids.push(n);
            }
            Ok(Event::End(_)) => {
                if stack.len() > 1 {
                    let n = stack.pop()?;
                    stack.last_mut()?.kids.push(n);
                }
            }
            Ok(Event::Text(t)) => stack.last_mut()?.text.push_str(&t.xml10_content()),
            Ok(Event::CData(t)) => stack.last_mut()?.text.push_str(&t.xml10_content()),
            Ok(Event::GeneralRef(r)) => {
                let c = if r.is_char_ref() { r.resolve_char_ref().ok().flatten() } else { entity(AsRef::<str>::as_ref(&r)) };
                if let Some(c) = c {
                    stack.last_mut()?.text.push(c);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    while stack.len() > 1 {
        let n = stack.pop()?;
        stack.last_mut()?.kids.push(n);
    }
    stack.pop()?.kids.into_iter().next()
}

/* ---------------------------------------------------------------- CAP 1.2 */

#[derive(Debug, Clone, Default)]
pub struct CapArea {
    pub desc: String,
    /// rings as [lon, lat]
    pub polygons: Vec<Vec<[f64; 2]>>,
    /// centre [lon, lat], radius km
    pub circles: Vec<([f64; 2], f64)>,
    pub geocodes: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default)]
pub struct CapInfo {
    pub lang: String,
    pub event: String,
    pub urgency: String,
    pub severity: String,
    pub certainty: String,
    pub headline: String,
    pub description: String,
    pub instruction: String,
    pub effective: String,
    pub onset: String,
    pub expires: String,
    pub sender_name: String,
    pub web: String,
    pub params: Vec<(String, String)>,
    pub areas: Vec<CapArea>,
}

#[derive(Debug, Clone, Default)]
pub struct CapAlert {
    pub identifier: String,
    pub sender: String,
    pub sent: String,
    pub status: String,
    pub msg_type: String,
    pub scope: String,
    /// identifiers this message updates or cancels
    pub references: Vec<String>,
    pub infos: Vec<CapInfo>,
}

impl CapInfo {
    pub fn param(&self, n: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str())
    }
}

/// "lat,lon lat,lon …" → ring of [lon, lat] (closed)
pub fn parse_polygon(s: &str) -> Option<Vec<[f64; 2]>> {
    let mut pts: Vec<[f64; 2]> = vec![];
    for p in s.split_whitespace() {
        let (a, b) = p.split_once(',')?;
        let (lat, lon) = (a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?);
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            return None;
        }
        pts.push([lon, lat]);
    }
    if pts.len() < 3 {
        return None;
    }
    if pts.first() != pts.last() {
        pts.push(pts[0]);
    }
    Some(pts)
}

/// "lat,lon radius_km"
pub fn parse_circle(s: &str) -> Option<([f64; 2], f64)> {
    let mut it = s.split_whitespace();
    let (a, b) = it.next()?.split_once(',')?;
    let r: f64 = it.next()?.parse().ok()?;
    Some(([b.trim().parse().ok()?, a.trim().parse().ok()?], r))
}

/// 32-sided polygon for a CAP circle (a zero radius gets 2 km so it stays visible)
pub fn circle_ring(c: [f64; 2], r_km: f64) -> Vec<[f64; 2]> {
    let r = r_km.max(2.0);
    let dlat = r / 111.2;
    let dlon = r / (111.2 * c[1].to_radians().cos().max(0.05));
    let mut v: Vec<[f64; 2]> = (0..32)
        .map(|i| {
            let a = i as f64 / 32.0 * std::f64::consts::TAU;
            [((c[0] + dlon * a.cos()) * 1e4).round() / 1e4, ((c[1] + dlat * a.sin()) * 1e4).round() / 1e4]
        })
        .collect();
    v.push(v[0]);
    v
}

fn parse_area(a: &XNode) -> CapArea {
    CapArea {
        desc: a.t("areaDesc").to_string(),
        polygons: a.children("polygon").filter_map(|p| parse_polygon(&p.text)).collect(),
        circles: a.children("circle").filter_map(|p| parse_circle(&p.text)).collect(),
        geocodes: a.children("geocode").map(|g| (g.t("valueName").to_string(), g.t("value").to_string())).filter(|(_, v)| !v.is_empty()).collect(),
    }
}

fn parse_info(i: &XNode) -> CapInfo {
    CapInfo {
        lang: i.t("language").to_string(),
        event: i.t("event").to_string(),
        urgency: i.t("urgency").to_string(),
        severity: i.t("severity").to_string(),
        certainty: i.t("certainty").to_string(),
        headline: i.t("headline").to_string(),
        description: i.t("description").to_string(),
        instruction: i.t("instruction").to_string(),
        effective: i.t("effective").to_string(),
        onset: i.t("onset").to_string(),
        expires: i.t("expires").to_string(),
        sender_name: i.t("senderName").to_string(),
        web: i.t("web").to_string(),
        params: i.children("parameter").map(|p| (p.t("valueName").to_string(), p.t("value").to_string())).collect(),
        areas: i.children("area").map(parse_area).collect(),
    }
}

/// A CAP `<alert>` element.
pub fn parse_cap(a: &XNode) -> Option<CapAlert> {
    if !a.name.eq_ignore_ascii_case("alert") {
        return None;
    }
    let identifier = a.t("identifier").to_string();
    if identifier.is_empty() {
        return None;
    }
    // "sender,identifier,sent sender,identifier,sent"
    let references = a.t("references").split_whitespace().filter_map(|r| r.split(',').nth(1).map(String::from)).collect();
    Some(CapAlert {
        identifier,
        sender: a.t("sender").to_string(),
        sent: a.t("sent").to_string(),
        status: a.t("status").to_string(),
        msg_type: a.t("msgType").to_string(),
        scope: a.t("scope").to_string(),
        references,
        infos: a.children("info").map(parse_info).collect(),
    })
}

pub fn parse_cap_str(s: &str) -> Option<CapAlert> {
    let root = parse_xml(s)?;
    if root.name.eq_ignore_ascii_case("alert") {
        return parse_cap(&root);
    }
    let mut v = vec![];
    root.find_all("alert", &mut v);
    v.into_iter().find_map(parse_cap)
}

/// The info block to show: English if there is one, else the first.
pub fn pick_info(a: &CapAlert) -> Option<&CapInfo> {
    a.infos.iter().find(|i| i.lang.to_ascii_lowercase().starts_with("en")).or_else(|| a.infos.first())
}

pub fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(s).or_else(|_| DateTime::parse_from_rfc2822(s)).map(|d| d.with_timezone(&Utc)).ok().or_else(|| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok().map(|n| n.and_utc()))
}

/* ---------------------------------------------------------------- feeds */

/// One feed entry: links to CAP documents, or a CAP alert embedded in the entry.
#[derive(Debug, Clone, Default)]
pub struct FeedEntry {
    pub cap_urls: Vec<String>,
    pub embedded: Option<CapAlert>,
    pub title: String,
}

fn absolute(base: &str, u: &str) -> Option<String> {
    let u = u.trim();
    if u.starts_with("http://") || u.starts_with("https://") {
        return Some(u.to_string());
    }
    if let Some(rest) = u.strip_prefix('/') {
        let scheme_end = base.find("://")? + 3;
        let host_end = base[scheme_end..].find('/').map(|i| i + scheme_end).unwrap_or(base.len());
        return Some(format!("{}/{}", &base[..host_end], rest));
    }
    None
}

fn looks_cap(url: &str, ty: &str) -> bool {
    let l = url.to_ascii_lowercase();
    ty.contains("cap") || ty.contains("xml") || l.contains("cap") || l.ends_with(".xml")
}

/// RSS `<item>`s / Atom `<entry>`s → CAP links (preferred: CAP-typed or CAP-looking links;
/// fallback: any link). A feed that is itself a CAP alert, or embeds `<alert>`s, is returned too.
/// `must` keeps only links containing it (a few feeds mix web pages and CAP files).
pub fn parse_feed(xml: &str, base: &str, must: Option<&str>) -> Vec<FeedEntry> {
    let Some(root) = parse_xml(xml) else { return vec![] };
    if root.name.eq_ignore_ascii_case("alert") {
        return parse_cap(&root).map(|a| vec![FeedEntry { embedded: Some(a), ..Default::default() }]).unwrap_or_default();
    }
    let mut items = vec![];
    root.find_all("item", &mut items);
    root.find_all("entry", &mut items);
    if items.is_empty() {
        // a bare list of alerts
        let mut al = vec![];
        root.find_all("alert", &mut al);
        return al.into_iter().filter_map(parse_cap).map(|a| FeedEntry { embedded: Some(a), ..Default::default() }).collect();
    }
    let mut out = vec![];
    for it in items {
        let mut emb = vec![];
        it.find_all("alert", &mut emb);
        let embedded = emb.into_iter().find_map(parse_cap);
        let mut pref = vec![];
        let mut fall = vec![];
        let mut links = vec![];
        it.find_all("link", &mut links);
        it.find_all("enclosure", &mut links);
        it.find_all("guid", &mut links);
        for l in links {
            let ty = l.attr("type").unwrap_or("").to_ascii_lowercase();
            let rel = l.attr("rel").unwrap_or("").to_ascii_lowercase();
            for raw in [l.attr("href"), l.attr("url"), Some(l.text.as_str())].into_iter().flatten() {
                let Some(u) = absolute(base, raw) else { continue };
                if must.is_some_and(|m| !u.contains(m)) {
                    continue;
                }
                if rel == "alternate" && ty.contains("html") {
                    fall.push(u);
                } else if looks_cap(&u, &ty) || rel == "enclosure" {
                    pref.push(u);
                } else {
                    fall.push(u);
                }
            }
        }
        let mut urls = if pref.is_empty() { fall } else { pref };
        urls.dedup();
        urls.truncate(1);
        if urls.is_empty() && embedded.is_none() {
            continue;
        }
        out.push(FeedEntry { cap_urls: urls, embedded, title: it.t("title").to_string() });
    }
    out
}

/* ---------------------------------------------------------------- geometry tables */

/// code → (name, polygons)
type GeoTable = HashMap<String, (String, Vec<Value>)>;

fn load_table(gz: &[u8]) -> GeoTable {
    use std::io::Read;
    let mut s = String::new();
    if flate2::read::GzDecoder::new(gz).read_to_string(&mut s).is_err() {
        return HashMap::new();
    }
    let v: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
    let mut m = HashMap::new();
    if let Some(o) = v.as_object() {
        for (k, e) in o {
            let polys = e["p"].as_array().cloned().unwrap_or_default();
            m.insert(k.clone(), (e["n"].as_str().unwrap_or("").to_string(), polys));
        }
    }
    m
}

/// MeteoAlarm EMMA_ID areas (derived from the MeteoAlarm geocode set, CC BY 4.0), simplified.
static EMMA: Lazy<GeoTable> = Lazy::new(|| load_table(include_bytes!("../data/emma_geocodes.json.gz")));
/// Australian BoM AMOC forecast / warning areas, simplified.
static AMOC: Lazy<GeoTable> = Lazy::new(|| load_table(include_bytes!("../data/amoc_geocodes.json.gz")));

/// Polygons for a geocode, from the bundled tables.
pub fn geocode_polys(name: &str, value: &str) -> Option<&'static Vec<Value>> {
    let n = name.to_ascii_uppercase();
    let t: &GeoTable = if n == "EMMA_ID" {
        &EMMA
    } else if n.starts_with("AMOC") {
        &AMOC
    } else {
        return None;
    };
    t.get(value).map(|(_, p)| p).filter(|p| !p.is_empty())
}

/// GeoJSON geometry for a set of areas: polygons and circles as given, geocodes through the
/// tables. Returns (geometry or Null, any area left unmapped).
pub fn areas_geometry(areas: &[CapArea]) -> (Value, bool) {
    let mut polys: Vec<Value> = vec![];
    let mut missing = false;
    for a in areas {
        let before = polys.len();
        for p in &a.polygons {
            polys.push(json!([crate::alerts::simplify_ring(p, 0.002)]));
        }
        for (c, r) in &a.circles {
            polys.push(json!([circle_ring(*c, *r)]));
        }
        if polys.len() == before {
            for (n, v) in &a.geocodes {
                if let Some(ps) = geocode_polys(n, v) {
                    polys.extend(ps.iter().cloned());
                }
            }
        }
        if polys.len() == before {
            missing = true;
        }
    }
    if polys.is_empty() { (Value::Null, missing) } else { (json!({"type": "MultiPolygon", "coordinates": polys}), missing) }
}

/* ---------------------------------------------------------------- features */

/// Where a feature comes from (alerts_intl.rs Source, minus the fetch details).
#[derive(Debug, Clone)]
pub struct SrcMeta<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub country: &'a str,
    pub region: &'a str,
    pub attribution: &'a str,
    /// fallback point when an alert's areas can't be mapped (centre of the country box)
    pub centre: [f64; 2],
}

/// Awareness level: MeteoAlarm / ECCC colour words, else CAP severity.
pub fn level_of(sev: &str, colour: &str) -> &'static str {
    let c = colour.to_ascii_lowercase();
    if c.contains("red") {
        return "red";
    }
    if c.contains("orange") || c.contains("amber") {
        return "orange";
    }
    if c.contains("yellow") {
        return "yellow";
    }
    if c.contains("green") {
        return "green";
    }
    match sev.to_ascii_lowercase().as_str() {
        "extreme" => "red",
        "severe" => "orange",
        "moderate" => "yellow",
        "minor" => "minor",
        _ => "unknown",
    }
}

fn cap1(s: &str) -> String {
    let s = s.trim();
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Title-case an event ("blizzard warning" → "Blizzard Warning") so ECCC types meet the NWS
/// colour table where they share a name.
pub fn title_case(s: &str) -> String {
    s.split_whitespace().map(|w| if w.len() <= 3 && ["of", "and", "for", "the"].contains(&w) { w.to_string() } else { cap1(w) }).collect::<Vec<_>>().join(" ")
}

#[allow(clippy::too_many_arguments)]
fn feature(src: &SrcMeta, id: &str, event: &str, info: Option<&CapInfo>, sent: &str, msg_type: &str, area_desc: &str, geom: Value, missing: bool, level: &str, link: &str, extra: Value) -> Value {
    let (geom, note) = if geom.is_null() {
        (json!({"type": "Point", "coordinates": src.centre}), Some("Area not mapped: shown at the country's centre"))
    } else if missing {
        (geom, Some("Some areas could not be mapped"))
    } else {
        (geom, None)
    };
    let g = |f: fn(&CapInfo) -> &str| info.map(f).unwrap_or("").to_string();
    let event = if event.is_empty() { "Weather Alert".to_string() } else { event.to_string() };
    let warning = event.ends_with("Warning");
    let fid = format!("{}:{}", src.id, id);
    let mut props = json!({
        "id": fid,
        "event": event,
        "severity": g(|i| &i.severity),
        "urgency": g(|i| &i.urgency),
        "certainty": g(|i| &i.certainty),
        "headline": g(|i| &i.headline),
        "description": g(|i| &i.description),
        "lang": g(|i| &i.lang), // 0.8.3: lets the app offer Translate
        "instruction": g(|i| &i.instruction),
        "areaDesc": area_desc,
        "sent": sent,
        "effective": g(|i| &i.effective),
        "onset": g(|i| &i.onset),
        "expires": g(|i| &i.expires),
        "ends": Value::Null,
        "senderName": if info.is_some_and(|i| !i.sender_name.is_empty()) { g(|i| &i.sender_name) } else { src.name.to_string() },
        "messageType": if msg_type.is_empty() { "Alert" } else { msg_type },
        "from_zones": false,
        "flags": {"warning": warning},
        "src": src.id,
        "src_name": src.name,
        "region": src.region,
        "country": src.country,
        "attribution": src.attribution,
        "level": level,
        "link": link,
        "geom_note": note,
    });
    if let (Some(o), Some(e)) = (props.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    json!({"type": "Feature", "id": fid, "geometry": geom, "properties": props})
}

pub fn expired(expires: &str, now: DateTime<Utc>) -> bool {
    parse_time(expires).is_some_and(|t| t < now)
}

/// A CAP alert → one feature (all its areas in one geometry). None for tests, cancellations,
/// expired or non-public messages.
pub fn cap_feature(src: &SrcMeta, a: &CapAlert, now: DateTime<Utc>) -> Option<Value> {
    if !a.status.is_empty() && !a.status.eq_ignore_ascii_case("actual") {
        return None;
    }
    if a.msg_type.eq_ignore_ascii_case("cancel") || a.msg_type.eq_ignore_ascii_case("ack") || a.msg_type.eq_ignore_ascii_case("error") {
        return None;
    }
    let info = pick_info(a)?;
    if expired(&info.expires, now) {
        return None;
    }
    // every info block in the same language shares the areas; collect them from the picked one
    let (geom, missing) = areas_geometry(&info.areas);
    let area_desc = info.areas.iter().map(|x| x.desc.as_str()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("; ");
    let colour = info.param("awareness_level").or(info.param("colour")).or(info.param("color")).unwrap_or("");
    let level = level_of(&info.severity, colour);
    let event = cap1(&info.event);
    Some(feature(src, &a.identifier, &event, Some(info), &a.sent, &a.msg_type, &area_desc, geom, missing, level, &info.web, json!({})))
}

/// MeteoAlarm "legacy" Atom: each entry carries the CAP fields inline (one entry per area);
/// entries sharing an identifier are merged. Event = the feed's title wording ("Yellow Wind
/// Warning"), which is the same in every country.
pub fn meteoalarm_features(src: &SrcMeta, xml: &str, now: DateTime<Utc>) -> Vec<Value> {
    let Some(root) = parse_xml(xml) else { return vec![] };
    struct Acc {
        event: String,
        info: CapInfo,
        sent: String,
        msg_type: String,
        areas: Vec<CapArea>,
        link: String,
        cap_url: String,
    }
    let mut by: Vec<(String, Acc)> = vec![];
    for e in root.children("entry") {
        let status = e.t("status");
        if !status.is_empty() && !status.eq_ignore_ascii_case("actual") {
            continue;
        }
        let mt = e.t("message_type").to_string();
        if mt.eq_ignore_ascii_case("cancel") {
            continue;
        }
        let expires = e.t("expires").to_string();
        if expired(&expires, now) {
            continue;
        }
        let title = e.t("title");
        let event = title.split(" issued for").next().unwrap_or(title).trim().to_string();
        let event = if event.is_empty() { cap1(e.t("event")) } else { event };
        let area = CapArea {
            desc: e.t("areaDesc").to_string(),
            polygons: e.children("polygon").filter_map(|p| parse_polygon(&p.text)).collect(),
            circles: e.children("circle").filter_map(|p| parse_circle(&p.text)).collect(),
            geocodes: e.children("geocode").map(|g| (g.t("valueName").to_string(), g.t("value").to_string())).collect(),
        };
        let ident = e.t("identifier");
        let key = if ident.is_empty() { e.t("id").to_string() } else { format!("{ident}|{event}") };
        if let Some((_, acc)) = by.iter_mut().find(|(k, _)| *k == key) {
            acc.areas.push(area);
            continue;
        }
        let mut link = String::new();
        let mut cap_url = String::new();
        for l in e.children("link") {
            let href = l.attr("href").unwrap_or("");
            if l.attr("type").is_some_and(|t| t.contains("cap")) {
                cap_url = href.to_string();
            } else if l.attr("rel").is_none() && link.is_empty() {
                link = href.to_string();
            }
        }
        let info = CapInfo {
            event: event.clone(),
            urgency: e.t("urgency").into(),
            severity: e.t("severity").into(),
            certainty: e.t("certainty").into(),
            headline: title.into(),
            effective: e.t("effective").into(),
            onset: e.t("onset").into(),
            expires,
            sender_name: src.name.into(),
            ..Default::default()
        };
        by.push((key, Acc { event, info, sent: e.t("sent").into(), msg_type: mt, areas: vec![area], link, cap_url }));
    }
    by.into_iter()
        .map(|(key, a)| {
            let (geom, missing) = areas_geometry(&a.areas);
            let desc = a.areas.iter().map(|x| x.desc.as_str()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("; ");
            let level = level_of(&a.info.severity, &a.event);
            let id = key.split('|').next().unwrap_or(&key).to_string() + "|" + &a.event.replace(' ', "_");
            feature(src, &id, &a.event, Some(&a.info), &a.sent, &a.msg_type, &desc, geom, missing, level, &a.link, json!({"cap_url": a.cap_url}))
        })
        .collect()
}

/// ECCC GeoMet OGC API `weather-alerts` items: one feature per alert per forecast region; grouped
/// back into one alert per (identifier or name/type/times).
pub fn geomet_features(src: &SrcMeta, fc: &Value, now: DateTime<Utc>) -> Vec<Value> {
    let s = |p: &Value, k: &str| -> String {
        for kk in [format!("{k}_en"), k.to_string(), format!("{k}_fr")] {
            if let Some(v) = p[&kk].as_str() {
                if !v.trim().is_empty() {
                    return v.trim().to_string();
                }
            }
        }
        String::new()
    };
    struct Acc {
        info: CapInfo,
        sent: String,
        level: &'static str,
        id: String,
        extra: Value,
        polys: Vec<Value>,
        areas: Vec<String>,
    }
    let mut by: Vec<(String, Acc)> = vec![];
    for f in fc["features"].as_array().map(|v| v.as_slice()).unwrap_or(&[]) {
        let p = &f["properties"];
        let ty = s(p, "alert_type").to_ascii_lowercase();
        let status = s(p, "status").to_ascii_lowercase();
        if ty == "ended" || status.contains("ended") || status.contains("cancel") {
            continue;
        }
        let expires = s(p, "expiration_datetime");
        let expires = if expires.is_empty() { s(p, "event_end_datetime") } else { expires };
        if expired(&expires, now) {
            continue;
        }
        let name = s(p, "alert_name");
        let name = if name.is_empty() { s(p, "alert_short_name") } else { name };
        let sent = s(p, "publication_datetime");
        let ident = s(p, "identifier");
        let key = if ident.is_empty() { format!("{}|{}|{}|{}|{}", s(p, "province"), name, ty, sent, expires) } else { ident };
        let area = s(p, "feature_name");
        let g = &f["geometry"];
        let mut polys: Vec<Value> = vec![];
        match g["type"].as_str() {
            Some("Polygon") => polys.push(g["coordinates"].clone()),
            Some("MultiPolygon") => polys.extend(g["coordinates"].as_array().cloned().unwrap_or_default()),
            _ => {}
        }
        if let Some((_, acc)) = by.iter_mut().find(|(k, _)| *k == key) {
            acc.polys.extend(polys);
            if !area.is_empty() && !acc.areas.contains(&area) {
                acc.areas.push(area);
            }
            continue;
        }
        let colour = s(p, "risk_colour");
        let event = title_case(&name);
        let info = CapInfo {
            event: event.clone(),
            severity: match colour.to_ascii_lowercase().as_str() {
                "red" => "Extreme".into(),
                "orange" => "Severe".into(),
                "yellow" => "Moderate".into(),
                _ => String::new(),
            },
            urgency: String::new(),
            certainty: s(p, "confidence"),
            headline: if s(p, "alert_short_name").is_empty() { event.clone() } else { title_case(&s(p, "alert_short_name")) },
            description: s(p, "alert_text"),
            effective: s(p, "validity_datetime"),
            expires: expires.clone(),
            sender_name: "Environment and Climate Change Canada".into(),
            ..Default::default()
        };
        let level = level_of(&info.severity, &colour);
        let id_hash = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            key.hash(&mut h);
            format!("{:x}", h.finish())
        };
        let extra = json!({"impact": s(p, "impact"), "province": s(p, "province"), "alert_type": ty});
        by.push((key, Acc { info, sent, level, id: id_hash, extra, polys, areas: if area.is_empty() { vec![] } else { vec![area] } }));
    }
    by.into_iter()
        .map(|(_, a)| {
            let info = &a.info;
            let polys: Vec<Value> = a
                .polys
                .iter()
                .map(|pl| {
                    json!(pl.as_array().map(|rs| rs.iter().map(|r| {
                        let pts: Vec<[f64; 2]> = r.as_array().map(|v| v.iter().filter_map(|c| Some([c.get(0)?.as_f64()?, c.get(1)?.as_f64()?])).collect()).unwrap_or_default();
                        json!(crate::alerts::simplify_ring(&pts, 0.004))
                    }).collect::<Vec<_>>()).unwrap_or_default())
                })
                .collect();
            let geom = if polys.is_empty() { Value::Null } else { json!({"type": "MultiPolygon", "coordinates": polys}) };
            let mut desc = a.areas.clone();
            if desc.is_empty() {
                desc.push(a.extra["province"].as_str().unwrap_or("").to_string());
            }
            feature(src, &a.id, &info.event, Some(info), &a.sent, "Alert", &desc.join("; "), geom, false, a.level, "https://weather.gc.ca/warnings/index_e.html", a.extra.clone())
        })
        .collect()
}

#[cfg(test)]
#[path = "alerts_cap_tests.rs"]
pub(crate) mod tests;
