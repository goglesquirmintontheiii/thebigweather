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
  source: "mrms" | "model" | "ndfd" | "metar" | "goes" | "future";
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
  /** which satellite menu entry lists it */
  sat: "19" | "18" | "himawari" | "meteosat" | "polar";
  layer: string;
  level: number;
  format: "png" | "jpg";
  /** minutes between images (1440 = daily) */
  step: number;
  /** imagery from a WMS (EUMETView) instead of NASA GIBS */
  wms?: string;
  attribution?: string;
}

const EUM = "https://view.eumetsat.int/geoserver/ows";
/** Imagery layers (no values): NASA GIBS (GOES, Himawari, polar/global) and EUMETSAT (Meteosat). */
export const GIBS: GibsLayer[] = [
  { id: "goes-east-geocolor", sat: "19", name: "GeoColor", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_GeoColor", level: 7, format: "png", step: 10 },
  { id: "goes-east-airmass", sat: "19", name: "Air Mass RGB", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_Air_Mass", level: 6, format: "png", step: 10 },
  { id: "goes-east-dust", sat: "19", name: "Dust RGB", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_Dust", level: 6, format: "png", step: 10 },
  { id: "goes-east-fire", sat: "19", name: "Fire Temperature RGB", group: "Satellite · GOES-19 (East) composites", layer: "GOES-East_ABI_FireTemp", level: 6, format: "png", step: 10 },
  { id: "goes-west-geocolor", sat: "18", name: "GeoColor", group: "Satellite · GOES-18 (West) composites", layer: "GOES-West_ABI_GeoColor", level: 7, format: "png", step: 10 },
  { id: "goes-west-airmass", sat: "18", name: "Air Mass RGB", group: "Satellite · GOES-18 (West) composites", layer: "GOES-West_ABI_Air_Mass", level: 6, format: "png", step: 10 },
  { id: "himawari-ir", sat: "himawari", name: "Band 13 · Clean IR", group: "Satellite · Himawari-9", layer: "Himawari_AHI_Band13_Clean_Infrared", level: 6, format: "png", step: 10 },
  { id: "himawari-vis", sat: "himawari", name: "Band 3 · Red Visible", group: "Satellite · Himawari-9", layer: "Himawari_AHI_Band3_Red_Visible_1km", level: 7, format: "png", step: 10 },
  { id: "himawari-airmass", sat: "himawari", name: "Air Mass RGB", group: "Satellite · Himawari-9", layer: "Himawari_AHI_Air_Mass", level: 6, format: "png", step: 10 },
  // Meteosat (EUMETSAT EUMETView WMS, keyless)
  { id: "mtg-geocolour", sat: "meteosat", name: "MTG GeoColour", group: "Satellite · Meteosat", layer: "mtg_fd:rgb_geocolour", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "mtg-truecolour", sat: "meteosat", name: "MTG True Colour", group: "Satellite · Meteosat", layer: "mtg_fd:rgb_truecolour", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "mtg-ir105", sat: "meteosat", name: "MTG IR 10.5 µm", group: "Satellite · Meteosat", layer: "mtg_fd:ir105_hrfi", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "mtg-vis06", sat: "meteosat", name: "MTG Visible 0.6 µm", group: "Satellite · Meteosat", layer: "mtg_fd:vis06_hrfi", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "mtg-dust", sat: "meteosat", name: "MTG Dust RGB", group: "Satellite · Meteosat", layer: "mtg_fd:rgb_dust", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "mtg-cloudphase", sat: "meteosat", name: "MTG Cloud Phase RGB", group: "Satellite · Meteosat", layer: "mtg_fd:rgb_cloudphase", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "mtg-fire", sat: "meteosat", name: "MTG Fire Temperature", group: "Satellite · Meteosat", layer: "mtg_fd:rgb_firetemperature", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "mtg-lightning", sat: "meteosat", name: "MTG Lightning (LI)", group: "Satellite · Meteosat", layer: "mtg_fd:li_afa", level: 9, format: "png", step: 10, wms: EUM, attribution: "EUMETSAT" },
  { id: "msg-airmass", sat: "meteosat", name: "MSG Air Mass", group: "Satellite · Meteosat", layer: "msg_fes:rgb_airmass", level: 9, format: "png", step: 15, wms: EUM, attribution: "EUMETSAT" },
  { id: "msg-convection", sat: "meteosat", name: "MSG Convection RGB", group: "Satellite · Meteosat", layer: "msg_fes:rgb_convection", level: 9, format: "png", step: 15, wms: EUM, attribution: "EUMETSAT" },
  { id: "msg-iodc-ir", sat: "meteosat", name: "MSG Indian Ocean IR", group: "Satellite · Meteosat", layer: "msg_iodc:ir108", level: 9, format: "png", step: 15, wms: EUM, attribution: "EUMETSAT" },
  // polar orbiters and global products (NASA GIBS)
  { id: "viirs-n20-true", sat: "polar", name: "VIIRS NOAA-20 True Color", group: "Satellite · Polar & global", layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor", level: 9, format: "jpg", step: 1440 },
  { id: "viirs-n21-true", sat: "polar", name: "VIIRS NOAA-21 True Color", group: "Satellite · Polar & global", layer: "VIIRS_NOAA21_CorrectedReflectance_TrueColor", level: 9, format: "jpg", step: 1440 },
  { id: "viirs-snpp-true", sat: "polar", name: "VIIRS Suomi NPP True Color", group: "Satellite · Polar & global", layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor", level: 9, format: "jpg", step: 1440 },
  { id: "modis-terra-true", sat: "polar", name: "MODIS Terra True Color", group: "Satellite · Polar & global", layer: "MODIS_Terra_CorrectedReflectance_TrueColor", level: 9, format: "jpg", step: 1440 },
  { id: "viirs-dnb", sat: "polar", name: "VIIRS Day/Night Band", group: "Satellite · Polar & global", layer: "VIIRS_SNPP_DayNightBand_At_Sensor_Radiance", level: 8, format: "png", step: 1440 },
  { id: "imerg", sat: "polar", name: "GPM IMERG Precip Rate", group: "Satellite · Polar & global", layer: "IMERG_Precipitation_Rate", level: 6, format: "png", step: 30 },
  { id: "aod", sat: "polar", name: "Aerosol Optical Depth (MODIS)", group: "Satellite · Polar & global", layer: "MODIS_Combined_Value_Added_AOD", level: 6, format: "png", step: 1440 },
  { id: "omps-ai", sat: "polar", name: "Aerosol Index (OMPS)", group: "Satellite · Polar & global", layer: "OMPS_Aerosol_Index", level: 6, format: "png", step: 1440 },
  { id: "sst-mur", sat: "polar", name: "Sea Surface Temp (MUR)", group: "Satellite · Polar & global", layer: "GHRSST_L4_MUR_Sea_Surface_Temperature", level: 7, format: "png", step: 1440 },
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
