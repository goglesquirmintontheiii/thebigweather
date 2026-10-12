//! Vector products from decoded grids: contour lines (marching squares) and wind barbs.

use super::service::GridService;
use super::Grid;
use anyhow::{anyhow, bail, Result};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Bilinear value at a lat/lon (falls back to the nearest cell next to missing data).
pub fn sample_bilinear(g: &Grid, lat: f64, lon: f64) -> Option<f32> {
    let (fi, fj) = g.proj.ij(lat, lon)?;
    if !fi.is_finite() || !fj.is_finite() || fi < -0.5 || fj < -0.5 || fi > g.nx as f64 - 0.5 || fj > g.ny as f64 - 0.5 {
        return None;
    }
    let (i0, j0) = (fi.floor().max(0.0) as usize, fj.floor().max(0.0) as usize);
    let (i1, j1) = ((i0 + 1).min(g.nx - 1), (j0 + 1).min(g.ny - 1));
    let (tx, ty) = ((fi - i0 as f64).clamp(0.0, 1.0) as f32, (fj - j0 as f64).clamp(0.0, 1.0) as f32);
    let r = [g.data[j0 * g.nx + i0], g.data[j0 * g.nx + i1], g.data[j1 * g.nx + i0], g.data[j1 * g.nx + i1]];
    if r.contains(&0) {
        return g.sample(lat, lon);
    }
    let v = r.map(|x| g.value_raw(x));
    let a = v[0] * (1.0 - tx) + v[1] * tx;
    let b = v[2] * (1.0 - tx) + v[3] * tx;
    Some(a * (1.0 - ty) + b * ty)
}

/// NaN-aware 3×3 smoothing (1-2-1 weights), `passes` times.
pub fn smooth(z: &mut [f32], nx: usize, ny: usize, passes: usize) {
    for _ in 0..passes {
        let src = z.to_vec();
        z.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
            for (i, o) in row.iter_mut().enumerate() {
                if !src[j * nx + i].is_finite() {
                    continue;
                }
                let (mut s, mut w) = (0f32, 0f32);
                for dj in -1isize..=1 {
                    for di in -1isize..=1 {
                        let (ii, jj) = (i as isize + di, j as isize + dj);
                        if ii < 0 || jj < 0 || ii as usize >= nx || jj as usize >= ny {
                            continue;
                        }
                        let v = src[jj as usize * nx + ii as usize];
                        if v.is_finite() {
                            let k = (if di == 0 { 2.0 } else { 1.0 }) * (if dj == 0 { 2.0 } else { 1.0 });
                            s += v * k;
                            w += k;
                        }
                    }
                }
                *o = s / w;
            }
        });
    }
}

/// Marching squares for one level on a regular raster (x fastest). Returns polylines in raster
/// coordinates (x = column, y = row), joined across cells.
pub fn isolines(z: &[f32], nx: usize, ny: usize, level: f32) -> Vec<Vec<(f32, f32)>> {
    if nx < 2 || ny < 2 {
        return vec![];
    }
    // edge ids: horizontal edge (i,j)-(i+1,j) = 2*(j*nx+i); vertical (i,j)-(i,j+1) = 2*(j*nx+i)+1
    let h = |i: usize, j: usize| 2 * (j * nx + i);
    let v = |i: usize, j: usize| 2 * (j * nx + i) + 1;
    let mut segs: Vec<(usize, usize)> = vec![];
    for j in 0..ny - 1 {
        for i in 0..nx - 1 {
            let (a, b, c, d) = (z[j * nx + i], z[j * nx + i + 1], z[(j + 1) * nx + i + 1], z[(j + 1) * nx + i]);
            if !(a.is_finite() && b.is_finite() && c.is_finite() && d.is_finite()) {
                continue;
            }
            let idx = (a >= level) as u8 | ((b >= level) as u8) << 1 | ((c >= level) as u8) << 2 | ((d >= level) as u8) << 3;
            // edges: bottom = h(i,j), right = v(i+1,j), top = h(i,j+1), left = v(i,j)
            let (bo, ri, to, le) = (h(i, j), v(i + 1, j), h(i, j + 1), v(i, j));
            match idx {
                0 | 15 => {}
                1 | 14 => segs.push((le, bo)),
                2 | 13 => segs.push((bo, ri)),
                3 | 12 => segs.push((le, ri)),
                4 | 11 => segs.push((ri, to)),
                6 | 9 => segs.push((bo, to)),
                7 | 8 => segs.push((le, to)),
                5 | 10 => {
                    // saddle: decide by the centre value
                    let centre = (a + b + c + d) / 4.0 >= level;
                    if (idx == 5) == centre {
                        segs.push((le, to));
                        segs.push((bo, ri));
                    } else {
                        segs.push((le, bo));
                        segs.push((ri, to));
                    }
                }
                _ => {}
            }
        }
    }
    let point = |e: usize| -> (f32, f32) {
        let cell = e / 2;
        let (i, j) = (cell % nx, cell / nx);
        let (za, zb, horiz) = if e % 2 == 0 { (z[j * nx + i], z[j * nx + i + 1], true) } else { (z[j * nx + i], z[(j + 1) * nx + i], false) };
        let t = if (zb - za).abs() < 1e-12 { 0.5 } else { ((level - za) / (zb - za)).clamp(0.0, 1.0) };
        if horiz { (i as f32 + t, j as f32) } else { (i as f32, j as f32 + t) }
    };
    let mut by_edge: HashMap<usize, Vec<usize>> = HashMap::with_capacity(segs.len() * 2);
    for (k, s) in segs.iter().enumerate() {
        by_edge.entry(s.0).or_default().push(k);
        by_edge.entry(s.1).or_default().push(k);
    }
    let mut used = vec![false; segs.len()];
    let mut lines = vec![];
    for start in 0..segs.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut chain: std::collections::VecDeque<usize> = [segs[start].0, segs[start].1].into_iter().collect();
        // extend forward from the back, then backward from the front
        for forward in [true, false] {
            loop {
                let end = if forward { *chain.back().unwrap() } else { *chain.front().unwrap() };
                let next = by_edge.get(&end).and_then(|l| l.iter().copied().find(|&k| !used[k]));
                let Some(k) = next else { break };
                used[k] = true;
                let other = if segs[k].0 == end { segs[k].1 } else { segs[k].0 };
                if forward {
                    chain.push_back(other);
                } else {
                    chain.push_front(other);
                }
            }
        }
        lines.push(chain.into_iter().map(point).collect());
    }
    lines
}

/// Douglas-Peucker simplification.
pub fn simplify(pts: &[(f32, f32)], tol: f32) -> Vec<(f32, f32)> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (p, q) = (pts[a], pts[b]);
        let (dx, dy) = (q.0 - p.0, q.1 - p.1);
        let len = (dx * dx + dy * dy).sqrt();
        let (mut best, mut bi) = (-1f32, a);
        for (k, r) in pts.iter().enumerate().take(b).skip(a + 1) {
            let d = if len < 1e-9 { ((r.0 - p.0).powi(2) + (r.1 - p.1).powi(2)).sqrt() } else { ((r.0 - p.0) * dy - (r.1 - p.1) * dx).abs() / len };
            if d > best {
                best = d;
                bi = k;
            }
        }
        if best > tol {
            keep[bi] = true;
            stack.push((a, bi));
            stack.push((bi, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// A "nice" contour interval giving roughly 12 levels over a range.
pub fn nice_interval(range: f32) -> f32 {
    if !(range > 0.0) {
        return 1.0;
    }
    let raw = range / 12.0;
    let p = 10f32.powf(raw.log10().floor());
    let m = raw / p;
    let n = if m < 1.5 { 1.0 } else if m < 3.0 { 2.0 } else if m < 3.5 { 2.5 } else if m < 7.5 { 5.0 } else { 10.0 };
    n * p
}

/// Default interval and base for a layer's units/variable (None = automatic).
fn default_interval(layer: &str, units: &str) -> Option<(f32, f32)> {
    if layer.ends_with("/mslp") || units == "hPa" {
        return Some((4.0, 0.0));
    }
    if layer.contains("hgt500") {
        return Some((60.0, 0.0));
    }
    match units {
        "°C" => Some((2.0, 0.0)),
        "dBZ" => Some((10.0, 0.0)),
        _ => None,
    }
}

/// Regular lat/lon raster over `bbox` sampled from `g`, plus its cell size (degrees).
pub fn raster(g: &Grid, bbox: [f64; 4], max_cells: usize) -> (Vec<f32>, usize, usize) {
    let [w, s, e, n] = bbox;
    // native resolution across the box, capped
    let native = {
        let a = g.proj.ij((s + n) / 2.0, w);
        let b = g.proj.ij((s + n) / 2.0, e);
        let c = g.proj.ij(s, (w + e) / 2.0);
        let d = g.proj.ij(n, (w + e) / 2.0);
        let dx = a.zip(b).map(|(a, b)| ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt()).unwrap_or(max_cells as f64);
        let dy = c.zip(d).map(|(c, d)| ((d.0 - c.0).powi(2) + (d.1 - c.1).powi(2)).sqrt()).unwrap_or(max_cells as f64);
        dx.max(dy)
    };
    let long = (native.ceil() as usize + 1).clamp(16, max_cells);
    let (nx, ny) = if e - w >= n - s { (long, ((long as f64 * (n - s) / (e - w)).round() as usize).max(2)) } else { (((long as f64 * (e - w) / (n - s)).round() as usize).max(2), long) };
    let (dlon, dlat) = ((e - w) / (nx - 1) as f64, (n - s) / (ny - 1) as f64);
    let mut z = vec![f32::NAN; nx * ny];
    z.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
        let lat = s + j as f64 * dlat;
        for (i, o) in row.iter_mut().enumerate() {
            if let Some(v) = sample_bilinear(g, lat, w + i as f64 * dlon) {
                *o = v;
            }
        }
    });
    (z, nx, ny)
}

/// Contours of `g` over `bbox` as GeoJSON features.
#[allow(clippy::too_many_arguments)]
pub fn contour_features(g: &Grid, bbox: [f64; 4], interval: f32, base: f32, passes: usize, major_every: i64, max_cells: usize) -> Result<Vec<Value>> {
    let [w, s, e, n] = bbox;
    let (mut z, nx, ny) = raster(g, bbox, max_cells);
    smooth(&mut z, nx, ny, passes);
    let (lo, hi) = z.iter().filter(|v| v.is_finite()).fold((f32::INFINITY, f32::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
    if !lo.is_finite() {
        return Ok(vec![]);
    }
    let k0 = ((lo - base) / interval).ceil() as i64;
    let k1 = ((hi - base) / interval).floor() as i64;
    if k1 - k0 > 200 {
        bail!("interval too small for this field ({} levels); use a larger interval", k1 - k0 + 1);
    }
    let (dlon, dlat) = ((e - w) / (nx - 1) as f64, (n - s) / (ny - 1) as f64);
    let feats: Vec<Vec<Value>> = (k0..=k1)
        .into_par_iter()
        .map(|k| {
            let level = base + k as f32 * interval;
            let major = major_every > 0 && k.rem_euclid(major_every) == 0;
            isolines(&z, nx, ny, level)
                .into_iter()
                .filter(|l| l.len() >= 3)
                .map(|l| {
                    let l = simplify(&l, 0.35);
                    let coords: Vec<[f64; 2]> = l.iter().map(|p| [((w + p.0 as f64 * dlon) * 1e4).round() / 1e4, ((s + p.1 as f64 * dlat) * 1e4).round() / 1e4]).collect();
                    let v = (level * 1000.0).round() / 1000.0;
                    json!({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": {"value": v, "major": major}})
                })
                .collect()
        })
        .collect();
    Ok(feats.into_iter().flatten().collect())
}

fn bbox_param(q: &HashMap<String, String>) -> Result<[f64; 4]> {
    let b: Vec<f64> = q.get("bbox").map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect()).unwrap_or_default();
    if b.len() != 4 || b[0] >= b[2] || b[1] >= b[3] || b[1] < -90.0 || b[3] > 90.0 || b[2] - b[0] > 360.0 {
        bail!("bbox=w,s,e,n required");
    }
    Ok([b[0], b[1], b[2], b[3]])
}

/// `GET /api/grid/contours?layer&time|key&bbox&interval&base&smooth&major`
pub async fn contours_api(gs: &GridService, q: &HashMap<String, String>) -> Result<Value> {
    let g = |k: &str| q.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let layer_id = g("layer").ok_or_else(|| anyhow!("layer required"))?;
    let layer = gs.layer(layer_id)?.clone();
    let bbox = bbox_param(q)?;
    let key = match g("key") {
        Some(k) => k.to_string(),
        None => {
            let fr = gs.frames(layer_id, 60, g("run"), g("storm"), None).await?;
            let t = g("time").and_then(|t| t.parse::<i64>().ok());
            let best = match t {
                Some(t) => fr.frames.iter().min_by_key(|f| (f.time - t).abs()),
                None => fr.frames.iter().filter(|f| f.time <= chrono::Utc::now().timestamp_millis()).next_back().or(fr.frames.first()),
            };
            best.map(|f| f.key.clone()).ok_or_else(|| anyhow!("no frame for {layer_id}"))?
        }
    };
    if key.starts_with("goesrgb|") {
        bail!("RGB composites have no values to contour");
    }
    let grid = gs.grid(&key).await?;
    let (dint, dbase) = default_interval(layer_id, layer.units).unwrap_or((0.0, 0.0));
    let interval: f32 = match g("interval") {
        Some(v) => v.parse().ok().filter(|v: &f32| *v > 0.0 && v.is_finite()).ok_or_else(|| anyhow!("interval must be > 0"))?,
        None => dint,
    };
    let base: f32 = g("base").and_then(|v| v.parse().ok()).unwrap_or(dbase);
    let passes = match g("smooth") {
        None | Some("0") => 0,
        Some(v) => v.parse::<usize>().unwrap_or(1).clamp(1, 4),
    };
    let major = g("major").and_then(|v| v.parse::<i64>().ok()).unwrap_or(5).clamp(0, 100);
    let max_cells = g("res").and_then(|v| v.parse::<usize>().ok()).unwrap_or(400).clamp(32, 1200);
    let units = layer.units;
    let (valid, reference) = (grid.valid_ms, grid.ref_ms);
    let k2 = key.clone();
    let out = gs
        .run_blocking(move || {
            let interval = if interval > 0.0 {
                interval
            } else {
                let (z, _, _) = raster(&grid, bbox, 128);
                let (lo, hi) = z.iter().filter(|v| v.is_finite()).fold((f32::INFINITY, f32::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
                nice_interval(hi - lo)
            };
            let feats = contour_features(&grid, bbox, interval, base, passes, major, max_cells)?;
            let mut v = json!({"type": "FeatureCollection", "features": feats});
            v["key"] = json!(k2);
            v["interval"] = json!(interval);
            v["base"] = json!(base);
            Ok(v)
        })
        .await?;
    let mut out = out;
    out["layer"] = json!(layer_id);
    out["units"] = json!(units);
    out["time"] = json!(valid);
    out["run"] = json!(reference);
    Ok(out)
}

/// Web Mercator world pixel ↔ lat/lon at a zoom.
fn merc_px(lat: f64, lon: f64, world: f64) -> (f64, f64) {
    let s = lat.clamp(-85.05, 85.05).to_radians().sin();
    ((lon + 180.0) / 360.0 * world, (0.5 - ((1.0 + s) / (1.0 - s)).ln() / (4.0 * std::f64::consts::PI)) * world)
}

fn merc_ll(x: f64, y: f64, world: f64) -> (f64, f64) {
    let lon = x / world * 360.0 - 180.0;
    let lat = (std::f64::consts::PI * (1.0 - 2.0 * y / world)).sinh().atan().to_degrees();
    (lat, lon)
}

/// Barb positions: a screen-space lattice every `spacing` px at `zoom`, aligned to the world so
/// barbs stay put while panning.
pub fn barb_points(bbox: [f64; 4], zoom: f64, spacing: f64) -> Vec<(f64, f64)> {
    let world = 256.0 * 2f64.powf(zoom);
    let [w, s, e, n] = bbox;
    let (x0, y0) = merc_px(n, w, world);
    let (x1, y1) = merc_px(s, e, world);
    let mut out = vec![];
    let mut y = (y0 / spacing).ceil() * spacing;
    while y <= y1 {
        let mut x = (x0 / spacing).ceil() * spacing;
        while x <= x1 {
            out.push(merc_ll(x, y, world));
            x += spacing;
        }
        y += spacing;
    }
    out
}

/// Meteorological direction (degrees the wind blows from) and speed in knots.
pub fn dir_kt(u: f32, v: f32) -> (f32, f32) {
    let d = ((-u).atan2(-v).to_degrees() + 360.0) % 360.0;
    (d, (u * u + v * v).sqrt() * 1.943_844)
}

/// `GET /api/grid/barbs?layer&level&time&bbox&spacing_px&zoom`
pub async fn barbs_api(gs: &GridService, q: &HashMap<String, String>) -> Result<Value> {
    let g = |k: &str| q.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let model = g("layer").or(g("model")).ok_or_else(|| anyhow!("layer=<model> required"))?.trim_start_matches("model/").split('/').next().unwrap_or("").to_string();
    let level = g("level").unwrap_or("10m").to_string();
    let bbox = bbox_param(q)?;
    let spacing = g("spacing_px").and_then(|v| v.parse::<f64>().ok()).unwrap_or(40.0).clamp(12.0, 400.0);
    let zoom = match g("zoom").and_then(|v| v.parse::<f64>().ok()) {
        Some(z) => z.clamp(0.0, 22.0),
        // assume the box fills ~1280 px across
        None => (1280.0 * 360.0 / ((bbox[2] - bbox[0]) * 256.0)).log2().clamp(0.0, 22.0),
    };
    let time = g("time").and_then(|t| t.parse::<i64>().ok());
    let (gu, gv, run, fh) = gs.wind_uv(&model, &level, time).await?;
    let out = gs
        .run_blocking(move || {
            let mut spacing = spacing;
            let mut pts = barb_points(bbox, zoom, spacing);
            while pts.len() > 8000 {
                spacing *= 1.5;
                pts = barb_points(bbox, zoom, spacing);
            }
            let feats: Vec<Value> = pts
                .par_iter()
                .filter_map(|&(lat, lon)| {
                    let (a, b) = (gu.sample(lat, lon)?, gv.sample(lat, lon)?);
                    let (u, v) = if gu.grid_rel {
                        let r = gu.proj.north_angle(lat, lon) as f32;
                        (r.cos() * a + r.sin() * b, -r.sin() * a + r.cos() * b)
                    } else {
                        (a, b)
                    };
                    let (d, kt) = dir_kt(u, v);
                    let r2 = |x: f32| (x * 100.0).round() / 100.0;
                    Some(crate::overlays::point(lon, lat, json!({"u": r2(u), "v": r2(v), "speed_kt": (kt * 10.0).round() / 10.0, "dir": d.round()})))
                })
                .collect();
            Ok((json!({"type": "FeatureCollection", "features": feats}), gu.valid_ms, spacing))
        })
        .await?;
    let (mut v, valid, spacing) = out;
    v["model"] = json!(model);
    v["level"] = json!(level);
    v["run"] = json!(run);
    v["fh"] = json!(fh);
    v["time"] = json!(valid);
    v["spacing_px"] = json!(spacing);
    v["zoom"] = json!(zoom);
    v["units"] = json!({"u": "m/s", "v": "m/s", "speed": "kt", "dir": "deg from"});
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::Proj;

    #[test]
    fn circle_contour_closes() {
        let (nx, ny) = (41, 41);
        let z: Vec<f32> = (0..nx * ny).map(|k| (((k % nx) as f32 - 20.0).powi(2) + ((k / nx) as f32 - 20.0).powi(2)).sqrt()).collect();
        let l = isolines(&z, nx, ny, 10.0);
        assert_eq!(l.len(), 1);
        let ring = &l[0];
        assert_eq!(ring.first(), ring.last());
        for p in ring {
            let r = ((p.0 - 20.0).powi(2) + (p.1 - 20.0).powi(2)).sqrt();
            assert!((r - 10.0).abs() < 0.3, "{r}");
        }
        let s = simplify(ring, 0.35);
        assert!(s.len() < ring.len() && s.len() > 8);
    }

    #[test]
    fn open_lines_and_missing() {
        let (nx, ny) = (10, 6);
        let mut z: Vec<f32> = (0..nx * ny).map(|k| (k % nx) as f32).collect();
        z[3 * nx + 4] = f32::NAN;
        let l = isolines(&z, nx, ny, 6.5);
        assert_eq!(l.len(), 1);
        assert!(l[0].iter().all(|p| (p.0 - 6.5).abs() < 1e-5));
        assert_eq!(l[0].len(), ny);
        // the missing cell breaks the 4.5 line into two
        assert_eq!(isolines(&z, nx, ny, 4.5).len(), 2);
    }

    #[test]
    fn grid_contours_and_intervals() {
        let (nx, ny) = (200, 100);
        let vals: Vec<f32> = (0..nx * ny).map(|k| 1000.0 + (k % nx) as f32 * 0.1).collect();
        let g = Grid::from_values(nx, ny, Proj::LatLon { lat0: 30.0, lon0: -100.0, dlat: 0.1, dlon: 0.1, nx, global: false }, &vals, 0, 0);
        let f = contour_features(&g, [-99.0, 31.0, -82.0, 38.0], 4.0, 0.0, 1, 2, 200).unwrap();
        // values 1001..1017 → 1004, 1008, 1012, 1016
        let vals: Vec<f64> = f.iter().map(|x| x["properties"]["value"].as_f64().unwrap()).collect();
        assert_eq!(vals, vec![1004.0, 1008.0, 1012.0, 1016.0]);
        assert!(f.iter().any(|x| x["properties"]["major"] == true));
        let c = f[0]["geometry"]["coordinates"].as_array().unwrap();
        assert!((c[0][0].as_f64().unwrap() - -96.0).abs() < 0.15, "{c:?}");
        assert_eq!(nice_interval(37.0), 2.5);
        assert_eq!(nice_interval(1200.0), 100.0);
        assert!(contour_features(&g, [-99.0, 31.0, -82.0, 38.0], 0.01, 0.0, 0, 5, 200).is_err());
    }

    #[test]
    fn barb_lattice_and_dirs() {
        let p = barb_points([-100.0, 30.0, -90.0, 40.0], 5.0, 40.0);
        // 10° of longitude at z5 = 227.6 px → ~6 columns
        assert!(p.len() > 20 && p.len() < 60, "{}", p.len());
        let p2 = barb_points([-99.0, 30.0, -90.0, 40.0], 5.0, 40.0);
        assert!(p2.iter().all(|a| p.iter().any(|b| (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9)));
        let (d, kt) = dir_kt(0.0, -10.0);
        assert!((d - 0.0).abs() < 1e-3 && (kt - 19.44).abs() < 0.01);
        assert!((dir_kt(10.0, 0.0).0 - 270.0).abs() < 1e-3);
    }
}
