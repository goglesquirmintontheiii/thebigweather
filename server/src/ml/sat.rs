//! GOES satellite features for training and inference: ABI brightness temperatures /
//! reflectance (Cloud & Moisture Imagery L2, decoded and cached by the grid service), cloud-top
//! cooling, cold-cloud fraction, and GLM lightning flash counts / jumps.
//!
//! Satellite choice: GOES-East (GOES-16 until 2025-04-07, then GOES-19) for points east of
//! 125° W (its CONUS sector covers the lower 48), GOES-West (GOES-17 until 2023-01-04, then
//! GOES-18, PACUS sector) farther west. Tropical / ocean points (outside 20–53° N or 130–60° W)
//! use the full disk: East east of 115° W, West otherwise.

use super::features::FeatMap;
use super::source::{stencil, NetSource};
use crate::grid::Grid;
use anyhow::{anyhow, bail, Result};
use chrono::{Datelike, TimeZone, Timelike, Utc};
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// (satellite number, product dir, file-name tag)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SatPick {
    pub sat: u32,
    pub dir: &'static str,
    pub tag: &'static str,
}

fn ms(y: i32, m: u32, d: u32) -> i64 {
    Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap().timestamp_millis()
}

pub fn east_sat(t: i64) -> u32 {
    if t < ms(2025, 4, 7) { 16 } else { 19 }
}

pub fn west_sat(t: i64) -> u32 {
    if t < ms(2023, 1, 4) { 17 } else { 18 }
}

/// Satellite / sector for a point.
pub fn pick(t: i64, lat: f64, lon: f64) -> SatPick {
    let conus = (20.0..=53.0).contains(&lat) && (-130.0..=-60.0).contains(&lon);
    if conus {
        if lon >= -125.0 {
            SatPick { sat: east_sat(t), dir: "ABI-L2-CMIPC", tag: "CMIPC" }
        } else {
            SatPick { sat: west_sat(t), dir: "ABI-L2-CMIPC", tag: "CMIPC" }
        }
    } else if lon >= -115.0 {
        SatPick { sat: east_sat(t), dir: "ABI-L2-CMIPF", tag: "CMIPF" }
    } else {
        SatPick { sat: west_sat(t), dir: "ABI-L2-CMIPF", tag: "CMIPF" }
    }
}

/// GLM satellite for a point.
pub fn glm_sat(t: i64, lon: f64) -> u32 {
    if lon >= -115.0 { east_sat(t) } else { west_sat(t) }
}

fn hour_prefix(dir: &str, t: i64) -> Option<String> {
    let d = chrono::DateTime::from_timestamp_millis(t)?;
    Some(format!("{dir}/{:04}/{:03}/{:02}/", d.year(), d.ordinal(), d.hour()))
}

/// Count flashes within `r_km` of each point with times in (t0, t1].
pub fn count_near(fl: &[(f32, f32, i64)], pts: &[(f64, f64)], r_km: f64, t0: i64, t1: i64) -> Vec<f32> {
    let cell = 0.25f64;
    let mut idx: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (k, f) in fl.iter().enumerate() {
        if f.2 > t0 && f.2 <= t1 {
            idx.entry(((f.0 as f64 / cell).floor() as i32, (f.1 as f64 / cell).floor() as i32)).or_default().push(k);
        }
    }
    pts.iter()
        .map(|&(la, lo)| {
            let ry = (r_km / 111.0 / cell).ceil() as i32 + 1;
            let rx = (r_km / 111.0 / la.to_radians().cos().max(0.2) / cell).ceil() as i32 + 1;
            let (ci, cj) = ((la / cell).floor() as i32, (lo / cell).floor() as i32);
            let mut n = 0u32;
            for di in -ry..=ry {
                for dj in -rx..=rx {
                    let Some(v) = idx.get(&(ci + di, cj + dj)) else { continue };
                    for &k in v {
                        let f = fl[k];
                        let dy = (f.0 as f64 - la) * 111.0;
                        let dx = (f.1 as f64 - lo) * 111.0 * la.to_radians().cos();
                        if dx * dx + dy * dy <= r_km * r_km {
                            n += 1;
                        }
                    }
                }
            }
            n as f32
        })
        .collect()
}

/// Parse a GLM L2 LCFA file → flashes (lat, lon, file start time).
pub fn parse_glm(bytes: &[u8], t: i64) -> Result<Vec<(f32, f32, i64)>> {
    let f = netcdf_reader::NcFile::from_bytes(bytes).map_err(|e| anyhow!("netcdf: {e}"))?;
    let lat = f.read_variable_unpacked_masked("flash_lat").map_err(|e| anyhow!("flash_lat: {e}"))?.into_raw_vec_and_offset().0;
    let lon = f.read_variable_unpacked_masked("flash_lon").map_err(|e| anyhow!("flash_lon: {e}"))?.into_raw_vec_and_offset().0;
    Ok(lat.iter().zip(&lon).filter(|(a, b)| a.is_finite() && b.is_finite()).map(|(a, b)| (*a as f32, *b as f32, t)).collect())
}

/// Sample a decoded band at points with a stencil: (value at point, min, fraction below `cold`).
fn sample_band(g: &Grid, pts: &[(f64, f64)], rings: &[(f64, usize)], cold: f32) -> Vec<(f32, f32, f32)> {
    let q = stencil(pts, rings);
    let k = q.len() / pts.len().max(1);
    (0..pts.len())
        .map(|i| {
            let vals: Vec<f32> = q[i * k..(i + 1) * k].iter().map(|p| g.sample(p.0, p.1).unwrap_or(f32::NAN)).collect();
            let centre = vals[0];
            let fin: Vec<f32> = vals.iter().copied().filter(|v| v.is_finite()).collect();
            let mn = fin.iter().copied().fold(f32::NAN, f32::min);
            let frac = if fin.is_empty() { f32::NAN } else { fin.iter().filter(|v| **v < cold).count() as f32 / fin.len() as f32 };
            (centre, mn, frac)
        })
        .collect()
}

impl NetSource {
    /// Newest ABI CMIP file of a band at or before `t`, at most `max_age` old → (key, time).
    async fn abi_key(&self, p: SatPick, band: u32, t: i64, max_age: i64, realtime: bool) -> Result<(String, i64)> {
        let bucket = format!("noaa-goes{}", p.sat);
        let want = format!("C{band:02}_G{}_", p.sat);
        let mut best: Option<(i64, String)> = None;
        for back in [0i64, 1] {
            let Some(prefix) = hour_prefix(p.dir, t - back * 3_600_000) else { continue };
            let ttl = if realtime { Duration::from_secs(60) } else { Duration::from_secs(86400) };
            let l = match self.listing(&bucket, &format!("{prefix}OR_ABI-L2-{}-M", p.tag), ttl, |k| crate::grid::goes::time_from_name(k)).await {
                Ok(l) => l,
                Err(e) if back == 0 => return Err(e),
                Err(_) => continue,
            };
            for (ft, k) in l.iter() {
                if k.contains(&want) && *ft <= t + 30_000 && t - ft <= max_age && best.as_ref().map(|b| *ft > b.0).unwrap_or(true) {
                    best = Some((*ft, k.clone()));
                }
            }
            if best.is_some() {
                break;
            }
        }
        best.map(|(ft, k)| (k, ft)).ok_or_else(|| anyhow!("no GOES-{} {} band {band} file near this time", p.sat, p.tag))
    }

    /// Decoded band (cached by the grid service).
    async fn abi_grid(&self, p: SatPick, band: u32, t: i64, realtime: bool) -> Result<(Arc<Grid>, i64)> {
        let max_age = if p.tag == "CMIPF" { 15 * 60_000 } else { 12 * 60_000 };
        let (key, ft) = self.abi_key(p, band, t, max_age, realtime).await?;
        let g = self.grids.grid(&format!("goes|ml|noaa-goes{}|{key}", p.sat)).await?;
        Ok((g, ft))
    }

    /// GLM flashes in (t0, t1] for the satellites covering `pts`.
    pub(crate) async fn glm_flashes(&self, t0: i64, t1: i64, pts: &[(f64, f64)], realtime: bool) -> Result<Vec<(f32, f32, i64)>> {
        let mut sats: Vec<u32> = pts.iter().map(|p| glm_sat(t1, p.1)).collect();
        sats.sort_unstable();
        sats.dedup();
        let mut keys: Vec<(u32, String, i64)> = vec![];
        for sat in sats {
            let bucket = format!("noaa-goes{sat}");
            let mut h = t0.div_euclid(3_600_000) * 3_600_000;
            while h <= t1 {
                if let Some(prefix) = hour_prefix("GLM-L2-LCFA", h) {
                    let ttl = if realtime { Duration::from_secs(60) } else { Duration::from_secs(86400) };
                    if let Ok(l) = self.listing(&bucket, &prefix, ttl, |k| crate::grid::goes::time_from_name(k)).await {
                        keys.extend(l.iter().filter(|(ft, _)| *ft > t0 - 20_000 && *ft <= t1).map(|(ft, k)| (sat, k.clone(), *ft)));
                    }
                }
                h += 3_600_000;
            }
        }
        if keys.is_empty() {
            bail!("no GLM files in the window");
        }
        if keys.len() > 2000 {
            bail!("GLM window too long ({} files)", keys.len());
        }
        let res: Vec<Result<Arc<Vec<(f32, f32, i64)>>>> = futures::stream::iter(keys)
            .map(|(sat, k, ft)| async move {
                let ck = format!("{sat}/{k}");
                if let Some(v) = self.glm.lock().get(&ck).cloned() {
                    return Ok(v);
                }
                let b = self.get(&crate::s3::object_url(&format!("noaa-goes{sat}"), &k), None).await?;
                let v = Arc::new(tokio::task::spawn_blocking(move || parse_glm(&b, ft)).await??);
                self.glm.lock().put(ck, v.clone());
                Ok(v)
            })
            .buffer_unordered(8)
            .collect()
            .await;
        let mut out = vec![];
        let mut errs = 0;
        for r in res {
            match r {
                Ok(v) => out.extend(v.iter().copied()),
                Err(_) => errs += 1,
            }
        }
        if out.is_empty() && errs > 0 {
            bail!("GLM files could not be read");
        }
        Ok(out)
    }

    /// Satellite features at points.
    pub(crate) async fn sat_env(&self, fields: &[String], t: i64, pts: &[(f64, f64)], realtime: bool, out: &mut [FeatMap]) -> Result<()> {
        let has = |f: &str| fields.iter().any(|x| x == f);
        let mut errs = vec![];
        let mut ok = 0;
        // group points by satellite / sector
        let mut groups: HashMap<SatPick, Vec<usize>> = HashMap::new();
        for (i, p) in pts.iter().enumerate() {
            groups.entry(pick(t, p.0, p.1)).or_default().push(i);
        }
        for (p, ix) in groups {
            let gp: Vec<(f64, f64)> = ix.iter().map(|&i| pts[i]).collect();
            // band 13: value, 15 km min, 50 km cold-cloud fraction, cooling
            if has("tb13") || has("tb13_min") || has("ccf") || has("cool13") {
                match self.abi_grid(p, 13, t, realtime).await {
                    Ok((g, ft)) => {
                        ok += 1;
                        let near = sample_band(&g, &gp, &[(7.5, 8), (15.0, 8)], 235.0);
                        let wide = if has("ccf") { sample_band(&g, &gp, &[(12.5, 8), (25.0, 8), (37.5, 8), (50.0, 8)], 235.0) } else { vec![] };
                        let prev = if has("cool13") {
                            let back = if p.tag == "CMIPF" { 20 * 60_000 } else { 15 * 60_000 };
                            match self.abi_grid(p, 13, ft - back + 60_000, realtime).await {
                                Ok((pg, pft)) if pft < ft => Some(sample_band(&pg, &gp, &[(7.5, 8), (15.0, 8)], 235.0)),
                                _ => None,
                            }
                        } else {
                            None
                        };
                        for (k, &i) in ix.iter().enumerate() {
                            let fm = &mut out[i];
                            fm.set("sat_tb13", near[k].0);
                            fm.set("sat_tb13_min", near[k].1);
                            if let Some(w) = wide.get(k) {
                                fm.set("sat_ccf", w.2);
                            }
                            if let Some(pv) = prev.as_ref() {
                                fm.set("sat_cool13", near[k].1 - pv[k].1);
                            }
                        }
                    }
                    Err(e) => errs.push(format!("band 13: {e:#}")),
                }
            }
            for (fid, band) in [("wv8", 8u32), ("wv9", 9), ("wv10", 10), ("ref02", 2)] {
                if !has(fid) {
                    continue;
                }
                match self.abi_grid(p, band, t, realtime).await {
                    Ok((g, _)) => {
                        ok += 1;
                        let id = format!("sat_{fid}");
                        for (k, &i) in ix.iter().enumerate() {
                            let v = g.sample(gp[k].0, gp[k].1).unwrap_or(f32::NAN);
                            out[i].set(&id, v);
                        }
                    }
                    Err(e) => errs.push(format!("band {band}: {e:#}")),
                }
            }
        }
        if has("glm10") || has("glm30") || has("glm_jump") {
            match self.glm_flashes(t - 30 * 60_000, t, pts, realtime).await {
                Ok(fl) => {
                    ok += 1;
                    let c10 = count_near(&fl, pts, 20.0, t - 10 * 60_000, t);
                    let c30 = count_near(&fl, pts, 20.0, t - 30 * 60_000, t);
                    for (i, fm) in out.iter_mut().enumerate() {
                        fm.set("sat_glm10", c10[i]);
                        fm.set("sat_glm30", c30[i]);
                        fm.set("sat_glm_jump", c10[i] - (c30[i] - c10[i]) / 2.0);
                    }
                }
                Err(e) => errs.push(format!("GLM: {e:#}")),
            }
        }
        if ok == 0 && !errs.is_empty() {
            bail!("{}", errs.join("; "));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn satellite_choice_and_counts() {
        let t24 = ms(2024, 6, 1);
        let t26 = ms(2026, 6, 1);
        assert_eq!(pick(t24, 35.0, -97.0), SatPick { sat: 16, dir: "ABI-L2-CMIPC", tag: "CMIPC" });
        assert_eq!(pick(t26, 35.0, -97.0).sat, 19);
        assert_eq!(pick(t26, 40.0, -127.0).sat, 18);
        assert_eq!(pick(ms(2022, 6, 1), 40.0, -127.0).sat, 17);
        assert_eq!(pick(t26, 15.0, -40.0).tag, "CMIPF");
        assert_eq!(pick(t26, 15.0, -130.0), SatPick { sat: 18, dir: "ABI-L2-CMIPF", tag: "CMIPF" });
        let fl = vec![(35.0f32, -97.0f32, 100i64), (35.05, -97.0, 200), (36.0, -97.0, 150), (35.0, -97.0, 900)];
        let c = count_near(&fl, &[(35.0, -97.0), (40.0, -90.0)], 20.0, 0, 500);
        assert_eq!(c, vec![2.0, 0.0]);
        assert_eq!(hour_prefix("GLM-L2-LCFA", ms(2024, 5, 29) + 20 * 3_600_000).unwrap(), "GLM-L2-LCFA/2024/150/20/");
    }
}
