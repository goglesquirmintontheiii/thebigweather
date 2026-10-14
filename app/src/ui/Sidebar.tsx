import { PlacefilePanel } from "./PlacefilePanel"; // radar 0.6
import { openPanel, type PanelId, connection } from "../store";
import { settings, update } from "../store"; // 0.8.1
import { signal } from "@preact/signals"; // 0.8.1
import { useEffect, useRef, useState } from "preact/hooks"; // 0.8.1
import { createPortal } from "preact/compat"; // 0.8.1
import { mergeOrder, moveBy, dropAt, isDefaultOrder } from "./uiorder"; // 0.8.1
import "./hotfix081.css"; // 0.8.1
import { viewer } from "../share/share"; // share & collab
import { alerts } from "../alerts";
import { Layers, Radar, TriangleAlert, MapPin, Activity, Settings, Radio, FolderOpen, CloudSun, Search, X, Map as MapIcon, CircleDot } from "lucide-preact";
import { RadioPanel } from "./panels/RadioPanel";
import { ForecastPanel } from "./panels/ForecastPanel";
import { SearchPanel } from "./panels/SearchPanel";
import { RecordPanel, recs } from "./panels/RecordPanel";
import { FilesPanel } from "./panels/FilesPanel";
import { nowPlaying, players } from "../radio";
import { forecastOpen } from "./ForecastCenter";
import { radioOpen } from "./RadioCenter";
import { MapPanel } from "./panels/MapPanel";
import { LayersPanel } from "./panels/LayersPanel";
import { RadarPanel } from "./panels/RadarPanel";
import { AlertsPanel } from "./panels/AlertsPanel";
import { PointsPanel } from "./panels/PointsPanel";
import { SourcesPanel } from "./panels/SourcesPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { Bookmark } from "lucide-preact"; // workflow
import { WorkspacePanel } from "./panels/WorkspacePanel"; // workflow
import { History } from "lucide-preact"; // history 0.6
import { histStormsOpen } from "../histsearch"; // history 0.6
/* detection models */
import { BrainCircuit } from "lucide-preact";
import { mlOpen, activeJobs } from "../ml/client";
/* end detection models */
/* shake/stats/server 0.6 */
import { AudioWaveform } from "lucide-preact";
import { shakeOpen } from "../shake";
/* workflow 0.6 */
import { RoutePanel } from "./RoutePanel";
import { RulesPanel } from "./RulesPanel";
import { WidgetsPanel } from "./WidgetHost";
/* end workflow 0.6 */
/* end shake/stats/server 0.6 */
import { Sun } from "lucide-preact"; // p7
import { spaceOpen } from "./SpacePanel"; // p7
/* radio/dash 0.8 */
import { LayoutDashboard, ChartGantt } from "lucide-preact";
import { dashOpen } from "./Dashboard";
import { timelineOpen } from "./AlertTimeline";
/* end radio/dash 0.8 */

const ITEMS: { id: Exclude<PanelId, null>; icon: any; label: string }[] = [
  { id: "radar", icon: Radar, label: "Radar" },
  { id: "layers", icon: Layers, label: "Layers" },
  { id: "map", icon: MapIcon, label: "Basemap" },
  { id: "alerts", icon: TriangleAlert, label: "Alerts" },
  { id: "points", icon: MapPin, label: "My points" },
  { id: "sources", icon: Activity, label: "Data sources" },
];

const MORE: { id: Exclude<PanelId, null>; icon: any; label: string }[] = [
  { id: "forecast", icon: CloudSun, label: "Forecast" },
  { id: "radio", icon: Radio, label: "Weather radio" },
  { id: "seismo" as any, icon: AudioWaveform, label: "Seismographs" }, // shake/stats/server 0.6
  { id: "search", icon: Search, label: "Search" },
  { id: "record", icon: CircleDot, label: "Recordings" },
  { id: "files", icon: FolderOpen, label: "Files & backup" },
  { id: "workspaces", icon: Bookmark, label: "Workspaces" }, // workflow
  // route / rules / widgets / placefiles: in the toolbar "…" menu (keeps the rail short)
];

/* ---------- 0.8.1: rearrangeable rail ---------- */
interface RailEntry {
  id: string;
  icon: any;
  label: string;
  on: () => boolean;
  click: () => void;
  extra?: () => any;
}
const togglePanel = (id: Exclude<PanelId, null>) => () => (openPanel.value = openPanel.value === id ? null : id);
const RAIL: RailEntry[] = [
  ...ITEMS.map(({ id, icon, label }) => ({
    id,
    icon,
    label,
    on: () => openPanel.value === id,
    click: togglePanel(id),
    extra:
      id === "alerts"
        ? () => {
            const nWarn = [...alerts.value.values()].filter((a) => String(a.properties.event).endsWith("Warning")).length;
            return nWarn > 0 && <span class="badge">{nWarn > 99 ? "99+" : nWarn}</span>;
          }
        : id === "sources"
          ? () => connection.value !== "online" && <span class={`dot ${connection.value}`} />
          : undefined,
  })),
  { id: "sep", icon: null, label: "Separator", on: () => false, click: () => {} },
  ...MORE.map(({ id, icon, label }) => ({
    id: id as string,
    icon,
    label,
    on: () => openPanel.value === id || (id === "forecast" && forecastOpen.value) || (id === "radio" && radioOpen.value) || ((id as string) === "seismo" && shakeOpen.value),
    click: () => (id === "forecast" ? (forecastOpen.value = !forecastOpen.value) : id === "radio" ? (radioOpen.value = !radioOpen.value) : (id as string) === "seismo" ? (shakeOpen.value = !shakeOpen.value) /* shake/stats/server 0.6 */ : togglePanel(id)()),
    extra:
      id === "radio"
        ? () => (nowPlaying.value || players.value.length > 0) && <span class="dot online" />
        : id === "record"
          ? () => recs.value.some((r) => r.status === "recording") && <span class="dot rec" />
          : undefined,
  })),
  { id: "hist", icon: History, label: "Historical Storms", on: () => histStormsOpen.value, click: () => (histStormsOpen.value = !histStormsOpen.value) }, // history 0.6
  { id: "ml", icon: BrainCircuit, label: "Detection models", on: () => mlOpen.value, click: () => (mlOpen.value = !mlOpen.value), extra: () => activeJobs.value.length > 0 && <span class="dot online" title="Training in progress" /> }, // detection models
  { id: "space", icon: Sun, label: "Space weather", on: () => spaceOpen.value, click: () => (spaceOpen.value = !spaceOpen.value) }, // p7
  { id: "dash", icon: LayoutDashboard, label: "Dashboard", on: () => dashOpen.value, click: () => (dashOpen.value = !dashOpen.value) }, // radio/dash 0.8
  { id: "timeline", icon: ChartGantt, label: "Alert timeline", on: () => timelineOpen.value, click: () => (timelineOpen.value = !timelineOpen.value) }, // radio/dash 0.8
];
export const RAIL_DEFAULT = RAIL.map((r) => r.id);

function railOrder(): string[] {
  return mergeOrder(settings.value.railOrder, RAIL_DEFAULT);
}
function saveOrder(o: string[]) {
  update((s) => (s.railOrder = isDefaultOrder(o, RAIL_DEFAULT) ? undefined : o));
}
/** right-click menu on a rail button */
const railMenu = signal<{ id: string; x: number; y: number } | null>(null);

export function Rail() {
  const order = railOrder();
  const byId = new Map(RAIL.map((r) => [r.id, r]));
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const move = (id: string, d: number) => saveOrder(moveBy(order, id, d));
  const dragProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      setDrag(id);
      railMenu.value = null;
      e.dataTransfer?.setData("text/x-tbw-rail", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      if (over?.id !== id || over.after !== after) setOver({ id, after });
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (drag && over) saveOrder(dropAt(order, drag, over.id, over.after));
      setDrag(null);
      setOver(null);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      railMenu.value = { id, x: e.clientX, y: e.clientY };
    },
    // keyboard: Alt+↑ / Alt+↓ moves the focused button
    onKeyDown: (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      e.stopPropagation();
      move(id, e.key === "ArrowUp" ? -1 : 1);
      requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-rail="${id}"]`)?.focus());
    },
    "data-rail": id,
  });
  const dropCls = (id: string) => (over?.id === id && drag && drag !== id ? (over.after ? " drop-after" : " drop-before") : "") + (drag === id ? " dragging" : "");
  return (
    <nav class="rail glass" ref={navRef as any}>
      {order.map((id) => {
        const r = byId.get(id)!;
        if (id === "sep") return <div key="sep" class={`rail-sep rail-sep-drag${dropCls(id)}`} title="Separator (drag to move)" {...(dragProps(id) as any)} />;
        const Icon = r.icon;
        return (
          <button key={id} class={`rail-btn ${r.on() ? "on" : ""}${dropCls(id)}`} title={r.label} onClick={r.click} {...(dragProps(id) as any)}>
            <Icon size={20} />
            {r.extra?.()}
          </button>
        );
      })}
      <div class="rail-fill" />
      <button class={`rail-btn ${openPanel.value === "settings" ? "on" : ""}`} title="Settings" onClick={() => (openPanel.value = openPanel.value === "settings" ? null : "settings")}>
        <Settings size={20} />
      </button>
      <RailMenu order={order} move={move} />
    </nav>
  );
}

function RailMenu({ order, move }: { order: string[]; move: (id: string, d: number) => void }) {
  const m = railMenu.value;
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement)?.closest?.(".rail-menu")) railMenu.value = null;
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (railMenu.value = null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, [m]);
  if (!m) return null;
  const i = order.indexOf(m.id);
  const custom = !isDefaultOrder(order, RAIL_DEFAULT);
  const act = (fn: () => void) => () => {
    fn();
    railMenu.value = null;
  };
  // portal: the rail's backdrop-filter would make it the containing block (and clip the menu)
  return createPortal(
    <div class="ctx glass rail-menu" style={{ left: `${m.x + 6}px`, top: `${Math.min(m.y, window.innerHeight - 150)}px` }}>
      <div class="ctx-title">{RAIL.find((r) => r.id === m.id)?.label}</div>
      <button disabled={i <= 0} onClick={act(() => move(m.id, -1))}>
        Move up
      </button>
      <button disabled={i >= order.length - 1} onClick={act(() => move(m.id, 1))}>
        Move down
      </button>
      <button disabled={!custom} onClick={act(() => saveOrder(RAIL_DEFAULT.slice()))}>
        Reset order
      </button>
      <div class="muted small rail-menu-hint">Drag buttons to rearrange · Alt+↑/↓</div>
    </div>,
    document.body,
  );
}
/* ---------- end 0.8.1 ---------- */

const TITLES: Record<string, string> = { forecast: "Forecast", radio: "Weather radio", search: "Search", record: "Recordings", files: "Files & backup", radar: "Radar", layers: "Layers", map: "Basemap", alerts: "Alerts", points: "My points", sources: "Data sources", settings: "Settings", workspaces: "Workspaces" /* workflow */, route: "Route weather", rules: "Notification rules", widgets: "Desktop widgets" /* workflow 0.6 */, placefiles: "Placefiles" /* radar 0.6 */ };

// share viewers: no owner-only panels (the server refuses their writes anyway)
const OWNER_ONLY = new Set(["settings", "record", "files", "workspaces", "rules", "widgets", "placefiles"]);

export function SidePanel() {
  const p = openPanel.value;
  if (!p || (viewer.value && OWNER_ONLY.has(p))) return null;
  return (
    <aside class="side-panel glass">
      <div class="panel-head">
        <h2>{TITLES[p]}</h2>
        <button class="icon-btn" onClick={() => (openPanel.value = null)} title="Close">
          <X size={16} />
        </button>
      </div>
      <div class="panel-body">
        {p === "radar" && <RadarPanel />}
        {p === "layers" && <LayersPanel />}
        {p === "map" && <MapPanel />}
        {p === "forecast" && <ForecastPanel />}
        {p === "radio" && <RadioPanel />}
        {p === "search" && <SearchPanel />}
        {p === "record" && <RecordPanel />}
        {p === "files" && <FilesPanel />}
        {p === "alerts" && <AlertsPanel />}
        {p === "points" && <PointsPanel />}
        {p === "sources" && <SourcesPanel />}
        {p === "settings" && <SettingsPanel />}
        {p === "workspaces" && <WorkspacePanel /> /* workflow */}
        {p === "placefiles" && <PlacefilePanel /> /* radar 0.6 */}
        {p === "route" && <RoutePanel /> /* workflow 0.6 */}
        {p === "rules" && <RulesPanel /> /* workflow 0.6 */}
        {p === "widgets" && <WidgetsPanel /> /* workflow 0.6 */}
      </div>
    </aside>
  );
}
