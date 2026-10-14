// 0.8.1: pure helpers for "identify layer items" (identify.ts): one point per feature, the
// layer's extent, and screen-space grid clustering so a pulse ring stays readable at any zoom.

export type LngLat = [number, number];

/** Calls fn for every [lng, lat] position in a GeoJSON geometry. */
function eachCoord(g: any, fn: (x: number, y: number) => void) {
  if (!g) return;
  if (g.type === "GeometryCollection") return g.geometries?.forEach((x: any) => eachCoord(x, fn));
  const walk = (c: any) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) fn(c[0], c[1]);
      return;
    }
    for (const x of c) walk(x);
  };
  walk(g.coordinates);
}

/** One representative position for a feature: the point itself, or the centre of its bounds. */
export function featurePoint(g: any): LngLat | null {
  if (!g) return null;
  if (g.type === "Point") return Array.isArray(g.coordinates) && Number.isFinite(g.coordinates[0]) && Number.isFinite(g.coordinates[1]) ? [g.coordinates[0], g.coordinates[1]] : null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  eachCoord(g, (x, y) => {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  });
  return w <= e ? [(w + e) / 2, (s + n) / 2] : null;
}

/** Feature points (lng/lat pairs, flat) + weights (cluster sizes when the data is pre-clustered). */
export function collectPoints(features: any[], max = 40000): { pts: Float64Array; wts: Float32Array; n: number; total: number } {
  const step = Math.max(1, Math.ceil(features.length / max));
  const cap = Math.ceil(features.length / step);
  const pts = new Float64Array(cap * 2);
  const wts = new Float32Array(cap);
  let n = 0;
  let total = 0;
  for (let i = 0; i < features.length; i += step) {
    const f = features[i];
    const p = featurePoint(f?.geometry);
    if (!p) continue;
    const w = (Number(f.properties?.point_count) || 1) * step;
    pts[n * 2] = p[0];
    pts[n * 2 + 1] = p[1];
    wts[n] = w;
    total += w;
    n++;
  }
  return { pts, wts, n, total: Math.round(total) };
}

/** [w, s, e, n] of the points, or null. */
export function extentOf(pts: Float64Array, n: number): [number, number, number, number] | null {
  if (!n) return null;
  let w = Infinity, s = Infinity, e = -Infinity, no = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > no) no = y;
  }
  return [w, s, e, no];
}

export interface Cluster {
  x: number;
  y: number;
  /** items in the group */
  n: number;
}

/** Screen-space clustering: points (flat x,y pixels) inside the view (plus margin) are binned in
 * `cell`-pixel cells, then neighbouring bins closer than `cell` are merged (largest first), so
 * the rings don't overlap. Cheap: O(points + bins²) with at most a few hundred bins. */
export function gridCluster(xy: ArrayLike<number>, wts: ArrayLike<number> | null, n: number, w: number, h: number, cell = 56, margin = 24): Cluster[] {
  const bins = new Map<number, { sx: number; sy: number; n: number }>();
  const cols = Math.ceil((w + 2 * margin) / cell) + 1;
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    if (!(x >= -margin && y >= -margin && x <= w + margin && y <= h + margin)) continue;
    const k = Math.floor((y + margin) / cell) * cols + Math.floor((x + margin) / cell);
    const wt = wts ? wts[i] : 1;
    const b = bins.get(k);
    if (b) {
      b.sx += x * wt;
      b.sy += y * wt;
      b.n += wt;
    } else bins.set(k, { sx: x * wt, sy: y * wt, n: wt });
  }
  const list: Cluster[] = [...bins.values()].map((b) => ({ x: b.sx / b.n, y: b.sy / b.n, n: b.n })).sort((a, b) => b.n - a.n);
  const out: Cluster[] = [];
  const used = new Uint8Array(list.length);
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    let { x: sx, y: sy, n: cn } = list[i];
    sx *= cn;
    sy *= cn;
    const cx = list[i].x, cy = list[i].y;
    for (let j = i + 1; j < list.length; j++) {
      if (used[j]) continue;
      const d = Math.hypot(list[j].x - cx, list[j].y - cy);
      if (d < cell) {
        used[j] = 1;
        sx += list[j].x * list[j].n;
        sy += list[j].y * list[j].n;
        cn += list[j].n;
      }
    }
    out.push({ x: sx / cn, y: sy / cn, n: Math.round(cn) });
  }
  return out;
}

/** Ring radius in CSS pixels for a group of n items (fixed on screen, so it reads when zoomed out). */
export function ringRadius(n: number): number {
  return n <= 1 ? 12 : Math.min(36, 13 + 4.5 * Math.log2(n));
}

/** Grid cell in pixels: bigger when there are many items so the map doesn't fill with rings. */
export function cellFor(itemsInView: number): number {
  return itemsInView > 2000 ? 120 : itemsInView > 300 ? 96 : 60;
}
