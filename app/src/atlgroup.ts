// 0.8.3: alert timeline helpers — one group (lane) per alert type, ordered like the map's priority
// (tornado, severe t-storm, flash flood, other warnings, watches, advisories, statements), then the
// non-alert lanes (mesoscale discussions, storm reports, model detections). Include / exclude type
// filter and the time span the canvas needs (active alerts can start or end in the future).
// Pure: no DOM / store imports, so tests can load it.

/** one key per NWS warning from its VTEC ("/O.NEW.KOUN.TO.W.0012.…/" live, "OUN.TO.W.0012"
 * archive) so a live warning and its archive copy show once */
export function vtecKey(v: unknown): string | null {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  const m = /(?:^|[./])([A-Z]{3,4})\.([A-Z]{2})\.([A-Z])\.(\d{4})(?=[./]|$)/.exec(s);
  return m ? `${m[1].slice(-3)}.${m[2]}.${m[3]}.${+m[4]}` : null;
}

/** lanes that aren't alert types */
export const KIND_LANES: Record<string, string> = { md: "Mesoscale discussions", lsr: "Storm reports", ml: "Model detections" };

/** sort rank of a group (lower first) */
export function typeRank(type: string): number {
  if (type in KIND_LANES) return 900 + Object.keys(KIND_LANES).indexOf(type);
  const e = type.toLowerCase();
  if (e.includes("tornado emergency")) return 0;
  if (e === "tornado warning") return 1;
  if (e === "extreme wind warning") return 2;
  if (e === "severe thunderstorm warning") return 3;
  if (e === "flash flood warning") return 4;
  if (e === "snow squall warning") return 5;
  if (e.endsWith("emergency")) return 6;
  if (e.endsWith("warning")) return 10;
  if (e.endsWith("watch")) return e.startsWith("tornado") ? 20 : e.startsWith("severe thunderstorm") ? 21 : 22;
  if (e.endsWith("advisory")) return 30;
  if (e.endsWith("statement")) return 40;
  return 50;
}

export interface GItem {
  key: string;
  /** group: the alert type ("Winter Storm Warning") or a KIND_LANES id */
  type: string;
  t0: number;
  t1: number;
  color: string;
}

export interface Group<T extends GItem> {
  type: string;
  name: string;
  color: string;
  items: T[];
}

/** Group items by type, groups ordered by rank then name; items keep their order. The group's
 * colour is its first item's (types share one colour; storm reports differ per item). */
export function groupItems<T extends GItem>(items: T[], laneColor: (type: string) => string | undefined = () => undefined): Group<T>[] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const l = m.get(it.type);
    if (l) l.push(it);
    else m.set(it.type, [it]);
  }
  return [...m.entries()]
    .map(([type, its]) => ({ type, name: KIND_LANES[type] ?? type, color: laneColor(type) ?? its[0].color, items: its }))
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.name.localeCompare(b.name));
}

/** type → "in" (show only these) or "out" (hide) */
export type TypeFilter = Record<string, "in" | "out">;

/** click on a chip: off → only → hidden → off */
export function cycleFilter(f: TypeFilter, type: string): TypeFilter {
  const n = { ...f };
  const cur = f[type];
  if (!cur) n[type] = "in";
  else if (cur === "in") n[type] = "out";
  else delete n[type];
  return n;
}

/** passes the filter: hidden types never; when any type is "only", just those */
export function passes(f: TypeFilter, type: string): boolean {
  const s = f[type];
  if (s === "out") return false;
  if (s === "in") return true;
  return !Object.values(f).includes("in");
}

export function applyFilter<T extends GItem>(items: T[], f: TypeFilter): T[] {
  return items.filter((i) => passes(f, i.type));
}

/** chips: every type present (filtered or not) with its count, in group order */
export function typeChips(items: GItem[]): { type: string; name: string; n: number; color: string }[] {
  return groupItems(items).map((g) => ({ type: g.type, name: g.name, n: g.items.length, color: g.color }));
}

/** canvas end: at least `now + minAhead`, far enough for the latest start / end, never past
 * `now + maxAhead` (alerts "until further notice" run for weeks) */
export function spanEnd(items: GItem[], now: number, minAhead = 2 * 3600_000, maxAhead = 7 * 24 * 3600_000): number {
  let end = now + minAhead;
  for (const i of items) end = Math.max(end, i.t1, i.t0 + 3600_000);
  return Math.min(end, now + maxAhead);
}

/** rows for a group: greedy interval packing (first row whose last item ended before this one) */
export function packRows<T extends { key: string; t0: number; t1: number; point?: boolean }>(items: T[], pxPerMs: number, minPx = 6): Map<string, number> {
  const rows: number[] = [];
  const out = new Map<string, number>();
  const sorted = items.slice().sort((a, b) => a.t0 - b.t0);
  for (const it of sorted) {
    const x0 = it.t0 * pxPerMs;
    const x1 = Math.max(x0 + (it.point ? 10 : minPx), it.t1 * pxPerMs) + (it.point ? 0 : 2);
    let r = rows.findIndex((end) => end <= x0);
    if (r < 0) {
      r = rows.length;
      rows.push(0);
    }
    rows[r] = x1;
    out.set(it.key, r);
  }
  return out;
}

/* ---------- 0.8.4: timeline search ---------- */
const STATES: Record<string, string> = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", GU: "Guam" };

/** lower case, accents removed (so "Yucatan" finds "Yucatán") */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function searchWords(q: string): string[] {
  return foldText(q).split(/\s+/).filter(Boolean);
}

const SEARCH_PROPS = ["event", "headline", "description", "instruction", "areaDesc", "senderName", "sender", "wfo", "city", "st", "state", "county", "country", "remark", "text", "concerning", "typetext", "source"];

/** everything the timeline search looks through for one item (folded); state codes also count as their names */
export function searchText(it: { type: string; title?: string; sub?: string; props?: any }): string {
  const parts: string[] = [KIND_LANES[it.type] ?? it.type, it.title ?? "", it.sub ?? ""];
  for (const k of SEARCH_PROPS) {
    const v = it.props?.[k];
    if (typeof v === "string" && v) parts.push(v);
  }
  const places = `${it.props?.areaDesc ?? ""} ${it.props?.st ?? ""} ${it.props?.state ?? ""}`;
  const names = new Set<string>();
  for (const m of places.matchAll(/\b[A-Z]{2}\b/g)) if (STATES[m[0]]) names.add(STATES[m[0]]);
  return foldText([...parts, ...names].join(" "));
}

/** items whose text has every search word (the list itself when there are no words) */
export function searchItems<T>(items: T[], words: string[], textOf: (it: T) => string): T[] {
  if (!words.length) return items;
  return items.filter((it) => {
    const t = textOf(it);
    return words.every((w) => t.includes(w));
  });
}
/* ---------- end 0.8.4 ---------- */
