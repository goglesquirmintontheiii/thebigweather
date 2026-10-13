//! Radar beam blockage from terrain (`/api/radar/blockage`).
//!
//! Terrain: AWS Terrain Tiles (terrarium PNG, elevation = R·256 + G + B/256 − 32768 m) at zoom 9
//! (~250 m pixels at mid latitudes), cached on disk under `cache/dem`. For each of 720 radials
//! (0.5°) and every 250 m out to 230 km, the beam centre height follows the 4/3-earth model from
//! the antenna (site elevation + `tower` m, default 20). With half-power beam radius
//! a = r·tan(bw/2) (bw = 0.95°) and y = terrain − beam centre, the blocked fraction of the beam
//! cross-section is (Bech et al. 2003)
//!   PBB = (y·√(a² − y²) + a²·asin(y/a) + π a²/2) / (π a²)   for −a < y < a (0 below, 1 above),
//! and the cumulative blockage (CBB) is the running maximum along the radial. Terrain is sampled
//! at the beam centre azimuth only (no azimuthal averaging across the beam).
//! Results are cached on disk per site / tilt (`cache/blockage`).

use super::encode::encode_l2_named;
use super::geom::{beam_height, destination};
use super::level2::{Moment, MomentData, Radial, Sweep, Volume};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const NRAD: usize = 720;
pub const GATE_M: f64 = 250.0;
pub const NGATES: usize = 920;
pub const BEAMWIDTH: f64 = 0.95;
const ZOOM: u32 = 9;
pub const TILE_URL: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

/// Partial beam blockage fraction for terrain `y` m above the beam centre, beam radius `a` m.
pub fn pbb(y: f64, a: f64) -> f64 {
    if a <= 0.0 {
        return if y > 0.0 { 1.0 } else { 0.0 };
    }
    if y <= -a {
        return 0.0;
    }
    if y >= a {
        return 1.0;
    }
    let pa2 = std::f64::consts::PI * a * a;
    ((y * (a * a - y * y).sqrt() + a * a * (y / a).asin() + pa2 / 2.0) / pa2).clamp(0.0, 1.0)
}

/// Decoded terrarium tile (256×256 elevations, m).
pub fn decode_terrarium(png_bytes: &[u8]) -> Result<Vec<f32>> {
    let dec = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let mut r = dec.read_info().map_err(|e| anyhow!("png: {e}"))?;
    let mut buf = vec![0u8; r.output_buffer_size().ok_or_else(|| anyhow!("png: size"))?];
    let info = r.next_frame(&mut buf).map_err(|e| anyhow!("png: {e}"))?;
    let ch = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        _ => bail!("terrarium tile is not RGB"),
    };
    if info.width != 256 || info.height != 256 || info.bit_depth != png::BitDepth::Eight {
        bail!("unexpected terrarium tile layout");
    }
    Ok(buf[..256 * 256 * ch].chunks(ch).map(|p| p[0] as f32 * 256.0 + p[1] as f32 + p[2] as f32 / 256.0 - 32768.0).collect())
}

/// Web Mercator tile and pixel (fractional) of a lat/lon at zoom z.
pub fn tile_px(lat: f64, lon: f64, z: u32) -> (u32, u32, f64, f64) {
    let n = (1u64 << z) as f64;
    let x = (lon + 180.0) / 360.0 * n;
    let lr = lat.to_radians();
    let y = (1.0 - (lr.tan() + 1.0 / lr.cos()).ln() / std::f64::consts::PI) / 2.0 * n;
    let (tx, ty) = (x.floor().clamp(0.0, n - 1.0), y.floor().clamp(0.0, n - 1.0));
    (tx as u32, ty as u32, (x - tx) * 256.0, (y - ty) * 256.0)
}

/// Terrain lookup over a set of loaded tiles.
pub struct Dem {
    pub z: u32,
    pub tiles: HashMap<(u32, u32), Vec<f32>>,
}

impl Dem {
    pub fn height(&self, lat: f64, lon: f64) -> Option<f32> {
        let (tx, ty, px, py) = tile_px(lat, lon, self.z);
        let t = self.tiles.get(&(tx, ty))?;
        let (i, j) = ((px.floor() as usize).min(255), (py.floor() as usize).min(255));
        Some(t[j * 256 + i])
    }
}

/// Tiles needed to cover `range_m` around a site.
pub fn tiles_for(lat: f64, lon: f64, range_m: f64, z: u32) -> Vec<(u32, u32)> {
    let mut v = vec![];
    for az in (0..360).step_by(5) {
        for k in 0..=10 {
            let (la, lo) = destination(lat, lon, az as f64, range_m * k as f64 / 10.0);
            let (tx, ty, _, _) = tile_px(la, lo, z);
            if !v.contains(&(tx, ty)) {
                v.push((tx, ty));
            }
        }
    }
    v
}

/// Cumulative blockage (%) per (radial, gate), radials at 0.25 + 0.5·k degrees.
pub fn compute(dem: &Dem, lat: f64, lon: f64, antenna_m: f64, elev_deg: f64) -> Vec<u8> {
    use rayon::prelude::*;
    let half = (BEAMWIDTH / 2.0).to_radians().tan();
    let mut out = vec![0u8; NRAD * NGATES];
    out.par_chunks_mut(NGATES).enumerate().for_each(|(k, row)| {
        let az = k as f64 * 0.5 + 0.25;
        let mut cbb = 0.0f64;
        for (g, o) in row.iter_mut().enumerate() {
            let r = (g as f64 + 0.5) * GATE_M;
            let (h, s) = beam_height(r, elev_deg);
            let (la, lo) = destination(lat, lon, az, s);
            if let Some(t) = dem.height(la, lo) {
                let y = t as f64 - (antenna_m + h);
                cbb = cbb.max(pbb(y, r * half));
            }
            *o = (cbb * 100.0).round() as u8;
        }
    });
    out
}

/// TBWS sweep of a blockage array ("BLK", %, scale 2 offset 2).
pub fn encode_sweep(site: &str, lat: f64, lon: f64, antenna_m: f64, elev_deg: f64, cbb: &[u8]) -> Result<Vec<u8>> {
    let now = chrono::Utc::now().timestamp_millis();
    let radials = (0..NRAD)
        .map(|k| Radial {
            time_ms: now,
            azimuth: k as f32 * 0.5 + 0.25,
            elevation: elev_deg as f32,
            az_spacing: 0.5,
            status: 1,
            elev_num: 1,
            nyquist: 0.0,
            moments: vec![MomentData {
                moment: Moment::Ref,
                ngates: NGATES as u16,
                first_gate_m: (GATE_M / 2.0) as f32,
                gate_m: GATE_M as f32,
                word_size: 8,
                scale: 2.0,
                offset: 2.0,
                data: cbb[k * NGATES..(k + 1) * NGATES].iter().map(|&p| if p == 0 { 0 } else { (p as u32 * 2 + 2).min(255) as u8 }).collect(),
            }],
        })
        .collect();
    let v = Volume { site: site.into(), lat: lat as f32, lon: lon as f32, height_m: antenna_m as f32, header_time_ms: now, complete: true, ..Default::default() };
    let s = Sweep { elev_num: 1, radials, complete: true };
    Ok(encode_l2_named(&v, &s, Moment::Ref, "BLK").ok_or_else(|| anyhow!("empty"))?.bytes)
}

/// GeoJSON: the "usable coverage" polygon (range where CBB first reaches `pct`, per 1°) plus
/// per-azimuth properties.
pub fn geojson(lat: f64, lon: f64, cbb: &[u8], pct: u8) -> serde_json::Value {
    let mut ring = vec![];
    let mut ranges = vec![];
    for deg in 0..360 {
        let k = deg * 2;
        let g = (0..NGATES).find(|&g| cbb[k * NGATES + g] >= pct).unwrap_or(NGATES);
        let r = g as f64 * GATE_M;
        ranges.push((r / 1000.0 * 10.0).round() / 10.0);
        let (la, lo) = destination(lat, lon, k as f64 * 0.5 + 0.25, r.max(1.0));
        ring.push(serde_json::json!([crate::overlays::round(lo), crate::overlays::round(la)]));
    }
    ring.push(ring[0].clone());
    let blocked = ranges.iter().filter(|r| **r < 230.0).count();
    serde_json::json!({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": {"kind": "coverage", "threshold_pct": pct, "range_km_by_az": ranges, "blocked_azimuths": blocked}}
    ]})
}

/// RGBA PNG (equirectangular, `size`² px) of blockage over the ±230 km box; returns
/// (png bytes, bounds [w, s, e, n]).
pub fn png(lat: f64, lon: f64, cbb: &[u8], size: usize) -> Result<(Vec<u8>, [f64; 4])> {
    let rng = NGATES as f64 * GATE_M;
    let dlat = rng / 111_320.0;
    let dlon = dlat / lat.to_radians().cos().max(0.05);
    let b = [lon - dlon, lat - dlat, lon + dlon, lat + dlat];
    let mut img = vec![0u8; size * size * 4];
    for j in 0..size {
        let la = b[3] - (j as f64 + 0.5) / size as f64 * (b[3] - b[1]);
        for i in 0..size {
            let lo = b[0] + (i as f64 + 0.5) / size as f64 * (b[2] - b[0]);
            let (az, d) = super::geom::bearing_dist(lat, lon, la, lo);
            let (_, s0) = (0.0, d);
            let g = (s0 / GATE_M) as usize;
            if g >= NGATES {
                continue;
            }
            let k = ((az / 0.5) as usize).min(NRAD - 1);
            let p = cbb[k * NGATES + g];
            if p == 0 {
                continue;
            }
            // yellow (partial) → red (full)
            let t = p as f32 / 100.0;
            let px = &mut img[(j * size + i) * 4..(j * size + i) * 4 + 4];
            px[0] = 255;
            px[1] = (220.0 * (1.0 - t)) as u8;
            px[2] = 0;
            px[3] = (80.0 + 150.0 * t) as u8;
        }
    }
    let mut out = vec![];
    {
        let mut e = png::Encoder::new(&mut out, size as u32, size as u32);
        e.set_color(png::ColorType::Rgba);
        e.set_depth(png::BitDepth::Eight);
        let mut w = e.write_header().map_err(|e| anyhow!("png: {e}"))?;
        w.write_image_data(&img).map_err(|e| anyhow!("png: {e}"))?;
    }
    Ok((out, b))
}

fn cache_path(dir: &Path, site: &str, elev: f64, tower: f64) -> PathBuf {
    dir.join(format!("{}_{:.2}_{:.0}.cbb", site.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>(), elev, tower))
}

/// Blockage array for a site (disk cached), fetching terrain tiles as needed.
pub async fn blockage(http: &reqwest::Client, cache: &Path, site: &str, lat: f64, lon: f64, ground_m: f64, tower: f64, elev: f64) -> Result<Vec<u8>> {
    let bdir = cache.join("blockage");
    let ddir = cache.join("dem");
    tokio::fs::create_dir_all(&bdir).await.ok();
    let p = cache_path(&bdir, site, elev, tower);
    if let Ok(b) = tokio::fs::read(&p).await {
        if b.len() == NRAD * NGATES {
            return Ok(b);
        }
    }
    let mut dem = Dem { z: ZOOM, tiles: HashMap::new() };
    for (tx, ty) in tiles_for(lat, lon, NGATES as f64 * GATE_M, ZOOM) {
        let tp = ddir.join(format!("{ZOOM}/{tx}/{ty}.png"));
        let bytes = match tokio::fs::read(&tp).await {
            Ok(b) => b,
            Err(_) => {
                let url = format!("{TILE_URL}/{ZOOM}/{tx}/{ty}.png");
                let r = http.get(&url).timeout(std::time::Duration::from_secs(30)).send().await?;
                if !r.status().is_success() {
                    bail!("HTTP {} for terrain tile {ZOOM}/{tx}/{ty}", r.status());
                }
                let b = r.bytes().await?.to_vec();
                if let Some(d) = tp.parent() {
                    tokio::fs::create_dir_all(d).await.ok();
                }
                tokio::fs::write(&tp, &b).await.ok();
                b
            }
        };
        let t = tokio::task::spawn_blocking(move || decode_terrarium(&bytes)).await??;
        dem.tiles.insert((tx, ty), t);
    }
    let antenna = ground_m + tower;
    let out = tokio::task::spawn_blocking(move || compute(&dem, lat, lon, antenna, elev)).await?;
    tokio::fs::write(&p, &out).await.ok();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_beam_blockage() {
        assert_eq!(pbb(-10.0, 5.0), 0.0);
        assert_eq!(pbb(10.0, 5.0), 1.0);
        assert!((pbb(0.0, 5.0) - 0.5).abs() < 1e-9);
        let a = pbb(2.5, 5.0);
        assert!(a > 0.5 && a < 1.0, "{a}");
        assert!((pbb(2.5, 5.0) + pbb(-2.5, 5.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn terrarium_decode_and_ridge() {
        // a tile at 1000 m everywhere: R=131 (131·256 = 33536 → 768 m) G=232 → 1000 m
        let mut raw = vec![];
        for _ in 0..256 * 256 {
            raw.extend_from_slice(&[131u8, 232, 0]);
        }
        let mut png_bytes = vec![];
        {
            let mut e = png::Encoder::new(&mut png_bytes, 256, 256);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().unwrap().write_image_data(&raw).unwrap();
        }
        let t = decode_terrarium(&png_bytes).unwrap();
        assert!((t[0] - 1000.0).abs() < 0.01, "{}", t[0]);
        // synthetic DEM: flat 0 m with a 2000 m ridge from 50 to 60 km east of the radar
        let (lat, lon) = (35.0, -97.0);
        let mut dem = Dem { z: ZOOM, tiles: HashMap::new() };
        for (tx, ty) in tiles_for(lat, lon, 240_000.0, ZOOM) {
            let n = (1u64 << ZOOM) as f64;
            let mut v = vec![0f32; 256 * 256];
            for j in 0..256 {
                for i in 0..256 {
                    let x = (tx as f64 + (i as f64 + 0.5) / 256.0) / n * 360.0 - 180.0;
                    let y = std::f64::consts::PI * (1.0 - 2.0 * (ty as f64 + (j as f64 + 0.5) / 256.0) / n);
                    let la = y.sinh().atan().to_degrees();
                    let (az, d) = crate::radar::geom::bearing_dist(lat, lon, la, x);
                    if (80.0..100.0).contains(&az) && (50_000.0..60_000.0).contains(&d) {
                        v[j * 256 + i] = 2000.0;
                    }
                }
            }
            dem.tiles.insert((tx, ty), v);
        }
        let c = compute(&dem, lat, lon, 20.0, 0.5);
        let at = |az: f64, km: f64| c[((az / 0.5) as usize) * NGATES + (km * 1000.0 / GATE_M) as usize];
        assert_eq!(at(90.0, 40.0), 0);
        assert_eq!(at(90.0, 70.0), 100, "behind the ridge");
        assert_eq!(at(180.0, 100.0), 0);
        let s = encode_sweep("KTST", lat, lon, 20.0, 0.5, &c).unwrap();
        assert_eq!(&s[64..67], b"BLK");
        let g = geojson(lat, lon, &c, 50);
        let r = g["features"][0]["properties"]["range_km_by_az"][90].as_f64().unwrap();
        assert!((49.0..=61.0).contains(&r), "{r}");
        let (p, b) = png(lat, lon, &c, 64).unwrap();
        assert_eq!(&p[1..4], b"PNG");
        assert!(b[0] < lon && b[2] > lon);
    }
}
