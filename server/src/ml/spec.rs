//! Training specs, targets, presets and the `/api/ml/catalog` document.
//!
//! A spec is resolved in layers: target defaults ← preset ← the request's own fields (deep JSON
//! merge, unknown fields ignored, missing ones defaulted). So `{"preset":"tornado-quick"}`,
//! `{"target":"tornado"}` and a fully custom spec all work.

use super::cells::CellParams;
use super::features::{all_features_for, Sources, FC_VARS, HRRR_VARS, MODEL_VARS, MRMS_FIELDS, OTHER_FIELDS, SAT_FIELDS};
use super::labels::{Filters, MatchRule, Region};
use anyhow::{anyhow, bail, Result};
use chrono::Datelike;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

/// Grid-point sampling options.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GridOpts {
    /// hours before the event at which positives are sampled (e.g. 0, 12, 24, 36, 48 for genesis)
    pub lead_hours: Vec<f64>,
    /// exclusion radius (km) / window (h) around events for negatives
    pub exclude_km: f64,
    pub exclude_hours: f64,
    /// grid spacing (deg) used when running the model over a region
    pub run_spacing_deg: f64,
    /// minutes between runs of a grid-point model
    pub run_every_min: u64,
    /// max positives per day (fires)
    pub per_day: usize,
}

impl Default for GridOpts {
    fn default() -> Self {
        Self { lead_hours: vec![0.0], exclude_km: 100.0, exclude_hours: 24.0, run_spacing_deg: 0.5, run_every_min: 360, per_day: 10 }
    }
}

fn one_or_many<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::String(s) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        Value::Array(a) => a.into_iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => vec![],
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TrainSpec {
    pub preset: Option<String>,
    pub name: String,
    pub target: String,
    pub candidate: String,
    #[serde(deserialize_with = "one_or_many")]
    pub label_source: Vec<String>,
    pub years: [i32; 2],
    pub region: Region,
    pub filters: Filters,
    pub max_events: usize,
    /// negatives per positive
    pub neg_ratio: f64,
    /// storm cases with no target event (radar) added as negatives
    pub null_days: usize,
    #[serde(rename = "match")]
    pub match_rule: MatchRule,
    pub sources: Sources,
    /// feature ids to use (empty = all)
    pub features: Vec<String>,
    /// gbdt | logreg | mlp
    pub algo: String,
    pub params: Value,
    /// 0/1 = single grouped holdout, ≥ 2 = grouped k-fold CV
    pub cv_folds: usize,
    pub time_limit_min: Option<f64>,
    #[serde(rename = "where")]
    pub where_: String,
    /// radars sampled per event (nearest first)
    pub radars_per_event: usize,
    /// consecutive volumes per event (trend features use the previous one)
    pub volumes_per_event: usize,
    pub max_radar_km: f64,
    pub cell: CellParams,
    pub grid: GridOpts,
    pub seed: u64,
    pub labels: Vec<String>,
    pub notes: String,
    /// classification | regression ("" = the target's default)
    pub task: String,
    /// target-specific settings (see the catalog's `targets[].params`)
    pub target_params: Value,
    /// stratified cap on the number of samples (0 = no cap)
    pub max_samples: usize,
}

impl Default for TrainSpec {
    fn default() -> Self {
        let y = chrono::Utc::now().year();
        Self {
            preset: None,
            name: String::new(),
            target: "tornado".into(),
            candidate: "radar_cell".into(),
            label_source: vec!["spc_tornado".into()],
            years: [y - 3, y - 1],
            region: Region::default(),
            filters: Filters::default(),
            max_events: 150,
            neg_ratio: 4.0,
            null_days: 25,
            match_rule: MatchRule::default(),
            sources: Sources::default(),
            features: vec![],
            algo: "gbdt".into(),
            params: json!({}),
            cv_folds: 0,
            time_limit_min: None,
            where_: "server".into(),
            radars_per_event: 1,
            volumes_per_event: 3,
            max_radar_km: 150.0,
            cell: CellParams::default(),
            grid: GridOpts::default(),
            seed: 42,
            labels: vec![],
            notes: String::new(),
            task: String::new(),
            target_params: json!({}),
            max_samples: 0,
        }
    }
}

pub struct Target {
    pub id: &'static str,
    pub name: &'static str,
    pub candidate: &'static str,
    /// classification | regression (default task)
    pub task: &'static str,
    /// detections | grid | outlook
    pub output: &'static str,
    pub description: &'static str,
    /// partial spec JSON applied over the defaults
    pub defaults: fn(i32) -> Value,
}

fn radar_sources() -> Value {
    json!({"radar_products": ["REF", "VEL", "SW", "ZDR", "RHO", "PHI", "CREF", "ET", "VIL"], "mrms": [], "metar": false, "model": []})
}

const SEVERE_ENV: &[&str] = &["cape", "mucape", "mlcape", "cin", "lftx", "lftx4", "shear06", "srh01", "srh03", "pwat", "lapse75", "t500", "t850", "rh700", "hgt0c", "elev"];

pub const TARGETS: &[Target] = &[
    Target { id: "tornado", name: "Tornado", candidate: "radar_cell", task: "classification", output: "detections", description: "Storm cells that produce a tornado within the match window (default: within 10 km, from 30 min before to 10 min after).", defaults: |_| json!({"label_source": ["spc_tornado"], "sources": radar_sources()}) },
    Target { id: "supercell", name: "Supercell", candidate: "radar_cell", task: "classification", output: "detections", description: "Rotating, long-lived severe storms; labels = tornado or ≥ 1.5\" hail reports nearby (proxy).", defaults: |_| json!({"label_source": ["spc_tornado", "spc_hail"], "filters": {"min_size_in": 1.5}, "match": {"radius_km": 15.0, "before_min": 15.0, "after_min": 30.0}, "sources": radar_sources()}) },
    Target { id: "hail", name: "Hail ≥ 1\"", candidate: "radar_cell", task: "classification", output: "detections", description: "Cells producing severe hail (≥ 1 inch).", defaults: |_| json!({"label_source": ["spc_hail"], "filters": {"min_size_in": 1.0}, "match": {"radius_km": 12.0, "before_min": 10.0, "after_min": 20.0}, "sources": radar_sources()}) },
    Target { id: "sighail", name: "Significant hail ≥ 2\"", candidate: "radar_cell", task: "classification", output: "detections", description: "Cells producing significant hail (≥ 2 inches).", defaults: |_| json!({"label_source": ["spc_hail"], "filters": {"min_size_in": 2.0}, "match": {"radius_km": 12.0, "before_min": 10.0, "after_min": 20.0}, "sources": radar_sources()}) },
    Target { id: "wind", name: "Damaging wind", candidate: "radar_cell", task: "classification", output: "detections", description: "Cells producing severe wind (≥ 50 kt measured/estimated or damage).", defaults: |_| json!({"label_source": ["spc_wind"], "filters": {"min_wind_kt": 50.0}, "match": {"radius_km": 15.0, "before_min": 10.0, "after_min": 20.0}, "sources": radar_sources()}) },
    Target { id: "debris", name: "Tornado debris (TDS)", candidate: "radar_cell", task: "classification", output: "detections", description: "Cells with an ongoing (E)F2+ tornado — lofted debris (low CC, low ZDR) should be visible.", defaults: |_| json!({"label_source": ["spc_tornado"], "filters": {"min_mag": 2}, "match": {"radius_km": 8.0, "before_min": 5.0, "after_min": 0.0}, "sources": radar_sources()}) },
    Target { id: "storm_intensify", name: "Storm instability (intensifying cells)", candidate: "radar_cell", task: "classification", output: "detections", description: "Unstable storm cells likely to develop / intensify within the look-ahead: the same cell (tracked through later radar volumes) gains VIL or reflectivity, or produces a severe report. Self-supervised from radar loops around storm reports and null days.", defaults: |y| json!({"label_source": ["radar_tracks", "spc_hail", "spc_wind", "spc_tornado"], "years": [y - 2, y - 1], "volumes_per_event": 10, "max_events": 120, "null_days": 20, "match": {"radius_km": 15.0, "before_min": 10.0, "after_min": 60.0}, "sources": radar_sources(), "target_params": {"lead_min": 30.0, "criteria": "any", "dvil": 10.0, "dref": 5.0, "use_reports": true, "report_radius_km": 15.0}}) },
    Target { id: "flash_flood", name: "Flash flood", candidate: "grid_point", task: "classification", output: "detections", description: "Points with a flash-flood report within 1 h (MRMS QPE / FLASH features).", defaults: |y| json!({"label_source": ["iem_lsr"], "filters": {"lsr_types": ["F"]}, "years": [(y - 3).max(2021), y - 1], "max_events": 600, "neg_ratio": 5.0, "sources": {"mrms": ["qpe1h", "qpe6h", "prate", "flash_crest_unit", "flash_ari01h", "flash_ffg01h"], "metar": false, "model": ["pwat"]}, "grid": {"lead_hours": [0.0], "exclude_km": 50.0, "exclude_hours": 6.0, "run_spacing_deg": 0.1, "run_every_min": 10}}) },
    Target { id: "tropical_genesis", name: "Tropical storm formation (48 h)", candidate: "grid_point", task: "classification", output: "detections", description: "Disturbances that become a tropical storm within 48 h (HURDAT2 genesis, GFS analysis environment).", defaults: |y| json!({"label_source": ["hurdat_genesis"], "filters": {"basins": ["al", "ep"]}, "years": [2021, y - 1], "max_events": 400, "neg_ratio": 6.0, "region": {"bbox": [-180.0, 0.0, -10.0, 40.0]}, "sources": {"mrms": [], "metar": false, "model": ["absv850", "shear_850_200", "rh700", "sst", "mslp", "pwat", "mucape", "land"]}, "grid": {"lead_hours": [0.0, 12.0, 24.0, 36.0, 48.0], "exclude_km": 600.0, "exclude_hours": 72.0, "run_spacing_deg": 1.0, "run_every_min": 360}}) },
    Target { id: "tropical_possible", name: "Possible tropical formation", candidate: "grid_point", task: "classification", output: "detections", description: "Systems that become any tropical cyclone (first best-track fix) within 48 h.", defaults: |y| json!({"label_source": ["hurdat_first_fix"], "filters": {"basins": ["al", "ep"]}, "years": [2021, y - 1], "max_events": 400, "neg_ratio": 6.0, "region": {"bbox": [-180.0, 0.0, -10.0, 40.0]}, "sources": {"mrms": [], "metar": false, "model": ["absv850", "shear_850_200", "rh700", "sst", "mslp", "pwat", "mucape", "land"]}, "grid": {"lead_hours": [0.0, 12.0, 24.0, 36.0, 48.0], "exclude_km": 600.0, "exclude_hours": 72.0, "run_spacing_deg": 1.0, "run_every_min": 360}}) },
    Target { id: "wildfire", name: "Wildfire ignition", candidate: "grid_point", task: "classification", output: "detections", description: "New satellite fire detections (no detection nearby the previous day) vs. dry/windy environment.", defaults: |y| json!({"label_source": ["hms_fire"], "years": [y - 3, y - 1], "max_events": 600, "neg_ratio": 4.0, "filters": {"months": [3, 4, 5, 6, 7, 8, 9, 10, 11]}, "sources": {"mrms": [], "metar": true, "model": ["t2m", "rh2m", "td2m", "wind10", "gust", "soilw", "pwat", "cape", "land"]}, "grid": {"lead_hours": [0.0], "exclude_km": 25.0, "exclude_hours": 24.0, "run_spacing_deg": 0.25, "run_every_min": 360, "per_day": 15}}) },
    Target { id: "instability", name: "Atmospheric instability (strong storms possible)", candidate: "grid_point", task: "classification", output: "grid", description: "Probability that a strong storm occurs near a point soon: a severe report or a radar-indicated strong storm (MRMS composite ≥ 50 dBZ) within the radius in the next hours. GFS / HRRR / RAP-style instability and shear, satellite, MRMS and METAR features.", defaults: |y| json!({"label_source": ["spc_hail", "spc_wind", "spc_tornado", "mrms_cref"], "years": [(y - 2).max(2021), y - 1], "max_events": 400, "null_days": 80, "filters": {"min_size_in": 1.0, "min_wind_kt": 50.0, "months": [3, 4, 5, 6, 7, 8, 9]}, "sources": {"mrms": ["cref", "vil"], "metar": true, "model": SEVERE_ENV, "satellite": ["tb13_min", "ccf", "glm10"]}, "grid": {"run_spacing_deg": 0.25, "run_every_min": 60}, "max_samples": 40000, "target_params": {"hours": 3.0, "radius_km": 40.0, "use_reports": true, "use_radar": true, "radar_dbz": 50.0, "pts_per_case": 12}}) },
    Target { id: "temp_forecast", name: "Temperature forecast", candidate: "grid_point", task: "regression", output: "grid", description: "2 m temperature (°C) at each lead, trained against the URMA analysis (METAR fallback) with current analyses, NWP forecasts valid at the lead time (MOS-like), climatology and satellite. Runs as a weather layer.", defaults: |y| json!({"label_source": ["urma_t2m"], "years": [(y - 1).max(2021), y - 1], "max_events": 150, "sources": {"mrms": [], "metar": true, "model": ["t2m", "td2m", "elev", "land", "soilw", "snod"], "fcst": ["t2m", "td2m", "tcc", "wind10", "apcp", "rh2m"], "fcst_model": "gfs"}, "grid": {"run_spacing_deg": 0.25, "run_every_min": 60}, "max_samples": 40000, "params": {"loss": "squared"}, "target_params": {"leads": [1.0, 3.0, 6.0, 12.0, 24.0], "pts_per_case": 60}}) },
    Target { id: "precip_forecast", name: "Precipitation forecast", candidate: "grid_point", task: "regression", output: "grid", description: "Accumulated precipitation (mm) over the next window (1/3/6/24 h), trained against MRMS MultiSensor QPE pass 2 with radar, NWP QPF, moisture and satellite features. Runs as a weather layer.", defaults: |y| json!({"label_source": ["mrms_qpe"], "years": [(y - 1).max(2021), y - 1], "max_events": 150, "sources": {"mrms": ["qpe1h", "qpe6h", "prate", "cref"], "metar": false, "model": ["pwat", "elev"], "fcst": ["apcp", "pwat", "cape", "refc"], "fcst_model": "gfs", "satellite": ["tb13_min", "ccf"]}, "grid": {"run_spacing_deg": 0.25, "run_every_min": 60}, "max_samples": 40000, "params": {"loss": "huber", "huber_delta": 2.0}, "target_params": {"leads": [1.0, 3.0, 6.0, 24.0], "pts_per_case": 80, "wet_min_mm": 0.25, "wet_frac": 0.5}}) },
    Target { id: "storm_forecast", name: "Storm forecast", candidate: "grid_point", task: "classification", output: "grid", description: "Probability of a storm (MRMS composite reflectivity ≥ the threshold, or GLM lightning) within the radius during the hour ending at each lead; regression mode predicts the max reflectivity (dBZ). Runs as a weather layer.", defaults: |y| json!({"label_source": ["mrms_cref"], "years": [(y - 1).max(2021), y - 1], "max_events": 150, "filters": {"months": [4, 5, 6, 7, 8, 9]}, "sources": {"mrms": ["cref", "vil", "et18", "prate"], "metar": true, "model": ["cape", "mucape", "cin", "shear06", "pwat", "lftx"], "fcst": ["refc", "cape", "apcp"], "fcst_model": "auto", "satellite": ["tb13_min", "ccf", "cool13", "glm10"]}, "grid": {"run_spacing_deg": 0.125, "run_every_min": 30}, "max_samples": 40000, "target_params": {"leads": [1.0, 3.0, 6.0], "window_h": 1.0, "radius_km": 25.0, "dbz": 40.0, "truth": "cref", "pts_per_case": 60}}) },
    Target { id: "tropical_forecast", name: "Tropical development", candidate: "grid_point", task: "classification", output: "grid", description: "Probability that a tropical cyclone forms within the radius of a point within 2 / 5 / 7 days (HURDAT2), from GFS analyses and forecasts (vorticity, shear, SST, mid-level humidity, pressure tendency) and GOES cold-cloud coverage. Output grid over the basins plus NHC-style areas.", defaults: |y| json!({"label_source": ["hurdat_genesis"], "filters": {"basins": ["al", "ep"], "months": [5, 6, 7, 8, 9, 10, 11]}, "years": [2021, y - 1], "max_events": 300, "null_days": 150, "region": {"bbox": [-160.0, 0.0, -10.0, 40.0]}, "sources": {"mrms": [], "metar": false, "model": ["absv850", "absv700", "shear_850_200", "rh700", "rh500", "sst", "mslp", "pwat", "mucape", "land", "vvel500"], "fcst": ["absv850", "mslp_min", "shear_850_200", "rh700"], "fcst_model": "gfs", "fcst_step_h": 12, "satellite": ["tb13_min", "ccf"]}, "grid": {"run_spacing_deg": 0.5, "run_every_min": 360}, "max_samples": 40000, "target_params": {"lead_days": [2.0], "radius_km": 300.0, "genesis": "ts", "pts_per_case": 25}}) },
    Target { id: "outlook", name: "Severe weather outlook (SPC-style)", candidate: "grid_point", task: "classification", output: "outlook", description: "Probability of severe reports (tornado / wind / hail / any) within 25 mi (40 km) of a point during a 12Z–12Z day (Day 1, 2, 3 or the Day 4–7 window, or a custom window), from GFS (and HRRR for day 1) forecast fields over the window plus climatology. Runs as categorical outlook polygons (TSTM … HIGH) and a probability layer.", defaults: |y| json!({"label_source": ["spc_tornado", "spc_hail", "spc_wind"], "filters": {"min_size_in": 1.0, "min_wind_kt": 50.0}, "years": [(y - 3).max(2021), y - 1], "max_events": 120, "null_days": 60, "neg_ratio": 4.0, "sources": {"mrms": [], "metar": false, "model": ["elev", "land"], "fcst": ["cape", "mucape", "mlcape", "srh03", "srh01", "shear06", "apcp", "lftx", "pwat", "lapse75", "td2m", "refc"], "fcst_model": "gfs"}, "grid": {"run_spacing_deg": 0.5, "run_every_min": 360}, "max_samples": 60000, "target_params": {"hazard": "any", "day": "1", "radius_km": 40.0, "grid_deg": 1.0}}) },
    Target { id: "flood_forecast", name: "Flood risk", candidate: "grid_point", task: "classification", output: "grid", description: "Areas that could flood soon: a flood / flash-flood report (or warning) within the radius in the next hours, from MRMS QPE 1–24 h, FLASH (CREST streamflow, return period, QPE/FFG), soil moisture, NWP QPF for the next hours, terrain and drought.", defaults: |y| json!({"label_source": ["iem_lsr"], "filters": {"lsr_types": ["F", "E"]}, "years": [(y - 2).max(2021), y - 1], "max_events": 400, "null_days": 60, "sources": {"mrms": ["qpe1h", "qpe3h", "qpe6h", "qpe24h", "prate", "flash_crest_unit", "flash_ari01h", "flash_ari06h", "flash_ffg01h", "flash_ffg06h"], "metar": false, "model": ["soilw", "soilw2", "pwat", "elev"], "fcst": ["apcp", "pwat"], "fcst_model": "auto", "other": ["drought"]}, "grid": {"run_spacing_deg": 0.125, "run_every_min": 30}, "max_samples": 40000, "target_params": {"hours": 6.0, "radius_km": 25.0, "use_warnings": false, "pts_per_case": 12}}) },
    Target { id: "custom", name: "Custom", candidate: "radar_cell", task: "classification", output: "detections", description: "Pick any label source and candidate type.", defaults: |_| json!({"sources": radar_sources()}) },
];

/// Target-specific settings (for the catalog): id, name, type, default, min, max, choices, help.
pub fn target_params(id: &str) -> Value {
    let p = |id: &str, name: &str, ty: &str, def: Value, min: Value, max: Value, choices: Value, help: &str| json!({"id": id, "name": name, "type": ty, "default": def, "min": min, "max": max, "choices": choices, "help": help});
    let n = Value::Null;
    match id {
        "storm_intensify" => json!([
            p("lead_min", "Look-ahead", "float", json!(30.0), json!(5.0), json!(120.0), n.clone(), "Minutes ahead in which the cell must intensify (matched to the volume nearest that time)"),
            p("criteria", "Criteria", "choice", json!("any"), n.clone(), n.clone(), json!(["any", "vil", "ref", "both"]), "Which increase counts: VIL, max reflectivity, either, or both"),
            p("dvil", "ΔVIL ≥", "float", json!(10.0), json!(0.0), json!(80.0), n.clone(), "kg/m²"),
            p("dref", "ΔREF max ≥", "float", json!(5.0), json!(0.0), json!(30.0), n.clone(), "dB"),
            p("use_reports", "Severe reports count", "bool", json!(true), n.clone(), n.clone(), n.clone(), "Also positive when a severe report (label sources) occurs near the cell within the look-ahead"),
            p("report_radius_km", "Report radius", "float", json!(15.0), json!(2.0), json!(60.0), n.clone(), "km"),
        ]),
        "instability" => json!([
            p("hours", "Window", "float", json!(3.0), json!(0.5), json!(24.0), n.clone(), "Hours after the analysis time"),
            p("radius_km", "Radius", "float", json!(40.0), json!(5.0), json!(200.0), n.clone(), "km around the point"),
            p("use_reports", "Severe reports", "bool", json!(true), n.clone(), n.clone(), n.clone(), "Severe reports (label sources) are positives"),
            p("use_radar", "Radar-indicated storms", "bool", json!(true), n.clone(), n.clone(), n.clone(), "MRMS composite reflectivity ≥ the threshold is a positive"),
            p("radar_dbz", "Radar threshold", "float", json!(50.0), json!(30.0), json!(70.0), n.clone(), "dBZ"),
            p("pts_per_case", "Points per case", "int", json!(12), json!(1), json!(500), n.clone(), "Extra random points sampled around each case"),
        ]),
        "flood_forecast" => json!([
            p("hours", "Window", "float", json!(6.0), json!(1.0), json!(48.0), n.clone(), "Hours after the analysis time"),
            p("radius_km", "Radius", "float", json!(25.0), json!(5.0), json!(150.0), n.clone(), "km"),
            p("use_warnings", "Flash-flood warnings", "bool", json!(false), n.clone(), n.clone(), n.clone(), "Also count NWS flash-flood warning polygons (IEM) as positives"),
            p("pts_per_case", "Points per case", "int", json!(12), json!(1), json!(500), n.clone(), "Extra random points sampled around each case"),
        ]),
        "temp_forecast" => json!([
            p("leads", "Leads", "hours_list", json!([1.0, 3.0, 6.0, 12.0, 24.0]), json!(0.0), json!(240.0), n.clone(), "Forecast hours; one model covers all leads (lead time is a feature)"),
            p("pts_per_case", "Points per time", "int", json!(60), json!(5), json!(2000), n.clone(), "Random points per sampled time"),
        ]),
        "precip_forecast" => json!([
            p("leads", "Accumulation windows", "hours_list", json!([1.0, 3.0, 6.0, 24.0]), json!(1.0), json!(72.0), n.clone(), "Hours from now; the label is the total over (now, now + window]"),
            p("pts_per_case", "Points per time", "int", json!(80), json!(5), json!(2000), n.clone(), "Random points per sampled time"),
            p("wet_min_mm", "Wet threshold", "float", json!(0.25), json!(0.0), json!(10.0), n.clone(), "mm; wet samples are over-sampled"),
            p("wet_frac", "Wet share", "float", json!(0.5), json!(0.0), json!(1.0), n.clone(), "Target share of wet samples after sampling"),
        ]),
        "storm_forecast" => json!([
            p("leads", "Leads", "hours_list", json!([1.0, 3.0, 6.0]), json!(0.5), json!(48.0), n.clone(), "Hours; the window is the `window_h` ending at each lead"),
            p("window_h", "Window", "float", json!(1.0), json!(0.25), json!(12.0), n.clone(), "Hours"),
            p("radius_km", "Radius", "float", json!(25.0), json!(0.0), json!(100.0), n.clone(), "km"),
            p("dbz", "Reflectivity threshold", "float", json!(40.0), json!(20.0), json!(65.0), json!([30.0, 40.0, 50.0]), "dBZ (classification)"),
            p("truth", "Storm truth", "choice", json!("cref"), n.clone(), n.clone(), json!(["cref", "glm"]), "MRMS composite reflectivity or GOES GLM lightning"),
            p("pts_per_case", "Points per time", "int", json!(60), json!(5), json!(2000), n.clone(), "Random points per sampled time"),
        ]),
        "tropical_forecast" => json!([
            p("lead_days", "Windows", "days_list", json!([2.0]), json!(0.5), json!(10.0), json!([2.0, 5.0, 7.0]), "Formation within this many days (one model can cover several)"),
            p("radius_km", "Radius", "float", json!(300.0), json!(50.0), json!(1000.0), n.clone(), "km"),
            p("genesis", "Formation", "choice", json!("ts"), n.clone(), n.clone(), json!(["ts", "any"]), "Tropical-storm strength or any tropical cyclone (first fix)"),
            p("pts_per_case", "Points per case", "int", json!(25), json!(1), json!(500), n.clone(), "Random ocean points per sampled time"),
        ]),
        "outlook" => json!([
            p("hazard", "Hazard", "choice", json!("any"), n.clone(), n.clone(), json!(["any", "tornado", "wind", "hail"]), "Reports counted as positives"),
            p("day", "Day", "choice", json!("1"), n.clone(), n.clone(), json!(["1", "2", "3", "4-7", "custom"]), "Day 1–3 (12Z–12Z), the Day 4–7 window, or custom (offset_h / window_h)"),
            p("offset_h", "Custom offset", "float", json!(6.0), json!(0.0), json!(240.0), n.clone(), "Hours from the issue time to the window start (day = custom)"),
            p("window_h", "Custom window", "float", json!(24.0), json!(1.0), json!(240.0), n.clone(), "Window length in hours (day = custom)"),
            p("radius_km", "Radius", "float", json!(40.0), json!(10.0), json!(150.0), n.clone(), "Practically-perfect neighbourhood (SPC uses 25 mi)"),
            p("grid_deg", "Training grid", "float", json!(1.0), json!(0.25), json!(3.0), n.clone(), "Spacing of the candidate points per day (degrees)"),
        ]),
        _ => json!([]),
    }
}

/// Outlook hazards (sub-targets) and storm thresholds.
pub fn subtargets(id: &str) -> Value {
    match id {
        "outlook" => json!([{"id": "any", "name": "Any severe"}, {"id": "tornado", "name": "Tornado"}, {"id": "wind", "name": "Wind"}, {"id": "hail", "name": "Hail"}]),
        "storm_forecast" => json!([{"id": "30", "name": "≥ 30 dBZ"}, {"id": "40", "name": "≥ 40 dBZ"}, {"id": "50", "name": "≥ 50 dBZ"}, {"id": "glm", "name": "Lightning (GLM)"}]),
        "tropical_forecast" => json!([{"id": "2", "name": "2 days"}, {"id": "5", "name": "5 days"}, {"id": "7", "name": "7 days"}]),
        _ => Value::Null,
    }
}

/// Units and colour map of a target's grid output.
pub fn output_field(target: &str, task: &str) -> (&'static str, &'static str, &'static str) {
    match (target, task) {
        ("temp_forecast", _) => ("t2m", "°C", "TEMP"),
        ("precip_forecast", _) => ("qpe", "mm", "PRECIPMM"),
        ("storm_forecast", "regression") => ("cref", "dBZ", "REF"),
        _ => ("prob", "%", "PROB"),
    }
}

pub fn target(id: &str) -> Option<&'static Target> {
    TARGETS.iter().find(|t| t.id == id)
}

pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub target: &'static str,
    pub spec: fn(i32) -> Value,
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "tornado-quick", name: "Tornado — quick (last 3 seasons, 150 events, GBDT)", target: "tornado", spec: |y| json!({"name": "Tornado (quick)", "years": [y - 3, y - 1], "max_events": 150, "null_days": 25, "neg_ratio": 4.0, "volumes_per_event": 3, "radars_per_event": 1, "algo": "gbdt", "cv_folds": 0}) },
    Preset { id: "tornado-thorough", name: "Tornado — thorough (2013–last year, 1500 events, 5-fold CV, tuned GBDT)", target: "tornado", spec: |y| json!({"name": "Tornado (thorough)", "years": [2013, y - 1], "max_events": 1500, "null_days": 300, "neg_ratio": 5.0, "volumes_per_event": 4, "radars_per_event": 2, "algo": "gbdt", "cv_folds": 5, "sources": {"mrms": ["azs02", "mesh"], "metar": true, "model": []}, "params": {"n_trees": 1500, "learning_rate": 0.03, "max_depth": 6, "min_child_weight": 3.0, "subsample": 0.8, "colsample": 0.7, "lambda": 2.0, "max_bins": 128, "early_stopping_rounds": 80}}) },
    Preset { id: "supercell", name: "Supercell (rotation + hail proxies; labels: tornado or ≥ 1.5\" hail)", target: "supercell", spec: |y| json!({"name": "Supercell", "years": [y - 3, y - 1], "max_events": 250, "null_days": 30, "algo": "gbdt"}) },
    Preset { id: "hail-large", name: "Large hail (≥ 1\")", target: "hail", spec: |y| json!({"name": "Large hail", "years": [y - 3, y - 1], "max_events": 250, "null_days": 30, "algo": "gbdt"}) },
    Preset { id: "hail-significant", name: "Significant hail (≥ 2\")", target: "sighail", spec: |y| json!({"name": "Significant hail", "years": [y - 4, y - 1], "max_events": 250, "null_days": 30, "algo": "gbdt"}) },
    Preset { id: "wind-damaging", name: "Damaging wind", target: "wind", spec: |y| json!({"name": "Damaging wind", "years": [y - 3, y - 1], "max_events": 250, "null_days": 30, "algo": "gbdt"}) },
    Preset { id: "tds", name: "Tornado debris signature (EF2+)", target: "debris", spec: |y| json!({"name": "Tornado debris", "years": [2013, y - 1], "max_events": 250, "null_days": 30, "volumes_per_event": 2, "algo": "gbdt"}) },
    Preset { id: "tropical-genesis", name: "Tropical genesis (Atlantic + E Pacific, GFS analysis features)", target: "tropical_genesis", spec: |_| json!({"name": "Tropical genesis", "algo": "gbdt"}) },
    Preset { id: "wildfire-ignition", name: "Wildfire ignition (HMS + METAR / model dryness)", target: "wildfire", spec: |_| json!({"name": "Wildfire ignition", "algo": "gbdt"}) },
    Preset { id: "flash-flood", name: "Flash flood (MRMS QPE / FLASH + reports)", target: "flash_flood", spec: |_| json!({"name": "Flash flood", "algo": "gbdt"}) },
    // storm instability (intensifying cells)
    Preset { id: "storm-intensify-quick", name: "Storm instability — quick (intensify within 30 min; 2 seasons, 120 cases)", target: "storm_intensify", spec: |y| json!({"name": "Intensifying storms (quick)", "years": [y - 2, y - 1], "max_events": 120, "null_days": 20, "volumes_per_event": 10, "algo": "gbdt", "params": {"n_trees": 300}}) },
    Preset { id: "storm-intensify-thorough", name: "Storm instability — thorough (2019+, 1000 cases, MRMS + GOES + HRRR, 5-fold CV)", target: "storm_intensify", spec: |y| json!({"name": "Intensifying storms (thorough)", "years": [2019, y - 1], "max_events": 1000, "null_days": 200, "volumes_per_event": 12, "cv_folds": 5, "sources": {"mrms": ["azs02", "mesh", "vil", "et18", "posh"], "metar": true, "model": [], "hrrr": ["mlcape", "mucape", "cin", "shear06", "srh01", "srh03", "uh25"], "satellite": ["tb13_min", "ccf", "cool13", "glm10", "glm30", "glm_jump"]}, "params": {"n_trees": 1200, "learning_rate": 0.03, "max_depth": 6, "early_stopping_rounds": 80}}) },
    // general instability
    Preset { id: "instability-quick", name: "Instability — quick (3 h / 40 km; 2 seasons, GFS + MRMS + METAR + GOES)", target: "instability", spec: |y| json!({"name": "Instability (quick)", "years": [(y - 2).max(2021), y - 1], "max_events": 250, "null_days": 50, "max_samples": 20000, "algo": "gbdt"}) },
    Preset { id: "instability-thorough", name: "Instability — thorough (2021+, HRRR analyses + HRRR forecasts, GOES/GLM, 5-fold CV)", target: "instability", spec: |y| json!({"name": "Instability (thorough)", "years": [2021, y - 1], "max_events": 2500, "null_days": 400, "max_samples": 200000, "cv_folds": 5, "sources": {"mrms": ["cref", "vil", "mesh", "azs02", "et18"], "metar": true, "model": SEVERE_ENV, "hrrr": ["cape", "mlcape", "mucape", "cin", "mlcin", "srh01", "srh03", "shear06", "shear01", "uh25", "refc", "ltng", "pwat", "lcl"], "fcst": ["cape", "shear06", "uh25", "refc", "srh01"], "fcst_model": "hrrr", "satellite": ["tb13", "tb13_min", "ccf", "cool13", "wv8", "wv10", "glm10", "glm30", "glm_jump"]}, "params": {"n_trees": 1500, "learning_rate": 0.03, "max_depth": 6, "early_stopping_rounds": 80}}) },
    // weather-layer forecasts
    Preset { id: "temp-forecast-quick", name: "Temperature — quick (leads 1–24 h, last season, GFS MOS-like)", target: "temp_forecast", spec: |y| json!({"name": "Temperature forecast (quick)", "years": [(y - 1).max(2021), y - 1], "max_events": 100, "max_samples": 25000, "algo": "gbdt", "params": {"n_trees": 400, "loss": "squared"}}) },
    Preset { id: "temp-forecast-thorough", name: "Temperature — thorough (3 years, HRRR ≤ 18 h else GFS, satellite, P10/P90, 5-fold CV)", target: "temp_forecast", spec: |y| json!({"name": "Temperature forecast (thorough)", "years": [(y - 3).max(2021), y - 1], "max_events": 1200, "max_samples": 250000, "cv_folds": 5, "sources": {"metar": true, "model": ["t2m", "td2m", "elev", "land", "soilw", "snod", "mslp", "wind10", "t850"], "hrrr": ["t2m", "td2m"], "fcst": ["t2m", "td2m", "tcc", "wind10", "apcp", "rh2m", "tmax", "tmin", "t850", "mslp"], "fcst_model": "auto", "satellite": ["tb13", "ccf"]}, "params": {"n_trees": 1500, "learning_rate": 0.03, "max_depth": 7, "loss": "squared", "quantiles": [0.1, 0.9], "early_stopping_rounds": 80}}) },
    Preset { id: "precip-forecast-quick", name: "Precipitation — quick (1/3/6/24 h totals, last season)", target: "precip_forecast", spec: |y| json!({"name": "Precipitation forecast (quick)", "years": [(y - 1).max(2021), y - 1], "max_events": 100, "max_samples": 25000, "algo": "gbdt", "params": {"n_trees": 400, "loss": "huber", "huber_delta": 2.0}}) },
    Preset { id: "precip-forecast-thorough", name: "Precipitation — thorough (3 years, HRRR/GFS QPF, MRMS, GOES, P10/P90)", target: "precip_forecast", spec: |y| json!({"name": "Precipitation forecast (thorough)", "years": [(y - 3).max(2021), y - 1], "max_events": 1200, "max_samples": 250000, "cv_folds": 5, "sources": {"mrms": ["qpe1h", "qpe3h", "qpe6h", "qpe24h", "prate", "cref", "vil", "et18"], "model": ["pwat", "elev", "rh700", "cape"], "hrrr": ["pwat", "refc", "apcp1h"], "fcst": ["apcp", "pwat", "cape", "refc", "tcc", "rh700"], "fcst_model": "auto", "satellite": ["tb13", "tb13_min", "ccf", "cool13", "wv9", "glm10"]}, "params": {"n_trees": 1500, "learning_rate": 0.03, "max_depth": 7, "loss": "huber", "huber_delta": 2.0, "quantiles": [0.1, 0.9], "early_stopping_rounds": 80}}) },
    Preset { id: "storm-forecast-quick", name: "Storms — quick (P(≥ 40 dBZ within 25 km), leads 1/3/6 h)", target: "storm_forecast", spec: |y| json!({"name": "Storm forecast (quick)", "years": [(y - 1).max(2021), y - 1], "max_events": 100, "max_samples": 25000, "algo": "gbdt", "params": {"n_trees": 400}}) },
    Preset { id: "storm-forecast-thorough", name: "Storms — thorough (3 seasons, HRRR, GOES + GLM, 5-fold CV)", target: "storm_forecast", spec: |y| json!({"name": "Storm forecast (thorough)", "years": [(y - 3).max(2021), y - 1], "max_events": 1200, "max_samples": 250000, "cv_folds": 5, "sources": {"mrms": ["cref", "vil", "et18", "et50", "prate", "mesh", "azs02"], "metar": true, "model": ["cape", "mucape", "cin", "shear06", "pwat", "lftx", "lapse75"], "hrrr": ["mlcape", "mlcin", "shear06", "srh03", "uh25", "refc", "ltng"], "fcst": ["refc", "cape", "apcp", "uh25", "ltng"], "fcst_model": "auto", "satellite": ["tb13", "tb13_min", "ccf", "cool13", "wv8", "glm10", "glm30", "glm_jump"]}, "params": {"n_trees": 1500, "learning_rate": 0.03, "max_depth": 7, "early_stopping_rounds": 80}}) },
    // tropical
    Preset { id: "tropical-forecast-2day", name: "Tropical development — 2 days (Atlantic + E Pacific)", target: "tropical_forecast", spec: |_| json!({"name": "Tropical development (2 day)", "max_events": 250, "max_samples": 25000, "target_params": {"lead_days": [2.0]}}) },
    Preset { id: "tropical-forecast-7day", name: "Tropical development — 7 days", target: "tropical_forecast", spec: |_| json!({"name": "Tropical development (7 day)", "max_events": 250, "max_samples": 25000, "target_params": {"lead_days": [7.0]}, "sources": {"fcst_step_h": 24}}) },
    Preset { id: "tropical-forecast-thorough", name: "Tropical development — thorough (2/5/7 days in one model, more cases, 5-fold CV)", target: "tropical_forecast", spec: |_| json!({"name": "Tropical development (thorough)", "max_events": 1000, "null_days": 600, "max_samples": 200000, "cv_folds": 5, "target_params": {"lead_days": [2.0, 5.0, 7.0]}, "sources": {"fcst_step_h": 24}, "params": {"n_trees": 1200, "learning_rate": 0.03, "early_stopping_rounds": 80}}) },
    // outlooks
    Preset { id: "outlook-day1", name: "Outlook — Day 1 (any severe, 12Z–12Z)", target: "outlook", spec: |_| json!({"name": "Outlook Day 1", "target_params": {"day": "1", "hazard": "any"}}) },
    Preset { id: "outlook-day2", name: "Outlook — Day 2", target: "outlook", spec: |_| json!({"name": "Outlook Day 2", "target_params": {"day": "2", "hazard": "any"}}) },
    Preset { id: "outlook-day3", name: "Outlook — Day 3", target: "outlook", spec: |_| json!({"name": "Outlook Day 3", "target_params": {"day": "3", "hazard": "any"}}) },
    Preset { id: "outlook-day4-7", name: "Outlook — Day 4–7 (one window, lower accuracy)", target: "outlook", spec: |_| json!({"name": "Outlook Day 4-7", "target_params": {"day": "4-7", "hazard": "any"}, "sources": {"fcst_step_h": 12}}) },
    Preset { id: "outlook-day1-tornado", name: "Outlook — Day 1 tornado", target: "outlook", spec: |_| json!({"name": "Outlook Day 1 tornado", "label_source": ["spc_tornado"], "target_params": {"day": "1", "hazard": "tornado"}}) },
    Preset { id: "outlook-day1-wind", name: "Outlook — Day 1 wind", target: "outlook", spec: |_| json!({"name": "Outlook Day 1 wind", "label_source": ["spc_wind"], "target_params": {"day": "1", "hazard": "wind"}}) },
    Preset { id: "outlook-day1-hail", name: "Outlook — Day 1 hail", target: "outlook", spec: |_| json!({"name": "Outlook Day 1 hail", "label_source": ["spc_hail"], "target_params": {"day": "1", "hazard": "hail"}}) },
    Preset { id: "outlook-thorough", name: "Outlook — Day 1 thorough (2021+, HRRR + GFS, 5-fold CV)", target: "outlook", spec: |y| json!({"name": "Outlook Day 1 (thorough)", "years": [2021, y - 1], "max_events": 900, "null_days": 400, "max_samples": 300000, "cv_folds": 5, "sources": {"fcst": ["cape", "mucape", "mlcape", "srh03", "srh01", "shear06", "apcp", "lftx", "pwat", "lapse75", "td2m", "refc", "uh25"], "fcst_model": "auto"}, "target_params": {"day": "1", "grid_deg": 0.5}, "params": {"n_trees": 1500, "learning_rate": 0.03, "early_stopping_rounds": 80}}) },
    // floods
    Preset { id: "flood-quick", name: "Flood risk — quick (6 h / 25 km; 2 seasons)", target: "flood_forecast", spec: |y| json!({"name": "Flood risk (quick)", "years": [(y - 2).max(2021), y - 1], "max_events": 250, "null_days": 40, "max_samples": 20000}) },
    Preset { id: "flood-thorough", name: "Flood risk — thorough (2021+, warnings, HRRR QPF, 5-fold CV)", target: "flood_forecast", spec: |y| json!({"name": "Flood risk (thorough)", "years": [2021, y - 1], "label_source": ["iem_lsr", "iem_sbw"], "filters": {"phenomena": ["FF"]}, "max_events": 2000, "null_days": 300, "max_samples": 200000, "cv_folds": 5, "target_params": {"use_warnings": true}, "sources": {"mrms": ["qpe1h", "qpe3h", "qpe6h", "qpe12h", "qpe24h", "qpe72h", "prate", "flash_crest_unit", "flash_crest_q", "flash_soil", "flash_ari01h", "flash_ari03h", "flash_ari06h", "flash_ffg01h", "flash_ffg03h", "flash_ffg06h"], "hrrr": ["apcp1h", "pwat"], "fcst": ["apcp", "pwat", "refc"], "fcst_model": "auto", "satellite": ["tb13_min", "ccf"]}, "params": {"n_trees": 1200, "learning_rate": 0.03, "early_stopping_rounds": 80}}) },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// Deep merge: objects merge key by key, everything else replaces.
pub fn merge(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Object(d), Value::Object(s)) => {
            for (k, v) in s {
                if v.is_null() {
                    continue;
                }
                match d.get_mut(k) {
                    Some(dv) if dv.is_object() && v.is_object() => merge(dv, v),
                    _ => {
                        d.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (d, s) => *d = s.clone(),
    }
}

/// Resolve a request body into a full spec.
pub fn resolve(raw: &Value) -> Result<TrainSpec> {
    let y = chrono::Utc::now().year();
    let raw = if raw.is_object() { raw.clone() } else { json!({}) };
    let preset_id = raw.get("preset").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let p = match preset_id {
        Some(id) => Some(preset(id).ok_or_else(|| anyhow!("unknown preset {id}"))?),
        None => None,
    };
    let target_id = raw.get("target").and_then(|v| v.as_str()).map(str::to_string).or(p.map(|p| p.target.to_string())).unwrap_or_else(|| "tornado".into());
    let t = target(&target_id).ok_or_else(|| anyhow!("unknown target {target_id}"))?;
    let mut v = serde_json::to_value(TrainSpec::default())?;
    merge(&mut v, &json!({"target": t.id, "candidate": t.candidate, "name": t.name}));
    merge(&mut v, &(t.defaults)(y));
    if let Some(p) = p {
        merge(&mut v, &(p.spec)(y));
        merge(&mut v, &json!({"preset": p.id}));
    }
    // a request's own params replace (not merge into) the preset's
    let mut req = raw.clone();
    if let Some(prm) = req.get("params").cloned() {
        v["params"] = prm;
        req.as_object_mut().unwrap().remove("params");
    }
    merge(&mut v, &req);
    let mut s: TrainSpec = serde_json::from_value(v).map_err(|e| anyhow!("bad training spec: {e}"))?;
    s.validate()?;
    Ok(s)
}

impl TrainSpec {
    pub fn validate(&mut self) -> Result<()> {
        if !matches!(self.candidate.as_str(), "radar_cell" | "grid_point") {
            bail!("candidate must be radar_cell or grid_point");
        }
        if !matches!(self.algo.as_str(), "gbdt" | "logreg" | "mlp") {
            bail!("algo must be gbdt, logreg or mlp");
        }
        let t = target(&self.target).ok_or_else(|| anyhow!("unknown target {}", self.target))?;
        if self.task.is_empty() {
            self.task = t.task.into();
        }
        if !matches!(self.task.as_str(), "classification" | "regression") {
            bail!("task must be classification or regression");
        }
        if self.task == "regression" && !matches!(self.target.as_str(), "temp_forecast" | "precip_forecast" | "storm_forecast") {
            bail!("regression is available for temp_forecast, precip_forecast and storm_forecast");
        }
        if matches!(self.target.as_str(), "temp_forecast" | "precip_forecast") && self.task != "regression" {
            bail!("{} is a regression target", self.target);
        }
        if !self.target_params.is_object() {
            self.target_params = json!({});
        }
        if self.label_source.is_empty() {
            bail!("label_source required");
        }
        for l in &self.label_source {
            if !super::labels::SOURCES.iter().any(|s| s.0 == l) {
                bail!("unknown label source {l}");
            }
        }
        if t.output != "detections" && self.candidate != t.candidate {
            bail!("{} uses {} candidates", t.id, t.candidate);
        }
        self.max_samples = self.max_samples.min(5_000_000);
        if self.years[0] > self.years[1] {
            self.years.swap(0, 1);
        }
        let y = chrono::Utc::now().year();
        self.years[0] = self.years[0].clamp(1950, y);
        self.years[1] = self.years[1].clamp(1950, y);
        self.max_events = self.max_events.clamp(1, 100_000);
        self.neg_ratio = self.neg_ratio.clamp(0.2, 100.0);
        self.null_days = self.null_days.min(20_000);
        self.cv_folds = self.cv_folds.min(10);
        self.radars_per_event = self.radars_per_event.clamp(1, 3);
        self.volumes_per_event = self.volumes_per_event.clamp(1, 12);
        self.max_radar_km = self.max_radar_km.clamp(20.0, 300.0);
        self.match_rule.radius_km = self.match_rule.radius_km.clamp(0.5, 200.0);
        self.match_rule.before_min = self.match_rule.before_min.clamp(0.0, 24.0 * 60.0);
        self.match_rule.after_min = self.match_rule.after_min.clamp(0.0, 24.0 * 60.0);
        if let Some(t) = self.time_limit_min {
            if !(t > 0.0) {
                self.time_limit_min = None;
            }
        }
        self.sources = self.sources.normalized();
        if self.name.trim().is_empty() {
            self.name = target(&self.target).map(|t| t.name.to_string()).unwrap_or_else(|| "Model".into());
        }
        if self.target == "custom" && self.candidate == "grid_point" && self.grid == GridOpts::default() {
            self.grid.exclude_km = 50.0;
        }
        Ok(())
    }
}

/// Every run option of `POST /api/ml/run` (per model), for generic rendering.
pub fn run_params() -> Value {
    let all = TARGETS.iter().map(|t| t.id).collect::<Vec<_>>();
    let cells: Vec<&str> = TARGETS.iter().filter(|t| t.candidate == "radar_cell").map(|t| t.id).collect();
    let grids: Vec<&str> = TARGETS.iter().filter(|t| t.output != "detections").map(|t| t.id).collect();
    let fc = ["temp_forecast", "precip_forecast", "storm_forecast", "tropical_forecast"];
    let p = |id: &str, name: &str, ty: &str, def: Value, min: Value, max: Value, choices: Value, help: &str, applies: &[&str]| json!({"id": id, "name": name, "type": ty, "default": def, "min": min, "max": max, "choices": choices, "help": help, "applies_to": applies});
    let n = Value::Null;
    json!([
        p("threshold", "Detection threshold", "float", n.clone(), json!(0.01), json!(0.99), n.clone(), "Probability for a detection / area (default: the model's best-CSI threshold); levels are derived from it", &all),
        p("min_prob", "Gate: minimum probability", "float", json!(0.0), json!(0.0), json!(1.0), n.clone(), "Hide detections and grid values below this probability (low-confidence cut-off)", &all),
        p("max_prob", "Gate: maximum probability", "float", json!(1.0), json!(0.0), json!(1.0), n.clone(), "Hide detections and grid values above this probability (high-confidence cut-off)", &all),
        p("min_value", "Gate: minimum value", "float", n.clone(), n.clone(), n.clone(), n.clone(), "Regression layers: hide values below (layer units, e.g. 0.25 mm)", &["temp_forecast", "precip_forecast", "storm_forecast"]),
        p("max_value", "Gate: maximum value", "float", n.clone(), n.clone(), n.clone(), n.clone(), "Regression layers: hide values above (layer units)", &["temp_forecast", "precip_forecast", "storm_forecast"]),
        p("persistence", "Persistence", "int", json!(1), json!(1), json!(10), n.clone(), "Require the detection in this many consecutive volumes (cells, by track) or cycles (grid areas)", &all),
        p("min_cell_dbz", "Minimum cell reflectivity", "float", json!(0.0), json!(0.0), json!(75.0), n.clone(), "Skip cells whose max reflectivity is lower (dBZ)", &cells),
        p("min_area_km2", "Minimum area", "float", json!(0.0), json!(0.0), json!(100000.0), n.clone(), "Skip cells / areas smaller than this (km²)", &all),
        p("max_range_km", "Maximum radar range", "float", json!(230.0), json!(10.0), json!(460.0), n.clone(), "Skip cells farther from the radar (km)", &cells),
        p("region", "Region", "region", n.clone(), n.clone(), n.clone(), n.clone(), "{bbox:[w,s,e,n]} or {states:[…]}: where to run grid models / keep detections (default: the model's region)", &all),
        p("leads", "Leads", "hours_list", n.clone(), json!(0.0), json!(240.0), n.clone(), "Forecast hours to produce (default: the trained leads)", &fc),
        p("valid_from", "Valid from", "time", n.clone(), n.clone(), n.clone(), n.clone(), "Window start (unix ms) for outlooks / a single forecast valid time", &grids),
        p("valid_to", "Valid to", "time", n.clone(), n.clone(), n.clone(), n.clone(), "Window end (unix ms) for outlooks", &["outlook"]),
        p("day", "Outlook day", "choice", json!("1"), n.clone(), n.clone(), json!(["1", "2", "3", "4-7"]), "Preset outlook windows (12Z–12Z)", &["outlook"]),
        p("grid_res_deg", "Grid spacing", "float", n.clone(), json!(0.03), json!(2.0), n.clone(), "Output grid spacing in degrees (default: the model's run spacing); coarsened automatically to stay within the point budget", &grids),
        p("smoothing_km", "Smoothing", "float", json!(0.0), json!(0.0), json!(300.0), n.clone(), "Smooth the output grid (km); outlooks default to 40 km", &grids),
        p("ensemble", "Ensemble", "choice", n.clone(), n.clone(), n.clone(), json!(["mean", "max"]), "Combine models of the same target that set the same ensemble mode into one extra output (grid layer mlpred/ensemble/<target> or ensemble detections)", &all),
        p("cadence_min", "Cadence", "int", n.clone(), json!(1), json!(1440), n.clone(), "Minutes between runs (default: every radar volume / the model's run_every_min)", &all),
        p("max_detections", "Max detections", "int", json!(200), json!(1), json!(5000), n.clone(), "Keep at most this many detections / areas per cycle (highest probability first)", &all),
        p("notify", "Notify", "bool", json!(false), n.clone(), n.clone(), n.clone(), "Push a notification (ml_notify on /ws) for new detections at or above the medium level", &all),
        p("outlook_levels", "Outlook categories", "json", n.clone(), n.clone(), n.clone(), n.clone(), "[{prob, cat}] probability (0–1) → category (TSTM, MRGL, SLGT, ENH, MDT, HIGH); default SPC-like for the hazard", &["outlook"]),
        p("quantiles", "Quantile layers", "bool", json!(true), n.clone(), n.clone(), n.clone(), "Also publish P10 / P90 layers when the model has quantile learners", &["temp_forecast", "precip_forecast", "storm_forecast"]),
    ])
}

/// Source lists for the catalog.
pub fn source_catalog() -> Value {
    json!({
        "radar_products": ["REF", "VEL", "SW", "ZDR", "RHO", "PHI", "CREF", "ET", "VIL"],
        "mrms": MRMS_FIELDS.iter().map(|f| json!({"id": f.0, "name": f.1, "unit": f.2})).collect::<Vec<_>>(),
        "model_vars": MODEL_VARS.iter().map(|v| json!({"id": v.id, "name": v.name, "unit": v.unit, "model": "gfs"})).collect::<Vec<_>>(),
        "hrrr_vars": HRRR_VARS.iter().map(|v| json!({"id": v.id, "name": v.name, "unit": v.unit, "model": "hrrr"})).collect::<Vec<_>>(),
        "fcst_vars": FC_VARS.iter().map(|v| json!({"id": v.id, "name": v.name, "unit": v.unit, "agg": format!("{:?}", v.agg).to_lowercase(), "gfs": !v.gfs.0.is_empty(), "hrrr": !v.hrrr.0.is_empty()})).collect::<Vec<_>>(),
        "fcst_models": ["gfs", "hrrr", "auto"],
        "satellite": SAT_FIELDS.iter().map(|f| json!({"id": f.0, "name": f.1, "unit": f.2})).collect::<Vec<_>>(),
        "metar": super::features::metar_features().iter().map(|f| json!({"id": f.id, "name": f.name, "unit": f.unit})).collect::<Vec<_>>(),
        "other": OTHER_FIELDS.iter().map(|f| json!({"id": f.0, "name": f.1, "unit": f.2})).collect::<Vec<_>>(),
    })
}

/// `GET /api/ml/catalog`
pub fn catalog() -> Value {
    let y = chrono::Utc::now().year();
    let full = Sources {
        mrms: MRMS_FIELDS.iter().map(|f| f.0.to_string()).collect(),
        metar: true,
        model: MODEL_VARS.iter().map(|v| v.id.to_string()).collect(),
        hrrr: HRRR_VARS.iter().map(|v| v.id.to_string()).collect(),
        fcst: FC_VARS.iter().map(|v| v.id.to_string()).collect(),
        fcst_model: "gfs".into(),
        satellite: SAT_FIELDS.iter().map(|v| v.0.to_string()).collect(),
        other: OTHER_FIELDS.iter().map(|v| v.0.to_string()).collect(),
        ..Default::default()
    };
    let cand = |id: &str, name: &str| json!({"id": id, "name": name, "features": all_features_for("", id, &full)});
    json!({
        "targets": TARGETS.iter().map(|t| {
            let d = (t.defaults)(y);
            // leads in hours (tropical windows are configured in days)
            let leads = d.get("target_params").and_then(|p| {
                p.get("leads").cloned().or_else(|| p.get("lead_days").and_then(|v| v.as_array()).map(|a| json!(a.iter().filter_map(|x| x.as_f64()).map(|x| x * 24.0).collect::<Vec<_>>())))
            });
            let (field, unit, cmap) = output_field(t.id, t.task);
            json!({
                "id": t.id, "name": t.name, "candidate": t.candidate, "task": t.task, "output": t.output,
                "tasks": if t.id == "storm_forecast" { json!(["classification", "regression"]) } else { json!([t.task]) },
                "default_labels_source": d.get("label_source").cloned().unwrap_or(json!([])), "description": t.description,
                "leads": leads, "subtargets": subtargets(t.id), "params": target_params(t.id),
                "target_features": super::features::target_features(t.id),
                "layer": if t.output == "detections" { Value::Null } else { json!({"field": field, "units": unit, "cmap": cmap}) },
            })
        }).collect::<Vec<_>>(),
        "candidates": [cand("radar_cell", "Radar storm cell (Level II volume)"), cand("grid_point", "Grid point (gridded environment)")],
        "tasks": ["classification", "regression"],
        "algos": [
            {"id": "gbdt", "name": "Gradient-boosted trees", "tasks": ["classification", "regression"], "params": [
                {"id": "n_trees", "name": "Max trees", "type": "int", "default": 400, "min": 10, "max": 5000, "help": "Upper bound; early stopping picks the best count on a validation split (continue: trees to add)"},
                {"id": "max_depth", "name": "Max depth", "type": "int", "default": 5, "min": 1, "max": 12, "help": "Deeper trees capture more interactions but overfit faster"},
                {"id": "learning_rate", "name": "Learning rate", "type": "float", "default": 0.06, "min": 0.005, "max": 1.0, "help": "Shrinkage per tree; lower = more trees, usually better"},
                {"id": "min_child_weight", "name": "Min child weight", "type": "float", "default": 2.0, "min": 0.0, "max": 100.0, "help": "Minimum hessian sum in a leaf"},
                {"id": "subsample", "name": "Row subsample", "type": "float", "default": 0.85, "min": 0.1, "max": 1.0, "help": "Fraction of samples per tree"},
                {"id": "colsample", "name": "Feature subsample", "type": "float", "default": 0.8, "min": 0.1, "max": 1.0, "help": "Fraction of features per tree"},
                {"id": "lambda", "name": "L2 (lambda)", "type": "float", "default": 1.0, "min": 0.0, "max": 100.0, "help": "L2 penalty on leaf weights"},
                {"id": "gamma", "name": "Min split gain", "type": "float", "default": 0.0, "min": 0.0, "max": 50.0, "help": "Splits must improve the loss by this much"},
                {"id": "max_bins", "name": "Histogram bins", "type": "int", "default": 64, "min": 8, "max": 254, "help": "Quantile bins per feature"},
                {"id": "scale_pos_weight", "name": "Positive class weight", "type": "float", "default": 0.0, "min": 0.0, "max": 100.0, "help": "0 = automatic (negatives / positives); classification only"},
                {"id": "early_stopping_rounds", "name": "Early stopping rounds", "type": "int", "default": 40, "min": 0, "max": 1000, "help": "Stop after this many trees without validation improvement (0 = off)"},
                {"id": "loss", "name": "Loss", "type": "choice", "default": "auto", "choices": ["auto", "squared", "huber", "quantile"], "help": "Regression loss (auto = squared error); classification always uses log loss"},
                {"id": "huber_delta", "name": "Huber δ", "type": "float", "default": 1.0, "min": 0.01, "max": 100.0, "help": "Residual size (target units) where Huber switches to linear"},
                {"id": "alpha", "name": "Quantile", "type": "float", "default": 0.5, "min": 0.01, "max": 0.99, "help": "Quantile of the main model when loss = quantile"},
                {"id": "quantiles", "name": "Extra quantile models", "type": "float_list", "default": [], "min": 0.01, "max": 0.99, "help": "Regression: also train these quantiles (e.g. 0.1, 0.9 → P10 / P90 layers)"},
                {"id": "seed", "name": "Seed", "type": "int", "default": 42, "min": 0, "max": 4294967295u64, "help": "Random seed (deterministic training)"}
            ]},
            {"id": "logreg", "name": "Logistic / ridge regression", "tasks": ["classification", "regression"], "params": [
                {"id": "l2", "name": "L2 penalty", "type": "float", "default": 1.0, "min": 0.0, "max": 1000.0, "help": "Ridge penalty on standardised coefficients"},
                {"id": "max_iter", "name": "Max iterations", "type": "int", "default": 50, "min": 1, "max": 500, "help": "Newton steps (classification)"},
                {"id": "scale_pos_weight", "name": "Positive class weight", "type": "float", "default": 0.0, "min": 0.0, "max": 100.0, "help": "0 = automatic"},
                {"id": "prior", "name": "Continue: prior weight", "type": "float", "default": 1.0, "min": 0.0, "max": 1000.0, "help": "Ridge regression trained further: pull towards the previous coefficients"}
            ]},
            {"id": "mlp", "name": "Neural network (MLP)", "tasks": ["classification", "regression"], "params": [
                {"id": "hidden1", "name": "Hidden layer 1", "type": "int", "default": 32, "min": 1, "max": 512, "help": "Units in the first hidden layer"},
                {"id": "hidden2", "name": "Hidden layer 2", "type": "int", "default": 16, "min": 0, "max": 512, "help": "0 = one hidden layer"},
                {"id": "epochs", "name": "Max epochs", "type": "int", "default": 200, "min": 1, "max": 5000, "help": "Upper bound; early stopping on validation loss"},
                {"id": "batch", "name": "Batch size", "type": "int", "default": 128, "min": 8, "max": 4096, "help": "Mini-batch size"},
                {"id": "learning_rate", "name": "Learning rate", "type": "float", "default": 0.003, "min": 0.00001, "max": 0.1, "help": "Adam step size"},
                {"id": "l2", "name": "Weight decay", "type": "float", "default": 0.0001, "min": 0.0, "max": 0.1, "help": "L2 on weights"},
                {"id": "scale_pos_weight", "name": "Positive class weight", "type": "float", "default": 0.0, "min": 0.0, "max": 100.0, "help": "0 = automatic"},
                {"id": "early_stopping_rounds", "name": "Early stopping epochs", "type": "int", "default": 20, "min": 0, "max": 500, "help": "0 = off"},
                {"id": "seed", "name": "Seed", "type": "int", "default": 42, "min": 0, "max": 4294967295u64, "help": "Random seed"}
            ]}
        ],
        "label_sources": super::labels::SOURCES.iter().map(|s| json!({"id": s.0, "name": s.1, "targets": s.2, "years": [s.3, y], "url": s.4, "truth": super::labels::is_truth_source(s.0)})).collect::<Vec<_>>(),
        "presets": PRESETS.iter().map(|p| json!({"id": p.id, "name": p.name, "target": p.target, "kind": if p.id.contains("thorough") { "thorough" } else { "quick" }, "spec": resolve(&json!({"preset": p.id})).map(|s| serde_json::to_value(s).unwrap_or_default()).unwrap_or_default()})).collect::<Vec<_>>(),
        "mrms_fields": MRMS_FIELDS.iter().map(|f| json!({"id": f.0, "name": f.1, "unit": f.2})).collect::<Vec<_>>(),
        "model_vars": MODEL_VARS.iter().map(|v| json!({"id": v.id, "name": v.name, "unit": v.unit})).collect::<Vec<_>>(),
        "sources": source_catalog(),
        "run_params": run_params(),
        "run_globals": [
            {"id": "radars", "name": "Radars", "type": "radars", "default": "all", "help": "\"all\" | \"nexrad\" | \"tdwr\" | [ids] | {states:[…]} | {bbox:[w,s,e,n]}"},
            {"id": "interval_s", "name": "Cycle interval", "type": "int", "default": 60, "min": 15, "max": 3600, "help": "Seconds between runner cycles"},
            {"id": "concurrency", "name": "Radars at once", "type": "int", "default": 0, "min": 0, "max": 64, "help": "0 = server default"},
            {"id": "enabled", "name": "Enabled", "type": "bool", "default": false, "help": "Run the selected models live"}
        ],
        "outlook": {
            "categories": super::predict::OUTLOOK_CATS.iter().map(|c| json!({"cat": c.0, "label": c.1, "color": c.2})).collect::<Vec<_>>(),
            "levels": {"any": super::predict::default_levels("any"), "tornado": super::predict::default_levels("tornado"), "wind": super::predict::default_levels("wind"), "hail": super::predict::default_levels("hail")},
            "days": ["1", "2", "3", "4-7"],
        },
        "retrain": {"modes": ["replace", "new"], "continue_algos": ["gbdt", "logreg", "mlp"]},
        "defaults": serde_json::to_value(TrainSpec::default()).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_layers() {
        let s = resolve(&json!({"preset": "tornado-quick"})).unwrap();
        assert_eq!(s.target, "tornado");
        assert_eq!(s.max_events, 150);
        assert_eq!(s.label_source, vec!["spc_tornado"]);
        let s = resolve(&json!({"target": "hail", "max_events": 10, "label_source": "spc_hail,iem_lsr", "bogus": 1, "match": {"radius_km": 5}})).unwrap();
        assert_eq!(s.filters.min_size_in, Some(1.0));
        assert_eq!(s.max_events, 10);
        assert_eq!(s.label_source.len(), 2);
        assert_eq!(s.match_rule.radius_km, 5.0);
        assert_eq!(s.match_rule.after_min, 20.0);
        let s = resolve(&json!({"preset": "tornado-thorough", "params": {"n_trees": 50}})).unwrap();
        assert_eq!(s.params, json!({"n_trees": 50}));
        assert_eq!(s.sources.mrms, vec!["azs02", "mesh"]);
        assert!(resolve(&json!({"target": "nope"})).is_err());
        assert!(resolve(&json!({"algo": "svm"})).is_err());
        let s = resolve(&json!({"preset": "tropical-genesis"})).unwrap();
        assert_eq!(s.candidate, "grid_point");
        assert!(s.sources.model.contains(&"absv850".to_string()));
        let c = catalog();
        assert!(c["targets"].as_array().unwrap().len() >= 19);
        assert!(c["presets"].as_array().unwrap().iter().all(|p| p["spec"]["target"].is_string()), "a preset failed to resolve");
        assert!(resolve(&json!({})).is_ok());
        // every preset resolves; new targets carry task / output
        for p in PRESETS {
            resolve(&json!({"preset": p.id})).unwrap_or_else(|e| panic!("{}: {e}", p.id));
        }
        let s = resolve(&json!({"preset": "temp-forecast-quick"})).unwrap();
        assert_eq!(s.task, "regression");
        assert_eq!(s.target_params["leads"], json!([1.0, 3.0, 6.0, 12.0, 24.0]));
        assert!(s.sources.fcst.contains(&"t2m".to_string()));
        let s = resolve(&json!({"preset": "outlook-day2"})).unwrap();
        assert_eq!(s.target_params["day"], "2");
        assert_eq!(s.target_params["radius_km"], 40.0);
        assert!(resolve(&json!({"target": "temp_forecast", "task": "classification"})).is_err());
        assert!(resolve(&json!({"target": "storm_forecast", "task": "regression"})).is_ok());
        let t = c["targets"].as_array().unwrap().iter().find(|t| t["id"] == "outlook").unwrap();
        assert_eq!(t["output"], "outlook");
        assert!(t["params"].as_array().unwrap().iter().any(|p| p["id"] == "hazard"));
        assert!(c["run_params"].as_array().unwrap().iter().any(|p| p["id"] == "min_prob"));
        assert!(c["sources"]["satellite"].as_array().unwrap().len() >= 8);
    }
}
