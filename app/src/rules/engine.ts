// workflow 0.6: notification rules engine. Rules live on the server (`GET/PUT /api/rules`, JSON ≤
// 256 KB) when it supports them, else in local settings. The client evaluates them: on data updates
// (alerts, storm cells, GPS fix) debounced, plus a 30-second timer for polled sources (lightning,
// AQI, METARs, SPC, radar) — each source is only fetched while an enabled rule needs it.

import { signal, effect } from "@preact/signals";
import { api, ApiError } from "../api";
import { settings, update, toast, uid, type Rule, type RuleCond, type RuleAction } from "../store";
import { alerts } from "../alerts";
import { fix } from "../gps";
import { playNamed } from "../sound";
import { distance, pointInGeometry } from "../util";
import { stormCellsNow, cellEtaTo, nearestStrike, nearestAqi, nearestMetar, spcLevel, dbzAt, fmtMi, SPC_NAME, MI } from "../wf6data";
import { mesoRank, hasTvs } from "../overlays/stormcells";
import { route } from "../route/route";
import { applyWorkspace } from "../workspaces";
import { freshDetections, startDetections } from "../ml/client"; // detection models
import { tmeta } from "../ml/targets"; // detection models

export interface FireLog {
  t: number;
  rule: string;
  msg: string;
  test?: boolean;
}
const LOG_KEY = "tbw.ruleLog.v1";
export const ruleLog = signal<FireLog[]>((() => {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]");
  } catch {
    return [];
  }
})());
function log(e: FireLog) {
  ruleLog.value = [e, ...ruleLog.value].slice(0, 200);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(ruleLog.value));
  } catch {
    /* full */
  }
}
/** "server" when rules sync with the server, "local" when it has no /api/rules */
export const rulesStore = signal<"server" | "local" | "?">("?");
/** last evaluation: rule id → current state text */
export const ruleState = signal<Record<string, { hit: boolean; text: string }>>({});
export const flashOn = signal(false);

// ---------- server sync ----------
let pushTimer: number | undefined;
let lastPushed = "";
async function pullRules() {
  try {
    const r = await api.get("/api/rules");
    const list = Array.isArray(r) ? r : r?.rules;
    rulesStore.value = "server";
    // an empty server store adopts the local rules (pushed by the effect below)
    if (Array.isArray(list) && (list.length || !settings.value.wf6.rules.length)) {
      lastPushed = JSON.stringify(list);
      if (lastPushed !== JSON.stringify(settings.value.wf6.rules)) update((s) => (s.wf6.rules = list));
    }
  } catch (e) {
    rulesStore.value = e instanceof ApiError && (e.status === 404 || e.status === 405) ? "local" : rulesStore.value === "server" ? "server" : "local";
  }
}
effect(() => {
  const rules = settings.value.wf6?.rules;
  if (rulesStore.value !== "server") return;
  const j = JSON.stringify(rules);
  if (j === lastPushed) return;
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    lastPushed = j;
    api.send("PUT", "/api/rules", { rules }).catch((e) => toast(`Couldn't save rules on the server: ${e.message}`, "warn"));
  }, 800);
});

// ---------- locations ----------
function whereOf(c: RuleCond): { lat: number; lon: number; label: string }[] {
  if (c.where === "gps") return fix.value ? [{ lat: fix.value.lat, lon: fix.value.lon, label: "your location" }] : [];
  if (c.where === "route") {
    const r = route.value;
    if (!r) return [];
    // every ~5 km along the route
    const out: { lat: number; lon: number; label: string }[] = [];
    let last = -1e9;
    r.coords.forEach((p, i) => {
      if (r.cum[i] - last >= 5000 || i === r.coords.length - 1) {
        out.push({ lat: p[1], lon: p[0], label: "your route" });
        last = r.cum[i];
      }
    });
    return out.slice(0, 400);
  }
  const p = settings.value.points.find((x) => x.id === c.where) ?? (c.where === "" || c.where === "first" ? settings.value.points[0] : undefined);
  return p ? [{ lat: p.lat, lon: p.lon, label: p.name }] : [];
}

/** distance (m) from a point to a GeoJSON polygon: 0 inside, else to its nearest vertex */
function distToGeom(lat: number, lon: number, g: any): number {
  if (!g) return Infinity;
  if (pointInGeometry(lon, lat, g)) return 0;
  let best = Infinity;
  const walk = (a: any) => {
    if (typeof a[0] === "number") best = Math.min(best, distance(lat, lon, a[1], a[0]));
    else for (const x of a) walk(x);
  };
  walk(g.coordinates ?? []);
  return best;
}

// ---------- conditions ----------
interface Hit {
  key: string;
  msg: string;
  vars: Record<string, string>;
}
export async function check(r: Rule): Promise<Hit | null> {
  const c = r.cond;
  const locs = whereOf(c);
  if (!locs.length) return null;
  const R = (c.mi ?? 10) * MI;
  switch (c.kind) {
    case "alert": {
      const want = (c.event ?? "Warning").toLowerCase();
      for (const a of alerts.value.values()) {
        const ev = String(a.properties.event);
        if (!ev.toLowerCase().includes(want)) continue;
        for (const l of locs) {
          const d = distToGeom(l.lat, l.lon, a.geometry);
          if (d <= R) return { key: a.properties.id, msg: `${ev}${d > 0 ? ` ${fmtMi(d)} from` : " covers"} ${l.label}`, vars: { event: ev, dist: d > 0 ? fmtMi(d) : "0", place: l.label, area: String(a.properties.areaDesc ?? "").split(";").slice(0, 3).join(",") } };
        }
      }
      return null;
    }
    case "rotation": {
      const cells = await stormCellsNow();
      for (const cell of cells) {
        const p = cell.p;
        const ok = c.rot === "tvs" ? hasTvs(p) : mesoRank(p) >= (c.value ?? 5) || hasTvs(p);
        if (!ok) continue;
        for (const l of locs) {
          const d = distance(l.lat, l.lon, cell.lat, cell.lon);
          if (d <= R) {
            const what = hasTvs(p) ? "TVS" : `Mesocyclone rank ${mesoRank(p)}`;
            return { key: `${p.nexrad}-${p.storm_id}`, msg: `${what} ${fmtMi(d)} from ${l.label}`, vars: { event: what, dist: fmtMi(d), place: l.label } };
          }
        }
      }
      return null;
    }
    case "lightning": {
      for (const l of locs.slice(0, 40)) {
        const s = await nearestStrike(l.lat, l.lon, c.minutes ?? 15, R);
        if (s && s.dist <= R) return { key: "", msg: `Lightning ${fmtMi(s.dist)} from ${l.label} (${Math.round(s.age / 60000)} min ago)`, vars: { event: "Lightning", dist: fmtMi(s.dist), place: l.label } };
      }
      return null;
    }
    case "eta": {
      const cells = await stormCellsNow();
      for (const cell of cells)
        for (const l of locs) {
          const m = cellEtaTo(cell, l.lat, l.lon, Math.max(3000, R));
          if (m != null && m <= (c.value ?? 20)) return { key: `${cell.p.nexrad}-${cell.p.storm_id}`, msg: `Storm ${cell.p.storm_id ?? ""} reaches ${l.label} in ~${m} min`, vars: { event: "Storm", min: String(m), place: l.label, dist: "" } };
        }
      return null;
    }
    case "aqi": {
      for (const l of locs.slice(0, 20)) {
        const a = await nearestAqi(l.lat, l.lon, Math.max(R, 30_000));
        if (a && a.aqi > (c.value ?? 150)) return { key: String(Math.floor(a.aqi / 50)), msg: `AQI ${Math.round(a.aqi)} near ${l.label}`, vars: { event: "Air quality", value: String(Math.round(a.aqi)), place: l.label } };
      }
      return null;
    }
    case "metar": {
      for (const l of locs.slice(0, 20)) {
        const m = await nearestMetar(l.lat, l.lon);
        if (!m || m.dist > Math.max(R, 15_000)) continue;
        const f = c.field ?? "gust";
        const tF = m.t != null ? m.t * 1.8 + 32 : null;
        const gust = m.wg != null ? m.wg * 1.15078 : null; // kt → mph
        const v = c.value ?? 50;
        if (f === "gust" && gust != null && gust >= v) return { key: "", msg: `${m.id} gust ${Math.round(gust)} mph near ${l.label}`, vars: { event: "Wind gust", value: String(Math.round(gust)), place: l.label } };
        if (f === "temp_hi" && tF != null && tF >= v) return { key: "", msg: `${m.id} temperature ${Math.round(tF)}°F near ${l.label}`, vars: { event: "Temperature", value: String(Math.round(tF)), place: l.label } };
        if (f === "temp_lo" && tF != null && tF <= v) return { key: "", msg: `${m.id} temperature ${Math.round(tF)}°F near ${l.label}`, vars: { event: "Temperature", value: String(Math.round(tF)), place: l.label } };
      }
      return null;
    }
    case "spc": {
      const l = locs[0];
      const s = await spcLevel(l.lat, l.lon, 1);
      if (s.level >= (c.value ?? 2)) return { key: s.label, msg: `SPC day 1: ${SPC_NAME[s.level]} risk (${s.label}) for ${l.label}`, vars: { event: `${SPC_NAME[s.level]} risk`, value: s.label, place: l.label } };
      return null;
    }
    /* detection models: a model detection within X mi */
    case "mldet": {
      const dets = await freshDetections(25);
      const minp = (c.value ?? 50) / 100;
      const cut = Date.now() - 20 * 60_000;
      for (const d of dets) {
        if (d.t < cut || d.prob < minp || (c.model && d.model_id !== c.model)) continue;
        for (const l of locs) {
          const dist = distance(l.lat, l.lon, d.lat, d.lon);
          if (dist <= R) {
            const what = `${tmeta(d.target).name} detection (${Math.round(d.prob * 100)}%, ${d.model_name})`;
            return { key: `${d.model_id}|${d.cell_id ?? d.site}`, msg: `${what} ${fmtMi(dist)} from ${l.label}`, vars: { event: what, dist: fmtMi(dist), place: l.label, value: String(Math.round(d.prob * 100)) } };
          }
        }
      }
      return null;
    }
    case "dbz": {
      const sample = locs.slice(0, 60);
      const { values } = await dbzAt(sample);
      for (let i = 0; i < sample.length; i++) if (values[i] >= (c.value ?? 50)) return { key: "", msg: `Radar ${Math.round(values[i])} dBZ at ${sample[i].label}`, vars: { event: "Radar", value: String(Math.round(values[i])), place: sample[i].label } };
      return null;
    }
  }
  return null;
}

export function describe(c: RuleCond): string {
  const where = c.where === "gps" ? "my GPS position" : c.where === "route" ? "my route" : settings.value.points.find((p) => p.id === c.where)?.name ?? "my first point";
  switch (c.kind) {
    case "alert":
      return `${c.event || "Any warning"} within ${c.mi} mi of ${where}`;
    case "rotation":
      return `${c.rot === "tvs" ? "TVS" : `Rotation (meso rank ≥ ${c.value ?? 5})`} within ${c.mi} mi of ${where}`;
    case "lightning":
      return `Lightning within ${c.mi} mi of ${where} in the last ${c.minutes ?? 15} min`;
    case "eta":
      return `Storm cell reaching ${where} in < ${c.value ?? 20} min`;
    case "aqi":
      return `AQI > ${c.value ?? 150} near ${where}`;
    case "metar":
      return c.field === "temp_lo" ? `METAR temperature ≤ ${c.value}°F near ${where}` : c.field === "temp_hi" ? `METAR temperature ≥ ${c.value}°F near ${where}` : `METAR gust ≥ ${c.value} mph near ${where}`;
    case "spc":
      return `SPC day-1 risk ≥ ${SPC_NAME[c.value ?? 2]} at ${where}`;
    case "dbz":
      return `Radar ≥ ${c.value ?? 50} dBZ at ${where}`;
    case "mldet":
      return `Model detection ≥ ${c.value ?? 50}% within ${c.mi} mi of ${where}`; // detection models
  }
}

// ---------- actions ----------
function quiet(): boolean {
  const q = settings.value.wf6.quiet;
  if (!q.on) return false;
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  const p = (s: string) => {
    const [h, mm] = s.split(":").map(Number);
    return (h || 0) * 60 + (mm || 0);
  };
  const a = p(q.from), b = p(q.to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

export function fillTemplate(t: string, r: Rule, h: Hit): string {
  return t.replace(/\{(\w+)\}/g, (_, k) => (k === "rule" ? r.name : k === "msg" ? h.msg : h.vars[k] ?? ""));
}

export async function runActions(r: Rule, h: Hit, test = false) {
  const a: RuleAction = r.act;
  const silent = quiet() && !test;
  if (a.sound && a.sound !== "off" && !silent) playNamed(a.sound);
  if (a.desktop && "Notification" in window) {
    const show = () => new Notification(r.name, { body: h.msg, silent: true });
    if (Notification.permission === "granted") show();
    else if (Notification.permission !== "denied") Notification.requestPermission().then((p) => p === "granted" && show());
  }
  toast(`${r.name}: ${h.msg}`, "alert", 9000);
  if (a.tts && !silent && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(fillTemplate(a.tts, r, h));
    u.volume = settings.value.audio.volume;
    const v = settings.value.wf6.briefing.voice;
    if (v) u.voice = speechSynthesis.getVoices().find((x) => x.name === v) ?? null;
    setTimeout(() => speechSynthesis.speak(u), a.sound && a.sound !== "off" ? 1800 : 0);
  }
  if (a.flash && !silent) {
    flashOn.value = true;
    setTimeout(() => (flashOn.value = false), 6000);
    (window as any).tbw?.wf6?.flash?.();
  }
  if (a.webhook) {
    const body = { rule: r.name, message: h.msg, time: new Date().toISOString(), test, vars: h.vars, condition: describe(r.cond) };
    try {
      if (test) {
        const res = await api.send("POST", "/api/rules/webhook-test", { url: a.webhook, payload: body }).catch(async (e) => {
          if (e instanceof ApiError && e.status === 404) {
            const x = await fetch(a.webhook!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            return { status: x.status };
          }
          throw e;
        });
        toast(`Webhook test: ${res?.status ?? res?.ok ?? "sent"}`);
      } else await fetch(a.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), mode: "no-cors" });
    } catch (e: any) {
      toast(`Webhook failed: ${e.message}`, "warn");
    }
  }
  if (a.open && !test) {
    if (a.open.startsWith("ws:")) applyWorkspace(a.open.slice(3));
    else if (a.open.startsWith("ovl:")) update((s) => (s.ovl[a.open!.slice(4)] = { ...(s.ovl[a.open!.slice(4)] ?? {}), on: true }));
  }
  log({ t: Date.now(), rule: r.name, msg: h.msg, test });
}

export async function testRule(r: Rule) {
  let h: Hit | null = null;
  try {
    h = await check(r);
  } catch {
    /* data not available */
  }
  await runActions(r, h ?? { key: "test", msg: `Test — ${describe(r.cond)} (condition is ${h ? "TRUE" : "false"} right now)`, vars: { event: "Test", dist: "5 mi", place: "Home", value: "0", min: "10", area: "" } }, true);
}

// ---------- evaluation loop ----------
const fired = new Map<string, number>(); // rule id + key → time
let busy = false;
let again = false;
async function evaluateAll() {
  if (busy) return void (again = true);
  busy = true;
  try {
    const st: Record<string, { hit: boolean; text: string }> = {};
    for (const r of settings.value.wf6.rules) {
      if (!r.on) continue;
      let h: Hit | null = null;
      try {
        h = await check(r);
      } catch (e: any) {
        st[r.id] = { hit: false, text: `error: ${e.message}` };
        continue;
      }
      st[r.id] = { hit: !!h, text: h?.msg ?? "" };
      if (!h) continue;
      const k = `${r.id}|${h.key}`;
      const last = Math.max(fired.get(k) ?? 0, h.key ? 0 : fired.get(`${r.id}|`) ?? 0);
      if (Date.now() - last < Math.max(1, r.cooldown) * 60_000) continue;
      fired.set(k, Date.now());
      fired.set(`${r.id}|`, Date.now());
      await runActions(r, h);
    }
    ruleState.value = st;
  } finally {
    busy = false;
    if (again) {
      again = false;
      setTimeout(evaluateAll, 2000);
    }
  }
}

let started = false;
export function startRules() {
  if (started) return;
  started = true;
  pullRules();
  api.on("connected", pullRules);
  let deb: number | undefined;
  const kick = () => {
    clearTimeout(deb);
    deb = window.setTimeout(() => settings.value.wf6.rules.some((r) => r.on) && evaluateAll(), 1500);
  };
  effect(() => {
    void alerts.value;
    void fix.value;
    void settings.value.wf6.rules;
    void route.value;
    kick();
  });
  setInterval(kick, 30_000);
  /* detection models: keep detections polling while an enabled rule needs them */
  let stopDet: (() => void) | null = null;
  effect(() => {
    const need = settings.value.wf6.rules.some((r) => r.on && r.cond.kind === "mldet");
    if (need && !stopDet) stopDet = startDetections();
    if (!need && stopDet) (stopDet(), (stopDet = null));
  });
}

export function newRule(kind: RuleCond["kind"] = "alert"): Rule {
  const where = settings.value.points[0]?.id ?? "gps";
  const presets: Record<RuleCond["kind"], Partial<RuleCond>> = {
    alert: { event: "Tornado Warning", mi: 10 },
    rotation: { rot: "meso", value: 5, mi: 15 },
    lightning: { mi: 5, minutes: 10 },
    eta: { value: 20, mi: 3 },
    aqi: { value: 150, mi: 25 },
    metar: { field: "gust", value: 50, mi: 15 },
    spc: { value: 3, mi: 0 },
    dbz: { value: 50, mi: 0 },
    mldet: { value: 60, mi: 15, model: "" }, // detection models
  };
  return { id: uid(), name: describe({ kind, where, mi: 10, ...presets[kind] } as RuleCond), on: true, cond: { kind, where, mi: 10, ...presets[kind] } as RuleCond, act: { sound: "alarm", desktop: true, tts: "{msg}" }, cooldown: 30 };
}
