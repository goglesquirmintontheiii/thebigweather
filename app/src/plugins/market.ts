// 0.8.2: plugin marketplace — loads the registries, installs / updates / uninstalls plugins.
// Installed code goes through the existing plugin host (host.ts): stored in IndexedDB, run on start.

import { signal, computed } from "@preact/signals";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { settings, update, type PluginCfg } from "../store";
import { setCode, removePlugin, restartPlugin } from "./host";
import { DEFAULT_REGISTRY, parseRegistry, entryBase, assetUrl, validateManifest, verifyHash, cmpVersion, descIsFile, type Manifest, type RegistryEntry } from "./marketcore";

export interface MarketItem {
  /** registry url + "#" + plugin id */
  key: string;
  reg: string;
  regName?: string;
  base: string;
  entry: RegistryEntry;
  source: "folder" | "repo";
  manifest?: Manifest;
  /** the manifest file as downloaded (for its checksum) */
  manifestText?: string;
  error?: string;
}
export interface InstalledMeta {
  manifest: Manifest;
  base: string;
  /** small data: URL so the installed list works offline */
  icon?: string;
  description?: string;
  at: number;
}

export const market = signal<{ loading: boolean; items: MarketItem[]; errors: { reg: string; msg: string }[]; at: number }>({ loading: false, items: [], errors: [], at: 0 });
export const installedMeta = signal<Record<string, InstalledMeta>>({});
export const busy = signal<Record<string, string>>({});

export const registries = () => {
  const r = (settings.value.wf6.pluginRegistries ?? []).map((x) => x.trim()).filter(Boolean);
  return r.length ? r : [DEFAULT_REGISTRY];
};
export const setRegistries = (list: string[]) =>
  update((s) => {
    const l = list.map((x) => x.trim()).filter(Boolean);
    s.wf6.pluginRegistries = l.length === 1 && l[0] === DEFAULT_REGISTRY ? undefined : l;
  });

const metaKey = (id: string) => `tbw.plugin.meta.${id}`;
export const pluginIdFor = (pid: string) => `mk.${pid}`;

async function fetchText(url: string, ms = 15000): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e: any) {
    throw new Error(e?.name === "AbortError" ? "timed out" : String(e?.message ?? e));
  } finally {
    clearTimeout(t);
  }
}

/** Load all registries and each plugin's manifest. */
export async function refreshMarket() {
  if (market.peek().loading) return;
  market.value = { ...market.peek(), loading: true };
  const items: MarketItem[] = [];
  const errors: { reg: string; msg: string }[] = [];
  await Promise.all(
    registries().map(async (reg) => {
      try {
        const r = parseRegistry(JSON.parse(await fetchText(reg)));
        const loaded = await Promise.all(
          r.plugins.slice(0, 200).map(async (entry): Promise<MarketItem> => {
            const base = entryBase(reg, entry);
            const it: MarketItem = { key: "", reg, regName: r.name, base, entry, source: entry.repo ? "repo" : "folder" };
            try {
              it.manifestText = await fetchText(base + "plugin.json");
              it.manifest = validateManifest(JSON.parse(it.manifestText));
            } catch (e: any) {
              it.error = `plugin.json: ${e.message}`;
            }
            it.key = `${reg}#${it.manifest?.id ?? entry.id ?? entry.path ?? entry.repo}`;
            return it;
          }),
        );
        items.push(...loaded);
      } catch (e: any) {
        errors.push({ reg, msg: e.message });
      }
    }),
  );
  // the same plugin id in two registries: the first registry wins
  const seen = new Set<string>();
  const order = registries();
  items.sort((a, b) => order.indexOf(a.reg) - order.indexOf(b.reg));
  const uniq = items.filter((it) => {
    const id = it.manifest?.id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  market.value = { loading: false, items: uniq, errors, at: Date.now() };
}

/** Load the stored metadata of installed marketplace plugins. */
export async function loadInstalledMeta() {
  const out: Record<string, InstalledMeta> = {};
  for (const p of settings.peek().wf6.plugins) {
    if (!p.market) continue;
    const m = await idbGet<InstalledMeta>(metaKey(p.id)).catch(() => undefined);
    if (m) out[p.id] = m;
  }
  installedMeta.value = out;
}

const descCache = new Map<string, string>();
/** The markdown description (downloads the file when the manifest names one). */
export async function description(m: Manifest, base: string): Promise<string> {
  const d = m.description ?? m.summary ?? "";
  if (!descIsFile(d)) return d;
  const url = assetUrl(base, d);
  if (!url) return "";
  if (descCache.has(url)) return descCache.get(url)!;
  const t = await fetchText(url);
  descCache.set(url, t);
  return t;
}

async function toDataUrl(url: string, maxBytes = 256 * 1024): Promise<string | undefined> {
  try {
    const r = await fetch(url);
    if (!r.ok) return undefined;
    const b = await r.blob();
    if (b.size > maxBytes || !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(b.type)) return undefined;
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res(undefined);
      fr.readAsDataURL(b);
    });
  } catch {
    return undefined;
  }
}

let appVer: string | null | undefined;
export async function appVersion(): Promise<string | null> {
  if (appVer !== undefined) return appVer;
  try {
    appVer = (await (window as any).tbw?.info?.())?.version ?? null;
  } catch {
    appVer = null;
  }
  return appVer ?? null;
}

export const installedFor = (pid: string): PluginCfg | undefined => settings.value.wf6.plugins.find((p) => p.market?.pid === pid);

/** Install (or update) a marketplace plugin: download, check hashes, store, enable. */
export async function install(it: MarketItem): Promise<void> {
  const m = it.manifest;
  if (!m) throw new Error(it.error ?? "no manifest");
  const id = pluginIdFor(m.id);
  busy.value = { ...busy.value, [m.id]: "Installing…" };
  try {
    const av = await appVersion();
    if (m.minAppVersion && av && cmpVersion(av, m.minAppVersion) < 0) throw new Error(`needs app version ${m.minAppVersion} or newer (you have ${av})`);
    const url = assetUrl(it.base, m.entry);
    if (!url) throw new Error("bad entry path");
    const code = await fetchText(url, 30000);
    if (code.length > 2_000_000) throw new Error("plugin file is too large (> 2 MB)");
    if (it.manifestText) await verifyHash(it.entry, "plugin.json", it.manifestText);
    await verifyHash(it.entry, m.entry, code);
    const iconUrl = m.icon ? assetUrl(it.base, m.icon) : null;
    const meta: InstalledMeta = {
      manifest: m,
      base: it.base,
      icon: iconUrl ? await toDataUrl(iconUrl) : undefined,
      description: await description(m, it.base).catch(() => m.summary ?? ""),
      at: Date.now(),
    };
    await setCode(id, code);
    await idbSet(metaKey(id), meta);
    installedMeta.value = { ...installedMeta.value, [id]: meta };
    const prev = settings.peek().wf6.plugins.find((p) => p.id === id);
    const cfg: PluginCfg = { id, name: m.name, src: `market:${m.id}`, on: prev ? prev.on : true, market: { pid: m.id, reg: it.reg, version: m.version, base: it.base } };
    update((s) => {
      const i = s.wf6.plugins.findIndex((p) => p.id === id);
      if (i >= 0) s.wf6.plugins[i] = cfg;
      else s.wf6.plugins.push(cfg);
    });
    if (prev?.on) await restartPlugin(cfg); // an update: run the new code
  } finally {
    const b = { ...busy.value };
    delete b[m.id];
    busy.value = b;
  }
}

export async function uninstall(id: string) {
  await removePlugin(id);
  await idbDel(metaKey(id)).catch(() => {});
  const o = { ...installedMeta.value };
  delete o[id];
  installedMeta.value = o;
}

export const setEnabled = (id: string, on: boolean) =>
  update((s) => {
    const p = s.wf6.plugins.find((x) => x.id === id);
    if (p) p.on = on;
  });

/** marketplace items that are newer than what's installed */
export const updates = computed(() =>
  market.value.items.filter((it) => {
    if (!it.manifest) return false;
    const p = settings.value.wf6.plugins.find((x) => x.market?.pid === it.manifest!.id);
    return !!p?.market && cmpVersion(it.manifest.version, p.market.version) > 0;
  }),
);
