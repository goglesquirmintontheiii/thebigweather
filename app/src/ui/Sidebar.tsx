import { openPanel, type PanelId, connection } from "../store";
import { alerts } from "../alerts";
import { Layers, Radar, TriangleAlert, MapPin, Activity, Settings, Radio, FolderOpen, CloudSun, Search, ArrowLeftRight, X, Map as MapIcon } from "lucide-preact";
import { MapPanel } from "./panels/MapPanel";
import { LayersPanel } from "./panels/LayersPanel";
import { RadarPanel } from "./panels/RadarPanel";
import { AlertsPanel } from "./panels/AlertsPanel";
import { PointsPanel } from "./panels/PointsPanel";
import { SourcesPanel } from "./panels/SourcesPanel";
import { SettingsPanel } from "./panels/SettingsPanel";

const ITEMS: { id: Exclude<PanelId, null>; icon: any; label: string }[] = [
  { id: "radar", icon: Radar, label: "Radar" },
  { id: "layers", icon: Layers, label: "Layers" },
  { id: "map", icon: MapIcon, label: "Basemap" },
  { id: "alerts", icon: TriangleAlert, label: "Alerts" },
  { id: "points", icon: MapPin, label: "My points" },
  { id: "sources", icon: Activity, label: "Data sources" },
];

const SOON = [
  { icon: Radio, label: "Weather radio", phase: 4 },
  { icon: CloudSun, label: "Forecast", phase: 4 },
  { icon: FolderOpen, label: "Map files", phase: 3 },
  { icon: Search, label: "Find on map", phase: 4 },
  { icon: ArrowLeftRight, label: "Import / export", phase: 4 },
];

export function Rail() {
  const nWarn = [...alerts.value.values()].filter((a) => String(a.properties.event).endsWith("Warning")).length;
  const conn = connection.value;
  return (
    <nav class="rail glass">
      {ITEMS.map(({ id, icon: Icon, label }) => (
        <button key={id} class={`rail-btn ${openPanel.value === id ? "on" : ""}`} title={label} onClick={() => (openPanel.value = openPanel.value === id ? null : id)}>
          <Icon size={20} />
          {id === "alerts" && nWarn > 0 && <span class="badge">{nWarn > 99 ? "99+" : nWarn}</span>}
          {id === "sources" && conn !== "online" && <span class={`dot ${conn}`} />}
        </button>
      ))}
      <div class="rail-sep" />
      {SOON.map(({ icon: Icon, label, phase }) => (
        <button key={label} class="rail-btn soon" title={`${label} — coming in phase ${phase}`} disabled>
          <Icon size={20} />
        </button>
      ))}
      <div class="rail-fill" />
      <button class={`rail-btn ${openPanel.value === "settings" ? "on" : ""}`} title="Settings" onClick={() => (openPanel.value = openPanel.value === "settings" ? null : "settings")}>
        <Settings size={20} />
      </button>
    </nav>
  );
}

const TITLES: Record<string, string> = { radar: "Radar", layers: "Layers", map: "Basemap", alerts: "Alerts", points: "My points", sources: "Data sources", settings: "Settings" };

export function SidePanel() {
  const p = openPanel.value;
  if (!p) return null;
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
        {p === "alerts" && <AlertsPanel />}
        {p === "points" && <PointsPanel />}
        {p === "sources" && <SourcesPanel />}
        {p === "settings" && <SettingsPanel />}
      </div>
    </aside>
  );
}
