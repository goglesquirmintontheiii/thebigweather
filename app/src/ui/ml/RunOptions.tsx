// models 0.7: per-model run options, rendered generically from catalog.run_params (filtered by
// applies_to = target ids or outputs), with a client-side fallback list for older servers. Values
// are saved per model in settings.ml.runOpts["ep|id"] and sent as {id, …options} in POST /api/ml/run.
// Also exports the generic option input used by the training form for targets[].params.

import { useState } from "preact/hooks";
import { SquareDashed, X, RotateCcw } from "lucide-preact";
import { settings, update } from "../../store";
import { catalog, mkey } from "../../ml/client";
import { pickBox } from "../../ml/pick";
import { outputOf, taskOf } from "../../ml/targets";
import type { Model, OptDef } from "../../ml/types";
import { Field } from "./common";

const STATES = "AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const REGIONS: [string, string[]][] = [
  ["Plains", ["TX", "OK", "KS", "NE", "SD", "ND", "CO", "IA", "MO"]],
  ["Dixie", ["LA", "MS", "AL", "TN", "AR", "GA", "KY"]],
  ["Gulf coast", ["TX", "LA", "MS", "AL", "FL"]],
  ["Northeast", ["PA", "NY", "NJ", "CT", "RI", "MA", "VT", "NH", "ME"]],
];

/** fallback when the server's catalog has no run_params (ids = POST /api/ml/run options) */
const DET = ["detections"], GRID = ["grid", "outlook"], CELL = ["radar_cell"];
export const DEFAULT_RUN_PARAMS: OptDef[] = [
  { id: "threshold", name: "Detection threshold", type: "float", min: 0.01, max: 0.99, step: 0.01, help: "Probability at which a detection counts (moderate level). Default: the model's saved threshold.", applies_to: DET, group: "Probability" },
  { id: "min_prob", name: "Min probability", type: "float", min: 0, max: 1, step: 0.01, help: "Don't report anything below this probability", applies_to: [], group: "Probability" },
  { id: "max_prob", name: "Max probability", type: "float", min: 0, max: 1, step: 0.01, help: "Don't report anything above this (e.g. to study the uncertain middle)", applies_to: [], group: "Probability" },
  { id: "persistence", name: "Persistence", type: "int", min: 1, max: 10, unit: "scans", help: "Report only after the cell is flagged on this many consecutive volumes (fewer false alarms, later warning)", applies_to: CELL, group: "Detections" },
  { id: "min_cell_dbz", name: "Min cell reflectivity", type: "float", min: 20, max: 70, step: 1, unit: "dBZ", help: "Ignore cells weaker than this", applies_to: CELL, group: "Detections" },
  { id: "max_range_km", name: "Max range from radar", type: "float", min: 20, max: 460, step: 10, unit: "km", help: "Cells farther from the radar are skipped (beam too high)", applies_to: CELL, group: "Detections" },
  { id: "min_area_km2", name: "Min area", type: "float", min: 0, max: 100000, step: 50, unit: "km²", help: "Drop forecast areas smaller than this", applies_to: GRID, group: "Detections" },
  { id: "max_detections", name: "Max detections per cycle", type: "int", min: 1, max: 1000, help: "Keep only the most probable", applies_to: [], group: "Detections" },
  { id: "region", name: "Region", type: "region", help: "Only run inside these states / this box", applies_to: [], group: "Where & when" },
  { id: "leads", name: "Forecast leads", type: "leads", choices: [0, 1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 72, 96, 120, 168], unit: "h", help: "Which forecast hours to produce", applies_to: ["grid"], group: "Where & when" },
  { id: "day", name: "Valid period", type: "day", help: "Outlook day (like SPC day 1–3, 4–7) or a custom valid range", applies_to: ["outlook", "grid"], group: "Where & when" },
  { id: "grid_res_deg", name: "Grid resolution", type: "choice", choices: [[0.05, "0.05°"], [0.1, "0.1°"], [0.25, "0.25°"], [0.5, "0.5°"], [1, "1°"]], help: "Spacing of the prediction grid (finer = slower)", applies_to: GRID, group: "Grid" },
  { id: "smoothing_km", name: "Smoothing", type: "float", min: 0, max: 300, step: 5, unit: "km", help: "Gaussian smoothing of the probability field before drawing areas / outlooks", applies_to: GRID, group: "Grid" },
  { id: "ensemble", name: "Ensemble", type: "choice", choices: [["", "Off"], ["gefs", "GEFS members"], ["time_lagged", "Time-lagged runs"], ["both", "Both"]], help: "Run the model on several inputs and average (smoother, more reliable probabilities)", applies_to: GRID, group: "Grid" },
  { id: "cadence_min", name: "Run every", type: "int", min: 5, max: 1440, step: 5, unit: "min", help: "How often the model runs (grid / outlook models)", applies_to: GRID, group: "Grid" },
  { id: "notify", name: "Notify", type: "bool", help: "Desktop / push notification for new high-probability detections", applies_to: [], group: "Detections" },
];

export function optChoices(p: OptDef): [string, string][] {
  return (p.choices ?? []).map((c) => (Array.isArray(c) ? [String(c[0]), c[1]] : typeof c === "object" ? [String(c.id), c.name] : [String(c), String(c)]));
}
const isNum = (p: OptDef) => p.type === "int" || p.type === "float" || p.type === "number";
const raw = (p: OptDef, v: string) => {
  const ch = p.choices?.find((c) => String(Array.isArray(c) ? c[0] : typeof c === "object" ? c.id : c) === v);
  const x = ch == null ? v : Array.isArray(ch) ? ch[0] : typeof ch === "object" ? ch.id : ch;
  return typeof x === "number" || (/^-?\d+(\.\d+)?$/.test(String(x)) && typeof p.default !== "string") ? +x : x;
};

/** generic input for an option (number / bool / choice / multi / string) */
export function OptInput({ p, value, onChange }: { p: OptDef; value: any; onChange: (v: any) => void }) {
  const v = value ?? p.default;
  if (p.type === "bool") return <input type="checkbox" checked={!!v} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />;
  const ch = optChoices(p);
  if (p.type === "multi" || p.type === "leads") {
    const arr: string[] = (Array.isArray(v) ? v : []).map(String);
    return (
      <div class="ml-chips">
        {ch.map(([k, l]) => (
          <button key={k} class={`chip ${arr.includes(k) ? "on" : ""}`} onClick={(e) => (e.preventDefault(), onChange((arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]).map((x) => raw(p, x))))}>
            {l}
            {p.type === "leads" ? " h" : ""}
          </button>
        ))}
      </div>
    );
  }
  if (ch.length)
    return (
      <select value={String(v ?? "")} onChange={(e) => onChange(raw(p, (e.target as HTMLSelectElement).value))}>
        {v == null && <option value="">Default</option>}
        {ch.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    );
  if (!isNum(p)) return <input value={v ?? ""} onChange={(e) => onChange((e.target as HTMLInputElement).value)} />;
  const step = p.step ?? (p.type === "int" ? 1 : Math.abs(+(p.default ?? 1)) < 1 ? 0.01 : 0.1);
  return (
    <span class="ml-num">
      <input type="number" min={p.min} max={p.max} step={step} placeholder={p.default != null ? String(p.default) : "default"} value={value ?? ""} onChange={(e) => {
        const t = (e.target as HTMLInputElement).value;
        if (t === "") return onChange(undefined);
        let n = +t;
        if (p.type === "int") n = Math.round(n);
        if (p.min != null) n = Math.max(p.min, n);
        if (p.max != null) n = Math.min(p.max, n);
        onChange(n);
      }} />
      {p.unit && <small class="muted">{p.unit}</small>}
    </span>
  );
}

// ---------- saved options ----------
export function runOptsOf(m: Model): Record<string, any> {
  return settings.value.ml?.runOpts?.[mkey(m)] ?? {};
}
export function setRunOpts(m: Model, fn: (o: Record<string, any>) => Record<string, any>) {
  update((s) => {
    const ml = { ...(s.ml ?? {}) };
    const all = { ...(ml.runOpts ?? {}) };
    const next = fn({ ...(all[mkey(m)] ?? {}) });
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "" || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
    if (Object.keys(next).length) all[mkey(m)] = next;
    else delete all[mkey(m)];
    ml.runOpts = all;
    s.ml = ml;
  });
}
/** the {id, …options} item for POST /api/ml/run (plain id when nothing is set) */
export function runItem(m: Model): string | ({ id: string } & Record<string, any>) {
  const o = runOptsOf(m);
  return Object.keys(o).length ? { id: m.id, ...o } : m.id;
}

export function paramsFor(m: Model): OptDef[] {
  const all = catalog.value?.run_params?.length ? catalog.value.run_params : DEFAULT_RUN_PARAMS;
  const out = outputOf(m.target, m.output);
  const tags = new Set([m.target, out, m.candidate ?? "", taskOf(m.target, m.task), "*"]);
  return all.filter((p) => {
    if (!p.applies_to?.length) return true;
    if (p.id === "threshold" && taskOf(m.target, m.task) === "regression") return false;
    return p.applies_to.some((a) => tags.has(a));
  });
}

// ---------- panel ----------
export function RunOptionsPanel({ m }: { m: Model }) {
  const o = runOptsOf(m);
  const ps = paramsFor(m);
  const set = (k: string, v: any) => setRunOpts(m, (x) => ({ ...x, [k]: v }));
  const groups = new Map<string, OptDef[]>();
  for (const p of ps) {
    const g = p.group ?? "Options";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }
  const n = Object.keys(o).length;
  return (
    <div class="ml-ropts">
      <div class="ml-ropts-head">
        <span>
          {n ? `${n} option${n > 1 ? "s" : ""} set` : "All defaults"} <small class="muted">· saved for this model</small>
        </span>
        {n > 0 && (
          <button class="btn xs ghost" onClick={() => setRunOpts(m, () => ({}))}>
            <RotateCcw size={12} /> Defaults
          </button>
        )}
      </div>
      {[...groups.entries()].map(([g, list]) => (
        <div key={g} class="ml-ropts-g">
          <small class="ml-ropts-gt">{g}</small>
          <div class="ml-grid">
            {list.map((p) => {
              if (p.type === "region" || p.id === "region") return <RegionOpt key={p.id} p={p} value={o.region} onChange={(v) => set("region", v)} />;
              if (p.type === "day" || p.type === "range" || p.id === "day") return <DayOpt key={p.id} p={p} o={o} m={m} />;
              if (p.type === "leads" || p.id === "leads") {
                const tl = catalog.value?.targets.find((t) => t.id === m.target)?.leads;
                const q: OptDef = { ...p, type: "leads", choices: p.choices?.length ? p.choices : tl?.length ? tl : DEFAULT_RUN_PARAMS.find((x) => x.id === "leads")!.choices };
                return (
                  <Field key={p.id} label={`${p.name} (h)`} help={p.help} wide>
                    <OptInput p={q} value={o.leads} onChange={(v) => set("leads", v)} />
                  </Field>
                );
              }
              const pct = (p.id === "threshold" || p.id === "min_prob" || p.id === "max_prob") && (p.max ?? 1) <= 1;
              return (
                <Field key={p.id} label={p.name} help={p.help} wide={p.type === "multi"}>
                  {pct ? <PctInput value={o[p.id]} def={p.id === "threshold" ? m.threshold : p.default} onChange={(v) => set(p.id, v)} /> : <OptInput p={p} value={o[p.id]} onChange={(v) => set(p.id, v)} />}
                </Field>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 0–1 option edited as a percentage */
function PctInput({ value, def, onChange }: { value?: number; def?: number; onChange: (v: number | undefined) => void }) {
  return (
    <span class="ml-num">
      <input type="number" min={0} max={100} step={1} placeholder={def != null ? String(Math.round(def * 100)) : "—"} value={value != null ? Math.round(value * 1000) / 10 : ""} onChange={(e) => {
        const t = (e.target as HTMLInputElement).value;
        onChange(t === "" ? undefined : Math.max(0, Math.min(100, +t)) / 100);
      }} />
      <small class="muted">%</small>
    </span>
  );
}

function RegionOpt({ p, value, onChange }: { p: OptDef; value?: { states?: string[]; bbox?: [number, number, number, number] }; onChange: (v: any) => void }) {
  const [open, setOpen] = useState(false);
  const r = value ?? {};
  const st = r.states ?? [];
  const put = (n: typeof r) => onChange(n.states?.length || n.bbox ? n : undefined);
  return (
    <Field label={p.name} help={p.help} wide>
      <div class="ml-chips">
        <button class={`chip ${!st.length && !r.bbox ? "on" : ""}`} onClick={(e) => (e.preventDefault(), put({}))}>
          Everywhere
        </button>
        {REGIONS.map(([n, s]) => (
          <button key={n} class={`chip ${st.length && s.every((x) => st.includes(x)) && st.length === s.length ? "on" : ""}`} onClick={(e) => (e.preventDefault(), put({ ...r, states: s }))}>
            {n}
          </button>
        ))}
        <button class={`chip ${open ? "on" : ""}`} onClick={(e) => (e.preventDefault(), setOpen(!open))}>
          States{st.length ? ` (${st.length})` : ""}…
        </button>
        {r.bbox ? (
          <span class="chip on">
            Box {r.bbox.map((v) => v.toFixed(1)).join(", ")}
            <button class="ml-x" title="Remove the box" onClick={(e) => (e.preventDefault(), put({ ...r, bbox: undefined }))}>
              <X size={11} />
            </button>
          </span>
        ) : (
          <button
            class="chip"
            onClick={async (e) => {
              e.preventDefault();
              const b = await pickBox();
              if (b) put({ ...r, bbox: b });
            }}
          >
            <SquareDashed size={12} /> Draw box
          </button>
        )}
      </div>
      {open && (
        <div class="ml-states">
          {STATES.map((s) => (
            <button key={s} class={st.includes(s) ? "on" : ""} onClick={(e) => (e.preventDefault(), put({ ...r, states: st.includes(s) ? st.filter((x) => x !== s) : [...st, s] }))}>
              {s}
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

const DAY_PRESETS: [string, string][] = [["1", "Day 1"], ["2", "Day 2"], ["3", "Day 3"], ["4-7", "Day 4–7"], ["custom", "Custom range"]];
function DayOpt({ p, o, m }: { p: OptDef; o: Record<string, any>; m: Model }) {
  const cur = o.valid_from || o.valid_to ? "custom" : o.day != null ? String(o.day) : "";
  const [custom, setCustom] = useState(cur === "custom");
  const toLocal = (t?: number) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
  const setDay = (k: string) => {
    if (k === "custom") {
      setCustom(true);
      const now = Date.now();
      return setRunOpts(m, (x) => ({ ...x, day: undefined, valid_from: x.valid_from ?? now, valid_to: x.valid_to ?? now + 24 * 3600e3 }));
    }
    setCustom(false);
    setRunOpts(m, (x) => ({ ...x, day: k === "" ? undefined : k === "4-7" ? "4-7" : +k, valid_from: undefined, valid_to: undefined }));
  };
  return (
    <Field label={p.name} help={p.help} wide>
      <div class="seg ml-days">
        <button class={!cur && !custom ? "on" : ""} onClick={(e) => (e.preventDefault(), setDay(""))}>
          Next run
        </button>
        {DAY_PRESETS.map(([k, l]) => (
          <button key={k} class={(k === "custom" ? custom || cur === "custom" : cur === k) ? "on" : ""} onClick={(e) => (e.preventDefault(), setDay(k))}>
            {l}
          </button>
        ))}
      </div>
      {(custom || cur === "custom") && (
        <div class="ml-range ml-dt">
          <input type="datetime-local" value={toLocal(o.valid_from)} onChange={(e) => setRunOpts(m, (x) => ({ ...x, valid_from: new Date((e.target as HTMLInputElement).value).getTime() || undefined }))} />
          →
          <input type="datetime-local" value={toLocal(o.valid_to)} onChange={(e) => setRunOpts(m, (x) => ({ ...x, valid_to: new Date((e.target as HTMLInputElement).value).getTime() || undefined }))} />
        </div>
      )}
    </Field>
  );
}
