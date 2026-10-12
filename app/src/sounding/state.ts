// Sounding window state and data (server: /api/sounding, /api/sounding/stations).

import { signal } from "@preact/signals";
import { api } from "../api";

export type SndModel = "hrrr" | "gfs" | "ecmwf";
export interface SndReq {
  lat: number;
  lon: number;
  src: "model" | "raob";
  model: SndModel;
  station?: string;
  /** model forecast hour (ISO valid time) */
  hour?: string;
  /** RAOB launch time (ms); undefined = latest */
  time?: number;
}
export interface SndData {
  src: string;
  station?: string;
  name?: string;
  lat: number;
  lon: number;
  time: number | string;
  model?: string;
  hours?: string[];
  levels: any[];
}

export const soundingReq = signal<SndReq | null>(null);
/** RAOB stations on the main map */
export const showStations = signal(false);
export const raobStations = signal<any | null>(null);

export function openSounding(lat: number, lon: number, o: Partial<SndReq> = {}) {
  const prev = soundingReq.value;
  soundingReq.value = { lat, lon, src: o.src ?? "model", model: o.model ?? prev?.model ?? "hrrr", station: o.station, hour: o.hour, time: o.time };
}

let stP: Promise<any> | null = null;
export function loadStations(): Promise<any> {
  if (raobStations.value) return Promise.resolve(raobStations.value);
  if (!stP)
    stP = api
      .get("/api/sounding/stations")
      .then((v) => (raobStations.value = v))
      .catch((e) => {
        stP = null;
        throw e;
      });
  return stP;
}

export function soundingUrl(r: SndReq): string {
  const q = new URLSearchParams({ lat: r.lat.toFixed(3), lon: r.lon.toFixed(3), src: r.src });
  if (r.src === "model") {
    q.set("model", r.model);
    if (r.hour) q.set("hour", r.hour);
  } else {
    if (r.station) q.set("station", r.station);
    if (r.time) q.set("time", String(r.time));
  }
  return `/api/sounding?${q}`;
}

// screenshot / console handle
(window as any).__tbwSnd = { openSounding, soundingReq, showStations };
