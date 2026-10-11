// Drawing mode: freehand, lines, arrows, rectangles, circles, polygons and text, anchored to
// map coordinates. Undo/redo, brush size and color, clear all, and optionally keep drawings
// after leaving drawing mode (each kept drawing gets an × to delete it).

import { signal, effect } from "@preact/signals";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import { settings, update, tool, uid } from "../store";
import { destination, distance } from "../util";

export type DrawKind = "free" | "line" | "arrow" | "rect" | "circle" | "poly" | "text" | "erase" | "pan";
export interface Drawing {
  id: string;
  kind: Exclude<DrawKind, "erase" | "pan">;
  /** LineString / Polygon ring / Point coordinates */
  coords: [number, number][];
  color: string;
  width: number;
  fill: boolean;
  text?: string;
  /** arrow head polygon */
  head?: [number, number][];
}

export const drawTool = signal<DrawKind>("free");
export const drawStyle = signal({ color: "#ff3b30", width: 3, fill: false });
export const drawings = signal<Drawing[]>([]);
export const textInput = signal<{ x: number; y: number; lng: number; lat: number } | null>(null);
const undoStack: Drawing[][] = [];
const redoStack: Drawing[][] = [];
export const canUndo = signal(false);
export const canRedo = signal(false);

let map: MLMap | null = null;
let preview: Drawing | null = null;
let active: Drawing | null = null;
let markers: maplibregl.Marker[] = [];
const EMPTY = { type: "FeatureCollection", features: [] } as any;

export const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#0a84ff", "#bf5af2", "#ffffff", "#111111"];

function commit(next: Drawing[]) {
  undoStack.push(drawings.value);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  drawings.value = next;
  canUndo.value = true;
  canRedo.value = false;
  persist();
}

export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(drawings.value);
  drawings.value = prev;
  canUndo.value = undoStack.length > 0;
  canRedo.value = true;
  persist();
}

export function redo() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(drawings.value);
  drawings.value = next;
  canUndo.value = true;
  canRedo.value = redoStack.length > 0;
  persist();
}

export function clearAll() {
  if (drawings.value.length) commit([]);
}

function persist() {
  // kept drawings live in settings so they survive restarts
  if (settings.value.drawKeep) update((s) => (s.drawings = drawings.value));
}

function toFeatures(list: Drawing[]): any[] {
  const out: any[] = [];
  for (const d of list) {
    const p = { id: d.id, color: d.color, width: d.width, fill: d.fill ? 1 : 0, kind: d.kind, text: d.text ?? "" };
    if (d.kind === "text") out.push({ type: "Feature", properties: p, geometry: { type: "Point", coordinates: d.coords[0] } });
    else if (d.kind === "rect" || d.kind === "circle" || d.kind === "poly") {
      if (d.coords.length >= 3) out.push({ type: "Feature", properties: p, geometry: { type: "Polygon", coordinates: [[...d.coords, d.coords[0]]] } });
      else if (d.coords.length === 2) out.push({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: d.coords } });
    } else if (d.coords.length >= 2) out.push({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: d.coords } });
    if (d.head) out.push({ type: "Feature", properties: { ...p, fill: 1, head: 1 }, geometry: { type: "Polygon", coordinates: [[...d.head, d.head[0]]] } });
  }
  return out;
}

function render() {
  const src = map?.getSource("draw") as GeoJSONSource | undefined;
  if (!src) return;
  const list = [...drawings.value, ...(preview ? [preview] : [])];
  src.setData({ type: "FeatureCollection", features: toFeatures(list) } as any);
  refreshMarkers();
}

/** Delete buttons on kept drawings (only outside drawing mode). */
function refreshMarkers() {
  for (const m of markers) m.remove();
  markers = [];
  if (!map || tool.value === "draw") return;
  for (const d of drawings.value) {
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of d.coords) {
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(maxX)) continue;
    const el = document.createElement("button");
    el.className = "draw-x";
    el.title = "Delete drawing";
    el.textContent = "×";
    el.onclick = (e) => {
      e.stopPropagation();
      commit(drawings.value.filter((x) => x.id !== d.id));
    };
    markers.push(new maplibregl.Marker({ element: el, anchor: "bottom-left", offset: [4, -4] }).setLngLat([maxX, maxY]).addTo(map));
  }
}

export function addDrawLayers(m: MLMap) {
  if (m.getSource("draw")) return;
  m.addSource("draw", { type: "geojson", data: EMPTY });
  const isPoly: any = ["==", ["geometry-type"], "Polygon"];
  m.addLayer({ id: "draw-fill", type: "fill", source: "draw", filter: ["all", isPoly, ["==", ["get", "fill"], 1]], paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["==", ["get", "head"], 1], 1, 0.22] } });
  m.addLayer({
    id: "draw-line",
    type: "line",
    source: "draw",
    filter: ["all", ["!=", ["geometry-type"], "Point"], ["!=", ["get", "head"], 1]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": ["get", "width"] },
  });
  m.addLayer({
    id: "draw-text",
    type: "symbol",
    source: "draw",
    filter: ["==", ["geometry-type"], "Point"],
    layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Bold"], "text-size": ["+", 10, ["*", 2, ["get", "width"]]], "text-allow-overlap": true },
    paint: { "text-color": ["get", "color"], "text-halo-color": "rgba(0,0,0,.85)", "text-halo-width": 1.6 },
  });
  render();
}

function ll(e: MapMouseEvent): [number, number] {
  return [e.lngLat.lng, e.lngLat.lat];
}

function shape(kind: Drawing["kind"], a: [number, number], b: [number, number]): [number, number][] {
  if (kind === "rect") return [a, [b[0], a[1]], b, [a[0], b[1]]];
  if (kind === "circle") {
    const r = distance(a[1], a[0], b[1], b[0]);
    return Array.from({ length: 72 }, (_, i) => destination(a[1], a[0], (i / 72) * 360, r));
  }
  return [a, b];
}

/** Arrow head as a small triangle sized in screen pixels at the current zoom. */
function arrowHead(a: [number, number], b: [number, number], width: number): [number, number][] | undefined {
  if (!map) return;
  const pa = map.project(a);
  const pb = map.project(b);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  const ux = dx / len;
  const uy = dy / len;
  const L = 10 + width * 3;
  const W = 6 + width * 1.8;
  const base = { x: pb.x - ux * L, y: pb.y - uy * L };
  const p1 = map.unproject([base.x - uy * W, base.y + ux * W]);
  const p2 = map.unproject([base.x + uy * W, base.y - ux * W]);
  return [b, [p1.lng, p1.lat], [p2.lng, p2.lat]];
}

let down = false;
let start: [number, number] | null = null;

function onDown(e: MapMouseEvent) {
  if (tool.value !== "draw" || (e.originalEvent as MouseEvent).button !== 0) return;
  const t = drawTool.value;
  if (t === "pan" || t === "poly" || t === "text") return;
  e.preventDefault();
  if (t === "erase") {
    const f = map!.queryRenderedFeatures(e.point, { layers: ["draw-fill", "draw-line", "draw-text"] })[0];
    if (f) commit(drawings.value.filter((x) => x.id !== f.properties.id));
    return;
  }
  down = true;
  start = ll(e);
  const st = drawStyle.value;
  preview = { id: uid(), kind: t, coords: [start], color: st.color, width: st.width, fill: st.fill };
}

function onMove(e: MapMouseEvent) {
  if (tool.value !== "draw") return;
  const t = drawTool.value;
  if (t === "poly" && active) {
    preview = { ...active, coords: [...active.coords, ll(e)] };
    render();
    return;
  }
  if (!down || !preview || !start) return;
  const p = ll(e);
  if (t === "free") {
    // keep points a couple of pixels apart
    const last = preview.coords[preview.coords.length - 1];
    const a = map!.project(last);
    if (Math.hypot(a.x - e.point.x, a.y - e.point.y) < 2) return;
    preview = { ...preview, coords: [...preview.coords, p] };
  } else {
    preview = { ...preview, coords: shape(t as Drawing["kind"], start, p), head: t === "arrow" ? arrowHead(start, p, preview.width) : undefined };
  }
  render();
}

function onUp() {
  if (!down) return;
  down = false;
  const d = preview;
  preview = null;
  start = null;
  if (d && d.coords.length >= 2) commit([...drawings.value, d]);
  else render();
}

function onClick(e: MapMouseEvent) {
  if (tool.value !== "draw") return;
  const t = drawTool.value;
  if (t === "poly") {
    const st = drawStyle.value;
    active = active ? { ...active, coords: [...active.coords, ll(e)] } : { id: uid(), kind: "poly", coords: [ll(e)], color: st.color, width: st.width, fill: st.fill };
    preview = active;
    render();
  } else if (t === "text") {
    textInput.value = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat };
  }
}

export function finishPoly() {
  if (active && active.coords.length >= 3) commit([...drawings.value, active]);
  active = null;
  preview = null;
  render();
}

export function addText(text: string) {
  const t = textInput.value;
  textInput.value = null;
  if (!t || !text.trim()) return;
  const st = drawStyle.value;
  commit([...drawings.value, { id: uid(), kind: "text", coords: [[t.lng, t.lat]], color: st.color, width: st.width, fill: false, text: text.trim() }]);
}

export function attachDraw(m: MLMap) {
  map = m;
  drawings.value = settings.value.drawings ?? [];
  m.on("style.load", () => addDrawLayers(m));
  if (m.isStyleLoaded()) addDrawLayers(m);
  m.on("mousedown", onDown);
  m.on("mousemove", onMove);
  m.on("mouseup", onUp);
  m.on("click", onClick);
  m.on("dblclick", (e) => {
    if (tool.value === "draw" && drawTool.value === "poly") {
      e.preventDefault();
      finishPoly();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (tool.value !== "draw" || (e.target as HTMLElement)?.tagName === "INPUT") return;
    if (e.key === "Enter") finishPoly();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") (e.shiftKey ? redo() : undo(), e.preventDefault(), e.stopPropagation());
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") (redo(), e.preventDefault(), e.stopPropagation());
  }, true);
}

// map interactions follow the tool: drawing tools take the left mouse button
effect(() => {
  const on = tool.value === "draw";
  const t = drawTool.value;
  if (!map) return;
  const drawing = on && t !== "pan";
  if (drawing) {
    map.dragPan.disable();
    map.doubleClickZoom.disable();
  } else {
    map.dragPan.enable();
    map.doubleClickZoom.enable();
  }
  map.getCanvas().style.cursor = drawing ? (t === "erase" ? "not-allowed" : t === "text" ? "text" : "crosshair") : "";
  if (!on) {
    active = null;
    preview = null;
    // leaving drawing mode: keep or drop the drawings
    if (!settings.value.drawKeep && drawings.value.length) {
      drawings.value = [];
      undoStack.length = 0;
      redoStack.length = 0;
      canUndo.value = canRedo.value = false;
    }
  }
  render();
});

effect(() => {
  void drawings.value;
  render();
});

export function setKeep(v: boolean) {
  update((s) => {
    s.drawKeep = v;
    s.drawings = v ? drawings.value : [];
  });
}
