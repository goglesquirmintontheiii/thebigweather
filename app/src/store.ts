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
}

/** Per-overlay state: on/off, style overrides and overlay-specific options. */
export interface OvlSettings {
  on?: boolean;
  color?: string;
  opacity?: number;
  size?: number;
  labels?: boolean;
  opts?: Record<string, string>;
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
}

/** The single visible weather layer. */
export type WeatherSel =
  | { kind: "radar" }
  | { kind: "grid"; id: string; run?: string; storm?: string }
  | { kind: "gibs"; id: string };
export type RadarSource = "L2" | "L3";

export interface Settings {
  servers: ServerEntry[];
  activeServer: string;
  basemap: Basemap;
  /** tile provider for Dark / Light / Road basemaps */
  basemapProvider: "openfreemap" | "carto";
  weather: WeatherSel;
  grid: { frames: number; opacity: number; smooth: boolean; quality: number };
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
    smooth: boolean;
    opacity: number;
  };
  /** product/table id -> chosen table id */
  tables: Record<string, string>;
  /** custom .pal palettes: id -> pal text */
  customPals: Record<string, string>;
  colorblind: boolean;
  units: { distance: "km" | "mi" | "nmi"; speed: "m/s" | "kt" | "mph" | "km/h"; temp: "F" | "C"; precip: "in" | "mm" };
  utc: boolean;
  anim: { fps: number; dwellMs: number };
  audio: { alerts: boolean; sweeps: boolean; volume: number };
  notify: { mode: "points" | "all" | "off"; warningsOnly: boolean; desktop: boolean };
  points: SavedPoint[];
  view: { center: [number, number]; zoom: number };
  panels: { stats: { open: boolean; x: number; y: number } };
}

const DEFAULTS: Settings = {
  servers: [],
  activeServer: "",
  basemap: "dark",
  basemapProvider: "openfreemap",
  weather: { kind: "radar" },
  grid: { frames: 12, opacity: 0.85, smooth: true, quality: 1 },
  extraSites: [],
  showFps: true,
  version: 2,
  ovl: {},
  customBasemaps: [],
  myCams: [],
  overlays: { alerts: true, sites: true, counties: true, states: true, points: true, rings: false, labels: true },
  radar: { site: "KTLX", source: "L2", product: "REF", tiltAngle: 0.5, frames: 12, live: false, smooth: false, opacity: 0.9 },
  tables: {},
  customPals: {},
  colorblind: false,
  units: { distance: "mi", speed: "mph", temp: "F", precip: "in" },
  utc: false,
  anim: { fps: 6, dwellMs: 1500 },
  audio: { alerts: true, sweeps: false, volume: 0.6 },
  notify: { mode: "points", warningsOnly: true, desktop: true },
  points: [],
  view: { center: [-97.3, 35.3], zoom: 6.4 },
  panels: { stats: { open: true, x: -1, y: 70 } },
};

const KEY = "tbw.settings.v1";

function load(): Settings {
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
export type PanelId = "layers" | "radar" | "alerts" | "points" | "sources" | "settings" | null;
export const openPanel = signal<PanelId>("radar");
export const tool = signal<"none" | "measure" | "bearing">("none");
export const crosshair = signal(false);
export const connection = signal<"connecting" | "online" | "offline" | "unauthorized" | "none">("none");
export const selectedAlert = signal<string | null>(null);
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
