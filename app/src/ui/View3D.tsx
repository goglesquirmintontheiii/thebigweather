// 3D volume view: pitches the map, swaps the 2D radar for a ray-marched volume and shows a
// small control panel. The volume follows the timeline's current frame.

import { signal, effect, computed } from "@preact/signals";
import type { Map as MLMap } from "maplibre-gl";
import { Box, RotateCcw, Loader2 } from "lucide-preact";
import { api, ApiError } from "../api";
import { settings, update } from "../store";
import { mapRef } from "../map/mapview";
import { currentFrame, frames, activeTable, currentSite, tableById } from "../radar/controller";
import { gridFrames } from "../grid/controller";
import { frameIndex, playing } from "../anim";
import { Volume3DLayer, parseVolume, type Volume } from "../radar/Volume3D";
import { Slider } from "./controls";
import type { ColorTable } from "../radar/colormaps";

/** app product id -> server volume3d moment */
const MOMENT: Record<string, string> = { REF: "REF", VEL: "VEL", SW: "SW", ZDR: "ZDR", RHO: "CC", CC: "CC", PHI: "PHI", KDP: "KDP" };
const DEFAULT_THR: Record<string, number> = { REF: 20, VEL: 10, SW: 4, ZDR: 1, CC: 0.8, PHI: 60, KDP: 0.5, MRMS: 20 };

export const vol3dLoading = signal(false);
export const vol3dError = signal<string | null>(null);
/** MRMS 3D endpoint: null = unknown, false = not on this server */
export const mrmsAvailable = signal<boolean | null>(null);
const shown = signal<Volume | null>(null);
/** a volume opened through the console/test handle stays up regardless of the timeline */
let manual = false;
/** map area for MRMS requests (quantized, updated when the view moves away) */
const viewBox = signal<string>("");

export function toggle3D() {
  update((s) => (s.view3d.on = !s.view3d.on));
}

/** What the volume should be built from right now, or a note why it can't. */
const want = computed<{ url: string | null; note: string | null; thrKey: string; table: ColorTable; abs: boolean; nextUrl?: string }>(() => {
  const s = settings.value;
  const v3 = s.view3d;
  if (v3.src === "mrms" && mrmsAvailable.value !== false) {
    const table = tableById(s.tables.REF || "REF");
    let time = Date.now();
    if (s.weather.kind === "radar") time = currentFrame.value?.time ?? time;
    else if (s.weather.kind === "grid") time = gridFrames.value[Math.min(frameIndex.value, gridFrames.value.length - 1)]?.time ?? time;
    const box = viewBox.value;
    // round to the minute so neighbouring ticks share a request
    const t = Math.round(time / 60000) * 60000;
    return { url: box ? `/api/grid/volume3d?time=${t}&bbox=${box}` : null, note: null, thrKey: "MRMS", table, abs: false };
  }
  const r = s.radar;
  const table = activeTable.value;
  if (s.weather.kind !== "radar") return { url: null, note: "Pick the radar layer for 3D", thrKey: "REF", table, abs: false };
  if (r.source !== "L2") return { url: null, note: "3D uses Level II volumes", thrKey: "REF", table, abs: false };
  const m = MOMENT[r.product];
  if (!m) return { url: null, note: `No 3D for ${r.product}`, thrKey: "REF", table, abs: false };
  const mk = (key: string) => `/api/radar/volume3d?key=${encodeURIComponent(key)}&moment=${m}&res=${v3.res}`;
  const f = currentFrame.value;
  const fs = frames.value;
  const i = f ? fs.indexOf(f) : -1;
  const next = i >= 0 && fs.length > 1 ? fs[(i + 1) % fs.length] : undefined;
  return { url: f?.key ? mk(f.key) : null, note: f ? null : "Waiting for radar data", thrKey: m, table, abs: m === "VEL", nextUrl: next?.key ? mk(next.key) : undefined };
});

// ---------- volume cache / loading ----------
const cache = new Map<string, Volume>();
const CACHE_MAX = 6;
let inflight: string | null = null;
let queued: string | null = null;

function remember(url: string, v: Volume) {
  cache.delete(url);
  cache.set(url, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

async function fetchVolume(url: string, prefetch = false) {
  if (cache.has(url)) {
    if (!prefetch && want.peek().url === url) shown.value = cache.get(url)!;
    return;
  }
  if (inflight) {
    // one request at a time; while the loop plays only the newest wish is kept
    if (!prefetch) queued = url;
    return;
  }
  inflight = url;
  if (!prefetch) vol3dLoading.value = true;
  try {
    const v = parseVolume(await api.bin(url));
    remember(url, v);
    if (want.peek().url === url) {
      manual = false;
      shown.value = v;
      vol3dError.value = null;
    }
  } catch (e: any) {
    if (url.startsWith("/api/grid/volume3d") && e instanceof ApiError && e.status === 404) {
      mrmsAvailable.value = false;
      update((s) => (s.view3d.src = "radar"));
    } else if (!prefetch && want.peek().url === url) vol3dError.value = e instanceof ApiError && e.status === 404 ? "No 3D data for this volume" : e.message ?? String(e);
  } finally {
    inflight = null;
    vol3dLoading.value = false;
    const q = queued;
    queued = null;
    const w = want.peek();
    if (q && q === w.url && !cache.has(q)) fetchVolume(q);
    else if (w.url && !cache.has(w.url)) fetchVolume(w.url);
    else if (w.url && cache.has(w.url)) {
      shown.value = cache.get(w.url)!;
      // keep one frame ahead while the loop plays
      if (playing.peek() && w.nextUrl && !cache.has(w.nextUrl)) fetchVolume(w.nextUrl, true);
    }
  }
}

effect(() => {
  if (!settings.value.view3d.on) return;
  const w = want.value;
  if (!w.url) {
    if (w.note && !manual) shown.value = null;
    return;
  }
  vol3dError.value = null;
  // cache hit shows immediately; otherwise the last volume stays up until the new one arrives
  fetchVolume(w.url);
});

/** Ask once whether the server has the MRMS 3D mosaic. */
async function probeMrms() {
  if (mrmsAvailable.value !== null || !api.base) return;
  try {
    await api.get(`/api/grid/volume3d?time=${Date.now()}&bbox=-98,35,-97.9,35.1&probe=1`);
    mrmsAvailable.value = true;
  } catch (e: any) {
    // 404 = route missing; other errors (no data, bad request) mean the route exists
    mrmsAvailable.value = !(e instanceof ApiError && e.status === 404);
  }
}

function updateViewBox(map: MLMap) {
  const b = map.getBounds();
  const c = map.getCenter();
  // at most ~10° x 7° around the centre, snapped to 0.5° so small pans reuse the volume
  const q = (x: number) => Math.round(x * 2) / 2;
  const w = Math.max(b.getWest(), c.lng - 5), e = Math.min(b.getEast(), c.lng + 5);
  const s = Math.max(b.getSouth(), c.lat - 3.5), n = Math.min(b.getNorth(), c.lat + 3.5);
  const box = `${q(w) - 0.5},${q(s) - 0.5},${q(e) + 0.5},${q(n) + 0.5}`;
  if (box !== viewBox.value) viewBox.value = box;
}

// ---------- map mode ----------
let layer: Volume3DLayer | null = null;
let saved: { pitch: number; bearing: number; maxPitch: number; rotate: boolean } | null = null;
let modeToken = 0;

function hide2D(map: MLMap) {
  const vis = settings.value.view3d.floor ? "visible" : "none";
  for (const id of ["radar", "grid"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
}

function addLayer(map: MLMap) {
  if (!layer) return;
  if (!map.getLayer(layer.id)) map.addLayer(layer);
  hide2D(map);
}
const onStyle = () => mapRef.value && addLayer(mapRef.value);
const onMoveEnd = () => mapRef.value && updateViewBox(mapRef.value);

function enter(map: MLMap) {
  const token = ++modeToken;
  saved ??= { pitch: map.getPitch(), bearing: map.getBearing(), maxPitch: map.getMaxPitch(), rotate: map.dragRotate.isEnabled() };
  map.setMaxPitch(78);
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();
  map.touchPitch?.enable?.();
  layer = new Volume3DLayer();
  if (map.isStyleLoaded()) addLayer(map);
  map.on("style.load", onStyle);
  map.on("moveend", onMoveEnd);
  updateViewBox(map);
  probeMrms();
  if (token === modeToken) map.easeTo({ pitch: 60, duration: 900 });
  syncLayer();
}

function exit(map: MLMap) {
  const token = ++modeToken;
  map.off("style.load", onStyle);
  map.off("moveend", onMoveEnd);
  if (layer && map.getLayer(layer.id)) map.removeLayer(layer.id); // frees GPU textures (onRemove)
  layer = null;
  manual = false;
  shown.value = null;
  cache.clear();
  for (const id of ["radar", "grid"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
  const s = saved;
  saved = null;
  map.easeTo({ pitch: s?.pitch ?? 0, bearing: s?.bearing ?? 0, duration: 600 });
  map.once("moveend", () => {
    if (token !== modeToken) return;
    map.setMaxPitch(s?.maxPitch ?? 0);
    if (!s?.rotate) {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
    }
  });
}

effect(() => {
  const map = mapRef.value;
  const on = settings.value.view3d.on;
  if (!map) return;
  if (on && !layer) enter(map);
  else if (!on && layer) exit(map);
});

function syncLayer() {
  const l = layer;
  if (!l) return;
  const v3 = settings.value.view3d;
  const w = want.value;
  const thr = v3.thr[w.thrKey] ?? DEFAULT_THR[w.thrKey] ?? w.table.min;
  l.setStyle(w.table, { threshold: thr, absValue: w.abs, density: v3.density, exag: v3.exag, smooth: v3.smooth, shade: v3.shade });
  l.setVolume(shown.value);
}

effect(() => {
  void settings.value.view3d;
  void want.value;
  void shown.value;
  syncLayer();
});

effect(() => {
  void settings.value.view3d.floor;
  const map = mapRef.value;
  if (map && layer) hide2D(map);
});

function resetView() {
  const map = mapRef.value;
  if (!map) return;
  const h = shown.value?.hdr;
  const site = currentSite.value;
  const center: [number, number] | undefined = h?.proj === "aeqd" && h.lon !== undefined ? [h.lon, h.lat!] : site ? [site.lon, site.lat] : undefined;
  map.easeTo({ center, zoom: h?.proj === "latlon" ? map.getZoom() : 7.4, pitch: 60, bearing: 0, duration: 800 });
}

// console / test handle: __tbw3d.load(url) shows any volume URL (absolute or server path)
(window as any).__tbw3d = {
  async load(url: string) {
    const buf = await (await fetch(url.startsWith("/") ? api.base + url : url)).arrayBuffer();
    const v = parseVolume(buf);
    manual = true;
    shown.value = v;
    return v.hdr;
  },
  get layer() {
    return layer;
  },
};

// ---------- panel ----------
export function View3D() {
  const v3 = settings.value.view3d;
  if (!v3.on) return null;
  const w = want.value;
  const t = w.table;
  const thr = v3.thr[w.thrKey] ?? DEFAULT_THR[w.thrKey] ?? t.min;
  const lo = w.abs ? 0 : t.min;
  const span = t.max - lo;
  const step = span > 20 ? 1 : span > 4 ? 0.1 : 0.01;
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const set = (fn: (x: typeof v3) => void) => update((s) => fn(s.view3d));
  const h = shown.value?.hdr;
  const gpuErr = layer?.error;
  return (
    <div class="v3d glass">
      <div class="v3d-head">
        <Box size={15} />
        <b>3D</b>
        <span class="muted small v3d-meta">{h ? `${h.site ?? "MRMS"} ${h.moment ?? ""} ${h.nx}×${h.ny}×${h.nz}` : ""}</span>
        {vol3dLoading.value && <Loader2 size={14} class="spin" />}
        <button class="icon-btn" title="Reset view" onClick={resetView}>
          <RotateCcw size={14} />
        </button>
      </div>
      {mrmsAvailable.value !== false && (
        <div class="v3d-seg">
          <button class={v3.src === "radar" ? "on" : ""} onClick={() => set((x) => (x.src = "radar"))}>
            Radar volume
          </button>
          <button class={v3.src === "mrms" ? "on" : ""} onClick={() => set((x) => (x.src = "mrms"))}>
            MRMS
          </button>
        </div>
      )}
      {w.note && <div class="v3d-note">{w.note}{w.note.includes("Level II") && <button class="link" onClick={() => update((s) => { s.radar.source = "L2"; s.radar.product = "REF"; })}>Switch</button>}</div>}
      {(vol3dError.value || gpuErr) && <div class="v3d-note err">{gpuErr || vol3dError.value}</div>}
      <Slider label={w.abs ? `|${t.units}| ≥` : `Min ${t.units}`} value={thr} min={lo} max={t.max} step={step} fmt={(x) => x.toFixed(dec)} set={(x) => set((s) => (s.thr = { ...s.thr, [w.thrKey]: x }))} />
      <Slider label="Density" value={v3.density} min={0.1} max={4} step={0.05} fmt={(x) => x.toFixed(2)} set={(x) => set((s) => (s.density = x))} />
      <Slider label="Height ×" value={v3.exag} min={1} max={10} step={0.5} fmt={(x) => `${x}×`} set={(x) => set((s) => (s.exag = x))} />
      <div class="v3d-row">
        {v3.src === "radar" && (
          <div class="v3d-seg small">
            <button class={v3.res === "lo" ? "on" : ""} onClick={() => set((x) => (x.res = "lo"))} title="Coarser grid, faster">
              Lo
            </button>
            <button class={v3.res === "hi" ? "on" : ""} onClick={() => set((x) => (x.res = "hi"))} title="Finer grid, bigger download">
              Hi
            </button>
          </div>
        )}
        <label title="Show the 2D layer under the volume">
          <input type="checkbox" checked={v3.floor} onChange={() => set((x) => (x.floor = !x.floor))} /> Floor
        </label>
        <label title="Smooth between voxels">
          <input type="checkbox" checked={v3.smooth} onChange={() => set((x) => (x.smooth = !x.smooth))} /> Smooth
        </label>
        <label title="Surface lighting">
          <input type="checkbox" checked={v3.shade} onChange={() => set((x) => (x.shade = !x.shade))} /> Light
        </label>
      </div>
    </div>
  );
}
