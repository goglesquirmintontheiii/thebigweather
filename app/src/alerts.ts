// Alert styling (NWS hazard map colors), priority, and point-based notification logic.

import { signal } from "@preact/signals";
import { api } from "./api";
import { settings, toast } from "./store";
import { pointInGeometry } from "./util";
import { playAlertSound, playNamed } from "./sound";
import { alertStyle, alertVisible } from "./alertstyle";

export const ALERT_COLORS: Record<string, string> = {
  "Tornado Warning": "#ff0000",
  "Severe Thunderstorm Warning": "#ffa500",
  "Flash Flood Warning": "#8b0000",
  "Snow Squall Warning": "#c71585",
  "Extreme Wind Warning": "#ff8c00",
  "Special Marine Warning": "#ffa500",
  "Tornado Watch": "#ffff00",
  "Severe Thunderstorm Watch": "#db7093",
  "Flood Warning": "#00ff00",
  "Flood Advisory": "#00ff7f",
  "Flood Watch": "#2e8b57",
  "Flash Flood Watch": "#2e8b57",
  "Coastal Flood Warning": "#228b22",
  "Coastal Flood Advisory": "#7cfc00",
  "Coastal Flood Watch": "#66cdaa",
  "Winter Storm Warning": "#ff69b4",
  "Winter Storm Watch": "#4682b4",
  "Winter Weather Advisory": "#7b68ee",
  "Blizzard Warning": "#ff4500",
  "Ice Storm Warning": "#8b008b",
  "Lake Effect Snow Warning": "#008b8b",
  "High Wind Warning": "#daa520",
  "High Wind Watch": "#b8860b",
  "Wind Advisory": "#d2b48c",
  "Heat Advisory": "#ff7f50",
  "Extreme Heat Warning": "#c71585",
  "Excessive Heat Warning": "#c71585",
  "Extreme Heat Watch": "#800000",
  "Red Flag Warning": "#ff1493",
  "Fire Weather Watch": "#ffdead",
  "Dense Fog Advisory": "#708090",
  "Special Weather Statement": "#ffe4b5",
  "Hurricane Warning": "#dc143c",
  "Hurricane Watch": "#ff00ff",
  "Tropical Storm Warning": "#b22222",
  "Tropical Storm Watch": "#f08080",
  "Storm Surge Warning": "#b524f7",
  "Storm Surge Watch": "#db7ff7",
  "Frost Advisory": "#6495ed",
  "Freeze Warning": "#483d8b",
  "Freeze Watch": "#00ffff",
  "Small Craft Advisory": "#d8bfd8",
  "Gale Warning": "#dda0dd",
  "Storm Warning": "#9400d3",
  "Air Quality Alert": "#808080",
  "Extreme Cold Warning": "#0000ff",
  "Cold Weather Advisory": "#afeeee",
  "Wind Chill Warning": "#b0c4de",
  "Wind Chill Advisory": "#afeeee",
  "Dust Storm Warning": "#ffe4c4",
  "Blowing Dust Advisory": "#bdb76b",
};

export function alertColor(event: string): string {
  return ALERT_COLORS[event] ?? "#a0a0a0";
}

/** Higher draws on top and sorts first. */
export function alertPriority(f: any): number {
  const p = f.properties;
  const e: string = p.event ?? "";
  let n = 10;
  if (e === "Tornado Warning") n = 100;
  else if (e === "Severe Thunderstorm Warning") n = 90;
  else if (e === "Flash Flood Warning") n = 85;
  else if (e === "Snow Squall Warning" || e === "Extreme Wind Warning") n = 80;
  else if (e.endsWith("Warning")) n = 60;
  else if (e.endsWith("Watch")) n = 40;
  else if (e.endsWith("Advisory")) n = 25;
  else if (e.endsWith("Statement")) n = 15;
  const fl = p.flags ?? {};
  if (fl.tornado_emergency || fl.flash_flood_emergency) n += 20;
  else if (fl.pds) n += 8;
  if (fl.tornado_damage_threat === "CATASTROPHIC" || fl.tornado_damage_threat === "CONSIDERABLE") n += 5;
  if (fl.thunderstorm_damage_threat === "DESTRUCTIVE") n += 4;
  return n;
}

export function alertTag(f: any): string | null {
  const fl = f.properties.flags ?? {};
  if (fl.tornado_emergency) return "TORNADO EMERGENCY";
  if (fl.flash_flood_emergency) return "FLASH FLOOD EMERGENCY";
  if (fl.pds) return "PDS";
  if (fl.tornado_damage_threat === "CONSIDERABLE") return "CONSIDERABLE";
  if (fl.thunderstorm_damage_threat === "DESTRUCTIVE") return "DESTRUCTIVE";
  if (fl.tornado_detection === "OBSERVED") return "OBSERVED";
  return null;
}

export const alerts = signal<Map<string, any>>(new Map());

function decorate(f: any) {
  f.properties.color = alertColor(f.properties.event);
  f.properties.priority = alertPriority(f);
  f.properties.tag = alertTag(f);
  return f;
}

let lastSound = 0;
/** Per-type sounds (Layers → Weather alerts → gear): the most urgent new alert's sound plays. */
function typeSounds(fs: any[]) {
  const s = settings.value;
  const scope = s.alertCfg.soundScope ?? "all";
  let best: { pri: number; sound: string } | null = null;
  for (const f of fs) {
    const p = f.properties;
    if (p.messageType && p.messageType !== "Alert") continue;
    if (!alertVisible(p.event)) continue;
    const snd = alertStyle(p.event).sound;
    if (snd === "off") continue;
    if (scope === "points" && !s.points.some((pt) => pointInGeometry(pt.lon, pt.lat, f.geometry))) continue;
    if (!best || p.priority > best.pri) best = { pri: p.priority, sound: snd };
  }
  if (best && Date.now() - lastSound > 3000) {
    lastSound = Date.now();
    playNamed(best.sound as any);
    return true;
  }
  return false;
}

/** Read new warnings aloud (Settings → alerts gear → "Read aloud"). */
function speak(fs: any[]) {
  if (!settings.value.speak || !("speechSynthesis" in window)) return;
  for (const f of fs.slice(0, 3)) {
    const p = f.properties;
    if (!String(p.event).endsWith("Warning") || !alertVisible(p.event)) continue;
    if (p.messageType && p.messageType !== "Alert") continue;
    const area = String(p.areaDesc ?? "").split(";").slice(0, 4).join(",");
    const u = new SpeechSynthesisUtterance(`${p.tag ? p.tag.toLowerCase() + ", " : ""}${p.event} for ${area}`);
    u.volume = settings.value.audio.volume;
    speechSynthesis.speak(u);
  }
}

function notifyNew(fs: any[]) {
  const s = settings.value;
  const played = typeSounds(fs);
  setTimeout(() => speak(fs), played ? 2600 : 0);
  if (s.notify.mode === "off") return;
  for (const f of fs) {
    const p = f.properties;
    if (s.notify.warningsOnly && !String(p.event).endsWith("Warning")) continue;
    if (p.messageType && p.messageType !== "Alert" && p.messageType !== "Update") continue;
    let hits: string[] = [];
    if (s.notify.mode === "points") {
      hits = s.points.filter((pt) => pt.notify && pointInGeometry(pt.lon, pt.lat, f.geometry)).map((pt) => pt.name);
      if (!hits.length) continue;
    }
    const tag = p.tag ? ` · ${p.tag}` : "";
    const where = hits.length ? ` for ${hits.join(", ")}` : "";
    toast(`${p.event}${tag}${where}`, "alert", 9000);
    if (s.audio.alerts && !played) playAlertSound(p.event, p.tag);
    if (s.notify.desktop && "Notification" in window) {
      const show = () => new Notification(`${p.event}${tag}`, { body: (p.areaDesc ?? "").slice(0, 180), silent: true });
      if (Notification.permission === "granted") show();
      else if (Notification.permission !== "denied") Notification.requestPermission().then((r) => r === "granted" && show());
    }
  }
}

let started = false;
export function startAlerts() {
  if (started) return;
  started = true;
  const load = async () => {
    try {
      const fc = await api.get("/api/alerts");
      const m = new Map<string, any>();
      for (const f of fc.features) m.set(f.properties.id, decorate(f));
      alerts.value = m;
    } catch {
      /* offline */
    }
  };
  api.on("connected", load);
  load();
  api.on("alerts", (msg) => {
    const m = new Map(alerts.value);
    for (const id of msg.removed ?? []) m.delete(id);
    for (const f of [...(msg.added ?? []), ...(msg.updated ?? [])]) m.set(f.properties.id, decorate(f));
    alerts.value = m;
    if (msg.added?.length) notifyNew(msg.added.map(decorate));
  });
}

export function sortedAlerts(): any[] {
  return [...alerts.value.values()].sort((a, b) => b.properties.priority - a.properties.priority || String(b.properties.sent).localeCompare(String(a.properties.sent)));
}
