// 0.8.2: dashboard layouts — widgets on a column grid (x, y, w, h in cells), several dashboards.
// Pure helpers (no DOM, no store) so they can be unit-tested: placing a widget pushes the ones it
// lands on out of the way, then everything floats up (no holes).

export type WType = "cur" | "warn" | "radar" | "storms" | "meteo" | "aq" | "summary" | "days" | "ltg" | "gauges" | "ml";

export interface DWidget {
  id: string;
  type: WType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** saved point id, "_center" (map centre) or empty = the selected tab */
  pt?: string;
  /** custom title */
  title?: string;
  opt?: Record<string, any>;
}
export interface Dash {
  id: string;
  name: string;
  cols: number;
  widgets: DWidget[];
}
export interface DashState {
  list: Dash[];
  active: string;
}

export const WIDGETS: Record<WType, { name: string; w: number; h: number }> = {
  cur: { name: "Current conditions", w: 1, h: 1 },
  warn: { name: "Alerts here", w: 1, h: 1 },
  radar: { name: "Radar thumbnail", w: 1, h: 2 },
  storms: { name: "Nearby storms + ETA", w: 2, h: 1 },
  meteo: { name: "Next 12 hours chart", w: 2, h: 1 },
  aq: { name: "Air quality & pollen", w: 1, h: 1 },
  summary: { name: "Summary card", w: 2, h: 2 },
  days: { name: "Forecast days", w: 2, h: 1 },
  ltg: { name: "Lightning distance", w: 1, h: 1 },
  gauges: { name: "River gauges nearby", w: 1, h: 1 },
  ml: { name: "Model detections nearby", w: 1, h: 1 },
};
export const WTYPES = Object.keys(WIDGETS) as WType[];
export const MIN_COLS = 1;
export const MAX_COLS = 6;

/** the dashboard as it was before 0.8.2 (3 columns; radar 2 rows tall; storms and chart 2 wide) */
export function defaultDash(): Dash {
  return {
    id: "default",
    name: "My dashboard",
    cols: 3,
    widgets: [
      { id: "cur", type: "cur", x: 0, y: 0, w: 1, h: 1 },
      { id: "warn", type: "warn", x: 1, y: 0, w: 1, h: 1 },
      { id: "radar", type: "radar", x: 2, y: 0, w: 1, h: 2 },
      { id: "storms", type: "storms", x: 0, y: 1, w: 2, h: 1 },
      { id: "meteo", type: "meteo", x: 0, y: 2, w: 2, h: 1 },
      { id: "aq", type: "aq", x: 2, y: 2, w: 1, h: 1 },
    ],
  };
}

const int = (v: any, d: number) => (Number.isFinite(+v) ? Math.round(+v) : d);

/** a saved (possibly hand-edited / older) state → a valid one */
export function normState(s: DashState | undefined | null): DashState {
  const list = (Array.isArray(s?.list) ? s!.list : [])
    .filter((d) => d && typeof d.id === "string")
    .map((d) => {
      const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, int(d.cols, 3)));
      const widgets = (Array.isArray(d.widgets) ? d.widgets : []).filter((w) => w && WIDGETS[w.type as WType]).map((w) => clampW({ ...w, x: int(w.x, 0), y: int(w.y, 0), w: int(w.w, 1), h: int(w.h, 1) }, cols));
      return { ...d, name: String(d.name || "Dashboard"), cols, widgets: compact(widgets, undefined, false) };
    });
  if (!list.length) list.push(defaultDash());
  const active = list.some((d) => d.id === s?.active) ? s!.active : list[0].id;
  return { list, active };
}

export function clampW(w: DWidget, cols: number): DWidget {
  const ww = Math.max(1, Math.min(cols, w.w));
  return { ...w, w: ww, h: Math.max(1, Math.min(6, w.h)), x: Math.max(0, Math.min(cols - ww, w.x)), y: Math.max(0, w.y) };
}

export const overlaps = (a: DWidget, b: DWidget) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** float every widget up as far as it goes (top-to-bottom, left-to-right order kept); `fixed` (the
 *  widget just dropped) stays where it is; float = false only resolves overlaps */
export function compact(ws: DWidget[], fixed?: string, float = true): DWidget[] {
  const sorted = [...ws].sort((a, b) => (a.id === fixed ? -1 : b.id === fixed ? 1 : a.y - b.y || a.x - b.x));
  const out: DWidget[] = [];
  for (const w of sorted) {
    const c = { ...w };
    if (float && w.id !== fixed) while (c.y > 0 && !out.some((o) => overlaps(o, { ...c, y: c.y - 1 }))) c.y--;
    // pushed into something (shouldn't happen after `place`): move below it
    while (out.some((o) => overlaps(o, c))) c.y++;
    out.push(c);
  }
  // keep the caller's array order (render order / keys)
  return ws.map((w) => out.find((o) => o.id === w.id)!);
}

/** move / resize widget `id` to (x, y, w, h); the ones it lands on move out of the way */
export function place(ws: DWidget[], id: string, x: number, y: number, w: number, h: number, cols: number): DWidget[] {
  const old = ws.find((o) => o.id === id);
  if (!old) return ws;
  const moved = clampW({ ...old, x, y, w, h }, cols);
  const down = moved.y > old.y;
  const settled: DWidget[] = [moved];
  const rest = ws.filter((o) => o.id !== id).sort((a, b) => a.y - b.y || a.x - b.x);
  rest.forEach((o, i) => {
    let c = { ...o };
    if (overlaps(moved, c) && down) {
      // moving down onto it: try putting it above the moved widget (a swap)
      const up = { ...c, y: moved.y - c.h };
      if (up.y >= 0 && !settled.some((s) => overlaps(s, up)) && !rest.slice(i + 1).some((r) => overlaps(r, up))) c = up;
    }
    while (settled.some((s) => overlaps(s, c))) {
      const hit = settled.filter((s) => overlaps(s, c));
      c.y = Math.max(...hit.map((s) => s.y + s.h));
    }
    settled.push(c);
  });
  return compact(
    ws.map((o) => settled.find((s) => s.id === o.id)!),
    id,
  );
}

/** add a widget of `type` at the bottom (left-most free spot of the last row first) */
export function addWidget(d: Dash, type: WType, id: string): Dash {
  const def = WIDGETS[type];
  const w = Math.min(def.w, d.cols);
  const bottom = d.widgets.reduce((m, o) => Math.max(m, o.y + o.h), 0);
  let spot: DWidget = { id, type, x: 0, y: bottom, w, h: def.h };
  // a free spot higher up?
  outer: for (let y = 0; y <= bottom; y++)
    for (let x = 0; x + w <= d.cols; x++) {
      const c = { ...spot, x, y };
      if (!d.widgets.some((o) => overlaps(o, c))) {
        spot = c;
        break outer;
      }
    }
  return { ...d, widgets: compact([...d.widgets, spot]) };
}

/** change the column count: widgets keep their place where they can */
export function setCols(d: Dash, cols: number): Dash {
  cols = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
  let ws = d.widgets.map((w) => clampW(w, cols));
  // resolve the overlaps that clamping made, one widget at a time
  for (const w of [...ws].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const cur = ws.find((o) => o.id === w.id)!;
    ws = place(ws, cur.id, cur.x, cur.y, cur.w, cur.h, cols);
  }
  return { ...d, cols, widgets: compact(ws) };
}

/** grid cell under a point: `rel` = pointer relative to the grid's top-left, column count and gap,
 *  grid width, and the row track sizes (px; rows past the last use `rowFallback`) */
export function cellAt(relX: number, relY: number, cols: number, width: number, gap: number, rows: number[], rowFallback = 110): { x: number; y: number } {
  const colW = (width - gap * (cols - 1)) / cols;
  const x = Math.max(0, Math.min(cols - 1, Math.floor(relX / (colW + gap))));
  let y = 0;
  let top = 0;
  if (relY <= 0) return { x, y: 0 };
  for (; y < rows.length; y++) {
    if (relY < top + rows[y] + gap / 2) return { x, y };
    top += rows[y] + gap;
  }
  return { x, y: y + Math.floor(Math.max(0, relY - top) / (rowFallback + gap)) };
}

export const uid = () => Math.random().toString(36).slice(2, 9);
