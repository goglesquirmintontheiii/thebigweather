// User files on the map: GeoJSON, KML, KMZ and GPX, kept in the browser's IndexedDB.

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
}

export const fileOverlays = signal<FileOverlay[]>([]);

const PREFIX = "tbw-file:";
const COLORS = ["#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#a78bfa", "#fb7185", "#2dd4bf"];

function parseXml(text: string) {
  return new DOMParser().parseFromString(text, "text/xml");
}

/** Convert a dropped/picked file to GeoJSON. */
export async function toGeoJSON(file: File): Promise<any> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".kmz")) {
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const k = Object.keys(z).find((n) => n.toLowerCase().endsWith(".kml"));
    if (!k) throw new Error("no KML inside the KMZ");
    return kml(parseXml(strFromU8(z[k])));
  }
  const text = await file.text();
  if (name.endsWith(".kml")) return kml(parseXml(text));
  if (name.endsWith(".gpx")) return gpx(parseXml(text));
  const j = JSON.parse(text);
  if (j.type === "FeatureCollection") return j;
  if (j.type === "Feature") return { type: "FeatureCollection", features: [j] };
  if (j.type && j.coordinates) return { type: "FeatureCollection", features: [{ type: "Feature", geometry: j, properties: {} }] };
  throw new Error("not GeoJSON");
}

export function isMapFile(f: File) {
  return /\.(geojson|json|kml|kmz|gpx)$/i.test(f.name);
}

export async function importFile(file: File) {
  try {
    const fc = await toGeoJSON(file);
    const n = fc.features?.length ?? 0;
    if (!n) throw new Error("no features");
    const id = uid();
    await set(PREFIX + id, { name: file.name, fc });
    fileOverlays.value = [...fileOverlays.value, { id, name: file.name, count: n }];
    const color = COLORS[fileOverlays.value.length % COLORS.length];
    update((s) => (s.ovl[`file:${id}`] = { on: true, color, opacity: 0.8, size: 2, labels: true }));
    setData(`file:${id}`, fc);
    toast(`Added ${file.name} (${n} features)`);
  } catch (e: any) {
    toast(`Couldn't read ${file.name}: ${e.message}`, "error");
  }
}

export async function removeFile(id: string) {
  await del(PREFIX + id);
  fileOverlays.value = fileOverlays.value.filter((f) => f.id !== id);
  update((s) => delete s.ovl[`file:${id}`]);
}

export async function loadFiles() {
  try {
    const ks = (await keys()).filter((k) => String(k).startsWith(PREFIX));
    const out: FileOverlay[] = [];
    for (const k of ks) {
      const v: any = await get(k);
      if (!v) continue;
      const id = String(k).slice(PREFIX.length);
      out.push({ id, name: v.name, count: v.fc.features?.length ?? 0 });
      setData(`file:${id}`, v.fc);
    }
    fileOverlays.value = out;
  } catch {
    /* storage unavailable */
  }
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
  const out: LayerSpecification[] = [
    { id: `${src}-fill`, type: "fill", source: src, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": fill, "fill-opacity": op * 0.3 } },
    { id: `${src}-line`, type: "line", source: src, filter: ["any", ["==", ["geometry-type"], "LineString"], ["==", ["geometry-type"], "Polygon"]], paint: { "line-color": stroke, "line-width": w, "line-opacity": op } },
    {
      id: `${src}-pt`,
      type: "circle",
      source: src,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-color": ["coalesce", ["get", "marker-color"], c], "circle-radius": w + 3, "circle-opacity": op, "circle-stroke-color": "#000", "circle-stroke-width": 1 },
    },
  ];
  if (o.labels !== false)
    out.push({
      id: `${src}-text`,
      type: "symbol",
      source: src,
      filter: ["==", ["geometry-type"], "Point"],
      layout: { "text-field": ["coalesce", ["get", "name"], ["get", "title"], ""], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 },
    });
  return out;
}

export function fileClick(p: any): Popup {
  const skip = new Set(["fill", "stroke", "fill-opacity", "stroke-opacity", "stroke-width", "marker-color", "styleUrl", "styleHash", "styleMapHash", "icon", "name", "description"]);
  const rows = Object.entries(p)
    .filter(([k, v]) => !skip.has(k) && !k.startsWith("_") && v !== null && v !== "" && typeof v !== "object")
    .slice(0, 12)
    .map(([k, v]) => [k, String(v)] as [string, string]);
  const desc = typeof p.description === "string" ? p.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined;
  return { title: p.name ?? p.title ?? "Feature", rows, text: desc };
}
