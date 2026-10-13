// workflow 0.6: audio briefings — a short spoken summary for a point: active alerts, nearest storm
// and its ETA, the radar trend, SPC risk and the next 12 hours of forecast. On demand (toolbar …
// menu, My points) or at scheduled times while the app runs.

import { signal } from "@preact/signals";
import { settings, toast } from "./store";
import { alerts } from "./alerts";
import { pointInGeometry, compass } from "./util";
import { nearestCell, nextArrival, echoTrend, forecastAt, spcLevel, SPC_NAME, nearestStrike, fmtMi, fmtTempF, hhmm, dbzWords } from "./wf6data";
import { cellFlags } from "./overlays/stormcells";
import { fix } from "./gps";
import { say, stopTts } from "./tts"; // radio/dash 0.8

export interface Briefing {
  title: string;
  t: number;
  lines: { k: string; text: string }[];
  speaking: boolean;
}
export const briefing = signal<Briefing | null>(null);
export const briefingBusy = signal(false);

export function briefingTarget(id?: string): { lat: number; lon: number; name: string } | null {
  const s = settings.value;
  const pid = id ?? s.wf6.briefing.point;
  if (pid === "gps" && fix.value) return { lat: fix.value.lat, lon: fix.value.lon, name: "your location" };
  const p = s.points.find((x) => x.id === pid) ?? s.points[0];
  if (p) return { lat: p.lat, lon: p.lon, name: p.name };
  const v = s.view.center;
  return { lat: v[1], lon: v[0], name: "the map center" };
}

export async function buildBriefing(target: { lat: number; lon: number; name: string }): Promise<Briefing> {
  const { lat, lon, name } = target;
  const lines: { k: string; text: string }[] = [];
  const now = new Date();
  lines.push({ k: "intro", text: `Weather briefing for ${name}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` });
  // alerts
  const al = [...alerts.value.values()].filter((a) => pointInGeometry(lon, lat, a.geometry)).sort((a, b) => b.properties.priority - a.properties.priority);
  if (al.length) {
    const names = [...new Set(al.map((a) => String(a.properties.event)))];
    const first = al[0].properties;
    const until = first.ends ?? first.expires;
    const untilTxt = until ? ` until ${hhmm(Date.parse(until))}` : "";
    lines.push({ k: "alerts", text: names.length === 1 ? `${/^[AEIOU]/i.test(names[0]) ? "An" : "A"} ${names[0]} is in effect${untilTxt}.` : `${names.length} alerts are in effect: ${names.slice(0, 4).join(", ")}. The ${String(first.event)} runs${untilTxt || " for now"}.` });
  } else lines.push({ k: "alerts", text: "No weather alerts are in effect." });
  const [arr, cell, trend, spc, fc, ltg] = await Promise.all([
    nextArrival({ lat, lon }).catch(() => null),
    nearestCell(lat, lon).catch(() => null),
    echoTrend(lat, lon).catch(() => null),
    spcLevel(lat, lon, 1).catch(() => ({ level: -1, label: "" })),
    forecastAt(lat, lon).catch(() => null),
    nearestStrike(lat, lon, 15, 80_000).catch(() => null),
  ]);
  // storms
  if (arr) {
    const fl = arr.flags ? ` with ${arr.flags.replace(/·/g, "and")}` : "";
    lines.push({ k: "storm", text: arr.min <= 1 ? `A storm${fl} is over ${name} now.` : `A storm${fl} is forecast to reach ${name} in about ${arr.min} minutes, around ${hhmm(arr.at)}.` });
  } else if (cell && cell.dist < 150_000) {
    const p = cell.cell.p;
    const fl = cellFlags(p);
    lines.push({ k: "storm", text: `The nearest tracked storm is ${fmtMi(cell.dist)} to the ${compass(cell.brg)}${fl ? `, ${fl}` : ""}${p.sknt ? `, moving ${compass(p.dir_to)} at ${Math.round(p.sknt * 1.15)} miles per hour` : ""}. It is not projected to reach ${name} in the next hour.` });
  }
  // radar
  if (trend) {
    if (trend.core) {
      const dir = trend.core.dist < 4000 ? "overhead" : `${fmtMi(trend.core.dist)} to the ${compass(trend.core.brg)}`;
      const ch = Number.isFinite(trend.before) ? (trend.now - trend.before > 5 ? ", and intensifying over the last half hour" : trend.before - trend.now > 5 ? ", and weakening over the last half hour" : "") : "";
      lines.push({ k: "radar", text: `Radar shows ${dbzWords(trend.core.dbz).toLowerCase() || "precipitation"} ${dir}${ch}.` });
    } else if (trend.now >= 15) lines.push({ k: "radar", text: "Radar shows only light precipitation nearby." });
    else lines.push({ k: "radar", text: "Radar is quiet nearby." });
  }
  if (ltg) lines.push({ k: "lightning", text: `Lightning ${fmtMi(ltg.dist)} to the ${compass(ltg.brg)}, ${Math.max(1, Math.round(ltg.age / 60000))} minute${Math.round(ltg.age / 60000) > 1 ? "s" : ""} ago.` });
  // SPC
  if (spc.level >= 1) lines.push({ k: "spc", text: `The Storm Prediction Center has ${/^[aeiou]/.test(SPC_NAME[spc.level]) ? "an" : "a"} ${SPC_NAME[spc.level]} risk of severe storms today, level ${spc.level} of 5.` });
  else if (spc.level === 0) lines.push({ k: "spc", text: "General thunderstorms are possible today." });
  // forecast: next 12 hours
  const h = (fc?.hourly ?? []).filter((x) => Date.parse(x.t) >= Date.now() - 3600_000).slice(0, 12);
  if (h.length) {
    const temps = h.map((x) => x.temp_f).filter((x): x is number => x != null);
    const pop = Math.max(0, ...h.map((x) => x.pop ?? 0));
    const shorts = h.map((x) => x.short).filter(Boolean);
    const common = shorts.sort((a, b) => shorts.filter((x) => x === b).length - shorts.filter((x) => x === a).length)[0] ?? "";
    const gust = Math.max(0, ...h.map((x) => x.gust_mph ?? x.wind_mph ?? 0));
    const rainAt = h.find((x) => (x.pop ?? 0) >= 50);
    lines.push({
      k: "forecast",
      text: `Next 12 hours: ${common ? common.toLowerCase() + ", " : ""}temperatures ${fmtTempF(Math.min(...temps))} to ${fmtTempF(Math.max(...temps))}${pop >= 20 ? `, ${pop} percent chance of precipitation${rainAt ? (Date.parse(rainAt.t) <= Date.now() ? " starting now" : ` from about ${hhmm(Date.parse(rainAt.t))}`) : ""}` : ""}${gust >= 25 ? `, winds up to ${Math.round(gust)} miles per hour` : ""}.`.replace(/°F/g, " degrees").replace(/°C/g, " degrees Celsius"),
    });
  } else if (fc?.periods?.[0]) lines.push({ k: "forecast", text: `${fc.periods[0].name}: ${fc.periods[0].text ?? fc.periods[0].short}` });
  return { title: `Briefing · ${name}`, t: Date.now(), lines, speaking: false };
}

export function speak(b: Briefing) {
  // radio/dash 0.8: system speech when it works, else the bundled offline voice (tts.ts)
  const text = b.lines.map((l) => l.text).join(" ");
  briefing.value = { ...b, speaking: true };
  say(text).finally(() => briefing.value && briefing.value.t === b.t && (briefing.value = { ...briefing.value, speaking: false }));
}

export function stopSpeaking() {
  stopTts();
  if (briefing.value) briefing.value = { ...briefing.value, speaking: false };
}

/** Build, show and read a briefing for a saved point id (or the configured briefing point). */
export async function runBriefing(pointId?: string, read = true) {
  const t = briefingTarget(pointId);
  if (!t) return;
  briefingBusy.value = true;
  briefing.value = { title: `Briefing · ${t.name}`, t: Date.now(), lines: [{ k: "intro", text: "Gathering alerts, storms, radar and forecast…" }], speaking: false };
  try {
    const b = await buildBriefing(t);
    briefing.value = b;
    if (read) speak(b);
  } catch (e: any) {
    briefing.value = { title: `Briefing · ${t.name}`, t: Date.now(), lines: [{ k: "err", text: `Couldn't build the briefing: ${e.message}` }], speaking: false };
  } finally {
    briefingBusy.value = false;
  }
}

// scheduled daily briefings ("07:00", "17:30"), while the app is running
let lastRun = "";
setInterval(() => {
  const times = settings.value.wf6?.briefing.times ?? [];
  if (!times.length) return;
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const key = `${d.toDateString()} ${hm}`;
  if (times.includes(hm) && lastRun !== key) {
    lastRun = key;
    runBriefing();
  }
}, 20_000);
