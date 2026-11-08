// workflow 0.6: plugin / script API. Plugins are user JavaScript run in the app's renderer (trusted
// code — they can do anything the app can). Each gets its own `tbw` API object; everything it
// registers through the API (layers, panels, handlers) is removed when it is disabled. See
// docs/PLUGINS.md.

import { signal, effect } from "@preact/signals";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import type { Map as MLMap, LayerSpecification, SourceSpecification } from "maplibre-gl";
import { settings, update, toast as appToast, uid, type PluginCfg } from "../store";
import { api } from "../api";
import { mapRef } from "../map/mapview";
import { setGeo, removeGeo } from "../map/wf6map";
import { frameIndex } from "../anim";
import { alerts } from "../alerts";

export const API_VERSION = 1;

export interface PluginPanel {
  pid: string;
  id: string;
  title: string;
  kw?: string;
  render: (el: HTMLElement) => void | (() => void);
}
export const pluginPanels = signal<PluginPanel[]>([]);
/* ---------- 0.8.3 plugins: everything a plugin registers is listed (palette, rail) ---------- */
/** plugin panels the user closed (panel ids); opened again from the rail / palette */
export const closedPanels = signal<Set<string>>(new Set());
export const isPanelOpen = (id: string) => !closedPanels.value.has(id);
export function setPanelOpen(id: string, open: boolean) {
  const s = new Set(closedPanels.peek());
  if (open) s.delete(id);
  else s.add(id);
  closedPanels.value = s;
}
/** last panel asked to come forward */
export const panelRaise = signal<{ id: string; at: number } | null>(null);
/** open a plugin's panel (and bring it forward); with `toggle`, close it when it is open */
export function showPluginPanel(id: string, toggle = false) {
  if (toggle && !closedPanels.peek().has(id)) return setPanelOpen(id, false);
  setPanelOpen(id, true);
  panelRaise.value = { id, at: Date.now() };
}
export interface PluginRailButton {
  pid: string;
  id: string;
  title: string;
  /** image URL (plugin asset / data: URL); undefined: the plugin's icon or a puzzle piece */
  icon?: string;
  click: () => void;
  on?: () => boolean;
  /** the button of a panel (addPanel): lit while the panel is open */
  panel?: string;
}
export const pluginRail = signal<PluginRailButton[]>([]);
export interface PluginCommand {
  pid: string;
  id: string;
  title: string;
  kw?: string;
  run: () => void;
}
export const pluginCommands = signal<PluginCommand[]>([]);
export interface PluginSetting {
  pid: string;
  id: string;
  title: string;
  kw?: string;
  get: () => any;
  set: (v: any) => void;
  options?: { label: string; value: any }[];
}
export const pluginSettings = signal<PluginSetting[]>([]);
export interface PluginLayer {
  pid: string;
  id: string;
  title: string;
  kw?: string;
  visible: boolean;
  setVisible: (v: boolean) => void;
}
export const pluginLayers = signal<PluginLayer[]>([]);
/** runs a plugin command; a manifest command of a plugin that isn't running yet enables the plugin and waits for it */
export async function runPluginCommand(pid: string, id: string) {
  const find = () => pluginCommands.peek().find((c) => c.pid === pid && c.id === id);
  let c = find();
  if (!c) {
    if (settings.peek().wf6.plugins.some((p) => p.id === pid && !p.on)) update((s) => s.wf6.plugins.forEach((p) => p.id === pid && (p.on = true)));
    for (let i = 0; i < 40 && !(c = find()); i++) await new Promise((r) => setTimeout(r, 150));
  }
  if (!c) throw new Error("The plugin didn't register this command");
  c.run();
}
export function setPluginSetting(pid: string, id: string, value?: any) {
  const s = pluginSettings.peek().find((x) => x.pid === pid && x.id === id);
  if (!s) return;
  s.set(s.options ? value : !s.get());
  pluginSettings.value = [...pluginSettings.peek()]; // the palette shows the new value
}
export function togglePluginLayer(pid: string, id: string) {
  const l = pluginLayers.peek().find((x) => x.pid === pid && x.id === id);
  if (l) l.setVisible(!l.visible);
}
const unlist = <T>(sig: { value: T[]; peek(): T[] }, x: T) => () => void (sig.value = sig.peek().filter((y) => y !== x));
const nice = (id: string) => String(id).replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
/* ---------- end 0.8.3 ---------- */
export const pluginStatus = signal<Record<string, { running: boolean; error?: string }>>({});

interface Running {
  cleanups: (() => void)[];
  layers: string[];
  sources: string[];
}
const running = new Map<string, Running>();

const codeKey = (id: string) => `tbw.plugin.${id}`;
export const getCode = (id: string) => idbGet<string>(codeKey(id));
export const setCode = (id: string, code: string) => idbSet(codeKey(id), code);

function status(id: string, s: { running: boolean; error?: string }) {
  pluginStatus.value = { ...pluginStatus.value, [id]: s };
}

/** The API object handed to one plugin. */
function makeApi(cfg: PluginCfg, run: Running) {
  const map = (): MLMap => {
    const m = mapRef.value;
    if (!m) throw new Error("map not ready");
    return m;
  };
  const guard = <A extends any[]>(fn: (...a: A) => void) => (...a: A) => {
    try {
      fn(...a);
    } catch (e: any) {
      status(cfg.id, { running: true, error: String(e?.message ?? e) });
    }
  };
  // 0.8.3 plugins: rail buttons
  const railButton = (o: { title: string; icon?: string; onClick: () => void; active?: () => boolean }, panel?: string) => {
    const b: PluginRailButton = { pid: cfg.id, id: uid(), title: String(o.title), icon: typeof o.icon === "string" ? o.icon : undefined, click: guard(o.onClick), on: o.active, panel };
    pluginRail.value = [...pluginRail.peek(), b];
    return unlist(pluginRail, b);
  };
  return Object.freeze({
    version: API_VERSION,
    plugin: { id: cfg.id, name: cfg.name, version: cfg.market?.version, base: cfg.market?.base }, // 0.8.2: marketplace plugins know their folder URL
    /** 0.8.2: URL of a file in a marketplace plugin's folder (sounds, images …), or null */
    asset(rel: string) {
      return cfg.market ? new URL(String(rel).replace(/^\/+/, ""), cfg.market.base).href : null;
    },
    get map() {
      return map();
    },
    /** Add (or replace) a GeoJSON layer. style: { type?: "circle"|"line"|"fill"|"symbol", paint?, layout?, filter? } or a list of MapLibre layers (without source). */
    addGeoJSONLayer(id: string, data: any, style: any = {}, opts: { title?: string; keywords?: string } = {}) {
      const sid = `plg-${cfg.id}-${id}`;
      const specs: any[] = Array.isArray(style) ? style : [style];
      const layers = specs.map((s, i) => {
        const g = typeof data === "object" ? data?.features?.[0]?.geometry?.type ?? data?.geometry?.type ?? "" : "";
        const type = s.type ?? (/Polygon/.test(g) ? "fill" : /Line/.test(g) ? "line" : "circle");
        return { id: `${sid}-${i}`, type, source: sid, ...(s.paint ? { paint: s.paint } : type === "circle" ? { paint: { "circle-radius": 5, "circle-color": "#f59e0b", "circle-stroke-color": "#000", "circle-stroke-width": 1 } } : {}), ...(s.layout ? { layout: s.layout } : {}), ...(s.filter ? { filter: s.filter } : {}), ...(s.minzoom != null ? { minzoom: s.minzoom } : {}) } as LayerSpecification;
      });
      // 0.8.3 plugins: listed in the palette (Layers) with a visibility toggle
      let cur = data;
      const prev = pluginLayers.peek().find((x) => x.pid === cfg.id && x.id === id);
      const vis = (v: boolean) => layers.map((l) => ({ ...l, layout: { ...((l as any).layout ?? {}), visibility: v ? "visible" : "none" } }) as LayerSpecification);
      const pl: PluginLayer = {
        pid: cfg.id,
        id,
        title: opts.title ?? nice(id),
        kw: opts.keywords,
        visible: prev?.visible ?? true,
        setVisible: (v) => {
          pl.visible = v;
          setGeo(sid, cur, vis(v));
          pluginLayers.value = [...pluginLayers.peek()];
        },
      };
      setGeo(sid, data, vis(pl.visible));
      pluginLayers.value = [...pluginLayers.peek().filter((x) => x !== prev), pl];
      const off = unlist(pluginLayers, pl);
      run.cleanups.push(off);
      if (!run.sources.includes(sid)) run.sources.push(sid);
      return {
        setData: (d: any) => ((cur = d), setGeo(sid, d)),
        remove: () => {
          removeGeo(sid);
          off();
          run.sources = run.sources.filter((x) => x !== sid);
        },
      };
    },
    /** Add a raw MapLibre source + layers (removed with the plugin; not kept across basemap changes). */
    addSource(id: string, source: SourceSpecification, layers: LayerSpecification[] = [], opts: { title?: string; keywords?: string } = {}) {
      const m = map();
      const sid = `plg-${cfg.id}-${id}`;
      if (!m.getSource(sid)) m.addSource(sid, source);
      const lids: string[] = [];
      for (const l of layers) {
        const lid = `${sid}-${l.id}`;
        if (!m.getLayer(lid)) m.addLayer({ ...(l as any), id: lid, source: sid });
        run.layers.push(lid);
        lids.push(lid);
      }
      run.sources.push(`raw:${sid}`);
      // 0.8.3 plugins: palette entry with a visibility toggle
      if (lids.length) {
        const pl: PluginLayer = {
          pid: cfg.id,
          id,
          title: opts.title ?? nice(id),
          kw: opts.keywords,
          visible: true,
          setVisible: (v) => {
            pl.visible = v;
            for (const lid of lids) if (mapRef.value?.getLayer(lid)) mapRef.value.setLayoutProperty(lid, "visibility", v ? "visible" : "none");
            pluginLayers.value = [...pluginLayers.peek()];
          },
        };
        pluginLayers.value = [...pluginLayers.peek(), pl];
        run.cleanups.push(unlist(pluginLayers, pl));
      }
      return sid;
    },
    /** A floating panel. 0.8.3: it also gets a sidebar (rail) button and a command palette entry, which open it
     *  again after it was closed. opts: { rail: false } leaves the rail button out, { icon } is the button's
     *  image URL, { open: false } starts it closed. Returns a function that removes the panel. */
    addPanel(title: string, render: (el: HTMLElement) => void | (() => void), opts: { rail?: boolean; icon?: string; keywords?: string; open?: boolean } = {}) {
      // a stable id (plugin + title) so a closed panel stays closed when the plugin restarts
      const key = `${cfg.id}:${title}`;
      const p: PluginPanel = { pid: cfg.id, id: pluginPanels.peek().some((x) => x.id === key) ? `${key}:${uid()}` : key, title, render, kw: opts?.keywords };
      if (opts?.open === false) setPanelOpen(p.id, false);
      pluginPanels.value = [...pluginPanels.value, p];
      const offs = [unlist(pluginPanels, p)];
      if (opts?.rail !== false) offs.push(railButton({ title, icon: opts?.icon, onClick: () => showPluginPanel(p.id, true) }, p.id));
      const off = () => offs.forEach((f) => f());
      run.cleanups.push(off);
      // 0.8.3: the remover also shows / hides the panel (backward compatible: still a function)
      return Object.assign(off, { show: () => showPluginPanel(p.id), hide: () => setPanelOpen(p.id, false), toggle: () => showPluginPanel(p.id, true), isOpen: () => !closedPanels.peek().has(p.id) });
    },
    /** 0.8.3: a button in the sidebar rail. icon: an image URL (e.g. tbw.asset("icon.png")); default: the plugin's icon. Returns a remover. */
    addRailButton(o: { title: string; icon?: string; onClick: () => void; active?: () => boolean }) {
      const off = railButton(o);
      run.cleanups.push(off);
      return off;
    },
    /** 0.8.3: a command palette (Ctrl+K) entry. An `id` that matches a manifest `commands` entry runs that command. */
    addCommand(o: { id?: string; title: string; keywords?: string; run: () => void }) {
      const c: PluginCommand = { pid: cfg.id, id: String(o.id ?? uid()), title: String(o.title), kw: o.keywords, run: guard(o.run) };
      pluginCommands.value = [...pluginCommands.peek().filter((x) => !(x.pid === c.pid && x.id === c.id)), c];
      const off = unlist(pluginCommands, c);
      run.cleanups.push(off);
      return off;
    },
    /** 0.8.3: a setting listed in the command palette (Settings). Booleans toggle; with `options` each choice is an entry. */
    addSetting(o: { id?: string; title: string; keywords?: string; get: () => any; set: (v: any) => void; options?: { label: string; value: any }[] }) {
      const st: PluginSetting = { pid: cfg.id, id: String(o.id ?? uid()), title: String(o.title), kw: o.keywords, get: o.get, set: guard(o.set), options: Array.isArray(o.options) ? o.options.slice(0, 30).map((x) => ({ label: String(x.label), value: x.value })) : undefined };
      pluginSettings.value = [...pluginSettings.peek(), st];
      const off = unlist(pluginSettings, st);
      run.cleanups.push(off);
      return off;
    },
    /** Called when the shown animation frame changes: cb({ index }). */
    onFrame(cb: (f: { index: number }) => void) {
      const g = guard(cb);
      const off = effect(() => g({ index: frameIndex.value }));
      run.cleanups.push(off);
      return off;
    },
    /** Called with each newly seen alert (GeoJSON feature). */
    onAlert(cb: (f: any) => void) {
      const g = guard(cb);
      let seen = new Set(alerts.peek().keys());
      const off = effect(() => {
        const m = alerts.value;
        for (const [id, f] of m) if (!seen.has(id)) g(f);
        seen = new Set(m.keys());
      });
      run.cleanups.push(off);
      return off;
    },
    /** Map events (click, mousemove, moveend…) — removed with the plugin. */
    on(ev: string, cb: (e: any) => void) {
      const m = map();
      const g = guard(cb);
      m.on(ev as any, g);
      const off = () => m.off(ev as any, g);
      run.cleanups.push(off);
      return off;
    },
    toast(msg: string, kind: "info" | "warn" | "error" = "info") {
      appToast(`${cfg.name}: ${msg}`, kind);
    },
    /** GET a server path (JSON, or text/ArrayBuffer by `as`). Uses the configured server and token. */
    async fetchServer(path: string, as: "json" | "text" | "arrayBuffer" = "json") {
      if (as === "arrayBuffer") return api.bin(path);
      if (as === "json") return api.get(path);
      const r = await fetch(api.base + path, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} });
      return r.text();
    },
    /** Read-only copy of the app settings (units, points, …). */
    settings() {
      return structuredClone(settings.peek());
    },
    /** Called when the plugin is disabled or reloaded. */
    onUnload(fn: () => void) {
      run.cleanups.push(fn);
    },
  });
}

function stop(id: string) {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  for (const f of r.cleanups.reverse())
    try {
      f();
    } catch {
      /* ignore */
    }
  const m = mapRef.value;
  for (const l of r.layers) if (m?.getLayer(l)) m.removeLayer(l);
  for (const s of r.sources) {
    if (s.startsWith("raw:")) {
      if (m?.getSource(s.slice(4))) m.removeSource(s.slice(4));
    } else removeGeo(s);
  }
  status(id, { running: false });
}

/** plugins that failed: not restarted automatically until reloaded or toggled */
const failed = new Set<string>();

async function start(cfg: PluginCfg) {
  stop(cfg.id);
  failed.delete(cfg.id);
  const run: Running = { cleanups: [], layers: [], sources: [] };
  running.set(cfg.id, run); // synchronously, so the sync effect doesn't start it twice
  const code = await getCode(cfg.id);
  if (!code) {
    running.delete(cfg.id);
    failed.add(cfg.id);
    return status(cfg.id, { running: false, error: "No code stored — reload it" });
  }
  // modules (`export default function (tbw) {…}`) load as-is; plain scripts get `tbw` in scope.
  // 0.8.2: `stormiq` is the same API object under the app's new name (2nd argument / in scope).
  const src = /\bexport\s+default\b/.test(code) ? code : `export default async function (tbw, stormiq) {\n${code}\n}`;
  const url = URL.createObjectURL(new Blob([src + `\n//# sourceURL=tbw-plugin-${cfg.name.replace(/\W+/g, "_")}.js`], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default !== "function") throw new Error("plugin has no default export function");
    const papi = makeApi(cfg, run);
    const ret = await mod.default(papi, papi); // (tbw, stormiq): one object, two names
    if (typeof ret === "function") run.cleanups.push(ret);
    status(cfg.id, { running: true });
  } catch (e: any) {
    stop(cfg.id);
    failed.add(cfg.id);
    status(cfg.id, { running: false, error: String(e?.message ?? e) });
    appToast(`Plugin “${cfg.name}” failed: ${e?.message ?? e}`, "error", 7000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Add a plugin from code (file / URL / paste) and enable it. */
export async function addPlugin(name: string, src: string, code: string) {
  const id = uid();
  await setCode(id, code);
  update((s) => s.wf6.plugins.push({ id, name: name.replace(/\.js$/, ""), src, on: true }));
}
export async function reloadPlugin(cfg: PluginCfg) {
  if (cfg.src.startsWith("url:")) {
    const r = await fetch(cfg.src.slice(4));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await setCode(cfg.id, await r.text());
  } else if (cfg.src.startsWith("folder:")) {
    const list = await pluginFolder();
    const f = list?.files.find((x) => x.name === cfg.src.slice(7));
    if (f) await setCode(cfg.id, f.code);
  }
  if (cfg.on) await start(cfg);
}
/** 0.8.2: run a plugin's stored code again (after a marketplace update) */
export async function restartPlugin(cfg: PluginCfg) {
  failed.delete(cfg.id);
  if (cfg.on) await start(cfg);
}
export async function removePlugin(id: string) {
  stop(id);
  await idbDel(codeKey(id));
  update((s) => (s.wf6.plugins = s.wf6.plugins.filter((p) => p.id !== id)));
}
/** Electron: .js files in <userData>/plugins. */
export async function pluginFolder(): Promise<{ dir: string; files: { name: string; code: string }[] } | null> {
  return (await (window as any).tbw?.wf6?.pluginsDir?.()) ?? null;
}

let started = false;
/** Keep running plugins in sync with the enabled list. */
export function startPlugins() {
  if (started) return;
  started = true;
  const wait = () => (mapRef.value ? Promise.resolve() : new Promise<void>((r) => setTimeout(() => wait().then(r), 300)));
  wait().then(() =>
    effect(() => {
      const list = settings.value.wf6.plugins;
      for (const id of [...running.keys()]) if (!list.some((p) => p.id === id && p.on)) stop(id);
      for (const id of [...failed]) if (!list.some((p) => p.id === id && p.on)) failed.delete(id); // toggled off: may retry when on
      for (const p of list) if (p.on && !running.has(p.id) && !failed.has(p.id)) start(p);
    }),
  );
  (window as any).__tbwPlugins = { running, start, stop };
  // 0.8.2: marketplace plugins installed → look for updates once, a little after start (rail dot)
  if (settings.peek().wf6.plugins.some((p) => p.market))
    setTimeout(() => import("./market").then((m) => (m.loadInstalledMeta(), m.refreshMarket())).catch(() => {}), 20_000);
}
