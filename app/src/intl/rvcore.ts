// 0.8.3 / 0.8.4: RainViewer radars: the shared list, regions and which ones get a marker (pure
// helpers, unit-tested).

import { signal } from "@preact/signals";

export interface RvRadar {
  id: string;
  /** intl source id ("rv_AU022") */
  source: string;
  name: string;
  state?: string;
  country: string;
  country_name?: string;
  lat: number;
  lon: number;
  range_km: number;
  bounds?: [number, number, number, number];
  /** "map": drawn on the map; "panel": the agency's picture, shown in a floating panel */
  display?: "map" | "panel";
}

/** Every RainViewer radar the server knows (filled by `loadRvRadars`). */
export const rvRadars = signal<RvRadar[]>([]);

const EU = new Set("AT BE BG BY CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LT LU LV MT NL NO PL PT RO RS SE SI SK UA".split(" "));
const OC = new Set("AU NZ FJ TO MH PG NC VU WS".split(" "));
const SA = new Set("BR AR CO CL PE VE UY BO EC PY".split(" "));
const CB = new Set("MX BB BM CW DO JM KY NI PA SV CU CR GT HN BS PR HT TT".split(" "));
const AF = new Set("ZA MU EG MA NG KE TN DZ SN GH RE".split(" "));
const AS = new Set("CN HK TW JP KR IN ID TH VN MY SG PH KH BD PK TR SA AE OM BH KW QA IL IR IQ JO LB KZ UZ GE AM AZ MN LK NP MM LA BT KG TJ TM AF".split(" "));

/** Region key of the radar-sites filter. */
export function rvRegion(cc: string): string {
  const c = (cc || "").toUpperCase();
  if (c === "US") return "US";
  if (c === "CA") return "CA";
  if (EU.has(c)) return "EU";
  if (OC.has(c)) return "OC";
  if (SA.has(c)) return "SA";
  if (CB.has(c)) return "CB";
  if (AF.has(c)) return "AF";
  if (AS.has(c)) return "AS";
  return "OT";
}

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/**
 * Radars to mark in the view: inside the (padded) view, not where Stormiq already has a radar of
 * its own (within `dupKm` of a native site), not in a hidden region; at most `max` (nearest the
 * view centre first). The selected one always stays.
 */
export function rvVisible(
  list: RvRadar[],
  view: { w: number; s: number; e: number; n: number },
  native: { lat: number; lon: number }[],
  hidden: Set<string>,
  selected = "",
  max = 160,
  dupKm = 30,
): RvRadar[] {
  const padX = (view.e - view.w) * 0.1;
  const padY = (view.n - view.s) * 0.1;
  const w = view.w - padX, e = view.e + padX, s = view.s - padY, n = view.n + padY;
  const lonIn = (lon: number) => {
    if (e - w >= 360) return true;
    // views crossing the antimeridian come with east > 180
    for (const k of [-360, 0, 360]) if (lon + k >= w && lon + k <= e) return true;
    return false;
  };
  const cy = (view.s + view.n) / 2, cx = (view.w + view.e) / 2;
  const out = list.filter((r) => {
    if (r.source === selected) return true;
    if (hidden.has(rvRegion(r.country))) return false;
    if (r.lat < s || r.lat > n || !lonIn(r.lon)) return false;
    return !native.some((x) => Math.abs(x.lat - r.lat) < 1 && km(x.lat, x.lon, r.lat, r.lon) < dupKm);
  });
  if (out.length <= max) return out;
  out.sort((a, b) => (a.source === selected ? -1 : b.source === selected ? 1 : Math.hypot(a.lat - cy, a.lon - cx) - Math.hypot(b.lat - cy, b.lon - cx)));
  return out.slice(0, max);
}
