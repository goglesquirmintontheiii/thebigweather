//! Winter road conditions from keyless state DOT ArcGIS services: Iowa DOT 511, the Iowa-hosted
//! Midwest feed (IL, KS, MN, MO, NE, ND, SD, WI) and PennDOT.

use super::agsquery::{self, f, parse_bbox, s, Query};
use super::{fc, Overlays};
use anyhow::{bail, Result};
use serde_json::{json, Value};

const IOWA: &str = "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/511_IA_Road_Conditions_View/FeatureServer/0";
const MIDWEST: &str = "https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Midwest_Winter_Road_Conditions_View/FeatureServer/0";
const PENNDOT: &str = "https://gis.penndot.gov/gis/rest/services/winterconditions/winterconditions/MapServer";

/// Normalized condition from a coverage level (0 normal … 4 impassable) and free text.
/// Returns one of closed | notravel | ice | snow | slush | wet | frost | dry | unknown.
pub fn classify(level: Option<u8>, text: &str) -> &'static str {
    let t = text.to_ascii_lowercase();
    let words: Vec<&str> = t.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let has = |p: &[&str]| words.iter().any(|w| p.iter().any(|x| w.starts_with(x)));
    if level == Some(4) || has(&["impassable", "closed", "closure"]) {
        return "closed";
    }
    if level == Some(3) || t.contains("travel not advised") || t.contains("no travel") {
        return "notravel";
    }
    if has(&["ice", "icy", "glaze", "freezing"]) {
        return "ice";
    }
    if has(&["slush"]) {
        return "slush";
    }
    if has(&["snow", "drift", "covered"]) {
        return "snow";
    }
    if has(&["frost"]) {
        return "frost";
    }
    if has(&["wet"]) {
        return "wet";
    }
    if level == Some(1) || level == Some(2) {
        return "snow";
    }
    if level == Some(0) || has(&["seasonal", "normal", "dry", "clear", "good"]) {
        return "dry";
    }
    "unknown"
}

/// Coverage level from Iowa / Midwest condition names or codes.
pub fn level_of(cond: &str) -> Option<u8> {
    let c = cond.trim().to_ascii_lowercase();
    Some(match c.as_str() {
        "1" | "seasonal" => 0,
        "2" | "partially covered" => 1,
        "3" | "completely covered" => 2,
        "4" | "travel not advised" => 3,
        "5" | "impassable" => 4,
        _ => return None,
    })
}

fn line(mut x: Value, props: Value) -> Value {
    x["properties"] = props;
    x
}

async fn iowa(o: &Overlays, bbox: Option<[f64; 4]>, adverse: bool) -> Result<Vec<Value>> {
    let q = Query {
        layer: IOWA,
        where_: if adverse { "ROAD_CONDITION <> 'Seasonal'" } else { "1=1" },
        fields: "ROAD_CONDITION,HL_PAVEMENT_CONDITION,PH_PAVEMENT_CONDITION,ROUTE_NAME,LONG_NAME,CARS_MSG_UPDATE_DATE",
        bbox,
        max: 6000,
        simplify: 0.0005,
        page: 2000,
        ..Default::default()
    };
    Ok(agsquery::features(o, &q)
        .await?
        .into_iter()
        .map(|x| {
            let p = &x["properties"];
            let lvl = level_of(&s(p, "ROAD_CONDITION"));
            let desc = [s(p, "ROAD_CONDITION"), s(p, "HL_PAVEMENT_CONDITION"), s(p, "PH_PAVEMENT_CONDITION")].into_iter().filter(|z| !z.is_empty()).collect::<Vec<_>>().join(" · ");
            // LONG_NAME already starts with the route ("I-235, between …")
            let road = Some(s(p, "LONG_NAME")).filter(|z| !z.is_empty()).unwrap_or_else(|| s(p, "ROUTE_NAME"));
            let props = json!({"cond": classify(lvl, &format!("{} {}", s(p, "HL_PAVEMENT_CONDITION"), s(p, "PH_PAVEMENT_CONDITION"))), "level": lvl, "desc": desc, "road": road, "source": "IA", "t": p["CARS_MSG_UPDATE_DATE"].as_i64()});
            line(x, props)
        })
        .collect())
}

async fn midwest(o: &Overlays, bbox: Option<[f64; 4]>, adverse: bool) -> Result<Vec<Value>> {
    let q = Query {
        layer: MIDWEST,
        where_: if adverse { "ROAD_CONDITION > 1" } else { "1=1" },
        fields: "ROAD_CONDITION,HEADLINE,DESCRIPTION,ROUTE_NAME,SEGMENT_NAME,SOURCE,STATUS,REPORT_UPDATED",
        bbox,
        max: 10000,
        simplify: 0.0005,
        page: 2000,
        ..Default::default()
    };
    Ok(agsquery::features(o, &q)
        .await?
        .into_iter()
        .map(|x| {
            let p = &x["properties"];
            let lvl = f(p, "ROAD_CONDITION").and_then(|v| level_of(&(v as i64).to_string()));
            let text = format!("{} {}", s(p, "HEADLINE"), s(p, "DESCRIPTION"));
            let desc = [s(p, "HEADLINE"), s(p, "DESCRIPTION")].into_iter().filter(|z| !z.is_empty()).collect::<Vec<_>>().join(" · ");
            let road = [s(p, "ROUTE_NAME"), s(p, "SEGMENT_NAME")].into_iter().filter(|z| !z.is_empty()).collect::<Vec<_>>().join(": ");
            let src = s(p, "SOURCE");
            let props = json!({"cond": classify(lvl, &text), "level": lvl, "desc": desc, "road": road, "source": if src.is_empty() { "Midwest".into() } else { src }, "t": p["REPORT_UPDATED"].as_i64(), "stale": s(p, "STATUS").contains("STALE")});
            line(x, props)
        })
        .collect())
}

async fn penndot(o: &Overlays, bbox: Option<[f64; 4]>) -> Result<Vec<Value>> {
    // one layer per condition; only roads that aren't normal are listed
    let layers = [(0, "closed", 4u8, "Impassable"), (1, "ice", 2, "Icy"), (2, "snow", 2, "Snow packed"), (3, "slush", 1, "Snow / slush"), (4, "ice", 1, "Wet, freezing")];
    let mut out = vec![];
    let mut errs = 0;
    for (id, cond, lvl, desc) in layers {
        let url = format!("{PENNDOT}/{id}");
        let q = Query { layer: &url, fields: "ST_RT_NO,COUNTY_NAME", bbox, max: 4000, simplify: 0.0005, page: 1000, ..Default::default() };
        match agsquery::features(o, &q).await {
            Ok(v) => out.extend(v.into_iter().map(|x| {
                let p = &x["properties"];
                let road = format!("PA {} ({} Co.)", s(p, "ST_RT_NO").trim_start_matches('0'), s(p, "COUNTY_NAME"));
                let props = json!({"cond": cond, "level": lvl, "desc": desc, "road": road, "source": "PA", "t": Value::Null});
                line(x, props)
            })),
            Err(_) => errs += 1,
        }
    }
    if errs == layers.len() {
        bail!("PennDOT winter conditions unavailable");
    }
    Ok(out)
}

fn overlaps(b: Option<[f64; 4]>, area: [f64; 4]) -> bool {
    b.map(|[w, s, e, n]| e >= area[0] && w <= area[2] && n >= area[1] && s <= area[3]).unwrap_or(true)
}

/// `adverse` drops roads in normal ("seasonal") condition.
pub async fn roadcond(o: &Overlays, bbox: &str, adverse: bool) -> Result<Value> {
    let bbox = parse_bbox(bbox)?;
    let (a, b, c) = tokio::join!(
        async { if overlaps(bbox, [-96.7, 40.3, -90.1, 43.6]) { Some(iowa(o, bbox, adverse).await) } else { None } },
        async { if overlaps(bbox, [-104.1, 35.9, -82.4, 49.4]) { Some(midwest(o, bbox, adverse).await) } else { None } },
        async { if overlaps(bbox, [-80.6, 39.7, -74.6, 42.3]) { Some(penndot(o, bbox).await) } else { None } },
    );
    let mut feats = vec![];
    let mut errs = vec![];
    let mut tried = 0;
    for (name, r) in [("Iowa", a), ("Midwest", b), ("PennDOT", c)] {
        match r {
            Some(Ok(v)) => {
                tried += 1;
                feats.extend(v.into_iter().filter(|x| !x["geometry"].is_null()));
            }
            Some(Err(e)) => {
                tried += 1;
                errs.push(format!("{name}: {e:#}"));
            }
            None => {}
        }
    }
    if tried > 0 && errs.len() == tried {
        bail!("{}", errs.join("; "));
    }
    let mut v = fc(feats);
    v["errors"] = json!(errs);
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies() {
        assert_eq!(classify(level_of("Impassable"), ""), "closed");
        assert_eq!(classify(level_of("4"), "Snow"), "notravel");
        assert_eq!(classify(level_of("Partially Covered"), "Partially covered with snow"), "snow");
        assert_eq!(classify(level_of("Completely Covered"), "Completely covered with ice"), "ice");
        assert_eq!(classify(level_of("Seasonal"), "Seasonal roadway conditions"), "dry");
        assert_eq!(classify(None, "Wet pavement"), "wet");
        assert_eq!(classify(level_of("2"), ""), "snow");
        assert_eq!(classify(None, "?"), "unknown");
        assert_eq!(classify(None, "see notice for service"), "unknown");
        assert!(overlaps(None, [0.0, 0.0, 1.0, 1.0]));
        assert!(!overlaps(Some([-120.0, 30.0, -110.0, 40.0]), [-96.7, 40.3, -90.1, 43.6]));
    }
}
