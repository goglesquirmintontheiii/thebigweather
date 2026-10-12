// radar 0.6: GRLevelX placefiles on the map — loading (server proxy or local file), periodic refresh,
// icon sheets sliced into map images, and MapLibre layers per placefile (fills, lines, icons, text,
// images). Object offsets are screen pixels (icon-offset / text-offset; object lines are re-projected
// on zoom). Threshold (nm) hides items when zoomed out further than that.

import { signal, effect } from "@preact/signals";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { api } from "../api";
import { settings, update, toast, uid, type PlacefileCfg } from "../store";
import { mapRef } from "../map/mapview";
import { currentFrame } from "./controller";
import { parsePlacefile, looksLikePlacefile, type Placefile, type PfItem } from "./placefile";

export const pfState = signal<Record<string, { loading?: boolean; error?: string; title?: string; count?: number; at?: number; refresh?: number; warnings?: number }>>({});
export const pfHover = signal<{ x: number; y: number; text: string } | null>(null);

const parsed = new Map<string, Placefile>();
const timers = new Map<string, number>();
const shown = new Map<string, string>();
const LOCAL = (id: string) => `tbw.pf.${id}`;

function setState(id: string, s: Partial<(typeof pfState.value)[string]>) {
  pfState.value = { ...pfState.value, [id]: { ...pfState.value[id], ...s } };
}

// ---------- loading ----------
async function fetchText(url: string): Promise<string> {
  if (!api.base) throw new Error("No server connected");
  const r = await fetch(`${api.base}/api/placefile?url=${encodeURIComponent(url)}`, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* text */
    }
    throw new Error(msg);
  }
  return r.text();
}

async function load(cfg: PlacefileCfg) {
  setState(cfg.id, { loading: true, error: undefined });
  try {
    let text: string | null;
    if (cfg.url) text = await fetchText(cfg.url);
    else {
      try {
        text = localStorage.getItem(LOCAL(cfg.id));
      } catch {
        text = null;
      }
      if (text == null) throw new Error("Local file text is missing — open the file again");
    }
    const pf = parsePlacefile(text);
    parsed.set(cfg.id, pf);
    shown.delete(cfg.id);
    setState(cfg.id, { loading: false, title: pf.title, count: pf.items.length, at: Date.now(), refresh: pf.refresh, warnings: pf.warnings.length });
    // name a newly added URL after its title
    if (pf.title && (cfg.name === cfg.url || !cfg.name)) update((s) => s.placefiles.forEach((p) => p.id === cfg.id && (p.name = pf.title)));
    schedule(cfg);
    sync();
  } catch (e: any) {
    setState(cfg.id, { loading: false, error: e.message });
  }
}

function schedule(cfg: PlacefileCfg) {
  clearInterval(timers.get(cfg.id));
  timers.delete(cfg.id);
  const secs = cfg.refresh || parsed.get(cfg.id)?.refresh || 0;
  if (!cfg.url || !secs || !cfg.on) return;
  timers.set(
    cfg.id,
    window.setInterval(() => {
      const c = settings.value.placefiles.find((p) => p.id === cfg.id);
      if (c?.on && !document.hidden) load(c);
    }, Math.max(10, secs) * 1000),
  );
}

export function addPlacefileUrl(url: string) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast("Placefile URL must start with http:// or https://", "warn");
    return;
  }
  if (settings.value.placefiles.some((p) => p.url === url)) {
    toast("That placefile is already in the list", "info");
    return;
  }
  const cfg: PlacefileCfg = { id: uid(), name: url, url, on: true, opacity: 1 };
  update((s) => s.placefiles.push(cfg));
}

export async function addPlacefileFile(f: File) {
  const text = await f.text();
  if (!looksLikePlacefile(text)) {
    toast(`${f.name} doesn't look like a placefile`, "warn");
    return;
  }
  const id = uid();
  try {
    localStorage.setItem(LOCAL(id), text);
  } catch {
    toast("Couldn't store the placefile (storage full)", "error");
    return;
  }
  const pf = parsePlacefile(text);
  update((s) => s.placefiles.push({ id, name: pf.title || f.name, url: "", on: true, opacity: 1 }));
  toast(`Placefile "${pf.title || f.name}" added (${pf.items.length} items)`);
}

/** Drop/open handler: is this file a placefile? (by extension, or by sniffing a text file) */
export async function isPlacefileFile(f: File): Promise<boolean> {
  if (/\.(pf|placefile|plc)$/i.test(f.name)) return true;
  if (!/\.txt$/i.test(f.name) || f.size > 20_000_000) return false;
  try {
    return looksLikePlacefile(await f.slice(0, 8000).text());
  } catch {
    return false;
  }
}

export function removePlacefile(id: string) {
  update((s) => (s.placefiles = s.placefiles.filter((p) => p.id !== id)));
  try {
    localStorage.removeItem(LOCAL(id));
  } catch {
    /* ignore */
  }
  parsed.delete(id);
  clearInterval(timers.get(id));
  timers.delete(id);
}

export function reloadPlacefile(id: string) {
  const c = settings.value.placefiles.find((p) => p.id === id);
  if (c) load(c);
}

// ---------- icons ----------
const sheets = new Map<string, Promise<ImageBitmap>>();
function sheet(url: string): Promise<ImageBitmap> {
  let p = sheets.get(url);
  if (!p) {
    p = api.bin(`/api/placefile/asset?url=${encodeURIComponent(url)}`).then((b) => createImageBitmap(new Blob([b])));
    sheets.set(url, p);
    p.catch(() => setTimeout(() => sheets.delete(url), 60_000));
  }
  return p;
}
const resolve = (u: string, base: string) => {
  try {
    return new URL(u, base || undefined).href;
  } catch {
    return u;
  }
};

const FALLBACK = "pf-fallback";
function ensureFallback(m: MLMap) {
  if (m.hasImage(FALLBACK)) return;
  const c = document.createElement("canvas");
  c.width = c.height = 12;
  const x = c.getContext("2d")!;
  x.fillStyle = "#fff";
  x.strokeStyle = "#000";
  x.lineWidth = 2;
  x.beginPath();
  x.arc(6, 6, 4.5, 0, Math.PI * 2);
  x.fill();
  x.stroke();
  m.addImage(FALLBACK, x.getImageData(0, 0, 12, 12));
}

/** Slice the icons this placefile uses out of its sheets and add them as map images. */
async function ensureIcons(m: MLMap, cfg: PlacefileCfg, pf: Placefile): Promise<Set<string>> {
  ensureFallback(m);
  const ok = new Set<string>();
  const used = new Map<number, Set<number>>();
  for (const it of pf.items) if (it.t === "icon") (used.get(it.file) ?? used.set(it.file, new Set()).get(it.file)!).add(it.icon);
  await Promise.all(
    [...used].map(async ([fn, icons]) => {
      const f = pf.iconFiles.get(fn);
      if (!f || !f.url) return;
      const url = resolve(f.url, cfg.url);
      if (!/^https?:/i.test(url)) return;
      let bmp: ImageBitmap;
      try {
        bmp = await sheet(url);
      } catch {
        return;
      }
      const cols = Math.max(1, Math.floor(bmp.width / f.w));
      const c = document.createElement("canvas");
      c.width = f.w;
      c.height = f.h;
      const x = c.getContext("2d", { willReadFrequently: true })!;
      for (const n of icons) {
        const name = `pf:${cfg.id}:${fn}:${n}`;
        if (m.hasImage(name)) {
          ok.add(name);
          continue;
        }
        const i = n - 1;
        const sx = (i % cols) * f.w, sy = Math.floor(i / cols) * f.h;
        if (sy + f.h > bmp.height) continue;
        x.clearRect(0, 0, f.w, f.h);
        x.drawImage(bmp, sx, sy, f.w, f.h, 0, 0, f.w, f.h);
        m.addImage(name, x.getImageData(0, 0, f.w, f.h));
        ok.add(name);
      }
    }),
  );
  return ok;
}

// ---------- features ----------
const rgba = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${((c[3] ?? 255) / 255) * a})`;
const mpp = (lat: number, z: number) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** z);
const rot = (x: number, y: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

function build(id: string, pf: Placefile, icons: Set<string>, zoom: number, t: number) {
  const feats: any[] = [];
  const images: { url: string; coords: [number, number][] }[] = [];
  const thrOf = (x: PfItem) => (x.thr > 0 ? x.thr : 999);
  for (const it of pf.items) {
    if (it.tr && (t < it.tr[0] || t > it.tr[1])) continue;
    const base = { thr: thrOf(it), hover: it.hover ?? "" };
    switch (it.t) {
      case "icon": {
        const name = `pf:${id}:${it.file}:${it.icon}`;
        const f = pf.iconFiles.get(it.file);
        const have = icons.has(name);
        // centre anchor: hotspot offset rotates with the icon, the object's pixel offset doesn't
        const hot: [number, number] = have && f ? [f.w / 2 - f.hx, f.h / 2 - f.hy] : [0, 0];
        const o = rot(it.ox, -it.oy, -it.angle);
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [it.lon, it.lat] }, properties: { ...base, k: "icon", img: have ? name : FALLBACK, rot: it.angle, off: [hot[0] + o[0], hot[1] + o[1]] } });
        break;
      }
      case "text": {
        const fnt = pf.fonts.get(it.font);
        const size = Math.max(8, Math.min(32, fnt?.size ?? 12));
        if (!it.text.trim()) break;
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [it.lon, it.lat] }, properties: { ...base, k: "text", txt: it.text, size, bold: (fnt?.flags ?? 0) & 1 ? 1 : 0, col: rgba(it.color), toff: [it.ox / size, -it.oy / size] } });
        break;
      }
      case "line": {
        const coords = it.pts.map(([lat, lon, ox, oy]) => {
          if (!ox && !oy) return [lon, lat];
          const k = mpp(lat, zoom);
          return [lon + (ox * k) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (oy * k) / 110540];
        });
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { ...base, k: "line", col: rgba(it.color), w: it.width } });
        break;
      }
      case "poly": {
        const tri = (it as any)._tri;
        if (tri) {
          const cols: number[][] = (it as any).colors ?? [];
          it.rings.forEach((r, i) => feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...r, r[0]]] }, properties: { ...base, k: "fill", col: rgba(cols[i] ?? it.color) } }));
        } else {
          feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: it.rings.map((r) => [...r, r[0]]) }, properties: { ...base, k: "fill", col: rgba(it.color) } });
        }
        break;
      }
      case "image": {
        // corners from the vertices nearest each texture corner
        const us = it.pts.map((p) => p[2]), vs = it.pts.map((p) => p[3]);
        const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
        const near = (u: number, v: number) => it.pts.reduce((a, p) => (Math.hypot(p[2] - u, p[3] - v) < Math.hypot(a[2] - u, a[3] - v) ? p : a), it.pts[0]);
        const c = [near(u0, v0), near(u1, v0), near(u1, v1), near(u0, v1)].map((p) => [p[1], p[0]] as [number, number]);
        images.push({ url: it.url, coords: c });
        break;
      }
    }
  }
  return { fc: { type: "FeatureCollection", features: feats }, images };
}

// ---------- map layers ----------
function viewNm(m: MLMap): number {
  const c = m.getCanvas();
  return (mpp(m.getCenter().lat, m.getZoom()) * Math.min(c.clientWidth, c.clientHeight)) / 2 / 1852;
}
const thrFilter = (m: MLMap, kind: string): any => ["all", ["==", ["get", "k"], kind], [">=", ["get", "thr"], viewNm(m)]];

function removeFrom(m: MLMap, id: string) {
  const pre = `pf-${id}`;
  for (const l of m.getStyle()?.layers ?? []) if (l.id === pre || l.id.startsWith(`${pre}-`)) m.removeLayer(l.id);
  for (const s of Object.keys(m.getStyle()?.sources ?? {})) if (s === pre || s.startsWith(`${pre}-`)) m.removeSource(s);
  shown.delete(id);
}

const imgUrls = new Map<string, Promise<string>>();
function imageUrl(u: string): Promise<string> {
  let p = imgUrls.get(u);
  if (!p) {
    p = api.bin(`/api/placefile/asset?url=${encodeURIComponent(u)}`).then((b) => URL.createObjectURL(new Blob([b])));
    imgUrls.set(u, p);
    p.catch(() => imgUrls.delete(u));
  }
  return p;
}

const gens = new Map<string, number>();
async function render(m: MLMap, cfg: PlacefileCfg) {
  const pf = parsed.get(cfg.id);
  if (!pf) return;
  const g = (gens.get(cfg.id) ?? 0) + 1;
  gens.set(cfg.id, g);
  const icons = await ensureIcons(m, cfg, pf);
  if (gens.get(cfg.id) !== g || !m.getStyle()) return;
  const t = currentFrame.value?.sweep?.start ?? currentFrame.value?.time ?? Date.now();
  const { fc, images } = build(cfg.id, pf, icons, m.getZoom(), pf.hasTime ? t : Date.now());
  const src = `pf-${cfg.id}`;
  const op = cfg.opacity;
  removeFrom(m, cfg.id);
  m.addSource(src, { type: "geojson", data: fc as any });
  const before = m.getLayer("ovl-tools-line") ? "ovl-tools-line" : undefined;
  // images first (under the vectors)
  for (let k = 0; k < images.length; k++) {
    const im = images[k];
    const u = resolve(im.url, cfg.url);
    if (!/^https?:/i.test(u)) continue;
    imageUrl(u)
      .then((url) => {
        if (gens.get(cfg.id) !== g || !m.getSource(src)) return;
        const s = `${src}-img${k}`;
        if (m.getSource(s)) return;
        m.addSource(s, { type: "image", url, coordinates: im.coords as any });
        m.addLayer({ id: `${src}-img${k}`, type: "raster", source: s, paint: { "raster-opacity": op, "raster-fade-duration": 0 } }, m.getLayer(`${src}-fill`) ? `${src}-fill` : before);
      })
      .catch(() => {});
  }
  m.addLayer({ id: `${src}-fill`, type: "fill", source: src, filter: thrFilter(m, "fill"), paint: { "fill-color": ["get", "col"], "fill-opacity": op } }, before);
  m.addLayer({ id: `${src}-line`, type: "line", source: src, filter: thrFilter(m, "line"), layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "col"], "line-width": ["get", "w"], "line-opacity": op } }, before);
  m.addLayer(
    {
      id: `${src}-icon`,
      type: "symbol",
      source: src,
      filter: thrFilter(m, "icon"),
      layout: { "icon-image": ["get", "img"], "icon-rotate": ["get", "rot"], "icon-offset": ["get", "off"], "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-rotation-alignment": "viewport" },
      paint: { "icon-opacity": op },
    },
    before,
  );
  m.addLayer(
    {
      id: `${src}-text`,
      type: "symbol",
      source: src,
      filter: thrFilter(m, "text"),
      layout: {
        "text-field": ["get", "txt"],
        "text-size": ["get", "size"],
        "text-font": ["case", ["==", ["get", "bold"], 1], ["literal", ["Noto Sans Bold"]], ["literal", ["Noto Sans Regular"]]],
        "text-offset": ["get", "toff"],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-max-width": 30,
      },
      paint: { "text-color": ["get", "col"], "text-halo-color": "rgba(0,0,0,0.85)", "text-halo-width": 1.2, "text-opacity": op },
    },
    before,
  );
  shown.set(cfg.id, sig(cfg));
}

const sig = (c: PlacefileCfg) => `${c.opacity}`;

/** Re-apply threshold filters (zoom) and re-project object lines. */
function onZoom(m: MLMap) {
  for (const c of settings.value.placefiles) {
    if (!c.on || !shown.has(c.id)) continue;
    const pre = `pf-${c.id}`;
    for (const k of ["fill", "line", "icon", "text"]) if (m.getLayer(`${pre}-${k}`)) m.setFilter(`${pre}-${k}`, thrFilter(m, k));
    const pf = parsed.get(c.id);
    if (pf?.hasObjects && pf.items.some((i) => i.t === "line" && i.pts.some((p) => p[2] || p[3]))) refreshData(m, c);
  }
}

function refreshData(m: MLMap, c: PlacefileCfg) {
  const pf = parsed.get(c.id);
  const s = m.getSource(`pf-${c.id}`) as GeoJSONSource | undefined;
  if (!pf || !s) return;
  const icons = new Set<string>();
  for (const it of pf.items) if (it.t === "icon" && m.hasImage(`pf:${c.id}:${it.file}:${it.icon}`)) icons.add(`pf:${c.id}:${it.file}:${it.icon}`);
  const t = currentFrame.value?.sweep?.start ?? currentFrame.value?.time ?? Date.now();
  s.setData(build(c.id, pf, icons, m.getZoom(), pf.hasTime ? t : Date.now()).fc as any);
}

function sync() {
  const m = mapRef.value;
  if (!m || !m.getStyle()) return;
  const list = settings.value.placefiles;
  for (const id of [...shown.keys()]) if (!list.some((c) => c.id === id && c.on)) removeFrom(m, id);
  for (const c of list) {
    if (!c.on) {
      clearInterval(timers.get(c.id));
      timers.delete(c.id);
      continue;
    }
    if (!parsed.has(c.id)) {
      if (!pfState.value[c.id]?.loading && !pfState.value[c.id]?.error) load(c);
      continue;
    }
    if (!timers.has(c.id)) schedule(c);
    if (shown.get(c.id) !== sig(c)) render(m, c);
  }
}

let hooked: MLMap | null = null;
function hook(m: MLMap) {
  if (hooked === m) return;
  hooked = m;
  m.on("style.load", () => {
    shown.clear();
    sync();
  });
  m.on("zoomend", () => onZoom(m));
  let last = 0;
  m.on("mousemove", (e) => {
    if (!shown.size) return;
    const now = performance.now();
    if (now - last < 50) return;
    last = now;
    const ids = (m.getStyle()?.layers ?? []).filter((l) => l.id.startsWith("pf-") && !l.id.includes("-img")).map((l) => l.id);
    if (!ids.length) return;
    const f = m.queryRenderedFeatures(e.point, { layers: ids }).find((x) => x.properties?.hover);
    pfHover.value = f ? { x: e.point.x, y: e.point.y, text: String(f.properties!.hover) } : null;
  });
  m.getCanvas().addEventListener("mouseleave", () => (pfHover.value = null));
}

effect(() => {
  const m = mapRef.value;
  void settings.value.placefiles;
  void api.base;
  if (!m) return;
  hook(m);
  if (m.isStyleLoaded()) sync();
  else m.once("idle", sync);
});

// time-ranged placefiles follow the frame on screen
let lastT = 0;
effect(() => {
  const t = currentFrame.value?.time ?? 0;
  if (Math.abs(t - lastT) < 1000) return;
  lastT = t;
  const m = mapRef.value;
  if (!m) return;
  for (const c of settings.value.placefiles) if (c.on && parsed.get(c.id)?.hasTime && shown.has(c.id)) refreshData(m, c);
});

// a server (re)connect retries placefiles that failed to load
api.on("connected", () => {
  for (const c of settings.value.placefiles) if (c.on && pfState.value[c.id]?.error) load(c);
});

(window as any).__tbwPf = { addPlacefileUrl, addPlacefileFile, reloadPlacefile, parsed, pfState, shown, render: () => sync(), renderOne: (id: string) => render(mapRef.value!, settings.value.placefiles.find((p) => p.id === id)!) }; // radar 0.6: console / screenshots
