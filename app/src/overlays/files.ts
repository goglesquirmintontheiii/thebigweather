// User files on the map: GeoJSON, KML, KMZ and GPX, kept in the browser's IndexedDB.
//
// Files are stored as raw GeoJSON Blobs and handed to MapLibre as blob: URLs, so a big
// file is parsed once inside the map's worker instead of on the page's main thread.

import { signal } from "@preact/signals";
import type { LayerSpecification } from "maplibre-gl";
import { get, set, del, keys } from "idb-keyval";
import { kml, gpx } from "@tmcw/togeojson";
import { unzipSync, strFromU8 } from "fflate";
import { settings, update, toast, uid } from "../store";
import type { Popup } from "./defs";
import { setData } from "./manager";

export interface FileOverlay {
  id: string;
  name: string;
  count: number;
  size?: number;
}

export const fileOverlays = signal<FileOverlay[]>([]);
/** imports in progress (name → note) */
export const fileImports = signal<Record<string, string>>({});

const PREFIX = "tbw-file:"; // old format: { name, fc }
const BLOB = "tbw-fblob:"; // new format: Blob of GeoJSON text
const META = "tbw-files"; // FileOverlay[]
const COLORS = ["#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#a78bfa", "#fb7185", "#2dd4bf"];
const urls = new Map<string, string>();
/** files above this size get coarser tiles to keep memory down */
export const BIG_FILE = 40 * 1024 * 1024;

function parseXml(text: string) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("not valid XML");
  return doc;
}

function clean(fc: any) {
  // drop features without geometry (KML NetworkLinks, GroundOverlays…) and flatten collections
  const out: any[] = [];
  for (const f of fc.features ?? []) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === "GeometryCollection") {
      for (const gg of g.geometries ?? []) if (gg) out.push({ type: "Feature", properties: f.properties ?? {}, geometry: gg });
    } else out.push(f);
  }
  return { type: "FeatureCollection", features: out };
}

/** XML formats → GeoJSON text. */
async function xmlToGeoJSON(file: File, name: string): Promise<{ text: string; count: number }> {
  let fc: any;
  if (name.endsWith(".kmz")) {
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const k = Object.keys(z).find((n) => n.toLowerCase().endsWith(".kml"));
    if (!k) throw new Error("no KML inside the KMZ");
    fc = kml(parseXml(strFromU8(z[k])));
  } else if (name.endsWith(".gpx")) fc = gpx(parseXml(await file.text()));
  else fc = kml(parseXml(await file.text()));
  fc = clean(fc);
  return { text: JSON.stringify(fc), count: fc.features.length };
}

/** Quick look at a JSON file without parsing all of it. */
async function sniffJson(file: File): Promise<{ blob: Blob; count: number }> {
  const head = (await file.slice(0, 4096).text()).replace(/^﻿/, "").trimStart();
  if (!head.startsWith("{")) throw new Error("not GeoJSON");
  if (file.size < 8 * 1024 * 1024) {
    // small: parse here so odd shapes (single Feature, bare geometry) get wrapped
    const j = JSON.parse(await file.text());
    let fc: any;
    if (j.type === "FeatureCollection") fc = j;
    else if (j.type === "Feature") fc = { type: "FeatureCollection", features: [j] };
    else if (j.type && j.coordinates) fc = { type: "FeatureCollection", features: [{ type: "Feature", geometry: j, properties: {} }] };
    else throw new Error("not GeoJSON");
    fc = clean(fc);
    return { blob: new Blob([JSON.stringify(fc)], { type: "application/geo+json" }), count: fc.features.length };
  }
  if (!/"type"\s*:\s*"(FeatureCollection|Feature)"/.test(head) && !/"features"\s*:/.test(head)) throw new Error("not GeoJSON");
  return { blob: file.slice(0, file.size, "application/geo+json"), count: await countFeatures(file) };
}

/** Count features by scanning the text in chunks (no full parse). */
async function countFeatures(file: File): Promise<number> {
  const re = /"type"\s*:\s*"Feature"/g;
  let n = 0;
  let tail = "";
  const step = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += step) {
    const s = tail + (await file.slice(off, off + step).text());
    re.lastIndex = 0;
    while (re.exec(s)) n++;
    tail = s.slice(-24).replace(/"type"\s*:\s*"Feature"[^]*$/, "");
  }
  return n;
}

export function isMapFile(f: File) {
  return /\.(geojson|json|kml|kmz|gpx)$/i.test(f.name);
}

async function saveMeta() {
  await set(META, fileOverlays.value);
}

function blobUrl(id: string, b: Blob) {
  const old = urls.get(id);
  if (old) URL.revokeObjectURL(old);
  const u = URL.createObjectURL(b);
  urls.set(id, u);
  return u;
}

export async function importFile(file: File) {
  const name = file.name.toLowerCase();
  fileImports.value = { ...fileImports.value, [file.name]: "Reading…" };
  try {
    let blob: Blob;
    let count: number;
    if (/\.(kml|kmz|gpx)$/.test(name)) {
      const r = await xmlToGeoJSON(file, name);
      blob = new Blob([r.text], { type: "application/geo+json" });
      count = r.count;
    } else {
      const r = await sniffJson(file);
      blob = r.blob;
      count = r.count;
    }
    if (!count) throw new Error("no features with a location");
    const id = uid();
    await set(BLOB + id, blob);
    const color = COLORS[fileOverlays.value.length % COLORS.length];
    // functional update so a slow loadFiles() can't drop this entry
    fileOverlays.value = [...fileOverlays.value.filter((f) => f.id !== id), { id, name: file.name, count, size: blob.size }];
    await saveMeta();
    setData(`file:${id}`, blobUrl(id, blob));
    update((s) => (s.ovl[`file:${id}`] = { on: true, color, opacity: 0.8, size: 2, labels: blob.size < BIG_FILE }));
    toast(`Added ${file.name} (${count.toLocaleString()} features)${blob.size > BIG_FILE ? ". Big file: it may take a few seconds to draw" : ""}`);
  } catch (e: any) {
    toast(`Couldn't read ${file.name}: ${e.message}`, "error", 7000);
  } finally {
    const n = { ...fileImports.value };
    delete n[file.name];
    fileImports.value = n;
  }
}

export async function removeFile(id: string) {
  await del(BLOB + id).catch(() => {});
  await del(PREFIX + id).catch(() => {});
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  fileOverlays.value = fileOverlays.value.filter((f) => f.id !== id);
  await saveMeta();
  update((s) => delete s.ovl[`file:${id}`]);
}

/** Blob URL for a stored file (loaded on demand when the layer is turned on). */
export async function fileUrl(id: string): Promise<string | null> {
  if (urls.has(id)) return urls.get(id)!;
  const b: Blob | undefined = await get(BLOB + id);
  return b ? blobUrl(id, b) : null;
}

export async function loadFiles() {
  try {
    let meta: FileOverlay[] = (await get(META)) ?? [];
    // migrate the old { name, fc } records to blobs, one at a time
    const old = (await keys()).filter((k) => String(k).startsWith(PREFIX));
    for (const k of old) {
      const id = String(k).slice(PREFIX.length);
      try {
        const v: any = await get(k);
        if (v?.fc && !meta.some((m) => m.id === id)) {
          const fc = clean(v.fc);
          const blob = new Blob([JSON.stringify(fc)], { type: "application/geo+json" });
          await set(BLOB + id, blob);
          meta.push({ id, name: v.name, count: fc.features.length, size: blob.size });
        }
      } catch {
        /* unreadable: drop it */
      }
      await del(k);
    }
    // merge with anything imported while we were loading
    const ids = new Set(meta.map((m) => m.id));
    fileOverlays.value = [...meta, ...fileOverlays.value.filter((f) => !ids.has(f.id))];
    await saveMeta();
    for (const f of fileOverlays.value) if (settings.value.ovl[`file:${f.id}`]?.on) fileUrl(f.id).then((u) => u && setData(`file:${f.id}`, u));
  } catch {
    /* storage unavailable */
  }
}

/** called by the manager when a file layer is turned on */
export function ensureFileData(oid: string) {
  const id = oid.slice(5);
  if (!urls.has(id)) fileUrl(id).then((u) => u && setData(oid, u));
}

export function fileSourceOpts(oid: string): Record<string, any> {
  const f = fileOverlays.value.find((x) => `file:${x.id}` === oid);
  // big files: coarser tiles and simplification keep the map worker's memory reasonable
  return f && (f.size ?? 0) > BIG_FILE ? { maxzoom: 12, tolerance: 0.6, buffer: 32 } : {};
}

export function fileLayers(oid: string, src: string): LayerSpecification[] | null {
  if (!oid.startsWith("file:")) return null;
  const o = settings.value.ovl[oid] ?? {};
  const c = o.color ?? "#f472b6";
  const op = o.opacity ?? 0.8;
  const w = o.size ?? 2;
  // KML styles come through as fill/stroke/marker-color properties
  const fill: any = ["coalesce", ["get", "fill"], c];
  const stroke: any = ["coalesce", ["get", "stroke"], c];
  const poly: any = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
  const line: any = ["match", ["geometry-type"], ["LineString", "MultiLineString", "Polygon", "MultiPolygon"], true, false];
  const pt: any = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
  const out: LayerSpecification[] = [
    { id: `${src}-fill`, type: "fill", source: src, filter: poly, paint: { "fill-color": fill, "fill-opacity": ["*", op, ["coalesce", ["get", "fill-opacity"], 0.3]] } },
    { id: `${src}-line`, type: "line", source: src, filter: line, paint: { "line-color": stroke, "line-width": w, "line-opacity": op } },
    {
      id: `${src}-pt`,
      type: "circle",
      source: src,
      filter: pt,
      paint: { "circle-color": ["coalesce", ["get", "marker-color"], ["get", "icon-color"], c], "circle-radius": w + 3, "circle-opacity": op, "circle-stroke-color": "#000", "circle-stroke-width": 1 },
    },
  ];
  if (o.labels !== false)
    out.push({
      id: `${src}-text`,
      type: "symbol",
      source: src,
      filter: pt,
      layout: { "text-field": ["to-string", ["coalesce", ["get", "name"], ["get", "title"], ""]], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 },
    });
  return out;
}

export function fileClick(p: any): Popup {
  const skip = new Set(["fill", "stroke", "fill-opacity", "stroke-opacity", "stroke-width", "marker-color", "icon-color", "icon-opacity", "icon-scale", "styleUrl", "styleHash", "styleMapHash", "icon", "name", "description"]);
  const rows = Object.entries(p)
    .filter(([k, v]) => !skip.has(k) && !k.startsWith("_") && v !== null && v !== "" && typeof v !== "object")
    .slice(0, 12)
    .map(([k, v]) => [k, String(v)] as [string, string]);
  const desc = typeof p.description === "string" ? p.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined;
  return { title: p.name ?? p.title ?? "Feature", rows, text: desc };
}
