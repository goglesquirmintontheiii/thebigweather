//! Space weather summary (SWPC): solar wind, X-ray flux, NOAA scales, alerts, plus image and
//! animation lists for SDO, SOHO LASCO, the OVATION aurora forecast and WSA-Enlil.

use super::Overlays;
use anyhow::{bail, Result};
use serde_json::{json, Value};

const SWPC: &str = "https://services.swpc.noaa.gov";

/// Rows of an SWPC "products" table: either `[[header...], [row...]]` or `[{...}]`.
pub fn table(v: &Value) -> Vec<serde_json::Map<String, Value>> {
    let Some(a) = v.as_array() else { return vec![] };
    if let Some(h) = a.first().and_then(|x| x.as_array()) {
        let hdr: Vec<String> = h.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect();
        return a
            .iter()
            .skip(1)
            .filter_map(|r| r.as_array())
            .map(|r| hdr.iter().cloned().zip(r.iter().cloned()).collect())
            .collect();
    }
    a.iter().filter_map(|x| x.as_object().cloned()).collect()
}

fn fnum(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|x: &f64| x.is_finite() && *x > -9999.0)
}

/// Latest row with a value for `key`.
fn latest(rows: &[serde_json::Map<String, Value>], key: &str) -> Option<(String, f64)> {
    rows.iter().rev().find_map(|r| Some((r.get("time_tag")?.as_str()?.to_string(), fnum(r.get(key))?)))
}

/// GOES long-wave (0.1-0.8 nm) flux → flare class ("C2.3").
pub fn xray_class(flux: f64) -> String {
    if flux <= 0.0 {
        return "-".into();
    }
    let (letter, base) = if flux >= 1e-4 {
        ('X', 1e-4)
    } else if flux >= 1e-5 {
        ('M', 1e-5)
    } else if flux >= 1e-6 {
        ('C', 1e-6)
    } else if flux >= 1e-7 {
        ('B', 1e-7)
    } else {
        ('A', 1e-8)
    };
    format!("{letter}{:.1}", flux / base)
}

fn abs_url(u: &str) -> String {
    if u.starts_with("http") { u.to_string() } else { format!("{SWPC}{}{u}", if u.starts_with('/') { "" } else { "/" }) }
}

/// Time from an image name: "..._20261011_1442_..." or "..._20261007T180000.jpg" → ISO UTC.
pub fn name_time(u: &str) -> Option<String> {
    let name = u.rsplit('/').next()?;
    let b = name.as_bytes();
    for i in 0..b.len().saturating_sub(12) {
        if b[i..i + 8].iter().all(|c| c.is_ascii_digit()) && (i == 0 || !b[i - 1].is_ascii_digit()) && (b[i + 8] == b'_' || b[i + 8] == b'T') && b[i + 9..i + 13].iter().all(|c| c.is_ascii_digit()) {
            let d = &name[i..i + 8];
            let t = &name[i + 9..i + 13];
            if d.starts_with("19") || d.starts_with("20") {
                return Some(format!("{}-{}-{}T{}:{}:00Z", &d[..4], &d[4..6], &d[6..8], &t[..2], &t[2..4]));
            }
        }
    }
    None
}

/// `[{url, time_tag?}]` animation list → absolute URLs (last `n` frames).
pub fn frames(v: &Value, n: usize) -> Vec<Value> {
    let a = v.as_array().cloned().unwrap_or_default();
    let k = a.len().saturating_sub(n);
    a[k..]
        .iter()
        .filter_map(|f| {
            let u = f["url"].as_str()?;
            let t = f["time_tag"].as_str().map(String::from).or_else(|| name_time(u)).unwrap_or_default();
            Some(json!({"url": abs_url(u), "time": t}))
        })
        .collect()
}

pub async fn swpc(o: &Overlays) -> Result<Value> {
    let get = |p: &'static str| async move { o.get_json(&format!("{SWPC}{p}")).await };
    let (plasma, mag, xray, flares, alerts, scales, on, os, c2, c3, enlil) = tokio::join!(
        get("/products/solar-wind/plasma-2-hour.json"),
        get("/products/solar-wind/mag-2-hour.json"),
        get("/json/goes/primary/xrays-6-hour.json"),
        get("/json/goes/primary/xray-flares-latest.json"),
        get("/products/alerts.json"),
        get("/products/noaa-scales.json"),
        get("/products/animations/ovation_north_24h.json"),
        get("/products/animations/ovation_south_24h.json"),
        get("/products/animations/lasco-c2.json"),
        get("/products/animations/lasco-c3.json"),
        get("/products/animations/enlil.json"),
    );
    if plasma.is_err() && mag.is_err() && xray.is_err() && alerts.is_err() {
        bail!("SWPC unavailable: {:#}", plasma.err().map(|e| e.to_string()).unwrap_or_default());
    }
    let mut errors = vec![];
    let mut ok = |name: &str, r: Result<Value>| -> Value {
        r.unwrap_or_else(|e| {
            errors.push(format!("{name}: {e:#}"));
            Value::Null
        })
    };
    let (plasma, mag, xray, flares, alerts, scales) = (ok("plasma", plasma), ok("mag", mag), ok("xrays", xray), ok("flares", flares), ok("alerts", alerts), ok("scales", scales));
    let (on, os, c2, c3, enlil) = (ok("ovation_north", on), ok("ovation_south", os), ok("lasco_c2", c2), ok("lasco_c3", c3), ok("enlil", enlil));
    let pr = table(&plasma);
    let mr = table(&mag);
    let speed = latest(&pr, "speed");
    let dens = latest(&pr, "density");
    let bz = latest(&mr, "bz_gsm");
    let bt = latest(&mr, "bt");
    // X-ray: long channel of the primary satellite
    let xr: Vec<&Value> = xray.as_array().map(|a| a.iter().filter(|x| x["energy"].as_str() == Some("0.1-0.8nm")).collect()).unwrap_or_default();
    let xl = xr.iter().rev().find(|x| x["flux"].as_f64().is_some());
    let flux = xl.and_then(|x| x["flux"].as_f64());
    let max6 = xr.iter().filter_map(|x| x["flux"].as_f64()).fold(0.0f64, f64::max);
    let fl = flares.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
    let alerts: Vec<Value> = alerts
        .as_array()
        .map(|a| a.iter().take(25).map(|x| json!({"id": x["product_id"], "issued": x["issue_datetime"], "message": x["message"]})).collect())
        .unwrap_or_default();
    let sdo = [("0193", "AIA 193 Å (corona)"), ("0171", "AIA 171 Å (quiet corona)"), ("0304", "AIA 304 Å (chromosphere)"), ("0131", "AIA 131 Å (flares)"), ("0211", "AIA 211 Å (active regions)"), ("0094", "AIA 94 Å (flaring regions)"), ("1600", "AIA 1600 Å"), ("HMIIC", "HMI continuum (sunspots)"), ("HMIB", "HMI magnetogram")];
    Ok(json!({
        "time": chrono::Utc::now().timestamp_millis(),
        "solar_wind": {
            "speed_kms": speed.as_ref().map(|x| x.1), "density_cc": dens.as_ref().map(|x| x.1),
            "bz_nt": bz.as_ref().map(|x| x.1), "bt_nt": bt.as_ref().map(|x| x.1),
            "time": speed.as_ref().map(|x| x.0.clone()).or(bz.as_ref().map(|x| x.0.clone())),
            "series": pr.iter().rev().step_by(5).take(24).rev().map(|r| json!({"t": r.get("time_tag"), "speed": fnum(r.get("speed")), "density": fnum(r.get("density"))})).collect::<Vec<_>>(),
            "bz_series": mr.iter().rev().step_by(5).take(24).rev().map(|r| json!({"t": r.get("time_tag"), "bz": fnum(r.get("bz_gsm")), "bt": fnum(r.get("bt"))})).collect::<Vec<_>>(),
        },
        "xray": {
            "flux": flux, "class": flux.map(xray_class), "time": xl.map(|x| x["time_tag"].clone()),
            "max_6h_class": if max6 > 0.0 { Value::from(xray_class(max6)) } else { Value::Null },
            "latest_flare": if fl.is_null() { Value::Null } else { json!({"begin": fl["begin_time"], "max": fl["max_time"], "end": fl["end_time"], "class": fl["max_class"], "current_class": fl["current_class"]}) },
        },
        "scales": scales,
        "alerts": alerts,
        "images": {
            "sdo": sdo.iter().map(|(k, n)| json!({"id": k, "name": n, "url": format!("https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_{k}.jpg"), "url_1024": format!("https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_{k}.jpg")})).collect::<Vec<_>>(),
            "lasco": [
                {"id": "c2", "name": "SOHO LASCO C2", "url": "https://soho.nascom.nasa.gov/data/realtime/c2/512/latest.jpg"},
                {"id": "c3", "name": "SOHO LASCO C3", "url": "https://soho.nascom.nasa.gov/data/realtime/c3/512/latest.jpg"},
            ],
            "suvi": {"name": "GOES SUVI 195 Å", "url": "https://services.swpc.noaa.gov/images/animations/suvi/primary/195/latest.png"},
        },
        "animations": {
            "ovation_north": frames(&on, 288), "ovation_south": frames(&os, 288),
            "lasco_c2": frames(&c2, 96), "lasco_c3": frames(&c3, 96), "enlil": frames(&enlil, 200),
        },
        "errors": errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_and_classes() {
        let v = json!([["time_tag", "density", "speed", "temperature"], ["2026-10-12 11:00:00.000", "4.1", "432.5", "90000"], ["2026-10-12 11:01:00.000", null, "440.0", "1"]]);
        let t = table(&v);
        assert_eq!(latest(&t, "speed").unwrap().1, 440.0);
        assert_eq!(latest(&t, "density").unwrap().1, 4.1);
        let v2 = json!([{"time_tag": "2026-10-12T11:00:00", "bz_gsm": -5.5}]);
        assert_eq!(latest(&table(&v2), "bz_gsm").unwrap().1, -5.5);
        assert_eq!(xray_class(2.3e-6), "C2.3");
        assert_eq!(xray_class(1.2e-4), "X1.2");
        assert_eq!(xray_class(5.0e-8), "A5.0");
        let f = frames(&json!([{"url": "/images/animations/ovation/north/a.jpg", "time_tag": "2026-10-07T13:50:00Z"}]), 10);
        assert_eq!(f[0]["url"], "https://services.swpc.noaa.gov/images/animations/ovation/north/a.jpg");
        assert_eq!(name_time("/images/animations/lasco-c3/20261011_1442_c3_512.jpg").unwrap(), "2026-10-11T14:42:00Z");
        assert_eq!(name_time("/images/animations/enlil/enlil_com2_58554_20261007T180000.jpg").unwrap(), "2026-10-07T18:00:00Z");
        assert_eq!(frames(&json!([{"url": "/x/20261011_1442_c3_512.jpg"}]), 5)[0]["time"], "2026-10-11T14:42:00Z");
    }
}
