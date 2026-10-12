// TomTom traffic: flow tiles through our server (token in the URL), key check, incident layers.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { effect } from "@preact/signals";
import { settings, update } from "../store";
import { api, ApiError } from "../api";
import { ovlStatus } from "./manager";
import { mapRef } from "../map/mapview";
import type { Style, Popup } from "./defs";

const on = (id: string) => !!settings.value.ovl[id]?.on;
export const NO_KEY = "Add a TomTom key in Settings → API keys";

/** raster source for the flow tiles */
export function trafficSource(o: Record<string, string>) {
  const tok = api.token ? `&token=${encodeURIComponent(api.token)}` : "";
  return { tiles: [`${api.base}/api/traffic/{z}/{x}/{y}?style=${o.style || "relative0-dark"}${tok}`], tileSize: 256, maxzoom: 18, attribution: "Traffic © TomTom" };
}

export function trafficLayers(s: string, st: Style): LayerSpecification[] {
  return [{ id: `${s}-flow`, type: "raster", source: s, paint: { "raster-opacity": st.opacity, "raster-fade-duration": 0 } } as LayerSpecification];
}

// one probe tile tells whether the server has a key (404 = no key)
let probed = "";
effect(() => {
  const want = on("traffic");
  void settings.value.activeServer;
  if (!want) {
    probed = "";
    return;
  }
  const k = `${api.base}|${settings.value.ovl.traffic?.opts?.style ?? ""}`;
  if (probed === k) return;
  probed = k;
  api
    .bin(`/api/traffic/4/3/6?style=${settings.value.ovl.traffic?.opts?.style || "relative0-dark"}`)
    .then(() => (ovlStatus.value = { ...ovlStatus.value, traffic: {} }))
    .catch((e) => {
      const msg = e instanceof ApiError && e.status === 404 ? NO_KEY : e.message;
      ovlStatus.value = { ...ovlStatus.value, traffic: { note: msg, error: e instanceof ApiError && e.status === 404 ? undefined : msg } };
    });
});

// flow tiles change every couple of minutes: refetch them (cache-busting stamp) while shown
let tileTimer: number | undefined;
effect(() => {
  clearInterval(tileTimer);
  if (!on("traffic")) return;
  tileTimer = window.setInterval(() => {
    const src = mapRef.value?.getSource("o-traffic") as any;
    if (!src?.setTiles || document.hidden) return;
    const o = { style: settings.value.ovl.traffic?.opts?.style ?? "relative0-dark" };
    src.setTiles(trafficSource(o).tiles.map((u) => `${u}&_t=${Math.floor(Date.now() / 120000)}`));
  }, 120_000);
});

// the "Incidents" option drives the hidden incidents overlay
effect(() => {
  const want = on("traffic") && settings.value.ovl.traffic?.opts?.inc === "1";
  if (!!settings.value.ovl.trafficinc?.on !== want)
    queueMicrotask(() =>
      update((s) => {
        s.ovl.trafficinc = { ...(s.ovl.trafficinc ?? {}), on: want };
      }),
    );
});

const MAG_COLOR: ExpressionSpecification = ["match", ["to-number", ["get", "magnitude"], 0], 1, "#facc15", 2, "#f97316", 3, "#ef4444", 4, "#991b1b", "#9ca3af"];
const CAT: Record<number, string> = { 0: "Incident", 1: "Accident", 2: "Fog", 3: "Dangerous conditions", 4: "Rain", 5: "Ice", 6: "Traffic jam", 7: "Lane closed", 8: "Road closed", 9: "Road works", 10: "Wind", 11: "Flooding", 14: "Broken-down vehicle" };
const LETTER: ExpressionSpecification = ["match", ["to-number", ["get", "category"], 0], 1, "A", 6, "J", 7, "L", 8, "X", 9, "W", 14, "B", "!"];

/** a marker point at the start of each incident line */
export function incPrepare(fc: any) {
  const pts: any[] = [];
  for (const f of fc?.features ?? []) {
    const g = f.geometry;
    if (g?.type === "LineString" && g.coordinates?.length) pts.push({ type: "Feature", geometry: { type: "Point", coordinates: g.coordinates[0] }, properties: { ...f.properties, _pt: 1 } });
  }
  return { ...fc, features: [...(fc?.features ?? []), ...pts], _count: fc?.features?.length ?? 0 };
}

export function incLayers(s: string, st: Style): LayerSpecification[] {
  const pt: any = ["==", ["geometry-type"], "Point"];
  return [
    { id: `${s}-line`, type: "line", source: s, filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" }, paint: { "line-color": MAG_COLOR, "line-width": 3.5 * st.size, "line-opacity": 0.85 * st.opacity, "line-dasharray": ["case", ["==", ["to-number", ["get", "category"], 0], 8], ["literal", [1, 1]], ["literal", [1, 0]]] } } as LayerSpecification,
    { id: `${s}-pt`, type: "circle", source: s, filter: pt, paint: { "circle-radius": 7.5 * st.size, "circle-color": MAG_COLOR, "circle-stroke-color": "#000", "circle-stroke-width": 1.4, "circle-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-glyph-text`, type: "symbol", source: s, filter: pt, layout: { "text-field": LETTER, "text-font": ["Noto Sans Bold"], "text-size": 10 * st.size, "text-allow-overlap": true }, paint: { "text-color": "#000" } } as LayerSpecification,
  ];
}

export function incClick(p: any): Popup {
  const roads = (() => {
    try {
      const r = typeof p.roads === "string" ? JSON.parse(p.roads) : p.roads;
      return Array.isArray(r) ? r.join(", ") : "";
    } catch {
      return "";
    }
  })();
  const mi = settings.value.units.distance !== "km";
  return {
    title: CAT[+p.category] ?? "Traffic incident",
    sub: [roads, p.from && p.to ? `${p.from} → ${p.to}` : p.from].filter(Boolean).join(" · "),
    color: ["#9ca3af", "#facc15", "#f97316", "#ef4444", "#991b1b"][+p.magnitude || 0],
    rows: [
      ["Delay", p.delay ? `${Math.round(p.delay / 60)} min` : "—"],
      ["Length", p.length ? (mi ? `${(p.length / 1609).toFixed(1)} mi` : `${(p.length / 1000).toFixed(1)} km`) : "—"],
      ["Severity", ["Unknown", "Minor", "Moderate", "Major", "Closure"][+p.magnitude || 0]],
      ["Until", p.end ? new Date(p.end).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"],
    ],
    text: p.desc || undefined,
  };
}
