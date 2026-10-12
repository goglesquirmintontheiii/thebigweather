//! Tornado damage surveys (NWS Damage Assessment Toolkit), the SPC historical tornado database,
//! and NHC tropical-storm wind-speed probabilities.

use super::agsquery::{self, f, parse_bbox, s, Query};
use super::{fc, round, Overlays};
use anyhow::{anyhow, bail, Result};
use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Utc};
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

// ---------- NWS Damage Assessment Toolkit ----------

const DAT: &str = "https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/FeatureServer";

fn trunc(s: String, n: usize) -> String {
    if s.len() <= n {
        return s;
    }
    let mut e = n;
    while !s.is_char_boundary(e) {
        e -= 1;
    }
    format!("{}…", &s[..e])
}

fn ms(p: &Value, k: &str) -> Value {
    p[k].as_i64().map(|v| json!(v)).unwrap_or(Value::Null)
}

fn opt(v: Option<f64>) -> Value {
    v.map(|x| json!((x * 100.0).round() / 100.0)).unwrap_or(Value::Null)
}

/// Normalize one DAT feature's properties (layer 0 points, 1 tracks, 2 swaths).
pub fn dat_props(kind: &str, p: &Value) -> Value {
    let comments = trunc(s(p, "comments"), 2000);
    match kind {
        "point" => json!({
            "kind": "point", "efscale": s(p, "efscale"), "event_date": ms(p, "stormdate"), "survey_date": ms(p, "surveydate"),
            "wfo": s(p, "office"), "comments": comments, "wind_mph": opt(f(p, "windspeed")), "event_id": s(p, "event_id"),
            "damage": s(p, "damage_txt"), "dod": s(p, "dod_txt"), "dir": s(p, "damage_dir"),
            "inj": opt(f(p, "injuries")), "fat": opt(f(p, "deaths")), "image": s(p, "image"),
        }),
        "track" => json!({
            "kind": "track", "efscale": s(p, "efscale"), "event_date": ms(p, "stormdate"), "start": ms(p, "starttime"), "end": ms(p, "endtime"),
            "survey_date": ms(p, "created_date"), "wfo": s(p, "wfo"), "comments": comments, "wind_mph": opt(f(p, "maxwind")), "event_id": s(p, "event_id"),
            "inj": opt(f(p, "injuries")), "fat": opt(f(p, "fatalities")), "len_mi": opt(f(p, "length")), "wid_yd": opt(f(p, "width")),
        }),
        _ => json!({
            "kind": "swath", "efscale": s(p, "efscale"), "event_date": ms(p, "stormdate"), "survey_date": ms(p, "created_date"),
            "wfo": Value::Null, "comments": comments, "wind_mph": Value::Null, "event_id": s(p, "event_id"),
            "inj": opt(f(p, "injuries")), "fat": opt(f(p, "fatalities")), "len_mi": opt(f(p, "length")), "wid_yd": opt(f(p, "width")),
        }),
    }
}

/// `where` clause for the last `days` days ("all" = everything).
pub fn dat_where(days: &str, now: chrono::DateTime<Utc>) -> Result<String> {
    let d: i64 = match days {
        "" => 7,
        "all" => return Ok("1=1".into()),
        x => x.parse().ok().filter(|d| (1..=3650).contains(d)).ok_or_else(|| anyhow!("days must be 7, 30, 365 or all"))?,
    };
    let t = now - chrono::Duration::days(d);
    Ok(format!("stormdate >= timestamp '{}'", t.format("%Y-%m-%d 00:00:00")))
}

pub async fn dat(o: &Overlays, days: &str, bbox: &str) -> Result<Value> {
    let w = dat_where(days, Utc::now())?;
    let bbox = parse_bbox(bbox)?;
    let layers = [(2, "swath", 3000usize), (1, "track", 4000), (0, "point", 8000)];
    let mut futs = vec![];
    for (id, kind, max) in layers {
        let url = format!("{DAT}/{id}");
        // some damage points have no storm date, only a survey date
        let w = if id == 0 && w != "1=1" { format!("({w}) OR (stormdate IS NULL AND {})", w.replace("stormdate", "surveydate")) } else { w.clone() };
        futs.push(async move {
            let q = Query { layer: &url, where_: &w, bbox, max, simplify: if id == 0 { 0.0 } else { 0.0002 }, order_by: "stormdate DESC", page: 2000, ..Default::default() };
            (kind, agsquery::features(o, &q).await)
        });
    }
    let mut feats = vec![];
    let mut errs = vec![];
    for (kind, r) in futures::future::join_all(futs).await {
        match r {
            Ok(v) => feats.extend(v.into_iter().filter(|x| !x["geometry"].is_null()).map(|mut x| {
                x["properties"] = dat_props(kind, &x["properties"]);
                x
            })),
            Err(e) => errs.push(format!("{kind}: {e:#}")),
        }
    }
    if errs.len() == 3 {
        bail!("{}", errs.join("; "));
    }
    Ok(fc(feats))
}

// ---------- SPC historical tornadoes ----------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Torn {
    pub om: i32,
    pub t: i64,
    pub mag: i8,
    pub inj: u16,
    pub fat: u16,
    pub st: [u8; 2],
    pub slat: f32,
    pub slon: f32,
    pub elat: f32,
    pub elon: f32,
    pub len: f32,
    pub wid: f32,
}

#[derive(Default)]
pub struct TornadoDb {
    rows: RwLock<Option<Arc<Vec<Torn>>>>,
    load: tokio::sync::Mutex<()>,
}

impl TornadoDb {
    pub fn mem_bytes(&self) -> (usize, usize) {
        self.rows.read().as_ref().map(|r| (r.len() * std::mem::size_of::<Torn>(), r.len())).unwrap_or((0, 0))
    }
    pub fn clear(&self) {
        *self.rows.write() = None;
    }
}

/// Parse the SPC "actual tornadoes" CSV (columns found by header name).
pub fn parse_tornadoes(csv_bytes: &[u8]) -> Result<Vec<Torn>> {
    let mut rd = csv::ReaderBuilder::new().flexible(true).from_reader(csv_bytes);
    let hdr: Vec<String> = rd.headers()?.iter().map(|h| h.trim().to_ascii_lowercase()).collect();
    let col = |n: &str| hdr.iter().position(|h| h == n);
    let need = |n: &str| col(n).ok_or_else(|| anyhow!("tornado CSV: no {n} column"));
    let (c_slat, c_slon, c_elat, c_elon, c_mag) = (need("slat")?, need("slon")?, need("elat")?, need("elon")?, need("mag")?);
    let (c_date, c_time, c_tz, c_st) = (col("date"), col("time"), col("tz"), col("st"));
    let (c_yr, c_mo, c_dy) = (col("yr"), col("mo"), col("dy"));
    let (c_inj, c_fat, c_len, c_wid, c_om) = (col("inj"), col("fat"), col("len"), col("wid"), col("om"));
    let mut out = Vec::with_capacity(72_000);
    for rec in rd.records() {
        let Ok(r) = rec else { continue };
        let g = |c: Option<usize>| c.and_then(|i| r.get(i)).unwrap_or("").trim();
        let n = |c: Option<usize>| g(c).parse::<f64>().ok();
        let date = match c_date.map(|_| g(c_date)).and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()) {
            Some(d) => d,
            None => match (n(c_yr), n(c_mo), n(c_dy)) {
                (Some(y), Some(m), Some(d)) => match NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32) {
                    Some(x) => x,
                    None => continue,
                },
                _ => continue,
            },
        };
        let time = chrono::NaiveTime::parse_from_str(g(c_time), "%H:%M:%S").unwrap_or_default();
        // tz 3 = CST (all but a few records), 9 = GMT
        let off_h = if g(c_tz) == "9" { 0 } else { 6 };
        let t = Utc.from_utc_datetime(&NaiveDateTime::new(date, time)).timestamp_millis() + off_h * 3_600_000;
        let (Some(slat), Some(slon)) = (n(Some(c_slat)), n(Some(c_slon))) else { continue };
        if slat == 0.0 || slon == 0.0 {
            continue;
        }
        let (mut elat, mut elon) = (n(Some(c_elat)).unwrap_or(0.0), n(Some(c_elon)).unwrap_or(0.0));
        if elat == 0.0 || elon == 0.0 {
            elat = 0.0;
            elon = 0.0;
        }
        let st = g(c_st).as_bytes();
        out.push(Torn {
            om: n(c_om).unwrap_or(0.0) as i32,
            t,
            mag: n(Some(c_mag)).map(|m| if m < 0.0 { -1 } else { m as i8 }).unwrap_or(-1),
            inj: n(c_inj).unwrap_or(0.0).max(0.0) as u16,
            fat: n(c_fat).unwrap_or(0.0).max(0.0) as u16,
            st: [st.first().copied().unwrap_or(b' '), st.get(1).copied().unwrap_or(b' ')],
            slat: slat as f32,
            slon: slon as f32,
            elat: elat as f32,
            elon: elon as f32,
            len: n(c_len).unwrap_or(0.0).max(0.0) as f32,
            wid: n(c_wid).unwrap_or(0.0).max(0.0) as f32,
        });
    }
    if out.len() < 100 {
        bail!("tornado CSV: only {} rows", out.len());
    }
    Ok(out)
}

/// `from`/`to`: unix ms or YYYY[-MM[-DD]].
pub fn parse_time(s: &str, end: bool) -> Result<Option<i64>> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.len() > 8 && s.chars().all(|c| c.is_ascii_digit() || c == '-') && !s.contains('-') {
        return Ok(Some(s.parse()?));
    }
    let parts: Vec<&str> = s.split('-').collect();
    let y: i32 = parts[0].parse().map_err(|_| anyhow!("bad date {s}"))?;
    let m: u32 = parts.get(1).map(|x| x.parse()).transpose().map_err(|_| anyhow!("bad date {s}"))?.unwrap_or(if end { 12 } else { 1 });
    let d0 = NaiveDate::from_ymd_opt(y, m, 1).ok_or_else(|| anyhow!("bad date {s}"))?;
    let d = match parts.get(2) {
        Some(x) => NaiveDate::from_ymd_opt(y, m, x.parse().map_err(|_| anyhow!("bad date {s}"))?).ok_or_else(|| anyhow!("bad date {s}"))?,
        None if end => {
            let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            NaiveDate::from_ymd_opt(ny, nm, 1).unwrap() - chrono::Duration::days(1)
        }
        None => d0,
    };
    let t = Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).timestamp_millis();
    Ok(Some(if end { t + 86_400_000 - 1 } else { t }))
}

/// Filter, rank (strongest first) and cap.
pub fn select_tornadoes(rows: &[Torn], bbox: Option<[f64; 4]>, from: Option<i64>, to: Option<i64>, minmag: Option<i8>, cap: usize) -> Vec<Torn> {
    let mut v: Vec<Torn> = rows
        .iter()
        .filter(|r| from.map(|f| r.t >= f).unwrap_or(true) && to.map(|t| r.t <= t).unwrap_or(true))
        .filter(|r| minmag.map(|m| r.mag >= m).unwrap_or(true))
        .filter(|r| match bbox {
            None => true,
            Some([w, s, e, n]) => {
                let (elat, elon) = if r.elat == 0.0 { (r.slat, r.slon) } else { (r.elat, r.elon) };
                let (lo_x, hi_x) = (r.slon.min(elon) as f64, r.slon.max(elon) as f64);
                let (lo_y, hi_y) = (r.slat.min(elat) as f64, r.slat.max(elat) as f64);
                hi_x >= w && lo_x <= e && hi_y >= s && lo_y <= n
            }
        })
        .copied()
        .collect();
    v.sort_by(|a, b| b.mag.cmp(&a.mag).then(b.fat.cmp(&a.fat)).then(b.len.total_cmp(&a.len)).then(b.t.cmp(&a.t)));
    v.truncate(cap);
    v
}

pub fn tornado_feature(r: &Torn) -> Value {
    let geom = if r.elat == 0.0 {
        json!({"type": "Point", "coordinates": [round(r.slon as f64), round(r.slat as f64)]})
    } else {
        json!({"type": "LineString", "coordinates": [[round(r.slon as f64), round(r.slat as f64)], [round(r.elon as f64), round(r.elat as f64)]]})
    };
    json!({"type": "Feature", "geometry": geom, "properties": {
        "om": r.om, "date": r.t, "mag": if r.mag < 0 { Value::Null } else { json!(r.mag) }, "inj": r.inj, "fat": r.fat,
        "len_mi": (r.len * 100.0).round() / 100.0, "wid_yd": r.wid.round(), "st": String::from_utf8_lossy(&r.st).trim().to_string(),
    }})
}

impl Overlays {
    async fn tornado_rows(&self) -> Result<Arc<Vec<Torn>>> {
        if let Some(r) = self.tornadoes.rows.read().clone() {
            return Ok(r);
        }
        let _g = self.tornadoes.load.lock().await;
        if let Some(r) = self.tornadoes.rows.read().clone() {
            return Ok(r);
        }
        let path = self.data_dir.join("spc_tornadoes.csv");
        let fresh = std::fs::metadata(&path).and_then(|m| m.modified()).ok().map(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(30 * 86400)).unwrap_or(false);
        let mut bytes = if fresh { tokio::fs::read(&path).await.ok() } else { None };
        if bytes.is_none() {
            // the file is named for its last year, which moves forward each spring
            let y = Utc::now().year();
            let mut err = None;
            for yr in [y - 1, y - 2, y - 3] {
                let url = format!("https://www.spc.noaa.gov/wcm/data/1950-{yr}_actual_tornadoes.csv");
                match self.get_bytes(&url).await {
                    Ok(b) if b.len() > 100_000 => {
                        let tmp = path.with_extension("part");
                        if tokio::fs::write(&tmp, &b).await.is_ok() {
                            tokio::fs::rename(&tmp, &path).await.ok();
                        }
                        bytes = Some(b.to_vec());
                        break;
                    }
                    Ok(_) => err = Some(anyhow!("{url}: empty")),
                    Err(e) => err = Some(e),
                }
            }
            if bytes.is_none() {
                // a stale copy beats nothing
                bytes = tokio::fs::read(&path).await.ok();
            }
            if bytes.is_none() {
                return Err(err.unwrap_or_else(|| anyhow!("SPC tornado database unavailable")));
            }
        }
        let b = bytes.unwrap_or_default();
        let rows = Arc::new(tokio::task::spawn_blocking(move || parse_tornadoes(&b)).await??);
        *self.tornadoes.rows.write() = Some(rows.clone());
        Ok(rows)
    }
}

pub async fn tornado_hist(o: &Overlays, bbox: &str, from: &str, to: &str, minmag: &str) -> Result<Value> {
    let bbox = parse_bbox(bbox)?;
    let (from, to) = (parse_time(from, false)?, parse_time(to, true)?);
    let minmag = match minmag.trim() {
        "" => None,
        m => Some(m.parse::<i8>().ok().filter(|m| (0..=5).contains(m)).ok_or_else(|| anyhow!("minmag must be 0-5"))?),
    };
    let rows = o.tornado_rows().await?;
    let sel = tokio::task::spawn_blocking(move || select_tornadoes(&rows, bbox, from, to, minmag, 20_000)).await?;
    let total = sel.len();
    let mut v = fc(sel.iter().map(tornado_feature).collect());
    v["count"] = json!(total);
    v["capped"] = json!(total >= 20_000);
    Ok(v)
}

// ---------- NHC wind-speed probabilities ----------

const NHC_TW: &str = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";

/// "5-10%" → (5, 10); "<5%" → (0, 5); ">90%" → (90, 100).
pub fn prob_range(s: &str) -> Option<(f64, f64)> {
    let t = s.trim().trim_end_matches('%').trim();
    if let Some(x) = t.strip_prefix('<') {
        return Some((0.0, x.trim().parse().ok()?));
    }
    if let Some(x) = t.strip_prefix('>') {
        return Some((x.trim().parse().ok()?, 100.0));
    }
    let (a, b) = t.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().trim_end_matches('%').parse().ok()?))
}

pub async fn nhc_wsp(o: &Overlays, kt: &str) -> Result<Value> {
    let layer = match kt {
        "" | "34" => 395,
        "50" => 396,
        "64" => 397,
        _ => bail!("kt must be 34, 50 or 64"),
    };
    let ktv = [34, 50, 64][layer - 395];
    let url = format!("{NHC_TW}/{layer}");
    let q = Query { layer: &url, fields: "percentage,idp_filedate", max: 4000, simplify: 0.01, page: 1000, ..Default::default() };
    let feats = agsquery::features(o, &q).await?;
    let mut issued = None;
    let out: Vec<Value> = feats
        .into_iter()
        .filter_map(|mut x| {
            let label = s(&x["properties"], "percentage");
            let (lo, hi) = prob_range(&label)?;
            if hi <= 5.0 {
                return None;
            }
            if issued.is_none() {
                issued = x["properties"]["idp_filedate"].as_i64();
            }
            x["properties"] = json!({"prob": lo, "prob_hi": hi, "label": label, "kt": ktv});
            Some(x)
        })
        .collect();
    let mut v = fc(out);
    v["issued"] = json!(issued);
    v["kt"] = json!(ktv);
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSV: &str = "om,yr,mo,dy,date,time,tz,st,stf,stn,mag,inj,fat,loss,closs,slat,slon,elat,elon,len,wid,ns,sn,sg,f1,f2,f3,f4,fc\n\
        192,1950,10,1,1950-10-01,21:00:00,3,OK,40,23,1,0,0,4,0,36.73,-102.52,36.88,-102.52,15.8,10,1,1,1,25,0,0,0,0\n\
        193,1950,10,9,1950-10-09,02:15:00,3,NC,37,9,3,3,0,5,0,34.17,-78.6,0,0,2,880,1,1,1,47,0,0,0,0\n\
        620001,2024,5,6,2024-05-06,20:30:00,3,OK,40,0,4,30,2,0,0,36.7,-96.2,36.8,-96.0,40.1,1400,1,1,1,113,0,0,0,0\n\
        620002,2024,5,7,2024-05-07,12:00:00,9,TX,48,0,-9,0,0,0,0,30.1,-97.1,30.2,-97.0,1.2,50,1,1,1,1,0,0,0,0\n";

    fn rows() -> Vec<Torn> {
        let mut s = String::from(CSV);
        // parse_tornadoes wants a real file; pad with copies
        let line = CSV.lines().nth(3).unwrap().to_string();
        for _ in 0..100 {
            s.push_str(&line);
            s.push('\n');
        }
        parse_tornadoes(s.as_bytes()).unwrap()
    }

    #[test]
    fn parses_spc_csv() {
        let r = rows();
        assert_eq!(r[0].om, 192);
        assert_eq!(r[0].mag, 1);
        assert_eq!(r[0].t, Utc.with_ymd_and_hms(1950, 10, 2, 3, 0, 0).unwrap().timestamp_millis());
        assert_eq!(&r[1].st, b"NC");
        assert_eq!(r[1].elat, 0.0);
        assert_eq!(r[3].mag, -1);
        assert_eq!(r[3].t, Utc.with_ymd_and_hms(2024, 5, 7, 12, 0, 0).unwrap().timestamp_millis());
        let f = tornado_feature(&r[1]);
        assert_eq!(f["geometry"]["type"], "Point");
        assert_eq!(tornado_feature(&r[2])["properties"]["wid_yd"], 1400.0);
    }

    #[test]
    fn selects_tornadoes() {
        let r = rows();
        let from = parse_time("2024", false).unwrap();
        let to = parse_time("2024-05", true).unwrap();
        let v = select_tornadoes(&r[..4], None, from, to, None, 10);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].mag, 4);
        assert_eq!(select_tornadoes(&r[..4], None, None, None, Some(1), 10).len(), 3);
        assert_eq!(select_tornadoes(&r[..4], Some([-103.0, 36.0, -102.0, 37.0]), None, None, None, 10).len(), 1);
        assert_eq!(select_tornadoes(&r, None, None, None, None, 3).len(), 3);
        assert_eq!(parse_time("1714953600000", false).unwrap(), Some(1714953600000));
        assert_eq!(parse_time("2024-05-07", true).unwrap(), Some(Utc.with_ymd_and_hms(2024, 5, 8, 0, 0, 0).unwrap().timestamp_millis() - 1));
    }

    #[test]
    fn dat_shapes() {
        let now = Utc.with_ymd_and_hms(2026, 10, 12, 5, 0, 0).unwrap();
        assert_eq!(dat_where("7", now).unwrap(), "stormdate >= timestamp '2026-10-05 00:00:00'");
        assert_eq!(dat_where("all", now).unwrap(), "1=1");
        assert!(dat_where("x", now).is_err());
        assert_eq!(f(&json!({"windspeed": "N/A"}), "windspeed"), None);
        let p = dat_props("track", &json!({"efscale": "EF1", "stormdate": 1756771200000i64, "wfo": "BUF", "maxwind": 110, "length": 3.78, "width": 150, "comments": "x"}));
        assert_eq!(p["kind"], "track");
        assert_eq!(p["wind_mph"], 110.0);
        assert_eq!(p["wid_yd"], 150.0);
        let p = dat_props("point", &json!({"efscale": "EF0", "windspeed": "85", "office": "DTX"}));
        assert_eq!(p["wfo"], "DTX");
        assert_eq!(p["wind_mph"], 85.0);
    }

    #[test]
    fn wsp_ranges() {
        assert_eq!(prob_range("5-10%"), Some((5.0, 10.0)));
        assert_eq!(prob_range("<5%"), Some((0.0, 5.0)));
        assert_eq!(prob_range(">90%"), Some((90.0, 100.0)));
        assert_eq!(prob_range("x"), None);
    }
}
