//! Port of app/tests/same.test.ts: synthetic AFSK with noise, frequency and clock offsets.

use super::encoder::{encode_same, EncodeOpts};
use super::parse::{build_header, parse_header};
use super::*;
use chrono::{TimeZone, Utc};

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 5, 20, 22, 5, 0).unwrap()
}
fn hdr() -> String {
    build_header("WXR", "TOR", &["040109", "040027", "140017"], "0045", Utc.with_ymd_and_hms(2026, 5, 20, 22, 3, 0).unwrap(), "KOUN/NWS")
}

/// Gaussian noise from a small LCG (deterministic).
fn add_noise(x: &mut [f32], snr_db: f64, seed: u32) {
    let mut s = seed;
    let mut u = || {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        (s as f64 + 0.5) / 4294967296.0
    };
    let sigma = (0.125 / 10f64.powf(snr_db / 10.0)).sqrt();
    for v in x.iter_mut() {
        let g = (-2.0 * u().ln()).sqrt() * (2.0 * std::f64::consts::PI * u()).cos();
        *v += (sigma * g) as f32;
    }
}

fn decode(x: &[f32], fs: f64, block: usize) -> Vec<SameEvent> {
    let mut d = SameDecoder::with_clock(fs, Box::new(now));
    let mut ev = vec![];
    for c in x.chunks(block) {
        ev.extend(d.push(c));
    }
    ev.extend(d.push(&vec![0.0; fs as usize * 5]));
    ev.extend(d.finish());
    ev
}

fn headers(ev: &[SameEvent]) -> Vec<(String, Option<parse::SameHeader>, usize)> {
    ev.iter()
        .filter_map(|e| match e {
            SameEvent::Header { raw, header, copies, .. } => Some((raw.clone(), header.clone(), *copies)),
            _ => None,
        })
        .collect()
}
fn tone_end(ev: &[SameEvent]) -> Option<(Tone, f64)> {
    ev.iter().find_map(|e| match e {
        SameEvent::ToneEnd { kind, duration, .. } => Some((*kind, *duration)),
        _ => None,
    })
}
fn eoms(ev: &[SameEvent]) -> usize {
    ev.iter().filter(|e| matches!(e, SameEvent::Eom { .. })).count()
}

#[test]
fn parse() {
    let h = parse_header("garbageZCZC-WXR-TOR-040109-040027-140017+0045-1402203-KOUN/NWS-xx", now()).unwrap();
    assert_eq!(h.event, "TOR");
    assert_eq!(h.event_name, "Tornado Warning");
    assert_eq!(h.level, "warning");
    assert_eq!(h.org_name, "National Weather Service");
    assert_eq!(h.locations.len(), 3);
    assert_eq!(h.locations[2].part, "Northwest");
    assert_eq!(h.locations[2].fips, "40017");
    assert_eq!(h.issued.to_rfc3339(), "2026-05-20T22:03:00+00:00");
    assert_eq!(h.expires.to_rfc3339(), "2026-05-20T22:48:00+00:00");
    assert_eq!(h.sender, "KOUN/NWS");
    assert_eq!(h.locations[0].name, "Oklahoma Co., OK");
    assert_eq!(h.locations[2].name, "Northwest Canadian Co., OK");
    // year rollover: day 365 heard on Jan 1
    let h2 = parse_header("ZCZC-WXR-RWT-020000+0015-3652359-KXYZ/NWS-", Utc.with_ymd_and_hms(2027, 1, 1, 0, 5, 0).unwrap()).unwrap();
    assert_eq!(h2.issued.format("%Y").to_string(), "2026");
    assert_eq!(h2.locations[0].name, "Kansas (entire state)");
    assert!(parse_header("ZCZC-WXR-TOR-040109+0045-9992203-KOUN/NWS-", now()).is_none());
    assert_eq!(hdr(), "ZCZC-WXR-TOR-040109-040027-140017+0045-1402203-KOUN/NWS-");
}

#[test]
fn vote_majority() {
    assert_eq!(vote(&["ZCZC-WXR-TOR".into(), "ZCZC-WXQ-TOR".into(), "ZCZC-WXR-TPR".into()]), "ZCZC-WXR-TOR");
}

fn clean(fs: f64) {
    let x = encode_same(&EncodeOpts { fs, header: hdr(), tone: "nwr", tone_sec: 8.0, message_sec: 2.0, eom: true, ..Default::default() });
    let ev = decode(&x, fs, 1000);
    let h = headers(&ev);
    assert_eq!(h.len(), 1, "{ev:?}");
    assert_eq!(h[0].0, hdr());
    assert_eq!(h[0].2, 3);
    assert_eq!(h[0].1.as_ref().unwrap().event_name, "Tornado Warning");
    let (k, d) = tone_end(&ev).unwrap();
    assert!(k == Tone::Nwr && (d - 8.0).abs() < 0.15, "{d}");
    assert_eq!(eoms(&ev), 1);
}

#[test]
fn clean_decode_24k() {
    clean(24000.0);
}

#[test]
fn clean_decode_22k() {
    clean(22050.0);
}

fn noisy(fs: f64) {
    let cases = [(6.0, 1.0, 1.0), (10.0, 1.02, 1.0), (10.0, 0.98, 1.0), (10.0, 1.0, 1.01), (10.0, 1.0, 0.99), (8.0, 1.015, 0.995), (3.0, 0.97, 1.02), (0.0, 1.03, 0.98)];
    for (k, (snr, fsc, bsc)) in cases.iter().enumerate() {
        let mut x = encode_same(&EncodeOpts { fs, header: hdr(), tone: "eas", tone_sec: 3.0, eom: true, freq_scale: *fsc, baud_scale: *bsc, ..Default::default() });
        add_noise(&mut x, *snr, k as u32 + 7);
        let ev = decode(&x, fs, 2048);
        let h = headers(&ev);
        assert_eq!(h.len(), 1, "fs {fs} case {k}: {ev:?}");
        assert_eq!(h[0].0, hdr(), "fs {fs} case {k}");
        let (kind, d) = tone_end(&ev).unwrap_or((Tone::Nwr, 0.0));
        assert!(kind == Tone::Eas && (d - 3.0).abs() < if *snr <= 3.0 { 0.5 } else { 0.2 }, "fs {fs} tone case {k}: {d}");
        assert_eq!(eoms(&ev), 1, "fs {fs} eom case {k}");
    }
}

#[test]
fn noisy_offsets_24k() {
    noisy(24000.0);
}

#[test]
fn noisy_offsets_22k() {
    noisy(22050.0);
}

#[test]
fn vote_repairs_burst() {
    let fs = 24000.0;
    let a = encode_same(&EncodeOpts { fs, header: hdr(), lead_sec: 0.3, ..Default::default() });
    let bad = hdr().replace("TOR", "TQR");
    let b = encode_same(&EncodeOpts { fs, header: bad, lead_sec: 0.0, ..Default::default() });
    let burst = (((16 + hdr().len()) * 8) as f64 * fs / 520.8333).round() as usize + fs as usize;
    let mut d = SameDecoder::with_clock(fs, Box::new(now));
    let mut ev = vec![];
    let lead = (0.3 * fs).round() as usize;
    ev.extend(d.push(&a[..lead]));
    ev.extend(d.push(&b[..burst]));
    ev.extend(d.push(&a[lead + burst..]));
    ev.extend(d.push(&vec![0.0; fs as usize * 5]));
    let h = headers(&ev);
    assert_eq!(h.len(), 1, "{ev:?}");
    assert_eq!(h[0].1.as_ref().unwrap().event, "TOR");
}

#[test]
fn no_false_alarms() {
    let fs = 22050.0;
    let mut x = vec![0.0f32; fs as usize * 60];
    add_noise(&mut x, 0.0, 99);
    for (i, v) in x.iter_mut().enumerate() {
        let i = i as f64;
        *v += (0.2 * (2.0 * std::f64::consts::PI * (180.0 + 40.0 * (i / 3000.0).sin()) * (i / fs)).sin()) as f32;
    }
    let ev = decode(&x, fs, 1000);
    assert!(ev.is_empty(), "{ev:?}");
}

#[test]
fn s16le() {
    let mut carry = None;
    let mut out = vec![];
    let bytes: Vec<u8> = [0i16, 16384, -32768].iter().flat_map(|v| v.to_le_bytes()).collect();
    s16le_to_f32(&mut carry, &bytes[..3], &mut out);
    s16le_to_f32(&mut carry, &bytes[3..], &mut out);
    assert_eq!(out, vec![0.0, 0.5, -1.0]);
}
