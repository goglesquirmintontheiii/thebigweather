// data 0.8: data export — overlays to CSV / GeoJSON / KML (client-side from the loaded GeoJSON, or
// the server's ?format=), gridded frames to CSV / GeoJSON / NetCDF and Level II sweeps to NetCDF
// (server), charts and the cross-section to PNG (canvas) / SVG (charts, re-drawn). Files go through
// the save-file IPC (saveio.ts).

import { signal } from "@preact/signals";
import type { GeoJSONSource } from "maplibre-gl";
import { api } from "../api";
import { settings, toast } from "../store";
import { mapRef } from "../map/mapview";
import { saveFile, stamp } from "../saveio";
import { gridDef, gridExtraQ } from "../weather";
import { gridFrames } from "../grid/controller";
import { frameIndex } from "../anim";
import { currentFrame } from "../radar/controller";
import { overlayDef } from "../overlays/defs";
import { chartSvg, chartRegistry } from "./svg";

export const exportOpen = signal(false);
/** overlay to highlight when opened from a layer's settings */
export const exportFocus = signal<string | null>(null);
export function openExport(focus: string | null = null) {
  exportFocus.value = focus;
  exportOpen.value = true;
}
export const exportBusy = signal<string>("");

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 80);

// ---------- overlays ----------

/** the overlay's GeoJSON as drawn (derived helper features dropped) */
export async function overlayData(id: string): Promise<any | null> {
  const src = mapRef.value?.getSource(`o-${id}`) as GeoJSONSource | undefined;
  if (!src || typeof (src as any).getData !== "function") return null;
  try {
    const fc: any = await (src as any).getData();
    const feats = (fc?.features ?? []).filter((f: any) => !f.properties?._k && !f.properties?._mid);
    return { type: "FeatureCollection", features: feats.map((f: any) => ({ type: "Feature", geometry: f.geometry, properties: Object.fromEntries(Object.entries(f.properties ?? {}).filter(([k]) => !k.startsWith("_"))) })) };
  } catch {
    return null;
  }
}

const csvCell = (v: any) => {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function centroid(g: any): [number, number] | null {
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  const pts: number[][] = g.type === "LineString" || g.type === "MultiPoint" ? g.coordinates : g.type === "Polygon" || g.type === "MultiLineString" ? g.coordinates.flat() : g.type === "MultiPolygon" ? g.coordinates.flat(2) : [];
  if (!pts.length) return null;
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}
/** one row per feature: lon, lat (point or centroid), geometry type, then every property; WKT for non-points */
export function toCsv(fc: any): string {
  const feats: any[] = fc?.features ?? [];
  const keys = [...new Set(feats.flatMap((f) => Object.keys(f.properties ?? {})))];
  const rows = [["lon", "lat", "geometry", ...keys, "wkt"].join(",")];
  for (const f of feats) {
    const c = centroid(f.geometry);
    rows.push([c ? +c[0].toFixed(6) : "", c ? +c[1].toFixed(6) : "", f.geometry?.type ?? "", ...keys.map((k) => csvCell(f.properties?.[k])), f.geometry && f.geometry.type !== "Point" ? csvCell(toWkt(f.geometry)) : ""].join(","));
  }
  return rows.join("\n") + "\n";
}
function toWkt(g: any): string {
  const p = (c: number[]) => `${+c[0].toFixed(6)} ${+c[1].toFixed(6)}`;
  const l = (cs: number[][]) => `(${cs.map(p).join(", ")})`;
  switch (g.type) {
    case "LineString":
      return `LINESTRING ${l(g.coordinates)}`;
    case "MultiLineString":
      return `MULTILINESTRING (${g.coordinates.map(l).join(", ")})`;
    case "Polygon":
      return `POLYGON (${g.coordinates.map(l).join(", ")})`;
    case "MultiPolygon":
      return `MULTIPOLYGON (${g.coordinates.map((r: any) => `(${r.map(l).join(", ")})`).join(", ")})`;
    case "MultiPoint":
      return `MULTIPOINT ${l(g.coordinates)}`;
    default:
      return "";
  }
}
const xml = (s: any) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
function kmlGeom(g: any): string {
  const co = (cs: number[][]) => `<coordinates>${cs.map((c) => `${c[0]},${c[1]}`).join(" ")}</coordinates>`;
  const poly = (rings: number[][][]) => `<Polygon><outerBoundaryIs><LinearRing>${co(rings[0])}</LinearRing></outerBoundaryIs>${rings.slice(1).map((r) => `<innerBoundaryIs><LinearRing>${co(r)}</LinearRing></innerBoundaryIs>`).join("")}</Polygon>`;
  switch (g?.type) {
    case "Point":
      return `<Point><coordinates>${g.coordinates[0]},${g.coordinates[1]}</coordinates></Point>`;
    case "LineString":
      return `<LineString>${co(g.coordinates)}</LineString>`;
    case "Polygon":
      return poly(g.coordinates);
    case "MultiPoint":
      return `<MultiGeometry>${g.coordinates.map((c: number[]) => `<Point><coordinates>${c[0]},${c[1]}</coordinates></Point>`).join("")}</MultiGeometry>`;
    case "MultiLineString":
      return `<MultiGeometry>${g.coordinates.map((c: number[][]) => `<LineString>${co(c)}</LineString>`).join("")}</MultiGeometry>`;
    case "MultiPolygon":
      return `<MultiGeometry>${g.coordinates.map(poly).join("")}</MultiGeometry>`;
    default:
      return "";
  }
}
export function toKml(fc: any, name: string): string {
  const pm = (fc?.features ?? [])
    .filter((f: any) => f.geometry)
    .map((f: any) => {
      const p = f.properties ?? {};
      const title = p.name ?? p.title ?? p.event ?? p.id ?? "";
      const data = Object.entries(p)
        .map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(typeof v === "object" ? JSON.stringify(v) : v)}</value></Data>`)
        .join("");
      return `<Placemark><name>${xml(title)}</name><ExtendedData>${data}</ExtendedData>${kmlGeom(f.geometry)}</Placemark>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(name)}</name>\n${pm}\n</Document></kml>\n`;
}

const MIME: Record<string, string> = { csv: "text/csv", geojson: "application/geo+json", kml: "application/vnd.google-earth.kml+xml", nc: "application/x-netcdf", png: "image/png", svg: "image/svg+xml" };

export async function exportOverlay(id: string, fmt: "csv" | "geojson" | "kml", via: "client" | "server" = "client") {
  const name = overlayDef(id)?.name ?? id;
  exportBusy.value = `${name} → ${fmt.toUpperCase()}`;
  try {
    let body: string | Blob;
    if (via === "server" && fmt !== "geojson") {
      const view = viewBbox();
      body = await serverBlob(`/api/ovl/${encodeURIComponent(id)}?format=${fmt}${overlayDef(id)?.view === "bbox" ? `&bbox=${view}` : ""}`);
    } else {
      const fc = await overlayData(id);
      if (!fc) throw new Error("layer has no data loaded (turn it on first)");
      body = fmt === "csv" ? toCsv(fc) : fmt === "kml" ? toKml(fc, name) : JSON.stringify(fc);
    }
    await done(await saveFile(`${safe(name)}_${stamp()}.${fmt}`, body, MIME[fmt]));
  } catch (e: any) {
    toast(`Export failed: ${e.message}`, "error");
  } finally {
    exportBusy.value = "";
  }
}

// ---------- server exports ----------
async function serverBlob(path: string): Promise<Blob> {
  if (!api.base) throw new Error("no server");
  const r = await fetch(api.base + path, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* binary */
    }
    throw new Error(r.status === 404 ? `not supported by this server (${path.split("?")[0]})` : `${r.status} ${msg}`);
  }
  return r.blob();
}
export function viewBbox(): string {
  const b = mapRef.value?.getBounds();
  return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(4)).join(",") : "";
}
async function done(f: string | null) {
  if (f) toast(`Saved ${f}`);
}

/** the gridded frame on screen */
export function gridFrameNow() {
  const w = settings.value.weather;
  if (w.kind !== "grid") return null;
  const fs = gridFrames.value;
  const f = fs[Math.min(frameIndex.value, fs.length - 1)];
  return f ? { layer: w.id, key: f.key, time: f.time, name: gridDef(w.id)?.name ?? w.id } : null;
}
export async function exportGrid(fmt: "csv" | "geojson" | "nc", area: "view" | "full") {
  const g = gridFrameNow();
  if (!g) return toast("No gridded frame on screen", "warn");
  exportBusy.value = `${g.name} → ${fmt === "nc" ? "NetCDF" : fmt.toUpperCase()}`;
  try {
    const q = `layer=${encodeURIComponent(g.layer)}&key=${encodeURIComponent(g.key)}&format=${fmt}${area === "view" ? `&bbox=${viewBbox()}` : ""}${gridExtraQ()}`;
    const b = await serverBlob(`/api/grid/export?${q}`);
    const t = new Date(g.time).toISOString().slice(0, 16).replace(/-/g, "").replace("T", "_").replace(":", "");
    await done(await saveFile(`${safe(g.name)}_${t}.${fmt}`, b, MIME[fmt]));
  } catch (e: any) {
    toast(`Export failed: ${e.message}`, "error");
  } finally {
    exportBusy.value = "";
  }
}

/** the Level II sweep on screen: volume key, tilt index and moment (from the sweep's cache key) */
export function radarSweepNow() {
  const r = settings.value.radar;
  if (settings.value.weather.kind !== "radar" || r.source !== "L2") return null;
  const s = currentFrame.value?.sweep;
  if (!s) return null;
  const parts = s.key.split("|");
  if (parts.length < 3) return null;
  const moment = parts[parts.length - 1].split("&")[0];
  const tilt = +parts[parts.length - 2];
  const key = parts.slice(0, -2).join("|");
  return { key, tilt, moment, site: r.site, time: s.start, elev: s.elevation };
}
export async function exportRadarNc() {
  const s = radarSweepNow();
  if (!s) return toast("Show a Level II radar sweep first", "warn");
  exportBusy.value = `${s.site} ${s.moment} → NetCDF`;
  try {
    const b = await serverBlob(`/api/radar/sweep.nc?key=${encodeURIComponent(s.key)}&tilt=${s.tilt}&moment=${s.moment}`);
    const t = new Date(s.time).toISOString().slice(0, 19).replace(/[-:T]/g, "");
    await done(await saveFile(`${s.site}_${t}_${s.moment}_${s.elev.toFixed(1)}deg.nc`, b, MIME.nc));
  } catch (e: any) {
    toast(`Export failed: ${e.message}`, "error");
  } finally {
    exportBusy.value = "";
  }
}

// ---------- images ----------
export interface CanvasItem {
  id: string;
  name: string;
  svg: boolean;
  canvas: () => HTMLCanvasElement | null;
}
/** charts and panels on screen that can be saved as images */
export function canvasItems(): CanvasItem[] {
  const out: CanvasItem[] = [];
  const xs = document.querySelector<HTMLCanvasElement>(".xs-panel canvas");
  if (xs) out.push({ id: "xsect", name: "Cross-section", svg: false, canvas: () => document.querySelector<HTMLCanvasElement>(".xs-panel canvas") });
  for (const [id, c] of chartRegistry) if (c.el.isConnected) out.push({ id: `chart:${id}`, name: `Chart · ${c.title || "untitled"}`, svg: true, canvas: () => (c.el.isConnected ? c.el : null) });
  const sk = document.querySelector<HTMLCanvasElement>(".skewt canvas, .snd-skewt canvas");
  if (sk) out.push({ id: "skewt", name: "Skew-T", svg: false, canvas: () => document.querySelector<HTMLCanvasElement>(".skewt canvas, .snd-skewt canvas") });
  return out;
}
export async function exportCanvas(it: CanvasItem, fmt: "png" | "svg") {
  try {
    if (fmt === "svg") {
      const id = it.id.replace(/^chart:/, "");
      const svg = chartSvg(id);
      if (!svg) throw new Error("SVG not available for this item");
      return done(await saveFile(`${safe(it.name)}_${stamp()}.svg`, svg, MIME.svg));
    }
    const c = it.canvas();
    if (!c) throw new Error("not on screen any more");
    const b = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (!b) throw new Error("couldn't read the canvas");
    await done(await saveFile(`${safe(it.name)}_${stamp()}.png`, b, MIME.png));
  } catch (e: any) {
    toast(`Export failed: ${e.message}`, "error");
  }
}

(window as any).__tbwExport = { exportOpen, openExport, canvasItems, exportOverlay, overlayData, toCsv, toKml, exportGrid, exportRadarNc, exportCanvas }; // console / screenshots
