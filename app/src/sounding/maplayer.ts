// RAOB stations on the main map (toggled from the Sounding window): click one to open its sounding.

import { effect } from "@preact/signals";
import type { Map as MLMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import { showStations, raobStations, loadStations, openSounding } from "./state";
import { toast } from "../store";

const SRC = "snd-stations";
const EMPTY = { type: "FeatureCollection", features: [] } as any;

function ensure(m: MLMap) {
  if (!m.getStyle()) return;
  if (!m.getSource(SRC)) m.addSource(SRC, { type: "geojson", data: raobStations.value ?? EMPTY });
  if (!m.getLayer(`${SRC}-pt`)) {
    m.addLayer({ id: `${SRC}-pt`, type: "circle", source: SRC, paint: { "circle-radius": 5, "circle-color": "#a78bfa", "circle-stroke-color": "#0b0f17", "circle-stroke-width": 1.5 } });
    m.addLayer({
      id: `${SRC}-lbl`,
      type: "symbol",
      source: SRC,
      minzoom: 4,
      layout: { "text-field": ["coalesce", ["get", "id"], ""], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-offset": [0, 1.1], "text-anchor": "top" },
      paint: { "text-color": "#e9ddff", "text-halo-color": "#000", "text-halo-width": 1.2 },
    });
  }
  const vis = showStations.value ? "visible" : "none";
  m.setLayoutProperty(`${SRC}-pt`, "visibility", vis);
  m.setLayoutProperty(`${SRC}-lbl`, "visibility", vis);
}

export function attachSoundingMap(m: MLMap, clickHooks?: ((e: MapMouseEvent) => boolean)[]) {
  m.on("style.load", () => ensure(m));
  const onClick = (e: MapMouseEvent) => {
    if (!showStations.value || !m.getLayer(`${SRC}-pt`)) return false;
    const f = m.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: [`${SRC}-pt`] })[0];
    if (!f) return false;
    const [lon, lat] = (f.geometry as any).coordinates;
    openSounding(lat, lon, { src: "raob", station: String(f.properties?.id ?? "") });
    return true;
  };
  if (clickHooks) clickHooks.push(onClick);
  else m.on("click", `${SRC}-pt`, (e) => onClick(e));
  m.on("mouseenter", `${SRC}-pt`, () => (m.getCanvas().style.cursor = "pointer"));
  m.on("mouseleave", `${SRC}-pt`, () => (m.getCanvas().style.cursor = ""));
  effect(() => {
    void showStations.value;
    const data = raobStations.value;
    if (showStations.value && !data) loadStations().catch((e) => toast(`Sounding stations: ${e.message}`, "warn"));
    if (!m.isStyleLoaded() && !m.getSource(SRC)) {
      m.once("idle", () => ensure(m));
      return;
    }
    ensure(m);
    (m.getSource(SRC) as GeoJSONSource | undefined)?.setData(data ?? EMPTY);
  });
}
