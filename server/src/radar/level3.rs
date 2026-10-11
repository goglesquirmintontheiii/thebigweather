//! NEXRAD / TDWR Level III decoder for radial products.
//!
//! Supports packet 16 (digital radial) and packet 0xAF1F (run-length radial),
//! bzip2-compressed symbology blocks, and the threshold encodings used by the
//! common base, dual-pol, derived and TDWR products.

use anyhow::{bail, Context, Result};
use std::io::Read;

fn be_u16(b: &[u8], o: usize) -> u16 {
    u16::from_be_bytes([b[o], b[o + 1]])
}
fn be_i16(b: &[u8], o: usize) -> i16 {
    i16::from_be_bytes([b[o], b[o + 1]])
}
fn be_u32(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn be_i32(b: &[u8], o: usize) -> i32 {
    i32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn f32_from_hw(b: &[u8], o: usize) -> f32 {
    f32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// Special value markers inside a lookup table.
pub const LUT_NODATA: f32 = f32::NAN;
pub const LUT_RF: f32 = -9999.0;

#[derive(Debug, Clone)]
pub struct L3Radial {
    pub azimuth: f32,
    pub width: f32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Product {
    pub code: i16,
    pub awips: String,
    pub site: String,
    pub lat: f32,
    pub lon: f32,
    pub height_m: f32,
    pub vcp: u16,
    pub elevation: f32,
    pub elev_num: u16,
    pub scan_time_ms: i64,
    pub gen_time_ms: i64,
    pub first_gate_m: f32,
    pub gate_m: f32,
    pub ngates: usize,
    pub radials: Vec<L3Radial>,
    /// raw byte -> physical value (NaN = no data, LUT_RF = range folded)
    pub lut: Vec<f32>,
    pub units: &'static str,
}

fn nexrad_time(julian: u16, secs: u32) -> i64 {
    (julian as i64 - 1) * 86_400_000 + secs as i64 * 1000
}

/// Products whose packet range scale isn't a gate size; nominal max range in km.
fn nominal_range_km(code: i16) -> f32 {
    match code {
        94 | 153 | 134 | 135 | 19 | 20 | 37 | 38 | 57 | 186 => 460.0,
        99 | 154 | 159 | 161 | 163 | 165 | 27 | 56 | 32 => 300.0,
        169..=177 | 138 | 78..=81 | 31 => 230.0,
        180 | 182 | 181 | 183 | 185 | 187 => 90.0,
        _ => 230.0,
    }
}

/// Elevation-based products (base tilts) read the angle from p3.
fn has_elevation(code: i16) -> bool {
    matches!(code, 19 | 20 | 27 | 30 | 32 | 56 | 94 | 99 | 153 | 154 | 159 | 161 | 163 | 165 | 177 | 180 | 181 | 182 | 183 | 185 | 186 | 187)
}

fn units_for(code: i16) -> &'static str {
    match code {
        19 | 20 | 37 | 38 | 94 | 153 | 180 | 181 | 186 | 187 => "dBZ",
        27 | 99 | 154 | 182 | 183 => "m/s",
        56 => "m/s",
        30 | 185 => "m/s",
        159 => "dB",
        161 => "",
        163 => "deg/km",
        165 | 177 => "class",
        134 => "kg/m2",
        135 => "kft",
        169 | 170 | 171 | 172 | 173 | 174 | 175 | 78 | 79 | 80 | 138 => "in",
        _ => "",
    }
}

/// Decode a 16-level threshold halfword (legacy products, packet AF1F).
fn legacy_threshold(hw: u16) -> f32 {
    if hw & 0x8000 != 0 {
        // special: 1 = TH (below threshold), 2 = ND, 3 = RF
        return if hw & 0xff == 3 { LUT_RF } else { LUT_NODATA };
    }
    let mut v = (hw & 0xff) as f32;
    if hw & 0x2000 != 0 {
        v /= 10.0;
    }
    if hw & 0x1000 != 0 {
        v /= 20.0;
    }
    if hw & 0x4000 != 0 {
        v /= 100.0;
    }
    if hw & 0x0100 != 0 {
        v = -v;
    }
    v
}

fn build_lut(code: i16, th: &[u8], pdb_p: &[i16; 11]) -> Vec<f32> {
    let hw = |i: usize| be_u16(th, i * 2);
    let hwi = |i: usize| be_i16(th, i * 2);
    let fl = |i: usize| f32_from_hw(th, i * 2);
    let mut lut = vec![LUT_NODATA; 256];
    match code {
        // min / increment / levels, raw 0 = below threshold, 1 = range folded
        94 | 99 | 153 | 154 | 180 | 182 | 186 | 181 | 183 | 187 => {
            let min = hwi(0) as f32 / 10.0;
            let inc = hwi(1) as f32 / 10.0;
            let n = (hw(2) as usize).clamp(2, 256);
            for (i, slot) in lut.iter_mut().enumerate().take(n).skip(2) {
                *slot = min + (i as f32 - 2.0) * inc;
            }
            lut[1] = LUT_RF;
        }
        // scale / offset floats
        159 | 161 | 163 | 169 | 170 | 171 | 172 | 173 | 174 | 175 | 176 => {
            let scale = fl(0);
            let offset = fl(2);
            let leading = if matches!(code, 159 | 161 | 163) { 2 } else { 1 };
            if scale != 0.0 {
                for (i, slot) in lut.iter_mut().enumerate().skip(leading) {
                    let mut v = (i as f32 - offset) / scale;
                    if matches!(code, 169 | 170 | 171 | 172 | 173 | 174 | 175) {
                        // accumulation products are in hundredths of an inch
                        v /= 100.0;
                    }
                    *slot = v;
                }
            }
            if leading == 2 {
                lut[1] = LUT_RF;
            }
        }
        165 | 177 => {
            // hydrometeor classification codes
            for (i, slot) in lut.iter_mut().enumerate() {
                if i >= 10 && i % 10 == 0 && i <= 150 {
                    *slot = (i / 10) as f32;
                }
            }
            lut[150] = LUT_RF;
        }
        134 => {
            let lin_scale = fl(0);
            let lin_off = fl(2);
            let log_start = hw(4) as usize;
            let log_scale = f32_from_hw(th, 10);
            let log_off = f32_from_hw(th, 14);
            for (i, slot) in lut.iter_mut().enumerate().skip(2) {
                *slot = if i < log_start {
                    (i as f32 - lin_off) / lin_scale
                } else {
                    ((i as f32 - log_off) / log_scale).exp()
                };
            }
        }
        135 => {
            let mask = hw(0) as usize;
            let scale = hw(1) as f32;
            let offset = hw(2) as f32;
            for (i, slot) in lut.iter_mut().enumerate().skip(2) {
                if scale != 0.0 {
                    *slot = (((i & mask) as f32) - offset) / scale;
                }
            }
        }
        138 => {
            // storm total style: min/inc hundredths
            let min = hwi(0) as f32 / 100.0;
            let inc = hwi(1) as f32 / 100.0;
            for (i, slot) in lut.iter_mut().enumerate().skip(1) {
                *slot = min + (i as f32 - 1.0) * inc;
            }
        }
        _ => {
            // 16-level legacy products
            for (i, slot) in lut.iter_mut().enumerate().take(16) {
                *slot = legacy_threshold(hw(i));
            }
            if code == 56 {
                // storm-relative velocity thresholds are in knots
                for v in lut.iter_mut().take(16) {
                    if v.is_finite() && *v != LUT_RF {
                        *v *= 0.514_444;
                    }
                }
            }
        }
    }
    let _ = pdb_p;
    lut
}

pub fn decode(file: &[u8]) -> Result<Product> {
    // Skip WMO + AWIPS header lines if present.
    let mut pos = 0;
    let mut awips = String::new();
    if file.len() > 30 && file[0].is_ascii_uppercase() {
        let mut lines = 0;
        let mut line_start = 0;
        let mut i = 0;
        while i < file.len().min(64) && lines < 2 {
            if file[i] == b'\n' {
                let line = String::from_utf8_lossy(&file[line_start..i]).trim().to_string();
                if lines == 1 {
                    awips = line;
                }
                lines += 1;
                line_start = i + 1;
            }
            i += 1;
        }
        pos = line_start;
    }
    let b = &file[pos..];
    if b.len() < 120 {
        bail!("file too short");
    }
    // Message header (18 bytes) + Product Description Block
    let code = be_i16(b, 0);
    let p = &b[18..];
    if be_i16(p, 0) != -1 {
        bail!("missing PDB divider");
    }
    let lat = be_i32(p, 2) as f32 / 1000.0;
    let lon = be_i32(p, 6) as f32 / 1000.0;
    let height_m = be_i16(p, 10) as f32 * 0.3048;
    let pcode = be_i16(p, 12);
    let vcp = be_u16(p, 16);
    let scan_time_ms = nexrad_time(be_u16(p, 22), be_u32(p, 24));
    let gen_time_ms = nexrad_time(be_u16(p, 28), be_u32(p, 30));
    let mut params = [0i16; 11];
    params[1] = be_i16(p, 34);
    params[2] = be_i16(p, 36);
    let elev_num = be_u16(p, 38);
    params[3] = be_i16(p, 40);
    let th = &p[42..74];
    for k in 4..=10 {
        params[k] = be_i16(p, 74 + (k - 4) * 2);
    }
    let sym_off = be_u32(p, 90) as usize * 2;
    let code = if pcode != 0 { pcode } else { code };
    let elevation = if has_elevation(code) { params[3] as f32 / 10.0 } else { 0.0 };

    // Symbology block (possibly bzip2 compressed after the PDB)
    let sym_owned;
    let sym: &[u8] = if params[8] == 1 {
        let mut out = Vec::new();
        bzip2::read::BzDecoder::new(&b[120..])
            .read_to_end(&mut out)
            .context("bzip2 symbology")?;
        sym_owned = out;
        &sym_owned
    } else {
        if sym_off == 0 || sym_off >= b.len() {
            bail!("no symbology block");
        }
        &b[sym_off..]
    };
    if sym.len() < 16 || be_i16(sym, 0) != -1 {
        bail!("bad symbology header");
    }
    // layer: divider at 10, length at 12, packets from 16
    let pk = &sym[16..];
    let pcode16 = be_u16(pk, 0);
    let first_bin = be_i16(pk, 2) as f32;
    let nbins = be_i16(pk, 4) as usize;
    let range_scale = be_i16(pk, 10) as f32;
    let nrad = be_i16(pk, 12) as usize;
    let mut radials = Vec::with_capacity(nrad);
    let mut q = 14;
    match pcode16 {
        16 => {
            for _ in 0..nrad {
                if q + 6 > pk.len() {
                    break;
                }
                let nbytes = be_i16(pk, q) as usize;
                let az = be_i16(pk, q + 2) as f32 / 10.0;
                let w = be_i16(pk, q + 4) as f32 / 10.0;
                q += 6;
                if q + nbytes > pk.len() {
                    break;
                }
                let mut d = pk[q..q + nbytes.min(nbins)].to_vec();
                d.resize(nbins, 0);
                radials.push(L3Radial { azimuth: az, width: w, data: d });
                q += nbytes + (nbytes & 1);
            }
        }
        0xAF1F => {
            for _ in 0..nrad {
                if q + 6 > pk.len() {
                    break;
                }
                let nhw = be_i16(pk, q) as usize;
                let az = be_i16(pk, q + 2) as f32 / 10.0;
                let w = be_i16(pk, q + 4) as f32 / 10.0;
                q += 6;
                let end = (q + nhw * 2).min(pk.len());
                let mut d = Vec::with_capacity(nbins);
                for &byte in &pk[q..end] {
                    let run = (byte >> 4) as usize;
                    let val = byte & 0x0f;
                    for _ in 0..run {
                        d.push(val);
                    }
                }
                d.resize(nbins, 0);
                radials.push(L3Radial { azimuth: az, width: w, data: d });
                q = end;
            }
        }
        other => bail!("unsupported packet code {other:#x}"),
    }
    let mut gate_m = if range_scale == 999.0 { 1000.0 } else { range_scale };
    if gate_m <= 0.0 || gate_m * nbins as f32 > 600_000.0 || gate_m < 50.0 {
        gate_m = nominal_range_km(code) * 1000.0 / nbins.max(1) as f32;
    }
    let site = awips.get(3..).unwrap_or("").to_string();
    Ok(Product {
        code,
        awips,
        site,
        lat,
        lon,
        height_m,
        vcp,
        elevation,
        elev_num,
        scan_time_ms,
        gen_time_ms,
        // gate centers (bins start at the radar)
        first_gate_m: (first_bin + 0.5) * gate_m,
        gate_m,
        ngates: nbins,
        radials,
        lut: build_lut(code, th, &params),
        units: units_for(code),
    })
}

#[cfg(test)]
mod tests {
    fn testdata(p: &str) -> Option<Vec<u8>> {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        std::fs::read(format!("{base}/{p}")).ok()
    }

    #[test]
    fn n0q_reflectivity() {
        let Some(b) = testdata("level3/SDUS53 KLOT 150709") else { return };
        let p = super::decode(&b).unwrap();
        assert_eq!(p.code, 94);
        assert_eq!(p.radials.len(), 360);
        assert!((p.lat - 41.604).abs() < 0.01);
        assert_eq!(p.lut[2], -32.0);
    }

    #[test]
    fn hydro_class() {
        let Some(b) = testdata("level3/LOT_N0H_2021_01_31_11_06_30") else { return };
        let p = super::decode(&b).unwrap();
        assert_eq!(p.code, 165);
        assert_eq!(p.gate_m, 250.0);
        assert_eq!(p.lut[60], 6.0);
    }
}
