//! METAR observations and Barnes-interpolated surface analyses.

use super::{Grid, Proj};
use anyhow::{bail, Result};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, Serialize)]
pub struct Obs {
    pub id: String,
    pub lat: f32,
    pub lon: f32,
    pub time: i64,
    pub temp: f32,
    pub dew: f32,
    pub wdir: f32,
    pub wspd: f32,
    pub gust: f32,
    pub vis: f32,
    pub alt: f32,
    pub slp: f32,
    pub cat: String,
    pub raw: String,
}

fn num(s: Option<&&str>) -> f32 {
    s.and_then(|v| v.trim().trim_end_matches('+').parse::<f32>().ok()).unwrap_or(f32::NAN)
}

/// Parse aviationweather.gov metars.cache.csv(.gz)
pub fn parse_csv(bytes: &[u8]) -> Result<Vec<Obs>> {
    let text = if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut s = String::new();
        flate2::read::MultiGzDecoder::new(bytes).read_to_string(&mut s)?;
        s
    } else {
        String::from_utf8_lossy(bytes).to_string()
    };
    let mut lines = text.lines();
    let header = loop {
        match lines.next() {
            Some(l) if l.starts_with("raw_text") => break l,
            Some(_) => continue,
            None => bail!("no CSV header"),
        }
    };
    let cols: HashMap<&str, usize> = header.split(',').enumerate().map(|(i, c)| (c.trim(), i)).collect();
    let c = |n: &str| cols.get(n).copied();
    let (Some(ci), Some(clat), Some(clon)) = (c("station_id"), c("latitude"), c("longitude")) else { bail!("missing columns") };
    let mut out: HashMap<String, Obs> = HashMap::new();
    for l in lines {
        let f: Vec<&str> = l.split(',').collect();
        let g = |k: Option<usize>| k.and_then(|i| f.get(i));
        let lat = num(f.get(clat));
        let lon = num(f.get(clon));
        if !lat.is_finite() || !lon.is_finite() {
            continue;
        }
        let time = g(c("observation_time"))
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        let o = Obs {
            id: f.get(ci).unwrap_or(&"").to_string(),
            lat,
            lon,
            time,
            temp: num(g(c("temp_c")).as_ref().map(|s| *s)),
            dew: num(g(c("dewpoint_c")).as_ref().map(|s| *s)),
            wdir: num(g(c("wind_dir_degrees")).as_ref().map(|s| *s)),
            wspd: num(g(c("wind_speed_kt")).as_ref().map(|s| *s)) * 0.514444,
            gust: num(g(c("wind_gust_kt")).as_ref().map(|s| *s)) * 0.514444,
            vis: num(g(c("visibility_statute_mi")).as_ref().map(|s| *s)) * 1.609344,
            alt: num(g(c("altim_in_hg")).as_ref().map(|s| *s)) * 33.8639,
            slp: num(g(c("sea_level_pressure_mb")).as_ref().map(|s| *s)),
            cat: g(c("flight_category")).map(|s| s.to_string()).unwrap_or_default(),
            raw: f.first().unwrap_or(&"").to_string(),
        };
        match out.get(&o.id) {
            Some(prev) if prev.time >= o.time => {}
            _ => {
                out.insert(o.id.clone(), o);
            }
        }
    }
    Ok(out.into_values().collect())
}

fn rh(t: f32, td: f32) -> f32 {
    let es = |x: f32| (17.625 * x / (243.04 + x)).exp();
    (100.0 * es(td) / es(t)).clamp(0.0, 100.0)
}

/// Apparent temperature (°C): heat index when warm/humid, wind chill when cold/windy.
fn feels(t: f32, td: f32, wind_ms: f32) -> f32 {
    let tf = t * 9.0 / 5.0 + 32.0;
    let mph = wind_ms * 2.236936;
    let f = if tf >= 80.0 {
        let r = rh(t, td);
        -42.379 + 2.04901523 * tf + 10.14333127 * r - 0.22475541 * tf * r - 0.00683783 * tf * tf - 0.05481717 * r * r + 0.00122874 * tf * tf * r + 0.00085282 * tf * r * r
            - 0.00000199 * tf * tf * r * r
    } else if tf <= 50.0 && mph > 3.0 {
        35.74 + 0.6215 * tf - 35.75 * mph.powf(0.16) + 0.4275 * tf * mph.powf(0.16)
    } else {
        tf
    };
    (f - 32.0) * 5.0 / 9.0
}

pub const FIELDS: [&str; 9] = ["temp", "dew", "rh", "wind", "gust", "pres", "vis", "feels", "spread"];

pub fn field_value(o: &Obs, field: &str) -> f32 {
    match field {
        "temp" => o.temp,
        "dew" => o.dew,
        "rh" => {
            if o.temp.is_finite() && o.dew.is_finite() {
                rh(o.temp, o.dew)
            } else {
                f32::NAN
            }
        }
        "wind" => o.wspd,
        "gust" => {
            if o.gust.is_finite() {
                o.gust
            } else {
                o.wspd
            }
        }
        "pres" => {
            if o.slp.is_finite() {
                o.slp
            } else {
                o.alt
            }
        }
        "vis" => o.vis.min(16.1),
        "feels" => {
            if o.temp.is_finite() && o.dew.is_finite() {
                feels(o.temp, o.dew, o.wspd.max(0.0))
            } else {
                o.temp
            }
        }
        "spread" => o.temp - o.dew,
        _ => f32::NAN,
    }
}

const RES: f64 = 0.1;
const RADIUS_DEG: f64 = 1.6;

/// Two-pass Barnes analysis on a global 0.1° grid (cells far from any station stay empty).
pub fn analyze(obs: &[Obs], field: &str, time: i64) -> Grid {
    let pts: Vec<(f64, f64, f32)> = obs
        .iter()
        .filter_map(|o| {
            let v = field_value(o, field);
            if v.is_finite() && (-90.0..=90.0).contains(&o.lat) {
                Some((o.lat as f64, o.lon as f64, v))
            } else {
                None
            }
        })
        .collect();
    let nx = (360.0 / RES) as usize;
    let lat_n = 75.0;
    let lat_s = -60.0;
    let ny = ((lat_n - lat_s) / RES) as usize;
    let proj = Proj::LatLon { lat0: lat_n - RES / 2.0, lon0: -180.0 + RES / 2.0, dlat: -RES, dlon: RES, nx, global: true };
    let k0 = (0.6f64).powi(2); // weight length scale (deg²)
    let pass = |values: &[(f64, f64, f32)], k: f64| -> (Vec<f32>, Vec<f32>) {
        let mut wsum = vec![0f32; nx * ny];
        let mut vsum = vec![0f32; nx * ny];
        let r_cells = (RADIUS_DEG / RES).ceil() as isize;
        for &(lat, lon, v) in values {
            let cj = ((lat_n - lat) / RES) as isize;
            let ci = ((lon + 180.0) / RES) as isize;
            let coslat = lat.to_radians().cos().max(0.2);
            let ri = (r_cells as f64 / coslat).ceil() as isize;
            for dj in -r_cells..=r_cells {
                let j = cj + dj;
                if j < 0 || j >= ny as isize {
                    continue;
                }
                let glat = lat_n - (j as f64 + 0.5) * RES;
                for di in -ri..=ri {
                    let i = (ci + di).rem_euclid(nx as isize);
                    let glon = -180.0 + (i as f64 + 0.5) * RES;
                    let mut dlon = glon - lon;
                    if dlon > 180.0 {
                        dlon -= 360.0;
                    }
                    if dlon < -180.0 {
                        dlon += 360.0;
                    }
                    let d2 = (glat - lat).powi(2) + (dlon * coslat).powi(2);
                    if d2 > RADIUS_DEG * RADIUS_DEG {
                        continue;
                    }
                    let w = (-d2 / k).exp() as f32;
                    let idx = j as usize * nx + i as usize;
                    wsum[idx] += w;
                    vsum[idx] += w * v;
                }
            }
        }
        (wsum, vsum)
    };
    let (w1, v1) = pass(&pts, k0);
    let first: Vec<f32> = w1.par_iter().zip(&v1).map(|(&w, &v)| if w > 0.005 { v / w } else { f32::NAN }).collect();
    // residuals at stations (nearest cell)
    let at = |lat: f64, lon: f64| -> f32 {
        let j = ((lat_n - lat) / RES) as isize;
        let i = (((lon + 180.0) / RES) as isize).rem_euclid(nx as isize);
        if j < 0 || j >= ny as isize {
            return f32::NAN;
        }
        first[j as usize * nx + i as usize]
    };
    let resid: Vec<(f64, f64, f32)> = pts
        .iter()
        .filter_map(|&(la, lo, v)| {
            let a = at(la, lo);
            if a.is_finite() {
                Some((la, lo, v - a))
            } else {
                None
            }
        })
        .collect();
    let (w2, v2) = pass(&resid, k0 * 0.35);
    let vals: Vec<f32> = (0..nx * ny)
        .into_par_iter()
        .map(|i| {
            let a = first[i];
            if !a.is_finite() {
                return f32::NAN;
            }
            if w2[i] > 1e-3 {
                a + v2[i] / w2[i]
            } else {
                a
            }
        })
        .collect();
    Grid::from_values(nx, ny, proj, &vals, time, time)
}

#[cfg(test)]
mod tests {
    #[test]
    fn barnes_recovers_station_values() {
        let mk = |id: &str, lat: f32, lon: f32, t: f32| super::Obs {
            id: id.into(),
            lat,
            lon,
            time: 0,
            temp: t,
            dew: t - 5.0,
            wdir: 0.0,
            wspd: 3.0,
            gust: f32::NAN,
            vis: 16.0,
            alt: 1013.0,
            slp: 1013.0,
            cat: String::new(),
            raw: String::new(),
        };
        let obs = vec![mk("A", 40.0, -100.0, 10.0), mk("B", 40.5, -99.0, 20.0), mk("C", 39.5, -98.5, 15.0)];
        let g = super::analyze(&obs, "temp", 0);
        let v = g.sample(40.0, -100.0).unwrap();
        assert!((v - 10.0).abs() < 3.0, "{v}");
        assert!(g.sample(0.0, 0.0).is_none());
    }

    #[test]
    fn parse_cache_csv() {
        let csv = "No errors\nNo warnings\n5 ms\ndata source=metars\n1 results\nraw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wind_dir_degrees,wind_speed_kt,wind_gust_kt,visibility_statute_mi,altim_in_hg,sea_level_pressure_mb,flight_category\nKOKC 101152Z 18012G20KT 10SM CLR 22/12 A2992,KOKC,2026-10-10T11:52:00Z,35.39,-97.6,22,12,180,12,20,10+,29.92,1013.2,VFR\n";
        let o = super::parse_csv(csv.as_bytes()).unwrap();
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].id, "KOKC");
        assert!((o[0].vis - 16.09).abs() < 0.1);
        assert!((o[0].gust - 10.29).abs() < 0.1);
    }
}
