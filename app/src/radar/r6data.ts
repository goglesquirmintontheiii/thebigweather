// radar 0.6: shared data access for the Phase 6 radar tools (TDS, hail, rotation tracks, inspector).
// Own small caches so analysis sweeps don't evict the loop's frames from the controller cache.

import { api } from "../api";
import { parseSweep, type Sweep } from "./sweep";

export interface TiltInfo {
  index: number;
  angle: number;
  moments: string[];
  time: number;
  complete: boolean;
}
export interface VolInfo {
  key: string;
  site: string;
  lat: number;
  lon: number;
  time: number;
  complete: boolean;
  tilts: TiltInfo[];
}

const metas = new Map<string, Promise<VolInfo>>();
export function volMeta(key: string): Promise<VolInfo> {
  let p = metas.get(key);
  if (!p) {
    p = api.get<VolInfo>(`/api/radar/meta?key=${encodeURIComponent(key)}`);
    metas.set(key, p);
    p.then((m) => !m.complete && metas.delete(key)).catch(() => metas.delete(key));
    if (metas.size > 80) metas.delete(metas.keys().next().value!);
  }
  return p;
}

// ---------- sweeps by tilt index ----------
const SWEEPS_MAX = 32;
const sweeps = new Map<string, Promise<Sweep>>();
/** One moment of one tilt (index from the volume meta). Derived products (CREF/ET/VIL) use tilt 0. */
export function sweepAt(key: string, tilt: number, moment: string, signal?: AbortSignal): Promise<Sweep> {
  const k = `${key}|${tilt}|${moment}`;
  let p = sweeps.get(k);
  if (p) {
    // refresh LRU position
    sweeps.delete(k);
    sweeps.set(k, p);
    return p;
  }
  p = api.bin(`/api/radar/sweep?key=${encodeURIComponent(key)}&tilt=${tilt}&moment=${moment}`, signal).then((b) => parseSweep(b, k));
  sweeps.set(k, p);
  p.catch(() => sweeps.delete(k));
  while (sweeps.size > SWEEPS_MAX) sweeps.delete(sweeps.keys().next().value!);
  return p;
}

/** Tilts carrying `moment`, lowest first, collapsing SAILS repeats (first of each angle). */
export function tiltsWith(m: VolInfo, moment: string): TiltInfo[] {
  const out: TiltInfo[] = [];
  for (const t of [...m.tilts].sort((a, b) => a.angle - b.angle || a.index - b.index)) {
    if (!t.moments.includes(moment)) continue;
    if (out.some((o) => Math.abs(o.angle - t.angle) < 0.15)) continue;
    out.push(t);
  }
  return out;
}

/** Tilt with `moment` nearest to `angle`. */
export function nearestTilt(m: VolInfo, moment: string, angle: number): TiltInfo | undefined {
  let best: TiltInfo | undefined;
  for (const t of m.tilts) if (t.moments.includes(moment) && (!best || Math.abs(t.angle - angle) < Math.abs(best.angle - angle))) best = t;
  return best;
}

// ---------- rotation detections per volume ----------
const rot = new Map<string, Promise<any>>();
export function rotationFor(key: string): Promise<any> {
  let p = rot.get(key);
  if (!p) {
    p = api.get(`/api/radar/rotation?key=${encodeURIComponent(key)}`);
    rot.set(key, p);
    p.catch(() => rot.delete(key));
    if (rot.size > 120) rot.delete(rot.keys().next().value!);
  }
  return p;
}
export function rotationCached(key: string): boolean {
  return rot.has(key);
}

// ---------- freezing level (0 °C and -20 °C heights, m MSL) ----------
export interface Levels {
  h0: number;
  hm20: number;
  src: string;
}
const DEFAULT_LEVELS: Levels = { h0: 3500, hm20: 6600, src: "default (3.5 km)" };
const lvl = new Map<string, Promise<Levels>>();
/** Model sounding near the radar, cached per site/hour; falls back to 3.5 km. */
export function freezingLevels(lat: number, lon: number): Promise<Levels> {
  const k = `${lat.toFixed(1)},${lon.toFixed(1)}|${Math.floor(Date.now() / 3600_000)}`;
  let p = lvl.get(k);
  if (!p) {
    p = api
      .get(`/api/sounding?src=model&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`)
      .then((s: any) => {
        const L = ((s?.levels ?? []) as any[]).filter((l) => l.z != null && l.t != null).sort((a, b) => a.z - b.z);
        const cross = (T: number) => {
          for (let i = 1; i < L.length; i++) {
            const a = L[i - 1], b = L[i];
            if (a.t >= T && b.t < T) return a.z + ((a.t - T) / (a.t - b.t)) * (b.z - a.z);
          }
          return NaN;
        };
        const h0 = cross(0), hm20 = cross(-20);
        if (!Number.isFinite(h0)) return DEFAULT_LEVELS;
        return { h0, hm20: Number.isFinite(hm20) ? hm20 : h0 + 3100, src: "model sounding" };
      })
      .catch(() => DEFAULT_LEVELS);
    lvl.set(k, p);
  }
  return p;
}

// ---------- geometry ----------
const R = 6371000;
const RE = (R * 4) / 3;
/** Beam height above the radar (4/3 earth) for a slant range (m) and elevation (deg). */
export function beamHeight(slant: number, elDeg: number): number {
  const el = (elDeg * Math.PI) / 180;
  return Math.sqrt(slant * slant + RE * RE + 2 * slant * RE * Math.sin(el)) - RE;
}
/** Local x/y (km east/north of the radar) → lat/lon (equirectangular, fine within ~250 km). */
export function xyToLL(lat0: number, lon0: number, xkm: number, ykm: number): [number, number] {
  return [lon0 + xkm / (111.32 * Math.cos((lat0 * Math.PI) / 180)), lat0 + ykm / 110.57];
}
export function llToXY(lat0: number, lon0: number, lat: number, lon: number): [number, number] {
  return [(lon - lon0) * 111.32 * Math.cos((lat0 * Math.PI) / 180), (lat - lat0) * 110.57];
}

/** The fields a worker needs from a sweep (typed arrays are copied by postMessage). */
export function wsweep(s: Sweep) {
  return { nrad: s.nrad, ngates: s.ngates, firstGate: s.firstGate, gate: s.gate, elevation: s.elevation, lat: s.lat, lon: s.lon, height: s.height, nyquist: s.nyquist, az: s.az, azIndex: s.azIndex, data: s.data, lut: s.lut, scale: s.scale, offset: s.offset, product: s.product };
}

// ---------- worker pool (two: dealias + analysis, so a slow volume never blocks the display) ----------
type Job = { resolve: (v: any) => void; reject: (e: any) => void };
class W {
  private w: Worker | null = null;
  private seq = 0;
  private jobs = new Map<number, Job>();
  run<T = any>(op: string, args: any): Promise<T> {
    if (!this.w) {
      this.w = new Worker(new URL("./r6.worker.ts", import.meta.url), { type: "module" });
      this.w.onmessage = (e) => {
        const j = this.jobs.get(e.data.id);
        if (!j) return;
        this.jobs.delete(e.data.id);
        if (e.data.error) j.reject(new Error(e.data.error));
        else j.resolve(e.data.result);
      };
      this.w.onerror = (e) => {
        for (const j of this.jobs.values()) j.reject(new Error(e.message || "worker error"));
        this.jobs.clear();
      };
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.w!.postMessage({ id, op, args });
    });
  }
}
export const dealiasWorker = new W();
export const analysisWorker = new W();
