//! 0.8.1: one storm → a few detections, and the same storm keeps the same id across cycles.
//!
//! * [`cluster`]: radar cells of one volume grouped into storms (connected components of cells
//!   whose edges are within a few km of each other).
//! * [`thin`]: per model and storm, greedy non-max suppression: the strongest detection, plus
//!   more only for large storms (spaced ≥ [`KEEP_SPACING_KM`] apart, at most [`MAX_PER_STORM`]).
//!   A storm kept as one detection is outlined by the hull of all its cells.
//! * [`nms`]: the same model seen by several radars: weaker duplicates within
//!   [`NMS_RADIUS_KM`] are dropped.
//! * [`StormReg`]: storm identity across cycles and radars (nearest predicted position),
//!   so a new cycle's detection replaces the previous one of the same storm.

use super::cells::Cell;
use super::runner::Detection;
use crate::radar::geom::bearing_dist;
use std::collections::HashMap;

/// Cells whose edges are this close belong to the same storm.
pub const JOIN_GAP_KM: f64 = 6.0;
/// Detections of one model kept within a storm are at least this far apart.
pub const KEEP_SPACING_KM: f64 = 25.0;
/// At most this many detections of one model per storm.
pub const MAX_PER_STORM: usize = 4;
/// Cross-radar duplicate radius.
pub const NMS_RADIUS_KM: f64 = 15.0;

fn km(a: (f64, f64), b: (f64, f64)) -> f64 {
    bearing_dist(a.0, a.1, b.0, b.1).1 / 1000.0
}

fn radius_km(c: &Cell) -> f64 {
    let a = c.feats.get("area_km2") as f64;
    if a.is_finite() && a > 0.0 { (a / std::f64::consts::PI).sqrt() } else { 4.0 }
}

/// Storm (component) index of each cell.
pub fn cluster(cells: &[Cell]) -> Vec<usize> {
    let n = cells.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    let r: Vec<f64> = cells.iter().map(radius_km).collect();
    for i in 0..n {
        for j in i + 1..n {
            // cheap reject (1° lat ≈ 111 km)
            let reach = r[i] + r[j] + JOIN_GAP_KM;
            if (cells[i].lat - cells[j].lat).abs() * 111.0 > reach {
                continue;
            }
            if km((cells[i].lat, cells[i].lon), (cells[j].lat, cells[j].lon)) <= reach {
                let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                if a != b {
                    parent[a] = b;
                }
            }
        }
    }
    // dense ids
    let mut ids: HashMap<usize, usize> = HashMap::new();
    (0..n)
        .map(|i| {
            let root = find(&mut parent, i);
            let k = ids.len();
            *ids.entry(root).or_insert(k)
        })
        .collect()
}

/// Convex hull (monotone chain) of (lon, lat) points.
pub fn hull(mut pts: Vec<[f32; 2]>) -> Vec<[f32; 2]> {
    pts.retain(|p| p[0].is_finite() && p[1].is_finite());
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: [f32; 2], a: [f32; 2], b: [f32; 2]| (a[0] - o[0]) as f64 * (b[1] - o[1]) as f64 - (a[1] - o[1]) as f64 * (b[0] - o[0]) as f64;
    let mut lower: Vec<[f32; 2]> = vec![];
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<[f32; 2]> = vec![];
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Thin one model's detections of a volume: `dets` are (cell index, detection, score).
/// Returns the kept detections with `storm_cells` set (and the storm hull as the outline when a
/// multi-cell storm keeps a single detection).
pub fn thin(cells: &[Cell], comp: &[usize], mut dets: Vec<(usize, Detection, f64)>) -> Vec<Detection> {
    if dets.is_empty() {
        return vec![];
    }
    let mut members: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, c) in comp.iter().enumerate() {
        members.entry(*c).or_default().push(i);
    }
    dets.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<(usize, Detection)> = vec![];
    for (ci, d, _) in dets {
        let s = comp[ci];
        let mem = &members[&s];
        let area: f64 = mem.iter().map(|&k| cells[k].feats.get("area_km2") as f64).filter(|a| a.is_finite()).sum();
        // large storms keep a few (one per ~1000 km² of cells)
        let cap = (1 + (area / 1000.0) as usize).min(MAX_PER_STORM);
        let mine: Vec<&(usize, Detection)> = kept.iter().filter(|(k, _)| comp[*k] == s).collect();
        if mine.len() >= cap || mine.iter().any(|(_, o)| km((o.lat, o.lon), (d.lat, d.lon)) < KEEP_SPACING_KM) {
            continue;
        }
        kept.push((ci, d));
    }
    let mut per: HashMap<usize, usize> = HashMap::new();
    for (ci, _) in &kept {
        *per.entry(comp[*ci]).or_default() += 1;
    }
    kept.into_iter()
        .map(|(ci, mut d)| {
            let s = comp[ci];
            let mem = &members[&s];
            d.storm_cells = Some(mem.len() as u32);
            if mem.len() > 1 && per[&s] == 1 {
                let h = hull(mem.iter().flat_map(|&k| cells[k].hull.iter().copied()).collect());
                if h.len() >= 3 {
                    d.outline = h;
                }
            }
            d
        })
        .collect()
}

/// Cross-radar non-max suppression: per model, a detection within `radius_km` of a stronger one
/// (score = `score(d)`) is dropped.
pub fn nms(dets: Vec<Detection>, radius_km: f64, score: impl Fn(&Detection) -> f64) -> Vec<Detection> {
    let mut by: HashMap<String, Vec<(f64, Detection)>> = HashMap::new();
    let mut other = vec![];
    for d in dets {
        if d.kind == "cell" {
            by.entry(d.model_id.clone()).or_default().push((score(&d), d));
        } else {
            other.push(d);
        }
    }
    let mut out = other;
    for (_, mut v) in by {
        v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut kept: Vec<Detection> = vec![];
        for (_, d) in v {
            // same radar: already thinned per storm
            if kept.iter().any(|k| k.site != d.site && km((k.lat, k.lon), (d.lat, d.lon)) < radius_km) {
                continue;
            }
            kept.push(d);
        }
        out.extend(kept);
    }
    out
}

/// Ranking score of a detection for suppression: probability, else (tracks / values) the
/// predicted strength, else the cell's area.
pub fn rank(d: &Detection) -> f64 {
    if d.target == "storm_track" || d.prob >= 0.999 && d.value.is_some() {
        return d.value.unwrap_or(0.0) + d.storm_cells.unwrap_or(1) as f64 * 1e-3;
    }
    d.prob
}

#[derive(Debug, Clone)]
struct Track {
    id: String,
    lat: f64,
    lon: f64,
    t: i64,
    /// (toward deg, kt)
    motion: Option<(f64, f64)>,
    /// wall clock of the last match (forgetting does not depend on the data time)
    seen: i64,
}

/// Storm identity per model across cycles and radars.
#[derive(Debug, Default)]
pub struct StormReg {
    seq: u64,
    by_model: HashMap<String, Vec<Track>>,
}

/// Tracks unseen this long are forgotten.
pub const STORM_FORGET_MS: i64 = 45 * 60_000;

impl StormReg {
    fn predicted(t: &Track, at: i64) -> (f64, f64) {
        let Some((dir, kt)) = t.motion else { return (t.lat, t.lon) };
        let h = ((at - t.t) as f64 / 3_600_000.0).clamp(0.0, 1.0);
        let d = kt * 1.852 * h;
        let a = dir.to_radians();
        (t.lat + d * a.cos() / 110.57, t.lon + d * a.sin() / (111.32 * t.lat.to_radians().cos().max(0.2)))
    }

    /// Give each cell detection a storm id: the nearest storm of the same model (predicted to
    /// the detection's time) within reach, else a new storm.
    pub fn assign(&mut self, dets: &mut [Detection], now: i64) {
        for v in self.by_model.values_mut() {
            v.retain(|t| now - t.seen < STORM_FORGET_MS);
        }
        self.by_model.retain(|_, v| !v.is_empty());
        let mut models: Vec<String> = dets.iter().filter(|d| d.kind == "cell").map(|d| d.model_id.clone()).collect();
        models.sort();
        models.dedup();
        for m in models {
            let idx: Vec<usize> = (0..dets.len()).filter(|&i| dets[i].kind == "cell" && dets[i].model_id == m).collect();
            let tracks = self.by_model.entry(m.clone()).or_default();
            let mut pairs: Vec<(f64, usize, usize)> = vec![];
            for (a, &i) in idx.iter().enumerate() {
                let d = &dets[i];
                for (j, t) in tracks.iter().enumerate() {
                    let dt_min = ((d.t - t.t) as f64 / 60_000.0).abs();
                    let reach = (18.0 + 0.4 * dt_min).min(35.0);
                    let p = Self::predicted(t, d.t);
                    let dist = km(p, (d.lat, d.lon));
                    if dist <= reach {
                        pairs.push((dist, a, j));
                    }
                }
            }
            pairs.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut got: Vec<Option<usize>> = vec![None; idx.len()];
            let mut used = vec![false; tracks.len()];
            for (_, a, j) in pairs {
                if got[a].is_some() || used[j] {
                    continue;
                }
                got[a] = Some(j);
                used[j] = true;
            }
            for (a, &i) in idx.iter().enumerate() {
                let d = &mut dets[i];
                let motion = d.motion.as_ref().and_then(|m| Some((m.get("dir")?.as_f64()?, m.get("kt")?.as_f64()?)));
                match got[a] {
                    Some(j) => {
                        let t = &mut tracks[j];
                        t.seen = now;
                        // the newest data time wins (two radars of the same cycle)
                        if d.t >= t.t {
                            t.lat = d.lat;
                            t.lon = d.lon;
                            t.t = d.t;
                            t.motion = motion.or(t.motion);
                        }
                        d.storm_id = Some(t.id.clone());
                    }
                    None => {
                        self.seq += 1;
                        let id = format!("s{}-{}", super::model::radix36(now as u64 / 1000), self.seq);
                        tracks.push(Track { id: id.clone(), lat: d.lat, lon: d.lon, t: d.t, motion, seen: now });
                        d.storm_id = Some(id);
                    }
                }
            }
        }
    }

    pub fn forget(&mut self, model: &str) {
        self.by_model.remove(model);
    }

    pub fn len(&self) -> usize {
        self.by_model.values().map(|v| v.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ml::features::FeatMap;
    use crate::ml::runner::blank_detection;

    fn cell(id: &str, lat: f64, lon: f64, area: f32) -> Cell {
        let mut f = FeatMap::default();
        f.set("area_km2", area);
        let d = 0.05;
        Cell { id: id.into(), lat, lon, t: 0, feats: f, hull: vec![[(lon - d) as f32, (lat - d) as f32], [(lon + d) as f32, (lat - d) as f32], [(lon + d) as f32, (lat + d) as f32], [(lon - d) as f32, (lat + d) as f32]], motion: None }
    }
    fn det(model: &str, lat: f64, lon: f64, p: f64, site: &str) -> Detection {
        Detection { model_id: model.into(), target: "hail".into(), prob: p, lat, lon, site: Some(site.into()), kind: "cell", ..blank_detection() }
    }

    #[test]
    fn one_storm_few_detections() {
        // a large storm of 30 touching cells (a 0.1° grid) and a small separate one
        let mut cells = vec![];
        for i in 0..6 {
            for j in 0..5 {
                cells.push(cell(&format!("c{i}{j}"), 35.0 + i as f64 * 0.1, -97.0 + j as f64 * 0.1, 150.0));
            }
        }
        cells.push(cell("far", 38.0, -94.0, 30.0));
        let comp = cluster(&cells);
        assert!(comp[..30].iter().all(|c| *c == comp[0]), "the big storm is one component");
        assert_ne!(comp[30], comp[0]);
        let dets: Vec<(usize, Detection, f64)> = cells.iter().enumerate().map(|(i, c)| (i, det("m", c.lat, c.lon, 0.5 + i as f64 * 0.001, "KTLX"), 0.5 + i as f64 * 0.001)).collect();
        let kept = thin(&cells, &comp, dets);
        let big = kept.iter().filter(|d| d.lat < 37.0).count();
        assert!((1..=MAX_PER_STORM).contains(&big), "{big} kept for the large storm");
        assert_eq!(kept.iter().filter(|d| d.lat > 37.0).count(), 1);
        // the small storm keeps one detection, outlined by its own hull
        let small = kept.iter().find(|d| d.lat > 37.0).unwrap();
        assert_eq!(small.storm_cells, Some(1));
        // cross-radar duplicates
        let a = det("m", 35.0, -97.0, 0.9, "KTLX");
        let b = det("m", 35.02, -97.02, 0.7, "KINX");
        let c = det("other", 35.02, -97.02, 0.7, "KINX");
        let out = nms(vec![a, b, c], NMS_RADIUS_KM, rank);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn storm_ids_persist() {
        let mut r = StormReg::default();
        let mut d1 = vec![det("m", 35.0, -97.0, 0.9, "KTLX"), det("m", 36.0, -95.0, 0.6, "KTLX")];
        r.assign(&mut d1, 1_000_000);
        // next cycle: both storms moved ~5 km, seen by another radar too
        let mut d2 = vec![{ let mut d = det("m", 35.03, -96.97, 0.8, "KINX"); d.t = 300_000; d }, { let mut d = det("m", 36.02, -94.98, 0.7, "KTLX"); d.t = 300_000; d }];
        r.assign(&mut d2, 1_300_000);
        assert_eq!(d1[0].storm_id, d2[0].storm_id);
        assert_eq!(d1[1].storm_id, d2[1].storm_id);
        assert_ne!(d2[0].storm_id, d2[1].storm_id);
        assert_eq!(r.len(), 2);
    }
}
