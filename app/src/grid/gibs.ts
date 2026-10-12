// NASA GIBS imagery layers (GeoColor, RGB composites, Himawari): one raster source per frame so
// animation just flips opacities and tiles stay cached.

import { signal, effect } from "@preact/signals";
import type { Map as MLMap } from "maplibre-gl";
import { settings } from "../store";
import { frameIndex, frameCount, playing, setFrameReady, framesToRequest, historyEnd, histRange } from "../anim";
import { GIBS } from "../weather";

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
  for (const f of [g.format, g.format === "png" ? "jpg" : "png"]) {
    try {
      const r = await fetch(`${BASE}/${g.layer}/default/${gtime(when, g.step)}/GoogleMapsCompatible_Level${g.level}/1/0/1.${f}`);
      if (r.ok && (r.headers.get("content-type") ?? "").startsWith("image/")) {
        format = f as "png" | "jpg";
        break;
      }
    } catch {
      /* offline */
    }
  }
  const out = { at: Date.now(), newest: when, format };
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

let buildGen = 0;
async function build() {
  const gen = ++buildGen;
  held = -1;
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
  const end = historyEnd.value;
  const stepMs = g.step * 60_000;
  const n = g.step >= 1440 ? Math.min(settings.value.grid.frames, 10) : framesToRequest(Math.min(settings.value.grid.frames, 24), g.step, 36);
  const h = histRange.value;
  // history: the window's image times (every step, or a multiple of it to stay under the cap)
  const ts = h && g.step < 1440 ? histTimes(h.start, h.end, g.step, 36) : times(n, end ? Math.floor(end / stepMs) * stepMs : info.newest, g.step);
  ts.forEach((t, i) => {
    const tiles = g.wms
      ? [`${g.wms}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(g.layer)}&styles=&format=image/png&transparent=true&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&time=${iso(t)}`]
      : [`${BASE}/${g.layer}/default/${gtime(t, g.step)}/GoogleMapsCompatible_Level${g.level}/{z}/{y}/{x}.${info.format}`];
    m.addSource(`gibs-${i}`, {
      type: "raster",
      tiles,
      tileSize: 256,
      maxzoom: g.level,
      attribution: g.attribution ? `Imagery: ${g.attribution}` : "Imagery: NASA EOSDIS GIBS",
    });
    m.addLayer({ id: `wx-gibs-${i}`, type: "raster", source: `gibs-${i}`, paint: { "raster-opacity": 0, "raster-fade-duration": 0 } }, before());
  });
  gibsTimes.value = ts;
  frameCount.value = ts.length;
  setFrameReady((i) => {
    try {
      return !!m.getSource(`gibs-${i}`) && m.isSourceLoaded(`gibs-${i}`);
    } catch {
      return false;
    }
  });
  frameIndex.value = ts.length - 1;
  show();
}

function show() {
  const m = map;
  const n = gibsTimes.value.length;
  if (!m || !n) return;
  const op = settings.value.grid.opacity;
  const cur = Math.min(frameIndex.value, n - 1);
  const sig = `${cur}|${op}`;
  if (sig === shownSig) return;
  shownSig = sig;
  let loaded = false;
  try {
    loaded = m.isSourceLoaded(`gibs-${cur}`);
  } catch {
    /* not added yet */
  }
  // hold the previous image underneath until the new one has its tiles
  const hold = !loaded && held >= 0 && held !== cur ? held : -1;
  for (let i = 0; i < n; i++) {
    if (!m.getLayer(`wx-gibs-${i}`)) continue;
    // keep the next frames at a hair of opacity so their tiles are requested before they're needed
    const ahead = (i - cur + n) % n;
    m.setPaintProperty(`wx-gibs-${i}`, "raster-opacity", i === cur || i === hold ? op : ahead > 0 && ahead <= 2 ? 0.01 : 0);
  }
  if (loaded) held = cur;
  else
    m.once("idle", () => {
      shownSig = "";
      show();
    });
}

export function attachGibs(m: MLMap, beforeFn: () => string | undefined) {
  map = m;
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
  const sig = w.kind === "gibs" ? `${w.id}|${settings.value.grid.frames}|${a.mode}|${a.minutes}|${h ? `${h.start}-${h.end}` : ""}` : "";
  if (sig === lastSig) return;
  lastSig = sig;
  playing.value = false;
  build();
});

effect(() => {
  void frameIndex.value;
  void settings.value.grid.opacity;
  if (settings.value.weather.kind === "gibs") show();
});

// roll the window forward every 10 minutes
setInterval(() => {
  if (settings.value.weather.kind === "gibs" && !playing.value && !historyEnd.value) build();
}, STEP);
