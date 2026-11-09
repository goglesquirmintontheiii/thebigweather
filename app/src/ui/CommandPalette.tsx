// panes/palette/a11y 0.8: command palette (Ctrl+K / Cmd+K). Fuzzy search over every layer,
// weather layer, panel, setting, place (geocoder), radar site, saved point, workspace and command.
// Keyboard only: type, ↑/↓ to move, Enter to run, Tab / Shift+Tab to switch category, Esc to close.

import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { settings, update, openPanel, tool, crosshair, toast, type PanelId } from "../store";
import { api } from "../api";
import { mapRef } from "../map/mapview";
import { allLayers, isLayerOn, toggleLayer, shortcutsOpen } from "../keybinds";
import { gridLayers, GIBS, selectWeather } from "../weather";
import { intlSources, selectIntl } from "../intl/radar";
import { sites, selectSite, L2_MOMENTS } from "../radar/controller";
import { togglePlay, stepFrame } from "../anim";
import { locate, screenshot } from "./Toolbar";
import { toggleInspector } from "./Inspector";
import { startXSection } from "./XSection";
import { histPicker, exitHistory, histRange } from "../history";
import { toggle3D } from "./View3D";
import { loopDialog } from "../loopexport";
import { enterKiosk } from "../kiosk";
import { runBriefing } from "../briefing";
import { shareDialog } from "../share/share";
import { teamOpen } from "../share/collab";
import { trackPanel } from "../gps";
import { applyWorkspace } from "../workspaces";
import { forecastOpen } from "./ForecastCenter";
import { radioOpen } from "./RadioCenter";
import { spaceOpen } from "./SpacePanel";
import { shakeOpen } from "../shake";
import { histStormsOpen } from "../histsearch";
import { mlOpen } from "../ml/client";
import { dashOpen } from "./Dashboard"; // 0.8.2 integration
import { timelineOpen } from "./AlertTimeline"; // 0.8.2 integration: no rail button any more (Alerts → Timelines)
import { winAware } from "./winframe"; // 0.8.2 integration: minimized → restore, popped out → focus
import { BUILTIN_LAYOUTS, openPaneWindow, defaultCfg, layoutName } from "./Panes";
import { jumpToSetting } from "../a11y/jump";
import { serverSettingsOpen } from "./ServerSettings"; // 0.8.4
import { configModal } from "./OverlayList"; // integration 0.8.3
import { A11Y_DEFAULTS, a11y } from "../a11y/a11y";
import { Search, CornerDownLeft, Command, Layers, CloudSun, PanelLeft, Settings as Cog, MapPin, Radar, Navigation, History, X, Puzzle } from "lucide-preact";
/* 0.8.3: every catalog product + plugins */
import { weatherEntries, pluginEntries, scoreEntry, type WxAct, type PlgAct } from "./paletteCore";
import { l3Products, currentSite } from "../radar/controller";
import { gridComposites } from "../weather";
import { groupOf, allIdOf, groupName, loadIntlList } from "../intl/radar";
import { noLevel3 } from "../intl/sites";
import { applyComposite } from "./LayerPicker";
import { pluginPanels, pluginLayers, pluginCommands, pluginSettings, pluginStatus, closedPanels, showPluginPanel, togglePluginLayer, runPluginCommand, setPluginSetting } from "../plugins/host";
import { market, installedMeta, loadInstalledMeta, refreshMarket, setEnabled } from "../plugins/market";
import { pluginDetail, pluginsTab } from "../plugins/PluginsPanel";
import { PanelsTopLeft } from "lucide-preact"; // 0.8.3: Workspaces icon

export const paletteOpen = signal(false);
const paletteQuery = signal("");
export function openPalette(q = "") {
  paletteQuery.value = q;
  paletteOpen.value = true;
}

type Cat = "command" | "layer" | "weather" | "panel" | "setting" | "place" | "site" | "point" | "workspace" | "plugin" /* 0.8.3 */;
const CATS: { id: Cat | "all"; name: string; icon: any }[] = [
  { id: "all", name: "All", icon: Search },
  { id: "command", name: "Commands", icon: Command },
  { id: "layer", name: "Layers", icon: Layers },
  { id: "weather", name: "Weather", icon: CloudSun },
  { id: "panel", name: "Panels", icon: PanelLeft },
  { id: "setting", name: "Settings", icon: Cog },
  { id: "place", name: "Places", icon: Navigation },
  { id: "site", name: "Radars", icon: Radar },
  { id: "point", name: "My points", icon: MapPin },
  { id: "workspace", name: "Workspaces", icon: PanelsTopLeft /* 0.8.3 */ },
  { id: "plugin", name: "Plugins", icon: Puzzle }, // 0.8.3
];
const CAT_NAME = Object.fromEntries(CATS.map((c) => [c.id, c.name])) as Record<string, string>;

interface PItem {
  id: string;
  cat: Cat;
  label: string;
  /** shown on the right / in the footer: what Enter will do */
  hint?: string;
  kw?: string;
  on?: boolean;
  key?: string;
  run: () => void;
}

/* ---------- fuzzy match: 0.8.3 moved to paletteCore.ts (scoreEntry) ---------- */

/* ---------- recents ---------- */
const RKEY = "tbw.palette.recent";
function recents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RKEY) ?? "[]");
  } catch {
    return [];
  }
}
function remember(id: string) {
  if (id.startsWith("place:")) return;
  try {
    localStorage.setItem(RKEY, JSON.stringify([id, ...recents().filter((x) => x !== id)].slice(0, 8)));
  } catch {
    /* ignore */
  }
}

const fly = (lon: number, lat: number, zoom = 8) => mapRef.value?.flyTo({ center: [lon, lat], zoom: Math.max(mapRef.value.getZoom(), zoom) });
const panel = (id: Exclude<PanelId, null>) => winAware(`p:${id}`, () => (openPanel.value = id)); // 0.8.2 integration: winAware
const win = (wid: string, sig: { value: boolean }) => winAware(wid, () => (sig.value = true)); // 0.8.2 integration

/* ---------- settings index (label must match the control's label for jumping) ---------- */
type SetDef = { label: string; section: string; kw?: string; get?: () => boolean; set?: (v: boolean) => void };
const a11ySet = (k: keyof typeof A11Y_DEFAULTS) => (v: any) => update((x) => (x.a11y = { ...A11Y_DEFAULTS, ...(x.a11y ?? {}), [k]: v }));
function settingDefs(): SetDef[] {
  const s = settings.value;
  return [
    { label: "Servers", section: "Servers", kw: "connect url token" },
    { label: "Desktop", section: "Desktop", kw: "tray autostart startup" },
    { label: "Appearance", section: "Appearance", kw: "theme light dark look" },
    { label: "Accent", section: "Appearance", kw: "colour color" },
    { label: "UI scale", section: "Appearance", kw: "zoom size" },
    { label: "Panel opacity", section: "Appearance", kw: "transparency glass" },
    { label: "Terrain hillshade", section: "Appearance" },
    { label: "3D terrain (tilt with right-drag)", section: "Appearance" },
    { label: "Wall / kiosk mode", section: "Kiosk" },
    { label: "Offline maps", section: "Offline", kw: "tiles cache" },
    { label: "Data use", section: "Data use" },
    { label: "Bandwidth saver", section: "Data use", get: () => !!s.saver, set: (v) => update((x) => (x.saver = v)) },
    { label: "Notify when a storm cell will reach my points", section: "Alerts & sound", kw: "eta", get: () => !!s.etaNotify, set: (v) => update((x) => (x.etaNotify = v)) },
    { label: "Units & time", section: "Units & time", kw: "miles km fahrenheit celsius" },
    { label: "Distance", section: "Units & time", kw: "units miles km nmi" },
    { label: "Temp", section: "Units & time", kw: "temperature units fahrenheit celsius" },
    { label: "Show times in UTC", section: "Units & time", kw: "zulu timezone", get: () => s.utc, set: (v) => update((x) => (x.utc = v)) },
    { label: "FPS counter", section: "Units & time", get: () => s.showFps, set: (v) => update((x) => (x.showFps = v)) },
    { label: "Colorblind-friendly tables", section: "Units & time", kw: "colour blind radar palette", get: () => s.colorblind, set: (v) => update((x) => (x.colorblind = v)) },
    { label: "Animation", section: "Animation", kw: "loop speed fps" },
    { label: "Last-frame pause", section: "Animation", kw: "dwell" },
    { label: "Alerts & sound", section: "Alerts & sound", kw: "notifications" },
    { label: "Notify for", section: "Alerts & sound" },
    { label: "Warnings only", section: "Alerts & sound", get: () => s.notify.warningsOnly, set: (v) => update((x) => (x.notify.warningsOnly = v)) },
    { label: "Desktop notifications", section: "Alerts & sound", get: () => s.notify.desktop, set: (v) => update((x) => (x.notify.desktop = v)) },
    { label: "Alert sounds", section: "Alerts & sound", get: () => s.audio.alerts, set: (v) => update((x) => (x.audio.alerts = v)) },
    { label: "Sound on new sweep", section: "Alerts & sound", get: () => s.audio.sweeps, set: (v) => update((x) => (x.audio.sweeps = v)) },
    { label: "Volume", section: "Alerts & sound" },
    { label: "API keys", section: "API keys" },
    /* integration 0.8.3: sections added this round (Settings categories) */
    { label: "Recording tools", section: "Connection", kw: "yt-dlp ytdlp deno youtube download install camera recording" },
    { label: "Performance", section: "Performance", kw: "gpu quality speed slow lag frame rate" },
    { label: "Updates", section: "App", kw: "update version upgrade download" },
    { label: "Pane layouts", section: "Pane layouts", kw: "custom grid editor" },
    // 0.8.3: MIDI is its own tab now (panel entry above)
    { label: "Accessibility", section: "Accessibility", kw: "a11y" },
    { label: "Colour vision", section: "Accessibility", kw: "colorblind deuteranopia protanopia tritanopia cvd" },
    { label: "Text size", section: "Accessibility", kw: "large font bigger" },
    { label: "High contrast", section: "Accessibility", get: () => a11y().contrast, set: a11ySet("contrast") },
    { label: "Reduce motion", section: "Accessibility", kw: "animation", get: () => a11y().reduceMotion, set: a11ySet("reduceMotion") },
    { label: "Always show focus rings", section: "Accessibility", kw: "keyboard", get: () => a11y().focusRings, set: a11ySet("focusRings") },
    { label: "Screen-reader announcements", section: "Accessibility", kw: "live region", get: () => a11y().announce, set: a11ySet("announce") },
    { label: "About", section: "About", kw: "version credits" },
  ];
}
const ANCHOR: Record<string, string> = { "Pane layouts": "pane-layouts", Accessibility: "a11y" };

/* ---------- 0.8.3: catalog + plugin entries ---------- */
function wxOn(a: WxAct): boolean {
  const s = settings.value;
  const w = s.weather;
  if (a.t === "radar") return w.kind === "radar" && s.radar.source === a.src && s.radar.product === a.product;
  if (a.t === "comp") return false;
  return w.kind === a.t && (w as any).id === a.id;
}
function runWx(a: WxAct) {
  if (a.t === "radar")
    return update((x) => {
      x.weather = { kind: "radar" };
      x.radar.source = a.src;
      x.radar.product = a.product;
    });
  if (a.t === "grid") return selectWeather({ kind: "grid", id: a.id });
  if (a.t === "gibs") return selectWeather({ kind: "gibs", id: a.id });
  if (a.t === "intl") return selectIntl(a.id);
  if (!applyComposite(a.id)) toast("That composite isn't available on this server", "warn");
}
function pluginItems() {
  const list = settings.value.wf6.plugins;
  const meta = installedMeta.value;
  const st = pluginStatus.value;
  const closed = closedPanels.value;
  return pluginEntries({
    plugins: list.map((p) => {
      const m = meta[p.id]?.manifest ?? market.value.items.find((it) => it.manifest && p.market?.pid === it.manifest.id)?.manifest;
      return { id: p.id, name: p.name, on: p.on, running: !!st[p.id]?.running, summary: m?.summary, tags: m?.tags, commands: m?.commands };
    }),
    market: market.value.items.filter((it) => it.manifest).map((it) => ({ key: it.key, id: it.manifest!.id, name: it.manifest!.name, summary: it.manifest!.summary, tags: it.manifest!.tags })),
    panels: pluginPanels.value.map((p) => ({ pid: p.pid, id: p.id, title: p.title, kw: p.kw, open: !closed.has(p.id) })),
    layers: pluginLayers.value.map((l) => ({ pid: l.pid, id: l.id, title: l.title, kw: l.kw, visible: l.visible })),
    commands: pluginCommands.value,
    settings: pluginSettings.value.map((x) => {
      let value: any;
      try {
        value = x.get();
      } catch {
        value = undefined;
      }
      return { pid: x.pid, id: x.id, title: x.title, kw: x.kw, options: x.options, value };
    }),
  });
}
function showPluginDetail(d: { id?: string; key?: string }) {
  pluginsTab.value = d.id ? "installed" : "market";
  openPanel.value = "plugins";
  pluginDetail.value = d;
}
function runPlg(a: PlgAct) {
  const name = () => settings.peek().wf6.plugins.find((p) => p.id === (a as any).pid)?.name ?? "Plugin";
  switch (a.t) {
    case "open":
      return showPluginDetail({ id: a.pid });
    case "market":
      return showPluginDetail({ key: a.key });
    case "toggle":
      setEnabled(a.pid, a.on);
      return toast(`${name()} ${a.on ? "enabled" : "disabled"}`, "info", 1500);
    case "panel":
      return winAware(`f:plg:${a.id}`, () => showPluginPanel(a.id))(); // minimized → restore
    case "layer":
      return togglePluginLayer(a.pid, a.id);
    case "cmd":
      return void runPluginCommand(a.pid, a.id).catch((e) => toast(`${name()}: ${e.message}`, "error"));
    case "set":
      return setPluginSetting(a.pid, a.id, a.value);
  }
}

/** 0.8.2: exported for MIDI mappings (midi/), which reuse these commands */
export type { PItem, Cat };
export function buildItems(): PItem[] {
  const s = settings.value;
  const out: PItem[] = [];
  const cmd = (id: string, label: string, run: () => void, hint?: string, kw?: string, on?: boolean, key?: string) => out.push({ id: `cmd:${id}`, cat: "command", label, run, hint, kw, on, key });
  // commands
  cmd("play", "Play / pause loop", togglePlay, undefined, "animate", undefined, "Space");
  cmd("prev", "Previous frame", () => stepFrame(-1), undefined, "step back", undefined, "←");
  cmd("next", "Next frame", () => stepFrame(1), undefined, "step forward", undefined, "→");
  cmd("locate", "My location", locate, "Fly to where you are", "gps here", undefined, "L");
  cmd("shot", "Screenshot", screenshot, "Save a PNG of the window", "capture image", undefined, "S");
  cmd("measure", "Measure distance", () => (tool.value = tool.value === "measure" ? "none" : "measure"), undefined, "ruler", tool.value === "measure", "M");
  cmd("draw", "Drawing mode", () => (tool.value = tool.value === "draw" ? "none" : "draw"), undefined, "pen annotate", tool.value === "draw", "D");
  cmd("bearing", "Distance & direction from radar", () => (tool.value = tool.value === "bearing" ? "none" : "bearing"), undefined, "bearing azimuth", tool.value === "bearing", "B");
  /* 0.8.2: renamed (were "Center crosshair value" / "Value under mouse"; old names kept as keywords) */
  cmd("cross", "Crosshair", () => (crosshair.value = !crosshair.value), undefined, "center crosshair value centre", crosshair.value, "C");
  cmd("cursor", "Data inspector", () => update((x) => (x.ui.cursorValue = !x.ui.cursorValue)), undefined, "readout value under mouse cursor", s.ui.cursorValue, "V");
  cmd("insp", "Inspector (all moments)", toggleInspector, undefined, "radar readout", !!s.radar6?.inspector, "I");
  cmd("xs", "Cross-section (Level II)", startXSection, "Click two points on the map", "vertical slice rhi");
  cmd("hist", histRange.value ? "Back to live (exit history mode)" : "History mode: pick a past time", () => (histRange.value ? exitHistory() : (histPicker.value = true)), undefined, "archive past replay historical");
  cmd("histstorms", "Historical storms", () => (histStormsOpen.value = true), undefined, "past events tornado outbreak");
  cmd("3d", s.view3d.on ? "Exit 3D view" : "3D view", toggle3D, "Only for layers with 3D data", "volume three", s.view3d.on, "Shift+3");
  cmd("loop", "Export loop (GIF / MP4)", () => (loopDialog.value = true), undefined, "animation video gif mp4 record");
  cmd("track", "GPS track & chasers", () => (trackPanel.value = !trackPanel.value), undefined, "chase");
  cmd("brief", "Briefing (spoken summary)", () => runBriefing(), undefined, "speak read");
  cmd("kiosk", "Wall / kiosk mode", enterKiosk, undefined, "fullscreen tv");
  cmd("share", "Share live view", () => (shareDialog.value = true), undefined, "link");
  cmd("team", "Team (live collaboration)", () => (teamOpen.value = true), undefined, "collab");
  cmd("keys", "Keyboard shortcuts", () => (shortcutsOpen.value = true), undefined, "hotkeys help", undefined, "?");
  cmd("sites", "Radar sites on the map", () => update((x) => (x.overlays.sites = !x.overlays.sites)), undefined, undefined, s.overlays.sites, "R");
  for (const l of BUILTIN_LAYOUTS) cmd(`layout:${l.id}`, `Panes: ${l.name}`, () => update((x) => (x.panes.layout = l.id)), undefined, "layout split dual quad multi", s.panes.layout === l.id);
  for (const m of ["v", "h", "d"] as const) cmd(`swipe:${m}`, `Panes: swipe compare (${m === "v" ? "vertical" : m === "h" ? "horizontal" : "diagonal"})`, () => update((x) => ((x.panes.layout = "swipe"), (x.panes.swipeMode = m))), undefined, "compare divider", s.panes.layout === "swipe" && (s.panes.swipeMode ?? "v") === m);
  for (const l of s.paneLayouts ?? []) cmd(`layout:custom:${l.id}`, `Panes: ${l.name}`, () => update((x) => (x.panes.layout = `custom:${l.id}`)), "My layout", "layout custom", s.panes.layout === `custom:${l.id}`);
  cmd("panewin", "New pane window", () => openPaneWindow(defaultCfg(1), { pos: true, time: true, layers: true }), "A window with just a map and product selector, linked to this one", "popout pop-out second monitor");
  cmd("linkall", "Panes: link all (position, time, layers)", () => update((x) => ((x.panes.sync = true), (x.panes.links = {}))), `Layout: ${layoutName(s.panes.layout)}`, "sync");
  cmd("plugins", "Plugins", panel("plugins"), "Installed plugins and the marketplace", "plugin marketplace extensions addons install"); // 0.8.2
  cmd("altr", "Alert translation options", () => (configModal.value = "base:alerts"), "Alerts → layer options → Translation", "translate russian language english alerts"); // integration 0.8.3
  cmd("saver", "Bandwidth saver", () => update((x) => (x.saver = !x.saver)), undefined, "data", !!s.saver);
  // layers (overlays + base layers)
  for (const l of allLayers()) out.push({ id: `layer:${l.id}`, cat: "layer", label: l.name, hint: l.group, kw: `${l.group} overlay`, on: isLayerOn(l.id), run: () => toggleLayer(l.id) });
  // weather layers — 0.8.3: generated from every catalog (Level II / III, grid catalog, GIBS + EUMETSAT imagery, world radars, composites)
  const tdwr = currentSite.value?.type === "TDWR";
  const wx = weatherEntries({
    site: s.radar.site,
    l2: L2_MOMENTS,
    l3: noLevel3(currentSite.value) ? [] : l3Products.value.filter((p) => !!p.tdwr === tdwr),
    grid: gridLayers.value,
    gibs: GIBS,
    intl: intlSources.value.map((x) => ({ id: x.id, name: x.name, region: x.region, country: x.country, allId: groupOf(x) ? allIdOf(x) : undefined, allName: groupOf(x) ? groupName(allIdOf(x)) : undefined })),
    composites: gridComposites.value.filter((c) => gridLayers.value.some((d) => d.id === c.fill)),
  });
  for (const e of wx) out.push({ id: e.id, cat: "weather", label: e.label, hint: e.hint, kw: e.kw, on: wxOn(e.act), run: () => runWx(e.act) });
  // plugins (0.8.3): each plugin, marketplace plugins, and the panels / layers / commands / settings they add
  for (const e of pluginItems()) out.push({ id: e.id, cat: e.cat, label: e.label, hint: e.hint, kw: e.kw, on: e.on, run: () => runPlg(e.act) });
  // panels
  const P: [string, string, () => void, string?][] = [
    ["radar", "Radar", panel("radar")],
    ["layers", "Layers", panel("layers"), "overlays"],
    ["map", "Basemap", panel("map"), "map style tiles"],
    ["alerts", "Alerts", panel("alerts"), "warnings watches"],
    ["points", "My points", panel("points"), "places saved"],
    ["sources", "Data sources", () => jumpToSetting("data-sources"), "status feeds enable disable"], // 0.8.4: a Settings category
    ["settings", "Settings", panel("settings"), "preferences options"],
    ["serversettings", "Server settings", win("c:ss", serverSettingsOpen), "local bundled memory cpu caches logs budgets"], // 0.8.4: was a Settings row (now a gear on the server card)
    ["search", "Search", panel("search"), "nearby find"],
    ["record", "Recordings", panel("record")],
    ["files", "Files & backup", panel("files"), "import export"],
    ["workspaces", "Workspaces", panel("workspaces")],
    ["midi", "MIDI", panel("midi"), "controller knob fader pad learn"], // 0.8.3: own tab
    ["route", "Route weather", panel("route"), "drive trip"],
    ["rules", "Notification rules", panel("rules")],
    ["widgets", "Desktop widgets", panel("widgets")],
    ["placefiles", "Placefiles", panel("placefiles"), "grlevelx"],
    ["forecast", "Forecast", () => (forecastOpen.value = true)],
    ["radio", "Weather radio", () => (radioOpen.value = true), "noaa nwr stream"],
    ["seismo", "Seismographs", () => (shakeOpen.value = true), "earthquake"],
    ["hist", "Historical Storms", () => (histStormsOpen.value = true)],
    ["ml", "Detection models", () => (mlOpen.value = true), "machine learning ai"],
    ["space", "Space weather", () => (spaceOpen.value = true), "aurora solar"],
    ["dash", "Dashboard", win("c:dash", dashOpen), "summary card widgets"], // 0.8.2 integration
    ["timeline", "Alert timeline", win("c:atl", timelineOpen), "alerts gantt timelines"], // 0.8.2 integration: was a rail button
  ];
  for (const [id, label, run, kw] of P) out.push({ id: `panel:${id}`, cat: "panel", label, run, kw, hint: "Open panel" });
  // settings
  for (const d of settingDefs()) {
    const toggle = d.get && d.set;
    out.push({
      id: `set:${d.label}`,
      cat: "setting",
      label: d.label,
      hint: toggle ? `${d.section} · toggle` : `Settings → ${d.section}`,
      kw: `${d.section} ${d.kw ?? ""}`,
      on: d.get?.(),
      run: toggle ? () => (d.set!(!d.get!()), toast(`${d.label}: ${!d.get!() ? "off" : "on"}`, "info", 1400)) : () => jumpToSetting(ANCHOR[d.label] ?? d.label),
    });
  }
  // radar sites (NEXRAD, TDWR, ODIM / international)
  for (const st of sites.value as any[])
    out.push({ id: `site:${st.id}`, cat: "site", label: `${st.id} · ${st.name}`, hint: `${st.type}${st.country ? ` · ${st.country}` : st.state ? ` · ${st.state}` : ""}`, kw: `${st.state ?? ""} ${st.country ?? ""} ${st.type}`, on: s.radar.site === st.id, run: () => (selectSite(st.id), fly(st.lon, st.lat, 7)) });
  for (const p of s.points) out.push({ id: `point:${p.id}`, cat: "point", label: p.name, hint: `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`, kw: "saved home", run: () => fly(p.lon, p.lat, 9) });
  for (const w of s.workspaces ?? []) out.push({ id: `ws:${w.id}`, cat: "workspace", label: w.name, hint: `Workspace · saved ${new Date(w.saved).toLocaleDateString()}`, run: () => applyWorkspace(w.id) });
  return out;
}

export function CommandPalette() {
  if (!paletteOpen.value) return null;
  return <Palette />;
}

function Palette() {
  const [q, setQ] = useState(paletteQuery.peek());
  const [cat, setCat] = useState<Cat | "all">("all");
  const [sel, setSel] = useState(0);
  const [places, setPlaces] = useState<{ q: string; list: PItem[]; busy: boolean }>({ q: "", list: [], busy: false });
  const inRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const all = useMemo(buildItems, [settings.value, gridLayers.value, sites.value, intlSources.value, l3Products.value, gridComposites.value, market.value, installedMeta.value, pluginPanels.value, pluginLayers.value, pluginCommands.value, pluginSettings.value, closedPanels.value, pluginStatus.value]);
  useEffect(() => {
    // 0.8.3: make sure lazily loaded lists are searchable (world radars, installed plugin manifests, marketplace once)
    loadIntlList().catch(() => {});
    if (settings.peek().wf6.plugins.some((p) => p.market) && !Object.keys(installedMeta.peek()).length) loadInstalledMeta().catch(() => {});
    inRef.current?.focus();
    return () => back.current?.isConnected && back.current.focus({ preventScroll: true });
  }, []);
  // 0.8.3: marketplace plugins become searchable once the user searches (one registry download per session)
  useEffect(() => {
    if ((cat === "plugin" || q.trim().length >= 3) && !market.peek().at && !market.peek().loading) refreshMarket().catch(() => {});
  }, [q.trim().length >= 3, cat]);
  // places: geocode after a pause
  useEffect(() => {
    const t = q.trim();
    if (t.length < 3 || !(cat === "all" || cat === "place")) return;
    setPlaces((p) => ({ ...p, busy: true }));
    const h = setTimeout(async () => {
      try {
        const r = await api.get(`/api/ovl/geocode?q=${encodeURIComponent(t)}`);
        const list: PItem[] = (r.results ?? []).slice(0, 6).map((x: any, i: number) => ({ id: `place:${i}:${x.lat},${x.lon}`, cat: "place" as Cat, label: x.label ?? x.name, hint: `Fly to ${(+x.lat).toFixed(2)}, ${(+x.lon).toFixed(2)}`, run: () => fly(+x.lon, +x.lat, 9) }));
        setPlaces({ q: t, list, busy: false });
      } catch {
        setPlaces({ q: t, list: [], busy: false });
      }
    }, 280);
    return () => clearTimeout(h);
  }, [q, cat]);
  const close = () => (paletteOpen.value = false);
  // Esc closes even when focus has left the search box
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !paletteOpen.value) return;
      const t = e.target as HTMLElement;
      if (t && t.closest && t.closest(".cp8-back input")) return; // the input's own handler runs
      e.preventDefault();
      paletteOpen.value = false;
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  const query = q.trim().toLowerCase();
  const rec = recents();
  const results: { it: PItem; score: number }[] = useMemo(() => {
    const pool = [...all, ...(query.length >= 3 && places.q === q.trim() ? places.list : [])].filter((it) => cat === "all" || it.cat === cat);
    if (!query) {
      const byId = new Map(pool.map((x) => [x.id, x]));
      const r = rec.map((id) => byId.get(id)).filter(Boolean) as PItem[];
      const rest = pool.filter((x) => !rec.includes(x.id) && (cat !== "all" || x.cat === "command"));
      return [...r.map((it) => ({ it, score: 1e6 })), ...rest.slice(0, cat === "all" ? 14 : 80).map((it) => ({ it, score: 0 }))];
    }
    const out: { it: PItem; score: number }[] = [];
    for (const it of pool) {
      if (it.cat === "place") {
        out.push({ it, score: 40 });
        continue;
      }
      let sc = scoreEntry(query, it, CAT_NAME[it.cat]); // 0.8.3: label + keywords + hint
      if (sc < 0) continue;
      if (rec.includes(it.id)) sc += 25;
      if (it.cat === "command" || it.cat === "panel") sc += 6;
      out.push({ it, score: sc });
    }
    out.sort((a, b) => b.score - a.score);
    if (cat !== "all") return out.slice(0, 80);
    // "All": grouped by category (best category first), a few per category
    const best = new Map<Cat, number>();
    const per = new Map<Cat, number>();
    const kept: typeof out = [];
    for (const r of out) {
      if (!best.has(r.it.cat)) best.set(r.it.cat, r.score);
      const n = per.get(r.it.cat) ?? 0;
      if (n >= 6) continue;
      per.set(r.it.cat, n + 1);
      kept.push(r);
    }
    kept.sort((a, b) => best.get(b.it.cat)! - best.get(a.it.cat)! || b.score - a.score);
    return kept;
  }, [all, query, cat, places]);
  useEffect(() => setSel(0), [query, cat]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const run = (it: PItem | undefined) => {
    if (!it) return;
    remember(it.id);
    close();
    setTimeout(() => {
      try {
        it.run();
      } catch (e: any) {
        toast(e.message ?? String(e), "error");
      }
    }, 0);
  };
  const cycle = (d: number) => {
    const i = CATS.findIndex((c) => c.id === cat);
    setCat(CATS[(i + d + CATS.length) % CATS.length].id);
  };
  const onKey = (e: KeyboardEvent) => {
    const n = results.length;
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((sel + 1) % Math.max(1, n)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSel((sel - 1 + n) % Math.max(1, n)));
    else if (e.key === "PageDown") (e.preventDefault(), setSel(Math.min(n - 1, sel + 8)));
    else if (e.key === "PageUp") (e.preventDefault(), setSel(Math.max(0, sel - 8)));
    else if (e.key === "Enter") (e.preventDefault(), run(results[sel]?.it));
    else if (e.key === "Tab") (e.preventDefault(), cycle(e.shiftKey ? -1 : 1));
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), q ? setQ("") : close());
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") (e.preventDefault(), close());
  };
  const cur = results[sel]?.it;
  let lastCat = "";
  const recentMode = !query;
  return (
    <div class="cp8-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="cp8 glass" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="cp8-top">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inRef}
            class="cp8-in"
            value={q}
            placeholder="Search layers, places, radars, settings, commands…"
            role="combobox"
            aria-expanded="true"
            aria-controls="cp8-list"
            aria-activedescendant={cur ? `cp8-o${sel}` : undefined}
            aria-autocomplete="list"
            aria-label="Command palette search"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={onKey as any}
          />
          <button class="icon-btn" title="Close (Esc)" aria-label="Close command palette" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div class="cp8-cats" role="tablist" aria-label="Categories (Tab / Shift+Tab)">
          {CATS.map((c) => (
            <button key={c.id} role="tab" aria-selected={cat === c.id} tabIndex={-1} class={`cp8-cat ${cat === c.id ? "on" : ""}`} onClick={() => (setCat(c.id), inRef.current?.focus())}>
              <c.icon size={12} aria-hidden="true" />
              {c.name}
            </button>
          ))}
        </div>
        <div class="cp8-list" id="cp8-list" role="listbox" ref={listRef} aria-label="Results">
          {results.map(({ it, score }, i) => {
            const head = recentMode ? (score >= 1e6 ? "Recent" : cat === "all" ? "Suggested" : CAT_NAME[cat]) : cat === "all" ? CAT_NAME[it.cat] : "";
            const showHead = head && head !== lastCat;
            lastCat = head;
            const Icon = CATS.find((c) => c.id === it.cat)?.icon ?? Command;
            return (
              <Fragment key={it.id}>
                {showHead && (
                  <div class="cp8-h" role="presentation" key={`h${i}`}>
                    {head === "Recent" ? <History size={11} /> : null} {head}
                  </div>
                )}
                <div id={`cp8-o${i}`} data-i={i} role="option" aria-selected={i === sel} class={`cp8-it ${i === sel ? "sel" : ""}`} onPointerMove={() => i !== sel && setSel(i)} onClick={() => run(it)}>
                  <Icon size={14} class="cp8-ic" aria-hidden="true" />
                  <span class="cp8-l">{it.label}</span>
                  {it.on !== undefined && <span class={`cp8-st ${it.on ? "on" : ""}`}>{it.on ? "on" : "off"}</span>}
                  {it.key && <kbd>{it.key}</kbd>}
                  <span class="cp8-hint">{it.hint ?? CAT_NAME[it.cat]}</span>
                </div>
              </Fragment>
            );
          })}
          {!results.length && <div class="cp8-empty">{places.busy ? "Searching places…" : "No matches"}</div>}
          {places.busy && results.length > 0 && <div class="cp8-empty small">Searching places…</div>}
        </div>
        <div class="cp8-foot" aria-live="polite">
          {cur ? (
            <>
              <CornerDownLeft size={12} aria-hidden="true" />
              <span>{previewOf(cur)}</span>
            </>
          ) : (
            <span>Type to search</span>
          )}
          <span class="cp8-keys">↑↓ move · Enter run · Tab category · Esc close</span>
        </div>
      </div>
    </div>
  );
}

function previewOf(it: PItem): string {
  switch (it.cat) {
    case "layer":
      return `${it.on ? "Turn off" : "Turn on"} ${it.label}`;
    case "weather":
      return `Show ${it.label} as the weather layer`;
    case "panel":
      return `Open ${it.label}`;
    case "setting":
      return it.on !== undefined ? `${it.on ? "Turn off" : "Turn on"} “${it.label}”` : `Go to Settings → ${it.label}`;
    case "place":
      return `${it.label} · ${it.hint}`;
    case "site":
      return `Show radar ${it.label} and fly there`;
    case "point":
      return `Fly to ${it.label}`;
    case "workspace":
      return `Load workspace “${it.label}”`;
    case "plugin": // 0.8.3
      return it.hint?.startsWith("Marketplace") ? `${it.label} · see details and install` : it.label.startsWith("Enable ") || it.label.startsWith("Disable ") ? it.label : `Show ${it.label} in Plugins`;
    default:
      return it.hint ? `${it.label} · ${it.hint}` : it.label;
  }
}
