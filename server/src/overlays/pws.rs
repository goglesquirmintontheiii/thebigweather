//! Personal weather stations from CWOP (Citizen Weather Observer Program) via the APRS-IS
//! network: a read-only, keyless login (`pass -1`) with a server-side weather filter (`t/w`).
//! The feed runs only while someone has the layer on; the newest report per station is kept.

use super::{fc, point, Overlays};
use anyhow::{anyhow, Result};
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const SERVERS: &[&str] = &["rotate.aprs2.net:14580", "noam.aprs2.net:14580", "euro.aprs2.net:14580"];
const MAX_STATIONS: usize = 60_000;
const KEEP_MS: i64 = 3 * 3_600_000;

/// One weather report (SI-ish units as served).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Wx {
    pub lat: f32,
    pub lon: f32,
    pub t: i64,
    pub temp_c: Option<f32>,
    pub rh: Option<f32>,
    pub dir: Option<f32>,
    pub wind_kt: Option<f32>,
    pub gust_kt: Option<f32>,
    pub pres_mb: Option<f32>,
    pub rain_1h_in: Option<f32>,
    pub rain_24h_in: Option<f32>,
    pub rain_mid_in: Option<f32>,
}

#[derive(Default)]
pub struct Pws {
    running: AtomicBool,
    pub stations: RwLock<HashMap<String, Wx>>,
    connected: AtomicBool,
}

const MPH_KT: f32 = 0.868_976;

fn num(s: &str) -> Option<f32> {
    let t = s.trim();
    if t.is_empty() || t.chars().all(|c| c == '.' || c == ' ') {
        return None;
    }
    t.parse::<f32>().ok()
}

/// DDMM.mmN / DDDMM.mmW (ambiguity spaces read as zeros).
fn lat_lon(lat: &str, lon: &str) -> Option<(f32, f32)> {
    let (lat, lon) = (lat.replace(' ', "0"), lon.replace(' ', "0"));
    if lat.len() != 8 || lon.len() != 9 {
        return None;
    }
    let la = lat[..2].parse::<f32>().ok()? + lat[2..7].parse::<f32>().ok()? / 60.0;
    let lo = lon[..3].parse::<f32>().ok()? + lon[3..8].parse::<f32>().ok()? / 60.0;
    let la = match &lat[7..] {
        "N" => la,
        "S" => -la,
        _ => return None,
    };
    let lo = match &lon[8..] {
        "E" => lo,
        "W" => -lo,
        _ => return None,
    };
    ((-90.0..=90.0).contains(&la) && (-180.0..=180.0).contains(&lo)).then_some((la, lo))
}

fn b91(s: &[u8]) -> Option<f64> {
    let mut v = 0f64;
    for &c in s {
        if !(33..=124).contains(&c) {
            return None;
        }
        v = v * 91.0 + (c - 33) as f64;
    }
    Some(v)
}

/// Weather fields after the position ("ddd/sssg...t...", or "c...s...g..." forms).
fn weather(s: &str, w: &mut Wx) {
    let b = s.as_bytes();
    let mut i = 0;
    if b.len() >= 7 && b[3] == b'/' {
        w.dir = num(&s[0..3]);
        w.wind_kt = num(&s[4..7]).map(|x| x * MPH_KT);
        i = 7;
    }
    let mut had_c = false;
    while i < b.len() {
        let k = b[i];
        let take = |n: usize| -> Option<&str> { s.get(i + 1..i + 1 + n) };
        let n = match k {
            b'c' | b'g' | b't' | b'r' | b'p' | b'P' | b'L' | b'l' | b's' | b'#' => 3,
            b'h' => 2,
            b'b' => 5,
            _ => break,
        };
        let Some(f) = take(n) else { break };
        if !f.bytes().all(|c| c.is_ascii_digit() || c == b'.' || c == b' ' || c == b'-') {
            break;
        }
        let v = num(f);
        match k {
            b'c' => {
                w.dir = v;
                had_c = true;
            }
            b's' if had_c && w.wind_kt.is_none() => w.wind_kt = v.map(|x| x * MPH_KT),
            b'g' => w.gust_kt = v.map(|x| x * MPH_KT),
            b't' => w.temp_c = v.map(|f| (f - 32.0) * 5.0 / 9.0),
            b'r' => w.rain_1h_in = v.map(|x| x / 100.0),
            b'p' => w.rain_24h_in = v.map(|x| x / 100.0),
            b'P' => w.rain_mid_in = v.map(|x| x / 100.0),
            b'h' => w.rh = v.map(|h| if h == 0.0 { 100.0 } else { h }),
            b'b' => w.pres_mb = v.map(|x| x / 10.0),
            _ => {}
        }
        i += 1 + n;
    }
    // drop impossible values
    if w.temp_c.map(|t| !(-60.0..=60.0).contains(&t)).unwrap_or(false) {
        w.temp_c = None;
    }
    if w.pres_mb.map(|p| !(850.0..=1090.0).contains(&p)).unwrap_or(false) {
        w.pres_mb = None;
    }
    if w.rh.map(|h| !(1.0..=100.0).contains(&h)).unwrap_or(false) {
        w.rh = None;
    }
    for x in [&mut w.wind_kt, &mut w.gust_kt] {
        if x.map(|v| !(0.0..=200.0).contains(&v)).unwrap_or(false) {
            *x = None;
        }
    }
    if w.dir.map(|d| !(0.0..=360.0).contains(&d)).unwrap_or(false) {
        w.dir = None;
    }
}

/// Parse one APRS-IS line into (station, report). Only weather reports with a position.
pub fn parse_packet(line: &str, now_ms: i64) -> Option<(String, Wx)> {
    if line.starts_with('#') {
        return None;
    }
    let (head, payload) = line.split_once(':')?;
    let src = head.split('>').next()?.trim();
    if src.is_empty() || src.len() > 12 {
        return None;
    }
    let mut p = payload;
    let dt = p.chars().next()?;
    p = &p[dt.len_utf8()..];
    match dt {
        '!' | '=' => {}
        '/' | '@' => p = p.get(7..)?, // timestamp
        _ => return None,
    }
    let mut w = Wx { t: now_ms, ..Default::default() };
    let pb = p.as_bytes();
    if pb.first().map(|c| c.is_ascii_digit() || *c == b' ').unwrap_or(false) {
        // uncompressed: lat(8) table(1) lon(9) symbol(1)
        let (la, lo) = lat_lon(p.get(0..8)?, p.get(9..18)?)?;
        if p.as_bytes().get(18) != Some(&b'_') {
            return None;
        }
        w.lat = la;
        w.lon = lo;
        weather(p.get(19..).unwrap_or(""), &mut w);
    } else {
        // compressed: table(1) lat(4) lon(4) symbol(1) cs(2) type(1)
        if pb.len() < 13 || pb[9] != b'_' {
            return None;
        }
        let la = 90.0 - b91(&pb[1..5])? / 380_926.0;
        let lo = -180.0 + b91(&pb[5..9])? / 190_463.0;
        if !(-90.0..=90.0).contains(&la) || !(-180.0..=180.0).contains(&lo) {
            return None;
        }
        w.lat = la as f32;
        w.lon = lo as f32;
        let (c, s) = (pb[10], pb[11]);
        if c != b' ' && (33..=122).contains(&c) && (33..=122).contains(&s) && c < b'{' {
            // course/speed: direction (deg) and speed (knots)
            w.dir = Some(((c - 33) as f32 * 4.0) % 360.0);
            w.wind_kt = Some(1.08f32.powi((s - 33) as i32) - 1.0);
        }
        weather(p.get(13..).unwrap_or(""), &mut w);
    }
    let has_wx = w.temp_c.is_some() || w.wind_kt.is_some() || w.pres_mb.is_some() || w.rh.is_some();
    has_wx.then(|| (src.to_string(), w))
}

/// Dew point (°C) from temperature and relative humidity (Magnus).
pub fn dewpoint(t: f32, rh: f32) -> f32 {
    let g = (rh / 100.0).ln() + 17.625 * t / (243.04 + t);
    243.04 * g / (17.625 - g)
}

fn r1(v: Option<f32>) -> Value {
    v.map(|x| json!((x * 10.0).round() / 10.0)).unwrap_or(Value::Null)
}

impl Pws {
    pub fn mem_bytes(&self) -> (usize, usize) {
        let s = self.stations.read();
        (s.len() * (std::mem::size_of::<Wx>() + 48), s.len())
    }

    /// Start the feed if needed; it stops 15 minutes after the last request.
    pub fn ensure(o: &Arc<Overlays>) {
        if o.pws.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let o = o.clone();
        tokio::spawn(async move {
            let mut k = 0;
            while !o.idle("pws", 900) {
                let server = SERVERS[k % SERVERS.len()];
                k += 1;
                match Self::session(&o, server).await {
                    Ok(()) => {}
                    Err(e) => o.health.err("ovl-pws", "Personal weather stations (CWOP / APRS-IS)", &e),
                }
                o.pws.connected.store(false, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
            o.pws.stations.write().clear();
            o.pws.running.store(false, Ordering::SeqCst);
        });
    }

    async fn session(o: &Arc<Overlays>, server: &str) -> Result<()> {
        let sock = tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect(server)).await.map_err(|_| anyhow!("{server}: connect timed out"))??;
        let (rd, mut wr) = sock.into_split();
        let login = format!("user N0CALL pass -1 vers TheBigWeather {} filter t/w\r\n", env!("CARGO_PKG_VERSION"));
        wr.write_all(login.as_bytes()).await?;
        let mut rd = BufReader::new(rd);
        let mut buf = Vec::with_capacity(512);
        let mut last_prune = std::time::Instant::now();
        loop {
            if o.idle("pws", 900) {
                return Ok(());
            }
            buf.clear();
            // servers send a "#" keepalive about every 20 s
            let n = tokio::time::timeout(Duration::from_secs(90), rd.read_until(b'\n', &mut buf)).await.map_err(|_| anyhow!("{server}: feed stalled"))??;
            if n == 0 {
                return Err(anyhow!("{server} closed the connection"));
            }
            if buf.len() > 600 {
                continue;
            }
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim_end();
            if line.starts_with("# logresp") {
                o.pws.connected.store(true, Ordering::SeqCst);
                o.health.ok("ovl-pws", "Personal weather stations (CWOP / APRS-IS)", server);
                continue;
            }
            let now = chrono::Utc::now().timestamp_millis();
            if let Some((id, w)) = parse_packet(line, now) {
                let mut s = o.pws.stations.write();
                if s.len() < MAX_STATIONS || s.contains_key(&id) {
                    s.insert(id, w);
                }
            }
            if last_prune.elapsed() > Duration::from_secs(60) {
                last_prune = std::time::Instant::now();
                o.pws.stations.write().retain(|_, w| now - w.t < KEEP_MS);
            }
        }
    }

    pub fn geojson(&self, bbox: Option<[f64; 4]>, minutes: i64) -> Value {
        let now = chrono::Utc::now().timestamp_millis();
        let cutoff = now - minutes.clamp(5, 180) * 60_000;
        let s = self.stations.read();
        let mut feats: Vec<Value> = s
            .iter()
            .filter(|(_, w)| w.t >= cutoff)
            .filter(|(_, w)| bbox.map(|[a, b, c, d]| (w.lon as f64) >= a && (w.lon as f64) <= c && (w.lat as f64) >= b && (w.lat as f64) <= d).unwrap_or(true))
            .take(25_000)
            .map(|(id, w)| {
                let dew = w.temp_c.zip(w.rh).map(|(t, h)| dewpoint(t, h));
                point(w.lon as f64, w.lat as f64, json!({
                    "id": id, "temp_c": r1(w.temp_c), "dew_c": r1(dew), "rh": r1(w.rh), "wind_kt": r1(w.wind_kt), "gust_kt": r1(w.gust_kt),
                    "dir": r1(w.dir), "pres_mb": r1(w.pres_mb), "rain_in": w.rain_mid_in.or(w.rain_24h_in).map(|x| json!((x * 100.0).round() / 100.0)).unwrap_or(Value::Null),
                    "rain_1h_in": w.rain_1h_in.map(|x| json!((x * 100.0).round() / 100.0)).unwrap_or(Value::Null), "t": w.t,
                }))
            })
            .collect();
        feats.sort_by(|a, b| a["properties"]["id"].as_str().cmp(&b["properties"]["id"].as_str()));
        let mut v = fc(feats);
        v["connected"] = json!(self.connected.load(Ordering::SeqCst));
        v["stations"] = json!(s.len());
        v
    }
}

pub async fn pws(o: &Arc<Overlays>, bbox: &str, minutes: &str) -> Result<Value> {
    let bbox = super::agsquery::parse_bbox(bbox)?;
    o.touch("pws");
    Pws::ensure(o);
    Ok(o.pws.geojson(bbox, minutes.parse().unwrap_or(60)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncompressed_with_timestamp() {
        let (id, w) = parse_packet("EW1234>APRS,TCPXX*,qAX,CWOP-3:@121955z4116.42N/09337.85W_220/004g010t075r001p020P015h88b10152L000.DsIP", 5).unwrap();
        assert_eq!(id, "EW1234");
        assert!((w.lat - 41.2737).abs() < 1e-3 && (w.lon + 93.6308).abs() < 1e-3);
        assert_eq!(w.dir, Some(220.0));
        assert!((w.wind_kt.unwrap() - 3.476).abs() < 0.01);
        assert!((w.gust_kt.unwrap() - 8.69).abs() < 0.01);
        assert!((w.temp_c.unwrap() - 23.889).abs() < 0.01);
        assert_eq!(w.rh, Some(88.0));
        assert!((w.pres_mb.unwrap() - 1015.2).abs() < 0.01);
        assert!((w.rain_mid_in.unwrap() - 0.15).abs() < 1e-6);
        assert_eq!(w.t, 5);
    }

    #[test]
    fn no_timestamp_missing_and_negative() {
        let (_, w) = parse_packet("CW9999>APRS,TCPIP*:!4903.50N/07201.75W_.../...g...t-05h00b.....", 0).unwrap();
        assert_eq!(w.dir, None);
        assert_eq!(w.wind_kt, None);
        assert!((w.temp_c.unwrap() + 20.56).abs() < 0.01);
        assert_eq!(w.rh, Some(100.0));
        assert_eq!(w.pres_mb, None);
        assert!(w.lat > 49.0 && w.lon < -72.0);
    }

    #[test]
    fn rejects_non_weather() {
        assert!(parse_packet("# aprsc 2.1", 0).is_none());
        assert!(parse_packet("N0CALL>APRS:!4903.50N/07201.75W-Test", 0).is_none());
        assert!(parse_packet("N0CALL>APRS:_10090556c220s004g005t077", 0).is_none());
    }

    #[test]
    fn compressed_position() {
        // "/5L!!<*e7_7P[g005t077" : APRS101 compressed example coordinates (49.5N, 72.75W)
        let (_, w) = parse_packet("XX1>APRS:=/5L!!<*e7_7P[g005t077", 0).unwrap();
        assert!((w.lat - 49.5).abs() < 0.01 && (w.lon + 72.75).abs() < 0.01, "{} {}", w.lat, w.lon);
        assert!((w.temp_c.unwrap() - 25.0).abs() < 0.01);
        assert!(w.dir.is_some());
        assert!((dewpoint(20.0, 50.0) - 9.26).abs() < 0.05);
    }
}
