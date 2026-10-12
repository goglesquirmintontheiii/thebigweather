//! Paged GeoJSON queries against ArcGIS FeatureServer / MapServer layers, plus bbox parsing.

use super::arcgis::enc;
use super::Overlays;
use anyhow::{anyhow, bail, Result};
use serde_json::Value;

/// `bbox=w,s,e,n` (empty = None).
pub fn parse_bbox(s: &str) -> Result<Option<[f64; 4]>> {
    if s.trim().is_empty() {
        return Ok(None);
    }
    let b: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if b.len() != 4 || b[0] >= b[2] || b[1] >= b[3] || b[1] < -90.0 || b[3] > 90.0 || b[2] - b[0] > 360.0 {
        bail!("bbox must be w,s,e,n");
    }
    Ok(Some([b[0], b[1], b[2], b[3]]))
}

/// One query.
pub struct Query<'a> {
    /// layer URL (…/FeatureServer/0)
    pub layer: &'a str,
    pub where_: &'a str,
    pub fields: &'a str,
    pub bbox: Option<[f64; 4]>,
    /// stop after this many features
    pub max: usize,
    /// geometry generalization in degrees (0 = none)
    pub simplify: f64,
    pub order_by: &'a str,
    /// page size (≤ the layer's maxRecordCount)
    pub page: usize,
}

impl Default for Query<'_> {
    fn default() -> Self {
        Query { layer: "", where_: "1=1", fields: "*", bbox: None, max: 5000, simplify: 0.0, order_by: "", page: 1000 }
    }
}

pub fn query_url(q: &Query, offset: usize) -> String {
    let mut p = vec![
        ("where", q.where_.to_string()),
        ("outFields", q.fields.to_string()),
        ("returnGeometry", "true".to_string()),
        ("outSR", "4326".to_string()),
        ("geometryPrecision", "5".to_string()),
        ("resultOffset", offset.to_string()),
        ("resultRecordCount", q.page.min(q.max.saturating_sub(offset)).max(1).to_string()),
        ("f", "geojson".to_string()),
    ];
    if let Some([w, s, e, n]) = q.bbox {
        p.push(("geometry", format!("{w},{s},{e},{n}")));
        p.push(("geometryType", "esriGeometryEnvelope".to_string()));
        p.push(("inSR", "4326".to_string()));
        p.push(("spatialRel", "esriSpatialRelIntersects".to_string()));
    }
    if q.simplify > 0.0 {
        p.push(("maxAllowableOffset", format!("{}", q.simplify)));
    }
    if !q.order_by.is_empty() {
        p.push(("orderByFields", q.order_by.to_string()));
    }
    let qs: Vec<String> = p.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect();
    format!("{}/query?{}", q.layer, qs.join("&"))
}

/// All features (up to `max`), following pages while the server reports more.
pub async fn features(o: &Overlays, q: &Query<'_>) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = vec![];
    loop {
        let v = o.get_json(&query_url(q, out.len())).await?;
        if let Some(e) = v.get("error") {
            return Err(anyhow!("ArcGIS: {}", e["message"].as_str().unwrap_or("error")));
        }
        let page = v["features"].as_array().cloned().unwrap_or_default();
        let n = page.len();
        out.extend(page);
        let more = v["exceededTransferLimit"].as_bool().unwrap_or(false) || v["properties"]["exceededTransferLimit"].as_bool().unwrap_or(false);
        if n == 0 || !more || out.len() >= q.max {
            break;
        }
    }
    out.truncate(q.max);
    Ok(out)
}

/// String / number property helpers.
pub fn s(p: &Value, k: &str) -> String {
    match &p[k] {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

pub fn f(p: &Value, k: &str) -> Option<f64> {
    match &p[k] {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches(|c: char| !c.is_ascii_digit()).parse().ok(),
        _ => None,
    }
    .filter(|v: &f64| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bbox_and_url() {
        assert_eq!(parse_bbox("").unwrap(), None);
        assert_eq!(parse_bbox("-100,30,-90,40").unwrap(), Some([-100.0, 30.0, -90.0, 40.0]));
        assert!(parse_bbox("-90,30,-100,40").is_err());
        let q = Query { layer: "https://x/FeatureServer/1", bbox: Some([-100.0, 30.0, -90.0, 40.0]), max: 2500, ..Default::default() };
        let u = query_url(&q, 2000);
        assert!(u.starts_with("https://x/FeatureServer/1/query?where=1%3D1"));
        assert!(u.contains("resultOffset=2000&resultRecordCount=500"));
        assert!(u.contains("geometry=-100,30,-90,40&geometryType=esriGeometryEnvelope"));
        assert_eq!(f(&serde_json::json!({"w": "110 mph"}), "w"), Some(110.0));
    }
}
