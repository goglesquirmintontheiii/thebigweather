//! `shakeevents`: seismic events seen by chosen Raspberry Shake nodes.
//!
//! Raspberry Shake publishes no event / detection feed (its FDSN server offers station and
//! dataselect only, data at least 30 minutes old, ≤ 5 requests/s and 30/min). So while the overlay
//! is requested, the server polls the vertical channel (EHZ, else SHZ) of up to 20 selected nodes
//! every 3 minutes (one request per node, ≥ 2.5 s apart so polling stays under 30/min), runs a classic STA/LTA trigger
//! (1 Hz high-pass, STA 1 s, LTA 30 s, on 4.0 / off 1.5 — `ratio` adjustable) and keeps only the
//! triggers (no waveforms). Triggers are associated with USGS events (predicted P arrival
//! dist / 6.5 km/s within ±(20 s + 5%)); the rest are grouped into local events when triggers on
//! different nodes fall within 40 s, located by a grid search (6 km/s) when ≥ 3 nodes trigger.
//! Local magnitude (rough): ML = log10(A_wa mm) + 1.11 log10(R) + 0.00189 R − 2.09 (Hutton &
//! Boore 1987), A_wa from the peak counts → velocity (3.9965e8 counts per m/s, the RS EHZ
//! sensitivity) → displacement at 5 Hz × 2080; median over nodes. Polling stops 30 minutes after
//! the last request.

use super::{fc, km, Overlays};
use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_NODES: usize = 20;
const POLL: Duration = Duration::from_secs(180);
const IDLE: Duration = Duration::from_secs(1800);
const COUNTS_PER_MS: f64 = 3.9965e8;
/// Raspberry Shake serves data at least this old.
const DELAY_MS: i64 = 31 * 60_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Trigger {
    pub on: i64,
    pub off: i64,
    /// peak |high-passed counts|
    pub amp: f64,
    pub ratio: f64,
}

#[derive(Default)]
struct Node {
    last_req: Option<Instant>,
    lat: f64,
    lon: f64,
    cha: String,
    /// data fetched up to (ms)
    upto: i64,
    triggers: VecDeque<Trigger>,
    error: Option<String>,
}

#[derive(Default)]
pub struct Seismic {
    running: AtomicBool,
    nodes: Mutex<HashMap<String, Node>>,
    pub ratio_on: Mutex<f64>,
}

/// STA/LTA triggers over evenly spaced samples (`sr` Hz, first sample at `t0` ms).
pub fn sta_lta(samples: &[i32], sr: f64, t0: i64, on: f64, off: f64) -> Vec<Trigger> {
    if sr <= 0.0 || samples.len() < (sr * 40.0) as usize {
        return vec![];
    }
    let dt = 1.0 / sr;
    let rc = 1.0 / (2.0 * std::f64::consts::PI * 1.0);
    let a = rc / (rc + dt);
    let (cs, cl) = (dt / 1.0, dt / 30.0);
    let (mut y, mut xp) = (0.0f64, samples[0] as f64);
    let (mut sta, mut lta) = (0.0f64, 0.0f64);
    let warm = (sr * 30.0) as usize;
    let mut out = vec![];
    let mut cur: Option<Trigger> = None;
    for (i, &s) in samples.iter().enumerate() {
        let x = s as f64;
        y = a * (y + x - xp);
        xp = x;
        let e = y * y;
        sta += cs * (e - sta);
        // freeze the long-term average while triggered so the event does not raise it
        if cur.is_none() {
            lta += cl * (e - lta);
        }
        if i < warm || lta <= 0.0 {
            continue;
        }
        let r = sta / lta;
        let t = t0 + (i as f64 * dt * 1000.0) as i64;
        match cur.as_mut() {
            None if r >= on => cur = Some(Trigger { on: t, off: t, amp: y.abs(), ratio: r }),
            Some(c) => {
                c.amp = c.amp.max(y.abs());
                c.ratio = c.ratio.max(r);
                c.off = t;
                if r < off || t - c.on > 300_000 {
                    out.push(cur.take().unwrap());
                }
            }
            None => {}
        }
    }
    out.extend(cur);
    // drop blips shorter than 1 s
    out.retain(|t| t.off - t.on >= 1000);
    out
}

/// Rough local magnitude from peak counts at R km (see module docs).
pub fn ml_estimate(amp_counts: f64, r_km: f64) -> Option<f64> {
    if amp_counts <= 0.0 {
        return None;
    }
    let v = amp_counts / COUNTS_PER_MS;
    let d = v / (2.0 * std::f64::consts::PI * 5.0);
    let a_wa_mm = d * 2080.0 * 1000.0;
    let r = r_km.max(5.0);
    Some(a_wa_mm.log10() + 1.11 * r.log10() + 0.00189 * r - 2.09)
}

/// Grid-search epicentre (6 km/s) for (lat, lon, onset ms) picks; returns (lat, lon, origin ms, rms s).
pub fn locate(picks: &[(f64, f64, i64)]) -> Option<(f64, f64, i64, f64)> {
    if picks.len() < 3 {
        return None;
    }
    let (la0, la1) = picks.iter().fold((90.0f64, -90.0f64), |a, p| (a.0.min(p.0), a.1.max(p.0)));
    let (lo0, lo1) = picks.iter().fold((180.0f64, -180.0f64), |a, p| (a.0.min(p.1), a.1.max(p.1)));
    let mut best: Option<(f64, f64, i64, f64)> = None;
    let steps = 60;
    let (pla, plo) = (((la1 - la0) * 0.5).max(0.5), ((lo1 - lo0) * 0.5).max(0.5));
    for a in 0..=steps {
        let lat = la0 - pla + (la1 - la0 + 2.0 * pla) * a as f64 / steps as f64;
        for b in 0..=steps {
            let lon = lo0 - plo + (lo1 - lo0 + 2.0 * plo) * b as f64 / steps as f64;
            let tt: Vec<f64> = picks.iter().map(|p| km(lat, lon, p.0, p.1) / 6.0).collect();
            let o: f64 = picks.iter().zip(&tt).map(|(p, t)| p.2 as f64 / 1000.0 - t).sum::<f64>() / picks.len() as f64;
            let rms = (picks.iter().zip(&tt).map(|(p, t)| (p.2 as f64 / 1000.0 - t - o).powi(2)).sum::<f64>() / picks.len() as f64).sqrt();
            if best.map(|x| rms < x.3).unwrap_or(true) {
                best = Some((lat, lon, (o * 1000.0) as i64, rms));
            }
        }
    }
    best
}

/// Parse `stations=AM.R1234,S5678` (net defaults to AM).
pub fn parse_stations(s: &str) -> Result<Vec<(String, String)>> {
    let mut out = vec![];
    for x in s.split(',').map(str::trim).filter(|x| !x.is_empty()) {
        let (net, sta) = x.split_once('.').unwrap_or(("AM", x));
        let (net, sta) = (net.to_ascii_uppercase(), sta.to_ascii_uppercase());
        if !crate::shake::valid_code(&net, 1, 2) || !crate::shake::valid_code(&sta, 1, 5) {
            bail!("bad station {x}");
        }
        if !out.contains(&(net.clone(), sta.clone())) {
            out.push((net, sta));
        }
    }
    if out.is_empty() {
        bail!("stations required (e.g. stations=AM.R1234,AM.S5678)");
    }
    if out.len() > MAX_NODES {
        bail!("at most {MAX_NODES} stations");
    }
    Ok(out)
}

impl Seismic {
    pub fn clear(&self) {
        for n in self.nodes.lock().values_mut() {
            n.triggers.clear();
        }
    }

    pub fn mem_bytes(&self) -> (usize, usize) {
        let n = self.nodes.lock();
        (n.values().map(|x| 64 + x.triggers.len() * 40).sum(), n.len())
    }

    fn ensure(o: &Arc<Overlays>) {
        if o.seismic.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let o = o.clone();
        tokio::spawn(async move {
            loop {
                let ids: Vec<String> = {
                    let mut n = o.seismic.nodes.lock();
                    n.retain(|_, x| x.last_req.map(|t| t.elapsed() < IDLE).unwrap_or(false));
                    n.keys().cloned().collect()
                };
                if ids.is_empty() {
                    break;
                }
                for id in ids {
                    if let Err(e) = poll_node(&o, &id).await {
                        if let Some(n) = o.seismic.nodes.lock().get_mut(&id) {
                            n.error = Some(format!("{e:#}"));
                        }
                    }
                    // the provider allows 30 requests per minute: stay well under it
                    tokio::time::sleep(Duration::from_millis(2500)).await;
                }
                tokio::time::sleep(POLL).await;
            }
            o.seismic.running.store(false, Ordering::SeqCst);
        });
    }
}

async fn poll_node(o: &Arc<Overlays>, id: &str) -> Result<()> {
    let (net, sta) = id.split_once('.').ok_or_else(|| anyhow!("bad id"))?;
    let now = chrono::Utc::now().timestamp_millis();
    let end = now - DELAY_MS;
    let (start, cha) = {
        let n = o.seismic.nodes.lock();
        let x = n.get(id).ok_or_else(|| anyhow!("gone"))?;
        // overlap 40 s so the LTA warms up again
        (if x.upto > 0 { x.upto - 40_000 } else { end - 3_600_000 }, x.cha.clone())
    };
    if end - start < 60_000 {
        return Ok(());
    }
    let chans: Vec<String> = if cha.is_empty() { vec!["EHZ".into(), "SHZ".into()] } else { vec![cha] };
    let on = *o.seismic.ratio_on.lock();
    let on = if on > 1.0 { on } else { 4.0 };
    for c in chans {
        let url = format!(
            "{}/fdsnws/dataselect/1/query?net={net}&sta={sta}&loc=00&cha={c}&starttime={}&endtime={}&nodata=404",
            crate::shake::FDSN,
            fdsn_time(start),
            fdsn_time(end)
        );
        let b = crate::shake::fetch_pub(o, &url).await?;
        if b.is_empty() {
            continue;
        }
        let cc = c.clone();
        let trig = tokio::task::spawn_blocking(move || -> Result<Vec<Trigger>> {
            let recs: Vec<crate::shake::Record> = crate::shake::parse_mseed(&b)?.into_iter().filter(|r| r.cha == cc).collect();
            let v = crate::shake::assemble(recs, start * 1000, end * 1000);
            let sr = v["sr"].as_f64().unwrap_or(0.0);
            let t0 = v["start"].as_f64().unwrap_or(0.0) as i64;
            let s: Vec<i32> = v["samples"].as_array().map(|a| a.iter().filter_map(|x| x.as_i64().map(|y| y as i32)).collect()).unwrap_or_default();
            Ok(sta_lta(&s, sr, t0, on, 1.5))
        })
        .await??;
        let mut n = o.seismic.nodes.lock();
        if let Some(x) = n.get_mut(id) {
            x.cha = c;
            x.upto = end;
            x.error = None;
            for t in trig {
                if !x.triggers.iter().any(|y| (y.on - t.on).abs() < 5_000) {
                    x.triggers.push_back(t);
                }
            }
            while x.triggers.front().map(|t| now - t.on > 24 * 3_600_000).unwrap_or(false) {
                x.triggers.pop_front();
            }
            while x.triggers.len() > 2000 {
                x.triggers.pop_front();
            }
        }
        return Ok(());
    }
    let mut n = o.seismic.nodes.lock();
    if let Some(x) = n.get_mut(id) {
        x.upto = end;
        x.error = Some("no EHZ/SHZ data".into());
    }
    Ok(())
}

fn fdsn_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()).unwrap_or_default()
}

/// One station trigger with its node position.
#[derive(Debug, Clone)]
pub struct Pick {
    pub sta: String,
    pub lat: f64,
    pub lon: f64,
    pub t: Trigger,
}

/// Associate picks with USGS events `(id, t ms, lat, lon, mag, place)` and group the rest.
#[allow(clippy::type_complexity)]
pub fn associate(picks: &[Pick], usgs: &[(String, i64, f64, f64, f64, String)], min_stations: usize, min_ml: f64) -> Vec<Value> {
    let mut used = vec![false; picks.len()];
    let mut out = vec![];
    for (id, t0, la, lo, mag, place) in usgs {
        let mut st: Vec<Value> = vec![];
        let mut amp: f64 = 0.0;
        let mut seen: Vec<&str> = vec![];
        for (k, p) in picks.iter().enumerate() {
            let d = km(*la, *lo, p.lat, p.lon);
            let tt = d / 6.5 * 1000.0;
            let pred = *t0 as f64 + tt;
            if (p.t.on as f64 - pred).abs() <= 20_000.0 + 0.05 * tt && !seen.contains(&p.sta.as_str()) {
                used[k] = true;
                seen.push(&p.sta);
                amp = amp.max(p.t.amp);
                st.push(json!({"sta": p.sta, "t_on": p.t.on, "amp": p.t.amp.round(), "ratio": (p.t.ratio * 10.0).round() / 10.0, "dist_km": d.round()}));
            }
        }
        if st.len() >= min_stations.max(1) && *mag >= min_ml {
            out.push(json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lo, la]}, "properties": {
                "kind": "usgs", "t": t0, "lat": la, "lon": lo, "stations": st, "max_amp": amp.round(), "est_ml": Value::Null, "usgs_id": id, "mag": mag, "place": place, "located": true}}));
        }
    }
    // local groups
    let mut rest: Vec<&Pick> = picks.iter().zip(&used).filter(|(_, u)| !**u).map(|(p, _)| p).collect();
    rest.sort_by_key(|p| p.t.on);
    let mut i = 0;
    while i < rest.len() {
        let mut g: Vec<&Pick> = vec![rest[i]];
        let mut j = i + 1;
        while j < rest.len() && rest[j].t.on - rest[i].t.on <= 40_000 {
            if !g.iter().any(|x| x.sta == rest[j].sta) {
                g.push(rest[j]);
            }
            j += 1;
        }
        i = j;
        if g.len() < min_stations.max(1) {
            continue;
        }
        let loc = locate(&g.iter().map(|p| (p.lat, p.lon, p.t.on)).collect::<Vec<_>>());
        let (lat, lon, t, located) = match loc {
            Some((la, lo, o, rms)) if rms < 3.0 => (la, lo, o, true),
            _ => (g[0].lat, g[0].lon, g[0].t.on, false),
        };
        let mut mls: Vec<f64> = if located { g.iter().filter_map(|p| ml_estimate(p.t.amp, km(lat, lon, p.lat, p.lon))).collect() } else { vec![] };
        mls.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let ml = mls.get(mls.len() / 2).copied().map(|x| (x * 10.0).round() / 10.0);
        if min_ml > 0.0 && ml.map(|m| m < min_ml).unwrap_or(true) {
            continue;
        }
        let amp = g.iter().map(|p| p.t.amp).fold(0.0, f64::max);
        let st: Vec<Value> = g.iter().map(|p| json!({"sta": p.sta, "t_on": p.t.on, "amp": p.t.amp.round(), "ratio": (p.t.ratio * 10.0).round() / 10.0, "dist_km": if located { json!(km(lat, lon, p.lat, p.lon).round()) } else { Value::Null }})).collect();
        out.push(json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [super::round(lon), super::round(lat)]}, "properties": {
            "kind": "local", "t": t, "lat": if located { json!(super::round(lat)) } else { Value::Null }, "lon": if located { json!(super::round(lon)) } else { Value::Null },
            "stations": st, "max_amp": amp.round(), "est_ml": ml, "usgs_id": Value::Null, "located": located}}));
    }
    out
}

/// `shakeevents?stations=AM.R1234,…&min_ml=&min_stations=&hours=&ratio=`.
pub async fn shake_events(o: &Arc<Overlays>, stations: &str, min_ml: &str, min_stations: &str, hours: &str, ratio: &str) -> Result<Value> {
    let list = parse_stations(stations)?;
    let min_ml: f64 = min_ml.parse().unwrap_or(0.0);
    let min_st: usize = min_stations.parse().unwrap_or(1usize).clamp(1, MAX_NODES);
    let hours: i64 = hours.parse().unwrap_or(6i64).clamp(1, 24);
    if let Ok(r) = ratio.parse::<f64>() {
        *o.seismic.ratio_on.lock() = r.clamp(2.0, 20.0);
    }
    // station coordinates from the (disk-cached) AM station list
    let st = super::more::shake_stations(o).await?;
    let mut coords: HashMap<String, (f64, f64)> = HashMap::new();
    for f in st["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        if let (Some(n), Some(s), Some(lo), Some(la)) = (p["net"].as_str(), p["sta"].as_str(), f["geometry"]["coordinates"][0].as_f64(), f["geometry"]["coordinates"][1].as_f64()) {
            coords.insert(format!("{n}.{s}"), (la, lo));
        }
    }
    {
        let mut n = o.seismic.nodes.lock();
        for (net, sta) in &list {
            let id = format!("{net}.{sta}");
            let &(lat, lon) = coords.get(&id).ok_or_else(|| anyhow!("unknown station {id}"))?;
            let e = n.entry(id).or_default();
            e.last_req = Some(Instant::now());
            e.lat = lat;
            e.lon = lon;
        }
    }
    Seismic::ensure(o);
    let now = chrono::Utc::now().timestamp_millis();
    let cutoff = now - hours * 3_600_000;
    let (picks, status): (Vec<Pick>, Vec<Value>) = {
        let n = o.seismic.nodes.lock();
        let mut p = vec![];
        let mut s = vec![];
        for (net, sta) in &list {
            let id = format!("{net}.{sta}");
            if let Some(x) = n.get(&id) {
                p.extend(x.triggers.iter().filter(|t| t.on >= cutoff).map(|t| Pick { sta: id.clone(), lat: x.lat, lon: x.lon, t: t.clone() }));
                s.push(json!({"sta": id, "lat": x.lat, "lon": x.lon, "cha": x.cha, "data_until": if x.upto > 0 { json!(x.upto) } else { Value::Null }, "triggers": x.triggers.iter().filter(|t| t.on >= cutoff).count(), "error": x.error}));
            }
        }
        (p, s)
    };
    let feed = if hours > 24 { "all_week" } else { "all_day" };
    let usgs: Vec<(String, i64, f64, f64, f64, String)> = match o.get_json(&format!("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson")).await {
        Ok(v) => v["features"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| {
                let p = &f["properties"];
                let c = &f["geometry"]["coordinates"];
                let t = p["time"].as_i64()?;
                (t >= cutoff - 3_600_000).then(|| (f["id"].as_str().unwrap_or("").to_string(), t, c[1].as_f64().unwrap_or(0.0), c[0].as_f64().unwrap_or(0.0), p["mag"].as_f64().unwrap_or(0.0), p["place"].as_str().unwrap_or("").to_string()))
            })
            .collect(),
        Err(_) => vec![],
    };
    let mut out = fc(associate(&picks, &usgs, min_st, min_ml));
    let loading = status.iter().any(|s| s["data_until"].is_null());
    out["stations"] = json!(status);
    out["loading"] = json!(loading);
    out["delay_min"] = json!(DELAY_MS / 60_000);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sta_lta_detects_a_burst() {
        let sr = 50.0;
        let n = (sr * 120.0) as usize;
        let mut rng = 12345u64;
        let mut noise = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) as f64 / (1u64 << 31) as f64 - 0.5) * 200.0
        };
        let s: Vec<i32> = (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                let burst = if (60.0..66.0).contains(&t) { 5000.0 * (2.0 * std::f64::consts::PI * 5.0 * t).sin() } else { 0.0 };
                (noise() + burst) as i32
            })
            .collect();
        let tr = sta_lta(&s, sr, 1_000_000, 4.0, 1.5);
        assert_eq!(tr.len(), 1, "{tr:?}");
        let on = (tr[0].on - 1_000_000) as f64 / 1000.0;
        assert!((59.5..62.0).contains(&on), "{on}");
        assert!(tr[0].amp > 2000.0);
        // pure noise: no triggers
        let quiet: Vec<i32> = (0..n).map(|_| noise() as i32).collect();
        assert!(sta_lta(&quiet, sr, 0, 4.0, 1.5).is_empty());
    }

    #[test]
    fn location_and_association() {
        let (la, lo) = (35.0, -97.0);
        let st = [(35.5, -97.0), (35.0, -96.4), (34.6, -97.5), (35.3, -97.6)];
        let t0 = 2_000_000i64;
        let picks: Vec<Pick> = st
            .iter()
            .enumerate()
            .map(|(k, &(a, b))| Pick { sta: format!("AM.S{k}"), lat: a, lon: b, t: Trigger { on: t0 + (km(la, lo, a, b) / 6.0 * 1000.0) as i64, off: 0, amp: 40_000.0, ratio: 9.0 } })
            .collect();
        let (ela, elo, eo, rms) = locate(&picks.iter().map(|p| (p.lat, p.lon, p.t.on)).collect::<Vec<_>>()).unwrap();
        assert!(km(ela, elo, la, lo) < 8.0, "{ela} {elo}");
        assert!((eo - t0).abs() < 2000 && rms < 1.0);
        let ev = associate(&picks, &[], 3, 0.0);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0]["properties"]["kind"], "local");
        assert_eq!(ev[0]["properties"]["stations"].as_array().unwrap().len(), 4);
        assert!(ev[0]["properties"]["est_ml"].as_f64().is_some());
        // the same picks match a USGS event there
        let u = vec![("us1".to_string(), t0, la, lo, 3.1, "x".to_string())];
        let ev = associate(&picks, &u, 2, 0.0);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0]["properties"]["usgs_id"], "us1");
        assert!(associate(&picks, &u, 2, 4.0).is_empty());
        let m = ml_estimate(40_000.0, 50.0).unwrap();
        assert!((0.0..4.0).contains(&m), "{m}");
        assert_eq!(parse_stations("R1234, am.s5678").unwrap(), vec![("AM".into(), "R1234".into()), ("AM".into(), "S5678".into())]);
        assert!(parse_stations("bad!").is_err());
    }
}
