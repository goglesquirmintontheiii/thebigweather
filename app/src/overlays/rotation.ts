// Rotation: (1) detections in the selected radar's Level II volume (/api/radar/rotation), and
// (2) the "Rotation scan" over every US radar's storm attributes (tornadic rotation / supercells).

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { signal, effect } from "@preact/signals";
import { settings } from "../store";
import { api } from "../api";
import { speedFactor, distance } from "../util";
import { setData, ovlStatus } from "./manager";
import { currentFrame, playing, sites, selectSite } from "../radar/controller";
import { mapRef } from "../map/mapview";
import { addAnim, wakeTicker, pulse } from "./ticker";
import { mesoRank, hasTvs, threat, cellFlags, stormClick } from "./stormcells";
import type { Style, Popup } from "./defs";

const EMPTY = { type: "FeatureCollection", features: [] };
const on = (id: string) => !!settings.value.ovl[id]?.on;
const bold = ["Noto Sans Bold"];
function status(id: string, s: { loading?: boolean; error?: string; count?: number; note?: string }) {
  ovlStatus.value = { ...ovlStatus.value, [id]: s };
}

// ---------- rotation in the selected radar ----------

const KIND_COLOR: ExpressionSpecification = ["match", ["get", "kind"], "tvs", "#ff2d2d", "meso", "#facc15", "#cbd5e1"];
const cache = new Map<string, any>();
let shownKey = "";
let inflight = "";
let debounce: number | undefined;
let playedFrames = 0;

/** units-dependent label + base radius (px at zoom 0, so circles keep their real size) */
function decorate(fc: any) {
  const k = speedFactor();
  const u = settings.value.units.speed;
  return {
    ...fc,
    features: (fc.features ?? []).map((f: any) => {
      const p = f.properties ?? {};
      const lat = f.geometry?.coordinates?.[1] ?? 35;
      const r0 = ((p.diam_km ?? 2) * 500) / (156543.03 * Math.cos((lat * Math.PI) / 180));
      return { ...f, properties: { ...p, _lbl: p.vrot != null ? `${Math.round(p.vrot * k)} ${u}` : "", _r0: r0 } };
    }),
  };
}

function show(key: string) {
  const fc = cache.get(key);
  if (!fc) return;
  shownKey = key;
  setData("rotation", decorate(fc));
  const n = fc.features?.length ?? 0;
  const tvs = fc.features?.filter((f: any) => f.properties?.kind === "tvs").length ?? 0;
  status("rotation", { count: n, note: n ? `${n}${tvs ? ` · ${tvs} TVS` : ""}` : "None" });
  wakeTicker();
}

async function load(key: string) {
  if (inflight === key) return;
  inflight = key;
  status("rotation", { ...ovlStatus.value.rotation, loading: true, error: undefined });
  try {
    const fc = await api.get(`/api/radar/rotation?key=${encodeURIComponent(key)}`);
    cache.set(key, fc);
    if (cache.size > 60) cache.delete(cache.keys().next().value!);
    if (on("rotation") && currentFrame.value?.key === key) show(key);
  } catch (e: any) {
    status("rotation", { error: e.message });
  } finally {
    if (inflight === key) inflight = "";
  }
}

effect(() => {
  const active = on("rotation");
  const src = settings.value.radar.source;
  const key = currentFrame.value?.key ?? "";
  const play = playing.value;
  void settings.value.units.speed;
  clearTimeout(debounce);
  if (!active) {
    shownKey = "";
    return;
  }
  if (src !== "L2") {
    setData("rotation", EMPTY);
    status("rotation", { note: "Level II only" });
    return;
  }
  if (!key) return;
  if (cache.has(key)) return show(key); // also redraws labels when units change
  if (play) {
    // animating: only every 4th new frame, and never more than one request at a time
    if (++playedFrames % 4 === 0 && !inflight) load(key);
    return;
  }
  debounce = window.setTimeout(() => load(key), 350);
});

export function rotationLayers(s: string, st: Style, o: Record<string, string>): LayerSpecification[] {
  const kinds = o.min === "tvs" ? ["tvs"] : o.min === "meso" ? ["tvs", "meso"] : ["tvs", "meso", "weak"];
  const kf: any = ["in", ["get", "kind"], ["literal", kinds]];
  const z = st.size;
  return [
    { id: `${s}-halo`, type: "circle", source: s, filter: ["all", kf, ["==", ["get", "kind"], "tvs"]], paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ff2d2d", "circle-stroke-width": 3, "circle-stroke-opacity": 0.8 } } as LayerSpecification,
    {
      id: `${s}-area`,
      type: "circle",
      source: s,
      filter: kf,
      paint: {
        // true diameter on the ground
        "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 0, ["get", "_r0"], 22, ["*", ["get", "_r0"], 4194304]],
        "circle-color": KIND_COLOR,
        "circle-opacity": ["*", st.opacity, ["match", ["get", "kind"], "weak", 0.12, 0.28]],
        "circle-stroke-color": KIND_COLOR,
        "circle-stroke-width": ["match", ["get", "kind"], "weak", 1, 2],
        "circle-stroke-opacity": ["*", st.opacity, ["match", ["get", "kind"], "weak", 0.5, 1]],
      },
    } as LayerSpecification,
    {
      id: `${s}-pt`,
      type: "circle",
      source: s,
      filter: kf,
      layout: { "circle-sort-key": ["coalesce", ["get", "score"], 0] },
      paint: { "circle-radius": ["match", ["get", "kind"], "tvs", 6 * z, "meso", 5 * z, 3.5 * z], "circle-color": KIND_COLOR, "circle-stroke-color": "#000", "circle-stroke-width": 1.4, "circle-opacity": ["*", st.opacity, ["match", ["get", "kind"], "weak", 0.6, 1]] },
    } as LayerSpecification,
    ...(st.labels
      ? [{ id: `${s}-text`, type: "symbol", source: s, filter: ["all", kf, ["!=", ["get", "kind"], "weak"]], layout: { "text-field": ["get", "_lbl"], "text-font": bold, "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true }, paint: { "text-color": KIND_COLOR, "text-halo-color": "#000", "text-halo-width": 1.5 } } as LayerSpecification]
      : []),
  ];
}

export function rotationClick(p: any): Popup {
  const k = speedFactor();
  const u = settings.value.units.speed;
  const sp = (v: any) => (v == null ? "—" : `${Math.round(v * k)} ${u}`);
  const name = p.kind === "tvs" ? "Tornadic vortex signature" : p.kind === "meso" ? "Mesocyclone" : "Weak rotation";
  const mi = settings.value.units.distance !== "km";
  const km = (v: any) => (v == null ? "—" : mi ? `${(v / 1.609).toFixed(1)} mi` : `${Number(v).toFixed(1)} km`);
  return {
    title: name,
    sub: `${p.site ?? ""} · ${p.tilts ?? 1} tilt${(p.tilts ?? 1) > 1 ? "s" : ""}${p.score != null ? ` · score ${Math.round(p.score * 100)}%` : ""}`,
    color: p.kind === "tvs" ? "#ff2d2d" : p.kind === "meso" ? "#facc15" : "#cbd5e1",
    rows: [
      ["Rotational vel.", sp(p.vrot)],
      ["Delta-V", sp(p.dv)],
      ["Diameter", km(p.diam_km)],
      ["Range / az", `${km(p.range_km)} · ${p.az != null ? Math.round(p.az) : "—"}°`],
      ["Height", p.height_km != null ? (mi ? `${Math.round(p.height_km * 3281).toLocaleString()} ft` : `${Number(p.height_km).toFixed(1)} km`) : "—"],
      ["Lowest tilt", p.tilt != null ? `${p.tilt}°` : "—"],
      ["Scan", p.t ? new Date(p.t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "—"],
    ],
  };
}

// ---------- rotation scan (all US radars) ----------

export type ScanMode = "tor" | "sc";
export interface ScanHit {
  lon: number;
  lat: number;
  site: string;
  id: string;
  strength: string;
  score: number;
  p: any;
}
export const scanMode = signal<ScanMode | null>(null);
export const scanHits = signal<ScanHit[]>([]);
export const scanState = signal<{ busy: boolean; error?: string; t?: number }>({ busy: false });

/** Rules (on the radars' own storm-attribute tables):
 * - Tornadic rotation: a TVS/ETVS detection, or a mesocyclone of strength rank ≥ 10.
 * - Supercell: a mesocyclone (rank ≥ 5) in a strong storm — max dBZ ≥ 50, POSH ≥ 30 % or VIL ≥ 40 kg/m². */
export function scanMatch(mode: ScanMode, p: any): boolean {
  const m = mesoRank(p);
  if (mode === "tor") return hasTvs(p) || m >= 10;
  return m >= 5 && ((p.max_dbz ?? 0) >= 50 || (p.posh ?? 0) >= 30 || (p.vil ?? 0) >= 40);
}

export function siteFor(nexrad: string): string {
  const n = String(nexrad ?? "").toUpperCase();
  return sites.value.find((s) => s.id.length === 4 && s.id.slice(1) === n && s.type === "NEXRAD")?.id ?? `K${n}`;
}

let scanTimer: number | undefined;

export async function runScan(mode: ScanMode) {
  scanMode.value = mode;
  clearInterval(scanTimer);
  scanTimer = window.setInterval(() => scanMode.value && on("rotscan") && runScan(scanMode.value), 120_000);
  scanState.value = { ...scanState.value, busy: true, error: undefined };
  try {
    const fc = await api.get("/api/ovl/stormattr");
    if (scanMode.value !== mode) return;
    const all: ScanHit[] = [];
    for (const f of fc.features ?? []) {
      const p = f.properties ?? {};
      const c = f.geometry?.coordinates;
      if (!c || !scanMatch(mode, p)) continue;
      const m = mesoRank(p);
      all.push({ lon: c[0], lat: c[1], site: siteFor(p.nexrad), id: p.storm_id, strength: hasTvs(p) ? `TVS${m ? ` · meso ${m}` : ""}` : `Meso ${m}`, score: threat(p), p });
    }
    // one entry per storm: nearby radars often see the same cell
    all.sort((a, b) => b.score - a.score);
    const hits: ScanHit[] = [];
    for (const h of all) if (!hits.some((k) => distance(k.lat, k.lon, h.lat, h.lon) < 8000)) hits.push(h);
    scanHits.value = hits;
    setData("rotscan", {
      type: "FeatureCollection",
      features: hits.map((h) => ({ type: "Feature", geometry: { type: "Point", coordinates: [h.lon, h.lat] }, properties: { ...h.p, _mode: mode, _site: h.site, _str: h.strength, _tvs: hasTvs(h.p) ? 1 : 0 } })),
    });
    scanState.value = { busy: false, t: Date.now() };
    status("rotscan", { count: hits.length });
    wakeTicker();
  } catch (e: any) {
    scanState.value = { busy: false, error: e.message };
  }
}

export function clearScan() {
  scanMode.value = null;
  clearInterval(scanTimer);
  scanHits.value = [];
  scanState.value = { busy: false };
  setData("rotscan", EMPTY);
  status("rotscan", {});
}

/** Fly to a hit and show that radar. */
export function goToHit(h: ScanHit) {
  const m = mapRef.value;
  m?.flyTo({ center: [h.lon, h.lat], zoom: Math.max(m.getZoom(), 8.5) });
  if (sites.value.some((s) => s.id === h.site)) selectSite(h.site);
}

effect(() => {
  if (!on("rotscan") && scanMode.value) clearScan();
});

export function scanLayers(s: string, st: Style): LayerSpecification[] {
  const col: ExpressionSpecification = ["case", ["==", ["get", "_mode"], "sc"], "#facc15", "#ff2d2d"];
  return [
    { id: `${s}-pulse`, type: "circle", source: s, paint: { "circle-radius": 12, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": col, "circle-stroke-width": 3, "circle-stroke-opacity": 0.9 } } as LayerSpecification,
    { id: `${s}-ring`, type: "circle", source: s, paint: { "circle-radius": 11 * st.size, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": col, "circle-stroke-width": 2, "circle-stroke-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-pt`, type: "circle", source: s, paint: { "circle-radius": 4.5 * st.size, "circle-color": col, "circle-stroke-color": "#000", "circle-stroke-width": 1.2, "circle-opacity": st.opacity } } as LayerSpecification,
    ...(st.labels
      ? [{ id: `${s}-text`, type: "symbol", source: s, minzoom: 5, layout: { "text-field": ["concat", ["get", "_site"], " ", ["get", "storm_id"], "\n", ["get", "_str"]], "text-font": bold, "text-size": 10.5, "text-offset": [0, 1.5], "text-anchor": "top", "text-optional": true }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.4 } } as LayerSpecification]
      : []),
  ];
}

export function scanClick(p: any): Popup {
  const base = stormClick(p)!;
  return { ...base, title: `${p._mode === "sc" ? "Possible supercell" : "Possible tornadic rotation"} · ${p._site}`, sub: cellFlags(p) };
}

// pulsing rings (scan hits, TVS halos)
addAnim({
  active: () => (on("rotscan") && scanHits.value.length > 0) || (on("rotation") && !!shownKey),
  frame: (m, t) => {
    pulse(m, "o-rotscan-pulse", t, 1600, 8, 30);
    pulse(m, "o-rotation-halo", t, 1200, 8, 26);
  },
});
