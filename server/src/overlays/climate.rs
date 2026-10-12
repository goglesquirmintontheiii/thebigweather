//! Climate summaries from NOAA RCC ACIS (keyless): nearest station's recent daily data with
//! 1991-2020 normals, departures and daily records, and daily records set in a map area.
//! Units are ACIS defaults: °F and inches.

use super::agsquery::parse_bbox;
use super::{km, Overlays};
use anyhow::{anyhow, bail, Result};
use chrono::{Datelike, NaiveDate, Utc};
use serde_json::{json, Value};
use std::time::Duration;

const ACIS: &str = "https://data.rcc-acis.org";

async fn acis(o: &Overlays, call: &str, body: &Value) -> Result<Value> {
    let r = o.http.post(format!("{ACIS}/{call}")).json(body).timeout(Duration::from_secs(60)).send().await?;
    if !r.status().is_success() {
        bail!("HTTP {} from ACIS {call}", r.status());
    }
    let v: Value = r.json().await?;
    if let Some(e) = v.get("error") {
        bail!("ACIS {call}: {}", e.as_str().unwrap_or("error"));
    }
    Ok(v)
}

/// ACIS value: number, "T" (trace → 0.001), "M"/"S"/"" → None; flags like "12A" keep the number.
pub fn val(v: &Value) -> Option<f64> {
    let s = match v {
        Value::String(s) => s.trim(),
        Value::Number(n) => return n.as_f64(),
        Value::Array(a) => return a.first().and_then(val),
        _ => return None,
    };
    if s == "T" {
        return Some(0.001);
    }
    let num: String = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    num.parse().ok()
}

fn j(v: Option<f64>) -> Value {
    v.map(|x| json!((x * 1000.0).round() / 1000.0)).unwrap_or(Value::Null)
}

/// smry entry → (value, date) whether ACIS sent `[v, date]` or `v`.
pub fn smry_pair(v: &Value) -> (Option<f64>, Option<String>) {
    match v {
        Value::Array(a) => (a.first().and_then(val), a.get(1).and_then(|d| d.as_str()).map(String::from)),
        x => (val(x), None),
    }
}

/// Pick the station: nearest, but stations without a 30-year record count as 40 km further.
pub fn pick_station(meta: &[Value], lat: f64, lon: f64, today: NaiveDate) -> Vec<(f64, Value)> {
    let mut v: Vec<(f64, Value)> = meta
        .iter()
        .filter_map(|m| {
            let ll = m["ll"].as_array()?;
            let (slon, slat) = (ll.first()?.as_f64()?, ll.get(1)?.as_f64()?);
            let d = km(lat, lon, slat, slon);
            let start = m["valid_daterange"].as_array().and_then(|r| r.first()).and_then(|r| r.get(0)).and_then(|s| s.as_str()).and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());
            let years = start.map(|s| (today - s).num_days() as f64 / 365.25).unwrap_or(0.0);
            let score = d + if years < 30.0 { 40.0 } else { 0.0 };
            Some((score, json!({"name": m["name"], "state": m["state"], "sid": m["sids"][0], "sids": m["sids"], "lat": slat, "lon": slon, "elev_ft": m["elev"], "dist_km": (d * 10.0).round() / 10.0, "por_start": start.map(|s| s.to_string()), "years": years.floor()})))
        })
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v
}

/// Summaries over rows `[date, maxt, mint, pcpn, snow, snwd, n_maxt, n_mint, n_pcpn]`.
pub fn summarize(rows: &[Vec<Option<f64>>]) -> Value {
    let col = |i: usize| rows.iter().filter_map(|r| r.get(i).copied().flatten()).collect::<Vec<f64>>();
    let mean = |v: &[f64]| if v.is_empty() { None } else { Some(v.iter().sum::<f64>() / v.len() as f64) };
    // departures only over days that have both the observation and the normal
    let pair = |a: usize, b: usize| -> (Option<f64>, Option<f64>) {
        let p: Vec<(f64, f64)> = rows.iter().filter_map(|r| Some((r.get(a).copied().flatten()?, r.get(b).copied().flatten()?))).collect();
        if p.is_empty() {
            (None, None)
        } else {
            let n = p.len() as f64;
            (Some(p.iter().map(|x| x.0).sum::<f64>() / n), Some(p.iter().map(|x| x.1).sum::<f64>() / n))
        }
    };
    let (ax, nx) = pair(1, 6);
    let (an, nn) = pair(2, 7);
    let pcpn: f64 = col(3).iter().map(|p| if *p < 0.002 { 0.0 } else { *p }).sum();
    let npcpn: f64 = rows.iter().filter(|r| r.get(3).copied().flatten().is_some()).filter_map(|r| r.get(8).copied().flatten()).sum();
    let snow: f64 = col(4).iter().map(|p| if *p < 0.002 { 0.0 } else { *p }).sum();
    let r = |x: Option<f64>| x.map(|v| (v * 10.0).round() / 10.0);
    json!({
        "days": rows.len(),
        "avg_maxt": j(r(mean(&col(1)))), "avg_mint": j(r(mean(&col(2)))),
        "normal_maxt": j(r(nx)), "normal_mint": j(r(nn)),
        "dep_maxt": j(r(ax.zip(nx).map(|(a, b)| a - b))), "dep_mint": j(r(an.zip(nn).map(|(a, b)| a - b))),
        "pcpn": j(Some((pcpn * 100.0).round() / 100.0)), "normal_pcpn": j(Some((npcpn * 100.0).round() / 100.0)),
        "dep_pcpn": j(Some(((pcpn - npcpn) * 100.0).round() / 100.0)),
        "snow": j(Some((snow * 10.0).round() / 10.0)),
    })
}

const RECORD_ELEMS: [(&str, &str, &str); 6] = [("maxt", "max", "maxt"), ("maxt", "min", "lomax"), ("mint", "min", "mint"), ("mint", "max", "himin"), ("pcpn", "max", "pcpn"), ("snow", "max", "snow")];

fn record_elems() -> Vec<Value> {
    RECORD_ELEMS.iter().map(|(n, r, _)| json!({"name": n, "interval": [1, 0, 0], "duration": "dly", "smry": {"reduce": r, "add": "date"}, "smry_only": 1})).collect()
}

/// `GET /api/climate?lat&lon`
pub async fn climate(o: &Overlays, lat: f64, lon: f64) -> Result<Value> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        bail!("lat/lon out of range");
    }
    let today = Utc::now().date_naive();
    let mut cands = vec![];
    for r in [0.4, 1.0, 2.5] {
        let body = json!({"bbox": [lon - r, lat - r * 0.75, lon + r, lat + r * 0.75], "elems": "maxt,mint,pcpn", "sdate": (today - chrono::Duration::days(10)).to_string(), "edate": today.to_string(), "meta": "name,state,sids,ll,elev,valid_daterange"});
        let m = acis(o, "StnMeta", &body).await?;
        cands = pick_station(m["meta"].as_array().map(|v| v.as_slice()).unwrap_or(&[]), lat, lon, today);
        if !cands.is_empty() {
            break;
        }
    }
    let (_, station) = cands.first().cloned().ok_or_else(|| anyhow!("no climate station within ~250 km"))?;
    let sid = station["sid"].as_str().unwrap_or("").to_string();
    let start = (today - chrono::Duration::days(30)).min(today.with_day(1).unwrap_or(today));
    let recent = json!({"sid": sid, "sdate": start.to_string(), "edate": today.to_string(), "elems": [
        {"name": "maxt"}, {"name": "mint"}, {"name": "pcpn"}, {"name": "snow"}, {"name": "snwd"},
        {"name": "maxt", "normal": "1"}, {"name": "mint", "normal": "1"}, {"name": "pcpn", "normal": "1"},
    ]});
    let last_year = today.with_year(today.year() - 1).unwrap_or(today - chrono::Duration::days(365));
    let recs = json!({"sid": sid, "sdate": "por", "edate": last_year.to_string(), "elems": record_elems()});
    let (d, r) = tokio::join!(acis(o, "StnData", &recent), acis(o, "StnData", &recs));
    let d = d?;
    let rows_raw = d["data"].as_array().cloned().unwrap_or_default();
    let mut rows: Vec<(String, Vec<Option<f64>>)> = vec![];
    for row in &rows_raw {
        let Some(a) = row.as_array() else { continue };
        let date = a.first().and_then(|x| x.as_str()).unwrap_or("").to_string();
        let mut vals = vec![None];
        vals.extend(a.iter().skip(1).map(val));
        rows.push((date, vals));
    }
    let days: Vec<Value> = rows
        .iter()
        .map(|(date, v)| {
            let g = |i: usize| v.get(i).copied().flatten();
            json!({"date": date, "maxt": j(g(1)), "mint": j(g(2)), "pcpn": j(g(3)), "snow": j(g(4)), "snwd": j(g(5)),
                   "normal_maxt": j(g(6)), "normal_mint": j(g(7)), "normal_pcpn": j(g(8)),
                   "dep_maxt": j(g(1).zip(g(6)).map(|(a, b)| a - b)), "dep_mint": j(g(2).zip(g(7)).map(|(a, b)| a - b))})
        })
        .collect();
    let month = format!("{:04}-{:02}", today.year(), today.month());
    let mtd: Vec<Vec<Option<f64>>> = rows.iter().filter(|(d, _)| d.starts_with(&month)).map(|r| r.1.clone()).collect();
    let cut = (today - chrono::Duration::days(29)).to_string();
    let last30: Vec<Vec<Option<f64>>> = rows.iter().filter(|(d, _)| d.as_str() >= cut.as_str()).map(|r| r.1.clone()).collect();
    let today_row = rows.iter().find(|(d, _)| *d == today.to_string()).map(|r| r.1.clone()).unwrap_or_default();
    let tg = |i: usize| today_row.get(i).copied().flatten();
    let mut records = serde_json::Map::new();
    if let Ok(r) = &r {
        if let Some(sm) = r["smry"].as_array() {
            for (k, (_, _, id)) in RECORD_ELEMS.iter().enumerate() {
                let (v, date) = sm.get(k).map(smry_pair).unwrap_or((None, None));
                records.insert((*id).into(), json!({"value": j(v), "year": date.as_deref().and_then(|d| d.get(..4)).and_then(|y| y.parse::<i32>().ok())}));
            }
        }
    }
    Ok(json!({
        "station": station,
        "nearby": cands.iter().skip(1).take(5).map(|c| c.1.clone()).collect::<Vec<_>>(),
        "units": {"temp": "°F", "precip": "in", "snow": "in"},
        "today": {"date": today.to_string(), "normal": {"maxt": j(tg(6)), "mint": j(tg(7)), "pcpn": j(tg(8))}, "records": records,
                  "records_error": r.as_ref().err().map(|e| format!("{e:#}"))},
        "days": days,
        "mtd": summarize(&mtd),
        "last30": summarize(&last30),
    }))
}

/// `date` = MM-DD (this year) or YYYY-MM-DD; default yesterday (today's obs are often incomplete).
pub fn record_date(s: &str, today: NaiveDate) -> Result<NaiveDate> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(today - chrono::Duration::days(1));
    }
    if s.len() == 5 {
        return NaiveDate::parse_from_str(&format!("{}-{s}", today.year()), "%Y-%m-%d").map_err(|_| anyhow!("date must be MM-DD or YYYY-MM-DD"));
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| anyhow!("date must be MM-DD or YYYY-MM-DD"))
}

/// Compare one station's observations with its records: (elem id, value, previous record, its year, tie).
pub fn broken(obs: &[Option<f64>; 4], rec: &[(Option<f64>, Option<String>)]) -> Vec<(&'static str, f64, f64, Option<i32>, bool)> {
    let mut out = vec![];
    for (k, (_, red, id)) in RECORD_ELEMS.iter().enumerate() {
        let o = match *id {
            "maxt" | "lomax" => obs[0],
            "mint" | "himin" => obs[1],
            "pcpn" => obs[2],
            _ => obs[3],
        };
        let (Some(o), Some((Some(r), date))) = (o, rec.get(k)) else { continue };
        if (*id == "pcpn" || *id == "snow") && o < 0.01 {
            continue;
        }
        let year = date.as_deref().and_then(|d| d.get(..4)).and_then(|y| y.parse().ok());
        let (beat, tie) = if *red == "max" { (o > *r, o == *r) } else { (o < *r, o == *r) };
        if beat || tie {
            out.push((*id, o, *r, year, tie && !beat));
        }
    }
    out
}

/// `GET /api/climate/records?date&bbox` — daily records set or tied at stations in the area.
pub async fn records(o: &Overlays, date: &str, bbox: &str) -> Result<Value> {
    let [w, s, e, n] = parse_bbox(bbox)?.ok_or_else(|| anyhow!("bbox=w,s,e,n required"))?;
    if (e - w) * (n - s) > 400.0 {
        bail!("area too large for records (max 400 square degrees); zoom in");
    }
    let today = Utc::now().date_naive();
    let d = record_date(date, today)?;
    let prev = d.with_year(d.year() - 1).unwrap_or(d - chrono::Duration::days(365));
    let first = d.with_year(1850).unwrap_or(NaiveDate::from_ymd_opt(1850, 1, 1).unwrap());
    let bb = json!([w, s, e, n]);
    let obs_q = json!({"bbox": bb, "sdate": d.to_string(), "edate": d.to_string(), "elems": "maxt,mint,pcpn,snow", "meta": "name,sids,ll,uid"});
    let rec_q = json!({"bbox": bb, "sdate": first.to_string(), "edate": prev.to_string(), "elems": record_elems(), "meta": "uid"});
    let (ob, rc) = tokio::join!(acis(o, "MultiStnData", &obs_q), acis(o, "MultiStnData", &rec_q));
    let (ob, rc) = (ob?, rc?);
    let mut recs: std::collections::HashMap<i64, Vec<(Option<f64>, Option<String>)>> = std::collections::HashMap::new();
    for st in rc["data"].as_array().cloned().unwrap_or_default() {
        let Some(uid) = st["meta"]["uid"].as_i64() else { continue };
        recs.insert(uid, st["smry"].as_array().map(|a| a.iter().map(smry_pair).collect()).unwrap_or_default());
    }
    let mut feats = vec![];
    for st in ob["data"].as_array().cloned().unwrap_or_default() {
        let m = &st["meta"];
        let (Some(uid), Some(ll)) = (m["uid"].as_i64(), m["ll"].as_array()) else { continue };
        let (Some(lon), Some(lat)) = (ll.first().and_then(|x| x.as_f64()), ll.get(1).and_then(|x| x.as_f64())) else { continue };
        let row = st["data"].as_array().and_then(|r| r.first()).and_then(|r| r.as_array()).cloned().unwrap_or_default();
        let obs = [row.first().and_then(val), row.get(1).and_then(val), row.get(2).and_then(val), row.get(3).and_then(val)];
        let Some(rec) = recs.get(&uid) else { continue };
        for (id, v, p, y, tie) in broken(&obs, rec) {
            feats.push(super::point(lon, lat, json!({"id": m["sids"][0], "name": m["name"], "elem": id, "value": j(Some(v)), "prev": j(Some(p)), "prev_year": y, "tie": tie, "date": d.to_string()})));
        }
    }
    let mut v = super::fc(feats);
    v["date"] = json!(d.to_string());
    v["units"] = json!({"temp": "°F", "precip": "in", "snow": "in"});
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values() {
        assert_eq!(val(&json!("84")), Some(84.0));
        assert_eq!(val(&json!("T")), Some(0.001));
        assert_eq!(val(&json!("M")), None);
        assert_eq!(val(&json!("0.25A")), Some(0.25));
        assert_eq!(smry_pair(&json!(["95", "1936-10-12"])), (Some(95.0), Some("1936-10-12".into())));
        assert_eq!(smry_pair(&json!("12")), (Some(12.0), None));
    }

    #[test]
    fn picks_long_record_station() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        let meta = vec![
            json!({"name": "NEW COOP", "sids": ["1 2"], "ll": [-93.6, 41.6], "valid_daterange": [["2020-01-01", "2026-10-11"]]}),
            json!({"name": "DES MOINES INTL AP", "sids": ["14933 1"], "ll": [-93.65313, 41.53395], "valid_daterange": [["1939-09-01", "2026-10-11"]]}),
        ];
        let p = pick_station(&meta, 41.6, -93.6, today);
        assert_eq!(p[0].1["name"], "DES MOINES INTL AP");
        assert_eq!(p[0].1["sid"], "14933 1");
    }

    #[test]
    fn summaries() {
        let rows = vec![vec![None, Some(80.0), Some(60.0), Some(0.5), Some(0.0), None, Some(70.0), Some(50.0), Some(0.1)], vec![None, Some(70.0), None, Some(0.001), None, None, Some(70.0), Some(50.0), Some(0.1)]];
        let s = summarize(&rows);
        assert_eq!(s["dep_maxt"], 5.0);
        assert_eq!(s["dep_mint"], 10.0);
        assert_eq!(s["pcpn"], 0.5);
        assert_eq!(s["normal_pcpn"], 0.2);
        assert_eq!(s["days"], 2);
    }

    #[test]
    fn records_broken() {
        let rec = vec![(Some(90.0), Some("1936-10-12".into())), (Some(45.0), None), (Some(25.0), None), (Some(70.0), None), (Some(1.5), Some("2010-10-12".into())), (Some(0.0), None)];
        let b = broken(&[Some(91.0), Some(70.0), Some(1.5), Some(0.0)], &rec);
        assert_eq!(b.len(), 3);
        assert_eq!(b[0], ("maxt", 91.0, 90.0, Some(1936), false));
        assert_eq!(b[1].0, "himin");
        assert!(b[1].4);
        assert_eq!(b[2], ("pcpn", 1.5, 1.5, Some(2010), true));
        let t = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        assert_eq!(record_date("", t).unwrap().to_string(), "2026-10-11");
        assert_eq!(record_date("07-04", t).unwrap().to_string(), "2026-07-04");
        assert!(record_date("x", t).is_err());
    }
}
