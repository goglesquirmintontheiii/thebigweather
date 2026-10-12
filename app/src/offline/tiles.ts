// workflow 0.6: offline basemap regions.
// Tiles (vector .pbf / raster), TileJSON and glyph ranges of the basemap in use are downloaded for
// a box + zoom range and kept locally: Electron → files under userData/offline-tiles (IPC);
// browser → the Cache API. Requests are routed through the `tbwtiles://` MapLibre protocol
// (addProtocol + transformRequest): tiles inside a saved region are served from the store
// first; everything is served from the store when offline (or "prefer offline" is on).

import { addProtocol, type Map as MLMap, type RequestTransformFunction } from "maplibre-gl";
import { signal } from "@preact/signals";
import { settings, update, uid, toast, type OfflineRegion } from "../store";
import { OFFLINE_HOSTS } from "../map/basemaps";

const io = () => (window as any).tbw?.wf6 as
  | { tileGet(k: string): Promise<Uint8Array | null>; tilePut(k: string, b: ArrayBuffer): Promise<boolean>; tileDel(k: string[]): Promise<number>; tileUsage(): Promise<{ bytes: number; files: number }> }
  | undefined;
const CACHE = "tbw-offline-tiles";
const cacheUrl = (k: string) => `https://tbw-offline.invalid/${encodeURIComponent(k)}`;

/** Stable key for a tile/resource URL: no scheme, CARTO subdomain and OpenFreeMap version dropped. */
export function tileKey(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\?.*$/, "")
    .replace(/^[a-d]\.basemaps\.cartocdn\.com/, "basemaps.cartocdn.com")
    .replace(/(tiles\.openfreemap\.org\/[a-z]+)\/\d{8}_\d{6}_[a-z]+\//, "$1/");
}

async function getLocal(k: string): Promise<ArrayBuffer | null> {
  const e = io();
  if (e) {
    const b = await e.tileGet(k).catch(() => null);
    return b ? (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) : null;
  }
  if (!("caches" in window)) return null;
  const c = await caches.open(CACHE);
  const r = await c.match(cacheUrl(k));
  return r ? r.arrayBuffer() : null;
}
async function putLocal(k: string, b: ArrayBuffer) {
  const e = io();
  if (e) return void (await e.tilePut(k, b));
  const c = await caches.open(CACHE);
  await c.put(cacheUrl(k), new Response(b));
}
async function delLocal(keys: string[]) {
  const e = io();
  if (e) return void (await e.tileDel(keys));
  const c = await caches.open(CACHE);
  await Promise.all(keys.map((k) => c.delete(cacheUrl(k))));
}
export async function storeUsage(): Promise<number> {
  const e = io();
  if (e) return (await e.tileUsage().catch(() => ({ bytes: 0 }))).bytes;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  return (est as any)?.usageDetails?.caches ?? est?.usage ?? 0;
}

// ---------- tile math ----------
const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
function tileRange(b: [number, number, number, number], z: number) {
  const n = 2 ** z - 1;
  return { x0: Math.max(0, lon2x(b[0], z)), x1: Math.min(n, lon2x(b[2], z)), y0: Math.max(0, lat2y(b[3], z)), y1: Math.min(n, lat2y(b[1], z)) };
}
export function countTiles(b: [number, number, number, number], minz: number, maxz: number): number {
  let n = 0;
  for (let z = minz; z <= maxz; z++) {
    const r = tileRange(b, z);
    n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return n;
}
function* tilesOf(b: [number, number, number, number], minz: number, maxz: number) {
  for (let z = minz; z <= maxz; z++) {
    const r = tileRange(b, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield [z, x, y] as const;
  }
}
function inRegion(z: number, x: number, y: number): boolean {
  for (const r of settings.value.wf6.offline.regions) {
    if (z < r.minz || z > r.maxz) continue;
    const t = tileRange(r.bbox, z);
    if (x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) return true;
  }
  return false;
}

// ---------- protocol ----------
const online = signal(typeof navigator === "undefined" ? true : navigator.onLine);
window.addEventListener("online", () => (online.value = true));
window.addEventListener("offline", () => (online.value = false));
export const offlineHits = signal(0);

let registered = false;
function register() {
  if (registered) return;
  registered = true;
  addProtocol("tbwtiles", async (params, abort) => {
    // tbwtiles://<c|n>/<host/path>: c = store first, n = network first
    const m = params.url.match(/^tbwtiles:\/\/([cn])\/(.*)$/);
    if (!m) throw new Error("bad offline url");
    const real = "https://" + m[2];
    const key = tileKey(real);
    const asData = (b: ArrayBuffer) => (params.type === "json" ? JSON.parse(new TextDecoder().decode(b)) : params.type === "string" ? new TextDecoder().decode(b) : b);
    if (m[1] === "c" || !online.value) {
      const b = await getLocal(key);
      if (b) {
        offlineHits.value++;
        return { data: asData(b) };
      }
    }
    try {
      const r = await fetch(real, { signal: abort.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = await r.arrayBuffer();
      return { data: asData(b) };
    } catch (e) {
      const b = m[1] === "n" ? await getLocal(key) : null;
      if (b) return { data: asData(b) };
      // a missing tile while offline is just empty
      if (!online.value && params.type !== "json") return { data: new ArrayBuffer(0) };
      throw e;
    }
  });
}

/** MapLibre transformRequest: basemap requests go through the store when it can help. */
export const offlineTransform: RequestTransformFunction = (url, kind) => {
  const regions = settings.value.wf6?.offline.regions ?? [];
  if (!regions.length || !OFFLINE_HOSTS.test(url)) return undefined;
  register();
  const prefer = settings.value.wf6.offline.prefer || !online.value;
  const rest = url.replace(/^https:\/\//, "");
  if (kind === "Tile") {
    const m = url.match(/\/(\d+)\/(\d+)\/(\d+)(?:@2x)?(?:\.\w+)?(?:\?|$)/);
    // ArcGIS tiles are z/y/x
    const arc = url.includes("arcgisonline");
    const zxy = m ? (arc ? [+m[1], +m[3], +m[2]] : [+m[1], +m[2], +m[3]]) : null;
    if (prefer || (zxy && inRegion(zxy[0], zxy[1], zxy[2]))) return { url: `tbwtiles://c/${rest}` };
    return undefined;
  }
  if (kind === "Glyphs") return { url: `tbwtiles://c/${rest}` };
  if (kind === "Source") return { url: `tbwtiles://${prefer ? "c" : "n"}/${rest}` };
  return undefined;
};

// ---------- download ----------
export const dlProgress = signal<{ done: number; total: number; bytes: number; failed: number; name: string } | null>(null);
let dlAbort: AbortController | null = null;
export function cancelDownload() {
  dlAbort?.abort();
}

/** Basemap source ids (map/basemaps.ts) that can be saved. */
const BASE_SOURCES = ["ofm", "carto", "labels", "relief", "hillshade", "wf6-dem-hs"];

/** Tile templates (and TileJSON / glyph URLs) of the basemap currently shown. Cheap: no style
 * serialisation (that would copy every GeoJSON source). */
export function currentTemplates(map: MLMap): { templates: { url: string; maxzoom: number; raster: boolean }[]; extra: string[] } {
  const templates: { url: string; maxzoom: number; raster: boolean }[] = [];
  const extra: string[] = [];
  for (const id of BASE_SOURCES) {
    const src: any = map.getSource(id);
    const u: string | undefined = src?.tiles?.[0];
    if (!u || !OFFLINE_HOSTS.test(u)) continue;
    if (typeof src.url === "string" && OFFLINE_HOSTS.test(src.url)) extra.push(src.url);
    templates.push({ url: u, maxzoom: src.maxzoom ?? 14, raster: src.type !== "vector" });
  }
  const glyphs = map.getGlyphs?.();
  if (glyphs && OFFLINE_HOSTS.test(glyphs)) {
    const fonts = new Set<string>();
    for (const id of map.getLayersOrder()) {
      if (map.getLayer(id)?.type !== "symbol") continue;
      const f = map.getLayoutProperty(id, "text-font");
      if (Array.isArray(f) && f.every((x) => typeof x === "string")) fonts.add(f.join(","));
    }
    // Latin, Latin-1, Latin Extended, Greek/Cyrillic and punctuation ranges
    for (const f of fonts) for (const r of ["0-255", "256-511", "512-767", "768-1023", "1024-1279", "8192-8447"]) extra.push(glyphs.replace("{fontstack}", encodeURIComponent(f)).replace("{range}", r));
  }
  return { templates, extra };
}

/** Rough size: vector tiles ~35 KB, retina raster ~45 KB, plain raster ~20 KB. */
export function estimateBytes(tiles: number, t: { raster: boolean; url: string }[]): number {
  return t.reduce((s, x) => s + tiles * (x.raster ? (x.url.includes("@2x") ? 45_000 : 20_000) : 35_000), 0);
}

export async function downloadRegion(map: MLMap, name: string, bbox: [number, number, number, number], minz: number, maxz: number, existing?: OfflineRegion) {
  if (dlProgress.value) return toast("A download is already running", "warn");
  const { templates, extra } = currentTemplates(map);
  if (!templates.length) return toast("This basemap can't be saved offline (use Dark, Light, Road, Dark roadmap or Terrain)", "warn", 6000);
  const jobs: string[] = [...extra];
  for (const t of templates) for (const [z, x, y] of tilesOf(bbox, minz, Math.min(maxz, t.maxzoom))) jobs.push(t.url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{r}", ""));
  if (jobs.length > 60_000) return toast(`${jobs.length.toLocaleString()} tiles is too many — pick a smaller box or fewer zoom levels`, "warn", 7000);
  dlAbort = new AbortController();
  const sig = dlAbort.signal;
  const prog = { done: 0, total: jobs.length, bytes: 0, failed: 0, name };
  dlProgress.value = { ...prog };
  let k = 0;
  let lastUi = 0;
  const worker = async () => {
    while (k < jobs.length && !sig.aborted) {
      const url = jobs[k++];
      try {
        const r = await fetch(url, { signal: sig });
        if (!r.ok) throw new Error(String(r.status));
        const b = await r.arrayBuffer();
        await putLocal(tileKey(url), b);
        prog.bytes += b.byteLength;
      } catch {
        if (!sig.aborted) prog.failed++;
      }
      prog.done++;
      if (performance.now() - lastUi > 250) {
        lastUi = performance.now();
        dlProgress.value = { ...prog };
      }
    }
  };
  // light use of the public tile servers: 4 at a time
  await Promise.all([worker(), worker(), worker(), worker()]);
  dlProgress.value = null;
  if (sig.aborted) return toast(`Stopped “${name}” (${prog.done.toLocaleString()} of ${prog.total.toLocaleString()} saved)`, "warn");
  const reg: OfflineRegion = { id: existing?.id ?? uid(), name, bbox, minz, maxz, tiles: prog.done - prog.failed, bytes: prog.bytes, saved: Date.now(), templates: templates.map((t) => t.url) };
  update((s) => {
    const l = s.wf6.offline.regions.filter((r) => r.id !== reg.id);
    l.push(reg);
    s.wf6.offline.regions = l;
  });
  toast(`Saved “${name}” for offline use · ${reg.tiles.toLocaleString()} tiles${prog.failed ? ` (${prog.failed} failed)` : ""}`);
}

/** Remove a region's tiles (those not inside another saved region). */
export async function deleteRegion(id: string) {
  const r = settings.value.wf6.offline.regions.find((x) => x.id === id);
  if (!r) return;
  const others = settings.value.wf6.offline.regions.filter((x) => x.id !== id);
  update((s) => (s.wf6.offline.regions = others));
  const keys: string[] = [];
  const covered = (z: number, x: number, y: number) =>
    others.some((o) => {
      if (z < o.minz || z > o.maxz) return false;
      const t = tileRange(o.bbox, z);
      return x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1;
    });
  for (const t of r.templates) for (const [z, x, y] of tilesOf(r.bbox, r.minz, r.maxz)) if (!covered(z, x, y)) keys.push(tileKey(t.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{r}", "")));
  for (let i = 0; i < keys.length; i += 2000) await delLocal(keys.slice(i, i + 2000));
  toast(`Deleted “${r.name}”`);
}
