//! Satellite-derived point overlays: GOES ABI fire detections (`goesfire`), overshooting tops /
//! cloud-top cooling (`ot`) and GLM lightning jumps per storm cell (`ljump`).

use super::{fc, point, Overlays};
use crate::grid::satprod;
use anyhow::{anyhow, bail, Result};
use chrono::{Datelike, Timelike, Utc};
use serde_json::{json, Value};
use std::sync::Arc;

/// Newest object keys (oldest first) of an ABI product over the last `hours` hours.
async fn abi_keys(o: &Overlays, bucket: &str, product: &str, filter: &str, hours: i64) -> Result<Vec<String>> {
    let now = Utc::now();
    let mut keys = vec![];
    for back in (0..hours.max(1)).rev() {
        let t = now - chrono::Duration::hours(back);
        let prefix = format!("{product}/{:04}/{:03}/{:02}/", t.year(), t.ordinal(), t.hour());
        if let Ok(l) = crate::s3::list(&o.http, bucket, &prefix, None, None, 3).await {
            keys.extend(l.objects.into_iter().map(|x| x.key).filter(|k| k.contains(filter) && k.ends_with(".nc")));
        }
    }
    keys.sort_by_key(|k| crate::grid::goes::time_from_name(k).unwrap_or(0));
    Ok(keys)
}

fn sat_param(s: &str) -> Result<u32> {
    match s {
        "" | "19" | "east" => Ok(19),
        "18" | "west" => Ok(18),
        _ => bail!("sat must be 19 or 18"),
    }
}

/// ABI L2 fire detections of the newest scan: `sat=19|18`, `sector=conus|full`,
/// `min_frp` (MW), `conf=all|high|medium` (default all but "low probability").
pub async fn goes_fire(o: &Overlays, sat: &str, sector: &str, min_frp: &str, conf: &str) -> Result<Value> {
    let sat = sat_param(sat)?;
    let product = match sector {
        "" | "conus" => "ABI-L2-FDCC",
        "full" => "ABI-L2-FDCF",
        _ => bail!("sector must be conus or full"),
    };
    let bucket = format!("noaa-goes{sat}");
    let keys = abi_keys(o, &bucket, product, &format!("_G{sat}_"), 2).await?;
    let key = keys.last().ok_or_else(|| anyhow!("no recent GOES-{sat} {product} files"))?.clone();
    let b = o.get_bytes(&crate::s3::object_url(&bucket, &key)).await?;
    let (t, fires) = tokio::task::spawn_blocking(move || satprod::read_fdc(&b)).await??;
    let min_frp: f32 = min_frp.parse().unwrap_or(0.0);
    let feats = fires
        .into_iter()
        .filter(|f| f.frp.unwrap_or(0.0) >= min_frp)
        .filter(|f| {
            let c = f.mask % 20;
            match conf {
                "high" => matches!(c, 10 | 11 | 13),
                "medium" => matches!(c, 10 | 11 | 13 | 14),
                "all" => true,
                _ => c != 15,
            }
        })
        .map(|f| {
            point(
                f.lon,
                f.lat,
                json!({"frp_mw": f.frp.map(|x| (x * 10.0).round() / 10.0), "temp_k": f.temp.map(|x| x.round()), "area_km2": f.area.map(|x| (x * 1000.0).round() / 1000.0),
                       "mask": f.mask, "class": satprod::fire_class(f.mask), "filtered": f.mask >= 30, "t": t, "sat": sat}),
            )
        })
        .collect();
    let mut v = fc(feats);
    v["time"] = json!(t);
    v["file"] = json!(key.rsplit('/').next());
    Ok(v)
}

/// Overshooting tops and cloud-top cooling from band 13: `sat`, `sector=conus|meso1|meso2`,
/// `max_bt` (K, 215), `delta` (K, 6.5), `cool` (K per 15 min, 6).
pub async fn overshooting(o: &Overlays, sat: &str, sector: &str, max_bt: &str, delta: &str, cool: &str) -> Result<Value> {
    let sat = sat_param(sat)?;
    let sector = if sector.is_empty() { "conus" } else { sector };
    let (_, _, dir, tag, _) = crate::grid::sources::GOES_SECTORS.iter().find(|s| s.0 == sat && s.1 == sector && sector != "full").ok_or_else(|| anyhow!("sector must be conus, meso1 or meso2"))?;
    let bucket = format!("noaa-goes{sat}");
    let keys = abi_keys(o, &bucket, dir, &format!("{tag}-M6C13_G{sat}_"), 2).await?;
    let keys: Vec<String> = if keys.is_empty() { abi_keys(o, &bucket, dir, &format!("{tag}-M3C13_G{sat}_"), 2).await? } else { keys };
    let newest = keys.last().ok_or_else(|| anyhow!("no recent GOES-{sat} {sector} band 13 files"))?.clone();
    let tn = crate::grid::goes::time_from_name(&newest).unwrap_or(0);
    let older = keys.iter().filter(|k| crate::grid::goes::time_from_name(k).map(|t| (tn - t - 15 * 60_000).abs() <= 5 * 60_000).unwrap_or(false)).min_by_key(|k| (tn - crate::grid::goes::time_from_name(k).unwrap_or(0) - 15 * 60_000).abs()).cloned();
    let max_bt: f32 = max_bt.parse().unwrap_or(215.0f32).clamp(180.0, 240.0);
    let delta: f32 = delta.parse().unwrap_or(6.5f32).clamp(2.0, 20.0);
    let cool: f32 = cool.parse().unwrap_or(6.0f32).clamp(2.0, 30.0);
    let bn = o.get_bytes(&crate::s3::object_url(&bucket, &newest)).await?;
    let bo = match &older {
        Some(k) => o.get_bytes(&crate::s3::object_url(&bucket, k)).await.ok(),
        None => None,
    };
    let feats = tokio::task::spawn_blocking(move || -> Result<Vec<Value>> {
        let now = crate::grid::goes::read_band(&bn, 0)?;
        let before = bo.and_then(|b| crate::grid::goes::read_band(&b, 0).ok());
        let mut out = vec![];
        for ot in satprod::detect_ot(&now, max_bt, delta) {
            let Some((lat, lon)) = crate::grid::rgb::geos_latlon(&now.proj, ot.i, ot.j) else { continue };
            let c = before.as_ref().and_then(|b| satprod::cooling_at(&now, b, ot.i, ot.j));
            out.push(point(lon, lat, json!({"kind": "ot", "bt_k": (ot.bt * 10.0).round() / 10.0, "delta_k": (ot.delta * 10.0).round() / 10.0, "cooling_k_15min": c.map(|x| (x * 10.0).round() / 10.0), "t": now.time})));
        }
        if let Some(b) = &before {
            for (i, j, bt, c) in satprod::cooling_points(&now, b, cool) {
                let Some((lat, lon)) = crate::grid::rgb::geos_latlon(&now.proj, i, j) else { continue };
                out.push(point(lon, lat, json!({"kind": "ctc", "bt_k": (bt * 10.0).round() / 10.0, "cooling_k_15min": (c * 10.0).round() / 10.0, "t": now.time})));
            }
        }
        Ok(out)
    })
    .await??;
    let mut v = fc(feats);
    v["time"] = json!(tn);
    v["cooling_available"] = json!(older.is_some());
    Ok(v)
}

// ---------- lightning jumps ----------

/// Flash-rate series (flashes/min per `bin_min`-minute bin, oldest first) of flashes within
/// `radius_km` of a moving cell: position at bin centre = (lat, lon) − motion·(t_cell − t_bin).
#[allow(clippy::too_many_arguments)]
pub fn flash_series(flashes: &[(i64, f64, f64)], lat: f64, lon: f64, t_cell: i64, u_ms: f64, v_ms: f64, radius_km: f64, t_end: i64, nbins: usize, bin_min: i64) -> Vec<f64> {
    let bin = bin_min * 60_000;
    let t0 = t_end - nbins as i64 * bin;
    let mut counts = vec![0usize; nbins];
    for &(t, fla, flo) in flashes {
        if t < t0 || t >= t_end {
            continue;
        }
        let k = ((t - t0) / bin) as usize;
        let tc = t0 + k as i64 * bin + bin / 2;
        let dt = (t_cell - tc) as f64 / 1000.0;
        // shift the cell back along its motion (u east, v north, m/s)
        let clat = lat - v_ms * dt / 111_320.0;
        let clon = lon - u_ms * dt / (111_320.0 * lat.to_radians().cos().max(0.05));
        if super::km(clat, clon, fla, flo) <= radius_km {
            counts[k] += 1;
        }
    }
    counts.iter().map(|&c| c as f64 / bin_min as f64).collect()
}

/// Schultz et al. (2009) 2σ lightning jump on a flash-rate series (2-min bins): DFRDT_k =
/// (FR_k − FR_{k−1}) / 2 min; σ = standard deviation of the 5 DFRDT values before k; a jump at
/// k when FR_k ≥ `min_rate` and DFRDT_k > `mult`·σ (σ > 0). Returns (DFRDT, σ, jump) per bin
/// (None until 6 bins of history exist).
pub fn jumps(fr: &[f64], min_rate: f64, mult: f64) -> Vec<Option<(f64, f64, bool)>> {
    let d: Vec<f64> = (0..fr.len()).map(|k| if k == 0 { 0.0 } else { (fr[k] - fr[k - 1]) / 2.0 }).collect();
    (0..fr.len())
        .map(|k| {
            if k < 6 {
                return None;
            }
            let w = &d[k - 5..k];
            let m = w.iter().sum::<f64>() / 5.0;
            let sd = (w.iter().map(|x| (x - m).powi(2)).sum::<f64>() / 4.0).sqrt();
            Some((d[k], sd, fr[k] >= min_rate && sd > 0.0 && d[k] > mult * sd))
        })
        .collect()
}

/// `ljump`: per storm cell (IEM NEXRAD storm attributes) GLM flash rates in 2-min bins over the
/// last 30 min and the Schultz 2σ jump test on the newest complete bin. Params `radius_km`
/// (15), `min_rate` (fl/min, 10), `sigma` (2). Starts the GLM poller (needs ~14 min of data).
pub async fn ljump(o: &Arc<Overlays>, radius: &str, min_rate: &str, sigma: &str) -> Result<Value> {
    o.touch("glm");
    super::obs::Glm::ensure(o);
    let radius: f64 = radius.parse().unwrap_or(15.0f64).clamp(5.0, 40.0);
    let min_rate: f64 = min_rate.parse().unwrap_or(10.0f64).clamp(0.0, 200.0);
    let mult: f64 = sigma.parse().unwrap_or(2.0f64).clamp(1.0, 5.0);
    let cells = super::more::storm_attr(o, "").await?;
    let now = Utc::now().timestamp_millis();
    // newest complete 2-min bin ends ~1 min ago (GLM files lag ~40 s)
    let t_end = (now - 60_000) / 120_000 * 120_000;
    let nbins = 15;
    let span = o.glm.span();
    let raw = o.glm.flashes_since(t_end - nbins as i64 * 120_000);
    let mut feats = vec![];
    for c in cells["features"].as_array().into_iter().flatten() {
        let p = &c["properties"];
        let (Some(lon), Some(lat)) = (c["geometry"]["coordinates"][0].as_f64(), c["geometry"]["coordinates"][1].as_f64()) else { continue };
        let t_cell = p["t"].as_i64().unwrap_or(now);
        // motion: "drct" is where the cell comes from, sknt its speed
        let (u, v) = match (p["drct"].as_f64(), p["sknt"].as_f64()) {
            (Some(d), Some(k)) if k > 0.0 => {
                let to = (d + 180.0).to_radians();
                (k * 0.514444 * to.sin(), k * 0.514444 * to.cos())
            }
            _ => (0.0, 0.0),
        };
        // one GLM per area to avoid double counting the East/West overlap
        let want = if lon > -105.0 { 19 } else { 18 };
        let fl: Vec<(i64, f64, f64)> = raw.iter().filter(|f| f.1 == want || f.1 == 16).map(|f| (f.0, f.2[1] as f64, f.2[0] as f64)).collect();
        let fr = flash_series(&fl, lat, lon, t_cell, u, v, radius, t_end, nbins, 2);
        let j = jumps(&fr, min_rate, mult);
        let last = j.last().copied().flatten();
        let jump_times: Vec<i64> = j.iter().enumerate().filter(|(_, x)| x.map(|x| x.2).unwrap_or(false)).map(|(k, _)| t_end - (nbins - k) as i64 * 120_000 + 120_000).collect();
        let rate = fr.last().copied().unwrap_or(0.0);
        if rate == 0.0 && fr.iter().all(|x| *x == 0.0) {
            continue;
        }
        let r1 = |x: f64| (x * 10.0).round() / 10.0;
        feats.push(point(
            lon,
            lat,
            json!({
                "cell_id": format!("{}-{}", p["nexrad"].as_str().unwrap_or(""), p["storm_id"].as_str().unwrap_or("")),
                "t": t_end, "rate_fpm": r1(rate), "dfrdt": last.map(|x| r1(x.0)), "sigma": last.map(|x| r1(x.1)),
                "jump": last.map(|x| x.2).unwrap_or(false), "jump_times": jump_times, "series_fpm": fr.iter().map(|x| r1(*x)).collect::<Vec<_>>(),
                "bin_min": 2, "radius_km": radius, "glm": want,
            }),
        ));
    }
    let mut out = fc(feats);
    let have_min = span.map(|(a, _)| (t_end - a) / 60_000).unwrap_or(0);
    out["loading"] = json!(have_min < 14);
    out["history_min"] = json!(have_min.clamp(0, 30));
    out["time"] = json!(t_end);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schultz_two_sigma() {
        // steady ~10 fl/min with small noise, then a jump to 30
        let fr = [10.0, 11.0, 10.0, 12.0, 11.0, 10.0, 11.0, 12.0, 30.0];
        let j = jumps(&fr, 10.0, 2.0);
        assert!(j[..6].iter().all(|x| x.is_none()));
        assert!(!j[7].unwrap().2);
        let (d, s, jump) = j[8].unwrap();
        assert!(jump, "{d} {s}");
        assert!((d - 9.0).abs() < 1e-9);
        // same jump below the activation rate: no flag
        let low: Vec<f64> = fr.iter().map(|x| x / 10.0).collect();
        assert!(!jumps(&low, 10.0, 2.0)[8].unwrap().2);
    }

    #[test]
    fn moving_cell_series() {
        // a cell moving east at 10 m/s; flashes follow it: one per bin at its position then
        let t_end = 1_800_000i64 * 1000;
        let (lat, lon) = (35.0f64, -97.0f64);
        let mut fl = vec![];
        for k in 0..5 {
            let tc = t_end - (5 - k) * 120_000 + 60_000;
            let dt = (t_end - tc) as f64 / 1000.0;
            let flon = lon - 10.0 * dt / (111_320.0 * lat.to_radians().cos());
            for _ in 0..(k + 1) * 2 {
                fl.push((tc, lat, flon));
            }
        }
        let s = flash_series(&fl, lat, lon, t_end, 10.0, 0.0, 5.0, t_end, 5, 2);
        assert_eq!(s, vec![1.0, 2.0, 3.0, 4.0, 5.0]);
        // a stationary assumption misses the early flashes (cell 30 km+ away)
        let s0 = flash_series(&fl, lat, lon, t_end, 0.0, 0.0, 5.0, t_end, 5, 2);
        assert!(s0[0] == 0.0 && s0[4] == 5.0);
    }
}
