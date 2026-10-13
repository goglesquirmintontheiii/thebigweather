//! Raspberry Shake seismograph data (FDSN network AM): station channels and waveforms.
//!
//! Raspberry Shake data may not be redistributed, so the server only proxies it on demand for the
//! person asking (nothing is recorded or polled) and keeps decoded results for a few minutes.
//! The provider allows about 5 requests/s; requests are spaced so this server stays under 4/s.
//! Waveforms arrive as miniSEED v2 and are decoded here (pure Rust: STEIM1/2, INT16/32, FLOAT32/64).

use crate::overlays::Overlays;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use chrono::{DateTime, NaiveDate, Utc};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

pub const FDSN: &str = "https://data.raspberryshake.org";
/// Longest waveform window one request may ask for.
pub const MAX_SPAN_MS: i64 = 2 * 3600 * 1000;
const MIN_GAP: Duration = Duration::from_millis(250);
const DATA_TTL: Duration = Duration::from_secs(300);
const DATA_CACHE_BYTES: usize = 24 * 1024 * 1024;
const CHANNEL_TTL: Duration = Duration::from_secs(86400);

pub struct Shake {
    /// when the last upstream request went out (spacing for the provider's rate limit)
    last: tokio::sync::Mutex<Instant>,
    channels: Mutex<HashMap<String, (Instant, Value)>>,
    /// decoded waveform responses, oldest first, with their total size
    data: Mutex<(VecDeque<(String, Instant, Bytes)>, usize)>,
}

impl Default for Shake {
    fn default() -> Self {
        Self {
            last: tokio::sync::Mutex::new(Instant::now() - MIN_GAP),
            channels: Mutex::new(HashMap::new()),
            data: Mutex::new((VecDeque::new(), 0)),
        }
    }
}

impl Shake {
    async fn throttle(&self) {
        let mut l = self.last.lock().await;
        let wait = MIN_GAP.saturating_sub(l.elapsed());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        *l = Instant::now();
    }

    fn cached(&self, key: &str) -> Option<Bytes> {
        let g = self.data.lock();
        g.0.iter().find(|e| e.0 == key && e.1.elapsed() < DATA_TTL).map(|e| e.2.clone())
    }

    fn store(&self, key: String, b: Bytes) {
        if b.len() > DATA_CACHE_BYTES / 2 {
            return;
        }
        let mut g = self.data.lock();
        g.1 += b.len();
        g.0.push_back((key, Instant::now(), b));
        while g.1 > DATA_CACHE_BYTES || g.0.front().map(|e| e.1.elapsed() > DATA_TTL).unwrap_or(false) {
            match g.0.pop_front() {
                Some(e) => g.1 -= e.2.len(),
                None => break,
            }
        }
    }
}

/// FDSN codes: letters/digits only, within a length range.
pub fn valid_code(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric())
}

fn fdsn_time(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()).unwrap_or_default()
}

/// A waveform request, validated.
#[derive(Debug, Clone)]
pub struct DataReq {
    pub net: String,
    pub sta: String,
    pub loc: String,
    pub cha: String,
    pub start: i64,
    pub end: i64,
}

impl DataReq {
    /// From query parameters; the error text is meant for the user (HTTP 400).
    pub fn from_query(q: &HashMap<String, String>) -> std::result::Result<Self, String> {
        let g = |k: &str, d: &str| q.get(k).map(|s| s.trim().to_ascii_uppercase()).filter(|s| !s.is_empty()).unwrap_or_else(|| d.to_string());
        let (net, sta, loc, cha) = (g("net", "AM"), g("sta", ""), g("loc", "00"), g("cha", "EHZ"));
        if !valid_code(&net, 1, 2) {
            return Err("bad net".into());
        }
        if !valid_code(&sta, 1, 5) {
            return Err("bad or missing sta".into());
        }
        if loc != "--" && !valid_code(&loc, 1, 2) {
            return Err("bad loc".into());
        }
        if !valid_code(&cha, 3, 3) {
            return Err("bad cha".into());
        }
        let t = |k: &str| q.get(k).and_then(|s| s.trim().parse::<i64>().ok()).ok_or_else(|| format!("{k} must be unix ms"));
        let (start, end) = (t("start")?, t("end")?);
        if end <= start {
            return Err("end must be after start".into());
        }
        if end - start > MAX_SPAN_MS {
            return Err("at most 2 hours per request".into());
        }
        let now = Utc::now().timestamp_millis();
        if start > now {
            return Err("start is in the future".into());
        }
        if start < 946_684_800_000 {
            return Err("start is too old".into());
        }
        Ok(Self { net, sta, loc, cha, start, end: end.min(now) })
    }

    fn key(&self) -> String {
        format!("{}.{}.{}.{}.{}.{}", self.net, self.sta, self.loc, self.cha, self.start, self.end)
    }
}

/// GET from the FDSN service with spacing; 204/404 ("no data") come back empty.
async fn fetch(o: &Overlays, url: &str) -> Result<Bytes> {
    o.shake.throttle().await;
    let r = o.http.get(url).timeout(Duration::from_secs(60)).send().await?;
    let s = r.status().as_u16();
    if s == 204 || s == 404 {
        return Ok(Bytes::new());
    }
    if !r.status().is_success() {
        bail!("HTTP {s} from data.raspberryshake.org");
    }
    let b = r.bytes().await?;
    if b.len() > 64 * 1024 * 1024 {
        bail!("response too large");
    }
    Ok(b)
}

/// [`fetch`] for sibling modules (`overlays::seismic`), with the same spacing.
pub(crate) async fn fetch_pub(o: &Overlays, url: &str) -> Result<Bytes> {
    fetch(o, url).await
}

/// Channels of one station: `[{loc, cha, sr, start, end, scale, units, sensor}]` (all epochs).
pub async fn channels(o: &Overlays, net: &str, sta: &str) -> Result<Value> {
    let key = format!("{net}.{sta}");
    if let Some((t, v)) = o.shake.channels.lock().get(&key) {
        if t.elapsed() < CHANNEL_TTL {
            return Ok(v.clone());
        }
    }
    let b = fetch(o, &format!("{FDSN}/fdsnws/station/1/query?network={net}&station={sta}&level=channel&format=text")).await?;
    let v = parse_channels(&String::from_utf8_lossy(&b));
    let mut c = o.shake.channels.lock();
    if c.len() > 500 {
        c.retain(|_, (t, _)| t.elapsed() < CHANNEL_TTL);
        if c.len() > 500 {
            c.clear();
        }
    }
    c.insert(key, (Instant::now(), v.clone()));
    Ok(v)
}

/// FDSN channel text: Network|Station|Location|Channel|Latitude|Longitude|Elevation|Depth|Azimuth|
/// Dip|SensorDescription|Scale|ScaleFreq|ScaleUnits|SampleRate|StartTime|EndTime
fn parse_channels(txt: &str) -> Value {
    let rows: Vec<Value> = txt
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let f: Vec<&str> = l.split('|').map(str::trim).collect();
            if f.len() < 17 {
                return None;
            }
            Some(json!({
                "loc": f[2], "cha": f[3], "sr": f[14].parse::<f64>().ok(), "start": f[15],
                "end": if f[16].is_empty() { Value::Null } else { json!(f[16]) },
                "scale": f[11].parse::<f64>().ok(), "units": f[13], "sensor": f[10],
            }))
        })
        .collect();
    json!(rows)
}

/// Waveform for one channel and window:
/// `{sr, start: ms of first sample, samples: [counts], gaps: [[ms0, ms1]], unit: "counts"}`.
/// Missing stretches inside the data are listed in `gaps` and padded with the last value so
/// sample i is always at `start + i * 1000 / sr`.
pub async fn data(o: &Overlays, r: &DataReq) -> Result<Bytes> {
    let key = r.key();
    if let Some(b) = o.shake.cached(&key) {
        return Ok(b);
    }
    let url = format!(
        "{FDSN}/fdsnws/dataselect/1/query?net={}&sta={}&loc={}&cha={}&starttime={}&endtime={}&nodata=404",
        r.net,
        r.sta,
        r.loc,
        r.cha,
        fdsn_time(r.start),
        fdsn_time(r.end)
    );
    let b = fetch(o, &url).await?;
    let (loc, cha, start, end) = (r.loc.trim_matches('-').to_string(), r.cha.clone(), r.start, r.end);
    let v = tokio::task::spawn_blocking(move || -> Result<Value> {
        let recs: Vec<Record> = parse_mseed(&b)?.into_iter().filter(|x| x.cha == cha && x.loc == loc).collect();
        Ok(assemble(recs, start * 1000, end * 1000))
    })
    .await
    .map_err(|e| anyhow!("decode task: {e}"))??;
    let out = Bytes::from(serde_json::to_vec(&v)?);
    o.shake.store(key, out.clone());
    Ok(out)
}

// ---------- miniSEED v2 ----------

/// One decoded data record.
#[derive(Debug, Clone)]
pub struct Record {
    pub net: String,
    pub sta: String,
    pub loc: String,
    pub cha: String,
    /// first sample time, unix µs
    pub start: i64,
    pub sr: f64,
    pub samples: Vec<i32>,
}

fn u16_at(b: &[u8], i: usize, be: bool) -> u16 {
    let x = [b[i], b[i + 1]];
    if be { u16::from_be_bytes(x) } else { u16::from_le_bytes(x) }
}

fn u32_at(b: &[u8], i: usize, be: bool) -> u32 {
    let x = [b[i], b[i + 1], b[i + 2], b[i + 3]];
    if be { u32::from_be_bytes(x) } else { u32::from_le_bytes(x) }
}

fn sr_from(factor: i16, mult: i16) -> f64 {
    let (f, m) = (factor as f64, mult as f64);
    match (factor.signum(), mult.signum()) {
        (1, 1) => f * m,
        (1, -1) => -f / m,
        (-1, 1) => -m / f,
        (-1, -1) => 1.0 / (f * m),
        (1, 0) => f,
        (-1, 0) => -1.0 / f,
        _ => 0.0,
    }
}

/// Parse a buffer of concatenated miniSEED v2 records (each needs blockette 1000).
pub fn parse_mseed(buf: &[u8]) -> Result<Vec<Record>> {
    let mut out = vec![];
    let mut pos = 0;
    while pos + 64 <= buf.len() {
        let h = &buf[pos..];
        // header byte order: the start year must be sane
        let be = (1900..=2100).contains(&u16_at(h, 20, true));
        if !be && !(1900..=2100).contains(&u16_at(h, 20, false)) {
            bail!("not miniSEED (bad header at byte {pos})");
        }
        let txt = |a: usize, b: usize| String::from_utf8_lossy(&h[a..b]).trim().to_string();
        let (year, doy) = (u16_at(h, 20, be), u16_at(h, 22, be));
        let (hh, mi, ss, frac) = (h[24] as u32, h[25] as u32, h[26] as u32, u16_at(h, 28, be) as i64);
        let nsamp = u16_at(h, 30, be) as usize;
        let sr = sr_from(u16_at(h, 32, be) as i16, u16_at(h, 34, be) as i16);
        let activity = h[36];
        let tcorr = u32_at(h, 40, be) as i32 as i64;
        let data_off = u16_at(h, 44, be) as usize;
        // blockettes
        let (mut enc, mut word_be, mut reclen, mut usec) = (None, true, 0usize, 0i64);
        let mut b = u16_at(h, 46, be) as usize;
        let mut guard = 0;
        while b >= 48 && b + 4 <= h.len().min(4096) && guard < 16 {
            let kind = u16_at(h, b, be);
            let next = u16_at(h, b + 2, be) as usize;
            match kind {
                1000 if b + 8 <= h.len() => {
                    enc = Some(h[b + 4]);
                    word_be = h[b + 5] == 1;
                    reclen = 1usize.checked_shl(h[b + 6] as u32).unwrap_or(0);
                }
                1001 if b + 8 <= h.len() => usec = h[b + 5] as i8 as i64,
                _ => {}
            }
            if next <= b {
                break;
            }
            b = next;
            guard += 1;
        }
        let enc = enc.ok_or_else(|| anyhow!("miniSEED record without blockette 1000"))?;
        if !(128..=65536).contains(&reclen) || pos + reclen > buf.len() {
            bail!("bad or truncated miniSEED record");
        }
        let day = NaiveDate::from_yo_opt(year as i32, doy as u32).and_then(|d| d.and_hms_opt(hh.min(23), mi.min(59), ss.min(59))).ok_or_else(|| anyhow!("bad record time"))?;
        let mut start = day.and_utc().timestamp() * 1_000_000 + frac * 100 + usec;
        if activity & 0x02 == 0 {
            start += tcorr * 100; // time correction not applied yet (0.0001 s units)
        }
        if nsamp > 0 && sr > 0.0 && data_off >= 48 && data_off < reclen {
            let d = &buf[pos + data_off..pos + reclen];
            let samples = decode(d, enc, nsamp, word_be)?;
            out.push(Record { net: txt(18, 20), sta: txt(8, 13), loc: txt(13, 15), cha: txt(15, 18), start, sr, samples });
        }
        pos += reclen;
    }
    Ok(out)
}

/// Decode a record's data section.
fn decode(d: &[u8], enc: u8, n: usize, be: bool) -> Result<Vec<i32>> {
    let need = |w: usize| if d.len() < n * w { Err(anyhow!("short data section")) } else { Ok(()) };
    Ok(match enc {
        1 => {
            need(2)?;
            (0..n).map(|i| u16_at(d, i * 2, be) as i16 as i32).collect()
        }
        3 => {
            need(4)?;
            (0..n).map(|i| u32_at(d, i * 4, be) as i32).collect()
        }
        4 => {
            need(4)?;
            (0..n).map(|i| f32::from_bits(u32_at(d, i * 4, be)).round() as i32).collect()
        }
        5 => {
            need(8)?;
            (0..n)
                .map(|i| {
                    let x: [u8; 8] = d[i * 8..i * 8 + 8].try_into().unwrap_or([0; 8]);
                    (if be { f64::from_be_bytes(x) } else { f64::from_le_bytes(x) }).round() as i32
                })
                .collect()
        }
        10 => steim(d, n, be, false)?,
        11 => steim(d, n, be, true)?,
        e => bail!("unsupported miniSEED encoding {e}"),
    })
}

/// Sign-extend the low `bits` of `v`.
fn sext(v: u32, bits: u32) -> i32 {
    ((v << (32 - bits)) as i32) >> (32 - bits)
}

/// `count` signed values of `bits` each, packed from the most significant end of the low
/// `count * bits` bits of `w`.
fn unpack(w: u32, count: u32, bits: u32, out: &mut Vec<i32>) {
    for k in 0..count {
        let shift = (count - 1 - k) * bits;
        out.push(sext((w >> shift) & ((1u32 << bits) - 1), bits));
    }
}

/// STEIM1 (`v2` false) / STEIM2 decompression: 64-byte frames of 16 words; word 0 holds 2-bit
/// codes for the 15 others; frame 0 words 1–2 are the first and last sample values.
fn steim(d: &[u8], n: usize, be: bool, v2: bool) -> Result<Vec<i32>> {
    let mut diffs: Vec<i32> = Vec::with_capacity(n + 8);
    let (mut x0, mut xn) = (None, 0i32);
    'frames: for f in 0..d.len() / 64 {
        let base = f * 64;
        let ctrl = u32_at(d, base, be);
        for w in 1..16 {
            let code = (ctrl >> (30 - 2 * w)) & 3;
            let word = u32_at(d, base + 4 * w, be);
            if f == 0 && w == 1 {
                x0 = Some(word as i32);
                continue;
            }
            if f == 0 && w == 2 {
                xn = word as i32;
                continue;
            }
            match (code, v2) {
                (0, _) => {}
                (1, _) => unpack(word, 4, 8, &mut diffs),
                (2, false) => unpack(word, 2, 16, &mut diffs),
                (3, false) => diffs.push(word as i32),
                (2, true) => match word >> 30 {
                    1 => unpack(word, 1, 30, &mut diffs),
                    2 => unpack(word, 2, 15, &mut diffs),
                    3 => unpack(word, 3, 10, &mut diffs),
                    _ => bail!("bad STEIM2 sub-code"),
                },
                (3, true) => match word >> 30 {
                    0 => unpack(word, 5, 6, &mut diffs),
                    1 => unpack(word, 6, 5, &mut diffs),
                    2 => unpack(word, 7, 4, &mut diffs),
                    _ => bail!("bad STEIM2 sub-code"),
                },
                _ => unreachable!(),
            }
            if diffs.len() >= n {
                break 'frames;
            }
        }
    }
    let x0 = x0.ok_or_else(|| anyhow!("empty STEIM data"))?;
    if diffs.len() < n {
        bail!("STEIM data has {} of {n} samples", diffs.len());
    }
    // the first difference links to the previous record; sample 0 is x0
    let mut s = Vec::with_capacity(n);
    s.push(x0);
    for d in &diffs[1..n] {
        s.push(s[s.len() - 1].wrapping_add(*d));
    }
    if s[n - 1] != xn {
        tracing::debug!("STEIM integrity: last sample {} != {}", s[n - 1], xn);
    }
    Ok(s)
}

/// Join records (one channel) into one evenly spaced series trimmed to [t0, t1] (µs).
pub fn assemble(mut recs: Vec<Record>, t0: i64, t1: i64) -> Value {
    recs.retain(|r| r.sr > 0.0 && !r.samples.is_empty());
    recs.sort_by_key(|r| r.start);
    let ms = |us: f64| (us / 1000.0).round() as i64;
    if recs.is_empty() {
        return json!({"sr": null, "start": null, "samples": [], "gaps": [[ms(t0 as f64), ms(t1 as f64)]], "unit": "counts"});
    }
    let sr = recs[0].sr;
    let dt = 1e6 / sr;
    let mut start = recs[0].start as f64;
    let mut out: Vec<i32> = vec![];
    let mut gaps: Vec<(f64, f64)> = vec![];
    for r in &recs {
        if (r.sr - sr).abs() > sr * 1e-4 {
            continue;
        }
        let expected = start + out.len() as f64 * dt;
        let delta = r.start as f64 - expected;
        if out.is_empty() {
            out.extend_from_slice(&r.samples);
        } else if delta > 1.5 * dt {
            if r.start as f64 > t1 as f64 + 60e6 {
                continue; // bogus time
            }
            gaps.push((expected, r.start as f64));
            let fill = (delta / dt).round() as usize;
            let last = *out.last().unwrap_or(&0);
            out.extend(std::iter::repeat_n(last, fill));
            out.extend_from_slice(&r.samples);
        } else if delta < -0.5 * dt {
            // overlap: keep what we have
            let skip = (-delta / dt).round() as usize;
            if skip < r.samples.len() {
                out.extend_from_slice(&r.samples[skip..]);
            }
        } else {
            out.extend_from_slice(&r.samples);
        }
    }
    // trim to the window
    let lead = ((t0 as f64 - start) / dt).ceil().max(0.0) as usize;
    let lead = lead.min(out.len());
    out.drain(..lead);
    start += lead as f64 * dt;
    let keep = (((t1 as f64 - start) / dt).floor() + 1.0).max(0.0) as usize;
    out.truncate(keep);
    if start - t0 as f64 > 1.5 * dt {
        gaps.insert(0, (t0 as f64, start));
    }
    let end = start + out.len() as f64 * dt;
    if t1 as f64 - end > 1.5 * dt {
        gaps.push((end, t1 as f64));
    }
    let gaps: Vec<Value> = gaps.into_iter().filter(|g| g.1 > t0 as f64 && g.0 < t1 as f64).map(|g| json!([ms(g.0.max(t0 as f64)), ms(g.1.min(t1 as f64))])).collect();
    json!({"sr": sr, "start": start.round() / 1000.0, "samples": out, "gaps": gaps, "unit": "counts"})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build one 512-byte big-endian miniSEED record (blockette 1000) around a data section.
    fn record(enc: u8, nsamp: u16, start: (u16, u16, u8, u8, u8, u16), data: &[u8], word_be: bool) -> Vec<u8> {
        let mut r = vec![0u8; 512];
        r[0..6].copy_from_slice(b"000001");
        r[6] = b'D';
        r[8..13].copy_from_slice(b"R1234");
        r[13..15].copy_from_slice(b"00");
        r[15..18].copy_from_slice(b"EHZ");
        r[18..20].copy_from_slice(b"AM");
        r[20..22].copy_from_slice(&start.0.to_be_bytes());
        r[22..24].copy_from_slice(&start.1.to_be_bytes());
        r[24] = start.2;
        r[25] = start.3;
        r[26] = start.4;
        r[28..30].copy_from_slice(&start.5.to_be_bytes());
        r[30..32].copy_from_slice(&nsamp.to_be_bytes());
        r[32..34].copy_from_slice(&100i16.to_be_bytes());
        r[34..36].copy_from_slice(&1i16.to_be_bytes());
        r[39] = 1;
        r[44..46].copy_from_slice(&64u16.to_be_bytes());
        r[46..48].copy_from_slice(&48u16.to_be_bytes());
        // blockette 1000
        r[48..50].copy_from_slice(&1000u16.to_be_bytes());
        r[52] = enc;
        r[53] = word_be as u8;
        r[54] = 9;
        r[64..64 + data.len()].copy_from_slice(data);
        r
    }

    fn words(w: &[u32]) -> Vec<u8> {
        w.iter().flat_map(|x| x.to_be_bytes()).collect()
    }

    #[test]
    fn steim1() {
        // samples 10, 12, 9, 9, 1009, -70000 → diffs (d0) 2, -3, 0, 1000, -71009
        // codes: w1 X0, w2 Xn, w3 four bytes [0,2,-3,0], w4 two halves [1000, 0?] no: one 32-bit, w5 one 32-bit
        let samples = [10, 12, 9, 9, 1009, -70000];
        let w3 = u32::from_be_bytes([0u8, 2, (-3i8) as u8, 0]);
        let w4 = 1000u32; // code 3: one 32-bit difference
        let w5 = (-71009i32) as u32;
        let ctrl = (1u32 << (30 - 6)) | (3u32 << (30 - 8)) | (3u32 << (30 - 10));
        let mut frame = vec![ctrl, 10, (-70000i32) as u32, w3, w4, w5];
        frame.resize(16, 0);
        let d = words(&frame);
        assert_eq!(steim(&d, 6, true, false).unwrap(), samples);
        // two 16-bit differences
        let ctrl = 2u32 << (30 - 6);
        let mut frame = vec![ctrl, 100, 70, ((5i16 as u16 as u32) << 16) | ((-30i16) as u16 as u32)];
        frame.resize(16, 0);
        assert_eq!(steim(&words(&frame), 2, true, false).unwrap(), vec![100, 70]);
    }

    #[test]
    fn steim2() {
        // samples: 0, 1, 3, 6, 10, 15, 21, 28, -100, 400, 100000
        // diffs (from 0): 0, 1, 2, 3, 4, 5, 6, 7, -128, 500, 99600
        let mut ctrl = 0u32;
        let mut w = vec![0u32, 0, 100000];
        // w3: code 3 / dnib 2: seven 4-bit diffs 0,1,2,3,4,5,6
        let mut v = 2u32 << 30;
        for (k, d) in [0i32, 1, 2, 3, 4, 5, 6].iter().enumerate() {
            v |= ((*d as u32) & 0xf) << ((6 - k) * 4);
        }
        w.push(v);
        ctrl |= 3 << (30 - 6);
        // w4: code 2 / dnib 3: three 10-bit diffs 7, -128, 500
        let mut v = 3u32 << 30;
        for (k, d) in [7i32, -128, 500].iter().enumerate() {
            v |= ((*d as u32) & 0x3ff) << ((2 - k) * 10);
        }
        w.push(v);
        ctrl |= 2 << (30 - 8);
        // w5: code 2 / dnib 1: one 30-bit diff 99600
        w.push((1u32 << 30) | (99600u32 & 0x3fff_ffff));
        ctrl |= 2 << (30 - 10);
        w[0] = ctrl;
        w.resize(16, 0);
        let s = steim(&words(&w), 11, true, true).unwrap();
        assert_eq!(s, vec![0, 1, 3, 6, 10, 15, 21, 28, -100, 400, 100000]);
        // the 5×6, 6×5, 2×15 and 4×8 packings, across two frames
        let mut f0 = vec![0u32, 50, 0];
        let mut c0 = 0u32;
        let mut v = 0u32 << 30; // five 6-bit: 0, -32, 31, 1, -1
        for (k, d) in [0i32, -32, 31, 1, -1].iter().enumerate() {
            v |= ((*d as u32) & 0x3f) << ((4 - k) * 6);
        }
        f0.push(v);
        c0 |= 3 << (30 - 6);
        let mut v = 1u32 << 30; // six 5-bit: -16, 15, 0, 0, 2, -2
        for (k, d) in [-16i32, 15, 0, 0, 2, -2].iter().enumerate() {
            v |= ((*d as u32) & 0x1f) << ((5 - k) * 5);
        }
        f0.push(v);
        c0 |= 3 << (30 - 8);
        f0[0] = c0;
        f0.resize(16, 0);
        let mut f1 = vec![0u32; 16];
        f1[1] = (2u32 << 30) | (((-16384i32 as u32) & 0x7fff) << 15) | (16383u32 & 0x7fff); // two 15-bit
        f1[2] = u32::from_be_bytes([127, 128, 1, 255]); // four 8-bit: 127, -128, 1, -1
        f1[0] = (2 << (30 - 2)) | (1 << (30 - 4));
        let mut all = words(&f0);
        all.extend(words(&f1));
        let s = steim(&all, 17, true, true).unwrap();
        let diffs = [0, -32, 31, 1, -1, -16, 15, 0, 0, 2, -2, -16384, 16383, 127, -128, 1, -1];
        let mut want = vec![50];
        for d in &diffs[1..] {
            want.push(want[want.len() - 1] + d);
        }
        assert_eq!(s, want);
    }

    #[test]
    fn records_and_gaps() {
        // INT32 record, 5 samples at 100 Hz starting 2024-05-21 (doy 142) 20:00:00.0000
        let d: Vec<u8> = [1i32, 2, 3, 4, 5].iter().flat_map(|x| x.to_be_bytes()).collect();
        let mut buf = record(3, 5, (2024, 142, 20, 0, 0, 0), &d, true);
        // INT16 little-endian data, next record after a 0.1 s gap (starts at .15 s)
        let d2: Vec<u8> = [-6i16, 7].iter().flat_map(|x| x.to_le_bytes()).collect();
        buf.extend(record(1, 2, (2024, 142, 20, 0, 0, 1500), &d2, false));
        let recs = parse_mseed(&buf).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].sta, "R1234");
        assert_eq!(recs[0].cha, "EHZ");
        assert_eq!(recs[0].sr, 100.0);
        assert_eq!(recs[0].start, 1716321600 * 1_000_000);
        assert_eq!(recs[1].samples, vec![-6, 7]);
        let t0 = 1716321600_000_000i64;
        let v = assemble(recs, t0, t0 + 300_000);
        assert_eq!(v["sr"], 100.0);
        assert_eq!(v["start"], 1716321600000.0);
        // 5 samples, 10 padded (gap 0.05 → 0.15 s), 2 samples
        let s: Vec<i64> = v["samples"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
        assert_eq!(s.len(), 17);
        assert_eq!(&s[..6], &[1, 2, 3, 4, 5, 5]);
        assert_eq!(&s[15..], &[-6, 7]);
        assert_eq!(v["gaps"][0], json!([1716321600050i64, 1716321600150i64]));
        assert_eq!(v["gaps"][1], json!([1716321600170i64, 1716321600300i64]));
        // window trimming
        let recs = parse_mseed(&buf).unwrap();
        let v = assemble(recs, t0 + 20_000, t0 + 30_000);
        assert_eq!(v["samples"], json!([3, 4]));
        assert_eq!(v["start"], 1716321600020.0);
        assert!(parse_mseed(b"garbage garbage garbage garbage garbage garbage garbage garbage garbage").is_err());
        assert_eq!(assemble(vec![], 0, 1000)["samples"], json!([]));
    }

    #[test]
    fn rates_and_requests() {
        assert_eq!(sr_from(100, 1), 100.0);
        assert_eq!(sr_from(-10, 1), 0.1);
        assert_eq!(sr_from(1, -10), 0.1);
        let now = Utc::now().timestamp_millis();
        let q = |s: &[(&str, String)]| s.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<HashMap<_, _>>();
        let ok = DataReq::from_query(&q(&[("sta", "r1234".into()), ("start", (now - 3_600_000).to_string()), ("end", (now - 1_800_000).to_string())])).unwrap();
        assert_eq!((ok.net.as_str(), ok.sta.as_str(), ok.loc.as_str(), ok.cha.as_str()), ("AM", "R1234", "00", "EHZ"));
        assert!(DataReq::from_query(&q(&[("sta", "R1234".into()), ("start", (now - 3 * 3_600_000).to_string()), ("end", now.to_string())])).is_err());
        assert!(DataReq::from_query(&q(&[("sta", "R1;34".into()), ("start", "1".into()), ("end", "2".into())])).is_err());
        assert!(DataReq::from_query(&q(&[("sta", "R1234".into()), ("start", "x".into()), ("end", "2".into())])).is_err());
    }

    #[test]
    fn channel_text() {
        let t = "#Network|Station|Location|Channel|Latitude|Longitude|Elevation|Depth|Azimuth|Dip|SensorDescription|Scale|ScaleFreq|ScaleUnits|SampleRate|StartTime|EndTime\n\
AM|R0038|00|EHZ|46.5045|7.3045|1279.0|0.0|0.0|-90.0|Raspberry Shake RS1D|399650000.0|5.0|M/S|100.0|2022-04-14T15:59:59.505|\n";
        let v = parse_channels(t);
        assert_eq!(v[0]["cha"], "EHZ");
        assert_eq!(v[0]["sr"], 100.0);
        assert!(v[0]["end"].is_null());
        assert_eq!(v[0]["units"], "M/S");
    }
}
