// Live collaboration ("Team"): one WebSocket per member to /api/collab/ws on the active server.
// Shares drawings (as GeoJSON per drawing group), member positions, pins, notes and the map
// view ("follow me"). Team content is drawn in its own map layers; copying a team drawing puts
// it into your own drawings.

import { signal, effect, computed } from "@preact/signals";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { api } from "../api";
import { toast, uid } from "../store";
import { mapRef } from "../map/mapview";
import { drawings } from "../map/draw";
import { drawingsToGeoJSON, geoJSONToDrawings, groupDrawings, renderable } from "./geo";

export interface Member {
  id: string;
  name: string;
  color: string;
  joined: number;
  pos?: { lat: number; lon: number; t: number; heading?: number; speed?: number } | null;
  view?: { center: [number, number]; zoom: number; bearing?: number; pitch?: number; t: number } | null;
}
export interface TeamDrawing {
  group: string;
  name: string;
  by: string;
  by_name: string;
  color: string;
  geojson: any;
  t: number;
}
export interface Pin {
  id: string;
  lat: number;
  lon: number;
  text: string;
  color: string;
  by: string;
  by_name: string;
  t: number;
}
export interface Note {
  id: string;
  text: string;
  by: string;
  by_name: string;
  color: string;
  t: number;
  lat?: number;
  lon?: number;
}

export const teamOpen = signal(false);
export const team = signal<{ code: string; name: string } | null>(null);
export const teamStatus = signal<"off" | "connecting" | "online" | "error">("off");
export const teamError = signal<string>("");
export const me = signal<string>("");
export const members = signal<Record<string, Member>>({});
export const teamDrawings = signal<Record<string, TeamDrawing>>({});
export const pins = signal<Pin[]>([]);
export const notes = signal<Note[]>([]);
export const following = signal<string | null>(null);
export const unread = signal(0);
/** placing a pin: the text waits for the next map click */
export const pinDraft = signal<string | null>(null);

const PREF_KEY = "tbw.team";
type Prefs = { name: string; color: string; room: string; pos: "off" | "gps" | "center"; shareView: boolean; shareDraw: boolean };
function loadPrefs(): Prefs {
  const d: Prefs = { name: "", color: "#3fb7ff", room: "", pos: "off", shareView: true, shareDraw: false };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") };
  } catch {
    return d;
  }
}
export const prefs = signal<Prefs>(loadPrefs());
export function setPrefs(p: Partial<Prefs>) {
  prefs.value = { ...prefs.value, ...p };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs.value));
  } catch {
    /* */
  }
}

export const memberList = computed(() => Object.values(members.value).sort((a, b) => (a.id === me.value ? -1 : b.id === me.value ? 1 : a.joined - b.joined)));

// ---------- REST ----------

export const listRooms = () => api.get<any[]>("/api/collab/rooms");
export async function createRoom(name: string) {
  return api.send<{ code: string; name: string }>("POST", "/api/collab/rooms", { name });
}
export async function deleteRoom(code: string) {
  return api.send("DELETE", `/api/collab/rooms/${encodeURIComponent(code)}`, {});
}

// ---------- socket ----------

let ws: WebSocket | null = null;
let retry = 0;
let retryTimer: number | undefined;
let wanted: string | null = null;

function send(m: any) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

export function join(code: string) {
  code = code.trim().toUpperCase();
  if (!code) return;
  wanted = code;
  setPrefs({ room: code });
  connect();
}

export function leave(forget = false) {
  wanted = null;
  if (forget) setPrefs({ room: "" });
  clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  stopPos();
  team.value = null;
  teamStatus.value = "off";
  members.value = {};
  teamDrawings.value = {};
  pins.value = [];
  notes.value = [];
  following.value = null;
  sentGroups.clear();
  renderTeam();
}

function connect() {
  clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  if (!wanted || !api.base) return;
  const p = prefs.value;
  teamStatus.value = "connecting";
  const q = new URLSearchParams({ room: wanted, name: p.name || "Chaser", color: p.color, token: api.token });
  const sock = new WebSocket(api.base.replace(/^http/, "ws") + "/api/collab/ws?" + q.toString());
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    retry = 0;
    teamStatus.value = "online";
    teamError.value = "";
    sentGroups.clear();
    startPos();
    pushDrawings();
  };
  sock.onmessage = (e) => {
    try {
      onMsg(JSON.parse(e.data));
    } catch {
      /* */
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (!opened) {
      // the server refuses unknown rooms before the upgrade: check why once
      listRooms()
        .then((rs) => {
          if (!rs.some((r) => r.code === wanted)) {
            teamError.value = `No room ${wanted} on this server`;
            setPrefs({ room: "" });
            leave();
          }
        })
        .catch(() => {});
    }
    if (!wanted) return;
    teamStatus.value = "connecting";
    retryTimer = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };
}

function onMsg(m: any) {
  switch (m.type) {
    case "state": {
      team.value = { code: m.room.code, name: m.room.name };
      me.value = m.you;
      members.value = Object.fromEntries((m.members as Member[]).map((x) => [x.id, x]));
      teamDrawings.value = Object.fromEntries((m.drawings as TeamDrawing[]).map((d) => [d.group, d]));
      pins.value = m.pins ?? [];
      notes.value = m.notes ?? [];
      break;
    }
    case "member":
      members.value = { ...members.value, [m.member.id]: { ...members.value[m.member.id], ...m.member } };
      break;
    case "leave": {
      const { [m.id]: _gone, ...rest } = members.value;
      members.value = rest;
      if (following.value === m.id) following.value = null;
      break;
    }
    case "pos":
      if (members.value[m.id]) members.value = { ...members.value, [m.id]: { ...members.value[m.id], pos: m.pos } };
      break;
    case "view":
      if (members.value[m.id]) members.value = { ...members.value, [m.id]: { ...members.value[m.id], view: m.view } };
      if (following.value === m.id && m.view) mapRef.value?.easeTo({ center: m.view.center, zoom: m.view.zoom, bearing: m.view.bearing ?? 0, pitch: m.view.pitch ?? 0, duration: 600 });
      break;
    case "draw":
      teamDrawings.value = { ...teamDrawings.value, [m.drawing.group]: m.drawing };
      break;
    case "draw_del": {
      const { [m.group]: _gone, ...rest } = teamDrawings.value;
      teamDrawings.value = rest;
      break;
    }
    case "pin":
      pins.value = [...pins.value.filter((p) => p.id !== m.pin.id), m.pin];
      break;
    case "pin_del":
      pins.value = pins.value.filter((p) => p.id !== m.id);
      break;
    case "note":
      notes.value = [...notes.value, m.note].slice(-300);
      if (m.note.by !== me.value) {
        if (!teamOpen.value) unread.value++;
        toast(`${m.note.by_name}: ${m.note.text.slice(0, 120)}`, "info", 6000);
      }
      break;
    case "closed":
      toast("The team room was closed", "warn");
      leave();
      break;
    case "error":
      teamError.value = m.error;
      toast(`Team: ${m.error}`, "warn");
      break;
  }
}

// ---------- actions ----------

export function rename(name: string, color: string) {
  setPrefs({ name, color });
  send({ type: "hello", name, color });
}

export function addNote(text: string, atCenter: boolean) {
  const c = atCenter ? mapRef.value?.getCenter() : null;
  send({ type: "note", text, ...(c ? { lat: c.lat, lon: c.lng } : {}) });
}

export function placePin(lng: number, lat: number, text: string) {
  send({ type: "pin", lat, lon: lng, text, color: prefs.value.color });
}
export const deletePin = (id: string) => send({ type: "pin_del", id });

export function follow(id: string | null) {
  following.value = id;
  const v = id ? members.value[id]?.view : null;
  if (v) mapRef.value?.easeTo({ center: v.center, zoom: v.zoom, duration: 600 });
}

export function flyTo(lon: number, lat: number) {
  const m = mapRef.value;
  m?.flyTo({ center: [lon, lat], zoom: Math.max(m.getZoom(), 9) });
}

/** Copy a team drawing into my drawings (a new drawing group). */
export function copyDrawing(group: string) {
  const d = teamDrawings.value[group];
  if (!d) return;
  const list = geoJSONToDrawings(d.geojson, uid(), uid);
  if (!list.length) return toast("Nothing to copy", "warn");
  drawings.value = [...drawings.value, ...list];
  toast(`Copied ${d.name || "drawing"} from ${d.by_name} · turn on "Keep drawings" to keep it`);
}

export function deleteTeamDrawing(group: string) {
  send({ type: "draw_del", group });
}

/** Share my drawings: each drawing group is sent when it changes, and removed when deleted. */
const sentGroups = new Map<string, string>();
function pushDrawings() {
  if (!prefs.value.shareDraw || teamStatus.value !== "online") return;
  const groups = groupDrawings(drawings.value);
  for (const [g, list] of groups) {
    const fc = drawingsToGeoJSON(list);
    const s = JSON.stringify(fc);
    if (sentGroups.get(g) === s) continue;
    sentGroups.set(g, s);
    send({ type: "draw", group: g, name: list.find((d) => d.kind === "text")?.text ?? "", geojson: fc });
  }
  for (const g of [...sentGroups.keys()]) {
    if (!groups.has(g)) {
      sentGroups.delete(g);
      send({ type: "draw_del", group: g });
    }
  }
}
let drawTimer: number | undefined;
effect(() => {
  void drawings.value;
  void prefs.value.shareDraw;
  clearTimeout(drawTimer);
  drawTimer = window.setTimeout(pushDrawings, 800);
});

// ---------- position & view ----------

let watchId: number | null = null;
let lastPos = 0;
let centerTimer: number | undefined;
function startPos() {
  stopPos();
  const mode = prefs.value.pos;
  if (mode === "gps" && "geolocation" in navigator) {
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (Date.now() - lastPos < 5000) return;
        lastPos = Date.now();
        send({ type: "pos", lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ...(p.coords.heading != null ? { heading: p.coords.heading } : {}), ...(p.coords.speed != null ? { speed: p.coords.speed } : {}) });
      },
      (e) => (teamError.value = `GPS: ${e.message}`),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
  } else if (mode === "center") {
    const tick = () => {
      const c = mapRef.value?.getCenter();
      if (c) send({ type: "pos", lat: c.lat, lon: c.lng });
    };
    tick();
    centerTimer = window.setInterval(tick, 15000);
  }
}
function stopPos() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(centerTimer);
  if (teamStatus.value === "online") send({ type: "pos", off: true });
}
export function setPosMode(pos: Prefs["pos"]) {
  setPrefs({ pos });
  if (teamStatus.value === "online") startPos();
}

let viewTimer: number | undefined;
effect(() => {
  const m = mapRef.value;
  if (!m) return;
  const h = () => {
    if (!prefs.value.shareView || teamStatus.value !== "online") return;
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => {
      const c = m.getCenter();
      send({ type: "view", center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() });
    }, 400);
  };
  // dragging the map yourself stops following
  const stop = (e: any) => e.originalEvent && following.value && (following.value = null);
  m.on("moveend", h);
  m.on("dragstart", stop);
  return () => {
    m.off("moveend", h);
    m.off("dragstart", stop);
  };
});

// ---------- map layers ----------

const EMPTY: any = { type: "FeatureCollection", features: [] };
let markers = new Map<string, maplibregl.Marker>();
let pinMarkers = new Map<string, maplibregl.Marker>();

function addLayers(m: MLMap) {
  if (m.getSource("team-draw")) return;
  m.addSource("team-draw", { type: "geojson", data: EMPTY });
  const isPoly: any = ["==", ["geometry-type"], "Polygon"];
  m.addLayer({ id: "team-draw-fill", type: "fill", source: "team-draw", filter: ["all", isPoly, ["==", ["get", "fill"], 1]], paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["==", ["get", "head"], 1], 1, 0.2] } });
  m.addLayer({
    id: "team-draw-line",
    type: "line",
    source: "team-draw",
    filter: ["all", ["!=", ["geometry-type"], "Point"], ["!=", ["get", "head"], 1]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-dasharray": [2, 1] },
  });
  m.addLayer({
    id: "team-draw-text",
    type: "symbol",
    source: "team-draw",
    filter: ["==", ["geometry-type"], "Point"],
    layout: { "text-field": ["get", "text"], "text-font": ["Noto Sans Bold"], "text-size": ["+", 10, ["*", 2, ["get", "width"]]], "text-allow-overlap": true },
    paint: { "text-color": ["get", "color"], "text-halo-color": ["get", "owner"], "text-halo-width": 1.2 },
  });
  renderTeam();
}

function renderTeam() {
  const m = mapRef.value;
  if (!m) return;
  const src = m.getSource("team-draw") as GeoJSONSource | undefined;
  if (src) {
    const mine = new Set(groupDrawings(drawings.value).keys());
    const feats: any[] = [];
    for (const d of Object.values(teamDrawings.value)) if (!mine.has(d.group)) feats.push(...renderable(d.geojson, { owner: "rgba(0,0,0,.85)", group: d.group }));
    src.setData({ type: "FeatureCollection", features: feats } as any);
  }
  // members
  const seen = new Set<string>();
  for (const x of Object.values(members.value)) {
    if (x.id === me.value || !x.pos) continue;
    seen.add(x.id);
    let mk = markers.get(x.id);
    if (!mk) {
      const el = document.createElement("div");
      el.className = "team-member";
      el.onclick = () => follow(following.value === x.id ? null : x.id);
      mk = new maplibregl.Marker({ element: el }).setLngLat([x.pos.lon, x.pos.lat]).addTo(m);
      markers.set(x.id, mk);
    }
    const el = mk.getElement();
    el.style.setProperty("--c", x.color);
    el.innerHTML = `<i></i><span></span>`;
    (el.querySelector("span") as HTMLElement).textContent = x.name;
    el.title = `${x.name}${x.pos.speed != null ? ` · ${Math.round(x.pos.speed * 2.237)} mph` : ""} · click to follow`;
    if (x.pos.heading != null) (el.querySelector("i") as HTMLElement).style.transform = `rotate(${x.pos.heading}deg)`;
    mk.setLngLat([x.pos.lon, x.pos.lat]);
  }
  for (const [id, mk] of markers) if (!seen.has(id)) (mk.remove(), markers.delete(id));
  // pins
  const pseen = new Set<string>();
  for (const p of pins.value) {
    pseen.add(p.id);
    let mk = pinMarkers.get(p.id);
    if (!mk) {
      const el = document.createElement("div");
      el.className = "team-pin";
      mk = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([p.lon, p.lat]).addTo(m);
      pinMarkers.set(p.id, mk);
    }
    const el = mk.getElement();
    el.style.setProperty("--c", p.color);
    el.title = `${p.text || "Pin"} — ${p.by_name}`;
    el.textContent = p.text ? p.text.slice(0, 28) : "📍";
    mk.setLngLat([p.lon, p.lat]);
  }
  for (const [id, mk] of pinMarkers) if (!pseen.has(id)) (mk.remove(), pinMarkers.delete(id));
}

effect(() => {
  const m = mapRef.value;
  if (!m) return;
  const add = () => addLayers(m);
  m.on("style.load", add);
  if (m.isStyleLoaded()) add();
  // place a pin with the next map click
  const click = (e: any) => {
    const t = pinDraft.value;
    if (t == null) return;
    pinDraft.value = null;
    m.getCanvas().style.cursor = "";
    placePin(e.lngLat.lng, e.lngLat.lat, t);
  };
  m.on("click", click);
  return () => {
    m.off("style.load", add);
    m.off("click", click);
  };
});
effect(() => {
  const d = pinDraft.value;
  const m = mapRef.value;
  if (m) m.getCanvas().style.cursor = d != null ? "copy" : "";
});
effect(() => {
  void teamDrawings.value;
  void members.value;
  void pins.value;
  void drawings.value;
  renderTeam();
});
effect(() => {
  if (teamOpen.value) unread.value = 0;
});

// reconnect when the active server changes; rejoin the last room on start
let lastBase = "";
effect(() => {
  void api; // configured by api.ts
  const t = window.setInterval(() => {
    if (api.base !== lastBase) {
      lastBase = api.base;
      if (wanted) connect();
    }
  }, 2000);
  return () => clearInterval(t);
});
if (prefs.value.room && !/[?&]share=/.test(location.search) && !location.hash.includes("popout=")) {
  wanted = prefs.value.room;
  window.setTimeout(connect, 1500);
}
