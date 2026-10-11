// Geo math, unit formatting, time formatting.

import { settings } from "./store";

const R = 6371008.8;
const rad = Math.PI / 180;

export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

export function destination(lat: number, lon: number, brg: number, dist: number): [number, number] {
  const d = dist / R, b = brg * rad, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((l2 / rad + 540) % 360) - 180, p2 / rad];
}

export function circle(lat: number, lon: number, radius: number, n = 128): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) pts.push(destination(lat, lon, (i / n) * 360, radius));
  return pts;
}

const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass(deg: number) {
  return DIRS[Math.round(deg / 22.5) % 16];
}

export function fmtDist(m: number): string {
  const u = settings.value.units.distance;
  const v = u === "km" ? m / 1000 : u === "mi" ? m / 1609.344 : m / 1852;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u}`;
}

export function speedFactor(): number {
  switch (settings.value.units.speed) {
    case "kt":
      return 1.943844;
    case "mph":
      return 2.236936;
    case "km/h":
      return 3.6;
    default:
      return 1;
  }
}

/** Format a product value in the user's units. */
export function fmtValue(v: number, units: string, labels?: Record<number, string>): string {
  if (Number.isNaN(v)) return "—";
  if (v === -9999) return "RF";
  if (labels) return labels[Math.round(v)] ?? "—";
  if (units === "m/s") {
    const f = speedFactor();
    return `${(v * f).toFixed(Math.abs(v * f) < 10 ? 1 : 0)} ${settings.value.units.speed}`;
  }
  if (units === "") return v.toFixed(3);
  if (units === "in") return `${v.toFixed(2)} in`;
  return `${v.toFixed(Math.abs(v) < 10 ? 1 : 0)} ${units}`;
}

export function fmtTime(ms: number, withDate = false): string {
  if (!ms) return "--:--";
  const d = new Date(ms);
  const utc = settings.value.utc;
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: utc ? "UTC" : undefined };
  if (withDate) Object.assign(opts, { month: "short", day: "numeric" });
  return d.toLocaleString(undefined, opts) + (utc ? "Z" : "");
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${Math.round(b)} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    b /= 1024;
    i++;
  } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
}

/** Ray-casting point in polygon for GeoJSON Polygon/MultiPolygon. */
export function pointInGeometry(lon: number, lat: number, g: any): boolean {
  if (!g) return false;
  const inRing = (ring: number[][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPoly = (p: number[][][]) => p.length > 0 && inRing(p[0]) && !p.slice(1).some(inRing);
  if (g.type === "Polygon") return inPoly(g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some(inPoly);
  return false;
}

export function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/** Convert a gridded-layer value from its native units into the user's preferred units. */
export function convertUnit(v: number, units: string): [number, string] {
  const u = settings.value.units;
  switch (units) {
    case "°C":
      return u.temp === "F" ? [v * 1.8 + 32, "°F"] : [v, "°C"];
    case "K":
      return u.temp === "F" ? [(v - 273.15) * 1.8 + 32, "°F"] : [v - 273.15, "°C"];
    case "mm":
      return u.precip === "in" ? [v / 25.4, "in"] : [v, "mm"];
    case "mm/h":
      return u.precip === "in" ? [v / 25.4, "in/h"] : [v, "mm/h"];
    case "cm":
      return u.precip === "in" ? [v / 2.54, "in"] : [v, "cm"];
    case "km":
      return u.distance === "km" ? [v, "km"] : [v / 1.609344, "mi"];
    case "m/s":
      return [v * speedFactor(), u.speed];
    default:
      return [v, units];
  }
}

/** Format a gridded value (with unit conversion and sensible precision). */
export function fmtGrid(v: number, units: string, labels?: Record<number, string>): string {
  if (Number.isNaN(v)) return "—";
  if (labels) return labels[Math.round(v)] ?? "—";
  const [x, lab] = convertUnit(v, units);
  const ax = Math.abs(x);
  const d = units === "1/s" ? 4 : lab === "in" || lab === "in/h" ? 2 : ax < 10 ? 1 : 0;
  return `${x.toFixed(d)}${lab === "%" || lab.startsWith("°") ? "" : " "}${lab}`;
}
