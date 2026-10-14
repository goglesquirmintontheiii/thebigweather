// App settings + UI state (Preact signals), persisted to localStorage.

import { signal, effect, computed } from "@preact/signals";

export interface ServerEntry {
  id: string;
  name: string;
  url: string;
  token: string;
}

export interface SavedPoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  color: string;
  notify: boolean;
}

export type Basemap = "dark" | "light" | "road" | "darkroad" | "terrain" | "satellite" | "google" | "offline" | `custom:${string}`;

/** A user-supplied raster tile source ({s} subdomains, {x} {y} {z}). */
export interface CustomBasemap {
  id: string;
  name: string;
  url: string;
  subdomains: string;
  minzoom: number;
  maxzoom: number;
  dark: boolean;
  /** draw CARTO place names on top */
  labels?: boolean;
}

/** Per-overlay state: on/off, style overrides and overlay-specific options. */
export interface OvlSettings {
  on?: boolean;
  color?: string;
  opacity?: number;
  size?: number;
  labels?: boolean;
  opts?: Record<string, string>;
  /** hide below this zoom */
  minzoom?: number;
  /** seconds between refreshes (overrides the overlay default) */
  refresh?: number;
  /** draw above the radar/weather layer instead of below */
  top?: boolean;
  /** starred in the Layers menu (0.6) */
  fav?: boolean;
}

/** A camera or stream the user placed on the map (YouTube, HLS, image or web page). */
export interface MyCam {
  id: string;
  name: string;
  lat: number;
  lon: number;
  url: string;
  /** link this stream to a ship (name or MMSI) instead of a map position */
  ship?: string;
  /** 360°/panoramic camera (workflow: map badge) */
  pano?: boolean;
}

export interface AlertTypeCfg {
  color?: string;
  border?: string;
  width?: number;
  line?: "solid" | "dashed" | "dotted";
  fill?: "solid" | "stripes" | "checker" | "none";
  fillOpacity?: number;
  sound?: "off" | "chime" | "beep" | "alarm" | "siren";
  /** seconds a new alert of this type flashes (0 = no flashing) */
  flash?: number;
}
export interface AlertCfg {
  /** play per-type sounds for every new alert, or only ones covering a saved point */
  soundScope?: "all" | "points";
  /** saved point ids left out of "My points only" sounds (new points are included) */
  soundSkip?: string[];
  hiddenCats: string[];
  hidden: string[];
  cats: Record<string, AlertTypeCfg>;
  types: Record<string, AlertTypeCfg>;
}

/** An extra map pane (multi-pane view). */
export interface PaneCfg {
  weather: WeatherSel;
  /** radar settings for this pane (radar layers) */
  site?: string;
  source?: "L2" | "L3";
  product?: string;
  tilt?: number;
}

/** The single visible weather layer. */
export type WeatherSel =
  | { kind: "radar" }
  | { kind: "grid"; id: string; run?: string; storm?: string; /* data 0.8: ensemble probability threshold (server units) */ thr?: number }
  | { kind: "gibs"; id: string }
  /** intl & forecast tools: international raster radar (see intl/radar.ts) */
  | { kind: "intl"; id: string; precip?: "rain" | "snow" };
export type RadarSource = "L2" | "L3";

/* ---------- panes/palette/a11y 0.8 ---------- */
export type PaneLayoutId = "1" | "2" | "2v" | "3" | "3c" | "4" | "swipe" | `custom:${string}`;
/** a grid layout: cells[0] is the main map, the rest are extra panes in order */
export interface PaneLayoutDef {
  id: string;
  name: string;
  rows: number;
  cols: number;
  cells: { r: number; c: number; rs: number; cs: number }[];
}
/** what an extra pane (or linked window) follows from the main map */
export interface PaneLink {
  pos: boolean;
  time: boolean;
  layers: boolean;
}
export interface A11ySettings {
  /** colour-vision-safe palettes (radar tables, alerts, overlays, legends, accents) */
  cvd: "off" | "deutan" | "protan" | "tritan";
  /** UI text scale (1 = normal … 1.5) */
  textScale: number;
  contrast: boolean;
  reduceMotion: boolean;
  /** always show focus rings (otherwise only when navigating with the keyboard) */
  focusRings: boolean;
  /** screen-reader announcements (new warnings, frame time when stepping) */
  announce: boolean;
}
/* ---------- end panes/palette/a11y 0.8 ---------- */

export interface Settings {
  servers: ServerEntry[];
  activeServer: string;
  basemap: Basemap;
  /** tile provider for Dark / Light / Road basemaps */
  basemapProvider: "openfreemap" | "carto";
  weather: WeatherSel;
  /** smooth: 0 = off, 0.5 = bilinear, 1 = heavy */
  grid: { frames: number; opacity: number; smooth: number; quality: number };
  /** extra radars shown alongside the main one (ctrl+click) */
  extraSites: string[];
  showFps: boolean;
  version: number;
  ovl: Record<string, OvlSettings>;
  customBasemaps: CustomBasemap[];
  myCams: MyCam[];
  overlays: { alerts: boolean; sites: boolean; counties: boolean; states: boolean; points: boolean; rings: boolean; labels: boolean };
  radar: {
    site: string;
    source: RadarSource;
    product: string; // L2 moment (REF, VEL...) or L3 product id (N0B...)
    tiltAngle: number;
    frames: number;
    live: boolean;
    /** 0 = off, 0.5 = bilinear, 1 = heavy */
    smooth: number;
    opacity: number;
  };
  /** product/table id -> chosen table id */
  tables: Record<string, string>;
  /** custom .pal palettes: id -> pal text */
  customPals: Record<string, string>;
  colorblind: boolean;
  units: { distance: "km" | "mi" | "nmi"; speed: "m/s" | "kt" | "mph" | "km/h"; temp: "F" | "C"; precip: "in" | "mm" };
  utc: boolean;
  /** frames by count (radar.frames / grid.frames) or by time span (minutes) */
  anim: { fps: number; dwellMs: number; mode: "count" | "time"; minutes: number };
  /** weather alert display, sounds and flashing (see alertstyle.ts) */
  alertCfg: AlertCfg;
  ui: { cursorValue: boolean; legendTop: boolean; loadBars: boolean; /** camera viewer size (resized by the user) */ camSize?: [number, number] };
  radio: { volume: number; favorites: string[]; custom: { name: string; url: string }[] };
  forecast: { point: string };
  /** speak new warnings aloud */
  speak: boolean;
  /** extra map panes: layout and what each shows */
  panes: {
    layout: PaneLayoutId /* panes/palette/a11y 0.8: built-ins + "custom:<id>" */;
    sync: boolean;
    list: PaneCfg[];
    /* data 0.6: swipe divider position (0..1) */ swipeX?: number;
    /* panes/palette/a11y 0.8: divider point y (0..1), orientation, angle (deg, 0 = vertical line), per-pane links */
    swipeY?: number;
    swipeMode?: "v" | "h" | "d";
    swipeAngle?: number;
    links?: Record<string, PaneLink>;
  };
  /* panes/palette/a11y 0.8 */
  paneLayouts?: PaneLayoutDef[];
  a11y?: A11ySettings;
  /* end panes/palette/a11y 0.8 */
  /** keep drawings after leaving drawing mode */
  drawKeep: boolean;
  drawings: import("./map/draw").Drawing[];
  audio: { alerts: boolean; sweeps: boolean; volume: number };
  notify: { mode: "points" | "all" | "off"; warningsOnly: boolean; desktop: boolean };
  points: SavedPoint[];
  view: { center: [number, number]; zoom: number };
  panels: { stats: { open: boolean; x: number; y: number }; /* shake/stats/server 0.6 */ appstats?: { open: boolean; x: number; y: number } };
  /** 0.8.1: left-rail button order (ids; missing ids go to their default spot, Sidebar.tsx) */
  railOrder?: string[];
  /* shake/stats/server 0.6: Seismographs window (favourite stations as "NET.STA") */
  shake?: { favs: string[] };
  /* 3D volume view (ui/View3D.tsx) */
  view3d: { on: boolean; src: "radar" | "mrms"; thr: Record<string, number>; density: number; exag: number; res: "lo" | "hi"; floor: boolean; smooth: boolean; shade: boolean };
  /* legend, panes, keys: value filter per legend key (gate.ts) and layer shortcuts (keybinds.ts) */
  gates: Record<string, { lo?: number; hi?: number; abs?: boolean; off?: boolean }>;
  keybinds: Record<string, string>;
  /* ---------- workflow ---------- */
  workspaces: import("./workspaces").Workspace[];
  /** bandwidth-saver mode (saver.ts) */
  saver: boolean;
  theme: { accent: string; scale: number; panelOpacity: number };
  /** storm-relative velocity: dir = where the storm moves toward (deg), speed in m/s */
  srv: { on: boolean; mode: "manual" | "auto" | "cell"; dir: number; speed: number };
  /** notify when a storm cell's path reaches a saved point */
  etaNotify: boolean;
  /* ---------- end workflow ---------- */
  /* ---------- history 0.6 ---------- */
  /** history-mode playback (independent of the live loop's `anim`): frame step in minutes (0 = every
   * volume/frame), max frames, speed; before/after = minutes around an alert or storm to replay */
  hist: { step: number; maxFrames: number; fps: number; dwellMs: number; before: number; after: number };
  /** history ranges opened recently (Historical Storms → Recent) */
  histRecent: { label: string; kind: "range" | "warning" | "tropical"; start: number; end: number; site?: string; bbox?: [number, number, number, number]; at: number; ref?: string }[];
  /* ---------- end history 0.6 ---------- */
  /* ---------- workflow 0.6 ---------- */
  wf6: Wf6Settings;
  /* ---------- end workflow 0.6 ---------- */
  /* ---------- data 0.6: contours / barbs over gridded layers (grid/contours.ts) ---------- */
  data6?: Data6Settings;
  /* ---------- end data 0.6 ---------- */
  /* ---------- radar 0.6 ---------- */
  /** dealias = unfold velocity for display; inspector = every-moment readout at the cursor;
   * ltgWatch = poll GLM for strikes near saved points (chip in the toolbar) */
  radar6: { dealias: boolean; inspector: boolean; ltgWatch: boolean; ltgMi: number };
  /** GRLevelX placefiles (local files keep their text in localStorage "tbw.pf.<id>") */
  placefiles: PlacefileCfg[];
  /* ---------- detection models ---------- */
  /** where training / the runner go by default ("local" = the server bundled with the app) */
  ml?: {
    trainWhere?: "main" | "local";
    runWhere?: "main" | "local";
    /* models 0.7 */
    /** per-model run options, keyed "ep|id" */
    runOpts?: Record<string, Record<string, any>>;
    /** runner-wide: concurrency (radars scored at once) */
    concurrency?: number;
    /** Run-tab detections list follows the map's probability gate */
    listGate?: boolean;
    /* models 0.8 */
    /** detections legend expanded: one probability gate per model */
    perModelGates?: boolean;
    /** Models list: where the models live */
    loc?: "both" | "main" | "local";
    /** radars each model runs on, keyed "ep|id" */
    runRadars?: Record<string, any>;
    /* end models 0.8 */
  };
  /* ---------- end detection models ---------- */
  /* ---------- end radar 0.6 ---------- */
  /* ---------- data 0.8 ---------- */
  p8?: P8Settings;
  /* ---------- end data 0.8 ---------- */
}

/* ---------- data 0.8 ---------- */
export interface P8Settings {
  /** last ensemble threshold per ens layer id (server units) */
  thr?: Record<string, number>;
  /** radar QC: REF → REFQC with a CC threshold; bio = also remove biological echoes */
  qc?: boolean;
  cc?: number;
  /** REFQC / BIO reflectivity texture threshold, dB (server default 8) */
  texture?: number;
  bio?: boolean;
  /** beam blockage overlay for the current radar / tilt */
  blockage?: boolean;
  /** chaser toolkit */
  chase?: { snapMin: number; autoLog: boolean; safeZone: boolean; vectors: boolean; cell?: string };
}
/* ---------- end data 0.8 ---------- */

/* ---------- radar 0.6 ---------- */
export interface PlacefileCfg {
  id: string;
  name: string;
  /** http(s) URL, or "" for a local file */
  url: string;
  on: boolean;
  opacity: number;
  /** refresh override (seconds, 0 = the file's own) */
  refresh?: number;
}
/* ---------- end radar 0.6 ---------- */

/* ---------- data 0.6 ---------- */
export interface Data6Settings {
  contours: boolean;
  /** grid layer id to contour ("" = the layer on screen) */
  cfield: string;
  /** interval / base in display units (NaN/undefined = preset) */
  interval?: number;
  base?: number;
  ccolor: string;
  labels: boolean;
  barbs: boolean;
  blevel: "10m" | "850" | "500" | "250";
  bcolor: string;
  /** models compared in the forecast center */
  models?: string[];
}
export const DATA6_DEFAULTS: Data6Settings = { contours: false, cfield: "", ccolor: "#ffffff", labels: true, barbs: false, blevel: "10m", bcolor: "#e5e7eb" };
/* ---------- end data 0.6 ---------- */

/* ---------- workflow 0.6: widgets, route, rules, briefings, kiosk, look, offline maps, plugins ---------- */
export type WidgetKind = "radar" | "current" | "alerts" | "countdown" | "lightning" | "clock";
export interface WidgetCfg {
  id: string;
  kind: WidgetKind;
  /** saved point id ("" = first point / map centre) */
  point: string;
  opacity: number;
  onTop: boolean;
  /** click-through (unlock from the Widgets panel) */
  locked: boolean;
  open: boolean;
  /** mini radar: zoom level */
  zoom?: number;
}
export interface RuleCond {
  kind: "alert" | "rotation" | "lightning" | "eta" | "aqi" | "metar" | "spc" | "dbz" | "mldet" /* detection models */ | "same" /* data 0.8: SAME message from the server's radio monitor (server rules) */;
  /** where: saved point id, "gps" or "route" */
  where: string;
  /** distance (mi) */
  mi: number;
  /** alert: event name substring ("Tornado Warning", "Warning", …) */
  event?: string;
  /** rotation: "tvs" | "meso" (rank ≥ value) */
  rot?: "tvs" | "meso";
  /** generic threshold (dBZ, AQI, minutes, meso rank, °F, mph, SPC level 1-5) */
  value?: number;
  /** lightning: within the last N minutes */
  minutes?: number;
  /** metar: field */
  field?: "temp_hi" | "temp_lo" | "gust";
  /** detection models: model id ("" = any model); value = min probability (%) */
  model?: string;
  /** models 0.7: max probability (%) (with value = min: a window) */
  maxp?: number;
  /** models 0.7: also require the detection to pass the map's probability gate */
  useGate?: boolean;
  /* ---------- data 0.8: server rules ---------- */
  /** the point the server checks (copied from the saved point / GPS by the app; server rules need it) */
  at?: { lat: number; lon: number; label?: string };
  /** metar: "pws" = personal weather stations instead of METARs */
  source?: "metar" | "pws";
  /** same: 5-digit county FIPS codes ("SS000" = whole state); empty = anywhere */
  fips?: string[];
  /** same: radio monitor station id ("" = any) */
  station?: string;
}
export interface RuleAction {
  sound?: "off" | "chime" | "beep" | "alarm" | "siren";
  desktop?: boolean;
  tts?: string;
  flash?: boolean;
  webhook?: string;
  /** "ws:<id>" workspace, "ovl:<id>" overlay on */
  open?: string;
  /** data 0.8: server notification channels (ids from /api/notify/channels) */
  channels?: string[];
}
export interface Rule {
  id: string;
  name: string;
  on: boolean;
  cond: RuleCond;
  act: RuleAction;
  /** minutes */
  cooldown: number;
  /** data 0.8: who evaluates the rule (default "app") */
  run_on?: "app" | "server" | "both";
}
export interface OfflineRegion {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  minz: number;
  maxz: number;
  tiles: number;
  bytes: number;
  saved: number;
  /** tile URL templates downloaded (vector/raster) */
  templates: string[];
}
export interface PluginCfg {
  id: string;
  name: string;
  /** "file:<name>" | "url:<url>" | "paste" | "folder:<file>" */
  src: string;
  on: boolean;
}
export interface Wf6Settings {
  themeMode: "dark" | "light" | "auto";
  radarStyle: "classic" | "smooth";
  terrain: { on: boolean; hillshade: boolean; exag: number; tilt: boolean };
  precipFx: boolean;
  widgets: WidgetCfg[];
  routeUrl: string;
  rules: Rule[];
  quiet: { on: boolean; from: string; to: string };
  briefing: { voice: string; rate: number; times: string[]; point: string; /* radio/dash 0.8: TTS engine + offline voice */ engine?: "auto" | "system" | "offline"; offlineVoice?: string };
  kiosk: { workspaces: string[]; seconds: number; resume: number };
  offline: { regions: OfflineRegion[]; prefer: boolean };
  plugins: PluginCfg[];
}
export const WF6_DEFAULTS: Wf6Settings = {
  themeMode: "dark",
  radarStyle: "classic",
  terrain: { on: false, hillshade: true, exag: 1.5, tilt: false },
  precipFx: false,
  widgets: [],
  routeUrl: "",
  rules: [],
  quiet: { on: false, from: "22:00", to: "07:00" },
  briefing: { voice: "", rate: 1, times: [], point: "" },
  kiosk: { workspaces: [], seconds: 30, resume: 60 },
  offline: { regions: [], prefer: false },
  plugins: [],
};
/** widget windows (widget.html) are read-only views of the settings */
const WIDGET_PAGE = typeof location !== "undefined" && /widget\.html$/.test(location.pathname);
/* ---------- end workflow 0.6 ---------- */

const DEFAULTS: Settings = {
  servers: [],
  activeServer: "",
  basemap: "dark",
  basemapProvider: "openfreemap",
  weather: { kind: "radar" },
  grid: { frames: 12, opacity: 0.85, smooth: 0.5, quality: 1 },
  extraSites: [],
  showFps: true,
  version: 2,
  ovl: {},
  customBasemaps: [],
  myCams: [],
  overlays: { alerts: true, sites: true, counties: true, states: true, points: true, rings: false, labels: true },
  radar: { site: "KTLX", source: "L2", product: "REF", tiltAngle: 0.5, frames: 12, live: false, smooth: 0, opacity: 0.9 },
  tables: {},
  customPals: {},
  colorblind: false,
  units: { distance: "mi", speed: "mph", temp: "F", precip: "in" },
  utc: false,
  anim: { fps: 6, dwellMs: 1500, mode: "count", minutes: 60 },
  alertCfg: { hiddenCats: [], hidden: [], cats: {}, types: {} },
  ui: { cursorValue: false, legendTop: false, loadBars: true },
  drawKeep: false,
  drawings: [],
  radio: { volume: 0.8, favorites: [], custom: [] },
  forecast: { point: "center" },
  speak: false,
  panes: { layout: "1", sync: true, list: [] },
  audio: { alerts: true, sweeps: false, volume: 0.6 },
  notify: { mode: "points", warningsOnly: true, desktop: true },
  points: [],
  view: { center: [-97.3, 35.3], zoom: 6.4 },
  panels: { stats: { open: true, x: -1, y: 70 }, appstats: { open: false, x: -1, y: 300 } /* shake/stats/server 0.6 */ },
  shake: { favs: [] } /* shake/stats/server 0.6 */,
  /* 3D volume view */
  view3d: { on: false, src: "radar", thr: {}, density: 1, exag: 4, res: "lo", floor: false, smooth: true, shade: true },
  /* legend, panes, keys */
  gates: {},
  keybinds: {},
  /* ---------- workflow ---------- */
  workspaces: [],
  saver: false,
  theme: { accent: "#3fb7ff", scale: 1, panelOpacity: 0.9 },
  srv: { on: false, mode: "auto", dir: 60, speed: 15 },
  etaNotify: false,
  /* ---------- end workflow ---------- */
  hist: { step: 0, maxFrames: 200, fps: 8, dwellMs: 1000, before: 30, after: 30 }, // history 0.6
  histRecent: [], // history 0.6
  radar6: { dealias: false, inspector: false, ltgWatch: true, ltgMi: 10 }, // radar 0.6
  placefiles: [], // radar 0.6
  wf6: structuredClone(WF6_DEFAULTS), // workflow 0.6
};

const KEY = "tbw.settings.v1";

/** pop-out windows don't write settings back (they'd overwrite the main window's) */
const POPOUT = (typeof location !== "undefined" && location.hash.includes("popout=")) || WIDGET_PAGE; // workflow 0.6: widgets too

function popoutOverrides(out: any) {
  if (!POPOUT) return out;
  try {
    const spec = JSON.parse(decodeURIComponent(location.hash.match(/popout=([^&]+)/)![1]));
    if ((spec.kind === "map" || spec.kind === "pane") /* panes 0.8 */ && spec.data) for (const [k, v] of Object.entries(spec.data)) out[k] = v;
  } catch {
    /* ignore */
  }
  return out;
}

function load(): Settings {
  return popoutOverrides(load0());
}

function load0(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const v = JSON.parse(raw);
    // shallow-merge nested groups so new settings get defaults
    const out: any = structuredClone(DEFAULTS);
    for (const k of Object.keys(v)) {
      if (out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) && typeof v[k] === "object" && !Array.isArray(v[k])) out[k] = { ...out[k], ...v[k] };
      else out[k] = v[k];
    }
    // migrations
    if ((v.version ?? 1) < 2) {
      out.radar.live = false; // RapidSweep is now opt-in
      out.version = 2;
    }
    // smoothing became an amount
    if (typeof out.radar.smooth === "boolean") out.radar.smooth = out.radar.smooth ? 0.5 : 0;
    if (typeof out.grid.smooth === "boolean") out.grid.smooth = out.grid.smooth ? 0.5 : 0;
    out.anim.fps = Math.min(16, Math.max(0.25, out.anim.fps));
    return out;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const settings = signal<Settings>(load());

let saveTimer: number | undefined;
effect(() => {
  const v = settings.value;
  clearTimeout(saveTimer);
  if (POPOUT || /[?&]share=/.test(location.search)) return; // pop-outs and shared views (Phase 6) don't save
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* storage full or unavailable */
    }
  }, 250);
});

/** Immutable update helper: update(s => { s.radar.site = "KLOT" }) */
export function update(fn: (s: Settings) => void) {
  const next = structuredClone(settings.value);
  fn(next);
  settings.value = next;
}

export const activeServer = computed(() => settings.value.servers.find((s) => s.id === settings.value.activeServer) ?? settings.value.servers[0]);

// ---------- transient UI state ----------
export type PanelId = "layers" | "map" | "radar" | "alerts" | "points" | "sources" | "settings" | "radio" | "forecast" | "search" | "files" | "draw" | "record" | "workspaces" /* workflow */ | "route" | "rules" | "widgets" /* workflow 0.6 */ | "placefiles" /* radar 0.6 */ | null;
export const openPanel = signal<PanelId>("radar");
export const tool = signal<"none" | "measure" | "bearing" | "draw" | "xsect" /* workflow */>("none");
export const crosshair = signal(false);
export const connection = signal<"connecting" | "online" | "offline" | "unauthorized" | "none">("none");
/** Info panel: alerts and area features (watches, storms, MDs) under a click, most urgent first. */
export type DetailItem = { kind: "alert"; id: string } | { kind: "ovl"; overlay: string; p: any };
export const details = signal<{ items: DetailItem[]; i: number } | null>(null);
/** the alert shown in the info panel (setting it opens just that alert) */
export const selectedAlert = {
  get value(): string | null {
    const d = details.value;
    const it = d?.items[d.i];
    return it?.kind === "alert" ? it.id : null;
  },
  set value(id: string | null) {
    details.value = id ? { items: [{ kind: "alert", id }], i: 0 } : null;
  },
};
export const toasts = signal<{ id: number; text: string; kind: "info" | "warn" | "error" | "alert"; ttl: number }[]>([]);

let toastId = 0;
export function toast(text: string, kind: "info" | "warn" | "error" | "alert" = "info", ttl = 4000) {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind, ttl }].slice(-5);
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), ttl);
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}
