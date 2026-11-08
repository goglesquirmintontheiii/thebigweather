// 0.8.3 windows: drag a pop-out back into the main window.
//   - Electron (main.cjs) tells the main window while a pop-out is dragged over it ("win-drag") and
//     the pop-out when it's dropped there ("win-drop", cursor in main-window px).
//   - The main window shows where it would go: a window's old spot ("Drop to dock"), or for a map
//     pane the pane spot under the cursor (Windows-snap style, winsnap.ts).
//   - The dropped pop-out sends what it holds over the "tbw-dock" channel; the main window docks it
//     when the drop was on a spot and answers "docked", and the pop-out closes itself.
// The pane window's "Dock back" button docks it without a drag (a new pane on the right).

import { render } from "preact";
import { signal } from "@preact/signals";
import "./windrop.css";
import { popoutSpec } from "../popout";
import { settings, update, toast, type PaneCfg, type PaneLink } from "../store";
import { IN_OS_WIN, POP_WIN, POPPERS, popped, homeOf, osCtl } from "./winframe";
import { snapAt, inRect, homeFallback, matchLayout, addEdge, type Grid, type Rect, type SnapHit } from "./winsnap";
import { layoutSpec, BUILTIN_LAYOUTS, MAX_MAPS, defaultCfg } from "./Panes";
import { myLink } from "../linkwin";

type DockMsg =
  | { t: "drop"; from: string; id: string; arg: any; x: number; y: number; cw: number; any?: boolean }
  | { t: "docked"; to: string };

const tbw = () => (window as any).tbw as any;
const isMain = !popoutSpec;
const isPaneWin = popoutSpec?.kind === "pane";
const me = Math.random().toString(36).slice(2);
const ch = typeof BroadcastChannel !== "undefined" && (isMain || IN_OS_WIN || isPaneWin) ? new BroadcastChannel("tbw-dock") : null;
const post = (m: DockMsg) => ch?.postMessage(m);

/* ---------- main window: targets ---------- */

/** the map area and its layout (null in swipe compare) */
function paneBox(): { box: Rect; grid: Grid | null } | null {
  const el = document.querySelector<HTMLElement>(".panes");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const s = layoutSpec(settings.peek().panes.layout);
  const grid = s ? { rows: s.rows, cols: s.cols, cells: s.cells.slice(0, MAX_MAPS) } : null;
  return { box: { x: r.left, y: r.top, w: r.width, h: r.height }, grid };
}
function paneHit(x: number, y: number): SnapHit | null {
  const b = paneBox();
  return b ? snapAt(b.grid, b.box, x, y, MAX_MAPS) : null;
}
function winHome(id: string): Rect {
  const p = POPPERS.get(id);
  const rail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rail")) || 56;
  return homeOf(id) ?? homeFallback(id, { w: window.innerWidth, h: window.innerHeight }, { w: p?.w, h: p?.h }, rail);
}

/** while a pop-out is over the main window: what it is and where the cursor is (CSS px) */
const over = signal<{ id: string; x: number; y: number } | null>(null);

/* ---------- main window: docking ---------- */

interface PaneArg {
  cfg?: PaneCfg;
  link?: PaneLink;
  layers?: Record<string, boolean>;
  ml?: boolean;
}

/** Put a docked pane into the layout `grid` (old cells in order, then the new pane). */
function dockPane(a: PaneArg, grid: Grid) {
  const s0 = settings.peek();
  const n = grid.cells.length - 1; // extra panes after docking
  const old = n - 1;
  const custom = (s0.paneLayouts ?? []).map((l) => ({ ...l, id: `custom:${l.id}` }));
  const hit = matchLayout(grid, BUILTIN_LAYOUTS) ?? matchLayout(grid, custom);
  update((s) => {
    while (s.panes.list.length < old) s.panes.list.push(defaultCfg(s.panes.list.length + 1));
    // per pane (1-based): its config, links, own layers, detections; pane n is the docked one
    const cur = (i: number) => (i <= old ? { cfg: s.panes.list[i - 1], link: s.panes.links?.[i], layers: s.panes.layers?.[i], ml: s.panes.ml?.[i] } : { cfg: a.cfg ?? defaultCfg(i), link: a.link, layers: a.layers, ml: a.ml });
    const perm = hit ? hit.perm : grid.cells.map((_, i) => i);
    const items = perm.slice(1).map((i) => cur(i));
    const rest = s.panes.list.slice(n);
    s.panes.list = [...items.map((x) => x.cfg), ...rest];
    const links: Record<string, PaneLink> = {};
    const layers: Record<string, Record<string, boolean>> = {};
    const ml: Record<string, boolean> = {};
    items.forEach((x, j) => {
      if (x.link) links[j + 1] = x.link;
      if (x.layers) layers[j + 1] = x.layers;
      if (x.ml != null) ml[j + 1] = x.ml;
    });
    s.panes.links = links;
    if (s.panes.layers || Object.keys(layers).length) s.panes.layers = layers;
    if (s.panes.ml || Object.keys(ml).length) s.panes.ml = ml;
    if (hit) s.panes.layout = hit.id as any;
    else {
      const id = `dock${Date.now().toString(36)}`;
      s.paneLayouts = [...(s.paneLayouts ?? []), { id, name: `${n + 1} maps`, rows: grid.rows, cols: grid.cols, cells: grid.cells }];
      s.panes.layout = `custom:${id}`;
    }
  });
}

function dockWin(id: string, arg: any) {
  const p = { ...popped.peek() };
  delete p[id];
  popped.value = p;
  POPPERS.get(id)?.open(arg);
}

function onDrop(m: Extract<DockMsg, { t: "drop" }>) {
  const k = m.cw > 0 ? window.innerWidth / m.cw : 1;
  const x = m.x * k, y = m.y * k;
  over.value = null;
  if (m.id === "pane") {
    let hit = m.any ? null : paneHit(x, y);
    if (m.any) {
      const b = paneBox();
      if (!b?.grid) return void toast("Switch off swipe compare to dock a pane", "warn");
      if (b.grid.cells.length >= MAX_MAPS) return void toast(`No room: ${MAX_MAPS} maps at most`, "warn");
      hit = { key: "edge:right", rect: b.box, grid: addEdge(b.grid, "right") };
    }
    if (!hit) return;
    dockPane(m.arg ?? {}, hit.grid);
  } else {
    if (!POPPERS.has(m.id)) return;
    if (!m.any && !inRect(winHome(m.id), x, y, 16)) return;
    dockWin(m.id, m.arg);
  }
  post({ t: "docked", to: m.from });
}

/* ---------- main window: the overlay ---------- */

function Overlay() {
  const o = over.value;
  if (!o) return null;
  if (o.id === "pane") {
    const h = paneHit(o.x, o.y);
    const b = paneBox();
    return (
      <div class="wd-layer" aria-hidden="true">
        {b && <div class="wd-area" style={box(b.box)} />}
        {h ? (
          <div class="wd-zone on" style={box(h.rect)}>
            <span>Drop to dock here</span>
          </div>
        ) : (
          <div class="wd-hint" style={{ left: `${o.x + 14}px`, top: `${o.y + 14}px` }}>
            {!b?.grid ? "Swipe compare: use Dock back" : b.grid.cells.length >= MAX_MAPS ? `${MAX_MAPS} maps at most` : "Move near a pane's edge"}
          </div>
        )}
      </div>
    );
  }
  const r = winHome(o.id);
  const on = inRect(r, o.x, o.y, 16);
  return (
    <div class="wd-layer" aria-hidden="true">
      <div class={`wd-zone${on ? " on" : ""}`} style={box(r)}>
        <span>{on ? "Drop to dock" : `${POPPERS.get(o.id)?.title ?? "Window"}: drop here to dock`}</span>
      </div>
    </div>
  );
}
const box = (r: Rect) => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

if (isMain && ch) {
  ch.onmessage = (e) => e.data?.t === "drop" && onDrop(e.data);
  try {
    tbw()?.win?.onDrag?.((v: { phase: string; id: string; x: number; y: number; cw: number }) => {
      if (v?.phase !== "over") return void (over.value = null);
      const k = v.cw > 0 ? window.innerWidth / v.cw : 1;
      over.value = { id: v.id, x: v.x * k, y: v.y * k };
    });
  } catch {
    /* browser */
  }
  // automated screenshots / tests: show the overlay as if a pop-out were dragged to (x, y)
  (window as any).__tbwDragSim = (id: string | null, x = 0, y = 0) => (over.value = id ? { id, x, y } : null);
  const mount = () => {
    const el = document.createElement("div");
    el.className = "wd-root";
    document.body.appendChild(el);
    render(<Overlay />, el);
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
}

/* ---------- pop-out windows ---------- */

/** what this pop-out holds, for the main window to open again */
function dockArg(): any {
  if (isPaneWin) {
    const p = settings.peek().panes;
    return { cfg: p.list[0], link: myLink.peek(), layers: p.layers?.["1"], ml: p.ml?.["1"] } satisfies PaneArg;
  }
  const p = POP_WIN ? POPPERS.get(POP_WIN) : null;
  return p?.arg ? p.arg() : popoutSpec?.kind === "win" ? popoutSpec.data?.arg : popoutSpec?.data;
}
function sendDrop(v: { x: number; y: number; cw: number }, any = false) {
  const id = isPaneWin ? "pane" : POP_WIN;
  if (!id) return;
  post({ t: "drop", from: me, id, arg: dockArg(), x: v.x, y: v.y, cw: v.cw, any });
}
/** pane window: back into the main window as a new pane (no drag) */
export function dockPaneWindow() {
  sendDrop({ x: 0, y: 0, cw: 0 }, true);
}

if (!isMain && ch) {
  if (isPaneWin) window.addEventListener("tbw-dock-pane", dockPaneWindow); // the pane's Dock back button (Panes.tsx)
  ch.onmessage = (e) => {
    if (e.data?.t === "docked" && e.data.to === me) osCtl("close");
  };
  try {
    tbw()?.win?.onDrop?.((v: { x: number; y: number; cw: number }) => sendDrop(v));
  } catch {
    /* browser */
  }
}
