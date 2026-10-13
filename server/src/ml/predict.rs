//! Grid inference for grid / outlook models: a regular lat/lon grid over the region, features
//! per lead (chunked so memory stays bounded), scoring in parallel, optional smoothing and
//! probability gating, then
//! * a prediction layer per model (`mlpred/<model_id>`, plus `/p10` … for quantile learners)
//!   published to the grid catalog through [`PredSink`] (the grid service), so the normal
//!   `/api/grid/frames|render|value` endpoints and the client legend work;
//! * area detections (polygons where the probability exceeds a threshold);
//! * SPC-style categorical outlooks (TSTM … HIGH polygons from probability contours).

use super::gridds::{self, LeadSpec, TParams};
use super::labels::Region;
use super::model::{Learner, ModelRecord};
use super::source::Fetch;
use super::spec::TrainSpec;
use crate::grid::{Grid, Proj};
use anyhow::{bail, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Where prediction layers go (the grid service in the server; tests inject their own).
pub trait PredSink: Send + Sync {
    /// Publish (replace) a layer. Values of `frames` are in the layer's units.
    #[allow(clippy::too_many_arguments)]
    fn publish(&self, id: &str, name: &str, units: &str, cmap: &str, step_min: u32, run_ms: i64, frames: Vec<Grid>);
    /// Remove a model's layers (`mlpred/<model_id>` and sub-layers).
    fn remove(&self, id: &str);
    /// Published layers: (id, run ms, valid times).
    fn layers(&self) -> Vec<(String, i64, Vec<i64>)>;
}

impl PredSink for crate::grid::service::GridService {
    fn publish(&self, id: &str, name: &str, units: &str, cmap: &str, step_min: u32, run_ms: i64, frames: Vec<Grid>) {
        self.put_pred_layer(id, name, "My models", units, cmap, step_min, run_ms, frames);
    }
    fn remove(&self, id: &str) {
        self.remove_pred_layers(id);
    }
    fn layers(&self) -> Vec<(String, i64, Vec<i64>)> {
        self.pred_layers()
    }
}

/// Options of one grid run.
#[derive(Debug, Clone, Default)]
pub struct PredictOpts {
    pub res_deg: Option<f64>,
    pub region: Option<Region>,
    pub smoothing_km: f64,
    pub leads: Option<Vec<f64>>,
    pub window: Option<(i64, i64)>,
    pub day: Option<String>,
    /// point budget (the grid is coarsened to fit)
    pub max_points: usize,
}

/// Output grid geometry (cell centres; row 0 = south).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GridGeom {
    pub w: f64,
    pub s: f64,
    pub res: f64,
    pub nx: usize,
    pub ny: usize,
}

impl GridGeom {
    pub fn new(b: [f64; 4], res: f64, max_points: usize) -> GridGeom {
        let mut res = res.clamp(0.02, 5.0);
        loop {
            let nx = (((b[2] - b[0]) / res).floor() as usize + 1).max(2);
            let ny = (((b[3] - b[1]) / res).floor() as usize + 1).max(2);
            if nx * ny <= max_points.max(100) || res >= 5.0 {
                return GridGeom { w: b[0], s: b[1], res, nx, ny };
            }
            res *= 1.25;
        }
    }
    pub fn point(&self, i: usize, j: usize) -> (f64, f64) {
        (self.s + j as f64 * self.res, self.w + i as f64 * self.res)
    }
    pub fn proj(&self) -> Proj {
        Proj::LatLon { lat0: self.s, lon0: self.w, dlat: self.res, dlon: self.res, nx: self.nx, global: false }
    }
}

#[derive(Debug, Clone)]
pub struct PredFrame {
    pub lead: LeadSpec,
    /// probability 0–1 (classification) or value (regression), NaN outside the region / no data
    pub values: Vec<f32>,
    /// quantile layers (q, values)
    pub quantiles: Vec<(f64, Vec<f32>)>,
}

#[derive(Debug, Clone)]
pub struct PredGrid {
    pub geom: GridGeom,
    pub issue: i64,
    pub frames: Vec<PredFrame>,
    /// feature sources that failed (partial inputs)
    pub warnings: Vec<String>,
}

/// The training spec of a model (with the model's own schema sources).
pub fn model_spec(m: &ModelRecord) -> TrainSpec {
    let mut s: TrainSpec = serde_json::from_value(m.spec.clone()).unwrap_or_default();
    s.sources = m.feature_schema.sources.normalized();
    s.target = m.target.clone();
    s.task = m.task.clone();
    s
}

/// Run a grid / outlook model over its region at issue time `t`.
pub async fn predict_grid(fetch: &dyn Fetch, m: &ModelRecord, o: &PredictOpts, t: i64, realtime: bool) -> Result<PredGrid> {
    let spec = model_spec(m);
    let mut tp = TParams::of(&spec);
    if let Some(d) = &o.day {
        tp.day = d.clone();
    }
    let leads = gridds::leads_for(&m.target, &tp, t, o.leads.as_deref(), o.window);
    if leads.is_empty() {
        bail!("no leads to run");
    }
    let region = o.region.clone().unwrap_or_else(|| spec.region.clone());
    let res = o.res_deg.unwrap_or(spec.grid.run_spacing_deg);
    let geom = GridGeom::new(region.bbox(), res, if o.max_points > 0 { o.max_points } else { 150_000 });
    let mut idx: Vec<usize> = vec![];
    let mut pts: Vec<(f64, f64)> = vec![];
    for j in 0..geom.ny {
        for i in 0..geom.nx {
            let (la, lo) = geom.point(i, j);
            if region.contains(la, lo, "") {
                idx.push(j * geom.nx + i);
                pts.push((la, lo));
            }
        }
    }
    if pts.is_empty() {
        bail!("the region has no grid points");
    }
    let n = geom.nx * geom.ny;
    let ids = m.ids();
    let mut frames: Vec<PredFrame> = leads.iter().map(|l| PredFrame { lead: *l, values: vec![f32::NAN; n], quantiles: m.quantiles.iter().map(|q| (q.q, vec![f32::NAN; n])).collect() }).collect();
    let mut warnings = vec![];
    const CHUNK: usize = 20_000;
    for (ci, chunk) in pts.chunks(CHUNK).enumerate() {
        let off = ci * CHUNK;
        let ana = match gridds::analysis(fetch, &spec, t, chunk, realtime, None).await {
            Ok(a) => a,
            Err(e) => {
                warnings.push(format!("analysis: {e:#}"));
                vec![super::features::FeatMap::default(); chunk.len()]
            }
        };
        for (li, l) in leads.iter().enumerate() {
            let fms = gridds::features(fetch, &spec, &tp, t, l, chunk, realtime, Some(&ana), None).await?;
            let xs: Vec<Vec<f32>> = fms.iter().map(|f| f.vector(&ids)).collect();
            drop(fms);
            let mm = m.clone();
            let scored: Vec<(f32, Vec<f32>)> = tokio::task::spawn_blocking(move || {
                xs.par_iter()
                    .map(|x| {
                        let p = mm.prob(x) as f32;
                        let q: Vec<f32> = mm.quantiles.iter().map(|q| q.learner.margin(x) as f32).collect();
                        (p, q)
                    })
                    .collect()
            })
            .await?;
            for (k, (p, q)) in scored.into_iter().enumerate() {
                let cell = idx[off + k];
                frames[li].values[cell] = p;
                for (qi, v) in q.into_iter().enumerate() {
                    frames[li].quantiles[qi].1[cell] = v;
                }
            }
        }
    }
    if o.smoothing_km > 0.0 {
        let k = o.smoothing_km / (geom.res * 111.0);
        let passes = (k * k).round().clamp(1.0, 12.0) as usize;
        for f in frames.iter_mut() {
            crate::grid::contour::smooth(&mut f.values, geom.nx, geom.ny, passes);
            for q in f.quantiles.iter_mut() {
                crate::grid::contour::smooth(&mut q.1, geom.nx, geom.ny, passes);
            }
        }
    }
    Ok(PredGrid { geom, issue: t, frames, warnings })
}

/// Hide values outside [lo, hi] (probability gate) in place.
pub fn gate(values: &mut [f32], lo: f64, hi: f64) {
    for v in values.iter_mut() {
        if v.is_finite() && ((*v as f64) < lo || (*v as f64) > hi) {
            *v = f32::NAN;
        }
    }
}

/// A frame as a grid in display units (probabilities → %).
pub fn to_grid(geom: &GridGeom, values: &[f32], pct: bool, valid: i64, issue: i64) -> Grid {
    let v: Vec<f32> = if pct { values.iter().map(|x| x * 100.0).collect() } else { values.to_vec() };
    Grid::from_values(geom.nx, geom.ny, geom.proj(), &v, valid, issue)
}

/// Polygons (outer ring + holes, lon/lat) of the region where `z ≥ level`.
pub fn polygons(geom: &GridGeom, z: &[f32], level: f32) -> Vec<Vec<Vec<[f64; 2]>>> {
    let (nx, ny) = (geom.nx + 2, geom.ny + 2);
    let low = level - 1e6;
    let mut pad = vec![low; nx * ny];
    for j in 0..geom.ny {
        for i in 0..geom.nx {
            let v = z[j * geom.nx + i];
            pad[(j + 1) * nx + i + 1] = if v.is_finite() { v } else { low };
        }
    }
    let lines = crate::grid::contour::isolines(&pad, nx, ny, level);
    let rings: Vec<Vec<[f64; 2]>> = lines
        .into_iter()
        .filter(|l| l.len() >= 4)
        .map(|l| {
            let l = crate::grid::contour::simplify(&l, 0.3);
            let mut r: Vec<[f64; 2]> = l.iter().map(|p| [round4(geom.w + (p.0 as f64 - 1.0) * geom.res), round4(geom.s + (p.1 as f64 - 1.0) * geom.res)]).collect();
            if r.first() != r.last() {
                r.push(r[0]);
            }
            r
        })
        .filter(|r| r.len() >= 4)
        .collect();
    // nesting: rings inside an even number of others are outer boundaries
    let inside = |p: [f64; 2], r: &[[f64; 2]]| {
        let poly: Vec<[f32; 2]> = r.iter().map(|q| [q[0] as f32, q[1] as f32]).collect();
        super::labels::point_in_poly(p[1], p[0], &poly)
    };
    let area = |r: &[[f64; 2]]| r.windows(2).map(|w| w[0][0] * w[1][1] - w[1][0] * w[0][1]).sum::<f64>().abs() / 2.0;
    let depth: Vec<usize> = (0..rings.len()).map(|i| (0..rings.len()).filter(|&k| k != i && inside(rings[i][0], &rings[k])).count()).collect();
    let mut polys: Vec<(usize, Vec<Vec<[f64; 2]>>)> = vec![];
    for i in 0..rings.len() {
        if depth[i] % 2 == 0 {
            polys.push((i, vec![rings[i].clone()]));
        }
    }
    for i in 0..rings.len() {
        if depth[i] % 2 == 1 {
            // the smallest outer ring containing this hole
            let host = polys.iter_mut().filter(|(o, _)| inside(rings[i][0], &rings[*o])).min_by(|a, b| area(&rings[a.0]).partial_cmp(&area(&rings[b.0])).unwrap_or(std::cmp::Ordering::Equal));
            if let Some((_, p)) = host {
                p.push(rings[i].clone());
            }
        }
    }
    polys.into_iter().map(|p| p.1).collect()
}

fn round4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

/// Area of a polygon's outer ring (km²).
pub fn ring_area_km2(r: &[[f64; 2]]) -> f64 {
    let lat0 = r.iter().map(|p| p[1]).sum::<f64>() / r.len().max(1) as f64;
    let kx = 111.32 * lat0.to_radians().cos();
    let a: f64 = r.windows(2).map(|w| (w[0][0] * kx) * (w[1][1] * 110.57) - (w[1][0] * kx) * (w[0][1] * 110.57)).sum();
    a.abs() / 2.0
}

/// Max of `z` over the cells inside a polygon's outer ring.
pub fn max_inside(geom: &GridGeom, z: &[f32], ring: &[[f64; 2]]) -> f32 {
    let poly: Vec<[f32; 2]> = ring.iter().map(|p| [p[0] as f32, p[1] as f32]).collect();
    let (mut w, mut s, mut e, mut n) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in ring {
        w = w.min(p[0]);
        e = e.max(p[0]);
        s = s.min(p[1]);
        n = n.max(p[1]);
    }
    let i0 = (((w - geom.w) / geom.res).floor().max(0.0)) as usize;
    let i1 = (((e - geom.w) / geom.res).ceil() as usize).min(geom.nx - 1);
    let j0 = (((s - geom.s) / geom.res).floor().max(0.0)) as usize;
    let j1 = (((n - geom.s) / geom.res).ceil() as usize).min(geom.ny - 1);
    let mut best = f32::NAN;
    for j in j0..=j1 {
        for i in i0..=i1 {
            let (la, lo) = geom.point(i, j);
            let v = z[j * geom.nx + i];
            if v.is_finite() && super::labels::point_in_poly(la, lo, &poly) {
                best = best.max(v);
            }
        }
    }
    best
}

/// Outlook categories: id, label, fill colour (SPC convective outlook palette).
pub const OUTLOOK_CATS: &[(&str, &str, &str)] = &[
    ("TSTM", "General thunderstorms", "#C1E9C1"),
    ("MRGL", "Marginal", "#66A366"),
    ("SLGT", "Slight", "#FFE066"),
    ("ENH", "Enhanced", "#FFA366"),
    ("MDT", "Moderate", "#E06666"),
    ("HIGH", "High", "#EE99EE"),
];

/// SPC probabilistic contour colours.
pub fn prob_color(p: f64) -> &'static str {
    match (p * 100.0).round() as i64 {
        ..=2 => "#008B00",
        3..=5 => "#8B4726",
        6..=10 => "#FFC800",
        11..=15 => "#FF0000",
        16..=30 => "#FF00FF",
        31..=45 => "#912CEE",
        _ => "#104E8B",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutlookLevel {
    /// probability 0–1
    pub prob: f64,
    pub cat: String,
}

/// Default probability → category mapping per hazard (TSTM at 2% is a proxy: there is no
/// separate thunder model).
pub fn default_levels(hazard: &str) -> Vec<OutlookLevel> {
    let l = |p: f64, c: &str| OutlookLevel { prob: p, cat: c.into() };
    match hazard {
        "tornado" => vec![l(0.02, "MRGL"), l(0.05, "SLGT"), l(0.10, "ENH"), l(0.15, "ENH"), l(0.30, "MDT"), l(0.45, "HIGH")],
        "wind" | "hail" => vec![l(0.02, "TSTM"), l(0.05, "MRGL"), l(0.15, "SLGT"), l(0.30, "ENH"), l(0.45, "ENH"), l(0.60, "MDT")],
        _ => vec![l(0.02, "TSTM"), l(0.05, "MRGL"), l(0.15, "SLGT"), l(0.30, "ENH"), l(0.45, "MDT"), l(0.60, "HIGH")],
    }
}

/// Category of a probability (highest level reached).
pub fn categorize(p: f64, levels: &[OutlookLevel]) -> Option<&str> {
    levels.iter().filter(|l| p >= l.prob).max_by(|a, b| a.prob.partial_cmp(&b.prob).unwrap_or(std::cmp::Ordering::Equal)).map(|l| l.cat.as_str())
}

/// Categorical outlook GeoJSON from a probability frame (values 0–1). Features are ordered by
/// probability (draw in order); each is a (Multi)Polygon of the area ≥ its probability.
#[allow(clippy::too_many_arguments)]
pub fn outlook_geojson(geom: &GridGeom, z: &[f32], levels: &[OutlookLevel], hazard: &str, day: &str, valid_from: i64, valid_to: i64, model_id: &str) -> Value {
    let mut feats = vec![];
    let mut lv = levels.to_vec();
    lv.sort_by(|a, b| a.prob.partial_cmp(&b.prob).unwrap_or(std::cmp::Ordering::Equal));
    for l in &lv {
        let polys = polygons(geom, z, l.prob as f32);
        if polys.is_empty() {
            continue;
        }
        let (label, color) = OUTLOOK_CATS.iter().find(|c| c.0 == l.cat).map(|c| (c.1, c.2)).unwrap_or((l.cat.as_str(), "#999999"));
        let pmax = polys.iter().map(|p| max_inside(geom, z, &p[0])).fold(f32::NAN, f32::max);
        feats.push(json!({
            "type": "Feature",
            "geometry": {"type": "MultiPolygon", "coordinates": polys},
            "properties": {"cat": l.cat, "label": label, "prob": l.prob, "max_prob": if pmax.is_finite() { json!((pmax as f64 * 1000.0).round() / 1000.0) } else { Value::Null }, "hazard": hazard, "day": day, "valid_from": valid_from, "valid_to": valid_to, "color": color, "prob_color": prob_color(l.prob), "model_id": model_id},
        }));
    }
    json!({"type": "FeatureCollection", "features": feats})
}

/// The learner type name (for logs).
pub fn learner_name(l: &Learner) -> &'static str {
    match l {
        Learner::Gbdt(_) => "gbdt",
        Learner::Logreg(_) => "logreg",
        Learner::Mlp(_) => "mlp",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outlook_contours_and_categories() {
        // a circular probability bump: 0.5 at the centre, falling off
        let geom = GridGeom::new([-100.0, 30.0, -90.0, 40.0], 0.25, 100_000);
        let (cla, clo) = (35.0, -95.0);
        let z: Vec<f32> = (0..geom.ny)
            .flat_map(|j| (0..geom.nx).map(move |i| (i, j)))
            .map(|(i, j)| {
                let (la, lo) = geom.point(i, j);
                let d = ((la - cla).powi(2) + (lo - clo).powi(2)).sqrt();
                (0.5 * (-d * d / 4.0).exp()) as f32
            })
            .collect();
        let lv = default_levels("any");
        assert_eq!(categorize(0.5, &lv), Some("MDT"));
        assert_eq!(categorize(0.16, &lv), Some("SLGT"));
        assert_eq!(categorize(0.01, &lv), None);
        assert_eq!(categorize(0.12, &default_levels("tornado")), Some("ENH"));
        let gj = outlook_geojson(&geom, &z, &lv, "any", "1", 1, 2, "m1");
        let f = gj["features"].as_array().unwrap();
        let cats: Vec<&str> = f.iter().map(|x| x["properties"]["cat"].as_str().unwrap()).collect();
        assert_eq!(cats, vec!["TSTM", "MRGL", "SLGT", "ENH", "MDT"]);
        // nested: the MDT polygon is inside the SLGT one and smaller
        let ring = |k: usize| f[k]["geometry"]["coordinates"][0][0].as_array().unwrap().iter().map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()]).collect::<Vec<_>>();
        let (slgt, mdt) = (ring(2), ring(4));
        assert!(ring_area_km2(&mdt) < ring_area_km2(&slgt));
        // a 0.45 contour of this bump has radius sqrt(4 ln(0.5/0.45)) ≈ 0.65°
        let r = (4.0f64 * (0.5f64 / 0.45).ln()).sqrt();
        let expect = std::f64::consts::PI * (r * 111.0) * (r * 111.0 * 35f64.to_radians().cos());
        let got = ring_area_km2(&mdt);
        assert!((got / expect - 1.0).abs() < 0.25, "{got} vs {expect}");
        assert_eq!(f[4]["properties"]["color"], "#E06666");
        assert!(f[4]["properties"]["max_prob"].as_f64().unwrap() > 0.45);
        // a ring of high values around a low centre makes a hole
        let z2: Vec<f32> = (0..geom.ny)
            .flat_map(|j| (0..geom.nx).map(move |i| (i, j)))
            .map(|(i, j)| {
                let (la, lo) = geom.point(i, j);
                let d = ((la - cla).powi(2) + (lo - clo).powi(2)).sqrt();
                if (1.0..3.0).contains(&d) { 0.4 } else { 0.0 }
            })
            .collect();
        let p = polygons(&geom, &z2, 0.2);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].len(), 2, "outer ring + hole");
        let mut g = z.clone();
        gate(&mut g, 0.1, 0.4);
        assert!(g.iter().all(|v| !v.is_finite() || (0.1..=0.4).contains(&(*v as f64))));
    }
}
