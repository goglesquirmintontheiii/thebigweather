// Catalog of weather layers (radar + gridded + imagery) and the active-layer description.

import { signal, computed, effect } from "@preact/signals";
import { api } from "./api";
import { settings, update, type WeatherSel } from "./store";
import { BUILTIN } from "./radar/colormaps";
import { intlName, intlRegion, intlSource } from "./intl/radar"; // intl & forecast tools

export interface GridLayerDef {
  id: string;
  group: string;
  name: string;
  units: string;
  cmap: string;
  source: "mrms" | "model" | "ndfd" | "metar" | "goes" | "future" | "opera" | "cwa" | "nowcast" /* data 0.6 */ | "mlpred" /* models 0.7: my models' predictions */;
  model?: string;
  step_min: number;
  /** data 0.8: extra request parameters (ensembles: thr = threshold in `units`, with presets) */
  params?: { thr?: { units?: string; presets?: number[]; default?: number; def?: number; op?: string } } & Record<string, any>;
  /** data 0.8: suggested contour interval / base (severe + ensemble layers) */
  contour?: { interval: number; base?: number };
}
/** data 0.8: server catalog composites (a fill layer + contour overlays of sibling layers) */
export interface GridComposite {
  id: string;
  name: string;
  fill: string;
  contours: { layer: string; interval?: number; base?: number }[];
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
  // data 0.6: marine
  { id: "sst-anom", sat: "polar", name: "SST Anomaly (MUR)", group: "Satellite · Polar & global", layer: "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies", level: 7, format: "png", step: 1440 },
];

export const gridLayers = signal<GridLayerDef[]>([]);
export const models = signal<ModelInfo[]>([]);
export const gridComposites = signal<GridComposite[]>([]); // data 0.8

api.on("connected", async () => {
  try {
    const c = await api.get("/api/grid/catalog");
    gridLayers.value = c.layers;
    models.value = c.models;
    gridComposites.value = Array.isArray(c.composites) ? c.composites : []; // data 0.8
  } catch (e) {
    console.warn("grid catalog:", e); // older server
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
  if (w.kind === "intl") return { title: intlName(w.id), group: `World radar · ${intlRegion(w.id, intlSource(w.id)?.region)}` };
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

/* ---------- data 0.6 ---------- */
/** catalog layers that are forecasts (models, NDFD, future radar, nowcasts) */
export function isForecastDef(d: GridLayerDef | undefined): boolean {
  return !!d && (d.source === "model" || d.source === "ndfd" || d.source === "future" || d.source === "nowcast" || d.source === "mlpred" /* models 0.7 */);
}
/** marine / hydrology layers (GFS-Wave, RTOFS, MRMS FLASH, NWM): the picker's "Water" tab */
export function isWaterDef(d: GridLayerDef): boolean {
  const g = d.group.toLowerCase();
  return /flood|flash|hydro|marine|wave|ocean|sea/.test(g) || /^model\/(gfswave|ww3|rtofs|gwes)\//.test(d.id) || d.model === "gfswave";
}
/* ---------- end data 0.6 ---------- */

/* ---------- data 0.8: ensemble probability + severe parameter layers ---------- */
export const isEnsId = (id: string) => id.startsWith("ens/");
export const isSvrId = (id: string) => id.startsWith("svr/");
/** threshold spec of an ensemble layer (server units); a default when the catalog gives none */
export function thrSpec(d: GridLayerDef | undefined): { units: string; presets: number[]; op: string } | null {
  // only probability layers (ens/<model>/<var>/prob|proble) take a threshold; mean / spread / min / max don't
  if (!d || !isEnsId(d.id) || !d.params?.thr) return null;
  const t = d.params.thr;
  const op0 = String(t.op ?? d.id.split("/")[3] ?? "gt");
  const op = op0 === "prob" ? "ge" : op0 === "proble" ? "le" : op0;
  const presets = Array.isArray(t.presets) ? t.presets.map(Number).filter(Number.isFinite) : [];
  return { units: String(t.units ?? d.units ?? ""), presets, op };
}
/** threshold in use for the layer on screen (server units), or null */
export function ensThr(sel: WeatherSel = settings.value.weather): number | null {
  if (sel.kind !== "grid" || !isEnsId(sel.id)) return null;
  if (sel.thr != null && Number.isFinite(sel.thr)) return sel.thr;
  const sp = thrSpec(gridDef(sel.id));
  const t0 = gridDef(sel.id)?.params?.thr;
  if (!t0) return null; // not a probability layer
  const d = t0.default ?? t0.def;
  const saved = settings.value.p8?.thr?.[sel.id];
  return saved ?? (d != null ? +d : sp?.presets[Math.floor(sp.presets.length / 2)] ?? null);
}
/** extra query string for grid requests (frames / render / value / export): "&thr=…" */
export function gridExtraQ(sel: WeatherSel = settings.value.weather): string {
  const t = ensThr(sel);
  return t == null ? "" : `&thr=${encodeURIComponent(String(t))}`;
}
export function setEnsThr(v: number) {
  update((s) => {
    if (s.weather.kind !== "grid" || !isEnsId(s.weather.id)) return;
    s.weather = { ...s.weather, thr: v };
    s.p8 = { ...(s.p8 ?? {}), thr: { ...(s.p8?.thr ?? {}), [s.weather.id]: v } };
  });
}
/** colour table for a severe parameter / fog / ensemble layer whose catalog cmap we don't have */
export function p8Cmap(d: GridLayerDef): string | null {
  const v = d.id.split("/").pop()!.toLowerCase();
  if (isEnsId(d.id)) return BUILTIN[d.cmap] && d.cmap !== "PROB" ? null : "ENSPROB";
  if (/^goes\/.*\/fog$/.test(d.id) || v === "fog") return BUILTIN[d.cmap] ? null : "FOG";
  if (!isSvrId(d.id) || (BUILTIN[d.cmap] && d.cmap !== "REF")) return null;
  const m: [RegExp, string][] = [[/dcape/, "DCAPE"], [/stp/, "STP"], [/scp/, "SCP"], [/ship/, "SHIP"], [/srh|helic/, "SRH"], [/shr|shear|bwd/, "SHEAR"], [/cin/, "CIN"], [/cape/, "CAPE"], [/lcl/, "LCL"], [/lapse|lr\d|_lr/, "LAPSE"], [/pwat|pw$/, "PWAT"], [/theta|thte|^te/, "THETAE"]];
  return m.find(([r]) => r.test(v))?.[1] ?? null;
}
/** ensemble layers draw probability (%): the catalog's own units belong to the threshold */
const ensUnitsFix = (d: GridLayerDef) => isEnsId(d.id) && !!d.params?.thr && d.units !== "%";
effect(() => {
  const ls = gridLayers.value;
  if (!ls.some((d) => p8Cmap(d) || ensUnitsFix(d))) return;
  gridLayers.value = ls.map((d) => {
    const c = p8Cmap(d);
    let n = c ? { ...d, cmap: c } : d;
    if (ensUnitsFix(n)) n = { ...n, units: "%", params: { ...(n.params ?? {}), thr: { ...(n.params?.thr ?? {}), units: n.params?.thr?.units ?? n.units } } };
    return n;
  });
});
/* ---------- end data 0.8 ---------- */

// screenshot / console handle (intl & forecast tools)
(window as any).__tbwWeather = { gridLayers };
