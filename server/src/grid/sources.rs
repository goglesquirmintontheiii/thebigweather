//! Catalog of gridded layers and how to list / fetch each source.

use super::decode::Transform;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct LayerDef {
    /// stable id used by apps, e.g. "mrms/cref", "model/hrrr/t2m"
    pub id: String,
    pub group: String,
    pub name: String,
    pub units: &'static str,
    pub cmap: &'static str,
    /// source-specific selector (MRMS product dir, NDFD element, METAR field, GOES band...)
    #[serde(skip)]
    pub product: String,
    #[serde(skip)]
    pub transform: Transform,
    #[serde(skip)]
    pub nodata: Vec<f32>,
    #[serde(skip)]
    pub min_valid: Option<f32>,
    /// source kind: mrms | model | ndfd | metar | goes | future | opera | cwa
    pub source: &'static str,
    /// model id for model layers
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// minutes between frames (for UI hints)
    pub step_min: u32,
}

// ---------------- MRMS ----------------

pub const MRMS_BUCKET: &str = "noaa-mrms-pds";

struct M(&'static str, &'static str, &'static str, &'static str, &'static str, &'static str);

const MRMS: &[M] = &[
    // id, group, name, product dir, units, cmap
    M("cref", "Reflectivity", "Composite Reflectivity", "MergedReflectivityQCComposite_00.50", "dBZ", "REF"),
    M("bref", "Reflectivity", "Base Reflectivity", "MergedBaseReflectivityQC_00.50", "dBZ", "REF"),
    M("lowalt", "Reflectivity", "Lowest-Altitude Reflectivity", "ReflectivityAtLowestAltitude_00.50", "dBZ", "REF"),
    M("seamless", "Reflectivity", "Seamless Hybrid Scan Refl.", "SeamlessHSR_00.00", "dBZ", "REF"),
    M("cref1h", "Reflectivity", "Composite Refl. 1-hr Max", "CREF_1HR_MAX_00.50", "dBZ", "REF"),
    M("ptype", "Winter / Precip", "Precipitation Type", "PrecipFlag_00.00", "class", "PTYPE"),
    M("prate", "Winter / Precip", "Precipitation Rate", "PrecipRate_00.00", "mm/h", "PRATE"),
    M("mesh", "Hail", "Hail Size (MESH)", "MESH_00.50", "mm", "MESH"),
    M("mesh1h", "Hail", "Max Hail Size 1 hr", "MESH_Max_60min_00.50", "mm", "MESH"),
    M("mesh2h", "Hail", "Max Hail Size 2 hr", "MESH_Max_120min_00.50", "mm", "MESH"),
    M("mesh4h", "Hail", "Max Hail Size 4 hr", "MESH_Max_240min_00.50", "mm", "MESH"),
    M("mesh24h", "Hail", "Max Hail Size 24 hr", "MESH_Max_1440min_00.50", "mm", "MESH"),
    M("posh", "Hail", "Prob. of Severe Hail", "POSH_00.50", "%", "PROB"),
    M("rot2h", "Rotation", "Rotation Track 2 hr", "RotationTrack120min_00.50", "1/s", "ROT"),
    M("rot24h", "Rotation", "Rotation Track 24 hr", "RotationTrack1440min_00.50", "1/s", "ROT"),
    M("azs02", "Rotation", "Low-Level Az Shear (0-2 km)", "MergedAzShear_0-2kmAGL_00.50", "1/s", "AZSHEAR"),
    M("ltg30", "Lightning", "Lightning Prob. 30 min", "LightningProbabilityNext30minGrid_scale_1", "%", "PROB"),
    M("ltg60", "Lightning", "Lightning Prob. 60 min", "LightningProbabilityNext60minGrid_scale_1", "%", "PROB"),
    M("vil", "Storm", "Vertically Integrated Liquid", "VIL_00.50", "kg/m²", "VIL"),
    M("et18", "Storm", "Echo Tops 18 dBZ", "EchoTop_18_00.50", "km", "ETKM"),
    M("et50", "Storm", "Echo Tops 50 dBZ", "EchoTop_50_00.50", "km", "ETKM"),
    M("qpe1h", "Precip Accumulation", "QPE 1 hr", "MultiSensor_QPE_01H_Pass2_00.00", "mm", "PRECIPMM"),
    M("qpe6h", "Precip Accumulation", "QPE 6 hr", "MultiSensor_QPE_06H_Pass2_00.00", "mm", "PRECIPMM"),
    M("qpe24h", "Precip Accumulation", "QPE 24 hr", "MultiSensor_QPE_24H_Pass2_00.00", "mm", "PRECIPMM"),
    M("qpe48h", "Precip Accumulation", "QPE 48 hr", "MultiSensor_QPE_48H_Pass2_00.00", "mm", "PRECIPMM"),
    M("qpe72h", "Precip Accumulation", "QPE 72 hr", "MultiSensor_QPE_72H_Pass2_00.00", "mm", "PRECIPMM"),
    M("rqpe1h", "Precip Accumulation", "Radar-only QPE 1 hr", "RadarOnly_QPE_01H_00.00", "mm", "PRECIPMM"),
];

pub fn mrms_layers() -> Vec<LayerDef> {
    MRMS.iter()
        .map(|m| LayerDef {
            id: format!("mrms/{}", m.0),
            group: format!("MRMS · {}", m.1),
            name: m.2.to_string(),
            units: m.4,
            cmap: m.5,
            product: m.3.to_string(),
            transform: Transform::None,
            // -999 = no coverage, -99 = no echo/missing; precip-type -3 = no coverage
            nodata: if m.0 == "ptype" { vec![-3.0] } else { vec![-999.0, -99.0] },
            min_valid: match m.5 {
                "REF" => Some(-30.0),
                "MESH" | "VIL" | "PRECIPMM" | "PRATE" | "ETKM" => Some(0.0),
                "PROB" => Some(0.0),
                _ => None,
            },
            source: "mrms",
            model: None,
            step_min: 2,
        })
        .collect()
}

// ---------------- Models ----------------

#[derive(Debug, Clone, Serialize)]
pub struct ModelDef {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    #[serde(skip)]
    pub bucket: &'static str,
    /// key template: {ymd} {hh} {fh2} {fh3} {fh}
    #[serde(skip)]
    pub file: &'static str,
    /// listing prefix template for one run: {ymd} {hh}
    #[serde(skip)]
    pub run_prefix: &'static str,
    /// cycles (UTC hours) this model runs
    #[serde(skip)]
    pub cycles: &'static [u32],
    /// "ncep" (.idx) or "ecmwf" (.index json lines) or "http" base for ECMWF
    #[serde(skip)]
    pub index: &'static str,
    pub resolution: &'static str,
}

pub const MODELS: &[ModelDef] = &[
    ModelDef { id: "hrrr", name: "HRRR", group: "Convection-allowing", bucket: "noaa-hrrr-bdp-pds", file: "hrrr.{ymd}/conus/hrrr.t{hh}z.wrfsfcf{fh2}.grib2", run_prefix: "hrrr.{ymd}/conus/hrrr.t{hh}z.wrfsfcf", cycles: &[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23], index: "ncep", resolution: "3 km" },
    ModelDef { id: "rrfs", name: "RRFS", group: "Convection-allowing", bucket: "noaa-rrfs-ops-pds", file: "rrfs.{ymd}/{hh}/rrfs.t{hh}z.prslev.3km.f{fh3}.conus.grib2", run_prefix: "rrfs.{ymd}/{hh}/rrfs.t{hh}z.prslev.3km.f", cycles: &[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23], index: "ncep", resolution: "3 km" },
    ModelDef { id: "nam3", name: "NAM 3 km", group: "Convection-allowing", bucket: "noaa-nam-pds", file: "nam.{ymd}/nam.t{hh}z.conusnest.hiresf{fh2}.tm00.grib2", run_prefix: "nam.{ymd}/nam.t{hh}z.conusnest.hiresf", cycles: &[0, 6, 12, 18], index: "ncep", resolution: "3 km" },
    ModelDef { id: "nam12", name: "NAM 12 km", group: "Regional", bucket: "noaa-nam-pds", file: "nam.{ymd}/nam.t{hh}z.awphys{fh2}.tm00.grib2", run_prefix: "nam.{ymd}/nam.t{hh}z.awphys", cycles: &[0, 6, 12, 18], index: "ncep", resolution: "12 km" },
    ModelDef { id: "rap", name: "RAP", group: "Regional", bucket: "noaa-rap-pds", file: "rap.{ymd}/rap.t{hh}z.awp130pgrbf{fh2}.grib2", run_prefix: "rap.{ymd}/rap.t{hh}z.awp130pgrbf", cycles: &[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23], index: "ncep", resolution: "13 km" },
    ModelDef { id: "nbm", name: "NBM", group: "Regional", bucket: "noaa-nbm-grib2-pds", file: "blend.{ymd}/{hh}/core/blend.t{hh}z.core.f{fh3}.co.grib2", run_prefix: "blend.{ymd}/{hh}/core/blend.t{hh}z.core.f", cycles: &[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23], index: "ncep", resolution: "2.5 km" },
    ModelDef { id: "gfs", name: "GFS", group: "Global", bucket: "noaa-gfs-bdp-pds", file: "gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{fh3}", run_prefix: "gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f", cycles: &[0, 6, 12, 18], index: "ncep", resolution: "0.25°" },
    ModelDef { id: "ecmwf", name: "ECMWF IFS", group: "Global", bucket: "https://data.ecmwf.int/forecasts", file: "{ymd}/{hh}z/ifs/0p25/oper/{ymd}{hh}0000-{fh}h-oper-fc.grib2", run_prefix: "{ymd}/{hh}z/ifs/0p25/oper/", cycles: &[0, 12], index: "ecmwf", resolution: "0.25°" },
    ModelDef { id: "hafsa", name: "HAFS-A", group: "Tropical", bucket: "noaa-nws-hafs-pds", file: "hfsa/{ymd}/{hh}/{storm}.{ymd}{hh}.hfsa.parent.atm.f{fh3}.grb2", run_prefix: "hfsa/{ymd}/{hh}/", cycles: &[0, 6, 12, 18], index: "ncep", resolution: "6 km" },
    // HRRR sub-hourly (15-minute) output; used by the 6-hour future radar, not listed as its own model.
    // Forecast "hours" in keys for this model are minutes.
    ModelDef { id: "hrrrsub", name: "HRRR", group: "Hidden", bucket: "noaa-hrrr-bdp-pds", file: "hrrr.{ymd}/conus/hrrr.t{hh}z.wrfsubhf{fh2}.grib2", run_prefix: "hrrr.{ymd}/conus/hrrr.t{hh}z.wrfsubhf", cycles: &[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23], index: "ncep", resolution: "3 km" },
    ModelDef { id: "hafsb", name: "HAFS-B", group: "Tropical", bucket: "noaa-nws-hafs-pds", file: "hfsb/{ymd}/{hh}/{storm}.{ymd}{hh}.hfsb.parent.atm.f{fh3}.grb2", run_prefix: "hfsb/{ymd}/{hh}/", cycles: &[0, 6, 12, 18], index: "ncep", resolution: "6 km" },
];

/// How to find a variable in a model's index.
#[derive(Debug, Clone)]
pub enum Match {
    /// "VAR:level" prefix match in an NCEP .idx (accumulations prefer "0-{fh} hour")
    Ncep(&'static [&'static str]),
    /// U and V components combined to speed
    NcepUv(&'static str, &'static str),
    /// ECMWF: param, levtype, levelist
    Ec(&'static str, &'static str, &'static str),
    EcUv(&'static str, &'static str),
}

pub struct VarDef {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub units: &'static str,
    pub cmap: &'static str,
    pub transform: Transform,
    pub ncep: Match,
    pub ecmwf: Option<Match>,
    pub accum: bool,
}

pub const VARS: &[VarDef] = &[
    VarDef { id: "refc", name: "Composite Reflectivity", group: "Precip", units: "dBZ", cmap: "REF", transform: Transform::None, ncep: Match::Ncep(&["REFC:entire atmosphere"]), ecmwf: None, accum: false },
    VarDef { id: "refd1", name: "1 km Reflectivity", group: "Precip", units: "dBZ", cmap: "REF", transform: Transform::None, ncep: Match::Ncep(&["REFD:1000 m above ground"]), ecmwf: None, accum: false },
    VarDef { id: "apcp", name: "Total Precipitation", group: "Precip", units: "mm", cmap: "PRECIPMM", transform: Transform::None, ncep: Match::Ncep(&["APCP:surface"]), ecmwf: Some(Match::Ec("tp", "sfc", "")), accum: true },
    VarDef { id: "snow", name: "Snowfall", group: "Precip", units: "cm", cmap: "SNOWCM", transform: Transform::MToCm, ncep: Match::Ncep(&["ASNOW:surface"]), ecmwf: None, accum: true },
    VarDef { id: "t2m", name: "2 m Temperature", group: "Surface", units: "°C", cmap: "TEMP", transform: Transform::KToC, ncep: Match::Ncep(&["TMP:2 m above ground"]), ecmwf: Some(Match::Ec("2t", "sfc", "")), accum: false },
    VarDef { id: "td2m", name: "2 m Dewpoint", group: "Surface", units: "°C", cmap: "DEW", transform: Transform::KToC, ncep: Match::Ncep(&["DPT:2 m above ground"]), ecmwf: Some(Match::Ec("2d", "sfc", "")), accum: false },
    VarDef { id: "rh2m", name: "2 m Relative Humidity", group: "Surface", units: "%", cmap: "RH", transform: Transform::None, ncep: Match::Ncep(&["RH:2 m above ground"]), ecmwf: None, accum: false },
    VarDef { id: "wind10", name: "10 m Wind Speed", group: "Surface", units: "m/s", cmap: "WIND", transform: Transform::None, ncep: Match::NcepUv("UGRD:10 m above ground", "VGRD:10 m above ground"), ecmwf: Some(Match::EcUv("10u", "10v")), accum: false },
    VarDef { id: "gust", name: "Wind Gust", group: "Surface", units: "m/s", cmap: "WIND", transform: Transform::None, ncep: Match::Ncep(&["GUST:surface", "GUST:10 m above ground"]), ecmwf: Some(Match::Ec("10fg", "sfc", "")), accum: false },
    VarDef { id: "mslp", name: "Sea-Level Pressure", group: "Surface", units: "hPa", cmap: "MSLP", transform: Transform::PaToHpa, ncep: Match::Ncep(&["PRMSL:mean sea level", "MSLMA:mean sea level", "MSLET:mean sea level"]), ecmwf: Some(Match::Ec("msl", "sfc", "")), accum: false },
    VarDef { id: "vis", name: "Visibility", group: "Surface", units: "km", cmap: "VISKM", transform: Transform::MToKm, ncep: Match::Ncep(&["VIS:surface"]), ecmwf: None, accum: false },
    VarDef { id: "tcc", name: "Total Cloud Cover", group: "Surface", units: "%", cmap: "CLOUD", transform: Transform::None, ncep: Match::Ncep(&["TCDC:entire atmosphere", "TCDC:surface"]), ecmwf: Some(Match::Ec("tcc", "sfc", "")), accum: false },
    VarDef { id: "cape", name: "Surface CAPE", group: "Severe", units: "J/kg", cmap: "CAPE", transform: Transform::None, ncep: Match::Ncep(&["CAPE:surface"]), ecmwf: Some(Match::Ec("mucape", "sfc", "")), accum: false },
    VarDef { id: "mlcape", name: "Mixed-Layer CAPE", group: "Severe", units: "J/kg", cmap: "CAPE", transform: Transform::None, ncep: Match::Ncep(&["CAPE:90-0 mb above ground"]), ecmwf: None, accum: false },
    VarDef { id: "mucape", name: "Most-Unstable CAPE", group: "Severe", units: "J/kg", cmap: "CAPE", transform: Transform::None, ncep: Match::Ncep(&["CAPE:255-0 mb above ground"]), ecmwf: Some(Match::Ec("mucape", "sfc", "")), accum: false },
    VarDef { id: "srh03", name: "0-3 km Storm-Rel. Helicity", group: "Severe", units: "m²/s²", cmap: "SRH", transform: Transform::None, ncep: Match::Ncep(&["HLCY:3000-0 m above ground"]), ecmwf: None, accum: false },
    VarDef { id: "srh01", name: "0-1 km Storm-Rel. Helicity", group: "Severe", units: "m²/s²", cmap: "SRH", transform: Transform::None, ncep: Match::Ncep(&["HLCY:1000-0 m above ground"]), ecmwf: None, accum: false },
    VarDef { id: "uh25", name: "Updraft Helicity (2-5 km)", group: "Severe", units: "m²/s²", cmap: "UH", transform: Transform::None, ncep: Match::Ncep(&["MXUPHL:5000-2000 m above ground"]), ecmwf: None, accum: false },
    VarDef { id: "pwat", name: "Precipitable Water", group: "Moisture", units: "mm", cmap: "PWAT", transform: Transform::None, ncep: Match::Ncep(&["PWAT:entire atmosphere"]), ecmwf: Some(Match::Ec("tcwv", "sfc", "")), accum: false },
    VarDef { id: "t850", name: "850 mb Temperature", group: "Upper air", units: "°C", cmap: "TEMP", transform: Transform::KToC, ncep: Match::Ncep(&["TMP:850 mb"]), ecmwf: Some(Match::Ec("t", "pl", "850")), accum: false },
    VarDef { id: "hgt500", name: "500 mb Height", group: "Upper air", units: "m", cmap: "HGT500", transform: Transform::None, ncep: Match::Ncep(&["HGT:500 mb"]), ecmwf: Some(Match::Ec("gh", "pl", "500")), accum: false },
    VarDef { id: "wind250", name: "250 mb Wind", group: "Upper air", units: "m/s", cmap: "JET", transform: Transform::None, ncep: Match::NcepUv("UGRD:250 mb", "VGRD:250 mb"), ecmwf: Some(Match::EcUv("u", "v")), accum: false },
];

/// Variables offered for each model (others aren't in that model's files).
pub fn model_vars(model: &str) -> Vec<&'static VarDef> {
    let ids: &[&str] = match model {
        "hrrr" => &["refc", "refd1", "apcp", "snow", "t2m", "td2m", "rh2m", "wind10", "gust", "mslp", "vis", "tcc", "cape", "mlcape", "mucape", "srh03", "srh01", "uh25", "pwat", "t850", "hgt500", "wind250"],
        "rrfs" => &["refc", "refd1", "apcp", "snow", "t2m", "td2m", "rh2m", "wind10", "gust", "mslp", "vis", "tcc", "cape", "mlcape", "mucape", "srh03", "srh01", "uh25", "pwat", "t850", "hgt500", "wind250"],
        "nam3" => &["refc", "refd1", "apcp", "t2m", "td2m", "rh2m", "wind10", "gust", "mslp", "vis", "tcc", "cape", "mlcape", "mucape", "srh03", "srh01", "uh25", "pwat", "t850", "hgt500", "wind250"],
        "nam12" | "rap" => &["refc", "apcp", "t2m", "td2m", "rh2m", "wind10", "gust", "mslp", "vis", "tcc", "cape", "mlcape", "mucape", "srh03", "pwat", "t850", "hgt500", "wind250"],
        "gfs" => &["refc", "apcp", "t2m", "td2m", "rh2m", "wind10", "gust", "mslp", "vis", "tcc", "cape", "mucape", "srh03", "pwat", "t850", "hgt500", "wind250"],
        "nbm" => &["apcp", "snow", "t2m", "td2m", "rh2m", "wind10", "gust", "vis", "tcc"],
        "ecmwf" => &["apcp", "t2m", "td2m", "wind10", "gust", "mslp", "tcc", "mucape", "pwat", "t850", "hgt500", "wind250"],
        "hafsa" | "hafsb" => &["refc", "apcp", "t2m", "wind10", "gust", "mslp", "pwat"],
        _ => &[],
    };
    ids.iter().filter_map(|id| VARS.iter().find(|v| v.id == *id)).collect()
}

pub fn var_def(id: &str) -> Option<&'static VarDef> {
    VARS.iter().find(|v| v.id == id)
}

pub fn model_def(id: &str) -> Option<&'static ModelDef> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn fill_template(t: &str, ymd: &str, hh: u32, fh: u32, storm: &str) -> String {
    t.replace("{ymd}", ymd)
        .replace("{hh}", &format!("{hh:02}"))
        .replace("{fh2}", &format!("{fh:02}"))
        .replace("{fh3}", &format!("{fh:03}"))
        .replace("{fh}", &fh.to_string())
        .replace("{storm}", storm)
}

/// One record of an NCEP .idx: (byte start, byte end exclusive or None, fields)
pub fn parse_ncep_idx(text: &str) -> Vec<(u64, Option<u64>, Vec<String>)> {
    let rows: Vec<(u64, Vec<String>)> = text
        .lines()
        .filter_map(|l| {
            let f: Vec<String> = l.split(':').map(|s| s.to_string()).collect();
            let off = f.get(1)?.parse::<u64>().ok()?;
            Some((off, f))
        })
        .collect();
    let mut out = vec![];
    for (k, (off, f)) in rows.iter().enumerate() {
        let end = rows.iter().skip(k + 1).map(|r| r.0).find(|&o| o > *off);
        out.push((*off, end, f.clone()));
    }
    out
}

/// Pick the byte range for a variable in an NCEP idx.
pub fn find_ncep(idx: &[(u64, Option<u64>, Vec<String>)], pattern: &str, fh: u32, accum: bool) -> Option<(u64, Option<u64>)> {
    let (var, level) = pattern.split_once(':')?;
    let mut cands: Vec<&(u64, Option<u64>, Vec<String>)> = idx
        .iter()
        .filter(|(_, _, f)| f.len() >= 6 && f[3] == var && f[4].starts_with(level))
        .collect();
    if cands.is_empty() {
        return None;
    }
    // deterministic lines end right after the forecast field
    let det: Vec<_> = cands.iter().copied().filter(|(_, _, f)| f.iter().skip(6).all(|x| x.is_empty())).collect();
    if !det.is_empty() {
        cands = det;
    }
    if accum {
        let want = format!("0-{fh} hour acc");
        let want_d = format!("0-{} day acc", fh / 24);
        if let Some(c) = cands.iter().find(|(_, _, f)| f[5].starts_with(&want) || (fh % 24 == 0 && f[5].starts_with(&want_d))) {
            return Some((c.0, c.1));
        }
        // otherwise the longest window
        cands.sort_by_key(|(_, _, f)| {
            f[5].split('-').nth(1).and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) * -1
        });
    }
    cands.first().map(|c| (c.0, c.1))
}

/// ECMWF .index json lines: param/levtype/levelist → (offset, length)
pub fn find_ecmwf(index: &str, param: &str, levtype: &str, level: &str) -> Option<(u64, u64)> {
    for l in index.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
        if v["param"].as_str() == Some(param) && v["levtype"].as_str() == Some(levtype) {
            if !level.is_empty() && v["levelist"].as_str() != Some(level) {
                continue;
            }
            let o = v["_offset"].as_u64()?;
            let n = v["_length"].as_u64()?;
            return Some((o, n));
        }
    }
    None
}

// ---------------- NDFD ----------------

pub const NDFD_BASE: &str = "https://tgftp.nws.noaa.gov/SL.us008001/ST.opnl/DF.gr2/DC.ndfd/AR.conus";

struct N(&'static str, &'static str, &'static str, &'static str, Transform, bool);
const NDFD: &[N] = &[
    // element, name, units, cmap, transform, has days 4-7
    N("temp", "Temperature", "°C", "TEMP", Transform::KToC, true),
    N("maxt", "High Temperature", "°C", "TEMP", Transform::KToC, true),
    N("mint", "Low Temperature", "°C", "TEMP", Transform::KToC, true),
    N("apt", "Feels-Like Temperature", "°C", "TEMP", Transform::KToC, true),
    N("td", "Dewpoint", "°C", "DEW", Transform::KToC, true),
    N("rhm", "Relative Humidity", "%", "RH", Transform::None, true),
    N("pop12", "Chance of Precip (12 hr)", "%", "PROB", Transform::None, true),
    N("qpf", "Precip Amount (6 hr)", "mm", "PRECIPMM", Transform::None, false),
    N("snow", "Snow Amount (6 hr)", "cm", "SNOWCM", Transform::MToCm, false),
    N("iceaccum", "Ice Accumulation", "mm", "PRECIPMM", Transform::None, false),
    N("sky", "Sky Cover", "%", "CLOUD", Transform::None, true),
    N("wspd", "Wind Speed", "m/s", "WIND", Transform::None, true),
    N("wgust", "Wind Gust", "m/s", "WIND", Transform::None, false),
    N("wbgt", "Wet-Bulb Globe Temp.", "°C", "TEMP", Transform::KToC, false),
    N("ptornado", "Tornado Probability", "%", "PROB", Transform::None, false),
    N("phail", "Hail Probability", "%", "PROB", Transform::None, false),
    N("ptstmwinds", "Damaging Wind Probability", "%", "PROB", Transform::None, false),
];

pub fn ndfd_layers() -> Vec<LayerDef> {
    NDFD.iter()
        .map(|n| LayerDef {
            id: format!("ndfd/{}", n.0),
            group: "NDFD Forecast".into(),
            name: n.1.into(),
            units: n.2,
            cmap: n.3,
            product: format!("{}|{}", n.0, if n.5 { "1" } else { "0" }),
            transform: n.4,
            nodata: vec![9999.0],
            min_valid: None,
            source: "ndfd",
            model: None,
            step_min: 180,
        })
        .collect()
}

// ---------------- METAR analysis ----------------

pub fn metar_layers() -> Vec<LayerDef> {
    let f = |id: &str, name: &str, units: &'static str, cmap: &'static str| LayerDef {
        id: format!("metar/{id}"),
        group: "Surface Obs Analysis".into(),
        name: name.into(),
        units,
        cmap,
        product: id.into(),
        transform: Transform::None,
        nodata: vec![],
        min_valid: None,
        source: "metar",
        model: None,
        step_min: 10,
    };
    vec![
        f("temp", "Temperature", "°C", "TEMP"),
        f("dew", "Dewpoint", "°C", "DEW"),
        f("feels", "Feels-Like", "°C", "TEMP"),
        f("rh", "Relative Humidity", "%", "RH"),
        f("spread", "Temp/Dewpoint Spread", "°C", "SPREAD"),
        f("wind", "Wind Speed", "m/s", "WIND"),
        f("gust", "Wind Gust", "m/s", "WIND"),
        f("pres", "Sea-Level Pressure", "hPa", "MSLP"),
        f("vis", "Visibility", "km", "VISKM"),
    ]
}

// ---------------- GOES ----------------

pub const GOES_BANDS: &[(u32, &str, &str, &str)] = &[
    (1, "Band 1 · Blue (0.47 µm)", "", "VISGRAY"),
    (2, "Band 2 · Red Visible (0.64 µm)", "", "VISGRAY"),
    (3, "Band 3 · Veggie (0.86 µm)", "", "VISGRAY"),
    (4, "Band 4 · Cirrus (1.37 µm)", "", "VISGRAY"),
    (5, "Band 5 · Snow/Ice (1.6 µm)", "", "VISGRAY"),
    (6, "Band 6 · Cloud Particle (2.2 µm)", "", "VISGRAY"),
    (7, "Band 7 · Shortwave IR (3.9 µm)", "K", "SWIR"),
    (8, "Band 8 · Upper-Level Water Vapor", "K", "WV"),
    (9, "Band 9 · Mid-Level Water Vapor", "K", "WV"),
    (10, "Band 10 · Low-Level Water Vapor", "K", "WV"),
    (11, "Band 11 · Cloud-Top Phase (8.4 µm)", "K", "IR"),
    (12, "Band 12 · Ozone (9.6 µm)", "K", "IR"),
    (13, "Band 13 · Clean Longwave IR", "K", "IR"),
    (14, "Band 14 · Longwave IR (11.2 µm)", "K", "IR"),
    (15, "Band 15 · Dirty Longwave IR", "K", "IR"),
    (16, "Band 16 · CO₂ Longwave IR", "K", "IR"),
];

/// sat, sector code, product dir, file-name sector tag, display name
pub const GOES_SECTORS: &[(u32, &str, &str, &str, &str)] = &[
    (19, "conus", "ABI-L2-CMIPC", "CMIPC", "GOES-19 (East) · CONUS"),
    (19, "full", "ABI-L2-CMIPF", "CMIPF", "GOES-19 (East) · Full Disk"),
    (19, "meso1", "ABI-L2-CMIPM", "CMIPM1", "GOES-19 (East) · Mesoscale 1"),
    (19, "meso2", "ABI-L2-CMIPM", "CMIPM2", "GOES-19 (East) · Mesoscale 2"),
    (18, "conus", "ABI-L2-CMIPC", "CMIPC", "GOES-18 (West) · PACUS"),
    (18, "full", "ABI-L2-CMIPF", "CMIPF", "GOES-18 (West) · Full Disk"),
    (18, "meso1", "ABI-L2-CMIPM", "CMIPM1", "GOES-18 (West) · Mesoscale 1"),
    (18, "meso2", "ABI-L2-CMIPM", "CMIPM2", "GOES-18 (West) · Mesoscale 2"),
];

pub fn goes_layers() -> Vec<LayerDef> {
    let mut out = vec![];
    for (sat, sector, _, _, sname) in GOES_SECTORS {
        for (band, bname, units, cmap) in GOES_BANDS {
            out.push(LayerDef {
                id: format!("goes/{sat}/{sector}/{band}"),
                group: format!("Satellite · {sname}"),
                name: bname.to_string(),
                units,
                cmap,
                product: format!("{sat}|{sector}|{band}"),
                transform: Transform::None,
                nodata: vec![],
                min_valid: None,
                source: "goes",
                model: None,
                step_min: if sector.starts_with("meso") { 1 } else if *sector == "full" { 10 } else { 5 },
            });
        }
        // RGB composites built on the server from several bands
        for r in super::rgb::RECIPES {
            out.push(LayerDef {
                id: format!("goes/{sat}/{sector}/rgb-{}", r.id),
                group: format!("Satellite · {sname}"),
                name: r.name.to_string(),
                units: "",
                cmap: "RGB",
                product: format!("{sat}|{sector}|rgb:{}", r.id),
                transform: Transform::None,
                nodata: vec![],
                min_valid: None,
                source: "goes",
                model: None,
                step_min: if sector.starts_with("meso") { 1 } else if *sector == "full" { 10 } else { 5 },
            });
        }
    }
    out
}

pub fn model_layers() -> Vec<LayerDef> {
    let mut out = vec![];
    for m in MODELS {
        for v in model_vars(m.id) {
            out.push(LayerDef {
                id: format!("model/{}/{}", m.id, v.id),
                group: format!("Models · {}", m.name),
                name: v.name.into(),
                units: v.units,
                cmap: v.cmap,
                product: v.id.into(),
                transform: v.transform,
                nodata: vec![],
                min_valid: None,
                source: "model",
                model: Some(m.id.into()),
                step_min: 60,
            });
        }
    }
    out
}

// ---------------- Future radar / snowfall ----------------

pub const SYNOPTIC: &[u32] = &[0, 6, 12, 18];
pub const ALL_CYCLES: &[u32] = &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

/// One model option for a future layer: model id, which cycles to consider, frame step (minutes).
pub struct FutureSrc {
    pub model: &'static str,
    pub cycles: &'static [u32],
    pub step_min: u32,
}

/// "Future" layers: a model field shown from now forward, picking the freshest run that reaches
/// the horizon (falling back down the list when a model is missing or late).
pub struct FutureDef {
    pub id: &'static str,
    pub name: &'static str,
    pub var: &'static str,
    pub horizon_h: u32,
    /// accumulate from "now" (snowfall) instead of showing the field as-is
    pub accum_from_now: bool,
    pub chain: &'static [FutureSrc],
}

pub const FUTURE: &[FutureDef] = &[
    FutureDef {
        id: "radar6",
        name: "Future Radar · 6 hr",
        var: "refc",
        horizon_h: 6,
        accum_from_now: false,
        chain: &[
            FutureSrc { model: "hrrrsub", cycles: ALL_CYCLES, step_min: 15 },
            FutureSrc { model: "hrrr", cycles: ALL_CYCLES, step_min: 60 },
            FutureSrc { model: "rrfs", cycles: ALL_CYCLES, step_min: 60 },
        ],
    },
    FutureDef {
        id: "radar24",
        name: "Future Radar · 24 hr",
        var: "refc",
        horizon_h: 24,
        accum_from_now: false,
        chain: &[
            FutureSrc { model: "hrrr", cycles: SYNOPTIC, step_min: 60 },
            FutureSrc { model: "rrfs", cycles: SYNOPTIC, step_min: 60 },
            FutureSrc { model: "nam3", cycles: SYNOPTIC, step_min: 60 },
        ],
    },
    FutureDef {
        id: "radar72",
        name: "Future Radar · 72 hr",
        var: "refc",
        horizon_h: 72,
        accum_from_now: false,
        chain: &[
            FutureSrc { model: "rrfs", cycles: SYNOPTIC, step_min: 60 },
            FutureSrc { model: "nam12", cycles: SYNOPTIC, step_min: 60 },
            FutureSrc { model: "gfs", cycles: SYNOPTIC, step_min: 60 },
        ],
    },
    FutureDef {
        id: "snow48",
        name: "Future Snowfall · 48 hr",
        var: "snow",
        horizon_h: 48,
        accum_from_now: true,
        chain: &[
            FutureSrc { model: "rrfs", cycles: SYNOPTIC, step_min: 60 },
            FutureSrc { model: "hrrr", cycles: SYNOPTIC, step_min: 60 },
        ],
    },
];

pub fn future_def(id: &str) -> Option<&'static FutureDef> {
    FUTURE.iter().find(|f| f.id == id)
}

pub fn future_layers() -> Vec<LayerDef> {
    FUTURE
        .iter()
        .map(|f| {
            let v = var_def(f.var).expect("future var");
            LayerDef {
                id: format!("future/{}", f.id),
                group: "Future".into(),
                name: f.name.into(),
                units: v.units,
                cmap: v.cmap,
                product: f.id.into(),
                transform: v.transform,
                nodata: vec![],
                min_valid: None,
                source: "future",
                model: None,
                step_min: f.chain[0].step_min,
            }
        })
        .collect()
}

/// Valid times (ms) and the forecast step to load for a future layer: every `step_min` from the
/// current step up to now + horizon, limited to hours the run has published. For sub-hourly runs
/// the step value is minutes (files hold the steps ending in that hour); otherwise hours.
pub fn future_steps(now: i64, run_t: i64, fhs: &[u32], step_min: u32, horizon_h: u32, sub: bool) -> Vec<(i64, u32)> {
    let step = step_min as i64 * 60_000;
    let end = now + horizon_h as i64 * 3_600_000;
    let mut t = (now - now.rem_euclid(step)).max(run_t + step);
    let mut out = vec![];
    while t <= end {
        let mins = ((t - run_t) / 60_000) as u32;
        let (file_h, key) = if sub { (mins.div_ceil(60), mins) } else { (mins / 60, mins / 60) };
        if (sub || mins % 60 == 0) && file_h > 0 && fhs.contains(&file_h) {
            out.push((t, key));
        }
        t += step;
    }
    out
}

/// Find a field in an HRRR sub-hourly index: rows are labelled "<minutes> min fcst".
pub fn find_ncep_minutes(idx: &[(u64, Option<u64>, Vec<String>)], pattern: &str, minutes: u32) -> Option<(u64, Option<u64>)> {
    let (var, level) = pattern.split_once(':')?;
    let want = format!("{minutes} min fcst");
    let alt = if minutes % 60 == 0 { format!("{} hour fcst", minutes / 60) } else { want.clone() };
    idx.iter()
        .find(|(_, _, f)| f.len() >= 6 && f[3] == var && f[4].starts_with(level) && (f[5] == want || f[5] == alt))
        .map(|c| (c.0, c.1))
}

pub fn all_layers() -> Vec<LayerDef> {
    let mut v = mrms_layers();
    v.extend(goes_layers());
    v.extend(model_layers());
    v.extend(metar_layers());
    v.extend(ndfd_layers());
    v.extend(future_layers());
    v.extend(super::intl::layers());
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idx_accumulation_choice() {
        let idx = "1:0:d=2026101012:REFC:entire atmosphere:6 hour fcst:\n2:100:d=2026101012:APCP:surface:5-6 hour acc fcst:\n3:200:d=2026101012:APCP:surface:0-6 hour acc fcst:\n4:300:d=2026101012:TMP:2 m above ground:6 hour fcst:\n5:400:d=2026101012:TMP:2 m above ground:6 hour fcst:ens std dev\n";
        let p = parse_ncep_idx(idx);
        assert_eq!(find_ncep(&p, "APCP:surface", 6, true), Some((200, Some(300))));
        assert_eq!(find_ncep(&p, "TMP:2 m above ground", 6, false), Some((300, Some(400))));
        assert_eq!(find_ncep(&p, "REFC:entire atmosphere", 6, false), Some((0, Some(100))));
    }

    #[test]
    fn subhourly_minutes() {
        let idx = "1:0:d=2026101000:REFC:entire atmosphere:75 min fcst:\n2:100:d=2026101000:TMP:2 m above ground:75 min fcst:\n50:900:d=2026101000:REFC:entire atmosphere:90 min fcst:\n51:1000:d=2026101000:TMP:2 m above ground:90 min fcst:\n";
        let rows = parse_ncep_idx(idx);
        assert_eq!(find_ncep_minutes(&rows, "REFC:entire atmosphere", 90), Some((900, Some(1000))));
        assert_eq!(find_ncep_minutes(&rows, "REFC:entire atmosphere", 75), Some((0, Some(100))));
        assert_eq!(find_ncep_minutes(&rows, "REFC:entire atmosphere", 105), None);
        assert!(future_layers().iter().all(|l| l.id.starts_with("future/")));
        // run 12Z, now 13:20Z, sub-hourly to f18 → 13:15 .. 19:15 in 15-min steps (minutes 75..435)
        let h = 3_600_000i64;
        let run = 1_791_700_000_000i64 - 1_791_700_000_000i64 % (24 * h) + 12 * h;
        let fhs: Vec<u32> = (0..=18).collect();
        let st = future_steps(run + h + 20 * 60_000, run, &fhs, 15, 6, true);
        assert_eq!(st.first().unwrap().1, 75);
        assert_eq!(st.len(), 25);
        assert_eq!(st.last().unwrap().1, 435);
        // hourly, run only published to f05: 13Z..17Z
        let fhs: Vec<u32> = (0..=5).collect();
        let st = future_steps(run + h + 20 * 60_000, run, &fhs, 60, 24, false);
        assert_eq!(st.iter().map(|x| x.1).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn ecmwf_index() {
        let idx = "{\"param\": \"2t\", \"levtype\": \"sfc\", \"_offset\": 10, \"_length\": 20}\n{\"param\": \"t\", \"levtype\": \"pl\", \"levelist\": \"850\", \"_offset\": 30, \"_length\": 5}\n";
        assert_eq!(find_ecmwf(idx, "2t", "sfc", ""), Some((10, 20)));
        assert_eq!(find_ecmwf(idx, "t", "pl", "850"), Some((30, 5)));
    }
}
