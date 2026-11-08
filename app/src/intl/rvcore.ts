// 0.8.3: which RainViewer radars get a marker (pure, unit-tested).

export interface RvRadar {
  id: string;
  /** intl source id ("rv_AU02") */
  source: string;
  name: string;
  state?: string;
  country: string;
  country_name?: string;
  lat: number;
  lon: number;
  range_km: number;
  bounds?: [number, number, number, number];
  /** listed in RainViewer's image index right now */
  listed?: boolean;
}

const EU = new Set("AT BE BG BY CH CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LV NL NO PL PT RO RS SE SI SK UA".split(" "));

/** Region key of the radar-sites filter ("US" | "CA" | "EU" | "OT"). */
export function rvRegion(cc: string): string {
  const c = (cc || "").toUpperCase();
  return c === "CA" ? "CA" : EU.has(c) ? "EU" : c === "US" ? "US" : "OT";
}

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/**
 * Radars to mark in the view: listed by RainViewer, inside the (padded) view, not where Stormiq
 * already has a radar of its own (within `dupKm` of a native site), not in a hidden region; at
 * most `max` (nearest the view centre first). The selected one always stays.
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
    if (r.listed === false || hidden.has(rvRegion(r.country))) return false;
    if (r.lat < s || r.lat > n || !lonIn(r.lon)) return false;
    return !native.some((x) => Math.abs(x.lat - r.lat) < 1 && km(x.lat, x.lon, r.lat, r.lon) < dupKm);
  });
  if (out.length <= max) return out;
  out.sort((a, b) => (a.source === selected ? -1 : b.source === selected ? 1 : Math.hypot(a.lat - cy, a.lon - cx) - Math.hypot(b.lat - cy, b.lon - cx)));
  return out.slice(0, max);
}
