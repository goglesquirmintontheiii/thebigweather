// NASA GIBS imagery layers (GeoColor, RGB composites, Himawari) and EUMETView WMS: one raster source
// per frame (per coverage part), bounded to the satellite's disc and capped at its native level.
// Only one complete image time is ever drawn; far frames are visibility:none so they fetch nothing.

import { signal, effect } from "@preact/signals";
import type { Map as MLMap } from "maplibre-gl";
import { settings } from "../store";
import { frameIndex, frameCount, playing, setFrameReady, framesToRequest, historyEnd, histRange } from "../anim";
import { GIBS } from "../weather";
import { perfNow } from "../perf"; // 0.8.1 perf

export const gibsTimes = signal<number[]>([]);
let map: MLMap | null = null;
let shownSig = "";
let held = -1;
let before: () => string | undefined = () => undefined;

const STEP = 10 * 60_000;
void STEP;
/** GIBS imagery appears ~40 minutes after the scan; ask for 60+ to be safe. */
const LATENCY = 60 * 60_000;

function times(n: number, newest: number | undefined, stepMin: number): number[] {
  const step = stepMin * 60_000;
  const last = Math.floor((newest ?? Date.now() - (stepMin >= 1440 ? 86400_000 : LATENCY)) / step) * step;
  return Array.from({ length: n }, (_, i) => last - (n - 1 - i) * step);
}

/** Image times inside [start, end] at a multiple of the layer's step, at most `cap`. */
function histTimes(start: number, end: number, stepMin: number, cap: number): number[] {
  let step = stepMin * 60_000;
  while ((end - start) / step + 1 > cap) step += stepMin * 60_000;
  const last = Math.floor(end / step) * step;
  const out: number[] = [];
  for (let t = last; t >= start && out.length < cap; t -= step) out.unshift(t);
  return out.length ? out : [last];
}

/** EUMETView: newest time from the layer's own WMS capabilities. */
async function wmsNewest(g: (typeof GIBS)[number]): Promise<number | undefined> {
  try {
    const [ws, name] = g.layer.split(":");
    const xml = await (await fetch(`${g.wms!.replace("/ows", "")}/${ws}/${name}/ows?service=WMS&version=1.3.0&request=GetCapabilities`)).text();
    const dim = xml.match(/<Dimension[^>]*name="time"[^>]*>([^<]*)</i);
    const def = xml.match(/<Dimension[^>]*name="time"[^>]*default="([^"]+)"/i);
    if (def) return Date.parse(def[1]);
    if (dim) {
      const parts = dim[1].trim().split(",");
      const last = parts[parts.length - 1].split("/");
      return Date.parse(last.length >= 2 ? last[1] : last[0]);
    }
  } catch {
    /* fall back */
  }
  return undefined;
}

const BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const resolved = new Map<string, { at: number; newest?: number; format: string }>();

/** Newest image time (from GIBS DescribeDomains) and the tile format that layer really serves.
 * Himawari runs later than GOES and some layers are JPEG-only, so neither is assumed. */
async function resolve(g: (typeof GIBS)[number]): Promise<{ newest?: number; format: string }> {
  const c = resolved.get(g.id);
  if (c && Date.now() - c.at < 10 * 60_000) return c;
  if (g.wms) {
    const newest = await wmsNewest(g);
    const out = { at: Date.now(), newest: newest ?? Math.floor((Date.now() - 40 * 60_000) / (g.step * 60_000)) * g.step * 60_000, format: "png" };
    resolved.set(g.id, out);
    return out;
  }
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  let newest: number | undefined;
  try {
    const url = `${BASE}/1.0.0/${g.layer}/default/GoogleMapsCompatible_Level${g.level}/all/${day(Date.now() - 86400_000)}--${day(Date.now() + 86400_000)}.xml`;
    const xml = await (await fetch(url)).text();
    for (const m of xml.matchAll(/(\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\dZ)?)\/(\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\dZ)?)/g)) {
      const t = Date.parse(m[2].length === 10 ? `${m[2]}T00:00:00Z` : m[2]);
      if (t <= Date.now() && (!newest || t > newest)) newest = t;
    }
  } catch {
    /* fall back to a fixed latency */
  }
  const stepMs = g.step * 60_000;
  const when = newest ?? Math.floor((Date.now() - (g.step >= 1440 ? 86400_000 : g.layer.startsWith("Himawari") ? 2 * LATENCY : LATENCY)) / stepMs) * stepMs;
  let format = g.format;
  // p7: the newest advertised time is sometimes not populated yet (GIBS then serves an empty tile or an
  // error), which left the initial (newest) frame blank until playback reached an older one: step back
  // to the newest time whose probe tile has real content.
  let real = when;
  const probe = async (t: number, f: string): Promise<"ok" | "empty" | "fail"> => {
    try {
      const r = await fetch(`${BASE}/${g.layer}/default/${gtime(t, g.step)}/GoogleMapsCompatible_Level${g.level}/1/0/1.${f}`);
      if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) return "fail";
      const b = await r.blob();
      return b.size < (f === "png" ? 900 : 2500) ? "empty" : "ok";
    } catch {
      return "fail";
    }
  };
  let found = false;
  for (const f of [g.format, g.format === "png" ? "jpg" : "png"]) {
    const r = await probe(when, f);
    if (r !== "fail") {
      format = f as "png" | "jpg";
      found = r === "ok";
      break;
    }
  }
  if (!found && g.step < 1440)
    for (let k = 1; k <= 6; k++) {
      const t = when - k * stepMs;
      if ((await probe(t, format)) === "ok") {
        real = t;
        break;
      }
    }
  const out = { at: Date.now(), newest: real, format };
  resolved.set(g.id, out);
  return out;
}

function iso(t: number) {
  return new Date(t).toISOString().slice(0, 19) + "Z";
}

/** GIBS time: daily layers take a plain date. */
function gtime(t: number, stepMin: number) {
  return stepMin >= 1440 ? new Date(t).toISOString().slice(0, 10) : iso(t);
}

function clear(m: MLMap) {
  const style = m.getStyle();
  if (!style) return;
  for (const l of style.layers) if (l.id.startsWith("wx-gibs-")) m.removeLayer(l.id);
  for (const id of Object.keys(style.sources)) if (id.startsWith("gibs-")) m.removeSource(id);
}

/** Geostationary coverage discs (lon/lat boxes; MapLibre bounds can't cross the antimeridian, so
 * a disc that does is split into two sources). Polar/global layers have no bounds. */
function coverage(g: (typeof GIBS)[number]): [number, number, number, number][] | null {
  if (g.sat === "19") return [[-156, -81, 6, 81]];
  if (g.sat === "18") return [[-180, -81, -56, 81], [142, -81, 180, 81]];
  if (g.sat === "himawari") return [[59, -81, 180, 81], [-180, -81, -138, 81]];
  if (g.sat === "meteosat") return g.layer.startsWith("msg_iodc") ? [[-36, -81, 127, 81]] : [[-81, -81, 81, 81]];
  return null;
}

/** Layer ids (one per coverage part) of frame i. */
let parts = 1;
const lid = (i: number, p: number) => `wx-gibs-${i}${p ? `-${p}` : ""}`;
const sid = (i: number, p: number) => `gibs-${i}${p ? `-${p}` : ""}`;

/** Frames whose tiles for the current view have fully arrived (cleared when the view moves). */
const ready = new Set<number>();

/** Render count when each frame was last opened: MapLibre only marks a source "used" (and reports
 * real tile state) after the next render, before that an unused source claims to be loaded. */
let renders = 0;
const opened = new Map<number, number>();

/** p7: per-frame tile outcomes for the current view; a frame whose tiles all failed is empty. */
const tileOk = new Map<number, number>();
const tileErr = new Map<number, number>();
const emptyFrame = (i: number) => !tileOk.get(i) && (tileErr.get(i) ?? 0) > 0;

function frameLoaded(m: MLMap, i: number): boolean {
  if ((opened.get(i) ?? Infinity) >= renders) return false;
  try {
    for (let p = 0; p < parts; p++) {
      if (!m.getSource(sid(i, p)) || m.getLayoutProperty(lid(i, p), "visibility") === "none") return false;
      if (!m.isSourceLoaded(sid(i, p))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 0.8.1 perf: out-of-view tiles a GIBS frame source may keep (MapLibre internals, guarded) */
function capTileCache(m: MLMap, id: string, sources: number) {
  try {
    const st = (m as any).style;
    const tm = st?.tileManagers?.[id] ?? st?.sourceCaches?.[id];
    if (!tm) return;
    const tiles = Math.floor((perfNow().cacheMB * 1024 * 1024 * 0.5) / (256 * 256 * 4) / Math.max(1, sources));
    tm._maxTileCacheSize = Math.max(8, Math.min(256, tiles));
  } catch {
    /* other MapLibre version: keep its default */
  }
}

let buildGen = 0;
async function build() {
  const gen = ++buildGen;
  held = -1;
  ready.clear();
  const m = map;
  if (!m || !m.getStyle()) return;
  const w = settings.value.weather;
  clear(m);
  shownSig = "";
  if (w.kind !== "gibs") {
    gibsTimes.value = [];
    return;
  }
  const g = GIBS.find((x) => x.id === w.id);
  if (!g) return;
  const info = await resolve(g);
  if (gen !== buildGen || !m.getStyle()) return;
  clear(m);
  ready.clear();
  opened.clear();
  tileOk.clear();
  tileErr.clear();
  held = -1;
  const end = historyEnd.value;
  const stepMs = g.step * 60_000;
  const n = g.step >= 1440 ? Math.min(settings.value.grid.frames, 10) : framesToRequest(Math.min(settings.value.grid.frames, 24), g.step, 36);
  const h = histRange.value;
  // history: the window's image times (every step, or a multiple of it to stay under the cap)
  const ts = h && g.step < 1440 ? histTimes(h.start, h.end, g.step, 36) : times(n, end ? Math.floor(end / stepMs) * stepMs : info.newest, g.step);
  const cov = coverage(g);
  parts = cov ? cov.length : 1;
  ts.forEach((t, i) => {
    const tiles = g.wms
      ? [`${g.wms}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(g.layer)}&styles=&format=image/png&transparent=true&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&time=${iso(t)}`]
      : [`${BASE}/${g.layer}/default/${gtime(t, g.step)}/GoogleMapsCompatible_Level${g.level}/{z}/{y}/{x}.${info.format}`];
    for (let p = 0; p < parts; p++) {
      m.addSource(sid(i, p), {
        type: "raster",
        tiles,
        tileSize: 256,
        // the layer's native matrix level: MapLibre overzooms past it instead of asking for tiles that don't exist
        maxzoom: g.level,
        ...(cov ? { bounds: cov[p] } : {}),
        attribution: g.attribution ? `Imagery: ${g.attribution}` : "Imagery: NASA EOSDIS GIBS",
      });
      // 0.8.1 perf: each frame's source keeps a tile cache sized from the viewport (×5 zoom levels):
      // with 24–36 frames on a large screen that was thousands of 256² textures (GBs of GPU memory).
      // Cap the tiles a source keeps out of view so the whole loop stays within the frame cache.
      capTileCache(m, sid(i, p), ts.length * parts);
      // every frame starts hidden (no tile requests); show() opens the current one and a short preload window
      m.addLayer({ id: lid(i, p), type: "raster", source: sid(i, p), layout: { visibility: "none" }, paint: { "raster-opacity": 0, "raster-fade-duration": 0 } }, before());
    }
  });
  gibsTimes.value = ts;
  frameCount.value = ts.length;
  setFrameReady((i) => !emptyFrame(i) && (ready.has(i) || (frameLoaded(m, i) && (ready.add(i), true))));
  frameIndex.value = ts.length - 1;
  shownSig = "";
  show();
}

/** Show exactly one complete image time. The current frame and the next 1-3 are "visible" at
 * opacity 0 so MapLibre fetches their tiles; until the current one has every tile for the view
 * the previous complete frame stays up, so frames of different times never mix. */
function show() {
  const m = map;
  const n = gibsTimes.value.length;
  if (!m || !n || !m.getLayer(lid(0, 0))) return;
  const op = settings.value.grid.opacity;
  const cur = Math.min(frameIndex.value, n - 1);
  const ahead = playing.value ? 3 : 1;
  const want = new Set<number>([cur]);
  let changed = false;
  for (let k = 1; k <= ahead && k < n; k++) want.add((cur + k) % n);
  // open the preload window first so the current frame's loaded state is meaningful
  for (let i = 0; i < n; i++)
    for (let p = 0; p < parts; p++) {
      const vis = want.has(i) || i === held ? "visible" : "none";
      if (m.getLayoutProperty(lid(i, p), "visibility") !== vis) {
        m.setLayoutProperty(lid(i, p), "visibility", vis);
        changed = true;
        if (vis === "visible") opened.set(i, renders);
      }
      if (vis === "none") ready.delete(i); // its tiles go back to the cache; re-check when it's reopened
    }
  const loaded = ready.has(cur) || frameLoaded(m, cur);
  if (loaded && held !== cur && held >= 0 && !want.has(held)) {
    // the previously held frame is no longer needed on screen
    for (let p = 0; p < parts; p++) m.setLayoutProperty(lid(held, p), "visibility", "none");
    ready.delete(held);
  }
  if (loaded) {
    ready.add(cur);
    held = cur;
    // p7: paused on a frame whose every tile failed (newest time not published yet): fall back to
    // the newest older frame instead of leaving the map blank until play is pressed
    if (!playing.value && emptyFrame(cur) && cur > 0) {
      queueMicrotask(() => {
        if (frameIndex.peek() === cur) frameIndex.value = cur - 1;
      });
    }
  }
  const visible = loaded ? cur : held >= 0 ? held : cur; // first load: only the current time ever draws
  const sig = `${cur}|${visible}|${op}`;
  if (sig !== shownSig) {
    shownSig = sig;
    changed = true;
    for (let i = 0; i < n; i++) for (let p = 0; p < parts; p++) m.setPaintProperty(lid(i, p), "raster-opacity", i === visible ? op : 0);
  }
  if (changed) m.triggerRepaint(); // p7: newly opened/shown sources render (and fetch) without user interaction
}

/** Tiles arriving or the view moving re-evaluate which frame can be shown. */
let hooked: MLMap | null = null;
function hook(m: MLMap) {
  if (hooked === m) return;
  hooked = m;
  m.on("render", () => void renders++);
  m.on("error", (e: { sourceId?: string; tile?: unknown } & object) => {
    if (!e.sourceId?.startsWith("gibs-") || !e.tile) return;
    const i = Number(e.sourceId.split("-")[1]);
    tileErr.set(i, (tileErr.get(i) ?? 0) + 1);
  });
  m.on("sourcedata", (e: { sourceId?: string; isSourceLoaded?: boolean; tile?: unknown }) => {
    if (!e.sourceId?.startsWith("gibs-") || settings.value.weather.kind !== "gibs") return;
    const i = Number(e.sourceId.split("-")[1]);
    if (e.tile) tileOk.set(i, (tileOk.get(i) ?? 0) + 1);
    if (frameLoaded(m, i)) ready.add(i);
    if (i === Math.min(frameIndex.value, gibsTimes.value.length - 1)) show();
  });
  m.on("idle", () => {
    if (settings.value.weather.kind === "gibs") show();
  });
  // a new view needs new tiles: only frames that are being fetched can be ready again
  m.on("moveend", () => {
    if (settings.value.weather.kind !== "gibs") return;
    ready.clear();
    tileOk.clear();
    tileErr.clear();
    if (held >= 0) ready.add(held); // keep showing what is on screen while the rest catches up
    show();
  });
}

export function attachGibs(m: MLMap, beforeFn: () => string | undefined) {
  map = m;
  hook(m);
  before = beforeFn;
}

/** Call after every style load. */
export function rebuildGibs() {
  build();
}

let lastSig = "";
effect(() => {
  const w = settings.value.weather;
  const a = settings.value.anim;
  const h = histRange.value;
  const sig = w.kind === "gibs" ? `${w.id}|${settings.value.grid.frames}|${a.mode}|${a.minutes}|${h ? `${h.start}-${h.end}` : ""}|${settings.value.saver}` : ""; // saver caps frames
  if (sig === lastSig) return;
  lastSig = sig;
  playing.value = false;
  build();
});

effect(() => {
  void frameIndex.value;
  void playing.value;
  void settings.value.grid.opacity;
  if (settings.value.weather.kind === "gibs") show();
});

// roll the window forward every 10 minutes
setInterval(() => {
  if (settings.value.weather.kind === "gibs" && !playing.value && !historyEnd.value) build();
}, STEP);
