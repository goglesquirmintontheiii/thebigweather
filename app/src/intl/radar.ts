// International raster radar (JMA, MSC GeoMet, DWD, PAGASA, SMN): tiles, WMS or georeferenced
// images through the server's /api/intlradar proxy. One MapLibre source per frame (per radar for
// the "All Mexico / All Canada radars" groups), animation flips opacities like the GIBS imagery
// layer. Sources are added lazily, when their frame is first shown or warmed up.

import { signal, effect } from "@preact/signals";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";
import { api } from "../api";
import { settings, update } from "../store";
import { frameIndex, frameCount, playing, setFrameReady, framesToRequest, trimToSpan, histRange } from "../anim";
import { thinEven } from "../timematch";

export interface IntlFrame {
  t: number;
  url: string;
}
export interface IntlSource {
  id: string;
  name: string;
  region: string;
  kind: "tiles" | "image" | "wms";
  attribution: string;
  license_note?: string;
  minzoom?: number;
  maxzoom?: number;
  bounds?: [number, number, number, number];
  step_min: number;
  frames: IntlFrame[];
  evenZoomsOnly?: boolean;
  tileSize?: number;
  crs?: string;
  /** per-radar sources: the "All … radars" group they belong to */
  group?: string;
  country?: string;
  site?: IntlSite;
  /** snow-rate frames (same times/bounds as `frames`, which are rain) */
  frames_snow?: IntlFrame[];
}
export interface IntlSite {
  id: string;
  name: string;
  province?: string;
  lat: number;
  lon: number;
  range_km?: number;
}
export type Precip = "rain" | "snow";

/** "All Mexico radars" pseudo source */
export const SMN_ALL = "smn_all";
/** "All Canada radars" pseudo source */
export const ECCC_ALL = "eccc_all";
/** most frames loaded per source (each frame is its own set of tiles / images) */
const MAX_FRAMES = 12;
const MAX_FRAMES_ALL = 8;
/** images an "All … radars" animation may hold (radars × frames): 33 Canadian radars → 4 frames */
const ALL_IMAGE_BUDGET = 140;
const MIN_FRAMES_ALL = 3;

// ---------- radar groups ("All Mexico radars", "All Canada radars") ----------

const GROUP_NAMES: Record<string, string> = { smn_all: "All Mexico radars", eccc_all: "All Canada radars" };
/** "smn_cun" → "smn" */
export const idPrefix = (id: string) => (id.includes("_") ? id.slice(0, id.indexOf("_")) : id);
/** Group name of a per-radar source (Mexico predates the server's `group` field). */
export function groupOf(s: IntlSource): string | undefined {
  return s.group ?? (s.id.startsWith("smn_") ? GROUP_NAMES.smn_all : undefined);
}
/** pseudo id of the source's group ("eccc_all") */
export const allIdOf = (s: IntlSource) => `${idPrefix(s.id)}_all`;
export function isGroupAll(id: string): boolean {
  return id.endsWith("_all") && (id in GROUP_NAMES || intlSources.value.some((s) => groupOf(s) && allIdOf(s) === id));
}
export function groupMembers(allId: string): IntlSource[] {
  return intlSources.value.filter((s) => groupOf(s) && allIdOf(s) === allId);
}
export function groupName(allId: string): string {
  const m = groupMembers(allId)[0];
  return (m && groupOf(m)) ?? GROUP_NAMES[allId] ?? allId;
}
/** sources that belong to `id` (itself, or every radar of a group) */
function membersOf(id: string): IntlSource[] {
  if (isGroupAll(id)) return groupMembers(id);
  const s = intlSource(id);
  return s ? [s] : [];
}
function unionBounds(list: IntlSource[]): [number, number, number, number] | undefined {
  const b = list.map((s) => s.bounds).filter(Boolean) as [number, number, number, number][];
  if (!b.length) return undefined;
  return [Math.min(...b.map((x) => x[0])), Math.min(...b.map((x) => x[1])), Math.max(...b.map((x) => x[2])), Math.max(...b.map((x) => x[3]))];
}
/** key of `intlErrors` for a source id (per-radar sources report under their base id) */
export function errKey(id: string): string {
  const p = idPrefix(id);
  return p === "smn" || p === "eccc" ? p : id;
}
/** precipitation type of the active selection */
export function curPrecip(): Precip {
  const w = settings.value.weather;
  return w.kind === "intl" && w.precip === "snow" ? "snow" : "rain";
}
/** whether a source (or any radar of a group) has separate snow frames */
export function hasSnow(id: string): boolean {
  return membersOf(id).some((s) => !!s.frames_snow);
}
function framesOf(s: IntlSource, p: Precip): IntlFrame[] {
  return p === "snow" && s.frames_snow ? s.frames_snow : s.frames;
}

export const intlSources = signal<IntlSource[]>([]);
/** base source id (jma, smn, geomet_rain…) → error from the server */
export const intlErrors = signal<Record<string, string>>({});
export const intlListLoading = signal(false);
/** frame times of the active intl layer */
export const intlTimes = signal<number[]>([]);
export const intlReady = signal<Set<number>>(new Set());
export const intlBad = signal<Set<number>>(new Set());
export const intlError = signal<string | null>(null);

/** Regions shown in the layer picker, in order. */
export const INTL_REGIONS = ["Canada", "Mexico", "Europe", "Asia", "Japan"] as const;

/** Region of a raster source or international grid layer id. */
export function intlRegion(id: string, fallback = ""): string {
  if (id === "jma") return "Japan";
  if (id.startsWith("geomet")) return "Canada";
  if (id === "dwd" || id.startsWith("opera")) return "Europe";
  if (id === "pagasa" || id.startsWith("cwa")) return "Asia";
  if (id.startsWith("smn")) return "Mexico";
  if (id.startsWith("eccc")) return "Canada";
  return fallback;
}

/** Map extents used to fly there when a far-away international layer is picked. */
const GRID_BOUNDS: Record<string, [number, number, number, number]> = {
  opera_dbzh: [-11, 35, 33, 69],
  opera_rate: [-11, 35, 33, 69],
  cwa_ref: [118.5, 21, 123.5, 26.5],
};
export const MEXICO_BOUNDS: [number, number, number, number] = [-117, 14.5, -86.5, 32.7];

/** Display names for sources that failed (they are missing from `sources`). */
export const INTL_NAMES: Record<string, string> = {
  jma: "Japan radar (JMA nowcast)",
  geomet_rain: "Canada radar · rain",
  geomet_snow: "Canada radar · snow",
  dwd: "Germany radar (DWD)",
  pagasa: "Philippines radar (PAGASA)",
  smn: "Mexico radars (SMN)",
  eccc: "Canada radars (ECCC)",
};

export function intlSource(id: string): IntlSource | undefined {
  return intlSources.value.find((s) => s.id === id);
}

export function intlName(id: string): string {
  const grp = INTL_NAMES[idPrefix(id)];
  // single sites of a group before the list has loaded: "Canada radar CASKR"
  const fallback = grp && id.includes("_") ? `${grp.replace(/s? \(.*$/, "")} ${id.slice(id.indexOf("_") + 1).toUpperCase()}` : id;
  const base = isGroupAll(id) ? groupName(id) : intlSource(id)?.name ?? INTL_NAMES[id] ?? fallback;
  const w = settings.value.weather;
  return w.kind === "intl" && w.id === id && w.precip === "snow" && hasSnow(id) ? `${base} · snow` : base;
}

/** Simple static legends (colors are the provider's, approximate where not published). */
export interface IntlLegend {
  title: string;
  units: string;
  stops: [string, string][];
}
const RAIN_GENERIC: [string, string][] = [
  ["#9be1ff", "light"],
  ["#2f8cff", ""],
  ["#19c43c", ""],
  ["#f6e60a", ""],
  ["#ff8a00", ""],
  ["#e8191a", ""],
  ["#b4006a", "heavy"],
];
export function intlLegend(id: string, precip: Precip = "rain"): IntlLegend {
  if (idPrefix(id) === "eccc") return precip === "snow" ? { title: "Snow rate", units: "cm/h", stops: RAIN_GENERIC } : { title: "Rain rate", units: "mm/h", stops: RAIN_GENERIC };
  if (id === "jma")
    return {
      title: "Precip intensity",
      units: "mm/h",
      stops: [
        ["#f2f2ff", "<1"],
        ["#a0d2ff", "1"],
        ["#218cff", "5"],
        ["#0041ff", "10"],
        ["#faf500", "20"],
        ["#ff9900", "30"],
        ["#ff2800", "50"],
        ["#b40068", "80+"],
      ],
    };
  if (id === "geomet_snow") return { title: "Snow rate", units: "cm/h", stops: RAIN_GENERIC };
  if (id.startsWith("geomet")) return { title: "Rain rate", units: "mm/h", stops: RAIN_GENERIC };
  if (id === "dwd") return { title: "Precip (radar)", units: "dBZ", stops: RAIN_GENERIC };
  return { title: "Reflectivity", units: "dBZ", stops: RAIN_GENERIC };
}

// ---------- server list ----------

let listAt = 0;
let listP: Promise<void> | null = null;
/** Fetch /api/intlradar (at most once a minute unless forced). */
export function loadIntlList(force = false): Promise<void> {
  if (!api.base) return Promise.resolve();
  if (listP) return listP;
  if (!force && Date.now() - listAt < 60_000 && intlSources.value.length) return Promise.resolve();
  intlListLoading.value = true;
  listP = api
    .get<{ sources: IntlSource[]; errors?: Record<string, string> }>("/api/intlradar")
    .then((r) => {
      listAt = Date.now();
      for (const s of r.sources ?? []) {
        s.frames = (s.frames ?? []).slice().sort((a, b) => a.t - b.t);
        if (s.frames_snow) s.frames_snow = s.frames_snow.slice().sort((a, b) => a.t - b.t);
      }
      intlSources.value = r.sources ?? [];
      intlErrors.value = r.errors ?? {};
    })
    .catch((e) => {
      intlErrors.value = { ...intlErrors.value, _all: e.message };
    })
    .finally(() => {
      listP = null;
      intlListLoading.value = false;
    });
  return listP;
}

// ---------- URLs ----------

/** Server-relative proxy URL → absolute with token; placeholders made literal for MapLibre. */
export function intlUrl(u: string): string {
  let out = u.startsWith("/") ? api.base + u : u;
  out = out.replace(/%7B(z|x|y|bbox-epsg-3857)%7D/gi, "{$1}");
  if (api.token && out.startsWith(api.base)) out += `${out.includes("?") ? "&" : "?"}token=${encodeURIComponent(api.token)}`;
  return out;
}

// JMA only publishes even zoom levels: odd zooms are served by cropping the parent tile.
const evenTemplates = new Map<string, string>();
let evenProto = false;
let evenSeq = 0;
function evenUrl(template: string): string {
  if (!evenProto) {
    evenProto = true;
    maplibregl.addProtocol("tbweven", async (params, ac) => {
      const m = params.url.match(/^tbweven:\/\/t\/([a-z0-9]+)\/(\d+)\/(\d+)\/(\d+)/);
      const tpl = m && evenTemplates.get(m[1]);
      if (!m || !tpl) throw new Error("bad tile");
      const z = +m[2], x = +m[3], y = +m[4];
      const odd = z % 2 === 1;
      const pz = odd ? z - 1 : z, px = odd ? x >> 1 : x, py = odd ? y >> 1 : y;
      const r = await fetch(tpl.replace("{z}", String(pz)).replace("{x}", String(px)).replace("{y}", String(py)), { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (!odd) return { data: await blob.arrayBuffer() };
      const bmp = await createImageBitmap(blob);
      const h = bmp.width / 2;
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      g.drawImage(bmp, (x & 1) * h, (y & 1) * h, h, h, 0, 0, bmp.width, bmp.height);
      bmp.close();
      return { data: await (await c.convertToBlob({ type: "image/png" })).arrayBuffer() };
    });
  }
  for (const [k, v] of evenTemplates) if (v === template) return `tbweven://t/${k}/{z}/{x}/{y}`;
  const key = `k${++evenSeq}`;
  evenTemplates.set(key, template);
  if (evenTemplates.size > 400) evenTemplates.delete(evenTemplates.keys().next().value!);
  return `tbweven://t/${key}/{z}/{x}/{y}`;
}

// ---------- frames for the active selection ----------

interface Part {
  src: IntlSource;
  url: string;
}
interface Built {
  t: number;
  parts: Part[];
}

/** radars of a group worth loading for the current view (all of them before the map exists) */
function groupInView(list: IntlSource[]): IntlSource[] {
  const m = map;
  if (!m || m.isMoving()) return list;
  const v = m.getBounds();
  const padX = (v.getEast() - v.getWest()) * 0.25;
  const padY = (v.getNorth() - v.getSouth()) * 0.25;
  const w = v.getWest() - padX, e = v.getEast() + padX, so = v.getSouth() - padY, n = v.getNorth() + padY;
  const inv = list.filter((s) => !s.bounds || !(s.bounds[0] > e || s.bounds[2] < w || s.bounds[1] > n || s.bounds[3] < so));
  // nothing nearby (the view is elsewhere): keep them all, the view flies there
  return inv.length ? inv : list;
}

function framesFor(id: string): Built[] {
  const g = settings.value.grid;
  const h = histRange.value;
  const p = curPrecip();
  if (isGroupAll(id)) {
    const list = groupInView(groupMembers(id).filter((s) => framesOf(s, p).length && s.bounds));
    if (!list.length) return [];
    const newest = Math.max(...list.map((s) => framesOf(s, p)[framesOf(s, p).length - 1].t));
    // a common time grid: SMN radars scan every 5–10 min at their own times, GeoMet crops share the mosaic's 6 min
    const stepMin = idPrefix(id) === "smn" ? 10 : Math.max(5, ...list.map((s) => s.step_min || 10));
    const stepMs = stepMin * 60_000;
    const tol = Math.min(8 * 60_000, stepMs * 0.8);
    const end = h ? Math.min(h.end, newest) : newest;
    // many radars → fewer frames (every frame is one image per radar)
    const cap = Math.max(MIN_FRAMES_ALL, Math.min(MAX_FRAMES_ALL, Math.floor(ALL_IMAGE_BUDGET / list.length)));
    const n = Math.min(cap, framesToRequest(g.frames, stepMin, cap));
    const out: Built[] = [];
    for (let k = n - 1; k >= 0; k--) {
      const t = end - k * stepMs;
      if (h && t < h.start - 60_000) continue;
      const parts: Part[] = [];
      for (const s of list) {
        let best: IntlFrame | null = null;
        for (const f of framesOf(s, p)) if (Math.abs(f.t - t) <= tol && (!best || Math.abs(f.t - t) < Math.abs(best.t - t))) best = f;
        if (best) parts.push({ src: s, url: best.url });
      }
      if (parts.length) out.push({ t, parts });
    }
    return out;
  }
  const s = intlSource(id);
  if (!s) return [];
  let fr = framesOf(s, p).map((f) => ({ time: f.t, url: f.url }));
  if (h) fr = thinEven(fr.filter((f) => f.time >= h.start - 60_000 && f.time <= h.end + 60_000), MAX_FRAMES);
  else {
    fr = trimToSpan(fr);
    fr = fr.slice(-Math.min(MAX_FRAMES, framesToRequest(g.frames, s.step_min || 10, MAX_FRAMES)));
  }
  return fr.map((f) => ({ t: f.time, parts: [{ src: s, url: f.url }] }));
}

// ---------- map layers ----------

let map: MLMap | null = null;
let before: () => string | undefined = () => undefined;
let built: Built[] = [];
let held = -1;
/** frames whose layers have been drawn (or warmed) since the last view change */
const touched = new Set<number>();
/** frames that received tiles since the last view change (an untouched raster source reports
 * "loaded" before it has asked for anything) */
const gotTiles = new Set<number>();

const sid = (i: number, j: number) => `intl-${i}-${j}`;
const lid = (i: number, j: number) => `wx-intl-${i}-${j}`;

function clear(m: MLMap) {
  const style = m.getStyle();
  if (!style) return;
  for (const l of style.layers) if (l.id.startsWith("wx-intl-")) m.removeLayer(l.id);
  for (const id of Object.keys(style.sources)) if (id.startsWith("intl-")) m.removeSource(id);
}

/** frames whose sources and layers exist (added on first use: a 33-radar group would otherwise
 * request every image of every frame at once) */
const created = new Set<number>();
/** image sources of a group frame that failed to load (the frame shows without them) */
const failedParts = new Set<string>();
function ensureFrame(i: number) {
  const m = map;
  const f = built[i];
  if (!m || !f || created.has(i)) return;
  created.add(i);
  f.parts.forEach((p, j) => {
    const s = p.src;
    const url = intlUrl(p.url);
    try {
      if (s.kind === "image") {
        const [w0, s0, e0, n0] = s.bounds ?? [-180, -85, 180, 85];
        m.addSource(sid(i, j), { type: "image", url, coordinates: [[w0, n0], [e0, n0], [e0, s0], [w0, s0]] } as any);
        // image sources take no attribution option, but the control reads the property
        const src: any = m.getSource(sid(i, j));
        if (src) src.attribution = attributionFor(s);
      } else {
        m.addSource(sid(i, j), {
          type: "raster",
          tiles: [s.evenZoomsOnly ? evenUrl(url) : url],
          tileSize: s.tileSize ?? 256,
          minzoom: s.minzoom ?? 0,
          maxzoom: s.evenZoomsOnly ? Math.floor((s.maxzoom ?? 10) / 2) * 2 : s.maxzoom ?? 12,
          bounds: s.bounds,
          attribution: attributionFor(s),
        } as any);
      }
      m.addLayer({ id: lid(i, j), type: "raster", source: sid(i, j), layout: { visibility: "none" }, paint: { "raster-opacity": 0, "raster-fade-duration": 0 } }, before());
    } catch (e) {
      const b = new Set(intlBad.value);
      b.add(i);
      intlBad.value = b;
      console.warn("intl radar layer", e);
    }
  });
}

function attributionFor(s: IntlSource) {
  return s.license_note ? `${s.attribution} · ${s.license_note}` : s.attribution;
}

let buildSig = "";
function build() {
  const m = map;
  if (!m || !m.getStyle()) return;
  clear(m);
  created.clear();
  failedParts.clear();
  held = -1;
  touched.clear();
  gotTiles.clear();
  const w = settings.value.weather;
  if (w.kind !== "intl") {
    built = [];
    intlTimes.value = [];
    intlReady.value = new Set();
    return;
  }
  built = framesFor(w.id);
  intlError.value = built.length ? null : intlErrors.value[errKey(w.id)] ?? (intlSources.value.length || !listP ? (histRange.peek() ? "This source has no archive for that window (recent frames only)" : "No frames available for this source right now") : null);
  const bad = new Set<number>();
  intlBad.value = bad;
  intlReady.value = new Set();
  intlTimes.value = built.map((f) => f.t);
  frameCount.value = built.length;
  setFrameReady((i) => intlReady.value.has(i));
  frameIndex.value = Math.max(0, built.length - 1);
  shownSig = "";
  show();
}

function inView(b?: [number, number, number, number]) {
  if (!map || !b) return true;
  const v = map.getBounds();
  return !(v.getWest() > b[2] || v.getEast() < b[0] || v.getSouth() > b[3] || v.getNorth() < b[1]);
}

function loadedFrame(i: number): boolean {
  const m = map;
  if (!m || !built[i]) return false;
  if (!gotTiles.has(i) && built[i].parts.some((p) => p.src.kind !== "image" && inView(p.src.bounds) && m.getZoom() >= (p.src.minzoom ?? 0) - 1)) return false;
  try {
    return built[i].parts.every((_, j) => failedParts.has(sid(i, j)) || (!!m.getSource(sid(i, j)) && m.isSourceLoaded(sid(i, j))));
  } catch {
    return false;
  }
}

let shownSig = "";
function show() {
  const m = map;
  const n = built.length;
  if (!m || !n) return;
  const op = settings.value.grid.opacity;
  const cur = Math.min(frameIndex.value, n - 1);
  const ready = intlReady.value;
  const loaded = ready.has(cur) || loadedFrame(cur);
  // once the frame on screen is in, warm up to 3 frames that aren't (nearest ahead first)
  const warm = new Set<number>();
  for (let k = 1; loaded && k < n && warm.size < 3; k++) {
    const i = (cur + k) % n;
    if (!ready.has(i) && !intlBad.value.has(i)) warm.add(i);
  }
  const hold = !loaded && held >= 0 && held !== cur && held < n ? held : -1;
  const sig = `${cur}|${hold}|${op}|${[...warm].join(",")}`;
  if (sig === shownSig) return;
  shownSig = sig;
  for (let i = 0; i < n; i++) {
    // hidden layers request nothing (opacity 0 still loads tiles): only the frame on screen, the
    // one held under it, the frames warming up and the ones already loaded stay "visible"
    const on = i === cur || i === hold;
    const vis = on || warm.has(i) || ready.has(i);
    if (vis) touched.add(i), ensureFrame(i);
    for (let j = 0; j < built[i].parts.length; j++) {
      if (!m.getLayer(lid(i, j))) continue;
      m.setLayoutProperty(lid(i, j), "visibility", vis ? "visible" : "none");
      m.setPaintProperty(lid(i, j), "raster-opacity", on ? op : 0);
    }
  }
  if (loaded) held = cur;
}

let readyTimer: number | undefined;
function scheduleReady() {
  clearTimeout(readyTimer);
  readyTimer = window.setTimeout(() => {
    if (!built.length) return;
    const s = new Set<number>();
    for (let i = 0; i < built.length; i++) if (touched.has(i) && loadedFrame(i)) s.add(i);
    const old = intlReady.value;
    if (s.size !== old.size || [...s].some((i) => !old.has(i))) intlReady.value = s;
    shownSig = "";
    show();
  }, 120);
}

/** set once the map is attached (markers wait for it) */
const mapReady = signal(false);

export function attachIntl(m: MLMap, beforeFn: () => string | undefined) {
  map = m;
  mapReady.value = true;
  before = beforeFn;
  m.on("sourcedata", (e: any) => {
    if (typeof e.sourceId === "string" && e.sourceId.startsWith("intl-")) {
      if (e.tile) gotTiles.add(+e.sourceId.split("-")[1]);
      scheduleReady();
    }
  });
  m.on("idle", () => built.length && scheduleReady());
  m.on("error", (e: any) => {
    const id: string | undefined = e.sourceId;
    // a listener stops MapLibre's own console report: keep it for everything else
    if (!id?.startsWith("intl-")) return void console.error(e.error ?? e);
    const i = +id.split("-")[1];
    const f = built[i];
    // a group frame (one image per radar) survives a few missing radars
    if (f && f.parts.length > 1 && f.parts.every((p) => p.src.kind === "image")) {
      failedParts.add(id);
      const bad = f.parts.filter((_, j) => failedParts.has(sid(i, j))).length;
      if (bad <= f.parts.length / 2) return void scheduleReady();
    }
    // a missing image ruins its frame; a missing tile doesn't
    if (f && f.parts.some((p) => p.src.kind === "image")) {
      const b = new Set(intlBad.value);
      b.add(i);
      intlBad.value = b;
      if (i === frameIndex.value) intlError.value = "Image unavailable";
    } else if (f) {
      // a failed tile still counts as an answer (the frame shouldn't wait forever)
      gotTiles.add(i);
      scheduleReady();
    }
  });
  m.on("zoom", () => markerDensity());
  m.on("moveend", () => {
    // a radar group only loads the radars near the view
    const w = settings.value.weather;
    if (w.kind === "intl" && isGroupAll(w.id)) viewTick.value++;
    // tiles for the new view: frames count as unloaded until drawn again
    if (!built.length || built.every((f) => f.parts.every((p) => p.src.kind === "image"))) return;
    touched.clear();
    gotTiles.clear();
    touched.add(frameIndex.value);
    intlReady.value = new Set();
    shownSig = "";
    show();
  });
}

/** Call after every style load. */
export function rebuildIntl() {
  buildSig = "";
  build();
  buildSig = sigNow();
}

function sigNow() {
  const w = settings.value.weather;
  if (w.kind !== "intl") return "";
  const a = settings.value.anim;
  const h = histRange.value;
  const fr = framesFor(w.id);
  return `${w.id}|${w.precip ?? ""}|${fr.map((f) => f.t).join(",")}|${isGroupAll(w.id) ? fr[fr.length - 1]?.parts.map((p) => p.src.id).join(",") : ""}|${settings.value.grid.frames}|${a.mode}|${a.minutes}|${h ? `${h.start}-${h.end}` : ""}|${api.base}|${settings.value.saver}`;
}

/** bumped after the map moves while a radar group is shown */
const viewTick = signal(0);

effect(() => {
  void intlSources.value;
  void intlErrors.value;
  void viewTick.value;
  const p = playing.value;
  const sig = sigNow();
  if (sig === buildSig) return;
  const sameLayer = buildSig.split("|")[0] === sig.split("|")[0];
  if (sameLayer && p) return; // new frames are picked up when playback stops
  const wasLatest = frameIndex.value >= built.length - 1;
  buildSig = sig;
  if (!sameLayer) playing.value = false;
  const keep = sameLayer && !wasLatest ? frameIndex.value : -1;
  build();
  if (keep >= 0 && keep < built.length) frameIndex.value = keep;
});

effect(() => {
  void frameIndex.value;
  void settings.value.grid.opacity;
  void intlReady.value;
  if (settings.value.weather.kind === "intl") show();
});

effect(() => {
  if (settings.value.weather.kind === "intl" && api.base) loadIntlList();
});
api.on("connected", () => {
  if (settings.value.weather.kind === "intl") loadIntlList(true);
});

// new frames every few minutes
setInterval(() => {
  if (settings.value.weather.kind === "intl" && !playing.value && !histRange.value) loadIntlList(true);
}, 3 * 60_000);

/** Fly to an extent when the map is mostly elsewhere. */
export function flyIfFar(b: [number, number, number, number] | undefined) {
  const m = map;
  if (!m || !b) return;
  const c = m.getCenter();
  const [w, s, e, n] = b;
  const inside = c.lng >= w && c.lng <= e && c.lat >= s && c.lat <= n;
  if (!inside) m.fitBounds([[w, s], [e, n]], { padding: 40, duration: 1400, maxZoom: 7 });
}

/** Pick an international raster radar. Radar groups and single radars fit the view to their
 * coverage; other sources fly there only when the map is elsewhere. `precip` defaults to the
 * current choice. */
export function selectIntl(id: string, precip?: Precip) {
  const p = hasSnow(id) ? precip ?? curPrecip() : "rain";
  // move first: a group built while the map flies loads all its radars, then trims on arrival
  if (isGroupAll(id)) fitTo(id === SMN_ALL ? MEXICO_BOUNDS : unionBounds(groupMembers(id)), 5.5);
  else {
    const s = intlSource(id);
    if (s?.site) fitTo(s.bounds, 8);
    else flyIfFar(s?.bounds);
  }
  update((s) => (s.weather = { kind: "intl", id, ...(p === "snow" ? { precip: p } : {}) }));
}

function fitTo(b: [number, number, number, number] | undefined, maxZoom: number) {
  const m = map;
  if (!m || !b) return;
  m.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 1200, maxZoom });
}

/** Rain / snow frames for sources that have both (Canada). */
export function setIntlPrecip(p: Precip) {
  update((s) => {
    if (s.weather.kind !== "intl") return;
    const { precip: _old, ...rest } = s.weather;
    s.weather = p === "snow" ? { ...rest, precip: p } : rest;
  });
}

// ---------- radar positions (groups whose sources carry a `site`, e.g. Canada) ----------

const siteMarkers = new Map<string, maplibregl.Marker>();

function markerDensity() {
  const m = map;
  if (m) m.getContainer().classList.toggle("intl-dots", m.getZoom() < 4.6);
}

/** radars to mark for the current selection: the group's sites while one of its sources (or a
 * mosaic of the same region) is shown */
function markedSources(): IntlSource[] {
  const w = settings.value.weather;
  if (w.kind !== "intl" || !settings.value.overlays.sites) return [];
  const cur = intlSource(w.id);
  const all = isGroupAll(w.id) ? w.id : cur && groupOf(cur) ? allIdOf(cur) : null;
  if (all) return groupMembers(all).filter((s) => s.site);
  // a mosaic (GeoMet) of the same region: show where its radars are
  const reg = intlRegion(w.id, cur?.region);
  return intlSources.value.filter((s) => s.site && groupOf(s) && intlRegion(s.id, s.region) === reg);
}

function siteEl(s: IntlSource): HTMLElement {
  const el = document.createElement("button");
  const st = s.site!;
  el.className = `site-marker intl-site r-ca-eccc`;
  el.textContent = st.id;
  el.title = `${st.name}${st.province ? `, ${st.province}` : ""} (${st.id}) — click to show this radar`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectIntl(s.id);
  });
  return el;
}

effect(() => {
  const list = markedSources();
  const w = settings.value.weather;
  const m = mapReady.value ? map : null;
  if (!m) return;
  const ids = new Set(list.map((s) => s.id));
  for (const [id, mk] of siteMarkers) if (!ids.has(id)) (mk.remove(), siteMarkers.delete(id));
  for (const s of list) {
    let mk = siteMarkers.get(s.id);
    if (!mk) {
      mk = new maplibregl.Marker({ element: siteEl(s), anchor: "center" }).setLngLat([s.site!.lon, s.site!.lat]).addTo(m);
      siteMarkers.set(s.id, mk);
    }
    mk.getElement().classList.toggle("selected", w.kind === "intl" && w.id === s.id);
  }
  markerDensity();
});

/** Pick an international grid layer (OPERA, CWA) and fly there if needed. */
export function flyForGrid(id: string) {
  flyIfFar(GRID_BOUNDS[id]);
}

// screenshot / console handle
(window as any).__tbwIntl = { intlSources, intlErrors, loadIntlList, selectIntl };
