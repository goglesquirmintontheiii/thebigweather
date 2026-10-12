// NEXRAD storm cell attributes: markers (TVS / meso / hail), motion arrows with 15-minute
// forecast positions, a threat score, and the storm table's data.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { signal } from "@preact/signals";
import { settings } from "../store";
import { histRange } from "../anim";
import { destination, compass, speedFactor } from "../util";
import type { Style, Popup } from "./defs";

const bold = ["Noto Sans Bold"];
const font = ["Noto Sans Regular"];
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });

export const mesoRank = (p: any) => {
  const n = parseInt(String(p?.meso ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};
export const hasTvs = (p: any) => !!p?.tvs && String(p.tvs).toUpperCase() !== "NONE";
export const hasHail = (p: any) => (p?.posh ?? 0) >= 50 || (p?.max_size ?? 0) >= 1;

/** Rough threat ranking for sorting: TVS ≫ strong meso > big hail > intense core. */
export function threat(p: any): number {
  const m = mesoRank(p);
  return (hasTvs(p) ? 100 : 0) + (m >= 5 ? m * 3 : 0) + (p.posh ?? 0) * 0.4 + (p.max_size ?? 0) * 15 + (p.vil ?? 0) * 0.3 + Math.max(0, (p.max_dbz ?? 0) - 50);
}

/** Speed (kt) in the user's units. */
export function fmtKt(kt: number | null | undefined) {
  if (kt == null) return "—";
  const u = settings.value.units.speed;
  return `${Math.round((kt / 1.943844) * speedFactor())} ${u}`;
}

/** cells from the last fetch (storm table, rotation scan) */
export const stormCells = signal<{ t: number; cells: { lon: number; lat: number; p: any }[] }>({ t: 0, cells: [] });

const MINUTES = [15, 30, 45, 60];

/** cells closer than this are one storm seen by several radars (when they move alike) */
const MERGE_M = 7000;

function sameMotion(a: any, b: any): boolean {
  if (a.dir_to == null || b.dir_to == null || !(a.sknt > 0) || !(b.sknt > 0)) return true; // can't tell: trust the distance
  const d = Math.abs(((a.dir_to - b.dir_to + 540) % 360) - 180);
  return d <= 50 && Math.abs(a.sknt - b.sknt) <= 18;
}

const maxOf = (a: any, b: any) => (a == null ? b : b == null ? a : Math.max(a, b));

/** One feature per storm: detections within ~7 km with similar motion are merged, keeping the
 * position/motion/id from the nearest radar (or a clearly newer scan) and the worst of the
 * attributes (TVS, meso rank, hail, VIL, dBZ, tops). `_radars` lists every radar that saw it. */
export function mergeCells<T extends { geometry?: any; properties?: any }>(feats: T[]): T[] {
  const pts = feats.filter((f) => f.geometry?.type === "Point" && f.geometry.coordinates);
  const rng = (f: T) => f.properties?.range_km ?? f.properties?.range ?? 999;
  pts.sort((a, b) => rng(a) - rng(b) || (b.properties?.t ?? 0) - (a.properties?.t ?? 0));
  const kept: T[] = [];
  for (const f of pts) {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry.coordinates;
    const k = kept.find((q) => {
      const [x, y] = q.geometry.coordinates;
      return Math.hypot((x - lon) * 111_195 * Math.cos((lat * Math.PI) / 180), (y - lat) * 111_195) < MERGE_M && sameMotion(q.properties, p);
    });
    if (!k) {
      kept.push({ ...f, properties: { ...p, _radars: [p.nexrad].filter(Boolean) } });
      continue;
    }
    const q = k.properties;
    if ((p.t ?? 0) - (q.t ?? 0) > 10 * 60_000) {
      // a much newer scan wins the position and motion
      (k as any).geometry = f.geometry;
      for (const key of ["nexrad", "storm_id", "t", "azimuth", "range", "range_km", "drct", "dir_to", "sknt"]) q[key] = p[key];
    }
    if (p.nexrad && !q._radars.includes(p.nexrad)) q._radars.push(p.nexrad);
    if (hasTvs(p) && !hasTvs(q)) q.tvs = p.tvs;
    if (mesoRank(p) > mesoRank(q)) q.meso = p.meso;
    for (const key of ["posh", "poh", "max_size", "vil", "max_dbz", "top"]) q[key] = maxOf(q[key], p[key]);
    if (p.max_dbz != null && p.max_dbz === q.max_dbz && p.max_dbz_height != null) q.max_dbz_height = p.max_dbz_height;
  }
  return kept;
}

/** Adds motion arrows (+15 min), dashed forecast track to +60 min and ETA ticks for every
 * moving cell. Derived features carry `_k`; cells are left as they come. */
export function stormPrepare(fc: any) {
  const feats = mergeCells(fc?.features ?? []);
  const extra: any[] = [];
  const cells: { lon: number; lat: number; p: any }[] = [];
  for (const f of feats) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates;
    if (!c) continue;
    p._threat = Math.round(threat(p));
    p._eta = etaText(cellEtas(c[1], c[0], p)); // ETAs to saved points
    cells.push({ lon: c[0], lat: c[1], p });
    if (p.dir_to == null || !(p.sknt > 0)) continue;
    const pos = MINUTES.map((m) => destination(c[1], c[0], p.dir_to, p.sknt * 1852 * (m / 60)));
    const base = { nexrad: p.nexrad, storm_id: p.storm_id, t: p.t, _threat: p._threat };
    extra.push({ type: "Feature", geometry: { type: "LineString", coordinates: [c, pos[0]] }, properties: { ...base, _k: "arrow" } });
    extra.push({ type: "Feature", geometry: { type: "Point", coordinates: pos[0] }, properties: { ...base, _k: "head", dir: p.dir_to } });
    extra.push({ type: "Feature", geometry: { type: "LineString", coordinates: pos }, properties: { ...base, _k: "fc" } });
    pos.forEach((q, i) => extra.push({ type: "Feature", geometry: { type: "Point", coordinates: q }, properties: { ...base, _k: "tick", m: MINUTES[i], eta: p.t ? hhmm(p.t + MINUTES[i] * 60000) : `+${MINUTES[i]}` } }));
  }
  cells.sort((a, b) => b.p._threat - a.p._threat);
  notifyEtas(cells);
  stormCells.value = { t: Date.now(), cells };
  return { ...fc, features: [...extra, ...feats], _count: feats.length, _raw: fc?.features?.length ?? 0 };
}

const isCell: ExpressionSpecification = ["!", ["has", "_k"]];
const MESO: ExpressionSpecification = ["to-number", ["get", "meso"], 0];
const TVS: ExpressionSpecification = ["!=", ["upcase", ["to-string", ["get", "tvs"]]], "NONE"];
const HAIL: ExpressionSpecification = ["any", [">=", ["coalesce", ["get", "posh"], 0], 50], [">=", ["coalesce", ["get", "max_size"], 0], 1]];
const DBZ_COLOR: ExpressionSpecification = ["interpolate", ["linear"], ["coalesce", ["get", "max_dbz"], 40], 40, "#4ade80", 48, "#facc15", 55, "#f97316", 60, "#ef4444", 66, "#d946ef"];

export function stormLayers(s: string, st: Style, o: Record<string, string>): LayerSpecification[] {
  const z = st.size;
  const only: any = o.show === "severe" ? ["any", TVS, [">=", MESO, 5], HAIL] : o.show === "rot" ? ["any", TVS, [">=", MESO, 5]] : true;
  const track = o.track !== "0";
  const k = (v: string): ExpressionSpecification => ["==", ["get", "_k"], v];
  return [
    ...(track
      ? ([
          { id: `${s}-fc`, type: "line", source: s, minzoom: 5, filter: k("fc"), paint: { "line-color": "#e5e7eb", "line-width": 1.3, "line-opacity": 0.75 * st.opacity, "line-dasharray": [2, 2] } },
          { id: `${s}-arrow`, type: "line", source: s, filter: k("arrow"), layout: { "line-cap": "round" }, paint: { "line-color": "#fff", "line-width": 2.2 * z, "line-opacity": st.opacity } },
          { id: `${s}-tick`, type: "circle", source: s, minzoom: 6.5, filter: k("tick"), paint: { "circle-radius": 2.6, "circle-color": "#fff", "circle-stroke-color": "#000", "circle-stroke-width": 1, "circle-opacity": st.opacity } },
          ...(st.labels ? [{ id: `${s}-eta-text`, type: "symbol", source: s, minzoom: 8, filter: k("tick"), layout: { "text-field": ["get", "eta"], "text-font": font, "text-size": 10, "text-offset": [0.7, 0], "text-anchor": "left", "text-optional": true }, paint: { "text-color": "#e5e7eb", "text-halo-color": "#000", "text-halo-width": 1.2 } }] : []),
          { id: `${s}-head`, type: "symbol", source: s, filter: k("head"), layout: { "icon-image": "sa-head", "icon-size": 0.85 * z, "icon-rotate": ["get", "dir"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": "#fff", "icon-halo-color": "#000", "icon-halo-width": 1, "icon-opacity": st.opacity } },
        ] as LayerSpecification[])
      : []),
    { id: `${s}-meso`, type: "circle", source: s, filter: ["all", isCell, [">=", MESO, 5], only], paint: { "circle-radius": ["interpolate", ["linear"], MESO, 5, 8 * z, 25, 13 * z], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#facc15", "circle-stroke-width": 2.6, "circle-stroke-opacity": st.opacity } } as LayerSpecification,
    {
      id: `${s}-pt`,
      type: "circle",
      source: s,
      filter: ["all", isCell, only],
      layout: { "circle-sort-key": ["coalesce", ["get", "max_dbz"], 0] },
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.2 * z, 9, 5 * z], "circle-color": DBZ_COLOR, "circle-stroke-color": "#000", "circle-stroke-width": 1.2, "circle-opacity": st.opacity },
    } as LayerSpecification,
    { id: `${s}-hail`, type: "symbol", source: s, filter: ["all", isCell, HAIL, only], layout: { "icon-image": "sa-hail", "icon-size": z, "icon-offset": [11, -9], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-tvs`, type: "symbol", source: s, filter: ["all", isCell, TVS], layout: { "icon-image": "sa-tvs", "icon-size": 1.1 * z, "icon-anchor": "bottom", "icon-offset": [0, -3], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-opacity": st.opacity } } as LayerSpecification,
    ...(st.labels
      ? [{ id: `${s}-text`, type: "symbol", source: s, minzoom: 7, filter: ["all", isCell, only], layout: { "text-field": ["get", "storm_id"], "text-font": bold, "text-size": 10, "text-offset": [-0.9, 0], "text-anchor": "right", "text-optional": true }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 } } as LayerSpecification]
      : []),
  ];
}

/** radars that detected the (merged) cell; MapLibre hands arrays back as JSON strings */
function radarsOf(p: any): string[] {
  const r = p?._radars;
  if (Array.isArray(r)) return r;
  try {
    return typeof r === "string" ? JSON.parse(r) : [];
  } catch {
    return [];
  }
}

export function cellFlags(p: any): string {
  const m = mesoRank(p);
  return [hasTvs(p) && "TVS", m >= 5 ? `Meso ${m}` : m > 0 ? `Shear ${m}` : "", hasHail(p) && `Hail ${p.max_size ?? "?"} in`].filter(Boolean).join(" · ");
}

export function stormClick(p: any): Popup | undefined {
  if (p._k) return undefined;
  const v = (x: any, u = "") => (x == null || x === "" ? "—" : `${x}${u}`);
  const tvs = hasTvs(p);
  return {
    title: `Cell ${p.storm_id} · K${p.nexrad}${radarsOf(p).length > 1 ? ` (+${radarsOf(p).length - 1})` : ""}`,
    sub: cellFlags(p) || "No rotation or hail flags",
    color: tvs ? "#ef4444" : mesoRank(p) >= 5 ? "#facc15" : hasHail(p) ? "#22c55e" : "#94a3b8",
    rows: [
      ["Max dBZ", p.max_dbz != null ? `${p.max_dbz}${p.max_dbz_height ? ` @ ${p.max_dbz_height} kft` : ""}` : "—"],
      ["Echo top", v(p.top, " kft")],
      ["VIL", v(p.vil, " kg/m²")],
      ["Hail (POSH/POH)", `${v(p.posh, "%")} / ${v(p.poh, "%")}`],
      ["Max hail", v(p.max_size, " in")],
      ["Moving", p.dir_to != null && p.sknt ? `${compass(p.dir_to)} ${fmtKt(p.sknt)}` : "Stationary"],
      ["Meso / TVS", `${p.meso ?? "NONE"} / ${p.tvs ?? "NONE"}`],
      ["Scan", p.t ? hhmm(p.t) : "—"],
      ...(radarsOf(p).length > 1 ? [["Seen by", radarsOf(p).map((r) => `K${r}`).join(", ")] as [string, string]] : []),
      ...(p._eta ? [["Reaches", String(p._eta)] as [string, string]] : []),
    ],
  };
}

// ---------- ETAs to saved points ----------

/** a cell's track passes within this distance of a point */
export const ETA_RADIUS_M = 5000;
const ETA_MINUTES = 60;

/** Saved points the cell's projected path (dir_to / sknt, 60 min) passes within ~5 km of. */
export function cellEtas(lat: number, lon: number, p: any): { id: string; name: string; min: number; miss: number }[] {
  if (p?.dir_to == null || !(p.sknt > 0)) return [];
  const mpm = (p.sknt * 1852) / 60; // metres per minute
  const L = mpm * ETA_MINUTES;
  const a = (p.dir_to * Math.PI) / 180;
  const ux = Math.sin(a), uy = Math.cos(a);
  const k = Math.cos((lat * Math.PI) / 180) * 111_195;
  const out: { id: string; name: string; min: number; miss: number }[] = [];
  for (const pt of settings.value.points) {
    const dx = (pt.lon - lon) * k, dy = (pt.lat - lat) * 111_195;
    const along = dx * ux + dy * uy;
    const cross = Math.abs(dx * uy - dy * ux);
    const near = Math.hypot(dx, dy) < ETA_RADIUS_M;
    if (!near && (along < 0 || along > L + ETA_RADIUS_M || cross > ETA_RADIUS_M)) continue;
    out.push({ id: pt.id, name: pt.name, min: near ? 0 : Math.max(0, Math.round(along / mpm)), miss: Math.round(near ? Math.hypot(dx, dy) : cross) });
  }
  return out.sort((x, y) => x.min - y.min);
}

export function etaText(list: { name: string; min: number }[]): string {
  return list.map((e) => `${e.name} ${e.min === 0 ? "now" : `${e.min} min`}`).join(" · ");
}

const notified = new Map<string, number>();
function notifyEtas(cells: { lon: number; lat: number; p: any }[]) {
  if (!settings.value.etaNotify || histRange.peek()) return; // not for replayed (history) cells
  const now = Date.now();
  for (const [k, t] of notified) if (now - t > 3 * 3600_000) notified.delete(k);
  for (const c of cells) {
    for (const e of cellEtas(c.lat, c.lon, c.p)) {
      const key = `${c.p.nexrad}-${c.p.storm_id}-${e.id}`;
      if (notified.has(key)) continue;
      notified.set(key, now);
      const flags = cellFlags(c.p);
      const msg = `Cell ${c.p.storm_id}${flags ? ` (${flags})` : ""} reaches ${e.name} ${e.min === 0 ? "now" : `in ~${e.min} min`}`;
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Storm approaching", { body: msg, silent: false });
      } catch {
        /* ignore */
      }
      import("../store").then((m) => m.toast(msg, "alert", 9000));
    }
  }
}
