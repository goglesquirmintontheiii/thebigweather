//! Ensemble probability / statistics maps from GEFS (31 members, 0.5°) and ECMWF open-data
//! ENS (51 members, 0.25°).
//!
//! Layers `ens/<model>/<var>/<op>`: op = `prob` (P(value ≥ thr), %), `proble` (P(value ≤ thr),
//! 2 m temperature only), `mean`, `spread` (standard deviation), `min`, `max`. Probability layers
//! take `thr` (catalog `params.thr`: units + presets); frame keys carry it:
//! `ens|<model>|<run>|<fh>|<var>|<op>|<thr>`.
//!
//! Members are streamed (fetched and decoded a few at a time) into per-cell accumulators:
//! count, sum, sum of squares, min, max and exceedance counts for every preset threshold plus the
//! requested one, so one pass fills every op; other thresholds stream again (the raw GRIB ranges
//! are disk-cached).
//!
//! Variables (internal units for mean/spread/min/max; thresholds in the user units):
//! * `apcpN` (N = 6, 12, 24, 48, 72): precipitation over the N hours ending at the frame, mm
//!   (thr in inches). GEFS: APCP buckets tiled from the members' idx (6-h or run-total buckets,
//!   differences when needed); ECMWF: tp(t) − tp(t − N).
//! * `snowN` (N = 24, 48, 72): snowfall, cm (thr in inches), 10:1 ratio. GEFS: positive change of
//!   the water equivalent of snow on the ground (WEASD, mm → cm); underestimates while snow
//!   melts. ECMWF: sf(t) − sf(t − N) (m water equivalent → cm of snow).
//! * `wind10`: 10 m wind speed m/s (thr mph); `gust` (ECMWF 10fg, the max gust of the preceding
//!   period) m/s (thr mph).
//! * `t2m`: 2 m temperature °C (thr °F).

use super::decode::{self, DecodeOpts};
use super::service::GridService;
use super::sources::{self, LayerDef};
use super::{Grid, Proj};
use anyhow::{anyhow, bail, Result};
use serde_json::json;
use std::sync::Arc;

pub struct EnsModel {
    pub id: &'static str,
    pub name: &'static str,
    /// hidden ModelDef used for run listing and file names
    pub def: &'static str,
    pub members: usize,
}

pub const MODELS: &[EnsModel] = &[
    EnsModel { id: "gefs", name: "GEFS", def: "gefsens", members: 31 },
    EnsModel { id: "ecmwf", name: "ECMWF ENS", def: "ecmwfens", members: 51 },
];

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Precip(u32),
    Snow(u32),
    Wind10,
    Gust,
    T2m,
}

pub struct EnsVar {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    pub units: &'static str,
    pub cmap: &'static str,
    pub thr_units: &'static str,
    pub presets: &'static [f64],
    pub default: f64,
}

const P_IN: &[f64] = &[0.01, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 4.0];
const S_IN: &[f64] = &[1.0, 2.0, 4.0, 6.0, 8.0, 12.0, 18.0, 24.0];
const W_MPH: &[f64] = &[20.0, 30.0, 40.0, 50.0, 58.0, 70.0, 80.0];
const T_F: &[f64] = &[0.0, 10.0, 20.0, 32.0, 50.0, 70.0, 80.0, 90.0, 100.0];

pub const VARS: &[EnsVar] = &[
    EnsVar { id: "apcp6", name: "6-hr Precipitation", kind: Kind::Precip(6), units: "mm", cmap: "PRECIPMM", thr_units: "in", presets: P_IN, default: 0.5 },
    EnsVar { id: "apcp12", name: "12-hr Precipitation", kind: Kind::Precip(12), units: "mm", cmap: "PRECIPMM", thr_units: "in", presets: P_IN, default: 1.0 },
    EnsVar { id: "apcp24", name: "24-hr Precipitation", kind: Kind::Precip(24), units: "mm", cmap: "PRECIPMM", thr_units: "in", presets: P_IN, default: 1.0 },
    EnsVar { id: "apcp48", name: "48-hr Precipitation", kind: Kind::Precip(48), units: "mm", cmap: "PRECIPMM", thr_units: "in", presets: P_IN, default: 1.0 },
    EnsVar { id: "apcp72", name: "72-hr Precipitation", kind: Kind::Precip(72), units: "mm", cmap: "PRECIPMM", thr_units: "in", presets: P_IN, default: 2.0 },
    EnsVar { id: "snow24", name: "24-hr Snowfall (10:1)", kind: Kind::Snow(24), units: "cm", cmap: "SNOWCM", thr_units: "in", presets: S_IN, default: 4.0 },
    EnsVar { id: "snow48", name: "48-hr Snowfall (10:1)", kind: Kind::Snow(48), units: "cm", cmap: "SNOWCM", thr_units: "in", presets: S_IN, default: 6.0 },
    EnsVar { id: "snow72", name: "72-hr Snowfall (10:1)", kind: Kind::Snow(72), units: "cm", cmap: "SNOWCM", thr_units: "in", presets: S_IN, default: 6.0 },
    EnsVar { id: "wind10", name: "10 m Wind Speed", kind: Kind::Wind10, units: "m/s", cmap: "WIND", thr_units: "mph", presets: W_MPH, default: 30.0 },
    EnsVar { id: "gust", name: "Wind Gust", kind: Kind::Gust, units: "m/s", cmap: "WIND", thr_units: "mph", presets: W_MPH, default: 40.0 },
    EnsVar { id: "t2m", name: "2 m Temperature", kind: Kind::T2m, units: "°C", cmap: "TEMP", thr_units: "°F", presets: T_F, default: 32.0 },
];

pub const OPS: &[&str] = &["prob", "proble", "mean", "spread", "min", "max"];

pub fn var(id: &str) -> Option<&'static EnsVar> {
    VARS.iter().find(|v| v.id == id)
}

pub fn model(id: &str) -> Option<&'static EnsModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// Variables a model offers.
pub fn model_vars(m: &str) -> Vec<&'static EnsVar> {
    VARS.iter().filter(|v| !(m == "gefs" && v.kind == Kind::Gust)).collect()
}

/// Ops a variable offers.
pub fn var_ops(v: &EnsVar) -> Vec<&'static str> {
    OPS.iter().copied().filter(|o| *o != "proble" || v.kind == Kind::T2m).collect()
}

/// Threshold in the user units → internal units.
pub fn thr_internal(v: &EnsVar, thr: f64) -> f32 {
    (match v.kind {
        Kind::Precip(_) => thr * 25.4,
        Kind::Snow(_) => thr * 2.54,
        Kind::Wind10 | Kind::Gust => thr * 0.44704,
        Kind::T2m => (thr - 32.0) / 1.8,
    }) as f32
}

/// Canonical threshold text for keys ("0.25", "1", "-10").
pub fn fmt_thr(t: f64) -> String {
    let r = (t * 1000.0).round() / 1000.0;
    if r == 0.0 { "0".into() } else { format!("{r}") }
}

pub fn layers() -> Vec<LayerDef> {
    let mut out = vec![];
    for m in MODELS {
        for v in model_vars(m.id) {
            for op in var_ops(v) {
                let prob = op.starts_with("prob");
                let (name, units, cmap): (String, &'static str, &'static str) = match op {
                    "prob" => (format!("{} · P({} ≥ thr)", m.name, v.name), "%", "PROB"),
                    "proble" => (format!("{} · P({} ≤ thr)", m.name, v.name), "%", "PROB"),
                    "mean" => (format!("{} · {} (mean)", m.name, v.name), v.units, v.cmap),
                    "spread" => (format!("{} · {} (spread)", m.name, v.name), v.units, if v.kind == Kind::T2m { "SPREAD" } else { v.cmap }),
                    "min" => (format!("{} · {} (member min)", m.name, v.name), v.units, v.cmap),
                    _ => (format!("{} · {} (member max)", m.name, v.name), v.units, v.cmap),
                };
                out.push(LayerDef {
                    id: format!("ens/{}/{}/{op}", m.id, v.id),
                    group: "Ensembles".into(),
                    name,
                    units,
                    cmap,
                    product: format!("{}|{op}", v.id),
                    source: "ens",
                    model: Some(m.id.into()),
                    step_min: 360,
                    params: prob.then(|| json!({"thr": {"units": v.thr_units, "presets": v.presets, "default": v.default}})),
                    contour: prob.then(|| json!({"interval": 10, "base": 0})),
                    ..Default::default()
                });
            }
        }
    }
    out
}

/// Forecast hours offered as frames: every 6 h, at least the accumulation window.
pub fn frame_fhs(v: &EnsVar, fhs: &[u32]) -> Vec<u32> {
    let w = match v.kind {
        Kind::Precip(w) | Kind::Snow(w) => w,
        _ => 6,
    };
    fhs.iter().copied().filter(|&f| f % 6 == 0 && f >= w).collect()
}

// ---------- GEFS precipitation bucket tiling ----------

/// "a-b hour acc fcst" / "a-b day acc fcst" → (a, b) hours.
pub fn acc_range(field: &str) -> Option<(u32, u32)> {
    let (rng, rest) = field.split_once(' ')?;
    let (a, b) = rng.split_once('-')?;
    let (a, b): (u32, u32) = (a.parse().ok()?, b.parse().ok()?);
    if rest.starts_with("hour acc") {
        Some((a, b))
    } else if rest.starts_with("day acc") {
        Some((a * 24, b * 24))
    } else {
        None
    }
}

/// Terms (file forecast hour, bucket start, bucket end, sign) summing to the precipitation over
/// [s, e], from the buckets each file holds (`buckets(fh)` → the (start, end) ranges in file fh).
pub fn tile(s: u32, e: u32, buckets: impl Fn(u32) -> Vec<(u32, u32)>) -> Option<Vec<(u32, u32, u32, i32)>> {
    let mut t = e;
    let mut out = vec![];
    let mut guard = 0;
    while t > s {
        guard += 1;
        if guard > 200 {
            return None;
        }
        let here: Vec<(u32, u32)> = buckets(t).into_iter().filter(|b| b.1 == t && b.0 < b.1).collect();
        if let Some(b) = here.iter().filter(|b| b.0 >= s).min_by_key(|b| b.0) {
            out.push((t, b.0, b.1, 1));
            t = b.0;
            continue;
        }
        // a bucket reaching back past s: subtract the same-start bucket ending at s
        let sub = here.iter().find_map(|b| buckets(s).into_iter().find(|c| c.0 == b.0 && c.1 == s).map(|c| (*b, c)));
        let (b, c) = sub?;
        out.push((t, b.0, b.1, 1));
        out.push((s, c.0, c.1, -1));
        t = s;
    }
    Some(out)
}

// ---------- accumulation ----------

/// Per-cell running statistics over members.
pub struct Acc {
    pub n: Vec<u8>,
    pub sum: Vec<f32>,
    pub sumsq: Vec<f32>,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
    /// thresholds (internal units) and exceedance counts (value ≥ thr)
    pub thr: Vec<f32>,
    pub ge: Vec<Vec<u8>>,
}

impl Acc {
    pub fn new(cells: usize, thr: Vec<f32>) -> Acc {
        let ge = thr.iter().map(|_| vec![0u8; cells]).collect();
        Acc { n: vec![0; cells], sum: vec![0.0; cells], sumsq: vec![0.0; cells], min: vec![f32::INFINITY; cells], max: vec![f32::NEG_INFINITY; cells], thr, ge }
    }
    pub fn add(&mut self, vals: &[f32]) {
        for (i, &v) in vals.iter().enumerate().take(self.n.len()) {
            if !v.is_finite() {
                continue;
            }
            self.n[i] = self.n[i].saturating_add(1);
            self.sum[i] += v;
            self.sumsq[i] += v * v;
            self.min[i] = self.min[i].min(v);
            self.max[i] = self.max[i].max(v);
            for (k, t) in self.thr.iter().enumerate() {
                if v >= *t {
                    self.ge[k][i] += 1;
                }
            }
        }
    }
    /// Values of one op (`thr_idx` for prob ops).
    pub fn op(&self, op: &str, thr_idx: usize) -> Vec<f32> {
        (0..self.n.len())
            .map(|i| {
                let n = self.n[i] as f32;
                if n == 0.0 {
                    return f32::NAN;
                }
                match op {
                    "prob" => 100.0 * self.ge[thr_idx][i] as f32 / n,
                    "proble" => 100.0 * (n - self.ge[thr_idx][i] as f32) / n,
                    "mean" => self.sum[i] / n,
                    "spread" => (self.sumsq[i] / n - (self.sum[i] / n).powi(2)).max(0.0).sqrt(),
                    "min" => self.min[i],
                    _ => self.max[i],
                }
            })
            .collect()
    }
}

/// ECMWF .index: (offset, length) per member (control = 0) for one param.
pub fn ecmwf_members(index: &str, param: &str) -> Vec<(usize, u64, u64)> {
    let mut out: Vec<(usize, u64, u64)> = vec![];
    for l in index.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
        if v["param"].as_str() != Some(param) || v["levtype"].as_str().map(|s| s != "sfc").unwrap_or(false) {
            continue;
        }
        let num = match v["type"].as_str() {
            Some("cf") => 0,
            _ => match v["number"].as_str().and_then(|s| s.parse::<usize>().ok()).or(v["number"].as_u64().map(|x| x as usize)) {
                Some(n) => n,
                None => continue,
            },
        };
        let (Some(o), Some(n)) = (v["_offset"].as_u64(), v["_length"].as_u64()) else { continue };
        if !out.iter().any(|x| x.0 == num) {
            out.push((num, o, n));
        }
    }
    out.sort_by_key(|x| x.0);
    out
}

fn gefs_member(k: usize) -> String {
    if k == 0 { "gec00".into() } else { format!("gep{k:02}") }
}

/// One GRIB selection: (file url, byte range).
type Pick = (String, (u64, Option<u64>));

impl GridService {
    /// Frames of an ensemble layer (newest run with frames; or `run`).
    pub(super) async fn ens_frames(&self, l: &LayerDef, run: Option<&str>, thr: Option<f64>) -> Result<super::service::FramesResp> {
        use super::service::{FrameInfo, FramesResp, RunInfo};
        let m = model(l.model.as_deref().unwrap_or("")).ok_or_else(|| anyhow!("unknown ensemble"))?;
        let (vid, op) = l.product.split_once('|').ok_or_else(|| anyhow!("bad layer"))?;
        let v = var(vid).ok_or_else(|| anyhow!("unknown variable"))?;
        let def = sources::model_def(m.def).ok_or_else(|| anyhow!("no model def"))?;
        let runs = self.runs_for(def, def.cycles, 3).await?;
        let chosen = match run {
            Some(r) => runs.iter().find(|x| x.0 == r).cloned(),
            None => runs.iter().find(|x| frame_fhs(v, &x.2).len() >= 2).cloned().or_else(|| runs.first().cloned()),
        }
        .ok_or_else(|| anyhow!("run not available"))?;
        let t = if op.starts_with("prob") { fmt_thr(thr.unwrap_or(v.default)) } else { String::new() };
        let frames = frame_fhs(v, &chosen.2)
            .into_iter()
            .map(|fh| FrameInfo { key: format!("ens|{}|{}|{fh}|{}|{op}|{t}", m.id, chosen.0, v.id), time: chosen.1 + fh as i64 * 3_600_000, label: format!("F{fh:03}") })
            .collect();
        Ok(FramesResp { frames, runs: runs.iter().map(|r| RunInfo { id: r.0.clone(), time: r.1, fhs: frame_fhs(v, &r.2) }).collect(), run: Some(chosen.0.clone()), ..Default::default() })
    }

    /// Compute an ensemble frame: every op (+ preset thresholds and `thr`) in one pass; the
    /// siblings go straight into the grid cache, the requested one is returned.
    pub(super) async fn ens_load(&self, parts: &[&str]) -> Result<Grid> {
        let (mid, run, fh, vid, op, thr_s) = (parts[1], parts[2], parts[3].parse::<u32>()?, parts[4], parts[5], parts[6]);
        let m = model(mid).ok_or_else(|| anyhow!("unknown ensemble"))?;
        let v = var(vid).ok_or_else(|| anyhow!("unknown variable"))?;
        if !OPS.contains(&op) || run.len() != 10 || !model_vars(mid).iter().any(|x| x.id == vid) {
            bail!("bad ensemble key");
        }
        let thr_user: Option<f64> = if op.starts_with("prob") { Some(thr_s.parse().map_err(|_| anyhow!("bad thr"))?) } else { None };
        let mut thr_list: Vec<f64> = v.presets.to_vec();
        if let Some(t) = thr_user {
            if !thr_list.iter().any(|x| fmt_thr(*x) == fmt_thr(t)) {
                thr_list.push(t);
            }
        }
        let thr_int: Vec<f32> = thr_list.iter().map(|t| thr_internal(v, *t)).collect();
        let (d, hh) = (&run[..8], run[8..].parse::<u32>()?);
        let run_ms = super::service::run_time_ms_pub(d, hh)?;
        let valid = run_ms + fh as i64 * 3_600_000;
        // what to fetch per member
        let plan = self.ens_plan(m, v, d, hh, fh).await?;
        let members: Vec<usize> = (0..m.members).collect();
        let mut acc: Option<Acc> = None;
        let mut proj: Option<(usize, usize, Proj)> = None;
        let (mut ok, mut failed) = (0usize, 0usize);
        let mut last_err = None;
        let kind = v.kind;
        for chunk in members.chunks(3) {
            let mut futs = vec![];
            for &k in chunk {
                futs.push(Box::pin(self.ens_member(m, &plan, k, kind)));
            }
            for r in futures::future::join_all(futs).await {
                match r {
                    Ok((nx, ny, p, vals)) => {
                        if let Some((px, py, _)) = &proj {
                            if *px != nx || *py != ny {
                                failed += 1;
                                continue;
                            }
                        } else {
                            proj = Some((nx, ny, p));
                        }
                        acc.get_or_insert_with(|| Acc::new(nx * ny, thr_int.clone())).add(&vals);
                        ok += 1;
                    }
                    Err(e) => {
                        failed += 1;
                        last_err = Some(e);
                    }
                }
            }
        }
        if ok == 0 || failed > ok {
            return Err(last_err.unwrap_or_else(|| anyhow!("no ensemble members")).context(format!("{} {} members unavailable ({failed} failed)", m.name, v.name)));
        }
        let acc = acc.ok_or_else(|| anyhow!("no members"))?;
        let (nx, ny, p) = proj.ok_or_else(|| anyhow!("no members"))?;
        let ops = var_ops(v);
        let base = format!("ens|{mid}|{run}|{fh}|{vid}");
        let built = self
            .run_blocking(move || {
                let mut out: Vec<(String, Grid)> = vec![];
                for o in ops {
                    if o.starts_with("prob") {
                        for (k, t) in thr_list.iter().enumerate() {
                            out.push((format!("{base}|{o}|{}", fmt_thr(*t)), Grid::from_values(nx, ny, p.clone(), &acc.op(o, k), valid, run_ms)));
                        }
                    } else {
                        out.push((format!("{base}|{o}|"), Grid::from_values(nx, ny, p.clone(), &acc.op(o, 0), valid, run_ms)));
                    }
                }
                Ok(out)
            })
            .await?;
        let want = format!("ens|{mid}|{run}|{fh}|{vid}|{op}|{}", thr_user.map(fmt_thr).unwrap_or_default());
        let mut res = None;
        for (k, g) in built {
            if k == want {
                res = Some(g);
            } else {
                self.cache_grid(k, Arc::new(g));
            }
        }
        self.health.ok("grid-ens", "Ensembles (GEFS / ECMWF ENS)", format!("{} {} F{fh:03}: {ok} members", m.name, v.name));
        res.ok_or_else(|| anyhow!("ensemble op not built"))
    }

    /// Per-member terms: list of (selector per member, sign). Selectors are resolved per member
    /// (GEFS: each member has its own idx).
    async fn ens_plan(&self, m: &EnsModel, v: &EnsVar, d: &str, hh: u32, fh: u32) -> Result<Vec<(u32, String, i32)>> {
        // (file fh, field selector, sign); selectors: GEFS "VAR:level" or "APCP:a-b", ECMWF param
        Ok(match (m.id, v.kind) {
            ("gefs", Kind::Precip(w)) => {
                let s = fh.checked_sub(w).ok_or_else(|| anyhow!("forecast hour before the window"))?;
                // bucket layout from the control member's idx files
                let def = sources::model_def(m.def).ok_or_else(|| anyhow!("no def"))?;
                let mut lay: std::collections::HashMap<u32, Vec<(u32, u32)>> = std::collections::HashMap::new();
                let need: Vec<u32> = (s..=fh).filter(|f| *f > 0 && f % 3 == 0).collect();
                for f in need {
                    let url = crate::s3::object_url(def.bucket, &sources::fill_template(def.file, d, hh, f, "").replace("{mem}", "gec00"));
                    if let Ok(idx) = self.text_cached(&format!("{url}.idx"), 3600).await {
                        let b: Vec<(u32, u32)> = sources::parse_ncep_idx(&idx).iter().filter(|r| r.2.len() >= 6 && r.2[3] == "APCP" && r.2[4] == "surface").filter_map(|r| acc_range(&r.2[5])).collect();
                        lay.insert(f, b);
                    }
                }
                let terms = tile(s, fh, |f| lay.get(&f).cloned().unwrap_or_default()).ok_or_else(|| anyhow!("GEFS precipitation buckets do not cover F{s:03}–F{fh:03}"))?;
                terms.into_iter().map(|(f, a, b, sg)| (f, format!("APCP:{a}-{b}"), sg)).collect()
            }
            ("gefs", Kind::Snow(w)) => {
                let s = fh.checked_sub(w).ok_or_else(|| anyhow!("forecast hour before the window"))?;
                vec![(fh, "WEASD:surface".into(), 1), (s, "WEASD:surface".into(), -1)]
            }
            ("gefs", Kind::Wind10) => vec![(fh, "UGRD:10 m above ground".into(), 1), (fh, "VGRD:10 m above ground".into(), 1)],
            ("gefs", Kind::T2m) => vec![(fh, "TMP:2 m above ground".into(), 1)],
            ("ecmwf", Kind::Precip(w)) | ("ecmwf", Kind::Snow(w)) => {
                let s = fh.checked_sub(w).ok_or_else(|| anyhow!("forecast hour before the window"))?;
                let p = if matches!(v.kind, Kind::Precip(_)) { "tp" } else { "sf" };
                let mut t = vec![(fh, p.to_string(), 1)];
                if s > 0 {
                    t.push((s, p.to_string(), -1));
                }
                t
            }
            ("ecmwf", Kind::Wind10) => vec![(fh, "10u".into(), 1), (fh, "10v".into(), 1)],
            ("ecmwf", Kind::Gust) => vec![(fh, "10fg".into(), 1)],
            ("ecmwf", Kind::T2m) => vec![(fh, "2t".into(), 1)],
            _ => bail!("{} has no {}", m.name, v.name),
        }
        .into_iter()
        .map(|(f, s, g): (u32, String, i32)| (f, format!("{d}{hh:02}|{s}"), g))
        .collect())
    }

    /// Resolve one term of one member to a URL + byte range.
    async fn ens_pick(&self, m: &EnsModel, k: usize, fh: u32, sel: &str) -> Result<Pick> {
        let (run, sel) = sel.split_once('|').ok_or_else(|| anyhow!("bad selector"))?;
        let (d, hh) = (&run[..8], run[8..].parse::<u32>()?);
        let def = sources::model_def(m.def).ok_or_else(|| anyhow!("no def"))?;
        if m.id == "gefs" {
            let url = crate::s3::object_url(def.bucket, &sources::fill_template(def.file, d, hh, fh, "").replace("{mem}", &gefs_member(k)));
            let idx = self.text_cached(&format!("{url}.idx"), 3600).await?;
            let rows = sources::parse_ncep_idx(&idx);
            let r = if let Some(rng) = sel.strip_prefix("APCP:") {
                let (a, b) = rng.split_once('-').ok_or_else(|| anyhow!("bad bucket"))?;
                let want = (a.parse::<u32>()?, b.parse::<u32>()?);
                rows.iter().find(|r| r.2.len() >= 6 && r.2[3] == "APCP" && acc_range(&r.2[5]) == Some(want)).map(|r| (r.0, r.1))
            } else {
                sources::find_ncep(&rows, sel, fh, false)
            };
            let r = r.ok_or_else(|| anyhow!("{sel} not in {} F{fh:03}", gefs_member(k)))?;
            Ok((url, r))
        } else {
            let url = format!("{}/{}", def.bucket, sources::fill_template(def.file, d, hh, fh, ""));
            let idx = self.text_cached(&url.replace(".grib2", ".index"), 3600).await?;
            let mem = ecmwf_members(&idx, sel);
            let (_, o, n) = mem.into_iter().find(|x| x.0 == k).ok_or_else(|| anyhow!("{sel} member {k} not in ECMWF step {fh}"))?;
            Ok((url, (o, Some(o + n))))
        }
    }

    /// One member's values (internal units) on its grid.
    async fn ens_member(&self, m: &EnsModel, plan: &[(u32, String, i32)], k: usize, kind: Kind) -> Result<(usize, usize, Proj, Vec<f32>)> {
        let mut bytes = vec![];
        for (fh, sel, sg) in plan {
            let (url, r) = self.ens_pick(m, k, *fh, sel).await?;
            bytes.push((self.fetch(&url, Some(r), true).await?, *sg));
        }
        let ecmwf = m.id == "ecmwf";
        self.run_blocking(move || {
            let opts = DecodeOpts::default();
            let mut grids: Vec<(Grid, i32)> = vec![];
            for (b, sg) in &bytes {
                grids.push((decode::decode(b, 0, &opts)?, *sg));
            }
            let (g0, _) = grids.first().ok_or_else(|| anyhow!("no fields"))?;
            let (nx, ny, proj) = (g0.nx, g0.ny, g0.proj.clone());
            if grids.iter().any(|(g, _)| g.data.len() != nx * ny) {
                bail!("member fields differ in size");
            }
            let val = |g: &Grid, i: usize| if g.data[i] == 0 { f32::NAN } else { g.value_raw(g.data[i]) };
            let n = nx * ny;
            let vals: Vec<f32> = match kind {
                Kind::Wind10 => (0..n).map(|i| (val(&grids[0].0, i).powi(2) + val(&grids[1].0, i).powi(2)).sqrt()).collect(),
                Kind::T2m => (0..n).map(|i| val(&grids[0].0, i) - 273.15).collect(),
                Kind::Gust => (0..n).map(|i| val(&grids[0].0, i)).collect(),
                Kind::Precip(_) | Kind::Snow(_) => {
                    // ECMWF: metres (tp, sf water equivalent) → mm; GEFS kg/m² = mm
                    let f = if ecmwf { 1000.0 } else { 1.0 };
                    (0..n)
                        .map(|i| {
                            let mut s = 0.0f32;
                            for (g, sg) in &grids {
                                let x = val(g, i);
                                if !x.is_finite() {
                                    return f32::NAN;
                                }
                                s += *sg as f32 * x;
                            }
                            // snow: mm water → cm snow at 10:1 is the same number
                            (s * f).max(0.0)
                        })
                        .collect()
                }
            };
            Ok((nx, ny, proj, vals))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_tiling() {
        // 6-hour buckets every 6 h (GEFS beyond the first steps): 24 h window = 4 buckets
        let six = |f: u32| if f % 6 == 0 && f > 0 { vec![(f - 6, f)] } else { vec![] };
        let t = tile(24, 48, six).unwrap();
        assert_eq!(t.iter().map(|x| (x.0, x.3)).collect::<Vec<_>>(), vec![(48, 1), (42, 1), (36, 1), (30, 1)]);
        // 3-hourly files with buckets restarting every 6 h: f003 0-3, f006 0-6, f009 6-9, f012 6-12
        let mixed = |f: u32| if f % 6 == 0 { vec![(f - 6, f)] } else { vec![(f - 3, f)] };
        let t = tile(6, 12, mixed).unwrap();
        assert_eq!(t, vec![(12, 6, 12, 1)]);
        // window starting mid-bucket: (3, 12] = f012 (6-12) + f006 (0-6) − f003 (0-3)
        let t = tile(3, 12, mixed).unwrap();
        assert_eq!(t, vec![(12, 6, 12, 1), (6, 0, 6, 1), (3, 0, 3, -1)]);
        // run totals only: difference of two totals
        let total = |f: u32| vec![(0, f)];
        assert_eq!(tile(24, 48, total).unwrap(), vec![(48, 0, 48, 1), (24, 0, 24, -1)]);
        assert!(tile(24, 48, |_| vec![]).is_none());
        assert_eq!(acc_range("18-24 hour acc fcst"), Some((18, 24)));
        assert_eq!(acc_range("0-1 day acc fcst"), Some((0, 24)));
        assert_eq!(acc_range("6 hour fcst"), None);
    }

    #[test]
    fn accumulator_ops() {
        let mut a = Acc::new(2, vec![10.0, 25.4]);
        for m in [[0.0, 5.0], [12.0, f32::NAN], [30.0, 7.0], [2.0, 9.0]] {
            a.add(&m);
        }
        assert_eq!(a.op("prob", 0), vec![50.0, 0.0]);
        assert_eq!(a.op("prob", 1)[0], 25.0);
        assert_eq!(a.op("proble", 0)[0], 50.0);
        assert_eq!(a.op("mean", 0), vec![11.0, 7.0]);
        assert_eq!(a.op("min", 0), vec![0.0, 5.0]);
        assert_eq!(a.op("max", 0), vec![30.0, 9.0]);
        let sd = a.op("spread", 0)[1];
        assert!((sd - (8.0f32 / 3.0).sqrt()).abs() < 1e-4, "{sd}");
    }

    #[test]
    fn ecmwf_index_members() {
        let idx = r#"{"type": "pf", "number": "2", "levtype": "sfc", "param": "tp", "_offset": 100, "_length": 10}
{"type": "cf", "levtype": "sfc", "param": "tp", "_offset": 0, "_length": 50}
{"type": "pf", "number": "1", "levtype": "sfc", "param": "2t", "_offset": 200, "_length": 10}
{"type": "pf", "number": "1", "levtype": "sfc", "param": "tp", "_offset": 300, "_length": 10}"#;
        assert_eq!(ecmwf_members(idx, "tp"), vec![(0, 0, 50), (1, 300, 10), (2, 100, 10)]);
    }

    #[test]
    fn catalog_and_thresholds() {
        let l = layers();
        let p = l.iter().find(|x| x.id == "ens/gefs/apcp24/prob").unwrap();
        assert_eq!(p.cmap, "PROB");
        assert_eq!(p.params.as_ref().unwrap()["thr"]["units"], "in");
        assert!(l.iter().any(|x| x.id == "ens/ecmwf/gust/prob"));
        assert!(!l.iter().any(|x| x.id == "ens/gefs/gust/prob"));
        assert!(l.iter().any(|x| x.id == "ens/gefs/t2m/proble"));
        assert!(!l.iter().any(|x| x.id == "ens/gefs/apcp24/proble"));
        assert_eq!(fmt_thr(0.25), "0.25");
        assert_eq!(fmt_thr(1.0), "1");
        assert_eq!(fmt_thr(-10.0), "-10");
        assert!((thr_internal(var("apcp24").unwrap(), 1.0) - 25.4).abs() < 1e-4);
        assert!((thr_internal(var("t2m").unwrap(), 32.0)).abs() < 1e-4);
        assert!((thr_internal(var("gust").unwrap(), 58.0) - 25.93).abs() < 0.01);
        let v = var("apcp24").unwrap();
        assert_eq!(frame_fhs(v, &[0, 3, 6, 12, 18, 21, 24, 30]), vec![24, 30]);
    }
}
