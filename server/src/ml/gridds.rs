//! Grid-point targets with windows and leads: instability, flood risk, temperature /
//! precipitation / storm forecasts, tropical development and SPC-style outlooks.
//!
//! A *case* is an issue time with candidate points; each target defines its *leads* (a target
//! window per lead), how points are labelled (event reports within a radius during the window,
//! or gridded truth such as URMA temperature, MRMS QPE / composite reflectivity, GLM flashes) and
//! extra features (lead time, window length, the current observation used as the persistence
//! baseline). The same feature code serves inference ([`features`]), so a model sees identical
//! inputs when it runs.

use super::core::{hash_str, Rng};
use super::dataset::{load_events, Built, CellCache, Sample, SampleMeta};
use super::features::{set_context, FeatMap};
use super::jobs::Ctl;
use super::labels::{self, Event, TimeIndex};
use super::source::{EnvCtx, Fetch, TruthReq};
use super::spec::TrainSpec;
use anyhow::{bail, Result};
use chrono::{NaiveDate, TimeZone, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const H: i64 = 3_600_000;

pub fn is_v2(target: &str) -> bool {
    matches!(target, "instability" | "temp_forecast" | "precip_forecast" | "storm_forecast" | "tropical_forecast" | "outlook" | "flood_forecast")
}

/// Target settings (`spec.target_params`), defaults per target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TParams {
    pub hours: f64,
    pub radius_km: f64,
    pub use_reports: bool,
    pub use_radar: bool,
    pub radar_dbz: f64,
    pub use_warnings: bool,
    pub pts_per_case: usize,
    pub leads: Vec<f64>,
    pub wet_min_mm: f64,
    pub wet_frac: f64,
    pub window_h: Option<f64>,
    pub dbz: f64,
    pub truth: String,
    pub lead_days: Vec<f64>,
    pub genesis: String,
    pub hazard: String,
    pub day: String,
    pub offset_h: f64,
    pub grid_deg: f64,
}

impl Default for TParams {
    fn default() -> Self {
        Self {
            hours: 3.0,
            radius_km: 40.0,
            use_reports: true,
            use_radar: true,
            radar_dbz: 50.0,
            use_warnings: false,
            pts_per_case: 20,
            leads: vec![],
            wet_min_mm: 0.25,
            wet_frac: 0.5,
            window_h: None,
            dbz: 40.0,
            truth: "cref".into(),
            lead_days: vec![2.0],
            genesis: "ts".into(),
            hazard: "any".into(),
            day: "1".into(),
            offset_h: 6.0,
            grid_deg: 1.0,
        }
    }
}

impl TParams {
    pub fn of(spec: &TrainSpec) -> TParams {
        serde_json::from_value(spec.target_params.clone()).unwrap_or_default()
    }
}

/// One lead of a case: the window the label (and forecast features) refer to.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LeadSpec {
    /// hours (the `lead_h` feature)
    pub lead_h: f64,
    /// window (unix ms), label period (w0, w1]
    pub w0: i64,
    pub w1: i64,
    /// time used for the context features (day of year, solar hour)
    pub ctx_t: i64,
    /// the valid time shown for the output frame
    pub valid: i64,
}

/// Outlook window (offset from the issue time, length) in hours for a day preset.
pub fn outlook_offsets(day: &str, tp: &TParams) -> (f64, f64) {
    match day {
        "1" => (6.0, 24.0),
        "2" => (30.0, 24.0),
        "3" => (54.0, 24.0),
        "4-7" | "4" => (78.0, 96.0),
        _ => (tp.offset_h, tp.window_h.unwrap_or(24.0)),
    }
}

/// 12Z start of the Day-`n` (1-based) outlook window for an issue time (SPC convention: the
/// Day 1 period is the 12Z–12Z day that the 06Z issuance covers).
pub fn outlook_day_start(issue: i64, n: i64) -> i64 {
    let d = chrono::DateTime::from_timestamp_millis(issue - 6 * H).map(|d| d.date_naive()).unwrap_or_default();
    Utc.from_utc_datetime(&d.and_hms_opt(12, 0, 0).unwrap()).timestamp_millis() + (n - 1) * 24 * H
}

/// Leads of a target at issue time `t`. `leads` overrides the trained ones (hours); `window`
/// overrides the outlook / forecast window (ms).
pub fn leads_for(target: &str, tp: &TParams, t: i64, leads: Option<&[f64]>, window: Option<(i64, i64)>) -> Vec<LeadSpec> {
    let hl = |x: f64| (x * H as f64) as i64;
    match target {
        "instability" | "flood_forecast" => {
            let (a, b) = window.unwrap_or((t, t + hl(tp.hours)));
            vec![LeadSpec { lead_h: 0.0, w0: a, w1: b, ctx_t: t, valid: a }]
        }
        "temp_forecast" => {
            let ls = leads.map(|l| l.to_vec()).unwrap_or_else(|| tp.leads.clone());
            let mut v: Vec<LeadSpec> = ls.iter().map(|&l| LeadSpec { lead_h: l, w0: t + hl(l), w1: t + hl(l), ctx_t: t + hl(l), valid: t + hl(l) }).collect();
            if let Some((a, _)) = window {
                v = vec![LeadSpec { lead_h: (a - t) as f64 / H as f64, w0: a, w1: a, ctx_t: a, valid: a }];
            }
            v
        }
        "precip_forecast" => {
            let ls = leads.map(|l| l.to_vec()).unwrap_or_else(|| tp.leads.clone());
            ls.iter().map(|&l| LeadSpec { lead_h: l, w0: t, w1: t + hl(l), ctx_t: t + hl(l) / 2, valid: t + hl(l) }).collect()
        }
        "storm_forecast" => {
            let w = hl(tp.window_h.unwrap_or(1.0));
            let ls = leads.map(|l| l.to_vec()).unwrap_or_else(|| tp.leads.clone());
            let mut v: Vec<LeadSpec> = ls.iter().map(|&l| LeadSpec { lead_h: l, w0: t + hl(l) - w, w1: t + hl(l), ctx_t: t + hl(l), valid: t + hl(l) }).collect();
            if let Some((a, b)) = window {
                v = vec![LeadSpec { lead_h: (b - t) as f64 / H as f64, w0: a, w1: b, ctx_t: b, valid: b }];
            }
            v
        }
        "tropical_forecast" => {
            let ls: Vec<f64> = leads.map(|l| l.iter().map(|h| h / 24.0).collect()).unwrap_or_else(|| tp.lead_days.clone());
            ls.iter().map(|&d| LeadSpec { lead_h: d * 24.0, w0: t, w1: t + hl(d * 24.0), ctx_t: t, valid: t }).collect()
        }
        "outlook" => {
            let (a, b) = match window {
                Some(w) => w,
                None => {
                    let (off, win) = outlook_offsets(&tp.day, tp);
                    if matches!(tp.day.as_str(), "1" | "2" | "3" | "4-7" | "4") {
                        let n = match tp.day.as_str() {
                            "1" => 1,
                            "2" => 2,
                            "3" => 3,
                            _ => 4,
                        };
                        let a = outlook_day_start(t, n);
                        (a, a + hl(win))
                    } else {
                        (t + hl(off), t + hl(off + win))
                    }
                }
            };
            vec![LeadSpec { lead_h: ((a - t) as f64 / H as f64).max(0.0), w0: a, w1: b, ctx_t: a, valid: a }]
        }
        _ => vec![LeadSpec { lead_h: 0.0, w0: t, w1: t, ctx_t: t, valid: t }],
    }
}

/// Events used as labels (reports / warnings / genesis), filtered for the target.
pub fn label_events(spec: &TrainSpec, tp: &TParams, all: &[Event]) -> Vec<Event> {
    let years = (spec.years[0], spec.years[1]);
    let mut v = labels::filter(all, &spec.filters, years);
    match spec.target.as_str() {
        "outlook" | "instability" => {
            let kinds: &[&str] = match tp.hazard.as_str() {
                "tornado" if spec.target == "outlook" => &["tornado"],
                "wind" if spec.target == "outlook" => &["wind"],
                "hail" if spec.target == "outlook" => &["hail"],
                _ => &["tornado", "wind", "hail"],
            };
            v.retain(|e| kinds.contains(&e.kind.as_str()));
        }
        "flood_forecast" => {
            v.retain(|e| e.kind == "flood" || e.kind.starts_with("lsr:") || (tp.use_warnings && e.kind.starts_with("warning:")));
        }
        _ => {}
    }
    v
}

/// Truth used for labels at a lead (None = event labels).
fn label_truth(target: &str, tp: &TParams, l: &LeadSpec, realtime: bool) -> Option<TruthReq> {
    let req = |kind: &str, t0: i64, t1: i64, r: f64| Some(TruthReq { kind: kind.into(), t0, t1, radius_km: r, realtime });
    match target {
        "temp_forecast" => req("t2m", l.w1, l.w1, 0.0),
        "precip_forecast" => req("qpe", l.w0, l.w1, 0.0),
        "storm_forecast" => req(if tp.truth == "glm" { "glm_count" } else { "cref_max" }, l.w0, l.w1, tp.radius_km),
        "instability" if tp.use_radar => req("cref_max", l.w0, l.w1, tp.radius_km),
        _ => None,
    }
}

/// Current observation (persistence baseline / `obs_now`) at issue time `t` for a lead.
pub fn obs_truth(target: &str, tp: &TParams, t: i64, l: &LeadSpec, realtime: bool) -> Option<TruthReq> {
    let req = |kind: &str, t0: i64, t1: i64, r: f64| Some(TruthReq { kind: kind.into(), t0, t1, radius_km: r, realtime });
    match target {
        "temp_forecast" => req("t2m", t, t, 0.0),
        "precip_forecast" => req("qpe", t - (l.w1 - l.w0), t, 0.0),
        "storm_forecast" => req(if tp.truth == "glm" { "glm_count" } else { "cref_max" }, t - (l.w1 - l.w0).max(H / 4), t, tp.radius_km),
        _ => None,
    }
}

/// Label of a truth value.
fn truth_label(target: &str, task: &str, tp: &TParams, v: f32) -> f32 {
    if !v.is_finite() {
        return f32::NAN;
    }
    match (target, task) {
        ("storm_forecast", "classification") => {
            if tp.truth == "glm" { (v >= 1.0) as u8 as f32 } else { (v as f64 >= tp.dbz) as u8 as f32 }
        }
        ("instability", _) => (v as f64 >= tp.radar_dbz) as u8 as f32,
        ("storm_forecast", _) => v.max(0.0),
        _ => v,
    }
}

/// Environment + target features for points at issue time `t` and one lead. `analysis`: the
/// lead-independent part computed earlier for the same points (reused across leads).
#[allow(clippy::too_many_arguments)]
pub async fn features(fetch: &dyn Fetch, spec: &TrainSpec, tp: &TParams, t: i64, l: &LeadSpec, pts: &[(f64, f64)], realtime: bool, analysis: Option<&[FeatMap]>, cache: Option<&CellCache>) -> Result<Vec<FeatMap>> {
    let src = spec.sources.normalized();
    let ana_src = src.analysis_part();
    let mut fms: Vec<FeatMap> = match analysis {
        Some(a) => a.to_vec(),
        None => env_cached(fetch, &ana_src, EnvCtx { t, win: None }, pts, realtime, cache).await?,
    };
    if !src.fcst.is_empty() {
        let fc_src = src.forecast_part();
        match env_cached(fetch, &fc_src, EnvCtx { t, win: Some((l.w0, l.w1)) }, pts, realtime, cache).await {
            Ok(f) => {
                for (a, b) in fms.iter_mut().zip(f) {
                    a.0.extend(b.0);
                }
            }
            Err(e) => tracing::debug!("ml forecast features at {t}: {e:#}"),
        }
    }
    if let Some(req) = obs_truth(&spec.target, tp, t, l, realtime) {
        match truth_cached(fetch, &req, pts, cache).await {
            Ok(v) => {
                for (fm, x) in fms.iter_mut().zip(v) {
                    fm.set("obs_now", x);
                }
            }
            Err(e) => tracing::debug!("ml obs_now at {t}: {e:#}"),
        }
    }
    for (fm, p) in fms.iter_mut().zip(pts) {
        set_context(fm, p.0, p.1, l.ctx_t);
        fm.set("lead_h", l.lead_h as f32);
        fm.set("win_h", ((l.w1 - l.w0) as f64 / H as f64) as f32);
    }
    Ok(fms)
}

/// The lead-independent environment for points.
pub async fn analysis(fetch: &dyn Fetch, spec: &TrainSpec, t: i64, pts: &[(f64, f64)], realtime: bool, cache: Option<&CellCache>) -> Result<Vec<FeatMap>> {
    let src = spec.sources.normalized().analysis_part();
    env_cached(fetch, &src, EnvCtx { t, win: None }, pts, realtime, cache).await
}

async fn env_cached(fetch: &dyn Fetch, src: &super::features::Sources, ctx: EnvCtx, pts: &[(f64, f64)], realtime: bool, cache: Option<&CellCache>) -> Result<Vec<FeatMap>> {
    if src.is_empty() {
        return Ok(vec![FeatMap::default(); pts.len()]);
    }
    let ck = format!("grid2|{}|{:?}|{}|{:016x}", ctx.t, ctx.win, src.key(), hash_str(&format!("{pts:?}")));
    if !realtime {
        if let Some(v) = cache.and_then(|c| c.get_env(&ck)).filter(|v| v.len() == pts.len()) {
            return Ok(v);
        }
    }
    let v = fetch.env_ctx(src, ctx, pts, realtime).await?;
    if !realtime {
        if let Some(c) = cache {
            c.put_env(&ck, &v);
        }
    }
    Ok(v)
}

async fn truth_cached(fetch: &dyn Fetch, req: &TruthReq, pts: &[(f64, f64)], cache: Option<&CellCache>) -> Result<Vec<f32>> {
    let ck = format!("truth|{}|{}|{}|{}|{:016x}", req.kind, req.t0, req.t1, req.radius_km, hash_str(&format!("{pts:?}")));
    if !req.realtime {
        if let Some(v) = cache.and_then(|c| c.get_env(&ck)).filter(|v| v.len() == pts.len()) {
            return Ok(v.iter().map(|f| f.get("v")).collect());
        }
    }
    let v = fetch.truth(req, pts).await?;
    if !req.realtime {
        if let Some(c) = cache {
            let fm: Vec<FeatMap> = v.iter().map(|x| {
                let mut f = FeatMap::default();
                f.set("v", *x);
                f
            }).collect();
            c.put_env(&ck, &fm);
        }
    }
    Ok(v)
}

/// A candidate point of a case.
#[derive(Debug, Clone)]
struct CPt {
    lat: f64,
    lon: f64,
    group: String,
    event: Option<String>,
}

#[derive(Debug, Clone)]
struct Case {
    t: i64,
    pts: Vec<CPt>,
}

fn rand_day(rng: &mut Rng, years: (i32, i32), months: &[u32]) -> Option<NaiveDate> {
    for _ in 0..200 {
        let y = years.0 + rng.below((years.1 - years.0 + 1).max(1) as usize) as i32;
        let m = 1 + rng.below(12) as u32;
        if !months.is_empty() && !months.contains(&m) {
            continue;
        }
        let d = 1 + rng.below(28) as u32;
        let day = NaiveDate::from_ymd_opt(y, m, d)?;
        if day < Utc::now().date_naive() - chrono::Duration::days(2) {
            return Some(day);
        }
    }
    None
}

fn day_ms(d: NaiveDate, hour: u32) -> i64 {
    Utc.from_utc_datetime(&d.and_hms_opt(hour, 0, 0).unwrap()).timestamp_millis()
}

/// A random point within `r_km` of (lat, lon).
fn jitter(rng: &mut Rng, lat: f64, lon: f64, r_km: f64) -> (f64, f64) {
    let a = rng.f64() * std::f64::consts::TAU;
    let d = rng.f64().sqrt() * r_km;
    (lat + a.cos() * d / 111.0, lon + a.sin() * d / 111.0 / lat.to_radians().cos().max(0.2))
}

fn rand_in(rng: &mut Rng, spec: &TrainSpec) -> Option<(f64, f64)> {
    let b = spec.region.bbox();
    for _ in 0..50 {
        let lat = b[1] + rng.f64() * (b[3] - b[1]);
        let lon = b[0] + rng.f64() * (b[2] - b[0]);
        if spec.region.contains(lat, lon, "") {
            return Some((lat, lon));
        }
    }
    None
}

fn date_of(t: i64) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(t).map(|d| d.date_naive()).unwrap_or_default()
}

/// Issue times and points of every case.
fn plan(spec: &TrainSpec, tp: &TParams, events: &[Event], storms: &[crate::hist::tc::Storm], rng: &mut Rng) -> Vec<Case> {
    let years = (spec.years[0], spec.years[1]);
    let months = &spec.filters.months;
    let mut cases: HashMap<i64, Case> = HashMap::new();
    let mut add = |t: i64, p: CPt| cases.entry(t).or_insert_with(|| Case { t, pts: vec![] }).pts.push(p);
    let in_region: Vec<&Event> = events.iter().filter(|e| spec.region.contains(e.lat, e.lon, &e.st)).collect();
    match spec.target.as_str() {
        "instability" | "flood_forecast" => {
            let hrs = tp.hours.max(0.25);
            let mut ev = in_region.clone();
            rng.shuffle(&mut ev);
            ev.truncate(spec.max_events);
            for e in ev {
                let t = (e.t0 - (rng.f64() * 0.9 * hrs * H as f64 + 0.05 * hrs * H as f64) as i64).div_euclid(H) * H;
                let g = format!("day:{}", date_of(e.t0));
                let (la, lo) = jitter(rng, e.lat, e.lon, tp.radius_km * 0.5);
                add(t, CPt { lat: la, lon: lo, group: g.clone(), event: Some(e.id.clone()) });
                for _ in 0..tp.pts_per_case {
                    let (la, lo) = jitter(rng, e.lat, e.lon, 400.0);
                    if spec.region.contains(la, lo, "") {
                        add(t, CPt { lat: la, lon: lo, group: g.clone(), event: None });
                    }
                }
            }
            for _ in 0..spec.null_days {
                let Some(d) = rand_day(rng, years, months) else { break };
                let hour = [0, 1, 2, 3, 15, 16, 17, 18, 19, 20, 21, 22, 23][rng.below(13)];
                let t = day_ms(d, hour);
                for _ in 0..tp.pts_per_case * 2 {
                    if let Some((la, lo)) = rand_in(rng, spec) {
                        add(t, CPt { lat: la, lon: lo, group: format!("null:{d}"), event: None });
                    }
                }
            }
        }
        "temp_forecast" | "precip_forecast" | "storm_forecast" => {
            let conv = spec.target == "storm_forecast";
            for _ in 0..spec.max_events {
                let Some(d) = rand_day(rng, years, months) else { break };
                let hour = if conv && rng.f64() < 0.6 { [15, 17, 19, 21, 23, 1][rng.below(6)] } else { rng.below(24) as u32 };
                let t = day_ms(d, hour);
                for _ in 0..tp.pts_per_case {
                    if let Some((la, lo)) = rand_in(rng, spec) {
                        add(t, CPt { lat: la, lon: lo, group: format!("t:{t}"), event: None });
                    }
                }
            }
        }
        "tropical_forecast" => {
            let r = tp.radius_km;
            let mut ev = in_region.clone();
            rng.shuffle(&mut ev);
            ev.truncate(spec.max_events);
            let snap6 = |t: i64| t.div_euclid(6 * H) * 6 * H;
            for e in ev {
                let sid = e.id.trim_start_matches("tc-");
                let storm = storms.iter().find(|s| s.id == sid);
                for &d in &tp.lead_days {
                    let t = snap6(e.t0 - ((rng.f64() * 0.9 + 0.05) * d * 24.0 * H as f64) as i64);
                    let (la, lo) = storm.and_then(|s| labels::storm_position(s, t)).unwrap_or((e.lat, e.lon));
                    let (la, lo) = jitter(rng, la, lo, r * 0.4);
                    add(t, CPt { lat: la, lon: lo, group: e.id.clone(), event: Some(e.id.clone()) });
                    for _ in 0..tp.pts_per_case / 2 {
                        if let Some((a, b)) = rand_in(rng, spec) {
                            add(t, CPt { lat: a, lon: b, group: e.id.clone(), event: None });
                        }
                    }
                }
            }
            for _ in 0..spec.null_days {
                let Some(d) = rand_day(rng, years, months) else { break };
                let t = day_ms(d, [0, 6, 12, 18][rng.below(4)]);
                for _ in 0..tp.pts_per_case {
                    if let Some((a, b)) = rand_in(rng, spec) {
                        add(t, CPt { lat: a, lon: b, group: format!("null:{d}"), event: None });
                    }
                }
            }
        }
        "outlook" => {
            // convective days (12Z–12Z) with reports, plus random days
            let mut days: Vec<NaiveDate> = in_region.iter().map(|e| date_of(e.t0 - 12 * H)).collect::<HashSet<_>>().into_iter().collect();
            days.sort();
            rng.shuffle(&mut days);
            days.truncate(spec.max_events);
            let have: HashSet<NaiveDate> = days.iter().copied().collect();
            for _ in 0..spec.null_days {
                if let Some(d) = rand_day(rng, years, months) {
                    if !have.contains(&d) {
                        days.push(d);
                    }
                }
            }
            let (off, _) = outlook_offsets(&tp.day, tp);
            let step = tp.grid_deg.clamp(0.1, 5.0);
            let b = spec.region.bbox();
            for d in days {
                let start = day_ms(d, 12);
                let t = start - (off * H as f64) as i64;
                let mut lat = b[1] + step / 2.0;
                while lat < b[3] {
                    let mut lon = b[0] + step / 2.0;
                    while lon < b[2] {
                        if spec.region.contains(lat, lon, "") {
                            let (la, lo) = jitter(rng, lat, lon, step * 30.0);
                            add(t, CPt { lat: la, lon: lo, group: format!("day:{d}"), event: None });
                        }
                        lon += step;
                    }
                    lat += step;
                }
            }
        }
        _ => {}
    }
    let mut v: Vec<Case> = cases.into_values().collect();
    v.sort_by_key(|c| c.t);
    v
}

/// Stratified cap: classification keeps up to half positives; regression keeps a share of
/// "wet" samples (label ≥ `wet`) when `wet` is given, else a random subset.
pub fn cap_samples(mut v: Vec<Sample>, max: usize, regression: bool, seed: u64) -> Vec<Sample> {
    cap_samples_wet(&mut v, max, regression, None, seed);
    v
}

fn cap_samples_wet(v: &mut Vec<Sample>, max: usize, regression: bool, wet: Option<(f32, f64)>, seed: u64) {
    if max == 0 || v.len() <= max {
        return;
    }
    let mut rng = Rng::new(seed ^ 0xCA9);
    rng.shuffle(v);
    let split = |s: &Sample| -> bool {
        match (regression, wet) {
            (false, _) => s.label > 0.5,
            (true, Some((w, _))) => s.label >= w,
            (true, None) => false,
        }
    };
    if regression && wet.is_none() {
        v.truncate(max);
        return;
    }
    let share = if regression { wet.map(|w| w.1).unwrap_or(0.5) } else { 0.5 };
    let (a, b): (Vec<Sample>, Vec<Sample>) = std::mem::take(v).into_iter().partition(split);
    let na = ((max as f64 * share) as usize).min(a.len()).max(max.saturating_sub(b.len()));
    let nb = max - na.min(max);
    v.extend(a.into_iter().take(na));
    v.extend(b.into_iter().take(nb));
}

/// Build the training set of a v2 grid target.
pub async fn build(fetch: Arc<dyn Fetch>, spec: &TrainSpec, ctl: &Ctl, cache_root: &Path, concurrency: usize) -> Result<Built> {
    let tp = TParams::of(spec);
    let years = (spec.years[0], spec.years[1]);
    let mut rng = Rng::new(spec.seed);
    ctl.phase("collect events", 0.0);
    let event_based = matches!(spec.target.as_str(), "instability" | "flood_forecast" | "outlook" | "tropical_forecast");
    let mut events = vec![];
    if event_based {
        let all = load_events(fetch.as_ref(), spec, years, ctl).await?;
        events = label_events(spec, &tp, &all);
        ctl.log(format!("{} label events ({} in region)", events.len(), events.iter().filter(|e| spec.region.contains(e.lat, e.lon, &e.st)).count()));
    }
    let storms = if spec.target == "tropical_forecast" { fetch.storms().await.map(|s| (*s).clone()).unwrap_or_default() } else { vec![] };
    let cases = plan(spec, &tp, &events, &storms, &mut rng);
    let n_pts: usize = cases.iter().map(|c| c.pts.len()).sum();
    ctl.log(format!("{} cases (issue times), {n_pts} candidate points, {} lead(s) each", cases.len(), leads_for(&spec.target, &tp, 0, None, None).len()));
    if cases.is_empty() {
        bail!("no cases: widen the years / months / region or add events");
    }
    ctl.counts(|c| {
        c.events = events.len();
        c.volumes_total = cases.len();
    });
    let tindex = Arc::new(TimeIndex::new(events));
    let cache = Arc::new(CellCache::new(cache_root));
    ctl.phase("environment", 0.0);
    let ids: Vec<String> = super::features::all_features_for(&spec.target, "grid_point", &spec.sources).into_iter().map(|f| f.id).collect();
    let done = AtomicUsize::new(0);
    let errs = AtomicUsize::new(0);
    let total = cases.len();
    let reg = spec.task == "regression";
    let outs: Vec<Vec<Sample>> = futures::stream::iter(cases)
        .map(|case| {
            let (fetch, cache, tindex, tp, ids) = (fetch.clone(), cache.clone(), tindex.clone(), tp.clone(), &ids);
            let (done, errs) = (&done, &errs);
            async move {
                if ctl.stopping() {
                    return vec![];
                }
                let res = case_samples(fetch.as_ref(), spec, &tp, &case, &tindex, ids, &cache).await;
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                ctl.counts(|c| c.volumes_done = n);
                ctl.set_progress(n as f64 / total.max(1) as f64);
                match res {
                    Ok(v) => v,
                    Err(e) => {
                        if errs.fetch_add(1, Ordering::Relaxed) < 10 {
                            ctl.log(format!("case {}: {e:#}", chrono::DateTime::from_timestamp_millis(case.t).map(|d| d.format("%Y-%m-%d %H:%MZ").to_string()).unwrap_or_default()));
                        }
                        vec![]
                    }
                }
            }
        })
        .buffer_unordered(concurrency.clamp(1, 3))
        .collect()
        .await;
    if ctl.cancelled() {
        bail!("cancelled");
    }
    ctl.phase("label", 0.0);
    let mut samples: Vec<Sample> = outs.into_iter().flatten().collect();
    // negatives over the wrong surface are trivially negative
    if spec.target == "tropical_forecast" {
        if let Some(il) = ids.iter().position(|i| i == "gfs_land") {
            let before = samples.len();
            samples.retain(|s| s.label > 0.5 || !(s.features[il] >= 0.5));
            if before > samples.len() {
                ctl.log(format!("dropped {} land negatives", before - samples.len()));
            }
        }
    }
    let n_all = samples.len();
    let wet = (spec.target == "precip_forecast").then_some((tp.wet_min_mm as f32, tp.wet_frac));
    if !reg {
        // keep all positives + up to neg_ratio × negatives
        let npos = samples.iter().filter(|s| s.label > 0.5).count();
        let want = ((npos as f64 * spec.neg_ratio.max(0.2)).ceil() as usize).max(200);
        let nneg = samples.len() - npos;
        if nneg > want && spec.target != "storm_forecast" {
            rng.shuffle(&mut samples);
            let mut k = 0usize;
            samples.retain(|s| {
                if s.label > 0.5 {
                    return true;
                }
                k += 1;
                k <= want
            });
        }
    }
    cap_samples_wet(&mut samples, spec.max_samples, reg, wet, spec.seed);
    let npos = samples.iter().filter(|s| s.label > 0.5).count();
    let label_mean = if samples.is_empty() { 0.0 } else { samples.iter().map(|s| s.label as f64).sum::<f64>() / samples.len() as f64 };
    ctl.log(format!("{} samples ({} before sampling){}", samples.len(), n_all, if reg { format!(", label mean {label_mean:.2}") } else { format!(", {npos} positive") }));
    ctl.counts(|c| {
        c.samples = samples.len();
        c.positives = npos;
    });
    if samples.is_empty() {
        bail!("no samples could be built (all cases failed: is the data archive reachable?)");
    }
    let stats = serde_json::json!({"cases": total, "cases_failed": errs.load(Ordering::Relaxed), "candidates": n_all, "samples": samples.len(), "positives": if reg { serde_json::Value::Null } else { npos.into() }, "label_mean": (label_mean * 1000.0).round() / 1000.0});
    Ok(Built { ids, samples, stats })
}

async fn case_samples(fetch: &dyn Fetch, spec: &TrainSpec, tp: &TParams, case: &Case, events: &TimeIndex, ids: &[String], cache: &CellCache) -> Result<Vec<Sample>> {
    let pts: Vec<(f64, f64)> = case.pts.iter().map(|p| (p.lat, p.lon)).collect();
    let ana = analysis(fetch, spec, case.t, &pts, false, Some(cache)).await?;
    let mut out = vec![];
    let mut label_err = None;
    for l in leads_for(&spec.target, tp, case.t, None, None) {
        // labels
        let lab: Vec<f32> = match label_truth(&spec.target, tp, &l, false) {
            Some(req) => match truth_cached(fetch, &req, &pts, Some(cache)).await {
                Ok(v) => {
                    let mut lab: Vec<f32> = v.iter().map(|x| truth_label(&spec.target, &spec.task, tp, *x)).collect();
                    if spec.target == "instability" && tp.use_reports {
                        for (k, p) in pts.iter().enumerate() {
                            if events.find(p.0, p.1, l.w0, l.w1, tp.radius_km).is_some() {
                                lab[k] = 1.0;
                            }
                        }
                    }
                    lab
                }
                Err(e) if spec.target == "instability" && tp.use_reports => {
                    label_err = Some(e);
                    pts.iter().map(|p| events.find(p.0, p.1, l.w0, l.w1, tp.radius_km).is_some() as u8 as f32).collect()
                }
                Err(e) => {
                    label_err = Some(e);
                    continue;
                }
            },
            None => pts.iter().map(|p| events.find(p.0, p.1, l.w0, l.w1, tp.radius_km).is_some() as u8 as f32).collect(),
        };
        let fms = features(fetch, spec, tp, case.t, &l, &pts, false, Some(&ana), Some(cache)).await?;
        for (k, fm) in fms.iter().enumerate() {
            if !lab[k].is_finite() {
                continue;
            }
            let p = &case.pts[k];
            out.push(Sample { features: fm.vector(ids), label: lab[k], weight: 1.0, group: p.group.clone(), meta: SampleMeta { lat: p.lat, lon: p.lon, t: case.t, site: None, cell_id: None, event: p.event.clone() } });
        }
    }
    if out.is_empty() {
        if let Some(e) = label_err {
            return Err(e.context("labels"));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leads_windows_and_outlook_days() {
        let t = Utc.with_ymd_and_hms(2024, 5, 6, 6, 0, 0).unwrap().timestamp_millis();
        let tp = TParams { leads: vec![1.0, 6.0], ..Default::default() };
        let l = leads_for("temp_forecast", &tp, t, None, None);
        assert_eq!(l.len(), 2);
        assert_eq!(l[1].w1, t + 6 * H);
        let l = leads_for("precip_forecast", &tp, t, Some(&[3.0]), None);
        assert_eq!((l[0].w0, l[0].w1), (t, t + 3 * H));
        let l = leads_for("storm_forecast", &TParams { leads: vec![3.0], window_h: Some(1.0), ..Default::default() }, t, None, None);
        assert_eq!((l[0].w0, l[0].w1), (t + 2 * H, t + 3 * H));
        // Day 1 from a 06Z issue is 12Z–12Z the same day; Day 4-7 a 96 h window from day 4
        let d1 = leads_for("outlook", &TParams::default(), t, None, None)[0];
        assert_eq!(d1.w0, t + 6 * H);
        assert_eq!(d1.w1 - d1.w0, 24 * H);
        assert_eq!(d1.lead_h, 6.0);
        let d47 = leads_for("outlook", &TParams { day: "4-7".into(), ..Default::default() }, t, None, None)[0];
        assert_eq!(d47.w0, t + 78 * H);
        assert_eq!(d47.w1 - d47.w0, 96 * H);
        // an 01Z issuance still belongs to the previous day's Day 1
        let t01 = Utc.with_ymd_and_hms(2024, 5, 7, 1, 0, 0).unwrap().timestamp_millis();
        assert_eq!(outlook_day_start(t01, 1), t + 6 * H);
        let tr = leads_for("tropical_forecast", &TParams { lead_days: vec![2.0, 7.0], ..Default::default() }, t, None, None);
        assert_eq!(tr[1].w1 - tr[1].w0, 7 * 24 * H);
        assert_eq!(truth_label("storm_forecast", "classification", &TParams::default(), 45.0), 1.0);
        assert_eq!(truth_label("storm_forecast", "regression", &TParams::default(), 45.0), 45.0);
    }

    #[test]
    fn caps_keep_strata() {
        let mk = |l: f32| Sample { features: vec![], label: l, weight: 1.0, group: String::new(), meta: SampleMeta::default() };
        let v: Vec<Sample> = (0..1000).map(|i| mk(if i < 50 { 1.0 } else { 0.0 })).collect();
        let c = cap_samples(v, 200, false, 1);
        assert_eq!(c.len(), 200);
        assert_eq!(c.iter().filter(|s| s.label > 0.5).count(), 50);
        let mut w: Vec<Sample> = (0..1000).map(|i| mk(if i < 100 { 5.0 } else { 0.0 })).collect();
        cap_samples_wet(&mut w, 200, true, Some((0.25, 0.5)), 1);
        assert_eq!(w.len(), 200);
        assert_eq!(w.iter().filter(|s| s.label > 0.25).count(), 100);
    }
}
