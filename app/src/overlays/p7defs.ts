// p7: power outages — county choropleth (joined client-side to the bundled county outlines,
// geo/counties-fips.json, loaded on first use) and outage points, from the server's keyless
// utility outage-map adapters (/api/ovl/outages: KUBRA Storm Center utilities, Duke Energy,
// Hydro-Québec). The per-source status shows in the layer's settings window. Imported once from
// App.tsx.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef } from "./defs";
import { settings } from "../store";
import { ovlMeta, setData, isOn } from "./manager";
import "../intl/ecccimg"; // p7 Canada: the selected radar's own ECCC images (imported here to keep radar.ts free of a cycle)

const font = ["Noto Sans Regular"];
const bold = ["Noto Sans Bold"];
const POLY: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const POINT: ExpressionSpecification = ["==", ["geometry-type"], "Point"];
const nf = (n: any) => (n == null || n === "" || !Number.isFinite(+n) ? "—" : Math.round(+n).toLocaleString());
const when = (v: any) => {
  if (v == null || v === "") return "—";
  const t = typeof v === "number" ? v : /^\d{10,}$/.test(String(v)) ? +v : NaN;
  // local strings from the utility ("2026-10-13 01:30:00") are shown as published
  if (!Number.isFinite(t)) return String(v);
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });
};
const ago = (ms: any) => {
  if (!ms) return "";
  const m = Math.round((Date.now() - +ms) / 60000);
  return m < 1 ? "just now" : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

// ---------- classes ----------

/** % of customers out (when the utility publishes customers served) */
export const PCT_BINS = [0.1, 1, 5, 10, 25, 50];
/** customers out (when it doesn't, or "color by customers") */
export const OUT_BINS = [10, 100, 1000, 5000, 20000, 50000];
export const OUT_COLORS = ["#fde68a", "#fbbf24", "#f97316", "#ef4444", "#b91c1c", "#7e22ce", "#3b0764"];
export function outageLevel(p: { pct?: number | null; out?: number }, by: string): number {
  const usePct = by !== "out" && p.pct != null && Number.isFinite(+p.pct);
  const v = usePct ? +p.pct! : +(p.out ?? 0);
  const bins = usePct ? PCT_BINS : OUT_BINS;
  let k = 0;
  while (k < bins.length && v >= bins[k]) k++;
  return k;
}
const LEVEL: ExpressionSpecification = ["match", ["to-number", ["get", "_lvl"], 0], 0, OUT_COLORS[0], 1, OUT_COLORS[1], 2, OUT_COLORS[2], 3, OUT_COLORS[3], 4, OUT_COLORS[4], 5, OUT_COLORS[5], OUT_COLORS[6]];

// ---------- county outlines (lazy, ~800 KB once) ----------

let shapes: Map<string, GeoJSON.Geometry> | null = null;
let shapesLoading: Promise<void> | null = null;
let lastRaw: any = null;
let lastOpts: Record<string, string> = {};

function loadShapes(): Promise<void> {
  shapesLoading ??= Promise.all([import("topojson-client"), fetch("geo/counties-fips.json").then((r) => r.json())])
    .then(([{ feature }, topo]) => {
      const fc: any = feature(topo, topo.objects.counties);
      const m = new Map<string, GeoJSON.Geometry>();
      for (const f of fc.features) if (f.id != null && f.geometry) m.set(String(f.id).padStart(5, "0"), f.geometry);
      shapes = m;
      // redraw what we already have, now with polygons
      if (lastRaw && isOn("outages")) setData("outages", prepare(lastRaw, lastOpts));
    })
    .catch((e) => {
      console.warn("county outlines", e);
      shapesLoading = null;
    });
  return shapesLoading;
}

// ---------- prepare ----------

function keepMeta(fc: any) {
  const src: any[] = Array.isArray(fc?.sources) ? fc.sources : [];
  ovlMeta.value = {
    ...ovlMeta.value,
    outages: {
      // shaped for the shared per-source list (name · count · age · error)
      sources: src.map((s) => ({ ...s, name: s.out != null ? `${s.name} — ${nf(s.out)} out` : s.name, count: s.count ?? 0 })),
      totalOut: fc?.total_out ?? 0,
      totalServed: fc?.total_served ?? 0,
      level: fc?.level,
    },
  };
}

/** One-line totals for the settings window. */
export function outageSummary(): string {
  const m = ovlMeta.value.outages;
  if (!m) return "";
  const ok = (m.sources as any[]).filter((s) => !s.error && s.age != null).length;
  const pct = m.totalServed > 0 ? ` (${((m.totalOut / m.totalServed) * 100).toFixed(2)}% of ${nf(m.totalServed)} customers tracked)` : "";
  return `${nf(m.totalOut)} customers out across ${ok} reporting utilities${pct}.`;
}

function prepare(fc: any, o: Record<string, string>) {
  lastRaw = fc;
  lastOpts = o;
  keepMeta(fc);
  const by = o.by || "auto";
  const feats: any[] = [];
  let needShapes = false;
  for (const f of fc?.features ?? []) {
    const p = f.properties ?? {};
    if (p.kind === "county") {
      const g = p.fips ? shapes?.get(String(p.fips)) : undefined;
      if (p.fips && !shapes) needShapes = true;
      const props = { ...p, _lvl: outageLevel(p, by), _lbl: p.pct != null && by !== "out" ? `${p.name}\n${p.pct}%` : `${p.name}\n${nf(p.out)}` };
      if (g) feats.push({ type: "Feature", geometry: g, properties: props });
      // no outline (unmatched name, or outlines still loading): a dot at the label point
      else if (f.geometry) feats.push({ type: "Feature", geometry: f.geometry, properties: { ...props, _dot: 1 } });
    } else if (f.geometry) {
      feats.push({ type: "Feature", geometry: f.geometry, properties: { ...p, _lvl: outageLevel({ out: p.out }, "out") } });
    }
  }
  if (needShapes) loadShapes();
  return { type: "FeatureCollection", features: feats, _count: (fc?.features ?? []).length };
}

// ---------- layer ----------

const size = (k: number): ExpressionSpecification => ["interpolate", ["linear"], ["sqrt", ["max", 1, ["to-number", ["get", "out"], 1]]], 1, 3 * k, 10, 5 * k, 32, 8 * k, 100, 12 * k, 224, 18 * k, 400, 24 * k];

const outages: OverlayDef = {
  id: "outages",
  name: "Power outages",
  group: "Hazards",
  refresh: 300,
  view: "bbox",
  options: [
    { key: "level", label: "Show", choices: [["county", "Counties"], ["point", "Counties + outage points"]], def: "county" },
    { key: "by", label: "Color counties by", choices: [["auto", "% of customers out"], ["out", "Customers out"]], def: "auto" },
  ],
  style: { opacity: 0.75, size: 1, labels: true },
  prepare,
  layers: (s, st) => {
    const L: LayerSpecification[] = [
      { id: `${s}-fill`, type: "fill", source: s, filter: POLY, paint: { "fill-color": LEVEL, "fill-opacity": st.opacity * 0.7 } } as LayerSpecification,
      { id: `${s}-line`, type: "line", source: s, filter: POLY, paint: { "line-color": "#1f2937", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.3, 9, 1.2], "line-opacity": Math.min(1, st.opacity + 0.15) } } as LayerSpecification,
      {
        id: `${s}-pt`,
        type: "circle",
        source: s,
        filter: POINT,
        layout: { "circle-sort-key": ["to-number", ["get", "out"], 0] },
        paint: {
          "circle-color": LEVEL,
          "circle-radius": ["case", ["has", "_dot"], 6 * st.size, size(st.size)],
          "circle-opacity": Math.min(1, st.opacity + 0.1),
          "circle-stroke-color": ["case", ["has", "_dot"], "#fff", "#000"],
          "circle-stroke-width": ["case", ["has", "_dot"], 1.5, 0.8],
        },
      } as LayerSpecification,
    ];
    if (st.labels)
      L.push(
        { id: `${s}-clabel`, type: "symbol", source: s, filter: ["any", POLY, ["has", "_dot"]], minzoom: 6.5, layout: { "text-field": ["get", "_lbl"], "text-font": bold, "text-size": 10.5, "text-padding": 2 }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 } } as LayerSpecification,
        { id: `${s}-plabel`, type: "symbol", source: s, filter: ["all", POINT, ["!", ["has", "_dot"]], [">=", ["to-number", ["get", "out"], 0], 50]], minzoom: 8, layout: { "text-field": ["to-string", ["get", "out"]], "text-font": font, "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top" }, paint: { "text-color": "#fde68a", "text-halo-color": "#000", "text-halo-width": 1.2 } } as LayerSpecification,
      );
    return L;
  },
  click: (p) => {
    const lvl = +(p._lvl ?? 0);
    if (p.kind === "county") {
      let utils: any[] = [];
      try {
        utils = typeof p.utilities === "string" ? JSON.parse(p.utilities) : p.utilities ?? [];
      } catch {
        /* properties come back stringified from the map */
      }
      return {
        title: `${p.name}${/city$/i.test(p.name ?? "") ? "" : " Co."}, ${p.state}`,
        sub: `Power outages · updated ${ago(p.updated) || "—"}`,
        color: OUT_COLORS[lvl],
        rows: [
          ["Customers out", nf(p.out)],
          ["Customers served", nf(p.served)],
          ["Out", p.pct != null ? `${p.pct}%` : "—"],
          ...utils.map((u: any) => [u.name, `${nf(u.out)}${u.served ? ` of ${nf(u.served)}` : ""}${u.etr ? ` · ETR ${when(u.etr)}` : ""}`] as [string, string]),
          ["Updated", when(p.updated)],
        ],
        text: p.fips ? undefined : "County outline not matched — shown at the utility's label point.",
      };
    }
    return {
      title: `${nf(p.out)} customer${+p.out === 1 ? "" : "s"} out`,
      sub: p.utility,
      color: OUT_COLORS[lvl],
      rows: [
        ["Started", when(p.start)],
        ["Est. restoration", when(p.etr)],
        ...(p.cause ? [["Cause", String(p.cause)] as [string, string]] : []),
        ...(p.status ? [["Status", String(p.status)] as [string, string]] : []),
        ...(p.area ? [["Area", String(p.area)] as [string, string]] : []),
        ["Updated", when(p.updated)],
      ],
    };
  },
  note:
    "Customers without power from the utilities' own public outage maps (no national keyless feed exists). Counties colored by % of customers out (yellow < 1% … purple ≥ 25%), or by customers out when the utility doesn't publish customers served; circles are individual outages. " +
    "Covered: AEP Ohio, AEP Texas, Alabama Power, Ameren, Appalachian Power, Atlantic City Electric, Austin Energy, BGE, Central Hudson, ComEd, CPS Energy, Dominion Energy (VA/NC, SC), DTE, Duke Energy (NC/SC/FL/IN/OH/KY), Evergy, FirstEnergy (OH/PA/NJ/MD/WV), Georgia Power, Indiana Michigan Power, JEA, Kentucky Power, LG&E/KU, Mississippi Power, National Grid (NY/MA), OG&E, Oncor, PECO, PNM, PSE&G, PSEG Long Island, PSO, SWEPCO and Hydro-Québec (points). " +
    "Not covered: other utilities and most co-ops (e.g. FPL, Entergy, Xcel, PG&E, SCE). Polled every 5 minutes while the layer is on.",
};

// after the wildfires (or at the end of Hazards)
if (!overlayDef("outages")) {
  let i = OVERLAYS.findIndex((o) => o.id === "fires");
  if (i < 0) i = OVERLAYS.reduce((a, o, k) => (o.group === "Hazards" ? k : a), -1);
  if (i < 0) i = OVERLAYS.length - 1;
  OVERLAYS.splice(i + 1, 0, outages);
}

// console / screenshot handle
(window as any).__tbwP7 = { outageLevel, outageSummary };
