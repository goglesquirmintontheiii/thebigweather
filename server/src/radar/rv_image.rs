//! 0.8.4: reflectivity read back out of the CMA radar pictures RainViewer republishes, so Chinese
//! radars work like any other radar (GPU colouring, Inspector, data inspector).
//!
//! The picture is a square map panel, radar at a crosshair near its centre, with a legend column
//! on the right, in a local plane (azimuthal equidistant) north-up. Radar echoes are drawn in
//! exactly 15 flat colours, one per 5 dBZ band; everything else (shaded relief, sea, rivers, borders,
//! names, crosshair) uses other colours and is not an echo. PNG is lossless, so a colour either is
//! a band or isn't. Each picture becomes one polar sweep: a composite, not a tilt.
//!
//! Measured on a full copy of the tree: crosshair 1.5 px left of and 1 px above the panel centre on
//! 206 of 210 sites (the rest are labels crossing it); scale `range / half-panel × 1.015`.

use super::level2::{Moment, MomentData, Radial, Sweep, Volume};
use anyhow::{anyhow, bail, Result};

/// Echo colour -> bottom of its 5 dBZ band. The swatches for 5 and 10 dBZ in the picture's legend
/// are paler than the colours used on the map; these are the ones on the map.
const BANDS: [([u8; 3], f32); 15] = [
    ([0, 0, 239], 0.0),
    ([1, 160, 246], 5.0),
    ([0, 236, 236], 10.0),
    ([109, 250, 61], 15.0),
    ([0, 216, 0], 20.0),
    ([1, 144, 0], 25.0),
    ([255, 255, 0], 30.0),
    ([231, 192, 0], 35.0),
    ([255, 144, 0], 40.0),
    ([255, 0, 0], 45.0),
    ([214, 0, 0], 50.0),
    ([192, 0, 0], 55.0),
    ([255, 0, 240], 60.0),
    ([150, 0, 180], 65.0),
    ([173, 144, 240], 70.0),
];

/// The "data range" text in the side panel, as drawn (FNV-1a of its pixels) -> km.
const RANGES: [(u64, f64); 7] = [
    (RANGE_HASHES[0], 220.0),
    (RANGE_HASHES[1], 256.0),
    (RANGE_HASHES[2], 460.0),
    (RANGE_HASHES[3], 230.0),
    (RANGE_HASHES[4], 287.0),
    (RANGE_HASHES[5], 150.0),
    (RANGE_HASHES[6], 281.0),
];
include!("rv_image_ranges.in");

const SCALE: f64 = 1.015;
const GATE_RAYS: usize = 720;
/// pixels of the crosshair (never echoes, whatever colour they come out as)
const CROSS_R: i32 = 9;

fn band(rgb: [u8; 3]) -> Option<f32> {
    BANDS.iter().find(|(c, _)| *c == rgb).map(|(_, v)| *v)
}

fn fnv(data: impl Iterator<Item = u8>) -> u64 {
    data.fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

pub fn is_png(b: &[u8]) -> bool {
    b.starts_with(&[0x89, b'P', b'N', b'G'])
}

/// RGB rows of a PNG.
fn read_rgb(b: &[u8]) -> Result<(usize, usize, Vec<u8>)> {
    let mut d = png::Decoder::new(std::io::Cursor::new(b));
    d.set_transformations(png::Transformations::normalize_to_color8());
    let mut r = d.read_info()?;
    let mut buf = vec![0; r.output_buffer_size().ok_or_else(|| anyhow!("png too large"))?];
    let i = r.next_frame(&mut buf)?;
    let (w, h) = (i.width as usize, i.height as usize);
    let n = match i.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        c => bail!("unexpected picture type {c:?}"),
    };
    let mut rgb = Vec::with_capacity(w * h * 3);
    for p in buf[..w * h * n].chunks_exact(n) {
        rgb.extend_from_slice(&p[..3]);
    }
    Ok((w, h, rgb))
}

/// Half-panel range text -> km, or an error when the picture isn't one of the known layouts.
fn range_km(rgb: &[u8], w: usize, pw: usize) -> Result<f64> {
    let mut bytes = Vec::with_capacity(28 * 85 * 3);
    for y in 62..90 {
        let s = (y * w + pw + 85) * 3;
        bytes.extend_from_slice(&rgb[s..s + 85 * 3]);
    }
    let h = fnv(bytes.into_iter());
    RANGES.iter().find(|(k, _)| *k == h).map(|(_, km)| *km).ok_or_else(|| anyhow!("picture layout changed (unknown range text)"))
}

/// One picture -> dBZ per pixel of the panel (NaN = no echo).
fn echoes(rgb: &[u8], w: usize, pw: usize, h: usize, cx: i32, cy: i32) -> Vec<f32> {
    let mut v = vec![f32::NAN; pw * h];
    for y in 0..h {
        for x in 0..pw {
            if (x as i32 - cx).abs() <= CROSS_R && (y as i32 - cy).abs() <= CROSS_R {
                continue;
            }
            let i = (y * w + x) * 3;
            if let Some(d) = band([rgb[i], rgb[i + 1], rgb[i + 2]]) {
                v[y * pw + x] = d + 2.5; // middle of the 5 dBZ band
            }
        }
    }
    // lines and names drawn over rain leave gaps: a gap pixel takes the middle value of its
    // neighbours when at least half of them are echo; a lone echo pixel is antialiasing or noise
    let mut out = v.clone();
    let mut around = Vec::with_capacity(8);
    for y in 1..h - 1 {
        for x in 1..pw - 1 {
            around.clear();
            for (dx, dy) in [(-1i32, -1i32), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)] {
                let d = v[(y as i32 + dy) as usize * pw + (x as i32 + dx) as usize];
                if !d.is_nan() {
                    around.push(d);
                }
            }
            let k = y * pw + x;
            if v[k].is_nan() && around.len() >= 4 {
                around.sort_by(|a, b| a.total_cmp(b));
                out[k] = around[around.len() / 2];
            } else if !v[k].is_nan() && around.is_empty() {
                out[k] = f32::NAN;
            }
        }
    }
    out
}

/// Polar composite sweep from a CMA picture.
pub fn decode(site: &str, png_bytes: &[u8], time_ms: i64, lat: f64, lon: f64) -> Result<Volume> {
    let (w, h, rgb) = read_rgb(png_bytes)?;
    let pw = match (w, h) {
        (920, 730) => 730,
        (924, 734) => 734,
        _ => bail!("picture layout changed ({w}x{h})"),
    };
    let km = range_km(&rgb, w, pw)?;
    let (cx, cy) = (pw as f64 / 2.0 - 1.5, h as f64 / 2.0 - 1.0);
    let v = echoes(&rgb, w, pw, h, cx as i32, cy as i32);
    let km_px = km / (pw as f64 / 2.0) * SCALE;
    let gates = (km / km_px).round() as usize;
    let gate_m = (km_px * 1000.0) as f32;
    let (scale, offset) = super::odim::quant(Moment::Ref);
    let radials = (0..GATE_RAYS)
        .map(|i| {
            let az = (i as f64 + 0.5) * 360.0 / GATE_RAYS as f64;
            let (sin, cos) = az.to_radians().sin_cos();
            let data: Vec<u8> = (0..gates)
                .map(|g| {
                    let r = g as f64 + 0.5;
                    let (x, y) = ((cx + r * sin).round(), (cy - r * cos).round());
                    if x < 0.0 || y < 0.0 || x >= pw as f64 || y >= h as f64 {
                        return 0;
                    }
                    let d = v[y as usize * pw + x as usize];
                    if d.is_nan() {
                        0
                    } else {
                        (d * scale + offset).round().clamp(2.0, 255.0) as u8
                    }
                })
                .collect();
            Radial {
                time_ms,
                azimuth: az as f32,
                elevation: 0.5,
                az_spacing: 0.5,
                status: if i == 0 { 0 } else if i + 1 == GATE_RAYS { 2 } else { 1 },
                elev_num: 1,
                nyquist: 0.0,
                moments: vec![MomentData { moment: Moment::Ref, ngates: gates as u16, first_gate_m: gate_m / 2.0, gate_m, word_size: 8, scale, offset, data }],
            }
        })
        .collect();
    Ok(Volume { site: site.to_string(), lat: lat as f32, lon: lon as f32, header_time_ms: time_ms, sweeps: vec![Sweep { elev_num: 1, radials, complete: true }], complete: true, version: "ODIM_H5".into(), ..Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a 924x734 picture: white, the real "256 km" text, echoes painted on top
    fn picture(paint: &[(usize, usize, [u8; 3])]) -> Vec<u8> {
        let (w, h, pw) = (924usize, 734usize, 734usize);
        let mut rgb = vec![255u8; w * h * 3];
        let label = include_bytes!("rv_label_256.rgb");
        for (k, row) in label.chunks_exact(85 * 3).enumerate() {
            let s = ((62 + k) * w + pw + 85) * 3;
            rgb[s..s + 85 * 3].copy_from_slice(row);
        }
        for (x, y, c) in paint {
            rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(c);
        }
        let mut out = vec![];
        {
            let mut e = png::Encoder::new(&mut out, w as u32, h as u32);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().unwrap().write_image_data(&rgb).unwrap();
        }
        out
    }

    fn value(v: &Volume, az: f64, km: f64) -> Option<f32> {
        let s = &v.sweeps[0];
        let r = s.radials.iter().min_by(|a, b| (a.azimuth as f64 - az).abs().total_cmp(&(b.azimuth as f64 - az).abs())).unwrap();
        let m = r.moment(Moment::Ref).unwrap();
        m.value(((km * 1000.0 - m.first_gate_m as f64) / m.gate_m as f64).round() as usize)
    }

    fn blob(cx: usize, cy: usize, c: [u8; 3]) -> Vec<(usize, usize, [u8; 3])> {
        (0..7).flat_map(|i| (0..7).map(move |j| (cx - 3 + i, cy - 3 + j, c))).collect()
    }

    #[test]
    fn colours_become_dbz_at_the_right_place() {
        // the crosshair is at (365.5, 366); 100 px due east, 0.708 km/px at 256 km
        let mut p = blob(466, 366, [255, 0, 0]); // 45-50 dBZ
        p.extend(blob(366, 266, [0, 216, 0])); // north: 20-25 dBZ
        let v = decode("cn9000b", &picture(&p), 1_794_000_000_000, 30.0, 120.0).unwrap();
        assert_eq!(v.sweeps[0].radials.len(), 720);
        let km_px = 256.0 / 367.0 * SCALE;
        assert_eq!(value(&v, 90.0, 100.0 * km_px), Some(47.5));
        assert_eq!(value(&v, 0.0, 100.0 * km_px), Some(22.5));
        assert_eq!(value(&v, 180.0, 100.0 * km_px), None);
    }

    #[test]
    fn basemap_is_not_echo_and_gaps_are_filled() {
        // a river and a sea colour aren't bands
        assert_eq!(band([0, 179, 255]), None);
        assert_eq!(band([179, 230, 255]), None);
        // a one-pixel line through an echo is bridged; a lone pixel is dropped
        let mut p = blob(466, 366, [255, 255, 0]);
        p.retain(|(_, y, _)| *y != 366);
        p.push((300, 500, [255, 0, 0]));
        let v = decode("cn9000b", &picture(&p), 0, 30.0, 120.0).unwrap();
        let km_px = 256.0 / 367.0 * SCALE;
        assert_eq!(value(&v, 90.0, 100.0 * km_px), Some(32.5), "gap under a line");
        let (dx, dy): (f64, f64) = (300.0 - 365.5, 500.0 - 366.0);
        assert_eq!(value(&v, dx.atan2(-dy).to_degrees().rem_euclid(360.0), dx.hypot(dy) * km_px), None, "lone pixel");
    }

    /// Real frame from the tree: `RV_CN_FILE=<png> RV_CN_PX=x,y cargo test real_frame -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_frame() {
        let raw = std::fs::read(std::env::var("RV_CN_FILE").unwrap()).unwrap();
        let (w, h, rgb) = read_rgb(&raw).unwrap();
        let pw = if w == 920 { 730 } else { 734 };
        let v = decode("cn", &raw, 0, 30.0, 120.0).unwrap();
        let km = range_km(&rgb, w, pw).unwrap();
        let km_px = km / (pw as f64 / 2.0) * SCALE;
        let (cx, cy) = (pw as f64 / 2.0 - 1.5, h as f64 / 2.0 - 1.0);
        let px: Vec<f64> = std::env::var("RV_CN_PX").unwrap().split(',').map(|x| x.parse().unwrap()).collect();
        let (dx, dy) = (px[0] - cx, px[1] - cy);
        let i = (px[1] as usize * w + px[0] as usize) * 3;
        println!("range {km} km, {km_px:.3} km/px; pixel {:?} rgb {:?} band {:?}", px, &rgb[i..i + 3], band([rgb[i], rgb[i + 1], rgb[i + 2]]));
        println!("polar value {:?}", value(&v, dx.atan2(-dy).to_degrees().rem_euclid(360.0), dx.hypot(dy) * km_px));
        let raster = echoes(&rgb, w, pw, h, cx as i32, cy as i32).iter().filter(|d| !d.is_nan()).count();
        let rays = v.sweeps[0].radials.iter().map(|r| r.moment(Moment::Ref).unwrap().data.iter().filter(|b| **b > 1).count()).sum::<usize>();
        println!("echo pixels {raster}, polar gates {rays}");
    }

    #[test]
    fn unknown_layouts_fail_instead_of_guessing() {
        let mut p = vec![];
        {
            let mut e = png::Encoder::new(&mut p, 10, 10);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().unwrap().write_image_data(&[255u8; 300]).unwrap();
        }
        assert!(decode("x", &p, 0, 0.0, 0.0).is_err());
        // right size, unknown range text
        let (w, h) = (924usize, 734usize);
        let mut q = vec![];
        {
            let mut e = png::Encoder::new(&mut q, w as u32, h as u32);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().unwrap().write_image_data(&vec![255u8; w * h * 3]).unwrap();
        }
        assert!(decode("x", &q, 0, 0.0, 0.0).is_err());
    }
}
