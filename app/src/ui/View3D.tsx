// 3D volume view: pitches the map, swaps the 2D radar for a ray-marched volume and shows a
// small control panel. The volume follows the timeline's current frame.
// Available for Level II radar (incl. ODIM volumes, source "L2") and MRMS reflectivity layers;
// the header shows a "3D" toggle only for those (Btn3D) and 3D exits when the layer changes away.

import { signal, effect, computed } from "@preact/signals";
import type { Map as MLMap, MapMouseEvent } from "maplibre-gl";
import { RotateCcw, Loader2 } from "lucide-preact";
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
let saved: { pitch: number; bearing: number; maxPitch: number; rotate: boolean } | null = null;
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
const onStyle = () => mapRef.value && addLayer(mapRef.value);
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
  );
}
