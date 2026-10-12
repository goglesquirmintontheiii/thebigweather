// Detection models: picking things on the map while the window steps aside — radar sites for the
// runner (click sites to toggle) and a box for the training region (two corner clicks).

import { signal, effect } from "@preact/signals";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import { mapRef, mapClickHooks } from "../map/mapview";
import { sites } from "../radar/controller";

export type BBox = [number, number, number, number];
type Pick = { kind: "radars"; sel: string[]; done: (sel: string[] | null) => void } | { kind: "bbox"; pts: [number, number][]; done: (b: BBox | null) => void };
export const pickMode = signal<Pick | null>(null);

const SRC = "ml-pick";
export const usSites = () => sites.value.filter((s) => s.type === "NEXRAD" || s.type === "TDWR");

export function pickRadars(sel: string[]): Promise<string[] | null> {
  return new Promise((res) => (pickMode.value = { kind: "radars", sel: [...sel], done: res }));
}
export function pickBox(): Promise<BBox | null> {
  return new Promise((res) => (pickMode.value = { kind: "bbox", pts: [], done: res }));
}
export function finishPick(ok: boolean) {
  const p = pickMode.value;
  if (!p) return;
  pickMode.value = null;
  if (p.kind === "radars") p.done(ok ? p.sel : null);
  else {
    const [a, b] = p.pts;
    p.done(ok && a && b ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] : null);
  }
}
function toggleSite(id: string) {
  const p = pickMode.value;
  if (p?.kind !== "radars") return;
  const sel = p.sel.includes(id) ? p.sel.filter((x) => x !== id) : [...p.sel, id];
  pickMode.value = { ...p, sel };
}

mapClickHooks.push((e: MapMouseEvent) => {
  const p = pickMode.value;
  if (!p) return false;
  if (p.kind === "bbox") {
    const pts = p.pts.length >= 2 ? [] : [...p.pts];
    pts.push([e.lngLat.lng, e.lngLat.lat]);
    pickMode.value = { ...p, pts };
    return true;
  }
  const m = mapRef.value!;
  let best = "", bd = 16;
  for (const s of usSites()) {
    const q = m.project([s.lon, s.lat]);
    const d = Math.hypot(q.x - e.point.x, q.y - e.point.y);
    if (d < bd) (bd = d), (best = s.id);
  }
  if (best) toggleSite(best);
  return true;
});
// the radar-site markers (DOM buttons) would switch the radar: take their clicks while picking
document.addEventListener(
  "click",
  (e) => {
    if (pickMode.value?.kind !== "radars") return;
    const el = (e.target as HTMLElement)?.closest?.(".site-marker");
    if (!el) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggleSite((el.textContent ?? "").trim());
  },
  true,
);

function rect(a: [number, number], b: [number, number]) {
  return [[a, [b[0], a[1]], b, [a[0], b[1]], a]];
}
effect(() => {
  const m = mapRef.value;
  const p = pickMode.value;
  if (!m || !m.getStyle()) return;
  if (!p) {
    for (const l of ["ml-pick-fill", "ml-pick-line", "ml-pick-dot", "ml-pick-lbl"]) if (m.getLayer(l)) m.removeLayer(l);
    if (m.getSource(SRC)) m.removeSource(SRC);
    document.querySelectorAll(".site-marker.ml-picked").forEach((x) => x.classList.remove("ml-picked"));
    return;
  }
  const feats: any[] = [];
  if (p.kind === "radars") {
    for (const s of usSites()) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { id: s.id, on: p.sel.includes(s.id) ? 1 : 0, tdwr: s.type === "TDWR" ? 1 : 0 } });
    document.querySelectorAll<HTMLElement>(".site-marker").forEach((x) => x.classList.toggle("ml-picked", p.sel.includes((x.textContent ?? "").trim())));
  } else if (p.pts.length) {
    const [a, b] = p.pts;
    if (b) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: rect(a, b) }, properties: {} });
    for (const q of p.pts) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: q }, properties: { on: 1 } });
  }
  const fc = { type: "FeatureCollection", features: feats } as any;
  const src = m.getSource(SRC) as GeoJSONSource | undefined;
  if (src) return void src.setData(fc);
  m.addSource(SRC, { type: "geojson", data: fc });
  m.addLayer({ id: "ml-pick-fill", type: "fill", source: SRC, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#3fb7ff", "fill-opacity": 0.15 } });
  m.addLayer({ id: "ml-pick-line", type: "line", source: SRC, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": "#3fb7ff", "line-width": 2, "line-dasharray": [2, 1] } });
  m.addLayer({ id: "ml-pick-dot", type: "circle", source: SRC, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["case", ["==", ["get", "on"], 1], 7, 4.5], "circle-color": ["case", ["==", ["get", "on"], 1], "#3fb7ff", ["==", ["get", "tdwr"], 1], "#a78bfa", "#94a3b8"], "circle-stroke-color": ["case", ["==", ["get", "on"], 1], "#fff", "#000"], "circle-stroke-width": 1.5 } });
  m.addLayer({ id: "ml-pick-lbl", type: "symbol", source: SRC, filter: ["all", ["==", ["geometry-type"], "Point"], ["has", "id"]], minzoom: 4.5, layout: { "text-field": ["get", "id"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: { "text-color": ["case", ["==", ["get", "on"], 1], "#fff", "#cbd5e1"], "text-halo-color": "#000", "text-halo-width": 1.2 } });
});
