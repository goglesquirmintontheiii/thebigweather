// models 0.8: running is per model (the Run tab is gone). A model's page holds its run settings
// (radars + every run_param the server offers), Enable / Stop, Run now on all radars, Test on the
// radar on screen, Run on the history range, its detections and the layers it produced.

import { useEffect, useMemo, useState } from "preact/hooks";
import { Power, Zap, FlaskConical, History as HistoryIcon, MousePointerClick, Crosshair, Layers, Map as MapIcon, AlertTriangle, Settings2, RefreshCw, Highlighter } from "lucide-preact";
import { runState, loadRun, testRun, mkey, ensurePredDef, refreshGridCatalog, mlOpen, detections } from "../../ml/client";
import { runOf, loadModelRun, setModelRun, runNow, runHistory, jobsFor, modelDetections, type RunJob } from "../../ml/m8";
import { RunOptionsPanel, runItem, runOptsOf, setRunOpts, paramsFor } from "./RunOptions";
import { showOutlook } from "../../ml/outlook";
import { selectWeather } from "../../weather";
import { outputOf, tmeta, LEVEL_COLOR } from "../../ml/targets";
import { histRange } from "../../anim";
import { pickRadars, usSites, pickMode } from "../../ml/pick";
import { settings, update } from "../../store";
import { sites } from "../../radar/controller";
import { fmtAge, fmtTime } from "../../util";
import { enableDetectionLayer, showDetection } from "../../overlays/mldefs";
import { isOn } from "../../overlays/manager";
import type { Detection, Model, PredLayer } from "../../ml/types";
import { summarize, confText, CONF_HELP } from "../../ml/summary"; // 0.8.1
import { Field, Help, TIcon } from "./common";

type RMode = "all" | "states" | "pick" | "current";
const rkey = (m: Model) => mkey(m);
function radarsSaved(m: Model): any {
  return settings.value.ml?.runRadars?.[rkey(m)] ?? "all";
}
function setRadarsSaved(m: Model, r: any) {
  update((s) => (s.ml = { ...(s.ml ?? {}), runRadars: { ...(s.ml?.runRadars ?? {}), [rkey(m)]: r } }));
}
function modeOf(r: any): RMode {
  if (Array.isArray(r)) return r.length && r.every((x) => x === settings.peek().radar.site || settings.peek().extraSites.includes(x)) && r.length === 1 + settings.peek().extraSites.length ? "current" : "pick";
  if (r && typeof r === "object" && Array.isArray(r.states)) return "states";
  return "all";
}
const onScreen = () => [settings.peek().radar.site, ...settings.peek().extraSites].filter(Boolean);
/** grid / outlook models and grid-point candidates don't use radars */
export const usesRadars = (m: Model) => outputOf(m.target, m.output) === "detections" && m.candidate !== "grid_point";

export function ModelRun({ m }: { m: Model }) {
  const r = runOf(m);
  const st = runState.value[m.ep];
  const out = outputOf(m.target, m.output);
  const radars = radarsSaved(m);
  const [mode, setMode] = useState<RMode>(modeOf(radars));
  const [showOpts, setShowOpts] = useState(false);
  const [busy, setBusy] = useState("");
  const [test, setTest] = useState<{ text?: string; errs?: string[] }>({});
  const [histStep, setHistStep] = useState<number>(out === "detections" ? 10 : 60 * Math.max(1, +(runOptsOf(m).frame_step_h ?? 1)));
  const [histRadars, setHistRadars] = useState<"screen" | "model" | "all">("screen");
  useEffect(() => {
    loadModelRun(m);
    const t = window.setInterval(() => document.visibilityState !== "hidden" && loadModelRun(m), 15_000);
    return () => clearInterval(t);
  }, [m.id, m.ep]);
  const allStates = useMemo(() => [...new Set(usSites().map((s) => s.state).filter(Boolean))].sort(), [sites.value]);
  const states: string[] = radars && typeof radars === "object" && !Array.isArray(radars) ? radars.states ?? [] : [];
  const picked: string[] = Array.isArray(radars) ? radars.map(String) : [];
  const nRadars = (() => {
    const us = usSites();
    if (mode === "all") return us.length || 200;
    if (mode === "states") return us.filter((s) => states.includes(s.state)).length;
    if (mode === "current") return onScreen().length;
    return picked.length;
  })();
  const radarsBody = (): any => (!usesRadars(m) ? "all" : mode === "all" ? "all" : mode === "states" ? { states } : mode === "current" ? onScreen() : picked);
  const opts = runOptsOf(m);
  const enabled = !!r?.enabled;
  const apply = async (en: boolean) => {
    setBusy(en ? "enable" : "stop");
    const ok = await setModelRun(m, { enabled: en, options: opts, radars: radarsBody() });
    setBusy("");
    if (ok && en) enableDetectionLayer();
  };
  const site = settings.value.radar.site;
  const runTest = async () => {
    setBusy("test");
    setTest({ text: usesRadars(m) ? `Scoring the newest ${site} volume…` : "Running once…" });
    const res = await testRun(m.ep, site, [runItem(m)]);
    setBusy("");
    loadRun();
    if (res) enableDetectionLayer();
    const errs = Object.values(res?.errors ?? {}).map(String);
    const extra = res ? [res.layers ? `${res.layers} forecast layer${res.layers > 1 ? "s" : ""}` : "", res.outlooks ? `${res.outlooks} outlook${res.outlooks > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ") : "";
    setTest({ text: !res ? "" : `${usesRadars(m) ? (res.error ? `${site}: ${res.error}` : `${site}: ${res.cells ?? "?"} cells, ${res.n} detection${res.n === 1 ? "" : "s"}`) : `${res.n} detection${res.n === 1 ? "" : "s"}`}${extra ? ` · ${extra}` : ""}`, errs });
  };
  const hr = histRange.value;
  const histOk = m.history_compatible !== false;
  const goHistory = async () => {
    if (!hr) return;
    setBusy("hist");
    const rad = !usesRadars(m) ? "all" : histRadars === "all" ? "all" : histRadars === "model" ? radarsBody() : onScreen();
    const j = await runHistory([m], rad, hr.start, hr.end, histStep, { [mkey(m)]: opts });
    setBusy("");
    if (j) {
      enableDetectionLayer();
      if (out !== "detections") refreshGridCatalog();
    }
  };
  const goNow = async () => {
    setBusy("now");
    await runNow([m], { [mkey(m)]: opts }, usesRadars(m) ? "all" : "all");
    setBusy("");
    enableDetectionLayer();
  };
  const layers = (st?.layers ?? []).filter((l) => l.model_id === m.id || (l.model_id.startsWith(`ensemble:${m.target}:`) && opts.ensemble != null));
  const ms = st?.models_state?.[m.id];
  const nOpt = Object.keys(opts).filter((k) => paramsFor(m).some((p) => p.id === k) || k === "valid_from" || k === "valid_to").length;
  const rj = jobsFor(m);
  return (
    <div class="m8-run">
      <div class="m8-run-head">
        <span class={`ml-run-state ${enabled ? "on" : ""}`}>
          <i />
          {enabled ? (
            <span>
              Running{usesRadars(m) ? ` on ${r?.radars === "all" || !r?.radars ? "all US radars" : Array.isArray(r?.radars) ? `${r!.radars.length} radar${r!.radars.length === 1 ? "" : "s"}` : r?.radars?.states ? `${r.radars.states.length} state${r.radars.states.length > 1 ? "s" : ""}` : "radars"}` : ""}
              {r?.last_run || ms?.last_run ? ` · last run ${fmtAge((r?.last_run ?? ms?.last_run)!)}` : ""}
              {r?.state && r.state !== "ok" && r.state !== "running" ? ` · ${r.state}` : ""}
            </span>
          ) : (
            <span>Stopped — its detections are hidden</span>
          )}
        </span>
        {r?.legacy && <small class="muted" title="This server has no per-model runner yet: the model is added to / removed from the server's runner">shared runner</small>}
        <span class="m8-run-btns">
          <button class="btn sm ghost" disabled={!!busy || (usesRadars(m) && !site)} title={usesRadars(m) ? `Score the newest ${site} volume once and show the result` : "Run once and show the result"} onClick={runTest}>
            <FlaskConical size={13} /> {busy === "test" ? "Testing…" : usesRadars(m) ? `Test on ${site || "radar"}` : "Test"}
          </button>
          <button class="btn sm ghost" disabled={!!busy} title={usesRadars(m) ? "Run once right now on every US radar (current conditions)" : "Run once now (current conditions)"} onClick={goNow}>
            <Zap size={13} /> {busy === "now" ? "Starting…" : usesRadars(m) ? "Run now · all radars" : "Run now"}
          </button>
          {enabled ? (
            <>
              <button class="btn sm ghost" disabled={!!busy} title="Save the settings below to the running model" onClick={() => apply(true)}>
                <RefreshCw size={13} /> Apply
              </button>
              <button class="btn sm danger" disabled={!!busy} title="Stop the model (removes its detections from the map)" onClick={() => apply(false)}>
                <Power size={13} /> {busy === "stop" ? "Stopping…" : "Stop"}
              </button>
            </>
          ) : (
            <button class="btn sm" disabled={!!busy || (usesRadars(m) && !nRadars)} title="Run continuously with these settings" onClick={() => apply(true)}>
              <Power size={13} /> {busy === "enable" ? "Starting…" : "Enable"}
            </button>
          )}
        </span>
      </div>
      {(r?.error || ms?.error) && (
        <small class="ml-prod-err">
          <AlertTriangle size={11} /> {r?.error ?? ms?.error}
        </small>
      )}

      {usesRadars(m) && (
        <div class="m8-radars">
          <span class="ml-flabel">
            Radars <small class="muted">· {nRadars} (NEXRAD + TDWR)</small>
          </span>
          <div class="seg ml-rmode">
            {(
              [
                ["all", "All US radars"],
                ["states", "By state"],
                ["pick", "Pick on map"],
                ["current", "Radars on screen"],
              ] as [RMode, string][]
            ).map(([k, l]) => (
              <button
                key={k}
                class={mode === k ? "on" : ""}
                onClick={() => {
                  setMode(k);
                  if (k === "all") setRadarsSaved(m, "all");
                  if (k === "current") setRadarsSaved(m, onScreen());
                  if (k === "states") setRadarsSaved(m, { states });
                  if (k === "pick") setRadarsSaved(m, picked);
                }}
              >
                {l}
              </button>
            ))}
          </div>
          {mode === "states" && (
            <div class="ml-states">
              {allStates.map((s) => (
                <button key={s} class={states.includes(s) ? "on" : ""} onClick={() => setRadarsSaved(m, { states: states.includes(s) ? states.filter((x) => x !== s) : [...states, s] })}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {mode === "pick" && (
            <div class="ml-picked">
              <button class="btn sm ghost" disabled={!!pickMode.value} onClick={async () => setRadarsSaved(m, (await pickRadars(picked)) ?? picked)}>
                <MousePointerClick size={13} /> Pick radars on the map
              </button>
              {picked.map((id) => (
                <span key={id} class="chip on" onClick={() => setRadarsSaved(m, picked.filter((x) => x !== id))} title="Remove">
                  {id} ×
                </span>
              ))}
            </div>
          )}
          {mode === "current" && <small class="muted">{onScreen().join(", ")}</small>}
        </div>
      )}

      <div class="m8-opts">
        <button class={`btn xs ghost ${showOpts ? "on" : ""}`} onClick={() => setShowOpts(!showOpts)}>
          <Settings2 size={12} /> Run settings{nOpt ? ` · ${nOpt} set` : " · defaults"}
        </button>
        {showOpts && <RunOptionsPanel m={m} />}
      </div>

      {hr && (
        <div class={`m8-hist ${histOk ? "" : "off"}`}>
          <HistoryIcon size={14} />
          <span>
            <b>History range</b> {fmtTime(hr.start, true)} → {fmtTime(hr.end, true)}
          </span>
          {usesRadars(m) && (
            <select value={histRadars} onChange={(e) => setHistRadars((e.target as HTMLSelectElement).value as any)} title="Radars to run on">
              <option value="screen">Radars on screen ({onScreen().length})</option>
              <option value="model">This model's radars</option>
              <option value="all">All US radars</option>
            </select>
          )}
          <select value={String(histStep)} onChange={(e) => setHistStep(+(e.target as HTMLSelectElement).value)} title="Time step between runs">
            {(out === "detections" ? [5, 10, 15, 30, 60] : [60, 120, 180, 360]).map((v) => (
              <option key={v} value={v}>
                every {v < 60 ? `${v} min` : `${v / 60} h`}
              </option>
            ))}
          </select>
          <button class="btn sm" disabled={!histOk || !!busy} title={histOk ? "Run the model over the history range; its detections / frames follow the timeline" : m.history_reason ?? "This model can't run on past data"} onClick={goHistory}>
            <HistoryIcon size={13} /> {busy === "hist" ? "Starting…" : "Run on this range"}
          </button>
          {!histOk && <small class="muted">{m.history_reason ?? "not history compatible"}</small>}
        </div>
      )}
      {rj.slice(0, 3).map((j) => (
        <RunJobBar key={`${j.ep}|${j.id}`} j={j} />
      ))}
      {test.text && <div class="muted small ml-test-res">{test.text}</div>}
      {test.errs?.map((e) => (
        <small key={e} class="ml-prod-err">
          <AlertTriangle size={11} /> {e}
        </small>
      ))}

      <Produced m={m} layers={layers} err={ms?.error} />
      {out !== "outlook" && <ModelDets m={m} areas={out === "grid"} />}
    </div>
  );
}

function RunJobBar({ j }: { j: RunJob }) {
  const live = !["done", "failed", "cancelled", "interrupted"].includes(j.state);
  const p = Math.max(0, Math.min(1, j.state === "done" ? 1 : j.progress));
  return (
    <div class={`m8-rj ${j.state}`}>
      <small>
        {j.kind === "history" ? "History run" : "Run now"} · {j.state}
        {j.detections != null ? ` · ${j.detections} detections` : ""}
        {j.error ? ` · ${j.error}` : ""}
      </small>
      <div class={`ml-bar ${live ? "live" : ""}`}>
        <i style={{ width: `${p * 100}%` }} />
      </div>
      <small class="ml-prog-pct">{Math.round(p * 100)}%</small>
    </div>
  );
}

/** the model's detections (GET /api/ml/models/{id}/detections), newest first */
function ModelDets({ m, areas }: { m: Model; areas?: boolean }) {
  const [list, setList] = useState<Detection[] | null>(null);
  const live = detections.value.filter((d) => d.ep === m.ep && d.model_id === m.id).length;
  useEffect(() => {
    let dead = false;
    const go = () => modelDetections(m).then((l) => !dead && setList(l));
    go();
    const t = window.setInterval(() => document.visibilityState !== "hidden" && go(), 30_000);
    return () => ((dead = true), clearInterval(t));
  }, [m.id, m.ep, live]);
  const ds = (list ?? []).slice(0, 60);
  return (
    <div class="m8-dets">
      <span class="ml-flabel">
        {areas ? "Highlighted areas" : "Detections"} <small class="muted">{list ? `${list.length} · newest first` : "loading…"}</small>
      </span>
      <div class="ml-det-list">
        {ds.map((d) => (
          <button key={d.key} class="ml-dl" onClick={() => showDetection(d)} title={`Fly there\n${CONF_HELP}`}>
            <TIcon t={d.target} size={18} />
            <span class="ml-dl-p" style={{ "--lc": LEVEL_COLOR[d.level] }} title={d.target === "storm_track" ? "Confidence" : "Probability"}>
              {d.target === "storm_track" && d.confidence != null ? `${Math.round(d.confidence * 100)}%` : `${Math.round(d.prob * 100)}%`}
            </span>
            <span class="ml-dl-main">
              <span>
                <b>{tmeta(d.target).code}</b> {d.kind === "area" ? "area" : d.site || "—"}
                {d.track?.length ? ` · track ${d.track[d.track.length - 1].lead_min} min` : ""}
                {` · conf. ${confText(d.confidence)}`}
              </span>
              {/* 0.8.1: the summary sentence */}
              <span style={{ fontSize: "11.5px", whiteSpace: "normal" }}>{summarize(d)}</span>
              <small>
                {fmtTime(d.t)} ({fmtAge(d.t)}){d.valid_from ? ` · valid ${fmtTime(d.valid_from)}${d.valid_to ? `–${fmtTime(d.valid_to)}` : ""}` : ""}
              </small>
            </span>
            <Crosshair size={13} class="muted" />
          </button>
        ))}
        {list && !ds.length && <div class="ml-empty small">No detections yet{areas ? " (areas appear when it runs as a highlight layer)" : ""}.</div>}
      </div>
    </div>
  );
}

/** grid models that can draw risk areas instead of (or as well as) a weather layer (#4) */
const AREA_TARGETS = new Set(["instability", "flood_forecast", "storm_forecast", "tropical_forecast", "flash_flood"]);

/* ---------- layers a grid / outlook model produced ---------- */
export function Produced({ m, layers, err }: { m: Model; layers: PredLayer[]; err?: string }) {
  const out = outputOf(m.target, m.output);
  const opts = runOptsOf(m);
  if (out === "detections" && !layers.length && !err) return null;
  const open = async (l: PredLayer) => {
    await refreshGridCatalog();
    ensurePredDef(l, m);
    selectWeather({ kind: "grid", id: l.layer_id });
    mlOpen.value = false;
  };
  const span = (l: PredLayer) => (l.valid_times.length ? `${l.valid_times.length} frame${l.valid_times.length > 1 ? "s" : ""} · ${fmtTime(Math.min(...l.valid_times), true)} → ${fmtTime(Math.max(...l.valid_times), true)}` : "no frames yet");
  const canAreas = out === "grid" && m.task !== "regression" && AREA_TARGETS.has(m.target);
  const disp: string = opts.display ?? "layer";
  const setDisp = (v: string) => {
    setRunOpts(m, (x) => ({ ...x, display: v === "layer" ? undefined : v }));
    if (v !== "layer") {
      update((s) => (s.ovl.mldetect = { ...(s.ovl.mldetect ?? { on: true }), on: true, opts: { ...(s.ovl.mldetect?.opts ?? {}), areas: "1" } }));
    }
  };
  return (
    <div class="ml-prod m8-prod">
      <span class="ml-flabel">Produced</span>
      {canAreas && (
        <span class="m8-disp">
          <small class="muted">Show as</small>
          <span class="seg">
            <button class={disp === "layer" ? "on" : ""} title="A forecast grid, chosen as the weather layer" onClick={() => setDisp("layer")}>
              <Layers size={12} /> Weather layer
            </button>
            <button class={disp === "areas" ? "on" : ""} title="Risk areas (polygons) on the Model detections layer, over any weather layer" onClick={() => setDisp("areas")}>
              <Highlighter size={12} /> Highlight areas
            </button>
            <button class={disp === "both" ? "on" : ""} onClick={() => setDisp("both")}>
              Both
            </button>
          </span>
          <Help text="Highlight areas need the model running (Enable / Run now); they show on the 'Model detections' layer and follow the timeline. Apply to send the choice to a running model." />
          {disp !== "layer" && !isOn("mldetect") && (
            <button class="btn xs" onClick={() => enableDetectionLayer()}>
              Turn on the layer
            </button>
          )}
        </span>
      )}
      {layers.map((l) => {
        const q = l.layer_id.match(/\/p(\d+)$/)?.[1];
        const what = l.kind === "outlook" ? "Probability grid" : l.model_id.startsWith("ensemble:") ? l.name ?? "Ensemble" : q ? `P${+q}` : "";
        return (
          <button key={l.layer_id} class="btn xs" title={`Show ${l.layer_id} as the main weather layer (${span(l)}); frames follow the timeline`} onClick={() => open(l)}>
            <Layers size={12} /> {l.kind === "outlook" ? "Open probability grid" : "Open as weather layer"}
            {what && l.kind !== "outlook" ? ` · ${what}` : ""}
            <small>{span(l)}</small>
          </button>
        );
      })}
      {out === "outlook" && (
        <button class="btn xs" title="Add the model's outlook to the map" onClick={() => (showOutlook(m, String(opts.day ?? "1")), (mlOpen.value = false))}>
          <MapIcon size={12} /> Show outlook
        </button>
      )}
      {out !== "detections" && !layers.length && out !== "outlook" && <small class="muted">The forecast layer appears here after the first run.</small>}
      {err && <small class="ml-prod-err">{err}</small>}
    </div>
  );
}
