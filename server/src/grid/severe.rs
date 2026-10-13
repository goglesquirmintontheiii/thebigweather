//! Severe-weather parameter maps (SPC mesoanalysis style) computed per grid cell from HRRR
//! (`wrfsfc`, decimated to ~6 km) or RAP (`awp130pgrb`, 13 km) fields.
//!
//! Layers: `svr/<src>/<param>` (src = hrrr | rap), group "Severe parameters". Frame keys:
//! `svr|<model>|<run>|<fh>|<param>`; the input fields are cached as ordinary grids under
//! `svrf|<model>|<run>|<fh>|<idx pattern>` so parameters sharing inputs download them once.
//!
//! Formulas (all per cell; NaN where an input is missing):
//! * CAPE / CIN: model fields (`CAPE:surface`, `CAPE:90-0 mb` = ML, `CAPE:255-0 mb` = MU,
//!   `CAPE:0-3000 m` = 3CAPE).
//! * LCL height (m AGL): HRRR `HGT:level of adiabatic condensation from sfc` − `HGT:surface`;
//!   RAP: Espy, 125 m × (T₂ − Td₂).
//! * Bulk shear 0–1 / 0–6 km: HRRR `VUCSH/VVCSH` (RAP has 0–6 km only; 0–1 km from the
//!   profile). 0–3 km: |V(3 km AGL) − V(10 m)| from pressure-level winds interpolated in height.
//!   Shear layers are in kt.
//! * SRH 0–1 / 0–3 km: model `HLCY` (Bunkers motion).
//! * Effective-ish layer (no parcel lifting here): surface-based when SBCAPE ≥ 100 J/kg and
//!   SBCIN ≥ −250 J/kg → ESRH = SRH 0–3 (ESRH01 = SRH 0–1), EBWD = 0–6 km shear; elevated when
//!   only MUCAPE ≥ 100 and MUCIN ≥ −250 → ESRH = SRH 0–3 − SRH 0–1 (≈ 1–3 km layer), ESRH01 = 0,
//!   EBWD = 0–6 km shear; otherwise 0.
//! * STP (fixed) = SBCAPE/1500 · (2000−LCL)/1000 · SRH1/150 · BWD6/20 (LCL term 1 below 1000 m,
//!   0 above 2000 m; BWD6 term 0 below 12.5 m/s, 1.5 above 30 m/s).
//! * STP (effective, CIN) = MLCAPE/1500 · (2000−LCL)/1000 · ESRH/150 · EBWD/20 · (200+MLCIN)/150
//!   (CIN term 1 above −50, 0 below −200; surface LCL stands in for the ML LCL).
//! * SCP = MUCAPE/1000 · ESRH/50 · EBWD/20 · (−40/MUCIN) (EBWD term 0 below 10 m/s, 1 above
//!   20 m/s; CIN term 1 above −40).
//! * SHIP = MUCAPE · MR · LR75 · (−T500) · BWD6 / 42 000 000 (MR = 2 m mixing ratio g/kg clamped
//!   11–13.6, T500 ≤ −5.5 °C, BWD6 7–27 m/s; × MUCAPE/1300 below 1300, × LR75/5.8 below 5.8,
//!   × FZL/2400 below 2400 m AGL).
//! * Lapse rates (°C/km): 0–3 km from T₂ and T at 3 km AGL; 700–500 mb from T and Z at both.
//! * DCAPE: the minimum-θe pressure level within the lowest 400 hPa (above ground) descends
//!   pseudo-adiabatically from its wet-bulb temperature to the surface;
//!   DCAPE = Rd ∫ (T_env − T_parcel) d ln p (virtual temperature ignored).
//! * θe (K): Bolton (1980) from T₂, Td₂ and surface pressure. PWAT (mm): model field.
//!
//! Profiles: HRRR levels 1000/925/850/700/500 mb (T, Td, U, V, Z; Z at 925 mb is estimated
//! hypsometrically), RAP 1000–500 mb every 50 mb (T, RH → Td, U, V, Z). Levels below ground are
//! skipped. This is far coarser than SPC's hourly RAP soundings: treat values as guidance.

use super::sources::LayerDef;
use super::Grid;
use serde_json::json;

pub struct Param {
    pub id: &'static str,
    pub name: &'static str,
    pub units: &'static str,
    pub cmap: &'static str,
    /// contour (interval, base) for `/api/grid/contours`
    pub contour: (f32, f32),
}

pub const PARAMS: &[Param] = &[
    Param { id: "stp", name: "Significant Tornado Parameter (fixed layer)", units: "", cmap: "STP", contour: (1.0, 0.0) },
    Param { id: "stpe", name: "Significant Tornado Parameter (effective, CIN)", units: "", cmap: "STP", contour: (1.0, 0.0) },
    Param { id: "scp", name: "Supercell Composite Parameter", units: "", cmap: "SCP", contour: (2.0, 0.0) },
    Param { id: "ship", name: "Significant Hail Parameter", units: "", cmap: "SHIP", contour: (0.5, 0.0) },
    Param { id: "sbcape", name: "Surface-Based CAPE", units: "J/kg", cmap: "CAPE", contour: (500.0, 0.0) },
    Param { id: "mlcape", name: "Mixed-Layer CAPE", units: "J/kg", cmap: "CAPE", contour: (500.0, 0.0) },
    Param { id: "mucape", name: "Most-Unstable CAPE", units: "J/kg", cmap: "CAPE", contour: (500.0, 0.0) },
    Param { id: "cape3", name: "0–3 km CAPE (3CAPE)", units: "J/kg", cmap: "CAPE", contour: (25.0, 0.0) },
    Param { id: "sbcin", name: "Surface-Based CIN", units: "J/kg", cmap: "CIN", contour: (25.0, 0.0) },
    Param { id: "mlcin", name: "Mixed-Layer CIN", units: "J/kg", cmap: "CIN", contour: (25.0, 0.0) },
    Param { id: "lcl", name: "LCL Height", units: "m", cmap: "LCL", contour: (250.0, 0.0) },
    Param { id: "shear01", name: "0–1 km Bulk Shear", units: "kt", cmap: "SHEAR", contour: (10.0, 0.0) },
    Param { id: "shear03", name: "0–3 km Bulk Shear", units: "kt", cmap: "SHEAR", contour: (10.0, 0.0) },
    Param { id: "shear06", name: "0–6 km Bulk Shear", units: "kt", cmap: "SHEAR", contour: (10.0, 0.0) },
    Param { id: "ebwd", name: "Effective-ish Bulk Shear", units: "kt", cmap: "SHEAR", contour: (10.0, 0.0) },
    Param { id: "srh01", name: "0–1 km Storm-Relative Helicity", units: "m²/s²", cmap: "SRH", contour: (50.0, 0.0) },
    Param { id: "srh03", name: "0–3 km Storm-Relative Helicity", units: "m²/s²", cmap: "SRH", contour: (50.0, 0.0) },
    Param { id: "esrh01", name: "Effective-ish SRH 0–1 km", units: "m²/s²", cmap: "SRH", contour: (50.0, 0.0) },
    Param { id: "esrh", name: "Effective-ish SRH (0–3 km)", units: "m²/s²", cmap: "SRH", contour: (50.0, 0.0) },
    Param { id: "lr03", name: "0–3 km Lapse Rate", units: "°C/km", cmap: "LAPSE", contour: (0.5, 0.0) },
    Param { id: "lr75", name: "700–500 mb Lapse Rate", units: "°C/km", cmap: "LAPSE", contour: (0.5, 0.0) },
    Param { id: "dcape", name: "Downdraft CAPE (approx.)", units: "J/kg", cmap: "DCAPE", contour: (200.0, 0.0) },
    Param { id: "pwat", name: "Precipitable Water", units: "mm", cmap: "PWAT", contour: (5.0, 0.0) },
    Param { id: "thetae", name: "Surface Theta-E", units: "K", cmap: "THETAE", contour: (4.0, 0.0) },
];

pub const SOURCES: &[(&str, &str)] = &[("hrrr", "HRRR"), ("rap", "RAP")];

/// Composite overlay presets (fill layer + contour layers) listed in the catalog.
pub fn composites() -> serde_json::Value {
    let mut out = vec![];
    for (src, sname) in SOURCES {
        let l = |p: &str| format!("svr/{src}/{p}");
        out.push(json!({"id": format!("{src}-stp-srh"), "name": format!("{sname}: STP + 0–1 km SRH"), "fill": l("stpe"), "contours": [{"layer": l("srh01"), "interval": 50, "base": 0}]}));
        out.push(json!({"id": format!("{src}-scp-ebwd"), "name": format!("{sname}: SCP + effective shear"), "fill": l("scp"), "contours": [{"layer": l("ebwd"), "interval": 10, "base": 0}]}));
        out.push(json!({"id": format!("{src}-mlcape-cin"), "name": format!("{sname}: MLCAPE + MLCIN"), "fill": l("mlcape"), "contours": [{"layer": l("mlcin"), "interval": 50, "base": 0}]}));
        out.push(json!({"id": format!("{src}-ship-lr75"), "name": format!("{sname}: SHIP + 700–500 mb lapse rate"), "fill": l("ship"), "contours": [{"layer": l("lr75"), "interval": 0.5, "base": 0}]}));
    }
    json!(out)
}

pub fn param(id: &str) -> Option<&'static Param> {
    PARAMS.iter().find(|p| p.id == id)
}

pub fn layers() -> Vec<LayerDef> {
    let mut v = vec![];
    for (src, sname) in SOURCES {
        for p in PARAMS {
            v.push(LayerDef {
                id: format!("svr/{src}/{}", p.id),
                group: "Severe parameters".into(),
                name: format!("{sname} · {}", p.name),
                units: p.units,
                cmap: p.cmap,
                product: p.id.into(),
                source: "svr",
                model: Some(src.to_string()),
                step_min: 60,
                contour: Some(json!({"interval": p.contour.0, "base": p.contour.1})),
                ..Default::default()
            });
        }
    }
    v
}

/// Max grid dimension for a source's input fields (HRRR 1799×1059 → ~900×530).
pub fn max_dim(model: &str) -> usize {
    if model == "hrrr" { 900 } else { 0 }
}

// ---------- inputs ----------

const SB_CAPE: &str = "CAPE:surface";
const SB_CIN: &str = "CIN:surface";
const ML_CAPE: &str = "CAPE:90-0 mb above ground";
const ML_CIN: &str = "CIN:90-0 mb above ground";
const MU_CAPE: &str = "CAPE:255-0 mb above ground";
const MU_CIN: &str = "CIN:255-0 mb above ground";
const CAPE3: &str = "CAPE:0-3000 m above ground";
const HGT_LCL: &str = "HGT:level of adiabatic condensation from sfc";
const HGT_SFC: &str = "HGT:surface";
const HGT_0C: &str = "HGT:0C isotherm";
const PWAT: &str = "PWAT:entire atmosphere";
const T2: &str = "TMP:2 m above ground";
const TD2: &str = "DPT:2 m above ground";
const PSFC: &str = "PRES:surface";
const U10: &str = "UGRD:10 m above ground";
const V10: &str = "VGRD:10 m above ground";
const SH1U: &str = "VUCSH:0-1000 m above ground";
const SH1V: &str = "VVCSH:0-1000 m above ground";
const SH6U: &str = "VUCSH:0-6000 m above ground";
const SH6V: &str = "VVCSH:0-6000 m above ground";
const SRH1: &str = "HLCY:1000-0 m above ground";
const SRH3: &str = "HLCY:3000-0 m above ground";

/// Pressure levels (hPa) of the profile used for interpolation.
pub fn profile_levels(model: &str) -> &'static [u32] {
    if model == "rap" { &[1000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500] } else { &[1000, 925, 850, 700, 500] }
}

fn lvl(var: &str, p: u32) -> String {
    format!("{var}:{p} mb")
}

/// The idx patterns of the profile (prefix "?" = optional).
fn profile_fields(model: &str) -> Vec<String> {
    let mut v = vec![T2.to_string(), TD2.to_string(), PSFC.to_string(), HGT_SFC.to_string(), U10.to_string(), V10.to_string()];
    for &p in profile_levels(model) {
        v.push(lvl("TMP", p));
        v.push(if model == "rap" { lvl("RH", p) } else { lvl("DPT", p) });
        v.push(lvl("UGRD", p));
        v.push(lvl("VGRD", p));
        // HRRR's wrfsfc has no 925 mb height (estimated hypsometrically)
        v.push(if model == "hrrr" && p == 925 { format!("?{}", lvl("HGT", p)) } else { lvl("HGT", p) });
    }
    v
}

/// Fields (NCEP idx patterns) a parameter needs; "?" prefix = optional.
pub fn required(model: &str, id: &str) -> Vec<String> {
    let s = |x: &[&str]| x.iter().map(|y| y.to_string()).collect::<Vec<String>>();
    let rap = model == "rap";
    let lcl: Vec<String> = if rap { s(&[T2, TD2]) } else { s(&[HGT_LCL, HGT_SFC]) };
    let eff = s(&[SB_CAPE, SB_CIN, MU_CAPE, MU_CIN, SRH1, SRH3, SH6U, SH6V]);
    let mut v: Vec<String> = match id {
        "sbcape" => s(&[SB_CAPE]),
        "mlcape" => s(&[ML_CAPE]),
        "mucape" => s(&[MU_CAPE]),
        "cape3" => s(&[CAPE3]),
        "sbcin" => s(&[SB_CIN]),
        "mlcin" => s(&[ML_CIN]),
        "pwat" => s(&[PWAT]),
        "lcl" => lcl,
        "thetae" => s(&[T2, TD2, PSFC]),
        "srh01" => s(&[SRH1]),
        "srh03" => s(&[SRH3]),
        "shear06" => s(&[SH6U, SH6V]),
        "shear01" if !rap => s(&[SH1U, SH1V]),
        "shear01" | "shear03" | "lr03" | "dcape" => profile_fields(model),
        "ebwd" | "esrh" | "esrh01" => eff,
        "lr75" => s(&["TMP:700 mb", "TMP:500 mb", "HGT:700 mb", "HGT:500 mb"]),
        "stp" => {
            let mut v = s(&[SB_CAPE, SRH1, SH6U, SH6V]);
            v.extend(lcl);
            v
        }
        "stpe" => {
            let mut v = eff;
            v.extend(s(&[ML_CAPE, ML_CIN]));
            v.extend(lcl);
            v
        }
        "scp" => eff,
        "ship" => s(&[MU_CAPE, T2, TD2, PSFC, SH6U, SH6V, "TMP:700 mb", "TMP:500 mb", "HGT:700 mb", "HGT:500 mb", HGT_0C, HGT_SFC]),
        _ => vec![],
    };
    v.sort();
    v.dedup();
    v
}

/// Input fields by pattern (absent optional fields are None).
pub struct Inputs<'a> {
    pub fields: Vec<(String, Option<&'a Grid>)>,
    /// VUCSH/VVCSH scale: 1 when stored as m/s differences, else the layer depth (stored as 1/s)
    pub sh1_scale: f32,
    pub sh6_scale: f32,
}

impl<'a> Inputs<'a> {
    pub fn new(fields: Vec<(String, Option<&'a Grid>)>) -> Self {
        let mut me = Inputs { fields, sh1_scale: 1.0, sh6_scale: 1.0 };
        // UPP labels VUCSH as 1/s but HRRR stores the m/s difference; guard either way
        let peak = |me: &Inputs, p: &str| me.grid(p).map(|g| g.offset.abs().max((g.offset + 65533.0 * g.scale).abs())).unwrap_or(1.0);
        if peak(&me, SH1U) < 0.5 {
            me.sh1_scale = 1000.0;
        }
        if peak(&me, SH6U) < 0.5 {
            me.sh6_scale = 6000.0;
        }
        me
    }
    fn grid(&self, p: &str) -> Option<&'a Grid> {
        self.fields.iter().find(|f| f.0 == p).and_then(|f| f.1)
    }
    #[inline]
    fn get(&self, p: &str, i: usize) -> Option<f32> {
        let g = self.grid(p)?;
        let r = *g.data.get(i)?;
        (r != 0).then(|| g.value_raw(r))
    }
}

// ---------- thermodynamics ----------

const RD: f64 = 287.04;
const CP: f64 = 1005.7;
const LV: f64 = 2.501e6;
const EPS: f64 = 0.622;
const G: f64 = 9.80665;

/// Saturation vapour pressure (hPa) over water, T in °C (Bolton).
pub fn es(t_c: f64) -> f64 {
    6.112 * (17.67 * t_c / (t_c + 243.5)).exp()
}

/// Mixing ratio (kg/kg) for vapour pressure e at pressure p (hPa).
pub fn mixing_ratio(e: f64, p: f64) -> f64 {
    EPS * e / (p - e).max(1.0)
}

/// Dewpoint (°C) from T (°C) and RH (%).
pub fn dewpoint_from_rh(t_c: f64, rh: f64) -> f64 {
    let e = (rh.clamp(0.1, 100.0) / 100.0) * es(t_c);
    let l = (e / 6.112).ln();
    243.5 * l / (17.67 - l)
}

/// Equivalent potential temperature (K), Bolton (1980) eq. 43. T, Td in °C, p in hPa.
pub fn theta_e(t_c: f64, td_c: f64, p: f64) -> f64 {
    let (t, td) = (t_c + 273.15, td_c.min(t_c) + 273.15);
    let r = mixing_ratio(es(td_c.min(t_c)), p) * 1000.0;
    let tl = 1.0 / (1.0 / (td - 56.0) + (t / td).ln() / 800.0) + 56.0;
    t * (1000.0 / p).powf(0.2854 * (1.0 - 0.00028 * r)) * ((3.376 / tl - 0.00254) * r * (1.0 + 0.00081 * r)).exp()
}

/// LCL (temperature K, pressure hPa) for a parcel at (T, Td °C, p hPa), Bolton.
pub fn lcl(t_c: f64, td_c: f64, p: f64) -> (f64, f64) {
    let (t, td) = (t_c + 273.15, td_c.min(t_c) + 273.15);
    let tl = 1.0 / (1.0 / (td - 56.0) + (t / td).ln() / 800.0) + 56.0;
    (tl, p * (tl / t).powf(CP / RD))
}

/// Temperature (K) after following the pseudo-adiabat from (t_k, p0) to p1 (hPa).
pub fn moist_adiabat(t_k: f64, p0: f64, p1: f64) -> f64 {
    let dtdp = |t: f64, p: f64| {
        let rs = mixing_ratio(es(t - 273.15), p);
        (RD * t + LV * rs) / (p * (CP + LV * LV * rs * EPS / (RD * t * t)))
    };
    let n = ((p1 - p0).abs() / 5.0).ceil().max(1.0) as usize;
    let dp = (p1 - p0) / n as f64;
    let (mut t, mut p) = (t_k, p0);
    for _ in 0..n {
        let k1 = dtdp(t, p);
        let k2 = dtdp(t + k1 * dp, p + dp);
        t += 0.5 * (k1 + k2) * dp;
        p += dp;
    }
    t
}

/// Wet-bulb temperature (K) at p: lift to the LCL, then down the pseudo-adiabat.
pub fn wet_bulb(t_c: f64, td_c: f64, p: f64) -> f64 {
    let (tl, pl) = lcl(t_c, td_c, p);
    moist_adiabat(tl, pl, p)
}

/// One profile point: p hPa, z m MSL, T/Td °C, u/v m/s.
#[derive(Debug, Clone, Copy)]
pub struct Lvl {
    pub p: f64,
    pub z: f64,
    pub t: f64,
    pub td: f64,
    pub u: f64,
    pub v: f64,
}

/// Surface point first, then levels above ground by increasing height.
#[derive(Debug, Clone, Default)]
pub struct Profile {
    pub lv: Vec<Lvl>,
}

impl Profile {
    /// `sfc` = 2 m / 10 m values at the surface (z = terrain height); `levels` any order,
    /// those at or below ground are dropped.
    pub fn new(sfc: Lvl, levels: &[Lvl]) -> Profile {
        let mut lv: Vec<Lvl> = levels.iter().copied().filter(|l| l.p < sfc.p - 1.0 && l.z > sfc.z + 5.0 && l.t.is_finite() && l.z.is_finite()).collect();
        lv.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
        lv.insert(0, sfc);
        Profile { lv }
    }

    /// Linear interpolation of a field at height `h` m AGL (None above the top level).
    pub fn at_agl(&self, h: f64, f: impl Fn(&Lvl) -> f64) -> Option<f64> {
        let z = self.lv.first()?.z + h;
        for w in self.lv.windows(2) {
            if z >= w[0].z && z <= w[1].z {
                let k = (z - w[0].z) / (w[1].z - w[0].z).max(1e-6);
                return Some(f(&w[0]) + k * (f(&w[1]) - f(&w[0])));
            }
        }
        None
    }

    /// Environment temperature (°C) at pressure p, linear in ln p.
    pub fn t_at_p(&self, p: f64) -> Option<f64> {
        for w in self.lv.windows(2) {
            let (a, b) = (w[0], w[1]);
            if p <= a.p && p >= b.p {
                let k = (a.p.ln() - p.ln()) / (a.p.ln() - b.p.ln()).max(1e-9);
                return Some(a.t + k * (b.t - a.t));
            }
        }
        None
    }

    /// Bulk shear magnitude (m/s) between the surface wind and `h` m AGL.
    pub fn shear(&self, h: f64) -> Option<f64> {
        let s = self.lv.first()?;
        let u = self.at_agl(h, |l| l.u)?;
        let v = self.at_agl(h, |l| l.v)?;
        Some(((u - s.u).powi(2) + (v - s.v).powi(2)).sqrt())
    }

    /// Lapse rate (°C/km) from the surface to `h` m AGL.
    pub fn lapse(&self, h: f64) -> Option<f64> {
        let t0 = self.lv.first()?.t;
        Some((t0 - self.at_agl(h, |l| l.t)?) / (h / 1000.0))
    }

    /// Downdraft CAPE (J/kg), see the module docs.
    pub fn dcape(&self) -> Option<f64> {
        let s = *self.lv.first()?;
        let src = self.lv.iter().skip(1).filter(|l| l.p >= s.p - 400.0).min_by(|a, b| theta_e(a.t, a.td, a.p).partial_cmp(&theta_e(b.t, b.td, b.p)).unwrap_or(std::cmp::Ordering::Equal))?;
        let mut tp = wet_bulb(src.t, src.td, src.p);
        let mut p = src.p;
        let mut d = 0.0;
        while p < s.p - 1e-6 {
            let p1 = (p + 10.0).min(s.p);
            let tp1 = moist_adiabat(tp, p, p1);
            let (te0, te1) = (self.t_at_p(p)? + 273.15, self.t_at_p(p1)? + 273.15);
            d += RD * 0.5 * ((te0 - tp) + (te1 - tp1)) * (p1 / p).ln();
            tp = tp1;
            p = p1;
        }
        Some(d.max(0.0))
    }
}

/// Fill missing heights hypsometrically from the level below (levels sorted by p descending).
pub fn fill_heights(levels: &mut [Lvl]) {
    for k in 1..levels.len() {
        if !levels[k].z.is_finite() && levels[k - 1].z.is_finite() && levels[k].t.is_finite() {
            let (a, b) = (levels[k - 1], levels[k]);
            let tm = (a.t + b.t) / 2.0 + 273.15;
            levels[k].z = a.z + RD * tm / G * (a.p / b.p).ln();
        }
    }
}

// ---------- composite indices ----------

/// Fixed-layer STP (SPC).
pub fn stp_fixed(sbcape: f64, lcl_m: f64, srh1: f64, bwd6_ms: f64) -> f64 {
    let lclt = if lcl_m < 1000.0 { 1.0 } else if lcl_m > 2000.0 { 0.0 } else { (2000.0 - lcl_m) / 1000.0 };
    let bwd = if bwd6_ms < 12.5 { 0.0 } else if bwd6_ms > 30.0 { 1.5 } else { bwd6_ms / 20.0 };
    (sbcape / 1500.0 * lclt * srh1 / 150.0 * bwd).max(0.0)
}

/// Effective-layer STP with CIN (SPC).
pub fn stp_eff(mlcape: f64, lcl_m: f64, esrh: f64, ebwd_ms: f64, mlcin: f64) -> f64 {
    let lclt = if lcl_m < 1000.0 { 1.0 } else if lcl_m > 2000.0 { 0.0 } else { (2000.0 - lcl_m) / 1000.0 };
    let bwd = if ebwd_ms < 12.5 { 0.0 } else if ebwd_ms > 30.0 { 1.5 } else { ebwd_ms / 20.0 };
    let cin = if mlcin > -50.0 { 1.0 } else if mlcin < -200.0 { 0.0 } else { (200.0 + mlcin) / 150.0 };
    (mlcape / 1500.0 * lclt * esrh / 150.0 * bwd * cin).max(0.0)
}

/// Supercell composite parameter (SPC, with the CIN term).
pub fn scp(mucape: f64, esrh: f64, ebwd_ms: f64, mucin: f64) -> f64 {
    let bwd = if ebwd_ms < 10.0 { 0.0 } else if ebwd_ms > 20.0 { 1.0 } else { ebwd_ms / 20.0 };
    let cin = if mucin > -40.0 { 1.0 } else { -40.0 / mucin };
    (mucape / 1000.0 * esrh / 50.0 * bwd * cin).max(0.0)
}

/// Significant hail parameter (SPC).
pub fn ship(mucape: f64, mr_gkg: f64, lr75: f64, t500: f64, bwd6_ms: f64, fzl_agl: f64) -> f64 {
    let mr = mr_gkg.clamp(11.0, 13.6);
    let t5 = t500.min(-5.5);
    let sh = bwd6_ms.clamp(7.0, 27.0);
    let mut s = mucape * mr * lr75 * -t5 * sh / 42_000_000.0;
    if mucape < 1300.0 {
        s *= mucape / 1300.0;
    }
    if lr75 < 5.8 {
        s *= lr75 / 5.8;
    }
    if fzl_agl < 2400.0 {
        s *= fzl_agl.max(0.0) / 2400.0;
    }
    s.max(0.0)
}

/// (ESRH 0–3, ESRH 0–1, EBWD m/s) from the effective-ish gate (see module docs).
pub fn effective(sbcape: f64, sbcin: f64, mucape: f64, mucin: f64, srh1: f64, srh3: f64, bwd6: f64) -> (f64, f64, f64) {
    if sbcape >= 100.0 && sbcin >= -250.0 {
        (srh3, srh1, bwd6)
    } else if mucape >= 100.0 && mucin >= -250.0 {
        ((srh3 - srh1).max(0.0), 0.0, bwd6)
    } else {
        (0.0, 0.0, 0.0)
    }
}

const MS_TO_KT: f64 = 1.943_844;

/// Compute one parameter for every cell. Returns NaN for missing.
pub fn compute(model: &str, id: &str, inp: &Inputs, n: usize) -> Vec<f32> {
    use rayon::prelude::*;
    let rap = model == "rap";
    let levels = profile_levels(model);
    // level patterns built once (T, Td or RH, U, V, Z)
    let lp: Vec<(u32, [String; 5])> = levels.iter().map(|&p| (p, [lvl("TMP", p), if rap { lvl("RH", p) } else { lvl("DPT", p) }, lvl("UGRD", p), lvl("VGRD", p), lvl("HGT", p)])).collect();
    (0..n)
        .into_par_iter()
        .map(|i| {
            let g = |p: &str| inp.get(p, i).map(|v| v as f64);
            let lcl_m = || -> Option<f64> {
                if rap {
                    Some((125.0 * (g(T2)? - g(TD2)?)).max(0.0))
                } else {
                    Some((g(HGT_LCL)? - g(HGT_SFC)?).max(0.0))
                }
            };
            let bwd6 = || Some((g(SH6U)?.powi(2) + g(SH6V)?.powi(2)).sqrt() * inp.sh6_scale as f64);
            let eff = || Some(effective(g(SB_CAPE)?, g(SB_CIN)?, g(MU_CAPE)?, g(MU_CIN)?, g(SRH1)?, g(SRH3)?, bwd6()?));
            let lr75 = || Some((g("TMP:700 mb")? - g("TMP:500 mb")?) / ((g("HGT:500 mb")? - g("HGT:700 mb")?) / 1000.0).max(0.1));
            let profile = || -> Option<Profile> {
                let sfc = Lvl { p: g(PSFC)? / 100.0, z: g(HGT_SFC)?, t: g(T2)? - 273.15, td: g(TD2)? - 273.15, u: g(U10)?, v: g(V10)? };
                let mut lv: Vec<Lvl> = lp
                    .iter()
                    .map(|(p, k)| {
                        let t = g(&k[0]).map(|x| x - 273.15).unwrap_or(f64::NAN);
                        let td = if rap { g(&k[1]).map(|rh| dewpoint_from_rh(t, rh)).unwrap_or(f64::NAN) } else { g(&k[1]).map(|x| x - 273.15).unwrap_or(f64::NAN) };
                        Lvl { p: *p as f64, z: g(&k[4]).unwrap_or(f64::NAN), t, td, u: g(&k[2]).unwrap_or(f64::NAN), v: g(&k[3]).unwrap_or(f64::NAN) }
                    })
                    .collect();
                fill_heights(&mut lv);
                Some(Profile::new(sfc, &lv))
            };
            let v: Option<f64> = match id {
                "sbcape" => g(SB_CAPE),
                "mlcape" => g(ML_CAPE),
                "mucape" => g(MU_CAPE),
                "cape3" => g(CAPE3),
                "sbcin" => g(SB_CIN),
                "mlcin" => g(ML_CIN),
                "pwat" => g(PWAT),
                "srh01" => g(SRH1),
                "srh03" => g(SRH3),
                "lcl" => lcl_m(),
                "thetae" => (|| Some(theta_e(g(T2)? - 273.15, g(TD2)? - 273.15, g(PSFC)? / 100.0)))(),
                "shear06" => bwd6().map(|x| x * MS_TO_KT),
                "shear01" if !rap => (|| Some((g(SH1U)?.powi(2) + g(SH1V)?.powi(2)).sqrt() * inp.sh1_scale as f64 * MS_TO_KT))(),
                "shear01" => profile().and_then(|p| p.shear(1000.0)).map(|x| x * MS_TO_KT),
                "shear03" => profile().and_then(|p| p.shear(3000.0)).map(|x| x * MS_TO_KT),
                "lr03" => profile().and_then(|p| p.lapse(3000.0)),
                "dcape" => profile().and_then(|p| p.dcape()),
                "lr75" => lr75(),
                "esrh" => eff().map(|e| e.0),
                "esrh01" => eff().map(|e| e.1),
                "ebwd" => eff().map(|e| e.2 * MS_TO_KT),
                "stp" => (|| Some(stp_fixed(g(SB_CAPE)?, lcl_m()?, g(SRH1)?, bwd6()?)))(),
                "stpe" => (|| {
                    let e = eff()?;
                    Some(stp_eff(g(ML_CAPE)?, lcl_m()?, e.0, e.2, g(ML_CIN)?))
                })(),
                "scp" => (|| {
                    let e = eff()?;
                    Some(scp(g(MU_CAPE)?, e.0, e.2, g(MU_CIN)?))
                })(),
                "ship" => (|| {
                    let p = g(PSFC)? / 100.0;
                    let mr = mixing_ratio(es(g(TD2)? - 273.15), p) * 1000.0;
                    let fzl = g(HGT_0C)? - g(HGT_SFC)?;
                    Some(ship(g(MU_CAPE)?, mr, lr75()?, g("TMP:500 mb")? - 273.15, bwd6()?, fzl))
                })(),
                _ => None,
            };
            v.filter(|x| x.is_finite()).map(|x| x as f32).unwrap_or(f32::NAN)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thermo_reference_values() {
        // θe of 30 °C / 20 °C at 1000 hPa: Bolton eq. 43 by hand (r = 14.88 g/kg, T_L = 290.8 K)
        let te = theta_e(30.0, 20.0, 1000.0);
        assert!((te - 347.5).abs() < 0.3, "{te}");
        // wet bulb of 30 °C / 20 °C at 1000 hPa ≈ 22.8 °C
        let tw = wet_bulb(30.0, 20.0, 1000.0) - 273.15;
        assert!((tw - 22.8).abs() < 0.5, "{tw}");
        // saturated parcel 20 °C at 1000 hPa lifted to 500 hPa ≈ −8.5 °C on the pseudo-adiabat,
        // conserving θe within ~1 K
        let t5 = moist_adiabat(293.15, 1000.0, 500.0) - 273.15;
        assert!((t5 - (-8.5)).abs() < 1.0, "{t5}");
        assert!((theta_e(20.0, 20.0, 1000.0) - theta_e(t5, t5, 500.0)).abs() < 1.5);
        let td = dewpoint_from_rh(25.0, 50.0);
        assert!((td - 13.9).abs() < 0.3, "{td}");
        let (tl, pl) = lcl(30.0, 20.0, 1000.0);
        assert!((tl - 290.6).abs() < 1.0 && (pl - 870.0).abs() < 15.0, "{tl} {pl}");
    }

    #[test]
    fn composite_indices() {
        // textbook: 3000 J/kg, LCL 800 m, SRH1 300, 25 m/s shear → 2·1·2·1.25 = 5
        assert!((stp_fixed(3000.0, 800.0, 300.0, 25.0) - 5.0).abs() < 1e-9);
        assert_eq!(stp_fixed(3000.0, 2500.0, 300.0, 25.0), 0.0);
        assert_eq!(stp_fixed(3000.0, 800.0, 300.0, 10.0), 0.0);
        assert!((stp_eff(1500.0, 1500.0, 150.0, 20.0, -125.0) - 0.25).abs() < 1e-9);
        assert!((scp(2000.0, 200.0, 25.0, -20.0) - 8.0).abs() < 1e-9);
        assert!((scp(2000.0, 200.0, 25.0, -80.0) - 4.0).abs() < 1e-9);
        let s = ship(3000.0, 14.0, 8.0, -15.0, 25.0, 3500.0);
        // 3000·13.6·8·15·25 / 42e6 = 2.914
        assert!((s - 2.914).abs() < 0.01, "{s}");
        assert_eq!(effective(50.0, 0.0, 1500.0, -10.0, 100.0, 250.0, 20.0), (150.0, 0.0, 20.0));
        assert_eq!(effective(50.0, 0.0, 50.0, -10.0, 100.0, 250.0, 20.0), (0.0, 0.0, 0.0));
    }

    fn sounding() -> (Lvl, Vec<Lvl>) {
        // a loaded-gun sounding: moist surface, dry 700-500 mb, westerly shear
        let sfc = Lvl { p: 970.0, z: 350.0, t: 30.0, td: 21.0, u: 2.0, v: 8.0 };
        let lv = vec![
            Lvl { p: 1000.0, z: 100.0, t: 32.0, td: 22.0, u: 0.0, v: 0.0 },
            Lvl { p: 925.0, z: f64::NAN, t: 25.0, td: 18.0, u: 8.0, v: 14.0 },
            Lvl { p: 850.0, z: 1500.0, t: 20.0, td: 14.0, u: 12.0, v: 12.0 },
            Lvl { p: 700.0, z: 3150.0, t: 9.0, td: -6.0, u: 18.0, v: 6.0 },
            Lvl { p: 500.0, z: 5850.0, t: -11.0, td: -30.0, u: 28.0, v: 2.0 },
        ];
        (sfc, lv)
    }

    #[test]
    fn profile_shear_lapse_dcape() {
        let (sfc, mut lv) = sounding();
        fill_heights(&mut lv);
        // 925 mb height estimated between 1000 and 850
        assert!(lv[1].z > 600.0 && lv[1].z < 900.0, "{}", lv[1].z);
        let p = Profile::new(sfc, &lv);
        // the 1000 mb level is below ground and dropped
        assert_eq!(p.lv.len(), 5);
        let lr = p.lapse(3000.0).unwrap();
        assert!((6.0..9.0).contains(&lr), "lapse {lr}");
        let s6 = p.shear(5000.0).unwrap();
        assert!(s6 > 15.0 && s6 < 30.0, "{s6}");
        assert!(p.shear(9000.0).is_none());
        let d = p.dcape().unwrap();
        // dry mid levels over a hot boundary layer: several hundred to ~1500 J/kg
        assert!((300.0..2000.0).contains(&d), "dcape {d}");
        let tw = wet_bulb(9.0, -6.0, 700.0) - 273.15;
        assert!(tw < 9.0 && tw > -2.0, "{tw}");
    }

    #[test]
    fn compute_on_synthetic_fields() {
        use crate::grid::Proj;
        let proj = Proj::LatLon { lat0: 30.0, lon0: -100.0, dlat: 1.0, dlon: 1.0, nx: 2, global: false };
        let mk = |v: f32| Grid::from_values(2, 1, proj.clone(), &[v, f32::NAN], 0, 0);
        let pats: Vec<(&str, f32)> = vec![(SB_CAPE, 3000.0), (SRH1, 300.0), (SH6U, 25.0), (SH6V, 0.0), (HGT_LCL, 1150.0), (HGT_SFC, 350.0)];
        let grids: Vec<(String, Grid)> = pats.iter().map(|(p, v)| (p.to_string(), mk(*v))).collect();
        let inp = Inputs::new(grids.iter().map(|(p, g)| (p.clone(), Some(g))).collect());
        let out = compute("hrrr", "stp", &inp, 2);
        assert!((out[0] - 5.0).abs() < 0.01, "{}", out[0]);
        assert!(out[1].is_nan());
        let sh = compute("hrrr", "shear06", &inp, 2);
        assert!((sh[0] - 48.6).abs() < 0.2, "{}", sh[0]);
        assert_eq!(required("hrrr", "stp").len(), 6);
        assert!(required("rap", "shear01").iter().any(|p| p == "RH:700 mb"));
        assert!(required("hrrr", "dcape").iter().any(|p| p == "?HGT:925 mb"));
        assert_eq!(layers().len(), PARAMS.len() * SOURCES.len());
    }
}

// ---------- service glue ----------

impl super::service::GridService {
    /// Frames of a severe-parameter layer: every forecast hour of the newest run with ≥ 3 hours
    /// (or `run`).
    pub(super) async fn svr_frames(&self, l: &LayerDef, run: Option<&str>) -> anyhow::Result<super::service::FramesResp> {
        use super::service::{FrameInfo, FramesResp, RunInfo};
        let mid = l.model.as_deref().unwrap_or("");
        let m = super::sources::model_def(mid).ok_or_else(|| anyhow::anyhow!("unknown model"))?;
        let runs = self.runs_for(m, m.cycles, 3).await?;
        let chosen = match run {
            Some(r) => runs.iter().find(|x| x.0 == r).cloned(),
            None => runs.iter().find(|x| x.2.len() >= 3 || runs.len() == 1).cloned().or_else(|| runs.first().cloned()),
        }
        .ok_or_else(|| anyhow::anyhow!("run not available"))?;
        let frames = chosen.2.iter().map(|&fh| FrameInfo { key: format!("svr|{mid}|{}|{fh}|{}", chosen.0, l.product), time: chosen.1 + fh as i64 * 3_600_000, label: format!("F{fh:03}") }).collect();
        Ok(FramesResp { frames, runs: runs.iter().map(|r| RunInfo { id: r.0.clone(), time: r.1, fhs: r.2.clone() }).collect(), run: Some(chosen.0.clone()), ..Default::default() })
    }

    /// One input field (`svrf|model|run|fh|pattern`), decimated for HRRR.
    pub(super) async fn svrf_load(&self, model: &str, run: &str, fh: u32, pat: &str) -> anyhow::Result<Grid> {
        use anyhow::anyhow;
        if !SOURCES.iter().any(|s| s.0 == model) || run.len() != 10 {
            anyhow::bail!("bad severe key");
        }
        let m = super::sources::model_def(model).ok_or_else(|| anyhow!("unknown model"))?;
        let (d, hh) = (&run[..8], run[8..].parse::<u32>()?);
        let url = crate::s3::object_url(m.bucket, &super::sources::fill_template(m.file, d, hh, fh, ""));
        let idx = self.text_cached(&format!("{url}.idx"), 3600).await?;
        let rows = super::sources::parse_ncep_idx(&idx);
        let r = super::sources::find_ncep(&rows, pat, fh, false).ok_or_else(|| anyhow!("{pat} not in {} F{fh:03}", m.name))?;
        let b = self.fetch(&url, Some(r), true).await?;
        let md = max_dim(model);
        let mut g = self.run_blocking(move || super::decode::decode(&b, 0, &super::decode::DecodeOpts { max_dim: md, ..Default::default() })).await?;
        g.ref_ms = super::service::run_time_ms_pub(d, hh)?;
        g.valid_ms = g.ref_ms + fh as i64 * 3_600_000;
        Ok(g)
    }

    /// A severe parameter (`svr|model|run|fh|param`).
    pub(super) async fn svr_load(&self, model: &str, run: &str, fh: u32, id: &str) -> anyhow::Result<Grid> {
        if param(id).is_none() {
            anyhow::bail!("unknown severe parameter {id}");
        }
        let req = required(model, id);
        let keys: Vec<String> = req.iter().map(|p| format!("svrf|{model}|{run}|{fh}|{}", p.trim_start_matches('?'))).collect();
        let mut fields: Vec<(String, Option<std::sync::Arc<Grid>>)> = vec![];
        for (ps, ks) in req.chunks(4).zip(keys.chunks(4)) {
            let mut futs = vec![];
            for k in ks {
                futs.push(Box::pin(self.grid(k)));
            }
            for (p, r) in ps.iter().zip(futures::future::join_all(futs).await) {
                match r {
                    Ok(g) => fields.push((p.trim_start_matches('?').to_string(), Some(g))),
                    Err(_) if p.starts_with('?') => fields.push((p.trim_start_matches('?').to_string(), None)),
                    Err(e) => return Err(e),
                }
            }
        }
        let first = fields.iter().find_map(|f| f.1.clone()).ok_or_else(|| anyhow::anyhow!("no input fields"))?;
        if fields.iter().any(|f| f.1.as_ref().map(|g| g.data.len() != first.data.len()).unwrap_or(false)) {
            anyhow::bail!("input fields differ in size");
        }
        let (model, id) = (model.to_string(), id.to_string());
        let out = self
            .run_blocking(move || {
                let inp = Inputs::new(fields.iter().map(|(p, g)| (p.clone(), g.as_deref())).collect());
                let vals = compute(&model, &id, &inp, first.data.len());
                Ok(Grid::from_values(first.nx, first.ny, first.proj.clone(), &vals, first.valid_ms, first.ref_ms))
            })
            .await;
        match &out {
            Ok(_) => self.health.ok("grid-svr", "Severe parameters (HRRR / RAP)", ""),
            Err(e) => self.health.err("grid-svr", "Severe parameters (HRRR / RAP)", e),
        }
        out
    }
}
