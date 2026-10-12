//! European single-site radar volumes (ODIM_H5): site table, listings and file fetching.
//!
//! Sources (verified 2026-10-12):
//! * **EUMETNET OPERA open radar data** — anonymous S3 `https://s3.waw3-1.cloudferro.com/openradar-24h/`,
//!   rolling 24 h, keys `YYYY/MM/DD/{CC}/{site}/{SCAN|PVOL}/{site}@{YYYYMMDDTHHMM}@{elevs _-joined}@{quantities _-joined}.h5`.
//!   Some countries publish one file per sweep (SCAN), some whole volumes (PVOL), some one quantity
//!   per file; files are grouped into volumes by scan cycle (see [`group_files`]).
//! * **FMI Finland** — AWS open data `fmi-opendata-radar-volume-hdf5`, keys
//!   `YYYY/MM/DD/{site}/{YYYYMMDDHHMM}_{site}_PVOL.h5` (~36 MB full dual-pol volumes, archive since 2007).
//! * **DWD Germany** open data (`opendata.dwd.de/weather/radar/sites/sweep_vol_*`) is *not* used:
//!   OPERA already carries the same German sweeps (DBZH/TH/VRADH), and DWD only offers huge flat
//!   HTML directory listings (~2 weeks × 288 × 10 sweeps per moment) with per-sweep second-precise
//!   names, which would cost megabytes per refresh per site.
//!
//! Coverage in the OPERA bucket (moments as published, 2026-10-12):
//! BE, CH, CZ, DE, DK, EE, ES, FI, FR, HR, IE, IS, LT, MT, NL, NO, PL, RO, SE, SK — mostly DBZH/TH/VRADH;
//! NL full dual-pol PVOL (DBZH, VRADH, WRADH, ZDR, RHOHV, PHIDP); PL/NO one quantity per file;
//! ES/NO 10-min cycles with separate Doppler scans.
//! Finland: OPERA (DBZH/TH/VRADH, small) for the last 24 h, FMI (full dual-pol) for older days or
//! when OPERA has nothing. Not covered: GB, PT, HU, SI, GR, RS, LV, IL, MD, AT, IT (not in the bucket).

use super::odim;
use super::service::VolEntry;
use crate::health::Health;
use crate::s3;
use crate::sites::Site;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const OPERA_BASE: &str = "https://s3.waw3-1.cloudferro.com/openradar-24h";
pub const FMI_BASE: &str = "https://fmi-opendata-radar-volume-hdf5.s3.amazonaws.com";
/// Countries present in the OPERA bucket when this was written; used until the first listing.
const OPERA_COUNTRIES: &[&str] = &["BE", "CH", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "HR", "IE", "IS", "LT", "MT", "NL", "NO", "PL", "RO", "SE", "SK"];
const LIST_TTL: Duration = Duration::from_secs(60);
const PAST_LIST_TTL: Duration = Duration::from_secs(1800);
const MIN: i64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Src {
    Opera,
    Fmi,
}

impl Src {
    pub fn id(self) -> &'static str {
        match self {
            Src::Opera => "opera",
            Src::Fmi => "fmi",
        }
    }
    fn parse(s: &str) -> Option<Src> {
        match s {
            "opera" => Some(Src::Opera),
            "fmi" => Some(Src::Fmi),
            _ => None,
        }
    }
    fn health(self) -> (&'static str, &'static str) {
        match self {
            Src::Opera => ("odim-opera", "EUMETNET OPERA radar volumes"),
            Src::Fmi => ("odim-fmi", "FMI Finland radar volumes"),
        }
    }
    fn base(self) -> &'static str {
        match self {
            Src::Opera => OPERA_BASE,
            Src::Fmi => FMI_BASE,
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct Row {
    id: String,
    name: String,
    country: String,
    lat: f64,
    lon: f64,
    elev_m: f64,
    #[serde(default)]
    status: i32,
}

#[derive(serde::Deserialize)]
struct Table {
    sites: Vec<Row>,
}

/// One upstream file.
#[derive(Debug, Clone, PartialEq)]
pub struct FileRef {
    pub key: String,
    pub size: u64,
    pub time_ms: i64,
    /// elevation list as written in the name ("" = whole volume)
    pub elevs: String,
    pub qtys: Vec<String>,
}

/// Files that make up one volume.
#[derive(Debug, Clone)]
pub struct Group {
    pub slot_ms: i64,
    pub time_ms: i64,
    pub files: Vec<FileRef>,
}

fn fmt_slot(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().map(|t| t.format("%Y%m%dT%H%M").to_string()).unwrap_or_default()
}

fn parse_slot(s: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M").ok().map(|d| d.and_utc().timestamp_millis())
}

/// `.../{site}@20261012T0005@0.5_1.5@DBZH_VRADH.h5`
pub fn parse_opera(key: &str, size: u64) -> Option<FileRef> {
    let base = key.rsplit('/').next()?.strip_suffix(".h5")?;
    let p: Vec<&str> = base.split('@').collect();
    if p.len() != 4 {
        return None;
    }
    Some(FileRef { key: key.to_string(), size, time_ms: parse_slot(p[1])?, elevs: p[2].to_string(), qtys: p[3].split('_').map(|s| s.to_string()).collect() })
}

/// `.../{YYYYMMDDHHMM}_{site}_PVOL.h5`
pub fn parse_fmi(key: &str, size: u64) -> Option<FileRef> {
    let base = key.rsplit('/').next()?;
    if !base.ends_with("_PVOL.h5") || base.len() < 12 {
        return None;
    }
    let t = chrono::NaiveDateTime::parse_from_str(&base[..12], "%Y%m%d%H%M").ok()?.and_utc().timestamp_millis();
    Some(FileRef { key: key.to_string(), size, time_ms: t, elevs: String::new(), qtys: vec!["PVOL".into()] })
}

fn median(mut v: Vec<i64>) -> Option<i64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    Some(v[v.len() / 2])
}

/// Scan-cycle length: the typical repeat interval of identical file signatures, in 5-minute
/// steps (5, 10 or 15 min).
pub fn cycle_ms(files: &[FileRef]) -> i64 {
    let mut by_sig: HashMap<(String, String), Vec<i64>> = HashMap::new();
    for f in files {
        by_sig.entry((f.elevs.clone(), f.qtys.join("_"))).or_default().push(f.time_ms);
    }
    let mins: Vec<i64> = by_sig
        .into_values()
        .filter_map(|mut t| {
            t.sort_unstable();
            t.dedup();
            t.windows(2).map(|w| w[1] - w[0]).filter(|d| *d > 0).min()
        })
        .collect();
    let p = median(mins).unwrap_or(5 * MIN);
    ((p as f64 / (5 * MIN) as f64).round().clamp(1.0, 3.0) as i64) * 5 * MIN
}

fn all_vertical(elevs: &str) -> bool {
    let v: Vec<f32> = elevs.split('_').filter_map(|e| e.parse().ok()).collect();
    !v.is_empty() && v.iter().all(|e| *e >= 80.0)
}

/// Group files into volumes. Files without a usable quantity, vertical-only scans and TH files
/// shadowed by a DBZH file of the same elevations are dropped. With `drop_young`, trailing volumes
/// newer than one cycle + 20 min with fewer files than usual (still arriving) are left out.
pub fn group_files(files: Vec<FileRef>, now_ms: i64, drop_young: bool) -> Vec<Group> {
    let files: Vec<FileRef> = files.into_iter().filter(|f| (f.qtys.iter().any(|q| q == "PVOL" || odim::wanted_quantity(q))) && !all_vertical(&f.elevs)).collect();
    let p = cycle_ms(&files);
    let mut slots: BTreeMap<i64, Vec<FileRef>> = BTreeMap::new();
    for f in files {
        slots.entry(f.time_ms.div_euclid(p) * p).or_default().push(f);
    }
    let mut out: Vec<Group> = slots
        .into_iter()
        .map(|(slot, mut fs)| {
            let has_dbz: Vec<String> = fs.iter().filter(|f| f.qtys.iter().any(|q| q == "DBZH" || q == "DBZ")).map(|f| f.elevs.clone()).collect();
            fs.retain(|f| !(f.qtys.iter().all(|q| q == "TH" || q == "T" || !odim::wanted_quantity(q)) && has_dbz.contains(&f.elevs)));
            fs.sort_by(|a, b| a.key.cmp(&b.key));
            Group { slot_ms: slot, time_ms: fs.iter().map(|f| f.time_ms).min().unwrap_or(slot), files: fs }
        })
        .filter(|g| !g.files.is_empty())
        .collect();
    if drop_young {
        while out.len() >= 3 {
            let last = out.last().unwrap();
            if now_ms - last.slot_ms > p + 20 * MIN {
                break;
            }
            let k = out.len();
            let typical = median(out[k.saturating_sub(7)..k - 1].iter().map(|g| g.files.len() as i64).collect()).unwrap_or(0);
            if (last.files.len() as i64) < typical {
                out.pop();
            } else {
                break;
            }
        }
    }
    out
}

#[derive(Default)]
struct DayList {
    fetched: Option<Instant>,
    /// earliest time (ms) the listing covers
    from_ms: i64,
    objects: BTreeMap<String, u64>,
}

pub struct OdimService {
    http: reqwest::Client,
    health: Arc<Health>,
    cache_dir: PathBuf,
    table: Vec<Row>,
    sites: RwLock<Vec<Site>>,
    subdirs: Mutex<HashMap<String, (Instant, Vec<String>)>>,
    lists: Mutex<HashMap<String, DayList>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn safe_name(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

impl OdimService {
    pub fn new(http: reqwest::Client, health: Arc<Health>, cache_dir: PathBuf) -> Arc<Self> {
        let table: Vec<Row> = serde_json::from_str::<Table>(include_str!("odim_sites.json")).map(|t| t.sites).unwrap_or_default();
        for s in [Src::Opera, Src::Fmi] {
            let (id, name) = s.health();
            health.register(id, name, s.base());
        }
        let me = Arc::new(Self { http, health, cache_dir, table, sites: RwLock::new(vec![]), subdirs: Mutex::new(HashMap::new()), lists: Mutex::new(HashMap::new()), locks: Mutex::new(HashMap::new()) });
        let initial: Vec<String> = me.table.iter().filter(|r| r.status == 1 && OPERA_COUNTRIES.contains(&r.country.as_str())).map(|r| r.id.clone()).collect();
        *me.sites.write() = me.build_sites(&initial, &[]);
        me
    }

    fn build_sites(&self, opera: &[String], fmi: &[String]) -> Vec<Site> {
        let mut out: Vec<Site> = self
            .table
            .iter()
            .filter(|r| opera.contains(&r.id) || fmi.contains(&r.id))
            .map(|r| {
                let src = match (opera.contains(&r.id), fmi.contains(&r.id) || r.country == "FI") {
                    (true, true) => "opera+fmi",
                    (true, false) => "opera",
                    _ => "fmi",
                };
                Site {
                    id: r.id.clone(),
                    name: r.name.clone(),
                    state: r.country.clone(),
                    lat: r.lat,
                    lon: r.lon,
                    elev_m: r.elev_m,
                    kind: "ODIM".into(),
                    country: Some(r.country.clone()),
                    region: Some("EU".into()),
                    format: Some("odim".into()),
                    source: Some(src.into()),
                }
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// Published ODIM sites.
    pub fn sites(&self) -> Vec<Site> {
        self.sites.read().clone()
    }

    /// Canonical (lowercase) id if `id` names a European ODIM site.
    pub fn canonical(&self, id: &str) -> Option<String> {
        let id = id.to_ascii_lowercase();
        (id.len() == 5 && self.table.iter().any(|r| r.id == id)).then_some(id)
    }

    fn row(&self, id: &str) -> Option<&Row> {
        self.table.iter().find(|r| r.id == id)
    }

    /// Refresh the published site list from the buckets every hour.
    pub fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) = me.refresh_sites().await {
                    tracing::warn!("ODIM site refresh: {e:#}");
                }
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        });
    }

    async fn refresh_sites(&self) -> Result<()> {
        let now = Utc::now();
        let day = format!("{:04}/{:02}/{:02}/", now.year(), now.month(), now.day());
        let mut opera = vec![];
        let (hid, hname) = Src::Opera.health();
        match s3::list_at(&self.http, OPERA_BASE, &day, Some("/"), None, 1).await {
            Ok(l) => {
                let countries: Vec<String> = l.prefixes.iter().filter_map(|p| p.trim_end_matches('/').rsplit('/').next().map(|s| s.to_string())).filter(|c| c.len() == 2).collect();
                let prefixes: Vec<String> = countries.iter().map(|c| format!("{day}{c}/")).collect();
                let lists = futures::future::join_all(prefixes.iter().map(|p| s3::list_at(&self.http, OPERA_BASE, p, Some("/"), None, 1))).await;
                for l in lists.into_iter().flatten() {
                    opera.extend(l.prefixes.iter().filter_map(|p| p.trim_end_matches('/').rsplit('/').next().map(|s| s.to_ascii_lowercase())));
                }
                self.health.ok(hid, hname, format!("{} sites", opera.len()));
            }
            Err(e) => self.health.err(hid, hname, &e),
        }
        let mut fmi = vec![];
        let (fid, fname) = Src::Fmi.health();
        match s3::list_at(&self.http, FMI_BASE, &day, Some("/"), None, 1).await {
            Ok(l) => {
                fmi = l.prefixes.iter().filter_map(|p| p.trim_end_matches('/').rsplit('/').next().map(|s| s.to_ascii_lowercase())).collect();
                self.health.ok(fid, fname, format!("{} sites", fmi.len()));
            }
            Err(e) => self.health.err(fid, fname, &e),
        }
        if opera.is_empty() && fmi.is_empty() {
            bail!("no ODIM sites listed");
        }
        if opera.is_empty() {
            // keep the OPERA part of the previous list
            opera = self.sites.read().iter().filter(|s| s.source.as_deref().map(|x| x.starts_with("opera")).unwrap_or(false)).map(|s| s.id.clone()).collect();
        }
        let list = self.build_sites(&opera, &fmi);
        if !list.is_empty() {
            *self.sites.write() = list;
        }
        Ok(())
    }

    fn lock(&self, k: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().entry(k.to_string()).or_default().clone()
    }

    /// OPERA object-type directories (PVOL / SCAN) a site uses on a day.
    async fn opera_dirs(&self, site: &str, cc: &str, day: NaiveDate) -> Result<Vec<String>> {
        let k = format!("{site}/{day}");
        if let Some((t, v)) = self.subdirs.lock().get(&k) {
            if t.elapsed() < Duration::from_secs(if v.is_empty() { 300 } else { 3600 }) {
                return Ok(v.clone());
            }
        }
        let prefix = format!("{}/{cc}/{site}/", day.format("%Y/%m/%d"));
        let l = s3::list_at(&self.http, OPERA_BASE, &prefix, Some("/"), None, 1).await?;
        let v: Vec<String> = l.prefixes.into_iter().filter(|p| p.ends_with("PVOL/") || p.ends_with("SCAN/")).collect();
        self.subdirs.lock().insert(k, (Instant::now(), v.clone()));
        Ok(v)
    }

    /// Objects of a site on a UTC day from `from_ms` on (listing cached; refreshed incrementally).
    async fn day_files(&self, src: Src, site: &str, day: NaiveDate, from_ms: i64) -> Result<Vec<FileRef>> {
        let day_start = day.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
        let day_end = day_start + 86_400_000;
        let now = Utc::now().timestamp_millis();
        let need_from = from_ms.clamp(day_start, day_end);
        let lk = format!("{}/{site}/{day}", src.id());
        let ttl = if now > day_end + 2 * 3_600_000 { PAST_LIST_TTL } else { LIST_TTL };
        let _g = self.lock(&lk).lock_owned().await;
        let (fresh, cov_from, latest) = {
            let l = self.lists.lock();
            match l.get(&lk) {
                Some(d) => (d.fetched.map(|t| t.elapsed() < ttl).unwrap_or(false), d.from_ms, d.objects.keys().filter_map(|k| self.parse(src, k, 0)).map(|f| f.time_ms).max()),
                None => (false, i64::MAX, None),
            }
        };
        if !(fresh && cov_from <= need_from) {
            // list from the earliest needed time (or 30 min before the newest file we have)
            let start = if cov_from > need_from { need_from } else { latest.map(|t| t - 30 * MIN).unwrap_or(cov_from).max(cov_from) };
            let (hid, hname) = src.health();
            let res = self.list_from(src, site, day, start, day_start).await;
            match res {
                Ok(objs) => {
                    self.health.ok(hid, hname, src.base());
                    let mut l = self.lists.lock();
                    let d = l.entry(lk.clone()).or_default();
                    if d.fetched.is_none() {
                        d.from_ms = i64::MAX;
                    }
                    d.objects.extend(objs);
                    d.from_ms = d.from_ms.min(start);
                    d.fetched = Some(Instant::now());
                }
                Err(e) => {
                    self.health.err(hid, hname, &e);
                    if !self.lists.lock().contains_key(&lk) {
                        return Err(e);
                    }
                }
            }
            // forget listings of days that left the window
            let cutoff = (Utc::now() - chrono::Duration::days(3)).date_naive();
            self.lists.lock().retain(|k, _| k.rsplit('/').next().and_then(|d| d.parse::<NaiveDate>().ok()).map(|d| d >= cutoff).unwrap_or(false) || k == &lk);
        }
        let l = self.lists.lock();
        Ok(l.get(&lk).map(|d| d.objects.iter().filter_map(|(k, s)| self.parse(src, k, *s)).collect()).unwrap_or_default())
    }

    fn parse(&self, src: Src, key: &str, size: u64) -> Option<FileRef> {
        match src {
            Src::Opera => parse_opera(key, size),
            Src::Fmi => parse_fmi(key, size),
        }
    }

    async fn list_from(&self, src: Src, site: &str, day: NaiveDate, start_ms: i64, day_start: i64) -> Result<Vec<(String, u64)>> {
        let start = (start_ms > day_start).then(|| Utc.timestamp_millis_opt(start_ms).single()).flatten();
        let mut out = vec![];
        match src {
            Src::Opera => {
                let cc = self.row(site).map(|r| r.country.clone()).ok_or_else(|| anyhow!("unknown site {site}"))?;
                for dir in self.opera_dirs(site, &cc, day).await? {
                    let sa = start.map(|t| format!("{dir}{site}@{}", t.format("%Y%m%dT%H%M")));
                    let v = s3::list_after(&self.http, OPERA_BASE, &dir, sa.as_deref(), 15).await?;
                    out.extend(v.into_iter().map(|o| (o.key, o.size)));
                }
            }
            Src::Fmi => {
                let prefix = format!("{}/{site}/", day.format("%Y/%m/%d"));
                let sa = start.map(|t| format!("{prefix}{}", t.format("%Y%m%d%H%M")));
                let v = s3::list_after(&self.http, FMI_BASE, &prefix, sa.as_deref(), 3).await?;
                out.extend(v.into_iter().map(|o| (o.key, o.size)));
            }
        }
        Ok(out)
    }

    fn entries(src: Src, site: &str, groups: &[Group]) -> Vec<VolEntry> {
        groups
            .iter()
            .map(|g| VolEntry { key: format!("odim:{}:{site}:{}", src.id(), fmt_slot(g.slot_ms)), time: g.time_ms, size: g.files.iter().map(|f| f.size).sum(), source: src.id() })
            .collect()
    }

    async fn groups_between(&self, src: Src, site: &str, from_ms: i64, to_ms: i64, drop_young: bool) -> Result<Vec<Group>> {
        let mut files = vec![];
        let mut d = Utc.timestamp_millis_opt(from_ms).single().ok_or_else(|| anyhow!("bad time"))?.date_naive();
        let last = Utc.timestamp_millis_opt(to_ms).single().ok_or_else(|| anyhow!("bad time"))?.date_naive();
        let mut err = None;
        while d <= last {
            match self.day_files(src, site, d, from_ms).await {
                Ok(f) => files.extend(f),
                Err(e) => err = Some(e),
            }
            d = d.succ_opt().unwrap();
        }
        if files.is_empty() {
            if let Some(e) = err {
                return Err(e);
            }
        }
        files.retain(|f| f.time_ms >= from_ms && f.time_ms < to_ms);
        let mut g = group_files(files, Utc::now().timestamp_millis(), drop_young);
        // the first slot may have been cut by `from_ms`
        if g.len() > 1 && g[0].slot_ms < from_ms {
            g.remove(0);
        }
        Ok(g)
    }

    /// Newest `n` volumes.
    pub async fn latest(&self, site: &str, n: usize) -> Result<Vec<VolEntry>> {
        let now = Utc::now().timestamp_millis();
        let span = ((n.max(2) as i64) * 15 * MIN + 20 * MIN).min(2 * 86_400_000);
        let mut out = vec![];
        let mut last_err = None;
        for src in self.sources_for(site, None) {
            match self.groups_between(src, site, now - span, now + MIN, true).await {
                Ok(g) if !g.is_empty() => {
                    out = Self::entries(src, site, &g);
                    break;
                }
                Ok(_) => {}
                Err(e) => last_err = Some(e),
            }
        }
        if out.is_empty() {
            if let Some(e) = last_err {
                return Err(e);
            }
        }
        let k = out.len().saturating_sub(n);
        Ok(out.split_off(k))
    }

    /// Volumes on a UTC day.
    pub async fn day(&self, site: &str, y: i32, m: u32, d: u32) -> Result<Vec<VolEntry>> {
        let day = NaiveDate::from_ymd_opt(y, m, d).ok_or_else(|| anyhow!("bad date"))?;
        let start = day.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
        let mut last_err = None;
        for src in self.sources_for(site, Some(start)) {
            match self.groups_between(src, site, start, start + 86_400_000, true).await {
                Ok(g) if !g.is_empty() => return Ok(Self::entries(src, site, &g)),
                Ok(_) => {}
                Err(e) => last_err = Some(e),
            }
        }
        match last_err {
            Some(e) => Err(e),
            None => Ok(vec![]),
        }
    }

    /// Sources to try, in order, for a site (and day start for history requests).
    fn sources_for(&self, site: &str, day_start: Option<i64>) -> Vec<Src> {
        let fi = self.row(site).map(|r| r.country == "FI").unwrap_or(false);
        let recent = day_start.map(|t| Utc::now().timestamp_millis() - t < 2 * 86_400_000).unwrap_or(true);
        match (fi, recent) {
            (true, true) => vec![Src::Opera, Src::Fmi],
            (true, false) => vec![Src::Fmi],
            (false, true) => vec![Src::Opera],
            (false, false) => vec![],
        }
    }

    /// Files of the volume behind an `odim:<source>:<site>:<YYYYMMDDTHHMM>` key.
    pub async fn resolve(&self, key: &str) -> Result<(Src, String, Vec<FileRef>)> {
        let (src, site, slot) = parse_key(key).ok_or_else(|| anyhow!("bad ODIM key"))?;
        let g = self.groups_between(src, &site, slot - 90 * MIN, slot + 30 * MIN, false).await?;
        let g = g.into_iter().find(|g| g.slot_ms == slot).ok_or_else(|| anyhow!("volume not found (expired?)"))?;
        Ok((src, site, g.files))
    }

    /// Download (disk-cached) all files of a volume, 6 at a time.
    pub async fn fetch(&self, src: Src, files: &[FileRef]) -> Result<Vec<Bytes>> {
        use futures::StreamExt;
        let keys: Vec<String> = files.iter().map(|f| f.key.clone()).collect();
        let res: Vec<Result<Bytes>> = futures::stream::iter(keys).map(|k| async move { self.fetch_one(src, &k).await }).buffered(6).collect().await;
        let mut out = vec![];
        let mut last = None;
        for r in res {
            match r {
                Ok(b) => out.push(b),
                Err(e) => last = Some(e),
            }
        }
        if out.is_empty() {
            return Err(last.unwrap_or_else(|| anyhow!("no files")));
        }
        Ok(out)
    }

    async fn fetch_one(&self, src: Src, key: &str) -> Result<Bytes> {
        let path = self.cache_dir.join(safe_name(&format!("{}_{key}", src.id())));
        if let Ok(b) = tokio::fs::read(&path).await {
            return Ok(Bytes::from(b));
        }
        let url = format!("{}/{key}", src.base());
        let r = self.http.get(&url).send().await?;
        if !r.status().is_success() {
            bail!("{} {key}: HTTP {}", src.id(), r.status());
        }
        let b = r.bytes().await?;
        let tmp = path.with_extension("part");
        if tokio::fs::write(&tmp, &b).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &path).await;
        }
        Ok(b)
    }
}

/// `odim:<source>:<site>:<YYYYMMDDTHHMM>` → (source, site, slot ms)
pub fn parse_key(key: &str) -> Option<(Src, String, i64)> {
    let mut p = key.strip_prefix("odim:")?.split(':');
    let src = Src::parse(p.next()?)?;
    let site = p.next()?.to_ascii_lowercase();
    let slot = parse_slot(p.next()?)?;
    if site.len() != 5 || !site.chars().all(|c| c.is_ascii_alphanumeric()) || p.next().is_some() {
        return None;
    }
    Some((src, site, slot))
}

/// Has this volume's scan cycle certainly finished uploading (safe to cache forever)?
pub fn settled(key: &str) -> bool {
    parse_key(key).map(|(_, _, t)| Utc::now().timestamp_millis() - t > 40 * MIN).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(name: &str) -> FileRef {
        parse_opera(&format!("2026/10/12/XX/site/SCAN/{name}"), 100).unwrap()
    }

    #[test]
    fn site_table_parses() {
        let t: Table = serde_json::from_str(include_str!("odim_sites.json")).unwrap();
        assert!(t.sites.len() > 150);
        let d = t.sites.iter().find(|r| r.id == "deess").unwrap();
        assert_eq!(d.country, "DE");
        assert!((d.lat - 51.4).abs() < 0.1 && d.elev_m > 0.0 && d.status == 1 && !d.name.is_empty());
        assert!(t.sites.iter().all(|r| r.id.len() == 5));
    }

    #[test]
    fn names_and_keys() {
        let x = f("deess@20261012T0005@0.5@DBZH.h5");
        assert_eq!(x.elevs, "0.5");
        assert_eq!(x.qtys, vec!["DBZH"]);
        assert_eq!(fmt_slot(x.time_ms), "20261012T0005");
        let y = parse_fmi("2026/10/12/fikor/202610120035_fikor_PVOL.h5", 5).unwrap();
        assert_eq!(fmt_slot(y.time_ms), "20261012T0035");
        let (s, site, t) = parse_key("odim:opera:deess:20261012T0005").unwrap();
        assert_eq!((s, site.as_str(), t), (Src::Opera, "deess", x.time_ms));
        assert!(parse_key("odim:opera:../x:20261012T0005").is_none());
        assert!(parse_key("odim:dwd:deess:20261012T0005").is_none());
    }

    #[test]
    fn grouping_by_cycle() {
        // Germany: per-sweep, per-quantity files, all stamped with the volume time; TH shadowed
        let mut de = vec![];
        for t in ["0000", "0005", "0010"] {
            for e in ["0.5", "1.5", "90.0"] {
                for q in ["DBZH", "TH", "VRADH"] {
                    de.push(f(&format!("deess@20261012T{t}@{e}@{q}.h5")));
                }
            }
        }
        let now = de[0].time_ms + 3 * 3_600_000;
        let g = group_files(de.clone(), now, true);
        assert_eq!(g.len(), 3);
        assert_eq!(g[0].files.len(), 4, "TH dropped, 90° dropped: {:?}", g[0].files);
        // newest still arriving: dropped while young
        let mut young = de.clone();
        young.retain(|x| !(fmt_slot(x.time_ms) == "20261012T0010" && x.elevs == "1.5"));
        assert_eq!(group_files(young.clone(), de[0].time_ms + 12 * MIN, true).len(), 2);
        assert_eq!(group_files(young, de[0].time_ms + 12 * MIN, false).len(), 3);
        // France: sweeps stamped with their own minute inside a 5-min cycle
        let fr: Vec<FileRef> = ["0000@7.5", "0001@0.9", "0002@1.51", "0004@0.4", "0005@6.5", "0006@0.9", "0007@1.51", "0009@0.4"].iter().map(|s| f(&format!("frabb@20261012T{s}@DBZH_TH_VRADH.h5"))).collect();
        let g = group_files(fr, now, false);
        assert_eq!(g.len(), 2);
        assert_eq!(g[1].files.len(), 4);
        // Spain: 10-min cycle, long-range at :00 and Doppler at :07 → one volume
        let es: Vec<FileRef> = ["0000@0.5_1.3_2.1@DBZH_TH", "0007@0.5_1.5@DBZH_VRADH", "0010@0.5_1.3_2.1@DBZH_TH", "0017@0.5_1.5@DBZH_VRADH"].iter().map(|s| f(&format!("esahr@20261012T{s}.h5"))).collect();
        assert_eq!(cycle_ms(&es), 10 * MIN);
        let g = group_files(es, now, false);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].files.len(), 2);
        assert_eq!(fmt_slot(g[1].slot_ms), "20261012T0010");
    }
}
