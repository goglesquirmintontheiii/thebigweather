//! Hurricane-hunter center fixes from Vortex Data Messages (URNT12 Atlantic, URPN12 Pacific).
//!
//! The latest message per basin comes from NWS tgftp; recent ones from the IEM AFOS archive
//! (REPNT2 / REPPN2) when it answers.

use super::{fc, point, Overlays};
use anyhow::{bail, Result};
use chrono::{Datelike, TimeZone, Timelike, Utc};
use serde_json::{json, Value};

const LATEST: &[&str] = &["https://tgftp.nws.noaa.gov/data/raw/ur/urnt12.knhc..txt", "https://tgftp.nws.noaa.gov/data/raw/ur/urpn12.knhc..txt"];
const ARCHIVE: &[&str] = &[
    "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=REPNT2&limit=40&fmt=text",
    "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=REPPN2&limit=40&fmt=text",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Vdm {
    pub id: String,
    pub storm: String,
    pub mission: String,
    pub t: i64,
    pub lat: f64,
    pub lon: f64,
    pub mslp: Option<f64>,
    pub maxwind: Option<f64>,
    pub text: String,
}

/// Split a text blob holding one or more products into VDMs (each starts at its WMO header).
pub fn split_messages(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for l in text.lines() {
        let l = l.trim_matches(|c: char| c.is_control() || c.is_whitespace());
        if l.starts_with("URNT12 ") || l.starts_with("URPN12 ") || l.starts_with("URPA12 ") {
            out.push(String::new());
        }
        if let Some(cur) = out.last_mut() {
            if !l.is_empty() {
                cur.push_str(l);
                cur.push('\n');
            }
        }
    }
    out
}

/// "<a> deg [<b> min] <H>" coordinates in a lettered line (and its continuation).
fn coords(s: &str) -> Vec<f64> {
    let t: Vec<&str> = s.split_whitespace().collect();
    let mut out = vec![];
    for (k, w) in t.iter().enumerate() {
        let sign = match *w {
            "N" | "E" => 1.0,
            "S" | "W" => -1.0,
            _ => continue,
        };
        let v = if k >= 4 && t[k - 1] == "min" && t[k - 3] == "deg" {
            t[k - 4].parse::<f64>().ok().zip(t[k - 2].parse::<f64>().ok()).map(|(d, m)| d + m / 60.0)
        } else if k >= 2 && t[k - 1] == "deg" {
            t[k - 2].parse::<f64>().ok()
        } else {
            None
        };
        if let Some(v) = v {
            out.push(sign * v);
        }
    }
    out
}

/// Parse one VDM. `now` resolves the month/year (messages give only day and time).
pub fn parse_vdm(text: &str, now: chrono::DateTime<Utc>) -> Option<Vdm> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let hdr = lines.iter().position(|l| l.starts_with("VORTEX DATA MESSAGE"))?;
    let id = lines[hdr].split_whitespace().nth(3).unwrap_or("").to_string();
    // lettered items "X. body" (continuation lines appended)
    let mut items: Vec<(char, String)> = vec![];
    let mut tail: Vec<&str> = vec![];
    for l in &lines[hdr + 1..] {
        let b = l.as_bytes();
        if b.len() > 2 && b[0].is_ascii_uppercase() && b[1] == b'.' && b[2] == b' ' {
            items.push((b[0] as char, l[3..].trim().to_string()));
        } else if let Some(last) = items.last_mut().filter(|_| tail.is_empty() && !l.starts_with("MAX ")) {
            last.1.push(' ');
            last.1.push_str(l);
        } else {
            tail.push(l);
        }
    }
    let get = |c: char| items.iter().find(|x| x.0 == c).map(|x| x.1.as_str());
    // A. DD/HH:MM:SSZ
    let a = get('A')?.trim_end_matches('Z');
    let (day, hms) = a.split_once('/')?;
    let day: u32 = day.trim().parse().ok()?;
    let tm = chrono::NaiveTime::parse_from_str(hms.trim(), "%H:%M:%S").or_else(|_| chrono::NaiveTime::parse_from_str(hms.trim(), "%H:%M")).ok()?;
    let (mut y, mut m) = (now.year(), now.month());
    if day > now.day() + 1 {
        if m == 1 {
            y -= 1;
            m = 12;
        } else {
            m -= 1;
        }
    }
    let t = Utc.with_ymd_and_hms(y, m, day, 0, 0, 0).single()? + chrono::Duration::seconds(tm.num_seconds_from_midnight() as i64);
    let c = coords(get('B')?);
    let (lat, lon) = (*c.first()?, *c.get(1)?);
    // minimum sea-level pressure: "NNN mb" alone, or "EXTRAP NNN mb"
    let mslp = items.iter().find_map(|(_, b)| {
        let w: Vec<&str> = b.split_whitespace().collect();
        match w.as_slice() {
            [p, "mb"] | ["EXTRAP", p, "mb"] => p.parse::<f64>().ok().filter(|p| (850.0..1050.0).contains(p)),
            _ => None,
        }
    });
    // max flight-level wind: inbound/outbound "ddd deg NN kt" items (not E, the centre wind) and "MAX FL WIND NN KT"
    let mut maxwind: Option<f64> = None;
    let mut bump = |v: f64| maxwind = Some(maxwind.map_or(v, |m: f64| m.max(v)));
    for (c, b) in &items {
        let w: Vec<&str> = b.split_whitespace().collect();
        if *c != 'E' && w.len() >= 4 && w[1] == "deg" && w[3].eq_ignore_ascii_case("kt") {
            if let Ok(v) = w[2].parse::<f64>() {
                bump(v);
            }
        }
    }
    for l in &tail {
        if let Some(r) = l.strip_prefix("MAX FL WIND ") {
            if let Some(v) = r.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()) {
                bump(v);
            }
        }
    }
    // mission line: "AF301 1409A ISAIAS OB 33"
    let (mission, storm) = items
        .iter()
        .rev()
        .find_map(|(_, b)| {
            let w: Vec<&str> = b.split_whitespace().collect();
            let ob = w.iter().position(|x| *x == "OB")?;
            (ob >= 2).then(|| (format!("{} {}", w[0], w[1]), w[2..ob].join(" ")))
        })
        .unwrap_or_default();
    Some(Vdm { storm: if storm.is_empty() { id.clone() } else { storm }, id, mission, t: t.timestamp_millis(), lat, lon, mslp, maxwind, text: lines.join("\n") })
}

/// Center fixes from the last 5 days as GeoJSON points.
pub async fn vdm(o: &Overlays) -> Result<Value> {
    let now = Utc::now();
    let mut texts = vec![];
    let mut errs = vec![];
    for u in LATEST.iter().chain(ARCHIVE) {
        match o.get_text(u).await {
            Ok(t) => texts.push(t),
            Err(e) => errs.push(format!("{e:#}")),
        }
    }
    if texts.is_empty() {
        bail!("no recon messages: {}", errs.join("; "));
    }
    let cutoff = now.timestamp_millis() - 5 * 86_400_000;
    let mut fixes: Vec<Vdm> = vec![];
    for t in &texts {
        for m in split_messages(t) {
            if let Some(v) = parse_vdm(&m, now).filter(|v| v.t >= cutoff && v.t <= now.timestamp_millis() + 3_600_000) {
                if !fixes.iter().any(|f| f.id == v.id && f.t == v.t) {
                    fixes.push(v);
                }
            }
        }
    }
    fixes.sort_by_key(|f| f.t);
    Ok(fc(fixes
        .iter()
        .map(|f| point(f.lon, f.lat, json!({"storm": f.storm, "id": f.id, "mission": f.mission, "mslp": f.mslp, "maxwind": f.maxwind, "t": f.t, "text": f.text})))
        .collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "URNT12 KNHC 092326\nVORTEX DATA MESSAGE   AL092026\nA. 09/22:47:30Z\nB. 29.79 deg N 086.76 deg W\nC. 700 mb 2861 m\nD. 972 mb\nE. 050 deg 18 kt\nF. OPEN SE\nG. C14\nH. NA\nI. NA\nJ. 219 deg 91 kt\nK. 127 deg 25 nm 22:40:00Z\nL. NA\nM. NA\nN. 250 deg 73 kt\nO. 185 deg 33 nm 23:05:30Z\nP. 17 C / 3049 m\nQ. 21 C / 3039 m\nR. 6 C / NA\nS. 1345 / 7\nT. 0.02 / 1 nm\nU. AF301 1409A ISAIAS    OB 33\nMAX FL WIND 128 KT 068 / 16 NM 18:37:00Z\nMODERATE TO SEVERE TURBULENCE NEAR CENTER FIX\n";

    #[test]
    fn vdm_current_format() {
        let now = Utc.with_ymd_and_hms(2026, 10, 10, 1, 0, 0).unwrap();
        let v = parse_vdm(NEW, now).unwrap();
        assert_eq!(v.id, "AL092026");
        assert_eq!(v.storm, "ISAIAS");
        assert_eq!(v.mission, "AF301 1409A");
        assert_eq!(v.t, Utc.with_ymd_and_hms(2026, 10, 9, 22, 47, 30).unwrap().timestamp_millis());
        assert!((v.lat - 29.79).abs() < 1e-9 && (v.lon + 86.76).abs() < 1e-9);
        assert_eq!(v.mslp, Some(972.0));
        assert_eq!(v.maxwind, Some(128.0));
        // previous month when the day is ahead of today
        let v2 = parse_vdm(NEW, Utc.with_ymd_and_hms(2026, 11, 2, 0, 0, 0).unwrap()).unwrap();
        assert_eq!(v2.t, Utc.with_ymd_and_hms(2026, 10, 9, 22, 47, 30).unwrap().timestamp_millis());
    }

    #[test]
    fn vdm_old_format_and_split() {
        let old = "\u{1}\n123\nURNT12 KNHC 101745\nVORTEX DATA MESSAGE           AL142024\nA. 10/17:21:50Z\nB. 26 deg 47 min N\n083 deg 51 min W\nC. 700 mb 2584 m\nD. 115 kt\nE. 107 deg 15 nm\nF. 197 deg 120 kt\nG. 107 deg 13 nm\nH. EXTRAP 950 mb\nP. AF309 2014A MILTON OB 15\n\u{3}\n";
        let blob = format!("{old}{NEW}");
        let msgs = split_messages(&blob);
        assert_eq!(msgs.len(), 2);
        let v = parse_vdm(&msgs[0], Utc.with_ymd_and_hms(2026, 10, 11, 0, 0, 0).unwrap()).unwrap();
        assert!((v.lat - (26.0 + 47.0 / 60.0)).abs() < 1e-9 && (v.lon + (83.0 + 51.0 / 60.0)).abs() < 1e-9, "{} {}", v.lat, v.lon);
        assert_eq!(v.mslp, Some(950.0));
        assert_eq!(v.maxwind, Some(120.0));
        assert_eq!(v.storm, "MILTON");
    }
}
