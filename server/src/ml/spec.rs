//! Training specs, targets, presets and the `/api/ml/catalog` document.
//!
//! A spec is resolved in layers: target defaults ← preset ← the request's own fields (deep JSON
//! merge, unknown fields ignored, missing ones defaulted). So `{"preset":"tornado-quick"}`,
//! `{"target":"tornado"}` and a fully custom spec all work.

use super::cells::CellParams;
use super::features::{all_features, Sources, MODEL_VARS, MRMS_FIELDS};
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
        }
    }
}

pub struct Target {
    pub id: &'static str,
    pub name: &'static str,
    pub candidate: &'static str,
    pub description: &'static str,
    /// partial spec JSON applied over the defaults
    pub defaults: fn(i32) -> Value,
}

fn radar_sources() -> Value {
    json!({"radar_products": ["REF", "VEL", "SW", "ZDR", "RHO", "PHI", "CREF", "ET", "VIL"], "mrms": [], "metar": false, "model": []})
}

pub const TARGETS: &[Target] = &[
    Target { id: "tornado", name: "Tornado", candidate: "radar_cell", description: "Storm cells that produce a tornado within the match window (default: within 10 km, from 30 min before to 10 min after).", defaults: |_| json!({"label_source": ["spc_tornado"], "sources": radar_sources()}) },
    Target { id: "supercell", name: "Supercell", candidate: "radar_cell", description: "Rotating, long-lived severe storms; labels = tornado or ≥ 1.5\" hail reports nearby (proxy).", defaults: |_| json!({"label_source": ["spc_tornado", "spc_hail"], "filters": {"min_size_in": 1.5}, "match": {"radius_km": 15.0, "before_min": 15.0, "after_min": 30.0}, "sources": radar_sources()}) },
    Target { id: "hail", name: "Hail ≥ 1\"", candidate: "radar_cell", description: "Cells producing severe hail (≥ 1 inch).", defaults: |_| json!({"label_source": ["spc_hail"], "filters": {"min_size_in": 1.0}, "match": {"radius_km": 12.0, "before_min": 10.0, "after_min": 20.0}, "sources": radar_sources()}) },
    Target { id: "sighail", name: "Significant hail ≥ 2\"", candidate: "radar_cell", description: "Cells producing significant hail (≥ 2 inches).", defaults: |_| json!({"label_source": ["spc_hail"], "filters": {"min_size_in": 2.0}, "match": {"radius_km": 12.0, "before_min": 10.0, "after_min": 20.0}, "sources": radar_sources()}) },
    Target { id: "wind", name: "Damaging wind", candidate: "radar_cell", description: "Cells producing severe wind (≥ 50 kt measured/estimated or damage).", defaults: |_| json!({"label_source": ["spc_wind"], "filters": {"min_wind_kt": 50.0}, "match": {"radius_km": 15.0, "before_min": 10.0, "after_min": 20.0}, "sources": radar_sources()}) },
    Target { id: "debris", name: "Tornado debris (TDS)", candidate: "radar_cell", description: "Cells with an ongoing (E)F2+ tornado — lofted debris (low CC, low ZDR) should be visible.", defaults: |_| json!({"label_source": ["spc_tornado"], "filters": {"min_mag": 2}, "match": {"radius_km": 8.0, "before_min": 5.0, "after_min": 0.0}, "sources": radar_sources()}) },
    Target { id: "flash_flood", name: "Flash flood", candidate: "grid_point", description: "Points with a flash-flood report within 1 h (MRMS QPE / FLASH features).", defaults: |y| json!({"label_source": ["iem_lsr"], "filters": {"lsr_types": ["F"]}, "years": [(y - 3).max(2021), y - 1], "max_events": 600, "neg_ratio": 5.0, "sources": {"mrms": ["qpe1h", "qpe6h", "prate", "flash_crest_unit", "flash_ari01h", "flash_ffg01h"], "metar": false, "model": ["pwat"]}, "grid": {"lead_hours": [0.0], "exclude_km": 50.0, "exclude_hours": 6.0, "run_spacing_deg": 0.1, "run_every_min": 10}}) },
    Target { id: "tropical_genesis", name: "Tropical storm formation (48 h)", candidate: "grid_point", description: "Disturbances that become a tropical storm within 48 h (HURDAT2 genesis, GFS analysis environment).", defaults: |y| json!({"label_source": ["hurdat_genesis"], "filters": {"basins": ["al", "ep"]}, "years": [2021, y - 1], "max_events": 400, "neg_ratio": 6.0, "region": {"bbox": [-180.0, 0.0, -10.0, 40.0]}, "sources": {"mrms": [], "metar": false, "model": ["absv850", "shear_850_200", "rh700", "sst", "mslp", "pwat", "mucape", "land"]}, "grid": {"lead_hours": [0.0, 12.0, 24.0, 36.0, 48.0], "exclude_km": 600.0, "exclude_hours": 72.0, "run_spacing_deg": 1.0, "run_every_min": 360}}) },
    Target { id: "tropical_possible", name: "Possible tropical formation", candidate: "grid_point", description: "Systems that become any tropical cyclone (first best-track fix) within 48 h.", defaults: |y| json!({"label_source": ["hurdat_first_fix"], "filters": {"basins": ["al", "ep"]}, "years": [2021, y - 1], "max_events": 400, "neg_ratio": 6.0, "region": {"bbox": [-180.0, 0.0, -10.0, 40.0]}, "sources": {"mrms": [], "metar": false, "model": ["absv850", "shear_850_200", "rh700", "sst", "mslp", "pwat", "mucape", "land"]}, "grid": {"lead_hours": [0.0, 12.0, 24.0, 36.0, 48.0], "exclude_km": 600.0, "exclude_hours": 72.0, "run_spacing_deg": 1.0, "run_every_min": 360}}) },
    Target { id: "wildfire", name: "Wildfire ignition", candidate: "grid_point", description: "New satellite fire detections (no detection nearby the previous day) vs. dry/windy environment.", defaults: |y| json!({"label_source": ["hms_fire"], "years": [y - 3, y - 1], "max_events": 600, "neg_ratio": 4.0, "filters": {"months": [3, 4, 5, 6, 7, 8, 9, 10, 11]}, "sources": {"mrms": [], "metar": true, "model": ["t2m", "rh2m", "td2m", "wind10", "gust", "soilw", "pwat", "cape", "land"]}, "grid": {"lead_hours": [0.0], "exclude_km": 25.0, "exclude_hours": 24.0, "run_spacing_deg": 0.25, "run_every_min": 360, "per_day": 15}}) },
    Target { id: "custom", name: "Custom", candidate: "radar_cell", description: "Pick any label source and candidate type.", defaults: |_| json!({"sources": radar_sources()}) },
];

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
        if self.label_source.is_empty() {
            bail!("label_source required");
        }
        for l in &self.label_source {
            if !super::labels::SOURCES.iter().any(|s| s.0 == l) {
                bail!("unknown label source {l}");
            }
        }
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

/// `GET /api/ml/catalog`
pub fn catalog() -> Value {
    let y = chrono::Utc::now().year();
    let full = Sources { mrms: MRMS_FIELDS.iter().map(|f| f.0.to_string()).collect(), metar: true, model: MODEL_VARS.iter().map(|v| v.id.to_string()).collect(), ..Default::default() };
    let cand = |id: &str, name: &str| json!({"id": id, "name": name, "features": all_features(id, &full)});
    json!({
        "targets": TARGETS.iter().map(|t| {
            let d = (t.defaults)(y);
            json!({"id": t.id, "name": t.name, "candidate": t.candidate, "default_labels_source": d.get("label_source").cloned().unwrap_or(json!([])), "description": t.description})
        }).collect::<Vec<_>>(),
        "candidates": [cand("radar_cell", "Radar storm cell (Level II volume)"), cand("grid_point", "Grid point (gridded environment)")],
        "algos": [
            {"id": "gbdt", "name": "Gradient-boosted trees", "params": [
                {"id": "n_trees", "name": "Max trees", "type": "int", "default": 400, "min": 10, "max": 5000, "help": "Upper bound; early stopping picks the best count on a validation split"},
                {"id": "max_depth", "name": "Max depth", "type": "int", "default": 5, "min": 1, "max": 12, "help": "Deeper trees capture more interactions but overfit faster"},
                {"id": "learning_rate", "name": "Learning rate", "type": "float", "default": 0.06, "min": 0.005, "max": 1.0, "help": "Shrinkage per tree; lower = more trees, usually better"},
                {"id": "min_child_weight", "name": "Min child weight", "type": "float", "default": 2.0, "min": 0.0, "max": 100.0, "help": "Minimum hessian sum in a leaf"},
                {"id": "subsample", "name": "Row subsample", "type": "float", "default": 0.85, "min": 0.1, "max": 1.0, "help": "Fraction of samples per tree"},
                {"id": "colsample", "name": "Feature subsample", "type": "float", "default": 0.8, "min": 0.1, "max": 1.0, "help": "Fraction of features per tree"},
                {"id": "lambda", "name": "L2 (lambda)", "type": "float", "default": 1.0, "min": 0.0, "max": 100.0, "help": "L2 penalty on leaf weights"},
                {"id": "gamma", "name": "Min split gain", "type": "float", "default": 0.0, "min": 0.0, "max": 50.0, "help": "Splits must improve the loss by this much"},
                {"id": "max_bins", "name": "Histogram bins", "type": "int", "default": 64, "min": 8, "max": 254, "help": "Quantile bins per feature"},
                {"id": "scale_pos_weight", "name": "Positive class weight", "type": "float", "default": 0.0, "min": 0.0, "max": 100.0, "help": "0 = automatic (negatives / positives)"},
                {"id": "early_stopping_rounds", "name": "Early stopping rounds", "type": "int", "default": 40, "min": 0, "max": 1000, "help": "Stop after this many trees without validation improvement (0 = off)"},
                {"id": "seed", "name": "Seed", "type": "int", "default": 42, "min": 0, "max": 4294967295u64, "help": "Random seed (deterministic training)"}
            ]},
            {"id": "logreg", "name": "Logistic regression", "params": [
                {"id": "l2", "name": "L2 penalty", "type": "float", "default": 1.0, "min": 0.0, "max": 1000.0, "help": "Ridge penalty on standardised coefficients"},
                {"id": "max_iter", "name": "Max iterations", "type": "int", "default": 50, "min": 1, "max": 500, "help": "Newton steps"},
                {"id": "scale_pos_weight", "name": "Positive class weight", "type": "float", "default": 0.0, "min": 0.0, "max": 100.0, "help": "0 = automatic"}
            ]},
            {"id": "mlp", "name": "Neural network (MLP)", "params": [
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
        "label_sources": super::labels::SOURCES.iter().map(|s| json!({"id": s.0, "name": s.1, "targets": s.2, "years": [s.3, y], "url": s.4})).collect::<Vec<_>>(),
        "presets": PRESETS.iter().map(|p| json!({"id": p.id, "name": p.name, "target": p.target, "spec": resolve(&json!({"preset": p.id})).map(|s| serde_json::to_value(s).unwrap_or_default()).unwrap_or_default()})).collect::<Vec<_>>(),
        "mrms_fields": MRMS_FIELDS.iter().map(|f| json!({"id": f.0, "name": f.1, "unit": f.2})).collect::<Vec<_>>(),
        "model_vars": MODEL_VARS.iter().map(|v| json!({"id": v.id, "name": v.name, "unit": v.unit})).collect::<Vec<_>>(),
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
        assert!(c["targets"].as_array().unwrap().len() >= 11);
        assert!(c["presets"].as_array().unwrap().iter().all(|p| p["spec"]["target"].is_string()));
        assert!(resolve(&json!({})).is_ok());
    }
}
