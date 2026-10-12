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
  render: (el: HTMLElement) => void | (() => void);
}
export const pluginPanels = signal<PluginPanel[]>([]);
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
  return Object.freeze({
    version: API_VERSION,
    plugin: { id: cfg.id, name: cfg.name },
    get map() {
      return map();
    },
    /** Add (or replace) a GeoJSON layer. style: { type?: "circle"|"line"|"fill"|"symbol", paint?, layout?, filter? } or a list of MapLibre layers (without source). */
    addGeoJSONLayer(id: string, data: any, style: any = {}) {
      const sid = `plg-${cfg.id}-${id}`;
      const specs: any[] = Array.isArray(style) ? style : [style];
      const layers = specs.map((s, i) => {
        const g = typeof data === "object" ? data?.features?.[0]?.geometry?.type ?? data?.geometry?.type ?? "" : "";
        const type = s.type ?? (/Polygon/.test(g) ? "fill" : /Line/.test(g) ? "line" : "circle");
        return { id: `${sid}-${i}`, type, source: sid, ...(s.paint ? { paint: s.paint } : type === "circle" ? { paint: { "circle-radius": 5, "circle-color": "#f59e0b", "circle-stroke-color": "#000", "circle-stroke-width": 1 } } : {}), ...(s.layout ? { layout: s.layout } : {}), ...(s.filter ? { filter: s.filter } : {}), ...(s.minzoom != null ? { minzoom: s.minzoom } : {}) } as LayerSpecification;
      });
      setGeo(sid, data, layers);
      if (!run.sources.includes(sid)) run.sources.push(sid);
      return {
        setData: (d: any) => setGeo(sid, d),
        remove: () => {
          removeGeo(sid);
          run.sources = run.sources.filter((x) => x !== sid);
        },
      };
    },
    /** Add a raw MapLibre source + layers (removed with the plugin; not kept across basemap changes). */
    addSource(id: string, source: SourceSpecification, layers: LayerSpecification[] = []) {
      const m = map();
      const sid = `plg-${cfg.id}-${id}`;
      if (!m.getSource(sid)) m.addSource(sid, source);
      for (const l of layers) {
        const lid = `${sid}-${l.id}`;
        if (!m.getLayer(lid)) m.addLayer({ ...(l as any), id: lid, source: sid });
        run.layers.push(lid);
      }
      run.sources.push(`raw:${sid}`);
      return sid;
    },
    /** A sidebar panel section (Settings → Plugins → panel list, and the floating plugin dock). */
    addPanel(title: string, render: (el: HTMLElement) => void | (() => void)) {
      const p: PluginPanel = { pid: cfg.id, id: uid(), title, render };
      pluginPanels.value = [...pluginPanels.value, p];
      run.cleanups.push(() => (pluginPanels.value = pluginPanels.value.filter((x) => x !== p)));
      return () => (pluginPanels.value = pluginPanels.value.filter((x) => x !== p));
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
  // modules (`export default function (tbw) {…}`) load as-is; plain scripts get `tbw` in scope
  const src = /\bexport\s+default\b/.test(code) ? code : `export default async function (tbw) {\n${code}\n}`;
  const url = URL.createObjectURL(new Blob([src + `\n//# sourceURL=tbw-plugin-${cfg.name.replace(/\W+/g, "_")}.js`], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default !== "function") throw new Error("plugin has no default export function");
    const ret = await mod.default(makeApi(cfg, run));
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
}
