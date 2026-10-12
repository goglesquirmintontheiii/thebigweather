// Raspberry Shake seismographs: station list, paged + cached waveform requests, and the DSP kit
// the Seismographs window uses (detrend, filters, spectrogram, PSD, window stats, travel times,
// rough ML, CSV/WAV export).

import { signal } from "@preact/signals";
import { api } from "./api";
import { settings, update } from "./store";
import { distance } from "./util";
import { onShakeClick } from "./overlays/defs";
import { popup } from "./overlays/manager";
import { mapRef } from "./map/mapview";

export interface ShakeSta {
  net: string;
  sta: string;
  name?: string;
  elev?: number | null;
  start?: string | null;
  end?: string | null;
  lon: number;
  lat: number;
}
export interface ShakeChan {
  loc: string;
  cha: string;
  sr: number;
  start?: string | null;
  end?: string | null;
  /** counts per physical unit (e.g. counts/(m/s)) */
  scale?: number | null;
  units?: string | null;
  sensor?: string | null;
}
export interface Wave {
  sr: number;
  start: number;
  samples: Float32Array;
  gaps: [number, number][];
}

/** the station shown in the viewer (null = browser only) */
export const shakeSel = signal<ShakeSta | null>(null);
export const shakeOpen = signal(false);
/** extra stations for the compare view */
export const shakeCompare = signal<ShakeSta[]>([]);

export const staKey = (s: { net: string; sta: string }) => `${s.net}.${s.sta}`;

let stations: ShakeSta[] | null = null;
let loading: Promise<ShakeSta[]> | null = null;

export function loadStations(): Promise<ShakeSta[]> {
  if (stations) return Promise.resolve(stations);
  if (!loading)
    loading = api
      .get("/api/ovl/shake")
      .then((fc) => {
        stations = (fc.features ?? []).filter((f: any) => f.geometry?.coordinates).map((f: any) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
        return stations!;
      })
      .finally(() => (loading = null));
  return loading;
}

export function openShake(s: ShakeSta | null) {
  shakeSel.value = s;
  shakeOpen.value = true;
}

export const isActive = (s: ShakeSta) => !s.end || Date.parse(s.end) > Date.now() - 86400000;

/** the map layer is hidden from the Layers list and toggled from the Seismographs window */
export function shakeLayerOn() {
  return !!settings.value.ovl.shake?.on;
}
export function setShakeLayer(on: boolean) {
  update((s) => (s.ovl.shake = { ...(s.ovl.shake ?? {}), on }));
}
export function isFav(s: ShakeSta) {
  return (settings.value.shake?.favs ?? []).includes(staKey(s));
}
export function toggleFav(s: ShakeSta) {
  const k = staKey(s);
  update((x) => {
    const f = x.shake?.favs ?? [];
    x.shake = { ...(x.shake ?? { favs: [] }), favs: f.includes(k) ? f.filter((y) => y !== k) : [...f, k] };
  });
}

// map clicks: clusters zoom in, stations open the seismograph (the popup only lends its position)
onShakeClick((p) => {
  setTimeout(() => {
    const pp = popup.value;
    if (pp?.overlay === "shake") popup.value = null;
    const m = mapRef.value;
    if (p.cluster) {
      if (m && pp) m.easeTo({ center: [pp.lng, pp.lat], zoom: Math.min(m.getZoom() + 2, 12) });
      return;
    }
    const known = stations?.find((x) => x.net === p.net && x.sta === p.sta);
    openShake(known ?? { net: p.net, sta: p.sta, name: p.name, elev: p.elev, start: p.start, end: p.end, lon: pp?.lng ?? 0, lat: pp?.lat ?? 0 });
  }, 0);
});

const chanCache = new Map<string, Promise<ShakeChan[]>>();
export function channels(s: ShakeSta): Promise<ShakeChan[]> {
  const k = staKey(s);
  if (!chanCache.has(k)) {
    const p = api.get(`/api/shake/channels?net=${encodeURIComponent(s.net)}&sta=${encodeURIComponent(s.sta)}`);
    p.catch(() => chanCache.delete(k));
    chanCache.set(k, p);
  }
  return chanCache.get(k)!;
}
/** channels still recording (falls back to all) */
export function liveChans(cs: ShakeChan[]) {
  const live = cs.filter((c) => !c.end || Date.parse(c.end) > Date.now() - 86400000);
  return live.length ? live : cs;
}
/** best vertical channel, or a given component (Z/N/E) */
export function pickChan(cs: ShakeChan[], comp = "Z"): ShakeChan | undefined {
  const l = liveChans(cs);
  return ["EH", "SH", "HH", "EN", "HN"].map((b) => l.find((c) => c.cha === b + comp)).find(Boolean) ?? l.find((c) => c.cha.endsWith(comp)) ?? l[0];
}

export async function waveform(s: ShakeSta, c: ShakeChan, start: number, end: number, sig?: AbortSignal): Promise<Wave> {
  const q = new URLSearchParams({ net: s.net, sta: s.sta, loc: c.loc ?? "", cha: c.cha, start: String(Math.round(start)), end: String(Math.round(end)) });
  const r = await api.get(`/api/shake/data?${q}`, sig);
  if (r.error) throw new Error(r.error);
  const raw: (number | null)[] = r.samples ?? [];
  const x = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) x[i] = raw[i] == null ? NaN : (raw[i] as number);
  return { sr: r.sr, start: r.start, samples: x, gaps: r.gaps ?? [] };
}

// ---------- paged + cached requests (server limit: 2 h per request) ----------

const CHUNK = 3600000;
/** data younger than this may still grow on the server */
const FRESH = 45 * 60000;
const cache = new Map<string, { w: Wave; at: number; done: boolean }>();
let cacheSamples = 0;
const CACHE_MAX = 60e6;

function cachePut(k: string, w: Wave, done: boolean) {
  const old = cache.get(k);
  if (old) cacheSamples -= old.w.samples.length;
  cache.set(k, { w, at: Date.now(), done });
  cacheSamples += w.samples.length;
  for (const [kk, v] of cache) {
    if (cacheSamples <= CACHE_MAX) break;
    cache.delete(kk);
    cacheSamples -= v.w.samples.length;
  }
}

async function cachedPiece(s: ShakeSta, c: ShakeChan, a: number, b: number, sig?: AbortSignal): Promise<Wave> {
  const k = `${staKey(s)}.${c.loc}.${c.cha}:${a}:${b}`;
  const hit = cache.get(k);
  if (hit && (hit.done || Date.now() - hit.at < 110000)) {
    cache.delete(k);
    cache.set(k, hit); // LRU touch
    return hit.w;
  }
  const w = await waveform(s, c, a, b, sig);
  cachePut(k, w, b < Date.now() - FRESH);
  return w;
}

/** Up to 12 h: hour-aligned pieces (cached), 3 at a time, merged onto one sample grid. */
export async function fetchRange(s: ShakeSta, c: ShakeChan, start: number, end: number, onProg?: (f: number) => void, sig?: AbortSignal): Promise<Wave> {
  end = Math.min(end, start + 12 * 3600000);
  const pieces: [number, number][] = [];
  if (end - start <= 2 * 3600000) pieces.push([start, end]);
  else for (let t = Math.floor(start / CHUNK) * CHUNK; t < end; t += CHUNK) pieces.push([Math.max(t, start), Math.min(t + CHUNK, end)]);
  // aligned whole hours are reusable cache keys; trim the partial ends to the request
  const keyed = pieces.map(([a, b]) => (pieces.length > 1 ? [Math.floor(a / CHUNK) * CHUNK, Math.floor(a / CHUNK) * CHUNK + CHUNK] : [a, b]) as [number, number]);
  const got: (Wave | null)[] = new Array(keyed.length).fill(null);
  let done = 0;
  onProg?.(0);
  let next = 0;
  const worker = async () => {
    while (next < keyed.length) {
      if (sig?.aborted) throw new DOMException("Aborted", "AbortError"); // p7: a superseded load stops (cache hits never throw)
      const i = next++;
      const [a, b] = keyed[i];
      try {
        got[i] = await cachedPiece(s, c, a, Math.min(b, Date.now()), sig);
      } catch (e: any) {
        if (e?.name === "AbortError") throw e;
        got[i] = null;
      }
      done++;
      if (!sig?.aborted) onProg?.(done / keyed.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (sig?.aborted) throw new DOMException("Aborted", "AbortError");
  // p7: an empty piece can come back without a sample rate; take it from one that has samples
  const ok = (got.filter(Boolean) as Wave[]).filter((w) => w.samples.length > 0 && w.sr > 0);
  if (!ok.length) throw new Error("No data in this window");
  const sr = ok[0].sr;
  const n = Math.max(0, Math.round(((end - start) / 1000) * sr));
  const out = new Float32Array(n).fill(NaN);
  const gaps: [number, number][] = [];
  got.forEach((w, i) => {
    if (!w) {
      gaps.push([Math.max(keyed[i][0], start), Math.min(keyed[i][1], end)]);
      return;
    }
    const off = Math.round(((w.start - start) / 1000) * sr);
    for (let j = 0; j < w.samples.length; j++) {
      const k = off + j;
      if (k >= 0 && k < n) out[k] = w.samples[j];
    }
    for (const g of w.gaps) if (g[1] > start && g[0] < end) gaps.push([Math.max(g[0], start), Math.min(g[1], end)]);
  });
  // a range that never got data (server had none yet) is a gap too
  let lastIdx = n - 1;
  while (lastIdx >= 0 && Number.isNaN(out[lastIdx])) lastIdx--;
  if (lastIdx < n - 1 && lastIdx >= 0) gaps.push([start + ((lastIdx + 1) / sr) * 1000, end]);
  if (lastIdx < 0) throw new Error("No data in this window");
  return { sr, start, samples: out.subarray(0, lastIdx + 1), gaps };
}

// ---------- DSP ----------

export interface FiltOpts {
  detrend: boolean;
  kind: "none" | "bp" | "hp" | "lp";
  lo: number;
  hi: number;
}
export const FILTER_PRESETS: { label: string; f: Partial<FiltOpts> }[] = [
  { label: "Raw", f: { kind: "none" } },
  { label: "Teleseism 0.7–2 Hz", f: { kind: "bp", lo: 0.7, hi: 2 } },
  { label: "Regional 1–5 Hz", f: { kind: "bp", lo: 1, hi: 5 } },
  { label: "Local 1–10 Hz", f: { kind: "bp", lo: 1, hi: 10 } },
  { label: "High 3–20 Hz", f: { kind: "bp", lo: 3, hi: 20 } },
  { label: "Hi-pass 0.5 Hz", f: { kind: "hp", lo: 0.5 } },
  { label: "Lo-pass 1 Hz", f: { kind: "lp", hi: 1 } },
];
export function filtLabel(f: FiltOpts) {
  const k = f.kind === "bp" ? `band-pass ${f.lo}–${f.hi} Hz` : f.kind === "hp" ? `high-pass ${f.lo} Hz` : f.kind === "lp" ? `low-pass ${f.hi} Hz` : "unfiltered";
  return `${f.detrend ? "detrended, " : ""}${k}`;
}

/** Remove mean and linear trend; missing samples (NaN) become 0. */
export function detrend(x: Float32Array): Float32Array {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    sx += i;
    sy += v;
    sxx += i * i;
    sxy += i * v;
    k++;
  }
  const out = new Float32Array(n);
  if (!k) return out;
  const d = k * sxx - sx * sx;
  const b = d ? (k * sxy - sx * sy) / d : 0;
  const a = (sy - b * sx) / k;
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(x[i]) ? x[i] - (a + b * i) : 0;
  return out;
}

/** RBJ cookbook 2nd-order section, run forward then backward (zero phase). */
function biquad(x: Float32Array, kind: "lp" | "hp", f: number, sr: number) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + al;
  const b0 = (kind === "lp" ? (1 - cs) / 2 : (1 + cs) / 2) / a0;
  const b1 = (kind === "lp" ? 1 - cs : -(1 + cs)) / a0;
  const b2 = b0;
  const a1 = (-2 * cs) / a0;
  const a2 = (1 - al) / a0;
  const pass = (from: number, to: number, step: number) => {
    let x1 = x[from], x2 = x[from], y1 = kind === "lp" ? x[from] : 0, y2 = y1;
    for (let i = from; i !== to; i += step) {
      const v = x[i];
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = y;
      x[i] = y;
    }
  };
  pass(0, x.length, 1);
  pass(x.length - 1, -1, -1);
}

/** detrend/fill, filter, then convert counts → physical units when `scale` is given */
export function prep(w: Wave, f: FiltOpts, scale?: number | null): Float32Array {
  let x: Float32Array;
  if (f.detrend) x = detrend(w.samples);
  else {
    x = new Float32Array(w.samples.length);
    let last = 0;
    for (let i = 0; i < x.length; i++) if (Number.isFinite(w.samples[i])) { last = w.samples[i]; break; }
    for (let i = 0; i < x.length; i++) x[i] = Number.isFinite(w.samples[i]) ? (last = w.samples[i]) : last;
  }
  if (x.length > 10) {
    const ny = w.sr / 2;
    if ((f.kind === "bp" || f.kind === "hp") && f.lo > 0 && f.lo < ny) biquad(x, "hp", f.lo, w.sr);
    if ((f.kind === "bp" || f.kind === "lp") && f.hi > 0 && f.hi < ny * 0.98) biquad(x, "lp", f.hi, w.sr);
  }
  if (scale && scale > 0) for (let i = 0; i < x.length; i++) x[i] /= scale;
  return x;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const hann = (n: number) => {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
};

/** Power (dB) per column × frequency bin, for samples i0..i1 spread over `cols` columns. */
export function spectrogram(x: Float32Array, i0: number, i1: number, cols: number, nfft: number): { db: Float32Array; bins: number; lo: number; hi: number } {
  const bins = nfft / 2;
  const db = new Float32Array(cols * bins);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const win = hann(nfft);
  const span = i1 - i0;
  for (let c = 0; c < cols; c++) {
    const mid = Math.round(i0 + ((c + 0.5) / cols) * span);
    const s = mid - nfft / 2;
    for (let i = 0; i < nfft; i++) {
      const k = s + i;
      re[i] = k >= 0 && k < x.length ? x[k] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) db[c * bins + b] = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-30);
  }
  // p7: levels from real signal only: gaps/padding are exact zeros (-300 dB) and would squash the
  // colour range (a window with a gap rendered as one flat colour, looking like it never loaded)
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(db.length / 4000));
  for (let i = 0; i < db.length; i += step) if (db[i] > -250 && Number.isFinite(db[i])) sample.push(db[i]);
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.08)] ?? 0;
  let hi = sample[Math.floor(sample.length * 0.995)] ?? lo + 1;
  if (!(hi > lo)) hi = lo + 1;
  return { db, bins, lo, hi };
}

/** Welch PSD (Hann, 50 % overlap): frequencies and power in dB (re unit²/Hz). */
export function psd(x: Float32Array, i0: number, i1: number, sr: number): { f: Float32Array; db: Float32Array } {
  i0 = Math.max(0, Math.floor(i0));
  i1 = Math.min(x.length, Math.floor(i1));
  const len = i1 - i0;
  let nfft = 64;
  while (nfft * 2 <= Math.min(4096, len / 2 || 64)) nfft *= 2;
  const bins = nfft / 2 + 1;
  const acc = new Float64Array(bins);
  const win = hann(nfft);
  let u = 0;
  for (let i = 0; i < nfft; i++) u += win[i] * win[i];
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  let segs = 0;
  for (let s = i0; s + nfft <= i1 || segs === 0; s += nfft / 2) {
    for (let i = 0; i < nfft; i++) {
      const k = s + i;
      re[i] = k < i1 ? x[k] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) acc[b] += re[b] * re[b] + im[b] * im[b];
    segs++;
    if (s + nfft >= i1) break;
  }
  const f = new Float32Array(bins);
  const db = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    f[b] = (b * sr) / nfft;
    db[b] = 10 * Math.log10(((b === 0 || b === bins - 1 ? 1 : 2) * acc[b]) / (segs * sr * u) + 1e-30);
  }
  return { f, db };
}

export interface WinStats {
  peak: number;
  peakT: number;
  rms: number;
  domF: number;
  p2p: number;
}
export function winStats(x: Float32Array, sr: number, start: number, t0: number, t1: number): WinStats | null {
  const i0 = Math.max(0, Math.floor(((t0 - start) / 1000) * sr));
  const i1 = Math.min(x.length, Math.ceil(((t1 - start) / 1000) * sr));
  if (i1 - i0 < 8) return null;
  let pk = 0, pi = i0, ss = 0, mn = Infinity, mx = -Infinity;
  for (let i = i0; i < i1; i++) {
    const v = x[i];
    if (Math.abs(v) > pk) {
      pk = Math.abs(v);
      pi = i;
    }
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    ss += v * v;
  }
  const p = psd(x, i0, i1, sr);
  let best = -Infinity, domF = 0;
  for (let b = 1; b < p.f.length; b++)
    if (p.f[b] >= 0.1 && p.db[b] > best) {
      best = p.db[b];
      domF = p.f[b];
    }
  return { peak: pk, peakT: start + (pi / sr) * 1000, rms: Math.sqrt(ss / (i1 - i0)), domF, p2p: mx - mn };
}

/** Very rough local magnitude from peak ground velocity (m/s) at the dominant frequency:
 * velocity → displacement, Wood-Anderson gain 2080, Hutton & Boore (1987) distance term. */
export function mlRough(peakVel: number, domF: number, hypoKm: number): number | null {
  if (!(peakVel > 0 && domF > 0 && hypoKm > 0)) return null;
  const dispM = peakVel / (2 * Math.PI * domF);
  const waMm = dispM * 1000 * 2080;
  return Math.log10(waMm) + 1.11 * Math.log10(hypoKm) + 0.00189 * hypoKm - 2.09;
}

/** inferno-like palette, 256 entries of [r,g,b] */
export const PALETTE: Uint8ClampedArray = (() => {
  const stops = [
    [0, 0, 0, 4],
    [0.15, 31, 12, 72],
    [0.3, 85, 15, 109],
    [0.45, 136, 34, 106],
    [0.6, 186, 54, 85],
    [0.75, 227, 89, 51],
    [0.88, 249, 140, 10],
    [1, 252, 255, 164],
  ];
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    out[i * 3] = r0 + (r1 - r0) * f;
    out[i * 3 + 1] = g0 + (g1 - g0) * f;
    out[i * 3 + 2] = b0 + (b1 - b0) * f;
  }
  return out;
})();

// ---------- earthquakes + travel times ----------

export interface Quake {
  id: string;
  mag: number;
  place: string;
  time: number;
  lat: number;
  lon: number;
  depth: number;
  url?: string;
}
export interface Arrival {
  km: number;
  hypo: number;
  p: number;
  s: number;
}

// surface-focus P and S times (s) by distance (deg), rounded from the Jeffreys–Bullen tables
const TT: [number, number, number][] = [
  [10, 145, 258],
  [15, 212, 380],
  [20, 276, 500],
  [30, 373, 673],
  [40, 458, 828],
  [50, 537, 970],
  [60, 607, 1100],
  [70, 668, 1215],
  [80, 723, 1320],
  [90, 773, 1410],
  [100, 818, 1490],
];

/** Rough P/S travel times (s): direct crustal waves near the source, Pn/Sn regionally,
 * a coarse table beyond 10°. Beyond ~100° (shadow zone) P is extrapolated. */
export function travel(km: number, depthKm = 10): { p: number; s: number } {
  const hypo = Math.hypot(km, depthKm);
  if (km < 150) return { p: hypo / 6.1, s: hypo / 3.55 };
  const deg = km / 111.19;
  if (deg < 10) {
    // blend Pn/Sn into the table so the curve stays continuous at 10°
    const pn = km / 8.0 + 7, sn = km / 4.5 + 12;
    return { p: pn, s: sn };
  }
  let i = 0;
  while (i < TT.length - 2 && deg > TT[i + 1][0]) i++;
  const [d0, p0, s0] = TT[i];
  const [d1, p1, s1] = TT[i + 1];
  const f = (deg - d0) / (d1 - d0);
  return { p: p0 + (p1 - p0) * f, s: s0 + (s1 - s0) * f };
}

export function arrival(q: Quake, st: ShakeSta): Arrival {
  const km = distance(st.lat, st.lon, q.lat, q.lon) / 1000;
  const t = travel(km, q.depth);
  return { km, hypo: Math.hypot(km, q.depth), p: q.time + t.p * 1000, s: q.time + t.s * 1000 };
}

/** Quakes (from the Earthquakes overlay feed) whose waves could be in [from, to]. */
export async function quakesIn(from: number, to: number): Promise<Quake[]> {
  const age = Date.now() - from;
  const user = settings.value.ovl.quakes?.opts ?? {};
  const period = age > 7 * 86400000 ? "month" : age > 86400000 ? "week" : user.period && user.period !== "hour" ? user.period : "day";
  const mag = period === "day" ? "1.0" : "2.5";
  const fc = await api.get(`/api/ovl/quakes?period=${period}&mag=${mag}`);
  const out: Quake[] = [];
  for (const f of fc.features ?? []) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const t = typeof p.time === "number" ? p.time : Date.parse(p.time);
    if (!(t > from - 25 * 60000 && t < to)) continue;
    out.push({ id: String(f.id ?? p.code ?? t), mag: p.mag ?? 0, place: p.place ?? "", time: t, lat: c[1], lon: c[0], depth: c[2] ?? 10, url: p.url });
  }
  return out.sort((a, b) => b.mag - a.mag);
}

/** would this quake plausibly show up at the station? (very rough detectability) */
export function visibleAt(q: Quake, st: ShakeSta) {
  const km = distance(st.lat, st.lon, q.lat, q.lon) / 1000;
  return q.mag >= (km < 50 ? 0 : 1.5 + 2 * Math.log10(km / 50));
}

// ---------- export ----------

export function toCsv(cols: { name: string; x: Float32Array; sr: number; start: number }[], t0: number, t1: number): string {
  const base = cols[0];
  const i0 = Math.max(0, Math.floor(((t0 - base.start) / 1000) * base.sr));
  const i1 = Math.min(base.x.length, Math.ceil(((t1 - base.start) / 1000) * base.sr));
  const lines = [["time_utc", "time_ms", ...cols.map((c) => c.name)].join(",")];
  for (let i = i0; i < i1; i++) {
    const t = base.start + (i / base.sr) * 1000;
    const row = [new Date(t).toISOString(), Math.round(t)];
    for (const c of cols) {
      const k = Math.round(((t - c.start) / 1000) * c.sr);
      const v = c.x[k];
      row.push(v == null || !Number.isFinite(v) ? "" : (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(5) : +v.toFixed(4)) as any);
    }
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

/** samples i0..i1 normalised to ±0.9 (16-bit PCM WAV at sr × speed) */
export function toWav(x: Float32Array, i0: number, i1: number, sr: number, speed: number): { blob: Blob; data: Float32Array; rate: number } {
  i0 = Math.max(0, Math.floor(i0));
  i1 = Math.min(x.length, Math.floor(i1));
  const n = Math.max(0, i1 - i0);
  let pk = 1e-30;
  for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(x[i]));
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = (x[i0 + i] / pk) * 0.9;
  const rate = Math.round(Math.min(384000, Math.max(3000, sr * speed)));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(data[i] * 32767), true);
  return { blob: new Blob([buf], { type: "audio/wav" }), data, rate };
}

let playing: AudioBufferSourceNode | null = null;
export const shakePlaying = signal(false);
export function playAudio(data: Float32Array, rate: number) {
  stopAudio();
  const ctx = new AudioContext();
  const b = ctx.createBuffer(1, Math.max(1, data.length), rate);
  b.copyToChannel(data as any, 0);
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(ctx.destination);
  src.onended = () => {
    shakePlaying.value = false;
    ctx.close();
    if (playing === src) playing = null;
  };
  src.start();
  playing = src;
  shakePlaying.value = true;
}
export function stopAudio() {
  try {
    playing?.stop();
  } catch {
    /* already stopped */
  }
  playing = null;
  shakePlaying.value = false;
}

// ---------- coarse regions for the station browser (smallest containing box wins) ----------

const REGIONS: [string, number, number, number, number][] = [
  // name, west, south, east, north
  ["United States", -125, 24.5, -66.9, 49.4],
  ["Alaska", -170, 51, -129, 71.5],
  ["Hawaii", -161, 18.5, -154, 22.5],
  ["Canada", -141, 41.7, -52, 83],
  ["Mexico", -117.2, 14.5, -86.7, 32.7],
  ["Central America & Caribbean", -92.3, 7, -59, 23.5],
  ["Colombia & Venezuela", -79.1, -4.3, -59.8, 12.5],
  ["Peru & Ecuador", -81.4, -18.4, -68.6, 1.5],
  ["Brazil", -74, -33.8, -34.8, 5.3],
  ["Chile", -75.7, -55.9, -66.4, -17.5],
  ["Argentina & Uruguay", -73.6, -55.1, -53, -21.8],
  ["UK & Ireland", -10.7, 49.8, 1.8, 60.9],
  ["France", -5.2, 42.3, 8.3, 51.1],
  ["Spain & Portugal", -9.6, 36, 3.4, 43.8],
  ["Benelux", 2.5, 49.4, 7.3, 53.6],
  ["Germany", 5.9, 47.2, 15.1, 55.1],
  ["Switzerland & Austria", 5.9, 45.8, 17.2, 49.1],
  ["Italy", 6.6, 36.6, 18.6, 47.1],
  ["Scandinavia", 4.5, 54.5, 31.6, 71.2],
  ["Poland & Czechia", 12, 48.5, 24.2, 54.9],
  ["Balkans & Hungary", 13.3, 39.6, 30, 48.6],
  ["Greece", 19.3, 34.8, 28.3, 41.8],
  ["Turkey & Cyprus", 25.6, 34.5, 44.8, 42.2],
  ["Eastern Europe", 20, 43.6, 41, 60],
  ["Middle East", 34, 12.5, 60, 38],
  ["North Africa", -17, 18, 34, 37.5],
  ["Sub-Saharan Africa", -18, -35, 52, 18],
  ["India & South Asia", 60.8, 5.9, 97.4, 37],
  ["Southeast Asia", 92, -11, 141, 28.6],
  ["Philippines", 116.9, 4.6, 126.6, 21.2],
  ["Taiwan", 119.3, 21.8, 122.1, 25.4],
  ["China & Mongolia", 73.5, 18, 135, 53.6],
  ["Korea", 124.6, 33.1, 131, 43],
  ["Japan", 122.9, 24, 146, 45.6],
  ["Russia", 27, 41, 180, 82],
  ["Australia", 112.9, -43.7, 153.7, -10],
  ["New Zealand", 166.4, -47.3, 178.6, -34.4],
  ["Pacific islands", 150, -30, 180, 20],
  ["Iceland & Atlantic", -32, 27, -12, 67],
];
export function regionOf(lat: number, lon: number): string {
  let best = "Other", area = Infinity;
  for (const [n, w, s, e, nn] of REGIONS) {
    if (lon >= w && lon <= e && lat >= s && lat <= nn) {
      const a = (e - w) * (nn - s);
      if (a < area) {
        area = a;
        best = n;
      }
    }
  }
  return best;
}
