// 0.8.3 windows: pure geometry for dragging pop-out windows back into the main window (WinDrop.tsx).
//   - a window docks when it's dropped on the spot it came from (its "home" rectangle)
//   - a map pane snaps into a pane spot of the current layout, Windows-snap style: near an outer edge
//     of the map area it takes a new full-height column / full-width row there; near an edge of a pane
//     it takes that half of the pane; the middle of a pane is no spot (moving a pop-out over the map
//     doesn't dock it by accident).
// No DOM / store imports, so tests can load it.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GCell {
  r: number;
  c: number;
  rs: number;
  cs: number;
}
export interface Grid {
  rows: number;
  cols: number;
  cells: GCell[];
}
export type Side = "left" | "right" | "top" | "bottom";
export interface SnapHit {
  /** what the spot is: "edge:right", "cell:2:top", … */
  key: string;
  /** where the pane will be, in the same units as the map box */
  rect: Rect;
  /** the new layout: the old cells in their order, then the docked pane last */
  grid: Grid;
}

export const inRect = (r: Rect | null | undefined, x: number, y: number, pad = 0) => !!r && x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;

/** the rectangle of a grid cell inside `box` */
export function cellRect(g: Grid, c: GCell, box: Rect): Rect {
  const cw = box.w / g.cols, ch = box.h / g.rows;
  return { x: box.x + c.c * cw, y: box.y + c.r * ch, w: c.cs * cw, h: c.rs * ch };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
/** the smallest grid with the same shape (all row / column numbers divided by their common factor) */
export function normalize(g: Grid): Grid {
  let fr = g.rows, fc = g.cols;
  for (const x of g.cells) (fr = gcd(gcd(fr, x.r), x.rs)), (fc = gcd(gcd(fc, x.c), x.cs));
  fr = fr || 1;
  fc = fc || 1;
  return { rows: g.rows / fr, cols: g.cols / fc, cells: g.cells.map((x) => ({ r: x.r / fr, c: x.c / fc, rs: x.rs / fr, cs: x.cs / fc })) };
}
export const sameGrid = (a: Grid, b: Grid) => a.rows === b.rows && a.cols === b.cols && a.cells.length === b.cells.length && a.cells.every((x, i) => x.r === b.cells[i].r && x.c === b.cells[i].c && x.rs === b.cells[i].rs && x.cs === b.cells[i].cs);

/** a new column / row along an outer edge of the whole grid */
export function addEdge(g: Grid, side: Side): Grid {
  const cells = g.cells.map((x) => ({ ...x }));
  if (side === "left" || side === "right") {
    if (side === "left") for (const x of cells) x.c += 1;
    cells.push({ r: 0, c: side === "left" ? 0 : g.cols, rs: g.rows, cs: 1 });
    return normalize({ rows: g.rows, cols: g.cols + 1, cells });
  }
  if (side === "top") for (const x of cells) x.r += 1;
  cells.push({ r: side === "top" ? 0 : g.rows, c: 0, rs: 1, cs: g.cols });
  return normalize({ rows: g.rows + 1, cols: g.cols, cells });
}

/** cell `k` split in two; the docked pane takes the `side` half */
export function splitCell(g: Grid, k: number, side: Side): Grid {
  const h = side === "left" || side === "right";
  const cells = g.cells.map((x) => (h ? { ...x, c: x.c * 2, cs: x.cs * 2 } : { ...x, r: x.r * 2, rs: x.rs * 2 }));
  const o = cells[k];
  let n: GCell;
  if (h) {
    const half = o.cs / 2;
    n = { r: o.r, c: side === "left" ? o.c : o.c + half, rs: o.rs, cs: half };
    cells[k] = { ...o, c: side === "left" ? o.c + half : o.c, cs: half };
  } else {
    const half = o.rs / 2;
    n = { r: side === "top" ? o.r : o.r + half, c: o.c, rs: half, cs: o.cs };
    cells[k] = { ...o, r: side === "top" ? o.r + half : o.r, rs: half };
  }
  cells.push(n);
  return normalize({ rows: h ? g.rows : g.rows * 2, cols: h ? g.cols * 2 : g.cols, cells });
}

/** the outer band that means "a new column / row" (px) */
export const edgeBand = (box: Rect) => Math.max(14, Math.min(48, Math.min(box.w, box.h) * 0.07));
/** how near a pane's edge (share of its size) the cursor must be to split it */
export const CELL_EDGE = 0.3;

/** The pane spot under (x, y) in the map box, or null (middle of a pane, outside, layout full). */
export function snapAt(g: Grid | null, box: Rect, x: number, y: number, maxCells = 6): SnapHit | null {
  if (!g || !g.cells.length || g.cells.length >= maxCells || !inRect(box, x, y)) return null;
  const hit = (key: string, grid: Grid): SnapHit => ({ key, grid, rect: cellRect(grid, grid.cells[grid.cells.length - 1], box) });
  // the outer band: a full column / row (corners: the nearer edge)
  const b = edgeBand(box);
  const d: [Side, number][] = [
    ["left", x - box.x],
    ["right", box.x + box.w - x],
    ["top", y - box.y],
    ["bottom", box.y + box.h - y],
  ];
  const near = d.filter(([, v]) => v < b).sort((a, c) => a[1] / (a[0] === "left" || a[0] === "right" ? box.w : box.h) - c[1] / (c[0] === "left" || c[0] === "right" ? box.w : box.h))[0];
  if (near) return hit(`edge:${near[0]}`, addEdge(g, near[0]));
  // inside a pane: the half nearest the cursor
  const k = g.cells.findIndex((c) => inRect(cellRect(g, c, box), x, y));
  if (k < 0) return null;
  const r = cellRect(g, g.cells[k], box);
  const u = (x - r.x) / r.w, v = (y - r.y) / r.h;
  const sides: [Side, number][] = [
    ["left", u],
    ["right", 1 - u],
    ["top", v],
    ["bottom", 1 - v],
  ];
  const [side, dist] = sides.sort((a, c) => a[1] - c[1])[0];
  if (dist > CELL_EDGE) return null;
  return hit(`cell:${k}:${side}`, splitCell(g, k, side));
}

const cellKey = (x: GCell) => `${x.r},${x.c},${x.rs},${x.cs}`;
/** A saved layout with the same shape as `g` (same main map cell). `perm[j]` = the index in `g.cells`
 * of the layout's cell j, so panes can be put in the layout's order. */
export function matchLayout<L extends Grid & { id: string }>(g: Grid, layouts: readonly L[]): { id: string; perm: number[] } | null {
  const n = normalize(g);
  const idx = new Map(n.cells.map((x, i) => [cellKey(x), i]));
  for (const l of layouts) {
    const m = normalize(l);
    if (m.rows !== n.rows || m.cols !== n.cols || m.cells.length !== n.cells.length) continue;
    const perm = m.cells.map((x) => idx.get(cellKey(x)) ?? -1);
    if (perm[0] !== 0 || perm.some((p) => p < 0) || new Set(perm).size !== perm.length) continue;
    return { id: l.id, perm };
  }
  return null;
}

/** Where a window that has no remembered spot would sit (centre windows / side panels). */
export function homeFallback(id: string, view: { w: number; h: number }, size: { w?: number; h?: number } = {}, rail = 56): Rect {
  if (id.startsWith("p:")) return { x: rail + 6, y: 56, w: Math.min(400, view.w * 0.4), h: Math.max(120, view.h - 140) };
  const w = Math.min(size.w ?? 900, view.w * 0.9), h = Math.min(size.h ?? 640, view.h * 0.86);
  return { x: (view.w - w) / 2, y: (view.h - h) / 2, w, h };
}
