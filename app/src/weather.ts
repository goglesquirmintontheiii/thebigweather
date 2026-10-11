// Catalog of weather layers (radar + gridded + imagery) and the active-layer description.

import { signal, computed } from "@preact/signals";
import { api } from "./api";
import { settings, update, type WeatherSel } from "./store";
import { BUILTIN } from "./radar/colormaps";

export interface GridLayerDef {
  id: string;
  group: string;
  name: string;
  units: string;
  cmap: string;
  source: "mrms" | "model" | "ndfd" | "metar" | "goes";
  model?: string;
  step_min: number;
}
export interface ModelInfo {
  id: string;
  name: string;
  group: string;
  resolution: string;
}

export interface GibsLayer {
  id: string;
  name: string;
  group: string;
  layer: string;
  level: number;
  format: "png" | "jpg";
  /** minutes between images */
  step: number;
}

/** NASA GIBS composites (imagery only, no values) — GeoColor, Air Mass, Himawari. */
export const GIBS: GibsLayer[] = [
  { id: "goes-east-geocolor", name: "GeoColor", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_GeoColor_v0_NRT", level: 7, format: "png", step: 10 },
  { id: "goes-east-airmass", name: "Air Mass RGB", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_Air_Mass_v0_NRT", level: 7, format: "png", step: 10 },
  { id: "goes-east-dust", name: "Dust RGB", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_Dust_v0_NRT", level: 7, format: "png", step: 10 },
  { id: "goes-east-fire", name: "Fire Temperature RGB", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_FireTemp_v0_NRT", level: 7, format: "png", step: 10 },
  { id: "goes-west-geocolor", name: "GeoColor", group: "Satellite · GOES-18 (West) composites", layer: "GOES-West_ABI_GeoColor_v0_NRT", level: 7, format: "png", step: 10 },
  { id: "goes-west-airmass", name: "Air Mass RGB", group: "Satellite · GOES-18 (West) composites", layer: "GOES-West_ABI_Air_Mass_v0_NRT", level: 7, format: "png", step: 10 },
  { id: "himawari-ir", name: "Band 13 · Clean IR", group: "Satellite · Himawari-9", layer: "Himawari_AHI_Band13_Clean_Infrared_v0_NRT", level: 7, format: "png", step: 10 },
  { id: "himawari-vis", name: "Band 3 · Red Visible", group: "Satellite · Himawari-9", layer: "Himawari_AHI_Band3_Red_Visible_1km_v0_NRT", level: 8, format: "png", step: 10 },
  { id: "himawari-airmass", name: "Air Mass RGB", group: "Satellite · Himawari-9", layer: "Himawari_AHI_Air_Mass_v0_NRT", level: 7, format: "png", step: 10 },
];

export const gridLayers = signal<GridLayerDef[]>([]);
export const models = signal<ModelInfo[]>([]);

api.on("connected", async () => {
  try {
    const c = await api.get("/api/grid/catalog");
    gridLayers.value = c.layers;
    models.value = c.models;
  } catch {
    /* older server */
  }
});

export function gridDef(id: string): GridLayerDef | undefined {
  return gridLayers.value.find((l) => l.id === id);
}

/** Short label for the active weather layer. */
export const activeLabel = computed(() => {
  const w = settings.value.weather;
  if (w.kind === "radar") return { title: settings.value.radar.source === "L2" ? "Level II" : "Level III", group: `Radar · ${settings.value.radar.site}` };
  if (w.kind === "gibs") {
    const g = GIBS.find((x) => x.id === w.id);
    return { title: g?.name ?? w.id, group: g?.group.replace("Satellite · ", "") ?? "Satellite" };
  }
  const d = gridDef(w.id);
  return { title: d?.name ?? w.id, group: d?.group ?? "" };
});

export function selectWeather(sel: WeatherSel) {
  update((s) => {
    s.weather = sel;
  });
}

/** Color table for a gridded layer (users can override per cmap like radar). */
export function gridTable(cmap: string) {
  return BUILTIN[cmap] ?? BUILTIN.REF;
}
