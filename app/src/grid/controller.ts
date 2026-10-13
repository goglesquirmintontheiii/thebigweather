// Gridded weather layers: frames, viewport rasters, prefetching for animation.

import { signal, computed, effect, batch } from "@preact/signals";
import { api, lastHello } from "../api";
import { settings, update } from "../store";
import { framesToRequest, trimToSpan, historyEnd, histRange } from "../anim";
import { frameIndex, playing, frameCount, setFrameReady } from "../anim";
import { parseRaster, type Raster } from "./raster";
import { GridLayer } from "./GridLayer";
import { gridDef, gridTable } from "../weather";
import { tableById } from "../radar/controller";
import type { Map as MLMap } from "maplibre-gl";

export interface GridFrame {
  key: string;
  time: number;
  label: string;
  error?: string;
}
export interface RunInfo {
  id: string;
  time: number;
  fhs: number[];
}

export const gridFrames = signal<GridFrame[]>([]);
export const gridRuns = signal<RunInfo[]>([]);
export const gridRun = signal<string | null>(null);
export const gridStorms = signal<string[]>([]);
export const gridLoading = signal(false);
export const gridError = signal<string | null>(null);
/** raster currently drawn (may be from an older viewport while a sharper one loads) */
export const gridRaster = signal<Raster | null>(null);
/** keys with a raster for the current viewport */
export const gridReady = signal<Set<string>>(new Set());

export const gridTableActive = computed(() => {
  const w = settings.value.weather;
  if (w.kind !== "grid") return null;
  const def = gridDef(w.id);
  if (!def || def.cmap === "RGB") return null;
  const chosen = settings.value.tables[def.cmap];
  void settings.value.customPals;
  return chosen ? tableById(chosen) : gridTable(def.cmap);
});

let layer: GridLayer | null = null;
let map: MLMap | null = null;

// ---------- raster cache (per frame key, best raster for latest view) ----------
const rasters = new Map<string, { r: Raster; view: string }>();
let rasterBytes = 0;
const MAX_BYTES = 220 * 1024 * 1024;

function storeRaster(key: string, r: Raster, view: string) {
  const old = rasters.get(key);
  if (old) {
    rasterBytes -= old.r.bytes;
    layer?.release(old.r);
  }
  rasters.set(key, { r, view });
  rasterBytes += r.bytes;
  while (rasterBytes > MAX_BYTES && rasters.size > 1) {
    const k = rasters.keys().next().value!;
    if (k === key) break;
    const v = rasters.get(k)!;
    rasterBytes -= v.r.bytes;
    layer?.release(v.r);
    rasters.delete(k);
  }
}

function clearRasters() {
  layer?.set(null, null, 0, 0);
  for (const v of rasters.values()) layer?.release(v.r);
  rasters.clear();
  rasterBytes = 0;
  gridReady.value = new Set();
}

// ---------- viewport ----------
interface View {
  sig: string;
  bbox: [number, number, number, number];
  w: number;
  h: number;
}

function currentView(): View | null {
  if (!map) return null;
  const c = map.getCanvas();
  const b = map.getBounds();
  const mx = (lon: number) => (lon + 180) / 360;
  const my = (lat: number) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  let x0 = mx(b.getWest()), x1 = mx(b.getEast()), y0 = my(b.getNorth()), y1 = my(b.getSouth());
  // pad so small pans don't need a new raster
  const px = (x1 - x0) * 0.15, py = (y1 - y0) * 0.15;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  y0 = Math.max(0, y0);
  y1 = Math.min(1, y1);
  const q = settings.value.grid.quality;
  const scale = Math.min(window.devicePixelRatio || 1, 1.5) * q;
  const w = Math.min(2400, Math.max(64, Math.round(c.clientWidth * 1.3 * scale)));
  const h = Math.min(2400, Math.max(64, Math.round(c.clientHeight * 1.3 * scale)));
  const r = (v: number) => v.toFixed(6);
  return { sig: `${r(x0)},${r(y0)},${r(x1)},${r(y1)},${w},${h}`, bbox: [x0, y0, x1, y1], w, h };
}

let view: View | null = null;
const inflight = new Map<string, Promise<void>>();

async function fetchRaster(key: string, v: View): Promise<void> {
  const id = `${key}@${v.sig}`;
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = (async () => {
    try {
      const buf = await api.bin(`/api/grid/render?key=${encodeURIComponent(key)}&bbox=${v.bbox.join(",")}&w=${v.w}&h=${v.h}&sv=${lastHello.value?.version ?? ""}`);
      const r = parseRaster(buf, key);
      storeRaster(key, r, v.sig);
      if (view?.sig === v.sig) {
        const s = new Set(gridReady.value);
        s.add(key);
        gridReady.value = s;
      }
      push();
    } catch (e: any) {
      const fs = gridFrames.value.slice();
      const i = fs.findIndex((f) => f.key === key);
      if (i >= 0) {
        fs[i] = { ...fs[i], error: e.message };
        gridFrames.value = fs;
      }
      if (key === gridFrames.value[frameIndex.value]?.key) gridError.value = e.message;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

function push() {
  if (!layer) return;
  const w = settings.value.weather;
  if (w.kind !== "grid") {
    layer.set(null, null, 0, 0);
    gridRaster.value = null;
    return;
  }
  const f = gridFrames.value[frameIndex.value];
  const hit = f ? rasters.get(f.key) : undefined;
  // keep the previous picture until this frame arrives (no blank flashes while loading/animating)
  const r = hit?.r ?? (gridFrames.value.length ? layer.raster : null);
  gridRaster.value = r;
  layer.set(r, gridTableActive.value, settings.value.grid.opacity, settings.value.grid.smooth);
}

/** Load rasters for the current frame first, then the rest (for animation). */
let prefetchGen = 0;
async function refreshRasters() {
  view = currentView();
  if (!view || settings.value.weather.kind !== "grid") return;
  gridReady.value = new Set([...rasters.entries()].filter(([, v]) => v.view === view!.sig).map(([k]) => k));
  const gen = ++prefetchGen;
  const fs = gridFrames.value;
  if (!fs.length) return;
  const cur = fs[frameIndex.value];
  if (cur && rasters.get(cur.key)?.view !== view.sig) await fetchRaster(cur.key, view);
  if (gen !== prefetchGen) return;
  // others: long forecast runs prefetch a window ahead of the current hour; short loops get everything
  const ci = frameIndex.value;
  const inWin = fs.length > 40 ? (i: number) => i >= ci - 3 && i <= ci + 30 : () => true;
  const rest = fs
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => inWin(i) && f.key !== cur?.key && rasters.get(f.key)?.view !== view!.sig)
    .sort((a, b) => (fs.length > 40 ? a.i - b.i : b.i - a.i));
  let k = 0;
  const worker = async () => {
    while (k < rest.length && gen === prefetchGen) {
      const { f } = rest[k++];
      await fetchRaster(f.key, view!);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- frames ----------
let loadGen = 0;
export async function loadGridFrames(keepIndex = false) {
  const w = settings.value.weather;
  if (w.kind !== "grid" || !api.base) return;
  const gen = ++loadGen;
  gridLoading.value = true;
  gridError.value = null;
  try {
    const d0 = gridDef(w.id);
    const obs0 = d0?.source !== "model" && d0?.source !== "ndfd" && d0?.source !== "future" && d0?.source !== "mlpred" && !w.id.startsWith("mlpred/"); // models 0.7: predictions are forecasts
    const q = new URLSearchParams({ layer: w.id, n: String(obs0 ? framesToRequest(settings.value.grid.frames, cadence(w.id)) : settings.value.grid.frames) });
    if (w.run) q.set("run", w.run);
    if (w.storm) q.set("storm", w.storm);
    if (obs0 && historyEnd.value) q.set("end", String(historyEnd.value));
    const res = await api.get(`/api/grid/frames?${q}`);
    // history window longer than one request: page back with earlier `end`s
    const h = histRange.value;
    if (obs0 && h && res.frames?.length) {
      for (let k = 0; k < 6 && res.frames[0].time > h.start + 60_000; k++) {
        q.set("end", String(res.frames[0].time - 1000));
        const more = await api.get(`/api/grid/frames?${q}`).catch(() => null);
        if (gen !== loadGen) return;
        const older = (more?.frames ?? []).filter((f: GridFrame) => f.time < res.frames[0].time);
        if (!older.length) break;
        res.frames = [...older, ...res.frames];
      }
    }
    if (gen !== loadGen) return;
    const fs: GridFrame[] = obs0 ? trimToSpan(res.frames) : res.frames;
    const prevLen = gridFrames.value.length;
    batch(() => {
      gridFrames.value = fs;
      gridRuns.value = res.runs ?? [];
      gridRun.value = res.run ?? null;
      gridStorms.value = res.storms ?? [];
      frameCount.value = fs.length;
      const def0 = gridDef(w.id);
      const obs = obs0; // models 0.7 (same test as above)
      const wasLatest = prevLen === 0 || frameIndex.value >= prevLen - 1;
      if (!keepIndex || frameIndex.value >= fs.length || (obs && wasLatest)) {
        // models start at the first forecast hour; observations at the latest
        const def = gridDef(w.id);
        frameIndex.value = !obs0 /* models 0.7 */ || def?.source === "model" || def?.source === "ndfd" || def?.source === "future" ? 0 : Math.max(0, fs.length - 1);
      }
      if (!fs.length) gridError.value = obs && histRange.value ? "No archived data for this layer in that window" : "No data available for this layer right now";
    });
    refreshRasters();
  } catch (e: any) {
    if (gen === loadGen) gridError.value = e.message;
  } finally {
    if (gen === loadGen) gridLoading.value = false;
  }
}

export function attachGrid(l: GridLayer, m: MLMap) {
  layer = l;
  map = m;
  let t: number | undefined;
  m.on("moveend", () => {
    clearTimeout(t);
    t = window.setTimeout(() => refreshRasters(), 150);
  });
  m.on("resize", () => {
    clearTimeout(t);
    t = window.setTimeout(() => refreshRasters(), 300);
  });
  push();
}

/** minutes between frames of an observation layer */
function cadence(id: string): number {
  const d = gridDef(id);
  if (d?.source === "mrms") return 2;
  if (d?.source === "metar") return 60;
  if ((d?.source as string) === "opera") return id.includes("rate") ? 15 : 5;
  if ((d?.source as string) === "cwa") return 10;
  if (d?.source === "goes") return id.includes("/meso") ? 1 : id.includes("/full") ? 10 : 5;
  return 10;
}

// react to layer selection
let lastSig = "";
effect(() => {
  const w = settings.value.weather;
  const n = settings.value.grid.frames;
  const a = settings.value.anim;
  const h = histRange.value;
  void api.base;
  const hs = settings.value.hist; // history 0.6: loop settings when live, history's frame step / max when not
  const sig = w.kind === "grid" ? `${w.id}|${w.run ?? ""}|${w.storm ?? ""}|${h ? `${h.start}-${h.end}|${hs.step}|${hs.maxFrames}` : `${n}|${a.mode}|${a.minutes}|${settings.value.saver}`}` : ""; // saver caps frames
  if (sig === lastSig) return;
  const layerChanged = lastSig.split("|")[0] !== sig.split("|")[0];
  lastSig = sig;
  playing.value = false;
  if (layerChanged) {
    clearRasters();
    gridFrames.value = [];
  }
  if (w.kind === "grid") loadGridFrames(!layerChanged);
  else push();
});

let slideTimer: number | undefined;
effect(() => {
  void frameIndex.value;
  void gridFrames.value;
  void gridTableActive.value;
  void settings.value.grid.opacity;
  void settings.value.grid.smooth;
  push();
  // if the frame's raster for this view isn't there yet, get it
  const f = gridFrames.value[frameIndex.value];
  if (f && view && rasters.get(f.key)?.view !== view.sig && settings.value.weather.kind === "grid") fetchRaster(f.key, view);
  // long runs: slide the prefetch window along as the user steps through hours
  const n = gridFrames.value.length;
  if (n > 40 && view && settings.value.weather.kind === "grid") {
    const ahead = gridFrames.value[Math.min(n - 1, frameIndex.value + 20)];
    if (ahead && rasters.get(ahead.key)?.view !== view.sig) {
      clearTimeout(slideTimer);
      slideTimer = window.setTimeout(() => refreshRasters(), 400);
    }
  }
});

effect(() => {
  if (settings.value.weather.kind === "grid") {
    frameCount.value = gridFrames.value.length;
    setFrameReady((i) => {
      const f = gridFrames.value[i];
      return !!f && rasters.has(f.key) && !f.error;
    });
  }
});

api.on("connected", () => {
  if (settings.value.weather.kind === "grid") loadGridFrames(true);
});
// models 0.7: a model run replaced a prediction layer (frame keys carry the run time) → reload it
api.on("ml_layer", (m) => {
  const w = settings.value.weather;
  if (w.kind === "grid" && typeof m?.layer_id === "string" && (w.id === m.layer_id || w.id.startsWith(`${m.layer_id}/`)) && !playing.value) setTimeout(() => loadGridFrames(true), 300);
});

// refresh observation layers periodically (new MRMS / satellite / METAR frames)
setInterval(() => {
  const w = settings.value.weather;
  if (w.kind !== "grid" || playing.value || historyEnd.value) return;
  const d = gridDef(w.id);
  if (d && d.source !== "model" && d.source !== "ndfd" && d.source !== "future") loadGridFrames(true); // models 0.7: mlpred refreshes too (new runs)
}, 90_000);

// future layers move forward with the clock and pick up new model runs
setInterval(() => {
  const w = settings.value.weather;
  if (w.kind !== "grid" || playing.value) return;
  if (gridDef(w.id)?.source === "future") loadGridFrames(true);
}, 10 * 60_000);

export function setRun(run: string | undefined) {
  update((s) => {
    if (s.weather.kind === "grid") s.weather = { ...s.weather, run };
  });
}
export function setStorm(storm: string | undefined) {
  update((s) => {
    if (s.weather.kind === "grid") s.weather = { ...s.weather, storm };
  });
}
