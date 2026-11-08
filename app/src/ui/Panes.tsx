// Multi-pane layout: the main map plus extra panes, and the layout picker.
// panes 0.8: grid layouts (built-in + custom, see PaneLayoutEditor.tsx) with drawn icons, per-pane
// links (position / time / layers), pane pop-out windows and pane windows linked to the main one.

import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat"; // 0.8.2
import { settings, update, openPanel, crosshair, type PaneCfg, type PaneLink, type PaneLayoutDef, type PaneLayoutId } from "../store";
import { mountPane, paneConfigured, paneStatus, resizePanes, paneLink, paneMap, paneCenter, paneMl, mainLinked, paneLayerShown, paneOverride, paneHasOverrides, paneHover } from "../map/panes";
import { L2_MOMENTS, l3Products, sites, productName } from "../radar/controller";
import { gridLayers, selectWeather, activeLabel, GIBS } from "../weather";
import { SwipeDivider, swipeGeom, type SwipeMode } from "./CompareSwipe"; // data 0.6
import { noLevel3 } from "../intl/sites";
import { fmtTime } from "../util";
import { AppWindow, Move, Clock, Layers, ExternalLink, SquarePlus, Pencil, Link2, Link2Off, ScanEye, RefreshCw } from "lucide-preact";
import { popout, popoutSpec } from "../popout";
import { mapRef } from "../map/mapview";
import { myKind, myLink, peerList, setMyLink, setPeerLink, linkMap } from "../linkwin";
import { startAlerts } from "../alerts";
import { jumpToSetting } from "../a11y/jump";
// 0.8.1
import { Crosshair, shiftHeld } from "./Readouts";
import { isOn, ovlStatus } from "../overlays/manager";
/* 0.8.2 */
import { ProductPicker } from "./ProductPicker";
import type { PGroup } from "./productFilter";
import { OVERLAYS } from "../overlays/defs";
import { fileOverlays } from "../overlays/files";
import { dropPane } from "../map/panesync";
import "./panes082.css";
/* 0.8.3 inspector: radar Inspector and distance & direction tool in panes */
import { PaneInspector } from "./Inspector";
import { paneBearing } from "../map/panes";
import { tool } from "../store";
import { fmtDist, compass } from "../util";

/** Product dropdown options: Level II moments, Level III families (for the site's radar type), gridded layers.
 * 0.8.2: as data for the searchable dropdown (same groups and labels as before). */
export function productGroups({ site, current, value, label, sat }: { site: string; current?: string; value: string; label?: string; /* data 0.6 */ sat?: boolean }): PGroup[] {
  const st = sites.value.find((x) => x.id === site);
  const tdwr = st?.type === "TDWR";
  const l3 = noLevel3(st) ? [] : l3Products.value.filter((p) => !!p.tdwr === tdwr);
  const cur = l3Products.value.find((p) => p.id === current);
  const fams = new Map<string, typeof l3>();
  for (const p of l3) {
    const k = `${p.code}|${p.name}`;
    fams.set(k, [...(fams.get(k) ?? []), p].sort((a, b) => a.tilt - b.tilt));
  }
  const groups = [...new Set(gridLayers.value.map((l) => l.group))];
  // the current layer when it isn't one of the options below (imagery, world radar, catalog not loaded yet)
  const known =
    (value.startsWith("r:L2:") && L2_MOMENTS.some((m) => `r:L2:${m.id}` === value)) ||
    (value.startsWith("r:L3:") && l3.some((p) => `r:L3:${p.id}` === value)) ||
    (value.startsWith("g:") && gridLayers.value.some((l) => `g:${l.id}` === value)) ||
    (!!sat && value.startsWith("s:") && GIBS.some((g) => `s:${g.id}` === value)); // data 0.6
  const out: PGroup[] = [];
  if (!known) out.push({ label: "Current", items: [{ value, label: label ?? value.replace(/^\w:(L[23]:)?/, "") }] });
  out.push({ label: `Level II · ${site}`, items: L2_MOMENTS.map((m, i) => ({ value: `r:L2:${m.id}`, label: m.name, hint: i < 6 ? String(i + 1) : undefined })) });
  if (fams.size > 0)
    out.push({
      label: `Level III · ${site}`,
      items: [...fams.values()].map((f) => {
        const pick = f.find((p) => p.id === current) ?? f.find((p) => p.tilt === cur?.tilt) ?? f[0];
        return { value: `r:L3:${pick.id}`, label: f[0].name, hint: f.length > 1 ? `~${(tdwr ? [0.3, 0.6, 1.0, 1.5] : [0.5, 0.9, 1.3, 1.8])[pick.tilt] ?? pick.tilt}°` : undefined };
      }),
    });
  for (const g of groups) out.push({ label: g, items: gridLayers.value.filter((l) => l.group === g).map((l) => ({ value: `g:${l.id}`, label: l.name })) });
  if (sat) /* data 0.6: imagery in panes */ for (const g of [...new Set(GIBS.map((x) => x.group))]) out.push({ label: `${g} (imagery)`, items: GIBS.filter((x) => x.group === g).map((x) => ({ value: `s:${x.id}`, label: x.name })) });
  return out;
}

type Sty = Record<string, any>;

/** The product dropdown. 0.8.1: the lists arrive after the first render (radar list, Level III and
 * gridded catalogs); it re-renders when they change. 0.8.2: searchable (type to filter). */
export function ProductSelect({ value, onPick, opts, ...rest }: { value: string; onPick: (v: string) => void; opts: Parameters<typeof productGroups>[0]; title?: string; "aria-label"?: string }) {
  void (sites.value, l3Products.value, gridLayers.value); // re-render when the option lists change
  return <ProductPicker value={value} groups={productGroups(opts)} onPick={onPick} fallback={opts.label} {...rest} />;
}

/* ---------- links ---------- */
const LINK_KINDS: [keyof PaneLink, any, string][] = [
  ["pos", Move, "position"],
  ["time", Clock, "time"],
  ["layers", Layers, "layers"],
];

/** Three small toggles: position / time / layers. 0.8.2: right-click the layers one for the pane's own layers. */
export function LinkToggles({ lk, set, what, chips, onLayers, own }: { lk: PaneLink; set: (l: PaneLink) => void; what: string; chips?: boolean; onLayers?: (x: number, y: number) => void; own?: boolean }) {
  return (
    <span class={chips ? "lk8-chips" : "lk8-icons"} role="group" aria-label={`${what} links`}>
      {LINK_KINDS.map(([k, I, name]) => (
        <button
          key={k}
          class={`lk8 ${lk[k] ? "on" : ""} ${k === "layers" && own ? "own" : ""}`}
          aria-pressed={lk[k]}
          title={`${what}: ${lk[k] ? "follows" : "doesn't follow"} the main map's ${name} (click to ${lk[k] ? "unlink" : "link"})${k === "layers" && onLayers ? `${own ? " · has its own layers" : ""} · right-click: choose layers` : ""}`}
          aria-label={`Link ${name} for ${what}`}
          onClick={(e) => (e.stopPropagation(), set({ ...lk, [k]: !lk[k] }))}
          onContextMenu={
            k === "layers" && onLayers
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onLayers(e.clientX, e.clientY);
                }
              : undefined
          }
          onKeyDown={
            k === "layers" && onLayers
              ? (e) => {
                  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                    e.preventDefault();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    onLayers(r.left, r.bottom + 4);
                  }
                }
              : undefined
          }
        >
          <I size={chips ? 12 : 11} />
          {chips && <span>{name === "position" ? "Pos" : name === "time" ? "Time" : "Layers"}</span>}
        </button>
      ))}
    </span>
  );
}

function setPaneLink(idx: number, lk: PaneLink) {
  update((s) => (s.panes.links = { ...(s.panes.links ?? {}), [idx]: lk }));
}

/* ---------- 0.8.1 ---------- */
/** Centre crosshair of an extra pane, with that pane's own value. */
function PaneCrosshair({ idx }: { idx: number }) {
  if (!crosshair.value) return null;
  const r = paneCenter.value[idx];
  return (
    <div class="crosshair">
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="9" fill="none" stroke="#000" stroke-width="4" opacity=".55" />
        <circle cx="22" cy="22" r="9" fill="none" stroke="#fff" stroke-width="1.6" />
        <path d="M22 2v11M22 31v11M2 22h11M31 22h11" stroke="#000" stroke-width="4" opacity=".55" />
        <path d="M22 2v11M22 31v11M2 22h11M31 22h11" stroke="#fff" stroke-width="1.6" />
      </svg>
      {r && (
        <div class="ch-val glass">
          <b>{r.v}</b>
          {r.sub && <span>{r.sub}</span>}
        </div>
      )}
    </div>
  );
}

/** Show / hide model detections in one pane (only while the Model detections layer is on). */
function MlToggle({ idx, what }: { idx: number; what: string }) {
  if (!isOn("mldetect")) return null;
  const on = paneMl(idx);
  return (
    <button
      class={`lk8 ${on ? "on" : ""}`}
      aria-pressed={on}
      title={`${what}: model detections ${on ? "shown" : "hidden"} (click to ${on ? "hide" : "show"})`}
      aria-label={`Model detections in ${what}`}
      onClick={(e) => (e.stopPropagation(), setPaneLayer(idx, "mldetect", !on))}
    >
      <ScanEye size={11} />
    </button>
  );
}
/* ---------- end 0.8.1 ---------- */

/* ---------- 0.8.2: per-pane layers, data inspector ---------- */
/** show / hide one layer in a pane (an override; dropped again when it matches the main map) */
function setPaneLayer(idx: number, id: string, on: boolean) {
  update((s) => {
    const all = { ...(s.panes.layers ?? {}) };
    const mine = { ...(all[idx] ?? {}) };
    delete mine[id];
    all[idx] = mine;
    s.panes.layers = all;
    if (id === "mldetect" && s.panes.ml?.[idx] !== undefined) {
      const ml = { ...s.panes.ml };
      delete ml[idx];
      s.panes.ml = ml;
    }
  });
  // without an override the pane follows the main map: keep one only if that differs
  if (paneLayerShown(idx, id) !== on) update((s) => (s.panes.layers = { ...(s.panes.layers ?? {}), [idx]: { ...(s.panes.layers?.[idx] ?? {}), [id]: on } }));
}
/** "Sync to main": drop the pane's own layers and link its layers again */
function syncPaneLayers(idx: number) {
  update((s) => {
    const all = { ...(s.panes.layers ?? {}) };
    delete all[idx];
    s.panes.layers = all;
    if (s.panes.ml) {
      const ml = { ...s.panes.ml };
      delete ml[idx];
      s.panes.ml = ml;
    }
  });
  if (myKind === "pane") setMyLink({ ...myLink.value, layers: true });
  else setPaneLink(idx, { ...paneLink(idx), layers: true });
}

const BASE_ROWS: [string, string][] = [
  ["base:alerts", "Weather alerts"],
  ["base:sites", "Radar sites"],
  ["base:states", "State lines"],
  ["base:counties", "Counties"],
  ["base:points", "My points"],
  ["base:rings", "Range rings"],
];

/** Right-click menu of a pane's Layers link: which layers this pane shows, and Sync to main. */
function PaneLayerMenu({ idx, what, at, onClose }: { idx: number; what: string; at: { x: number; y: number }; onClose: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => (window.removeEventListener("pointerdown", down, true), window.removeEventListener("keydown", key, true));
  }, []);
  void ovlStatus.value;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (name: string, group: string) => words.every((w) => `${name} ${group}`.toLowerCase().includes(w));
  const rows: { id: string; name: string; group: string; client?: boolean }[] = [
    ...BASE_ROWS.map(([id, name]) => ({ id, name, group: "Map" })),
    ...OVERLAYS.filter((o) => !o.hidden || o.id === "mldetect").map((o) => ({ id: o.id, name: o.name, group: o.group, client: o.feed === "client" })),
    ...fileOverlays.value.map((f) => ({ id: `file:${f.id}`, name: f.name, group: "My files" })),
  ].filter((r) => hit(r.name, r.group));
  // what's shown first, then the rest by group
  const shown = rows.filter((r) => paneLayerShown(idx, r.id));
  const rest = rows.filter((r) => !paneLayerShown(idx, r.id));
  const groups = [...new Set(rest.map((r) => r.group))];
  const W = 290;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 420));
  const own = paneHasOverrides(idx);
  const row = (r: (typeof rows)[number]) => {
    const on = paneLayerShown(idx, r.id);
    const o = paneOverride(idx, r.id);
    const noData = on && r.client && !r.id.startsWith("base:") && !isOn(r.id);
    return (
      <label key={r.id} class={`pl82-row ${o !== undefined ? "own" : ""}`} title={o !== undefined ? "Set for this pane only" : "Follows the main map"}>
        <input type="checkbox" checked={on} onChange={() => setPaneLayer(idx, r.id, !on)} />
        <span class="pl82-name">{r.name}</span>
        {noData && <span class="pl82-note" title="Computed in the app: turn it on in the main Layers menu for data">main off</span>}
        {o !== undefined && <span class="pl82-dot" aria-label="set for this pane" />}
      </label>
    );
  };
  return createPortal(
    <div ref={ref} class="pl82 glass" style={{ left: `${left}px`, top: `${top}px`, width: `${W}px` }} role="dialog" aria-label={`${what} layers`}>
      <div class="pl82-h">
        <b>{what} layers</b>
        <button class="pp8-chip pl82-sync" disabled={!own && paneLink(idx).layers} title="Show the same layers as the main map (clears this pane's own choices)" onClick={() => syncPaneLayers(idx)}>
          <RefreshCw size={12} /> Sync to main
        </button>
      </div>
      <input class="pl82-q" value={q} placeholder="Search layers" aria-label="Search layers" onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />
      <div class="pl82-list">
        {shown.length > 0 && <div class="pl82-gh">Shown here</div>}
        {shown.map(row)}
        {groups.map((g) => (
          <div key={g}>
            <div class="pl82-gh">{g}</div>
            {rest.filter((r) => r.group === g).map(row)}
          </div>
        ))}
        {!rows.length && <div class="muted small" style={{ padding: "6px 8px" }}>No layer matches</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Data inspector (value under the mouse) inside a pane, from the pane's own product. */
function PaneCursorValue({ idx }: { idx: number }) {
  const h = paneHover.value;
  if (!h || h.idx !== idx || !(settings.value.ui.cursorValue || shiftHeld.value)) return null;
  return (
    <div class="cursor-val" style={{ left: `${h.x + 16}px`, top: `${h.y + 14}px` }}>
      <b>{h.v}</b>
      {h.sub && <span>{h.sub}</span>}
    </div>
  );
}
/* ---------- end 0.8.2 ---------- */

/** 0.8.3 inspector: distance & direction from this pane's radar to its centre */
function PaneBearing({ idx }: { idx: number }) {
  if (tool.value !== "bearing") return null;
  const b = paneBearing.value[idx];
  if (!b) return null;
  return (
    <div class="tool-readout glass i83-pane-brg">
      From {b.site}: {fmtDist(b.dist)} · {Math.round(b.brg)}° {compass(b.brg)}
    </div>
  );
}

/** Second map window / pane window: what this window follows. */
function LinkControls({ onLayers }: { onLayers?: (x: number, y: number) => void }) {
  if (myKind === "main") return null;
  return <LinkToggles lk={myLink.value} set={setMyLink} what="This window" onLayers={myKind === "pane" ? onLayers : undefined} own={myKind === "pane" && paneHasOverrides(1)} />;
}

/** Publish the header's bottom edge as --hdr-b so the pane dropdowns and the scan bar sit just
 * below it (the header wraps on narrow windows), and slide the header right when the side panel
 * would cover its left end (narrow windows with a panel open). */
function useHeaderVar() {
  const panel = openPanel.value;
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".topbar");
    if (!el) return;
    let busy = false;
    const upd = () => {
      if (busy) return;
      busy = true;
      const sp = document.querySelector(".side-panel");
      const pr = sp ? sp.getBoundingClientRect().right + 10 : 0;
      el.style.left = "";
      el.style.maxWidth = "";
      const w = el.offsetWidth;
      const cx = window.innerWidth / 2;
      if (pr && cx - w / 2 < pr) {
        el.style.maxWidth = `${Math.max(320, window.innerWidth - pr - 12)}px`;
        el.style.left = `${pr + el.offsetWidth / 2}px`;
      }
      document.documentElement.style.setProperty("--hdr-b", `${Math.round(el.getBoundingClientRect().bottom + 6)}px`);
      requestAnimationFrame(() => (busy = false));
    };
    upd();
    const t = setTimeout(upd, 250); // after the panel's open animation
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    window.addEventListener("resize", upd);
    return () => (clearTimeout(t), ro.disconnect(), window.removeEventListener("resize", upd));
  }, [panel]);
}

/* ---------- layouts ---------- */
export type GridSpec = { rows: number; cols: number; cells: { r: number; c: number; rs: number; cs: number }[] };
const cell = (r: number, c: number, rs = 1, cs = 1) => ({ r, c, rs, cs });
export const BUILTIN_LAYOUTS: (GridSpec & { id: PaneLayoutId; name: string })[] = [
  { id: "1", name: "One map", rows: 1, cols: 1, cells: [cell(0, 0)] },
  { id: "2", name: "Two side by side", rows: 1, cols: 2, cells: [cell(0, 0), cell(0, 1)] },
  { id: "2v", name: "Two stacked", rows: 2, cols: 1, cells: [cell(0, 0), cell(1, 0)] },
  { id: "3", name: "Three: one large + two stacked", rows: 2, cols: 2, cells: [cell(0, 0, 2, 1), cell(0, 1), cell(1, 1)] },
  { id: "3c", name: "Three side by side", rows: 1, cols: 3, cells: [cell(0, 0), cell(0, 1), cell(0, 2)] },
  { id: "4", name: "Four (2 × 2)", rows: 2, cols: 2, cells: [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)] },
];
export const MAX_MAPS = 6;

export function layoutSpec(id: string): (GridSpec & { name: string }) | null {
  if (id === "swipe") return null;
  if (id.startsWith("custom:")) return settings.value.paneLayouts?.find((l) => `custom:${l.id}` === id) ?? null;
  return BUILTIN_LAYOUTS.find((l) => l.id === id) ?? null;
}
export function paneCountOf(id: string): number {
  if (id === "swipe") return 1;
  const s = layoutSpec(id);
  return s ? Math.min(MAX_MAPS, s.cells.length) - 1 : 0;
}
/** kept for older imports */
export const PANE_COUNT: Record<string, number> = { "1": 0, "2": 1, "2v": 1, "3": 2, "3c": 2, "4": 3, swipe: 1 };
export function layoutName(id: string): string {
  return id === "swipe" ? "Swipe compare" : layoutSpec(id)?.name ?? id;
}

/** A layout drawn as its panes (main map shaded). */
export function LayoutIcon({ spec, size = 18, swipe }: { spec?: GridSpec | null; size?: number; swipe?: SwipeMode }) {
  const pad = 2.5, W = 24 - 2 * pad, gap = 1.6;
  if (swipe) {
    const line = swipe === "v" ? "M12 3.5V20.5" : swipe === "h" ? "M3.5 12H20.5" : "M8 3.5L16 20.5";
    const half = swipe === "v" ? "M12 3.5H19a1.5 1.5 0 0 1 1.5 1.5V19a1.5 1.5 0 0 1-1.5 1.5H12Z" : swipe === "h" ? "M3.5 12H20.5V19a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" : "M8 3.5H19a1.5 1.5 0 0 1 1.5 1.5V19a1.5 1.5 0 0 1-1.5 1.5H16Z";
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
        <path d={half} fill="currentColor" fill-opacity="0.35" stroke="none" />
        <path d={line} stroke-width="2" />
      </svg>
    );
  }
  const g = spec ?? BUILTIN_LAYOUTS[0];
  const cw = (W - gap * (g.cols - 1)) / g.cols, ch = (W - gap * (g.rows - 1)) / g.rows;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      {g.cells.slice(0, MAX_MAPS).map((c, i) => (
        <rect key={i} x={pad + c.c * (cw + gap)} y={pad + c.r * (ch + gap)} width={c.cs * cw + (c.cs - 1) * gap} height={c.rs * ch + (c.rs - 1) * gap} rx="1.4" fill={i === 0 ? "currentColor" : "none"} fill-opacity={i === 0 ? 0.35 : 0} />
      ))}
    </svg>
  );
}

/** Product dropdown for the main map (top-centre of its pane, just below the header). */
export function MainPaneHead({ style }: { style?: Sty }) {
  const s = settings.value;
  const w = s.weather;
  const value = w.kind === "radar" ? `r:${s.radar.source}:${s.radar.product}` : w.kind === "grid" ? `g:${w.id}` : `x:${w.id}`;
  const pick = (v: string) => {
    if (v.startsWith("g:")) return selectWeather({ kind: "grid", id: v.slice(2) });
    if (!v.startsWith("r:")) return;
    const [, src, prod] = v.split(":");
    update((x) => {
      x.weather = { kind: "radar" };
      x.radar.source = src as "L2" | "L3";
      x.radar.product = prod;
    });
  };
  // the scan bar centres under this dropdown (the main pane's centre), not the window's
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".main-head");
    if (!el) return;
    const upd = () => {
      const r = el.getBoundingClientRect();
      if (r.width) document.documentElement.style.setProperty("--main-cx", `${Math.round(r.left + r.width / 2)}px`);
    };
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    window.addEventListener("resize", upd);
    const t = setInterval(upd, 1000);
    return () => (ro.disconnect(), window.removeEventListener("resize", upd), clearInterval(t));
  }, []);
  return (
    <div class={`pane-head main-head glass ${openPanel.value ? "shift" : ""}`} style={style}>
      <ProductSelect value={value} onPick={pick} title="Product (1–6 for Level II) · type to search" aria-label="Main map product" opts={{ site: s.radar.site, current: s.radar.product, value, label: w.kind === "radar" ? productName(s.radar.product) : activeLabel.value.title }} />
      <LinkControls />
    </div>
  );
}

export function defaultCfg(i: number): PaneCfg {
  const second = ["VEL", "ZDR", "RHO", "SW", "PHI"][i - 1] ?? "VEL";
  return { weather: { kind: "radar" }, product: second, source: "L2", tilt: 0.5 };
}

/** Open a pane in its own window (only the map and its product selector). */
export function openPaneWindow(cfg: PaneCfg, link: PaneLink, view?: { center: [number, number]; zoom: number }, title?: string) {
  const m = mapRef.value;
  const c = m?.getCenter();
  const v = view ?? { center: c ? ([c.lng, c.lat] as [number, number]) : settings.value.view.center, zoom: m?.getZoom() ?? settings.value.view.zoom };
  const t = title ?? `Pane · ${cfgLabel(cfg)}`;
  popout({ kind: "pane", title: t, width: 760, height: 560, data: { view: v, panes: { layout: "1", sync: false, list: [cfg], links: {} }, paneWin: { link, title: t } } });
}

function cfgLabel(cfg: PaneCfg) {
  if (cfg.weather.kind === "grid") return gridLayers.value.find((l) => l.id === (cfg.weather as any).id)?.name ?? cfg.weather.id;
  if (cfg.weather.kind === "gibs") return GIBS.find((g) => g.id === (cfg.weather as any).id)?.name ?? cfg.weather.id;
  return productName(cfg.product ?? "REF");
}

/** Move pane idx out of the window into a pane window; the layout shrinks by one. */
export function popOutPane(idx: number) {
  const s0 = settings.value;
  const cfg = s0.panes.list[idx - 1] ?? defaultCfg(idx);
  const pm = paneMap(idx);
  const c = pm?.getCenter();
  openPaneWindow(cfg, paneLink(idx), c ? { center: [c.lng, c.lat], zoom: pm!.getZoom() } : undefined);
  const n = paneCountOf(s0.panes.layout);
  update((s) => {
    s.panes.list.splice(idx - 1, 1);
    const old = s.panes.links ?? {};
    const links: Record<string, PaneLink> = {};
    for (const [k, v] of Object.entries(old)) if (+k < idx) links[k] = v;
    else if (+k > idx) links[+k - 1] = v;
    s.panes.links = links;
    if (s.panes.ml) s.panes.ml = dropPane(s.panes.ml, idx); // 0.8.1: per-pane detection toggles move with their panes
    if (s.panes.layers) s.panes.layers = dropPane(s.panes.layers, idx); // 0.8.2: and their own layers
    const BY_COUNT: PaneLayoutId[] = ["1", "2", "3", "4"];
    if (s.panes.layout === "swipe" || !s.panes.layout.startsWith("custom:") || n - 1 <= 3) s.panes.layout = BY_COUNT[Math.max(0, Math.min(3, n - 1))];
  });
}

function PaneBox({ idx, area, headStyle, standalone }: { idx: number; area?: string; headStyle?: Sty; standalone?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 0.8.1: load the shown product right away; a pane window re-links when its map is rebuilt
    return mountPane(idx, ref.current!, settings.peek().panes.list[idx - 1] ?? defaultCfg(idx), standalone ? (m) => (linkMap.value = m) : undefined);
  }, [idx]);
  const cfg = settings.value.panes.list[idx - 1] ?? defaultCfg(idx);
  const st = paneStatus.value[idx] ?? {};
  const value = cfg.weather.kind === "grid" ? `g:${cfg.weather.id}` : cfg.weather.kind === "gibs" ? `s:${cfg.weather.id}` /* data 0.6 */ : `r:${cfg.source ?? "L2"}:${cfg.product ?? "REF"}`;
  const set = (v: string) => {
    const [, src, prod] = v.split(":");
    const next: PaneCfg = v.startsWith("g:") ? { weather: { kind: "grid", id: v.slice(2) } } : v.startsWith("s:") /* data 0.6 */ ? { weather: { kind: "gibs", id: v.slice(2) } } : { weather: { kind: "radar" }, source: src as "L2" | "L3", product: prod, tilt: settings.value.radar.tiltAngle, site: cfg.site };
    update((s) => {
      while (s.panes.list.length < idx) s.panes.list.push(defaultCfg(s.panes.list.length + 1));
      s.panes.list[idx - 1] = next;
    });
    paneConfigured(idx, next);
    if (standalone) document.title = `Pane · ${cfgLabel(next)}`;
  };
  const swipe = settings.value.panes.layout === "swipe" && !standalone;
  const g = swipe ? swipeGeom.value : null;
  const hs: Sty | undefined = g?.pane ? { left: `${g.pane.x}px`, top: `${g.pane.y}px` } : g ? { display: "none" } : headStyle;
  const lk = paneLink(idx);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // 0.8.2: the pane's layers menu
  const what = standalone ? "This window" : `Pane ${idx + 1}`;
  return (
    <div class={`pane ${standalone ? "pane-solo" : ""}`} style={{ gridArea: area, clipPath: g?.clip }} aria-label={`Map pane ${idx + 1}`}>
      <div ref={ref} class="pane-map" />
      <div class="pane-head glass" style={hs}>
        <ProductSelect value={value} onPick={set} title="Product for this pane · type to search" aria-label={standalone ? "Product" : `Product for pane ${idx + 1}`} opts={{ site: cfg.site ?? settings.value.radar.site, current: cfg.product, value, sat: true }} />
        <span class="pane-time" title={st.error ?? ""}>{st.loading ? "Loading…" : st.error ? st.error : st.time ? fmtTime(st.time, true) : ""}</span>
        {standalone ? (
          <>
            <LinkControls onLayers={(x, y) => setMenu({ x, y })} />
            <span class="lk8-icons">
              <MlToggle idx={idx} what="This window" />
            </span>
          </>
        ) : (
          <span class="ph-tools">
            {!swipe && <LinkToggles lk={lk} set={(l) => setPaneLink(idx, l)} what={`Pane ${idx + 1}`} onLayers={(x, y) => setMenu({ x, y })} own={paneHasOverrides(idx)} />}
            {swipe && <LinkToggles lk={{ ...lk, pos: true }} set={(l) => setPaneLink(idx, { ...l, pos: true })} what={`Pane ${idx + 1}`} onLayers={(x, y) => setMenu({ x, y })} own={paneHasOverrides(idx)} />}
            <MlToggle idx={idx} what={`Pane ${idx + 1}`} />
            <button class="lk8 pane-out" title="Pop this pane out into its own window" aria-label={`Pop out pane ${idx + 1}`} onClick={() => popOutPane(idx)}>
              <ExternalLink size={11} />
            </button>
          </span>
        )}
      </div>
      {!swipe && <PaneCrosshair idx={idx} /> /* 0.8.1 */}
      <PaneCursorValue idx={idx} /* 0.8.2 */ />
      <PaneInspector idx={idx} /* 0.8.3 inspector */ />
      <PaneBearing idx={idx} /* 0.8.3 inspector */ />
      {menu && <PaneLayerMenu idx={idx} what={what} at={menu} onClose={() => setMenu(null)} /* 0.8.2 */ />}
    </div>
  );
}

/** Pane window (pop-out): just one map pane and its product selector. */
export function PaneWindowApp() {
  useEffect(() => {
    document.title = popoutSpec?.title ?? "Pane";
    document.documentElement.style.setProperty("--hdr-b", "8px");
    startAlerts();
  }, []);
  return (
    <div class="app pane-window">
      <div class="panes layout-1">
        <PaneBox idx={1} standalone />
      </div>
    </div>
  );
}

/** The main map element plus extra panes in a grid. */
export function PaneGrid({ mapEl }: { mapEl: any }) {
  const layout = settings.value.panes.layout;
  const n = paneCountOf(layout);
  const spec = layoutSpec(layout);
  const panel = !!openPanel.value;
  useHeaderVar();
  useEffect(() => {
    // make sure every pane has a config
    if (settings.value.panes.list.length < n)
      update((s) => {
        while (s.panes.list.length < n) s.panes.list.push(defaultCfg(s.panes.list.length + 1));
      });
    const t = setTimeout(resizePanes, 30);
    return () => clearTimeout(t);
  }, [layout, n]);
  const grid = !!spec && layout !== "1";
  const style: Sty | undefined = grid ? { gridTemplateRows: `repeat(${spec!.rows}, minmax(0, 1fr))`, gridTemplateColumns: `repeat(${spec!.cols}, minmax(0, 1fr))` } : undefined;
  const areaOf = (i: number) => {
    const c = spec?.cells[i];
    return grid && c ? `${c.r + 1} / ${c.c + 1} / span ${c.rs} / span ${c.cs}` : undefined;
  };
  // selectors: below the header in the top row; left-column panes centre in what the side panel leaves visible
  const headOf = (i: number): Sty | undefined => {
    const c = spec?.cells[i];
    if (!grid || !c) return undefined;
    const st: Sty = { top: c.r === 0 ? "var(--hdr-b, 62px)" : "8px" };
    if (panel && c.c === 0 && c.cs < spec!.cols) st.left = "calc((var(--rail) + 18px + 316px + 100%) / 2)";
    else st.left = "50%";
    return st;
  };
  const g = layout === "swipe" ? swipeGeom.value : null;
  const mainHead: Sty | undefined = g ? (g.main ? { left: `${g.main.x}px`, top: `${g.main.y}px` } : { display: "none" }) : headOf(0);
  return (
    <div class={`panes layout-${layout.startsWith("custom:") ? "custom" : layout} ${grid ? "pg8" : ""} ${panel ? "panel-open" : ""}`} style={style}>
      <div class="pane main" style={{ gridArea: areaOf(0) }}>
        <div ref={mapEl} class="map" role="application" aria-label="Weather map" tabIndex={-1} id="tbw-map" />
        <MainPaneHead style={mainHead} />
        {grid && <Crosshair /> /* 0.8.1: centre of the main pane (the window-centred one is hidden in grid layouts) */}
      </div>
      {Array.from({ length: n }, (_, i) => (
        <PaneBox key={`${layout}-${i + 1}`} idx={i + 1} area={areaOf(i + 1)} headStyle={headOf(i + 1)} />
      ))}
      {layout === "swipe" && <SwipeDivider /> /* data 0.6 */}
    </div>
  );
}

/** The toolbar's panes button: a drawn grid icon (the current layout, or 2×2). */
function PanesGlyph({ size = 19 }: { size?: number }) {
  const p = settings.value.panes;
  if (p.layout === "swipe") return <LayoutIcon swipe={p.swipeMode ?? "v"} size={size} />;
  const spec = layoutSpec(p.layout);
  return <LayoutIcon spec={!spec || p.layout === "1" ? BUILTIN_LAYOUTS[5] : spec} size={size} />;
}

export function PaneButton() {
  const [open, setOpen] = useState(false);
  const p = settings.value.panes;
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const setLayout = (k: PaneLayoutId) => update((s) => (s.panes.layout = k));
  const close = () => (setOpen(false), btnRef.current?.focus());
  useEffect(() => {
    if (!open) return;
    (popRef.current?.querySelector<HTMLElement>("button.on") ?? popRef.current?.querySelector<HTMLElement>("button"))?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close());
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [open]);
  const n = paneCountOf(p.layout);
  const custom = settings.value.paneLayouts ?? [];
  const lb = (k: PaneLayoutId, icon: any, title: string) => (
    <button key={k} class={`tb sm ${p.layout === k ? "on" : ""}`} title={title} aria-label={title} aria-pressed={p.layout === k} onClick={() => setLayout(k)}>
      {icon}
    </button>
  );
  const allLinked = (k: keyof PaneLink) => Array.from({ length: n }, (_, i) => paneLink(i + 1)[k]).every(Boolean);
  const linkAll = (on: boolean) =>
    update((s) => {
      const l: Record<string, PaneLink> = {};
      for (let i = 1; i <= n; i++) l[i] = { pos: on, time: on, layers: on };
      s.panes.links = { ...(s.panes.links ?? {}), ...l };
      s.panes.sync = on;
      if (on) s.panes.mainPos = true; // 0.8.1
    });
  const others = peerList.value;
  return (
    <div class="pane-btn-wrap">
      {open && (
        <>
          <div class="ws-scrim" onPointerDown={close} />
          <div class="pane-pop pp8 glass" ref={popRef} role="dialog" aria-label="Map panes">
            <div class="pp8-h">Layout</div>
            <div class="pp8-row" role="toolbar" aria-label="Pane layouts">
              {BUILTIN_LAYOUTS.map((l) => lb(l.id, <LayoutIcon spec={l} />, l.name))}
              {lb("swipe", <LayoutIcon swipe={p.swipeMode ?? "v"} />, "Swipe compare: drag the divider to compare two layers")}
            </div>
            {p.layout === "swipe" && (
              <div class="pp8-row pp8-sub" role="radiogroup" aria-label="Swipe divider">
                {(["v", "h", "d"] as SwipeMode[]).map((m) => (
                  <button key={m} role="radio" aria-checked={(p.swipeMode ?? "v") === m} class={`pp8-chip ${(p.swipeMode ?? "v") === m ? "on" : ""}`} onClick={() => update((s) => (s.panes.swipeMode = m))}>
                    <LayoutIcon swipe={m} size={14} />
                    {m === "v" ? "Vertical" : m === "h" ? "Horizontal" : "Diagonal"}
                  </button>
                ))}
              </div>
            )}
            <div class="pp8-h">
              My layouts
              <button
                class="pp8-edit"
                title="Create and edit layouts (Settings → Pane layouts)"
                onClick={() => {
                  setOpen(false);
                  jumpToSetting("pane-layouts");
                }}
              >
                <Pencil size={11} /> Edit
              </button>
            </div>
            <div class="pp8-row" role="toolbar" aria-label="My layouts">
              {custom.length ? custom.map((l) => lb(`custom:${l.id}`, <LayoutIcon spec={l} />, `${l.name} (${Math.min(MAX_MAPS, l.cells.length)} maps)`)) : <span class="muted small">None yet: Edit to make one</span>}
            </div>
            {(n > 0 || others.length > 0) && (
              <>
                <div class="pp8-h">
                  Linked to the main map
                  {n > 0 && (
                    <button class="pp8-edit" onClick={() => linkAll(!(allLinked("pos") && allLinked("time") && allLinked("layers")))} title="Link or unlink every pane">
                      {allLinked("pos") && allLinked("time") && allLinked("layers") ? <Link2Off size={11} /> : <Link2 size={11} />}
                      {allLinked("pos") && allLinked("time") && allLinked("layers") ? "Unlink all" : "Link all"}
                    </button>
                  )}
                </div>
                <div class="pp8-links">
                  {n > 0 && p.layout !== "swipe" && (
                    /* 0.8.1: unlink the main map; linked panes keep moving together */
                    <div class="pp8-lrow">
                      <span class="pp8-ln" title="The main map">
                        <b>Main</b> map
                      </span>
                      <span class="lk8-chips" role="group" aria-label="Main map links">
                        <button
                          class={`lk8 ${mainLinked() ? "on" : ""}`}
                          aria-pressed={mainLinked()}
                          title={mainLinked() ? "Main map moves with the linked panes (click to let it move freely)" : "Main map moves freely; linked panes still move together (click to link)"}
                          aria-label="Link position for the main map"
                          onClick={(e) => (e.stopPropagation(), update((s) => (s.panes.mainPos = !mainLinked())))}
                        >
                          <Move size={12} />
                          <span>Pos</span>
                        </button>
                      </span>
                    </div>
                  )}
                  {Array.from({ length: n }, (_, i) => {
                    const cfg = p.list[i] ?? defaultCfg(i + 1);
                    return (
                      <div class="pp8-lrow" key={`p${i}`}>
                        <span class="pp8-ln" title={cfgLabel(cfg)}>
                          <b>Pane {i + 2}</b> {cfgLabel(cfg)}
                        </span>
                        {p.layout === "swipe" ? (
                          <LinkToggles chips lk={{ ...paneLink(i + 1), pos: true }} set={(l) => setPaneLink(i + 1, { ...l, pos: true })} what={`Pane ${i + 2}`} />
                        ) : (
                          <LinkToggles chips lk={paneLink(i + 1)} set={(l) => setPaneLink(i + 1, l)} what={`Pane ${i + 2}`} />
                        )}
                      </div>
                    );
                  })}
                  {myKind === "main" &&
                    others.map((w) => (
                      <div class="pp8-lrow" key={w.id}>
                        <span class="pp8-ln" title={w.title}>
                          <b>{w.kind === "pane" ? "Window" : "Map win"}</b> {w.title.replace(/^Pane · /, "")}
                        </span>
                        <LinkToggles chips lk={w.lk} set={(l) => setPeerLink(w.id, l)} what={w.title} />
                      </div>
                    ))}
                </div>
              </>
            )}
            <div class="pp8-h">Windows</div>
            <div class="pp8-row">
              <button
                class="pp8-chip"
                title="Open another full map window (its own layers; good for a second monitor)"
                onClick={() => {
                  const m = mapRef.value;
                  const c = m?.getCenter();
                  popout({ kind: "map", title: "Stormiq · map", width: 1100, height: 750, data: { view: { center: c ? [c.lng, c.lat] : settings.value.view.center, zoom: m?.getZoom() ?? 6 }, panes: { layout: "1", sync: true, list: [] } } });
                }}
              >
                <AppWindow size={14} /> Map window
              </button>
              <button class="pp8-chip" title="Open a window that acts like a pane: only a product selector, linked to this window" onClick={() => openPaneWindow(defaultCfg(1), { pos: true, time: true, layers: true })}>
                <SquarePlus size={14} /> Pane window
              </button>
            </div>
          </div>
        </>
      )}
      <button ref={btnRef} class={`tb ${p.layout !== "1" ? "on" : ""}`} title={`Map panes · ${layoutName(p.layout)}`} aria-label="Map panes" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <PanesGlyph />
      </button>
    </div>
  );
}

export type { PaneLayoutDef };
