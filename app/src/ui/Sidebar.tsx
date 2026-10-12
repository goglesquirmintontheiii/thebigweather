import { openPanel, type PanelId, connection } from "../store";
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
  { id: "search", icon: Search, label: "Search" },
  { id: "record", icon: CircleDot, label: "Recordings" },
  { id: "files", icon: FolderOpen, label: "Files & backup" },
  { id: "workspaces", icon: Bookmark, label: "Workspaces" }, // workflow
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
      {MORE.map(({ id, icon: Icon, label }) => (
        <button key={id} class={`rail-btn ${openPanel.value === id || (id === "forecast" && forecastOpen.value) || (id === "radio" && radioOpen.value) ? "on" : ""}`} title={label} onClick={() => (id === "forecast" ? (forecastOpen.value = !forecastOpen.value) : id === "radio" ? (radioOpen.value = !radioOpen.value) : (openPanel.value = openPanel.value === id ? null : id))}>
          <Icon size={20} />
          {id === "radio" && (nowPlaying.value || players.value.length > 0) && <span class="dot online" />}
          {id === "record" && recs.value.some((r) => r.status === "recording") && <span class="dot rec" />}
        </button>
      ))}
      <div class="rail-fill" />
      <button class={`rail-btn ${openPanel.value === "settings" ? "on" : ""}`} title="Settings" onClick={() => (openPanel.value = openPanel.value === "settings" ? null : "settings")}>
        <Settings size={20} />
      </button>
    </nav>
  );
}

const TITLES: Record<string, string> = { forecast: "Forecast", radio: "Weather radio", search: "Search", record: "Recordings", files: "Files & backup", radar: "Radar", layers: "Layers", map: "Basemap", alerts: "Alerts", points: "My points", sources: "Data sources", settings: "Settings", workspaces: "Workspaces" /* workflow */ };

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
      </div>
    </aside>
  );
}
