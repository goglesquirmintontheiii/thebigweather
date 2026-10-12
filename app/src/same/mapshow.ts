// "Show on map" for decoded SAME messages: outlines the listed counties on the main map (from a
// popped-out radio window the request goes to the main window over a BroadcastChannel).
// p7: every outline belongs to a log entry (key) and goes away by itself when the message
// expires (tests after 60 s), when the entry is hidden ("Hide on map") or when the log is cleared.

import { signal } from "@preact/signals";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { mapRef } from "../map/mapview";
import { toast } from "../store";
import { countyFeatures } from "./fips";

const SRC = "same-hl";
const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("tbw-same-map") : null;
/** this window's prefix, so log ids of different (popped-out) windows never collide */
const WIN = Math.random().toString(36).slice(2, 7);
export const sameKey = (id: number) => `${WIN}:${id}`;

/** Test messages stay on the map this long. */
export const TEST_SHOW_MS = 60_000;
/** Real messages: until they expire, at least this long (an already-expired header still flashes up). */
const MIN_SHOW_MS = 60_000;

/** keys currently outlined (in this window's view of things; drives the Map / Hide toggles) */
export const sameShown = signal<Record<string, number>>({});

interface Hl {
  fc: GeoJSON.FeatureCollection;
  until: number;
  timer: number;
}
const shown = new Map<string, Hl>();

function setShown(key: string, until: number | null) {
  const n = { ...sameShown.value };
  if (until == null) delete n[key];
  else n[key] = until;
  sameShown.value = n;
}

function render(map: MLMap) {
  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [...shown.values()].flatMap((h) => h.fc.features) };
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (src) src.setData(fc);
  else if (fc.features.length) {
    map.addSource(SRC, { type: "geojson", data: fc });
    map.addLayer({ id: "same-hl-fill", type: "fill", source: SRC, paint: { "fill-color": ["coalesce", ["get", "_color"], "#ff3b30"], "fill-opacity": 0.22 } });
    map.addLayer({ id: "same-hl-line", type: "line", source: SRC, paint: { "line-color": ["coalesce", ["get", "_color"], "#ff3b30"], "line-width": 2.4, "line-dasharray": [2, 1] } });
  }
}

export interface ShowOpts {
  /** log entry key (sameKey(id)); outlines with the same key replace each other */
  key?: string;
  /** when the message expires (ms); undefined = 10 minutes */
  expires?: number;
  test?: boolean;
}

export async function showCounties(fips: string[], label: string, color = "#ff3b30", o: ShowOpts = {}) {
  const key = o.key ?? `${WIN}:adhoc`;
  const until = o.test ? Date.now() + TEST_SHOW_MS : Math.max(Date.now() + MIN_SHOW_MS, o.expires ?? Date.now() + 10 * 60000);
  const map = mapRef.value;
  if (!map) {
    if (ch) {
      ch.postMessage({ fips, label, color, key, until });
      setShown(key, until);
      window.setTimeout(() => sameShown.value[key] === until && setShown(key, null), until - Date.now());
      toast("Sent to the main window's map");
    } else toast("No map in this window", "warn");
    return;
  }
  const fc = await countyFeatures(fips.filter((f) => !/^(5[7-9]|6[15]|7[357]|9\d)/.test(f)));
  if (!fc.features.length) return toast("No county outlines for these codes (marine zones aren't bundled)", "warn");
  for (const f of fc.features) f.properties = { ...(f.properties ?? {}), label, _color: color };
  place(map, key, fc, until);
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c: any) => {
    if (typeof c[0] === "number") {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
    } else c.forEach(walk);
  };
  for (const f of fc.features) walk((f.geometry as any).coordinates);
  map.fitBounds([[w, s], [e, n]], { padding: 160, maxZoom: 8, duration: 800 });
}

function place(map: MLMap, key: string, fc: GeoJSON.FeatureCollection, until: number) {
  const old = shown.get(key);
  if (old) clearTimeout(old.timer);
  const timer = window.setTimeout(() => hideCounties(key), Math.max(1000, until - Date.now()));
  shown.set(key, { fc, until, timer });
  setShown(key, until);
  render(map);
}

/** Remove one entry's outlines (or all of them without a key). */
export function hideCounties(key?: string) {
  const keys = key ? [key] : [...shown.keys(), ...Object.keys(sameShown.value)];
  for (const k of keys) {
    const h = shown.get(k);
    if (h) clearTimeout(h.timer);
    shown.delete(k);
    setShown(k, null);
    if (mapRef.value) ch?.postMessage({ gone: k });
  }
  const map = mapRef.value;
  if (!map) {
    ch?.postMessage({ clear: true, key });
    return;
  }
  if (map.getStyle()) render(map);
}

/** Everything off (kept for older callers). */
export function clearCounties() {
  hideCounties();
}

if (ch)
  ch.onmessage = (e) => {
    const d = e.data;
    if (!mapRef.value) {
      // popped-out window: the main map dropped an outline (expired / hidden there)
      if (d?.gone) setShown(d.gone, null);
      return;
    }
    if (d?.clear) hideCounties(d.key);
    else if (Array.isArray(d?.fips)) showCounties(d.fips, d.label, d.color, { key: d.key, expires: d.until, test: false });
  };
