// radar 0.6: dual-pol hail. Two layers, both computed client-side from Level II:
//  - "Hail (dual-pol)": HSDA-like size classes at the lowest tilt, clustered per storm, with the
//    storm's MESH (from the whole volume: SHI integrated above the 0 °C level, MESH = 2.54·SHI^0.5).
//  - "Hail swath (loop)": max MESH per ~1 km cell over the loop's volumes, drawn as an image source.
// Melting level: nearest model sounding (0 °C / -20 °C heights), else 3.5 km.

import { effect, signal } from "@preact/signals";
import type { LayerSpecification } from "maplibre-gl";
import { settings } from "../store";
import { setData, ovlStatus } from "../overlays/manager";
import { currentFrame, frames, playing } from "./controller";
import { volMeta, sweepAt, tiltsWith, analysisWorker, wsweep, xyToLL, freezingLevels, type Levels } from "./r6data";
import { HAIL_LABEL, HAIL_COLOR, meshColor, mmToIn, MESH_STOPS } from "./hailfuzzy";
import { mapRef } from "../map/mapview";
import type { Style, Popup } from "../overlays/defs";

const EMPTY = { type: "FeatureCollection", features: [] as any[] };
const on = (id: string) => !!settings.value.ovl[id]?.on;
const status = (id: string, s: { loading?: boolean; error?: string; count?: number; note?: string }) => (ovlStatus.value = { ...ovlStatus.value, [id]: s });

export interface MeshGrid {
  key: string;
  site: string;
  t: number;
  W: number;
  H: number;
  bounds: [number, number, number, number];
  mesh: Float32Array;
  levels: Levels;
}

// ---------- MESH per volume ----------
const meshCache = new Map<string, Promise<MeshGrid>>();
export const meshReady = new Map<string, MeshGrid>();

export function meshFor(key: string): Promise<MeshGrid> {
  let p = meshCache.get(key);
  if (p) return p;
  p = (async () => {
    const meta = await volMeta(key);
    const tl = tiltsWith(meta, "REF");
    if (tl.length < 3) throw new Error("volume has too few tilts for MESH");
    const levels = await freezingLevels(meta.lat, meta.lon);
    // fetch a few tilts at a time
    const refs: any[] = new Array(tl.length);
    let i = 0;
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        while (i < tl.length) {
          const k = i++;
          refs[k] = await sweepAt(key, tl[k].index, "REF");
        }
      }),
    );
    const s0 = refs[0];
    const r = await analysisWorker.run<{ W: number; H: number; bounds: [number, number, number, number]; mesh: Float32Array }>("mesh", {
      refs: refs.map(wsweep),
      h0: levels.h0,
      hm20: levels.hm20,
      radarH: s0.height,
      lat0: s0.lat,
      lon0: s0.lon,
      rangeKm: 230,
      res: 1,
    });
    const g: MeshGrid = { key, site: meta.site, t: meta.time, ...r, levels };
    meshReady.set(key, g);
    if (meshReady.size > 60) meshReady.delete(meshReady.keys().next().value!);
    return g;
  })();
  meshCache.set(key, p);
  p.catch(() => meshCache.delete(key));
  if (meshCache.size > 60) meshCache.delete(meshCache.keys().next().value!);
  return p;
}

/** MESH (mm) at a point from a grid (NaN outside). */
export function meshAt(g: MeshGrid, lat: number, lon: number): number {
  const [w, s, e, n] = g.bounds;
  if (lon < w || lon > e || lat < s || lat > n) return NaN;
  const my = (la: number) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));
  const i = Math.floor(((lon - w) / (e - w)) * g.W);
  const j = Math.floor(((my(n) - my(lat)) / (my(n) - my(s))) * g.H);
  if (i < 0 || j < 0 || i >= g.W || j >= g.H) return NaN;
  return g.mesh[j * g.W + i];
}

// ---------- Hail (dual-pol): HSDA clusters + MESH ----------
export interface HailCell {
  lat: number;
  lon: number;
  cls: 1 | 2 | 3;
  cnt: number[];
  zmax: number;
  mesh: number;
  poly: [number, number][];
}
export const hailCells = signal<{ key: string; cells: HailCell[]; levels?: Levels } | null>(null);
const hsdaCache = new Map<string, { cells: HailCell[]; levels: Levels }>();
let inflight = "";
let debounce: number | undefined;
let played = 0;

async function computeHail(key: string) {
  const meta = await volMeta(key);
  const t = meta.tilts.filter((x) => x.moments.includes("REF") && x.moments.includes("ZDR") && x.moments.includes("RHO")).sort((a, b) => a.angle - b.angle || a.index - b.index)[0];
  if (!t) throw new Error("no dual-pol tilt in this volume");
  const [ref, zdr, rho] = await Promise.all(["REF", "ZDR", "RHO"].map((m) => sweepAt(key, t.index, m)));
  const levels = await freezingLevels(meta.lat, meta.lon);
  const [cl, mg] = await Promise.all([analysisWorker.run<any[]>("hsda", { ref: wsweep(ref), zdr: wsweep(zdr), rho: wsweep(rho), h0: levels.h0, maxRange: 200 }), meshFor(key).catch(() => null)]);
  const cells: HailCell[] = cl.map((c) => {
    const poly = c.hull.map(([x, y]: [number, number]) => xyToLL(ref.lat, ref.lon, x, y));
    let mesh = NaN;
    if (mg) {
      // max MESH over the cluster's bounding box (+2 km)
      const xs = poly.map((p: number[]) => p[0]), ys = poly.map((p: number[]) => p[1]);
      const pad = 0.02;
      for (let la = Math.min(...ys) - pad; la <= Math.max(...ys) + pad; la += 0.009)
        for (let lo = Math.min(...xs) - pad; lo <= Math.max(...xs) + pad; lo += 0.011) {
          const v = meshAt(mg, la, lo);
          if (v > (mesh || 0) || Number.isNaN(mesh)) mesh = Number.isNaN(v) ? mesh : v;
        }
    }
    const [lon, lat] = xyToLL(ref.lat, ref.lon, c.mx, c.my);
    return { lat, lon, cls: c.cls, cnt: c.cnt, zmax: c.zmax, mesh, poly };
  });
  return { cells: cells.sort((a, b) => b.cls - a.cls || (b.mesh || 0) - (a.mesh || 0)), levels };
}

function hailFc(cells: HailCell[]) {
  const feats: any[] = [];
  for (const c of cells) {
    const msh = Number.isFinite(c.mesh) && c.mesh > 0 ? mmToIn(c.mesh) : NaN;
    const props = { cls: c.cls, cnt: c.cnt.join(","), zmax: c.zmax, mesh: c.mesh, _col: HAIL_COLOR[c.cls], _lbl: `${HAIL_LABEL[c.cls]}${Number.isFinite(msh) && msh >= 0.25 ? ` · MESH ${msh.toFixed(2)}″` : ""}` };
    if (c.poly.length >= 3) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...c.poly, c.poly[0]]] }, properties: props });
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: props });
  }
  return { type: "FeatureCollection", features: feats };
}

function showHail(key: string) {
  const r = hsdaCache.get(key);
  if (!r) return;
  hailCells.value = { key, ...r };
  setData("hail", hailFc(r.cells));
  const big = r.cells.filter((c) => c.cls >= 2).length;
  status("hail", { count: r.cells.length, note: r.cells.length ? `${r.cells.length} cells${big ? ` · ${big} ≥ 1 in` : ""} · 0 °C ${(r.levels.h0 / 1000).toFixed(1)} km` : "No hail" });
}

async function loadHail(key: string) {
  if (inflight === key) return;
  inflight = key;
  status("hail", { ...ovlStatus.value.hail, loading: true, error: undefined });
  try {
    const r = await computeHail(key);
    hsdaCache.set(key, r);
    if (hsdaCache.size > 40) hsdaCache.delete(hsdaCache.keys().next().value!);
    if (on("hail") && currentFrame.value?.key === key) showHail(key);
  } catch (e: any) {
    if (currentFrame.value?.key === key) status("hail", { error: e.message });
  } finally {
    if (inflight === key) inflight = "";
  }
}

effect(() => {
  const active = on("hail");
  const src = settings.value.radar.source;
  const key = currentFrame.value?.key ?? "";
  const play = playing.value;
  clearTimeout(debounce);
  if (!active) {
    hailCells.value = null;
    return;
  }
  if (src !== "L2") {
    setData("hail", EMPTY);
    status("hail", { note: "Level II only" });
    return;
  }
  if (!key) return;
  if (hsdaCache.has(key)) return showHail(key);
  if (play) {
    if (++played % 4 === 0 && !inflight) loadHail(key);
    return;
  }
  debounce = window.setTimeout(() => loadHail(key), 450);
});

export function hailLayers(s: string, st: Style): LayerSpecification[] {
  return [
    { id: `${s}-fill`, type: "fill", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": ["get", "_col"], "fill-opacity": 0.25 * st.opacity } } as LayerSpecification,
    { id: `${s}-line`, type: "line", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": ["get", "_col"], "line-width": 2 * st.size, "line-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-pt`, type: "circle", source: s, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["match", ["get", "cls"], 3, 7, 2, 6, 4.5], "circle-color": ["get", "_col"], "circle-stroke-color": "#000", "circle-stroke-width": 1.4, "circle-opacity": st.opacity } } as LayerSpecification,
    ...(st.labels
      ? [{ id: `${s}-text`, type: "symbol", source: s, filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": ["get", "_lbl"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true }, paint: { "text-color": ["get", "_col"], "text-halo-color": "#000", "text-halo-width": 1.5 } } as LayerSpecification]
      : []),
  ];
}

export function hailClick(p: any): Popup {
  const cnt = String(p.cnt ?? "0,0,0,0").split(",").map(Number);
  const m = +p.mesh;
  const lv = hailCells.value?.levels;
  return {
    title: `Hail ${HAIL_LABEL[+p.cls]} (dual-pol)`,
    sub: "HSDA-style classification at the lowest tilt",
    color: HAIL_COLOR[+p.cls],
    rows: [
      ["MESH (volume)", Number.isFinite(m) && m > 0 ? `${mmToIn(m).toFixed(2)} in (${Math.round(m)} mm)` : "—"],
      ["Max reflectivity", `${Math.round(+p.zmax)} dBZ`],
      ["Gates small / large / giant", `${cnt[1] ?? 0} / ${cnt[2] ?? 0} / ${cnt[3] ?? 0}`],
      ["0 °C / -20 °C", lv ? `${(lv.h0 / 1000).toFixed(1)} / ${(lv.hm20 / 1000).toFixed(1)} km (${lv.src})` : "—"],
    ],
    text: "Estimated from reflectivity, ZDR and CC vs the melting level (fuzzy logic) and from the reflectivity volume (MESH). Use as guidance.",
  };
}

// ---------- Hail swath (loop) ----------
const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let swathUrl = BLANK;
let swathCoords: [number, number][] = [
  [-100, 36],
  [-99.99, 36],
  [-99.99, 35.99],
  [-100, 35.99],
];
export const swathInfo = signal<{ frames: number; total: number; maxIn: number; busy: boolean } | null>(null);
/** current swath max grid (for the inspector) */
export let swathGrid: MeshGrid | null = null;

export function swathSource() {
  return { type: "image", url: swathUrl, coordinates: swathCoords };
}

function paintSwath(g: MeshGrid) {
  const c = document.createElement("canvas");
  c.width = g.W;
  c.height = g.H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(g.W, g.H);
  let mx = 0;
  for (let i = 0; i < g.mesh.length; i++) {
    const v = g.mesh[i];
    if (v > mx) mx = v;
    const col = meshColor(v);
    if (!col) continue;
    img.data[i * 4] = col[0];
    img.data[i * 4 + 1] = col[1];
    img.data[i * 4 + 2] = col[2];
    img.data[i * 4 + 3] = 215;
  }
  ctx.putImageData(img, 0, 0);
  const [w, s, e, n] = g.bounds;
  swathUrl = c.toDataURL("image/png");
  swathCoords = [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ];
  const src: any = mapRef.value?.getSource("o-hailswath");
  src?.updateImage?.({ url: swathUrl, coordinates: swathCoords });
  return mx;
}

let swGen = 0;
let swSig = "";
async function buildSwath() {
  const gen = ++swGen;
  const keys = frames.value.map((f) => f.key);
  const upTo = (settings.value.ovl.hailswath?.opts?.span ?? "loop") === "upto";
  const cur = currentFrame.value?.key;
  const want = upTo && cur ? keys.slice(0, keys.indexOf(cur) + 1) : keys;
  let acc: MeshGrid | null = null;
  let n = 0;
  swathInfo.value = { frames: 0, total: want.length, maxIn: 0, busy: true };
  status("hailswath", { loading: true, note: `0/${want.length} volumes` });
  // newest first so the most recent hail shows up quickly
  for (const k of [...want].reverse()) {
    if (gen !== swGen || !on("hailswath")) return;
    let g: MeshGrid;
    try {
      g = await meshFor(k);
    } catch {
      continue;
    }
    if (gen !== swGen) return;
    if (!acc) acc = { ...g, key: "swath", mesh: g.mesh.slice() };
    else if (acc.W === g.W && Math.abs(acc.bounds[0] - g.bounds[0]) < 1e-6 && Math.abs(acc.bounds[1] - g.bounds[1]) < 1e-6) {
      const a = acc.mesh, b = g.mesh;
      for (let i = 0; i < a.length; i++) if (b[i] > a[i] || (Number.isNaN(a[i]) && !Number.isNaN(b[i]))) a[i] = b[i];
    } else continue; // a different radar
    n++;
    // repaint every couple of volumes
    if (n <= 2 || n % 3 === 0 || n === want.length) {
      const mx = paintSwath(acc);
      swathGrid = acc;
      swathInfo.value = { frames: n, total: want.length, maxIn: mmToIn(mx), busy: n < want.length };
      status("hailswath", { loading: n < want.length, note: `${n}/${want.length} volumes · max ${mmToIn(mx).toFixed(2)} in` });
    }
  }
  if (gen !== swGen) return;
  if (acc) {
    const mx = paintSwath(acc);
    swathGrid = acc;
    swathInfo.value = { frames: n, total: want.length, maxIn: mmToIn(mx), busy: false };
    status("hailswath", { count: n, note: `${n} volumes · max ${mmToIn(mx).toFixed(2)} in` });
  } else {
    swathInfo.value = null;
    status("hailswath", { note: "No Level II volumes" });
  }
}

let swTimer: number | undefined;
effect(() => {
  const active = on("hailswath");
  const src = settings.value.radar.source;
  const keys = frames.value.map((f) => f.key).join(",");
  const upTo = (settings.value.ovl.hailswath?.opts?.span ?? "loop") === "upto";
  const cur = upTo ? currentFrame.value?.key ?? "" : "";
  const play = playing.value;
  if (!active) {
    swGen++;
    swSig = "";
    swathGrid = null;
    swathInfo.value = null;
    return;
  }
  if (src !== "L2") {
    status("hailswath", { note: "Level II only" });
    return;
  }
  const sig = `${keys}|${cur}`;
  if (sig === swSig || (play && upTo && swSig)) return;
  swSig = sig;
  clearTimeout(swTimer);
  swTimer = window.setTimeout(buildSwath, 600);
});

export function swathLayers(s: string, st: Style): LayerSpecification[] {
  return [{ id: `${s}-r`, type: "raster", source: s, paint: { "raster-opacity": 0.8 * st.opacity, "raster-fade-duration": 0, "raster-resampling": "nearest" } } as LayerSpecification];
}

export const SWATH_LEGEND = MESH_STOPS.map(([mm, c]) => [`${mmToIn(mm).toFixed(2)}″`, `rgb(${c.join(",")})`]);
