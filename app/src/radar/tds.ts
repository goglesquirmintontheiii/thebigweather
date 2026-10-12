// radar 0.6: tornado debris signature (TDS) detection for the Level II volume on screen.
// Lowest 1–2 tilts: CC < ~0.80, |ZDR| ≤ ~1 dB, REF ≥ ~35 dBZ, within ~2 km of a velocity couplet from
// the server's rotation detector. Gates are clustered in a worker; clusters become "Possible debris"
// polygons with a confidence score. Runs only while the "Debris signatures (TDS)" layer is on.

import { effect, signal } from "@preact/signals";
import type { LayerSpecification } from "maplibre-gl";
import { settings } from "../store";
import { setData, ovlStatus } from "../overlays/manager";
import { currentFrame, playing } from "./controller";
import { volMeta, sweepAt, rotationFor, analysisWorker, wsweep, llToXY, xyToLL } from "./r6data";
import { addAnim, wakeTicker } from "../overlays/ticker";
import { speedFactor } from "../util";
import type { Style, Popup } from "../overlays/defs";

const EMPTY = { type: "FeatureCollection", features: [] as any[] };
const on = () => !!settings.value.ovl.tds?.on;
const status = (s: { loading?: boolean; error?: string; count?: number; note?: string }) => (ovlStatus.value = { ...ovlStatus.value, tds: s });

export interface TdsHit {
  lat: number;
  lon: number;
  conf: number;
  ccMin: number;
  ccMean: number;
  zdr: number;
  ref: number;
  vrot: number | null;
  kind: string | null;
  tilts: number;
  n: number;
  hkm: number;
  poly: [number, number][];
  site: string;
  t: number;
}
/** detections for the frame on screen (also read by the inspector and the rules engine) */
export const tdsHits = signal<{ key: string; hits: TdsHit[] } | null>(null);

const cache = new Map<string, TdsHit[]>();
let inflight = "";
let debounce: number | undefined;
let playedFrames = 0;

function opts() {
  const o = settings.value.ovl.tds?.opts ?? {};
  return { cc: +(o.cc ?? 0.8), needRot: (o.couplet ?? "1") === "1" };
}

async function compute(key: string): Promise<TdsHit[]> {
  const meta = await volMeta(key);
  const p = opts();
  const tilts = meta.tilts
    .filter((t) => t.moments.includes("REF") && t.moments.includes("RHO") && t.moments.includes("ZDR") && t.angle < 1.9)
    .sort((a, b) => a.angle - b.angle || a.index - b.index)
    .filter((t, i, arr) => i === 0 || Math.abs(t.angle - arr[i - 1].angle) > 0.15)
    .slice(0, 2);
  if (!tilts.length) throw new Error("no dual-pol tilts in this volume");
  const [rotFc, ...sw] = await Promise.all([
    rotationFor(key).catch(() => ({ features: [] })),
    ...tilts.flatMap((t) => ["REF", "RHO", "ZDR"].map((m) => sweepAt(key, t.index, m))),
  ]);
  const lat0 = sw[0].lat, lon0 = sw[0].lon;
  const rots = ((rotFc as any).features ?? []).map((f: any) => {
    const [lon, lat] = f.geometry.coordinates;
    const [x, y] = llToXY(lat0, lon0, lat, lon);
    return { x, y, vrot: f.properties?.vrot ?? 0, kind: f.properties?.kind ?? "weak", diam: f.properties?.diam_km ?? 2 };
  });
  const args = {
    tilts: tilts.map((_, k) => ({ ref: wsweep(sw[k * 3]), rho: wsweep(sw[k * 3 + 1]), zdr: wsweep(sw[k * 3 + 2]) })),
    rot: rots,
    p: { cc: p.cc, zdr: 1.2, ref: 35, km: 2, maxRange: 150, needRot: p.needRot },
  };
  const cl: any[] = await analysisWorker.run("tds", args);
  // group clusters of both tilts that sit on the same spot
  const groups: any[][] = [];
  for (const c of cl.sort((a, b) => b.n - a.n)) {
    const g = groups.find((gg) => Math.hypot(gg[0].cx - c.cx, gg[0].cy - c.cy) < 3);
    if (g) g.push(c);
    else groups.push([c]);
  }
  const hits: TdsHit[] = groups.map((g) => {
    const n = g.reduce((a, c) => a + c.n, 0);
    const w = (f: (c: any) => number) => g.reduce((a, c) => a + f(c) * c.n, 0) / n;
    const cx = w((c) => c.cx), cy = w((c) => c.cy);
    const ccMean = w((c) => c.ccMean);
    const ri = g.find((c) => c.rotIdx >= 0)?.rotIdx ?? -1;
    const rot = ri >= 0 ? rots[ri] : null;
    const nt = new Set(g.map((c) => c.tilt)).size;
    const kindW = !rot ? 0 : rot.kind === "tvs" ? 1 : rot.kind === "meso" ? 0.75 : 0.45;
    const rotS = kindW * Math.min(1, Math.max(0.5, 0.5 + rot?.vrot / 50 || 0));
    const ccS = Math.min(1, Math.max(0, (0.9 - ccMean) / 0.3));
    const sizeS = Math.min(1, n / 30);
    let conf = 0.4 * rotS + 0.25 * ccS + 0.15 * sizeS + 0.2 * (nt >= 2 ? 1 : 0.4);
    if (!rot) conf *= 0.5;
    const lowest = g.reduce((a, c) => (c.tilt < a.tilt ? c : a), g[0]);
    const [lon, lat] = xyToLL(lat0, lon0, cx, cy);
    return {
      lat,
      lon,
      conf: Math.round(conf * 100) / 100,
      ccMin: Math.min(...g.map((c) => c.ccMin)),
      ccMean,
      zdr: w((c) => c.zdrMean),
      ref: Math.max(...g.map((c) => c.refMax)),
      vrot: rot ? rot.vrot : null,
      kind: rot ? rot.kind : null,
      tilts: nt,
      n,
      hkm: w((c) => c.hkm),
      poly: lowest.hull.map(([x, y]: [number, number]) => xyToLL(lat0, lon0, x, y)),
      site: meta.site,
      t: meta.time,
    };
  });
  return hits.sort((a, b) => b.conf - a.conf);
}

function toFc(hits: TdsHit[]) {
  const feats: any[] = [];
  hits.forEach((h, i) => {
    const props = { ...h, poly: undefined, rank: i + 1, _lbl: `TDS ${Math.round(h.conf * 100)}%`, _hi: h.conf >= 0.5 ? 1 : 0 };
    if (h.poly.length >= 3) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...h.poly, h.poly[0]]] }, properties: props });
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [h.lon, h.lat] }, properties: props });
  });
  return { type: "FeatureCollection", features: feats };
}

function show(key: string) {
  const hits = cache.get(key) ?? [];
  tdsHits.value = { key, hits };
  setData("tds", toFc(hits));
  const strong = hits.filter((h) => h.conf >= 0.5).length;
  status({ count: hits.length, note: hits.length ? `${hits.length} possible${strong ? ` · ${strong} likely` : ""}` : "None" });
  wakeTicker();
}

async function load(key: string) {
  if (inflight === key) return;
  inflight = key;
  status({ ...ovlStatus.value.tds, loading: true, error: undefined });
  try {
    const hits = await compute(key);
    cache.set(key, hits);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
    if (on() && currentFrame.value?.key === key) show(key);
  } catch (e: any) {
    if (currentFrame.value?.key === key) status({ error: e.message });
  } finally {
    if (inflight === key) inflight = "";
  }
}

let optSig = "";
effect(() => {
  const active = on();
  const src = settings.value.radar.source;
  const key = currentFrame.value?.key ?? "";
  const play = playing.value;
  const sig = JSON.stringify(opts());
  if (sig !== optSig) {
    optSig = sig;
    cache.clear();
  }
  clearTimeout(debounce);
  if (!active) {
    tdsHits.value = null;
    return;
  }
  if (src !== "L2") {
    setData("tds", EMPTY);
    tdsHits.value = null;
    status({ note: "Level II only" });
    return;
  }
  if (!key) return;
  if (cache.has(key)) return show(key);
  if (play) {
    if (++playedFrames % 4 === 0 && !inflight) load(key);
    return;
  }
  debounce = window.setTimeout(() => load(key), 400);
});

const PURPLE = "#c026d3";
export function tdsLayers(s: string, st: Style): LayerSpecification[] {
  return [
    { id: `${s}-fill`, type: "fill", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": PURPLE, "fill-opacity": 0.22 * st.opacity } } as LayerSpecification,
    { id: `${s}-glow`, type: "line", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": "#f0abfc", "line-width": 6, "line-blur": 3, "line-opacity": 0.5 } } as LayerSpecification,
    { id: `${s}-line`, type: "line", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": PURPLE, "line-width": 2.5 * st.size, "line-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-pt`, type: "circle", source: s, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["case", ["==", ["get", "_hi"], 1], 6 * st.size, 4.5 * st.size], "circle-color": PURPLE, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5, "circle-opacity": st.opacity } } as LayerSpecification,
    ...(st.labels
      ? [{ id: `${s}-text`, type: "symbol", source: s, filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": ["get", "_lbl"], "text-font": ["Noto Sans Bold"], "text-size": 11.5, "text-offset": [0, 1.2], "text-anchor": "top", "text-allow-overlap": true }, paint: { "text-color": "#f5d0fe", "text-halo-color": "#3b0764", "text-halo-width": 1.6 } } as LayerSpecification]
      : []),
  ];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
export function tdsClick(p: any): Popup {
  const k = speedFactor();
  const u = settings.value.units.speed;
  const mi = settings.value.units.distance !== "km";
  const all = tdsHits.value?.hits ?? [];
  const list = all.map((h, i) => `${i + 1}. ${pct(h.conf)} · CC ${h.ccMin.toFixed(2)} · ${h.vrot != null ? `Vrot ${Math.round(h.vrot * k)} ${u}` : "no couplet"} · ${h.lat.toFixed(3)}, ${h.lon.toFixed(3)}`).join("\n");
  return {
    title: "Possible debris (TDS)",
    sub: `${p.site ?? ""} · confidence ${pct(+p.conf)} · ${p.tilts} tilt${p.tilts > 1 ? "s" : ""}`,
    color: PURPLE,
    rows: [
      ["CC min / mean", `${(+p.ccMin).toFixed(2)} / ${(+p.ccMean).toFixed(2)}`],
      ["ZDR mean", `${(+p.zdr).toFixed(1)} dB`],
      ["Max reflectivity", `${Math.round(+p.ref)} dBZ`],
      ["Couplet", p.vrot != null && p.vrot !== "" ? `${String(p.kind).toUpperCase()} · Vrot ${Math.round(+p.vrot * k)} ${u}` : "none within 2 km"],
      ["Gates", String(p.n)],
      ["Beam height", mi ? `${Math.round(+p.hkm * 3281).toLocaleString()} ft` : `${(+p.hkm).toFixed(1)} km`],
      ["Scan", p.t ? new Date(+p.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "—"],
    ],
    text: all.length > 1 ? `All signatures in this scan:\n${list}` : "Automated: low CC + near-zero ZDR + strong reflectivity collocated with rotation. Confirm with the CC and velocity imagery; ground clutter, biota and hail can mimic it.",
  };
}

// pulsing purple outline
addAnim({
  active: () => on() && !!tdsHits.value?.hits.length,
  frame: (m, t) => {
    const k = 0.5 + 0.5 * Math.sin((t / 700) * Math.PI);
    if (m.getLayer("o-tds-glow")) {
      m.setPaintProperty("o-tds-glow", "line-opacity", 0.15 + 0.6 * k);
      m.setPaintProperty("o-tds-glow", "line-width", 4 + 8 * k);
    }
  },
});
