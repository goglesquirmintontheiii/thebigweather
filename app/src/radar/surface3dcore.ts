// 0.8.3 3d: pure helpers for 3D height surfaces (no DOM / WebGL, unit-tested in tests/view3d083.test.ts).
// A 2D product (a Level III / single-tilt sweep, composite, echo tops, VIL, any MRMS / model grid) is
// decimated onto a capped grid in mercator space by max-pooling (peaks survive the decimation;
// velocity keeps the value with the largest |v|), then drawn as a surface whose height follows the
// value (|v| for velocity). Echo-top style products use their value as the real height.

import { rawToValue, RF, type Sweep } from "./sweep";
import type { Raster } from "../grid/raster";

/** Regular grid in mercator (0..1) space: node (i, j) sits at x0 + (i + 0.5)·dx, y0 + (j + 0.5)·dy. */
export interface Field {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** nx*ny values, x fastest; NaN = no data */
  v: Float32Array;
  /** max |value| / value present (for quick "anything to draw?" checks) */
  valid: number;
}

/** value → height (m, before vertical exaggeration) */
export interface HeightMap {
  lo: number;
  hi: number;
  /** height of `hi` (m) */
  top: number;
  /** the value is itself a height: metres per unit (echo tops in kft / km) */
  perUnit?: number;
  abs: boolean;
}

/** Most surfaces top out here before exaggeration (m). */
export const SURF_TOP = 8000;
/** grid side caps (nodes) for the two quality levels; ≤ 360² ≈ 130k vertices keeps integrated GPUs happy */
export const SURF_N = { lo: 200, hi: 360 } as const;

export function heightMapFor(t: { id?: string; name?: string; units: string; min: number; max: number }, abs: boolean): HeightMap {
  const u = (t.units || "").toLowerCase();
  const isTop = /^e?et|top/i.test(t.id ?? "") || /top/i.test(t.name ?? "");
  if (isTop) {
    const per = u === "kft" ? 304.8 : u === "km" ? 1000 : u === "ft" ? 0.3048 : u === "m" ? 1 : u === "kft msl" ? 304.8 : 0;
    if (per) return { lo: 0, hi: t.max, top: t.max * per, perUnit: per, abs: false };
  }
  let lo = abs ? 0 : t.min;
  // reflectivity tables start far below anything that matters (−30 dBZ)
  if (!abs && u === "dbz") lo = Math.max(lo, 5);
  const hi = Math.max(t.max, lo + 1e-6);
  return { lo, hi, top: SURF_TOP, abs };
}

/** Height (m) for a value; 0 for no data / at or below the bottom of the scale. */
export function heightOf(v: number, hm: HeightMap): number {
  if (!Number.isFinite(v)) return 0;
  const x = hm.abs ? Math.abs(v) : v;
  if (hm.perUnit) return Math.max(0, Math.min(25_000, x * hm.perUnit));
  const f = (x - hm.lo) / (hm.hi - hm.lo);
  return f <= 0 ? 0 : f >= 1 ? hm.top : f * hm.top;
}

/** keep the stronger of the cell's value and v (|v| for velocity) */
export function pool(out: Float32Array, i: number, v: number, abs: boolean) {
  const o = out[i];
  if (o !== o || (abs ? Math.abs(v) > Math.abs(o) : v > o)) out[i] = v;
}

const mercX = (lonDeg: number) => (lonDeg + 180) / 360;
const mercY = (latDeg: number) => {
  const s = Math.sin((latDeg * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const R_EARTH = 6371000;

/** Grid side for a quality setting. */
export function sideFor(res: "lo" | "hi"): number {
  return SURF_N[res] ?? SURF_N.lo;
}

/** Max-pool a radar sweep onto an n×n mercator grid around the radar (≤ 460 km range). */
export function binSweep(sw: Pick<Sweep, "nrad" | "ngates" | "firstGate" | "gate" | "elevation" | "lat" | "lon" | "az" | "data" | "lut" | "offset" | "scale">, n: number, abs: boolean): Field {
  const rmax = Math.min(460_000, sw.firstGate + sw.ngates * sw.gate);
  const lat0 = sw.lat, lon0 = sw.lon;
  const cosEl = Math.cos((sw.elevation * Math.PI) / 180);
  // square in mercator, sized at the poleward edge so the whole circle fits
  const latEdge = Math.min(85, Math.abs(lat0) + (rmax / R_EARTH) * (180 / Math.PI));
  const half = rmax / (2 * Math.PI * R_EARTH * Math.cos((latEdge * Math.PI) / 180));
  const cx = mercX(lon0), cy = mercY(lat0);
  const f: Field = { nx: n, ny: n, x0: cx - half, x1: cx + half, y0: cy - half, y1: cy + half, v: new Float32Array(n * n).fill(NaN), valid: 0 };
  const kx = n / (f.x1 - f.x0), ky = n / (f.y1 - f.y0);
  const cellM = (2 * rmax) / n;
  // half a cell between samples is enough for max-pooling (and 5–10× cheaper than every gate)
  const gs = Math.max(1, Math.floor(cellM / 2 / Math.max(1, sw.gate)));
  const d2r = Math.PI / 180;
  const latR0 = lat0 * d2r;
  const data = sw.data, ng = sw.ngates;
  let valid = 0;
  for (let ri = 0; ri < sw.nrad; ri++) {
    const az = sw.az[ri] * d2r;
    const sa = Math.sin(az), ca = Math.cos(az);
    const row = ri * ng;
    for (let g = 0; g < ng; g += gs) {
      const raw = data[row + g];
      if (!sw.lut && raw === 0) continue;
      const v = rawToValue(sw as Sweep, raw);
      if (!(v === v) || v === RF) continue;
      const r = (sw.firstGate + g * sw.gate) * cosEl;
      if (r > rmax) break;
      const lat = latR0 + (r * ca) / R_EARTH;
      const x = cx + (r * sa) / (R_EARTH * Math.cos(lat)) / (2 * Math.PI);
      const s = Math.sin(lat);
      const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      const i = Math.floor((x - f.x0) * kx), j = Math.floor((y - f.y0) * ky);
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      pool(f.v, j * n + i, v, abs);
      valid++;
    }
  }
  f.valid = valid;
  fillHoles(f, abs);
  return f;
}

/** Max-pool a gridded raster (values, not RGB) onto a grid whose longer side is ≤ n. */
export function binRaster(r: Pick<Raster, "w" | "h" | "x0" | "y0" | "x1" | "y1" | "data" | "scale" | "offset" | "rgba">, n: number, abs: boolean): Field | null {
  if (r.rgba || !r.w || !r.h) return null;
  const k = Math.min(1, n / Math.max(r.w, r.h));
  const nx = Math.max(2, Math.round(r.w * k)), ny = Math.max(2, Math.round(r.h * k));
  const f: Field = { nx, ny, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, v: new Float32Array(nx * ny).fill(NaN), valid: 0 };
  const sx = nx / r.w, sy = ny / r.h;
  let valid = 0;
  for (let py = 0; py < r.h; py++) {
    const j = Math.min(ny - 1, Math.floor(py * sy)) * nx;
    const row = py * r.w;
    for (let px = 0; px < r.w; px++) {
      const raw = r.data[row + px];
      if (raw === 0) continue;
      pool(f.v, j + Math.min(nx - 1, Math.floor(px * sx)), r.offset + (raw - 1) * r.scale, abs);
      valid++;
    }
  }
  f.valid = valid;
  return f;
}

/** Fill empty cells surrounded by data (gaps between far-range radials) with the strongest neighbour. */
export function fillHoles(f: Field, abs: boolean) {
  const { nx, ny, v } = f;
  const src = v.slice();
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (src[k] === src[k]) continue;
      let cnt = 0, best = NaN;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const w = src[k + dj * nx + di];
          if (w !== w) continue;
          cnt++;
          if (best !== best || (abs ? Math.abs(w) > Math.abs(best) : w > best)) best = w;
        }
      if (cnt >= 5) v[k] = best;
    }
}

export interface Mesh {
  /** per vertex: x, y (mercator, relative to ref), z (m), value, valid (0/1) */
  verts: Float32Array;
  idx: Uint32Array;
  ref: [number, number];
  /** highest surface point (m) */
  maxH: number;
}
export const MESH_STRIDE = 5;

/** Triangle mesh for a field (one vertex per node; quads with at least one valid corner). */
export function buildMesh(f: Field, hm: HeightMap): Mesh {
  const { nx, ny } = f;
  const dx = (f.x1 - f.x0) / nx, dy = (f.y1 - f.y0) / ny;
  const ref: [number, number] = [(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2];
  const verts = new Float32Array(nx * ny * MESH_STRIDE);
  let maxH = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const val = f.v[k];
      const ok = val === val;
      const h = ok ? heightOf(val, hm) : 0;
      if (h > maxH) maxH = h;
      const o = k * MESH_STRIDE;
      verts[o] = f.x0 + (i + 0.5) * dx - ref[0];
      verts[o + 1] = f.y0 + (j + 0.5) * dy - ref[1];
      verts[o + 2] = h;
      verts[o + 3] = ok ? val : 0;
      verts[o + 4] = ok ? 1 : 0;
    }
  // count first so the index buffer is exact
  let quads = 0;
  const ok = (k: number) => f.v[k] === f.v[k];
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i;
      if (ok(k) || ok(k + 1) || ok(k + nx) || ok(k + nx + 1)) quads++;
    }
  const idx = new Uint32Array(quads * 6);
  let p = 0;
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (!(ok(a) || ok(b) || ok(c) || ok(d))) continue;
      idx[p++] = a; idx[p++] = b; idx[p++] = d;
      idx[p++] = a; idx[p++] = d; idx[p++] = c;
    }
  return { verts, idx, ref, maxH };
}

/** Field node value nearest a mercator point (NaN outside / no data). */
export function fieldAt(f: Field, x: number, y: number): number {
  const i = Math.floor(((x - f.x0) / (f.x1 - f.x0)) * f.nx), j = Math.floor(((y - f.y0) / (f.y1 - f.y0)) * f.ny);
  if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return NaN;
  return f.v[j * f.nx + i];
}

/**
 * First hit of a ray with the surface. a, b: ray ends in mercator x, y and height in metres (exaggerated
 * heights divided back out by the caller: pass zScale = exaggeration). Returns the node value and height.
 */
export function raySurface(f: Field, hm: HeightMap, a: [number, number, number], b: [number, number, number], exag: number, steps = 600): { x: number; y: number; value: number; h: number } | null {
  let prevAbove = true;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
    const v = fieldAt(f, x, y);
    const h = heightOf(v, hm) * exag;
    const above = z > h;
    if (!above && prevAbove && v === v && s > 0) return { x, y, value: v, h: h / exag };
    prevAbove = above;
  }
  return null;
}

/* ---------- 3D source selection (shared by the main map and the panes) ---------- */

/** products whose height uses |value| */
export function isVelocityTable(tableKey: string): boolean {
  return tableKey === "VEL" || tableKey === "SRV" || tableKey === "DVEL";
}
/** categorical / colour-only tables have no meaningful height */
export function surfaceable(t: { labels?: Record<number, string>; units?: string } | null | undefined): boolean {
  return !!t && !t.labels && t.units !== "class";
}

/** Live (in-progress) volume URLs carry a version so the volume refreshes as new tilts arrive. */
export function liveVersion(key: string, tiltsSeen: number): string {
  return key.startsWith("live:") ? `&v=${tiltsSeen}` : "";
}
