// Detection models → Run: pick models + radars, enable the runner (server or this computer),
// per-radar status, and the newest detections (click to fly there).

import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Power, MousePointerClick, RefreshCw, Crosshair, AlertTriangle, FlaskConical, Settings2, Map as MapIcon, Layers } from "lucide-preact";
import { models, loadModels, runState, loadRun, setRun, testRun, detections, startDetections, detStatus, mkey, mlTab, mlPrefs, canLocal, localIsMain, ensurePredDef, refreshGridCatalog, mlOpen } from "../../ml/client";
import { RunOptionsPanel, runItem, runOptsOf } from "./RunOptions"; // models 0.7
import { probGate, PG_DET } from "../../ml/probgate"; // models 0.7
import { showOutlook } from "../../ml/outlook"; // models 0.7
import { selectWeather } from "../../weather"; // models 0.7
import { outputOf } from "../../ml/targets"; // models 0.7
import type { Model, PredLayer } from "../../ml/types"; // models 0.7
import { tmeta, LEVEL_COLOR } from "../../ml/targets";
import { pickRadars, usSites, pickMode } from "../../ml/pick";
import { settings, update } from "../../store";
import { sites } from "../../radar/controller";
import { mapRef } from "../../map/mapview";
import { distance, fmtDist, fmtAge, fmtTime } from "../../util";
import { enableDetectionLayer, showDetection } from "../../overlays/mldefs";
import type { Ep, RunState } from "../../ml/types";
import { TIcon, WhereToggle, Field, Help, EpBadge } from "./common";

type RMode = "all" | "nexrad" | "tdwr" | "states" | "pick" | "current";
/** models preselected by "Run" in the Models tab */
const preset = signal<string[] | null>(null);
export function runPreset(keys: string[]) {
  preset.value = keys;
  mlTab.value = "run";
}

function radarsOf(st?: RunState): { mode: RMode; states: string[]; picked: string[] } {
  const r = st?.radars;
  if (r === "nexrad" || r === "tdwr" || r === "all") return { mode: r, states: [], picked: [] };
  if (Array.isArray(r)) return { mode: "pick", states: [], picked: r.map(String) };
  if (r && Array.isArray(r.states)) return { mode: "states", states: r.states, picked: [] };
  return { mode: "all", states: [], picked: [] };
}
// the runner checks each radar for a new volume every interval_s (server: 15–3600 s, default 60)
const INTERVALS: [number, string][] = [[60, "Every new volume"], [120, "2 min"], [300, "5 min"], [600, "10 min"]];

export function RunTab() {
  const [where, setWhere0] = useState<Ep>(mlPrefs().runWhere === "local" && canLocal() ? "local" : "main");
  const setWhere = (e: Ep) => (setWhere0(e), update((s) => (s.ml = { ...(s.ml ?? {}), runWhere: e })));
  const st = runState.value[where];
  const [sel, setSel] = useState<string[]>([]);
  const [mode, setMode] = useState<RMode>("all");
  const [states, setStates] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [interval, setIntv] = useState(60);
  const [test, setTest] = useState<{ busy?: boolean; text?: string }>({});
  const [busy, setBusy] = useState(false);
  const [optFor, setOptFor] = useState<string>(""); // models 0.7: model whose options are open
  const [conc, setConc] = useState<number>(mlPrefs().concurrency ?? 4);
  useEffect(() => {
    loadModels();
    loadRun();
    const stop = startDetections(true);
    const t = window.setInterval(() => document.visibilityState !== "hidden" && loadRun(), 10_000);
    return () => (stop(), clearInterval(t));
  }, []);
  // adopt the runner's current setup when switching machine / on first load
  useEffect(() => {
    const r = radarsOf(st);
    setMode(r.mode);
    setStates(r.states);
    setPicked(r.picked);
    setIntv(st?.interval_s ?? 60);
    if (st?.concurrency) setConc(st.concurrency);
    // models 0.7: adopt the runner's per-model options when this app has none saved (new session / other machine)
    const mo = st?.model_opts ?? {};
    const saved = settings.peek().ml?.runOpts ?? {};
    const adopt = Object.entries(mo).filter(([id, o]) => o && Object.keys(o).length && !saved[`${where}|${id}`]);
    if (adopt.length) update((s) => (s.ml = { ...(s.ml ?? {}), runOpts: { ...(s.ml?.runOpts ?? {}), ...Object.fromEntries(adopt.map(([id, o]) => [`${where}|${id}`, o])) } }));
    if (preset.value) {
      setSel(preset.value.filter((k) => k.startsWith(`${where}|`)).map((k) => k.split("|")[1]));
      preset.value = null;
    } else setSel(st?.models ?? []);
  }, [where, !!st]);
  const mine = models.value.filter((m) => m.ep === where);
  const allStates = useMemo(() => [...new Set(usSites().map((s) => s.state).filter(Boolean))].sort(), [sites.value]);
  const radars = (): any => {
    if (mode === "states") return { states };
    if (mode === "pick") return picked;
    if (mode === "current") return [settings.value.radar.site, ...settings.value.extraSites];
    return mode;
  };
  const nRadars = (() => {
    const us = usSites();
    if (mode === "all") return us.length || 200;
    if (mode === "nexrad") return us.filter((s) => s.type === "NEXRAD").length || 160;
    if (mode === "tdwr") return us.filter((s) => s.type === "TDWR").length || 45;
    if (mode === "states") return us.filter((s) => states.includes(s.state)).length;
    if (mode === "pick") return picked.length;
    return 1 + settings.value.extraSites.length;
  })();
  const apply = async (enabled: boolean) => {
    setBusy(true);
    update((s) => (s.ml = { ...(s.ml ?? {}), concurrency: conc }));
    const items = sel.map((id) => {
      const m = mine.find((x) => x.id === id);
      return m ? runItem(m) : id;
    });
    const ok = await setRun(where, { models: items, radars: radars(), enabled, interval_s: interval, concurrency: conc });
    setBusy(false);
    if (ok && enabled) enableDetectionLayer();
  };
  const cellModels = sel.filter((id) => mine.find((m) => m.id === id)?.candidate !== "grid_point");
  const site = settings.value.radar.site;
  // models 0.7: test runs every selected model once (cell models on the current radar; grid / outlook
  // models over their region and valid period) with the per-model options
  const testItems = sel.map((id) => {
    const m = mine.find((x) => x.id === id);
    return m ? runItem(m) : id;
  });
  const runTest = async () => {
    setTest({ busy: true, text: cellModels.length ? `Scoring the newest ${site} volume…` : "Running the selected models once…" });
    const r = await testRun(where, site, testItems);
    loadRun();
    if (r) enableDetectionLayer();
    setTest({ text: !r ? "" : r.error ? `${site}: ${r.error}` : `${site}: ${r.cells ?? "?"} cells, ${r.n} detection${r.n === 1 ? "" : "s"}${r.ms != null ? ` · ${r.ms} ms` : ""}${r.n ? " · shown on the map" : ""}` });
  };
  const per = Object.entries(st?.per_radar ?? {}).sort((a, b) => +!!b[1].error - +!!a[1].error || (b[1].detections ?? 0) - (a[1].detections ?? 0) || a[0].localeCompare(b[0]));
  const c = mapRef.value?.getCenter();
  // models 0.7: optionally follow the map's probability gate
  const lg = !!settings.value.ml?.listGate;
  const pg = probGate(PG_DET);
  const allDets = detections.value;
  const gatedDets = lg && pg.on ? allDets.filter((d) => d.prob >= pg.lo - 1e-9 && d.prob <= pg.hi + 1e-9) : allDets;
  const dets = gatedDets.slice(0, 200);
  return (
    <div class="ml-run">
      <div class="ml-run-cfg">
        <div class="ml-run-row">
          <Field label="Run on" help="Server: keeps running when the app is closed. This computer: the server built into the app (needs the app open).">
            <WhereToggle value={where} onChange={setWhere} verb="Run" />
          </Field>
          <div class={`ml-run-state ${st?.enabled ? "on" : ""}`}>
            <i />
            {st?.enabled ? (
              <span>
                Running {st.models.length} model{st.models.length === 1 ? "" : "s"} on {Object.keys(st.per_radar ?? {}).length || "…"} radars{st.last_cycle ? ` · last cycle ${fmtAge(st.last_cycle)}` : ""}
              </span>
            ) : (
              <span>Not running on {where === "local" || localIsMain.value ? "this computer" : "the server"}</span>
            )}
          </div>
        </div>

        <span class="ml-flabel">Models {where === "local" && !localIsMain.value && <small class="muted">(trained on or copied to this computer)</small>}</span>
        <div class="ml-run-models">
          {mine.map((m) => {
            const on = sel.includes(m.id);
            const nOpt = Object.keys(runOptsOf(m)).length;
            const out = outputOf(m.target, m.output);
            return (
              <div key={mkey(m)} class={`ml-rm-wrap ${optFor === mkey(m) ? "open" : ""}`}>
                <div class={`ml-rm ${on ? "on" : ""}`} role="button" onClick={() => setSel(on ? sel.filter((x) => x !== m.id) : [...sel, m.id])}>
                  <input type="checkbox" checked={on} tabIndex={-1} />
                  <TIcon t={m.target} size={20} />
                  <span>
                    <b>{m.name}</b>
                    <small>
                      {tmeta(m.target).name} · {m.task === "regression" ? `MAE ${m.metrics?.mae != null ? m.metrics.mae.toFixed(1) : "—"}` : `CSI ${m.metrics?.csi != null ? m.metrics.csi.toFixed(2) : "—"}`}
                      {out !== "detections" ? ` · → ${out === "grid" ? "weather layer" : "outlook"}` : ""}
                      {st?.models_state?.[m.id]?.state ? ` · ${st.models_state[m.id].state}` : ""}
                    </small>
                  </span>
                  <button class={`icon-btn ml-rm-opt ${nOpt ? "set" : ""}`} title="Run options for this model" onClick={(e) => (e.stopPropagation(), setOptFor(optFor === mkey(m) ? "" : mkey(m)))}>
                    <Settings2 size={14} />
                    {nOpt > 0 && <small>{nOpt}</small>}
                  </button>
                </div>
                <Produced m={m} layers={(st?.layers ?? []).filter((l) => l.model_id === m.id)} err={st?.models_state?.[m.id]?.error} />
                {optFor === mkey(m) && <RunOptionsPanel m={m} />}
              </div>
            );
          })}
          {!mine.length && <div class="muted small">No models on {where === "local" ? "this computer" : "the server"} yet — train or import one first.</div>}
          {mine.length > 1 && (
            <button class="chip" onClick={() => setSel(sel.length === mine.length ? [] : mine.map((m) => m.id))}>
              {sel.length === mine.length ? "None" : "All models"}
            </button>
          )}
        </div>

        <span class="ml-flabel">
          Radars <small class="muted">· {nRadars} selected (NEXRAD + TDWR)</small>
        </span>
        <div class="seg ml-rmode">
          {(
            [
              ["all", "All US radars"],
              ["nexrad", "All NEXRAD"],
              ["tdwr", "All TDWR"],
              ["states", "By state"],
              ["pick", "Pick on map"],
              ["current", "Current radar"],
            ] as [RMode, string][]
          ).map(([k, l]) => (
            <button key={k} class={mode === k ? "on" : ""} onClick={() => setMode(k)}>
              {l}
            </button>
          ))}
        </div>
        {mode === "states" && (
          <div class="ml-states">
            {allStates.map((s) => (
              <button key={s} class={states.includes(s) ? "on" : ""} onClick={() => setStates(states.includes(s) ? states.filter((x) => x !== s) : [...states, s])}>
                {s}
              </button>
            ))}
          </div>
        )}
        {mode === "pick" && (
          <div class="ml-picked">
            <button class="btn sm ghost" disabled={!!pickMode.value} onClick={async () => setPicked((await pickRadars(picked)) ?? picked)}>
              <MousePointerClick size={13} /> Pick radars on the map
            </button>
            {picked.map((id) => (
              <span key={id} class="chip on" onClick={() => setPicked(picked.filter((x) => x !== id))} title="Remove">
                {id} ×
              </span>
            ))}
          </div>
        )}
        {mode === "current" && (
          <div class="muted small">
            {[settings.value.radar.site, ...settings.value.extraSites].join(", ")} <Help text="The radar on screen plus the extra radars shown with Ctrl+click (fixed at the time you press Enable)" />
          </div>
        )}
        <div class="ml-run-row">
          <Field label="Concurrency" help="Radars / grid tiles scored at the same time (more = faster cycles, more CPU)">
            <input type="number" min={1} max={32} value={conc} onChange={(e) => setConc(Math.max(1, Math.min(32, Math.round(+(e.target as HTMLInputElement).value))))} style={{ width: "64px" }} />
          </Field>
          <Field label="Interval" help="How often each radar is scored. 'Every new volume' scores each volume as it arrives (most timely, most CPU). Grid / outlook models use their own 'Run every' option.">
            <select value={String(interval)} onChange={(e) => setIntv(+(e.target as HTMLSelectElement).value)}>
              {INTERVALS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <div class="ml-run-btns">
            <button class="btn ghost" disabled={busy || test.busy || !sel.length || (!!cellModels.length && !site)} title={cellModels.length ? `Run the selected models once (radar-cell models on the newest ${site} volume) and show the result on the map` : "Run the selected models once and show the result"} onClick={runTest}>
              <FlaskConical size={14} /> {test.busy ? "Testing…" : cellModels.length ? `Test on ${site || "radar"}` : "Run once"}
            </button>
            {st?.enabled && (
              <button class="btn ghost" disabled={busy} onClick={() => apply(false)}>
                <Power size={14} /> Disable
              </button>
            )}
            <button class="btn" disabled={busy || !sel.length || !nRadars} onClick={() => apply(true)}>
              <Power size={14} /> {st?.enabled ? "Apply changes" : "Enable"}
            </button>
          </div>
        </div>
        {test.text && <div class="muted small ml-test-res">{test.text}</div>}
      </div>

      <div class="ml-run-out">
        <div class="ml-box ml-dets">
          <h4>
            Detections <small class="muted">newest first · {gatedDets.length}{gatedDets.length !== allDets.length ? ` of ${allDets.length}` : ""}</small>
            <label class="ml-check ml-lg" title="Show only detections inside the probability gate on the map (legend bar)">
              <input type="checkbox" checked={lg} onChange={(e) => update((s) => (s.ml = { ...(s.ml ?? {}), listGate: (e.target as HTMLInputElement).checked }))} /> match map gate{lg && pg.on ? ` (${Math.round(pg.lo * 100)}–${Math.round(pg.hi * 100)}%)` : ""}
            </label>
            {detStatus.value.error && (
              <span class="ml-warn" title={detStatus.value.error}>
                <AlertTriangle size={12} />
              </span>
            )}
          </h4>
          <div class="ml-det-list">
            {dets.map((d) => (
              <button key={d.key} class="ml-dl" onClick={() => showDetection(d)} title="Fly there">
                <TIcon t={d.target} size={20} />
                <span class="ml-dl-p" style={{ "--lc": LEVEL_COLOR[d.level] }}>
                  {Math.round(d.prob * 100)}%
                </span>
                <span class="ml-dl-main">
                  <span>
                    <b>{tmeta(d.target).code}</b> {d.model_name}
                  </span>
                  <small>
                    {d.kind === "area" ? `area${d.valid_from ? ` · valid ${fmtTime(d.valid_from)}${d.valid_to ? `–${fmtTime(d.valid_to)}` : ""}` : ""}` : d.site || "—"} · {fmtTime(d.t)} ({fmtAge(d.t)}){c ? ` · ${fmtDist(distance(c.lat, c.lng, d.lat, d.lon))} from centre` : ""}
                  </small>
                </span>
                {d.ep === "local" && !localIsMain.value && <EpBadge ep="local" />}
                <Crosshair size={13} class="muted" />
              </button>
            ))}
            {!dets.length && <div class="ml-empty small">{allDets.length ? "No detections inside the map's probability gate." : "No detections in the last hour."}</div>}
          </div>
        </div>
        <div class="ml-box ml-per">
          <h4>
            Radars <small class="muted">{per.length ? `${per.length} · ${per.filter(([, v]) => v.error).length} with errors` : ""}</small>
            <button class="icon-btn" title="Refresh" onClick={() => loadRun()}>
              <RefreshCw size={13} />
            </button>
          </h4>
          <div class="ml-per-wrap">
            <table class="ml-table">
              <thead>
                <tr>
                  <th>Radar</th>
                  <th>Last volume</th>
                  <th>Cells</th>
                  <th>Det.</th>
                  <th>Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {per.map(([site, v]) => (
                  <tr key={site} class={v.error ? "err" : ""}>
                    <td>
                      <b>{site}</b>
                    </td>
                    <td>{v.t ? fmtAge(v.t < 1e11 ? v.t * 1000 : v.t) : "—"}</td>
                    <td>{v.cells ?? "—"}</td>
                    <td>{v.detections ?? "—"}</td>
                    <td>{v.ms != null ? `${v.ms} ms` : "—"}</td>
                    <td class="ml-per-st" title={v.error}>
                      {v.error ? v.error : "ok"}
                    </td>
                  </tr>
                ))}
                {!per.length && (
                  <tr>
                    <td colSpan={6} class="muted">
                      {st?.enabled ? "Waiting for the first cycle…" : "Enable the runner to see per-radar status"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- models 0.7: layers a grid / outlook model produced ---------- */
function Produced({ m, layers, err }: { m: Model; layers: PredLayer[]; err?: string }) {
  const out = outputOf(m.target, m.output);
  if (out === "detections" && !layers.length && !err) return null;
  const open = async (l: PredLayer) => {
    await refreshGridCatalog();
    ensurePredDef(l, m);
    selectWeather({ kind: "grid", id: l.layer_id });
    mlOpen.value = false;
  };
  const span = (l: PredLayer) => (l.valid_times.length ? `${l.valid_times.length} time${l.valid_times.length > 1 ? "s" : ""} · ${fmtTime(Math.min(...l.valid_times), true)} → ${fmtTime(Math.max(...l.valid_times), true)}` : "no frames yet");
  return (
    <div class="ml-prod">
      {layers
        .filter((l) => l.kind !== "outlook")
        .map((l) => (
          <button key={l.layer_id} class="btn xs" title={`Show ${l.layer_id} as the main weather layer (${span(l)})`} onClick={() => open(l)}>
            <Layers size={12} /> Open as weather layer{l.field || l.layer_id.split("/")[2] ? ` · ${l.name ?? l.field ?? l.layer_id.split("/")[2]}` : ""}
            <small>{span(l)}</small>
          </button>
        ))}
      {out === "outlook" && (
        <button class="btn xs" title="Add the model's outlook to the map (Day 1 by default; change day / hazard on the map card)" onClick={() => (showOutlook(m, String(runOptsOf(m).day ?? "1")), (mlOpen.value = false))}>
          <MapIcon size={12} /> Show outlook
        </button>
      )}
      {out !== "detections" && !layers.some((l) => l.kind !== "outlook") && out !== "outlook" && <small class="muted">The forecast layer appears here after the first run.</small>}
      {err && <small class="ml-prod-err">{err}</small>}
    </div>
  );
}
