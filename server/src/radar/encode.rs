//! Compact sweep format ("TBWS") sent to clients. Little-endian.
//!
//! ```text
//! 0   "TBWS"            magic
//! 4   u16 version (1)
//! 6   u8  word size (1|2 bytes per gate)
//! 7   u8  flags  bit0 = sweep complete, bit1 = has LUT
//! 8   u16 radials, 10 u16 gates
//! 12  f32 first gate (m), 16 f32 gate spacing (m)
//! 20  f32 scale, 24 f32 offset      value = (raw - offset) / scale (16-bit data)
//! 28  f32 elevation (deg)
//! 32  f64 start ms, 40 f64 end ms
//! 48  f32 lat, 52 f32 lon, 56 f32 height (m), 60 f32 nyquist (m/s)
//! 64  [u8; 8] product name
//! 72  u16 vcp, 74 u16 LUT length, 76 u32 reserved
//! 80  f32[radials] azimuth (center), f32[radials] width
//!     f32[lut] LUT (raw -> value, NaN = no data, -9999 = range folded)
//!     data: radials * gates * word size
//! ```
//! raw 0 is always "no data"; raw 1 is "range folded" for Level II.

use super::level2::{Moment, Sweep, Volume};
use super::level3::Product;

pub const HEADER_LEN: usize = 80;

pub struct Encoded {
    pub bytes: Vec<u8>,
}

#[allow(clippy::too_many_arguments)]
fn header(
    out: &mut Vec<u8>,
    word: u8,
    flags: u8,
    nrad: usize,
    ngates: usize,
    first: f32,
    gate: f32,
    scale: f32,
    offset: f32,
    elev: f32,
    t0: i64,
    t1: i64,
    lat: f32,
    lon: f32,
    h: f32,
    nyq: f32,
    name: &str,
    vcp: u16,
    lut_len: usize,
) {
    out.extend_from_slice(b"TBWS");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.push(word);
    out.push(flags);
    out.extend_from_slice(&(nrad as u16).to_le_bytes());
    out.extend_from_slice(&(ngates as u16).to_le_bytes());
    for v in [first, gate, scale, offset, elev] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&(t0 as f64).to_le_bytes());
    out.extend_from_slice(&(t1 as f64).to_le_bytes());
    for v in [lat, lon, h, nyq] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    let mut nm = [0u8; 8];
    for (i, c) in name.bytes().take(8).enumerate() {
        nm[i] = c;
    }
    out.extend_from_slice(&nm);
    out.extend_from_slice(&vcp.to_le_bytes());
    out.extend_from_slice(&(lut_len as u16).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    debug_assert_eq!(out.len(), HEADER_LEN);
}

/// Encode one moment of a Level II sweep.
pub fn encode_l2(vol: &Volume, sweep: &Sweep, m: Moment) -> Option<Encoded> {
    encode_l2_named(vol, sweep, m, m.code())
}

/// [`encode_l2`] with an explicit product name in the header (derived products).
pub fn encode_l2_named(vol: &Volume, sweep: &Sweep, m: Moment, name: &str) -> Option<Encoded> {
    let mut rads: Vec<_> = sweep
        .radials
        .iter()
        .filter_map(|r| r.moment(m).map(|d| (r, d)))
        .collect();
    if rads.is_empty() {
        return None;
    }
    rads.sort_by(|a, b| a.0.azimuth.partial_cmp(&b.0.azimuth).unwrap_or(std::cmp::Ordering::Equal));
    let ngates = rads.iter().map(|(_, d)| d.ngates as usize).max().unwrap_or(0);
    let first = rads[0].1;
    let word: u8 = if first.word_size == 16 { 2 } else { 1 };
    let nrad = rads.len();
    let lut_len = if word == 1 { 256 } else { 0 };
    let mut flags = 0u8;
    if sweep.complete {
        flags |= 1;
    }
    if lut_len > 0 {
        flags |= 2;
    }
    let nyq = rads.iter().map(|(r, _)| r.nyquist).fold(0.0f32, f32::max);
    let mut out = Vec::with_capacity(HEADER_LEN + nrad * 8 + lut_len * 4 + nrad * ngates * word as usize);
    header(
        &mut out,
        word,
        flags,
        nrad,
        ngates,
        first.first_gate_m,
        first.gate_m,
        first.scale,
        first.offset,
        sweep.elevation(),
        sweep.start_ms(),
        sweep.end_ms(),
        vol.lat,
        vol.lon,
        vol.height_m,
        nyq,
        name,
        vol.vcp,
        lut_len,
    );
    for (r, _) in &rads {
        out.extend_from_slice(&r.azimuth.to_le_bytes());
    }
    for (r, _) in &rads {
        out.extend_from_slice(&r.az_spacing.to_le_bytes());
    }
    if lut_len > 0 {
        for raw in 0..256u32 {
            let v = match raw {
                0 => f32::NAN,
                1 => -9999.0,
                _ => (raw as f32 - first.offset) / first.scale,
            };
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    for (_, d) in &rads {
        let n = d.ngates as usize;
        if word == 1 {
            out.extend_from_slice(&d.data[..n]);
            out.resize(out.len() + (ngates - n), 0);
        } else {
            for g in 0..n {
                let v = d.raw(g);
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.resize(out.len() + (ngates - n) * 2, 0);
        }
    }
    Some(Encoded { bytes: out })
}

pub fn encode_l3(p: &Product, name: &str) -> Encoded {
    let mut rads: Vec<_> = p.radials.iter().collect();
    rads.sort_by(|a, b| a.azimuth.partial_cmp(&b.azimuth).unwrap_or(std::cmp::Ordering::Equal));
    let nrad = rads.len();
    let ngates = p.ngates;
    let mut out = Vec::with_capacity(HEADER_LEN + nrad * 8 + 1024 + nrad * ngates);
    header(
        &mut out,
        1,
        3,
        nrad,
        ngates,
        p.first_gate_m,
        p.gate_m,
        1.0,
        0.0,
        p.elevation,
        p.scan_time_ms,
        p.scan_time_ms,
        p.lat,
        p.lon,
        p.height_m,
        0.0,
        name,
        p.vcp,
        256,
    );
    for r in &rads {
        // L3 azimuths are radial start angles; convert to centers
        let c = (r.azimuth + r.width / 2.0).rem_euclid(360.0);
        out.extend_from_slice(&c.to_le_bytes());
    }
    for r in &rads {
        out.extend_from_slice(&r.width.to_le_bytes());
    }
    for v in &p.lut {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for r in &rads {
        out.extend_from_slice(&r.data[..ngates.min(r.data.len())]);
        if r.data.len() < ngates {
            out.resize(out.len() + ngates - r.data.len(), 0);
        }
    }
    Encoded { bytes: out }
}

pub fn zstd(bytes: &[u8]) -> Vec<u8> {
    zstd::bulk::compress(bytes, 3).unwrap_or_else(|_| bytes.to_vec())
}
