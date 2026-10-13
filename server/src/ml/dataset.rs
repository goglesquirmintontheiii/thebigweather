//! Dataset builder: label events → cases (event + radars + volumes, plus storm "null" cases) →
//! download & extract cell features (cached per volume) → trends → environment → labels →
//! negative sampling. Grid-point targets sample points around events and random negatives.

use super::cells::{self, VolCells};
use super::core::{hash_str, Rng};
use super::features::{FeatMap, Sources};
use super::jobs::Ctl;
use super::labels::{self, Event, EventIndex, Filters, MatchRule};
use super::source::Fetch;
use super::spec::TrainSpec;
use anyhow::{anyhow, bail, Result};
use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SampleMeta {
    pub lat: f64,
    pub lon: f64,
    pub t: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sample {
    /// values in [`Built::ids`] order (NaN = missing)
    pub features: Vec<f32>,
    pub label: f32,
    pub weight: f32,
    /// event / case id (CV folds never split a group)
    pub group: String,
    pub meta: SampleMeta,
}

fn day_of(t: i64) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(t).map(|d| d.date_naive()).unwrap_or_default()
}

fn year_span(y: i32) -> (i64, i64) {
    (Utc.with_ymd_and_hms(y, 1, 1, 0, 0, 0).unwrap().timestamp_millis(), Utc.with_ymd_and_hms(y + 1, 1, 1, 0, 0, 0).unwrap().timestamp_millis().min(Utc::now().timestamp_millis()))
}

fn lsr_kind(code: &str) -> String {
    match code {
        "T" => "tornado".into(),
        "H" => "hail".into(),
        "G" | "D" | "M" => "wind".into(),
        "F" => "flood".into(),
        x => format!("lsr:{x}"),
    }
}

/// All events of the label sources (unfiltered) for the years.
pub async fn load_events(fetch: &dyn Fetch, spec: &TrainSpec, years: (i32, i32), ctl: &Ctl) -> Result<Vec<Event>> {
    let mut out = vec![];
    for src in &spec.label_source {
        let r: Result<Vec<Event>> = match src.as_str() {
            "spc_tornado" => fetch.spc("tornado", years).await,
            "spc_hail" => fetch.spc("hail", years).await,
            "spc_wind" => fetch.spc("wind", years).await,
            "iem_lsr" => {
                let mut v = vec![];
                for y in years.0..=years.1 {
                    let (a, b) = year_span(y);
                    ctl.log(format!("loading IEM storm reports for {y}"));
                    v.extend(fetch.lsr(a, b).await?);
                    if ctl.cancelled() {
                        break;
                    }
                }
                let kinds: Vec<String> = spec.filters.lsr_types.iter().map(|c| lsr_kind(c)).collect();
                if !kinds.is_empty() {
                    v.retain(|e| kinds.contains(&e.kind));
                }
                Ok(v)
            }
            "iem_sbw" => {
                let mut v = vec![];
                for y in years.0..=years.1 {
                    let (a, b) = year_span(y);
                    ctl.log(format!("loading NWS warnings for {y}"));
                    v.extend(fetch.sbw(a, b).await?);
                    if ctl.cancelled() {
                        break;
                    }
                }
                let ph = if spec.filters.phenomena.is_empty() {
                    match spec.target.as_str() {
                        "hail" | "sighail" | "wind" => vec!["SV".to_string()],
                        "flash_flood" | "flood_forecast" => vec!["FF".to_string()],
                        "instability" | "storm_intensify" | "outlook" => vec!["SV".to_string(), "TO".to_string()],
                        _ => vec!["TO".to_string()],
                    }
                } else {
                    spec.filters.phenomena.clone()
                };
                v.retain(|e| ph.iter().any(|p| e.kind.ends_with(p.as_str())));
                Ok(v)
            }
            "hurdat_genesis" | "hurdat_first_fix" => fetch.storms().await.map(|s| labels::genesis(&s, src == "hurdat_first_fix", &spec.filters.basins)),
            "hms_fire" => Ok(vec![]), // sampled per day in the grid-point builder
            x if labels::is_truth_source(x) => continue, // gridded truth, no events
            x => Err(anyhow!("unknown label source {x}")),
        };
        match r {
            Ok(v) => {
                ctl.log(format!("{src}: {} events in {}–{}", v.iter().filter(|e| (years.0..=years.1).contains(&labels::year_of(e.t0))).count(), years.0, years.1));
                out.extend(v);
            }
            Err(e) => {
                if spec.label_source.len() == 1 {
                    return Err(e.context(format!("loading {src}")));
                }
                ctl.log(format!("{src} unavailable: {e:#}"));
            }
        }
    }
    Ok(out)
}

/// Relaxed filters: everything of the same kinds (used to skip ambiguous negatives).
fn relaxed(f: &Filters) -> Filters {
    Filters { lsr_types: f.lsr_types.clone(), phenomena: f.phenomena.clone(), basins: f.basins.clone(), ..Default::default() }
}

/// Disk cache of extracted cells per (volume key, extractor version + params).
pub struct CellCache {
    dir: PathBuf,
}

impl CellCache {
    pub fn new(root: &Path) -> Self {
        let dir = root.join(format!("cells/v{}", super::features::RADAR_CELL_VERSION));
        std::fs::create_dir_all(&dir).ok();
        CellCache { dir }
    }
    fn path(&self, key: &str, params: &str) -> PathBuf {
        self.dir.join(format!("{:016x}.json.zst", hash_str(&format!("{key}|{params}"))))
    }
    pub fn get(&self, key: &str, params: &str) -> Option<VolCells> {
        let z = std::fs::read(self.path(key, params)).ok()?;
        let d = zstd::decode_all(&z[..]).ok()?;
        let v: VolCells = serde_json::from_slice(&d).ok()?;
        (v.key == key).then_some(v)
    }
    pub fn put(&self, v: &VolCells, params: &str) {
        if let Ok(j) = serde_json::to_vec(v) {
            if let Ok(z) = zstd::encode_all(&j[..], 3) {
                crate::platform::write_atomic(&self.path(&v.key, params), &z).ok();
            }
        }
    }
    pub fn get_env(&self, key: &str) -> Option<Vec<FeatMap>> {
        let p = self.dir.join(format!("env-{:016x}.json.zst", hash_str(key)));
        let z = std::fs::read(p).ok()?;
        serde_json::from_slice(&zstd::decode_all(&z[..]).ok()?).ok()
    }
    pub fn put_env(&self, key: &str, v: &[FeatMap]) {
        let p = self.dir.join(format!("env-{:016x}.json.zst", hash_str(key)));
        if let Ok(j) = serde_json::to_vec(v) {
            if let Ok(z) = zstd::encode_all(&j[..], 3) {
                crate::platform::write_atomic(&p, &z).ok();
            }
        }
    }
}

/// Nearest NEXRAD sites within range (distance km, id).
fn nearest_radars(sites: &[crate::sites::Site], lat: f64, lon: f64, max_km: f64, n: usize) -> Vec<(f64, String)> {
    let mut v: Vec<(f64, String)> = sites
        .iter()
        .filter(|s| s.kind == "NEXRAD")
        .map(|s| (crate::radar::geom::bearing_dist(s.lat, s.lon, lat, lon).1 / 1000.0, s.id.clone()))
        .filter(|(d, _)| *d >= 8.0 && *d <= max_km)
        .collect();
    v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    v.truncate(n);
    v
}

pub struct Built {
    /// feature ids of `Sample::features`
    pub ids: Vec<String>,
    pub samples: Vec<Sample>,
    pub stats: serde_json::Value,
}

/// Build the training set for a spec.
pub async fn build(fetch: Arc<dyn Fetch>, spec: &TrainSpec, ctl: &Ctl, cache_root: &Path, concurrency: usize) -> Result<Built> {
    if spec.target == "storm_intensify" {
        return build_intensify(fetch, spec, ctl, cache_root, concurrency).await;
    }
    if super::gridds::is_v2(&spec.target) {
        return super::gridds::build(fetch, spec, ctl, cache_root, concurrency).await;
    }
    if spec.candidate == "radar_cell" {
        build_radar(fetch, spec, ctl, cache_root, concurrency).await
    } else {
        build_grid(fetch, spec, ctl, cache_root, concurrency).await
    }
}

/// Radar volume runs to process for a spec (target events + storm null cases).
struct Plan {
    runs: Vec<Run>,
    target: Vec<Event>,
    ambiguous: Vec<Event>,
    n_cases: usize,
    n_nulls: usize,
    total: usize,
}

async fn plan_runs(fetch: &Arc<dyn Fetch>, spec: &TrainSpec, ctl: &Ctl, rng: &mut Rng, with_nulls: bool) -> Result<Plan> {
    let years = (spec.years[0], spec.years[1]);
    ctl.phase("collect events", 0.0);
    let all = load_events(fetch.as_ref(), spec, years, ctl).await?;
    let target = labels::filter(&all, &spec.filters, years);
    let ambiguous = labels::filter(&all, &relaxed(&spec.filters), years);
    let mut cases: Vec<&Event> = target.iter().filter(|e| spec.region.contains(e.lat, e.lon, &e.st)).collect();
    rng.shuffle(&mut cases);
    cases.truncate(spec.max_events);
    ctl.log(format!("{} target events ({} in region); using {}", target.len(), target.iter().filter(|e| spec.region.contains(e.lat, e.lon, &e.st)).count(), cases.len()));
    ctl.counts(|c| c.events = cases.len());
    if cases.is_empty() && (spec.null_days == 0 || !with_nulls) {
        bail!("no events match the spec (years {}–{}, region, filters)", years.0, years.1);
    }
    let sites = fetch.sites();
    if !sites.iter().any(|s| s.kind == "NEXRAD") {
        bail!("no NEXRAD sites known");
    }

    // null cases: other severe reports with no target event nearby (storms, but no event)
    let mut nulls: Vec<Event> = vec![];
    if spec.null_days > 0 && with_nulls {
        let have: HashSet<&str> = spec.label_source.iter().map(|s| s.as_str()).collect();
        let mut proxies = vec![];
        for (src, kind) in [("spc_hail", "hail"), ("spc_wind", "wind"), ("spc_tornado", "tornado")] {
            if have.contains(src) {
                continue;
            }
            match fetch.spc(kind, years).await {
                Ok(v) => proxies.extend(v.into_iter().filter(|e| spec.region.contains(e.lat, e.lon, &e.st) && (labels::year_of(e.t0) >= years.0 && labels::year_of(e.t0) <= years.1))),
                Err(e) => ctl.log(format!("null cases: {kind} reports unavailable: {e:#}")),
            }
        }
        let amb_idx = EventIndex::new(ambiguous.clone());
        let far = MatchRule { radius_km: 150.0, before_min: 180.0, after_min: 180.0 };
        rng.shuffle(&mut proxies);
        let mut used_days: HashSet<NaiveDate> = HashSet::new();
        for p in proxies {
            if nulls.len() >= spec.null_days {
                break;
            }
            let d = day_of(p.t0);
            if used_days.contains(&d) || amb_idx.first_match(p.lat, p.lon, p.t0, &far).is_some() {
                continue;
            }
            used_days.insert(d);
            nulls.push(p);
        }
        ctl.log(format!("{} null (storm, no event) cases", nulls.len()));
    }

    // volume runs per case (consecutive volumes of one radar; trends use the previous one)
    ctl.phase("list volumes", 0.0);
    let mut listings: HashMap<(String, NaiveDate), Arc<Vec<crate::radar::service::VolEntry>>> = HashMap::new();
    let mut runs: Vec<Run> = vec![];
    let total_cases = cases.len() + nulls.len();
    let mut list_errs = 0usize;
    let case_list: Vec<(Event, bool)> = cases.iter().map(|e| ((*e).clone(), false)).chain(nulls.iter().map(|e| (e.clone(), true))).collect();
    for (ci, (ev, is_null)) in case_list.iter().enumerate() {
        if ctl.stopping() {
            ctl.log("stop requested while listing volumes");
            break;
        }
        ctl.set_progress(ci as f64 / total_cases.max(1) as f64);
        let n_radars = if *is_null { 1 } else { spec.radars_per_event };
        let radars = nearest_radars(&sites, ev.lat, ev.lon, spec.max_radar_km, n_radars);
        let group = if *is_null { format!("null:{}", ev.id) } else { ev.id.clone() };
        // window of interest: lead time before the event to shortly after its start
        let w0 = ev.t0 - (spec.match_rule.after_min * 60_000.0) as i64 - 6 * 60_000;
        let w1 = if *is_null { ev.t0 + 5 * 60_000 } else { ev.t0.max(ev.t1.min(ev.t0 + (spec.match_rule.before_min * 60_000.0) as i64)) + 60_000 };
        for (_, site) in radars {
            let mut vols = vec![];
            for d in [day_of(w0), day_of(w1)].into_iter().collect::<std::collections::BTreeSet<_>>() {
                let k = (site.clone(), d);
                let l = match listings.get(&k) {
                    Some(l) => l.clone(),
                    None => match fetch.list_day(&site, d).await {
                        Ok(l) => {
                            let l = Arc::new(l);
                            listings.insert(k, l.clone());
                            l
                        }
                        Err(e) => {
                            list_errs += 1;
                            if list_errs <= 5 {
                                ctl.log(format!("list {site} {d}: {e:#}"));
                            }
                            continue;
                        }
                    },
                };
                vols.extend(l.iter().filter(|v| v.time >= w0 && v.time <= w1).cloned());
            }
            vols.sort_by_key(|v| v.time);
            vols.dedup_by_key(|v| v.time);
            if vols.is_empty() {
                continue;
            }
            // a run of consecutive volumes ending near the event start (random small offset)
            let end_t = ev.t0 + 60_000;
            let mut end = vols.iter().rposition(|v| v.time <= end_t).unwrap_or(vols.len() - 1);
            end = end.saturating_sub(rng.below(2));
            let start = (end + 1).saturating_sub(spec.volumes_per_event);
            runs.push(Run { site: site.clone(), group: group.clone(), vols: vols[start..=end].iter().map(|v| (v.key.clone(), v.time)).collect() });
        }
    }
    let total: usize = runs.iter().map(|r| r.vols.len()).sum();
    ctl.log(format!("{total} radar volumes to process in {} runs ({list_errs} listing errors)", runs.len()));
    ctl.counts(|c| c.volumes_total = total);
    if total == 0 {
        bail!("no radar volumes found for the selected events");
    }
    let n_cases = cases.len();
    Ok(Plan { runs, target, ambiguous, n_cases, n_nulls: nulls.len(), total })
}

async fn build_radar(fetch: Arc<dyn Fetch>, spec: &TrainSpec, ctl: &Ctl, cache_root: &Path, concurrency: usize) -> Result<Built> {
    let mut rng = Rng::new(spec.seed);
    let Plan { runs, target, ambiguous, n_cases, n_nulls, total } = plan_runs(&fetch, spec, ctl, &mut rng, true).await?;
    // fetch + extract (cached) → trends → environment → labels, streamed per run
    ctl.phase("fetch & extract", 0.0);
    let ids: Vec<String> = super::features::all_features_for(&spec.target, "radar_cell", &spec.sources).into_iter().map(|f| f.id).collect();
    let ctx = RunCtx {
        fetch: fetch.clone(),
        cache: CellCache::new(cache_root),
        params_key: serde_json::to_string(&spec.cell).unwrap_or_default(),
        cell: spec.cell.clone(),
        sources: spec.sources.clone(),
        skey: spec.sources.key(),
        ids: ids.clone(),
        rule: spec.match_rule,
        tidx: EventIndex::new(target.clone()),
        aidx: EventIndex::new(ambiguous),
        emitted: parking_lot::Mutex::new(HashSet::new()),
        done: AtomicUsize::new(0),
        errs: AtomicUsize::new(0),
        hits: AtomicUsize::new(0),
        env_errs: AtomicUsize::new(0),
        vols_ok: AtomicUsize::new(0),
        total,
    };
    let outs: Vec<RunOut> = futures::stream::iter(runs).map(|r| ctx.run(r, ctl)).buffer_unordered(concurrency.max(1)).collect().await;
    if ctl.cancelled() {
        bail!("cancelled");
    }
    let (mut pos, mut neg, mut amb) = (vec![], vec![], 0usize);
    for o in outs {
        pos.extend(o.pos);
        neg.extend(o.neg);
        amb += o.amb;
    }
    let ld = |a: &AtomicUsize| a.load(Ordering::Relaxed);
    ctl.log(format!(
        "extracted {} volumes ({} from cache, {} failed{}); environment errors: {}",
        ld(&ctx.vols_ok),
        ld(&ctx.hits),
        ld(&ctx.errs),
        if ctl.stopping() { ", stopped early" } else { "" },
        ld(&ctx.env_errs)
    ));
    ctl.phase("label", 0.0);
    let n_cells = pos.len() + neg.len() + amb;
    // negatives: half strong storms (hard cases), half random
    let want = ((pos.len() as f64 * spec.neg_ratio).ceil() as usize).max(100.min(neg.len()));
    let iref = ids.iter().position(|i| i == "ref_max").unwrap_or(0);
    if neg.len() > want {
        rng.shuffle(&mut neg);
        let (mut strong, mut rest): (Vec<Sample>, Vec<Sample>) = neg.into_iter().partition(|s| s.features[iref] >= 50.0);
        let ns = (want / 2).min(strong.len());
        strong.truncate(ns);
        rest.truncate(want - ns);
        neg = strong.into_iter().chain(rest).collect();
    }
    ctl.log(format!("{n_cells} cells: {} positive, {} negatives kept, {amb} ambiguous skipped", pos.len(), neg.len()));
    let stats = serde_json::json!({"events": n_cases, "null_cases": n_nulls, "volumes": ld(&ctx.vols_ok), "volumes_planned": total, "volumes_failed": ld(&ctx.errs), "cells": n_cells, "positives": pos.len(), "negatives": neg.len(), "ambiguous": amb});
    let mut samples = pos;
    samples.extend(neg);
    ctl.counts(|c| {
        c.samples = samples.len();
        c.positives = samples.iter().filter(|s| s.label > 0.5).count();
    });
    Ok(Built { ids, samples, stats })
}

/// Consecutive volumes of one radar for one case.
struct Run {
    site: String,
    group: String,
    vols: Vec<(String, i64)>,
}

#[derive(Default)]
struct RunOut {
    pos: Vec<Sample>,
    neg: Vec<Sample>,
    amb: usize,
}

/// Shared state of the per-run workers.
struct RunCtx {
    fetch: Arc<dyn Fetch>,
    cache: CellCache,
    params_key: String,
    cell: super::cells::CellParams,
    sources: Sources,
    skey: String,
    ids: Vec<String>,
    rule: MatchRule,
    tidx: EventIndex,
    aidx: EventIndex,
    /// volume keys whose cells were already emitted (runs may share volumes)
    emitted: parking_lot::Mutex<HashSet<String>>,
    done: AtomicUsize,
    errs: AtomicUsize,
    hits: AtomicUsize,
    env_errs: AtomicUsize,
    vols_ok: AtomicUsize,
    total: usize,
}

impl RunCtx {
    async fn cells(&self, key: &str) -> Result<VolCells> {
        if let Some(v) = self.cache.get(key, &self.params_key) {
            self.hits.fetch_add(1, Ordering::Relaxed);
            return Ok(v);
        }
        let vol = self.fetch.volume(key).await?;
        let (k, cp) = (key.to_string(), self.cell.clone());
        let vc = tokio::task::spawn_blocking(move || cells::extract(&vol, &k, &cp)).await?;
        self.cache.put(&vc, &self.params_key);
        Ok(vc)
    }

    async fn env(&self, vc: &mut VolCells, ctl: &Ctl) {
        if self.sources.is_empty() || vc.cells.is_empty() {
            return;
        }
        let ck = format!("{}|{}|{}", vc.key, self.skey, vc.cells.len());
        let env = match self.cache.get_env(&ck).filter(|v| v.len() == vc.cells.len()) {
            Some(v) => Some(v),
            None => {
                let pts: Vec<(f64, f64)> = vc.cells.iter().map(|c| (c.lat, c.lon)).collect();
                match self.fetch.env(&self.sources, vc.t, &pts, false).await {
                    Ok(v) => {
                        self.cache.put_env(&ck, &v);
                        Some(v)
                    }
                    Err(e) => {
                        if self.env_errs.fetch_add(1, Ordering::Relaxed) < 5 {
                            ctl.log(format!("environment for {}: {e:#}", vc.key));
                        }
                        None
                    }
                }
            }
        };
        for (c, e) in vc.cells.iter_mut().zip(env.unwrap_or_default()) {
            c.feats.0.extend(e.0);
        }
    }

    async fn run_intensify(&self, run: Run, ctl: &Ctl, p: &IntensifyParams, reports: &labels::TimeIndex) -> RunOut {
        let mut out = RunOut::default();
        let mut vcs: Vec<VolCells> = vec![];
        for (key, _) in &run.vols {
            if ctl.stopping() {
                break;
            }
            let res = self.cells(key).await;
            let n = self.done.fetch_add(1, Ordering::Relaxed) + 1;
            ctl.counts(|c| c.volumes_done = n);
            ctl.set_progress(n as f64 / self.total.max(1) as f64);
            match res {
                Ok(v) => {
                    self.vols_ok.fetch_add(1, Ordering::Relaxed);
                    vcs.push(v);
                }
                Err(e) => {
                    if self.errs.fetch_add(1, Ordering::Relaxed) < 20 {
                        ctl.log(format!("skip {key}: {e:#}"));
                    }
                }
            }
        }
        if vcs.len() < 2 {
            return out;
        }
        let ids = track(&mut vcs);
        let labs = intensify_labels(&vcs, &ids, p, Some(reports));
        for (k, vc) in vcs.iter_mut().enumerate() {
            if labs[k].iter().all(|l| l.is_none()) || !self.emitted.lock().insert(vc.key.clone()) {
                out.amb += labs[k].iter().filter(|l| l.is_none()).count();
                continue;
            }
            self.env(vc, ctl).await;
            for (c, l) in vc.cells.iter().zip(&labs[k]) {
                let Some(l) = l else {
                    out.amb += 1;
                    continue;
                };
                let s = Sample { features: c.feats.vector(&self.ids), label: *l, weight: 1.0, group: run.group.clone(), meta: SampleMeta { lat: c.lat, lon: c.lon, t: c.t, site: Some(run.site.clone()), cell_id: Some(c.id.clone()), event: None } };
                if *l > 0.5 { out.pos.push(s) } else { out.neg.push(s) }
            }
        }
        out
    }

    async fn run(&self, run: Run, ctl: &Ctl) -> RunOut {
        let mut out = RunOut::default();
        let mut prev: Option<VolCells> = None;
        for (key, _) in &run.vols {
            if ctl.stopping() {
                break;
            }
            let res = self.cells(key).await;
            let n = self.done.fetch_add(1, Ordering::Relaxed) + 1;
            ctl.counts(|c| c.volumes_done = n);
            ctl.set_progress(n as f64 / self.total.max(1) as f64);
            let mut vc = match res {
                Ok(v) => v,
                Err(e) => {
                    if self.errs.fetch_add(1, Ordering::Relaxed) < 20 {
                        ctl.log(format!("skip {key}: {e:#}"));
                    }
                    prev = None;
                    continue;
                }
            };
            self.vols_ok.fetch_add(1, Ordering::Relaxed);
            if let Some(p) = &prev {
                cells::apply_trends(&mut vc, p);
            }
            if self.emitted.lock().insert(key.clone()) {
                self.env(&mut vc, ctl).await;
                for c in &vc.cells {
                    let meta = SampleMeta { lat: c.lat, lon: c.lon, t: c.t, site: Some(run.site.clone()), cell_id: Some(c.id.clone()), event: None };
                    let x = c.feats.vector(&self.ids);
                    if let Some(e) = self.tidx.first_match(c.lat, c.lon, c.t, &self.rule) {
                        out.pos.push(Sample { features: x, label: 1.0, weight: 1.0, group: run.group.clone(), meta: SampleMeta { event: Some(e.id.clone()), ..meta } });
                    } else if self.tidx.first_match(c.lat, c.lon, c.t, &self.rule.relaxed()).is_some() || self.aidx.first_match(c.lat, c.lon, c.t, &self.rule.relaxed()).is_some() {
                        out.amb += 1;
                    } else {
                        out.neg.push(Sample { features: x, label: 0.0, weight: 1.0, group: run.group.clone(), meta });
                    }
                }
            }
            prev = Some(vc);
        }
        out
    }
}

/// Settings of the storm-intensification target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IntensifyParams {
    pub lead_min: f64,
    /// any | vil | ref | both
    pub criteria: String,
    pub dvil: f64,
    pub dref: f64,
    pub use_reports: bool,
    pub report_radius_km: f64,
}

impl Default for IntensifyParams {
    fn default() -> Self {
        Self { lead_min: 30.0, criteria: "any".into(), dvil: 10.0, dref: 5.0, use_reports: true, report_radius_km: 15.0 }
    }
}

/// Track ids through consecutive volumes (greedy matching by `apply_trends`, which also adds the
/// trend / motion features). Returns the track id of every cell.
pub fn track(vcs: &mut [VolCells]) -> Vec<Vec<usize>> {
    let mut next = 0usize;
    let mut ids: Vec<Vec<usize>> = vec![];
    for k in 0..vcs.len() {
        let m = if k > 0 {
            let (a, b) = vcs.split_at_mut(k);
            cells::apply_trends(&mut b[0], &a[k - 1])
        } else {
            vec![None; vcs[0].cells.len()]
        };
        let row: Vec<usize> = m
            .iter()
            .map(|x| match x {
                Some(j) if k > 0 => ids[k - 1][*j],
                _ => {
                    next += 1;
                    next - 1
                }
            })
            .collect();
        ids.push(row);
    }
    ids
}

/// Intensification labels for the cells of a tracked run: `Some(label)` when the future state is
/// known (a volume close to t + lead exists in the run), else None.
pub fn intensify_labels(vcs: &[VolCells], ids: &[Vec<usize>], p: &IntensifyParams, reports: Option<&labels::TimeIndex>) -> Vec<Vec<Option<f32>>> {
    let lead = (p.lead_min * 60_000.0) as i64;
    let tol = (lead as f64 * 0.3).max(180_000.0) as i64;
    (0..vcs.len())
        .map(|k| {
            let tt = vcs[k].t + lead;
            let fut = (k + 1..vcs.len()).filter(|&m| (vcs[m].t - tt).abs() <= tol).min_by_key(|&m| (vcs[m].t - tt).abs());
            vcs[k]
                .cells
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let rep = p.use_reports && reports.map(|r| r.find(c.lat, c.lon, c.t, c.t + lead, p.report_radius_km).is_some()).unwrap_or(false);
                    let Some(m) = fut else { return if rep { Some(1.0) } else { None } };
                    let later = vcs[m].cells.iter().zip(&ids[m]).find(|(_, id)| **id == ids[k][i]).map(|(c, _)| c);
                    let grow = match later {
                        Some(l) => {
                            let dv = l.feats.get("vil_max") - c.feats.get("vil_max");
                            let dr = l.feats.get("ref_max") - c.feats.get("ref_max");
                            let v = dv.is_finite() && dv as f64 >= p.dvil;
                            let r = dr.is_finite() && dr as f64 >= p.dref;
                            match p.criteria.as_str() {
                                "vil" => v,
                                "ref" => r,
                                "both" => v && r,
                                _ => v || r,
                            }
                        }
                        // the track ended (dissipated or merged)
                        None => false,
                    };
                    Some(if grow || rep { 1.0 } else { 0.0 })
                })
                .collect()
        })
        .collect()
}

/// Storm-intensification samples: consecutive volumes around storm reports, cells tracked, each
/// cell labelled by its own future state.
async fn build_intensify(fetch: Arc<dyn Fetch>, spec: &TrainSpec, ctl: &Ctl, cache_root: &Path, concurrency: usize) -> Result<Built> {
    let p: IntensifyParams = serde_json::from_value(spec.target_params.clone()).unwrap_or_default();
    let mut rng = Rng::new(spec.seed);
    let Plan { runs, target, n_cases, total, .. } = plan_runs(&fetch, spec, ctl, &mut rng, false).await?;
    ctl.phase("fetch & extract", 0.0);
    let ids: Vec<String> = super::features::all_features_for(&spec.target, "radar_cell", &spec.sources).into_iter().map(|f| f.id).collect();
    let ctx = RunCtx {
        fetch: fetch.clone(),
        cache: CellCache::new(cache_root),
        params_key: serde_json::to_string(&spec.cell).unwrap_or_default(),
        cell: spec.cell.clone(),
        sources: spec.sources.clone(),
        skey: spec.sources.key(),
        ids: ids.clone(),
        rule: spec.match_rule,
        tidx: EventIndex::new(vec![]),
        aidx: EventIndex::new(vec![]),
        emitted: parking_lot::Mutex::new(HashSet::new()),
        done: AtomicUsize::new(0),
        errs: AtomicUsize::new(0),
        hits: AtomicUsize::new(0),
        env_errs: AtomicUsize::new(0),
        vols_ok: AtomicUsize::new(0),
        total,
    };
    let reports = labels::TimeIndex::new(target);
    let rp = (&p, &reports);
    let outs: Vec<RunOut> = futures::stream::iter(runs).map(|r| ctx.run_intensify(r, ctl, rp.0, rp.1)).buffer_unordered(concurrency.max(1)).collect().await;
    if ctl.cancelled() {
        bail!("cancelled");
    }
    let (mut pos, mut neg, mut unknown) = (vec![], vec![], 0usize);
    for o in outs {
        pos.extend(o.pos);
        neg.extend(o.neg);
        unknown += o.amb;
    }
    let ld = |a: &AtomicUsize| a.load(Ordering::Relaxed);
    ctl.log(format!("extracted {} volumes ({} from cache, {} failed); {} cells intensify, {} do not, {} without a future volume", ld(&ctx.vols_ok), ld(&ctx.hits), ld(&ctx.errs), pos.len(), neg.len(), unknown));
    ctl.phase("label", 0.0);
    let want = ((pos.len() as f64 * spec.neg_ratio).ceil() as usize).max(100.min(neg.len()));
    if neg.len() > want {
        rng.shuffle(&mut neg);
        neg.truncate(want);
    }
    let stats = serde_json::json!({"events": n_cases, "volumes": ld(&ctx.vols_ok), "volumes_planned": total, "volumes_failed": ld(&ctx.errs), "positives": pos.len(), "negatives": neg.len(), "unknown_future": unknown, "lead_min": p.lead_min});
    let mut samples = pos;
    samples.extend(neg);
    let samples = super::gridds::cap_samples(samples, spec.max_samples, false, spec.seed);
    ctl.counts(|c| {
        c.samples = samples.len();
        c.positives = samples.iter().filter(|s| s.label > 0.5).count();
    });
    Ok(Built { ids, samples, stats })
}

/// A candidate point for grid-point targets.
#[derive(Clone, Debug)]
struct Pt {
    lat: f64,
    lon: f64,
    t: i64,
    label: f32,
    group: String,
    event: Option<String>,
}

async fn build_grid(fetch: Arc<dyn Fetch>, spec: &TrainSpec, ctl: &Ctl, cache_root: &Path, concurrency: usize) -> Result<Built> {
    let years = (spec.years[0], spec.years[1]);
    let mut rng = Rng::new(spec.seed);
    let bbox = spec.region.bbox();
    ctl.phase("collect events", 0.0);
    let tropical = spec.label_source.iter().any(|s| s.starts_with("hurdat"));
    let fire = spec.label_source.iter().any(|s| s == "hms_fire");
    let mut pts: Vec<Pt> = vec![];
    let mut all_events: Vec<Event> = vec![];
    // time snapping: GFS cycles when only model / METAR sources are used, 10 min with MRMS
    let snap = |t: i64| -> i64 {
        if !spec.sources.mrms.is_empty() {
            t / 600_000 * 600_000
        } else if !spec.sources.model.is_empty() {
            (t + 3 * 3_600_000).div_euclid(6 * 3_600_000) * 6 * 3_600_000
        } else {
            t / 3_600_000 * 3_600_000
        }
    };
    if fire {
        // sample days, keep new fires in the region
        let months: Vec<u32> = if spec.filters.months.is_empty() { (1..=12).collect() } else { spec.filters.months.clone() };
        let mut days: Vec<NaiveDate> = vec![];
        for y in years.0..=years.1 {
            let mut d = NaiveDate::from_ymd_opt(y, 1, 2).unwrap();
            while d.year() == y && d < Utc::now().date_naive() {
                if months.contains(&d.month()) {
                    days.push(d);
                }
                d = d.succ_opt().unwrap();
            }
        }
        rng.shuffle(&mut days);
        let per_day = spec.grid.per_day.max(1);
        let n_days = spec.max_events.div_ceil(per_day).min(days.len());
        days.truncate(n_days);
        ctl.log(format!("sampling HMS fire detections on {} days", days.len()));
        for (i, d) in days.iter().enumerate() {
            if ctl.stopping() {
                break;
            }
            ctl.set_progress(i as f64 / days.len().max(1) as f64);
            let (Ok(today), Ok(yest)) = (fetch.fires(*d).await, fetch.fires(d.pred_opt().unwrap()).await) else {
                ctl.log(format!("HMS {d}: unavailable"));
                continue;
            };
            all_events.extend(today.iter().cloned());
            let mut nf: Vec<Event> = labels::new_fires(&today, &yest, 4.0).into_iter().filter(|e| spec.region.contains(e.lat, e.lon, "") && spec.filters.min_frp.map(|m| e.mag.is_finite() && e.mag as f64 >= m).unwrap_or(true)).collect();
            rng.shuffle(&mut nf);
            nf.truncate(per_day);
            for e in nf {
                pts.push(Pt { lat: e.lat, lon: e.lon, t: snap(e.t0), label: 1.0, group: format!("day:{d}"), event: Some(e.id.clone()) });
            }
        }
    } else {
        let all = load_events(fetch.as_ref(), spec, years, ctl).await?;
        let target = labels::filter(&all, &spec.filters, years);
        all_events = labels::filter(&all, &relaxed(&spec.filters), (years.0, years.1));
        let mut cases: Vec<Event> = target.into_iter().filter(|e| spec.region.contains(e.lat, e.lon, &e.st)).collect();
        rng.shuffle(&mut cases);
        cases.truncate(spec.max_events);
        let storms = if tropical { Some(fetch.storms().await?) } else { None };
        for e in &cases {
            let leads: Vec<f64> = if spec.grid.lead_hours.is_empty() { vec![0.0] } else { spec.grid.lead_hours.clone() };
            for h in leads {
                let t = e.t0 - (h * 3_600_000.0) as i64;
                let (lat, lon) = match storms.as_ref().and_then(|s| s.iter().find(|s| format!("tc-{}", s.id) == e.id)) {
                    Some(s) => labels::storm_position(s, t).unwrap_or((e.lat, e.lon)),
                    None => (e.lat, e.lon),
                };
                let group = if tropical { e.id.clone() } else { format!("day:{}", day_of(e.t0)) };
                pts.push(Pt { lat, lon, t: snap(t), label: 1.0, group, event: Some(e.id.clone()) });
            }
        }
    }
    let npos = pts.len();
    ctl.log(format!("{npos} positive points"));
    ctl.counts(|c| c.events = npos);
    if npos == 0 {
        bail!("no positive events match the spec");
    }
    // negatives: random points in the region near positive times, away from any event
    let idx = EventIndex::new(all_events);
    let excl = MatchRule { radius_km: spec.grid.exclude_km, before_min: spec.grid.exclude_hours * 60.0, after_min: spec.grid.exclude_hours * 60.0 };
    let want = (npos as f64 * spec.neg_ratio).ceil() as usize;
    let span_days = if tropical { 10.0 } else { 2.0 };
    let pos_snapshot = pts.clone();
    let mut tries = 0;
    let mut nneg = 0;
    while nneg < want && tries < want * 20 {
        tries += 1;
        let p = &pos_snapshot[rng.below(npos)];
        let t = if spec.sources.mrms.is_empty() { snap(p.t + ((rng.f64() * 2.0 - 1.0) * span_days * 86_400_000.0) as i64) } else { p.t };
        let lat = bbox[1] + rng.f64() * (bbox[3] - bbox[1]);
        let lon = bbox[0] + rng.f64() * (bbox[2] - bbox[0]);
        if !spec.region.contains(lat, lon, "") || idx.first_match(lat, lon, t, &excl).is_some() {
            continue;
        }
        if pos_snapshot.iter().any(|q| (q.t - t).abs() < (spec.grid.exclude_hours * 3_600_000.0) as i64 && labels::dist_to_path_km(lat, lon, &Event { id: String::new(), kind: String::new(), t0: 0, t1: 0, lat: q.lat, lon: q.lon, elat: 0.0, elon: 0.0, mag: 0.0, st: String::new(), poly: vec![] }) < spec.grid.exclude_km) {
            continue;
        }
        pts.push(Pt { lat, lon, t, label: 0.0, group: format!("neg:{}", day_of(t)), event: None });
        nneg += 1;
    }
    ctl.log(format!("{nneg} negative points"));

    // features: grouped by time so each gridded file is fetched once
    ctl.phase("environment", 0.0);
    let cache = Arc::new(CellCache::new(cache_root));
    let mut by_t: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, p) in pts.iter().enumerate() {
        by_t.entry(p.t).or_default().push(i);
    }
    let mut keys: Vec<i64> = by_t.keys().copied().collect();
    keys.sort_unstable();
    ctl.counts(|c| c.volumes_total = keys.len());
    let skey = spec.sources.key();
    let total = keys.len();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let src: Sources = spec.sources.clone();
    let envs: Vec<(i64, Option<Vec<FeatMap>>)> = futures::stream::iter(keys.into_iter())
        .map(|t| {
            let ix = by_t[&t].clone();
            let q: Vec<(f64, f64)> = ix.iter().map(|&i| (pts[i].lat, pts[i].lon)).collect();
            let fetch = fetch.clone();
            let cache = cache.clone();
            let src = src.clone();
            let ck = format!("grid|{t}|{skey}|{:016x}", hash_str(&format!("{q:?}")));
            let done = &done;
            async move {
                if ctl.stopping() {
                    return (t, None);
                }
                let r = match cache.get_env(&ck) {
                    Some(v) if v.len() == q.len() => Some(v),
                    _ => match fetch.env(&src, t, &q, false).await {
                        Ok(v) => {
                            cache.put_env(&ck, &v);
                            Some(v)
                        }
                        Err(e) => {
                            ctl.log(format!("environment at {t}: {e:#}"));
                            None
                        }
                    },
                };
                let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                ctl.counts(|c| c.volumes_done = n);
                ctl.set_progress(n as f64 / total.max(1) as f64);
                (t, r)
            }
        })
        .buffer_unordered(concurrency.clamp(1, 3))
        .collect()
        .await;
    let ids: Vec<String> = super::features::all_features_for(&spec.target, "grid_point", &spec.sources).into_iter().map(|f| f.id).collect();
    let mut samples = vec![];
    let land_rule = if fire { Some(true) } else if tropical { Some(false) } else { None };
    let mut dropped = 0;
    for (t, env) in envs {
        let Some(env) = env else { continue };
        for (k, &i) in by_t[&t].iter().enumerate() {
            let p = &pts[i];
            let mut fm = env.get(k).cloned().unwrap_or_default();
            super::features::set_context(&mut fm, p.lat, p.lon, p.t);
            // negatives on the wrong surface are trivially negative: drop them
            if p.label < 0.5 {
                if let Some(want_land) = land_rule {
                    let l = fm.get("gfs_land");
                    if l.is_finite() && (l >= 0.5) != want_land {
                        dropped += 1;
                        continue;
                    }
                }
            }
            samples.push(Sample { features: fm.vector(&ids), label: p.label, weight: 1.0, group: p.group.clone(), meta: SampleMeta { lat: p.lat, lon: p.lon, t: p.t, site: None, cell_id: None, event: p.event.clone() } });
        }
    }
    if dropped > 0 {
        ctl.log(format!("dropped {dropped} negatives over the wrong surface (land/sea)"));
    }
    if ctl.cancelled() {
        bail!("cancelled");
    }
    let npos = samples.iter().filter(|s| s.label > 0.5).count();
    ctl.counts(|c| {
        c.samples = samples.len();
        c.positives = npos;
    });
    let stats = serde_json::json!({"positives": npos, "negatives": samples.len() - npos, "times": total});
    Ok(Built { ids, samples, stats })
}
