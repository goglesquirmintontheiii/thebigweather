//! SAME AFSK encoder (port of app/src/same/encoder.ts): unit tests and the monitor self-test.

use super::{BAUD, MARK, SPACE};
use std::f64::consts::PI;

pub struct EncodeOpts {
    pub fs: f64,
    pub header: String,
    /// "nwr" | "eas" | ""
    pub tone: &'static str,
    pub tone_sec: f64,
    pub message_sec: f64,
    pub eom: bool,
    pub amp: f64,
    pub freq_scale: f64,
    pub baud_scale: f64,
    pub lead_sec: f64,
}

impl Default for EncodeOpts {
    fn default() -> Self {
        EncodeOpts { fs: 24000.0, header: String::new(), tone: "", tone_sec: 8.0, message_sec: 0.0, eom: false, amp: 0.5, freq_scale: 1.0, baud_scale: 1.0, lead_sec: 0.5 }
    }
}

pub fn encode_same(o: &EncodeOpts) -> Vec<f32> {
    let fs = o.fs;
    let amp = o.amp;
    let mut out: Vec<f32> = vec![];
    let silence = |out: &mut Vec<f32>, s: f64| out.extend(std::iter::repeat_n(0.0f32, (s * fs).round() as usize));
    let mut ph = 0.0f64;
    let mut afsk = |out: &mut Vec<f32>, text: &str| {
        let mut bytes = vec![0xabu8; 16];
        bytes.extend(text.bytes());
        let baud = BAUD * o.baud_scale;
        let n_bits = bytes.len() * 8;
        let n = ((n_bits as f64 / baud) * fs).ceil() as usize;
        let (fm, fsp) = (MARK * o.freq_scale, SPACE * o.freq_scale);
        for i in 0..n {
            let bi = (((i as f64 / fs) * baud).floor() as usize).min(n_bits - 1);
            let bit = (bytes[bi >> 3] >> (bi & 7)) & 1; // LSB first
            ph += 2.0 * PI * (if bit == 1 { fm } else { fsp }) / fs;
            out.push((amp * ph.sin()) as f32);
        }
    };
    silence(&mut out, o.lead_sec);
    for _ in 0..3 {
        afsk(&mut out, &o.header);
        silence(&mut out, 1.0);
    }
    if !o.tone.is_empty() {
        let n = (o.tone_sec * fs).round() as usize;
        for i in 0..n {
            let s = i as f64 / fs;
            let v = if o.tone == "nwr" { amp * (2.0 * PI * 1050.0 * s).sin() } else { amp / 2.0 * ((2.0 * PI * 853.0 * s).sin() + (2.0 * PI * 960.0 * s).sin()) };
            out.push(v as f32);
        }
        silence(&mut out, 1.0);
    }
    if o.message_sec > 0.0 {
        silence(&mut out, o.message_sec);
    }
    if o.eom {
        for _ in 0..3 {
            afsk(&mut out, "NNNN");
            silence(&mut out, 1.0);
        }
    }
    out
}
