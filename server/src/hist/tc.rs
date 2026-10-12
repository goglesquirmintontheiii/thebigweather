//! Historical tropical cyclone best tracks.
//!
//! - Atlantic, NE & NC Pacific: NHC HURDAT2 (public domain), file names discovered from
//!   <https://www.nhc.noaa.gov/data/>; refreshed monthly.
//! - Seasons newer than HURDAT2 (AL/EP/CP) and every other basin: NOAA NCEI IBTrACS v04r01 CSV
//!   (public domain; per-basin `ibtracs.<BASIN>.list.v04r01.csv`, plus `last3years` for the
//!   provisional Atlantic/East Pacific seasons). The files are large, so they are stream-parsed
//!   during download into a compact 6-hourly index (zstd JSON on disk) and never kept raw.
//!
//! Winds are 1-minute sustained knots (HURDAT2 / IBTrACS `USA_WIND`, falling back to `WMO_WIND`
//! when no US agency value exists), pressures hPa.

use super::{load_zst, save_zst};
use crate::overlays::Overlays;
use anyhow::{anyhow, bail, Result};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

const NHC_DATA: &str = "https://www.nhc.noaa.gov/data/";
const HURDAT_AL: &str = "hurdat2-1851-2025-092326.txt";
const HURDAT_EP: &str = "hurdat2-nepac-1949-2025-092926.txt";
const IBTRACS: &str = "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv";

/// One fix: unix s, lat, lon, wind kt (-1 missing), pressure hPa (-1 missing), status, landfall.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pt(pub i64, pub f32, pub f32, pub i16, pub i16, pub String, pub bool);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Storm {
    pub id: String,
    pub name: String,
    /// al | ep | cp | wp | io | sh
    pub basin: String,
    pub year: i32,
    pub pts: Vec<Pt>,
}

/// Sources by id: (refresh age, provisional?)
fn src_age(src: &str) -> Duration {
    match src {
        "recent" => Duration::from_secs(86400 * 7),
        _ => Duration::from_secs(86400 * 30),
    }
}

fn src_label(src: &str) -> &'static str {
    match src {
        "al" | "nepac" => "HURDAT2",
        "recent" => "IBTrACS (provisional)",
        _ => "IBTrACS",
    }
}

/// Sources holding a basin.
fn basin_sources(b: &str) -> &'static [&'static str] {
    match b {
        "al" => &["al", "recent"],
        "ep" | "cp" => &["nepac", "recent"],
        "wp" => &["wp"],
        "io" => &["ni"],
        "sh" => &["si", "sp", "sa"],
        _ => &[],
    }
}

const BASINS: &[&str] = &["al", "ep", "cp", "wp", "io", "sh"];

// ---------- categories ----------

/// Saffir–Simpson-style category from 1-minute wind (kt) and status.
pub fn category(w: i16, status: &str) -> &'static str {
    match status {
        "EX" | "ET" | "PT" => return "EX",
        "LO" | "WV" | "DB" | "DS" | "IN" | "MD" => return "LO",
        "SD" => return "SD",
        "SS" => return "SS",
        _ => {}
    }
    wind_cat(w)
}

fn wind_cat(w: i16) -> &'static str {
    match w {
        i16::MIN..=33 => "TD",
        34..=63 => "TS",
        64..=82 => "H1",
        83..=95 => "H2",
        96..=112 => "H3",
        113..=136 => "H4",
        _ => "H5",
    }
}

fn is_tropical(status: &str) -> bool {
    !matches!(status, "EX" | "ET" | "PT" | "LO" | "WV" | "DB" | "DS" | "IN" | "MD")
}

// ---------- HURDAT2 ----------

fn hurdat_ll(s: &str) -> Option<f32> {
    let s = s.trim();
    let (v, h) = s.split_at(s.len().checked_sub(1)?);
    let v: f32 = v.trim().parse().ok()?;
    Some(if h == "S" || h == "W" { -v } else { v })
}

fn basin_of_atcf(id: &str) -> &'static str {
    match id.get(..2).unwrap_or("") {
        "AL" => "al",
        "EP" => "ep",
        "CP" => "cp",
        "WP" => "wp",
        "IO" | "BB" | "AS" => "io",
        "SH" | "SP" | "SI" => "sh",
        _ => "",
    }
}

/// Parse a HURDAT2 file: synoptic (00/06/12/18 UTC) fixes plus landfall ("L") records.
pub fn parse_hurdat(txt: &str) -> Vec<Storm> {
    let mut out: Vec<Storm> = vec![];
    for line in txt.lines() {
        let f: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if f.len() >= 3 && f[0].len() == 8 && f[0].chars().take(2).all(|c| c.is_ascii_alphabetic()) {
            let id = f[0].to_ascii_uppercase();
            out.push(Storm {
                year: id[4..].parse().unwrap_or(0),
                basin: basin_of_atcf(&id).to_string(),
                name: f[1].to_string(),
                id,
                pts: vec![],
            });
            continue;
        }
        if f.len() < 8 || f[0].len() != 8 {
            continue;
        }
        let Some(s) = out.last_mut() else { continue };
        let Ok(t) = NaiveDateTime::parse_from_str(&format!("{}{}", f[0], f[1]), "%Y%m%d%H%M") else { continue };
        let landfall = f[2] == "L";
        let hhmm: u32 = f[1].parse().unwrap_or(1);
        if hhmm % 600 != 0 && !landfall {
            continue;
        }
        let (Some(lat), Some(lon)) = (hurdat_ll(f[4]), hurdat_ll(f[5])) else { continue };
        let w = f[6].parse::<i16>().ok().filter(|v| *v >= 0).unwrap_or(-1);
        let p = f[7].parse::<i16>().ok().filter(|v| *v > 0).unwrap_or(-1);
        s.pts.push(Pt(t.and_utc().timestamp(), lat, lon, w, p, f[3].to_string(), landfall));
    }
    out.retain(|s| !s.pts.is_empty());
    out
}

/// Newest HURDAT2 file names listed on the NHC data page: (atlantic, nepac).
pub fn hurdat_names(html: &str) -> (Option<String>, Option<String>) {
    let mut best: [Option<((i32, String), String)>; 2] = [None, None];
    let mut i = 0;
    while let Some(p) = html[i..].find("hurdat2-") {
        let s = i + p;
        i = s + 8;
        let Some(e) = html[s..].find(".txt").map(|e| s + e + 4) else { break };
        let name = &html[s..e];
        if name.len() > 60 || name.contains(['/', '"', ' ', '<']) {
            continue;
        }
        let parts: Vec<&str> = name.trim_end_matches(".txt").split('-').collect();
        let (slot, yr, stamp) = match parts.as_slice() {
            ["hurdat2", "1851", y, st] => (0, y, st),
            ["hurdat2", "nepac", "1949", y, st] => (1, y, st),
            _ => continue,
        };
        let Ok(y) = yr.parse::<i32>() else { continue };
        // stamp is MMDDYY: compare as YYMMDD
        let k = (y, if stamp.len() == 6 { format!("{}{}", &stamp[4..], &stamp[..4]) } else { stamp.to_string() });
        if best[slot].as_ref().map(|(bk, _)| k > *bk).unwrap_or(true) {
            best[slot] = Some((k, name.to_string()));
        }
    }
    let [a, b] = best;
    (a.map(|x| x.1), b.map(|x| x.1))
}

// ---------- IBTrACS ----------

/// Streaming IBTrACS CSV parser (feed it lines; rows of one storm are contiguous).
pub struct IbParse {
    cols: Arc<HashMap<String, usize>>,
    pub storms: Vec<Storm>,
    cur_sid: String,
    cur: Option<Storm>,
    prev_d2l: Option<f32>,
    /// only keep storms whose first-row BASIN is in this list (empty: all)
    keep: Vec<&'static str>,
    seen: HashSet<String>,
}

impl IbParse {
    pub fn new(keep: Vec<&'static str>) -> Self {
        Self { cols: Arc::new(HashMap::new()), storms: vec![], cur_sid: String::new(), cur: None, prev_d2l: None, keep, seen: HashSet::new() }
    }

    fn flush(&mut self) {
        if let Some(s) = self.cur.take() {
            if !s.pts.is_empty() && self.seen.insert(s.id.clone()) {
                self.storms.push(s);
            }
        }
    }

    pub fn line(&mut self, line: &str) {
        let f: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if self.cols.is_empty() {
            if f.first() == Some(&"SID") {
                self.cols = Arc::new(f.iter().enumerate().map(|(i, c)| (c.to_string(), i)).collect());
            }
            return;
        }
        let cols = self.cols.clone();
        let g = |k: &str| cols.get(k).and_then(|&i| f.get(i)).copied().unwrap_or("");
        let Ok(season) = g("SEASON").parse::<i32>() else { return }; // units row
        let sid = g("SID");
        if sid != self.cur_sid {
            self.flush();
            self.cur_sid = sid.to_string();
            self.prev_d2l = None;
            let basin = g("BASIN");
            if !self.keep.is_empty() && !self.keep.contains(&basin) {
                return;
            }
            let atcf = g("USA_ATCF_ID").to_ascii_uppercase();
            let b = match basin {
                "NA" => "al",
                "EP" if atcf.starts_with("CP") => "cp",
                "EP" => "ep",
                "WP" => "wp",
                "NI" => "io",
                _ => "sh",
            };
            let name = match g("NAME") {
                "" | "NOT_NAMED" | "UNNAMED" => "UNNAMED".to_string(),
                n => n.to_string(),
            };
            self.cur = Some(Storm { id: if atcf.len() == 8 { atcf } else { sid.to_string() }, name, basin: b.to_string(), year: season, pts: vec![] });
        }
        let Some(s) = self.cur.as_mut() else { return };
        if s.id.len() != 8 {
            let a = g("USA_ATCF_ID").to_ascii_uppercase();
            if a.len() == 8 {
                s.id = a;
            }
        }
        let Ok(t) = NaiveDateTime::parse_from_str(g("ISO_TIME"), "%Y-%m-%d %H:%M:%S") else { return };
        let (Ok(lat), Ok(mut lon)) = (g("LAT").parse::<f32>(), g("LON").parse::<f32>()) else { return };
        if lon > 180.0 {
            lon -= 360.0;
        }
        let d2l = g("DIST2LAND").parse::<f32>().ok();
        let landfall = matches!((self.prev_d2l, d2l), (Some(a), Some(b)) if a > 0.0 && b <= 0.0);
        if d2l.is_some() {
            self.prev_d2l = d2l;
        }
        use chrono::Timelike;
        if !(t.minute() == 0 && t.hour() % 6 == 0) && !landfall {
            return;
        }
        let n = |k: &str| g(k).parse::<f32>().ok().filter(|v| *v >= 0.0).map(|v| v.round() as i16);
        let w = n("USA_WIND").or(n("WMO_WIND")).unwrap_or(-1);
        let p = n("USA_PRES").or(n("WMO_PRES")).filter(|p| *p > 0).unwrap_or(-1);
        let status = match g("USA_STATUS") {
            "" | "XX" => match g("NATURE") {
                "ET" => "EX",
                "DS" => "LO",
                "SS" => "SS",
                _ => "",
            },
            st => st,
        };
        s.pts.push(Pt(t.and_utc().timestamp(), (lat * 100.0).round() / 100.0, (lon * 100.0).round() / 100.0, w, p, status.to_string(), landfall));
    }

    pub fn finish(mut self) -> Vec<Storm> {
        self.flush();
        self.storms
    }
}

/// Download and stream-parse an IBTrACS CSV (never held in memory whole).
async fn ibtracs(o: &Overlays, file: &str, keep: Vec<&'static str>) -> Result<Vec<Storm>> {
    let url = format!("{IBTRACS}/{file}");
    let mut r = o.http.get(&url).timeout(Duration::from_secs(1200)).send().await?;
    if !r.status().is_success() {
        bail!("HTTP {} from www.ncei.noaa.gov ({file})", r.status());
    }
    let mut p = IbParse::new(keep);
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 20);
    while let Some(chunk) = r.chunk().await? {
        buf.extend_from_slice(&chunk);
        if let Some(last) = buf.iter().rposition(|&b| b == b'\n') {
            for l in buf[..last].split(|&b| b == b'\n') {
                p.line(&String::from_utf8_lossy(l));
            }
            buf.drain(..=last);
        }
    }
    if !buf.is_empty() {
        p.line(&String::from_utf8_lossy(&buf));
    }
    let s = p.finish();
    if s.is_empty() {
        bail!("no storms parsed from {file}");
    }
    Ok(s)
}

async fn fetch_source(o: &Overlays, src: &str) -> Result<Vec<Storm>> {
    match src {
        "al" | "nepac" => {
            let names = o.get_text(NHC_DATA).await.map(|h| hurdat_names(&h)).unwrap_or((None, None));
            let file = if src == "al" { names.0.unwrap_or_else(|| HURDAT_AL.into()) } else { names.1.unwrap_or_else(|| HURDAT_EP.into()) };
            let txt = o.get_text(&format!("{NHC_DATA}hurdat/{file}")).await?;
            let s = parse_hurdat(&txt);
            if s.is_empty() {
                bail!("no storms parsed from {file}");
            }
            Ok(s)
        }
        "recent" => ibtracs(o, "ibtracs.last3years.list.v04r01.csv", vec!["NA", "EP"]).await,
        "wp" => ibtracs(o, "ibtracs.WP.list.v04r01.csv", vec![]).await,
        "ni" => ibtracs(o, "ibtracs.NI.list.v04r01.csv", vec![]).await,
        "si" => ibtracs(o, "ibtracs.SI.list.v04r01.csv", vec![]).await,
        "sp" => ibtracs(o, "ibtracs.SP.list.v04r01.csv", vec![]).await,
        "sa" => ibtracs(o, "ibtracs.SA.list.v04r01.csv", vec![]).await,
        _ => bail!("unknown source {src}"),
    }
}

fn static_src(src: &str) -> Option<&'static str> {
    ["al", "nepac", "recent", "wp", "ni", "si", "sp", "sa"].into_iter().find(|s| *s == src)
}

/// A parsed source: memory → disk → download. A stale copy is served while a fresh one downloads
/// in the background; the big IBTrACS files are always fetched in the background (the first
/// request gets a "try again" error).
async fn source(o: &Arc<Overlays>, src: &str) -> Result<Arc<Vec<Storm>>> {
    let src = static_src(src).ok_or_else(|| anyhow!("unknown source"))?;
    let age = src_age(src);
    let mem = o.hist.tc.lock().get(src).cloned();
    if let Some((t, v)) = &mem {
        if t.elapsed() < age {
            return Ok(v.clone());
        }
    }
    let path = o.hist.dir.join("tc").join(format!("{src}.json.zst"));
    let mut stale = mem.map(|m| m.1);
    if stale.is_none() {
        let disk_age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
        if let Some(a) = disk_age {
            let lock = o.hist.lock_for(&format!("tc-load-{src}"));
            let _g = lock.lock().await;
            if let Some(v) = o.hist.tc.lock().get(src).map(|m| m.1.clone()) {
                return Ok(v);
            }
            if let Some(v) = load_zst::<Vec<Storm>>(&path, None) {
                let v = Arc::new(v);
                // keep it until the file itself is due for a refresh
                o.hist.tc.lock().insert(src, (Instant::now().checked_sub(a.min(age)).unwrap_or_else(Instant::now), v.clone()));
                if a < age {
                    return Ok(v);
                }
                stale = Some(v);
            }
        }
    }
    let failed = o.hist.tc_state.lock().1.get(src).filter(|(t, _)| t.elapsed() < Duration::from_secs(600)).map(|x| x.1.clone());
    if let Some(err) = failed {
        return stale.ok_or_else(|| anyhow!("{err}"));
    }
    let background = stale.is_some() || !matches!(src, "al" | "nepac");
    if background {
        if o.hist.tc_state.lock().0.insert(src) {
            let o2 = o.clone();
            tokio::spawn(async move {
                refresh(&o2, src).await.ok();
                o2.hist.tc_state.lock().0.remove(src);
            });
        }
        return stale.ok_or_else(|| anyhow!("downloading the {} {src} best-track archive (first use); try again in a few minutes", src_label(src)));
    }
    let lock = o.hist.lock_for(&format!("tc-{src}"));
    let _g = lock.lock().await;
    if let Some(v) = o.hist.tc.lock().get(src).filter(|(t, _)| t.elapsed() < age).map(|m| m.1.clone()) {
        return Ok(v);
    }
    refresh(o, src).await
}

async fn refresh(o: &Arc<Overlays>, src: &'static str) -> Result<Arc<Vec<Storm>>> {
    let name = format!("hist-tc-{src}");
    let label = format!("Storm history · {} ({src})", src_label(src));
    match fetch_source(o, src).await {
        Ok(v) => {
            o.health.ok(&name, &label, format!("{} storms", v.len()));
            let path = o.hist.dir.join("tc").join(format!("{src}.json.zst"));
            save_zst(&path, &v).map_err(|e| tracing::warn!("tc cache: {e:#}")).ok();
            let v = Arc::new(v);
            o.hist.tc.lock().insert(src, (Instant::now(), v.clone()));
            o.hist.tc_state.lock().1.remove(src);
            Ok(v)
        }
        Err(e) => {
            o.health.err(&name, &label, &e);
            o.hist.tc_state.lock().1.insert(src, (Instant::now(), format!("{e:#}")));
            Err(e)
        }
    }
}

// ---------- queries ----------

/// Summary of one storm (list item / detail properties).
pub fn summary(s: &Storm, src: &str) -> Value {
    let (mut maxw, mut minp) = (-1i16, i16::MAX);
    let mut trop_max = -1i16;
    let mut bb = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for p in &s.pts {
        maxw = maxw.max(p.3);
        if p.4 > 0 {
            minp = minp.min(p.4);
        }
        if is_tropical(&p.5) {
            trop_max = trop_max.max(p.3);
        }
        bb = [bb[0].min(p.2), bb[1].min(p.1), bb[2].max(p.2), bb[3].max(p.1)];
    }
    let landfalls: Vec<Value> = s.pts.iter().filter(|p| p.6).map(|p| json!({"t": p.0 * 1000, "lat": jf(p.1), "lon": jf(p.2), "vmax": nn(p.3), "cat": category(p.3, &p.5)})).collect();
    json!({
        "id": s.id, "name": s.name, "basin": s.basin, "year": s.year,
        "start": s.pts.first().map(|p| p.0 * 1000), "end": s.pts.last().map(|p| p.0 * 1000),
        "maxwind": nn(maxw), "minpres": if minp == i16::MAX { Value::Null } else { json!(minp) },
        "peak_cat": wind_cat(if trop_max >= 0 { trop_max } else { maxw }),
        "landfalls": landfalls,
        "bbox": bb.map(jf),
        "source": src_label(src),
    })
}

/// f32 → f64 for JSON output without float noise.
fn jf(v: f32) -> f64 {
    ((v as f64) * 100.0).round() / 100.0
}

fn nn(v: i16) -> Value {
    if v < 0 { Value::Null } else { json!(v) }
}

/// Storms of a basin from its sources (provisional IBTrACS only for seasons HURDAT2 lacks).
async fn basin_storms(o: &Arc<Overlays>, basin: &str, errors: &mut Vec<String>) -> Vec<(Arc<Vec<Storm>>, &'static str)> {
    let mut out = vec![];
    for &src in basin_sources(basin) {
        match source(o, src).await {
            Ok(v) => out.push((v, src)),
            Err(e) => errors.push(format!("{src}: {e:#}")),
        }
    }
    out
}

/// `GET /api/hist/tropical?basin=al|ep|cp|wp|io|sh|all&year=&from=&to=&q=&minwind=&limit=&offset=`
pub async fn list(o: &Arc<Overlays>, p: &HashMap<String, String>) -> Result<Value> {
    let g = |k: &str| p.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let basins: Vec<&str> = match g("basin").unwrap_or("al") {
        "all" => BASINS.to_vec(),
        b => b.split(',').map(|x| x.trim()).filter(|x| BASINS.contains(x)).collect(),
    };
    if basins.is_empty() {
        bail!("basin must be al, ep, cp, wp, io, sh or all");
    }
    let year = g("year").and_then(|s| s.parse::<i32>().ok());
    let from = year.or(g("from").and_then(|s| s.parse().ok())).unwrap_or(i32::MIN);
    let to = year.or(g("to").and_then(|s| s.parse().ok())).unwrap_or(i32::MAX);
    let q = g("q").map(|s| s.to_ascii_uppercase());
    let minwind = g("minwind").and_then(|s| s.parse::<i16>().ok()).unwrap_or(-1);
    let limit = g("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(1000).clamp(1, 5000);
    let offset = g("offset").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
    let mut errors = vec![];
    let mut items: Vec<(i64, Value)> = vec![];
    let f = StormFilter { from, to, q, minwind };
    for b in &basins {
        let sets = basin_storms(o, b, &mut errors).await;
        items.extend(pick(&sets, b, &f));
    }
    if items.is_empty() && !errors.is_empty() {
        bail!("{}", errors.join("; "));
    }
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let total = items.len();
    Ok(json!({
        "total": total, "offset": offset, "limit": limit,
        "errors": if errors.is_empty() { Value::Null } else { json!(errors) },
        "items": items.into_iter().skip(offset).take(limit).map(|x| x.1).collect::<Vec<_>>(),
    }))
}

pub struct StormFilter {
    pub from: i32,
    pub to: i32,
    /// upper-case name or id fragment
    pub q: Option<String>,
    /// kt; -1 = any
    pub minwind: i16,
}

/// Matching storms of one basin as (start, summary); provisional (IBTrACS) storms only for
/// seasons HURDAT2 doesn't cover yet.
pub fn pick(sets: &[(Arc<Vec<Storm>>, &'static str)], basin: &str, f: &StormFilter) -> Vec<(i64, Value)> {
    let mut hurdat_last: HashMap<&str, i32> = HashMap::new();
    for (v, src) in sets {
        if *src == "al" || *src == "nepac" {
            for s in v.iter() {
                let e = hurdat_last.entry(s.basin.as_str()).or_insert(0);
                *e = (*e).max(s.year);
            }
        }
    }
    let mut out = vec![];
    for (v, src) in sets {
        // one source may hold several basins (nepac: ep+cp; recent: al+ep+cp)
        for s in v.iter().filter(|s| s.basin == basin) {
            if *src == "recent" && s.year <= hurdat_last.get(s.basin.as_str()).copied().unwrap_or(0) {
                continue;
            }
            if s.year < f.from || s.year > f.to {
                continue;
            }
            if let Some(q) = &f.q {
                if !s.name.to_ascii_uppercase().contains(q.as_str()) && !s.id.contains(q.as_str()) {
                    continue;
                }
            }
            if f.minwind >= 0 && s.pts.iter().map(|p| p.3).max().unwrap_or(-1) < f.minwind {
                continue;
            }
            out.push((s.pts.first().map(|p| p.0).unwrap_or(0), summary(s, src)));
        }
    }
    out
}

/// Sources that may hold a storm id.
fn id_sources(id: &str) -> Vec<&'static str> {
    match basin_of_atcf(id) {
        "al" => vec!["al", "recent"],
        "ep" | "cp" => vec!["nepac", "recent"],
        b if !b.is_empty() => basin_sources(b).to_vec(),
        // IBTrACS SID: YYYYDDDHLLLLL (H = N/S)
        _ if id.as_bytes().get(7) == Some(&b'S') => vec!["si", "sp", "sa"],
        _ => vec!["wp", "ni", "recent"],
    }
}

/// `GET /api/hist/tropical/{id}` — the track as GeoJSON.
pub async fn track(o: &Arc<Overlays>, id: &str) -> Result<Value> {
    let id = id.trim().to_ascii_uppercase();
    if id.is_empty() || id.len() > 16 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("bad storm id");
    }
    let mut errors = vec![];
    for src in id_sources(&id) {
        let v = match source(o, src).await {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("{src}: {e:#}"));
                continue;
            }
        };
        // a provisional copy only when HURDAT2 doesn't have it (sources are searched in order)
        if let Some(s) = v.iter().find(|s| s.id == id) {
            return Ok(track_geojson(s, src));
        }
    }
    if !errors.is_empty() {
        bail!("{}", errors.join("; "));
    }
    bail!("storm {id} not found")
}

/// Track GeoJSON: LineString segments per category, then 6-hourly points.
pub fn track_geojson(s: &Storm, src: &str) -> Value {
    // unwrap longitudes so tracks crossing the dateline stay continuous
    let mut lons: Vec<f32> = Vec::with_capacity(s.pts.len());
    for p in &s.pts {
        let mut x = p.2;
        if let Some(&prev) = lons.last() {
            while x - prev > 180.0 {
                x -= 360.0;
            }
            while prev - x > 180.0 {
                x += 360.0;
            }
        }
        lons.push(x);
    }
    let cats: Vec<&str> = s.pts.iter().map(|p| category(p.3, &p.5)).collect();
    let mut feats = vec![];
    let mut i = 0;
    while i + 1 < s.pts.len() {
        let mut j = i;
        while j + 1 < s.pts.len() && cats[j + 1] == cats[i] {
            j += 1;
        }
        let end = (j + 1).min(s.pts.len() - 1);
        let coords: Vec<[f64; 2]> = (i..=end).map(|k| [jf(lons[k]), jf(s.pts[k].1)]).collect();
        let vmax = s.pts[i..=j].iter().map(|p| p.3).max().unwrap_or(-1);
        feats.push(json!({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"kind": "track", "cat": cats[i], "vmax": nn(vmax)}}));
        i = j + 1;
    }
    for (k, p) in s.pts.iter().enumerate() {
        feats.push(json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [jf(lons[k]), jf(p.1)]},
            "properties": {"kind": "fix", "t": p.0 * 1000, "vmax": nn(p.3), "mslp": nn(p.4), "status": p.5, "cat": cats[k], "landfall": p.6}}));
    }
    json!({"type": "FeatureCollection", "features": feats, "properties": summary(s, src)})
}

#[cfg(test)]
mod tests {
    use super::*;

    const HURDAT: &str = "AL011851,            UNNAMED,     14,
18510625, 0000,  , HU, 28.0N,  94.8W,  80, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999
18510625, 0600,  , HU, 28.0N,  95.4W,  80, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999, -999
AL092022,                IAN,     3,
20220928, 1200,  , HU, 26.3N,  82.3W, 135,  937, -999
20220928, 1905, L, HU, 26.7N,  82.2W, 130,  941, -999
20220929, 0000,  , HU, 27.0N,  81.9W,  90,  955, -999
20220929, 0300,  , HU, 27.2N,  81.7W,  80,  960, -999
20220930, 0000,  , EX, 30.0N, 179.5E,  45, 1000, -999
";

    #[test]
    fn hurdat() {
        let s = parse_hurdat(HURDAT);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].id, "AL011851");
        assert_eq!(s[0].year, 1851);
        assert_eq!(s[0].pts[0], Pt(-3740169600, 28.0, -94.8, 80, -1, "HU".into(), false));
        let ian = &s[1];
        assert_eq!((ian.name.as_str(), ian.basin.as_str()), ("IAN", "al"));
        assert_eq!(ian.pts.len(), 4, "non-synoptic, non-landfall rows dropped");
        assert!(ian.pts[1].6);
        assert_eq!(ian.pts[3].2, 179.5);
        let sm = summary(ian, "al");
        assert_eq!(sm["maxwind"], 135);
        assert_eq!(sm["minpres"], 937);
        assert_eq!(sm["peak_cat"], "H4");
        assert_eq!(sm["landfalls"].as_array().unwrap().len(), 1);
        assert_eq!(sm["landfalls"][0]["vmax"], 130);
    }

    #[test]
    fn list_filter() {
        let h = Arc::new(parse_hurdat(HURDAT));
        let mut prov = h[1].clone();
        prov.id = "AL052026".into();
        prov.name = "ZETA".into();
        prov.year = 2026;
        let old = h[1].clone(); // provisional copy of a season HURDAT2 already has
        let recent = Arc::new(vec![prov, old]);
        let sets = vec![(h, "al"), (recent, "recent")];
        let all = StormFilter { from: i32::MIN, to: i32::MAX, q: None, minwind: -1 };
        let r = pick(&sets, "al", &all);
        assert_eq!(r.iter().map(|x| x.1["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["AL011851", "AL092022", "AL052026"]);
        assert_eq!(r[2].1["source"], "IBTrACS (provisional)");
        assert_eq!(pick(&sets, "al", &StormFilter { q: Some("IAN".into()), ..all }).len(), 1);
        assert_eq!(pick(&sets, "al", &StormFilter { minwind: 100, from: 2000, to: 2022, q: None }).len(), 1);
        assert!(pick(&sets, "ep", &StormFilter { from: i32::MIN, to: i32::MAX, q: None, minwind: -1 }).is_empty());
    }

    #[test]
    fn categories() {
        assert_eq!(category(30, "TD"), "TD");
        assert_eq!(category(64, "HU"), "H1");
        assert_eq!(category(137, "HU"), "H5");
        assert_eq!(category(60, "EX"), "EX");
        assert_eq!(category(-1, ""), "TD");
    }

    #[test]
    fn names() {
        let html = r#"<a href="hurdat/hurdat2-1851-2024-040425.txt">x</a> <a href="hurdat/hurdat2-1851-2025-092326.txt">
            <a href="hurdat/hurdat2-nepac-1949-2025-092926.txt"> hurdat2-format-atl-1851-2021.pdf"#;
        let (a, e) = hurdat_names(html);
        assert_eq!(a.as_deref(), Some("hurdat2-1851-2025-092326.txt"));
        assert_eq!(e.as_deref(), Some("hurdat2-nepac-1949-2025-092926.txt"));
    }

    const IB: &str = "SID,SEASON,NUMBER,BASIN,SUBBASIN,NAME,ISO_TIME,NATURE,LAT,LON,WMO_WIND,WMO_PRES,WMO_AGENCY,TRACK_TYPE,DIST2LAND,LANDFALL,IFLAG,USA_AGENCY,USA_ATCF_ID,USA_LAT,USA_LON,USA_RECORD,USA_STATUS,USA_WIND,USA_PRES
 ,Year, , , , , , ,degrees_north,degrees_east,kts,mb, , ,km,km, , , ,degrees_north,degrees_east, , ,kts,mb
2024240N16136,2024,60,WP,MM,SHANSHAN,2024-08-27 00:00:00,TS,26.0,131.5,85,955,tokyo,main,300,250,O_____________, ,WP112024,26.0,131.5, ,TY,105,950
2024240N16136,2024,60,WP,MM,SHANSHAN,2024-08-27 03:00:00,TS,26.4,131.2, , , ,main,0,0,P_____________, ,WP112024,26.4,131.2,L,TY,100,952
2024240N16136,2024,60,WP,MM,SHANSHAN,2024-08-27 06:00:00,TS,26.8,130.9,80,960,tokyo,main,0,0,O_____________, ,WP112024,26.8,130.9, ,TY,95,955
2024300S12170,2024,70,SP,MM,NOT_NAMED,2024-10-26 00:00:00,TS,-12.0,179.8, , , ,main,500,400,_______________, , ,-12.0,179.8, , , ,
2024300S12170,2024,70,SP,MM,NOT_NAMED,2024-10-26 06:00:00,TS,-12.5,180.4,35,995,nadi,main,500,400,_______________, , ,-12.5,180.4, , , ,
";

    #[test]
    fn ibtracs_parse() {
        let mut p = IbParse::new(vec![]);
        for l in IB.lines() {
            p.line(l);
        }
        let s = p.finish();
        assert_eq!(s.len(), 2);
        let sh = &s[0];
        assert_eq!((sh.id.as_str(), sh.name.as_str(), sh.basin.as_str(), sh.year), ("WP112024", "SHANSHAN", "wp", 2024));
        assert_eq!(sh.pts.len(), 3, "03Z kept because it is a landfall");
        assert_eq!(sh.pts[0].3, 105, "USA wind preferred");
        assert!(sh.pts[1].6 && !sh.pts[2].6);
        assert_eq!(sh.pts[2].5, "TY");
        let sp = &s[1];
        assert_eq!((sp.id.as_str(), sp.name.as_str(), sp.basin.as_str()), ("2024300S12170", "UNNAMED", "sh"));
        assert_eq!(sp.pts[0].3, -1);
        assert_eq!(sp.pts[1].3, 35, "falls back to WMO wind");
        assert!((sp.pts[1].2 + 179.6).abs() < 0.01, "lon normalized to ±180");
        let g = track_geojson(sp, "sp");
        let line = &g["features"][0]["geometry"]["coordinates"];
        assert!((line[1][0].as_f64().unwrap() - 180.4).abs() < 0.01, "dateline unwrapped");
        assert_eq!(id_sources("2024300S12170"), vec!["si", "sp", "sa"]);
        // basin filter
        let mut p = IbParse::new(vec!["NA", "EP"]);
        for l in IB.lines() {
            p.line(l);
        }
        assert!(p.finish().is_empty());
    }

    #[test]
    fn track_segments() {
        let s = &parse_hurdat(HURDAT)[1];
        let g = track_geojson(s, "al");
        let f = g["features"].as_array().unwrap();
        let segs: Vec<&Value> = f.iter().filter(|x| x["properties"]["kind"] == "track").collect();
        // H4, H4 → H2 → EX: segments H4, H2(90) , then EX? (H1 is 80 at 03Z dropped)
        assert_eq!(segs.iter().map(|x| x["properties"]["cat"].as_str().unwrap()).collect::<Vec<_>>(), vec!["H4", "H2"]);
        assert_eq!(segs[0]["geometry"]["coordinates"].as_array().unwrap().len(), 3, "segment joins the next fix");
        assert_eq!(f.iter().filter(|x| x["properties"]["kind"] == "fix").count(), 4);
        // dateline unwrap: 179.5E after 81.9W → -180.5
        assert_eq!(f.last().unwrap()["geometry"]["coordinates"][0], json!(-180.5));
        assert_eq!(g["properties"]["id"], "AL092022");
    }
}
