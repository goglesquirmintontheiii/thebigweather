// Parser for the server's TBWS sweep format (see server/src/radar/encode.rs).

export const RF = -9999;

export interface Sweep {
  key: string;
  product: string;
  word: 1 | 2;
  complete: boolean;
  nrad: number;
  ngates: number;
  firstGate: number; // m
  gate: number; // m
  scale: number;
  offset: number;
  elevation: number;
  start: number; // ms
  end: number; // ms
  lat: number;
  lon: number;
  height: number;
  nyquist: number;
  vcp: number;
  az: Float32Array; // radial centers
  width: Float32Array;
  lut: Float32Array | null; // raw -> value (8-bit data)
  data: Uint8Array | Uint16Array;
  /** azimuth lookup: 3600 bins of 0.1°, radial index or 65535 */
  azIndex: Uint16Array;
  bytes: number;
}

export function parseSweep(buf: ArrayBuffer, key: string): Sweep {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "TBWS") throw new Error("not a sweep");
  const word = dv.getUint8(6) as 1 | 2;
  const flags = dv.getUint8(7);
  const nrad = dv.getUint16(8, true);
  const ngates = dv.getUint16(10, true);
  const f = (o: number) => dv.getFloat32(o, true);
  let name = "";
  for (let i = 0; i < 8; i++) {
    const c = dv.getUint8(64 + i);
    if (c) name += String.fromCharCode(c);
  }
  const lutLen = dv.getUint16(74, true);
  let o = 80;
  const az = new Float32Array(buf.slice(o, o + nrad * 4));
  o += nrad * 4;
  const width = new Float32Array(buf.slice(o, o + nrad * 4));
  o += nrad * 4;
  let lut: Float32Array | null = null;
  if (lutLen) {
    lut = new Float32Array(buf.slice(o, o + lutLen * 4));
    o += lutLen * 4;
  }
  const n = nrad * ngates;
  const data = word === 2 ? new Uint16Array(buf.slice(o, o + n * 2)) : new Uint8Array(buf.slice(o, o + n));
  const s: Sweep = {
    key,
    product: name,
    word,
    complete: (flags & 1) !== 0,
    nrad,
    ngates,
    firstGate: f(12),
    gate: f(16),
    scale: f(20),
    offset: f(24),
    elevation: f(28),
    start: dv.getFloat64(32, true),
    end: dv.getFloat64(40, true),
    lat: f(48),
    lon: f(52),
    height: f(56),
    nyquist: f(60),
    vcp: dv.getUint16(72, true),
    az,
    width,
    lut,
    data,
    azIndex: buildAzIndex(az, width),
    bytes: buf.byteLength,
  };
  return s;
}

/** Map 0.1° azimuth bins to the radial covering them (nearest center within its width). */
function buildAzIndex(az: Float32Array, width: Float32Array): Uint16Array {
  const out = new Uint16Array(3600).fill(65535);
  const best = new Float32Array(3600).fill(1e9);
  for (let i = 0; i < az.length; i++) {
    const w = Math.max(width[i] || 1, 0.5);
    const half = w / 2 + 0.05;
    const lo = Math.floor((az[i] - half) * 10);
    const hi = Math.ceil((az[i] + half) * 10);
    for (let b = lo; b <= hi; b++) {
      const bin = ((b % 3600) + 3600) % 3600;
      const center = (bin + 0.5) / 10;
      let d = Math.abs(center - az[i]);
      if (d > 180) d = 360 - d;
      if (d <= half && d < best[bin]) {
        best[bin] = d;
        out[bin] = i;
      }
    }
  }
  return out;
}

/** Physical value at a radial/gate, NaN = no data, RF = range folded. */
export function rawToValue(s: Sweep, raw: number): number {
  if (s.lut) return s.lut[raw];
  if (raw === 0) return NaN;
  if (raw === 1) return RF;
  return (raw - s.offset) / s.scale;
}

const R_EARTH = 6371000;

/** Value at a lat/lon, plus range/azimuth from the radar. */
export function sampleAt(s: Sweep, lat: number, lon: number): { value: number; range: number; az: number; height: number } | null {
  const toR = Math.PI / 180;
  const p1 = s.lat * toR, p2 = lat * toR, dl = (lon - s.lon) * toR;
  const cosc = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  const c = Math.acos(Math.min(1, Math.max(-1, cosc)));
  const ground = c * R_EARTH;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const az = ((Math.atan2(y, x) / toR) + 360) % 360;
  const el = s.elevation * toR;
  const slant = ground / Math.cos(el);
  // beam height (4/3 earth model) above radar
  const re = R_EARTH * 4 / 3;
  const height = Math.sqrt(slant * slant + re * re + 2 * slant * re * Math.sin(el)) - re;
  const gi = Math.floor((slant - s.firstGate) / s.gate + 0.5);
  const bin = Math.floor(az * 10) % 3600;
  const ri = s.azIndex[bin];
  if (gi < 0 || gi >= s.ngates || ri === 65535) return { value: NaN, range: ground, az, height };
  const raw = s.data[ri * s.ngates + gi];
  return { value: rawToValue(s, raw), range: ground, az, height };
}

/** Maximum data range (m). */
export function sweepRange(s: Sweep): number {
  return s.firstGate + s.ngates * s.gate;
}
