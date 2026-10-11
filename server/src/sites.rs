//! Radar site table: embedded fallback, refreshed from NCEI HOMR when reachable.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Site {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub state: String,
    pub lat: f64,
    pub lon: f64,
    pub elev_m: f64,
    /// NEXRAD | TDWR
    #[serde(rename = "type")]
    pub kind: String,
}

impl Site {
    /// 3-letter id used by Level III products
    pub fn l3_id(&self) -> String {
        if self.id.len() == 4 {
            self.id[1..].to_string()
        } else {
            self.id.clone()
        }
    }
}

const EMBEDDED: &str = include_str!("../data/sites.json");

pub fn embedded() -> Vec<Site> {
    serde_json::from_str(EMBEDDED).unwrap_or_default()
}

/// Parse NCEI HOMR nexrad-stations.txt (fixed width, whitespace separated).
pub fn parse_homr(text: &str) -> Vec<Site> {
    let mut out = vec![];
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 10 {
            continue;
        }
        let kind = *t.last().unwrap();
        if kind != "NEXRAD" && kind != "TDWR" {
            continue;
        }
        let n = t.len();
        let (Ok(lat), Ok(lon), Ok(elev)) = (t[n - 5].parse::<f64>(), t[n - 4].parse::<f64>(), t[n - 3].parse::<f64>()) else {
            continue;
        };
        let icao = t[2];
        if icao.len() != 4 {
            continue;
        }
        let country_idx = t.iter().position(|w| *w == "UNITED").unwrap_or(n - 5);
        let name = t[3..country_idx].join(" ");
        let state = t.get(country_idx + 2).map(|s| s.to_string()).unwrap_or_default();
        out.push(Site {
            id: icao.to_string(),
            name: titlecase(&name),
            state: if state.len() == 2 { state } else { String::new() },
            lat,
            lon,
            elev_m: (elev * 0.3048 * 10.0).round() / 10.0,
            kind: kind.to_string(),
        });
    }
    out
}

fn titlecase(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Merge refreshed names/coordinates into the embedded list (keeps sites HOMR lacks).
pub fn merge(mut base: Vec<Site>, fresh: Vec<Site>) -> Vec<Site> {
    for f in fresh {
        if let Some(b) = base.iter_mut().find(|b| b.id == f.id) {
            b.name = f.name;
            b.state = f.state;
            b.lat = f.lat;
            b.lon = f.lon;
            b.elev_m = f.elev_m;
            b.kind = f.kind;
        } else {
            base.push(f);
        }
    }
    base.sort_by(|a, b| a.id.cmp(&b.id));
    base
}
