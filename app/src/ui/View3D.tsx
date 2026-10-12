// 3D volume view: pitches the map, swaps the 2D radar for a ray-marched volume and shows a
// small control panel. The volume follows the timeline's current frame.
// Available for Level II radar (incl. ODIM volumes, source "L2") and MRMS reflectivity layers;
// the header shows a "3D" toggle only for those (Btn3D) and 3D exits when the layer changes away.

import { signal, effect, computed } from "@preact/signals";
import type { Map as MLMap, MapMouseEvent } from "maplibre-gl";
import { RotateCcw, Loader2, ChevronUp, ChevronDown, RotateCw, Plus, Minus, Move3D, RefreshCw, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { settings, update } from "../store";
import { mapRef } from "../map/mapview";
import { currentFrame, frames, activeTable, currentSite, tableById } from "../radar/controller";
import { gridFrames } from "../grid/controller";
import { gridDef, gridLayers } from "../weather";
import { frameIndex, playing } from "../anim";
import { Volume3DLayer, parseVolume, volumeAim, type Volume, type IsoShell, type V3Mode, type Label } from "../radar/Volume3D";
import { Slider } from "./controls";
import type { ColorTable } from "../radar/colormaps";

/** app product id -> server volume3d moment */
const MOMENT: Record<string, string> = { REF: "REF", VEL: "VEL", SW: "SW", ZDR: "ZDR", RHO: "CC", CC: "CC", PHI: "PHI", KDP: "KDP" };
const DEFAULT_THR: Record<string, number> = { REF: 20, VEL: 10, SW: 4, ZDR: 1, CC: 0.8, PHI: 60, KDP: 0.5, MRMS: 20 };
/** isosurface presets per moment: [value, opacity] */
const ISO_PRESET: Record<string, [number, number][]> = {
  REF: [[20, 0.25], [40, 0.55], [55, 1]],
  MRMS: [[20, 0.25], [40, 0.55], [55, 1]],
  VEL: [[10, 0.2], [25, 0.5], [40, 1]],
  SW: [[4, 0.25], [8, 0.55], [12, 1]],
  ZDR: [[1, 0.25], [2.5, 0.55], [4, 1]],
  CC: [[0.8, 0.25], [0.9, 0.5], [0.97, 1]],
  PHI: [[60, 0.25], [120, 0.55], [180, 1]],
  KDP: [[0.5, 0.25], [1.5, 0.55], [3, 1]],
};

// ---------- 3D-only preferences (kept beside settings.view3d) ----------
interface V3X {
  /** p7: plain left-drag orbits instead of panning (laptops) */
  orbit?: boolean;
  /** p7: slow auto-rotate */
  spin?: boolean;
  mode: V3Mode;
  iso: Record<string, IsoShell[]>;
  heightColor: boolean;
  tops: boolean;
  planes: boolean;
}
const XKEY = "tbw.view3d.x";
function loadX(): V3X {
  const d: V3X = { mode: "iso", iso: {}, heightColor: false, tops: true, planes: false };
  try {
    const s = JSON.parse(localStorage.getItem(XKEY) || "null");
    if (s && typeof s === "object") return { ...d, ...s, iso: { ...(s.iso || {}) } };
  } catch {
    /* private mode / bad JSON */
  }
  return d;
}
export const v3x = signal<V3X>(loadX());
function setX(fn: (x: V3X) => void) {
  const n = structuredClone(v3x.value);
  fn(n);
  v3x.value = n;
  try {
    localStorage.setItem(XKEY, JSON.stringify(n));
  } catch {
    /* ignore */
  }
}
function shellsFor(key: string): IsoShell[] {
  return v3x.value.iso[key] ?? (ISO_PRESET[key] ?? ISO_PRESET.REF).map(([value, opacity]) => ({ value, opacity, on: true }));
}

export const vol3dLoading = signal(false);
export const vol3dError = signal<string | null>(null);
/** MRMS 3D endpoint: null = unknown, false = not on this server */
export const mrmsAvailable = signal<boolean | null>(null);
const shown = signal<Volume | null>(null);
/** a volume opened through the console/test handle stays up regardless of the timeline */
let manual = false;
/** map area for MRMS requests (quantized, updated when the view moves away) */
const viewBox = signal<string>("");

/** Which 3D source the current weather layer supports (null = none). */
export const support3D = computed<"radar" | "mrms" | null>(() => {
  const s = settings.value;
  const w = s.weather;
  if (w.kind === "radar") return s.radar.source === "L2" && MOMENT[s.radar.product] ? "radar" : null;
  if (w.kind === "grid") {
    const d = gridDef(w.id);
    return d?.source === "mrms" && d.cmap === "REF" && mrmsAvailable.value !== false ? "mrms" : null;
  }
  return null;
});

export function toggle3D() {
  const on = settings.value.view3d.on;
  // Shift+3 does nothing on layers without 3D data
  if (!on && !support3D.value) return;
  update((s) => (s.view3d.on = !on));
}

/** What the volume should be built from right now, or a note why it can't. */
const want = computed<{ url: string | null; note: string | null; thrKey: string; table: ColorTable; abs: boolean; nextUrl?: string }>(() => {
  const s = settings.value;
  const v3 = s.view3d;
  const sup = support3D.value;
  if ((sup === "mrms" || (v3.src === "mrms" && sup === "radar")) && mrmsAvailable.value !== false) {
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
  if (s.weather.kind !== "radar") return { url: null, note: "Pick Level II radar or MRMS reflectivity for 3D", thrKey: "REF", table, abs: false };
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

// probe as soon as an MRMS reflectivity layer is picked, so the header button is accurate
effect(() => {
  const w = settings.value.weather;
  if (w.kind !== "grid") return;
  const d = gridDef(w.id);
  if (d?.source === "mrms" && d.cmap === "REF") probeMrms();
});

// leave 3D when the layer changes to one without 3D data (wait for the catalog on startup)
effect(() => {
  const on = settings.value.view3d.on;
  const sup = support3D.value;
  const w = settings.value.weather;
  if (!on || sup || manual) return;
  if (w.kind === "grid" && !gridLayers.value.length) return;
  update((s) => (s.view3d.on = false));
});

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
let saved: { pitch: number; bearing: number; maxPitch: number; rotate: boolean; box?: boolean } | null = null;
let modeToken = 0;
/** aim the camera at the storms once the first volume arrives */
let aimPending = false;
let overlay: HTMLDivElement | null = null;
let tip: HTMLDivElement | null = null;

function hide2D(map: MLMap) {
  const vis = settings.value.view3d.floor ? "visible" : "none";
  for (const id of ["radar", "grid"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
}

function addLayer(map: MLMap) {
  if (!layer) return;
  if (!map.getLayer(layer.id)) map.addLayer(layer);
  hide2D(map);
}
const onStyle = () => {
  const m = mapRef.value;
  if (!m) return;
  addLayer(m);
  navReassert(m); // p7
};
const onMoveEnd = () => mapRef.value && updateViewBox(mapRef.value);

function showLabels(ls: Label[]) {
  if (!overlay) return;
  overlay.innerHTML = ls
    .map((l) => `<div class="v3d-lbl v3d-k-${l.kind}" style="transform:translate(${l.x.toFixed(1)}px,${l.y.toFixed(1)}px)"><span>${l.text.replace(/</g, "&lt;")}</span></div>`)
    .join("");
}

function fmtH(m: number) {
  return settings.value.units.distance === "km" ? `${(m / 1000).toFixed(1)} km` : `${(m / 304.8).toFixed(1)} kft`;
}
function fmtDist(m: number) {
  const u = settings.value.units.distance;
  if (u === "mi") return `${(m / 1609.344).toFixed(1)} mi`;
  if (u === "nmi") return `${(m / 1852).toFixed(1)} nmi`;
  return `${(m / 1000).toFixed(1)} km`;
}

let hoverRaf = 0;
let hoverPt: { x: number; y: number } | null = null;
const onHover = (e: MapMouseEvent) => {
  const oe = e.originalEvent as MouseEvent;
  hoverPt = oe.buttons ? null : { x: e.point.x, y: e.point.y };
  if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover);
};
const onLeave = () => {
  hoverPt = null;
  if (tip) tip.style.display = "none";
};
function runHover() {
  hoverRaf = 0;
  if (!tip || !layer) return;
  const p = hoverPt && layer.pick(hoverPt.x, hoverPt.y);
  if (!p || !hoverPt) {
    tip.style.display = "none";
    return;
  }
  const u = layer.table?.units ?? "";
  const dec = Math.abs(p.max) < 10 && layer.table && layer.table.max - layer.table.min < 20 ? 2 : 0;
  const site = shown.value?.hdr.site;
  tip.innerHTML =
    `<b>${p.max.toFixed(dec)} ${u}</b> max along view <span class="muted">at ${fmtH(p.maxH)}</span><br>` +
    `surface ${p.value.toFixed(dec)} ${u} · ${fmtH(p.h)}` +
    (p.range !== undefined ? `<br>${fmtDist(p.range)} from ${site ?? "radar"}` : "");
  tip.style.display = "block";
  tip.style.transform = `translate(${hoverPt.x + 14}px, ${hoverPt.y + 14}px)`;
}

function enter(map: MLMap) {
  const token = ++modeToken;
  saved ??= { pitch: map.getPitch(), bearing: map.getBearing(), maxPitch: map.getMaxPitch(), rotate: map.dragRotate.isEnabled() };
  map.setMaxPitch(80);
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();
  map.touchPitch?.enable?.();
  layer = new Volume3DLayer();
  overlay = document.createElement("div");
  overlay.className = "v3d-labels";
  tip = document.createElement("div");
  tip.className = "v3d-tip glass";
  map.getContainer().append(overlay, tip);
  layer.onLabels = showLabels;
  if (map.isStyleLoaded()) addLayer(map);
  map.on("style.load", onStyle);
  map.on("moveend", onMoveEnd);
  map.on("mousemove", onHover);
  map.on("mouseout", onLeave);
  navAttach(map); // p7: laptop navigation
  updateViewBox(map);
  probeMrms();
  aimPending = true;
  if (token === modeToken) map.easeTo({ pitch: 60, duration: 900 });
  syncLayer();
  if (shown.value) aimAt(shown.value);
}

function exit(map: MLMap) {
  const token = ++modeToken;
  map.off("style.load", onStyle);
  map.off("moveend", onMoveEnd);
  map.off("mousemove", onHover);
  map.off("mouseout", onLeave);
  navDetach(map); // p7
  if (layer && map.getLayer(layer.id)) map.removeLayer(layer.id); // frees GPU textures (onRemove)
  layer = null;
  overlay?.remove();
  tip?.remove();
  overlay = tip = null;
  manual = false;
  aimPending = false;
  shown.value = null;
  cache.clear();
  for (const id of ["radar", "grid"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
  const s = saved;
  saved = null;
  map.easeTo({ pitch: s?.pitch ?? 0, bearing: s?.bearing ?? 0, duration: 600, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
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

/** Current iso shells / threshold for the layer. */
function styleNow() {
  const v3 = settings.value.view3d;
  const x = v3x.value;
  const w = want.value;
  const thr = v3.thr[w.thrKey] ?? DEFAULT_THR[w.thrKey] ?? w.table.min;
  return { w, thr, shells: shellsFor(w.thrKey), x, v3 };
}

function syncLayer() {
  const l = layer;
  if (!l) return;
  const { w, thr, shells, x, v3 } = styleNow();
  l.setStyle(w.table, {
    mode: x.mode,
    threshold: thr,
    absValue: w.abs,
    density: v3.density,
    exag: v3.exag,
    smooth: v3.smooth,
    shade: v3.shade,
    iso: shells,
    heightColor: x.heightColor,
    tops: x.tops,
    planes: x.planes,
    heightUnit: settings.value.units.distance === "km" ? "km" : "kft",
  });
  l.setVolume(shown.value);
}

effect(() => {
  void settings.value.view3d;
  void settings.value.units;
  void v3x.value;
  void want.value;
  void shown.value;
  syncLayer();
});

effect(() => {
  void settings.value.view3d.floor;
  const map = mapRef.value;
  if (map && layer) hide2D(map);
});

/** Frame the storms: centre on the echo mass, pitch ~62°, and look toward the radar so it sits behind them. */
function aimAt(v: Volume, duration = 1000) {
  const map = mapRef.value;
  if (!map || !layer) return;
  aimPending = false;
  const { w, thr, shells } = styleNow();
  const on = shells.filter((s) => s.on);
  const level = v3x.value.mode === "iso" && on.length ? on[Math.min(1, on.length - 1)].value : thr;
  const a = volumeAim(v, level, w.abs) ?? volumeAim(v, thr, w.abs);
  if (!a) return;
  const c = map.getCanvas();
  const widthKm = Math.max(170, Math.min(600, a.spreadKm * 7));
  const mpp = (widthKm * 1000) / Math.max(400, c.clientWidth);
  const zoom = Math.max(5.5, Math.min(10.5, Math.log2((40075016.7 * Math.cos((a.lat * Math.PI) / 180)) / (512 * mpp))));
  // look toward the radar (it sits behind the storms, a little to the side so its height axis
  // shows); storms grow upward on screen, so put their base in the lower part of the view
  map.easeTo({ center: [a.lon, a.lat], zoom, pitch: 62, bearing: a.bearing !== null ? a.bearing + 25 : map.getBearing(), duration, padding: { top: c.clientHeight * 0.3, bottom: 0, left: 0, right: 0 } });
}

effect(() => {
  const v = shown.value;
  if (v && aimPending && !manual) aimAt(v);
});

function resetView() {
  const map = mapRef.value;
  if (!map) return;
  const v = shown.value;
  if (v) return aimAt(v, 800);
  const site = currentSite.value;
  map.easeTo({ center: site ? [site.lon, site.lat] : undefined, zoom: 7.4, pitch: 60, bearing: 0, duration: 800 });
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
  aim() {
    if (shown.value) aimAt(shown.value, 0);
  },
  setX,
  get layer() {
    return layer;
  },
};

// ---------- p7: laptop / touchpad navigation ----------
// Without a right button, MapLibre's tilt/rotate (right-drag, Ctrl+drag) is hard to reach, so 3D adds:
// Shift/Alt+left-drag (or plain drag in Orbit mode) to orbit, Alt+two-finger scroll to orbit,
// Shift+arrows / W A S D to tilt and rotate, PageUp/PageDown or +/- to zoom, an on-screen pad,
// and a slow auto-rotate. Everything is attached only while 3D is on.
const MAXP = 80;
const clampP = (p: number) => Math.max(0, Math.min(MAXP, p));
/** last user input (auto-rotate pauses for a moment after it) */
let lastInput = 0;
const HINT_KEY = "tbw.3d.navhint";
export const navHint = signal<boolean>((() => {
  try {
    return !localStorage.getItem(HINT_KEY);
  } catch {
    return false;
  }
})());
function hintSeen() {
  if (!navHint.value) return;
  navHint.value = false;
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** Orbit by a screen delta (px): right = turn the view clockwise around the centre, up = tilt toward the horizon. */
function orbitBy(map: MLMap, dx: number, dy: number) {
  map.jumpTo({ bearing: map.getBearing() + dx * 0.45, pitch: clampP(map.getPitch() - dy * 0.35) });
}
/** a small step; animated unless repeated quickly */
export function nav3d(dPitch: number, dBearing: number, dZoom: number, duration = 160) {
  const map = mapRef.value;
  if (!map || !layer) return;
  const now = performance.now();
  lastInput = now;
  // quick repeats (key auto-repeat, clicks) add up instead of restarting from mid-animation
  const g = navGoal && now < navGoal.until && map.isMoving() ? navGoal : { pitch: map.getPitch(), bearing: map.getBearing(), zoom: map.getZoom(), until: 0 };
  navGoal = { pitch: clampP(g.pitch + dPitch), bearing: g.bearing + dBearing, zoom: Math.max(0, Math.min(22, g.zoom + dZoom)), until: now + duration * 3 + 100 };
  map.easeTo({ pitch: navGoal.pitch, bearing: navGoal.bearing, zoom: navGoal.zoom, duration, easing: (t) => t });
}
let navGoal: { pitch: number; bearing: number; zoom: number; until: number } | null = null;

function capture(e: PointerEvent) {
  try {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    /* synthetic / already released */
  }
}

/** The terrain code (basemaps.applyTerrain, run from wf6map on every style load and on every settings
 *  change) eases the camera flat, sets maxPitch to 0 and turns rotation off. In 3D that froze the view
 *  ("can't change the viewing angle"). While 3D is on, those resets are ignored (guardPitch). */
function navReassert(map: MLMap) {
  if (!layer) return;
  if (map.getMaxPitch() < MAXP) map.setMaxPitch(MAXP);
  if (!map.dragRotate.isEnabled()) map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();
  map.boxZoom.disable();
}
let guarded: MLMap | null = null;
/** While 3D is on, ignore the terrain code's camera resets (they arrive on every settings change). */
function guardPitch(map: MLMap) {
  if (guarded) return;
  guarded = map;
  const m = map as any;
  const setMax = map.setMaxPitch, ease = map.easeTo, rotOff = map.dragRotate.disable, touchOff = map.touchZoomRotate.disableRotation;
  m.setMaxPitch = (v?: number | null) => setMax.call(map, layer && (v == null || v < MAXP) ? MAXP : v);
  // applyTerrain's flatten: easeTo({ pitch: 0, bearing: 0, duration: 300 }) and nothing else
  m.easeTo = (o: any, ev?: any) => {
    if (layer && o && o.pitch === 0 && o.bearing === 0 && o.center === undefined && o.zoom === undefined && o.padding === undefined) return map;
    return ease.call(map, o, ev);
  };
  m.dragRotate.disable = () => (layer ? undefined : rotOff.call(map.dragRotate));
  m.touchZoomRotate.disableRotation = () => (layer ? undefined : touchOff.call(map.touchZoomRotate));
}
function unguardPitch(map: MLMap) {
  if (guarded !== map) return;
  guarded = null;
  const m = map as any;
  delete m.setMaxPitch;
  delete m.easeTo;
  delete m.dragRotate.disable;
  delete m.touchZoomRotate.disableRotation;
}

let drag: { x: number; y: number; moved: boolean } | null = null;
let swallowClick = false;
const onDown = (e: MouseEvent) => {
  const map = mapRef.value;
  if (!map || !layer || e.button !== 0 || e.ctrlKey || e.metaKey) return;
  if (!(e.target as HTMLElement).classList?.contains("maplibregl-canvas")) return;
  // Orbit mode swaps the roles: plain drag orbits, Shift+drag pans
  if (!(v3x.value.orbit ? !e.shiftKey : e.shiftKey || e.altKey)) return;
  // keep MapLibre (pan, Shift box-zoom) out of it
  e.stopPropagation();
  e.preventDefault();
  drag = { x: e.clientX, y: e.clientY, moved: false };
  lastInput = performance.now();
  map.getCanvas().style.cursor = "grabbing";
  window.addEventListener("mousemove", onDragMove, true);
  window.addEventListener("mouseup", onDragUp, true);
};
const onDragMove = (e: MouseEvent) => {
  const map = mapRef.value;
  if (!drag || !map) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  drag.x = e.clientX;
  drag.y = e.clientY;
  lastInput = performance.now();
  orbitBy(map, dx, dy);
  hintSeen();
};
const onDragUp = () => {
  window.removeEventListener("mousemove", onDragMove, true);
  window.removeEventListener("mouseup", onDragUp, true);
  if (drag?.moved) swallowClick = true;
  drag = null;
  const map = mapRef.value;
  if (map) map.getCanvas().style.cursor = "";
  setTimeout(() => (swallowClick = false), 0);
};
const onClickCap = (e: MouseEvent) => {
  if (swallowClick) {
    e.stopPropagation();
    swallowClick = false;
  }
};
/** Alt + two-finger scroll (touchpad) or Alt + wheel orbits; Ctrl+wheel stays pinch-zoom */
const onWheel = (e: WheelEvent) => {
  const map = mapRef.value;
  if (!map || !layer || !e.altKey || e.ctrlKey) return;
  e.stopPropagation();
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : 1;
  lastInput = performance.now();
  orbitBy(map, -e.deltaX * k * 0.6, -e.deltaY * k * 0.6);
  hintSeen();
};
const onKey = (e: KeyboardEvent) => {
  if (!layer) return;
  const t = e.target as HTMLElement;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const fast = e.repeat ? 90 : 160;
  let d: [number, number, number] | null = null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.shiftKey && k === "ArrowUp") d = [4, 0, 0];
  else if (e.shiftKey && k === "ArrowDown") d = [-4, 0, 0];
  else if (e.shiftKey && k === "ArrowLeft") d = [0, -7, 0];
  else if (e.shiftKey && k === "ArrowRight") d = [0, 7, 0];
  else if (!e.shiftKey && k === "w") d = [4, 0, 0];
  else if (!e.shiftKey && k === "s") d = [-4, 0, 0];
  else if (!e.shiftKey && k === "a") d = [0, -7, 0];
  else if (!e.shiftKey && k === "d") d = [0, 7, 0];
  else if (k === "PageUp" || k === "+" || k === "=") d = [0, 0, 0.25];
  else if (k === "PageDown" || k === "-" || k === "_") d = [0, 0, -0.25];
  if (!d) return;
  // ahead of the app's hotkeys (frame step, screenshot, draw…) while 3D is on
  e.preventDefault();
  e.stopImmediatePropagation();
  nav3d(d[0], d[1], d[2], fast);
  hintSeen();
};
let spinRaf = 0;
let spinT = 0;
function spinLoop(t: number) {
  spinRaf = 0;
  const map = mapRef.value;
  if (!map || !layer || !v3x.peek().spin) return;
  const dt = spinT ? Math.min(0.1, (t - spinT) / 1000) : 0;
  spinT = t;
  // pause while the user is moving the view
  if (!drag && performance.now() - lastInput > 2500 && !map.isMoving()) map.setBearing(map.getBearing() + dt * 5);
  spinRaf = requestAnimationFrame(spinLoop);
}
effect(() => {
  const on = !!v3x.value.spin && settings.value.view3d.on && !!mapRef.value;
  if (on && !spinRaf) {
    spinT = 0;
    spinRaf = requestAnimationFrame(spinLoop);
  } else if (!on && spinRaf) {
    cancelAnimationFrame(spinRaf);
    spinRaf = 0;
  }
});

function navAttach(map: MLMap) {
  const el = map.getContainer();
  el.addEventListener("mousedown", onDown, true);
  el.addEventListener("click", onClickCap, true);
  el.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("keydown", onKey, true);
  // Shift+drag orbits in 3D instead of box-zooming; Ctrl+left-drag / right-drag stay MapLibre's rotate
  if (saved) saved.box = map.boxZoom.isEnabled();
  map.boxZoom.disable();
  map.dragRotate.enable();
  guardPitch(map);
}
function navDetach(map: MLMap) {
  const el = map.getContainer();
  el.removeEventListener("mousedown", onDown, true);
  el.removeEventListener("click", onClickCap, true);
  el.removeEventListener("wheel", onWheel, true);
  window.removeEventListener("keydown", onKey, true);
  onDragUp();
  unguardPitch(map);
  if (saved?.box !== false) map.boxZoom.enable();
}

/** press-and-hold button: one step on press, then continuous while held */
function HoldBtn({ title, step, rate, children, cls = "" }: { title: string; step: [number, number, number]; rate: [number, number, number]; children: any; cls?: string }) {
  const st = useRef<{ raf: number; t: number; timer: number } | null>(null);
  const stop = () => {
    if (!st.current) return;
    cancelAnimationFrame(st.current.raf);
    clearTimeout(st.current.timer);
    st.current = null;
  };
  useEffect(() => stop, []);
  const down = (e: PointerEvent) => {
    e.preventDefault();
    capture(e);
    stop();
    nav3d(step[0], step[1], step[2]);
    hintSeen();
    const s = { raf: 0, t: 0, timer: 0 };
    st.current = s;
    s.timer = window.setTimeout(() => {
      const loop = (t: number) => {
        const map = mapRef.value;
        if (!map || st.current !== s) return;
        const dt = s.t ? Math.min(0.1, (t - s.t) / 1000) : 0;
        s.t = t;
        lastInput = performance.now();
        map.jumpTo({ pitch: clampP(map.getPitch() + rate[0] * dt), bearing: map.getBearing() + rate[1] * dt, zoom: map.getZoom() + rate[2] * dt });
        s.raf = requestAnimationFrame(loop);
      };
      s.raf = requestAnimationFrame(loop);
    }, 280);
  };
  return (
    <button class={`v3n-btn ${cls}`} title={title} onPointerDown={down as any} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && nav3d(step[0], step[1], step[2])}>
      {children}
    </button>
  );
}

/** drag on the pad: left/right rotates, up/down tilts */
function OrbitPad() {
  const [knob, setKnob] = useState<[number, number]>([0, 0]);
  const last = useRef<[number, number] | null>(null);
  const start = useRef<[number, number]>([0, 0]);
  const down = (e: PointerEvent) => {
    e.preventDefault();
    capture(e);
    last.current = [e.clientX, e.clientY];
    start.current = [e.clientX, e.clientY];
    lastInput = performance.now();
  };
  const move = (e: PointerEvent) => {
    const map = mapRef.value;
    if (!last.current || !map) return;
    const dx = e.clientX - last.current[0], dy = e.clientY - last.current[1];
    last.current = [e.clientX, e.clientY];
    lastInput = performance.now();
    orbitBy(map, dx * 1.3, dy * 1.3);
    const kx = e.clientX - start.current[0], ky = e.clientY - start.current[1];
    const r = Math.hypot(kx, ky), m = 20;
    setKnob(r > m ? [(kx / r) * m, (ky / r) * m] : [kx, ky]);
    hintSeen();
  };
  const up = () => {
    last.current = null;
    setKnob([0, 0]);
  };
  return (
    <div class="v3n-pad" title="Orbit: drag here to rotate (left/right) and tilt (up/down)" onPointerDown={down as any} onPointerMove={move as any} onPointerUp={up} onPointerCancel={up}>
      <span class="v3n-ring" />
      <span class="v3n-knob" style={{ transform: `translate(${knob[0]}px, ${knob[1]}px)` }}>
        <Move3D size={13} />
      </span>
    </div>
  );
}

function Nav3D() {
  const x = v3x.value;
  const map = mapRef.value;
  const [, setT] = useState(0);
  // keep the pitch / bearing readout fresh
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const f = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), setT((t) => t + 1)));
    };
    map.on("move", f);
    return () => {
      map.off("move", f);
      cancelAnimationFrame(raf);
    };
  }, [map]);
  useEffect(() => {
    if (!navHint.value) return;
    const t = setTimeout(hintSeen, 15000);
    return () => clearTimeout(t);
  }, []);
  const pitch = map ? Math.round(map.getPitch()) : 0;
  const brg = map ? Math.round(((map.getBearing() % 360) + 360) % 360) : 0;
  return (
    <div class="v3n glass" onPointerDown={(e) => e.stopPropagation()}>
      {navHint.value && (
        <div class="v3n-hint">
          <span>
            <b>Tilt / rotate:</b> Shift+drag or Alt+drag on the map, the pad below, or W A S D / Shift+arrows. Zoom: +/− or PageUp/PageDown.
          </span>
          <button class="icon-btn" title="Got it" onClick={hintSeen}>
            <X size={12} />
          </button>
        </div>
      )}
      <div class="v3n-main">
        <div class="v3n-cross">
          <HoldBtn cls="up" title="Tilt toward the horizon (W, Shift+↑)" step={[5, 0, 0]} rate={[30, 0, 0]}>
            <ChevronUp size={15} />
          </HoldBtn>
          <HoldBtn cls="left" title="Rotate left (A, Shift+←)" step={[0, -10, 0]} rate={[0, -45, 0]}>
            <RotateCcw size={14} />
          </HoldBtn>
          <OrbitPad />
          <HoldBtn cls="right" title="Rotate right (D, Shift+→)" step={[0, 10, 0]} rate={[0, 45, 0]}>
            <RotateCw size={14} />
          </HoldBtn>
          <HoldBtn cls="down" title="Tilt toward top-down (S, Shift+↓)" step={[-5, 0, 0]} rate={[-30, 0, 0]}>
            <ChevronDown size={15} />
          </HoldBtn>
        </div>
        <div class="v3n-zoom">
          <HoldBtn title="Zoom in (+, PageUp)" step={[0, 0, 0.3]} rate={[0, 0, 1.2]}>
            <Plus size={14} />
          </HoldBtn>
          <HoldBtn title="Zoom out (−, PageDown)" step={[0, 0, -0.3]} rate={[0, 0, -1.2]}>
            <Minus size={14} />
          </HoldBtn>
          <button class="v3n-btn" title="Reset: aim at the storms" onClick={resetView}>
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
      <div class="v3n-foot">
        <button class={`v3n-tog ${x.orbit ? "on" : ""}`} aria-pressed={!!x.orbit} title="Plain drag orbits around the view centre instead of panning (good for touchpads); Shift+drag pans then." onClick={() => setX((y) => (y.orbit = !y.orbit))}>
          Orbit drag
        </button>
        <button class={`v3n-tog ${x.spin ? "on" : ""}`} aria-pressed={!!x.spin} title="Slowly rotate the view" onClick={() => setX((y) => (y.spin = !y.spin))}>
          Auto-rotate
        </button>
        <span class="v3n-read muted" title="Tilt · heading">
          {pitch}° · {brg}°
        </span>
      </div>
    </div>
  );
}
// test handle
(window as any).__tbw3dNav = { nav3d, orbitBy: (dx: number, dy: number) => mapRef.value && orbitBy(mapRef.value, dx, dy), hint: navHint };
// ---------- end p7 ----------

// ---------- header button ----------
export function Btn3D() {
  const on = settings.value.view3d.on;
  if (!support3D.value && !on) return null;
  return (
    <button class={`hdr-3d ${on ? "on" : ""}`} title={on ? "Leave 3D view (Shift+3)" : "3D volume view (Shift+3)"} onClick={toggle3D}>
      3D
    </button>
  );
}

// ---------- panel ----------
function ShellRow({ s, i, k, table, dec, step }: { s: IsoShell; i: number; k: string; table: ColorTable; dec: number; step: number }) {
  const all = shellsFor(k);
  const set = (fn: (x: IsoShell) => void) =>
    setX((x) => {
      const arr = (x.iso[k] ?? all).map((y) => ({ ...y }));
      fn(arr[i]);
      x.iso[k] = arr;
    });
  const c = layer?.table ? layer.colorOf(s.value + (table.max - table.min) * 0.01) : [0.5, 0.5, 0.5];
  const css = `rgb(${c.map((x) => Math.round(x * 255)).join(",")})`;
  return (
    <div class={`v3d-shell ${s.on ? "" : "off"}`}>
      <input type="checkbox" checked={s.on} onChange={() => set((x) => (x.on = !x.on))} title="Show this surface" />
      <i class="v3d-sw" style={{ background: css }} />
      <input
        class="v3d-num"
        type="number"
        step={step}
        value={+s.value.toFixed(dec)}
        onChange={(e) => {
          const n = parseFloat((e.target as HTMLInputElement).value);
          if (isFinite(n)) set((x) => (x.value = n));
        }}
        title={`Surface value (${table.units})`}
      />
      <span class="muted small">{table.units}</span>
      <input type="range" min={0.05} max={1} step={0.05} value={s.opacity} onInput={(e) => set((x) => (x.opacity = +(e.target as HTMLInputElement).value))} title="Opacity" />
      <span class="val">{Math.round(s.opacity * 100)}%</span>
    </div>
  );
}

export function View3D() {
  const v3 = settings.value.view3d;
  if (!v3.on) return null;
  const x = v3x.value;
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
  const shells = shellsFor(w.thrKey);
  const sup = support3D.value;
  return (
    <>
    <Nav3D /> {/* p7 */}
    <div class="v3d glass">
      <div class="v3d-head">
        <b>3D</b>
        <span class="muted small v3d-meta">{h ? `${h.site ?? "MRMS"} ${h.moment ?? ""} ${h.nx}×${h.ny}×${h.nz}` : ""}</span>
        {vol3dLoading.value && <Loader2 size={14} class="spin" />}
        <button class="icon-btn" title="Aim at the storms" onClick={resetView}>
          <RotateCcw size={14} />
        </button>
      </div>
      {sup === "radar" && mrmsAvailable.value !== false && (
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
      <div class="v3d-seg">
        <button class={x.mode === "iso" ? "on" : ""} onClick={() => setX((y) => (y.mode = "iso"))} title="Solid shells at chosen values: cores and tops stand out">
          Surfaces
        </button>
        <button class={x.mode === "volume" ? "on" : ""} onClick={() => setX((y) => (y.mode = "volume"))} title="Semi-transparent cloud">
          Cloud
        </button>
      </div>
      {x.mode === "iso" ? (
        <div class="v3d-shells">
          {shells.map((s, i) => (
            <ShellRow key={i} s={s} i={i} k={w.thrKey} table={t} dec={dec} step={step} />
          ))}
          {x.iso[w.thrKey] && (
            <button class="link small v3d-reset" onClick={() => setX((y) => delete y.iso[w.thrKey])}>
              Reset surfaces
            </button>
          )}
        </div>
      ) : (
        <>
          <Slider label={w.abs ? `|${t.units}| ≥` : `Min ${t.units}`} value={thr} min={lo} max={t.max} step={step} fmt={(x) => x.toFixed(dec)} set={(x) => set((s) => (s.thr = { ...s.thr, [w.thrKey]: x }))} />
          <Slider label="Density" value={v3.density} min={0.1} max={4} step={0.05} fmt={(x) => x.toFixed(2)} set={(x) => set((s) => (s.density = x))} />
        </>
      )}
      <Slider label="Height ×" value={v3.exag} min={1} max={10} step={0.5} fmt={(x) => `${x}×`} set={(x) => set((s) => (s.exag = x))} />
      <div class="v3d-row">
        {v3.src === "radar" && sup === "radar" && (
          <div class="v3d-seg small">
            <button class={v3.res === "lo" ? "on" : ""} onClick={() => set((x) => (x.res = "lo"))} title="Coarser grid, faster">
              Lo
            </button>
            <button class={v3.res === "hi" ? "on" : ""} onClick={() => set((x) => (x.res = "hi"))} title="Finer grid, bigger download">
              Hi
            </button>
          </div>
        )}
        <label title="Height scale and echo-top markers">
          <input type="checkbox" checked={x.tops} onChange={() => setX((y) => (y.tops = !y.tops))} /> Tops
        </label>
        <label title="Faint height planes every 5 km">
          <input type="checkbox" checked={x.planes} onChange={() => setX((y) => (y.planes = !y.planes))} /> Planes
        </label>
        {x.mode === "volume" && (
          <label title="Colour by height instead of value">
            <input type="checkbox" checked={x.heightColor} onChange={() => setX((y) => (y.heightColor = !y.heightColor))} /> Height colours
          </label>
        )}
      </div>
      <div class="v3d-row">
        <label title="Show the 2D layer under the volume">
          <input type="checkbox" checked={v3.floor} onChange={() => set((x) => (x.floor = !x.floor))} /> Floor
        </label>
        <label title="Smooth the field (less blocky surfaces)">
          <input type="checkbox" checked={v3.smooth} onChange={() => set((x) => (x.smooth = !x.smooth))} /> Smooth
        </label>
        <label title="Surface lighting">
          <input type="checkbox" checked={v3.shade} onChange={() => set((x) => (x.shade = !x.shade))} /> Light
        </label>
      </div>
    </div>
    </>
  );
}
