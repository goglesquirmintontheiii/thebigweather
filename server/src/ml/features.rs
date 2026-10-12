//! Feature schemas: the fixed per-candidate features (versioned) plus optional environment
//! features from gridded sources. A model stores its schema; inference rebuilds the same vector.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Bump when an extractor's output for the same input changes (invalidates cached samples).
pub const RADAR_CELL_VERSION: u32 = 1;
pub const GRID_POINT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FeatureDef {
    pub id: String,
    pub name: String,
    pub unit: String,
    pub group: String,
}

fn f(id: &str, name: &str, unit: &str, group: &str) -> FeatureDef {
    FeatureDef { id: id.into(), name: name.into(), unit: unit.into(), group: group.into() }
}

/// Radar storm-cell features computed from one Level II volume (+ the previous one for trends).
pub fn radar_cell_base() -> Vec<FeatureDef> {
    vec![
        f("ref_max", "Max composite reflectivity", "dBZ", "Reflectivity"),
        f("ref_mean", "Mean composite reflectivity", "dBZ", "Reflectivity"),
        f("ref_low_max", "Max lowest-tilt reflectivity", "dBZ", "Reflectivity"),
        f("area_km2", "Cell area (≥ threshold)", "km²", "Reflectivity"),
        f("area50_km2", "Area ≥ 50 dBZ", "km²", "Reflectivity"),
        f("core_h_km", "Height of max reflectivity", "km", "Reflectivity"),
        f("overhang_db", "Mid-level minus low-level reflectivity at core (BWER proxy)", "dB", "Reflectivity"),
        f("vil_max", "Max VIL", "kg/m²", "Column"),
        f("vil_density", "VIL density", "g/m³", "Column"),
        f("et18_km", "18 dBZ echo top", "km", "Column"),
        f("h50_km", "50 dBZ echo top", "km", "Column"),
        f("mesh_mm", "MESH (SHI, default melting levels)", "mm", "Column"),
        f("zdr_max", "Max low-level ZDR in core", "dB", "Dual-pol"),
        f("zdr_core", "Mean low-level ZDR in core", "dB", "Dual-pol"),
        f("cc_min", "Min low-level CC (REF ≥ 30)", "", "Dual-pol"),
        f("cc_low_frac", "Fraction of low-level gates with CC < 0.85", "", "Dual-pol"),
        f("kdp_max", "Max low-level KDP (from ΦDP)", "°/km", "Dual-pol"),
        f("vrot_max", "Max rotational velocity (couplets)", "m/s", "Velocity"),
        f("vrot_low", "Max Vrot below 3 km", "m/s", "Velocity"),
        f("rot_dv", "Couplet ΔV", "m/s", "Velocity"),
        f("rot_diam_km", "Couplet diameter", "km", "Velocity"),
        f("rot_tilts", "Tilts with the couplet", "", "Velocity"),
        f("rot_h_km", "Couplet height", "km", "Velocity"),
        f("rot_score", "Couplet score", "", "Velocity"),
        f("rot_tvs", "TVS signature", "0/1", "Velocity"),
        f("rot_meso", "Mesocyclone signature", "0/1", "Velocity"),
        f("azshear_low", "Low-level azimuthal shear (98th pct)", "10⁻³ s⁻¹", "Velocity"),
        f("azshear_mid", "Mid-level azimuthal shear (98th pct)", "10⁻³ s⁻¹", "Velocity"),
        f("conv_low", "Low-level radial convergence", "10⁻³ s⁻¹", "Velocity"),
        f("div_top", "Upper-level radial divergence", "10⁻³ s⁻¹", "Velocity"),
        f("vel_max_low", "Max |radial velocity| lowest tilt", "m/s", "Velocity"),
        f("sw_max_low", "Max spectrum width lowest tilt", "m/s", "Velocity"),
        f("range_km", "Range from radar", "km", "Geometry"),
        f("beam_h_km", "Lowest beam height at the cell", "km", "Geometry"),
        f("motion_kt", "Cell motion speed", "kt", "Track"),
        f("ref_trend", "Max reflectivity change since previous volume", "dB", "Track"),
        f("vil_trend", "VIL change since previous volume", "kg/m²", "Track"),
        f("vrot_trend", "Vrot change since previous volume", "m/s", "Track"),
        f("area_trend", "Area ratio to previous volume", "", "Track"),
        f("solar_hour", "Local solar hour", "h", "Context"),
        f("doy", "Day of year", "", "Context"),
        f("lat", "Latitude", "°", "Context"),
    ]
}

/// Point features always present for grid-point candidates.
pub fn grid_point_base() -> Vec<FeatureDef> {
    vec![
        f("lat", "Latitude", "°", "Context"),
        f("lon", "Longitude", "°", "Context"),
        f("doy", "Day of year", "", "Context"),
        f("solar_hour", "Local solar hour", "h", "Context"),
    ]
}

/// Nearest METAR features.
pub fn metar_features() -> Vec<FeatureDef> {
    vec![
        f("metar_t", "Nearest METAR temperature", "°C", "METAR"),
        f("metar_td", "Nearest METAR dewpoint", "°C", "METAR"),
        f("metar_spread", "Nearest METAR T − Td", "°C", "METAR"),
        f("metar_wspd", "Nearest METAR wind", "kt", "METAR"),
        f("metar_gust", "Nearest METAR gust", "kt", "METAR"),
        f("metar_ptend", "Nearest METAR 1 h altimeter change", "hPa", "METAR"),
        f("metar_dist_km", "Distance to nearest METAR", "km", "METAR"),
    ]
}

/// MRMS fields usable as features (layer id in the grid catalog, without "mrms/").
pub const MRMS_FIELDS: &[(&str, &str, &str)] = &[
    ("azs02", "MRMS low-level azimuthal shear (max within 5 km)", "1/s"),
    ("mesh", "MRMS MESH (max within 5 km)", "mm"),
    ("vil", "MRMS VIL (max within 5 km)", "kg/m²"),
    ("et18", "MRMS 18 dBZ echo top (max within 5 km)", "km"),
    ("cref", "MRMS composite reflectivity (max within 5 km)", "dBZ"),
    ("posh", "MRMS probability of severe hail", "%"),
    ("rot2h", "MRMS 2 h rotation track", "1/s"),
    ("qpe1h", "MRMS 1 h QPE", "mm"),
    ("qpe6h", "MRMS 6 h QPE", "mm"),
    ("prate", "MRMS precipitation rate", "mm/h"),
    ("flash_crest_unit", "FLASH CREST max unit streamflow", "m³/s/km²"),
    ("flash_ari01h", "FLASH QPE return period 1 h", "yr"),
    ("flash_ffg01h", "FLASH QPE/FFG ratio 1 h", "ratio"),
];

/// GFS analysis (f000) variables: id, name, unit, idx pattern(s), transform.
/// Wind magnitudes / shears use two (U, V) patterns; `shear` ids use four.
pub struct ModelVar {
    pub id: &'static str,
    pub name: &'static str,
    pub unit: &'static str,
    pub pats: &'static [&'static str],
    pub kind: VarKind,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum VarKind {
    Plain,
    KToC,
    PaToHpa,
    Times1e5,
    /// |(u,v)| of pats[0..2]
    Speed,
    /// |(u2−u1, v2−v1)| with pats = [u1, v1, u2, v2]
    Shear,
}

pub const MODEL_VARS: &[ModelVar] = &[
    ModelVar { id: "cape", name: "Surface CAPE", unit: "J/kg", pats: &["CAPE:surface"], kind: VarKind::Plain },
    ModelVar { id: "mucape", name: "Most-unstable CAPE", unit: "J/kg", pats: &["CAPE:255-0 mb above ground"], kind: VarKind::Plain },
    ModelVar { id: "cin", name: "Surface CIN", unit: "J/kg", pats: &["CIN:surface"], kind: VarKind::Plain },
    ModelVar { id: "lftx", name: "Lifted index", unit: "K", pats: &["LFTX:surface"], kind: VarKind::Plain },
    ModelVar { id: "srh03", name: "0–3 km storm-relative helicity", unit: "m²/s²", pats: &["HLCY:3000-0 m above ground"], kind: VarKind::Plain },
    ModelVar { id: "shear06", name: "Bulk shear 10 m–500 mb (≈0–6 km)", unit: "m/s", pats: &["UGRD:10 m above ground", "VGRD:10 m above ground", "UGRD:500 mb", "VGRD:500 mb"], kind: VarKind::Shear },
    ModelVar { id: "pwat", name: "Precipitable water", unit: "mm", pats: &["PWAT:entire atmosphere"], kind: VarKind::Plain },
    ModelVar { id: "t2m", name: "2 m temperature", unit: "°C", pats: &["TMP:2 m above ground"], kind: VarKind::KToC },
    ModelVar { id: "td2m", name: "2 m dewpoint", unit: "°C", pats: &["DPT:2 m above ground"], kind: VarKind::KToC },
    ModelVar { id: "rh2m", name: "2 m relative humidity", unit: "%", pats: &["RH:2 m above ground"], kind: VarKind::Plain },
    ModelVar { id: "wind10", name: "10 m wind speed", unit: "m/s", pats: &["UGRD:10 m above ground", "VGRD:10 m above ground"], kind: VarKind::Speed },
    ModelVar { id: "gust", name: "Surface gust", unit: "m/s", pats: &["GUST:surface"], kind: VarKind::Plain },
    ModelVar { id: "mslp", name: "Sea-level pressure", unit: "hPa", pats: &["PRMSL:mean sea level"], kind: VarKind::PaToHpa },
    ModelVar { id: "absv850", name: "850 mb absolute vorticity", unit: "10⁻⁵ s⁻¹", pats: &["ABSV:850 mb"], kind: VarKind::Times1e5 },
    ModelVar { id: "rh700", name: "700 mb relative humidity", unit: "%", pats: &["RH:700 mb"], kind: VarKind::Plain },
    ModelVar { id: "shear_850_200", name: "850–200 mb vertical shear", unit: "m/s", pats: &["UGRD:850 mb", "VGRD:850 mb", "UGRD:200 mb", "VGRD:200 mb"], kind: VarKind::Shear },
    ModelVar { id: "sst", name: "Surface (skin) temperature", unit: "°C", pats: &["TMP:surface"], kind: VarKind::KToC },
    ModelVar { id: "soilw", name: "Soil moisture 0–10 cm", unit: "fraction", pats: &["SOILW:0-0.1 m below ground"], kind: VarKind::Plain },
    ModelVar { id: "hgt0c", name: "Freezing level height", unit: "m", pats: &["HGT:0C isotherm"], kind: VarKind::Plain },
    ModelVar { id: "land", name: "Land fraction", unit: "0/1", pats: &["LAND:surface"], kind: VarKind::Plain },
];

pub fn model_var(id: &str) -> Option<&'static ModelVar> {
    MODEL_VARS.iter().find(|v| v.id == id)
}

/// Optional data sources feeding environment features.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct Sources {
    /// radar products used for cell features (informational; all are extracted when present)
    pub radar_products: Vec<String>,
    /// MRMS field ids (see MRMS_FIELDS)
    pub mrms: Vec<String>,
    pub metar: bool,
    /// GFS analysis variable ids (see MODEL_VARS)
    pub model: Vec<String>,
}

impl Sources {
    /// Drop unknown ids, dedupe.
    pub fn normalized(&self) -> Sources {
        let mut s = self.clone();
        s.mrms.retain(|m| MRMS_FIELDS.iter().any(|f| f.0 == m));
        s.mrms.sort();
        s.mrms.dedup();
        s.model.retain(|m| model_var(m).is_some());
        s.model.sort();
        s.model.dedup();
        s
    }
    pub fn is_empty(&self) -> bool {
        self.mrms.is_empty() && !self.metar && self.model.is_empty()
    }
    pub fn key(&self) -> String {
        format!("m:{};w:{};g:{}", self.mrms.join(","), self.metar as u8, self.model.join(","))
    }
}

/// Environment feature definitions for a source set (in a fixed order).
pub fn env_features(s: &Sources) -> Vec<FeatureDef> {
    let mut out = vec![];
    for m in &s.mrms {
        if let Some(d) = MRMS_FIELDS.iter().find(|f| f.0 == m) {
            out.push(f(&format!("mrms_{}", d.0), d.1, d.2, "MRMS"));
        }
    }
    if s.metar {
        out.extend(metar_features());
    }
    for m in &s.model {
        if let Some(v) = model_var(m) {
            out.push(f(&format!("gfs_{}", v.id), &format!("GFS {}", v.name), v.unit, "Model (GFS analysis)"));
        }
    }
    out
}

/// Every feature a candidate can produce with the given sources.
pub fn all_features(candidate: &str, s: &Sources) -> Vec<FeatureDef> {
    let mut v = match candidate {
        "radar_cell" => radar_cell_base(),
        _ => grid_point_base(),
    };
    v.extend(env_features(s));
    v
}

pub fn candidate_version(candidate: &str) -> u32 {
    if candidate == "radar_cell" { RADAR_CELL_VERSION } else { GRID_POINT_VERSION }
}

/// The feature set stored in a model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Schema {
    pub candidate: String,
    pub version: u32,
    pub sources: Sources,
    pub features: Vec<FeatureDef>,
}

impl Schema {
    /// `ids` = subset to keep (empty = all).
    pub fn new(candidate: &str, sources: &Sources, ids: &[String]) -> Schema {
        let s = sources.normalized();
        let mut feats = all_features(candidate, &s);
        if !ids.is_empty() {
            feats.retain(|f| ids.contains(&f.id));
        }
        Schema { candidate: candidate.into(), version: candidate_version(candidate), sources: s, features: feats }
    }
    pub fn ids(&self) -> Vec<String> {
        self.features.iter().map(|f| f.id.clone()).collect()
    }
}

/// A sample's raw features by id (missing = NaN / absent). Serialized as a JSON object without
/// the missing values (JSON has no NaN); `null` reads back as missing.
#[derive(Debug, Clone, Default)]
pub struct FeatMap(pub HashMap<String, f32>);

impl Serialize for FeatMap {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut keys: Vec<(&String, &f32)> = self.0.iter().filter(|(_, v)| v.is_finite()).collect();
        keys.sort_by(|a, b| a.0.cmp(b.0));
        let mut m = s.serialize_map(Some(keys.len()))?;
        for (k, v) in keys {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

impl<'de> Deserialize<'de> for FeatMap {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m: HashMap<String, Option<f32>> = HashMap::deserialize(d)?;
        Ok(FeatMap(m.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).collect()))
    }
}

impl FeatMap {
    pub fn set(&mut self, k: &str, v: f32) {
        self.0.insert(k.to_string(), v);
    }
    pub fn get(&self, k: &str) -> f32 {
        self.0.get(k).copied().unwrap_or(f32::NAN)
    }
    /// Vector in schema order.
    pub fn vector(&self, ids: &[String]) -> Vec<f32> {
        ids.iter().map(|k| self.get(k)).collect()
    }
}

/// Local solar hour (0–24) at a longitude for a unix-ms time.
pub fn solar_hour(t_ms: i64, lon: f64) -> f32 {
    let h = (t_ms.rem_euclid(86_400_000)) as f64 / 3_600_000.0 + lon / 15.0;
    h.rem_euclid(24.0) as f32
}

pub fn day_of_year(t_ms: i64) -> f32 {
    use chrono::Datelike;
    chrono::DateTime::from_timestamp_millis(t_ms).map(|d| d.ordinal() as f32).unwrap_or(f32::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_subsets_and_env() {
        let s = Sources { mrms: vec!["mesh".into(), "bogus".into()], metar: true, model: vec!["cape".into()], ..Default::default() };
        let sc = Schema::new("radar_cell", &s, &[]);
        assert_eq!(sc.sources.mrms, vec!["mesh"]);
        assert!(sc.ids().contains(&"mrms_mesh".to_string()));
        assert!(sc.ids().contains(&"metar_spread".to_string()));
        assert!(sc.ids().contains(&"gfs_cape".to_string()));
        let sub = Schema::new("radar_cell", &s, &["ref_max".into(), "gfs_cape".into()]);
        assert_eq!(sub.ids(), vec!["ref_max", "gfs_cape"]);
        let mut m = FeatMap::default();
        m.set("ref_max", 60.0);
        let v = m.vector(&sub.ids());
        assert_eq!(v[0], 60.0);
        assert!(v[1].is_nan());
        assert!((solar_hour(0, -90.0) - 18.0).abs() < 1e-4);
        m.set("x", f32::NAN);
        let j = serde_json::to_string(&m).unwrap();
        assert_eq!(j, r#"{"ref_max":60.0}"#);
        let back: FeatMap = serde_json::from_str(r#"{"a":1.5,"b":null}"#).unwrap();
        assert_eq!(back.get("a"), 1.5);
        assert!(back.get("b").is_nan());
    }
}
