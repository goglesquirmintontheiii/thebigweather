// GPS track recording (watchPosition): the live track on the map, saved tracks (local), GPX
// export, and distance/bearing to the nearest spotters and the nearest warning polygon.

import { signal, computed, effect } from "@preact/signals";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { toast, uid } from "./store";
import { mapRef } from "./map/mapview";
import { alerts } from "./alerts";
import { distance, bearing, pointInGeometry } from "./util";
import { saveFile } from "./saveio";

export type TrkPt = [number, number, number, number?]; // lon, lat, time ms, accuracy m
export interface Track {
  id: string;
  name: string;
  start: number;
  end: number;
  pts: TrkPt[];
}

const KEY = "tbw.tracks.v1";
function loadTracks(): Track[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
export const tracks = signal<Track[]>(loadTracks());
effect(() => {
  const v = tracks.value;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    toast("Track storage full — export and delete old tracks", "warn");
  }
});

export const trackPanel = signal(false);
export const recording = signal<Track | null>(null);
export const fix = signal<{ lat: number; lon: number; acc: number; t: number; speed: number | null; hdg: number | null } | null>(null);
export const gpsError = signal<string | null>(null);
/** saved track shown on the map */
export const shownTrack = signal<string | null>(null);

let watchId: number | null = null;

export function startTrack() {
  if (recording.value) return;
  if (!("geolocation" in navigator)) {
    gpsError.value = "This device has no location service.";
    return;
  }
  gpsError.value = null;
  const t: Track = { id: uid(), name: `Track ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, start: Date.now(), end: Date.now(), pts: [] };
  recording.value = t;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const c = p.coords;
      gpsError.value = null;
      fix.value = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: p.timestamp, speed: c.speed, hdg: c.heading };
      const r = recording.value;
      if (!r) return;
      const last = r.pts[r.pts.length - 1];
      // skip jitter: < 8 m moved and < 30 s
      if (last && distance(last[1], last[0], c.latitude, c.longitude) < Math.max(8, c.accuracy / 4) && p.timestamp - last[2] < 30_000) return;
      recording.value = { ...r, end: p.timestamp, pts: [...r.pts, [+c.longitude.toFixed(6), +c.latitude.toFixed(6), p.timestamp, Math.round(c.accuracy)]] };
    },
    (e) => {
      if (e.code === 1) stopTrack(false);
      gpsError.value =
        e.code === 1
          ? "Location permission denied."
          : "No location fix. The desktop app needs a location provider (GPS or the OS location service); try again outdoors or connect a GPS.";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 },
  );
}

export function stopTrack(save = true) {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  const r = recording.value;
  recording.value = null;
  if (save && r && r.pts.length > 1) {
    tracks.value = [r, ...tracks.value];
    toast(`Saved ${r.name} (${r.pts.length} points)`);
  } else if (save && r) toast("Track too short — not saved", "info");
}

export function trackLength(t: Track) {
  let d = 0;
  for (let i = 1; i < t.pts.length; i++) d += distance(t.pts[i - 1][1], t.pts[i - 1][0], t.pts[i][1], t.pts[i][0]);
  return d;
}

export function toGpx(t: Track) {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  const pts = t.pts.map((p) => `      <trkpt lat="${p[1]}" lon="${p[0]}"><time>${new Date(p[2]).toISOString()}</time>${p[3] != null ? `<hdop>${(p[3] / 5).toFixed(1)}</hdop>` : ""}</trkpt>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TheBigWeather" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(t.name)}</name><time>${new Date(t.start).toISOString()}</time></metadata>
  <trk>
    <name>${esc(t.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

export async function exportGpx(t: Track) {
  const f = await saveFile(`${t.name.replace(/[^\w-]+/g, "_")}.gpx`, toGpx(t), "application/gpx+xml");
  if (f) toast(`Saved ${f}`);
}

// ---------- nearby: spotters and warnings ----------

/** where "you" are: GPS fix, else map centre */
export const here = computed(() => {
  const f = fix.value;
  if (f) return { lat: f.lat, lon: f.lon, src: "GPS" as const };
  return null;
});

/** distance (m) from a point to a polygon's edge, 0 inside */
function distToGeom(lat: number, lon: number, g: any): number {
  if (pointInGeometry(lon, lat, g)) return 0;
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  const rings: number[][][] = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
  for (const ring of rings)
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * k, ay = ring[i - 1][1] - lat;
      const bx = (ring[i][0] - lon) * k, by = ring[i][1] - lat;
      const dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(px, py) * 111_195;
      if (d < best) best = d;
    }
  return best;
}

export function nearestWarning(lat: number, lon: number): { event: string; dist: number; brg: number; id: string } | null {
  let best: any = null;
  for (const a of alerts.value.values()) {
    const p = a.properties ?? {};
    if (!String(p.event ?? "").endsWith("Warning") || !a.geometry) continue;
    const d = distToGeom(lat, lon, a.geometry);
    if (!best || d < best.dist) {
      // bearing toward the polygon's first vertex area (rough centroid)
      const ring = a.geometry.type === "Polygon" ? a.geometry.coordinates[0] : a.geometry.coordinates[0][0];
      const cx = ring.reduce((s: number, q: number[]) => s + q[0], 0) / ring.length, cy = ring.reduce((s: number, q: number[]) => s + q[1], 0) / ring.length;
      best = { event: p.event, dist: d, brg: bearing(lat, lon, cy, cx), id: p.id };
    }
  }
  return best;
}

export function nearestSpotters(lat: number, lon: number, n = 3): { name: string; dist: number; brg: number; stream: boolean }[] {
  const map = mapRef.value;
  if (!map?.getSource("o-spotters")) return [];
  const seen = new Set<string>();
  const out: { name: string; dist: number; brg: number; stream: boolean }[] = [];
  for (const f of map.querySourceFeatures("o-spotters")) {
    const c = (f.geometry as any).coordinates as number[];
    if (!c) continue;
    const key = `${c[0].toFixed(4)},${c[1].toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: String(f.properties?.name || "Spotter"), dist: distance(lat, lon, c[1], c[0]), brg: bearing(lat, lon, c[1], c[0]), stream: !!f.properties?.stream });
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, n);
}

// ---------- map drawing ----------
let marker: maplibregl.Marker | null = null;
function draw(map: MLMap) {
  if (!map.getStyle()) return;
  if (!map.getSource("gps-track")) {
    map.addSource("gps-track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "gps-track-case", type: "line", source: "gps-track", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": 5, "line-opacity": 0.5 } });
    map.addLayer({ id: "gps-track", type: "line", source: "gps-track", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["case", ["get", "live"], "#f472b6", "#a78bfa"], "line-width": 3 } });
  }
  const feats: any[] = [];
  const r = recording.value;
  if (r && r.pts.length > 1) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: r.pts.map((p) => [p[0], p[1]]) }, properties: { live: true } });
  const s = tracks.value.find((t) => t.id === shownTrack.value);
  if (s && s.pts.length > 1) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: s.pts.map((p) => [p[0], p[1]]) }, properties: { live: false } });
  (map.getSource("gps-track") as GeoJSONSource).setData({ type: "FeatureCollection", features: feats });
  const f = fix.value;
  if (f && recording.value) {
    if (!marker) {
      const el = document.createElement("div");
      el.className = "me-marker";
      marker = new maplibregl.Marker({ element: el });
    }
    marker.setLngLat([f.lon, f.lat]).addTo(map);
  } else {
    marker?.remove();
    marker = null;
  }
}

let hooked: MLMap | null = null;
effect(() => {
  const map = mapRef.value;
  void recording.value;
  void tracks.value;
  void shownTrack.value;
  void fix.value;
  if (!map) return;
  if (hooked !== map) {
    hooked = map;
    map.on("style.load", () => draw(map));
  }
  if ((map as any).style?._loaded) draw(map);
});
