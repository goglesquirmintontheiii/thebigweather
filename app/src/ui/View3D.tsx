// 3D view: pitches a map, swaps its 2D layer for a ray-marched volume (Level II / MRMS 3D) or a
// height surface (0.8.3: every other product — Level III, single tilts, velocity |v|, composite, echo
// tops, VIL, MRMS / model grids) and shows a small control panel. The 3D data follows the timeline.
// 0.8.3 3d: one Mode3D per map, so any pane can be in 3D too (R40); volumes load with progress, a
// timeout and Retry (R43); while a volume loads the 2D product is shown as a surface right away.

import { flatten2D } from "../map/pitchpick"; // 0.8.4
import { signal, effect, computed, untracked, type ReadonlySignal, type Signal } from "@preact/signals";
import type { Map as MLMap, MapMouseEvent } from "maplibre-gl";
import { RotateCcw, Loader2, ChevronUp, ChevronDown, RotateCw, Plus, Minus, Move3D, RefreshCw, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { settings, update, type PaneCfg } from "../store";
import { mapRef } from "../map/mapview";
import { currentFrame, frames, activeTable, currentSite, tableById, tableKeyFor, liveState } from "../radar/controller";
import { gridFrames, gridRaster, gridTableActive } from "../grid/controller";
import { gridDef, gridLayers, gridTable } from "../weather";
import { frameIndex, playing } from "../anim";
import { Volume3DLayer, parseVolume, volumeAim, type Volume, type IsoShell, type V3Mode, type Label } from "../radar/Volume3D";
import { Surface3DLayer } from "../radar/Surface3D";
import { binSweep, binRaster, heightMapFor, sideFor, isVelocityTable, surfaceable, liveVersion, type Field } from "../radar/surface3dcore";
import type { Sweep } from "../radar/sweep";
import type { Raster } from "../grid/raster";
import { pane3dInfo, paneRev } from "../map/panes";
import { Slider } from "./controls";
import type { ColorTable } from "../radar/colormaps";
import { popoutSpec } from "../popout"; // integration 0.8.3

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
/** 0.8.3 3d: a volume that hasn't arrived after this long is reported (and can be retried) */
const TIMEOUT_MS = 120_000;

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
  /** 0.8.3 3d: per product: draw a height surface instead of the volume (velocity defaults to it) */
  height?: Record<string, boolean>;
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
/** 0.8.3 3d (R41): velocity shows as a |v| height surface unless the volume was picked */
function heightStyle(key: string, vel: boolean): boolean {
  return v3x.value.height?.[key] ?? vel;
}

/** MRMS 3D endpoint: null = unknown, false = not on this server */
export const mrmsAvailable = signal<boolean | null>(null);

// ---------- what to draw ----------
interface SurfSrc {
  sweep?: Sweep;
  raster?: Raster;
}
interface Want {
  /** volume to load (null: none / not yet) */
  url: string | null;
  nextUrl?: string;
  /** server moment of the volume (a volume of another moment is never shown with this table) */
  moment: string | null;
  /** 2D data drawn as a height surface: on its own (surfOnly) or while the volume loads */
  surf: SurfSrc | null;
  surfOnly: boolean;
  note: string | null;
  thrKey: string;
  /** key of the Volume / Height choice (null: no volume for this product) */
  styleKey: string | null;
  table: ColorTable;
  abs: boolean;
}
interface Ctx {
  kind: "radar" | "grid" | "other";
  source?: "L2" | "L3";
  product?: string;
  table?: ColorTable | null;
  frameKey?: string;
  nextKey?: string;
  sweep?: Sweep;
  gridId?: string;
  raster?: Raster | null;
  time?: number;
  box?: string;
  /** live (in-progress) volume version */
  liveV?: number;
}

const REF_T = () => tableById(settings.value.tables.REF || "REF");

function buildWant(c: Ctx): Want {
  const v3 = settings.value.view3d;
  const none = (note: string, table = c.table ?? REF_T()): Want => ({ url: null, moment: null, surf: null, surfOnly: true, note, thrKey: "REF", styleKey: null, table, abs: false });
  const mrmsUrl = (time: number | undefined) => {
    const t = Math.round((time ?? Date.now()) / 60000) * 60000; // to the minute: neighbouring ticks share a request
    return c.box ? `/api/grid/volume3d?time=${t}&bbox=${c.box}` : null;
  };
  if (c.kind === "radar") {
    const product = c.product ?? "REF";
    const tk = tableKeyFor(product);
    const abs = isVelocityTable(tk);
    const table = c.table ?? REF_T();
    const m = c.source === "L2" ? MOMENT[product] : undefined;
    const surf = c.sweep ? { sweep: c.sweep } : null;
    if (m && v3.src === "mrms" && mrmsAvailable.value !== false)
      return { url: mrmsUrl(c.time), moment: "REF", surf: null, surfOnly: false, note: null, thrKey: "MRMS", styleKey: null, table: REF_T(), abs: false };
    if (m && !heightStyle(m, abs)) {
      const mk = (key: string) => `/api/radar/volume3d?key=${encodeURIComponent(key)}&moment=${m}&res=${v3.res}`;
      return {
        url: c.frameKey ? mk(c.frameKey) + liveVersion(c.frameKey, c.liveV ?? 0) : null,
        nextUrl: c.nextKey && !c.nextKey.startsWith("live:") ? mk(c.nextKey) : undefined,
        moment: m,
        surf,
        surfOnly: false,
        note: c.frameKey ? null : "Waiting for radar data",
        thrKey: m,
        styleKey: m,
        table,
        abs: m === "VEL",
      };
    }
    if (!surfaceable(table)) return none(`No 3D for ${product}`, table);
    return { url: null, moment: null, surf, surfOnly: true, note: surf ? null : "Waiting for radar data", thrKey: m ?? tk, styleKey: m ?? null, table, abs };
  }
  if (c.kind === "grid") {
    const d = c.gridId ? gridDef(c.gridId) : undefined;
    if (!d) return none("Waiting for the layer list");
    const surf = c.raster && !c.raster.rgba ? { raster: c.raster } : null;
    if (d.source === "mrms" && d.cmap === "REF" && mrmsAvailable.value !== false && !heightStyle("MRMS", false))
      return { url: mrmsUrl(c.time), moment: "REF", surf, surfOnly: false, note: null, thrKey: "MRMS", styleKey: "MRMS", table: REF_T(), abs: false };
    const table = c.table ?? (d.cmap !== "RGB" ? gridTable(d.cmap) : null);
    if (!table || d.cmap === "RGB" || !surfaceable(table)) return none("No 3D for this layer");
    const mr = d.source === "mrms" && d.cmap === "REF" && mrmsAvailable.value !== false;
    return { url: null, moment: null, surf, surfOnly: true, note: surf ? null : "Waiting for data", thrKey: d.cmap, styleKey: mr ? "MRMS" : null, table, abs: false };
  }
  return none("No 3D for this layer");
}

/** Which 3D the main map's layer supports (null = none). */
export const support3D = computed<"radar" | "mrms" | "surface" | null>(() => {
  const s = settings.value;
  const w = s.weather;
  if (w.kind === "radar") return s.radar.source === "L2" && MOMENT[s.radar.product] ? "radar" : surfaceable(activeTable.value) ? "surface" : null;
  if (w.kind === "grid") {
    const d = gridDef(w.id);
    if (!d) return null;
    if (d.source === "mrms" && d.cmap === "REF" && mrmsAvailable.value !== false) return "mrms";
    return d.cmap !== "RGB" && surfaceable(gridTableActive.value) ? "surface" : null;
  }
  return null;
});
/** does a pane's layer have 3D? */
function paneSupports(cfg: PaneCfg | null | undefined): boolean {
  if (!cfg) return false;
  if (cfg.weather.kind === "radar") {
    const product = cfg.source === "L3" ? cfg.product ?? "N0B" : cfg.product ?? "REF";
    if ((cfg.source ?? "L2") === "L2" && MOMENT[product]) return true;
    const tk = tableKeyFor(product);
    return surfaceable(tableById(settings.value.tables[tk] ?? tk));
  }
  if (cfg.weather.kind === "grid") {
    const d = gridDef(cfg.weather.id);
    return !!d && d.cmap !== "RGB" && surfaceable(gridTable(d.cmap));
  }
  return false;
}

export function toggle3D() {
  const on = settings.value.view3d.on;
  // Shift+3 does nothing on layers without 3D data
  if (!on && !support3D.value) return;
  update((s) => (s.view3d.on = !on));
}

/** live volume version: how many tilts the main site's in-progress volume has shown so far */
const liveTilts = signal<{ key: string; elev: number; n: number }>({ key: "", elev: NaN, n: 0 });
effect(() => {
  const l = liveState.value;
  if (!l) return;
  const o = liveTilts.peek();
  if (o.key !== l.key) liveTilts.value = { key: l.key, elev: l.elev, n: 1 };
  else if (Math.abs(o.elev - l.elev) > 0.05 || (l.complete && o.n < 1000)) liveTilts.value = { key: l.key, elev: l.elev, n: l.complete ? 1000 : o.n + 1 };
});

/** fetch a binary body, reporting bytes as they arrive */
async function fetchBin(path: string, signal: AbortSignal, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  if (!api.base) throw new ApiError(0, "No server configured");
  const r = await fetch(api.base + path, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {}, signal });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* binary */
    }
    throw new ApiError(r.status, msg);
  }
  if (!onBytes || !r.body) return r.arrayBuffer();
  onBytes(0);
  const rd = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    const now = performance.now();
    if (now - last > 150) (last = now), onBytes(got);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out.buffer;
}

/** surfaces are built once per frame and quality */
const fieldCache = new WeakMap<object, Map<string, Field | null>>();
function fieldFor(s: SurfSrc, res: "lo" | "hi", abs: boolean): Field | null {
  const o = (s.sweep ?? s.raster) as object | undefined;
  if (!o) return null;
  const k = `${res}|${abs}`;
  let m = fieldCache.get(o);
  if (!m) fieldCache.set(o, (m = new Map()));
  if (!m.has(k)) m.set(k, s.sweep ? binSweep(s.sweep, sideFor(res), abs) : binRaster(s.raster!, sideFor(res), abs));
  return m.get(k)!;
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

const MAXP = 80;
const clampP = (p: number) => Math.max(0, Math.min(MAXP, p));
/** last user input (auto-rotate pauses for a moment after it) */
let lastInput = 0;

/** Orbit by a screen delta (px): right = turn the view clockwise around the centre, up = tilt toward the horizon. */
function orbitBy(map: MLMap, dx: number, dy: number) {
  map.jumpTo({ bearing: map.getBearing() + dx * 0.45, pitch: clampP(map.getPitch() - dy * 0.35) });
}

/**
 * p7 mouse navigation on one map: Shift/Alt+left-drag (or plain drag in Orbit mode) orbits, Alt+wheel
 * orbits. 0.8.3 3d (R38): MapLibre still gets the mousedown — it compares every click with the last
 * mousedown it saw, so swallowing it (old Orbit mode) made later clicks on alerts, cameras… do nothing
 * until 3D was left. Only its drag-pan is paused for the gesture.
 */
function attachNav(map: MLMap): () => void {
  let drag: { x: number; y: number; moved: boolean } | null = null;
  let panWas = false;
  let swallowClick = false;
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
    if (!(e.target as HTMLElement).classList?.contains("maplibregl-canvas")) return;
    // Orbit mode swaps the roles: plain drag orbits, Shift+drag pans
    if (!(v3x.value.orbit ? !e.shiftKey : e.shiftKey || e.altKey)) return;
    panWas = map.dragPan.isEnabled();
    if (panWas) map.dragPan.disable();
    e.preventDefault(); // no text selection; MapLibre still sees the event
    drag = { x: e.clientX, y: e.clientY, moved: false };
    lastInput = performance.now();
    window.addEventListener("mousemove", onDragMove, true);
    window.addEventListener("mouseup", onDragUp, true);
    window.addEventListener("blur", onDragUp);
  };
  const onDragMove = (e: MouseEvent) => {
    if (!drag) return;
    if (!e.buttons) return onDragUp(); // released outside the window
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    if (!drag.moved) map.getCanvas().style.cursor = "grabbing";
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
    window.removeEventListener("blur", onDragUp);
    if (drag?.moved) {
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
    }
    if (drag?.moved) map.getCanvas().style.cursor = "";
    drag = null;
    if (panWas) map.dragPan.enable();
    panWas = false;
  };
  const onClickCap = (e: MouseEvent) => {
    if (swallowClick) {
      e.stopPropagation();
      swallowClick = false;
    }
  };
  /** Alt + two-finger scroll (touchpad) or Alt + wheel orbits; Ctrl+wheel stays pinch-zoom */
  const onWheel = (e: WheelEvent) => {
    if (!e.altKey || e.ctrlKey) return;
    e.stopPropagation();
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : 1;
    lastInput = performance.now();
    orbitBy(map, -e.deltaX * k * 0.6, -e.deltaY * k * 0.6);
    hintSeen();
  };
  const el = map.getContainer();
  el.addEventListener("mousedown", onDown, true);
  el.addEventListener("click", onClickCap, true);
  el.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    el.removeEventListener("mousedown", onDown, true);
    el.removeEventListener("click", onClickCap, true);
    el.removeEventListener("wheel", onWheel, true);
    onDragUp();
  };
}

// ---------- one map in 3D ----------
interface ModeOpts {
  name: string;
  want: ReadonlySignal<Want>;
  isOn: () => boolean;
  getMap: () => MLMap | null;
  /** the map's 2D weather layers (hidden under the 3D data unless Floor is on) */
  hide: string[];
  main: boolean;
  /** map area for MRMS requests (quantized, updated when the view moves away) */
  box: Signal<string>;
}

export class Mode3D {
  readonly o: ModeOpts;
  /** the map while in 3D */
  active = signal<MLMap | null>(null);
  shown = signal<Volume | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  /** bytes received / start of the current volume request */
  progress = signal<{ got: number; t0: number; bytes: boolean } | null>(null);
  /** map area for MRMS requests (quantized, updated when the view moves away) */
  viewBox: Signal<string>;
  vol: Volume3DLayer | null = null;
  surf: Surface3DLayer | null = null;
  /** a volume opened through the console/test handle stays up regardless of the timeline */
  manual = false;
  private cache = new Map<string, Volume>();
  private failed = new Set<string>();
  private inflight: { url: string; ctl: AbortController; prefetch: boolean } | null = null;
  private queued: string | null = null;
  private saved: { pitch: number; bearing: number; maxPitch: number; rotate: boolean } | null = null;
  /** 0.8.4: what `saved` was while the camera eases back to 2D (3D switched on again meanwhile) */
  private leaving: { pitch: number; bearing: number; maxPitch: number; rotate: boolean } | null = null;
  private token = 0;
  private aimPending = false;
  private overlay: HTMLDivElement | null = null;
  private tip: HTMLDivElement | null = null;
  private navOff: (() => void) | null = null;
  private stops: (() => void)[] = [];
  private hoverRaf = 0;
  private hoverPt: { x: number; y: number } | null = null;

  constructor(o: ModeOpts) {
    this.o = o;
    this.viewBox = o.box;
    // enter / leave (and follow a pane whose map was rebuilt)
    this.stops.push(
      effect(() => {
        const map = o.getMap();
        const on = o.isOn();
        const cur = this.active.peek();
        if (cur && (cur !== map || !on)) this.exit();
        if (on && map && !this.active.peek()) this.enter(map);
      }),
    );
    // load what the timeline wants
    this.stops.push(
      effect(() => {
        if (!this.active.value) return;
        const w = o.want.value;
        if (!w.url) {
          if (w.note && !this.manual) this.shown.value = null;
          return;
        }
        if (!this.failed.has(w.url)) this.error.value = null;
        // cache hit shows immediately; otherwise the last volume stays up until the new one arrives
        this.fetchVolume(w.url);
      }),
    );
    this.stops.push(
      effect(() => {
        void settings.value.view3d;
        void settings.value.units;
        void v3x.value;
        void o.want.value;
        void this.shown.value;
        if (this.active.value) this.sync();
      }),
    );
    this.stops.push(
      effect(() => {
        void settings.value.view3d.floor;
        const m = this.active.value;
        if (m) this.hide2D(m);
      }),
    );
    // aim the camera at the storms once the first volume arrives
    this.stops.push(
      effect(() => {
        const v = this.shown.value;
        if (v && this.aimPending && !this.manual && this.active.peek()) this.aimAt(v);
      }),
    );
  }

  dispose() {
    this.exit();
    for (const s of this.stops) s();
    this.stops = [];
  }

  /** forget failures and load again */
  retry() {
    this.failed.clear();
    this.error.value = null;
    const w = this.o.want.peek();
    if (w.url) this.fetchVolume(w.url);
  }

  private remember(url: string, v: Volume) {
    this.cache.delete(url);
    this.cache.set(url, v);
    while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
  }

  private async fetchVolume(url: string, prefetch = false): Promise<void> {
    if (this.cache.has(url)) {
      if (!prefetch && this.o.want.peek().url === url) this.shown.value = this.cache.get(url)!;
      return;
    }
    if (this.failed.has(url)) return; // no retry loop: Retry asks again
    if (this.inflight) {
      // one request at a time; while the loop plays only the newest wish is kept
      if (!prefetch) {
        this.queued = url;
        // a prefetch that is no longer wanted gives way
        if (this.inflight.prefetch && this.inflight.url !== url) this.inflight.ctl.abort();
        else if (this.inflight.url === url && this.inflight.prefetch) {
          this.inflight.prefetch = false;
          this.loading.value = true;
        }
      }
      return;
    }
    const tok = this.token;
    const ctl = new AbortController();
    const me = { url, ctl, prefetch };
    this.inflight = me;
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), ctl.abort()), TIMEOUT_MS);
    const t0 = performance.now();
    if (!prefetch) {
      this.loading.value = true;
      this.progress.value = { got: 0, t0, bytes: false };
    }
    try {
      const buf = await fetchBin(url, ctl.signal, (got) => !me.prefetch && tok === this.token && (this.progress.value = { got, t0, bytes: true }));
      if (tok !== this.token) return;
      const v = parseVolume(buf);
      this.remember(url, v);
      if (this.o.want.peek().url === url) {
        this.manual = false;
        this.shown.value = v;
        this.error.value = null;
      }
    } catch (e: any) {
      if (tok !== this.token) return;
      const aborted = e?.name === "AbortError" && !timedOut;
      if (url.startsWith("/api/grid/volume3d") && e instanceof ApiError && e.status === 404) {
        mrmsAvailable.value = false;
        if (this.o.main) update((s) => (s.view3d.src = "radar"));
      } else if (!aborted) {
        this.failed.add(url);
        if (!me.prefetch && this.o.want.peek().url === url)
          this.error.value = timedOut ? "3D data is taking too long (server busy?)" : e instanceof ApiError && e.status === 404 ? "No 3D data for this volume" : e?.message ?? String(e);
      }
    } finally {
      clearTimeout(timer);
      if (this.inflight === me) this.inflight = null;
      if (tok === this.token) {
        this.loading.value = false;
        this.progress.value = null;
        const q = this.queued;
        this.queued = null;
        const w = this.o.want.peek();
        if (q && q === w.url && !this.cache.has(q)) this.fetchVolume(q);
        else if (w.url && !this.cache.has(w.url)) this.fetchVolume(w.url);
        else if (w.url && this.cache.has(w.url)) {
          this.shown.value = this.cache.get(w.url)!;
          // keep one frame ahead while the loop plays
          if (playing.peek() && w.nextUrl && !this.cache.has(w.nextUrl)) this.fetchVolume(w.nextUrl, true);
        }
      }
    }
  }

  private hide2D(map: MLMap) {
    const vis = settings.peek().view3d.floor ? "visible" : "none";
    for (const id of this.o.hide)
      try {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
      } catch {
        /* style reloading */
      }
  }
  private addLayers(map: MLMap) {
    try {
      if (this.surf && !map.getLayer(this.surf.id)) map.addLayer(this.surf);
      if (this.vol && !map.getLayer(this.vol.id)) map.addLayer(this.vol);
    } catch (e) {
      console.warn("3D layers:", e);
    }
    this.hide2D(map);
  }
  private onStyle = () => {
    const m = this.active.peek();
    if (!m) return;
    this.addLayers(m);
    this.reassert(m);
  };
  private onMoveEnd = () => {
    const m = this.active.peek();
    if (m) this.updateViewBox(m);
  };
  private updateViewBox(map: MLMap) {
    const b = map.getBounds();
    const c = map.getCenter();
    // at most ~10° x 7° around the centre, snapped to 0.5° so small pans reuse the volume
    const q = (x: number) => Math.round(x * 2) / 2;
    const w = Math.max(b.getWest(), c.lng - 5), e = Math.min(b.getEast(), c.lng + 5);
    const s = Math.max(b.getSouth(), c.lat - 3.5), n = Math.min(b.getNorth(), c.lat + 3.5);
    const box = `${q(w) - 0.5},${q(s) - 0.5},${q(e) + 0.5},${q(n) + 0.5}`;
    if (box !== this.viewBox.peek()) this.viewBox.value = box;
  }
  /** after a style load (terrain re-applied): make sure the 3D camera limits still hold */
  private reassert(map: MLMap) {
    if (map.getMaxPitch() < MAXP) map.setMaxPitch(MAXP);
    if (!map.dragRotate.isEnabled()) map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.boxZoom.disable();
  }

  private onHover = (e: MapMouseEvent) => {
    const oe = e.originalEvent as MouseEvent;
    this.hoverPt = oe.buttons ? null : { x: e.point.x, y: e.point.y };
    if (!this.hoverRaf) this.hoverRaf = requestAnimationFrame(this.runHover);
  };
  private onLeave = () => {
    this.hoverPt = null;
    if (this.tip) this.tip.style.display = "none";
  };
  private runHover = () => {
    this.hoverRaf = 0;
    const tip = this.tip, pt = this.hoverPt;
    if (!tip) return;
    const hide = () => void (tip.style.display = "none");
    if (!pt) return hide();
    const w = this.o.want.peek();
    const u = w.table.units ?? "";
    let html = "";
    if (this.surf?.field) {
      const p = this.surf.pick(pt.x, pt.y);
      if (!p) return hide();
      const dec = Math.abs(p.value) < 10 && w.table.max - w.table.min < 20 ? 2 : Math.abs(p.value) < 100 ? 1 : 0;
      html = `<b>${p.value.toFixed(dec)} ${u}</b><br><span class="muted">height ${fmtH(p.h)}${w.abs ? " (|value|)" : ""}</span>`;
    } else if (this.vol) {
      const p = this.vol.pick(pt.x, pt.y);
      if (!p) return hide();
      const t = this.vol.table;
      const dec = Math.abs(p.max) < 10 && t && t.max - t.min < 20 ? 2 : 0;
      const site = this.shown.peek()?.hdr.site;
      html =
        `<b>${p.max.toFixed(dec)} ${t?.units ?? ""}</b> max along view <span class="muted">at ${fmtH(p.maxH)}</span><br>` +
        `surface ${p.value.toFixed(dec)} ${t?.units ?? ""} · ${fmtH(p.h)}` +
        (p.range !== undefined ? `<br>${fmtDist(p.range)} from ${site ?? "radar"}` : "");
    } else return hide();
    tip.innerHTML = html;
    tip.style.display = "block";
    tip.style.transform = `translate(${pt.x + 14}px, ${pt.y + 14}px)`;
  };

  private showLabels = (ls: Label[]) => {
    if (!this.overlay) return;
    this.overlay.innerHTML = ls
      .map((l) => `<div class="v3d-lbl v3d-k-${l.kind}" style="transform:translate(${l.x.toFixed(1)}px,${l.y.toFixed(1)}px)"><span>${l.text.replace(/</g, "&lt;")}</span></div>`)
      .join("");
  };

  private enter(map: MLMap) {
    const token = ++this.token;
    this.saved ??= this.leaving ?? { pitch: map.getPitch(), bearing: map.getBearing(), maxPitch: map.getMaxPitch(), rotate: map.dragRotate.isEnabled() };
    this.leaving = null;
    this.active.value = map;
    map.setMaxPitch(MAXP);
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.touchPitch?.enable?.();
    map.boxZoom.disable(); // Shift+drag orbits in 3D instead of box-zooming
    const id = this.o.name;
    this.vol = new Volume3DLayer(`volume3d-${id}`);
    this.surf = new Surface3DLayer(`surface3d-${id}`);
    this.overlay = document.createElement("div");
    this.overlay.className = "v3d-labels";
    this.tip = document.createElement("div");
    this.tip.className = "v3d-tip glass";
    map.getContainer().append(this.overlay, this.tip);
    this.vol.onLabels = this.showLabels;
    if (map.isStyleLoaded()) this.addLayers(map);
    map.on("style.load", this.onStyle);
    map.on("moveend", this.onMoveEnd);
    map.on("mousemove", this.onHover);
    map.on("mouseout", this.onLeave);
    this.navOff = attachNav(map);
    if (this.o.main) mainNavOn();
    this.updateViewBox(map);
    probeMrms();
    this.aimPending = true;
    if (token === this.token) map.easeTo({ pitch: 60, duration: 900 });
    this.sync();
    if (this.shown.peek()) this.aimAt(this.shown.peek()!);
  }

  private exit() {
    const map = this.active.peek();
    if (!map) return;
    const token = ++this.token;
    this.inflight?.ctl.abort();
    this.inflight = null;
    this.queued = null;
    this.loading.value = false;
    this.progress.value = null;
    this.active.value = null;
    cancelAnimationFrame(this.hoverRaf);
    this.hoverRaf = 0;
    this.navOff?.();
    this.navOff = null;
    if (this.o.main) mainNavOff();
    const alive = !(map as any)._removed;
    try {
      map.off("style.load", this.onStyle);
      map.off("moveend", this.onMoveEnd);
      map.off("mousemove", this.onHover);
      map.off("mouseout", this.onLeave);
      if (alive) {
        // removeLayer frees the GPU textures / buffers (onRemove)
        for (const l of [this.vol, this.surf]) if (l && map.getLayer(l.id)) map.removeLayer(l.id);
        for (const id of this.o.hide) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
      }
    } catch {
      /* map already removed (pane closed / rebuilt) */
    }
    this.vol = this.surf = null;
    this.overlay?.remove();
    this.tip?.remove();
    this.overlay = this.tip = null;
    this.manual = false;
    this.aimPending = false;
    this.shown.value = null;
    this.cache.clear();
    this.failed.clear();
    this.error.value = null;
    const s = this.saved;
    this.saved = null;
    if (!alive) return;
    try {
      map.boxZoom.enable();
      let tilt: boolean, maxP: number;
      if (this.o.main) {
        // terrain tilt may have been toggled while 3D was on: its current state decides the 2D limits
        const t = settings.peek().wf6.terrain;
        tilt = t.on && t.tilt;
        maxP = tilt ? 70 : 0;
      } else {
        tilt = (s?.maxPitch ?? 0) > 0;
        maxP = s?.maxPitch ?? 0;
      }
      this.leaving = s;
      map.easeTo({ pitch: tilt ? s?.pitch ?? 0 : 0, bearing: tilt ? s?.bearing ?? 0 : 0, duration: 600, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      // 0.8.4: an interrupted ease (a wheel or drag during it) ends early too; before this it left
      // the map part-way rotated with rotation already switched off
      const done = () => {
        if (token !== this.token || this.active.peek()) return;
        this.leaving = null;
        if (!tilt) flatten2D(map);
        map.setMaxPitch(maxP);
        if (!tilt && !(s?.rotate && !this.o.main)) {
          map.dragRotate.disable();
          map.touchZoomRotate.disableRotation();
        }
      };
      if (map.isMoving()) map.once("moveend", done);
      else done(); // no animation (reduced motion): moveend has already fired
    } catch {
      /* removed meanwhile */
    }
  }

  /** Current iso shells / threshold. */
  styleNow() {
    const v3 = settings.value.view3d;
    const x = v3x.value;
    const w = this.o.want.value;
    const thr = v3.thr[w.thrKey] ?? DEFAULT_THR[w.thrKey] ?? w.table.min;
    return { w, thr, shells: shellsFor(w.thrKey), x, v3 };
  }

  /** the volume on screen if it belongs to what is wanted (never a REF volume with the VEL table) */
  volumeNow(w: Want): Volume | null {
    const v = this.shown.value;
    if (!v || w.surfOnly) return null;
    if (this.manual) return v;
    return w.moment && v.hdr.moment && v.hdr.moment !== w.moment ? null : v;
  }

  private sync() {
    const vol = this.vol, surf = this.surf;
    if (!vol || !surf) return;
    const { w, thr, shells, x, v3 } = this.styleNow();
    const v = this.volumeNow(w);
    vol.setStyle(w.table, {
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
    vol.setVolume(v);
    // the height surface: on its own, or the 2D frame while its volume loads (something shows at once)
    const useSurf = w.surf && (w.surfOnly || !v);
    let field: Field | null = null;
    if (useSurf) {
      try {
        field = fieldFor(w.surf!, v3.res, w.abs);
      } catch (e) {
        console.error("3D surface:", e);
      }
    }
    surf.set(field, w.table, heightMapFor(w.table, w.abs), { exag: v3.exag, shade: v3.shade, opacity: w.surfOnly ? 1 : 0.85 });
  }

  /** Frame the storms: centre on the echo mass, pitch ~62°, and look toward the radar so it sits behind them. */
  aimAt(v: Volume, duration = 1000) {
    const map = this.active.peek();
    if (!map || !this.vol) return;
    this.aimPending = false;
    const { w, thr, shells } = this.styleNow();
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

  resetView() {
    const map = this.active.peek();
    if (!map) return;
    const v = this.volumeNow(this.o.want.peek());
    if (v) return this.aimAt(v, 800);
    const sw = this.o.want.peek().surf?.sweep;
    map.easeTo({ center: sw ? [sw.lon, sw.lat] : undefined, pitch: 60, bearing: 0, duration: 800 });
  }
}

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

// ---------- the main map ----------
let mainMode: Mode3D;
const mainBox = signal("");
const mainWant = computed<Want>(() => {
  const s = settings.value;
  const box = mainBox.value;
  if (s.weather.kind === "radar") {
    const f = currentFrame.value;
    const fs = frames.value;
    const i = f ? fs.indexOf(f) : -1;
    const next = i >= 0 && fs.length > 1 ? fs[(i + 1) % fs.length] : undefined;
    const lt = liveTilts.value;
    return buildWant({ kind: "radar", source: s.radar.source, product: s.radar.product, table: activeTable.value, frameKey: f?.key, nextKey: next?.key, sweep: f?.sweep, time: f?.time, box, liveV: f?.key && lt.key === f.key ? lt.n : 0 });
  }
  if (s.weather.kind === "grid") {
    const gf = gridFrames.value;
    const time = gf[Math.min(frameIndex.value, gf.length - 1)]?.time;
    return buildWant({ kind: "grid", gridId: s.weather.id, raster: gridRaster.value, table: gridTableActive.value, time, box });
  }
  return buildWant({ kind: "other" });
});
mainMode = new Mode3D({ name: "main", want: mainWant, isOn: () => settings.value.view3d.on, getMap: () => mapRef.value, hide: ["radar", "grid"], main: true, box: mainBox });

// leave 3D when the layer changes to one without 3D data (wait for the catalog on startup)
effect(() => {
  const on = settings.value.view3d.on;
  const sup = support3D.value;
  const w = settings.value.weather;
  if (!on || sup || mainMode.manual) return;
  if (w.kind === "grid" && !gridLayers.value.length) return;
  update((s) => (s.view3d.on = false));
});

// ---------- 0.8.3 3d (R40): panes ----------
const PKEY = "tbw.view3d.panes";
/* integration 0.8.3: only the main window keeps its panes' 3D (a pane window's pane 1 isn't the main window's pane 1) */
const PKEEP = !popoutSpec;
/** panes in 3D (by pane index) */
export const pane3d = signal<Record<number, boolean>>((() => {
  try {
    const v = PKEEP ? JSON.parse(localStorage.getItem(PKEY) || "{}") : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
})());
export function togglePane3D(idx: number) {
  const n = { ...pane3d.value, [idx]: !pane3d.value[idx] };
  if (!n[idx]) delete n[idx];
  pane3d.value = n;
  try {
    if (PKEEP) localStorage.setItem(PKEY, JSON.stringify(n));
  } catch {
    /* ignore */
  }
}
const paneModes = new Map<number, Mode3D>();
function paneMode(idx: number): Mode3D {
  let m = paneModes.get(idx);
  if (m) return m;
  const pbox = signal("");
  const want = computed<Want>(() => {
    void paneRev.value;
    const box = pbox.value;
    const info = pane3dInfo(idx);
    const cfg = info?.cfg;
    if (!info || !cfg) return buildWant({ kind: "other" });
    if (cfg.weather.kind === "radar") {
      const source = cfg.source ?? "L2";
      const product = source === "L3" ? cfg.product ?? "N0B" : cfg.product ?? "REF";
      const tk = tableKeyFor(product);
      const table = tableById(settings.value.tables[tk] ?? tk);
      return buildWant({ kind: "radar", source, product, table, frameKey: info.key || undefined, nextKey: info.next, sweep: info.cur?.sweep, time: info.time, box });
    }
    if (cfg.weather.kind === "grid") return buildWant({ kind: "grid", gridId: cfg.weather.id, raster: info.cur?.raster ?? null, table: (info.cur?.table as ColorTable | null) ?? null, time: info.time, box });
    return buildWant({ kind: "other" });
  });
  m = new Mode3D({
    name: `pane${idx}`,
    want,
    isOn: () => !!pane3d.value[idx] && paneSupports(pane3dInfo(idx)?.cfg),
    getMap: () => (void paneRev.value, pane3dInfo(idx)?.map ?? null),
    hide: ["pane-radar", "pane-grid"],
    box: pbox,
    main: false,
  });
  paneModes.set(idx, m);
  return m;
}
// started after the module graph has loaded (map/panes may still be initialising during an import cycle)
setTimeout(() => effect(() => {
  const on = pane3d.value;
  untracked(() => {
    for (const k of Object.keys(on)) if (on[+k]) paneMode(+k);
    for (const [k, m] of paneModes)
      if (!on[k]) {
        m.dispose();
        paneModes.delete(k);
      }
  });
}), 0);

/** 3D toggle for a pane's header */
export function Pane3DBtn({ idx }: { idx: number }) {
  void paneRev.value;
  const on = !!pane3d.value[idx];
  const cfg = pane3dInfo(idx)?.cfg ?? settings.value.panes.list[idx - 1];
  if (!on && !paneSupports(cfg)) return null;
  const m = on ? paneModes.get(idx) : undefined;
  const err = m?.error.value;
  const busy = m?.loading.value;
  return (
    <button
      class={`lk8 p3d ${on ? "on" : ""} ${err ? "err" : ""}`}
      title={err ? `3D: ${err} (click to leave 3D)` : on ? "Leave 3D in this pane · right-drag or Shift+drag to tilt" : "3D view in this pane"}
      aria-label={`3D view in pane ${idx + 1}`}
      aria-pressed={on}
      onClick={() => togglePane3D(idx)}
    >
      {busy ? <Loader2 size={11} class="spin" /> : "3D"}
    </button>
  );
}

// console / test handle: __tbw3d.load(url) shows any volume URL (absolute or server path)
(window as any).__tbw3d = {
  async load(url: string) {
    const buf = await (await fetch(url.startsWith("/") ? api.base + url : url)).arrayBuffer();
    const v = parseVolume(buf);
    mainMode.manual = true;
    mainMode.shown.value = v;
    return v.hdr;
  },
  aim() {
    if (mainMode.shown.value) mainMode.aimAt(mainMode.shown.value, 0);
  },
  setX,
  get layer() {
    return mainMode.vol;
  },
  get surface() {
    return mainMode.surf;
  },
  mode: mainMode,
  pane: (idx: number) => paneModes.get(idx),
};

// ---------- p7: laptop / touchpad navigation (main map) ----------
// Without a right button, MapLibre's tilt/rotate (right-drag, Ctrl+drag) is hard to reach, so 3D adds:
// Shift/Alt+left-drag (or plain drag in Orbit mode) to orbit, Alt+two-finger scroll to orbit (any 3D
// map, attachNav), Shift+arrows / W A S D to tilt and rotate, PageUp/PageDown or +/- to zoom, an
// on-screen pad, and a slow auto-rotate (main map only).
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

const mainMap = () => mainMode.active.peek();
/** a small step; animated unless repeated quickly */
export function nav3d(dPitch: number, dBearing: number, dZoom: number, duration = 160) {
  const map = mainMap();
  if (!map) return;
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

const onKey = (e: KeyboardEvent) => {
  if (!mainMap()) return;
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
function mainNavOn() {
  window.addEventListener("keydown", onKey, true);
}
function mainNavOff() {
  window.removeEventListener("keydown", onKey, true);
}
let spinRaf = 0;
let spinT = 0;
function spinLoop(t: number) {
  spinRaf = 0;
  const map = mainMap();
  if (!map || !v3x.peek().spin) return;
  const dt = spinT ? Math.min(0.1, (t - spinT) / 1000) : 0;
  spinT = t;
  // pause while the user is moving the view
  if (performance.now() - lastInput > 2500 && !map.isMoving()) map.setBearing(map.getBearing() + dt * 5);
  spinRaf = requestAnimationFrame(spinLoop);
}
effect(() => {
  const on = !!v3x.value.spin && !!mainMode.active.value;
  if (on && !spinRaf) {
    spinT = 0;
    spinRaf = requestAnimationFrame(spinLoop);
  } else if (!on && spinRaf) {
    cancelAnimationFrame(spinRaf);
    spinRaf = 0;
  }
});

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
        const map = mainMap();
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
    const map = mainMap();
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
  const map = mainMode.active.value;
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
          <button class="v3n-btn" title="Reset: aim at the storms" onClick={() => mainMode.resetView()}>
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
    <button class={`hdr-3d ${on ? "on" : ""}`} title={on ? "Leave 3D view (Shift+3)" : "3D view (Shift+3)"} onClick={toggle3D}>
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
  const l = mainMode.vol;
  const c = l?.table ? l.colorOf(s.value + (table.max - table.min) * 0.01) : [0.5, 0.5, 0.5];
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

/** 0.8.3 3d (R43): what the loader is doing */
function LoadState({ m }: { m: Mode3D }) {
  const p = m.progress.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!p) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [!!p]);
  if (!p) return null;
  const s = Math.round((performance.now() - p.t0) / 1000);
  const mb = p.got / 1048576;
  return (
    <div class="v3d-note v3d-load">
      <Loader2 size={12} class="spin" /> {p.bytes ? `Loading 3D data · ${mb >= 0.1 ? `${mb.toFixed(1)} MB` : "starting"}` : "Server is building the volume"}
      {s >= 2 ? ` · ${s} s` : ""}
    </div>
  );
}

export function View3D() {
  const v3 = settings.value.view3d;
  if (!v3.on) return null;
  const m = mainMode;
  const x = v3x.value;
  const w = mainWant.value;
  const t = w.table;
  const thr = v3.thr[w.thrKey] ?? DEFAULT_THR[w.thrKey] ?? t.min;
  const lo = w.abs ? 0 : t.min;
  const span = t.max - lo;
  const step = span > 20 ? 1 : span > 4 ? 0.1 : 0.01;
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const set = (fn: (x: typeof v3) => void) => update((s) => fn(s.view3d));
  const vol = m.volumeNow(w);
  const h = vol?.hdr;
  const gpuErr = m.vol?.error || m.surf?.error;
  const shells = shellsFor(w.thrKey);
  const sup = support3D.value;
  const surfOnly = w.surfOnly;
  const err = m.error.value;
  return (
    <>
    <Nav3D /> {/* p7 */}
    <div class="v3d glass">
      <div class="v3d-head">
        <b>3D</b>
        <span class="muted small v3d-meta">{h ? `${h.site ?? "MRMS"} ${h.moment ?? ""} ${h.nx}×${h.ny}×${h.nz}` : surfOnly ? (w.abs ? "Height = |value|" : "Height = value") : ""}</span>
        {m.loading.value && <Loader2 size={14} class="spin" />}
        <button class="icon-btn" title="Aim at the storms" onClick={() => m.resetView()}>
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
      {w.styleKey && !(sup === "radar" && v3.src === "mrms") && (
        <div class="v3d-seg">
          <button class={!surfOnly ? "on" : ""} onClick={() => setX((y) => (y.height = { ...(y.height ?? {}), [w.styleKey!]: false }))} title="Full 3D volume from all tilts">
            Volume
          </button>
          <button class={surfOnly ? "on" : ""} onClick={() => setX((y) => (y.height = { ...(y.height ?? {}), [w.styleKey!]: true }))} title={w.abs ? "The 2D product raised by |value|" : "The 2D product raised by value"}>
            Height
          </button>
        </div>
      )}
      {w.note && <div class="v3d-note">{w.note}</div>}
      <LoadState m={m} />
      {!vol && !surfOnly && w.surf && m.loading.value && <div class="v3d-note muted small">Showing the 2D frame as height until the volume arrives</div>}
      {(err || gpuErr) && (
        <div class="v3d-note err">
          {gpuErr || err}
          {err && !gpuErr && (
            <button class="link" onClick={() => m.retry()}>
              Retry
            </button>
          )}
        </div>
      )}
      {!surfOnly && (
        <div class="v3d-seg">
          <button class={x.mode === "iso" ? "on" : ""} onClick={() => setX((y) => (y.mode = "iso"))} title="Solid shells at chosen values: cores and tops stand out">
            Surfaces
          </button>
          <button class={x.mode === "volume" ? "on" : ""} onClick={() => setX((y) => (y.mode = "volume"))} title="Semi-transparent cloud">
            Cloud
          </button>
        </div>
      )}
      {surfOnly ? null : x.mode === "iso" ? (
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
        <div class="v3d-seg small">
          <button class={v3.res === "lo" ? "on" : ""} onClick={() => set((x) => (x.res = "lo"))} title="Coarser grid, faster">
            Lo
          </button>
          <button class={v3.res === "hi" ? "on" : ""} onClick={() => set((x) => (x.res = "hi"))} title="Finer grid, bigger download">
            Hi
          </button>
        </div>
        {!surfOnly && (
          <>
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
          </>
        )}
      </div>
      <div class="v3d-row">
        <label title="Show the 2D layer under the 3D data">
          <input type="checkbox" checked={v3.floor} onChange={() => set((x) => (x.floor = !x.floor))} /> Floor
        </label>
        {!surfOnly && (
          <label title="Smooth the field (less blocky surfaces)">
            <input type="checkbox" checked={v3.smooth} onChange={() => set((x) => (x.smooth = !x.smooth))} /> Smooth
          </label>
        )}
        <label title="Surface lighting">
          <input type="checkbox" checked={v3.shade} onChange={() => set((x) => (x.shade = !x.shade))} /> Light
        </label>
      </div>
    </div>
    </>
  );
}
