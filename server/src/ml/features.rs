//! Feature schemas: the fixed per-candidate features (versioned) plus optional environment
//! features from gridded sources. A model stores its schema; inference rebuilds the same vector.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Bump when an extractor's output for the same input changes (invalidates cached samples).
pub const RADAR_CELL_VERSION: u32 = 1;
/// v2: day-of-year harmonics, HRRR / NWP-forecast / satellite / other sources, target features
pub const GRID_POINT_VERSION: u32 = 2;

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
        f("doy_sin", "Season (sin of day of year)", "", "Context"),
        f("doy_cos", "Season (cos of day of year)", "", "Context"),
    ]
}

/// Features that only some targets have (lead time, window, the current observation).
pub fn target_features(target: &str) -> Vec<FeatureDef> {
    match target {
        "temp_forecast" => vec![f("lead_h", "Forecast lead", "h", "Target"), f("obs_now", "Current 2 m temperature (URMA / RTMA analysis)", "°C", "Target")],
        "precip_forecast" => vec![f("lead_h", "Accumulation window", "h", "Target"), f("obs_now", "Precipitation in the previous window (MRMS QPE)", "mm", "Target")],
        "storm_forecast" => vec![f("lead_h", "Forecast lead", "h", "Target"), f("obs_now", "Current max composite reflectivity within the radius", "dBZ", "Target")],
        "tropical_forecast" => vec![f("lead_h", "Formation window", "h", "Target")],
        "outlook" => vec![f("lead_h", "Hours from issue to the window start", "h", "Target"), f("win_h", "Window length", "h", "Target")],
        "storm_track" => vec![
            f("lead_min", "Lead time of the predicted position", "min", "Track"),
            f("motion_u_kt", "Cell motion, east component", "kt", "Track"),
            f("motion_v_kt", "Cell motion, north component", "kt", "Track"),
            f("prev_u_kt", "Previous cell motion, east component", "kt", "Track"),
            f("prev_v_kt", "Previous cell motion, north component", "kt", "Track"),
            f("track_age_min", "Time the cell has been tracked", "min", "Track"),
            f("ext_dx_km", "Extrapolated displacement east (motion × lead)", "km", "Track"),
            f("ext_dy_km", "Extrapolated displacement north (motion × lead)", "km", "Track"),
            f("steer_u_kt", "Steering wind, east (HRRR storm motion or GFS 0–6 km mean wind)", "kt", "Environment"),
            f("steer_v_kt", "Steering wind, north", "kt", "Environment"),
            f("bunkers_u_kt", "Bunkers right-mover motion, east (GFS mean wind + shear)", "kt", "Environment"),
            f("bunkers_v_kt", "Bunkers right-mover motion, north", "kt", "Environment"),
        ],
        _ => vec![],
    }
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
        f("metar_ttend", "Nearest METAR 1 h temperature change", "°C", "METAR"),
        f("metar_dist_km", "Distance to nearest METAR", "km", "METAR"),
    ]
}

/// MRMS fields usable as features: id, name, unit (see [`MRMS_PRODUCTS`] for the files).
pub const MRMS_FIELDS: &[(&str, &str, &str)] = &[
    ("azs02", "MRMS low-level azimuthal shear (max within 5 km)", "1/s"),
    ("azs36", "MRMS mid-level (3–6 km) azimuthal shear (max within 5 km)", "1/s"),
    ("mesh", "MRMS MESH (max within 5 km)", "mm"),
    ("mesh60", "MRMS MESH 60 min max (max within 5 km)", "mm"),
    ("shi", "MRMS severe hail index", ""),
    ("posh", "MRMS probability of severe hail", "%"),
    ("vil", "MRMS VIL (max within 5 km)", "kg/m²"),
    ("vild", "MRMS VIL density", "g/m³"),
    ("et18", "MRMS 18 dBZ echo top (max within 5 km)", "km"),
    ("et30", "MRMS 30 dBZ echo top", "km"),
    ("et50", "MRMS 50 dBZ echo top", "km"),
    ("cref", "MRMS composite reflectivity (max within 5 km)", "dBZ"),
    ("cref1h", "MRMS composite reflectivity 1 h max", "dBZ"),
    ("ref_m20c", "MRMS reflectivity at −20 °C", "dBZ"),
    ("h50_m20c", "MRMS height of 50 dBZ above the −20 °C level", "km"),
    ("rot2h", "MRMS 2 h rotation track", "1/s"),
    ("rot60", "MRMS 60 min low-level rotation track", "1/s"),
    ("rotml60", "MRMS 60 min mid-level rotation track", "1/s"),
    ("ltg30", "MRMS lightning probability next 30 min", "%"),
    ("prate", "MRMS precipitation rate", "mm/h"),
    ("qpe1h", "MRMS 1 h QPE", "mm"),
    ("qpe3h", "MRMS 3 h QPE", "mm"),
    ("qpe6h", "MRMS 6 h QPE", "mm"),
    ("qpe12h", "MRMS 12 h QPE", "mm"),
    ("qpe24h", "MRMS 24 h QPE", "mm"),
    ("qpe72h", "MRMS 72 h QPE", "mm"),
    ("flash_crest_unit", "FLASH CREST max unit streamflow", "m³/s/km²"),
    ("flash_crest_q", "FLASH CREST max streamflow", "m³/s"),
    ("flash_soil", "FLASH CREST max soil saturation", "%"),
    ("flash_ari01h", "FLASH QPE return period 1 h", "yr"),
    ("flash_ari03h", "FLASH QPE return period 3 h", "yr"),
    ("flash_ari06h", "FLASH QPE return period 6 h", "yr"),
    ("flash_ffg01h", "FLASH QPE/FFG ratio 1 h", "ratio"),
    ("flash_ffg03h", "FLASH QPE/FFG ratio 3 h", "ratio"),
    ("flash_ffg06h", "FLASH QPE/FFG ratio 6 h", "ratio"),
];

/// MRMS file for each feature: id, product directory, max file age (min), value when there is
/// no echo / no data (NaN = keep missing).
pub const MRMS_PRODUCTS: &[(&str, &str, u32, f32)] = &[
    ("azs02", "MergedAzShear_0-2kmAGL_00.50", 12, 0.0),
    ("azs36", "MergedAzShear_3-6kmAGL_00.50", 12, 0.0),
    ("mesh", "MESH_00.50", 12, 0.0),
    ("mesh60", "MESH_Max_60min_00.50", 12, 0.0),
    ("shi", "SHI_00.50", 12, 0.0),
    ("posh", "POSH_00.50", 12, 0.0),
    ("vil", "VIL_00.50", 12, 0.0),
    ("vild", "VIL_Density_00.50", 12, 0.0),
    ("et18", "EchoTop_18_00.50", 12, 0.0),
    ("et30", "EchoTop_30_00.50", 12, 0.0),
    ("et50", "EchoTop_50_00.50", 12, 0.0),
    ("cref", "MergedReflectivityQCComposite_00.50", 12, 0.0),
    ("cref1h", "CREF_1HR_MAX_00.50", 15, 0.0),
    ("ref_m20c", "Reflectivity_-20C_00.50", 12, 0.0),
    ("h50_m20c", "H50_Above_-20C_00.50", 12, 0.0),
    ("rot2h", "RotationTrack120min_00.50", 12, 0.0),
    ("rot60", "RotationTrack60min_00.50", 12, 0.0),
    ("rotml60", "RotationTrackML60min_00.50", 12, 0.0),
    ("ltg30", "LightningProbabilityNext30minGrid_scale_1", 12, 0.0),
    ("prate", "PrecipRate_00.00", 12, 0.0),
    ("qpe1h", "MultiSensor_QPE_01H_Pass2_00.00", 65, 0.0),
    ("qpe3h", "MultiSensor_QPE_03H_Pass2_00.00", 65, 0.0),
    ("qpe6h", "MultiSensor_QPE_06H_Pass2_00.00", 65, 0.0),
    ("qpe12h", "MultiSensor_QPE_12H_Pass2_00.00", 65, 0.0),
    ("qpe24h", "MultiSensor_QPE_24H_Pass2_00.00", 65, 0.0),
    ("qpe72h", "MultiSensor_QPE_72H_Pass2_00.00", 65, 0.0),
    ("flash_crest_unit", "FLASH_CREST_MAXUNITSTREAMFLOW_00.00", 15, 0.0),
    ("flash_crest_q", "FLASH_CREST_MAXSTREAMFLOW_00.00", 15, 0.0),
    ("flash_soil", "FLASH_CREST_MAXSOILSAT_00.00", 15, f32::NAN),
    ("flash_ari01h", "FLASH_QPE_ARI01H_00.00", 15, 0.0),
    ("flash_ari03h", "FLASH_QPE_ARI03H_00.00", 15, 0.0),
    ("flash_ari06h", "FLASH_QPE_ARI06H_00.00", 15, 0.0),
    ("flash_ffg01h", "FLASH_QPE_FFG01H_00.00", 15, 0.0),
    ("flash_ffg03h", "FLASH_QPE_FFG03H_00.00", 15, 0.0),
    ("flash_ffg06h", "FLASH_QPE_FFG06H_00.00", 15, 0.0),
];

pub fn mrms_product(id: &str) -> Option<&'static (&'static str, &'static str, u32, f32)> {
    MRMS_PRODUCTS.iter().find(|p| p.0 == id)
}

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
    /// lapse rate (K/km) with pats = [T low, T high, Z low, Z high]
    Lapse,
    /// the first of the patterns present in the file
    Alt,
    /// accumulation (APCP) over the file's own window ("0-N hour acc")
    Accum,
    /// mean of all patterns
    Mean,
    /// pats[1] − pats[0]
    Diff,
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
    ModelVar { id: "elev", name: "Terrain height (model orography)", unit: "m", pats: &["HGT:surface"], kind: VarKind::Plain },
    ModelVar { id: "mlcape", name: "Mixed-layer CAPE", unit: "J/kg", pats: &["CAPE:90-0 mb above ground", "CAPE:180-0 mb above ground"], kind: VarKind::Alt },
    ModelVar { id: "lftx4", name: "Best (4-layer) lifted index", unit: "K", pats: &["4LFTX:surface"], kind: VarKind::Plain },
    ModelVar { id: "srh01", name: "0–1 km storm-relative helicity", unit: "m²/s²", pats: &["HLCY:1000-0 m above ground"], kind: VarKind::Plain },
    ModelVar { id: "t500", name: "500 mb temperature", unit: "°C", pats: &["TMP:500 mb"], kind: VarKind::KToC },
    ModelVar { id: "t700", name: "700 mb temperature", unit: "°C", pats: &["TMP:700 mb"], kind: VarKind::KToC },
    ModelVar { id: "t850", name: "850 mb temperature", unit: "°C", pats: &["TMP:850 mb"], kind: VarKind::KToC },
    ModelVar { id: "rh500", name: "500 mb relative humidity", unit: "%", pats: &["RH:500 mb"], kind: VarKind::Plain },
    ModelVar { id: "rh850", name: "850 mb relative humidity", unit: "%", pats: &["RH:850 mb"], kind: VarKind::Plain },
    ModelVar { id: "lapse75", name: "700–500 mb lapse rate", unit: "K/km", pats: &["TMP:700 mb", "TMP:500 mb", "HGT:700 mb", "HGT:500 mb"], kind: VarKind::Lapse },
    ModelVar { id: "absv700", name: "700 mb absolute vorticity", unit: "10⁻⁵ s⁻¹", pats: &["ABSV:700 mb"], kind: VarKind::Times1e5 },
    ModelVar { id: "vvel500", name: "500 mb vertical velocity (ω)", unit: "Pa/s", pats: &["VVEL:500 mb"], kind: VarKind::Plain },
    ModelVar { id: "wind850", name: "850 mb wind speed", unit: "m/s", pats: &["UGRD:850 mb", "VGRD:850 mb"], kind: VarKind::Speed },
    ModelVar { id: "wind250", name: "250 mb wind speed", unit: "m/s", pats: &["UGRD:250 mb", "VGRD:250 mb"], kind: VarKind::Speed },
    ModelVar { id: "hgt500", name: "500 mb height", unit: "m", pats: &["HGT:500 mb"], kind: VarKind::Plain },
    ModelVar { id: "soilw2", name: "Soil moisture 10–40 cm", unit: "fraction", pats: &["SOILW:0.1-0.4 m below ground"], kind: VarKind::Plain },
    ModelVar { id: "weasd", name: "Snow water equivalent", unit: "kg/m²", pats: &["WEASD:surface"], kind: VarKind::Plain },
    ModelVar { id: "snod", name: "Snow depth", unit: "m", pats: &["SNOD:surface"], kind: VarKind::Plain },
    ModelVar { id: "mwu", name: "0–6 km mean wind, east (850/700/500/300 mb)", unit: "m/s", pats: &["UGRD:850 mb", "UGRD:700 mb", "UGRD:500 mb", "UGRD:300 mb"], kind: VarKind::Mean },
    ModelVar { id: "mwv", name: "0–6 km mean wind, north", unit: "m/s", pats: &["VGRD:850 mb", "VGRD:700 mb", "VGRD:500 mb", "VGRD:300 mb"], kind: VarKind::Mean },
    ModelVar { id: "shru", name: "10 m–500 mb shear vector, east", unit: "m/s", pats: &["UGRD:10 m above ground", "UGRD:500 mb"], kind: VarKind::Diff },
    ModelVar { id: "shrv", name: "10 m–500 mb shear vector, north", unit: "m/s", pats: &["VGRD:10 m above ground", "VGRD:500 mb"], kind: VarKind::Diff },
];

/// HRRR "analysis" variables (forecast hour 1 of the run an hour before the time, so hourly
/// maxima such as updraft helicity exist).
pub const HRRR_VARS: &[ModelVar] = &[
    ModelVar { id: "cape", name: "Surface CAPE", unit: "J/kg", pats: &["CAPE:surface"], kind: VarKind::Plain },
    ModelVar { id: "mlcape", name: "Mixed-layer CAPE", unit: "J/kg", pats: &["CAPE:90-0 mb above ground"], kind: VarKind::Plain },
    ModelVar { id: "mucape", name: "Most-unstable CAPE", unit: "J/kg", pats: &["CAPE:255-0 mb above ground"], kind: VarKind::Plain },
    ModelVar { id: "cin", name: "Surface CIN", unit: "J/kg", pats: &["CIN:surface"], kind: VarKind::Plain },
    ModelVar { id: "mlcin", name: "Mixed-layer CIN", unit: "J/kg", pats: &["CIN:90-0 mb above ground"], kind: VarKind::Plain },
    ModelVar { id: "srh01", name: "0–1 km storm-relative helicity", unit: "m²/s²", pats: &["HLCY:1000-0 m above ground"], kind: VarKind::Plain },
    ModelVar { id: "srh03", name: "0–3 km storm-relative helicity", unit: "m²/s²", pats: &["HLCY:3000-0 m above ground"], kind: VarKind::Plain },
    ModelVar { id: "shear06", name: "0–6 km bulk shear", unit: "m/s", pats: &["VUCSH:0-6000 m above ground", "VVCSH:0-6000 m above ground"], kind: VarKind::Speed },
    ModelVar { id: "shear01", name: "0–1 km bulk shear", unit: "m/s", pats: &["VUCSH:0-1000 m above ground", "VVCSH:0-1000 m above ground"], kind: VarKind::Speed },
    ModelVar { id: "uh25", name: "2–5 km updraft helicity (1 h max)", unit: "m²/s²", pats: &["MXUPHL:5000-2000 m above ground"], kind: VarKind::Plain },
    ModelVar { id: "refc", name: "Simulated composite reflectivity", unit: "dBZ", pats: &["REFC:entire atmosphere"], kind: VarKind::Plain },
    ModelVar { id: "ltng", name: "Lightning threat", unit: "flashes/km²/5min", pats: &["LTNG:entire atmosphere"], kind: VarKind::Plain },
    ModelVar { id: "pwat", name: "Precipitable water", unit: "mm", pats: &["PWAT:entire atmosphere"], kind: VarKind::Plain },
    ModelVar { id: "t2m", name: "2 m temperature", unit: "°C", pats: &["TMP:2 m above ground"], kind: VarKind::KToC },
    ModelVar { id: "td2m", name: "2 m dewpoint", unit: "°C", pats: &["DPT:2 m above ground"], kind: VarKind::KToC },
    ModelVar { id: "gust", name: "Surface gust", unit: "m/s", pats: &["GUST:surface"], kind: VarKind::Plain },
    ModelVar { id: "hgt0c", name: "Freezing level height", unit: "m", pats: &["HGT:0C isotherm"], kind: VarKind::Plain },
    ModelVar { id: "lcl", name: "LCL height", unit: "m", pats: &["HGT:level of adiabatic condensation from sfc"], kind: VarKind::Plain },
    ModelVar { id: "apcp1h", name: "1 h precipitation", unit: "mm", pats: &["APCP:surface"], kind: VarKind::Accum },
    ModelVar { id: "ustm", name: "Storm motion (Bunkers right mover), east", unit: "m/s", pats: &["USTM:0-6000 m above ground"], kind: VarKind::Plain },
    ModelVar { id: "vstm", name: "Storm motion (Bunkers right mover), north", unit: "m/s", pats: &["VSTM:0-6000 m above ground"], kind: VarKind::Plain },
];

/// How a forecast field is summarised over the target window.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Agg {
    /// valid at the window end
    At,
    Max,
    Min,
    Mean,
    /// accumulated over the window
    Acc,
}

impl Agg {
    pub fn name(&self) -> &'static str {
        match self {
            Agg::At => "at the valid time",
            Agg::Max => "window max",
            Agg::Min => "window min",
            Agg::Mean => "window mean",
            Agg::Acc => "window total",
        }
    }
}

/// NWP forecast fields valid over the target window (MOS-like features): GFS and HRRR patterns.
pub struct FcVar {
    pub id: &'static str,
    pub name: &'static str,
    pub unit: &'static str,
    pub agg: Agg,
    pub gfs: (&'static [&'static str], VarKind),
    pub hrrr: (&'static [&'static str], VarKind),
}

const NONE: (&[&str], VarKind) = (&[], VarKind::Plain);

pub const FC_VARS: &[FcVar] = &[
    FcVar { id: "t2m", name: "2 m temperature", unit: "°C", agg: Agg::At, gfs: (&["TMP:2 m above ground"], VarKind::KToC), hrrr: (&["TMP:2 m above ground"], VarKind::KToC) },
    FcVar { id: "td2m", name: "2 m dewpoint", unit: "°C", agg: Agg::At, gfs: (&["DPT:2 m above ground"], VarKind::KToC), hrrr: (&["DPT:2 m above ground"], VarKind::KToC) },
    FcVar { id: "rh2m", name: "2 m relative humidity", unit: "%", agg: Agg::At, gfs: (&["RH:2 m above ground"], VarKind::Plain), hrrr: (&["RH:2 m above ground"], VarKind::Plain) },
    FcVar { id: "tmax", name: "2 m temperature (max)", unit: "°C", agg: Agg::Max, gfs: (&["TMP:2 m above ground"], VarKind::KToC), hrrr: (&["TMP:2 m above ground"], VarKind::KToC) },
    FcVar { id: "tmin", name: "2 m temperature (min)", unit: "°C", agg: Agg::Min, gfs: (&["TMP:2 m above ground"], VarKind::KToC), hrrr: (&["TMP:2 m above ground"], VarKind::KToC) },
    FcVar { id: "wind10", name: "10 m wind speed", unit: "m/s", agg: Agg::Max, gfs: (&["UGRD:10 m above ground", "VGRD:10 m above ground"], VarKind::Speed), hrrr: (&["UGRD:10 m above ground", "VGRD:10 m above ground"], VarKind::Speed) },
    FcVar { id: "gust", name: "Surface gust", unit: "m/s", agg: Agg::Max, gfs: (&["GUST:surface"], VarKind::Plain), hrrr: (&["GUST:surface"], VarKind::Plain) },
    FcVar { id: "mslp", name: "Sea-level pressure", unit: "hPa", agg: Agg::At, gfs: (&["PRMSL:mean sea level"], VarKind::PaToHpa), hrrr: (&["MSLMA:mean sea level"], VarKind::PaToHpa) },
    FcVar { id: "mslp_min", name: "Sea-level pressure (min)", unit: "hPa", agg: Agg::Min, gfs: (&["PRMSL:mean sea level"], VarKind::PaToHpa), hrrr: (&["MSLMA:mean sea level"], VarKind::PaToHpa) },
    FcVar { id: "tcc", name: "Total cloud cover", unit: "%", agg: Agg::Mean, gfs: (&["TCDC:entire atmosphere"], VarKind::Plain), hrrr: (&["TCDC:entire atmosphere"], VarKind::Plain) },
    FcVar { id: "apcp", name: "Precipitation (QPF)", unit: "mm", agg: Agg::Acc, gfs: (&["APCP:surface"], VarKind::Accum), hrrr: (&["APCP:surface"], VarKind::Accum) },
    FcVar { id: "cape", name: "Surface CAPE", unit: "J/kg", agg: Agg::Max, gfs: (&["CAPE:surface"], VarKind::Plain), hrrr: (&["CAPE:surface"], VarKind::Plain) },
    FcVar { id: "mucape", name: "Most-unstable CAPE", unit: "J/kg", agg: Agg::Max, gfs: (&["CAPE:255-0 mb above ground"], VarKind::Plain), hrrr: (&["CAPE:255-0 mb above ground"], VarKind::Plain) },
    FcVar { id: "mlcape", name: "Mixed-layer CAPE", unit: "J/kg", agg: Agg::Max, gfs: (&["CAPE:90-0 mb above ground", "CAPE:180-0 mb above ground"], VarKind::Alt), hrrr: (&["CAPE:90-0 mb above ground"], VarKind::Plain) },
    FcVar { id: "cin", name: "Surface CIN", unit: "J/kg", agg: Agg::At, gfs: (&["CIN:surface"], VarKind::Plain), hrrr: (&["CIN:surface"], VarKind::Plain) },
    FcVar { id: "lftx", name: "Lifted index", unit: "K", agg: Agg::Min, gfs: (&["LFTX:surface"], VarKind::Plain), hrrr: (&["LFTX:500-1000 mb"], VarKind::Plain) },
    FcVar { id: "srh03", name: "0–3 km helicity", unit: "m²/s²", agg: Agg::Max, gfs: (&["HLCY:3000-0 m above ground"], VarKind::Plain), hrrr: (&["HLCY:3000-0 m above ground"], VarKind::Plain) },
    FcVar { id: "srh01", name: "0–1 km helicity", unit: "m²/s²", agg: Agg::Max, gfs: (&["HLCY:1000-0 m above ground"], VarKind::Plain), hrrr: (&["HLCY:1000-0 m above ground"], VarKind::Plain) },
    FcVar { id: "shear06", name: "0–6 km bulk shear", unit: "m/s", agg: Agg::Max, gfs: (&["UGRD:10 m above ground", "VGRD:10 m above ground", "UGRD:500 mb", "VGRD:500 mb"], VarKind::Shear), hrrr: (&["VUCSH:0-6000 m above ground", "VVCSH:0-6000 m above ground"], VarKind::Speed) },
    FcVar { id: "uh25", name: "2–5 km updraft helicity", unit: "m²/s²", agg: Agg::Max, gfs: NONE, hrrr: (&["MXUPHL:5000-2000 m above ground"], VarKind::Plain) },
    FcVar { id: "refc", name: "Composite reflectivity", unit: "dBZ", agg: Agg::Max, gfs: (&["REFC:entire atmosphere"], VarKind::Plain), hrrr: (&["REFC:entire atmosphere"], VarKind::Plain) },
    FcVar { id: "ltng", name: "Lightning threat", unit: "flashes/km²/5min", agg: Agg::Max, gfs: NONE, hrrr: (&["LTNG:entire atmosphere"], VarKind::Plain) },
    FcVar { id: "pwat", name: "Precipitable water", unit: "mm", agg: Agg::Max, gfs: (&["PWAT:entire atmosphere"], VarKind::Plain), hrrr: (&["PWAT:entire atmosphere"], VarKind::Plain) },
    FcVar { id: "t850", name: "850 mb temperature", unit: "°C", agg: Agg::At, gfs: (&["TMP:850 mb"], VarKind::KToC), hrrr: (&["TMP:850 mb"], VarKind::KToC) },
    FcVar { id: "lapse75", name: "700–500 mb lapse rate", unit: "K/km", agg: Agg::Max, gfs: (&["TMP:700 mb", "TMP:500 mb", "HGT:700 mb", "HGT:500 mb"], VarKind::Lapse), hrrr: (&["TMP:700 mb", "TMP:500 mb", "HGT:700 mb", "HGT:500 mb"], VarKind::Lapse) },
    FcVar { id: "absv850", name: "850 mb absolute vorticity", unit: "10⁻⁵ s⁻¹", agg: Agg::Max, gfs: (&["ABSV:850 mb"], VarKind::Times1e5), hrrr: NONE },
    FcVar { id: "shear_850_200", name: "850–200 mb shear (min)", unit: "m/s", agg: Agg::Min, gfs: (&["UGRD:850 mb", "VGRD:850 mb", "UGRD:200 mb", "VGRD:200 mb"], VarKind::Shear), hrrr: NONE },
    FcVar { id: "rh700", name: "700 mb relative humidity", unit: "%", agg: Agg::Mean, gfs: (&["RH:700 mb"], VarKind::Plain), hrrr: (&["RH:700 mb"], VarKind::Plain) },
    FcVar { id: "hgt0c", name: "Freezing level", unit: "m", agg: Agg::At, gfs: (&["HGT:0C isotherm"], VarKind::Plain), hrrr: (&["HGT:0C isotherm"], VarKind::Plain) },
];

pub fn fc_var(id: &str) -> Option<&'static FcVar> {
    FC_VARS.iter().find(|v| v.id == id)
}

pub fn hrrr_var(id: &str) -> Option<&'static ModelVar> {
    HRRR_VARS.iter().find(|v| v.id == id)
}

/// GOES satellite features: id, name, unit.
pub const SAT_FIELDS: &[(&str, &str, &str)] = &[
    ("tb13", "GOES ABI band 13 (10.3 µm) brightness temperature", "K"),
    ("tb13_min", "GOES band 13 min brightness temperature within 15 km", "K"),
    ("ccf", "GOES cold-cloud fraction (band 13 < 235 K) within 50 km", "fraction"),
    ("cool13", "GOES cloud-top cooling: change of the 15 km band-13 minimum over ~15 min", "K"),
    ("wv8", "GOES band 8 upper-level water vapour BT", "K"),
    ("wv9", "GOES band 9 mid-level water vapour BT", "K"),
    ("wv10", "GOES band 10 low-level water vapour BT", "K"),
    ("ref02", "GOES band 2 visible reflectance (day only)", ""),
    ("glm10", "GOES GLM flashes within 20 km, last 10 min", "count"),
    ("glm30", "GOES GLM flashes within 20 km, last 30 min", "count"),
    ("glm_jump", "GOES GLM lightning jump (last 10 min minus the 10-min mean of the 20 min before)", "count"),
];

/// Other sources: id, name, unit.
pub const OTHER_FIELDS: &[(&str, &str, &str)] = &[("drought", "US Drought Monitor class (−1 none, 0 = D0 … 4 = D4)", "class")];

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
    /// HRRR analysis variable ids (see HRRR_VARS)
    pub hrrr: Vec<String>,
    /// NWP forecast fields over the target window (see FC_VARS)
    pub fcst: Vec<String>,
    /// gfs | hrrr | auto (HRRR when the window fits its 18 h range, else GFS)
    pub fcst_model: String,
    /// forecast-hour step (h) when summarising a window; 0 = automatic
    pub fcst_step_h: u32,
    /// GOES ABI / GLM features (see SAT_FIELDS)
    pub satellite: Vec<String>,
    /// other sources (see OTHER_FIELDS)
    pub other: Vec<String>,
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
        s.hrrr.retain(|m| hrrr_var(m).is_some());
        s.hrrr.sort();
        s.hrrr.dedup();
        s.fcst.retain(|m| fc_var(m).is_some());
        s.fcst.sort();
        s.fcst.dedup();
        s.satellite.retain(|m| SAT_FIELDS.iter().any(|f| f.0 == m));
        s.satellite.sort();
        s.satellite.dedup();
        s.other.retain(|m| OTHER_FIELDS.iter().any(|f| f.0 == m));
        s.other.sort();
        s.other.dedup();
        if !matches!(s.fcst_model.as_str(), "gfs" | "hrrr" | "auto") {
            s.fcst_model = if s.fcst.is_empty() { String::new() } else { "gfs".into() };
        }
        s
    }
    pub fn is_empty(&self) -> bool {
        self.mrms.is_empty() && !self.metar && self.model.is_empty() && self.hrrr.is_empty() && self.fcst.is_empty() && self.satellite.is_empty() && self.other.is_empty()
    }
    /// Cache key (identical to the v1 key when only v1 sources are used).
    pub fn key(&self) -> String {
        let mut k = format!("m:{};w:{};g:{}", self.mrms.join(","), self.metar as u8, self.model.join(","));
        if !self.hrrr.is_empty() {
            k.push_str(&format!(";h:{}", self.hrrr.join(",")));
        }
        if !self.fcst.is_empty() {
            k.push_str(&format!(";f:{}@{}/{}", self.fcst.join(","), self.fcst_model, self.fcst_step_h));
        }
        if !self.satellite.is_empty() {
            k.push_str(&format!(";s:{}", self.satellite.join(",")));
        }
        if !self.other.is_empty() {
            k.push_str(&format!(";o:{}", self.other.join(",")));
        }
        k
    }
    /// Only the sources that depend on the target window (forecast fields).
    pub fn forecast_part(&self) -> Sources {
        Sources { fcst: self.fcst.clone(), fcst_model: self.fcst_model.clone(), fcst_step_h: self.fcst_step_h, ..Default::default() }
    }
    /// Everything except the forecast fields.
    pub fn analysis_part(&self) -> Sources {
        Sources { fcst: vec![], fcst_model: String::new(), fcst_step_h: 0, ..self.clone() }
    }
    /// Union of two source sets.
    pub fn union(&self, o: &Sources) -> Sources {
        let mut s = self.clone();
        s.mrms.extend(o.mrms.iter().cloned());
        s.metar |= o.metar;
        s.model.extend(o.model.iter().cloned());
        s.hrrr.extend(o.hrrr.iter().cloned());
        s.fcst.extend(o.fcst.iter().cloned());
        if s.fcst_model.is_empty() {
            s.fcst_model = o.fcst_model.clone();
        }
        s.satellite.extend(o.satellite.iter().cloned());
        s.other.extend(o.other.iter().cloned());
        s.normalized()
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
    for m in &s.hrrr {
        if let Some(v) = hrrr_var(m) {
            out.push(f(&format!("hrrr_{}", v.id), &format!("HRRR {}", v.name), v.unit, "Model (HRRR analysis)"));
        }
    }
    for m in &s.fcst {
        if let Some(v) = fc_var(m) {
            out.push(f(&format!("fc_{}", v.id), &format!("Forecast {} ({})", v.name, v.agg.name()), v.unit, "Model forecast (target window)"));
        }
    }
    for m in &s.satellite {
        if let Some(d) = SAT_FIELDS.iter().find(|x| x.0 == m) {
            out.push(f(&format!("sat_{}", d.0), d.1, d.2, "Satellite (GOES)"));
        }
    }
    for m in &s.other {
        if let Some(d) = OTHER_FIELDS.iter().find(|x| x.0 == m) {
            out.push(f(&format!("{}_class", d.0), d.1, d.2, "Other"));
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

/// Every feature of a target (candidate base, target features, environment).
pub fn all_features_for(target: &str, candidate: &str, s: &Sources) -> Vec<FeatureDef> {
    let mut v = match candidate {
        "radar_cell" => radar_cell_base(),
        _ => grid_point_base(),
    };
    v.extend(target_features(target));
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
    /// Schema for a target (adds the target's own features such as the lead time).
    pub fn for_target(target: &str, candidate: &str, sources: &Sources, ids: &[String]) -> Schema {
        let s = sources.normalized();
        let mut feats = all_features_for(target, candidate, &s);
        if !ids.is_empty() {
            feats.retain(|f| ids.contains(&f.id));
        }
        Schema { candidate: candidate.into(), version: candidate_version(candidate), sources: s, features: feats }
    }
    pub fn ids(&self) -> Vec<String> {
        self.features.iter().map(|f| f.id.clone()).collect()
    }
}

/// Context features of a grid point at time `t`.
pub fn set_context(fm: &mut FeatMap, lat: f64, lon: f64, t: i64) {
    fm.set("lat", lat as f32);
    fm.set("lon", lon as f32);
    let d = day_of_year(t);
    fm.set("doy", d);
    fm.set("solar_hour", solar_hour(t, lon));
    let a = d as f64 / 365.25 * std::f64::consts::TAU;
    fm.set("doy_sin", a.sin() as f32);
    fm.set("doy_cos", a.cos() as f32);
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

/// Storm-track features of a cell for a lead (minutes): motion components, extrapolation and
/// steering winds from the environment features present.
pub fn track_features(fm: &mut FeatMap, lead_min: f64) {
    const KT: f32 = 1.943_844;
    fm.set("lead_min", lead_min as f32);
    let (u, v) = (fm.get("motion_u_kt"), fm.get("motion_v_kt"));
    if u.is_finite() && v.is_finite() {
        let h = lead_min as f32 / 60.0;
        fm.set("ext_dx_km", u * 1.852 * h);
        fm.set("ext_dy_km", v * 1.852 * h);
    }
    let (su, sv) = match (fm.get("hrrr_ustm"), fm.get("hrrr_vstm")) {
        (a, b) if a.is_finite() && b.is_finite() => (a, b),
        _ => (fm.get("gfs_mwu"), fm.get("gfs_mwv")),
    };
    if su.is_finite() && sv.is_finite() {
        fm.set("steer_u_kt", su * KT);
        fm.set("steer_v_kt", sv * KT);
    }
    let (mu, mv, shu, shv) = (fm.get("gfs_mwu"), fm.get("gfs_mwv"), fm.get("gfs_shru"), fm.get("gfs_shrv"));
    if [mu, mv, shu, shv].iter().all(|x| x.is_finite()) {
        let n = (shu * shu + shv * shv).sqrt().max(0.1);
        // right mover: 7.5 m/s to the right of the shear vector
        fm.set("bunkers_u_kt", (mu + 7.5 * shv / n) * KT);
        fm.set("bunkers_v_kt", (mv - 7.5 * shu / n) * KT);
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
