// data 0.8: auto-saved chase logs — the GPS track (gps.ts), map/radar snapshots every N minutes and
// photos added from a file picker or by dropping them on the Chaser panel. Metadata in localStorage,
// images in IndexedDB (idb-keyval). Export: one .zip with GPX, JSON and the PNG/JPEG files.

import { signal, effect } from "@preact/signals";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { zipSync, strToU8 } from "fflate";
import { toast, uid, settings } from "../store";
import { mapRef } from "../map/mapview";
import { fix, recording, startTrack, stopTrack, toGpx, type TrkPt } from "../gps";
import { saveFile, stamp } from "../saveio";
import { C8 } from "./chase";

export interface ChaseImg {
  key: string;
  t: number;
  name: string;
  lat?: number;
  lon?: number;
  kind: "snap" | "photo";
  mime: string;
  bytes: number;
}
export interface ChaseLog {
  id: string;
  name: string;
  start: number;
  end: number;
  pts: TrkPt[];
  imgs: ChaseImg[];
  notes: { t: number; text: string; lat?: number; lon?: number }[];
}

const KEY = "tbw.chaselogs.v1";
function load(): ChaseLog[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
export const chaseLogs = signal<ChaseLog[]>(load());
export const activeLog = signal<string | null>(null);
effect(() => {
  const v = chaseLogs.value;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    toast("Chase log storage full — export and delete old logs", "warn");
  }
});

function patch(id: string, fn: (l: ChaseLog) => void) {
  chaseLogs.value = chaseLogs.value.map((l) => {
    if (l.id !== id) return l;
    const n = { ...l, imgs: [...l.imgs], notes: [...l.notes] };
    fn(n);
    return n;
  });
}
export const logById = (id: string | null) => chaseLogs.value.find((l) => l.id === id) ?? null;

let snapTimer: number | undefined;
let syncTimer: number | undefined;
export function startChaseLog() {
  if (activeLog.value) return;
  const l: ChaseLog = { id: uid(), name: `Chase ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, start: Date.now(), end: Date.now(), pts: [], imgs: [], notes: [] };
  chaseLogs.value = [l, ...chaseLogs.value];
  activeLog.value = l.id;
  if (!recording.value) startTrack();
  // copy the live GPS track into the log every 20 s (autosave)
  syncTimer = window.setInterval(syncTrack, 20_000);
  armSnaps();
  setTimeout(() => snapshot(), 1500);
  toast("Chase log started: GPS track + radar snapshots are saved automatically");
}
function armSnaps() {
  clearInterval(snapTimer);
  const min = Math.max(1, C8().snapMin || 5);
  snapTimer = window.setInterval(() => snapshot(), min * 60_000);
}
effect(() => {
  void settings.value.p8?.chase?.snapMin;
  if (activeLog.value) armSnaps();
});
function syncTrack() {
  const id = activeLog.value;
  const r = recording.value;
  if (!id) return;
  patch(id, (l) => {
    if (r && r.pts.length >= l.pts.length) l.pts = r.pts.slice();
    l.end = Date.now();
  });
}
export function stopChaseLog() {
  const id = activeLog.value;
  if (!id) return;
  syncTrack();
  clearInterval(snapTimer);
  clearInterval(syncTimer);
  activeLog.value = null;
  if (recording.value) stopTrack(true);
  const l = logById(id);
  toast(`Saved ${l?.name ?? "chase log"} (${l?.pts.length ?? 0} GPS points, ${l?.imgs.length ?? 0} images)`);
}

/** PNG of the map canvas (radar, overlays and all) */
export function captureMap(): Promise<Blob | null> {
  const m = mapRef.value;
  if (!m) return Promise.resolve(null);
  return new Promise((res) => {
    m.once("render", () => m.getCanvas().toBlob((b) => res(b), "image/png"));
    m.triggerRepaint();
    setTimeout(() => res(null), 4000);
  });
}
export async function snapshot(logId = activeLog.value): Promise<boolean> {
  if (!logId) return false;
  const b = await captureMap();
  if (!b) return false;
  const key = `chase:${logId}:${uid()}`;
  await idbSet(key, b);
  const f = fix.value;
  const t = Date.now();
  patch(logId, (l) => l.imgs.push({ key, t, name: `radar_${new Date(t).toISOString().slice(11, 19).replace(/:/g, "")}.png`, lat: f?.lat, lon: f?.lon, kind: "snap", mime: "image/png", bytes: b.size }));
  return true;
}
export async function addPhotos(files: File[], logId = activeLog.value ?? chaseLogs.value[0]?.id) {
  if (!logId) {
    toast("Start a chase log first", "warn");
    return;
  }
  let n = 0;
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    const key = `chase:${logId}:${uid()}`;
    await idbSet(key, f);
    const fx = fix.value;
    patch(logId, (l) => l.imgs.push({ key, t: f.lastModified || Date.now(), name: f.name, lat: fx?.lat, lon: fx?.lon, kind: "photo", mime: f.type, bytes: f.size }));
    n++;
  }
  if (n) toast(`Added ${n} photo${n > 1 ? "s" : ""} to the chase log`);
}
export function addNote(text: string, logId = activeLog.value) {
  if (!logId || !text.trim()) return;
  const f = fix.value;
  patch(logId, (l) => l.notes.push({ t: Date.now(), text: text.trim(), lat: f?.lat, lon: f?.lon }));
}
export async function imgUrl(key: string): Promise<string | null> {
  const b = await idbGet(key);
  return b instanceof Blob ? URL.createObjectURL(b) : null;
}
export async function deleteLog(id: string) {
  const l = logById(id);
  if (id === activeLog.value) stopChaseLog();
  for (const i of l?.imgs ?? []) await idbDel(i.key).catch(() => {});
  chaseLogs.value = chaseLogs.value.filter((x) => x.id !== id);
}

/** .zip: track.gpx, log.json (track, notes, image index) and the images */
export async function exportLog(id: string) {
  if (id === activeLog.value) syncTrack();
  const l = logById(id);
  if (!l) return;
  const files: Record<string, Uint8Array> = {};
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
  if (l.pts.length) files["track.gpx"] = strToU8(toGpx({ id: l.id, name: l.name, start: l.start, end: l.end, pts: l.pts }));
  const index: any[] = [];
  const used = new Set<string>();
  for (const i of l.imgs) {
    const b = await idbGet(i.key).catch(() => null);
    if (!(b instanceof Blob)) continue;
    let name = `${i.kind === "snap" ? "snapshots" : "photos"}/${safe(i.name)}`;
    for (let k = 2; used.has(name); k++) name = name.replace(/(\.\w+)?$/, `_${k}$1`);
    used.add(name);
    files[name] = new Uint8Array(await b.arrayBuffer());
    index.push({ file: name, time: new Date(i.t).toISOString(), lat: i.lat, lon: i.lon, kind: i.kind });
  }
  files["log.json"] = strToU8(JSON.stringify({ name: l.name, start: new Date(l.start).toISOString(), end: new Date(l.end).toISOString(), points: l.pts.map((p) => ({ lon: p[0], lat: p[1], time: new Date(p[2]).toISOString(), acc_m: p[3] })), notes: l.notes.map((n) => ({ ...n, time: new Date(n.t).toISOString() })), images: index, app: "TheBigWeather" }, null, 1));
  const zip = zipSync(files, { level: 0 });
  const f = await saveFile(`${safe(l.name)}_${stamp()}.zip`, zip, "application/zip");
  if (f) toast(`Saved ${f}`);
}
