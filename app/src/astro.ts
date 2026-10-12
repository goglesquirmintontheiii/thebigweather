// data 0.6: sun and moon positions, moon phase and rise/set times (after SunCalc, V. Agafonkin,
// BSD) for the stargazing tab. Accurate to a minute or two, plenty for planning a night out.

const rad = Math.PI / 180;
const dayMs = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // obliquity of the Earth

const toDays = (t: number) => t / dayMs - 0.5 + J1970 - J2000;
const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const altitude = (H: number, phi: number, dec: number) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d: number, lw: number) => rad * (280.16 + 360.9856235 * d) - lw;
const solarMeanAnomaly = (d: number) => rad * (357.5291 + 0.98560028 * d);
function eclipticLongitude(M: number) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + rad * 102.9372 + Math.PI;
}
function sunCoords(d: number) {
  const L = eclipticLongitude(solarMeanAnomaly(d));
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}
function moonCoords(d: number) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

/** sun altitude in degrees */
export function sunAlt(t: number, lat: number, lon: number): number {
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(t);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return altitude(H, phi, c.dec) / rad;
}

/** moon altitude in degrees (with refraction) */
export function moonAlt(t: number, lat: number, lon: number): number {
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(t);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitude(H, phi, c.dec);
  h = h + rad * 0.017 / Math.tan(h + rad * 10.26 / (h / rad + 5.1)); // refraction
  return h / rad;
}

/** illuminated fraction (0..1), phase (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter) */
export function moonIllum(t: number): { fraction: number; phase: number; name: string } {
  const d = toDays(t);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  const fraction = (1 + Math.cos(inc)) / 2;
  const phase = 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI;
  return { fraction, phase, name: phaseName(phase) };
}
function phaseName(p: number): string {
  if (p < 0.03 || p > 0.97) return "New moon";
  if (p < 0.22) return "Waxing crescent";
  if (p < 0.28) return "First quarter";
  if (p < 0.47) return "Waxing gibbous";
  if (p < 0.53) return "Full moon";
  if (p < 0.72) return "Waning gibbous";
  if (p < 0.78) return "Last quarter";
  return "Waning crescent";
}

/** times in [t0, t1) where f crosses `h` upward (rise) and downward (set), 5-minute scan */
export function crossings(f: (t: number) => number, t0: number, t1: number, h: number): { up: number[]; down: number[] } {
  const up: number[] = [];
  const down: number[] = [];
  const step = 5 * 60_000;
  let pv = f(t0) - h;
  for (let t = t0 + step; t <= t1; t += step) {
    const v = f(t) - h;
    if (pv < 0 && v >= 0) up.push(t - step * (v / (v - pv)));
    if (pv >= 0 && v < 0) down.push(t - step * (v / (v - pv)));
    pv = v;
  }
  return { up, down };
}

/** dark-sky windows (sun below -18°) in [t0, t1), split by whether the moon is up */
export function darkWindows(lat: number, lon: number, t0: number, t1: number): { start: number; end: number; moonUp: boolean }[] {
  const out: { start: number; end: number; moonUp: boolean }[] = [];
  const step = 10 * 60_000;
  let cur: { start: number; end: number; moonUp: boolean } | null = null;
  for (let t = t0; t < t1; t += step) {
    const dark = sunAlt(t, lat, lon) < -18;
    const mu = moonAlt(t, lat, lon) > 0;
    if (dark && (!cur || cur.moonUp !== mu)) {
      if (cur) out.push(cur);
      cur = { start: t, end: t + step, moonUp: mu };
    } else if (dark && cur) cur.end = t + step;
    else if (!dark && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}
