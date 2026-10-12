// Detection models → Run: pick models + radars, enable the runner (server or this computer),
// per-radar status, and the newest detections (click to fly there).

import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Power, MousePointerClick, RefreshCw, Crosshair, AlertTriangle, FlaskConical } from "lucide-preact";
import { models, loadModels, runState, loadRun, setRun, testRun, detections, startDetections, detStatus, mkey, mlTab, mlPrefs, canLocal, localIsMain } from "../../ml/client";
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
    const ok = await setRun(where, { models: sel, radars: radars(), enabled, interval_s: interval });
    setBusy(false);
    if (ok && enabled) enableDetectionLayer();
  };
  const cellModels = sel.filter((id) => mine.find((m) => m.id === id)?.candidate !== "grid_point");
  const site = settings.value.radar.site;
  const runTest = async () => {
    setTest({ busy: true, text: `Scoring the newest ${site} volume…` });
    const r = await testRun(where, site, cellModels);
    if (r) enableDetectionLayer();
    setTest({ text: !r ? "" : r.error ? `${site}: ${r.error}` : `${site}: ${r.cells ?? "?"} cells, ${r.n} detection${r.n === 1 ? "" : "s"}${r.ms != null ? ` · ${r.ms} ms` : ""}${r.n ? " · shown on the map" : ""}` });
  };
  const per = Object.entries(st?.per_radar ?? {}).sort((a, b) => +!!b[1].error - +!!a[1].error || (b[1].detections ?? 0) - (a[1].detections ?? 0) || a[0].localeCompare(b[0]));
  const c = mapRef.value?.getCenter();
  const dets = detections.value.slice(0, 200);
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
            return (
              <button key={mkey(m)} class={`ml-rm ${on ? "on" : ""}`} onClick={() => setSel(on ? sel.filter((x) => x !== m.id) : [...sel, m.id])}>
                <input type="checkbox" checked={on} tabIndex={-1} />
                <TIcon t={m.target} size={20} />
                <span>
                  <b>{m.name}</b>
                  <small>
                    {tmeta(m.target).name} · CSI {m.metrics?.csi != null ? m.metrics.csi.toFixed(2) : "—"}
                  </small>
                </span>
              </button>
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
          <Field label="Interval" help="How often each radar is scored. 'Every new volume' scores each volume as it arrives (most timely, most CPU).">
            <select value={String(interval)} onChange={(e) => setIntv(+(e.target as HTMLSelectElement).value)}>
              {INTERVALS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <div class="ml-run-btns">
            <button class="btn ghost" disabled={busy || test.busy || !cellModels.length || !site} title={cellModels.length ? `Run the selected radar-cell models once on the newest ${site} volume and show the result on the map` : "Select a radar-cell model"} onClick={runTest}>
              <FlaskConical size={14} /> {test.busy ? "Testing…" : `Test on ${site || "radar"}`}
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
            Detections <small class="muted">newest first · {detections.value.length}</small>
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
                    {d.site || "—"} · {fmtTime(d.t)} ({fmtAge(d.t)}){c ? ` · ${fmtDist(distance(c.lat, c.lng, d.lat, d.lon))} from centre` : ""}
                  </small>
                </span>
                {d.ep === "local" && !localIsMain.value && <EpBadge ep="local" />}
                <Crosshair size={13} class="muted" />
              </button>
            ))}
            {!dets.length && <div class="ml-empty small">No detections in the last hour.</div>}
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
