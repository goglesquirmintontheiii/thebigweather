// models 0.8: per-model running (enable / stop / run now / history runs), training-job limits,
// detections by time (timeline animation + history mode), model reports, ensembles and A/B
// comparisons. Everything is written defensively: older servers answer 404 and the UI falls back
// (per-model run → the global runner, time queries → the live detections already in memory).

import { signal, computed, effect } from "@preact/signals";
import { api, ApiError } from "../api";
import { settings, toast } from "../store";
import { histRange } from "../anim";
// active.ts sits in an import cycle with the overlays (active → radar → … → mldefs → here): load it
// once everything has initialised
const activeMod = signal<typeof import("../active") | null>(null);
setTimeout(() => void import("../active").then((m) => (activeMod.value = m)), 0);
const frames = () => activeMod.value?.activeFrames.value ?? [];
const nowFrameTime = () => activeMod.value?.activeTime.value ?? 0;
import { mlReq, mlBin, liveEps, ensureLocal, loadRun, runState, detections, detectionsFromFeatures, models, mkey, loadJobs, jobs, normJob, pollDetections, loadModels, localUrl, localIsMain } from "./client";
import type { Detection, Ep, Job, Model, ModelRun } from "./types";

const enc = encodeURIComponent;
const num = (v: any, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : v != null && v !== "" && Number.isFinite(+v) ? +v : d);
const tms = (v: any): number | undefined => (v == null || v === "" ? undefined : typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined);
const missing = (e: any) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/* ---------- training-job limits (GET/PUT /api/ml/settings) ---------- */
export const mlSettings = signal<Partial<Record<Ep, { max_jobs: number; supported: boolean } | null>>>({});
export async function loadMlSettings() {
  const out: Partial<Record<Ep, { max_jobs: number; supported: boolean } | null>> = {};
  await Promise.all(
    liveEps().map(async (ep) => {
      try {
        const r = await mlReq<any>(ep, "GET", "/api/ml/settings");
        out[ep] = { max_jobs: Math.max(1, Math.min(8, Math.round(num(r?.max_jobs, 2)))), supported: true };
      } catch (e) {
        out[ep] = missing(e) ? { max_jobs: 2, supported: false } : null;
      }
    }),
  );
  mlSettings.value = out;
}
export async function setMaxJobs(ep: Ep, n: number) {
  const v = Math.max(1, Math.min(8, Math.round(n)));
  const prev = mlSettings.value;
  mlSettings.value = { ...prev, [ep]: { max_jobs: v, supported: true } };
  try {
    if (ep === "local" && !(await ensureLocal())) throw new Error("the built-in server isn't running");
    await mlReq(ep, "PUT", "/api/ml/settings", { max_jobs: v });
    loadJobs(); // lowering the limit pauses jobs
  } catch (e: any) {
    mlSettings.value = prev;
    toast(`Couldn't set the job limit: ${e.message}`, "error");
  }
}

/* ---------- per-model run (GET/PUT /api/ml/models/{id}/run) ---------- */
export const modelRuns = signal<Record<string, ModelRun & { legacy?: boolean }>>({});
function normRun(r: any): ModelRun {
  return { enabled: !!r?.enabled, options: r?.options && typeof r.options === "object" ? r.options : undefined, radars: r?.radars, state: r?.state, last_run: tms(r?.last_run), error: r?.error || undefined, detections: r?.detections != null ? num(r.detections) : undefined };
}
/** the global runner's view of one model (older servers) */
function legacyRun(m: Model): ModelRun & { legacy: true } {
  const st = runState.value[m.ep];
  const on = !!st?.enabled && st.models.includes(m.id);
  const ms = st?.models_state?.[m.id];
  return { enabled: on, options: st?.model_opts?.[m.id], radars: st?.radars, state: ms?.state, last_run: tms(ms?.last_run), error: ms?.error, legacy: true };
}
export async function loadModelRun(m: Model) {
  const k = mkey(m);
  try {
    const r = await mlReq<any>(m.ep, "GET", `/api/ml/models/${enc(m.id)}/run`);
    modelRuns.value = { ...modelRuns.value, [k]: normRun(r) };
  } catch (e) {
    if (!missing(e)) return;
    await loadRun();
    modelRuns.value = { ...modelRuns.value, [k]: legacyRun(m) };
  }
}
export const runOf = (m: Model): (ModelRun & { legacy?: boolean }) | undefined => modelRuns.value[mkey(m)];
/** enable / stop one model. Stopping removes its detections (server and map). */
export async function setModelRun(m: Model, body: { enabled: boolean; options?: Record<string, any>; radars?: any }): Promise<boolean> {
  const k = mkey(m);
  try {
    if (m.ep === "local" && !(await ensureLocal())) return false;
    let legacy = !!modelRuns.value[k]?.legacy;
    if (!legacy) {
      try {
        const r = await mlReq<any>(m.ep, "PUT", `/api/ml/models/${enc(m.id)}/run`, body);
        modelRuns.value = { ...modelRuns.value, [k]: r && typeof r === "object" && "enabled" in r ? normRun(r) : { ...body } };
      } catch (e) {
        if (!missing(e)) throw e;
        legacy = true;
      }
    }
    if (legacy) {
      // global runner: add / remove this model, keep the others
      await loadRun();
      const st = runState.value[m.ep];
      const others = (st?.models ?? []).filter((id) => id !== m.id).map((id) => (st?.model_opts?.[id] ? { id, ...st.model_opts[id] } : id));
      const mine = body.options && Object.keys(body.options).length ? { id: m.id, ...body.options } : m.id;
      const list = body.enabled ? [...others, mine] : others;
      await mlReq(m.ep, "POST", "/api/ml/run", { models: list, radars: body.radars ?? st?.radars ?? "all", enabled: list.length > 0, interval_s: st?.interval_s, concurrency: st?.concurrency });
      await loadRun();
      modelRuns.value = { ...modelRuns.value, [k]: legacyRun(m) };
    }
    if (!body.enabled) dropDetections(m.ep, m.id);
    else pollDetections();
    loadRun();
    return true;
  } catch (e: any) {
    toast(`Couldn't ${body.enabled ? "start" : "stop"} “${m.name}”: ${e.message}`, "error");
    return false;
  }
}
/** remove a model's detections from the map (it was stopped) */
export function dropDetections(ep: Ep, id: string) {
  if (detections.peek().some((d) => d.ep === ep && d.model_id === id && !d.test)) detections.value = detections.peek().filter((d) => !(d.ep === ep && d.model_id === id && !d.test));
}
/** model keys known to be stopped / disabled: their detections are hidden (#15) */
export const stoppedModels = computed(() => {
  const out = new Set<string>();
  const runs = modelRuns.value;
  for (const [k, r] of Object.entries(runs)) if (!r.enabled) out.add(k);
  for (const [ep, st] of Object.entries(runState.value) as [Ep, any][]) {
    if (!st) continue;
    for (const m of models.value) {
      if (m.ep !== ep || runs[mkey(m)]) continue;
      // the global runner says it's off (or doesn't run this model) and no per-model run says otherwise
      if (!st.enabled || !st.models.includes(m.id)) out.add(mkey(m));
    }
  }
  return out;
});
// WebSocket: a model was enabled / stopped elsewhere
api.on("ml_run_state", (m) => {
  const id = String(m?.model_id ?? m?.id ?? "");
  if (!id) return;
  const ep: Ep = m?.ep === "local" ? "local" : "main";
  const k = `${ep}|${id}`;
  modelRuns.value = { ...modelRuns.value, [k]: { ...(modelRuns.value[k] ?? {}), ...normRun({ ...(modelRuns.value[k] ?? {}), ...m }) } };
  if (m?.enabled === false) dropDetections(ep, id);
});

/* ---------- one-shot runs with progress: run now (all radars) and history runs ---------- */
export interface RunJob {
  ep: Ep;
  id: string;
  kind: "now" | "history";
  state: string;
  progress: number;
  models: string[];
  from?: number;
  to?: number;
  error?: string;
  detections?: number;
  started: number;
}
export const runJobs = signal<Record<string, RunJob>>({});
const jk = (j: { ep: Ep; id: string }) => `${j.ep}|${j.id}`;
function track(j: RunJob) {
  runJobs.value = { ...runJobs.value, [jk(j)]: j };
  const tick = async () => {
    const cur = runJobs.peek()[jk(j)];
    if (!cur) return;
    try {
      const r = await mlReq<any>(j.ep, "GET", `/api/ml/jobs/${enc(j.id)}`);
      const n = normJob(r, j.ep);
      const next: RunJob = { ...cur, state: n.state, progress: n.progress ?? cur.progress, error: n.error, detections: r?.counts?.detections ?? r?.detections ?? cur.detections };
      runJobs.value = { ...runJobs.peek(), [jk(j)]: next };
      if (j.kind === "history") refreshTimeDets(true);
      if (["done", "failed", "cancelled", "interrupted"].includes(n.state)) {
        if (j.kind === "now") pollDetections();
        if (n.state === "done") toast(j.kind === "history" ? `History run finished · ${next.detections ?? "?"} detections` : "Run finished · detections on the map", "info", 6000);
        else if (n.state === "failed") toast(`Run failed: ${n.error ?? "error"}`, "error", 8000);
        return;
      }
    } catch {
      /* transient */
    }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 800);
}
export function jobsFor(m: Model): RunJob[] {
  return Object.values(runJobs.value).filter((j) => j.ep === m.ep && j.models.includes(m.id)).sort((a, b) => b.started - a.started);
}
const runItemOf = (m: Model, opts?: Record<string, any>) => (opts && Object.keys(opts).length ? { id: m.id, ...opts } : m.id);
/** run once now on every radar (current conditions) */
export async function runNow(ms: Model[], opts: Record<string, Record<string, any>> = {}, radars: any = "all"): Promise<RunJob | null> {
  const ep = ms[0]?.ep ?? "main";
  try {
    if (ep === "local" && !(await ensureLocal())) return null;
    const r = await mlReq<any>(ep, "POST", "/api/ml/run/now", { models: ms.map((m) => runItemOf(m, opts[mkey(m)])), radars });
    const id = String(r?.job_id ?? r?.id ?? "");
    pollDetections();
    if (!id) {
      // synchronous answer (features inline)
      pollDetections();
      return null;
    }
    const j: RunJob = { ep, id, kind: "now", state: "running", progress: 0, models: ms.map((m) => m.id), started: Date.now() };
    track(j);
    return j;
  } catch (e: any) {
    toast(missing(e) ? "This server can't run models on demand yet (update the server)" : `Run failed: ${e.message}`, "error");
    return null;
  }
}
/** run on the history range (POST /api/ml/run/history) — detections land on the timeline */
export async function runHistory(ms: Model[], radars: any, from: number, to: number, step_min: number, opts: Record<string, Record<string, any>> = {}): Promise<RunJob | null> {
  const ep = ms[0]?.ep ?? "main";
  try {
    if (ep === "local" && !(await ensureLocal())) return null;
    const r = await mlReq<any>(ep, "POST", "/api/ml/run/history", { models: ms.map((m) => runItemOf(m, opts[mkey(m)])), radars, from: Math.round(from), to: Math.round(to), step_min });
    const id = String(r?.job_id ?? r?.id ?? "");
    timeSync.value = true;
    const j: RunJob = { ep, id, kind: "history", state: "running", progress: 0, models: ms.map((m) => m.id), from, to, started: Date.now() };
    if (id) track(j);
    refreshTimeDets(true);
    loadJobs();
    return j;
  } catch (e: any) {
    toast(missing(e) ? "This server can't run models on past data yet (update the server)" : `History run failed: ${e.message}`, "error");
    return null;
  }
}

/* ---------- per-model detections list ---------- */
export async function modelDetections(m: Model, from?: number, to?: number): Promise<Detection[]> {
  const q = new URLSearchParams();
  if (from) q.set("from", String(Math.round(from)));
  if (to) q.set("to", String(Math.round(to)));
  try {
    const r = await mlReq<any>(m.ep, "GET", `/api/ml/models/${enc(m.id)}/detections${q.size ? `?${q}` : ""}`);
    return detectionsFromFeatures(Array.isArray(r) ? r : r?.features ?? [], m.ep).sort((a, b) => b.t - a.t);
  } catch {
    return detections.peek().filter((d) => d.ep === m.ep && d.model_id === m.id);
  }
}

/* ---------- detections by time: the map follows the timeline (#6) and history mode (#2) ---------- */
/** sync the detection layer with the frame on screen (off = always the newest) */
export const timeSync = signal(true);
/** detections fetched for a time range (every instance kept, keyed with its time) */
export const timeDets = signal<{ from: number; to: number; list: Detection[]; t: number; loading?: boolean; error?: string }>({ from: 0, to: 0, list: [], t: 0 });
/** the range the timeline covers: the history window, else the loop's frames */
export const timeRange = computed<{ from: number; to: number; hist: boolean } | null>(() => {
  const h = histRange.value;
  if (h) return { from: h.start, to: h.end, hist: true };
  const fs = frames();
  if (fs.length < 2) return null;
  return { from: fs[0].time, to: fs[fs.length - 1].time, hist: false };
});
/** typical step between frames (ms), for how long a detection stays on screen while animating */
export const frameStepMs = computed(() => {
  const fs = frames();
  if (fs.length < 2) return 10 * 60_000;
  const d = fs.slice(1).map((f, i) => f.time - fs[i].time).filter((x) => x > 0).sort((a, b) => a - b);
  return Math.max(4 * 60_000, Math.min(3 * 3600_000, d[Math.floor(d.length / 2)] ?? 10 * 60_000));
});
/** time the detection layer shows: null = live (newest) */
export const detTime = computed<number | null>(() => {
  if (!timeSync.value) return null;
  const r = timeRange.value;
  if (!r) return null;
  const t = nowFrameTime();
  if (!t) return r.hist ? r.to : null;
  // live loop parked on the newest frame: show the newest detections as before
  if (!r.hist && t >= r.to - 30_000) return null;
  return t;
});
let tdSeq = 0;
let tdLast = 0;
export async function refreshTimeDets(force = false) {
  const r = timeRange.peek();
  if (!r) return;
  const cur = timeDets.peek();
  const same = Math.abs(cur.from - r.from) < 60_000 && Math.abs(cur.to - r.to) < 60_000;
  if (!force && same && Date.now() - cur.t < (r.hist ? 5 * 60_000 : 60_000)) return;
  if (!force && Date.now() - tdLast < 4000) return;
  tdLast = Date.now();
  const seq = ++tdSeq;
  const from = r.from - 30 * 60_000, to = r.to + 5 * 60_000;
  timeDets.value = { ...cur, loading: true };
  const got: Detection[] = [];
  let err = "";
  await Promise.all(
    liveEps().map(async (ep) => {
      try {
        const res = await mlReq<any>(ep, "GET", `/api/ml/detections?from=${Math.round(from)}&to=${Math.round(to)}`);
        got.push(...detectionsFromFeatures(Array.isArray(res) ? res : res?.features ?? [], ep).map((d) => ({ ...d, key: `${d.key}@${d.t}`, hist: r.hist })));
      } catch (e: any) {
        if (ep === "main") err = e.message;
      }
    }),
  );
  if (seq !== tdSeq) return;
  timeDets.value = { from: r.from, to: r.to, list: got, t: Date.now(), error: err || undefined };
}
/** detections to draw at time T: cells within one frame step before T, areas valid at T */
export function detsAt(T: number): Detection[] {
  const win = Math.max(frameStepMs.peek(), 5 * 60_000);
  const src = timeDets.value.list.length ? timeDets.value.list : detections.value;
  const out = new Map<string, Detection>();
  for (const d of src) {
    const ok = d.valid_from != null || d.valid_to != null ? (d.valid_from ?? d.t) - 1 <= T && T <= (d.valid_to ?? d.t + win) : d.t <= T + 30_000 && d.t > T - win;
    if (!ok) continue;
    // one instance per cell: the newest before T
    const base = d.key.replace(/@\d+$/, "");
    const o = out.get(base);
    if (!o || o.t < d.t) out.set(base, d);
  }
  return [...out.values()];
}
// fetch while the layer animates (range change, history mode); a minute's refresh while live
let tdTimer: number | undefined;
effect(() => {
  const r = timeRange.value;
  const on = timeSync.value && !!settings.value.ovl["mldetect"]?.on;
  void detTime.value; // re-evaluates when the user starts scrubbing
  clearTimeout(tdTimer);
  if (!r || !on) return;
  if (!r.hist && detTime.peek() == null && !timeDets.peek().list.length) return; // parked on the newest frame: nothing to fetch yet
  tdTimer = window.setTimeout(() => refreshTimeDets(), 600);
});

/* ---------- model reports (Phase 8) ---------- */
export interface Report {
  key: string;
  ep: Ep;
  id: string;
  t: number;
  model_id: string;
  model_name: string;
  target: string;
  prob: number;
  level?: string;
  lat: number;
  lon: number;
  site?: string;
  text?: string;
  verified?: boolean | null;
}
export const reports = signal<Report[]>([]);
export const reportsState = signal<{ loading?: boolean; error?: string; t?: number }>({});
function normReport(r: any, ep: Ep): Report | null {
  const p = r?.properties ?? r ?? {};
  const g = r?.geometry?.type === "Point" ? r.geometry.coordinates : null;
  const lon = num(p.lon ?? g?.[0], NaN), lat = num(p.lat ?? g?.[1], NaN);
  const t = tms(p.t ?? p.time ?? p.issued);
  if (!t) return null;
  let prob = num(p.prob, NaN);
  if (prob > 1) prob /= 100;
  const id = String(p.id ?? r?.id ?? `${p.model_id}|${t}|${lon}`);
  return { key: `${ep}|${id}`, ep, id, t, model_id: String(p.model_id ?? ""), model_name: p.model_name || models.peek().find((m) => m.id === String(p.model_id))?.name || "Model", target: p.target || "custom", prob: Number.isFinite(prob) ? prob : 0, level: p.level, lat, lon, site: p.site, text: p.text ?? p.summary ?? p.description, verified: p.verified ?? null };
}
export interface ReportQuery {
  from: number;
  to: number;
  bbox?: [number, number, number, number] | null;
  models?: string[];
}
const rq = (q: ReportQuery) => {
  const u = new URLSearchParams({ from: String(Math.round(q.from)), to: String(Math.round(q.to)) });
  if (q.bbox) u.set("bbox", q.bbox.map((v) => v.toFixed(3)).join(","));
  if (q.models?.length) u.set("models", q.models.join(","));
  return u;
};
export async function loadReports(q: ReportQuery) {
  reportsState.value = { ...reportsState.value, loading: true };
  const out: Report[] = [];
  let err = "";
  await Promise.all(
    liveEps().map(async (ep) => {
      try {
        const r = await mlReq<any>(ep, "GET", `/api/ml/reports?${rq(q)}`);
        const list = Array.isArray(r) ? r : r?.reports ?? r?.features ?? [];
        for (const x of list) {
          const n = normReport(x, ep);
          if (n) out.push(n);
        }
      } catch (e: any) {
        if (ep === "main") err = missing(e) ? "This server has no model reports yet (update the server)" : e.message;
      }
    }),
  );
  reports.value = out.sort((a, b) => b.t - a.t);
  reportsState.value = { error: err || undefined, t: Date.now() };
}
api.on("ml_report", (m) => {
  const n = normReport(m?.report ?? m, "main");
  if (n && !reports.peek().some((r) => r.key === n.key)) reports.value = [n, ...reports.peek()].slice(0, 5000);
});
/** CSV / GeoJSON from the server; falls back on the list in memory */
export async function exportReports(q: ReportQuery, format: "csv" | "geojson", list: Report[]): Promise<{ name: string; blob: Blob }> {
  const name = `model-reports-${new Date(q.from).toISOString().slice(0, 10)}_${new Date(q.to).toISOString().slice(0, 10)}.${format === "csv" ? "csv" : "geojson"}`;
  try {
    const u = rq(q);
    u.set("format", format);
    const { buf } = await mlBin("main", `/api/ml/reports/export?${u}`);
    if (buf.byteLength) return { name, blob: new Blob([buf], { type: format === "csv" ? "text/csv" : "application/geo+json" }) };
  } catch {
    /* build locally */
  }
  if (format === "csv") {
    const esc = (v: any) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = [["time_utc", "model", "target", "prob", "lat", "lon", "site", "text"], ...list.map((r) => [new Date(r.t).toISOString(), r.model_name, r.target, r.prob.toFixed(3), r.lat.toFixed(4), r.lon.toFixed(4), r.site ?? "", r.text ?? ""])];
    return { name, blob: new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" }) };
  }
  const fc = { type: "FeatureCollection", features: list.map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] }, properties: { id: r.id, t: new Date(r.t).toISOString(), model_id: r.model_id, model_name: r.model_name, target: r.target, prob: r.prob, site: r.site, text: r.text } })) };
  return { name, blob: new Blob([JSON.stringify(fc)], { type: "application/geo+json" }) };
}

/* ---------- ensembles ---------- */
export const ENS_METHODS: [string, string, string][] = [
  ["mean", "Average", "Mean of the members' probabilities"],
  ["weighted", "Weighted average", "Members weighted (e.g. by skill)"],
  ["max", "Maximum", "The highest member probability (most sensitive)"],
  ["vote", "Majority vote", "Share of members above their own threshold"],
  ["stack", "Stacked (logistic)", "A small model learns how to combine the members"],
];
export async function createEnsemble(ep: Ep, body: { name: string; members: string[]; method: string; weights?: number[] }): Promise<Model | null> {
  try {
    const r = await mlReq<any>(ep, "POST", "/api/ml/ensembles", body);
    toast(`Ensemble “${body.name}” created`);
    await loadModels();
    const id = String(r?.id ?? r?.model?.id ?? "");
    return models.peek().find((m) => m.ep === ep && m.id === id) ?? null;
  } catch (e: any) {
    toast(missing(e) ? "This server can't build ensembles yet (update the server)" : `Couldn't create the ensemble: ${e.message}`, "error");
    return null;
  }
}

/* ---------- A/B compare ---------- */
export interface Scorecard {
  model_id: string;
  name: string;
  auc?: number;
  csi?: number;
  pod?: number;
  far?: number;
  brier?: number;
  hits?: number;
  misses?: number;
  false_alarms?: number;
  lead_min?: number;
  reliability?: { p: number; obs: number; n: number }[];
  [k: string]: any;
}
export interface CompareEvent {
  id: string;
  t?: number;
  lat?: number;
  lon?: number;
  desc?: string;
  kind?: string;
  outcomes: Record<string, { hit?: boolean; prob?: number; lead_min?: number; fa?: boolean }>;
}
export interface CompareResult {
  ep: Ep;
  id: string;
  state: string;
  progress: number;
  error?: string;
  models: string[];
  scorecards: Scorecard[];
  events: CompareEvent[];
  t: number;
}
export const compareRes = signal<CompareResult | null>(null);
function normCompare(r: any, ep: Ep, id: string, models0: string[]): CompareResult {
  const sc: Scorecard[] = (Array.isArray(r?.scorecards) ? r.scorecards : r?.scorecards && typeof r.scorecards === "object" ? Object.entries(r.scorecards).map(([k, v]: any) => ({ model_id: k, ...v })) : []).map((s: any) => ({
    ...s,
    model_id: String(s.model_id ?? s.id ?? ""),
    name: s.name ?? models.peek().find((m) => m.id === String(s.model_id ?? s.id))?.name ?? String(s.model_id ?? s.id),
    auc: s.auc ?? s.roc_auc,
    reliability: Array.isArray(s.reliability) ? s.reliability.map((b: any) => ({ p: num(b.p ?? b.mean_pred), obs: num(b.obs ?? b.obs_freq), n: num(b.n) })) : undefined,
  }));
  const ev: CompareEvent[] = (Array.isArray(r?.events) ? r.events : []).map((e: any, i: number) => ({ ...e, id: String(e.id ?? i), t: tms(e.t ?? e.time), outcomes: e.outcomes && typeof e.outcomes === "object" ? e.outcomes : {} }));
  let progress = num(r?.progress, 0);
  if (progress > 1) progress /= 100;
  return { ep, id, state: r?.state ?? (sc.length ? "done" : "running"), progress, error: r?.error, models: Array.isArray(r?.models) ? r.models.map(String) : models0, scorecards: sc, events: ev, t: Date.now() };
}
export async function startCompare(ep: Ep, ids: string[], events: Record<string, any>): Promise<string | null> {
  try {
    if (ep === "local" && !(await ensureLocal())) return null;
    const r = await mlReq<any>(ep, "POST", "/api/ml/compare", { models: ids, events });
    const id = String(r?.job_id ?? r?.id ?? "");
    compareRes.value = { ep, id, state: "running", progress: 0, models: ids, scorecards: [], events: [], t: Date.now() };
    const tick = async () => {
      if (compareRes.peek()?.id !== id) return;
      try {
        const c = normCompare(await mlReq<any>(ep, "GET", `/api/ml/compare/${enc(id)}`), ep, id, ids);
        compareRes.value = c;
        if (["done", "failed", "cancelled"].includes(c.state)) return;
      } catch {
        /* transient */
      }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 500);
    return id;
  } catch (e: any) {
    toast(missing(e) ? "This server can't compare models yet (update the server)" : `Couldn't start the comparison: ${e.message}`, "error");
    return null;
  }
}
export async function openCompare(ep: Ep, id: string) {
  try {
    compareRes.value = normCompare(await mlReq<any>(ep, "GET", `/api/ml/compare/${enc(id)}`), ep, id, []);
  } catch (e: any) {
    toast(`Couldn't load the comparison: ${e.message}`, "error");
  }
}

/* ---------- training placeholders follow job progress ---------- */
api.on("ml_job", (m) => {
  const id = String(m?.id ?? "");
  if (!id || m?.progress == null) return;
  const k = `job:${id}`;
  if (!models.peek().some((x) => x.id === k)) return;
  let p = num(m.progress);
  if (p > 1) p /= 100;
  models.value = models.peek().map((x) => (x.id === k ? { ...x, progress: p, state: m.state ?? x.state } : x));
});
/** jobs of one model's runs (history / run-now) listed in Jobs too */
export const runJobList = computed<Job[]>(() => jobs.value.filter((j) => j.type === "history" || j.type === "run_now"));

/** bytes → "12.3 MB" */
export function fmtBytes(b?: number): string {
  if (b == null || !Number.isFinite(b)) return "—";
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
export const INTENSITIES: [string, string][] = [["quick", "Quick"], ["medium", "Medium"], ["thorough", "Thorough"], ["intensive", "Intensive"]];
/** where the built-in server lives (for labels) */
export const localOn = computed(() => !!localUrl.value || localIsMain.value);
