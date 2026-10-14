// 0.8.1: timelapse video length (server: TlCam.length_min / until) — pure helpers.

export const UNITS: [string, number][] = [
  ["min", 1],
  ["hours", 60],
  ["days", 1440],
  ["weeks", 10080],
];
export const DAY = 1440;
/** server limits: 5 min … 366 days */
export const MIN_LEN = 5;
export const MAX_LEN = 366 * DAY;

export function toMinutes(n: number, unit: number): number {
  return Math.max(MIN_LEN, Math.min(MAX_LEN, Math.round((Number.isFinite(n) ? n : 1) * unit)));
}

/** Largest unit that divides the length evenly: 2880 → [2, 1440]. */
export function splitLen(min: number): [number, number] {
  const m = min || DAY;
  for (let i = UNITS.length - 1; i >= 0; i--) if (m % UNITS[i][1] === 0) return [m / UNITS[i][1], UNITS[i][1]];
  return [m, 1];
}

export function fmtLen(min: number): string {
  const [n, u] = splitLen(min);
  const name = UNITS.find((x) => x[1] === u)![0];
  if (n === 1) return { min: "1 min", hours: "1 hour", days: "1 day", weeks: "1 week" }[name]!;
  return `${n} ${name}`;
}

/** `<input type="datetime-local">` value ↔ unix ms (local time). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(s: string): number | null {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}
