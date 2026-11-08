// 0.8.2 offline areas: pure tile maths (no DOM / map imports, unit-tested in tests/offlinecover.test.ts).
//
// An offline area is a polygon drawn on one basemap with a max zoom. The tiles it needs are the
// tiles that intersect the polygon (not its bounding box) at every zoom from minz to maxz, for each
// tile template of the basemap, plus the basemap's TileJSON / glyph URLs. The tile store is shared
// and keyed by tile URL (host/path/z/x/y), so a tile is stored once however many areas need it;
// its reference count is the number of areas that need it. Download / Edit → Update / Delete are
// all "go from these areas to those areas": fetch what is needed now and wasn't before, delete what
// was needed before and isn't now. Because a tile at zoom z is needed when any covering polygon goes
// to z or deeper, the max zoom kept for overlapping polygons is the highest of them.

export type LngLat = [number, number];

export interface OfflineArea {
  id: string;
  /** Basemap id (store.ts Basemap) the area was saved for */
  basemap: string;
  name: string;
  /** polygon ring, lon/lat, not closed (first point not repeated) */
  poly: LngLat[];
  minz: number;
  maxz: number;
  /** tile URL templates ({z} {x} {y}) of the basemap when downloaded */
  templates: { url: string; maxzoom: number; minzoom?: number }[];
  /** other URLs saved with it (TileJSON, glyph ranges) */
  extra: string[];
  tiles: number;
  bytes: number;
  failed?: number;
  /** URLs that failed (retried on the next Update), at most 2000 */
  missing?: string[];
  saved: number;
}

/** Stable key for a tile/resource URL: no scheme or query, CARTO subdomain and OpenFreeMap version dropped. */
export function tileKey(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\?.*$/, "")
    .replace(/^[a-d]\.basemaps\.cartocdn\.com/, "basemaps.cartocdn.com")
    .replace(/(tiles\.openfreemap\.org\/[a-z]+)\/\d{8}_\d{6}_[a-z]+\//, "$1/");
}

export const fillTemplate = (t: string, z: number, x: number, y: number) => t.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{r}", "");

// ---------- projection ----------
const MAXLAT = 85.0511;
/** lon/lat → fractional tile coordinates at zoom z */
export function toTile(p: LngLat, z: number): [number, number] {
  const n = 2 ** z;
  const lat = (Math.max(-MAXLAT, Math.min(MAXLAT, p[1])) * Math.PI) / 180;
  return [((p[0] + 180) / 360) * n, ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n];
}

/** metres per pixel of a 256 px tile at a latitude */
export const metresPerPixel = (z: number, lat: number) => (156543.034 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

// ---------- polygon → tile cover ----------

/** x ranges [x0, x1] (inclusive) of the tiles in row y that intersect the polygon (tile coords). */
function rowRanges(pts: [number, number][], y: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  const y0 = y, y1 = y + 1;
  const m = pts.length;
  // 1) tiles crossed by an edge: clip each edge to the strip y0..y1
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
    if (hi < y0 || lo > y1) continue;
    let xa: number, xb: number;
    if (a[1] === b[1]) {
      xa = a[0];
      xb = b[0];
    } else {
      const xAt = (yy: number) => a[0] + ((yy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      xa = xAt(Math.max(lo, y0));
      xb = xAt(Math.min(hi, y1));
    }
    out.push([Math.floor(Math.min(xa, xb)), Math.floor(Math.max(xa, xb))]);
  }
  // 2) tiles inside: even-odd spans along the row's centre line
  const yc = y + 0.5;
  const xs: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    if (a[1] > yc !== b[1] > yc) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
  }
  xs.sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([Math.floor(xs[i]), Math.floor(xs[i + 1])]);
  // clamp + merge
  const r = out.map(([p, q]) => [Math.max(0, p), Math.min(n - 1, q)] as [number, number]).filter(([p, q]) => p <= q);
  r.sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const s of r) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged;
}

/** Rows of tiles intersecting the polygon at zoom z: [y, [[x0, x1], …]][] */
export function coverRows(poly: LngLat[], z: number): [number, [number, number][]][] {
  if (poly.length < 3) return [];
  const n = 2 ** z;
  const pts = poly.map((p) => toTile(p, z));
  let ymin = Infinity, ymax = -Infinity;
  for (const p of pts) {
    ymin = Math.min(ymin, p[1]);
    ymax = Math.max(ymax, p[1]);
  }
  const out: [number, [number, number][]][] = [];
  for (let y = Math.max(0, Math.floor(ymin)); y <= Math.min(n - 1, Math.floor(ymax)); y++) {
    const r = rowRanges(pts, y, n);
    if (r.length) out.push([y, r]);
  }
  return out;
}

export function* coverTiles(poly: LngLat[], z: number): Generator<[number, number]> {
  for (const [y, rs] of coverRows(poly, z)) for (const [x0, x1] of rs) for (let x = x0; x <= x1; x++) yield [x, y];
}

/** tiles per zoom level (for the size estimate) */
export function countCover(poly: LngLat[], minz: number, maxz: number): number {
  let n = 0;
  for (let z = minz; z <= maxz; z++) for (const [, rs] of coverRows(poly, z)) for (const [a, b] of rs) n += b - a + 1;
  return n;
}

/** does tile z/x/y intersect the polygon? */
export function tileInPoly(poly: LngLat[], z: number, x: number, y: number): boolean {
  if (poly.length < 3) return false;
  const pts = poly.map((p) => toTile(p, z));
  let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
  for (const p of pts) {
    ymin = Math.min(ymin, p[1]);
    ymax = Math.max(ymax, p[1]);
    xmin = Math.min(xmin, p[0]);
    xmax = Math.max(xmax, p[0]);
  }
  if (y < Math.floor(ymin) || y > Math.floor(ymax) || x < Math.floor(xmin) || x > Math.floor(xmax)) return false;
  return rowRanges(pts, y, 2 ** z).some(([a, b]) => x >= a && x <= b);
}

// ---------- areas → keys, ref counts, change plans ----------

type AreaTiles = Pick<OfflineArea, "poly" | "minz" | "maxz" | "templates" | "extra">;

/** every URL an area needs (tiles of each template at each zoom it has, then extras) */
export function* areaUrls(a: AreaTiles): Generator<string> {
  for (const t of a.templates) {
    const z1 = Math.min(a.maxz, t.maxzoom);
    for (let z = Math.max(a.minz, t.minzoom ?? 0); z <= z1; z++) for (const [x, y] of coverTiles(a.poly, z)) yield fillTemplate(t.url, z, x, y);
  }
  yield* a.extra;
}

/** store key → number of areas that need it */
export function refCounts(areas: AreaTiles[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of areas) {
    const seen = new Set<string>();
    for (const u of areaUrls(a)) {
      const k = tileKey(u);
      if (seen.has(k)) continue;
      seen.add(k);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
}

export function neededKeys(areas: AreaTiles[]): Set<string> {
  const s = new Set<string>();
  for (const a of areas) for (const u of areaUrls(a)) s.add(tileKey(u));
  return s;
}

/** Going from `before` to `after` (all areas of the store): URLs to fetch and keys to delete. */
export function planChange(before: AreaTiles[], after: AreaTiles[]): { add: string[]; del: string[] } {
  const had = neededKeys(before);
  const add: string[] = [];
  const now = new Set<string>();
  for (const a of after)
    for (const u of areaUrls(a)) {
      const k = tileKey(u);
      if (now.has(k)) continue;
      now.add(k);
      if (!had.has(k)) add.push(u);
    }
  const del: string[] = [];
  for (const k of had) if (!now.has(k)) del.push(k);
  return { add, del };
}

/** point-in-polygon (lon/lat, even-odd) */
export function pointInPoly(p: LngLat, poly: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
