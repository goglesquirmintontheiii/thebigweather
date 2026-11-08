import { tool, crosshair, toast, settings, update } from "../store";
import { playing, togglePlay, frameCount } from "../anim";
import { mapRef, measureTotal, measurePts, describeBearing, bearingInfo } from "../map/mapview";
import { fmtDist } from "../util";
import { Play, Pause, LocateFixed, Camera, Compass, Crosshair, Ruler, RadioTower, PenTool, MousePointer2 } from "lucide-preact";
import * as maplibregl from "maplibre-gl";
import { DrawBar } from "./DrawBar";
import { PaneButton } from "./Panes";
import { ScreenRecButton } from "./ScreenRecButton";
import { CalendarClock } from "lucide-preact"; // history
import { histRange, histPicker, exitHistory } from "../history"; // history
// workflow
import { useState, useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { Film, Bookmark, Slice, Route, Leaf, Ellipsis } from "lucide-preact";
import { loopDialog, loopProgress } from "../loopexport";
import { LoopExportDialog } from "./LoopExport";
import { SrvControl } from "./SrvControl";
import { WorkspaceMenu } from "./panels/WorkspacePanel";
import { startXSection, xsLine } from "./XSection";
import { trackPanel, recording } from "../gps";
import { ScanSearch, Zap, Shapes } from "lucide-preact"; // radar 0.6
import { LightningChip, toggleInspector } from "./Inspector"; // radar 0.6
/* workflow 0.6 */
import { Megaphone, Tv, Navigation, ListChecks, AppWindow } from "lucide-preact";
import { runBriefing, briefing } from "../briefing";
import { enterKiosk } from "../kiosk";
/* end workflow 0.6 */
import { Share2, Users } from "lucide-preact"; // share & collab
import { shareDialog } from "../share/share"; // share & collab
import { teamOpen, team, unread } from "../share/collab"; // share & collab
/* data 0.8 */
import { FileDown, Car, BellRing } from "lucide-preact";
import { exportOpen } from "../export/export";
import { chaseOpen } from "../chase/chase";
import { activeLog } from "../chase/log";
import { notifyOpen } from "./NotifyPanel";
/* end data 0.8 */
/* 0.8.2: pinnable "…" menu items */
import { Fragment } from "preact";
import { signal } from "@preact/signals";
import { Pin, PinOff, ChevronLeft, ChevronRight } from "lucide-preact";
import { togglePin, movePin, cleanPins, fitCount } from "./tbpins";
import type { PanelId } from "../store";
import "./tb082.css";

let locMarker: maplibregl.Marker | null = null;

export async function locate() {
  const map = mapRef.value;
  if (!map) return;
  const show = (lat: number, lon: number, approx: boolean) => {
    locMarker?.remove();
    const el = document.createElement("div");
    el.className = `me-marker ${approx ? "approx" : ""}`;
    locMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), approx ? 8 : 10) });
    if (approx) toast("Approximate location (from IP)", "info");
  };
  const ipFallback = async () => {
    try {
      const r = await fetch("https://ipwho.is/").then((x) => x.json());
      if (r.success !== false && r.latitude) return show(r.latitude, r.longitude, true);
    } catch {
      /* next */
    }
    const home = settings.value.points[0];
    if (home) return show(home.lat, home.lon, false);
    toast("Couldn't get your location", "warn");
  };
  if (!("geolocation" in navigator)) return ipFallback();
  navigator.geolocation.getCurrentPosition(
    (p) => show(p.coords.latitude, p.coords.longitude, false),
    () => ipFallback(),
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 },
  );
}

export async function screenshot() {
  const tbw = (window as any).tbw;
  if (tbw?.capture) {
    const path = await tbw.capture();
    if (path) toast(`Saved ${path}`);
    return;
  }
  // browser fallback: map canvas only
  const map = mapRef.value;
  if (!map) return;
  map.once("render", () => {
    map.getCanvas().toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `TBW_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
      a.click();
    });
  });
  map.triggerRepaint();
}

/* ---------- 0.8.2: "…" menu items (each can be pinned to the toolbar) ---------- */
/** workspaces menu (a signal so a pinned button can open it too) */
export const wsMenu = signal(false);
export interface TbItem {
  id: string;
  sec: string;
  label: string;
  key?: string;
  icon: any;
  on: () => boolean;
  run: () => void;
  disabled?: () => boolean;
  /** hidden for shared-view viewers (Phase 6) */
  owner?: boolean;
  /** lights the "…" button while on (tools, not panels) */
  tool?: boolean;
}
const togglePanel = (id: Exclude<PanelId, null>) => () => (openPanel.value = openPanel.value === id ? null : id);
export const TB_ITEMS: TbItem[] = [
  { id: "insp", sec: "Radar tools", label: "Inspector (all moments)", key: "I", icon: ScanSearch, on: () => !!settings.value.radar6?.inspector, run: toggleInspector },
  { id: "xsect", sec: "Radar tools", label: "Cross-section (Level II)", icon: Slice, on: () => tool.value === "xsect" || !!xsLine.value, run: startXSection, tool: true },
  { id: "bearing", sec: "Radar tools", label: "Distance & direction", key: "B", icon: Compass, on: () => tool.value === "bearing", run: () => (tool.value = tool.value === "bearing" ? "none" : "bearing"), tool: true },
  { id: "sites", sec: "Radar tools", label: "Radar sites", key: "R", icon: RadioTower, on: () => settings.value.overlays.sites, run: () => update((s) => (s.overlays.sites = !s.overlays.sites)) },
  { id: "placefiles", sec: "Radar tools", label: "Placefiles", icon: Shapes, on: () => openPanel.value === "placefiles", run: togglePanel("placefiles") },
  { id: "ltg", sec: "Radar tools", label: "Lightning near my points", icon: Zap, on: () => !!settings.value.radar6?.ltgWatch, run: () => update((s) => (s.radar6 = { ...s.radar6, ltgWatch: !s.radar6?.ltgWatch })) },
  { id: "cross", sec: "Data", label: "Crosshair", key: "C", icon: Crosshair, on: () => crosshair.value, run: () => (crosshair.value = !crosshair.value), tool: true },
  { id: "cursor", sec: "Data", label: "Data inspector", key: "V", icon: MousePointer2, on: () => settings.value.ui.cursorValue, run: () => update((s) => (s.ui.cursorValue = !s.ui.cursorValue)), tool: true },
  { id: "loop", sec: "Data", label: "Export loop (GIF / MP4)", icon: Film, on: () => loopDialog.value || !!loopProgress.value, run: () => (loopDialog.value = !loopDialog.value), disabled: () => frameCount.value < 1 || !!loopProgress.value, tool: true },
  { id: "track", sec: "Data", label: "GPS track & chasers", icon: Route, on: () => trackPanel.value, run: () => (trackPanel.value = !trackPanel.value), tool: true },
  { id: "export", sec: "Data", label: "Export data", icon: FileDown, on: () => exportOpen.value, run: () => (exportOpen.value = !exportOpen.value) },
  { id: "chase", sec: "Data", label: "Chaser toolkit", icon: Car, on: () => chaseOpen.value, run: () => (chaseOpen.value = !chaseOpen.value) },
  { id: "route", sec: "Workflow", label: "Route weather", icon: Navigation, on: () => openPanel.value === "route", run: togglePanel("route") },
  { id: "brief", sec: "Workflow", label: "Briefing (spoken summary)", icon: Megaphone, on: () => !!briefing.value, run: () => runBriefing() },
  { id: "rules", sec: "Workflow", label: "Notification rules", icon: ListChecks, on: () => openPanel.value === "rules", run: togglePanel("rules"), owner: true },
  { id: "notify", sec: "Workflow", label: "Notification channels", icon: BellRing, on: () => notifyOpen.value, run: () => (notifyOpen.value = !notifyOpen.value) },
  { id: "widgets", sec: "Workflow", label: "Desktop widgets", icon: AppWindow, on: () => openPanel.value === "widgets", run: togglePanel("widgets"), owner: true },
  { id: "ws", sec: "Workflow", label: "Workspaces", icon: Bookmark, on: () => wsMenu.value, run: () => (wsMenu.value = !wsMenu.value), owner: true },
  { id: "kiosk", sec: "Workflow", label: "Wall / kiosk mode", icon: Tv, on: () => false, run: enterKiosk, owner: true },
  { id: "share", sec: "Share", label: "Share live view", icon: Share2, on: () => shareDialog.value, run: () => (shareDialog.value = !shareDialog.value), owner: true },
  { id: "team", sec: "Share", label: "Team (live collaboration)", icon: Users, on: () => teamOpen.value, run: () => (teamOpen.value = !teamOpen.value), owner: true },
];
const tbItem = (id: string) => TB_ITEMS.find((x) => x.id === id);
const SECS = [...new Set(TB_ITEMS.map((x) => x.sec))];
/** label with live state (recording, logging, team name) */
function liveLabel(it: TbItem): string {
  if (it.id === "track" && recording.value) return "GPS track · recording";
  if (it.id === "chase" && activeLog.value) return "Chaser toolkit · logging";
  if (it.id === "team" && team.value) return `Team · ${team.value.name}${unread.value ? ` (${unread.value})` : ""}`;
  return it.label;
}
/** pinned item ids, in toolbar order */
export const pinnedIds = () => cleanPins(settings.value.tbPins, (id) => !!tbItem(id));
export function setPins(fn: (p: string[]) => string[]) {
  update((s) => (s.tbPins = fn(cleanPins(s.tbPins, (id) => !!tbItem(id)))));
}
/* ---------- end 0.8.2 ---------- */

export function Toolbar() {
  const t = tool.value;
  const wsOpen = wsMenu.value; // workflow (0.8.2: a signal)
  const setWsOpen = (v: boolean) => (wsMenu.value = v);
  const [more, setMore] = useState(false);
  /* 0.8.2: pinned items, how many fit, right-click menu on a pinned button */
  const pins = pinnedIds();
  const [fit, setFit] = useState(pins.length);
  const [ctx, setCtx] = useState<{ id: string; x: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [, setW] = useState(0);
  useEffect(() => {
    const r = () => setW(window.innerWidth);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const pinEls = bar.querySelectorAll<HTMLElement>(":scope > .tb-pin");
    const one = pinEls[0] ?? bar.querySelector<HTMLElement>(":scope > .tb");
    const per = (one?.getBoundingClientRect().width ?? 42) + 2;
    const base = bar.getBoundingClientRect().width - pinEls.length * per;
    // the bar is centred in the window: keep it clear of the left rail on both sides
    const dock = bar.closest<HTMLElement>(".bottom-dock");
    const host = ((dock?.offsetParent as HTMLElement | null) ?? document.body).getBoundingClientRect();
    const rail = document.querySelector<HTMLElement>(".rail")?.getBoundingClientRect();
    const avail = host.width - 2 * Math.max(16, rail && rail.width ? rail.right - host.left + 8 : 16);
    const n = fitCount(avail, base, per, pins.length);
    if (n !== fit) setFit(n);
  });
  void measurePts.value;
  void bearingInfo.value;
  const btn = (on: boolean, title: string, onClick: () => void, icon: any, disabled = false) => (
    <button class={`tb ${on ? "on" : ""}`} title={title} onClick={onClick} disabled={disabled}>
      {icon}
    </button>
  );
  const shown = pins.slice(0, fit);
  const menuItem = (it: TbItem) => {
    const pinned = pins.includes(it.id);
    const Icon = it.icon;
    return (
      <div key={it.id} class={`tb-more-row ${pinned ? "pinned" : ""}`}>
        <button class={`tb-more-item ${it.on() ? "on" : ""}`} onClick={() => (setMore(false), it.run())} disabled={it.disabled?.()}>
          <Icon size={16} class={it.owner ? "p6-owner" : undefined} />
          <span>{liveLabel(it)}</span>
          {it.key && <kbd>{it.key}</kbd>}
        </button>
        <button
          class={`tb-pin-btn ${pinned ? "on" : ""}`}
          title={pinned ? (shown.includes(it.id) ? "Unpin from toolbar" : "Pinned, no room in the toolbar · click to unpin") : "Pin to toolbar"}
          aria-label={pinned ? `Unpin ${it.label}` : `Pin ${it.label} to toolbar`}
          aria-pressed={pinned}
          onClick={(e) => (e.stopPropagation(), setPins((p) => togglePin(p, it.id)))}
        >
          <Pin size={13} />
        </button>
      </div>
    );
  };
  // a tool inside the menu is active (0.8.2: not counting tools shown as pinned buttons)
  const moreOn = TB_ITEMS.some((it) => it.tool && !shown.includes(it.id) && it.on());
  return (
    <div class={`toolbar-wrap ${more ? "menu-open" : ""}`}>
      {t === "measure" && (
        <div class="tool-readout glass">
          {measurePts.value.length < 2 ? "Click points to measure · right-click to finish" : `Total ${fmtDist(measureTotal())}`}
        </div>
      )}
      {t === "draw" && <DrawBar />}
      {t === "bearing" && bearingInfo.value && <div class="tool-readout glass">From {settings.value.radar.site}: {describeBearing()}</div>}
      {/* workflow */ t === "xsect" && <div class="tool-readout glass">Cross-section: click two points · Esc to cancel</div>}
      <SrvControl />
      <LoopExportDialog />
      {wsOpen && (
        <>
          <div class="ws-scrim" onPointerDown={() => setWsOpen(false)} />
          <WorkspaceMenu onClose={() => setWsOpen(false)} />
        </>
      )}
      {more && (
        <>
          <div class="ws-scrim" onPointerDown={() => setMore(false)} />
          <div class="tb-more glass">
            {SECS.map((sec) => (
              <Fragment key={sec}>
                <div class={`tb-more-h ${sec === "Share" ? "p6-owner" : ""}`}>{sec}</div>
                {TB_ITEMS.filter((x) => x.sec === sec).map(menuItem)}
              </Fragment>
            ))}
          </div>
        </>
      )}
      {ctx && (
        <>
          <div class="ws-scrim" onPointerDown={() => setCtx(null)} onContextMenu={(e) => (e.preventDefault(), setCtx(null))} />
          <div class="tb-ctx glass" style={{ left: `${ctx.x}px` }} onClick={() => setCtx(null)}>
            <button class="tb-more-item" disabled={pins.indexOf(ctx.id) <= 0} onClick={() => setPins((p) => movePin(p, ctx.id, -1))}>
              <ChevronLeft size={15} />
              <span>Move left</span>
            </button>
            <button class="tb-more-item" disabled={pins.indexOf(ctx.id) >= shown.length - 1} onClick={() => setPins((p) => movePin(p, ctx.id, 1))}>
              <ChevronRight size={15} />
              <span>Move right</span>
            </button>
            <button class="tb-more-item" onClick={() => setPins((p) => togglePin(p, ctx.id))}>
              <PinOff size={15} />
              <span>Unpin from toolbar</span>
            </button>
          </div>
        </>
      )}
      <div class="toolbar glass" ref={barRef}>
        {btn(playing.value, "Play / pause loop (Space)", togglePlay, playing.value ? <Pause size={19} /> : <Play size={19} />, frameCount.value < 2)}
        {/* history */ btn(!!histRange.value || histPicker.value, histRange.value ? "Historical mode on · click for live" : "Historical mode", () => (histRange.value ? exitHistory() : (histPicker.value = !histPicker.value)), <CalendarClock size={19} />)}
        {btn(false, "My location (L)", locate, <LocateFixed size={19} />)}
        {btn(false, "Screenshot (S)", screenshot, <Camera size={19} />)}
        <ScreenRecButton />
        {btn(t === "measure", "Measure distance (M)", () => (tool.value = t === "measure" ? "none" : "measure"), <Ruler size={19} />)}
        <PaneButton />
        {btn(t === "draw", "Drawing mode (D)", () => (tool.value = t === "draw" ? "none" : "draw"), <PenTool size={19} />)}
        {/* 0.8.2: pinned items (the rest stay in the … menu when the window is narrow) */}
        {shown.map((id) => {
          const it = tbItem(id)!;
          const Icon = it.icon;
          return (
            <button
              key={id}
              class={`tb tb-pin ${it.on() ? "on" : ""}`}
              title={`${liveLabel(it)}${it.key ? ` (${it.key})` : ""} · right-click to unpin`}
              aria-label={it.label}
              disabled={it.disabled?.()}
              onClick={it.run}
              onContextMenu={(e) => {
                e.preventDefault();
                const el = e.currentTarget as HTMLElement;
                const w = el.closest(".toolbar-wrap")!.getBoundingClientRect();
                setCtx({ id, x: el.getBoundingClientRect().left - w.left });
              }}
            >
              <span class="tb-ic">
                <Icon size={19} class={it.owner ? "p6-owner" : undefined} />
                {id === "track" && recording.value && <i class="tb-dot rec" />}
              </span>
            </button>
          );
        })}
        {btn(
          more || moreOn,
          "More tools",
          () => setMore(!more),
          <span class="tb-ic">
            <Ellipsis size={19} />
            {recording.value && !shown.includes("track") && <i class="tb-dot rec" />}
          </span>,
        )}
        <LightningChip /> {/* radar 0.6 */}
        {settings.value.saver && btn(true, "Bandwidth saver on · click to turn off", () => update((s) => (s.saver = false)), <Leaf size={19} />)}
      </div>
    </div>
  );
}

/* ---------- workflow: automation hook (screenshots / console) ---------- */
import { pinMetar } from "./MetarPanels";
import { stormCells, stormPrepare } from "../overlays/stormcells";
import { recs } from "./panels/RecordPanel";
import { openPanel } from "../store";
import { tracks, startTrack } from "../gps";
(window as any).__tbwWf = { loopDialog, startXSection, xsLine, pinMetar, trackPanel, recording, tracks, startTrack, stormCells, stormPrepare, recs, openPanel, update, settings };
