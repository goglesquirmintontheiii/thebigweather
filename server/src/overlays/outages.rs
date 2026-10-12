//! Power outages (`/api/ovl/outages`): keyless utility outage maps, aggregated by county.
//!
//! There is no keyless national feed (PowerOutage.us has no free API and its terms forbid
//! scraping; DOE/ORNL ODIN is for registered subscribers), so this reads the public data behind
//! the utilities' own outage maps (all verified 2026-10-12):
//!
//! * **KUBRA Storm Center** (many large US utilities). Per view:
//!   `kubra.io/stormcenter/api/v1/stormcenters/{instance}/views/{view}/currentState?preview=false`
//!   → `data.interval_generation_data` (`data/<uuid>`, changes every few minutes) and
//!   `stormcenterDeploymentId`; `…/configuration/{deployment}?preview=false` lists the view's
//!   layers — the `THEMATIC_LAYER*` with `areaType: county` (source
//!   `public/thematic-N/thematic_areas.json`) and the summary (`public/summary-N/data.json`).
//!   Files live at `https://kubra.io/{interval_generation_data}/{source}`. Thematic entries:
//!   `{id: "IL|Illinois|Bureau|county", title, desc: {name, cust_a: {val[, mask]}, cust_s, n_out,
//!   etr}, geom: {p: [encoded polyline label point], a: [...]}}` (only areas with outages).
//!   Summary: `summaryFileData.totals[]{total_cust_a.val, total_cust_s}`, `date_generated`.
//! * **Duke Energy** public ArcGIS service `Duke_Energy_Distribution_Outages_Public` (~20 min):
//!   layer 1 = counties (`COUNTY_NAME`, `STATE_NAME`, `CUSTOMER_OUT`, `CUSTOMER_SERVED`, `ETR`),
//!   layer 0 = outage points (`AFFECTED_CUSTOMERS`, `CAUSE`, `CREW_STATUS`, `START_TIME`, `ETR`).
//! * **Hydro-Québec** open data (`pannes.hydroquebec.com/pannes/donnees/v3_0/bisversion.json` →
//!   `bismarkers{version}.json`, every 15 min): outage points `[customers, start, etr, "P",
//!   "[lon, lat]", status, _, cause, municipality, _]`.
//!
//! Sources are only polled while the overlay is requested (each at most every 5 minutes; a failed
//! source waits 2 minutes) and everything is dropped after 30 idle minutes. Counties are matched
//! to 5-digit FIPS codes by name and state (table built from the app's `counties-fips.json`); the
//! client joins the polygons.

use super::{agsquery, round, Overlays};
use anyhow::{anyhow, bail, Result};
use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Utc};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const KUBRA: &str = "https://kubra.io";
const DUKE: &str = "https://services3.arcgis.com/oX5r75R7mapdoI2F/arcgis/rest/services/Duke_Energy_Distribution_Outages_Public/FeatureServer";
const HQ: &str = "https://pannes.hydroquebec.com/pannes/donnees/v3_0";
/// seconds between polls of one source
const POLL_S: u64 = 300;
/// wait after a failure before retrying
const BACKOFF_S: u64 = 120;
/// KUBRA view configuration is cached this long (it only changes with a new deployment id)
const CFG_TTL: Duration = Duration::from_secs(6 * 3600);
const MAX_POINTS: usize = 8000;

/// A KUBRA Storm Center view: (id, utility, states, instance, view).
/// IDs from the utilities' public outage maps (collected by open-source outage scrapers), each
/// checked live against `currentState` on 2026-10-12.
pub const KUBRA_VIEWS: &[(&str, &str, &[&str], &str, &str)] = &[
    ("kubra_aep_oh", "AEP Ohio", &["OH"], "9c0735d8-b721-4dce-b80b-558e98ce1083", "9b2feb80-69f8-4035-925e-f2acbcf1728e"),
    ("kubra_aep_tx", "AEP Texas", &["TX"], "3ff6812b-90d8-40cd-97a6-76633226f27b", "6022fe09-5259-4763-892f-5f57463fa6a5"),
    ("kubra_alabama", "Alabama Power", &["AL"], "7636a60f-7b81-4fb0-a30d-ed79a8e271e7", "c3471c92-6e1b-494b-a884-391139a2cc18"),
    ("kubra_ameren", "Ameren", &["IL", "MO"], "92e209c0-35c3-4ec2-9ce9-30d87a55706f", "9b7c2416-cb0c-4845-99c7-7b31041038a2"),
    ("kubra_appalachian", "Appalachian Power", &["VA", "WV", "TN"], "6674f49e-0236-4ed8-a40a-b31747557ab7", "8cfe790f-59f3-4ce3-a73f-a9642227411f"),
    ("kubra_ace", "Atlantic City Electric", &["NJ"], "4b4c1b8f-d2fe-4d2a-877d-a704f764db98", "addc2ec9-6104-4ea0-9da5-ff5ba896437e"),
    ("kubra_austin", "Austin Energy", &["TX"], "dd9c446f-f6b8-43f9-8f80-83f5245c60a1", "76446308-a901-4fa3-849c-3dd569933a51"),
    ("kubra_bge", "BGE", &["MD"], "3db5fd35-4a88-465f-8985-8db3eb760b61", "e7b67c05-848e-404f-aeb0-08d96c45d0bd"),
    ("kubra_central_hudson", "Central Hudson", &["NY"], "d19170d4-3357-4f67-bc30-e88f85fc85c8", "7e22d4b2-8c3d-4625-adc1-ffcdd2944de0"),
    ("kubra_comed", "ComEd", &["IL"], "0f46457f-e3ee-473c-8040-d7da9e776ccb", "a7f6692c-38f6-4bef-8681-989b2bcba5da"),
    ("kubra_cps", "CPS Energy", &["TX"], "912c6202-c3f4-491c-a8c1-726157725e92", "812092c0-153f-4a7f-8c58-e1af1cb740b7"),
    ("kubra_dominion", "Dominion Energy (VA/NC)", &["VA", "NC"], "9c691bb6-767e-4532-b00e-286ac9adc223", "38b5394c-8bca-4dfd-ac59-b321615446bd"),
    ("kubra_dominion_sc", "Dominion Energy (SC)", &["SC"], "ba976967-dc3e-4d05-8206-50d0260b22c3", "5b77d88d-a054-4008-a168-0e13468a4d6d"),
    ("kubra_dte", "DTE Energy", &["MI"], "4fbb3ad3-e01d-4d71-9575-d453769c1171", "8ed2824a-bd92-474e-a7c4-848b812b7f9b"),
    ("kubra_evergy", "Evergy", &["KS", "MO"], "b1493825-4ee3-4706-a986-99a763a733db", "c1062d22-2919-487c-9000-e21b72b62278"),
    ("kubra_fe_oh", "FirstEnergy (OH)", &["OH"], "6c715f0e-bbec-465f-98cc-0b81623744be", "db9c3f02-0a06-4672-a357-0f676eb75bfa"),
    ("kubra_fe_pa", "FirstEnergy (PA)", &["PA"], "6c715f0e-bbec-465f-98cc-0b81623744be", "8587e451-e258-4692-b5e8-28010506d51a"),
    ("kubra_fe_nj", "FirstEnergy (NJ)", &["NJ"], "6c715f0e-bbec-465f-98cc-0b81623744be", "fcd7c23d-de37-4471-8ca3-37c3260f94fa"),
    ("kubra_fe_mdwv", "FirstEnergy (MD/WV)", &["MD", "WV"], "6c715f0e-bbec-465f-98cc-0b81623744be", "5ed3ddf1-3a6f-4cfd-8957-eba54b5baaad"),
    ("kubra_georgia", "Georgia Power", &["GA"], "7b38c047-7950-444b-a25c-9b3e5ab986eb", "67b44af5-3847-4ca3-9f4e-9190aac343d6"),
    ("kubra_im", "Indiana Michigan Power", &["IN", "MI"], "e07a4ffb-83dd-4251-8dad-3fe5a26979b6", "1b319a36-d1cf-443d-9ecf-6267acae0c3a"),
    ("kubra_jea", "JEA", &["FL"], "2bb4315d-ff9d-4937-a231-57b8a9df189c", "40a074f2-b303-42b7-b717-ed7d9d2ad9e2"),
    ("kubra_kypower", "Kentucky Power", &["KY"], "23dcd38e-2573-4e20-a463-959b11cae011", "60f31606-5702-4a1e-a74c-08d866b7a6fa"),
    ("kubra_lgeku", "LG&E and KU", &["KY"], "877fd1e9-4162-473f-b782-d8a53a85326b", "a6cee9e4-312b-4b77-9913-2ae371eb860d"),
    ("kubra_mspower", "Mississippi Power", &["MS"], "32c5f878-d103-49e1-8a8a-ad0e2bdb4507", "1521bb54-d36b-4d36-a64d-48a454ee39a0"),
    ("kubra_ngrid_ma", "National Grid (MA)", &["MA"], "9cb2e5b7-d321-4575-a552-4ae7078cbc31", "ec79df5b-2c54-4fb9-a86a-b20775678236"),
    ("kubra_ngrid_ny", "National Grid (NY)", &["NY"], "9cb2e5b7-d321-4575-a552-4ae7078cbc31", "1b69b604-7588-4753-8591-9f135a962a2f"),
    ("kubra_oge", "OG&E", &["OK", "AR"], "dc85f79f-59f9-4e9e-9557-b3a9bee7e0ce", "8fe9d356-96bc-41f1-b353-6720eb408936"),
    ("kubra_oncor", "Oncor", &["TX"], "560abba3-7881-4741-b538-ca416b58ba1e", "ca124b24-9a06-4b19-aeb3-1841a9c962e1"),
    ("kubra_peco", "PECO", &["PA"], "39e6d9f3-fdea-4539-848f-b8631945da6f", "789577bd-d2c6-42b8-af4b-b51ae6f52b6c"),
    ("kubra_pnm", "PNM", &["NM"], "b6fe87bc-3c82-4afe-b7f0-7eee93a32dfa", "92a8c818-17ed-401d-89be-73e5ae60ee5b"),
    ("kubra_pseg", "PSE&G", &["NJ"], "79d82478-c10a-4956-a045-89de3cda618c", "bdb7f5be-1c1a-46fa-862e-ebdf21851d2e"),
    ("kubra_psegli", "PSEG Long Island", &["NY"], "48006d55-45bb-40a4-99a6-1289326f0d0d", "fb50e444-70e5-4b69-b868-28463b5dbd19"),
    ("kubra_pso", "Public Service Co. of Oklahoma", &["OK"], "4bb3b3bc-e1c4-448b-b806-e4fc85c3b640", "e2356e43-c76f-4772-bf85-31240a2cc504"),
    ("kubra_swepco", "SWEPCO", &["LA", "AR", "TX"], "9632df6e-a385-400a-b822-b68d268e8e7c", "e51304d0-7052-458d-a5ac-0e1980cca976"),
];

/// Non-KUBRA sources: (id, name).
const OTHER: &[(&str, &str)] = &[("duke", "Duke Energy (NC/SC/FL/IN/OH/KY)"), ("hydroquebec", "Hydro-Québec")];

// ---------- records ----------

#[derive(Clone, Debug, PartialEq)]
pub struct County {
    pub fips: Option<String>,
    pub name: String,
    /// two-letter state
    pub state: String,
    pub out: u64,
    pub served: Option<u64>,
    /// label point (lon, lat) when the source gives one
    pub at: Option<(f64, f64)>,
    pub etr: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Point {
    pub lon: f64,
    pub lat: f64,
    pub out: u64,
    pub start: Option<String>,
    pub etr: Option<String>,
    pub cause: Option<String>,
    pub status: Option<String>,
    pub area: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Snap {
    pub counties: Vec<County>,
    pub points: Vec<Point>,
    pub out: u64,
    pub served: Option<u64>,
    /// when the utility generated the data (ms)
    pub updated: Option<i64>,
    /// points are the source's only detail (no county breakdown)
    pub points_primary: bool,
}

#[derive(Default)]
struct Src {
    snap: Option<Arc<Snap>>,
    tried: Option<Instant>,
    ok: Option<Instant>,
    busy: bool,
    err: Option<String>,
}

pub struct Outages {
    srcs: Mutex<HashMap<&'static str, Src>>,
    /// KUBRA view configs: deployment id → (fetched, county source, summary source)
    cfg: Mutex<HashMap<String, (Instant, Vec<String>, Option<String>)>>,
    sem: Arc<tokio::sync::Semaphore>,
    reaper: AtomicBool,
}

impl Default for Outages {
    fn default() -> Self {
        Self { srcs: Mutex::new(HashMap::new()), cfg: Mutex::new(HashMap::new()), sem: Arc::new(tokio::sync::Semaphore::new(8)), reaper: AtomicBool::new(false) }
    }
}

// ---------- county names → FIPS ----------

const STATES: &[(&str, &str, &str)] = &[
    ("01", "AL", "Alabama"), ("02", "AK", "Alaska"), ("04", "AZ", "Arizona"), ("05", "AR", "Arkansas"), ("06", "CA", "California"),
    ("08", "CO", "Colorado"), ("09", "CT", "Connecticut"), ("10", "DE", "Delaware"), ("11", "DC", "District of Columbia"), ("12", "FL", "Florida"),
    ("13", "GA", "Georgia"), ("15", "HI", "Hawaii"), ("16", "ID", "Idaho"), ("17", "IL", "Illinois"), ("18", "IN", "Indiana"),
    ("19", "IA", "Iowa"), ("20", "KS", "Kansas"), ("21", "KY", "Kentucky"), ("22", "LA", "Louisiana"), ("23", "ME", "Maine"),
    ("24", "MD", "Maryland"), ("25", "MA", "Massachusetts"), ("26", "MI", "Michigan"), ("27", "MN", "Minnesota"), ("28", "MS", "Mississippi"),
    ("29", "MO", "Missouri"), ("30", "MT", "Montana"), ("31", "NE", "Nebraska"), ("32", "NV", "Nevada"), ("33", "NH", "New Hampshire"),
    ("34", "NJ", "New Jersey"), ("35", "NM", "New Mexico"), ("36", "NY", "New York"), ("37", "NC", "North Carolina"), ("38", "ND", "North Dakota"),
    ("39", "OH", "Ohio"), ("40", "OK", "Oklahoma"), ("41", "OR", "Oregon"), ("42", "PA", "Pennsylvania"), ("44", "RI", "Rhode Island"),
    ("45", "SC", "South Carolina"), ("46", "SD", "South Dakota"), ("47", "TN", "Tennessee"), ("48", "TX", "Texas"), ("49", "UT", "Utah"),
    ("50", "VT", "Vermont"), ("51", "VA", "Virginia"), ("53", "WA", "Washington"), ("54", "WV", "West Virginia"), ("55", "WI", "Wisconsin"),
    ("56", "WY", "Wyoming"), ("72", "PR", "Puerto Rico"),
];

/// "North Carolina" / "NORTH CAROLINA" / "NC" → "NC"
pub fn state_abbr(s: &str) -> Option<&'static str> {
    let t = s.trim();
    STATES.iter().find(|x| x.1.eq_ignore_ascii_case(t) || x.2.eq_ignore_ascii_case(t)).map(|x| x.1)
}

fn state_fips(abbr: &str) -> Option<&'static str> {
    STATES.iter().find(|x| x.1 == abbr).map(|x| x.0)
}

/// Comparable county name: lower-case letters/digits only, "Saint" → "st", without
/// "county"/"parish"/"borough"/"census area".
fn norm(s: &str) -> String {
    let mut t = s.trim().to_lowercase();
    for suf in [" county", " parish", " borough", " census area", " municipality", " city and borough"] {
        if let Some(x) = t.strip_suffix(suf) {
            t = x.to_string();
        }
    }
    if let Some(x) = t.strip_prefix("saint ") {
        t = format!("st {x}");
    } else if let Some(x) = t.strip_prefix("ste. ").or_else(|| t.strip_prefix("ste ")) {
        t = format!("ste {x}");
    }
    t.replace("st.", "st").chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// (state fips, normalized name) → FIPS codes
static FIPS: Lazy<HashMap<(String, String), Vec<String>>> = Lazy::new(|| {
    let mut m: HashMap<(String, String), Vec<String>> = HashMap::new();
    for line in include_str!("county_names.tsv").lines() {
        let Some((f, n)) = line.split_once('\t') else { continue };
        if f.len() != 5 {
            continue;
        }
        let n = n.replace('ñ', "n");
        m.entry((f[..2].to_string(), norm(&n))).or_default().push(f.to_string());
    }
    m
});

/// FIPS for a county name in a state. "… City" prefers an independent city (county code ≥ 500,
/// e.g. Richmond city VA, Baltimore city MD) and a plain name the county.
pub fn county_fips(state: &str, name: &str) -> Option<String> {
    let sf = state_fips(state)?;
    let name = name.replace('ñ', "n").replace('Ñ', "N");
    let lookup = |n: &str| FIPS.get(&(sf.to_string(), norm(n)));
    let lower = name.trim().to_lowercase();
    let is_city = lower.ends_with(" city") || lower.ends_with(" (city)");
    let pick = |v: &Vec<String>, city: bool| -> String {
        v.iter().find(|f| (f[2..].parse::<u32>().unwrap_or(0) >= 500) == city).or(v.first()).cloned().unwrap_or_default()
    };
    if let Some(v) = lookup(&name) {
        if v.len() == 1 || !is_city {
            return Some(pick(v, false));
        }
    }
    if is_city {
        let base = lower.trim_end_matches(" (city)").trim_end_matches(" city");
        if let Some(v) = lookup(base) {
            return Some(pick(v, true));
        }
    }
    None
}

// ---------- small parsers ----------

/// First point of a Google encoded polyline (precision 5) → (lon, lat).
pub fn polyline_first(s: &str) -> Option<(f64, f64)> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut next = || -> Option<i64> {
        let (mut res, mut shift) = (0i64, 0);
        loop {
            let c = *b.get(i)? as i64 - 63;
            i += 1;
            if c < 0 {
                return None;
            }
            res |= (c & 0x1f) << shift;
            shift += 5;
            if c < 0x20 {
                break;
            }
        }
        Some(if res & 1 != 0 { !(res >> 1) } else { res >> 1 })
    };
    let lat = next()? as f64 / 1e5;
    let lon = next()? as f64 / 1e5;
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)).then_some((lon, lat))
}

fn u(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite() && *x >= 0.0).map(|x| x.round() as u64),
        Value::String(s) => s.trim().replace(',', "").parse::<f64>().ok().filter(|x| x.is_finite() && *x >= 0.0).map(|x| x.round() as u64),
        Value::Object(_) => u(&v["val"]),
        _ => None,
    }
}

/// Case-insensitive property lookup (ArcGIS layers differ in field-name case).
fn prop<'a>(p: &'a Value, k: &str) -> &'a Value {
    p.as_object().and_then(|m| m.iter().find(|(kk, _)| kk.eq_ignore_ascii_case(k)).map(|x| x.1)).unwrap_or(&Value::Null)
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() && s != "ETR-NULL" && s != "ETR-EXP" => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// US Eastern local time (Québec, Ontario, the Carolinas) → UTC ms (2nd Sunday of March to 1st
/// Sunday of November is daylight time).
pub fn eastern_ms(local: NaiveDateTime) -> i64 {
    let y = local.year();
    let nth_sunday = |m: u32, n: u32| -> NaiveDate {
        let first = NaiveDate::from_ymd_opt(y, m, 1).unwrap_or_default();
        let off = (7 - first.weekday().num_days_from_sunday()) % 7;
        first + chrono::Duration::days((off + 7 * (n - 1)) as i64)
    };
    let start = nth_sunday(3, 2).and_hms_opt(2, 0, 0).unwrap_or_default();
    let end = nth_sunday(11, 1).and_hms_opt(2, 0, 0).unwrap_or_default();
    let off_h = if local >= start && local < end { 4 } else { 5 };
    Utc.from_utc_datetime(&(local + chrono::Duration::hours(off_h))).timestamp_millis()
}

// ---------- KUBRA ----------

/// County thematic sources and the summary source from a view configuration.
pub fn kubra_cfg(cfg: &Value) -> (Vec<String>, Option<String>) {
    let mut counties = vec![];
    let mut summary = None;
    fn walk(v: &Value, counties: &mut Vec<String>, summary: &mut Option<String>) {
        match v {
            Value::Object(m) => {
                let ty = m.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let area = m.get("areaType").and_then(|t| t.as_str()).unwrap_or("").to_ascii_lowercase();
                if ty.starts_with("THEMATIC_LAYER") && (area == "county" || area == "parish" || area == "counties") {
                    let src = m.get("source").and_then(|s| s.as_array().and_then(|a| a.first()).or(Some(s))).and_then(|s| s.as_str());
                    if let Some(s) = src {
                        if !counties.iter().any(|c: &String| c == s) {
                            counties.push(s.to_string());
                        }
                    }
                }
                for x in m.values() {
                    walk(x, counties, summary);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, counties, summary)),
            Value::String(s) if summary.is_none() && s.starts_with("public/summary-") && s.ends_with("/data.json") => *summary = Some(s.clone()),
            _ => {}
        }
    }
    walk(cfg, &mut counties, &mut summary);
    (counties, summary)
}

/// Totals from a KUBRA summary file: (customers out, customers served, generated ms).
pub fn kubra_summary(v: &Value) -> (u64, Option<u64>, Option<i64>) {
    let s = &v["summaryFileData"];
    let mut out = 0;
    let mut served: Option<u64> = None;
    for t in s["totals"].as_array().into_iter().flatten() {
        out += u(&t["total_cust_a"]).unwrap_or(0);
        if let Some(x) = u(&t["total_cust_s"]) {
            served = Some(served.unwrap_or(0) + x);
        }
    }
    let t = s["date_generated"].as_str().and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok()).map(|d| d.timestamp_millis());
    (out, served, t)
}

/// County records from a KUBRA `thematic_areas.json`. The state comes from the area id
/// (`IL|Illinois|Bureau|county`, `OE|OHIO|LAKE|county`), else the utility's only state, else the
/// first of its states where the name is a known county.
pub fn kubra_counties(v: &Value, states: &[&str]) -> Vec<County> {
    let mut out = vec![];
    for a in v["file_data"].as_array().into_iter().flatten() {
        let d = &a["desc"];
        let name = d["name"].as_str().or(a["title"].as_str()).unwrap_or("").trim().to_string();
        let n = u(&d["cust_a"]).unwrap_or(0);
        if name.is_empty() || n == 0 {
            continue;
        }
        let id = a["id"].as_str().unwrap_or("");
        let segs: Vec<&str> = id.split('|').collect();
        // full state names win (Ameren writes "MI|Missouri|…"), then a code the utility serves
        let mut st = segs.iter().filter(|s| s.len() > 2).find_map(|s| state_abbr(s)).filter(|s| states.is_empty() || states.contains(s));
        if st.is_none() {
            st = segs.iter().filter(|s| s.len() == 2).find_map(|s| states.iter().find(|x| x.eq_ignore_ascii_case(s)).copied());
        }
        let (state, fips) = match st {
            Some(s) => (s.to_string(), county_fips(s, &name)),
            None if states.len() == 1 => (states[0].to_string(), county_fips(states[0], &name)),
            None => states.iter().find_map(|s| county_fips(s, &name).map(|f| (s.to_string(), Some(f)))).unwrap_or_else(|| (states.first().copied().unwrap_or("").to_string(), None)),
        };
        let at = a["geom"]["p"].as_array().and_then(|p| p.first()).and_then(|p| p.as_str()).and_then(polyline_first);
        out.push(County { fips, name: title_case(&name), state, out: n, served: u(&d["cust_s"]), at, etr: text(&d["etr"]) });
    }
    out
}

fn title_case(s: &str) -> String {
    if s.chars().any(|c| c.is_lowercase()) {
        return s.to_string();
    }
    s.split(' ')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn kubra(o: &Arc<Overlays>, states: &[&str], inst: &str, view: &str) -> Result<Snap> {
    let base = format!("{KUBRA}/stormcenter/api/v1/stormcenters/{inst}/views/{view}");
    let cs = o.get_json(&format!("{base}/currentState?preview=false")).await?;
    let data = cs["data"]["interval_generation_data"].as_str().ok_or_else(|| anyhow!("no interval data in currentState"))?.to_string();
    let dep = cs["stormcenterDeploymentId"].as_str().ok_or_else(|| anyhow!("no deployment id"))?.to_string();
    let cached = o.outages.cfg.lock().get(&dep).filter(|c| c.0.elapsed() < CFG_TTL).map(|c| (c.1.clone(), c.2.clone()));
    let (csrc, ssrc) = match cached {
        Some(c) => c,
        None => {
            let cfg = o.get_json(&format!("{base}/configuration/{dep}?preview=false")).await?;
            let c = kubra_cfg(&cfg);
            o.outages.cfg.lock().insert(dep.clone(), (Instant::now(), c.0.clone(), c.1.clone()));
            c
        }
    };
    let ssrc = ssrc.unwrap_or_else(|| "public/summary-1/data.json".into());
    let summary = o.get_json(&format!("{KUBRA}/{data}/{ssrc}")).await?;
    let (out, served, updated) = kubra_summary(&summary);
    let mut counties = vec![];
    for c in &csrc {
        match o.get_json(&format!("{KUBRA}/{data}/{c}")).await {
            Ok(v) => counties.extend(kubra_counties(&v, states)),
            // a view with no outages may omit the file
            Err(e) if out == 0 => tracing::debug!("kubra county file: {e:#}"),
            Err(e) => return Err(e),
        }
    }
    Ok(Snap { counties, points: vec![], out, served, updated, points_primary: false })
}

// ---------- Duke Energy (ArcGIS) ----------

pub fn duke_counties(fc: &Value) -> Vec<County> {
    let mut out = vec![];
    for f in fc["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let n = u(prop(p, "CUSTOMER_OUT")).unwrap_or(0);
        let name = prop(p, "COUNTY_NAME").as_str().unwrap_or("").trim().to_string();
        if n == 0 || name.is_empty() {
            continue;
        }
        let state = prop(p, "STATE_NAME").as_str().and_then(state_abbr).unwrap_or("").to_string();
        let fips = if state.is_empty() { ["NC", "SC", "FL", "IN", "OH", "KY"].iter().find_map(|s| county_fips(s, &name)) } else { county_fips(&state, &name) };
        let state = if state.is_empty() { fips.as_deref().and_then(|f| STATES.iter().find(|s| s.0 == &f[..2])).map(|s| s.1.to_string()).unwrap_or_default() } else { state };
        out.push(County { fips, name: title_case(&name), state, out: n, served: u(prop(p, "CUSTOMER_SERVED")), at: None, etr: text(prop(p, "ETR")) });
    }
    out
}

pub fn duke_points(feats: &[Value]) -> Vec<Point> {
    feats
        .iter()
        .filter_map(|f| {
            let c = f["geometry"]["coordinates"].as_array()?;
            let (lon, lat) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
            let p = &f["properties"];
            let n = u(prop(p, "AFFECTED_CUSTOMERS")).unwrap_or(0);
            (n > 0).then(|| Point {
                lon,
                lat,
                out: n,
                start: text(prop(p, "START_TIME")),
                etr: text(prop(p, "ETR")),
                cause: text(prop(p, "CAUSE")),
                status: text(prop(p, "CREW_STATUS")),
                area: text(prop(p, "JURISDICTION")),
            })
        })
        .collect()
}

async fn duke(o: &Arc<Overlays>) -> Result<Snap> {
    let url = format!("{DUKE}/1/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=2000");
    let fc = o.get_json(&url).await?;
    if let Some(e) = fc.get("error") {
        bail!("ArcGIS: {}", e["message"].as_str().unwrap_or("error"));
    }
    let counties = duke_counties(&fc);
    let mut updated = None;
    let mut served = 0u64;
    for f in fc["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        served += u(prop(p, "CUSTOMER_SERVED")).unwrap_or(0);
        if let Some(t) = prop(p, "last_edited_date").as_i64() {
            updated = Some(updated.map_or(t, |u: i64| u.max(t)));
        }
    }
    let layer = format!("{DUKE}/0");
    let q = agsquery::Query { layer: &layer, where_: "1=1", max: MAX_POINTS, page: 2000, ..Default::default() };
    let points = match agsquery::features(o, &q).await {
        Ok(f) => duke_points(&f),
        Err(e) => {
            tracing::debug!("duke points: {e:#}");
            vec![]
        }
    };
    let out = counties.iter().map(|c| c.out).sum();
    Ok(Snap { counties, points, out, served: (served > 0).then_some(served), updated, points_primary: false })
}

// ---------- Hydro-Québec ----------

pub fn hq_points(v: &Value) -> Vec<Point> {
    let status = |s: &str| match s {
        "A" => "Crew assigned",
        "L" => "Crew at work",
        "R" => "Crew en route",
        _ => "",
    };
    v["pannes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let a = p.as_array()?;
            let n = u(a.first()?).unwrap_or(0);
            let xy: Vec<f64> = a.get(4)?.as_str()?.trim_matches(|c| c == '[' || c == ']').split(',').filter_map(|x| x.trim().parse().ok()).collect();
            if xy.len() != 2 || n == 0 {
                return None;
            }
            let t = |i: usize| a.get(i).and_then(|x| x.as_str()).filter(|s| !s.is_empty());
            let ms = |i: usize| t(i).and_then(|s| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()).map(|d| eastern_ms(d).to_string());
            Some(Point {
                lon: xy[0],
                lat: xy[1],
                out: n,
                start: ms(1),
                etr: ms(2),
                // the cause codes are not documented
                cause: None,
                status: t(5).map(status).filter(|s| !s.is_empty()).map(String::from),
                area: None,
            })
        })
        .collect()
}

async fn hydroquebec(o: &Arc<Overlays>) -> Result<Snap> {
    let ver = o.get_text(&format!("{HQ}/bisversion.json")).await?;
    let ver = ver.trim().trim_matches('"').to_string();
    if ver.len() < 14 || !ver.chars().all(|c| c.is_ascii_digit()) {
        bail!("unexpected Hydro-Québec version {ver:?}");
    }
    let v = o.get_json(&format!("{HQ}/bismarkers{ver}.json")).await?;
    let points = hq_points(&v);
    let updated = NaiveDateTime::parse_from_str(&ver[..14], "%Y%m%d%H%M%S").ok().map(eastern_ms);
    Ok(Snap { out: points.iter().map(|p| p.out).sum(), counties: vec![], points, served: None, updated, points_primary: true })
}

// ---------- polling ----------

fn source_name(id: &str) -> &'static str {
    KUBRA_VIEWS.iter().find(|k| k.0 == id).map(|k| k.1).or_else(|| OTHER.iter().find(|k| k.0 == id).map(|k| k.1)).unwrap_or("")
}

fn source_states(id: &str) -> Vec<&'static str> {
    match id {
        "duke" => vec!["NC", "SC", "FL", "IN", "OH", "KY"],
        "hydroquebec" => vec!["QC"],
        _ => KUBRA_VIEWS.iter().find(|k| k.0 == id).map(|k| k.2.to_vec()).unwrap_or_default(),
    }
}

async fn fetch(o: &Arc<Overlays>, id: &'static str) -> Result<Snap> {
    match id {
        "duke" => duke(o).await,
        "hydroquebec" => hydroquebec(o).await,
        _ => {
            let k = KUBRA_VIEWS.iter().find(|k| k.0 == id).ok_or_else(|| anyhow!("unknown source {id}"))?;
            kubra(o, k.2, k.3, k.4).await
        }
    }
}

fn all_ids() -> Vec<&'static str> {
    KUBRA_VIEWS.iter().map(|k| k.0).chain(OTHER.iter().map(|k| k.0)).collect()
}

/// Refresh stale sources; the very first request waits (up to 25 s) for the first round.
async fn ensure(o: &Arc<Overlays>) {
    let mut handles = vec![];
    let mut first = true;
    {
        let mut m = o.outages.srcs.lock();
        for id in all_ids() {
            let s = m.entry(id).or_default();
            if s.snap.is_some() || s.err.is_some() {
                first = false;
            }
            let stale = s.ok.map(|t| t.elapsed().as_secs() >= POLL_S).unwrap_or(true);
            let backoff = s.err.is_some() && s.tried.map(|t| t.elapsed().as_secs() < BACKOFF_S).unwrap_or(false);
            if !stale || s.busy || backoff {
                continue;
            }
            s.busy = true;
            s.tried = Some(Instant::now());
            let o2 = o.clone();
            let sem = o.outages.sem.clone();
            handles.push(tokio::spawn(async move {
                let _p = sem.acquire().await;
                let r = tokio::time::timeout(Duration::from_secs(60), fetch(&o2, id)).await.unwrap_or_else(|_| Err(anyhow!("timed out")));
                let mut m = o2.outages.srcs.lock();
                let s = m.entry(id).or_default();
                s.busy = false;
                match r {
                    Ok(d) => {
                        s.snap = Some(Arc::new(d));
                        s.ok = Some(Instant::now());
                        s.err = None;
                    }
                    Err(e) => {
                        tracing::debug!("outages {id}: {e:#}");
                        let msg = format!("{e:#}");
                        s.err = Some(if msg.chars().count() > 160 { format!("{}…", msg.chars().take(160).collect::<String>()) } else { msg });
                    }
                }
            }));
        }
    }
    if first && !handles.is_empty() {
        let _ = tokio::time::timeout(Duration::from_secs(25), futures::future::join_all(handles)).await;
    }
    start_reaper(o);
}

fn start_reaper(o: &Arc<Overlays>) {
    if o.outages.reaper.swap(true, Ordering::SeqCst) {
        return;
    }
    let o = o.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            if o.idle("outages", 1800) {
                o.outages.srcs.lock().clear();
                o.outages.reaper.store(false, Ordering::SeqCst);
                break;
            }
        }
    });
}

// ---------- output ----------

fn inside(b: &Option<[f64; 4]>, lon: f64, lat: f64) -> bool {
    b.map(|b| lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]).unwrap_or(true)
}

/// Merge per-utility snapshots into the response. Counties with the same FIPS are summed (several
/// utilities can serve one county); county features carry a label point when a source gave one,
/// else no geometry (the client draws them from `fips`).
pub fn assemble(snaps: &[(&str, &str, Arc<Snap>)], bbox: Option<[f64; 4]>, points: bool) -> (Vec<Value>, u64, u64) {
    struct Acc {
        name: String,
        state: String,
        fips: Option<String>,
        out: u64,
        served: u64,
        served_known: bool,
        at: Option<(f64, f64)>,
        utils: Vec<Value>,
        updated: Option<i64>,
        sources: Vec<String>,
    }
    let mut acc: BTreeMap<String, Acc> = BTreeMap::new();
    let mut feats = vec![];
    let mut total = 0u64;
    let mut served_total = 0u64;
    for (id, name, s) in snaps {
        total += s.out;
        served_total += s.served.unwrap_or(0);
        for c in &s.counties {
            let key = c.fips.clone().unwrap_or_else(|| format!("{}|{}", c.state, c.name.to_lowercase()));
            let a = acc.entry(key).or_insert_with(|| Acc { name: c.name.clone(), state: c.state.clone(), fips: c.fips.clone(), out: 0, served: 0, served_known: true, at: None, utils: vec![], updated: None, sources: vec![] });
            a.out += c.out;
            match c.served {
                Some(x) => a.served += x,
                None => a.served_known = false,
            }
            a.at = a.at.or(c.at);
            a.updated = match (a.updated, s.updated) {
                (Some(x), Some(y)) => Some(x.max(y)),
                (x, y) => x.or(y),
            };
            a.utils.push(json!({"name": name, "out": c.out, "served": c.served, "etr": c.etr}));
            if !a.sources.iter().any(|x| x == id) {
                a.sources.push(id.to_string());
            }
        }
        if points || s.points_primary {
            for p in &s.points {
                if !inside(&bbox, p.lon, p.lat) {
                    continue;
                }
                feats.push(json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(p.lon), round(p.lat)]}, "properties": {
                    "kind": "point", "out": p.out, "utility": name, "source": id, "updated": s.updated,
                    "start": p.start, "etr": p.etr, "cause": p.cause, "status": p.status, "area": p.area,
                }}));
            }
        }
    }
    let mut counties: Vec<Value> = acc
        .into_values()
        .filter(|a| a.at.map(|(x, y)| inside(&bbox, x, y)).unwrap_or(true))
        .map(|a| {
            let served = (a.served_known && a.served > 0).then_some(a.served);
            let pct = served.map(|s| ((a.out as f64 / s as f64) * 1000.0).round() / 10.0);
            let utility = a.utils.iter().filter_map(|u| u["name"].as_str()).collect::<Vec<_>>().join(", ");
            json!({"type": "Feature", "geometry": a.at.map(|(x, y)| json!({"type": "Point", "coordinates": [round(x), round(y)]})), "properties": {
                "kind": "county", "fips": a.fips, "name": a.name, "state": a.state, "out": a.out, "served": served, "pct": pct,
                "utility": utility, "utilities": a.utils, "updated": a.updated, "source": a.sources.join(","),
            }})
        })
        .collect();
    counties.sort_by(|a, b| b["properties"]["out"].as_u64().cmp(&a["properties"]["out"].as_u64()));
    counties.extend(feats);
    (counties, total, served_total)
}

/// `outages` overlay: `?bbox=w,s,e,n&level=county|point`.
/// `county` (default): county features + outage points from sources without a county breakdown
/// (Hydro-Québec); `point`: also every individual outage point (Duke Energy).
pub async fn outages(o: &Arc<Overlays>, bbox: &str, level: &str) -> Result<Value> {
    o.touch("outages");
    ensure(o).await;
    let bb = agsquery::parse_bbox(bbox)?;
    let (snaps, sources) = {
        let m = o.outages.srcs.lock();
        let mut snaps = vec![];
        let mut sources = vec![];
        for id in all_ids() {
            let s = m.get(id);
            let snap = s.and_then(|s| s.snap.clone());
            sources.push(json!({
                "id": id, "name": source_name(id), "states": source_states(id),
                "count": snap.as_ref().map(|x| if x.points_primary { x.points.len() } else { x.counties.len() }).unwrap_or(0),
                "out": snap.as_ref().map(|x| x.out), "served": snap.as_ref().and_then(|x| x.served), "updated": snap.as_ref().and_then(|x| x.updated),
                "age": s.and_then(|s| s.ok).map(|t| t.elapsed().as_secs()), "error": s.and_then(|s| s.err.clone()),
            }));
            if let Some(x) = snap {
                snaps.push((id, source_name(id), x));
            }
        }
        (snaps, sources)
    };
    let ok = sources.iter().filter(|s| s["error"].is_null() && !s["age"].is_null()).count();
    let bad = sources.iter().filter(|s| !s["error"].is_null()).count();
    let (feats, total, served) = assemble(&snaps, bb, level == "point");
    if ok > 0 {
        o.health.ok("outages-src", "Power outage sources (utilities)", format!("{ok} utilities ok, {bad} failing, {total} customers out"));
    } else if bad > 0 {
        o.health.err("outages-src", "Power outage sources (utilities)", format!("all {bad} sources failing"));
    }
    Ok(json!({
        "type": "FeatureCollection", "features": feats, "sources": sources, "total_out": total, "total_served": served,
        "total": total, "level": if level == "point" { "point" } else { "county" },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fips_lookup() {
        assert_eq!(county_fips("MI", "Macomb").as_deref(), Some("26099"));
        assert_eq!(county_fips("OH", "CUYAHOGA").as_deref(), Some("39035"));
        assert_eq!(county_fips("VA", "Richmond City").as_deref(), Some("51760"));
        assert_eq!(county_fips("VA", "Richmond").as_deref(), Some("51159"));
        assert_eq!(county_fips("VA", "James City").as_deref(), Some("51095"));
        assert_eq!(county_fips("FL", "Saint Johns").as_deref(), Some("12109"));
        assert_eq!(county_fips("FL", "ST. LUCIE").as_deref(), Some("12111"));
        assert_eq!(county_fips("LA", "St. Bernard Parish").as_deref(), Some("22087"));
        assert_eq!(county_fips("MD", "Baltimore City").as_deref(), Some("24510"));
        assert_eq!(county_fips("NM", "Doña Ana").as_deref(), Some("35013"));
        assert_eq!(county_fips("TX", "Nowhere"), None);
        assert_eq!(state_abbr("NORTH CAROLINA"), Some("NC"));
    }

    #[test]
    fn polyline() {
        // Google's example: (38.5, -120.2)
        let (lon, lat) = polyline_first("_p~iF~ps|U_ulLnnqC").unwrap();
        assert!((lat - 38.5).abs() < 1e-6 && (lon + 120.2).abs() < 1e-6);
    }

    #[test]
    fn kubra_files() {
        let cfg = json!({"config": {"layers": {"data": {"interval_generation_data": [
            {"id": "cluster-1", "type": "CLUSTER_LAYER_V2", "source": ["public/cluster-1/{q}.json"]},
            {"id": "thematic-1", "type": "THEMATIC_LAYER_V2", "areaType": "zip", "source": ["public/thematic-1/thematic_areas.json"]},
            {"id": "thematic-2", "type": "THEMATIC_LAYER_V2", "areaType": "county", "source": ["public/thematic-2/thematic_areas.json"]},
        ]}}, "summary": {"data": {"interval_generation_data": {"source": "public/summary-2/data.json"}}}}});
        let (c, s) = kubra_cfg(&cfg);
        assert_eq!(c, vec!["public/thematic-2/thematic_areas.json".to_string()]);
        assert_eq!(s.as_deref(), Some("public/summary-2/data.json"));
        let sum = json!({"summaryFileData": {"totals": [{"total_cust_a": {"val": 900}, "total_cust_s": 2263999}], "date_generated": "2026-10-12T21:20:00.890927532Z"}});
        let (o, sv, t) = kubra_summary(&sum);
        assert_eq!((o, sv), (900, Some(2263999)));
        assert_eq!(t, Some(1791840000890));
        let th = json!({"file_title": "thematic_areas", "file_data": [
            {"id": "MI|Missouri|Lincoln|county", "title": "Lincoln", "desc": {"name": "Lincoln", "cust_a": {"val": 18}, "cust_s": 14304, "etr": "ETR-NULL"}, "geom": {"p": ["_p~iF~ps|U"]}},
            {"id": "IL|Illinois|Bureau|county", "title": "Bureau", "desc": {"name": "Bureau", "cust_a": {"val": 14}, "cust_s": 9851}},
            {"id": "OE|OHIO|LAKE|county", "title": "LAKE", "desc": {"name": "LAKE", "cust_a": {"val": 19, "mask": 20}, "cust_s": 103882}},
            {"id": "x", "desc": {"name": "Zero", "cust_a": {"val": 0}}},
        ]});
        let c = kubra_counties(&th, &["IL", "MO"]);
        assert_eq!(c.len(), 3, "an unknown state code falls back to a county of the same name in a served state");
        assert_eq!((c[0].state.as_str(), c[0].fips.as_deref(), c[0].out, c[0].served), ("MO", Some("29113"), 18, Some(14304)));
        assert!(c[0].at.is_some() && c[0].etr.is_none());
        assert_eq!(c[1].fips.as_deref(), Some("17011"));
        let c = kubra_counties(&th, &["OH"]);
        assert_eq!(c.iter().find(|x| x.name == "Lake").and_then(|x| x.fips.clone()).as_deref(), Some("39085"));
    }

    #[test]
    fn duke_and_hq() {
        let fc = json!({"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": null, "properties": {"COUNTY_NAME": "BUNCOMBE", "CUSTOMER_SERVED": 155286, "CUSTOMER_OUT": 70, "STATE_NAME": "NORTH CAROLINA", "ETR": "2026-10-13 01:30:00"}},
            {"type": "Feature", "geometry": null, "properties": {"county_name": "PINELLAS", "customer_served": 559890, "customer_out": 16, "state_name": "FLORIDA"}},
            {"type": "Feature", "geometry": null, "properties": {"COUNTY_NAME": "IREDELL", "CUSTOMER_OUT": 0, "STATE_NAME": "NORTH CAROLINA"}},
        ]});
        let c = duke_counties(&fc);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].fips.as_deref(), c[0].name.as_str(), c[0].out), (Some("37021"), "Buncombe", 70));
        assert_eq!(c[1].fips.as_deref(), Some("12103"));
        let hq = json!({"messages": [], "pannes": [
            [71, "2026-10-12 08:35:15", "", "P", "[-73.6023391977352, 45.583253638285974]", "A", "", "", "0283", ""],
            [0, "2026-10-12 08:35:15", "", "P", "[-73.6, 45.5]", "A", "", "", "0283", ""],
        ]});
        let p = hq_points(&hq);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].out, 71);
        assert_eq!(p[0].status.as_deref(), Some("Crew assigned"));
        // 08:35:15 EDT = 12:35:15 UTC
        assert_eq!(p[0].start.as_deref(), Some("1791808515000"));
        let jan = NaiveDateTime::parse_from_str("2026-01-10 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(eastern_ms(jan), Utc.with_ymd_and_hms(2026, 1, 10, 17, 0, 0).unwrap().timestamp_millis());
    }

    #[test]
    fn merge() {
        let a = Arc::new(Snap { counties: vec![County { fips: Some("39035".into()), name: "Cuyahoga".into(), state: "OH".into(), out: 10, served: Some(1000), at: Some((-81.6, 41.4)), etr: None }], out: 10, served: Some(5000), ..Default::default() });
        let b = Arc::new(Snap { counties: vec![County { fips: Some("39035".into()), name: "Cuyahoga".into(), state: "OH".into(), out: 30, served: Some(1000), at: None, etr: None }], out: 30, ..Default::default() });
        let q = Arc::new(Snap { points: vec![Point { lon: -73.6, lat: 45.6, out: 5, start: None, etr: None, cause: None, status: None, area: None }], out: 5, points_primary: true, ..Default::default() });
        let (f, total, _) = assemble(&[("a", "A", a.clone()), ("b", "B", b), ("hq", "HQ", q.clone())], None, false);
        assert_eq!(total, 45);
        assert_eq!(f.len(), 2);
        let p = &f[0]["properties"];
        assert_eq!((p["out"].as_u64(), p["served"].as_u64(), p["pct"].as_f64()), (Some(40), Some(2000), Some(2.0)));
        assert_eq!(p["utility"], "A, B");
        assert_eq!(f[1]["properties"]["kind"], "point");
        // bbox keeps counties without a known position, drops points outside
        let (f, _, _) = assemble(&[("a", "A", a), ("hq", "HQ", q)], Some([-90.0, 30.0, -80.0, 45.0]), false);
        assert_eq!(f.len(), 1);
    }
}
