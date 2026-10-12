// Drawing groups ⇄ GeoJSON (team rooms, share links). One drawing (group) becomes one
// FeatureCollection; every shape keeps its style in `properties` so it round-trips exactly.

import type { Drawing } from "../map/draw";

export type FC = { type: "FeatureCollection"; features: any[] };

const KINDS = new Set(["free", "line", "arrow", "rect", "circle", "poly", "text"]);
const num = (v: any, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const pt = (c: any): [number, number] | null => (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [+c[0], +c[1]] : null);

/** Drawing shapes → a FeatureCollection (polygons closed, arrow heads in properties). */
export function drawingsToGeoJSON(list: Drawing[]): FC {
  const features: any[] = [];
  for (const d of list) {
    const props: any = { id: d.id, kind: d.kind, color: d.color, width: d.width, fill: !!d.fill };
    if (d.text) props.text = d.text;
    if (d.group) props.group = d.group;
    if (d.head) props.head = d.head;
    let geometry: any;
    if (d.kind === "text") geometry = { type: "Point", coordinates: d.coords[0] };
    else if ((d.kind === "rect" || d.kind === "circle" || d.kind === "poly") && d.coords.length >= 3) geometry = { type: "Polygon", coordinates: [[...d.coords, d.coords[0]]] };
    else geometry = { type: "LineString", coordinates: d.coords };
    if (!geometry.coordinates || (geometry.type !== "Point" && geometry.coordinates.length < 2)) continue;
    features.push({ type: "Feature", properties: props, geometry });
  }
  return { type: "FeatureCollection", features };
}

/** A FeatureCollection (ours or any simple GeoJSON) → drawing shapes in `group`. */
export function geoJSONToDrawings(fc: any, group: string, uid: () => string): Drawing[] {
  const out: Drawing[] = [];
  const feats: any[] = fc?.type === "FeatureCollection" && Array.isArray(fc.features) ? fc.features : fc?.type === "Feature" ? [fc] : [];
  for (const f of feats.slice(0, 2000)) {
    const g = f?.geometry;
    const p = f?.properties ?? {};
    if (!g) continue;
    const base = { color: typeof p.color === "string" ? p.color : "#ff3b30", width: num(p.width, 3), fill: !!p.fill, group };
    let kind = KINDS.has(p.kind) ? p.kind : null;
    if (g.type === "Point") {
      const c = pt(g.coordinates);
      if (c) out.push({ ...base, id: uid(), kind: "text", coords: [c], text: String(p.text ?? p.name ?? "•").slice(0, 200) });
    } else if (g.type === "LineString") {
      const coords = (g.coordinates as any[]).map(pt).filter(Boolean) as [number, number][];
      if (coords.length < 2) continue;
      const head = Array.isArray(p.head) ? ((p.head as any[]).map(pt).filter(Boolean) as [number, number][]) : undefined;
      out.push({ ...base, id: uid(), kind: kind === "free" || kind === "arrow" ? kind : "line", coords, ...(head && head.length >= 3 ? { head } : {}) });
    } else if (g.type === "Polygon") {
      const ring = ((g.coordinates?.[0] ?? []) as any[]).map(pt).filter(Boolean) as [number, number][];
      if (ring.length >= 4) ring.pop(); // drop the closing point
      if (ring.length < 3) continue;
      out.push({ ...base, id: uid(), kind: kind === "rect" || kind === "circle" ? kind : "poly", coords: ring });
    } else if (g.type === "MultiLineString" || g.type === "MultiPolygon") {
      const parts = g.type === "MultiLineString" ? g.coordinates : g.coordinates.map((poly: any) => poly[0]);
      for (const part of parts ?? []) {
        const geometry = g.type === "MultiLineString" ? { type: "LineString", coordinates: part } : { type: "Polygon", coordinates: [part] };
        out.push(...geoJSONToDrawings({ type: "Feature", properties: p, geometry }, group, uid));
      }
    }
  }
  return out;
}

/** Shapes grouped by drawing (session) id. */
export function groupDrawings(list: Drawing[]): Map<string, Drawing[]> {
  const m = new Map<string, Drawing[]>();
  for (const d of list) {
    const g = d.group ?? d.id;
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(d);
  }
  return m;
}

/** GeoJSON ready for map layers: arrow heads become filled polygons; `owner` colours text halos. */
export function renderable(fc: FC, extra: Record<string, any> = {}): any[] {
  const out: any[] = [];
  for (const f of fc.features ?? []) {
    const p = { ...f.properties, ...extra, fill: f.properties?.fill ? 1 : 0, text: f.properties?.text ?? "" };
    out.push({ type: "Feature", properties: p, geometry: f.geometry });
    if (Array.isArray(f.properties?.head) && f.properties.head.length >= 3) {
      out.push({ type: "Feature", properties: { ...p, fill: 1, head: 1 }, geometry: { type: "Polygon", coordinates: [[...f.properties.head, f.properties.head[0]]] } });
    }
  }
  return out;
}
