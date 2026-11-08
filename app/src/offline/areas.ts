// 0.8.2 offline areas: download / update / delete polygon areas of a basemap (Basemap tab →
// right-click a basemap). Tile cover, ref counts and the change plan are in cover.ts; this file
// resolves a basemap's tile templates, checks the provider's terms, and runs the download job
// (4 requests at a time, pause / resume / cancel). Tiles share the store of the 0.6 box regions.

import { signal } from "@preact/signals";
import { settings, update, uid, toast, type Basemap } from "../store";
import { buildStyle, BASEMAPS, FAA_CHARTS } from "../map/basemaps";
import { planChange, countCover, tileKey, type OfflineArea, type LngLat } from "./cover";
import { putLocal, delLocal, legacyCovered } from "./tiles";

export type { OfflineArea } from "./cover";

export interface DownloadPolicy {
  ok: boolean;
  /** why it can't be downloaded */
  reason?: string;
  /** per-download limits from the provider's terms */
  maxTiles?: number;
  maxBytes?: number;
  /** shown under the estimate */
  note?: string;
}

const OFM_TERMS = "OpenFreeMap allows offline areas of up to 3,000 tiles / 50 MB per download (openfreemap.org/tos)";

/** What the provider's terms allow for a basemap. */
export function downloadPolicy(b: Basemap | string): DownloadPolicy {
  const s = settings.value;
  const ofm = (s.basemapProvider ?? "openfreemap") === "openfreemap";
  if (b.startsWith("custom:")) {
    const c = s.customBasemaps.find((x) => `custom:${x.id}` === b);
    if (c?.url.includes("{-y}")) return { ok: false, reason: "TMS ({-y}) tile servers can't be saved offline." };
    return { ok: true, maxTiles: 60_000, note: "Check that this tile server allows offline downloads" };
  }
  if (b in FAA_CHARTS) return { ok: false, reason: "FAA's chart tile service doesn't allow tile export. FAA publishes the charts as GeoTIFF downloads on faa.gov instead." };
  switch (b) {
    case "dark":
    case "light":
    case "road":
      return ofm ? { ok: true, maxTiles: 3000, maxBytes: 50e6, note: OFM_TERMS } : { ok: false, reason: "CARTO's basemap terms forbid bulk downloads. Switch Map tiles to OpenFreeMap to save this map." };
    case "darkroad":
      return { ok: true, maxTiles: 3000, maxBytes: 50e6, note: OFM_TERMS };
    case "terrain":
      return { ok: false, reason: "Esri's terrain tiles don't allow export or offline use, and CARTO's labels forbid bulk downloads." };
    case "satellite":
      return { ok: false, reason: "Esri World Imagery doesn't allow offline export without an ArcGIS licence." };
    case "google":
      return { ok: false, reason: "Google's Map Tiles terms don't allow storing tiles offline." };
    case "offline":
      return { ok: false, reason: "Already offline: built into the app." };
  }
  return { ok: false, reason: "Unknown basemap" };
}

export const basemapName = (b: string) => (b.startsWith("custom:") ? settings.value.customBasemaps.find((c) => `custom:${c.id}` === b)?.name ?? "Custom" : BASEMAPS.find((x) => x.id === b)?.name ?? b);

export const areasOf = (b: string) => (settings.value.wf6.offline.areas ?? []).filter((a) => a.basemap === b);

/** Tile templates + TileJSON / glyph URLs of a basemap (built from its style, not the map shown). */
export async function basemapTemplates(b: Basemap): Promise<{ templates: OfflineArea["templates"]; extra: string[]; maxzoom: number }> {
  const s = settings.value;
  const style = buildStyle(b, { labels: s.overlays.labels, provider: s.basemapProvider, custom: s.customBasemaps });
  const templates: OfflineArea["templates"] = [];
  const extra: string[] = [];
  for (const [id, src0] of Object.entries(style.sources)) {
    const src: any = src0;
    if (src.type !== "vector" && src.type !== "raster") continue;
    if (id === "land" || id === "borders") continue;
    if (src.tiles?.[0]) templates.push({ url: src.tiles[0], maxzoom: src.maxzoom ?? 19, minzoom: src.minzoom });
    else if (typeof src.url === "string") {
      const r = await fetch(src.url);
      if (!r.ok) throw new Error(`TileJSON: HTTP ${r.status}`);
      const tj = await r.json();
      if (!tj.tiles?.[0]) throw new Error("TileJSON without tiles");
      templates.push({ url: tj.tiles[0], maxzoom: tj.maxzoom ?? 14, minzoom: tj.minzoom });
      extra.push(src.url);
    }
  }
  if (style.glyphs) {
    const fonts = new Set<string>();
    for (const l of style.layers as any[]) {
      const f = l.layout?.["text-font"];
      if (l.type === "symbol" && Array.isArray(f) && f.every((x: any) => typeof x === "string")) fonts.add(f.join(","));
    }
    // Latin, Latin-1, Latin Extended, Greek/Cyrillic and punctuation ranges
    for (const f of fonts) for (const r of ["0-255", "256-511", "512-767", "768-1023", "1024-1279", "8192-8447"]) extra.push(style.glyphs.replace("{fontstack}", encodeURIComponent(f)).replace("{range}", r));
  }
  return { templates, extra, maxzoom: Math.max(0, ...templates.map((t) => t.maxzoom)) };
}

/** rough size: vector tiles ~30 KB, retina raster ~45 KB, plain raster ~20 KB, glyph ranges ~70 KB */
export function estimateUrls(urls: string[]): number {
  let b = 0;
  for (const u of urls) b += /\.pbf$/.test(u) && u.includes("/fonts/") ? 70_000 : /\.pbf|\.mvt|planet\//.test(u) ? 30_000 : u.includes("@2x") ? 45_000 : 20_000;
  return b;
}

// ---------- job ----------
export interface AreaJob {
  name: string;
  done: number;
  total: number;
  bytes: number;
  failed: number;
  paused: boolean;
}
export const areaJob = signal<AreaJob | null>(null);
let abort: AbortController | null = null;
let resumeFn: (() => void) | null = null;
let pauseWait: Promise<void> | null = null;

export function pauseAreaJob() {
  if (!areaJob.value || areaJob.value.paused) return;
  pauseWait = new Promise((r) => (resumeFn = r));
  areaJob.value = { ...areaJob.value, paused: true };
}
export function resumeAreaJob() {
  if (!areaJob.value?.paused) return;
  areaJob.value = { ...areaJob.value, paused: false };
  pauseWait = null;
  resumeFn?.();
  resumeFn = null;
}
export function cancelAreaJob() {
  abort?.abort();
  resumeAreaJob();
}

/** The plan for replacing / adding / removing one area (all areas of the store are counted, so
 * tiles shared with other areas — of any basemap — are neither fetched again nor deleted). */
export function planFor(next: OfflineArea | null, removeId?: string) {
  const all = settings.value.wf6.offline.areas ?? [];
  const after = all.filter((a) => a.id !== (next?.id ?? removeId));
  if (next) after.push(next);
  const p = planChange(all, after);
  // tiles a 0.6 box region also covers stay
  p.del = p.del.filter((k) => !legacyCovered(k));
  // retry tiles that failed last time
  const old = all.find((a) => a.id === next?.id);
  for (const u of old?.missing ?? []) if (!p.add.includes(u)) p.add.push(u);
  return p;
}


/** Check the provider limits for a plan; returns an error text or null. */
export function limitError(pol: DownloadPolicy, add: string[]): string | null {
  if (!pol.ok) return pol.reason ?? "Can't download";
  if (pol.maxTiles && add.length > pol.maxTiles) return `${add.length.toLocaleString()} tiles is over the ${pol.maxTiles.toLocaleString()} allowed per download — draw a smaller area or lower the max zoom`;
  if (pol.maxBytes && estimateUrls(add) > pol.maxBytes) return `~${Math.round(estimateUrls(add) / 1e6)} MB is over the ${Math.round(pol.maxBytes / 1e6)} MB allowed per download`;
  return null;
}

/** Download a new area or apply an edited one (Update): fetch the new tiles, then delete the ones
 * no area needs any more. Cancel removes what this job fetched and keeps the old area. */
export async function saveArea(input: { id?: string; basemap: Basemap; name: string; poly: LngLat[]; maxz: number }): Promise<boolean> {
  if (areaJob.value) return toast("A download is already running", "warn"), false;
  const pol = downloadPolicy(input.basemap);
  const old = (settings.value.wf6.offline.areas ?? []).find((a) => a.id === input.id);
  let tpl: Awaited<ReturnType<typeof basemapTemplates>>;
  try {
    // an edited area keeps its templates (OpenFreeMap's version is dropped from keys anyway)
    tpl = old ? { templates: old.templates, extra: old.extra, maxzoom: 0 } : await basemapTemplates(input.basemap);
  } catch (e: any) {
    toast(`Can't read this basemap: ${e?.message ?? e}`, "error");
    return false;
  }
  if (!tpl.templates.length) return toast("This basemap has nothing to download", "warn"), false;
  const next: OfflineArea = {
    id: old?.id ?? uid(),
    basemap: input.basemap,
    name: input.name.trim() || `Area ${(settings.value.wf6.offline.areas ?? []).length + 1}`,
    poly: input.poly,
    minz: 0,
    maxz: input.maxz,
    templates: tpl.templates,
    extra: tpl.extra,
    tiles: 0,
    bytes: 0,
    saved: Date.now(),
  };
  const plan = planFor(next);
  const err = limitError(pol, plan.add);
  if (err) return toast(err, "warn", 7000), false;
  abort = new AbortController();
  const sig = abort.signal;
  const prog: AreaJob = { name: next.name, done: 0, total: plan.add.length, bytes: 0, failed: 0, paused: false };
  areaJob.value = { ...prog };
  const fetched: string[] = [];
  const missing: string[] = [];
  let k = 0;
  let lastUi = 0;
  const worker = async () => {
    while (k < plan.add.length && !sig.aborted) {
      if (pauseWait) await pauseWait;
      if (sig.aborted) break;
      const url = plan.add[k++];
      try {
        const r = await fetch(url, { signal: sig });
        if (!r.ok) throw new Error(String(r.status));
        const b = await r.arrayBuffer();
        await putLocal(tileKey(url), b);
        fetched.push(tileKey(url));
        prog.bytes += b.byteLength;
      } catch {
        if (!sig.aborted) {
          prog.failed++;
          if (missing.length < 2000) missing.push(url);
        }
      }
      prog.done++;
      if (performance.now() - lastUi > 250) {
        lastUi = performance.now();
        areaJob.value = { ...prog, paused: !!areaJob.value?.paused };
      }
    }
  };
  // light use of the tile servers (OpenFreeMap: at most 4 parallel requests)
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (sig.aborted) {
    // undo: drop what this job stored that no area needed before
    for (let i = 0; i < fetched.length; i += 2000) await delLocal(fetched.slice(i, i + 2000));
    areaJob.value = null;
    abort = null;
    toast(`Cancelled “${next.name}”${old ? " — the saved area is unchanged" : ""}`, "warn");
    return false;
  }
  for (let i = 0; i < plan.del.length; i += 2000) await delLocal(plan.del.slice(i, i + 2000));
  next.tiles = next.templates.reduce((n, t) => n + countCover(next.poly, Math.max(next.minz, t.minzoom ?? 0), Math.min(next.maxz, t.maxzoom)), 0);
  next.bytes = (old?.bytes ?? 0) + prog.bytes - (old ? estimateRemoved(plan.del.length, old) : 0);
  next.failed = prog.failed;
  if (missing.length) next.missing = missing;
  update((s) => {
    const l = (s.wf6.offline.areas ?? []).filter((a) => a.id !== next.id);
    l.push(next);
    s.wf6.offline.areas = l;
  });
  areaJob.value = null;
  abort = null;
  toast(`${old ? "Updated" : "Saved"} “${next.name}” · +${(prog.done - prog.failed).toLocaleString()}${plan.del.length ? ` / −${plan.del.length.toLocaleString()}` : ""} tiles${prog.failed ? ` (${prog.failed} failed — Update retries them)` : ""}`);
  return true;
}

function estimateRemoved(n: number, a: OfflineArea) {
  return a.tiles ? Math.min(a.bytes, Math.round((a.bytes / a.tiles) * n)) : 0;
}

/** Delete an area: only tiles no other area (or 0.6 region) needs are removed. */
export async function deleteArea(id: string) {
  const a = (settings.value.wf6.offline.areas ?? []).find((x) => x.id === id);
  if (!a) return;
  const plan = planFor(null, id);
  update((s) => (s.wf6.offline.areas = (s.wf6.offline.areas ?? []).filter((x) => x.id !== id)));
  for (let i = 0; i < plan.del.length; i += 2000) await delLocal(plan.del.slice(i, i + 2000));
  toast(`Deleted “${a.name}” (${plan.del.length.toLocaleString()} tiles removed)`);
}
