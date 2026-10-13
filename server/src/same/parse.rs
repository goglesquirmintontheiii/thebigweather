//! SAME header parsing: ZCZC-ORG-EEE-PSSCCC(-PSSCCC…)+TTTT-JJJHHMM-LLLLLLLL-

use super::codes;
use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SameLocation {
    /// PSSCCC
    pub code: String,
    /// "" = whole area, else "Northwest" …
    pub part: String,
    pub state: String,
    pub county: String,
    /// SSCCC
    pub fips: String,
    pub marine: bool,
    /// human-readable name ("Northwest Canadian Co., OK")
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SameHeader {
    pub raw: String,
    pub org: String,
    pub org_name: String,
    pub event: String,
    pub event_name: String,
    /// emergency | warning | watch | advisory | statement | test | admin
    pub level: String,
    pub locations: Vec<SameLocation>,
    /// TTTT
    pub purge: String,
    pub purge_min: u32,
    pub issued: DateTime<Utc>,
    pub expires: DateTime<Utc>,
    pub sender: String,
}

fn digits(b: &[u8]) -> bool {
    !b.is_empty() && b.iter().all(|c| c.is_ascii_digit())
}

/// Try to parse a header starting exactly at `s` ("ZCZC-…"); returns the header text length too.
fn parse_at(s: &[u8]) -> Option<(usize, [String; 6], Vec<String>)> {
    if !s.starts_with(b"ZCZC-") {
        return None;
    }
    let mut i = 5;
    let org = s.get(i..i + 3)?;
    if !org.iter().all(|c| c.is_ascii_uppercase()) || s.get(i + 3) != Some(&b'-') {
        return None;
    }
    i += 4;
    let ev = s.get(i..i + 3)?;
    if !ev.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) || s.get(i + 3) != Some(&b'-') {
        return None;
    }
    i += 4;
    let mut locs = vec![];
    loop {
        let l = s.get(i..i + 6)?;
        if !digits(l) {
            return None;
        }
        locs.push(String::from_utf8_lossy(l).to_string());
        i += 6;
        if s.get(i) == Some(&b'-') {
            i += 1;
        }
        if s.get(i) == Some(&b'+') {
            i += 1;
            break;
        }
        if locs.len() >= 31 {
            return None;
        }
    }
    let purge = s.get(i..i + 4)?;
    if !digits(purge) || s.get(i + 4) != Some(&b'-') {
        return None;
    }
    i += 5;
    let jt = s.get(i..i + 7)?;
    if !digits(jt) || s.get(i + 7) != Some(&b'-') {
        return None;
    }
    i += 8;
    let start = i;
    while i < s.len() && s[i] != b'-' && i - start < 8 {
        i += 1;
    }
    if i == start || s.get(i) != Some(&b'-') {
        return None;
    }
    let sender = &s[start..i];
    i += 1;
    let f = |b: &[u8]| String::from_utf8_lossy(b).to_string();
    Some((i, [f(org), f(ev), String::new(), f(purge), f(jt), f(sender)], locs))
}

/// Parse a header (leading/trailing junk is ignored). `now` resolves the year of the Julian day.
pub fn parse_header(text: &str, now: DateTime<Utc>) -> Option<SameHeader> {
    let b = text.as_bytes();
    let mut from = 0;
    while let Some(p) = text[from..].find("ZCZC-") {
        let at = from + p;
        if let Some((len, f, locs)) = parse_at(&b[at..]) {
            return build(&text[at..at + len], f, locs, now);
        }
        from = at + 1;
    }
    None
}

fn build(raw: &str, f: [String; 6], locs: Vec<String>, now: DateTime<Utc>) -> Option<SameHeader> {
    let [org, event, _, purge, jt, sender] = f;
    let p_h: u32 = purge[..2].parse().ok()?;
    let p_m: u32 = purge[2..].parse().ok()?;
    let jd: i64 = jt[..3].parse().ok()?;
    let hh: u32 = jt[3..5].parse().ok()?;
    let mm: u32 = jt[5..7].parse().ok()?;
    if !(1..=366).contains(&jd) || hh > 23 || mm > 59 || p_m > 59 {
        return None;
    }
    let mk = |y: i32| Utc.with_ymd_and_hms(y, 1, 1, hh, mm, 0).single().map(|d| d + chrono::Duration::days(jd - 1));
    let mut issued = mk(now.year())?;
    // a header from late December heard in early January (or a skewed clock)
    if (issued - now).num_milliseconds() > 2 * 86_400_000 {
        issued = mk(now.year() - 1)?;
    } else if (now - issued).num_milliseconds() > 300 * 86_400_000 {
        issued = mk(now.year() + 1)?;
    }
    let (event_name, level) = codes::event_info(&event);
    let locations = locs
        .into_iter()
        .map(|c| {
            let state = c[1..3].to_string();
            let county = c[3..].to_string();
            let mut l = SameLocation {
                part: codes::part(c.chars().next().unwrap_or('0')).to_string(),
                marine: codes::marine(&state).is_some(),
                fips: c[1..].to_string(),
                code: c,
                state,
                county,
                name: String::new(),
            };
            l.name = location_name(&l);
            l
        })
        .collect();
    let purge_min = p_h * 60 + p_m;
    Some(SameHeader {
        raw: raw.to_string(),
        org_name: codes::originator(&org).map(str::to_string).unwrap_or_else(|| format!("Unknown originator ({org})")),
        org,
        event,
        event_name,
        level: level.to_string(),
        locations,
        purge,
        purge_min,
        issued,
        expires: issued + chrono::Duration::minutes(purge_min as i64),
        sender: sender.trim().to_string(),
    })
}

/// Human name for a location (same wording as the app).
pub fn location_name(l: &SameLocation) -> String {
    let pre = if l.part.is_empty() { String::new() } else { format!("{} ", l.part) };
    if l.state == "00" {
        return format!("{pre}United States (all)");
    }
    if let Some(m) = codes::marine(&l.state) {
        return format!("{pre}{m} zone {}", l.county);
    }
    let Some((abbr, name)) = codes::state(&l.state) else {
        return format!("{pre}area {}", l.code);
    };
    if l.county == "000" {
        return format!("{pre}{name} (entire state)");
    }
    let Some(n) = codes::county_name(&l.fips) else {
        return format!("{pre}county {}, {abbr}", l.county);
    };
    let low = n.to_ascii_lowercase();
    let suffix = if ["city", "borough", "census area", "municipality", "planning region", "parish"].iter().any(|w| low.contains(w)) || l.state == "72" {
        ""
    } else if l.state == "22" {
        " Parish"
    } else if l.state == "02" {
        ""
    } else {
        " Co."
    };
    format!("{pre}{n}{suffix}, {abbr}")
}

/// Build a header string (tests, self-test).
pub fn build_header(org: &str, event: &str, locations: &[&str], purge: &str, issued: DateTime<Utc>, sender: &str) -> String {
    let jd = issued.ordinal();
    let sender: String = format!("{sender:<8}").chars().take(8).collect();
    format!("ZCZC-{org}-{event}-{}+{purge}-{jd:03}{}-{sender}-", locations.join("-"), issued.format("%H%M"))
}
