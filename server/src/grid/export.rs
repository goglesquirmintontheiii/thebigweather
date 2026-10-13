//! `/api/grid/export`: a grid frame resampled (bilinear) onto a regular lat/lon raster over a
//! bbox, as CSV (`lat,lon,value`), GeoJSON points or netCDF-3 (CF lat/lon grid).

use super::service::GridService;
use crate::export::{text, Attr, Data, Nc};
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;

pub struct Export {
    pub body: Vec<u8>,
    pub content_type: &'static str,
    pub filename: String,
}

/// Query: `layer` (for units/name), `key` (frame; else the newest past frame of `layer`),
/// `format=csv|geojson|nc`, `bbox=w,s,e,n` (required), `res` (max cells on the long side:
/// csv/nc ≤ 1000, geojson ≤ 300; default 300), `thr` for ensemble probability layers.
pub async fn export(gs: &GridService, q: &HashMap<String, String>) -> Result<Export> {
    let g = |k: &str| q.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let layer_id = g("layer").ok_or_else(|| anyhow!("layer required"))?;
    let layer = gs.layer(layer_id)?;
    let bbox = super::contour::bbox_param(q)?;
    let format = g("format").unwrap_or("csv");
    if !["csv", "geojson", "nc"].contains(&format) {
        bail!("format must be csv, geojson or nc (geotiff is not supported)");
    }
    let thr = g("thr").and_then(|t| t.parse::<f64>().ok());
    let key = match g("key") {
        Some(k) => k.to_string(),
        None => {
            let fr = gs.frames_thr(layer_id, 60, g("run"), None, None, thr).await?;
            let now = chrono::Utc::now().timestamp_millis();
            fr.frames.iter().filter(|f| f.time <= now).next_back().or(fr.frames.first()).map(|f| f.key.clone()).ok_or_else(|| anyhow!("no frame for {layer_id}"))?
        }
    };
    let key = super::ens_key_thr(&key, thr);
    if key.starts_with("goesrgb|") {
        bail!("RGB composites have no values to export");
    }
    let grid = gs.grid(&key).await?;
    let cap = if format == "geojson" { 300 } else { 1000 };
    let max_cells = g("res").and_then(|v| v.parse::<usize>().ok()).unwrap_or(300).clamp(8, cap);
    let (units, name, lid) = (layer.units.to_string(), layer.name.clone(), layer.id.clone());
    let fmt = format.to_string();
    gs.run_blocking(move || {
        let (z, nx, ny) = super::contour::raster(&grid, bbox, max_cells);
        let [w, s, e, n] = bbox;
        let (dlon, dlat) = ((e - w) / (nx - 1).max(1) as f64, (n - s) / (ny - 1).max(1) as f64);
        let r5 = |x: f64| (x * 100_000.0).round() / 100_000.0;
        let stem = format!("{}_{}", lid.replace('/', "_"), grid.valid_ms);
        let out = match fmt.as_str() {
            "csv" => {
                let mut o = format!("# {name} ({units}), valid {}\nlat,lon,value\n", chrono::DateTime::from_timestamp_millis(grid.valid_ms).map(|t| t.to_rfc3339()).unwrap_or_default());
                for j in 0..ny {
                    for i in 0..nx {
                        let v = z[j * nx + i];
                        if v.is_finite() {
                            o.push_str(&format!("{},{},{}\n", r5(s + j as f64 * dlat), r5(w + i as f64 * dlon), (v * 1000.0).round() / 1000.0));
                        }
                    }
                }
                Export { body: o.into_bytes(), content_type: "text/csv", filename: format!("{stem}.csv") }
            }
            "geojson" => {
                let mut feats = vec![];
                for j in 0..ny {
                    for i in 0..nx {
                        let v = z[j * nx + i];
                        if v.is_finite() {
                            feats.push(crate::overlays::point(w + i as f64 * dlon, s + j as f64 * dlat, serde_json::json!({"value": (v * 1000.0).round() / 1000.0})));
                        }
                    }
                }
                let mut fc = crate::overlays::fc(feats);
                fc["layer"] = serde_json::json!(lid);
                fc["units"] = serde_json::json!(units);
                fc["time"] = serde_json::json!(grid.valid_ms);
                fc["reference"] = serde_json::json!(grid.ref_ms);
                Export { body: serde_json::to_vec(&fc)?, content_type: "application/geo+json", filename: format!("{stem}.geojson") }
            }
            _ => {
                let mut nc = Nc::default();
                let dy = nc.dim("lat", ny);
                let dx = nc.dim("lon", nx);
                nc.atts.push(("Conventions".into(), text("CF-1.8")));
                nc.atts.push(("title".into(), text(&name)));
                nc.atts.push(("source".into(), text(&format!("TheBigWeather layer {lid}"))));
                nc.atts.push(("valid_time".into(), text(&chrono::DateTime::from_timestamp_millis(grid.valid_ms).map(|t| t.to_rfc3339()).unwrap_or_default())));
                nc.atts.push(("reference_time".into(), text(&chrono::DateTime::from_timestamp_millis(grid.ref_ms).map(|t| t.to_rfc3339()).unwrap_or_default())));
                nc.var("lat", &[dy], vec![("units", text("degrees_north")), ("standard_name", text("latitude"))], Data::F64((0..ny).map(|j| s + j as f64 * dlat).collect()));
                nc.var("lon", &[dx], vec![("units", text("degrees_east")), ("standard_name", text("longitude"))], Data::F64((0..nx).map(|i| w + i as f64 * dlon).collect()));
                let vals: Vec<f32> = z.iter().map(|v| if v.is_finite() { *v } else { -9999.0 }).collect();
                nc.var("value", &[dy, dx], vec![("long_name", text(&name)), ("units", text(&units)), ("_FillValue", Attr::F32(vec![-9999.0]))], Data::F32(vals));
                Export { body: nc.to_bytes(), content_type: "application/x-netcdf", filename: format!("{stem}.nc") }
            }
        };
        Ok(out)
    })
    .await
}
