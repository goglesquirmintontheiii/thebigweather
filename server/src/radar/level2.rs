//! NEXRAD / TDWR Level II (Archive II) decoder.
//!
//! Handles:
//! * full archive files (bzip2 LDM records, uncompressed records, or gzip-wrapped)
//! * real-time chunk files (S/I/E) from the chunks bucket, appended incrementally
//! * Message 31 (modern, dual-pol) and Message 1 (legacy, pre-2008)

use anyhow::{bail, Context, Result};
use std::io::Read;

const VOLUME_HEADER_LEN: usize = 24;
const CTM_LEN: usize = 12;
const MSG_HEADER_LEN: usize = 16;
/// Non-31 messages occupy fixed 2432-byte frames (12 CTM + 2420).
const FIXED_FRAME: usize = 2432;
/// Message 1 data pointers are relative to the start of the message header.
const MSG1_PTR_BASE: usize = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Moment {
    Ref,
    Vel,
    Sw,
    Zdr,
    Phi,
    Rho,
    Cfp,
    /// specific differential phase (°/km); only from ODIM volumes (Level II has no KDP)
    Kdp,
}

impl Moment {
    pub fn from_block_name(n: &[u8]) -> Option<Moment> {
        match n {
            b"REF" => Some(Moment::Ref),
            b"VEL" => Some(Moment::Vel),
            b"SW " | b"SW\0" => Some(Moment::Sw),
            b"ZDR" => Some(Moment::Zdr),
            b"PHI" => Some(Moment::Phi),
            b"RHO" => Some(Moment::Rho),
            b"CFP" => Some(Moment::Cfp),
            _ => None,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Moment::Ref => "REF",
            Moment::Vel => "VEL",
            Moment::Sw => "SW",
            Moment::Zdr => "ZDR",
            Moment::Phi => "PHI",
            Moment::Rho => "RHO",
            Moment::Cfp => "CFP",
            Moment::Kdp => "KDP",
        }
    }
    pub fn parse(s: &str) -> Option<Moment> {
        match s.to_ascii_uppercase().as_str() {
            "REF" => Some(Moment::Ref),
            "VEL" => Some(Moment::Vel),
            "SW" => Some(Moment::Sw),
            "ZDR" => Some(Moment::Zdr),
            "PHI" => Some(Moment::Phi),
            "RHO" | "CC" => Some(Moment::Rho),
            "CFP" => Some(Moment::Cfp),
            "KDP" => Some(Moment::Kdp),
            _ => None,
        }
    }
    pub const ALL: [Moment; 8] = [
        Moment::Ref,
        Moment::Vel,
        Moment::Sw,
        Moment::Zdr,
        Moment::Phi,
        Moment::Rho,
        Moment::Cfp,
        Moment::Kdp,
    ];
}

#[derive(Debug, Clone)]
pub struct MomentData {
    pub moment: Moment,
    pub ngates: u16,
    pub first_gate_m: f32,
    pub gate_m: f32,
    pub word_size: u8,
    pub scale: f32,
    pub offset: f32,
    /// raw gate values; 1 byte per gate (word 8) or 2 bytes big-endian per gate (word 16)
    pub data: Vec<u8>,
}

impl MomentData {
    #[inline]
    pub fn raw(&self, i: usize) -> u16 {
        if self.word_size == 16 {
            u16::from_be_bytes([self.data[i * 2], self.data[i * 2 + 1]])
        } else {
            self.data[i] as u16
        }
    }
    /// Physical value of gate i, None for below-threshold / range-folded.
    pub fn value(&self, i: usize) -> Option<f32> {
        let r = self.raw(i);
        if r <= 1 {
            None
        } else {
            Some((r as f32 - self.offset) / self.scale)
        }
    }
}

#[derive(Debug, Clone)]
pub struct Radial {
    pub time_ms: i64,
    pub azimuth: f32,
    pub elevation: f32,
    pub az_spacing: f32,
    pub status: u8,
    pub elev_num: u8,
    pub nyquist: f32,
    pub moments: Vec<MomentData>,
}

impl Radial {
    pub fn moment(&self, m: Moment) -> Option<&MomentData> {
        self.moments.iter().find(|x| x.moment == m)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Sweep {
    pub elev_num: u8,
    pub radials: Vec<Radial>,
    pub complete: bool,
}

impl Sweep {
    pub fn elevation(&self) -> f32 {
        if self.radials.is_empty() {
            return 0.0;
        }
        // median elevation is robust to the antenna still settling
        let mut v: Vec<f32> = self.radials.iter().map(|r| r.elevation).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    }
    pub fn moments(&self) -> Vec<Moment> {
        let mut out = vec![];
        for m in Moment::ALL {
            if self.radials.iter().take(20).any(|r| r.moment(m).is_some()) {
                out.push(m);
            }
        }
        out
    }
    pub fn start_ms(&self) -> i64 {
        self.radials.first().map(|r| r.time_ms).unwrap_or(0)
    }
    pub fn end_ms(&self) -> i64 {
        self.radials.last().map(|r| r.time_ms).unwrap_or(0)
    }
    pub fn max_gates(&self, m: Moment) -> u16 {
        self.radials
            .iter()
            .filter_map(|r| r.moment(m).map(|d| d.ngates))
            .max()
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Volume {
    pub site: String,
    pub vcp: u16,
    pub lat: f32,
    pub lon: f32,
    pub height_m: f32,
    pub header_time_ms: i64,
    pub sweeps: Vec<Sweep>,
    /// true once an end-of-volume radial (status 4) was seen
    pub complete: bool,
    pub version: String,
}

impl Volume {
    pub fn start_ms(&self) -> i64 {
        self.sweeps
            .first()
            .map(|s| s.start_ms())
            .filter(|t| *t > 0)
            .unwrap_or(self.header_time_ms)
    }
    pub fn end_ms(&self) -> i64 {
        self.sweeps.last().map(|s| s.end_ms()).unwrap_or(self.header_time_ms)
    }
}

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
fn be_f32(b: &[u8], o: usize) -> f32 {
    f32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn nexrad_time(julian: u16, ms: u32) -> i64 {
    (julian as i64 - 1) * 86_400_000 + ms as i64
}

/// Incremental decoder. Feed it an archive file, or chunk files in order.
#[derive(Default)]
pub struct Decoder {
    pub vol: Volume,
    /// added to every timestamp (used by replay to make old data look current)
    pub time_offset_ms: i64,
    cur_elev: Option<u8>,
    /// leftover decompressed bytes from a record that ended mid-message (rare)
    pending: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode a full archive file (possibly gzip-wrapped).
    pub fn decode_file(bytes: &[u8]) -> Result<Volume> {
        let mut d = Decoder::new();
        d.feed(bytes)?;
        d.finish();
        Ok(d.vol)
    }

    pub fn finish(&mut self) {
        if let Some(s) = self.vol.sweeps.last_mut() {
            if !s.radials.is_empty() && self.vol.complete {
                s.complete = true;
            }
        }
    }

    /// Feed one archive file or one chunk (S, I or E).
    pub fn feed(&mut self, bytes: &[u8]) -> Result<()> {
        let owned;
        let mut b = bytes;
        if b.len() > 2 && b[0] == 0x1f && b[1] == 0x8b {
            let mut out = Vec::with_capacity(b.len() * 4);
            flate2::read::MultiGzDecoder::new(b)
                .read_to_end(&mut out)
                .context("gunzip")?;
            owned = out;
            b = &owned;
        }
        if b.len() >= VOLUME_HEADER_LEN && (&b[0..4] == b"AR2V" || &b[0..4] == b"ARCH") {
            self.read_volume_header(&b[..VOLUME_HEADER_LEN]);
            b = &b[VOLUME_HEADER_LEN..];
        }
        if b.is_empty() {
            return Ok(());
        }
        // Compressed LDM records: 4-byte signed size then "BZh".
        if b.len() > 8 && &b[4..7] == b"BZh" {
            // Collect record slices, decompress them in parallel, parse in order.
            let mut recs: Vec<&[u8]> = vec![];
            let mut pos = 0;
            while pos + 4 <= b.len() {
                let size = be_i32(b, pos).unsigned_abs() as usize;
                pos += 4;
                if size == 0 {
                    break;
                }
                if pos + size > b.len() {
                    bail!("truncated LDM record ({} of {} bytes)", b.len() - pos, size);
                }
                recs.push(&b[pos..pos + size]);
                pos += size;
            }
            use rayon::prelude::*;
            let outs: Vec<Result<Vec<u8>>> = recs
                .par_iter()
                .map(|r| {
                    let mut out = Vec::with_capacity(r.len() * 6);
                    bzip2::read::BzDecoder::new(*r)
                        .read_to_end(&mut out)
                        .context("bzip2 record")?;
                    Ok(out)
                })
                .collect();
            for o in outs {
                self.parse_messages(o?);
            }
        } else {
            // Uncompressed message stream
            self.parse_messages(b.to_vec());
        }
        Ok(())
    }

    fn read_volume_header(&mut self, h: &[u8]) {
        self.vol.version = String::from_utf8_lossy(&h[0..9]).trim_end_matches('.').to_string();
        let jd = be_u32(h, 12);
        let ms = be_u32(h, 16);
        if jd > 0 {
            self.vol.header_time_ms = nexrad_time(jd as u16, ms) + self.time_offset_ms;
        }
        let id = String::from_utf8_lossy(&h[20..24])
            .trim_matches(char::from(0))
            .trim()
            .to_string();
        if !id.is_empty() && self.vol.site.is_empty() {
            self.vol.site = id;
        }
    }

    fn parse_messages(&mut self, mut buf: Vec<u8>) {
        if !self.pending.is_empty() {
            let mut p = std::mem::take(&mut self.pending);
            p.extend_from_slice(&buf);
            buf = p;
        }
        let b = &buf[..];
        let mut pos = 0usize;
        while pos + CTM_LEN + MSG_HEADER_LEN <= b.len() {
            let h = pos + CTM_LEN;
            let size_hw = be_u16(b, h) as usize;
            let mtype = b[h + 3];
            if mtype == 31 {
                let len = size_hw * 2; // includes msg header
                if len < MSG_HEADER_LEN {
                    pos += FIXED_FRAME;
                    continue;
                }
                let end = h + len;
                if end > b.len() {
                    self.pending = b[pos..].to_vec();
                    return;
                }
                if let Err(e) = self.msg31(&b[h + MSG_HEADER_LEN..end]) {
                    tracing::debug!("msg31 parse: {e}");
                }
                pos = end;
            } else {
                if pos + FIXED_FRAME > b.len() {
                    // Final partial frame of metadata; ignore unless msg1
                    if mtype == 1 && b.len() - pos >= 1200 {
                        let _ = self.msg1(&b[h..]);
                    }
                    return;
                }
                match mtype {
                    1 => {
                        let _ = self.msg1(&b[h..pos + FIXED_FRAME]);
                    }
                    5 => self.msg5(&b[h + MSG_HEADER_LEN..pos + FIXED_FRAME]),
                    _ => {}
                }
                pos += FIXED_FRAME;
            }
        }
    }

    fn msg5(&mut self, b: &[u8]) {
        if b.len() > 6 && self.vol.vcp == 0 {
            let vcp = be_u16(b, 4);
            if vcp > 0 && vcp < 1000 {
                self.vol.vcp = vcp;
            }
        }
    }

    fn push_radial(&mut self, r: Radial) {
        let new_sweep = match self.cur_elev {
            None => true,
            Some(e) => e != r.elev_num || r.status == 0 || r.status == 3 || r.status == 5,
        };
        if new_sweep {
            if let Some(last) = self.vol.sweeps.last_mut() {
                // the previous sweep ended when a new one starts
                if !last.radials.is_empty() {
                    last.complete = true;
                }
            }
            // If the same elevation number reappears (e.g. SAILS/MESO-SAILS),
            // it's a new sweep anyway.
            self.vol.sweeps.push(Sweep {
                elev_num: r.elev_num,
                radials: Vec::with_capacity(720),
                complete: false,
            });
            self.cur_elev = Some(r.elev_num);
        }
        let status = r.status;
        let s = self.vol.sweeps.last_mut().unwrap();
        s.radials.push(r);
        if status == 2 || status == 4 {
            s.complete = true;
            self.cur_elev = None;
        }
        if status == 4 {
            self.vol.complete = true;
        }
    }

    fn msg31(&mut self, b: &[u8]) -> Result<()> {
        if b.len() < 32 {
            bail!("short msg31");
        }
        let site = String::from_utf8_lossy(&b[0..4]).trim().to_string();
        if self.vol.site.is_empty() && site.chars().all(|c| c.is_ascii_alphanumeric()) {
            self.vol.site = site;
        }
        let time_ms = nexrad_time(be_u16(b, 8), be_u32(b, 4)) + self.time_offset_ms;
        let azimuth = be_f32(b, 12);
        let az_res = b[20];
        let status = b[21];
        let elev_num = b[22];
        let elevation = be_f32(b, 24);
        let nblocks = (be_u16(b, 30) as usize).min(10);
        let mut moments = Vec::with_capacity(6);
        let mut nyquist = 0.0;
        for i in 0..nblocks {
            let ptr = be_u32(b, 32 + i * 4) as usize;
            if ptr == 0 || ptr + 4 > b.len() {
                continue;
            }
            let btype = b[ptr];
            let name = &b[ptr + 1..ptr + 4];
            if btype == b'R' {
                match name {
                    b"VOL" if ptr + 44 <= b.len() => {
                        let lat = be_f32(b, ptr + 8);
                        let lon = be_f32(b, ptr + 12);
                        let h = be_i16(b, ptr + 16) as f32 + be_u16(b, ptr + 18) as f32;
                        if lat.is_finite() && lat.abs() <= 90.0 && lat != 0.0 {
                            self.vol.lat = lat;
                            self.vol.lon = lon;
                            self.vol.height_m = h;
                        }
                        let vcp = be_u16(b, ptr + 40);
                        if vcp > 0 {
                            self.vol.vcp = vcp;
                        }
                    }
                    b"RAD" if ptr + 18 <= b.len() => {
                        nyquist = be_u16(b, ptr + 16) as f32 / 100.0;
                    }
                    _ => {}
                }
            } else if btype == b'D' {
                let Some(m) = Moment::from_block_name(name) else { continue };
                if ptr + 28 > b.len() {
                    continue;
                }
                let ngates = be_u16(b, ptr + 8);
                let first = be_u16(b, ptr + 10) as f32;
                let gate = be_u16(b, ptr + 12) as f32;
                let word = b[ptr + 19];
                let scale = be_f32(b, ptr + 20);
                let offset = be_f32(b, ptr + 24);
                let nbytes = ngates as usize * if word == 16 { 2 } else { 1 };
                let start = ptr + 28;
                if start + nbytes > b.len() || scale == 0.0 {
                    continue;
                }
                moments.push(MomentData {
                    moment: m,
                    ngates,
                    first_gate_m: first,
                    gate_m: gate,
                    word_size: if word == 16 { 16 } else { 8 },
                    scale,
                    offset,
                    data: b[start..start + nbytes].to_vec(),
                });
            }
        }
        self.push_radial(Radial {
            time_ms,
            azimuth,
            elevation,
            az_spacing: if az_res == 1 { 0.5 } else { 1.0 },
            status,
            elev_num,
            nyquist,
            moments,
        });
        Ok(())
    }

    /// Legacy message 1. `b` starts at the message header.
    fn msg1(&mut self, b: &[u8]) -> Result<()> {
        let d = &b[MSG_HEADER_LEN..];
        if d.len() < 100 {
            bail!("short msg1");
        }
        let time_ms = nexrad_time(be_u16(d, 4), be_u32(d, 0)) + self.time_offset_ms;
        let azimuth = be_u16(d, 8) as f32 * 180.0 / 32768.0;
        let status = be_u16(d, 12) as u8;
        let elevation = be_u16(d, 14) as f32 * 180.0 / 32768.0;
        let elev_num = be_u16(d, 16) as u8;
        let first_ref = be_i16(d, 18) as f32;
        let first_dop = be_i16(d, 20) as f32;
        let ref_gate = be_u16(d, 22) as f32;
        let dop_gate = be_u16(d, 24) as f32;
        let nref = be_u16(d, 26);
        let ndop = be_u16(d, 28);
        let ref_ptr = be_u16(d, 36) as usize + MSG1_PTR_BASE;
        let vel_ptr = be_u16(d, 38) as usize + MSG1_PTR_BASE;
        let sw_ptr = be_u16(d, 40) as usize + MSG1_PTR_BASE;
        let vel_res = be_u16(d, 42);
        let vcp = be_u16(d, 44);
        let nyquist = be_u16(d, 62) as f32 / 100.0;
        let nyquist = if nyquist > 0.0 && nyquist < 100.0 { nyquist } else { 0.0 };
        if vcp > 0 && self.vol.vcp == 0 {
            self.vol.vcp = vcp;
        }
        let mut moments = vec![];
        // pointers are relative to the start of the message header
        let mut push = |m: Moment, ptr: usize, n: u16, first: f32, gate: f32, scale: f32, offset: f32| {
            if ptr == 0 || n == 0 || ptr + n as usize > b.len() {
                return;
            }
            moments.push(MomentData {
                moment: m,
                ngates: n,
                first_gate_m: first,
                gate_m: gate,
                word_size: 8,
                scale,
                offset,
                data: b[ptr..ptr + n as usize].to_vec(),
            });
        };
        push(Moment::Ref, ref_ptr, nref, first_ref, ref_gate, 2.0, 66.0);
        let (vs, vo) = if vel_res == 4 { (1.0, 129.0) } else { (2.0, 129.0) };
        push(Moment::Vel, vel_ptr, ndop, first_dop, dop_gate, vs, vo);
        push(Moment::Sw, sw_ptr, ndop, first_dop, dop_gate, 2.0, 129.0);
        self.push_radial(Radial {
            time_ms,
            azimuth,
            elevation,
            az_spacing: 1.0,
            status,
            elev_num,
            nyquist,
            moments,
        });
        Ok(())
    }
}

/// A "tilt" as shown to users: one elevation angle, with the best sweep for each moment.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Tilt {
    pub index: usize,
    pub angle: f32,
    /// moment code -> sweep index within the volume
    pub sweeps: std::collections::BTreeMap<String, usize>,
}

/// Group sweeps into tilts. Split cuts (surveillance + doppler at the same angle) are merged,
/// and repeated low tilts (SAILS) are kept as separate tilts in time order.
pub fn tilts(vol: &Volume) -> Vec<Tilt> {
    let mut out: Vec<Tilt> = vec![];
    for (si, s) in vol.sweeps.iter().enumerate() {
        if s.radials.len() < 10 {
            continue;
        }
        let angle = (s.elevation() * 10.0).round() / 10.0;
        let moms = s.moments();
        // merge into the previous tilt if same angle and it lacks these moments (split cut)
        let mut merged = false;
        if let Some(t) = out.last_mut() {
            if (t.angle - angle).abs() < 0.25 && moms.iter().any(|m| !t.sweeps.contains_key(m.code())) {
                for m in &moms {
                    let k = m.code().to_string();
                    let better = match t.sweeps.get(&k) {
                        None => true,
                        Some(&prev) => vol.sweeps[prev].max_gates(*m) < s.max_gates(*m),
                    };
                    if better && !t.sweeps.contains_key(&k) {
                        t.sweeps.insert(k, si);
                    }
                }
                merged = true;
            }
        }
        if !merged {
            let mut map = std::collections::BTreeMap::new();
            for m in &moms {
                map.insert(m.code().to_string(), si);
            }
            out.push(Tilt {
                index: out.len(),
                angle,
                sweeps: map,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn testdata(p: &str) -> Option<Vec<u8>> {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        std::fs::read(format!("{base}/{p}")).ok()
    }

    #[test]
    fn ktlx_2013() {
        let Some(b) = testdata("level2/KTLX20130420_205120_V06") else { return };
        let v = Decoder::decode_file(&b).unwrap();
        assert_eq!(v.site, "KTLX");
        assert_eq!(v.vcp, 32);
        assert_eq!(v.sweeps.len(), 7);
        assert!((v.lat - 35.333).abs() < 0.05, "lat {}", v.lat);
        let t = tilts(&v);
        assert!(t[0].sweeps.contains_key("REF") && t[0].sweeps.contains_key("VEL"));
        let s = &v.sweeps[0];
        assert!(s.radials.len() >= 700, "radials {}", s.radials.len());
    }

    #[test]
    fn tdwr_chunks_assemble() {
        let base = std::env::var("TBW_TESTDATA").unwrap_or_else(|_| "../../testdata".into());
        let dir = format!("{base}/level2/chunks/185");
        let Ok(rd) = std::fs::read_dir(&dir) else { return };
        let mut files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        files.sort();
        let mut d = Decoder::new();
        for f in &files {
            d.feed(&std::fs::read(f).unwrap()).unwrap();
        }
        d.finish();
        assert_eq!(d.vol.site, "TORD");
        assert!(d.vol.complete);
        assert_eq!(d.vol.sweeps.len(), 16);
        assert!(tilts(&d.vol).len() >= 10);
    }

    #[test]
    fn klot_bzip2_superres() {
        let Some(b) = testdata("level2/KLOT20200715_230602_V06") else { return };
        let v = Decoder::decode_file(&b).unwrap();
        assert_eq!(v.vcp, 212);
        assert_eq!(v.sweeps.len(), 23);
        let r = &v.sweeps[0].radials[0];
        let refl = r.moment(Moment::Ref).unwrap();
        assert_eq!(refl.ngates, 1832);
        assert_eq!(refl.gate_m, 250.0);
    }
}
