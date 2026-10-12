// workflow 0.6: map-side hooks — GeoJSON layers that survive basemap changes (route weather,
// storm intercept, offline-region box, plugins), terrain/hillshade, and the precip-type effect.

import type { Map as MLMap, LayerSpecification, GeoJSONSource } from "maplibre-gl";
import { effect } from "@preact/signals";
import { settings } from "../store";
import { applyTerrain, isDarkBasemap } from "./basemaps";
import { attachPrecipFx } from "../fx/precip";

interface GeoDef {
  data: any;
  layers: LayerSpecification[];
}
const defs = new Map<string, GeoDef>();
let map: MLMap | null = null;

function add(id: string, d: GeoDef) {
  if (!map || !map.style) return;
  try {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: d.data });
    else (map.getSource(id) as GeoJSONSource).setData(d.data);
    for (const l of d.layers) if (!map.getLayer(l.id)) map.addLayer(l);
  } catch {
    /* style still loading: re-added on style.load */
  }
}
function remove(id: string, d: GeoDef) {
  if (!map || !map.style) return;
  for (const l of d.layers) if (map.getLayer(l.id)) map.removeLayer(l.id);
  if (map.getSource(id)) map.removeSource(id);
}

/** Show (or update) a GeoJSON source with its layers; kept across basemap/style changes. */
export function setGeo(id: string, data: any, layers?: LayerSpecification[]) {
  const old = defs.get(id);
  const d: GeoDef = { data, layers: layers ?? old?.layers ?? [] };
  if (old && layers && JSON.stringify(old.layers) !== JSON.stringify(layers)) remove(id, old);
  defs.set(id, d);
  add(id, d);
}
export function removeGeo(id: string) {
  const d = defs.get(id);
  if (!d) return;
  defs.delete(id);
  remove(id, d);
}

export function attachWf6(m: MLMap) {
  map = m;
  const terrain = () => applyTerrain(m, settings.value.wf6.terrain, isDarkBasemap(settings.value.basemap, settings.value.customBasemaps));
  m.on("style.load", () => {
    for (const [id, d] of defs) add(id, d);
    terrain();
  });
  effect(() => {
    void settings.value.wf6.terrain;
    void settings.value.basemap;
    if (m.isStyleLoaded() || m.getLayer("ovl-states")) terrain();
  });
  attachPrecipFx(m);
}

export const wf6Map = () => map;
