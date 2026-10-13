// Detection models: client for /api/ml/* on the main server and on the server bundled with the
// desktop app ("This computer"), plus the shared state (catalog, models, jobs, runner, detections).

import { signal, computed } from "@preact/signals";
import { api, ApiError } from "../api";
import { settings, activeServer, toast } from "../store";
import { hasDesktop, localServer, BUILTIN_ID } from "../share/desktop";
import type { Catalog, Detection, Ep, Job, Metrics, Model, RunState, TrainSpec, HistoryEntry, ModelRunOpts, PredLayer, TargetDef } from "./types";
import { levelOf, normTarget, outputOf, taskOf } from "./targets";
import { gridLayers, type GridLayerDef } from "../weather"; // models 0.7

// ---------- endpoints ----------
/** base URL of the app's bundled server once it is known to be running ("" = not running) */
export const localUrl = signal("");
export const localState = signal<"off" | "starting" | "on" | "unavailable">("off");
/** the active server already is the bundled one: "This computer" and "Server" are the same machine */
export const localIsMain = computed(() => activeServer.value?.id === BUILTIN_ID);
export const canLocal = () => hasDesktop() && !localIsMain.value && localState.value !== "unavailable";
export const EP_NAME: Record<Ep, string> = { main: "Server", local: "This computer" };
export const epName = (ep: Ep) => (ep === "main" && localIsMain.value ? "This computer" : ep === "main" ? activeServer.value?.name || "Server" : "This computer");

function base(ep: Ep): { url: string; token: string } {
  if (ep === "local" && !localIsMain.value) return { url: localUrl.value, token: "" };
  return { url: api.base, token: api.token };
}
const NO_ML = "This server has no detection-model support yet (update the server)";

export async function mlReq<T = any>(ep: Ep, method: string, path: string, body?: any, raw = false): Promise<T> {
  const b = base(ep);
  if (!b.url) throw new ApiError(0, ep === "local" ? "The built-in server isn't running" : "No server configured");
  const headers: Record<string, string> = {};
  if (b.token) headers.Authorization = `Bearer ${b.token}`;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (raw) {
      headers["Content-Type"] = "application/octet-stream";
      payload = body;
    } else {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const r = await fetch(b.url + path, { method, headers, body: payload });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* not json */
    }
    if (r.status === 404 && /^\/api\/ml\/(catalog|models|jobs|run)$/.test(path.split("?")[0])) msg = NO_ML;
    throw new ApiError(r.status, msg || `HTTP ${r.status}`);
  }
  const ct = r.headers.get("content-type") ?? "";
  if (r.status === 204) return undefined as T;
  if (ct.includes("json")) return r.json();
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t as any;
  }
}
async function mlBin(ep: Ep, path: string): Promise<{ buf: ArrayBuffer; name: string }> {
  const b = base(ep);
  const r = await fetch(b.url + path, { headers: b.token ? { Authorization: `Bearer ${b.token}` } : {} });
  if (!r.ok) throw new ApiError(r.status, r.statusText);
  const cd = r.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return { buf: await r.arrayBuffer(), name: m ? decodeURIComponent(m[1]) : "" };
}

/** Status of the bundled server (doesn't start it). */
export async function probeLocal(): Promise<string> {
  if (!canLocal()) return "";
  try {
    const st = await localServer("status");
    if (!st.available) {
      localState.value = "unavailable";
      return "";
    }
    if (st.running && st.url) {
      localUrl.value = st.url;
      localState.value = "on";
      return st.url;
    }
  } catch {
    /* old app build */
  }
  if (localState.value !== "starting") localState.value = "off";
  return "";
}

/** Start the bundled server (if needed) and wait until it answers. */
export async function ensureLocal(): Promise<boolean> {
  if (localIsMain.value) return true;
  if (!hasDesktop()) {
    toast("Training on this computer needs the desktop app", "warn");
    return false;
  }
  if (localUrl.value) {
    try {
      const r = await fetch(`${localUrl.value}/api/health`);
      if (r.ok) return true;
    } catch {
      /* restart below */
    }
  }
  localState.value = "starting";
  let st = await localServer("start");
  if (!st.available) {
    localState.value = "unavailable";
    toast(st.error || "This build has no bundled server", "error");
    return false;
  }
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${st.url}/api/health`);
      if (r.ok) {
        localUrl.value = st.url;
        localState.value = "on";
        return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
    st = await localServer("status");
    if (st.error && !st.running) break;
  }
  localState.value = "off";
  toast(`The built-in server didn't start: ${st.error || "timeout"}`, "error");
  return false;
}
/** endpoints worth asking right now */
export function liveEps(): Ep[] {
  const out: Ep[] = [];
  if (api.base) out.push("main");
  if (localUrl.value && !localIsMain.value) out.push("local");
  return out;
}

// ---------- normalisers ----------
const num = (v: any, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : v != null && v !== "" && Number.isFinite(+v) ? +v : d);
const tms = (v: any): number | undefined => {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : /^\d+$/.test(v) ? tms(+v) : undefined;
};
/** server metrics: list items carry {roc_auc, pr_auc, csi, …}; the full model {eval: {…, confusion,
 *  reliability[{lo,hi,n,mean_pred,obs_freq}], best_csi_threshold}, dataset: {samples, positives}} */
function normMetrics(raw: any): Metrics {
  const r = raw ?? {};
  const e = r.eval && typeof r.eval === "object" ? r.eval : r;
  const out: Metrics = { ...e };
  out.auc = e.auc ?? e.roc_auc ?? undefined;
  const nn = (v: any) => (v == null || !Number.isFinite(+v) ? undefined : +v);
  for (const k of ["auc", "pr_auc", "pod", "far", "csi", "brier", "threshold", "best_csi_threshold", "mae", "rmse", "bias", "r2", "skill"] as const) (out as any)[k] = nn((out as any)[k]);
  out.samples = nn(r.dataset?.samples ?? e.samples ?? e.n);
  out.positives = nn(r.dataset?.positives ?? e.positives);
  if (Array.isArray(e.reliability)) out.reliability = e.reliability.map((b: any) => ({ p: num(b.p ?? b.mean_pred), obs: num(b.obs ?? b.obs_freq), n: num(b.n) }));
  else delete out.reliability;
  if (r.eval_kind) out.eval_kind = r.eval_kind;
  return out;
}
export function normModel(m: any, ep: Ep): Model {
  const fs = Array.isArray(m.feature_schema) ? m.feature_schema : Array.isArray(m.feature_schema?.features) ? m.feature_schema.features : undefined;
  const metrics = normMetrics(m.metrics);
  return {
    ...m,
    id: String(m.id),
    ep,
    name: m.name || "Untitled model",
    labels: Array.isArray(m.labels) ? m.labels.map(String) : [],
    target: normTarget(m.target || m.spec?.target || "custom"),
    created: tms(m.created),
    updated: tms(m.updated),
    feature_schema: fs,
    metrics,
    importance: Array.isArray(m.importance) ? m.importance : [],
    threshold: num(m.threshold, metrics.best_csi_threshold ?? metrics.threshold ?? 0.5),
    // models 0.7
    task: taskOf(m.target || m.spec?.target || "", m.task ?? m.spec?.task),
    output: outputOf(m.target || m.spec?.target || "", m.output),
    version: m.version != null ? num(m.version, 1) : Array.isArray(m.history) && m.history.length ? Math.max(...m.history.map((h: any) => num(h.version, 1))) : 1,
    history: Array.isArray(m.history) ? m.history.map((h: any, i: number): HistoryEntry => ({ ...h, version: num(h.version, i + 1), at: tms(h.at), kind: h.kind || (i ? "retrain" : "train"), samples: h.samples != null ? num(h.samples) : undefined, metrics_summary: h.metrics_summary && typeof h.metrics_summary === "object" ? h.metrics_summary : undefined })) : [],
  };
}
export function normJob(j: any, ep: Ep): Job {
  return {
    ...j,
    id: String(j.id),
    ep,
    state: j.state || "queued",
    progress: num(j.progress, 0) > 1 ? num(j.progress) / 100 : num(j.progress, 0),
    started: tms(j.started),
    finished: tms(j.finished),
    log: Array.isArray(j.log) ? j.log : [],
    name: j.name || j.spec?.name || undefined,
    target: normTarget(j.target || j.spec?.target || "custom"),
    counts: j.counts ?? {},
  };
}
function geomCenter(g: any): [number, number] | null {
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  const pts: number[][] = [];
  const walk = (a: any) => (typeof a?.[0] === "number" ? pts.push(a) : a?.forEach?.(walk));
  walk(g.coordinates);
  if (!pts.length) return null;
  let x = 0, y = 0;
  for (const p of pts) (x += p[0]), (y += p[1]);
  return [x / pts.length, y / pts.length];
}
export function normDetection(f: any, ep: Ep): Detection | null {
  const p = f?.properties ?? f ?? {};
  const g = f?.geometry ?? (p.lon != null ? { type: "Point", coordinates: [p.lon, p.lat] } : null);
  const c = p.lon != null && p.lat != null ? [+p.lon, +p.lat] : p.centroid ?? geomCenter(g);
  if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  let prob = num(p.prob, 0);
  if (prob > 1) prob /= 100;
  const t = tms(p.t) ?? Date.now();
  const model_id = String(p.model_id ?? "");
  const area = p.kind === "area"; // models 0.7: grid models' areas
  const vf = tms(p.valid_from), vt = tms(p.valid_to);
  return {
    kind: area ? "area" : "cell",
    valid_from: vf,
    valid_to: vt,
    key: area ? `${ep}|${model_id}|area|${p.id ?? f?.id ?? `${c[0].toFixed(2)},${c[1].toFixed(2)}`}|${vf ?? ""}` : `${ep}|${model_id}|${p.cell_id ?? `${p.site}|${c[0].toFixed(2)},${c[1].toFixed(2)}`}`,
    ep,
    model_id,
    model_name: p.model_name || "Model",
    target: normTarget(p.target || "custom"),
    prob,
    level: p.level === "low" || p.level === "med" || p.level === "high" ? p.level : levelOf(prob),
    site: p.site ?? "",
    t,
    cell_id: p.cell_id,
    top_features: Array.isArray(p.top_features) ? p.top_features : [],
    motion: p.motion && Number.isFinite(+p.motion.dir) ? { dir: +p.motion.dir, kt: num(p.motion.kt) } : undefined,
    lon: c[0],
    lat: c[1],
    poly: g?.type === "Polygon" ? g.coordinates : g?.type === "MultiPolygon" ? g.coordinates[0] : p.poly ?? (Array.isArray(p.outline) && p.outline.length >= 3 ? [[...p.outline, p.outline[0]]] : undefined),
  };
}
/** /api/ml/detections sends each detection as a Point (kind "point") plus, for cells, a Polygon
 *  (kind "outline", id "<id>-outline"): pair them into one detection (centre + cell box). */
export function detectionsFromFeatures(feats: any[], ep: Ep): Detection[] {
  const outlines = new Map<string, any>();
  for (const f of feats) if (f?.properties?.kind === "outline") outlines.set(String(f.properties.id ?? String(f.id ?? "").replace(/-outline$/, "")), f);
  const out: Detection[] = [];
  for (const f of feats) {
    const p = f?.properties ?? {};
    if (p.kind === "outline") {
      // outline without its point (shouldn't happen): use it alone
      if (feats.some((x) => x !== f && x?.properties?.id === p.id && x?.properties?.kind !== "outline")) continue;
    }
    const d = normDetection(f, ep);
    if (!d) continue;
    const o = p.kind !== "outline" ? outlines.get(String(p.id ?? f.id ?? "")) : undefined;
    if (o?.geometry?.type === "Polygon") d.poly = o.geometry.coordinates;
    out.push(d);
  }
  return out;
}

// ---------- shared state ----------
export const mlOpen = signal(false);
export type MlTab = "models" | "train" | "jobs" | "run";
export const mlTab = signal<MlTab>("models");
export const catalog = signal<Catalog | null>(null);
export const catalogErr = signal("");
export const models = signal<Model[]>([]);
export const modelsErr = signal("");
export const modelsLoading = signal(false);
export const jobs = signal<Job[]>([]);
export const jobsErr = signal("");
export const runState = signal<Partial<Record<Ep, RunState>>>({});
export const detections = signal<Detection[]>([]);
/** model to show in the Models tab ("ep|id") */
export const selModel = signal<string>("");
/** custom training form, prefilled by "duplicate settings" */
export const trainDraft = signal<Partial<TrainSpec> | null>(null);
export const mkey = (m: { ep: Ep; id: string }) => `${m.ep}|${m.id}`;

export async function loadCatalog(force = false) {
  if (catalog.value && !force) return;
  const eps: Ep[] = api.base ? ["main"] : localUrl.value ? ["local"] : [];
  for (const ep of eps) {
    try {
      const c = await mlReq<Catalog>(ep, "GET", "/api/ml/catalog");
      catalog.value = {
        targets: c.targets ?? [],
        candidates: c.candidates ?? [],
        algos: c.algos ?? [],
        label_sources: c.label_sources ?? [],
        presets: c.presets ?? [],
        // server: radar products are fixed; MRMS / model ids come as mrms_fields / model_vars
        radar_products: c.radar_products ?? (c as any).defaults?.sources?.radar_products,
        mrms: c.mrms ?? (c as any).mrms_fields,
        model_fields: c.model_fields ?? (c as any).model_vars,
        defaults: c.defaults,
        server: c.server,
        // models 0.7
        run_params: Array.isArray(c.run_params) ? c.run_params : undefined,
        sources: c.sources && typeof c.sources === "object" ? c.sources : undefined,
      };
      catalog.value.targets = catalog.value.targets.map((t: TargetDef) => ({ ...t, id: normTarget(t.id), task: taskOf(t.id, t.task), output: outputOf(t.id, t.output) }));
      catalogErr.value = "";
      return;
    } catch (e: any) {
      catalogErr.value = e.message;
    }
  }
  if (!eps.length) catalogErr.value = "No server configured";
}

let modelsSeq = 0;
export async function loadModels() {
  const seq = ++modelsSeq;
  modelsLoading.value = true;
  const out: Model[] = [];
  let err = "";
  await probeLocal();
  await Promise.all(
    liveEps().map(async (ep) => {
      try {
        const r = await mlReq<any>(ep, "GET", "/api/ml/models");
        const list = Array.isArray(r) ? r : r?.models ?? [];
        out.push(...list.map((m: any) => normModel(m, ep)));
      } catch (e: any) {
        if (ep === "main") err = e.message;
      }
    }),
  );
  // an older, slower call must not overwrite a newer list (e.g. after an import)
  if (seq !== modelsSeq) return;
  // keep details already fetched (metrics, importance) for unchanged models
  const old = new Map(models.value.map((m) => [mkey(m), m]));
  models.value = out
    .map((m) => {
      const o = old.get(mkey(m));
      return o && o.updated === m.updated && o.importance?.length && !m.importance?.length ? { ...o, ...m, metrics: o.metrics, importance: o.importance, feature_schema: o.feature_schema, spec: o.spec } : m;
    })
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  modelsErr.value = err;
  modelsLoading.value = false;
}

let modelsOnce = 0;
/** load the model list once (rules panel, map layer options, popups); retried after a minute while empty */
export function ensureModels() {
  if (modelsOnce && (models.value.length || Date.now() - modelsOnce < 60_000)) return;
  modelsOnce = Date.now();
  setTimeout(() => {
    loadModels();
    loadCatalog();
  }, 0);
}

/** full model (metrics, importance, spec) */
export async function loadModel(ep: Ep, id: string): Promise<Model | null> {
  try {
    const m = normModel(await mlReq(ep, "GET", `/api/ml/models/${encodeURIComponent(id)}`), ep);
    models.value = models.value.map((x) => (mkey(x) === mkey(m) ? { ...x, ...m } : x));
    if (!models.value.some((x) => mkey(x) === mkey(m))) models.value = [m, ...models.value];
    return m;
  } catch (e: any) {
    toast(`Couldn't load the model: ${e.message}`, "error");
    return null;
  }
}

export async function patchModel(m: Model, patch: Partial<Pick<Model, "name" | "labels" | "notes" | "threshold">>) {
  const prev = models.value;
  models.value = models.value.map((x) => (mkey(x) === mkey(m) ? { ...x, ...patch } : x));
  try {
    const r = await mlReq(m.ep, "PATCH", `/api/ml/models/${encodeURIComponent(m.id)}`, patch);
    if (r && typeof r === "object" && r.id) {
      const n = normModel(r, m.ep);
      models.value = models.value.map((x) => (mkey(x) === mkey(m) ? { ...x, ...n, metrics: n.metrics && Object.keys(n.metrics).length ? n.metrics : x.metrics, importance: n.importance?.length ? n.importance : x.importance } : x));
    }
  } catch (e: any) {
    models.value = prev;
    toast(`Couldn't save: ${e.message}`, "error");
  }
}

export async function deleteModel(m: Model) {
  try {
    await mlReq(m.ep, "DELETE", `/api/ml/models/${encodeURIComponent(m.id)}`);
    models.value = models.value.filter((x) => mkey(x) !== mkey(m));
    if (selModel.value === mkey(m)) selModel.value = "";
    toast(`Deleted “${m.name}”`);
  } catch (e: any) {
    toast(`Couldn't delete: ${e.message}`, "error");
  }
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "model";
export async function exportModel(m: Model) {
  try {
    const { buf, name } = await mlBin(m.ep, `/api/ml/models/${encodeURIComponent(m.id)}/export`);
    const file = name || `${safeName(m.name)}.tbwmodel`;
    const tbw: any = (window as any).tbw;
    if (tbw?.saveFile) {
      const path = await tbw.saveFile(file, new Uint8Array(buf));
      toast(`Saved ${path}`);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
      a.download = file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e: any) {
    toast(`Export failed: ${e.message}`, "error");
  }
}

export async function importModel(file: File | Blob, ep: Ep = "main"): Promise<Model | null> {
  try {
    if (ep === "local" && !(await ensureLocal())) return null;
    const r = await mlReq(ep, "POST", "/api/ml/models/import", await file.arrayBuffer(), true);
    const m = normModel(r?.model ?? r, ep);
    await loadModels();
    selModel.value = mkey(m);
    toast(`Imported “${m.name}”`);
    return m;
  } catch (e: any) {
    toast(`Import failed: ${e.message}`, "error");
    return null;
  }
}

/** export from one machine, import on the other */
export async function copyModel(m: Model, to: Ep): Promise<Model | null> {
  try {
    if (to === "local" && !(await ensureLocal())) return null;
    const { buf } = await mlBin(m.ep, `/api/ml/models/${encodeURIComponent(m.id)}/export`);
    const r = await mlReq(to, "POST", "/api/ml/models/import", buf, true);
    const n = normModel(r?.model ?? r, to);
    await loadModels();
    toast(`Copied “${m.name}” to ${EP_NAME[to] === "Server" ? "the main server" : "this computer"}`);
    return n;
  } catch (e: any) {
    toast(`Copy failed: ${e.message}`, "error");
    return null;
  }
}

// ---------- jobs ----------
let jobsSeq = 0;
export async function loadJobs() {
  const seq = ++jobsSeq;
  await probeLocal();
  const out: Job[] = [];
  let err = "";
  await Promise.all(
    liveEps().map(async (ep) => {
      try {
        const r = await mlReq<any>(ep, "GET", "/api/ml/jobs");
        const list = Array.isArray(r) ? r : r?.jobs ?? [];
        out.push(...list.map((j: any) => normJob(j, ep)));
      } catch (e: any) {
        if (ep === "main") err = e.message;
      }
    }),
  );
  if (seq !== jobsSeq) return;
  // keep logs fetched by loadJob
  const old = new Map(jobs.value.map((j) => [`${j.ep}|${j.id}`, j]));
  jobs.value = out
    .map((j) => {
      const o = old.get(`${j.ep}|${j.id}`);
      return o && (o.log?.length ?? 0) > (j.log?.length ?? 0) && j.state === o.state ? { ...j, log: o.log } : j;
    })
    .sort((a, b) => order(a) - order(b) || (b.started ?? 0) - (a.started ?? 0));
  jobsErr.value = err;
  // a job just finished: refresh models
  for (const j of out) {
    const o = old.get(`${j.ep}|${j.id}`);
    if (o && o.state !== j.state && j.state === "done") {
      toast(`Training finished: ${j.name ?? "model"}`, "info", 7000);
      loadModels();
    }
  }
}
const order = (j: Job) => ({ running: 0, stopping: 0, queued: 1 } as Record<string, number>)[j.state] ?? 2;

export async function loadJob(ep: Ep, id: string) {
  try {
    const j = normJob(await mlReq(ep, "GET", `/api/ml/jobs/${encodeURIComponent(id)}`), ep);
    jobs.value = jobs.value.map((x) => (x.ep === ep && x.id === id ? { ...x, ...j } : x));
  } catch {
    /* gone */
  }
}
export const activeJobs = computed(() => jobs.value.filter((j) => j.state === "running" || j.state === "queued" || j.state === "stopping"));

export async function startTraining(ep: Ep, body: Partial<TrainSpec> | { preset: string; name?: string; time_limit_min?: number | null }): Promise<string | null> {
  try {
    if (ep === "local" && !(await ensureLocal())) return null;
    const r = await mlReq<{ job_id: string }>(ep, "POST", "/api/ml/train", body);
    const id = String(r?.job_id ?? (r as any)?.id ?? "");
    toast(`Training started on ${ep === "local" ? "this computer" : "the server"} · see Jobs`);
    await loadJobs();
    return id;
  } catch (e: any) {
    toast(`Couldn't start training: ${e.message}`, "error");
    return null;
  }
}
export async function jobAction(j: Job, what: "stop" | "delete") {
  try {
    if (what === "stop") await mlReq(j.ep, "POST", `/api/ml/jobs/${encodeURIComponent(j.id)}/stop`, {});
    else await mlReq(j.ep, "DELETE", `/api/ml/jobs/${encodeURIComponent(j.id)}`);
    await loadJobs();
  } catch (e: any) {
    toast(`${what === "stop" ? "Stop" : "Cancel"} failed: ${e.message}`, "error");
  }
}

/** restart an interrupted / failed job (the server answers with a new job id) */
export async function resumeJob(j: Job) {
  try {
    if (j.ep === "local" && !(await ensureLocal())) return;
    await mlReq(j.ep, "POST", `/api/ml/jobs/${encodeURIComponent(j.id)}/resume`, {});
    toast("Training resumed · see Jobs");
    await loadJobs();
  } catch (e: any) {
    toast(`Resume failed: ${e.message}`, "error");
  }
}

// ---------- runner ----------
export async function loadRun() {
  await probeLocal();
  const out: Partial<Record<Ep, RunState>> = {};
  await Promise.all(
    liveEps().map(async (ep) => {
      try {
        const r = await mlReq<any>(ep, "GET", "/api/ml/run");
        // models 0.7: models may be {id, …options}; layers produced by grid / outlook models
        const mo: Record<string, ModelRunOpts> = {};
        const ids = (Array.isArray(r?.models) ? r.models : []).map((x: any) => {
          if (x && typeof x === "object") {
            const { id, ...rest } = x;
            mo[String(id)] = rest;
            return String(id);
          }
          return String(x);
        });
        const layers: PredLayer[] = (Array.isArray(r?.layers) ? r.layers : []).filter((l: any) => l && (l.layer_id || l.id)).map((l: any) => ({ ...l, model_id: String(l.model_id ?? ""), layer_id: String(l.layer_id ?? l.id), kind: l.kind || "grid", valid_times: (Array.isArray(l.valid_times) ? l.valid_times : []).map((t: any) => tms(t)).filter((t: any) => t != null) }));
        out[ep] = { enabled: !!r?.enabled, models: ids, radars: r?.radars ?? "all", sites: Array.isArray(r?.sites) ? r.sites : undefined, interval_s: r?.interval_s, last_cycle: tms(r?.last_cycle), per_radar: r?.per_radar ?? {}, models_state: r?.models_state && typeof r.models_state === "object" ? r.models_state : undefined, layers, concurrency: r?.concurrency, model_opts: mo };
      } catch {
        /* no runner */
      }
    }),
  );
  runState.value = out;
}
export async function setRun(ep: Ep, body: { models: (string | ({ id: string } & ModelRunOpts))[]; radars: any; enabled: boolean; interval_s?: number; concurrency?: number }) {
  try {
    if (ep === "local" && !(await ensureLocal())) return false;
    await mlReq(ep, "POST", "/api/ml/run", body);
    await loadRun();
    if (body.enabled) startDetections(true);
    return true;
  } catch (e: any) {
    toast(`Couldn't update the runner: ${e.message}`, "error");
    return false;
  }
}
/** Score the newest volume of one radar once (POST /api/ml/run/test); detections are not stored on
 *  the server — they're merged into the map layer here. */
export async function testRun(ep: Ep, site: string, ids: (string | ({ id: string } & ModelRunOpts))[], extra: { valid_time?: number; day?: any } = {}): Promise<{ n: number; cells?: number; ms?: number; error?: string } | null> {
  try {
    if (ep === "local" && !(await ensureLocal())) return null;
    const r = await mlReq<any>(ep, "POST", "/api/ml/run/test", { models: ids, site, ...extra });
    if (Array.isArray(r?.layers) && r.layers.length) refreshGridCatalog(); // models 0.7: test produced prediction grids
    const list = detectionsFromFeatures(r?.features ?? [], ep);
    // shown regardless of the volume's age
    const now = Date.now();
    mergeDetections(list.map((d) => ({ ...d, key: `test|${d.key}`, test: true, t: Math.max(d.t, now - 60_000) })));
    const st = r?.stats ?? {};
    return { n: list.length, cells: st.cells, ms: st.ms, error: st.error };
  } catch (e: any) {
    toast(`Test failed: ${e.message}`, "error");
    return null;
  }
}

/** model key → number of radars it runs on */
export const runningOn = computed(() => {
  const out = new Map<string, number>();
  for (const [ep, st] of Object.entries(runState.value) as [Ep, RunState][]) {
    if (!st?.enabled) continue;
    const n = st.sites?.length ?? (Object.keys(st.per_radar ?? {}).length || (Array.isArray(st.radars) ? st.radars.length : 0));
    for (const id of st.models) out.set(`${ep}|${id}`, n);
  }
  return out;
});

// ---------- detections ----------
let detTimer: number | undefined;
let detUsers = 0;
const lastPoll: Partial<Record<Ep, number>> = {};
let lastFetch = 0;
export const detMaxAgeMin = signal(60);
export const detStatus = signal<{ error?: string; t?: number }>({});

function mergeDetections(list: Detection[]) {
  if (!list.length) return pruneDetections();
  const m = new Map(detections.value.map((d) => [d.key, d]));
  for (const d of list) {
    const o = m.get(d.key);
    if (!o || o.t <= d.t) m.set(d.key, d);
  }
  const cut = Date.now() - detMaxAgeMin.value * 60_000;
  detections.value = [...m.values()].filter((d) => detEnd(d) >= cut).sort((a, b) => b.t - a.t).slice(0, 3000);
}
/** models 0.7: an area stays as long as it's valid */
export const detEnd = (d: Detection) => Math.max(d.t, d.valid_to ?? 0);
function pruneDetections() {
  const cut = Date.now() - detMaxAgeMin.value * 60_000;
  if (detections.value.some((d) => detEnd(d) < cut)) detections.value = detections.value.filter((d) => detEnd(d) >= cut);
}

export async function pollDetections() {
  const eps = liveEps();
  let err = "";
  lastFetch = Date.now();
  const got: Detection[] = [];
  await Promise.all(
    eps.map(async (ep) => {
      if (ep === "local" && !runState.value.local?.enabled) return;
      const since = Math.max(Date.now() - detMaxAgeMin.value * 60_000, (lastPoll[ep] ?? 0) - 10 * 60_000);
      try {
        const r = await mlReq<any>(ep, "GET", `/api/ml/detections?since=${Math.round(since)}`);
        got.push(...detectionsFromFeatures(Array.isArray(r) ? r : r?.features ?? [], ep));
        lastPoll[ep] = Date.now();
      } catch (e: any) {
        if (ep === "main") err = e.message;
      }
    }),
  );
  mergeDetections(got);
  detStatus.value = { error: err || undefined, t: Date.now() };
}
/** fetch if older than `maxAgeS` (used by the notification rules) */
export async function freshDetections(maxAgeS = 25): Promise<Detection[]> {
  if (Date.now() - lastFetch > maxAgeS * 1000) await pollDetections();
  return detections.value;
}
/** start polling (ref-counted). Returns stop(). */
export function startDetections(kick = false): () => void {
  detUsers++;
  if (!detTimer) {
    detTimer = window.setInterval(() => document.visibilityState !== "hidden" && pollDetections(), 30_000);
    kick = true;
  }
  if (kick) pollDetections();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--detUsers <= 0) {
      detUsers = 0;
      clearInterval(detTimer);
      detTimer = undefined;
    }
  };
}
// WebSocket pushes (main server): a detection (flat, with lat/lon/outline), a job update, a model change
api.on("ml_detection", (m) => {
  const f = m.feature ?? m.detection ?? m;
  const list = Array.isArray(m.features) ? m.features : [f];
  mergeDetections(detectionsFromFeatures(list, "main"));
});
let wsModels: number | undefined;
api.on("ml_model", () => {
  if (!models.value.length && !mlOpen.value) return;
  clearTimeout(wsModels);
  wsModels = window.setTimeout(() => loadModels(), 500);
});
api.on("ml_job", (m) => {
  const id = String(m.id ?? "");
  const old = jobs.value.find((j) => j.ep === "main" && j.id === id);
  if (!old) return void (mlOpen.value && loadJobs());
  // a state change goes through loadJobs (it toasts "Training finished" and refreshes models)
  if (m.state && m.state !== old.state) return void loadJobs();
  jobs.value = jobs.value.map((j) => (j === old ? { ...j, phase: m.phase ?? j.phase, progress: m.progress != null ? num(m.progress) : j.progress } : j));
});

// settings group (store.ts declares `ml?`)
export function mlPrefs() {
  return { trainWhere: "main" as Ep, runWhere: "main" as Ep, ...(settings.value.ml ?? {}) };
}

/* ---------- models 0.7: retrain / train further ---------- */
export type RetrainMode = "replace" | "new";
async function modelJob(m: Model, what: "retrain" | "continue", body: any): Promise<string | null> {
  try {
    if (m.ep === "local" && !(await ensureLocal())) return null;
    const r = await mlReq<{ job_id: string }>(m.ep, "POST", `/api/ml/models/${encodeURIComponent(m.id)}/${what}`, body);
    const id = String(r?.job_id ?? (r as any)?.id ?? "");
    toast(`${what === "retrain" ? "Retraining" : "Training further"}: “${m.name}” · see Jobs`);
    await loadJobs();
    return id;
  } catch (e: any) {
    const msg = String(e.message ?? e);
    toast(what === "continue" && /feature|schema|retrain/i.test(msg) ? `Can't train further: ${msg} — use Retrain instead` : `Couldn't start: ${msg}`, "error", 9000);
    return null;
  }
}
/** retrain from scratch with (optionally edited) spec; mode "new" keeps the old model */
export const retrainModel = (m: Model, spec: Partial<TrainSpec>, mode: RetrainMode) => modelJob(m, "retrain", { ...spec, mode });
export interface ContinueOpts {
  extra_events?: number;
  years?: [number, number];
  region?: { states?: string[]; bbox?: [number, number, number, number] };
  n_trees?: number;
  iterations?: number;
  epochs?: number;
  learning_rate?: number;
  mode: RetrainMode;
  name?: string;
  [k: string]: any;
}
export const continueModel = (m: Model, o: ContinueOpts) => modelJob(m, "continue", o);

/* ---------- models 0.7: prediction layers (mlpred/*) in the grid catalog ---------- */
export async function refreshGridCatalog() {
  if (!api.base) return;
  try {
    const c = await api.get("/api/grid/catalog");
    if (Array.isArray(c?.layers)) gridLayers.value = c.layers;
  } catch {
    /* older server */
  }
}
export const predLayers = computed(() => gridLayers.value.filter((d) => (d.source as string) === "mlpred" || d.id.startsWith("mlpred/")));
/** model id of a prediction layer id "mlpred/<model_id>[/<field>]" */
export const predModelId = (layerId: string) => layerId.split("/")[1] ?? "";
export function predModelName(layerId: string): string {
  const id = predModelId(layerId);
  return models.value.find((m) => m.id === id)?.name ?? gridLayers.value.find((d) => d.id === layerId)?.group?.replace(/^My models · /, "") ?? id;
}
/** make sure the grid catalog knows a layer the runner reports (so the legend has units/cmap) */
export function ensurePredDef(l: PredLayer, m?: Model) {
  if (gridLayers.value.some((d) => d.id === l.layer_id)) return;
  const t = normTarget(m?.target ?? "");
  const [units, cmap] = t === "temp_forecast" ? ["°C", "TEMP"] : t === "precip_forecast" ? ["mm", "PRECIPMM"] : ["%", "PROB"];
  const def: GridLayerDef = { id: l.layer_id, group: "My models", name: l.name ?? m?.name ?? l.layer_id, units, cmap, source: "mlpred" as any, model: l.model_id, step_min: 60 };
  gridLayers.value = [...gridLayers.value, def];
}
