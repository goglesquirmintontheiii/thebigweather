// International raster radar (JMA, MSC GeoMet, DWD, PAGASA, SMN): tiles, WMS or georeferenced
// images through the server's /api/intlradar proxy. One MapLibre source per frame (per radar for
// "All Mexico"), animation flips opacities like the GIBS imagery layer.

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
}

/** "All Mexico radars" pseudo source */
export const SMN_ALL = "smn_all";
/** most frames loaded per source (each frame is its own set of tiles / images) */
const MAX_FRAMES = 12;
const MAX_FRAMES_ALL = 8;

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
};

export function intlSource(id: string): IntlSource | undefined {
  return intlSources.value.find((s) => s.id === id);
}

export function intlName(id: string): string {
  if (id === SMN_ALL) return "All Mexico radars";
  return intlSource(id)?.name ?? INTL_NAMES[id] ?? id;
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
export function intlLegend(id: string): IntlLegend {
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
      for (const s of r.sources ?? []) s.frames = (s.frames ?? []).slice().sort((a, b) => a.t - b.t);
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

function framesFor(id: string): Built[] {
  const g = settings.value.grid;
  const h = histRange.value;
  if (id === SMN_ALL) {
    const list = intlSources.value.filter((s) => s.id.startsWith("smn_") && s.frames.length && s.bounds);
    if (!list.length) return [];
    const newest = Math.max(...list.map((s) => s.frames[s.frames.length - 1].t));
    const stepMs = 10 * 60_000;
    const end = h ? Math.min(h.end, newest) : newest;
    const n = Math.min(MAX_FRAMES_ALL, framesToRequest(g.frames, 10, MAX_FRAMES_ALL));
    const out: Built[] = [];
    for (let k = n - 1; k >= 0; k--) {
      const t = end - k * stepMs;
      if (h && t < h.start - 60_000) continue;
      const parts: Part[] = [];
      for (const s of list) {
        let best: IntlFrame | null = null;
        for (const f of s.frames) if (Math.abs(f.t - t) <= 8 * 60_000 && (!best || Math.abs(f.t - t) < Math.abs(best.t - t))) best = f;
        if (best) parts.push({ src: s, url: best.url });
      }
      if (parts.length) out.push({ t, parts });
    }
    return out;
  }
  const s = intlSource(id);
  if (!s) return [];
  let fr = s.frames.map((f) => ({ time: f.t, url: f.url }));
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

function attributionFor(s: IntlSource) {
  return s.license_note ? `${s.attribution} · ${s.license_note}` : s.attribution;
}

let buildSig = "";
function build() {
  const m = map;
  if (!m || !m.getStyle()) return;
  clear(m);
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
  const bad = new Set<number>();
  intlError.value = built.length ? null : intlErrors.value[w.id.startsWith("smn") ? "smn" : w.id] ?? (intlSources.value.length || !listP ? "No frames available for this source right now" : null);
  built.forEach((f, i) =>
    f.parts.forEach((p, j) => {
      const s = p.src;
      const url = intlUrl(p.url);
      try {
        if (s.kind === "image") {
          const [w0, s0, e0, n0] = s.bounds ?? [-180, -85, 180, 85];
          m.addSource(sid(i, j), { type: "image", url, coordinates: [[w0, n0], [e0, n0], [e0, s0], [w0, s0]] } as any);
          // image sources take no attribution option, but the control reads the property
          const src: any = m.getSource(sid(i, j));
          if (src && i === built.length - 1) src.attribution = attributionFor(s);
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
        bad.add(i);
        console.warn("intl radar layer", e);
      }
    }),
  );
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
    return built[i].parts.every((_, j) => !!m.getSource(sid(i, j)) && m.isSourceLoaded(sid(i, j)));
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
    if (vis) touched.add(i);
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

export function attachIntl(m: MLMap, beforeFn: () => string | undefined) {
  map = m;
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
  m.on("moveend", () => {
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
  return `${w.id}|${fr.map((f) => f.t).join(",")}|${settings.value.grid.frames}|${a.mode}|${a.minutes}|${h ? `${h.start}-${h.end}` : ""}|${api.base}`;
}

effect(() => {
  void intlSources.value;
  void intlErrors.value;
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

/** Pick an international raster radar (and fly there if the map is elsewhere). */
export function selectIntl(id: string) {
  update((s) => (s.weather = { kind: "intl", id }));
  const b = id === SMN_ALL ? MEXICO_BOUNDS : intlSource(id)?.bounds;
  flyIfFar(b);
}

/** Pick an international grid layer (OPERA, CWA) and fly there if needed. */
export function flyForGrid(id: string) {
  flyIfFar(GRID_BOUNDS[id]);
}

// screenshot / console handle
(window as any).__tbwIntl = { intlSources, intlErrors, loadIntlList, selectIntl };
