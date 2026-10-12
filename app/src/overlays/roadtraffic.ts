// Keyless traffic layers from the server: road work / closures / incidents (WZDx, CHP, CHART) and
// measured traffic speeds (Digitraffic, CHART, NYC DOT). The per-source status the server sends
// with each response is kept in ovlMeta for the layer's settings window.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { settings } from "../store";
import { ovlMeta } from "./manager";
import type { OverlayDef, Style, Popup } from "./defs";

export interface FeedSource {
  id: string;
  name: string;
  count: number;
  /** seconds since the last successful fetch */
  age: number | null;
  error: string | null;
}
export interface FeedMeta {
  sources: FeedSource[];
  total?: number;
  truncated?: boolean;
}

const font = ["Noto Sans Regular"];
const halo = { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 };
const when = (ms: any) => (ms ? new Date(typeof ms === "number" ? ms : Date.parse(ms)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "—");
const LINE: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];
const POINT: ExpressionSpecification = ["==", ["geometry-type"], "Point"];

function keepMeta(id: string, fc: any) {
  ovlMeta.value = { ...ovlMeta.value, [id]: { sources: Array.isArray(fc?.sources) ? fc.sources : [], total: fc?.total, truncated: !!fc?.truncated } as FeedMeta };
}

/** A point in the middle of a line (or of a multi-line's longest part), for the icon. */
function midPoint(g: any): [number, number] | null {
  let line: number[][] | undefined;
  if (g?.type === "LineString") line = g.coordinates;
  else if (g?.type === "MultiLineString") line = (g.coordinates as number[][][]).reduce((a, b) => (b.length > (a?.length ?? 0) ? b : a), undefined as any);
  if (!line?.length) return null;
  const p = line[Math.floor((line.length - 1) / 2)];
  return [p[0], p[1]];
}

// ---------- road work & closures ----------

export const ROAD_KINDS: Record<string, string> = { workzone: "Work zone", closure: "Road closed", incident: "Incident" };
const SEV_COLOR: ExpressionSpecification = ["match", ["to-number", ["get", "severity"], 1], 3, "#ef4444", 2, "#f97316", "#facc15"];
const SEV_HEX = ["#facc15", "#facc15", "#f97316", "#ef4444"];
const SEV_NAME = ["Unknown", "Minor", "Moderate", "Major"];

function roadPrepare(fc: any, o: Record<string, string>) {
  keepMeta("roadwork", fc);
  const kinds = new Set((o.kinds || "workzone,closure,incident").split(","));
  const feats = (fc?.features ?? []).filter((f: any) => kinds.has(f.properties?.kind));
  const pts: any[] = [];
  for (const f of feats) {
    if (f.geometry?.type === "Point") continue;
    const c = midPoint(f.geometry);
    if (c) pts.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { ...f.properties, _mid: 1 } });
  }
  return { ...fc, features: [...feats, ...pts], _count: feats.length };
}

function roadLayers(s: string, st: Style): LayerSpecification[] {
  const w = (add: number): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 6, 2 * st.size + add, 12, ["+", add, ["*", st.size, ["match", ["to-number", ["get", "severity"], 1], 3, 6, 2, 5, 4]]]];
  const width = w(0);
  return [
    { id: `${s}-case`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": w(2), "line-opacity": 0.55 * st.opacity } } as LayerSpecification,
    {
      id: `${s}-line`,
      type: "line",
      source: s,
      filter: LINE,
      layout: { "line-cap": "butt", "line-join": "round" },
      // closures dashed, work zones and incidents solid
      paint: { "line-color": SEV_COLOR, "line-width": width, "line-opacity": st.opacity, "line-dasharray": ["case", ["==", ["get", "kind"], "closure"], ["literal", [1.4, 1]], ["literal", [1, 0]]] },
    } as LayerSpecification,
    {
      id: `${s}-icon`,
      type: "symbol",
      source: s,
      filter: POINT,
      layout: {
        "icon-image": ["match", ["get", "kind"], "closure", "road-closure", "incident", "road-incident", "road-workzone"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.7 * st.size, 9, 1.05 * st.size, 13, 1.25 * st.size],
        "icon-allow-overlap": ["step", ["zoom"], false, 9, true],
        "icon-padding": 1,
        // major events win the space at low zoom
        "symbol-sort-key": ["-", 3, ["to-number", ["get", "severity"], 1]],
        ...(st.labels ? { "text-field": ["step", ["zoom"], "", 10, ["get", "road"]], "text-font": font, "text-size": 10.5, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true, "text-max-width": 12 } : {}),
      },
      paint: { "icon-opacity": st.opacity, ...halo },
    } as LayerSpecification,
  ];
}

function roadClick(p: any): Popup {
  const sev = Math.max(0, Math.min(3, +p.severity || 0));
  return {
    title: ROAD_KINDS[p.kind] ?? "Road event",
    sub: [p.road, p.dir].filter(Boolean).join(" · ") || undefined,
    color: SEV_HEX[sev],
    rows: [
      ["Severity", SEV_NAME[sev]],
      ...(p.road ? [["Road", String(p.road)] as [string, string]] : []),
      ...(p.dir ? [["Direction", String(p.dir)] as [string, string]] : []),
      ["Start", when(p.start)],
      ["End", p.end ? when(p.end) : "Not given"],
      ["Source", String(p.source ?? "—")],
    ],
    text: p.desc || undefined,
  };
}

// ---------- traffic speeds ----------

const mph = () => settings.value.units.speed === "mph";
/** colour by % of free-flow speed when the source gives one, else by the speed itself (km/h) */
const FLOW_COLOR: ExpressionSpecification = [
  "case",
  [">=", ["to-number", ["coalesce", ["get", "ratio"], -1]], 0],
  ["interpolate", ["linear"], ["to-number", ["get", "ratio"]], 0.25, "#b91c1c", 0.5, "#f97316", 0.75, "#facc15", 0.9, "#22c55e"],
  ["interpolate", ["linear"], ["to-number", ["get", "speed"], 0], 15, "#b91c1c", 35, "#f97316", 60, "#facc15", 85, "#84cc16", 105, "#22c55e"],
];
const FLOW_RANK: ExpressionSpecification = ["case", [">=", ["to-number", ["coalesce", ["get", "ratio"], -1]], 0], ["*", 100, ["to-number", ["get", "ratio"]]], ["to-number", ["get", "speed"], 0]];

const d = 8;
const SLOTS: Record<string, [number, number]> = {
  "2-0": [-d, 0], "2-1": [d, 0],
  "3-0": [0, -d], "3-1": [d, d * 0.6], "3-2": [-d, d * 0.6],
  "4-0": [-d, -d], "4-1": [d, -d], "4-2": [d, d], "4-3": [-d, d],
};
const SLOT_OFFSET: any = ["match", ["get", "_slot"], ...Object.entries(SLOTS).flatMap(([k, v]) => [k, ["literal", v]]), ["literal", [0, 0]]];

/** Stations publish one value per direction at the same spot: fan them out a few pixels. */
function flowPrepare(fc: any) {
  keepMeta("trafficflow", fc);
  const at = new Map<string, any[]>();
  const feats = fc?.features ?? [];
  for (const f of feats) {
    if (f.geometry?.type !== "Point") continue;
    const [x, y] = f.geometry.coordinates;
    const k = `${(+x).toFixed(5)},${(+y).toFixed(5)}`;
    at.set(k, [...(at.get(k) ?? []), f]);
  }
  const out = feats.map((f: any) => ({ ...f, properties: { ...f.properties, _slot: "" } }));
  const idx = new Map<any, number>(feats.map((f: any, i: number) => [f, i]));
  for (const list of at.values()) {
    if (list.length < 2) continue;
    const n = Math.min(4, list.length);
    list.forEach((f, j) => (out[idx.get(f)!].properties._slot = `${n}-${j % n}`));
  }
  return { ...fc, features: out, _count: feats.length };
}

function flowLayers(s: string, st: Style): LayerSpecification[] {
  const speed: ExpressionSpecification = mph() ? ["round", ["*", ["to-number", ["get", "speed"], 0], 0.621371]] : ["round", ["to-number", ["get", "speed"], 0]];
  return [
    { id: `${s}-case`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5 * st.size, 14, 7 * st.size], "line-opacity": 0.5 * st.opacity } } as LayerSpecification,
    { id: `${s}-line`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["-", 200, FLOW_RANK] }, paint: { "line-color": FLOW_COLOR, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5 * st.size, 14, 5 * st.size], "line-opacity": st.opacity } } as LayerSpecification,
    {
      id: `${s}-pt`,
      type: "symbol",
      source: s,
      filter: POINT,
      layout: {
        "icon-image": "flow-dot",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.55 * st.size, 9, 0.9 * st.size, 13, 1.1 * st.size],
        "icon-offset": SLOT_OFFSET,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["-", 200, FLOW_RANK],
        "icon-anchor": "center",
      },
      paint: { "icon-color": FLOW_COLOR, "icon-halo-color": "rgba(0,0,0,.85)", "icon-halo-width": 1.2, "icon-opacity": st.opacity },
    } as LayerSpecification,
    ...(st.labels
      ? [
          {
            id: `${s}-text`,
            type: "symbol",
            source: s,
            minzoom: 10,
            filter: POINT,
            layout: { "text-field": ["to-string", speed], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
            paint: halo,
          } as LayerSpecification,
          {
            id: `${s}-ltext`,
            type: "symbol",
            source: s,
            minzoom: 11,
            filter: LINE,
            layout: { "text-field": ["to-string", speed], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "symbol-placement": "line-center" },
            paint: halo,
          } as LayerSpecification,
        ]
      : []),
  ];
}

function flowClick(p: any): Popup {
  const m = mph();
  const sp = (v: any) => (v == null || v === "" ? "—" : m ? `${Math.round(+v * 0.621371)} mph` : `${Math.round(+v)} km/h`);
  const r = p.ratio == null || p.ratio === "" ? null : +p.ratio;
  const color = r != null ? (r < 0.5 ? "#b91c1c" : r < 0.75 ? "#f97316" : r < 0.9 ? "#facc15" : "#22c55e") : +p.speed < 35 ? "#b91c1c" : +p.speed < 60 ? "#f97316" : +p.speed < 85 ? "#facc15" : "#22c55e";
  return {
    title: p.road || "Traffic speed",
    sub: [p.dir ? `Direction ${p.dir}` : "", p.source].filter(Boolean).join(" · "),
    color,
    rows: [
      ["Speed", sp(p.speed)],
      ["Free flow", sp(p.free_flow)],
      ["Of free flow", r != null ? `${Math.round(r * 100)}%` : "No reference (coloured by speed)"],
      ["Measured", when(p.t)],
      ["Source", String(p.source ?? "—")],
    ],
  };
}

export const roadTrafficDefs: OverlayDef[] = [
  {
    id: "roadwork",
    name: "Road work & closures (open data)",
    group: "Traffic",
    view: "bbox",
    minzoom: 4,
    refresh: 300,
    options: [
      {
        key: "kinds",
        label: "Show",
        choices: [
          ["workzone,closure,incident", "Work zones, closures & incidents"],
          ["workzone,closure", "Work zones & closures"],
          ["closure", "Closures only"],
          ["incident", "Incidents only"],
          ["workzone", "Work zones only"],
        ],
        def: "workzone,closure,incident",
      },
    ],
    style: { opacity: 1, size: 1, labels: true },
    prepare: (fc, o) => roadPrepare(fc, o),
    layers: (s, st) => roadLayers(s, st),
    click: (p) => roadClick(p),
    note: "No key needed. US DOT work zone feeds (WZDx), California Highway Patrol and Maryland CHART. Cone = work zone, barrier = closure, triangle = incident; lines yellow minor → red major (closures dashed).",
  },
  {
    id: "trafficflow",
    name: "Traffic speeds (open data)",
    group: "Traffic",
    view: "bbox",
    minzoom: 5,
    refresh: 300,
    style: { opacity: 1, size: 1, labels: true },
    prepare: (fc) => flowPrepare(fc),
    layers: (s, st) => flowLayers(s, st),
    click: (p) => flowClick(p),
    note: "No key needed. Measured speeds: Finland (Fintraffic Digitraffic, CC BY 4.0), Maryland CHART sensors and NYC DOT links. Coloured by % of free-flow speed where the source gives one (red < 50%, green ≥ 90%), else by the speed itself.",
  },
];
