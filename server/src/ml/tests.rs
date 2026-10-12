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
    ml.runner.set_cfg(runner::RunCfg { models: vec![mid.clone()], radars: json!("all"), enabled: true, interval_s: 60 });
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
