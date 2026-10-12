// radar 0.6: overlay catalog entries for the Level II analysis layers (Severe group).
// Imported once from App.tsx after overlays/moredefs.

import { OVERLAYS, overlayDef, type OverlayDef } from "../overlays/defs";
import { tdsLayers, tdsClick } from "./tds";
import { hailLayers, hailClick, swathLayers, swathSource } from "./hail";
import { rotTrackLayers, rotTrackClick } from "./rottracks";
import "./lightning";

/** rasterTop: drawn above the radar picture (manager.ts) */
const defs: (OverlayDef & { rasterTop?: boolean })[] = [
  {
    id: "tds",
    name: "Debris signatures (TDS)",
    group: "Severe",
    feed: "client",
    refresh: 0,
    options: [
      { key: "cc", label: "CC below", choices: [["0.7", "0.70"], ["0.75", "0.75"], ["0.8", "0.80"], ["0.85", "0.85"]], def: "0.8" },
      { key: "couplet", label: "Couplet", choices: [["1", "Required (within 2 km)"], ["0", "Not required"]], def: "1" },
    ],
    rasterTop: true,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => tdsLayers(s, st),
    click: (p) => tdsClick(p),
    note: "Level II, lowest two tilts: CC < 0.80, ZDR within ±1 dB and ≥ 35 dBZ next to a velocity couplet. Computed in the app for the frame on screen.",
  },
  {
    id: "hail",
    name: "Hail (dual-pol)",
    group: "Severe",
    feed: "client",
    refresh: 0,
    rasterTop: true,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => hailLayers(s, st),
    click: (p) => hailClick(p),
    note: "Hail size classes (HSDA-style fuzzy logic on Z, ZDR, CC vs the melting level) at the lowest tilt, per storm, with MESH from the whole volume. Green < 1 in, yellow 1–2 in, red > 2 in.",
  },
  {
    id: "hailswath",
    name: "Hail swath (loop)",
    group: "Severe",
    feed: "client",
    refresh: 0,
    rasterTop: true,
    options: [{ key: "span", label: "Accumulate", choices: [["loop", "Whole loop"], ["upto", "Up to the frame on screen"]], def: "loop" }],
    style: { opacity: 1 },
    raster: () => swathSource(),
    layers: (s, st) => swathLayers(s, st),
    note: "Maximum MESH over the loop's Level II volumes (~1 km cells). Loads every tilt of every volume, so it takes a while on long loops.",
  },
  {
    id: "rottracks",
    name: "Rotation tracks (loop)",
    group: "Severe",
    feed: "client",
    refresh: 0,
    options: [{ key: "min", label: "Minimum", choices: [["weak", "Weak"], ["meso", "Meso"], ["tvs", "TVS"]], def: "meso" }],
    rasterTop: true,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => rotTrackLayers(s, st),
    click: (p) => rotTrackClick(p),
    note: "The rotation detector run on every volume of the loop, linked into tracks (≤ 10 km per 5 min). Colour = rotational velocity: yellow 10, orange 15, red 20, magenta 30+ m/s.",
  },
];

if (!overlayDef("tds")) {
  let i = OVERLAYS.findIndex((o) => o.id === "rotscan");
  if (i < 0) i = OVERLAYS.reduce((a, o, k) => (o.group === "Severe" ? k : a), OVERLAYS.length - 1);
  OVERLAYS.splice(i + 1, 0, ...defs);
}

// console / automated screenshots
import { reload, frames, frameIndex, currentFrame } from "./controller";
import { settings, update } from "../store";
import { tdsHits } from "./tds";
import { hailCells, swathInfo } from "./hail";
import { rotTracks } from "./rottracks";
import { dealiasState } from "./dealias";
import { inspData } from "./inspector";
import { hover } from "../map/mapview";
(window as any).__tbwR6 = { reload, frames, frameIndex, currentFrame, settings, update, tdsHits, hailCells, swathInfo, rotTracks, dealiasState, inspData, hover };
