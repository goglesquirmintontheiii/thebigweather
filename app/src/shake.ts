// Raspberry Shake seismographs: station list, waveform requests, and the small DSP kit the
// seismograph window uses (detrend, band-pass biquads, FFT spectrogram, P/S estimates).

import { signal } from "@preact/signals";
import { api } from "./api";
import { settings } from "./store";
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
}
export interface Wave {
  sr: number;
  start: number;
  samples: Float32Array;
  gaps: [number, number][];
}

/** the station shown in the seismograph window (null = closed) */
export const shakeSel = signal<ShakeSta | null>(null);
export const shakeOpen = signal(false);

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

export function openShake(s: ShakeSta) {
  shakeSel.value = s;
  shakeOpen.value = true;
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

export async function channels(s: ShakeSta): Promise<ShakeChan[]> {
  return api.get(`/api/shake/channels?net=${encodeURIComponent(s.net)}&sta=${encodeURIComponent(s.sta)}`);
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

// ---------- DSP ----------

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
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
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

export const FILTERS: { id: string; label: string; band?: [number, number] }[] = [
  { id: "none", label: "No filter" },
  { id: "tele", label: "0.7–2 Hz", band: [0.7, 2] },
  { id: "local", label: "1–10 Hz", band: [1, 10] },
  { id: "high", label: "3–20 Hz", band: [3, 20] },
];

export function prep(w: Wave, filter: string): Float32Array {
  const x = detrend(w.samples);
  const f = FILTERS.find((z) => z.id === filter)?.band;
  if (f && x.length > 10) {
    biquad(x, "hp", f[0], w.sr);
    biquad(x, "lp", f[1], w.sr);
  }
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

/** Power (dB) per column × frequency bin, for samples i0..i1 spread over `cols` columns. */
export function spectrogram(x: Float32Array, i0: number, i1: number, cols: number, nfft: number): { db: Float32Array; bins: number; lo: number; hi: number } {
  const bins = nfft / 2;
  const db = new Float32Array(cols * bins);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const win = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1));
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
    for (let b = 0; b < bins; b++) db[c * bins + b] = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-6);
  }
  // color range from percentiles
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(db.length / 4000));
  for (let i = 0; i < db.length; i += step) sample.push(db[i]);
  sample.sort((a, b) => a - b);
  return { db, bins, lo: sample[Math.floor(sample.length * 0.08)] ?? 0, hi: sample[Math.floor(sample.length * 0.995)] ?? 1 };
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

// ---------- earthquakes ----------

export interface QuakeHit {
  id: string;
  mag: number;
  place: string;
  time: number;
  km: number;
  p: number;
  s: number;
  url?: string;
}

/** Recent quakes (from the Earthquakes overlay feed) with rough P/S arrival times at a station:
 * straight great-circle distance at ~6 km/s (P) and ~3.5 km/s (S). */
export async function quakesFor(st: ShakeSta, from: number, to: number): Promise<QuakeHit[]> {
  const age = Date.now() - from;
  const user = settings.value.ovl.quakes?.opts ?? {};
  const period = age > 7 * 86400000 ? "month" : age > 86400000 ? "week" : user.period && user.period !== "hour" ? user.period : "day";
  const mag = period === "day" ? "1.0" : "2.5";
  const fc = await api.get(`/api/ovl/quakes?period=${period}&mag=${mag}`);
  const out: QuakeHit[] = [];
  for (const f of fc.features ?? []) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const t = typeof p.time === "number" ? p.time : Date.parse(p.time);
    if (!(t > from - 25 * 60000 && t < to)) continue;
    const km = distance(st.lat, st.lon, c[1], c[0]) / 1000;
    const need = km < 50 ? 0 : 1.5 + 2 * Math.log10(km / 50);
    if ((p.mag ?? 0) < need) continue;
    out.push({ id: String(f.id ?? p.code ?? t), mag: p.mag ?? 0, place: p.place ?? "", time: t, km, p: t + (km / 6) * 1000, s: t + (km / 3.5) * 1000, url: p.url });
  }
  return out.sort((a, b) => b.mag - 1.8 * Math.log10(b.km + 10) - (a.mag - 1.8 * Math.log10(a.km + 10))).slice(0, 12);
}
