// Sounding thermodynamics and kinematics: parcels, CAPE/CIN, shear, SRH, Bunkers storm motion
// and the usual composite indices. Units: hPa, °C, m (MSL unless noted), wind in kt on input.

export interface Level {
  p: number;
  z: number;
  t: number;
  td: number | null;
  wd: number | null;
  ws: number | null;
}

const RD = 287.04;
const CP = 1005.7;
const LV = 2.501e6;
const EPS = 0.622;
const G = 9.80665;
const KAPPA = RD / CP;
const K0 = 273.15;
export const KT = 0.514444;

export const es = (t: number) => 6.112 * Math.exp((17.67 * t) / (t + 243.5));
/** mixing ratio (kg/kg) of vapor pressure e at p */
export const mixr = (p: number, t: number) => {
  const e = Math.min(es(t), p * 0.5);
  return (EPS * e) / (p - e);
};
/** dewpoint (°C) for mixing ratio w (kg/kg) at p */
export const tdOf = (p: number, w: number) => {
  const e = (w * p) / (EPS + w);
  const l = Math.log(e / 6.112);
  return (243.5 * l) / (17.67 - l);
};
export const theta = (p: number, t: number) => (t + K0) * Math.pow(1000 / p, KAPPA);
/** temperature (°C) on a dry adiabat of potential temperature th (K) */
export const dryT = (p: number, th: number) => th * Math.pow(p / 1000, KAPPA) - K0;
/** virtual temperature (K) */
export const tv = (t: number, w: number) => (t + K0) * (1 + 0.61 * w);
export const thetaE = (p: number, t: number, td: number) => {
  const w = mixr(p, td);
  const l = lcl(p, t, td);
  return (t + K0) * Math.pow(1000 / p, 0.2854 * (1 - 0.28 * w)) * Math.exp((3.376 / (l.t + K0) - 0.00254) * w * 1000 * (1 + 0.81 * w));
};

/** Bolton LCL: pressure (hPa) and temperature (°C) */
export function lcl(p: number, t: number, td: number) {
  const T = t + K0, D = Math.min(td, t) + K0;
  const tl = 1 / (1 / (D - 56) + Math.log(T / D) / 800) + 56;
  return { p: p * Math.pow(tl / T, 1 / KAPPA), t: tl - K0 };
}

/** saturated (pseudo-adiabatic) lapse dT/dp in K/hPa */
function moistDTdp(p: number, t: number) {
  const T = t + K0;
  const rs = mixr(p, t);
  return ((RD * T + LV * rs) / (CP + (LV * LV * rs * EPS) / (RD * T * T))) / p;
}

/** Follow a moist adiabat from (p0, t0) to p1 (RK4 in ~2 hPa steps). */
export function moistT(p0: number, t0: number, p1: number): number {
  const n = Math.max(1, Math.ceil(Math.abs(p1 - p0) / 2));
  const h = (p1 - p0) / n;
  let p = p0, t = t0;
  for (let i = 0; i < n; i++) {
    const k1 = moistDTdp(p, t);
    const k2 = moistDTdp(p + h / 2, t + (h / 2) * k1);
    const k3 = moistDTdp(p + h / 2, t + (h / 2) * k2);
    const k4 = moistDTdp(p + h, t + h * k3);
    t += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    p += h;
  }
  return t;
}

/** Wet-bulb temperature by iterating on the moist adiabat through the LCL. */
export function wetbulb(p: number, t: number, td: number) {
  const l = lcl(p, t, td);
  return moistT(l.p, l.t, p);
}

// ---------- profile helpers ----------

export function clean(levels: any[]): Level[] {
  const out: Level[] = levels
    .filter((l) => l && Number.isFinite(l.p) && Number.isFinite(l.t) && l.p > 0)
    .map((l) => ({ p: +l.p, z: Number.isFinite(l.z) ? +l.z : NaN, t: +l.t, td: Number.isFinite(l.td) ? Math.min(+l.td, +l.t) : null, wd: Number.isFinite(l.wd) ? +l.wd : null, ws: Number.isFinite(l.ws) ? +l.ws : null }))
    .sort((a, b) => b.p - a.p);
  // drop duplicate pressures
  const u = out.filter((l, i) => i === 0 || l.p < out[i - 1].p);
  // fill missing heights hypsometrically
  for (let i = 0; i < u.length; i++) {
    if (Number.isFinite(u[i].z)) continue;
    if (i === 0) u[i].z = 0;
    else {
      const a = u[i - 1], b = u[i];
      const tm = (tv(a.t, a.td != null ? mixr(a.p, a.td) : 0) + tv(b.t, b.td != null ? mixr(b.p, b.td) : 0)) / 2;
      b.z = a.z + ((RD * tm) / G) * Math.log(a.p / b.p);
    }
  }
  return u;
}

/** Linear-in-log-p interpolation of a field at pressure p. */
export function atP(L: Level[], p: number, f: (l: Level) => number | null): number | null {
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    if (p <= a.p && p >= b.p) {
      const va = f(a), vb = f(b);
      if (va == null || vb == null) return va ?? vb;
      const r = Math.log(a.p / p) / Math.log(a.p / b.p);
      return va + (vb - va) * r;
    }
  }
  return null;
}

/** Linear interpolation by height AGL (m). */
export function atZ(L: Level[], zAgl: number, f: (l: Level) => number | null): number | null {
  const z = L[0].z + zAgl;
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    if (z >= a.z && z <= b.z) {
      const va = f(a), vb = f(b);
      if (va == null || vb == null) return va ?? vb;
      return va + ((vb - va) * (z - a.z)) / (b.z - a.z || 1);
    }
  }
  return null;
}

export const pAtZ = (L: Level[], zAgl: number) => {
  const lp = atZ(L, zAgl, (l) => Math.log(l.p));
  return lp == null ? null : Math.exp(lp);
};
export const zAtP = (L: Level[], p: number) => {
  const z = atP(L, p, (l) => l.z);
  return z == null ? null : z - L[0].z;
};

/** wind components (kt) at a level; meteorological direction (from). */
export const uv = (wd: number, ws: number): [number, number] => [-ws * Math.sin((wd * Math.PI) / 180), -ws * Math.cos((wd * Math.PI) / 180)];
export function windAtZ(L: Level[], zAgl: number): [number, number] | null {
  const u = atZ(L, zAgl, (l) => (l.wd != null && l.ws != null ? uv(l.wd, l.ws)[0] : null));
  const v = atZ(L, zAgl, (l) => (l.wd != null && l.ws != null ? uv(l.wd, l.ws)[1] : null));
  return u == null || v == null ? null : [u, v];
}

// ---------- parcels ----------

export interface Parcel {
  kind: "SB" | "ML" | "MU";
  p0: number;
  t0: number;
  td0: number;
  lclP: number;
  lclZ: number | null;
  lfcP: number | null;
  elP: number | null;
  cape: number;
  cin: number;
  li: number | null;
  /** parcel temperature trace (°C) at descending pressures */
  trace: { p: number; t: number }[];
}

/** Parcel temperature at pressure p. */
function parcelT(p0: number, t0: number, td0: number, l: { p: number; t: number }, p: number) {
  if (p >= l.p) return dryT(p, theta(p0, t0));
  return moistT(l.p, l.t, p);
}

export function liftParcel(L: Level[], kind: Parcel["kind"], p0: number, t0: number, td0: number): Parcel {
  const l = lcl(p0, t0, td0);
  const w0 = mixr(p0, td0);
  const top = Math.max(100, L[L.length - 1].p);
  // sample every ~5 hPa plus every level
  const ps = new Set<number>();
  for (let p = p0; p >= top; p -= 5) ps.add(+p.toFixed(2));
  for (const x of L) if (x.p <= p0 && x.p >= top) ps.add(x.p);
  ps.add(+l.p.toFixed(2));
  const plist = [...ps].sort((a, b) => b - a);
  const trace: { p: number; t: number }[] = [];
  // moist part integrated incrementally
  let mp = l.p, mt = l.t;
  /** b: virtual temperature excess (K) */
  const buoy: { p: number; b: number }[] = [];
  for (const p of plist) {
    let t: number;
    if (p >= l.p) t = dryT(p, theta(p0, t0));
    else {
      t = moistT(mp, mt, p);
      mp = p;
      mt = t;
    }
    trace.push({ p, t });
    const te = atP(L, p, (x) => x.t);
    const tde = atP(L, p, (x) => x.td);
    if (te == null) continue;
    const wp = p >= l.p ? w0 : mixr(p, t);
    const tvp = tv(t, wp);
    const tve = tv(te, tde != null ? mixr(p, tde) : 0);
    buoy.push({ p, b: tvp - tve });
  }
  // CAPE / CIN: Rd * ∫ (Tvp - Tve) d ln p, in J/kg; LFC = first positive crossing above the LCL
  let lfcP: number | null = null, elP: number | null = null;
  let cape = 0, cin = 0;
  for (let i = 1; i < buoy.length; i++) {
    const a = buoy[i - 1], b = buoy[i];
    if (b.p > l.p) continue;
    if (lfcP == null && b.b > 0) lfcP = a.b > 0 ? Math.min(l.p, a.p) : a.p - ((a.p - b.p) * a.b) / (a.b - b.b || 1);
    if (lfcP != null && a.b > 0 && b.b <= 0) elP = a.p - ((a.p - b.p) * a.b) / (a.b - b.b || 1);
  }
  for (let i = 1; i < buoy.length; i++) {
    const a = buoy[i - 1], b = buoy[i];
    const e = RD * ((a.b + b.b) / 2) * Math.log(a.p / b.p);
    if (lfcP != null && b.p <= lfcP && (elP == null || a.p >= elP)) {
      if (e > 0) cape += e;
    } else if (lfcP != null && a.p > lfcP && e < 0) cin += e;
    else if (lfcP == null && e < 0 && b.p > 300) cin += e;
  }
  if (cape < 1) {
    cape = 0;
    if (lfcP == null) elP = null;
  }
  const t500 = atP(L, 500, (x) => x.t);
  const pt500 = p0 > 500 ? parcelT(p0, t0, td0, l, 500) : null;
  return { kind, p0, t0, td0, lclP: l.p, lclZ: zAtP(L, l.p), lfcP, elP, cape, cin: Math.min(0, cin), li: t500 != null && pt500 != null ? t500 - pt500 : null, trace };
}

export function sbParcel(L: Level[]): Parcel | null {
  const s = L[0];
  if (s.td == null) return null;
  return liftParcel(L, "SB", s.p, s.t, s.td);
}

/** Mean of the lowest 100 hPa: potential temperature and mixing ratio. */
export function mlParcel(L: Level[]): Parcel | null {
  const s = L[0];
  const top = s.p - 100;
  let th = 0, w = 0, n = 0;
  for (let p = s.p; p >= top; p -= 2) {
    const t = atP(L, p, (x) => x.t);
    const td = atP(L, p, (x) => x.td);
    if (t == null || td == null) continue;
    th += theta(p, t);
    w += mixr(p, td);
    n++;
  }
  if (!n) return null;
  th /= n;
  w /= n;
  const t0 = dryT(s.p, th);
  return liftParcel(L, "ML", s.p, t0, Math.min(t0, tdOf(s.p, w)));
}

/** Highest theta-e in the lowest 300 hPa. */
export function muParcel(L: Level[]): Parcel | null {
  let best: Level | null = null, be = -1;
  for (const l of L) {
    if (l.p < L[0].p - 300) break;
    if (l.td == null) continue;
    const e = thetaE(l.p, l.t, l.td);
    if (e > be) (be = e), (best = l);
  }
  return best ? liftParcel(L, "MU", best.p, best.t, best.td!) : null;
}

// ---------- kinematics ----------

export interface Kin {
  shear1: number | null;
  shear3: number | null;
  shear6: number | null;
  rm: [number, number] | null;
  lm: [number, number] | null;
  mean6: [number, number] | null;
  srh1: number | null;
  srh3: number | null;
}

function shear(L: Level[], z: number): number | null {
  const a = windAtZ(L, 0), b = windAtZ(L, z);
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null;
}

function meanWind(L: Level[], z0: number, z1: number): [number, number] | null {
  let u = 0, v = 0, n = 0;
  for (let z = z0; z <= z1 + 1; z += 100) {
    const w = windAtZ(L, z);
    if (!w) continue;
    u += w[0];
    v += w[1];
    n++;
  }
  return n ? [u / n, v / n] : null;
}

/** storm-relative helicity (m²/s²) from 0 to z for storm motion c (kt) */
function srh(L: Level[], z: number, c: [number, number]): number | null {
  let s = 0, prev: [number, number] | null = null, any = false;
  for (let h = 0; h <= z; h += 100) {
    const w = windAtZ(L, h);
    if (!w) continue;
    if (prev) {
      s += (w[0] - c[0]) * (prev[1] - c[1]) - (prev[0] - c[0]) * (w[1] - c[1]);
      any = true;
    }
    prev = w;
  }
  return any ? s * KT * KT : null;
}

export function kinematics(L: Level[]): Kin {
  const mean6 = meanWind(L, 0, 6000);
  const lo = meanWind(L, 0, 500), hi = meanWind(L, 5500, 6000);
  let rm: [number, number] | null = null, lm: [number, number] | null = null;
  if (mean6 && lo && hi) {
    const sh = [hi[0] - lo[0], hi[1] - lo[1]];
    const m = Math.hypot(sh[0], sh[1]) || 1;
    const d = 7.5 / KT;
    rm = [mean6[0] + (d * sh[1]) / m, mean6[1] - (d * sh[0]) / m];
    lm = [mean6[0] - (d * sh[1]) / m, mean6[1] + (d * sh[0]) / m];
  }
  return {
    shear1: shear(L, 1000),
    shear3: shear(L, 3000),
    shear6: shear(L, 6000),
    rm,
    lm,
    mean6,
    srh1: rm ? srh(L, 1000, rm) : null,
    srh3: rm ? srh(L, 3000, rm) : null,
  };
}

// ---------- everything ----------

export interface Indices {
  sb: Parcel | null;
  ml: Parcel | null;
  mu: Parcel | null;
  pwat: number | null;
  lr03: number | null;
  lr75: number | null;
  frz: number | null;
  wbz: number | null;
  kin: Kin;
  stp: number | null;
  scp: number | null;
}

export function analyze(L: Level[]): Indices {
  const sb = sbParcel(L), ml = mlParcel(L), mu = muParcel(L);
  // precipitable water (mm)
  let pwat = 0, ok = false;
  for (let i = 1; i < L.length; i++) {
    const a = L[i - 1], b = L[i];
    if (a.td == null || b.td == null || b.p < 100) continue;
    pwat += ((mixr(a.p, a.td) + mixr(b.p, b.td)) / 2) * (a.p - b.p) * 100 / G;
    ok = true;
  }
  const t3 = atZ(L, 3000, (l) => l.t);
  const lr03 = t3 != null ? (L[0].t - t3) / 3 : null;
  const t7 = atP(L, 700, (l) => l.t), t5 = atP(L, 500, (l) => l.t), z7 = zAtP(L, 700), z5 = zAtP(L, 500);
  const lr75 = t7 != null && t5 != null && z7 != null && z5 != null ? ((t7 - t5) / (z5 - z7)) * 1000 : null;
  const cross = (f: (l: Level) => number | null): number | null => {
    for (let i = 0; i < L.length; i++) {
      const v = f(L[i]);
      if (v == null) continue;
      if (i === 0 && v <= 0) return 0;
      if (i > 0 && v <= 0) {
        const pv = f(L[i - 1]);
        if (pv == null) return L[i].z - L[0].z;
        return L[i - 1].z + ((L[i].z - L[i - 1].z) * pv) / (pv - v || 1) - L[0].z;
      }
    }
    return null;
  };
  const frz = cross((l) => l.t);
  const wbz = cross((l) => (l.td != null ? wetbulb(l.p, l.t, l.td) : null));
  const kin = kinematics(L);
  let stp: number | null = null, scp: number | null = null;
  if (sb && kin.srh1 != null && kin.shear6 != null && sb.lclZ != null) {
    const lclT = sb.lclZ < 1000 ? 1 : sb.lclZ > 2000 ? 0 : (2000 - sb.lclZ) / 1000;
    const s6 = kin.shear6 * KT;
    const shT = s6 < 12.5 ? 0 : Math.min(s6, 30) / 20;
    const cinT = sb.cin > -50 ? 1 : sb.cin < -200 ? 0 : (200 + sb.cin) / 150;
    stp = (sb.cape / 1500) * lclT * (kin.srh1 / 150) * shT * cinT;
  }
  if (mu && kin.srh3 != null && kin.shear6 != null) {
    const s6 = kin.shear6 * KT;
    const shT = s6 < 10 ? 0 : s6 > 20 ? 1 : s6 / 20;
    scp = (mu.cape / 1000) * (kin.srh3 / 50) * shT;
  }
  return { sb, ml, mu, pwat: ok ? pwat : null, lr03, lr75, frz, wbz, kin, stp, scp };
}
