// 0.8.2: pure helpers for the Alerts tab and the alert layer — regions (United States / Canada /
// International), sorting and filtering, awareness-level colours for non-NWS alerts, the
// "which international sources is the map looking at" test, and the nearest-radar pick.
// No DOM / store imports, so tests can load it.

export type AlertRegion = "us" | "ca" | "intl";
export const REGIONS: AlertRegion[] = ["us", "ca", "intl"];
export const REGION_LABEL: Record<AlertRegion, string> = { us: "United States", ca: "Canada", intl: "International" };

/** The tab an alert belongs in (NWS alerts carry no region in older servers / fixtures). */
export function regionOf(p: { region?: string; country?: string } | undefined): AlertRegion {
  const r = p?.region;
  if (r === "ca" || r === "intl" || r === "us") return r;
  const c = (p?.country ?? "").toUpperCase();
  if (c === "CA") return "ca";
  if (c && c !== "US") return "intl";
  return "us";
}

/** Awareness level → colour (MeteoAlarm / ECCC colours; CAP severity mapped onto them). */
export const LEVEL_COLORS: Record<string, string> = {
  red: "#e3171f",
  orange: "#ff9a1f",
  yellow: "#f5e10a",
  green: "#3cb44b",
  minor: "#4aa3ff",
  unknown: "#a0a0a0",
};
export function levelColor(level: string | undefined, severity?: string): string {
  const l = (level ?? "").toLowerCase();
  if (LEVEL_COLORS[l] && l !== "unknown") return LEVEL_COLORS[l];
  const s = (severity ?? "").toLowerCase();
  return s === "extreme" ? LEVEL_COLORS.red : s === "severe" ? LEVEL_COLORS.orange : s === "moderate" ? LEVEL_COLORS.yellow : s === "minor" ? LEVEL_COLORS.minor : LEVEL_COLORS.unknown;
}
/** Extra priority for non-NWS alerts by level (NWS priority comes from the event type). */
export function levelBoost(level: string | undefined): number {
  return level === "red" ? 30 : level === "orange" ? 15 : level === "yellow" ? 5 : 0;
}

export type SortKey = "priority" | "time" | "type" | "name";
export const SORT_LABEL: Record<SortKey, string> = { priority: "Priority", time: "Time", type: "Type", name: "Name" };

interface Feat {
  properties: { id: string; event?: string; areaDesc?: string; sent?: string; effective?: string; priority?: number; country?: string };
}
const t = (p: Feat["properties"]) => Date.parse(p.sent ?? p.effective ?? "") || 0;

/** Sort a list (copy): priority (default), time (newest first), type (A–Z, then priority), name
 * (area name A–Z). */
export function sortAlerts<T extends Feat>(list: T[], key: SortKey): T[] {
  const out = list.slice();
  const pri = (a: T, b: T) => (b.properties.priority ?? 0) - (a.properties.priority ?? 0) || t(b.properties) - t(a.properties);
  const s = (x: string | undefined) => (x ?? "").trim().toLocaleLowerCase();
  if (key === "time") out.sort((a, b) => t(b.properties) - t(a.properties) || pri(a, b));
  else if (key === "type") out.sort((a, b) => s(a.properties.event).localeCompare(s(b.properties.event)) || pri(a, b));
  else if (key === "name") out.sort((a, b) => s(a.properties.areaDesc).localeCompare(s(b.properties.areaDesc)) || pri(a, b));
  else out.sort(pri);
  return out;
}

/** Event types in a list with counts, most common first (ties A–Z). */
export function typeCounts(list: Feat[]): [string, number][] {
  const m = new Map<string, number>();
  for (const a of list) m.set(a.properties.event ?? "", (m.get(a.properties.event ?? "") ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Keep alerts whose type is in `types` (empty = all). */
export function filterTypes<T extends Feat>(list: T[], types: readonly string[]): T[] {
  if (!types.length) return list;
  const s = new Set(types);
  return list.filter((a) => s.has(a.properties.event ?? ""));
}

export type BBox = [number, number, number, number];
export function bboxHit(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export interface SrcInfo {
  id: string;
  region: string;
  bbox: BBox;
  enabled?: boolean;
}
/** International sources the map is looking at. A view wider than `maxSpan` degrees (the whole
 * world) asks for none — keeps it cheap; the International tab asks for all of them. */
export function sourcesInView(srcs: SrcInfo[], view: BBox, maxSpan = 70): string[] {
  const w = view[2] - view[0];
  if (w > maxSpan || view[3] - view[1] > maxSpan) return [];
  // a view across the antimeridian (east < west) is split
  const views: BBox[] = view[0] < -180 || view[2] > 180 ? [[Math.max(-180, view[0]), view[1], Math.min(180, view[2]), view[3]], view[0] < -180 ? [view[0] + 360, view[1], 180, view[3]] : [-180, view[1], view[2] - 360, view[3]]] : [view];
  return srcs.filter((s) => s.region === "intl" && s.enabled !== false && views.some((v) => bboxHit(s.bbox, v))).map((s) => s.id);
}

/** Great-circle distance (km). */
export function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The nearest of `list` to a point (null when the list is empty). */
export function nearest<T extends { lat: number; lon: number }>(list: T[], lat: number, lon: number): { item: T; km: number } | null {
  let best: { item: T; km: number } | null = null;
  for (const s of list) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const km = distKm(lat, lon, s.lat, s.lon);
    if (!best || km < best.km) best = { item: s, km };
  }
  return best;
}

/** Radars of the current single-site product family: Level III → NEXRAD + TDWR; Level II →
 * NEXRAD and ODIM (European / Canadian volumes), TDWR only if the current site is one. */
export function radarFamily<T extends { type?: string; kind?: string; region?: string; country?: string }>(sites: T[], source: "L2" | "L3", current?: T): T[] {
  const l3 = (s: T) => s.type === "NEXRAD" || s.type === "TDWR";
  if (source === "L3") return sites.filter(l3);
  return sites.filter((s) => s.type !== "TDWR" || current?.type === "TDWR");
}
