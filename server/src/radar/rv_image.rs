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

/// A picture rather than a volume file.
pub fn is_picture(b: &[u8]) -> bool {
    b.starts_with(&[0x89, b'P', b'N', b'G']) || b.starts_with(b"GIF8") || b.starts_with(&[0xff, 0xd8, 0xff])
}

/// RGB rows of a picture, and whether the format kept colours exactly.
fn read_rgb(b: &[u8]) -> Result<(usize, usize, Vec<u8>)> {
    if b.starts_with(b"GIF8") {
        return read_gif(b);
    }
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        return read_jpeg(b);
    }
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

fn read_gif(b: &[u8]) -> Result<(usize, usize, Vec<u8>)> {
    let mut o = gif::DecodeOptions::new();
    o.set_color_output(gif::ColorOutput::RGBA);
    let mut d = o.read_info(std::io::Cursor::new(b))?;
    let (w, h) = (d.width() as usize, d.height() as usize);
    let mut rgb = None;
    while let Some(f) = d.read_next_frame()? {
        if f.width as usize == w && f.height as usize == h {
            rgb = Some(f.buffer.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect::<Vec<u8>>());
        }
    }
    Ok((w, h, rgb.ok_or_else(|| anyhow!("gif has no full frame"))?))
}

fn read_jpeg(b: &[u8]) -> Result<(usize, usize, Vec<u8>)> {
    let mut d = jpeg_decoder::Decoder::new(std::io::Cursor::new(b));
    let px = d.decode()?;
    let i = d.info().ok_or_else(|| anyhow!("jpeg without a header"))?;
    if i.pixel_format != jpeg_decoder::PixelFormat::RGB24 {
        bail!("unexpected jpeg colours");
    }
    Ok((i.width as usize, i.height as usize, px))
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

/// One picture -> dBZ per pixel of the panel (NaN = no echo). `lone`: fewest echo neighbours an
/// echo pixel needs to stay (more for JPEG, where stray pixels drift close to a band).
fn echoes(rgb: &[u8], w: usize, pw: usize, h: usize, cx: i32, cy: i32, cross: i32, lone: usize, classify: &dyn Fn([u8; 3]) -> Option<f32>) -> Vec<f32> {
    let mut v = vec![f32::NAN; pw * h];
    for y in 0..h {
        for x in 0..pw {
            if (x as i32 - cx).abs() <= cross && (y as i32 - cy).abs() <= cross {
                continue;
            }
            let i = (y * w + x) * 3;
            if let Some(d) = classify([rgb[i], rgb[i + 1], rgb[i + 2]]) {
                v[y * pw + x] = d;
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
            } else if !v[k].is_nan() && around.len() < lone {
                out[k] = f32::NAN;
            }
        }
    }
    out
}

/// Polar composite sweep from a CMA picture.
pub fn decode(site: &str, bytes: &[u8], time_ms: i64, lat: f64, lon: f64) -> Result<Volume> {
    let (w, h, rgb) = read_rgb(bytes)?;
    let (pw, cx, cy, km, km_px, v) = match (w, h) {
        (920, 730) | (924, 734) => {
            let pw = if w == 920 { 730 } else { 734 };
            let km = range_km(&rgb, w, pw)?;
            let (cx, cy) = (pw as f64 / 2.0 - 1.5, h as f64 / 2.0 - 1.0);
            let v = echoes(&rgb, w, pw, h, cx as i32, cy as i32, CROSS_R, 1, &|c| band(c).map(|d| d + 2.5)); // middle of the 5 dBZ band
            (pw, cx, cy, km, km / (pw as f64 / 2.0) * SCALE, v)
        }
        (720, 720) => {
            // Mauritius: no legend, white background, north-up, lines crossing on the radar
            let dark = (0..720).filter(|y| { let i = (y * w + 360) * 3; (rgb[i] as u32 + rgb[i + 1] as u32 + rgb[i + 2] as u32) < 300 }).count();
            if dark < 500 {
                bail!("picture layout changed (no crossing lines)");
            }
            (720, 360.0, 360.0, 450.0, 1.25, echoes(&rgb, w, 720, 720, 360, 360, 4, 1, &hue_scale))
        }
        (880, 720) => {
            let r = rainbow(&rgb, w, bytes)?;
            (720, 360.0, 359.0, r.0, r.0 / 360.0, r.1)
        }
        _ => bail!("picture layout changed ({w}x{h})"),
    };
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

/// An ordered colour scale with no legend (cyan -> green -> yellow -> red): an approximate dBZ.
fn hue_scale(c: [u8; 3]) -> Option<f32> {
    const SCALE: [(f32, f32); 5] = [(190.0, 10.0), (144.0, 25.0), (85.0, 35.0), (45.0, 45.0), (0.0, 55.0)];
    let (r, g, b) = (c[0] as f32, c[1] as f32, c[2] as f32);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    if max < 90.0 || (max - min) / max < 0.3 {
        return None; // white, greys, dark lines
    }
    let d = max - min;
    let h = 60.0 * if max == r { ((g - b) / d).rem_euclid(6.0) } else if max == g { (b - r) / d + 2.0 } else { (r - g) / d + 4.0 };
    if h > 200.0 {
        return None; // the navy rings and labels
    }
    let h = h.min(190.0);
    SCALE.windows(2).find(|w| h <= w[0].0 && h >= w[1].0).map(|w| w[0].1 + (w[0].0 - h) / (w[0].0 - w[1].0) * (w[1].1 - w[0].1))
}

// ---------- 880x720 "Rainbow" radar pictures (Turkey, India) ----------

/// "Max Range" text as drawn (1 bit per pixel) -> km
const RB_RANGE: [(u64, f64); 4] = [(7952650576700358865, 500.0), (11195017397843920462, 150.0), (2334592486488087884, 370.0), (11317515062125981279, 350.0)];
/// Numbers beside the legend -> bottom of each band, lowest first
const RB_LEGEND: [(u64, &[f32]); 6] = [
    (17860165333994646170, &[20.0, 22.7, 25.3, 28.0, 30.7, 33.3, 36.0, 38.7, 41.3, 44.0, 46.7, 49.3, 52.0, 54.7, 57.3]),
    (10854256192995699901, &[0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 34.0, 38.0, 42.0, 46.0, 50.0, 54.0, 58.0, 62.0]),
    (18004293053878981906, &[20.0, 22.7, 25.4, 28.1, 30.8, 33.5, 36.2, 38.9, 41.6, 44.3, 47.0, 49.7, 52.4, 55.1, 57.8]),
    (15761734307561835078, &[20.0, 23.0, 26.0, 29.0, 32.0, 35.0, 38.0, 41.0, 44.0, 47.0, 50.0, 53.0, 56.0, 59.0, 62.0, 65.0]),
    (8467982950681784704, &[0.0, 4.0, 8.0, 12.0, 16.0, 20.0, 24.0, 28.0, 32.0, 36.0, 40.0, 44.0, 48.0, 52.0, 56.0]),
    (4053654812743431091, &[2.0, 7.0, 12.0, 18.0, 21.0, 23.0, 28.0, 34.0, 37.0, 39.0, 44.0, 50.0, 53.0, 55.0, 60.0, 66.0]),
];
const RB_DARK: u32 = 380;
const RB_DE: f32 = 14.0;
const RB_CHROMA: f32 = 25.0;

fn lab(c: [f32; 3]) -> [f32; 3] {
    let f = |v: f32| {
        let v = v / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (f(c[0]), f(c[1]), f(c[2]));
    let g3 = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (x, y, z) = (g3((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505), g3(0.2126 * r + 0.7152 * g + 0.0722 * b), g3((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089));
    [116.0 * y - 16.0, 500.0 * (x - y), 200.0 * (y - z)]
}

/// Bit pattern of a box of the side panel, hashed.
fn box_hash(rgb: &[u8], w: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> u64 {
    fnv((y0..y1).flat_map(|y| {
        (x0..x1).map(move |x| {
            let i = (y * w + x) * 3;
            ((rgb[i] as u32 + rgb[i + 1] as u32 + rgb[i + 2] as u32) < RB_DARK) as u8
        })
    }))
}

/// km and dBZ per pixel. The legend is read from each picture: GIF palettes differ frame to frame.
fn rainbow(rgb: &[u8], w: usize, raw: &[u8]) -> Result<(f64, Vec<f32>)> {
    let km = RB_RANGE.iter().find(|(k, _)| *k == box_hash(rgb, w, 722, 208, 878, 222)).map(|x| x.1).ok_or_else(|| anyhow!("picture layout changed (unknown range text)"))?;
    let lows = RB_LEGEND.iter().find(|(k, _)| *k == box_hash(rgb, w, 742, 374, 778, 616)).map(|x| x.1).ok_or_else(|| anyhow!("picture layout changed (unknown legend)"))?;
    let step = if lows.len() == 16 { 15 } else { 16 };
    let bands: Vec<([f32; 3], f32)> = lows
        .iter()
        .enumerate()
        .map(|(k, low)| {
            let cy = 616 - 8 - step * k;
            let mut sum = [0f32; 3];
            for y in cy - 3..cy + 4 {
                for x in 782..798 {
                    let i = (y * w + x) * 3;
                    (0..3).for_each(|c| sum[c] += rgb[i + c] as f32);
                }
            }
            let hi = lows.get(k + 1).copied().unwrap_or(low + (low - lows[k.max(1) - 1]));
            (sum.map(|v| v / (7.0 * 16.0)), (low + hi) / 2.0)
        })
        .collect();
    if raw.starts_with(b"GIF8") {
        let exact: Vec<([u8; 3], f32)> = bands.iter().map(|(c, v)| (c.map(|x| x.round() as u8), *v)).collect();
        let classify = move |c: [u8; 3]| exact.iter().find(|(e, _)| *e == c).map(|(_, v)| *v);
        return Ok((km, echoes(rgb, w, 720, 720, 360, 359, 4, 1, &classify)));
    }
    // JPEG: nearest band in Lab; far from every band, or too grey to be one, is map
    let lbands: Vec<([f32; 3], f32)> = bands.iter().map(|(c, v)| (lab(*c), *v)).collect();
    let classify = move |c: [u8; 3]| {
        let l = lab(c.map(|x| x as f32));
        if l[1].hypot(l[2]) <= RB_CHROMA {
            return None;
        }
        let dist = |b: &[f32; 3]| ((l[0] - b[0]).powi(2) + (l[1] - b[1]).powi(2) + (l[2] - b[2]).powi(2)).sqrt();
        lbands.iter().map(|(b, v)| (dist(b), *v)).min_by(|a, b| a.0.total_cmp(&b.0)).filter(|(d, _)| *d < RB_DE).map(|(_, v)| v)
    };
    Ok((km, echoes(rgb, w, 720, 720, 360, 359, 4, 2, &classify)))
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
    fn approximate_scale_runs_from_cyan_to_red() {
        let cyan = hue_scale([167, 255, 255]).unwrap();
        let green = hue_scale([0, 150, 60]).unwrap();
        let orange = hue_scale([208, 155, 0]).unwrap();
        let red = hue_scale([230, 10, 10]).unwrap();
        assert!(cyan < green && green < orange && orange < red, "{cyan} {green} {orange} {red}");
        assert_eq!(hue_scale([0, 0, 100]), None, "ring lines");
        assert_eq!(hue_scale([255, 255, 255]), None);
    }

    #[test]
    fn jpeg_noise_near_a_band_is_kept_and_map_colours_are_not() {
        let band = lab([0.0, 200.0, 0.0]);
        let near = lab([12.0, 190.0, 14.0]);
        let d = ((band[0] - near[0]).powi(2) + (band[1] - near[1]).powi(2) + (band[2] - near[2]).powi(2)).sqrt();
        assert!(d < RB_DE, "{d}");
        let cream = lab([253.0, 253.0, 220.0]);
        assert!(cream[1].hypot(cream[2]) < RB_CHROMA, "land colour is too grey to be a band");
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
        let raster = echoes(&rgb, w, pw, h, cx as i32, cy as i32, CROSS_R, 1, &|c| band(c).map(|d| d + 2.5)).iter().filter(|d| !d.is_nan()).count();
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
