//! Raster tiles from allowlisted NOAA ArcGIS services (NOHRSC snow analysis, NWS HeatRisk),
//! rendered by the service's `export` / `exportImage` for each Web Mercator tile.

use super::Overlays;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use std::time::Duration;

pub struct Service {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    /// ImageServer (exportImage) rather than MapServer (export)
    pub image: bool,
}

pub const SERVICES: &[Service] = &[
    Service { id: "nohrsc", name: "NOHRSC snow analysis", url: "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer", image: false },
    Service { id: "heatrisk", name: "NWS HeatRisk", url: "https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer", image: true },
];

/// Percent-encode a query value (unreserved characters, ',' and ':' pass through).
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~,:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn with_query(base: &str, q: &[(&str, String)]) -> String {
    let qs: Vec<String> = q.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect();
    format!("{base}?{}", qs.join("&"))
}

pub fn service(id: &str) -> Option<&'static Service> {
    SERVICES.iter().find(|s| s.id == id)
}

/// Web Mercator (EPSG:3857) bounds of an XYZ tile: (xmin, ymin, xmax, ymax) in metres.
pub fn tile_bbox(z: u32, x: u32, y: u32) -> (f64, f64, f64, f64) {
    const HALF: f64 = 20_037_508.342_789_244;
    let size = 2.0 * HALF / (1u64 << z) as f64;
    let xmin = -HALF + x as f64 * size;
    let ymax = HALF - y as f64 * size;
    (xmin, ymax - size, xmin + size, ymax)
}

/// MapServer sub-layer for NOHRSC: depth (raster 3) or SWE (raster 7).
fn nohrsc_layer(layer: &str) -> Result<u32> {
    Ok(match layer {
        "" | "depth" | "0" | "3" => 3,
        "swe" | "4" | "7" => 7,
        _ => bail!("layer must be depth or swe"),
    })
}

/// HeatRisk day 1..7 (day 1 = today).
fn heatrisk_day(day: &str) -> Result<u32> {
    match day {
        "" => Ok(1),
        d => d.parse::<u32>().ok().filter(|d| (1..=7).contains(d)).ok_or_else(|| anyhow!("day must be 1-7")),
    }
}

/// Query parameters for one 256×256 transparent PNG tile.
pub fn tile_query(s: &Service, z: u32, x: u32, y: u32, layer: &str, day: &str) -> Result<Vec<(&'static str, String)>> {
    let (a, b, c, d) = tile_bbox(z, x, y);
    let mut q = vec![
        ("bbox", format!("{a:.3},{b:.3},{c:.3},{d:.3}")),
        ("bboxSR", "3857".to_string()),
        ("imageSR", "3857".to_string()),
        ("size", "256,256".to_string()),
        ("format", "png32".to_string()),
        ("transparent", "true".to_string()),
        ("f", "image".to_string()),
    ];
    if s.image {
        let day = heatrisk_day(day)?;
        q.push(("renderingRule", r#"{"rasterFunction":"heatrisk.rft"}"#.to_string()));
        q.push(("mosaicRule", format!(r#"{{"mosaicMethod":"esriMosaicNone","where":"name='HeatRisk_{day}_Mercator'"}}"#)));
        q.push(("interpolation", "RSP_NearestNeighbor".to_string()));
    } else {
        q.push(("layers", format!("show:{}", nohrsc_layer(layer)?)));
        q.push(("dpi", "96".to_string()));
    }
    Ok(q)
}

pub async fn tile(o: &Overlays, id: &str, z: u32, x: u32, y: u32, layer: &str, day: &str) -> Result<Bytes> {
    let s = service(id).ok_or_else(|| anyhow!("unknown service {id}"))?;
    if z > 16 || x >= (1u32 << z) || y >= (1u32 << z) {
        bail!("bad tile");
    }
    let q = tile_query(s, z, x, y, layer, day)?;
    let ck = format!("arcgis/{id}/{z}/{x}/{y}/{layer}/{day}");
    if let Some(b) = o.arcgis.get(&ck) {
        return Ok(b);
    }
    let path = if s.image { "exportImage" } else { "export" };
    let r = o.http.get(with_query(&format!("{}/{path}", s.url), &q)).timeout(Duration::from_secs(30)).send().await;
    let res = async {
        let r = r?;
        if !r.status().is_success() {
            bail!("HTTP {} from {}", r.status(), super::host(s.url));
        }
        let ct = r.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let b = r.bytes().await?;
        // ArcGIS reports errors as JSON with status 200
        if !ct.starts_with("image/") {
            bail!("{}: {}", s.name, String::from_utf8_lossy(&b[..b.len().min(200)]));
        }
        Ok(b)
    }
    .await;
    match &res {
        Ok(b) => {
            o.health.ok(&format!("arcgis-{id}"), s.name, "");
            o.arcgis.put(ck, b.clone());
        }
        Err(e) => o.health.err(&format!("arcgis-{id}"), s.name, e),
    }
    res
}

/// The service's legend JSON, passed through.
pub async fn legend(o: &Overlays, id: &str) -> Result<Bytes> {
    let s = service(id).ok_or_else(|| anyhow!("unknown service {id}"))?;
    let ck = format!("arcgis/{id}/legend");
    if let Some(b) = o.arcgis.get(&ck) {
        return Ok(b);
    }
    let mut q = vec![("f", "json".to_string())];
    if s.image {
        q.push(("renderingRule", r#"{"rasterFunction":"heatrisk.rft"}"#.to_string()));
    }
    let r = o.http.get(with_query(&format!("{}/legend", s.url), &q)).timeout(Duration::from_secs(30)).send().await?;
    if !r.status().is_success() {
        bail!("HTTP {} from {}", r.status(), super::host(s.url));
    }
    let b = r.bytes().await?;
    serde_json::from_slice::<serde_json::Value>(&b).map_err(|e| anyhow!("{}: bad legend JSON: {e}", s.name))?;
    o.arcgis.put(ck, b.clone());
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiles() {
        let (a, b, c, d) = tile_bbox(0, 0, 0);
        assert!((a + 20_037_508.34).abs() < 0.01 && (d - 20_037_508.34).abs() < 0.01 && (c - a - 2.0 * 20_037_508.34).abs() < 0.02 && (b + 20_037_508.34).abs() < 0.01);
        let (a, _, _, d) = tile_bbox(1, 1, 0);
        assert!(a.abs() < 1e-6 && (d - 20_037_508.34).abs() < 0.01);
        let q = tile_query(service("nohrsc").unwrap(), 4, 3, 5, "swe", "").unwrap();
        assert!(q.contains(&("layers", "show:7".to_string())));
        let q = tile_query(service("heatrisk").unwrap(), 4, 3, 5, "", "3").unwrap();
        assert!(q.iter().any(|(k, v)| *k == "mosaicRule" && v.contains("HeatRisk_3_Mercator")));
        assert!(tile_query(service("heatrisk").unwrap(), 4, 3, 5, "", "9").is_err());
        assert!(tile_query(service("nohrsc").unwrap(), 4, 3, 5, "rain", "").is_err());
        assert!(service("other").is_none());
        assert_eq!(enc("show:7 {\"a\"='x'}"), "show:7%20%7B%22a%22%3D%27x%27%7D");
    }
}
