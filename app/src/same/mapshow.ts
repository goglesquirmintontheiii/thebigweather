// "Show on map" for decoded SAME messages: outlines the listed counties on the main map (from a
// popped-out radio window the request goes to the main window over a BroadcastChannel).

import type { GeoJSONSource } from "maplibre-gl";
import { mapRef } from "../map/mapview";
import { toast } from "../store";
import { countyFeatures } from "./fips";

const SRC = "same-hl";
const ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("tbw-same-map") : null;
let clearT = 0;

export async function showCounties(fips: string[], label: string, color = "#ff3b30") {
  const map = mapRef.value;
  if (!map) {
    if (ch) {
      ch.postMessage({ fips, label, color });
      toast("Sent to the main window's map");
    } else toast("No map in this window", "warn");
    return;
  }
  const fc = await countyFeatures(fips.filter((f) => !/^(5[7-9]|6[15]|7[357]|9\d)/.test(f)));
  if (!fc.features.length) return toast("No county outlines for these codes (marine zones aren't bundled)", "warn");
  for (const f of fc.features) f.properties = { ...(f.properties ?? {}), label };
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (src) src.setData(fc);
  else {
    map.addSource(SRC, { type: "geojson", data: fc });
    map.addLayer({ id: "same-hl-fill", type: "fill", source: SRC, paint: { "fill-color": color, "fill-opacity": 0.22 } });
    map.addLayer({ id: "same-hl-line", type: "line", source: SRC, paint: { "line-color": color, "line-width": 2.4, "line-dasharray": [2, 1] } });
  }
  map.setPaintProperty("same-hl-fill", "fill-color", color);
  map.setPaintProperty("same-hl-line", "line-color", color);
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
  // fades away after 10 minutes
  clearTimeout(clearT);
  clearT = window.setTimeout(() => clearCounties(), 10 * 60000);
}

export function clearCounties() {
  const map = mapRef.value;
  if (!map) return ch?.postMessage({ clear: true });
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
}

if (ch)
  ch.onmessage = (e) => {
    if (!mapRef.value) return;
    if (e.data?.clear) clearCounties();
    else if (Array.isArray(e.data?.fips)) showCounties(e.data.fips, e.data.label, e.data.color);
  };
