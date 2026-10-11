//! Ships (AIS): Finland Digitraffic (keyless, Baltic), Norway Kystverket open feed (keyless, raw
//! NMEA over TCP), and aisstream.io worldwide when a key is set. Collectors run only while the
//! overlay is in use.

use super::{fc, point, Overlays};
use anyhow::{anyhow, Result};
use futures::{SinkExt, StreamExt};
use parking_lot::RwLock;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Default, Debug)]
pub struct Ship {
    pub lat: f64,
    pub lon: f64,
    pub sog: f64,
    pub cog: f64,
    pub hdg: f64,
    pub name: String,
    pub kind: u32,
    pub dest: String,
    pub t: i64,
    pub src: &'static str,
}

#[derive(Default)]
pub struct Ships {
    pub map: RwLock<HashMap<u32, Ship>>,
    digi: AtomicBool,
    norway: AtomicBool,
    ais: AtomicBool,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Ships {
    pub fn ensure(o: &Arc<Overlays>, key: &str) {
        if !o.ships.digi.swap(true, Ordering::SeqCst) {
            let o = o.clone();
            tokio::spawn(async move {
                while !o.idle("ships", 900) {
                    match digitraffic(&o).await {
                        Ok(()) => o.health.ok("ovl-ships-fi", "Ships · Digitraffic (Finland)", ""),
                        Err(e) => o.health.err("ovl-ships-fi", "Ships · Digitraffic (Finland)", &e),
                    }
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
                o.ships.digi.store(false, Ordering::SeqCst);
                o.ships.map.write().clear();
            });
        }
        if !o.ships.norway.swap(true, Ordering::SeqCst) {
            let o = o.clone();
            tokio::spawn(async move {
                while !o.idle("ships", 900) {
                    match kystverket(&o).await {
                        Ok(()) => {}
                        Err(e) => o.health.err("ovl-ships-no", "Ships · Kystverket (Norway)", &e),
                    }
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
                o.ships.norway.store(false, Ordering::SeqCst);
            });
        }
        if !key.is_empty() && !o.ships.ais.swap(true, Ordering::SeqCst) {
            let o = o.clone();
            let key = key.to_string();
            tokio::spawn(async move {
                while !o.idle("ships", 900) {
                    match aisstream(&o, &key).await {
                        Ok(()) => {}
                        Err(e) => o.health.err("ovl-ships-ais", "Ships · aisstream.io", &e),
                    }
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                o.ships.ais.store(false, Ordering::SeqCst);
            });
        }
    }

    fn upsert(&self, mmsi: u32, f: impl FnOnce(&mut Ship)) {
        let mut m = self.map.write();
        let s = m.entry(mmsi).or_default();
        f(s);
    }

    /// Ships inside `bbox` (w,s,e,n), newest first, capped for the map.
    pub fn geojson(&self, bbox: &str) -> Value {
        let b: Vec<f64> = bbox.split(',').filter_map(|x| x.parse().ok()).collect();
        let (w, s, e, n) = if b.len() == 4 { (b[0], b[1], b[2], b[3]) } else { (-180.0, -90.0, 180.0, 90.0) };
        let cutoff = now_ms() - 3 * 3_600_000;
        let m = self.map.read();
        let mut v: Vec<(&u32, &Ship)> = m.iter().filter(|(_, s_)| s_.t > cutoff && s_.lat != 0.0 && s_.lat >= s && s_.lat <= n && s_.lon >= w && s_.lon <= e).collect();
        v.sort_by_key(|x| -x.1.t);
        v.truncate(6000);
        let feats = v
            .into_iter()
            .map(|(id, s)| {
                point(
                    s.lon,
                    s.lat,
                    json!({"mmsi": id, "name": s.name, "sog": (s.sog * 10.0).round() / 10.0, "cog": s.cog.round(), "hdg": if s.hdg < 360.0 { s.hdg } else { s.cog }, "type": s.kind, "dest": s.dest, "t": s.t, "src": s.src}),
                )
            })
            .collect();
        let mut out = fc(feats);
        out["sources"] = json!({"fi": self.digi.load(Ordering::Relaxed), "no": self.norway.load(Ordering::Relaxed), "ais": self.ais.load(Ordering::Relaxed)});
        out
    }
}

async fn digitraffic(o: &Arc<Overlays>) -> Result<()> {
    let req = |u: &str| o.http.get(u).header("Digitraffic-User", "TheBigWeather/self-hosted").header("Accept-Encoding", "gzip").timeout(Duration::from_secs(60)).send();
    let from = now_ms() - 20 * 60_000;
    let loc: Value = req(&format!("https://meri.digitraffic.fi/api/ais/v1/locations?from={from}")).await?.error_for_status()?.json().await?;
    for f in loc["features"].as_array().cloned().unwrap_or_default() {
        let Some(mmsi) = f["mmsi"].as_u64().or(f["properties"]["mmsi"].as_u64()) else { continue };
        let c = &f["geometry"]["coordinates"];
        let p = &f["properties"];
        let (Some(lon), Some(lat)) = (c[0].as_f64(), c[1].as_f64()) else { continue };
        o.ships.upsert(mmsi as u32, |s| {
            s.lat = lat;
            s.lon = lon;
            s.sog = p["sog"].as_f64().filter(|v| *v < 102.0).unwrap_or(0.0);
            s.cog = p["cog"].as_f64().filter(|v| *v < 360.0).unwrap_or(0.0);
            s.hdg = p["heading"].as_f64().unwrap_or(511.0);
            s.t = p["timestampExternal"].as_i64().unwrap_or_else(now_ms);
            s.src = "Digitraffic";
        });
    }
    // names/types change rarely; refresh every ~10 minutes
    static LAST_META: parking_lot::Mutex<i64> = parking_lot::Mutex::new(0);
    let need = { now_ms() - *LAST_META.lock() > 600_000 };
    if need {
        let meta: Value = req(&format!("https://meri.digitraffic.fi/api/ais/v1/vessels?from={}", now_ms() - 24 * 3_600_000)).await?.error_for_status()?.json().await?;
        for v in meta.as_array().cloned().unwrap_or_default() {
            let Some(mmsi) = v["mmsi"].as_u64() else { continue };
            o.ships.upsert(mmsi as u32, |s| {
                s.name = v["name"].as_str().unwrap_or("").trim().to_string();
                s.kind = v["shipType"].as_u64().unwrap_or(0) as u32;
                s.dest = v["destination"].as_str().unwrap_or("").trim().to_string();
            });
        }
        *LAST_META.lock() = now_ms();
    }
    Ok(())
}

/// Norway's open AIS feed: raw !AIVDM sentences over TCP. Read for ~40 s per round.
async fn kystverket(o: &Arc<Overlays>) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let stream = tokio::time::timeout(Duration::from_secs(10), tokio::net::TcpStream::connect("153.44.253.27:5631")).await.map_err(|_| anyhow!("connect timeout"))??;
    o.health.ok("ovl-ships-no", "Ships · Kystverket (Norway)", "");
    let mut lines = BufReader::new(stream).lines();
    let mut parts: HashMap<String, Vec<String>> = HashMap::new();
    let end = tokio::time::Instant::now() + Duration::from_secs(40);
    while tokio::time::Instant::now() < end {
        let Ok(Ok(Some(line))) = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await else { break };
        let Some(start) = line.find("!AIVDM").or_else(|| line.find("!AIVDO")) else { continue };
        let f: Vec<&str> = line[start..].split(',').collect();
        if f.len() < 7 {
            continue;
        }
        let (total, num, seq) = (f[1].parse::<usize>().unwrap_or(1), f[2].parse::<usize>().unwrap_or(1), f[3]);
        let payload = f[5].to_string();
        let full = if total > 1 {
            let e = parts.entry(seq.to_string()).or_default();
            e.push(payload);
            if num < total {
                continue;
            }
            parts.remove(seq).unwrap_or_default().concat()
        } else {
            payload
        };
        if let Some(m) = decode_ais(&full) {
            apply(o, m, "Kystverket");
        }
    }
    Ok(())
}

/// aisstream.io websocket (worldwide). Runs one subscription while the overlay is in use.
async fn aisstream(o: &Arc<Overlays>, key: &str) -> Result<()> {
    let (mut ws, _) = tokio_tungstenite::connect_async("wss://stream.aisstream.io/v0/stream").await?;
    let sub = json!({"APIKey": key, "BoundingBoxes": [[[-90, -180], [90, 180]]], "FilterMessageTypes": ["PositionReport", "ShipStaticData", "StandardClassBPositionReport"]});
    ws.send(tokio_tungstenite::tungstenite::Message::Text(sub.to_string().into())).await?;
    o.health.ok("ovl-ships-ais", "Ships · aisstream.io", "");
    while !o.idle("ships", 900) {
        let Ok(Some(msg)) = tokio::time::timeout(Duration::from_secs(60), ws.next()).await else { break };
        let msg = msg?;
        let text = match msg {
            tokio_tungstenite::tungstenite::Message::Text(t) => t.to_string(),
            tokio_tungstenite::tungstenite::Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if let Some(e) = v.get("error") {
            return Err(anyhow!("aisstream: {e}"));
        }
        let md = &v["MetaData"];
        let Some(mmsi) = md["MMSI"].as_u64() else { continue };
        let kind = v["MessageType"].as_str().unwrap_or("");
        let body = &v["Message"][kind];
        let name = md["ShipName"].as_str().unwrap_or("").trim().to_string();
        match kind {
            "PositionReport" | "StandardClassBPositionReport" => {
                let (Some(lat), Some(lon)) = (body["Latitude"].as_f64(), body["Longitude"].as_f64()) else { continue };
                o.ships.upsert(mmsi as u32, |s| {
                    s.lat = lat;
                    s.lon = lon;
                    s.sog = body["Sog"].as_f64().unwrap_or(0.0);
                    s.cog = body["Cog"].as_f64().unwrap_or(0.0);
                    s.hdg = body["TrueHeading"].as_f64().unwrap_or(511.0);
                    s.t = now_ms();
                    s.src = "aisstream.io";
                    if !name.is_empty() {
                        s.name = name.clone();
                    }
                });
            }
            "ShipStaticData" => {
                o.ships.upsert(mmsi as u32, |s| {
                    s.name = body["Name"].as_str().unwrap_or(&name).trim().to_string();
                    s.kind = body["Type"].as_u64().unwrap_or(0) as u32;
                    s.dest = body["Destination"].as_str().unwrap_or("").trim().to_string();
                });
            }
            _ => {}
        }
        // bound memory: drop ships silent for 3 hours
        if rand::random::<u16>() < 20 {
            let cutoff = now_ms() - 3 * 3_600_000;
            o.ships.map.write().retain(|_, s| s.t > cutoff || s.t == 0);
        }
    }
    Ok(())
}

// ---------- minimal AIS decoder (types 1-3, 5, 18, 19, 24A) ----------

#[derive(Debug, PartialEq)]
pub enum Ais {
    Pos { mmsi: u32, lat: f64, lon: f64, sog: f64, cog: f64, hdg: f64 },
    Static { mmsi: u32, name: String, kind: u32, dest: String },
}

fn bits(payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() * 6);
    for c in payload.bytes() {
        let mut v = c.wrapping_sub(48);
        if v > 40 {
            v -= 8;
        }
        for i in (0..6).rev() {
            out.push((v >> i) & 1);
        }
    }
    out
}

fn uint(b: &[u8], start: usize, len: usize) -> Option<u64> {
    if start + len > b.len() {
        return None;
    }
    Some(b[start..start + len].iter().fold(0u64, |a, &x| (a << 1) | x as u64))
}

fn int(b: &[u8], start: usize, len: usize) -> Option<i64> {
    let u = uint(b, start, len)? as i64;
    Some(if b[start] == 1 { u - (1i64 << len) } else { u })
}

fn text(b: &[u8], start: usize, chars: usize) -> String {
    let mut s = String::new();
    for i in 0..chars {
        let Some(v) = uint(b, start + i * 6, 6) else { break };
        let c = if v < 32 { (v as u8 + 64) as char } else { v as u8 as char };
        s.push(c);
    }
    s.trim_end_matches('@').trim().to_string()
}

pub fn decode_ais(payload: &str) -> Option<Ais> {
    let b = bits(payload);
    let t = uint(&b, 0, 6)?;
    let mmsi = uint(&b, 8, 30)? as u32;
    let pos = |sog_at: usize, lon_at: usize, lat_at: usize, cog_at: usize, hdg_at: usize| -> Option<Ais> {
        let lon = int(&b, lon_at, 28)? as f64 / 600_000.0;
        let lat = int(&b, lat_at, 27)? as f64 / 600_000.0;
        if lon.abs() > 180.0 || lat.abs() > 90.0 {
            return None;
        }
        let sog = uint(&b, sog_at, 10)? as f64 / 10.0;
        let cog = uint(&b, cog_at, 12)? as f64 / 10.0;
        let hdg = uint(&b, hdg_at, 9)? as f64;
        Some(Ais::Pos { mmsi, lat, lon, sog: if sog >= 102.3 { 0.0 } else { sog }, cog: if cog >= 360.0 { 0.0 } else { cog }, hdg })
    };
    match t {
        1..=3 => pos(50, 61, 89, 116, 128),
        18 | 19 => pos(46, 57, 85, 112, 124),
        5 => Some(Ais::Static { mmsi, name: text(&b, 112, 20), kind: uint(&b, 232, 8)? as u32, dest: text(&b, 302, 20) }),
        24 if uint(&b, 38, 2)? == 0 => Some(Ais::Static { mmsi, name: text(&b, 40, 20), kind: 0, dest: String::new() }),
        _ => None,
    }
}

fn apply(o: &Overlays, m: Ais, src: &'static str) {
    match m {
        Ais::Pos { mmsi, lat, lon, sog, cog, hdg } => o.ships.upsert(mmsi, |s| {
            s.lat = lat;
            s.lon = lon;
            s.sog = sog;
            s.cog = cog;
            s.hdg = hdg;
            s.t = now_ms();
            s.src = src;
        }),
        Ais::Static { mmsi, name, kind, dest } => o.ships.upsert(mmsi, |s| {
            if !name.is_empty() {
                s.name = name;
            }
            if kind > 0 {
                s.kind = kind;
            }
            if !dest.is_empty() {
                s.dest = dest;
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ais_type1() {
        // classic example from the AIVDM/AIVDO protocol decoding guide
        match decode_ais("15M67FC000G?ufbE`FepT@3n00Sa").unwrap() {
            Ais::Pos { mmsi, lat, lon, sog, .. } => {
                assert_eq!(mmsi, 366053209);
                assert!((lat - 37.802118).abs() < 1e-4, "{lat}");
                assert!((lon + 122.341618).abs() < 1e-4, "{lon}");
                assert!(sog < 0.1);
            }
            _ => panic!(),
        }
    }
}
