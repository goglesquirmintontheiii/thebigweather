//! ODIM_H5 polar volume (PVOL) / single-sweep (SCAN) decoder producing the same [`Volume`] the
//! Level II decoder builds, so every radar endpoint (sweeps, meta, rotation, 3D, cross-sections,
//! derived products) works on European volumes unchanged.
//!
//! * one file may hold any number of `datasetN` (elevations) × `dataM` (quantities);
//!   several files (one quantity or one elevation per file) are merged with [`assemble`]
//! * quantities: DBZH (DBZ, TH, T fallbacks) → REF, VRADH/VRAD → VEL (`how/NI` → Nyquist),
//!   WRADH/WRAD → SW, ZDR → ZDR, RHOHV → RHO, PHIDP (UPHIDP) → PHI, KDP → KDP
//! * every gate is re-quantized to 8 bits with the Level II convention
//!   (value = (raw − offset) / scale, raw 0 = no data / undetect), see [`quant`]
//! * azimuths from `how/startazA`/`stopazA` when present, else ray i is centred at
//!   (i + ½)·360/nrays; ray times from `startazT`/`stopazT`, else interpolated from the dataset
//!   start/end times starting at `a1gate`

use super::level2::{Moment, MomentData, Radial, Sweep, Volume};
use anyhow::{anyhow, bail, Result};
use hdf5_reader::group::Group;
use hdf5_reader::{Datatype, Hdf5File};

pub fn is_hdf5(b: &[u8]) -> bool {
    b.len() > 8 && &b[..8] == b"\x89HDF\r\n\x1a\n"
}

/// ODIM quantity → (moment, preference; lower wins when a dataset holds several).
fn map_quantity(q: &str) -> Option<(Moment, u8)> {
    Some(match q.trim().to_ascii_uppercase().as_str() {
        "DBZH" => (Moment::Ref, 0),
        "DBZ" => (Moment::Ref, 1),
        "TH" => (Moment::Ref, 2),
        "T" => (Moment::Ref, 3),
        "VRADH" => (Moment::Vel, 0),
        "VRAD" => (Moment::Vel, 1),
        "VRADDH" => (Moment::Vel, 2),
        "VRADV" => (Moment::Vel, 3),
        "WRADH" => (Moment::Sw, 0),
        "WRAD" => (Moment::Sw, 1),
        "ZDR" => (Moment::Zdr, 0),
        "RHOHV" => (Moment::Rho, 0),
        "PHIDP" => (Moment::Phi, 0),
        "UPHIDP" => (Moment::Phi, 1),
        "KDP" => (Moment::Kdp, 0),
        _ => return None,
    })
}

/// Is an ODIM quantity name one this decoder uses?
pub fn wanted_quantity(q: &str) -> bool {
    map_quantity(q).is_some()
}

/// 8-bit quantization per moment: byte = value·scale + offset (clamped 2..=255, 0 = no data).
/// REF/VEL/SW/ZDR/RHO match Level II's 8-bit encodings.
pub fn quant(m: Moment) -> (f32, f32) {
    match m {
        Moment::Ref => (2.0, 66.0),        // −32 … 94.5 dBZ, 0.5 dB
        Moment::Vel => (2.0, 129.0),       // −63.5 … 63 m/s, 0.5 m/s
        Moment::Sw => (2.0, 129.0),        // 0 … 63 m/s
        Moment::Zdr => (16.0, 128.0),      // −7.9 … 7.9 dB
        Moment::Rho => (300.0, -60.5),     // 0.208 … 1.052
        Moment::Phi => (0.7, 2.0),         // 0 … 361°, wrapped to 0..360
        Moment::Kdp => (10.0, 40.0),       // −3.8 … 21.5 °/km
        Moment::Cfp => (1.0, 8.0),
    }
}

#[inline]
fn q8(m: Moment, v: f64, (s, o): (f32, f32)) -> u8 {
    if !v.is_finite() {
        return 0;
    }
    let v = if m == Moment::Phi { v.rem_euclid(360.0) } else { v } as f32;
    (v * s + o).round().clamp(2.0, 255.0) as u8
}

fn attr(chain: &[Option<&Group>], name: &str) -> Option<hdf5_reader::Attribute> {
    chain.iter().flatten().find_map(|g| g.attribute(name).ok())
}

fn attr_f64(chain: &[Option<&Group>], name: &str) -> Option<f64> {
    attr(chain, name)?.read_as_f64().ok()
}

fn attr_str(chain: &[Option<&Group>], name: &str) -> Option<String> {
    let a = attr(chain, name)?;
    a.read_string().ok().or_else(|| a.read_strings().ok().and_then(|v| v.into_iter().next())).map(|s| s.trim_end_matches('\0').trim().to_string())
}

fn attr_vec(chain: &[Option<&Group>], name: &str) -> Option<Vec<f64>> {
    let a = attr(chain, name)?;
    a.read_1d::<f64>().ok().or_else(|| a.read_1d::<f32>().ok().map(|v| v.into_iter().map(|x| x as f64).collect()))
}

/// "YYYYMMDD" + "HHMMSS" → unix ms.
pub fn odim_time(date: &str, time: &str) -> Option<i64> {
    let t = if time.len() >= 6 { &time[..6] } else { time };
    chrono::NaiveDateTime::parse_from_str(&format!("{date}{t:0<6}"), "%Y%m%d%H%M%S").ok().map(|d| d.and_utc().timestamp_millis())
}

enum Raw {
    U8(Vec<u8>),
    U16(Vec<u16>),
    F(Vec<f64>),
}

fn read_raw(ds: &hdf5_reader::Dataset) -> Result<Raw> {
    macro_rules! rd {
        ($t:ty) => {
            ds.read_array::<$t>().map_err(|e| anyhow!("hdf5 read: {e}"))?.iter().map(|&v| v as f64).collect()
        };
    }
    Ok(match ds.dtype() {
        Datatype::FixedPoint { size: 1, signed: false, .. } => Raw::U8(ds.read_array::<u8>().map_err(|e| anyhow!("hdf5 read: {e}"))?.iter().copied().collect()),
        Datatype::FixedPoint { size: 2, signed: false, .. } => Raw::U16(ds.read_array::<u16>().map_err(|e| anyhow!("hdf5 read: {e}"))?.iter().copied().collect()),
        Datatype::FixedPoint { size: 1, signed: true, .. } => Raw::F(rd!(i8)),
        Datatype::FixedPoint { size: 2, signed: true, .. } => Raw::F(rd!(i16)),
        Datatype::FixedPoint { size: 4, signed: true, .. } => Raw::F(rd!(i32)),
        Datatype::FixedPoint { size: 4, signed: false, .. } => Raw::F(rd!(u32)),
        Datatype::FloatingPoint { size: 8, .. } => Raw::F(rd!(f64)),
        Datatype::FloatingPoint { .. } => Raw::F(rd!(f32)),
        d => bail!("unsupported ODIM data type {d:?}"),
    })
}

/// One elevation of one file before merging (gates already quantized).
#[derive(Debug, Clone)]
pub struct DsInfo {
    pub elev: f32,
    pub nrays: usize,
    pub start_ms: i64,
    pub end_ms: i64,
    pub a1gate: usize,
    /// per-row azimuth centre (deg) and acquisition time (ms)
    pub az: Vec<f32>,
    pub times: Vec<i64>,
    pub nyquist: f32,
    /// (moment, ngates, first gate centre m, gate spacing m, rows × ngates bytes)
    pub moments: Vec<(Moment, usize, f32, f32, Vec<u8>)>,
}

/// Everything one ODIM file contributes to a volume.
#[derive(Debug, Clone, Default)]
pub struct Part {
    /// `NOD:` code from /what/source (e.g. "deess"), may be empty
    pub nod: String,
    pub lat: f32,
    pub lon: f32,
    pub height_m: f32,
    pub datasets: Vec<DsInfo>,
}

fn nod_of(source: &str) -> String {
    source.split(',').find_map(|kv| kv.trim().strip_prefix("NOD:").map(|s| s.trim().to_string())).unwrap_or_default()
}

/// Decode one ODIM_H5 file (PVOL or SCAN).
pub fn decode(bytes: &[u8]) -> Result<Part> {
    let f = Hdf5File::from_bytes(bytes).map_err(|e| anyhow!("hdf5: {e}"))?;
    let rwhat = f.group("/what").ok();
    let rwhere = f.group("/where").ok();
    let rhow = f.group("/how").ok();
    let object = attr_str(&[rwhat.as_ref()], "object").unwrap_or_default();
    if !object.is_empty() && object != "PVOL" && object != "SCAN" {
        bail!("ODIM object {object} is not a polar volume/scan");
    }
    let mut part = Part {
        nod: nod_of(&attr_str(&[rwhat.as_ref()], "source").unwrap_or_default()),
        lat: attr_f64(&[rwhere.as_ref()], "lat").unwrap_or(0.0) as f32,
        lon: attr_f64(&[rwhere.as_ref()], "lon").unwrap_or(0.0) as f32,
        height_m: attr_f64(&[rwhere.as_ref()], "height").unwrap_or(0.0) as f32,
        datasets: vec![],
    };
    let root_t = attr_str(&[rwhat.as_ref()], "date").zip(attr_str(&[rwhat.as_ref()], "time")).and_then(|(d, t)| odim_time(&d, &t)).unwrap_or(0);
    for n in 1..=128 {
        let Ok(dg) = f.group(&format!("/dataset{n}")) else { break };
        let dwhat = dg.group("what").ok();
        let dwhere = dg.group("where").ok();
        let dhow = dg.group("how").ok();
        let product = attr_str(&[dwhat.as_ref()], "product").unwrap_or_else(|| "SCAN".into());
        if product != "SCAN" {
            continue;
        }
        let wch = [dwhere.as_ref(), rwhere.as_ref()];
        let Some(elev) = attr_f64(&wch, "elangle") else { continue };
        let nbins_w = attr_f64(&wch, "nbins").unwrap_or(0.0) as usize;
        let nrays_w = attr_f64(&wch, "nrays").unwrap_or(0.0) as usize;
        let rstart_km = attr_f64(&wch, "rstart").unwrap_or(0.0);
        let rscale = attr_f64(&wch, "rscale").unwrap_or(0.0);
        let a1gate = attr_f64(&wch, "a1gate").unwrap_or(0.0).max(0.0) as usize;
        let tch = [dwhat.as_ref(), rwhat.as_ref()];
        let start_ms = attr_str(&tch, "startdate").zip(attr_str(&tch, "starttime")).and_then(|(d, t)| odim_time(&d, &t)).unwrap_or(root_t);
        let end_ms = attr_str(&tch, "enddate").zip(attr_str(&tch, "endtime")).and_then(|(d, t)| odim_time(&d, &t)).unwrap_or(start_ms).max(start_ms);
        let hch = [dhow.as_ref(), rhow.as_ref()];
        // best data group per moment
        let mut best: Vec<(Moment, u8, String)> = vec![];
        for m in 1..=64 {
            let Ok(g) = dg.group(&format!("data{m}")) else { break };
            let gw = g.group("what").ok();
            let Some(q) = attr_str(&[gw.as_ref(), dwhat.as_ref(), rwhat.as_ref()], "quantity") else { continue };
            let Some((mom, pri)) = map_quantity(&q) else { continue };
            match best.iter_mut().find(|b| b.0 == mom) {
                Some(b) if b.1 <= pri => {}
                Some(b) => *b = (mom, pri, format!("data{m}")),
                None => best.push((mom, pri, format!("data{m}"))),
            }
        }
        if best.is_empty() || rscale <= 0.0 {
            continue;
        }
        let mut moments = vec![];
        let mut nrays = nrays_w;
        let mut nyq = attr_f64(&hch, "NI").unwrap_or(0.0) as f32;
        for (mom, _, path) in &best {
            let g = dg.group(path).map_err(|e| anyhow!("{path}: {e}"))?;
            let gw = g.group("what").ok();
            let ch = [gw.as_ref(), dwhat.as_ref(), rwhat.as_ref()];
            let gain = attr_f64(&ch, "gain").unwrap_or(1.0);
            let offset = attr_f64(&ch, "offset").unwrap_or(0.0);
            let nodata = attr_f64(&ch, "nodata");
            let undetect = attr_f64(&ch, "undetect");
            let Ok(ds) = g.dataset("data") else { continue };
            let shape = ds.shape().to_vec();
            if shape.len() != 2 || shape[0] == 0 || shape[1] == 0 {
                continue;
            }
            let (rows, bins) = (shape[0] as usize, shape[1] as usize);
            if nrays == 0 {
                nrays = rows;
            }
            if rows != nrays {
                continue;
            }
            let q = quant(*mom);
            let miss = |raw: f64, s: Option<f64>| s.map(|s| (raw - s).abs() <= 1e-6 * s.abs().max(1.0)).unwrap_or(false);
            let conv = |raw: f64| -> u8 {
                if miss(raw, nodata) || miss(raw, undetect) {
                    0
                } else {
                    q8(*mom, raw * gain + offset, q)
                }
            };
            let bytes: Vec<u8> = match read_raw(&ds)? {
                Raw::U8(v) => {
                    let lut: Vec<u8> = (0..256).map(|r| conv(r as f64)).collect();
                    v.iter().map(|&r| lut[r as usize]).collect()
                }
                Raw::U16(v) => {
                    let lut: Vec<u8> = (0..65536).map(|r| conv(r as f64)).collect();
                    v.iter().map(|&r| lut[r as usize]).collect()
                }
                Raw::F(v) => v.iter().map(|&r| if r.is_finite() { conv(r) } else { 0 }).collect(),
            };
            if *mom == Moment::Vel && nyq <= 0.0 && offset < 0.0 {
                // VRAD is usually scaled to span ±NI
                nyq = (-offset) as f32;
            }
            let _ = nbins_w;
            moments.push((*mom, bins, (rstart_km * 1000.0 + rscale / 2.0) as f32, rscale as f32, bytes));
        }
        if moments.is_empty() || nrays == 0 {
            continue;
        }
        let dth = 360.0 / nrays as f64;
        let az: Vec<f32> = match (attr_vec(&hch, "startazA"), attr_vec(&hch, "stopazA")) {
            (Some(a), Some(b)) if a.len() == nrays && b.len() == nrays => a
                .iter()
                .zip(&b)
                .map(|(&s, &e)| (s + (e - s).rem_euclid(360.0) / 2.0).rem_euclid(360.0) as f32)
                .collect(),
            _ => (0..nrays).map(|i| ((i as f64 + 0.5) * dth) as f32).collect(),
        };
        let times: Vec<i64> = match (attr_vec(&hch, "startazT"), attr_vec(&hch, "stopazT")) {
            (Some(a), Some(b)) if a.len() == nrays && b.len() == nrays && a[0] > 1e8 => a.iter().zip(&b).map(|(&s, &e)| ((s + e) / 2.0 * 1000.0) as i64).collect(),
            _ => (0..nrays)
                .map(|i| {
                    let k = (i + nrays - a1gate % nrays) % nrays;
                    start_ms + ((end_ms - start_ms) as f64 * k as f64 / nrays as f64) as i64
                })
                .collect(),
        };
        part.datasets.push(DsInfo { elev: elev as f32, nrays, start_ms, end_ms, a1gate: a1gate % nrays, az, times, nyquist: nyq, moments });
    }
    if part.datasets.is_empty() {
        bail!("no usable sweeps in ODIM file");
    }
    Ok(part)
}

impl DsInfo {
    fn into_sweep(self, elev_num: u8) -> Sweep {
        let n = self.nrays;
        // radials in acquisition order (times ascending), like Level II
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&i| (self.times[i], (i + n - self.a1gate) % n));
        let spacing = 360.0 / n as f32;
        let mut radials = Vec::with_capacity(n);
        for (k, &i) in order.iter().enumerate() {
            let moments = self
                .moments
                .iter()
                .map(|(m, ng, first, gate, bytes)| {
                    let (s, o) = quant(*m);
                    MomentData { moment: *m, ngates: (*ng).min(u16::MAX as usize) as u16, first_gate_m: *first, gate_m: *gate, word_size: 8, scale: s, offset: o, data: bytes[i * ng..(i + 1) * ng].to_vec() }
                })
                .collect();
            radials.push(Radial {
                time_ms: self.times[i],
                azimuth: self.az[i],
                elevation: self.elev,
                az_spacing: spacing,
                status: if k == 0 { 0 } else if k + 1 == n { 2 } else { 1 },
                elev_num,
                nyquist: self.nyquist,
                moments,
            });
        }
        Sweep { elev_num, radials, complete: true }
    }
}

/// Merge decoded files into one volume. Datasets at the same elevation with the same ray count
/// that started within 3 minutes of each other and carry different moments become one sweep
/// (one-quantity-per-file countries); everything else stays a separate sweep (the tilt grouping
/// merges split cuts later). Vertical-pointing scans (≥ 80°) are dropped.
pub fn assemble(site: &str, parts: Vec<Part>) -> Result<Volume> {
    let mut v = Volume { site: site.to_string(), version: "ODIM_H5".into(), complete: true, ..Default::default() };
    if let Some(p) = parts.iter().find(|p| p.lat != 0.0 || p.lon != 0.0) {
        v.lat = p.lat;
        v.lon = p.lon;
        v.height_m = p.height_m;
    }
    if v.site.is_empty() {
        v.site = parts.iter().map(|p| p.nod.clone()).find(|s| !s.is_empty()).unwrap_or_default();
    }
    let mut all: Vec<DsInfo> = parts.into_iter().flat_map(|p| p.datasets).filter(|d| d.elev < 80.0 && d.elev > -3.0).collect();
    all.sort_by(|a, b| a.elev.partial_cmp(&b.elev).unwrap_or(std::cmp::Ordering::Equal).then(a.start_ms.cmp(&b.start_ms)));
    let mut merged: Vec<DsInfo> = vec![];
    for d in all {
        if let Some(t) = merged.iter_mut().find(|t| {
            (t.elev - d.elev).abs() < 0.05 && t.nrays == d.nrays && (t.start_ms - d.start_ms).abs() <= 180_000 && d.moments.iter().all(|m| !t.moments.iter().any(|x| x.0 == m.0))
        }) {
            if t.nyquist <= 0.0 {
                t.nyquist = d.nyquist;
            }
            t.moments.extend(d.moments);
        } else {
            merged.push(d);
        }
    }
    if merged.is_empty() {
        bail!("no sweeps in ODIM volume");
    }
    v.header_time_ms = merged.iter().map(|d| d.start_ms).min().unwrap_or(0);
    v.sweeps = merged.into_iter().enumerate().map(|(i, d)| d.into_sweep((i + 1).min(255) as u8)).collect();
    Ok(v)
}


/// Decode and assemble a set of files of one volume (in parallel).
pub fn decode_volume(site: &str, files: &[bytes::Bytes]) -> Result<Volume> {
    use rayon::prelude::*;
    let parts: Vec<Result<Part>> = files.par_iter().map(|b| decode(b)).collect();
    let mut ok = vec![];
    let mut last_err = None;
    for p in parts {
        match p {
            Ok(p) => ok.push(p),
            Err(e) => last_err = Some(e),
        }
    }
    if ok.is_empty() {
        return Err(last_err.unwrap_or_else(|| anyhow!("no ODIM files")));
    }
    if let Some(e) = last_err {
        tracing::debug!("ODIM {site}: skipped a file: {e:#}");
    }
    assemble(site, ok)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::radar::level2::tilts;
    use hdf5_writer::{AttributeBuilder, DatasetBuilder, Hdf5Builder, WriteOptions};

    pub struct SynthDs {
        pub elev: f64,
        pub nrays: usize,
        pub nbins: usize,
        pub rscale: f64,
        pub start: &'static str,
        pub az_arrays: bool,
        /// (quantity, gain, offset, nodata, undetect, raw fn(ray, bin))
        pub data: Vec<(&'static str, f64, f64, f64, f64, fn(usize, usize) -> u8)>,
    }

    /// Write a synthetic ODIM PVOL (u8 data) with hdf5-writer.
    pub fn synth_file(object: &str, nod: &str, ds: &[SynthDs]) -> Vec<u8> {
        let mut b = Hdf5Builder::new()
            .group_attribute("what", AttributeBuilder::fixed_string("object", object))
            .group_attribute("what", AttributeBuilder::fixed_string("version", "H5rad 2.3"))
            .group_attribute("what", AttributeBuilder::fixed_string("date", "20261012"))
            .group_attribute("what", AttributeBuilder::fixed_string("time", "120000"))
            .group_attribute("what", AttributeBuilder::fixed_string("source", &format!("WMO:10410,NOD:{nod},PLC:Test")))
            .group_attribute("where", AttributeBuilder::scalar("lat", 51.4f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("lon", 6.96f64).unwrap())
            .group_attribute("where", AttributeBuilder::scalar("height", 185.0f64).unwrap());
        for (i, d) in ds.iter().enumerate() {
            let n = i + 1;
            let g = format!("dataset{n}");
            b = b
                .group_attribute(&format!("{g}/what"), AttributeBuilder::fixed_string("product", "SCAN"))
                .group_attribute(&format!("{g}/what"), AttributeBuilder::fixed_string("startdate", "20261012"))
                .group_attribute(&format!("{g}/what"), AttributeBuilder::fixed_string("starttime", d.start))
                .group_attribute(&format!("{g}/what"), AttributeBuilder::fixed_string("enddate", "20261012"))
                .group_attribute(&format!("{g}/what"), AttributeBuilder::fixed_string("endtime", "120030"))
                .group_attribute(&format!("{g}/where"), AttributeBuilder::scalar("elangle", d.elev).unwrap())
                .group_attribute(&format!("{g}/where"), AttributeBuilder::scalar("nbins", d.nbins as i64).unwrap())
                .group_attribute(&format!("{g}/where"), AttributeBuilder::scalar("nrays", d.nrays as i64).unwrap())
                .group_attribute(&format!("{g}/where"), AttributeBuilder::scalar("rstart", 0.0f64).unwrap())
                .group_attribute(&format!("{g}/where"), AttributeBuilder::scalar("rscale", d.rscale).unwrap())
                .group_attribute(&format!("{g}/where"), AttributeBuilder::scalar("a1gate", 90i64).unwrap())
                .group_attribute(&format!("{g}/how"), AttributeBuilder::scalar("NI", 32.0f64).unwrap());
            if d.az_arrays {
                let st: Vec<f64> = (0..d.nrays).map(|r| r as f64 * 360.0 / d.nrays as f64 + 0.1).collect();
                let sp: Vec<f64> = (0..d.nrays).map(|r| (r + 1) as f64 * 360.0 / d.nrays as f64 + 0.1).collect();
                b = b
                    .group_attribute(&format!("{g}/how"), AttributeBuilder::vector("startazA", &st).unwrap())
                    .group_attribute(&format!("{g}/how"), AttributeBuilder::vector("stopazA", &sp).unwrap());
            }
            for (m, (q, gain, off, nodata, undet, f)) in d.data.iter().enumerate() {
                let p = format!("{g}/data{}", m + 1);
                let raw: Vec<u8> = (0..d.nrays * d.nbins).map(|k| f(k / d.nbins, k % d.nbins)).collect();
                b = b
                    .dataset(DatasetBuilder::typed_data(format!("{p}/data"), vec![d.nrays as u64, d.nbins as u64], &raw).unwrap().chunked(vec![d.nrays as u64, d.nbins as u64]))
                    .group_attribute(&format!("{p}/what"), AttributeBuilder::fixed_string("quantity", q))
                    .group_attribute(&format!("{p}/what"), AttributeBuilder::scalar("gain", *gain).unwrap())
                    .group_attribute(&format!("{p}/what"), AttributeBuilder::scalar("offset", *off).unwrap())
                    .group_attribute(&format!("{p}/what"), AttributeBuilder::scalar("nodata", *nodata).unwrap())
                    .group_attribute(&format!("{p}/what"), AttributeBuilder::scalar("undetect", *undet).unwrap());
            }
        }
        b.into_plan().unwrap().encode(WriteOptions::default()).unwrap()
    }

    fn dbz_raw(ray: usize, bin: usize) -> u8 {
        // dBZ = raw·0.5 − 32 → 40 dBZ = raw 144 in rays 80..100 (az 80–100°), bins 100..150
        if bin == 0 {
            255 // nodata
        } else if (80..100).contains(&ray) && (100..150).contains(&bin) {
            144
        } else if bin > 300 {
            0 // undetect
        } else {
            74 // 5 dBZ
        }
    }
    fn vel_raw(ray: usize, _bin: usize) -> u8 {
        // VRADH gain 0.25 offset −32: approaching west, receding east
        if ray < 180 {
            168 // +10 m/s
        } else {
            88 // −10 m/s
        }
    }
    fn zdr_raw(_: usize, _: usize) -> u8 {
        // gain 0.0625, offset −8 → 1.5 dB = raw 152
        152
    }

    pub fn synth_pvol() -> Vec<u8> {
        synth_file(
            "PVOL",
            "tstrd",
            &[
                SynthDs { elev: 0.5, nrays: 360, nbins: 400, rscale: 500.0, start: "120000", az_arrays: true, data: vec![("TH", 0.5, -32.0, 255.0, 0.0, dbz_raw), ("DBZH", 0.5, -32.0, 255.0, 0.0, dbz_raw), ("VRADH", 0.25, -32.0, 255.0, 0.0, vel_raw), ("SQIH", 1.0, 0.0, 255.0, 0.0, zdr_raw)] },
                SynthDs { elev: 1.5, nrays: 360, nbins: 400, rscale: 500.0, start: "120030", az_arrays: false, data: vec![("DBZH", 0.5, -32.0, 255.0, 0.0, dbz_raw)] },
                SynthDs { elev: 90.0, nrays: 360, nbins: 100, rscale: 500.0, start: "120100", az_arrays: false, data: vec![("DBZH", 0.5, -32.0, 255.0, 0.0, dbz_raw)] },
            ],
        )
    }

    #[test]
    fn decode_pvol_and_merge_split_files() {
        let pvol = synth_pvol();
        assert!(is_hdf5(&pvol));
        let p = decode(&pvol).unwrap();
        assert_eq!(p.nod, "tstrd");
        assert_eq!(p.datasets.len(), 3);
        let d0 = &p.datasets[0];
        assert_eq!(d0.moments.len(), 2, "DBZH preferred over TH, SQIH ignored");
        assert!((d0.nyquist - 32.0).abs() < 1e-3);
        assert!((d0.az[0] - 0.6).abs() < 1e-3, "from startazA/stopazA: {}", d0.az[0]);
        assert!((p.datasets[1].az[0] - 0.5).abs() < 1e-3);
        // a separate one-quantity SCAN file (ZDR at 0.5°) merges into the 0.5° sweep
        let scan = synth_file("SCAN", "tstrd", &[SynthDs { elev: 0.5, nrays: 360, nbins: 400, rscale: 500.0, start: "120000", az_arrays: false, data: vec![("ZDR", 0.0625, -8.0, 255.0, 0.0, zdr_raw)] }]);
        let v = decode_volume("tstrd", &[bytes::Bytes::from(pvol), bytes::Bytes::from(scan)]).unwrap();
        assert_eq!(v.site, "tstrd");
        assert!((v.lat - 51.4).abs() < 1e-4 && (v.height_m - 185.0).abs() < 1e-3);
        assert_eq!(v.sweeps.len(), 2, "90° scan dropped, ZDR merged");
        let t = tilts(&v);
        assert_eq!(t.len(), 2);
        assert!(t[0].sweeps.contains_key("REF") && t[0].sweeps.contains_key("VEL") && t[0].sweeps.contains_key("ZDR"));
        assert_eq!(t[1].angle, 1.5);
        let s = &v.sweeps[0];
        assert_eq!(s.radials.len(), 360);
        // acquisition order starts at a1gate (ray 90)
        assert!((s.radials[0].azimuth - 90.6).abs() < 1e-3, "{}", s.radials[0].azimuth);
        assert!(s.radials[0].time_ms <= s.radials[359].time_ms);
        let r = s.radials.iter().find(|r| (r.azimuth - 90.6).abs() < 0.01).unwrap();
        let refl = r.moment(Moment::Ref).unwrap();
        assert_eq!(refl.first_gate_m, 250.0);
        assert_eq!(refl.gate_m, 500.0);
        assert_eq!(refl.value(0), None, "nodata");
        assert_eq!(refl.value(120), Some(40.0));
        assert_eq!(refl.value(200), Some(5.0));
        assert_eq!(refl.value(350), None, "undetect");
        let vel = r.moment(Moment::Vel).unwrap();
        assert_eq!(vel.value(10), Some(10.0));
        assert_eq!(r.nyquist, 32.0);
        let zdr = r.moment(Moment::Zdr).unwrap();
        assert_eq!(zdr.value(10), Some(1.5));
        // encodes like any Level II sweep
        let e = crate::radar::encode::encode_l2(&v, s, Moment::Ref).unwrap();
        assert_eq!(&e.bytes[0..4], b"TBWS");
    }
}

#[cfg(test)]
mod fixtures {
    /// `cargo test --release write_odim_fixture -- --ignored` writes a small synthetic ODIM PVOL
    /// (site "tstrd", DBZH/VRADH at 0.5°, DBZH at 1.5°) for manual API tests via /api/radar/upload.
    #[test]
    #[ignore]
    fn write_odim_fixture() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/fixtures/odim");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tstrd_synthetic_pvol.h5"), super::tests::synth_pvol()).unwrap();
    }
}
