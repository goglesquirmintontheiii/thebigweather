//! End-to-end: a synthetic data source (radar volumes with storms, tornado reports, null-case
//! proxies) → training job through the job manager → model store → export / import → runner.

use super::cells::tests::storm_volume;
use super::core::Rng;
use super::features::{FeatMap, Sources};
use super::labels::Event;
use super::source::{Bf, Fetch};
use super::*;
use crate::hist::tc::Storm;
use crate::radar::geom::destination;
use crate::radar::level2::Volume;
use crate::radar::service::VolEntry;
use crate::sites::Site;
use chrono::{NaiveDate, TimeZone, Utc};
use serde_json::json;
use std::sync::Arc;

const SITE: (f64, f64) = (35.0, -97.0);

/// Storm set of a synthetic case: (az, range km, dBZ, top km, vortex m/s).
type Storms = Vec<(f64, f64, f32, f64, f64)>;

struct Mock {
    /// case index → (volume time, storms, tornado storm index)
    cases: Vec<(i64, Storms, Option<usize>)>,
    live: Storms,
}

fn case_storms(i: usize, tornadic: bool) -> (Storms, Option<usize>) {
    let mut r = Rng::new(1000 + i as u64);
    let mut s: Storms = vec![];
    let base_az = r.f64() * 360.0;
    let n = 2 + r.below(2);
    for k in 0..n {
        let az = (base_az + k as f64 * 110.0) % 360.0;
        let range = 40.0 + r.f64() * 80.0;
        let strong = tornadic && k == 0;
        let z = if strong { 58.0 + r.f64() as f32 * 7.0 } else { 45.0 + r.f64() as f32 * 15.0 };
        let top = if strong { 11.0 + r.f64() * 3.0 } else { 7.0 + r.f64() * 6.0 };
        // some non-tornadic storms rotate weakly (realistic false-alarm candidates)
        let vort = if strong { 26.0 + r.f64() * 14.0 } else if r.f64() < 0.3 { 10.0 + r.f64() * 8.0 } else { 0.0 };
        s.push((az, range, z, top, vort));
    }
    (s, tornadic.then_some(0))
}

impl Mock {
    fn new(n_tor: usize, n_null: usize) -> Mock {
        let mut cases = vec![];
        for i in 0..n_tor + n_null {
            let day = NaiveDate::from_ymd_opt(2024, 3, 1).unwrap() + chrono::Duration::days(i as i64 * 2);
            let t = Utc.from_utc_datetime(&day.and_hms_opt(20, 0, 0).unwrap()).timestamp_millis();
            let (s, tor) = case_storms(i, i < n_tor);
            cases.push((t, s, tor));
        }
        Mock { cases, live: vec![(30.0, 70.0, 63.0, 13.0, 38.0), (250.0, 90.0, 52.0, 8.0, 0.0)] }
    }
    fn event(&self, i: usize) -> Option<Event> {
        let (t, s, tor) = &self.cases[i];
        let k = (*tor)?;
        let (lat, lon) = destination(SITE.0, SITE.1, s[k].0, s[k].1 * 1000.0);
        Some(Event { id: format!("tor{i}"), kind: "tornado".into(), t0: t + 8 * 60_000, t1: t + 14 * 60_000, lat, lon, elat: 0.0, elon: 0.0, mag: 2.0, st: "OK".into(), poly: vec![] })
    }
}

impl Fetch for Mock {
    fn sites(&self) -> Vec<Site> {
        vec![Site { id: "KTST".into(), name: "Test".into(), state: "OK".into(), lat: SITE.0, lon: SITE.1, elev_m: 400.0, kind: "NEXRAD".into(), country: None, region: None, format: None, source: None }]
    }
    fn list_day<'a>(&'a self, _site: &'a str, day: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
        Box::pin(async move {
            Ok(self
                .cases
                .iter()
                .enumerate()
                .filter(|(_, c)| chrono::DateTime::from_timestamp_millis(c.0).unwrap().date_naive() == day)
                .map(|(i, c)| VolEntry { key: format!("syn:{i}"), time: c.0, size: 0, source: "aws" })
                .collect())
        })
    }
    fn latest<'a>(&'a self, _site: &'a str) -> Bf<'a, Option<VolEntry>> {
        Box::pin(async move { Ok(Some(VolEntry { key: "syn:live".into(), time: Utc::now().timestamp_millis() - 120_000, size: 0, source: "aws" })) })
    }
    fn volume<'a>(&'a self, key: &'a str) -> Bf<'a, Arc<Volume>> {
        Box::pin(async move {
            let (storms, t) = if key == "syn:live" {
                (self.live.clone(), Utc::now().timestamp_millis() - 120_000)
            } else {
                let i: usize = key.trim_start_matches("syn:").parse()?;
                (self.cases[i].1.clone(), self.cases[i].0)
            };
            Ok(Arc::new(tokio::task::spawn_blocking(move || storm_volume(&storms, t)).await?))
        })
    }
    fn spc<'a>(&'a self, kind: &'a str, _years: (i32, i32)) -> Bf<'a, Vec<Event>> {
        Box::pin(async move {
            Ok(match kind {
                "tornado" => (0..self.cases.len()).filter_map(|i| self.event(i)).collect(),
                // null-case proxies: hail reports at the non-tornadic cases' first storm
                "hail" => self
                    .cases
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.2.is_none())
                    .map(|(i, c)| {
                        let (lat, lon) = destination(SITE.0, SITE.1, c.1[0].0, c.1[0].1 * 1000.0);
                        Event { id: format!("hail{i}"), kind: "hail".into(), t0: c.0 + 4 * 60_000, t1: c.0 + 4 * 60_000, lat, lon, elat: 0.0, elon: 0.0, mag: 1.0, st: "OK".into(), poly: vec![] }
                    })
                    .collect(),
                _ => vec![],
            })
        })
    }
    fn lsr<'a>(&'a self, _t0: i64, _t1: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn sbw<'a>(&'a self, _t0: i64, _t1: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
        Box::pin(async { Ok(Arc::new(vec![])) })
    }
    fn fires(&self, _day: NaiveDate) -> Bf<'_, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn env<'a>(&'a self, s: &'a Sources, _t: i64, pts: &'a [(f64, f64)], _realtime: bool) -> Bf<'a, Vec<FeatMap>> {
        Box::pin(async move {
            Ok(pts
                .iter()
                .map(|p| {
                    let mut f = FeatMap::default();
                    if s.metar {
                        f.set("metar_t", 25.0 + (p.0 as f32 - 35.0));
                    }
                    f
                })
                .collect())
        })
    }
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("tbw-ml-{tag}-{}", rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_to_end_train_export_import_run() {
    let dir = tmpdir("e2e");
    let mock = Arc::new(Mock::new(24, 10));
    let cfg = crate::config::MlCfg::default();
    let ml = Ml::new(&cfg, &dir, mock.clone(), None, false, 4000);
    let t0 = std::time::Instant::now();
    let id = ml
        .submit(&json!({"preset": "tornado-quick", "name": "Synthetic tornado", "years": [2024, 2024], "volumes_per_event": 1, "null_days": 10, "neg_ratio": 3, "sources": {"metar": true}, "labels": ["test"], "params": {"n_trees": 120, "early_stopping_rounds": 30}}))
        .unwrap();
    let ctl = ml.jobs.get(&id).unwrap();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let s = ctl.state();
        if matches!(s.as_str(), "done" | "failed" | "cancelled") {
            break;
        }
        assert!(t0.elapsed().as_secs() < 600, "job timed out: {}", ctl.json(true));
    }
    let j = ctl.json(true);
    eprintln!("job finished in {:?}: {}", t0.elapsed(), serde_json::to_string_pretty(&j["log"]).unwrap());
    assert_eq!(j["state"], "done", "{j}");
    assert_eq!(j["progress"], 1.0);
    assert_eq!(j["counts"]["volumes_done"], 34);
    let mid = j["model_id"].as_str().unwrap().to_string();
    let m = ml.store.get(&mid).unwrap();
    eprintln!("metrics: {}", serde_json::to_string_pretty(&m.metrics).unwrap());
    eprintln!("importance: {:?}", &m.importance[..6]);
    assert_eq!(m.labels, vec!["test"]);
    assert!(m.feature_schema.ids().contains(&"metar_t".to_string()));
    let pos = m.metrics["dataset"]["positives"].as_u64().unwrap();
    assert!(pos >= 20, "{pos}");
    let auc = m.metrics["eval"]["roc_auc"].as_f64().unwrap();
    assert!(auc > 0.8, "auc {auc}");

    // rename / relabel / threshold
    let m2 = ml.store.patch(&mid, &json!({"name": "Renamed", "labels": ["a", "b"], "threshold": 0.4})).unwrap();
    assert_eq!(m2.name, "Renamed");
    assert_eq!(m2.levels.med, 0.4);

    // export / import roundtrip gives the same scores
    let bytes = model::export(&m2).unwrap();
    let back = model::import(&bytes).unwrap();
    let mut fm = FeatMap::default();
    fm.set("vrot_max", 30.0);
    fm.set("ref_max", 62.0);
    assert_eq!(m2.score(&fm, 3).0, back.score(&fm, 3).0);
    if std::env::var_os("TBW_WRITE_ML_FIXTURE").is_some() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/fixtures/ml/synthetic-tornado.tbwmodel");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, &bytes).unwrap();
    }

    // runner: one live volume with a tornadic and a plain storm
    let r = runner::Runner::new(None, 1);
    let dets = r.process_site(mock.as_ref(), "KTST", &[m2.clone()], false).await;
    eprintln!("{} detections: {:?}", dets.len(), dets.iter().map(|d| (d.prob, d.level, d.lat, d.lon)).collect::<Vec<_>>());
    let (tla, tlo) = destination(SITE.0, SITE.1, 30.0, 70_000.0);
    let near = |d: &runner::Detection| crate::radar::geom::bearing_dist(d.lat, d.lon, tla, tlo).1 < 8000.0;
    let hit = dets.iter().find(|d| near(d)).expect("tornadic cell detected");
    assert!(hit.prob > 0.5, "{}", hit.prob);
    assert!(!hit.top_features.is_empty());
    assert!(hit.outline.len() >= 3);
    assert!(dets.iter().filter(|d| !near(d)).all(|d| d.prob < hit.prob));
    r.push_all(dets);
    let gj = r.geojson(0, &[], None);
    assert!(gj["features"].as_array().unwrap().iter().any(|f| f["properties"]["kind"] == "outline"));
    assert_eq!(gj["features"][0]["properties"]["model_id"], json!(mid));
    // the same volume is not processed twice
    assert!(r.process_site(mock.as_ref(), "KTST", &[m2.clone()], false).await.is_empty());

    // runner config + loop through Ml (cycle once)
    ml.runner.set_cfg(runner::RunCfg { models: vec![runner::ModelRun::plain(&mid)], radars: json!("all"), enabled: true, interval_s: 60, concurrency: 0, ..Default::default() });
    ml.runner.cycle(mock.as_ref(), &ml.store, None).await;
    assert!(ml.runner.dets.read().len() >= 1);
    let st = ml.runner.status(&mock.sites());
    assert_eq!(st["sites"], json!(["KTST"]));
    assert!(st["per_radar"]["KTST"]["cells"].as_u64().unwrap() >= 2);

    // a second job reuses the cached volumes, and stop keeps a model
    let id2 = ml.submit(&json!({"preset": "tornado-quick", "years": [2024, 2024], "volumes_per_event": 1, "null_days": 10, "algo": "logreg", "cv_folds": 3})).unwrap();
    let c2 = ml.jobs.get(&id2).unwrap();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if matches!(c2.state().as_str(), "done" | "failed" | "cancelled") {
            break;
        }
    }
    let j2 = c2.json(true);
    assert_eq!(j2["state"], "done", "{j2}");
    assert!(j2["log"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("34 from cache")), "{}", j2["log"]);
    let m3 = ml.store.get(j2["model_id"].as_str().unwrap()).unwrap();
    assert!(m3.metrics["eval_kind"].as_str().unwrap().contains("3-fold"));
    assert!(m3.metrics["eval"]["roc_auc"].as_f64().unwrap() > 0.75);

    // cancel a queued/running job
    let id3 = ml.submit(&json!({"preset": "tornado-quick", "years": [2024, 2024]})).unwrap();
    let c3 = ml.jobs.get(&id3).unwrap();
    c3.request_cancel();
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if c3.state() == "cancelled" {
            break;
        }
    }
    assert_eq!(c3.state(), "cancelled");

    // model store reloads from disk
    let store2 = model::Store::open(dir.join("ml/models"));
    assert!(store2.get(&mid).is_some());
    ml.store.delete(&mid).unwrap();
    assert!(ml.store.get(&mid).is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn fixture_model_imports() {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/fixtures/ml/synthetic-tornado.tbwmodel");
    let Ok(b) = std::fs::read(&p) else { return };
    let m = model::import(&b).unwrap();
    assert_eq!(m.candidate, "radar_cell");
    assert_eq!(m.target, "tornado");
    let mut strong = FeatMap::default();
    for (k, v) in [("vrot_max", 32.0), ("vrot_low", 32.0), ("rot_tvs", 1.0), ("rot_meso", 1.0), ("ref_max", 62.0), ("azshear_low", 12.0), ("mesh_mm", 40.0)] {
        strong.set(k, v);
    }
    let mut weak = FeatMap::default();
    for (k, v) in [("vrot_max", 0.0), ("vrot_low", 0.0), ("rot_tvs", 0.0), ("rot_meso", 0.0), ("ref_max", 50.0), ("azshear_low", 1.0), ("mesh_mm", 5.0)] {
        weak.set(k, v);
    }
    assert!(m.score(&strong, 3).0 > m.score(&weak, 3).0);
    // rejects files from a newer format
    let mut v: serde_json::Value = serde_json::from_slice(&zstd::decode_all(&b[..]).unwrap()).unwrap();
    v["format_version"] = json!(99);
    assert!(model::import(&serde_json::to_vec(&v).unwrap()).is_err());
}

#[test]
fn grid_point_dataset_and_training() {
    // tropical-style grid points: positives where a synthetic "vorticity" field is high
    struct G;
    impl Fetch for G {
        fn sites(&self) -> Vec<Site> {
            vec![]
        }
        fn list_day<'a>(&'a self, _s: &'a str, _d: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn latest<'a>(&'a self, _s: &'a str) -> Bf<'a, Option<VolEntry>> {
            Box::pin(async { Ok(None) })
        }
        fn volume<'a>(&'a self, _k: &'a str) -> Bf<'a, Arc<Volume>> {
            Box::pin(async { anyhow::bail!("no radar") })
        }
        fn spc<'a>(&'a self, _k: &'a str, _y: (i32, i32)) -> Bf<'a, Vec<Event>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn lsr<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn sbw<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
            Box::pin(async {
                use crate::hist::tc::Pt;
                let mut v = vec![];
                for i in 0..40 {
                    let t = Utc.with_ymd_and_hms(2022, 8, 1, 0, 0, 0).unwrap().timestamp() + i * 3 * 86400;
                    let (la, lo) = (12.0 + (i % 5) as f32, -40.0 - (i % 7) as f32 * 3.0);
                    v.push(Storm { id: format!("AL{:02}2022", i), name: "X".into(), basin: "al".into(), year: 2022, pts: vec![Pt(t, la, lo, 25, 1008, "TD".into(), false), Pt(t + 21600, la + 0.3, lo - 0.5, 40, 1002, "TS".into(), false)] });
                }
                Ok(Arc::new(v))
            })
        }
        fn fires(&self, _d: NaiveDate) -> Bf<'_, Vec<Event>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn env<'a>(&'a self, _s: &'a Sources, t: i64, pts: &'a [(f64, f64)], _r: bool) -> Bf<'a, Vec<FeatMap>> {
            Box::pin(async move {
                // vorticity peaks near the synthetic storms' first fixes
                let st = self.storms().await?;
                Ok(pts
                    .iter()
                    .map(|&(la, lo)| {
                        let mut f = FeatMap::default();
                        let near = st.iter().any(|s| {
                            let p = &s.pts[0];
                            (p.0 * 1000 - t).abs() < 3 * 86_400_000 && ((p.1 as f64 - la).powi(2) + (p.2 as f64 - lo).powi(2)).sqrt() < 2.0
                        });
                        f.set("gfs_absv850", if near { 20.0 } else { 5.0 } + ((la * 7.0 + lo * 3.0).sin() as f32) * 3.0);
                        f.set("gfs_land", 0.0);
                        f
                    })
                    .collect())
            })
        }
    }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    rt.block_on(async {
        let spec = spec::resolve(&json!({"preset": "tropical-genesis", "years": [2022, 2022], "sources": {"model": ["absv850", "land"]}, "params": {"n_trees": 80}})).unwrap();
        let ctl = jobs::Ctl::detached();
        let dir = tmpdir("grid");
        let built = dataset::build(Arc::new(G), &spec, &ctl, &dir, 2).await.unwrap();
        let pos = built.samples.iter().filter(|s| s.label > 0.5).count();
        assert_eq!(pos, 40 * 5, "{}", built.stats);
        assert!(built.samples.len() > pos * 4);
        let schema = features::Schema::new(&spec.candidate, &spec.sources, &spec.features);
        assert!(schema.ids().contains(&"gfs_absv850".to_string()));
        let tr = train::quick(&spec, &schema, &built.ids, &built.samples).unwrap();
        assert!(tr.metrics["eval"]["roc_auc"].as_f64().unwrap() > 0.8, "{}", tr.metrics);
        std::fs::remove_dir_all(&dir).ok();
    });
}

// ---------- grid models: forecasts as weather layers, outlooks, retrain / continue ----------

/// Synthetic gridded world: a diurnal temperature field, a NWP forecast of it with a
/// latitude-dependent bias, a daily CAPE blob with hail reports under it.
struct GMock {
    grids: Option<Arc<crate::grid::service::GridService>>,
}

const H: i64 = 3_600_000;

fn syn_temp(lat: f64, lon: f64, t: i64) -> f32 {
    let hour = (t.rem_euclid(24 * H)) as f64 / H as f64 + lon / 15.0;
    (28.0 - 0.9 * (lat - 30.0) + 7.0 * ((hour - 9.0) / 24.0 * std::f64::consts::TAU).sin()) as f32
}

fn cape_centre(t: i64) -> (f64, f64) {
    let d = t.div_euclid(24 * H);
    (33.0 + (d % 5) as f64, -97.0 + (d % 7) as f64 * 0.7)
}

fn syn_cape(lat: f64, lon: f64, t: i64) -> f32 {
    let (cla, clo) = cape_centre(t);
    (3000.0 * (-((lat - cla).powi(2) + (lon - clo).powi(2)) / 3.0).exp()) as f32
}

fn hail_reports() -> Vec<Event> {
    let mut v = vec![];
    let mut r = Rng::new(77);
    for d in 0..30 {
        let day = Utc.with_ymd_and_hms(2024, 4, 1, 20, 0, 0).unwrap().timestamp_millis() + d * 24 * H;
        let (cla, clo) = cape_centre(day);
        for k in 0..6 {
            let (la, lo) = (cla + r.normal() * 0.5, clo + r.normal() * 0.5);
            v.push(Event { id: format!("hail{d}-{k}"), kind: "hail".into(), t0: day + k * 600_000, t1: day + k * 600_000, lat: la, lon: lo, elat: 0.0, elon: 0.0, mag: 1.5, st: String::new(), poly: vec![] });
        }
    }
    v
}

impl Fetch for GMock {
    fn sites(&self) -> Vec<Site> {
        vec![]
    }
    fn list_day<'a>(&'a self, _s: &'a str, _d: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn latest<'a>(&'a self, _s: &'a str) -> Bf<'a, Option<VolEntry>> {
        Box::pin(async { Ok(None) })
    }
    fn volume<'a>(&'a self, _k: &'a str) -> Bf<'a, Arc<Volume>> {
        Box::pin(async { anyhow::bail!("no radar") })
    }
    fn spc<'a>(&'a self, kind: &'a str, _y: (i32, i32)) -> Bf<'a, Vec<Event>> {
        Box::pin(async move { Ok(if kind == "hail" { hail_reports() } else { vec![] }) })
    }
    fn lsr<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn sbw<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
        Box::pin(async { Ok(Arc::new(vec![])) })
    }
    fn fires(&self, _d: NaiveDate) -> Bf<'_, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn env<'a>(&'a self, s: &'a Sources, t: i64, pts: &'a [(f64, f64)], realtime: bool) -> Bf<'a, Vec<FeatMap>> {
        self.env_ctx(s, super::source::EnvCtx { t, win: None }, pts, realtime)
    }
    fn env_ctx<'a>(&'a self, s: &'a Sources, ctx: super::source::EnvCtx, pts: &'a [(f64, f64)], _r: bool) -> Bf<'a, Vec<FeatMap>> {
        Box::pin(async move {
            let (w0, w1) = ctx.win.unwrap_or((ctx.t, ctx.t));
            Ok(pts
                .iter()
                .map(|&(la, lo)| {
                    let mut f = FeatMap::default();
                    if s.model.iter().any(|m| m == "t2m") {
                        f.set("gfs_t2m", syn_temp(la, lo, ctx.t) + 0.5);
                    }
                    if s.fcst.iter().any(|m| m == "t2m") {
                        // the forecast has a latitude-dependent bias the model can learn
                        f.set("fc_t2m", syn_temp(la, lo, w1) + (la as f32 - 35.0) * 0.4);
                    }
                    if s.fcst.iter().any(|m| m == "cape") {
                        f.set("fc_cape", syn_cape(la, lo, w0 + 8 * H));
                    }
                    f
                })
                .collect())
        })
    }
    fn truth<'a>(&'a self, req: &'a super::source::TruthReq, pts: &'a [(f64, f64)]) -> Bf<'a, Vec<f32>> {
        Box::pin(async move {
            match req.kind.as_str() {
                "t2m" => Ok(pts.iter().map(|&(la, lo)| syn_temp(la, lo, req.t1)).collect()),
                k => anyhow::bail!("no {k}"),
            }
        })
    }
    fn pred_sink(&self) -> Option<Arc<dyn super::predict::PredSink>> {
        self.grids.clone().map(|g| g as Arc<dyn super::predict::PredSink>)
    }
}

async fn wait_job(ml: &Arc<Ml>, id: &str) -> serde_json::Value {
    let ctl = ml.jobs.get(id).unwrap();
    let t0 = std::time::Instant::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if matches!(ctl.state().as_str(), "done" | "failed" | "cancelled") {
            break;
        }
        assert!(t0.elapsed().as_secs() < 600, "job timed out: {}", ctl.json(true));
    }
    ctl.json(true)
}

fn test_grids(dir: &std::path::Path) -> Arc<crate::grid::service::GridService> {
    let health = Arc::new(crate::health::Health::new(crate::hub::Hub::new()));
    crate::grid::service::GridService::new(reqwest::Client::new(), health, dir, 256, 2, false)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grid_forecast_train_run_layer_continue_retrain() {
    let dir = tmpdir("gridml");
    let grids = test_grids(&dir);
    let mock = Arc::new(GMock { grids: Some(grids.clone()) });
    let ml = Ml::new(&crate::config::MlCfg::default(), &dir, mock.clone(), None, false, 4000);
    let spec = json!({"target": "temp_forecast", "name": "Synthetic temperature", "years": [2024, 2024], "max_events": 40, "region": {"bbox": [-100.0, 30.0, -90.0, 40.0]},
        "sources": {"metar": false, "model": ["t2m"], "fcst": ["t2m"], "fcst_model": "gfs"}, "target_params": {"leads": [1.0, 6.0], "pts_per_case": 25},
        "params": {"n_trees": 40, "learning_rate": 0.1, "early_stopping_rounds": 0, "quantiles": [0.1, 0.9]}});
    let j = wait_job(&ml, &ml.submit(&spec).unwrap()).await;
    assert_eq!(j["state"], "done", "{j}");
    let mid = j["model_id"].as_str().unwrap().to_string();
    let m = ml.store.get(&mid).unwrap();
    eprintln!("temp metrics: {}", m.metrics["eval"]);
    assert_eq!(m.task, "regression");
    assert_eq!(m.output(), "grid");
    assert!(m.ids().contains(&"lead_h".to_string()) && m.ids().contains(&"obs_now".to_string()) && m.ids().contains(&"fc_t2m".to_string()));
    let r2 = m.metrics["eval"]["r2"].as_f64().unwrap();
    assert!(r2 > 0.8, "r2 {r2}");
    assert!(m.metrics["eval"]["skill_persistence"].as_f64().unwrap() > 0.0, "{}", m.metrics["eval"]);
    assert_eq!(m.quantiles.len(), 2);
    assert_eq!(m.history.len(), 1);
    assert_eq!(m.history[0].kind, "train");

    // run → a prediction layer registered in the grid catalog (weather layer)
    let o = runner::ModelRun { id: mid.clone(), grid_res_deg: Some(0.5), region: Some(labels::Region { states: vec![], bbox: Some([-98.0, 32.0, -94.0, 36.0]) }), ..Default::default() };
    let t = Utc.with_ymd_and_hms(2024, 7, 1, 12, 0, 0).unwrap().timestamp_millis();
    let out = ml.runner.run_grid_model(mock.as_ref(), &m, &o, t, None).await.unwrap();
    let lid = format!("mlpred/{mid}");
    assert_eq!(out.layers[0].layer_id, lid);
    assert_eq!(out.layers.len(), 4, "main + P10 + P90 + past runs");
    let cat = grids.catalog();
    let l = cat["layers"].as_array().unwrap().iter().find(|l| l["id"] == json!(lid)).expect("catalog lists the prediction layer").clone();
    assert_eq!(l["units"], "°C");
    assert_eq!(l["cmap"], "TEMP");
    assert_eq!(l["group"], "My models");
    assert_eq!(l["source"], "mlpred");
    let fr = grids.frames(&lid, 12, None, None, None).await.unwrap();
    // hourly frames up to the longest trained lead (frame_step_h defaults to 1 h)
    assert_eq!(fr.frames.len(), 6);
    assert_eq!(fr.frames[5].time, t + 6 * H);
    assert_eq!(fr.frames[0].time, t + H);
    let v = grids.value(&fr.frames[5].key, 34.0, -96.0).await.unwrap().unwrap();
    let truth = syn_temp(34.0, -96.0, t + 6 * H);
    assert!((v - truth).abs() < 3.0, "{v} vs {truth}");
    let png = grids.render(&fr.frames[0].key, (0.2, 0.35, 0.3, 0.45), 64, 64).await.unwrap();
    assert!(png.len() > 80);
    let p10 = grids.frames(&format!("{lid}/p10"), 12, None, None, None).await.unwrap();
    let lo = grids.value(&p10.frames[5].key, 34.0, -96.0).await.unwrap().unwrap();
    assert!(lo <= v + 0.5, "P10 {lo} vs {v}");
    let st = ml.runner.model_state.read().get(&mid).cloned().unwrap();
    assert_eq!(st.state, "ok");
    // main + P10 + P90 + the past-runs animation layer
    assert_eq!(st.layers.len(), 4, "{:?}", st.layers.iter().map(|l| &l.layer_id).collect::<Vec<_>>());
    // a second run 1 h later: the past layer animates both runs
    let o2 = runner::ModelRun { frame_step_h: Some(3.0), ..o.clone() };
    let out2 = ml.runner.run_grid_model(mock.as_ref(), &m, &o2, t + H, None).await.unwrap();
    assert_eq!(out2.layers[0].valid_times, vec![t + 4 * H, t + 7 * H]);
    let past = grids.frames(&format!("{lid}/past"), 12, None, None, None).await.unwrap();
    assert_eq!(past.frames.iter().map(|f| f.time).collect::<Vec<_>>(), vec![t + H, t + 4 * H]);
    // family / intensity / size in the model info
    let sm = m.summary();
    assert_eq!(sm["family_key"], "temp_forecast");
    assert_eq!(sm["intensity"], "custom");
    assert!(sm["size_bytes"].as_u64().unwrap() > 1000);
    assert_eq!(sm["history_mode"]["compatible"], true);

    // continue (warm start, replace): more trees, same schema, history kept
    assert!(ml.continue_training(&mid, &json!({"sources": {"model": ["t2m", "td2m"]}})).unwrap_err().to_string().contains("retrain"));
    let j2 = wait_job(&ml, &ml.continue_training(&mid, &json!({"iterations": 60})).unwrap()).await;
    assert_eq!(j2["state"], "done", "{j2}");
    assert_eq!(j2["kind"], "continue");
    assert_eq!(j2["model_id"], json!(mid));
    let m2 = ml.store.get(&mid).unwrap();
    assert_eq!(m2.version, 2);
    assert_eq!(m2.history.len(), 2);
    assert_eq!(m2.history[1].kind, "continue");
    assert_eq!(m2.feature_schema, m.feature_schema);
    let trees = |m: &model::ModelRecord| match &m.learner {
        model::Learner::Gbdt(g) => g.trees.len(),
        _ => 0,
    };
    assert!(trees(&m2) > trees(&m), "{} -> {}", trees(&m), trees(&m2));
    let (r1, r2) = (m.metrics["train_fit"]["rmse"].as_f64().unwrap(), m2.metrics["train_fit"]["rmse"].as_f64().unwrap());
    assert!(r2 < r1, "training rmse {r1} -> {r2}");
    assert!(m2.metrics["previous"]["version"] == 1);

    // retrain from scratch as a new model with another learner
    let j3 = wait_job(&ml, &ml.retrain(&mid, &json!({"mode": "new", "algo": "logreg", "params": {"l2": 0.1}})).unwrap()).await;
    assert_eq!(j3["state"], "done", "{j3}");
    let m3 = ml.store.get(j3["model_id"].as_str().unwrap()).unwrap();
    assert_ne!(m3.id, mid);
    assert_eq!(m3.algo, "logreg");
    assert!(m3.origin.contains(&mid));
    assert_eq!(m3.history.last().unwrap().from_model.as_deref(), Some(mid.as_str()));
    assert!(m3.metrics["eval"]["r2"].as_f64().unwrap() > 0.5);

    // an imported model can be continued too (it carries its spec)
    let bytes = model::export(&m2).unwrap();
    let mut imp = model::import(&bytes).unwrap();
    imp.id = model::new_id();
    imp.origin = "imported".into();
    let imp = ml.store.save(imp).unwrap();
    let j4 = wait_job(&ml, &ml.continue_training(&imp.id, &json!({"iterations": 10, "mode": "new"})).unwrap()).await;
    assert_eq!(j4["state"], "done", "{j4}");

    // forgetting the model removes its layers
    ml.runner.forget_model(&mid);
    assert!(!grids.catalog()["layers"].as_array().unwrap().iter().any(|l| l["id"] == json!(lid)));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outlook_train_and_run() {
    let dir = tmpdir("outlook");
    let grids = test_grids(&dir);
    let mock = Arc::new(GMock { grids: Some(grids.clone()) });
    let ml = Ml::new(&crate::config::MlCfg::default(), &dir, mock.clone(), None, false, 4000);
    let spec = json!({"preset": "outlook-day1-hail", "years": [2024, 2024], "filters": {"months": [4], "min_size_in": 1.0}, "max_events": 30, "null_days": 4,
        "region": {"bbox": [-104.0, 28.0, -88.0, 42.0]}, "sources": {"model": [], "fcst": ["cape"], "fcst_model": "gfs"}, "max_samples": 0, "params": {"n_trees": 80}});
    let j = wait_job(&ml, &ml.submit(&spec).unwrap()).await;
    assert_eq!(j["state"], "done", "{j}");
    let m = ml.store.get(j["model_id"].as_str().unwrap()).unwrap();
    eprintln!("outlook metrics: {}", m.metrics_summary());
    assert_eq!(m.output(), "outlook");
    assert!(m.metrics["eval"]["roc_auc"].as_f64().unwrap() > 0.8);
    // Day 1 issued 06Z: the window is 12Z–12Z
    let issue = Utc.with_ymd_and_hms(2024, 4, 10, 6, 0, 0).unwrap().timestamp_millis();
    let o = runner::ModelRun { id: m.id.clone(), grid_res_deg: Some(0.5), day: Some("1".into()), ..Default::default() };
    let out = ml.runner.run_grid_model(mock.as_ref(), &m, &o, issue, None).await.unwrap();
    let gj = out.outlook.unwrap();
    assert_eq!(gj["valid_from"], issue + 6 * H);
    assert_eq!(gj["valid_to"], issue + 30 * H);
    assert_eq!(gj["prob_layer"], json!(format!("mlpred/{}", m.id)));
    assert_eq!(gj["hazard"], "hail");
    let feats = gj["features"].as_array().unwrap();
    assert!(!feats.is_empty(), "{gj}");
    let p = &feats[0]["properties"];
    for k in ["cat", "label", "prob", "hazard", "day", "valid_from", "valid_to", "color"] {
        assert!(!p[k].is_null(), "missing {k}");
    }
    // the highest category sits over the CAPE blob
    let top = feats.last().unwrap();
    let ring = top["geometry"]["coordinates"][0][0].as_array().unwrap();
    let (cx, cy) = ring.iter().fold((0.0, 0.0), |a, q| (a.0 + q[0].as_f64().unwrap(), a.1 + q[1].as_f64().unwrap()));
    let (cla, clo) = cape_centre(issue + 14 * H);
    let n = ring.len() as f64;
    assert!((cy / n - cla).abs() < 2.0 && (cx / n - clo).abs() < 2.5, "centre {} {} vs {cla} {clo}", cy / n, cx / n);
    assert!(grids.catalog()["layers"].as_array().unwrap().iter().any(|l| l["id"] == json!(format!("mlpred/{}", m.id)) && l["cmap"] == "PROB" && l["units"] == "%"));
    std::fs::remove_dir_all(&dir).ok();
}

// ---------- storm intensification (radar cells tracked through later volumes) ----------

struct IMock {
    cases: Vec<i64>,
    live: std::sync::atomic::AtomicUsize,
}

fn istorms(case: usize, k: usize) -> Storms {
    let rot = (case * 13) as f64;
    let k = k as f64;
    vec![
        ((40.0 + rot) % 360.0, 70.0, 47.0 + 2.2 * k as f32, 7.0 + 0.8 * k, 0.0),
        ((160.0 + rot) % 360.0, 90.0, 55.0, 10.0, 0.0),
        ((280.0 + rot) % 360.0, 60.0, 60.0 - 1.8 * k as f32, 12.0 - 0.7 * k, 0.0),
    ]
}

impl Fetch for IMock {
    fn sites(&self) -> Vec<Site> {
        vec![Site { id: "KTST".into(), name: "Test".into(), state: "OK".into(), lat: SITE.0, lon: SITE.1, elev_m: 400.0, kind: "NEXRAD".into(), country: None, region: None, format: None, source: None }]
    }
    fn list_day<'a>(&'a self, _site: &'a str, day: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
        Box::pin(async move {
            let mut v = vec![];
            for (i, t) in self.cases.iter().enumerate() {
                for k in 0..8 {
                    let tk = t - (7 - k as i64) * 300_000;
                    if chrono::DateTime::from_timestamp_millis(tk).unwrap().date_naive() == day {
                        v.push(VolEntry { key: format!("iv:{i}:{k}"), time: tk, size: 0, source: "aws" });
                    }
                }
            }
            Ok(v)
        })
    }
    fn latest<'a>(&'a self, _site: &'a str) -> Bf<'a, Option<VolEntry>> {
        Box::pin(async move {
            let k = self.live.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Some(VolEntry { key: format!("iv:live:{k}"), time: Utc::now().timestamp_millis() - 600_000 + k as i64 * 300_000, size: 0, source: "aws" }))
        })
    }
    fn volume<'a>(&'a self, key: &'a str) -> Bf<'a, Arc<Volume>> {
        Box::pin(async move {
            let p: Vec<&str> = key.split(':').collect();
            let k: usize = p[2].parse()?;
            let (storms, t) = if p[1] == "live" { (istorms(0, k + 1), Utc::now().timestamp_millis() - 600_000 + k as i64 * 300_000) } else {
                let i: usize = p[1].parse()?;
                (istorms(i, k), self.cases[i] - (7 - k as i64) * 300_000)
            };
            Ok(Arc::new(tokio::task::spawn_blocking(move || storm_volume(&storms, t)).await?))
        })
    }
    fn spc<'a>(&'a self, kind: &'a str, _y: (i32, i32)) -> Bf<'a, Vec<Event>> {
        Box::pin(async move {
            if kind != "hail" {
                return Ok(vec![]);
            }
            Ok(self
                .cases
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    let s = &istorms(i, 7)[0];
                    let (lat, lon) = destination(SITE.0, SITE.1, s.0, s.1 * 1000.0);
                    Event { id: format!("h{i}"), kind: "hail".into(), t0: *t, t1: *t, lat, lon, elat: 0.0, elon: 0.0, mag: 1.5, st: "OK".into(), poly: vec![] }
                })
                .collect())
        })
    }
    fn lsr<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn sbw<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
        Box::pin(async { Ok(Arc::new(vec![])) })
    }
    fn fires(&self, _d: NaiveDate) -> Bf<'_, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn env<'a>(&'a self, _s: &'a Sources, _t: i64, pts: &'a [(f64, f64)], _r: bool) -> Bf<'a, Vec<FeatMap>> {
        Box::pin(async move { Ok(vec![FeatMap::default(); pts.len()]) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn storm_intensify_train_and_run() {
    let dir = tmpdir("intensify");
    let cases: Vec<i64> = (0..10).map(|i| Utc.with_ymd_and_hms(2024, 5, 1, 21, 0, 0).unwrap().timestamp_millis() + i * 2 * 24 * H).collect();
    let mock = Arc::new(IMock { cases, live: std::sync::atomic::AtomicUsize::new(0) });
    let ml = Ml::new(&crate::config::MlCfg::default(), &dir, mock.clone(), None, false, 4000);
    let spec = json!({"target": "storm_intensify", "label_source": ["radar_tracks", "spc_hail"], "years": [2024, 2024], "max_events": 10, "volumes_per_event": 8,
        "match": {"radius_km": 15.0, "before_min": 0.0, "after_min": 40.0}, "neg_ratio": 3.0,
        "target_params": {"lead_min": 15.0, "criteria": "ref", "dref": 4.0, "use_reports": false}, "params": {"n_trees": 80}});
    let j = wait_job(&ml, &ml.submit(&spec).unwrap()).await;
    eprintln!("{}", serde_json::to_string_pretty(&j["log"]).unwrap());
    assert_eq!(j["state"], "done", "{j}");
    let m = ml.store.get(j["model_id"].as_str().unwrap()).unwrap();
    eprintln!("intensify metrics: {} importance {:?}", m.metrics_summary(), &m.importance[..4]);
    assert_eq!(m.target, "storm_intensify");
    assert!(m.metrics["dataset"]["build"]["unknown_future"].as_u64().unwrap() > 0);
    let pos = m.metrics["dataset"]["positives"].as_u64().unwrap();
    assert!(pos >= 20, "{pos}");
    assert!(m.metrics["eval"]["roc_auc"].as_f64().unwrap() > 0.8, "{}", m.metrics["eval"]);
    // live: the second volume has trends; the growing cell scores above the decaying one
    let r = runner::Runner::new(None, 1);
    r.set_cfg(runner::RunCfg { models: vec![runner::ModelRun { id: m.id.clone(), min_prob: Some(0.0), threshold: Some(0.05), ..Default::default() }], ..Default::default() });
    let _ = r.process_site(mock.as_ref(), "KTST", &[m.clone()], false).await;
    let d = r.process_site(mock.as_ref(), "KTST", &[m.clone()], false).await;
    let at = |az: f64, rng: f64| destination(SITE.0, SITE.1, az, rng * 1000.0);
    let near = |d: &runner::Detection, p: (f64, f64)| crate::radar::geom::bearing_dist(d.lat, d.lon, p.0, p.1).1 < 10_000.0;
    let grow = d.iter().find(|x| near(x, at(40.0, 70.0))).expect("growing cell detected");
    let decay = d.iter().find(|x| near(x, at(280.0, 60.0)));
    eprintln!("grow {} decay {:?}", grow.prob, decay.map(|x| x.prob));
    assert!(decay.map(|x| x.prob < grow.prob).unwrap_or(true));
    // a gate above the growing cell's probability hides it
    r.set_cfg(runner::RunCfg { models: vec![runner::ModelRun { id: m.id.clone(), max_prob: Some(grow.prob * 0.5), threshold: Some(0.05), ..Default::default() }], ..Default::default() });
    let d2 = r.process_site(mock.as_ref(), "KTST", &[m.clone()], false).await;
    assert!(d2.iter().all(|x| x.prob <= grow.prob * 0.5 + 1e-9));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn intensify_labels_from_tracks() {
    use super::cells::{Cell, VolCells};
    let mk = |t: i64, cells: Vec<(f64, f32, f32)>| VolCells {
        key: format!("k{t}"),
        site: "KTST".into(),
        t,
        lat: 35.0,
        lon: -97.0,
        cells: cells
            .into_iter()
            .enumerate()
            .map(|(i, (lon, r, v))| {
                let mut f = FeatMap::default();
                f.set("ref_max", r);
                f.set("vil_max", v);
                f.set("area_km2", 50.0);
                Cell { id: format!("c{i}"), lat: 35.5, lon, t, feats: f, hull: vec![], motion: None }
            })
            .collect(),
    };
    let t = 1_700_000_000_000;
    let mut v = vec![mk(t, vec![(-97.0, 50.0, 20.0), (-96.0, 55.0, 30.0)]), mk(t + 300_000, vec![(-97.0, 53.0, 25.0), (-96.0, 55.0, 30.0)]), mk(t + 600_000, vec![(-97.0, 58.0, 40.0)])];
    let ids = dataset::track(&mut v);
    assert_eq!(ids[1][0], ids[0][0]);
    assert_eq!(ids[2][0], ids[0][0]);
    let p = dataset::IntensifyParams { lead_min: 10.0, dvil: 10.0, dref: 5.0, criteria: "any".into(), use_reports: false, report_radius_km: 10.0 };
    let l = dataset::intensify_labels(&v, &ids, &p, None);
    assert_eq!(l[0], vec![Some(1.0), Some(0.0)], "the first cell grows; the second dissipates");
    assert_eq!(l[1], vec![None, None], "no volume 10 min later");
    assert!(v[1].cells[0].feats.get("ref_trend") > 0.0);
}


// ---------- one-shot / historical runs, per-model run configs, reports, ensembles, A/B ----------

async fn train_quick(ml: &Arc<Ml>, extra: serde_json::Value) -> String {
    let mut spec = json!({"preset": "tornado-quick", "name": "Synthetic tornado", "years": [2024, 2024], "volumes_per_event": 1, "null_days": 10, "neg_ratio": 3, "sources": {"metar": true}, "params": {"n_trees": 60, "early_stopping_rounds": 20}});
    spec::merge(&mut spec, &extra);
    let j = wait_job(ml, &ml.submit(&spec).unwrap()).await;
    assert_eq!(j["state"], "done", "{j}");
    j["model_id"].as_str().unwrap().to_string()
}

async fn wait_any(ml: &Arc<Ml>, id: &str) -> serde_json::Value {
    let ctl = ml.jobs.get(id).unwrap();
    let t0 = std::time::Instant::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if matches!(ctl.state().as_str(), "done" | "failed" | "cancelled") {
            return ctl.json(true);
        }
        assert!(t0.elapsed().as_secs() < 600, "job timed out: {}", ctl.json(true));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_history_reports_ensembles_compare() {
    let dir = tmpdir("ops");
    let mock = Arc::new(Mock::new(24, 10));
    let ml = Ml::new(&crate::config::MlCfg::default(), &dir, mock.clone(), None, false, 4000);
    let m1 = train_quick(&ml, json!({})).await;
    let m2 = train_quick(&ml, json!({"algo": "logreg", "params": {"l2": 1.0}, "intensity": "medium", "cv_folds": 0, "max_events": 150})).await;
    let rec1 = ml.store.get(&m1).unwrap();
    assert_eq!(rec1.intensity, "quick");
    assert_eq!(rec1.family_key, "tornado");
    assert_eq!(ml.store.get(&m2).unwrap().intensity, "medium");
    let job = ml.jobs.get(rec1.job_id.as_ref().unwrap()).unwrap().json(true);
    assert!(job["usage"]["cache_hits"].as_u64().is_some(), "{}", job["usage"]);
    assert!(job["resources"]["cpu_threads"].as_u64().unwrap() >= 1);

    // historical run over the first cases (one volume per case day)
    let (t0, t2) = (mock.cases[0].0, mock.cases[2].0);
    let hid = ml.run_history(&json!({"models": [m1], "radars": "all", "from": t0 - H, "to": t2 + H})).unwrap();
    let h = wait_any(&ml, &hid).await;
    assert_eq!(h["state"], "done", "{h}");
    assert_eq!(h["kind"], "history");
    assert_eq!(h["counts"]["volumes_total"], 3);
    let q = ml.runner.query(&runner::DetQuery { run: Some(hid.clone()), ..Default::default() });
    assert!(q["count"].as_u64().unwrap() >= 1, "{q}");
    assert!(q["features"].as_array().unwrap().iter().all(|f| f["properties"]["t"].as_i64().unwrap() <= t2 + H));
    // time-range query includes historical detections; live-only does not
    let ranged = ml.runner.query(&runner::DetQuery { from: Some(t0 - H), to: Some(t0 + H), ..Default::default() });
    assert!(ranged["count"].as_u64().unwrap() >= 1);
    assert_eq!(ml.runner.query(&runner::DetQuery::default())["count"], 0);
    assert!(ml.run_history(&json!({"models": [m1], "from": t0, "to": t0 - 1})).is_err());

    // one-shot run over all radars
    let rid = ml.run_now(&json!({"models": [m1], "radars": "all"})).unwrap();
    let r = wait_any(&ml, &rid).await;
    assert_eq!(r["state"], "done", "{r}");
    assert!(r["result"]["detections"].as_u64().unwrap() >= 1, "{r}");
    assert!(ml.runner.dets.read().iter().all(|d| d.run.as_deref() == Some(rid.as_str())));

    // per-model run config: enabled with options and radars; disabling clears its detections
    let v = ml.set_model_run(&m1, &json!({"enabled": true, "options": {"min_prob": 0.05, "report_cycles": 1}, "radars": ["KTST"]})).unwrap();
    assert_eq!(v["enabled"], true);
    assert_eq!(v["options"]["min_prob"], 0.05);
    assert_eq!(v["radars"], json!(["KTST"]));
    ml.runner.cycle(mock.as_ref(), &ml.store, None).await;
    // report after one cycle (report_cycles 1)
    let reps = ml.reports.query(None, None, None, &[m1.clone()], 0);
    assert!(!reps.is_empty(), "no report");
    assert!(super::reports::to_csv(&reps).contains(&reps[0].id));
    assert_eq!(super::reports::to_geojson(&reps)["count"], reps.len());
    let v = ml.set_model_run(&m1, &json!({"enabled": false})).unwrap();
    assert_eq!(v["enabled"], false);
    assert_eq!(v["options"]["min_prob"], 0.05, "options kept while disabled");
    assert!(ml.runner.dets.read().iter().all(|d| d.model_id != m1));

    // ensemble of the two models: mean of the members
    let e = ml.create_ensemble(&json!({"name": "Both", "members": [m1, m2], "method": "mean"})).unwrap();
    assert!(e.is_ensemble());
    let mut fm = FeatMap::default();
    fm.set("vrot_max", 30.0);
    fm.set("ref_max", 62.0);
    fm.set("metar_t", 25.0);
    let (a, b) = (ml.store.get(&m1).unwrap().score(&fm, 1).0, ml.store.get(&m2).unwrap().score(&fm, 1).0);
    let pe = e.score(&fm, 1).0;
    assert!((pe - (a + b) / 2.0).abs() < 1e-6, "{pe} vs {a} {b}");
    let back = model::import(&model::export(&e).unwrap()).unwrap();
    assert!((back.score(&fm, 1).0 - pe).abs() < 1e-9);
    assert_eq!(e.summary()["kind"], "ensemble");
    assert!(ml.create_ensemble(&json!({"members": [m1]})).is_err());
    assert!(ml.retrain(&e.id, &json!({})).is_err());

    // A/B scorecards on the same events
    let cid = ml.compare(&json!({"models": [m1, m2, e.id], "events": {"years": [2024, 2024], "seed": 9}})).unwrap();
    let c = wait_any(&ml, &cid).await;
    assert_eq!(c["state"], "done", "{c}");
    let full = ml.compare_result(&cid).unwrap();
    let cards = full["result"]["scorecards"].as_array().unwrap();
    assert_eq!(cards.len(), 3);
    assert!(cards.iter().all(|c| c["roc_auc"].as_f64().unwrap() > 0.6), "{cards:?}");
    assert!(!full["result"]["events"].as_array().unwrap().is_empty());

    // a cancelled job resumes in place (same id) and finishes
    let id = ml.submit(&json!({"preset": "tornado-quick", "years": [2024, 2024], "volumes_per_event": 1, "null_days": 10, "params": {"n_trees": 30}})).unwrap();
    ml.jobs.get(&id).unwrap().request_cancel();
    let j = wait_job(&ml, &id).await;
    assert_eq!(j["state"], "cancelled");
    assert_eq!(j["retryable"], true);
    assert_eq!(ml.resume(&id).unwrap(), id);
    let j = wait_job(&ml, &id).await;
    assert_eq!(j["state"], "done", "{j}");
    assert_eq!(j["resumes"], 1);

    // settings
    let mut c = crate::config::MlCfg::default();
    assert!(Ml::patch_settings(&mut c, &json!({"max_jobs": 9})).is_err());
    let ch = Ml::patch_settings(&mut c, &json!({"max_jobs": 4, "resources": {"cpu_threads": 3}})).unwrap();
    assert_eq!(ch, vec!["max_jobs", "cpu_threads"]);
    ml.configure(&c, 4000);
    assert_eq!(ml.jobs.max_jobs(), 4);
    assert_eq!(ml.default_resources().cpu_threads, 3);
    std::fs::remove_dir_all(&dir).ok();
}

// ---------- storm tracks ----------

/// Storms moving with a constant velocity (east, north km per minute) from a start point.
struct TMock {
    /// per case: start time, storms (lat0, lon0, km/min east, km/min north, dBZ)
    cases: Vec<(i64, Vec<(f64, f64, f64, f64, f32)>)>,
    live: std::sync::atomic::AtomicUsize,
}

impl TMock {
    fn new(n: usize) -> TMock {
        let mut cases = vec![];
        for i in 0..n {
            let t = Utc.with_ymd_and_hms(2024, 5, 1, 20, 0, 0).unwrap().timestamp_millis() + i as i64 * 2 * 24 * H;
            let mut r = Rng::new(500 + i as u64);
            let mut storms = vec![];
            for k in 0..2 {
                let (la, lo) = destination(SITE.0, SITE.1, r.f64() * 360.0, (50.0 + r.f64() * 40.0) * 1000.0);
                // motion 0.4–0.9 km/min (13–29 kt), direction varies per storm
                let spd = 0.4 + r.f64() * 0.5;
                let dir = (r.f64() * 360.0 + k as f64 * 90.0).to_radians();
                storms.push((la, lo, spd * dir.sin(), spd * dir.cos(), 52.0 + r.f64() as f32 * 8.0));
            }
            cases.push((t, storms));
        }
        TMock { cases, live: std::sync::atomic::AtomicUsize::new(0) }
    }
    /// (az, range km, dBZ, top, vortex) of the storms `min` minutes after the case start.
    fn at(&self, case: usize, min: f64) -> Storms {
        self.cases[case].1.iter().map(|&(la, lo, u, v, z)| {
            let lat = la + v * min / 110.57;
            let lon = lo + u * min / (111.32 * la.to_radians().cos());
            let (az, d) = crate::radar::geom::bearing_dist(SITE.0, SITE.1, lat, lon);
            (az, d / 1000.0, z, 10.0, 0.0)
        }).collect()
    }
}

impl Fetch for TMock {
    fn sites(&self) -> Vec<Site> {
        vec![Site { id: "KTST".into(), name: "Test".into(), state: "OK".into(), lat: SITE.0, lon: SITE.1, elev_m: 400.0, kind: "NEXRAD".into(), country: None, region: None, format: None, source: None }]
    }
    fn list_day<'a>(&'a self, _site: &'a str, day: NaiveDate) -> Bf<'a, Vec<VolEntry>> {
        Box::pin(async move {
            let mut v = vec![];
            for (i, c) in self.cases.iter().enumerate() {
                for k in 0..20 {
                    let t = c.0 + k * 300_000;
                    if chrono::DateTime::from_timestamp_millis(t).unwrap().date_naive() == day {
                        v.push(VolEntry { key: format!("tv:{i}:{k}"), time: t, size: 0, source: "aws" });
                    }
                }
            }
            Ok(v)
        })
    }
    fn latest<'a>(&'a self, _site: &'a str) -> Bf<'a, Option<VolEntry>> {
        Box::pin(async move {
            let k = self.live.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Some(VolEntry { key: format!("tv:live:{k}"), time: Utc::now().timestamp_millis() - 900_000 + k as i64 * 300_000, size: 0, source: "aws" }))
        })
    }
    fn volume<'a>(&'a self, key: &'a str) -> Bf<'a, Arc<Volume>> {
        Box::pin(async move {
            let p: Vec<&str> = key.split(':').collect();
            let k: i64 = p[2].parse()?;
            let (storms, t) = if p[1] == "live" { (self.at(0, k as f64 * 5.0), Utc::now().timestamp_millis() - 900_000 + k * 300_000) } else {
                let i: usize = p[1].parse()?;
                (self.at(i, k as f64 * 5.0), self.cases[i].0 + k * 300_000)
            };
            Ok(Arc::new(tokio::task::spawn_blocking(move || storm_volume(&storms, t)).await?))
        })
    }
    fn spc<'a>(&'a self, kind: &'a str, _y: (i32, i32)) -> Bf<'a, Vec<Event>> {
        Box::pin(async move {
            if kind != "hail" {
                return Ok(vec![]);
            }
            Ok(self.cases.iter().enumerate().map(|(i, c)| {
                let s = &self.at(i, 25.0)[0];
                let (lat, lon) = destination(SITE.0, SITE.1, s.0, s.1 * 1000.0);
                Event { id: format!("h{i}"), kind: "hail".into(), t0: c.0 + 25 * 60_000, t1: c.0 + 25 * 60_000, lat, lon, elat: 0.0, elon: 0.0, mag: 1.5, st: "OK".into(), poly: vec![] }
            }).collect())
        })
    }
    fn lsr<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn sbw<'a>(&'a self, _a: i64, _b: i64) -> Bf<'a, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn storms(&self) -> Bf<'_, Arc<Vec<Storm>>> {
        Box::pin(async { Ok(Arc::new(vec![])) })
    }
    fn fires(&self, _d: NaiveDate) -> Bf<'_, Vec<Event>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn env<'a>(&'a self, _s: &'a Sources, _t: i64, pts: &'a [(f64, f64)], _r: bool) -> Bf<'a, Vec<FeatMap>> {
        Box::pin(async move { Ok(vec![FeatMap::default(); pts.len()]) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn storm_track_train_and_run() {
    let dir = tmpdir("track");
    let mock = Arc::new(TMock::new(12));
    let ml = Ml::new(&crate::config::MlCfg::default(), &dir, mock.clone(), None, false, 4000);
    let j = wait_job(&ml, &ml.submit(&json!({"preset": "storm-track-quick", "years": [2024, 2024], "max_events": 12, "volumes_per_event": 16, "sources": {"model": []}, "params": {"n_trees": 150, "learning_rate": 0.1, "early_stopping_rounds": 0}})).unwrap()).await;
    eprintln!("{}", serde_json::to_string_pretty(&j["log"]).unwrap());
    assert_eq!(j["state"], "done", "{j}");
    let m = ml.store.get(j["model_id"].as_str().unwrap()).unwrap();
    assert_eq!(m.target, "storm_track");
    assert_eq!(m.aux.len(), 2);
    let err = &m.metrics["track_err_km"];
    eprintln!("track errors {err} persistence {}", m.metrics["track_err_persistence_km"]);
    assert!(err["30"].as_f64().unwrap() < 15.0, "{err}");
    // live: after a few volumes the 30-min position is close to the true one
    let r = runner::Runner::new(None, 1);
    r.set_cfg(runner::RunCfg { models: vec![runner::ModelRun::plain(&m.id)], ..Default::default() });
    let mut d = vec![];
    for _ in 0..4 {
        d = r.process_site(mock.as_ref(), "KTST", &[m.clone()], false).await;
    }
    assert!(!d.is_empty());
    let k = mock.live.load(std::sync::atomic::Ordering::SeqCst) as f64 - 1.0;
    let mut best = f64::MAX;
    for det in &d {
        let tr = det.track.as_ref().unwrap().as_array().unwrap();
        assert_eq!(tr.len(), 4);
        let p30 = &tr[1];
        assert_eq!(p30["lead_min"], 30.0);
        assert!(p30["cone_km"].as_f64().unwrap() > 0.0 && p30["strength_units"] == "kg/m²");
        // nearest true storm position 30 min later
        for s in mock.at(0, k * 5.0 + 30.0) {
            let (la, lo) = destination(SITE.0, SITE.1, s.0, s.1 * 1000.0);
            let e = crate::radar::geom::bearing_dist(la, lo, p30["lat"].as_f64().unwrap(), p30["lon"].as_f64().unwrap()).1 / 1000.0;
            best = best.min(e);
        }
    }
    assert!(best < 8.0, "30-min position error {best} km");
    let gj = { r.push_all(d); r.geojson(0, &[], None) };
    assert!(gj["features"].as_array().unwrap().iter().any(|f| f["properties"]["kind"] == "track" && f["geometry"]["type"] == "LineString"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn track_labels_follow_the_cell() {
    use super::cells::{Cell, VolCells};
    let mk = |t: i64, lon: f64| VolCells { key: format!("k{t}"), site: "KTST".into(), t, lat: 35.0, lon: -97.0, cells: vec![{
        let mut f = FeatMap::default();
        f.set("vil_max", 20.0 + (t / 60_000 % 100) as f32);
        f.set("ref_max", 55.0);
        Cell { id: "c".into(), lat: 35.5, lon, t, feats: f, hull: vec![], motion: None }
    }] };
    let t = 1_700_000_000_000;
    // 0.05° east per 5 min ≈ 4.5 km
    let mut v: Vec<VolCells> = (0..8).map(|k| mk(t + k * 300_000, -97.0 + k as f64 * 0.05)).collect();
    let ids = dataset::track(&mut v);
    let p = dataset::TrackParams { leads: vec![15.0, 30.0], strength: "vil".into() };
    let l = dataset::track_labels(&v, &ids, &p);
    let first: Vec<_> = l.iter().filter(|x| x.0 == 0).collect();
    assert_eq!(first.len(), 2);
    let dx15 = first.iter().find(|x| x.2 == 15.0).unwrap().3;
    assert!((dx15 - 3.0 * 0.05 * 111.32 * 35.5f64.to_radians().cos() as f32).abs() < 0.3, "{dx15}");
    assert!(v[1].cells[0].feats.get("motion_u_kt") > 20.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn instability_areas_by_level_and_shifted_frames() {
    let dir = tmpdir("instab");
    let grids = test_grids(&dir);
    let mock = Arc::new(GMock { grids: Some(grids.clone()) });
    let ml = Ml::new(&crate::config::MlCfg::default(), &dir, mock.clone(), None, false, 4000);
    let spec = json!({"target": "instability", "years": [2024, 2024], "max_events": 60, "null_days": 10, "filters": {"months": [4]},
        "region": {"bbox": [-104.0, 28.0, -88.0, 42.0]}, "sources": {"mrms": [], "metar": false, "model": [], "satellite": [], "fcst": ["cape"], "fcst_model": "gfs"},
        "max_samples": 0, "params": {"n_trees": 60}});
    let j = wait_job(&ml, &ml.submit(&spec).unwrap()).await;
    assert_eq!(j["state"], "done", "{j}");
    let m = ml.store.get(j["model_id"].as_str().unwrap()).unwrap();
    let issue = Utc.with_ymd_and_hms(2024, 4, 10, 18, 0, 0).unwrap().timestamp_millis();
    let o = runner::ModelRun { id: m.id.clone(), grid_res_deg: Some(0.5), threshold: Some(0.3), frame_step_h: Some(1.0), max_frames: Some(3), ..Default::default() };
    let out = ml.runner.run_grid_model(mock.as_ref(), &m, &o, issue, None).await.unwrap();
    assert_eq!(out.layers[0].valid_times, vec![issue, issue + H, issue + 2 * H]);
    let lv: std::collections::BTreeSet<String> = out.detections.iter().filter_map(|d| d.prob_level.map(|p| format!("{p:.3}"))).collect();
    eprintln!("{} areas, levels {lv:?}", out.detections.len());
    assert!(out.detections.iter().all(|d| d.kind == "area" && d.prob_level.is_some()));
    assert!(lv.len() >= 2, "{lv:?}");
    // areas off: only the layer
    let o2 = runner::ModelRun { areas: Some(false), ..o.clone() };
    assert!(ml.runner.run_grid_model(mock.as_ref(), &m, &o2, issue, None).await.unwrap().detections.is_empty());
    // outside the US: allowed (missing US-only inputs are NaN), flagged in the state
    let o3 = runner::ModelRun { id: m.id.clone(), grid_res_deg: Some(1.0), region: Some(labels::Region { states: vec![], bbox: Some([0.0, 40.0, 10.0, 50.0]) }), ..Default::default() };
    assert!(ml.runner.run_grid_model(mock.as_ref(), &m, &o3, issue, None).await.is_ok());
    assert_eq!(m.coverage()["outside_us"]["allowed"], true);
    assert_eq!(m.coverage()["outside_us"]["confidence"], "lower");
    let st = ml.runner.model_state.read().get(&m.id).cloned().unwrap();
    assert_eq!(st.coverage.unwrap()["confidence"], "lower");
    std::fs::remove_dir_all(&dir).ok();
}
