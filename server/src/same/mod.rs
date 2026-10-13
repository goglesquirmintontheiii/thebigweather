//! EAS SAME (Specific Area Message Encoding) decoder: a port of the app's
//! `app/src/same/{decoder,dsp,parse,codes}.ts`. AFSK demodulation (520.83 baud, mark 2083.3 Hz /
//! space 1562.5 Hz), bit-clock recovery, byte framing on the 0xAB preamble, 3-burst majority
//! vote, NNNN end of message, and attention-tone detection (NWR 1050 Hz, EAS 853 + 960 Hz).
//! Used by the server-side radio monitor (`crate::radio`).

pub mod codes;
pub mod parse;
pub mod encoder;
#[cfg(test)]
mod tests;

use parse::{parse_header, SameHeader};
use serde::Serialize;
use std::f64::consts::PI;

pub const BAUD: f64 = 520.833_333_3;
pub const MARK: f64 = 2083.333_333_3;
pub const SPACE: f64 = 1562.5;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SameEvent {
    Header { t: f64, raw: String, header: Option<SameHeader>, copies: usize },
    Eom { t: f64, copies: usize },
    ToneStart { t: f64, kind: Tone },
    ToneEnd { t: f64, kind: Tone, duration: f64 },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Nwr,
    Eas,
}

const KI: f64 = 0.006;

/// Goertzel power at `f`, normalised so a pure tone gives ≈1 relative to the block energy.
pub fn tone_ratio(x: &[f32], fs: f64, f: f64, energy: f64) -> f64 {
    let k = 2.0 * (2.0 * PI * f / fs).cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for &v in x {
        let s = v as f64 + k * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    let p = s1 * s1 + s2 * s2 - k * s1 * s2;
    if energy > 1e-12 { p / (energy * x.len() as f64 / 2.0) } else { 0.0 }
}

pub fn energy_of(x: &[f32]) -> f64 {
    x.iter().map(|&v| (v as f64) * (v as f64)).sum()
}

/// Accept a burst start with at most one bad character.
fn looks(s: &str) -> Option<&'static str> {
    let b = s.as_bytes();
    let diff = |a: &[u8]| a.iter().enumerate().filter(|(i, c)| b.get(*i) != Some(c)).count();
    if diff(b"ZCZC") <= 1 {
        Some("ZCZC")
    } else if diff(b"NNNN") <= 1 {
        Some("NNNN")
    } else {
        None
    }
}

/// Character-wise majority vote over up to 3 copies.
pub fn vote(copies: &[String]) -> String {
    if copies.len() == 1 {
        return copies[0].clone();
    }
    let cs: Vec<&[u8]> = copies.iter().map(|c| c.as_bytes()).collect();
    let len = cs.iter().map(|c| c.len()).max().unwrap_or(0);
    let mut out = String::new();
    for i in 0..len {
        // first-seen order wins ties (as the Map iteration in the TS version)
        let mut cnt: Vec<(u8, usize)> = vec![];
        for c in &cs {
            if let Some(&ch) = c.get(i) {
                match cnt.iter_mut().find(|(x, _)| *x == ch) {
                    Some(e) => e.1 += 1,
                    None => cnt.push((ch, 1)),
                }
            }
        }
        let mut best = cs[0].get(i).copied();
        let mut bn = 0;
        for (ch, n) in cnt {
            if n > bn {
                best = Some(ch);
                bn = n;
            }
        }
        if let Some(b) = best {
            out.push(b as char);
        }
    }
    out
}

/// Bits → bursts of characters.
struct AfskDemod {
    fs: f64,
    n_win: usize,
    ring: Vec<f64>, // 5 values per sample: mI mQ sI sQ x²
    ri: usize,
    sum: [f64; 5],
    ph_m: f64,
    ph_s: f64,
    d_m: f64,
    d_s: f64,
    bit_ph: f64,
    bit_step: f64,
    f_adj: f64,
    prev_d: f64,
    q_acc: f64,
    q_n: usize,
    n: u64,
    shift: u32,
    good: u32,
    synced: bool,
    bit_count: u32,
    bad: u32,
    msg: String,
    msg_t: f64,
    bursts: Vec<(String, f64)>,
}

impl AfskDemod {
    fn new(fs: f64) -> Self {
        let n_win = (fs / BAUD).round() as usize;
        AfskDemod {
            fs,
            n_win,
            ring: vec![0.0; n_win * 5],
            ri: 0,
            sum: [0.0; 5],
            ph_m: 0.0,
            ph_s: 0.0,
            d_m: 2.0 * PI * MARK / fs,
            d_s: 2.0 * PI * SPACE / fs,
            bit_ph: 0.0,
            bit_step: BAUD / fs,
            f_adj: 0.0,
            prev_d: 0.0,
            q_acc: 0.0,
            q_n: 0,
            n: 0,
            shift: 0,
            good: 0,
            synced: false,
            bit_count: 0,
            bad: 0,
            msg: String::new(),
            msg_t: 0.0,
            bursts: vec![],
        }
    }

    fn push(&mut self, x: &[f32], t0: f64) {
        let half_n = self.n_win as f64 / 2.0;
        for (i, &v) in x.iter().enumerate() {
            let v = v as f64;
            let o = self.ri * 5;
            let a = [v * self.ph_m.cos(), v * self.ph_m.sin(), v * self.ph_s.cos(), v * self.ph_s.sin(), v * v];
            for k in 0..5 {
                self.sum[k] += a[k] - self.ring[o + k];
                self.ring[o + k] = a[k];
            }
            self.ri += 1;
            if self.ri == self.n_win {
                self.ri = 0;
            }
            self.ph_m += self.d_m;
            if self.ph_m > 2.0 * PI {
                self.ph_m -= 2.0 * PI;
            }
            self.ph_s += self.d_s;
            if self.ph_s > 2.0 * PI {
                self.ph_s -= 2.0 * PI;
            }
            self.n += 1;
            if self.n % 65536 == 0 {
                // cancel running-sum drift
                self.sum = [0.0; 5];
                for (j, r) in self.ring.iter().enumerate() {
                    self.sum[j % 5] += r;
                }
            }
            let s = &self.sum;
            let em = s[0] * s[0] + s[1] * s[1];
            let es = s[2] * s[2] + s[3] * s[3];
            let tot = em + es;
            let d = (em - es) / (tot + 1e-20);
            let q = tot / (s[4] * half_n + 1e-20);
            self.q_acc += q;
            self.q_n += 1;
            // clock recovery: zero crossings of the discriminator belong half a bit after sampling
            if (d > 0.0) != (self.prev_d > 0.0) && q > 0.2 {
                let err = self.bit_ph - 0.5;
                self.bit_ph -= err * if self.synced { 0.12 } else { 0.3 };
                self.f_adj = (self.f_adj - err * KI).clamp(-0.04, 0.04);
            } else if q < 0.1 {
                self.f_adj *= 0.9995;
            }
            self.prev_d = d;
            self.bit_ph += self.bit_step * (1.0 + self.f_adj);
            if self.bit_ph >= 1.0 {
                self.bit_ph -= 1.0;
                let qm = self.q_acc / self.q_n.max(1) as f64;
                self.q_acc = 0.0;
                self.q_n = 0;
                self.bit(if d > 0.0 { 1 } else { 0 }, q.min(qm), t0 + i as f64 / self.fs);
            }
        }
    }

    fn bit(&mut self, b: u32, q: f64, t: f64) {
        self.shift = ((self.shift >> 1) | (b << 7)) & 0xff;
        let carrier = q > 0.3;
        if !self.synced {
            self.good = if carrier { self.good + 1 } else { 0 };
            if self.good >= 8 && self.shift == 0xab {
                self.synced = true;
                self.bit_count = 0;
                self.bad = 0;
                self.msg.clear();
                self.msg_t = t;
            }
            return;
        }
        self.bad = if carrier { 0 } else { self.bad + 1 };
        if self.bad >= 6 {
            return self.end();
        }
        self.bit_count += 1;
        if self.bit_count < 8 {
            return;
        }
        self.bit_count = 0;
        let c = self.shift;
        if self.msg.is_empty() && c == 0xab {
            return; // still in the preamble
        }
        if !(0x20..=0x7e).contains(&c) {
            return self.end();
        }
        if self.msg.is_empty() {
            self.msg_t = t;
        }
        self.msg.push(c as u8 as char);
        if self.msg.len() == 4 && looks(&self.msg).is_none() {
            self.msg.clear();
            self.synced = false;
            self.good = 0;
            return;
        }
        if self.msg.len() >= 268 {
            self.end();
        }
    }

    fn end(&mut self) {
        if self.msg.len() >= 4 {
            self.bursts.push((std::mem::take(&mut self.msg), self.msg_t));
        }
        self.msg.clear();
        self.synced = false;
        self.good = 0;
    }
}

struct ToneDetector {
    fs: f64,
    buf: Vec<f32>,
    blk: usize,
    kind: Option<Tone>,
    on_count: u32,
    off_count: u32,
    cand: Option<Tone>,
    start: f64,
    /// RMS level of the last block (dBFS)
    level_db: f64,
}

impl ToneDetector {
    fn new(fs: f64) -> Self {
        let blk = (fs * 0.025).round() as usize;
        ToneDetector { fs, buf: Vec::with_capacity(blk), blk, kind: None, on_count: 0, off_count: 0, cand: None, start: 0.0, level_db: -120.0 }
    }

    fn push(&mut self, x: &[f32], t0: f64, out: &mut Vec<SameEvent>) {
        for (i, &v) in x.iter().enumerate() {
            self.buf.push(v);
            if self.buf.len() == self.blk {
                self.block(t0 + (i + 1) as f64 / self.fs, out);
                self.buf.clear();
            }
        }
    }

    fn block(&mut self, t: f64, out: &mut Vec<SameEvent>) {
        let (fs, blk) = (self.fs, self.blk);
        let e = energy_of(&self.buf);
        self.level_db = 10.0 * (e / blk as f64 + 1e-12).log10();
        let mut k = None;
        if e / blk as f64 > 1e-6 {
            let r1050 = tone_ratio(&self.buf, fs, 1050.0, e);
            let r853 = tone_ratio(&self.buf, fs, 853.0, e);
            let r960 = tone_ratio(&self.buf, fs, 960.0, e);
            // lower thresholds once a tone is running (hysteresis)
            let h = if self.kind.is_some() { 0.6 } else { 1.0 };
            if r1050 > 0.35 * h && r853 < 0.1 && r960 < 0.1 {
                k = Some(Tone::Nwr);
            } else if r853 > 0.1 * h && r960 > 0.1 * h && r853 + r960 > 0.3 * h {
                k = Some(Tone::Eas);
            }
        }
        let dt = blk as f64 / fs;
        match self.kind {
            None => {
                if k.is_some() && k == self.cand {
                    self.on_count += 1;
                } else {
                    self.cand = k;
                    self.on_count = if k.is_some() { 1 } else { 0 };
                }
                if self.on_count >= 8 {
                    self.kind = k;
                    self.start = t - 8.0 * dt;
                    self.off_count = 0;
                    out.push(SameEvent::ToneStart { t: self.start, kind: k.unwrap() });
                }
            }
            Some(cur) => {
                if k == Some(cur) {
                    self.off_count = 0;
                } else {
                    self.off_count += 1;
                    if self.off_count >= 4 {
                        let end = t - 4.0 * dt;
                        out.push(SameEvent::ToneEnd { t: end, kind: cur, duration: end - self.start });
                        self.kind = None;
                        self.cand = None;
                        self.on_count = 0;
                    }
                }
            }
        }
    }
}

struct Group {
    kind: &'static str,
    copies: Vec<String>,
    t: f64,
    last: f64,
}

/// Streaming decoder. Feed mono f32 samples at `fs` with [`SameDecoder::push`]; events come back
/// from each call.
pub struct SameDecoder {
    pub fs: f64,
    demod: AfskDemod,
    tones: ToneDetector,
    t: f64,
    group: Option<Group>,
    last_header: (String, f64),
    last_eom: f64,
    now: Box<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send>,
}

impl SameDecoder {
    pub fn new(fs: f64) -> Self {
        Self::with_clock(fs, Box::new(chrono::Utc::now))
    }
    pub fn with_clock(fs: f64, now: Box<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send>) -> Self {
        SameDecoder { fs, demod: AfskDemod::new(fs), tones: ToneDetector::new(fs), t: 0.0, group: None, last_header: (String::new(), -1e9), last_eom: -1e9, now }
    }
    /// Seconds of audio processed.
    pub fn time(&self) -> f64 {
        self.t
    }
    pub fn tone(&self) -> Option<Tone> {
        self.tones.kind
    }
    /// Level of the most recent 25 ms block, dBFS.
    pub fn level_db(&self) -> f64 {
        self.tones.level_db
    }

    pub fn push(&mut self, x: &[f32]) -> Vec<SameEvent> {
        let mut out = vec![];
        self.demod.push(x, self.t);
        for (s, t) in std::mem::take(&mut self.demod.bursts) {
            self.burst(s, t, &mut out);
        }
        self.tones.push(x, self.t, &mut out);
        self.t += x.len() as f64 / self.fs;
        if self.group.as_ref().map(|g| self.t - g.last > 4.5).unwrap_or(false) {
            self.flush(&mut out);
        }
        out
    }

    /// Force out a partially received group.
    pub fn finish(&mut self) -> Vec<SameEvent> {
        let mut out = vec![];
        self.flush(&mut out);
        out
    }

    fn burst(&mut self, s: String, t: f64, out: &mut Vec<SameEvent>) {
        let Some(kind) = looks(&s) else { return };
        if self.group.as_ref().map(|g| g.kind != kind || t - g.last > 4.5).unwrap_or(false) {
            self.flush(out);
        }
        let g = self.group.get_or_insert(Group { kind, copies: vec![], t, last: t });
        g.copies.push(s);
        g.last = t;
        if g.copies.len() >= 3 {
            self.flush(out);
        }
    }

    fn flush(&mut self, out: &mut Vec<SameEvent>) {
        let Some(g) = self.group.take() else { return };
        if g.kind == "NNNN" {
            if g.t - self.last_eom < 10.0 {
                return;
            }
            self.last_eom = g.t;
            out.push(SameEvent::Eom { t: g.t, copies: g.copies.len() });
            return;
        }
        let now = (self.now)();
        let mut raw = vote(&g.copies);
        let mut header = parse_header(&raw, now);
        if header.is_none() {
            // two disagreeing copies: take whichever parses
            for c in &g.copies {
                if let Some(h) = parse_header(c, now) {
                    header = Some(h);
                    raw = c.clone();
                    break;
                }
            }
        }
        let key = header.as_ref().map(|h| h.raw.clone()).unwrap_or_else(|| raw.clone());
        if key == self.last_header.0 && g.t - self.last_header.1 < 15.0 {
            return;
        }
        self.last_header = (key, g.t);
        let raw = header.as_ref().map(|h| h.raw.clone()).unwrap_or_else(|| raw.chars().map(|c| if (' '..='~').contains(&c) { c } else { '?' }).collect());
        out.push(SameEvent::Header { t: g.t, raw, header, copies: g.copies.len() });
    }
}

/// s16le bytes → f32 samples (carry an odd trailing byte in `carry`).
pub fn s16le_to_f32(carry: &mut Option<u8>, bytes: &[u8], out: &mut Vec<f32>) {
    let mut i = 0;
    if let Some(lo) = carry.take() {
        if let Some(&hi) = bytes.first() {
            out.push(i16::from_le_bytes([lo, hi]) as f32 / 32768.0);
            i = 1;
        } else {
            *carry = Some(lo);
            return;
        }
    }
    while i + 1 < bytes.len() {
        out.push(i16::from_le_bytes([bytes[i], bytes[i + 1]]) as f32 / 32768.0);
        i += 2;
    }
    if i < bytes.len() {
        *carry = Some(bytes[i]);
    }
}
