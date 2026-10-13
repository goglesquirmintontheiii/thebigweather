//! Automatic model reports: a detection that persists for N consecutive cycles (radar volumes for
//! cells — matched by track id —, runs for grid areas — matched by overlap) becomes a report
//! (`ml_report` on `/ws`). Open reports are updated while the object persists and closed when it
//! disappears. Storage: `data/ml/reports/open.json` + one JSON-lines file per month of closed
//! reports.

use super::model::ModelRecord;
use super::runner::Detection;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackPt {
    pub t: i64,
    pub lat: f64,
    pub lon: f64,
    pub prob: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub model_id: String,
    pub model_name: String,
    pub target: String,
    /// cell | area | point
    pub kind: String,
    pub site: Option<String>,
    pub first_t: i64,
    pub last_t: i64,
    pub max_prob: f64,
    /// highest level reached (low | med | high)
    pub level: String,
    pub cycles: u32,
    pub track: Vec<TrackPt>,
    /// last area outline (lon, lat)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ring: Vec<[f64; 2]>,
    pub open: bool,
    pub created: i64,
    pub updated: i64,
}

/// An object being followed (reported or not yet).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Obj {
    key: String,
    model_id: String,
    scope: String,
    count: u32,
    last_t: i64,
    /// the cell id / area ring used for matching
    cell: Option<String>,
    ring: Vec<[f64; 2]>,
    rep: Report,
    reported: bool,
}

pub struct Reports {
    dir: PathBuf,
    objs: Mutex<HashMap<String, Obj>>,
    /// recently closed (served without reading the month files)
    recent: Mutex<VecDeque<Report>>,
    hub: Option<crate::hub::Hub>,
    seq: std::sync::atomic::AtomicU64,
}

fn level_rank(l: &str) -> u8 {
    match l {
        "high" => 3,
        "med" => 2,
        "low" => 1,
        _ => 0,
    }
}

fn month_of(t: i64) -> String {
    chrono::DateTime::from_timestamp_millis(t).map(|d| d.format("%Y-%m").to_string()).unwrap_or_else(|| "0000-00".into())
}

impl Reports {
    pub fn open(dir: PathBuf, hub: Option<crate::hub::Hub>) -> Reports {
        std::fs::create_dir_all(&dir).ok();
        let objs: HashMap<String, Obj> = std::fs::read(dir.join("open.json")).ok().and_then(|b| serde_json::from_slice::<Vec<Obj>>(&b).ok()).unwrap_or_default().into_iter().map(|o| (o.key.clone(), o)).collect();
        Reports { dir, objs: Mutex::new(objs), recent: Mutex::new(VecDeque::new()), hub, seq: std::sync::atomic::AtomicU64::new(0) }
    }

    fn save_open(&self, g: &HashMap<String, Obj>) {
        let v: Vec<&Obj> = g.values().filter(|o| o.reported).collect();
        if let Ok(b) = serde_json::to_vec(&v) {
            crate::platform::write_atomic(&self.dir.join("open.json"), &b).ok();
        }
    }

    fn close(&self, mut o: Obj) {
        if !o.reported {
            return;
        }
        o.rep.open = false;
        o.rep.updated = chrono::Utc::now().timestamp_millis();
        let p = self.dir.join(format!("{}.jsonl", month_of(o.rep.first_t)));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            if let Ok(line) = serde_json::to_string(&o.rep) {
                let _ = writeln!(f, "{line}");
            }
        }
        if let Some(h) = &self.hub {
            h.send(json!({"type": "ml_report", "action": "closed", "report": o.rep}));
        }
        let mut r = self.recent.lock();
        r.push_back(o.rep);
        while r.len() > 5000 {
            r.pop_front();
        }
    }

    /// One cycle of a model in a scope (a radar site, or "grid"): its detections now.
    pub fn observe(&self, m: &ModelRecord, scope: &str, dets: &[&Detection], n: u32) {
        let now = chrono::Utc::now().timestamp_millis();
        let mut g = self.objs.lock();
        let mut seen: Vec<String> = vec![];
        let mut events: Vec<(&'static str, Report)> = vec![];
        for d in dets {
            // the object this detection continues: same track (cells) or overlapping area
            let found = g
                .values()
                .filter(|o| o.model_id == m.id && o.scope == scope && !seen.contains(&o.key))
                .find(|o| match (&d.cell_id, &o.cell) {
                    (Some(c), Some(oc)) => c == oc,
                    _ if d.kind == "area" && !o.ring.is_empty() => {
                        let ring: Vec<[f32; 2]> = o.ring.iter().map(|q| [q[0] as f32, q[1] as f32]).collect();
                        let dring: Vec<[f32; 2]> = d.rings.first().map(|r| r.iter().map(|q| [q[0] as f32, q[1] as f32]).collect()).unwrap_or_default();
                        let (olat, olon) = (o.rep.track.last().map(|p| p.lat).unwrap_or(0.0), o.rep.track.last().map(|p| p.lon).unwrap_or(0.0));
                        super::labels::point_in_poly(d.lat, d.lon, &ring) || (!dring.is_empty() && super::labels::point_in_poly(olat, olon, &dring))
                    }
                    _ => false,
                })
                .map(|o| o.key.clone());
            // a gap of more than 20 min (cells) / 3 runs (areas) starts a new object
            let key = match found {
                Some(k) if d.t - g[&k].last_t <= if d.kind == "area" { 6 * 3_600_000 } else { 20 * 60_000 } || d.t < g[&k].last_t => k,
                Some(k) => {
                    if let Some(o) = g.remove(&k) {
                        self.close(o);
                    }
                    format!("{}|{scope}|{}", m.id, d.id)
                }
                None => format!("{}|{scope}|{}", m.id, d.id),
            };
            let pt = TrackPt { t: d.t, lat: (d.lat * 1e4).round() / 1e4, lon: (d.lon * 1e4).round() / 1e4, prob: (d.prob * 1000.0).round() / 1000.0 };
            let o = g.entry(key.clone()).or_insert_with(|| Obj {
                key: key.clone(),
                model_id: m.id.clone(),
                scope: scope.to_string(),
                count: 0,
                last_t: d.t,
                cell: d.cell_id.clone(),
                ring: vec![],
                rep: Report { id: String::new(), model_id: m.id.clone(), model_name: m.name.clone(), target: m.target.clone(), kind: d.kind.to_string(), site: d.site.clone(), first_t: d.t, last_t: d.t, max_prob: 0.0, level: d.level.to_string(), cycles: 0, track: vec![], ring: vec![], open: true, created: now, updated: now },
                reported: false,
            });
            if o.count > 0 && d.t <= o.last_t {
                // the same cycle twice (several levels / frames): keep the strongest
                o.rep.max_prob = o.rep.max_prob.max(d.prob);
                seen.push(key);
                continue;
            }
            o.count += 1;
            o.last_t = d.t;
            o.cell = d.cell_id.clone().or(o.cell.take());
            if let Some(r) = d.rings.first() {
                o.ring = r.clone();
                o.rep.ring = r.clone();
            }
            o.rep.last_t = d.t;
            o.rep.cycles = o.count;
            o.rep.max_prob = o.rep.max_prob.max(d.prob);
            if level_rank(d.level) > level_rank(&o.rep.level) {
                o.rep.level = d.level.to_string();
            }
            o.rep.track.push(pt);
            if o.rep.track.len() > 500 {
                o.rep.track.remove(0);
            }
            o.rep.updated = now;
            if !o.reported && o.count >= n {
                o.reported = true;
                o.rep.id = format!("r{}-{}", super::model::radix36(now as u64), self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
                events.push(("new", o.rep.clone()));
            } else if o.reported {
                events.push(("update", o.rep.clone()));
            }
            seen.push(key);
        }
        // objects of this model / scope not seen this cycle have ended
        let gone: Vec<String> = g.values().filter(|o| o.model_id == m.id && o.scope == scope && !seen.contains(&o.key)).map(|o| o.key.clone()).collect();
        let changed = !events.is_empty() || gone.iter().any(|k| g[k].reported);
        for k in gone {
            if let Some(o) = g.remove(&k) {
                self.close(o);
            }
        }
        if changed {
            self.save_open(&g);
        }
        drop(g);
        if let Some(h) = &self.hub {
            for (action, r) in events {
                h.send(json!({"type": "ml_report", "action": action, "report": r}));
            }
        }
    }

    /// A model stopped running: close its open reports.
    pub fn close_model(&self, id: &str) {
        let mut g = self.objs.lock();
        let keys: Vec<String> = g.values().filter(|o| o.model_id == id).map(|o| o.key.clone()).collect();
        for k in keys {
            if let Some(o) = g.remove(&k) {
                self.close(o);
            }
        }
        self.save_open(&g);
    }

    /// Reports overlapping [from, to] (ms), optionally in a bbox / of some models.
    pub fn query(&self, from: Option<i64>, to: Option<i64>, bbox: Option<[f64; 4]>, models: &[String], limit: usize) -> Vec<Report> {
        let now = chrono::Utc::now().timestamp_millis();
        let (a, b) = (from.unwrap_or(now - 7 * 86_400_000), to.unwrap_or(now + 86_400_000));
        let mut out: Vec<Report> = self.objs.lock().values().filter(|o| o.reported).map(|o| o.rep.clone()).collect();
        // closed reports: the month files of the range (plus the in-memory recent ones)
        let mut seen: std::collections::HashSet<String> = out.iter().map(|r| r.id.clone()).collect();
        let mut m = chrono::DateTime::from_timestamp_millis(a).map(|d| d.date_naive()).unwrap_or_default().with_day0(0).unwrap_or_default();
        let end = chrono::DateTime::from_timestamp_millis(b).map(|d| d.date_naive()).unwrap_or_default();
        let mut guard = 0;
        while m <= end && guard < 240 {
            guard += 1;
            let p = self.dir.join(format!("{}.jsonl", m.format("%Y-%m")));
            if let Ok(txt) = std::fs::read_to_string(&p) {
                for l in txt.lines() {
                    if let Ok(r) = serde_json::from_str::<Report>(l) {
                        if seen.insert(r.id.clone()) {
                            out.push(r);
                        }
                    }
                }
            }
            m = m.checked_add_months(chrono::Months::new(1)).unwrap_or(end + chrono::Duration::days(1));
        }
        for r in self.recent.lock().iter() {
            if seen.insert(r.id.clone()) {
                out.push(r.clone());
            }
        }
        out.retain(|r| r.last_t >= a && r.first_t <= b && (models.is_empty() || models.contains(&r.model_id)) && bbox.map(|[w, s, e, n]| r.track.iter().any(|p| p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n)).unwrap_or(true));
        out.sort_by_key(|r| std::cmp::Reverse(r.first_t));
        if limit > 0 {
            out.truncate(limit);
        }
        out
    }
}

use chrono::Datelike;

/// GeoJSON of reports: a LineString (track) or Polygon (area) per report, plus its start point.
pub fn to_geojson(rs: &[Report]) -> Value {
    let mut feats = vec![];
    for r in rs {
        let mut p = serde_json::to_value(r).unwrap_or_default();
        if let Some(o) = p.as_object_mut() {
            o.remove("track");
            o.remove("ring");
        }
        p["points"] = json!(r.track.len());
        let geom = if !r.ring.is_empty() {
            json!({"type": "Polygon", "coordinates": [r.ring]})
        } else if r.track.len() >= 2 {
            json!({"type": "LineString", "coordinates": r.track.iter().map(|q| [q.lon, q.lat]).collect::<Vec<_>>()})
        } else {
            let q = r.track.first().cloned().unwrap_or(TrackPt { t: 0, lat: 0.0, lon: 0.0, prob: 0.0 });
            json!({"type": "Point", "coordinates": [q.lon, q.lat]})
        };
        p["track_times"] = json!(r.track.iter().map(|q| q.t).collect::<Vec<_>>());
        feats.push(json!({"type": "Feature", "id": r.id, "geometry": geom, "properties": p}));
    }
    json!({"type": "FeatureCollection", "features": feats, "count": rs.len()})
}

/// CSV of reports (one row per report; the track as `lat lon` pairs).
pub fn to_csv(rs: &[Report]) -> String {
    let iso = |t: i64| chrono::DateTime::from_timestamp_millis(t).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default();
    let mut s = String::from("id,model_id,model_name,target,kind,site,first_t,last_t,cycles,max_prob,level,start_lat,start_lon,end_lat,end_lon,track\n");
    let q = |x: &str| format!("\"{}\"", x.replace('"', "\"\""));
    for r in rs {
        let (a, b) = (r.track.first(), r.track.last());
        let tr: Vec<String> = r.track.iter().map(|p| format!("{} {}", p.lat, p.lon)).collect();
        s.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            r.id,
            r.model_id,
            q(&r.model_name),
            r.target,
            r.kind,
            r.site.clone().unwrap_or_default(),
            iso(r.first_t),
            iso(r.last_t),
            r.cycles,
            r.max_prob,
            r.level,
            a.map(|p| p.lat).unwrap_or(f64::NAN),
            a.map(|p| p.lon).unwrap_or(f64::NAN),
            b.map(|p| p.lat).unwrap_or(f64::NAN),
            b.map(|p| p.lon).unwrap_or(f64::NAN),
            q(&tr.join(";"))
        ));
    }
    s
}
