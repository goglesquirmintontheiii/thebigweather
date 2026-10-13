// Detection models → Train: Quick (presets, a few clicks) and Custom (every knob, from the catalog).

import { useEffect, useMemo, useState } from "preact/hooks";
import { Rocket, Sparkles, SlidersHorizontal, SquareDashed, X, Info, Cpu, Globe2, Server, Laptop } from "lucide-preact";
import { catalog, catalogErr, loadCatalog, startTraining, trainDraft, mlTab, mlPrefs, canLocal, retrainModel, models, type RetrainMode, localIsMain, localUrl, jobs } from "../../ml/client";
import { mlSettings, loadMlSettings, setMaxJobs, INTENSITIES } from "../../ml/m8"; // models 0.8
import type { Resources } from "../../ml/types";
import { tmeta, outputOf, taskOf } from "../../ml/targets";
import { ModeSwitch } from "./Retrain"; // models 0.7
import { OptInput, optChoices } from "./RunOptions"; // models 0.7: generic option inputs
import { pickBox } from "../../ml/pick";
import { update } from "../../store";
import type { Catalog, Ep, FilterDef, ParamDef, Preset, TrainSpec } from "../../ml/types";
import { TIcon, WhereToggle, Field, Help, fmtDur } from "./common";

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const PLAINS = ["TX", "OK", "KS", "NE", "SD", "ND", "CO", "IA", "MO"];
const DIXIE = ["LA", "MS", "AL", "TN", "AR", "GA", "KY"];
// fallbacks when the catalog doesn't list them (ids as the server knows them)
const DEF_RADAR = ["REF", "VEL", "SW", "ZDR", "RHO", "PHI", "CREF", "ET", "VIL"];
const DEF_MRMS = ["azs02", "mesh", "vil", "et18", "cref", "posh", "rot2h", "qpe1h", "qpe6h", "prate"];
const DEF_MODEL = ["cape", "mucape", "cin", "pwat", "rh700", "absv850", "shear_850_200", "sst", "mslp", "t2m", "rh2m", "wind10"];
const SRC_NAMES: Record<string, string> = { REF: "Reflectivity", VEL: "Velocity", SW: "Spectrum width", ZDR: "ZDR", RHO: "Correlation coef.", PHI: "Diff. phase", KDP: "KDP", CREF: "Composite refl.", ET: "Echo tops", VIL: "VIL" };
const opt = (x: string | { id: string; name: string }): [string, string] => (typeof x === "string" ? [x, SRC_NAMES[x] ?? x.replace(/_/g, " ")] : [x.id, x.name]);
/* models 0.7: satellite + other source fallbacks (the catalog's `sources` wins) */
type SrcItem = string | { id: string; name: string; group?: string; help?: string; unit?: string };
const DEF_SAT: SrcItem[] = [
  { id: "abi_c02", name: "C02 · Red visible 0.64 µm", group: "GOES ABI bands" },
  { id: "abi_c07", name: "C07 · Shortwave IR 3.9 µm", group: "GOES ABI bands" },
  { id: "abi_c08", name: "C08 · Upper water vapor 6.2 µm", group: "GOES ABI bands" },
  { id: "abi_c09", name: "C09 · Mid water vapor 6.9 µm", group: "GOES ABI bands" },
  { id: "abi_c10", name: "C10 · Low water vapor 7.3 µm", group: "GOES ABI bands" },
  { id: "abi_c13", name: "C13 · Clean IR 10.3 µm", group: "GOES ABI bands" },
  { id: "abi_c14", name: "C14 · IR 11.2 µm", group: "GOES ABI bands" },
  { id: "abi_c15", name: "C15 · Dirty IR 12.3 µm", group: "GOES ABI bands" },
  { id: "ir_cooling", name: "Cloud-top cooling rate", group: "Derived" },
  { id: "ir_min", name: "Coldest cloud top", group: "Derived" },
  { id: "ot", name: "Overshooting-top score", group: "Derived" },
  { id: "glm_fed", name: "GLM flash-extent density", group: "Lightning (GLM)" },
  { id: "glm_trend", name: "GLM flash-rate trend (jump)", group: "Lightning (GLM)" },
];
const DEF_OTHER: SrcItem[] = [
  { id: "spc_outlook", name: "SPC outlook (as a feature)" },
  { id: "nws_warnings", name: "Active NWS warnings" },
  { id: "lightning", name: "Ground lightning" },
  { id: "nwm", name: "National Water Model streamflow" },
  { id: "soil_moisture", name: "Soil moisture" },
  { id: "climatology", name: "Climatology (day of year)" },
  { id: "terrain", name: "Terrain / land use" },
];
const srcList = (v: any, d: SrcItem[]): SrcItem[] => (Array.isArray(v) && v.length ? v : d);
const ids2 = (l: SrcItem[]) => l.map((x) => (typeof x === "string" ? x : x.id));
/** grouped [group, [id, name][]] */
function groupsOf(l: SrcItem[]): [string, [string, string][]][] {
  const g = new Map<string, [string, string][]>();
  for (const x of l) {
    const k = typeof x === "string" ? "" : x.group ?? "";
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(opt(x as any));
  }
  return [...g.entries()];
}

const TIME_LIMITS: [string, string][] = [["", "No limit"], ["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"], ["240", "4 hours"], ["480", "8 hours"], ["1440", "24 hours"], ["c", "Custom…"]];

/** label filters per target (server ids: labels::Filters) */
const EF = [["0", "EF0+"], ["1", "EF1+"], ["2", "EF2+ (significant)"], ["3", "EF3+"], ["4", "EF4+"]] as [string, string][];
const BASINS: [string, string][] = [["al", "Atlantic"], ["ep", "East Pacific"]];
const FILTERS: Record<string, FilterDef[]> = {
  tornado: [{ id: "min_mag", name: "Tornado rating", type: "choice", options: EF, default: 0, help: "Only tornadoes rated at least this count as events" }],
  debris: [{ id: "min_mag", name: "Tornado rating", type: "choice", options: EF, default: 2, help: "Debris signatures usually need EF2+ tornadoes" }],
  supercell: [{ id: "min_size_in", name: "Hail at least", type: "number", unit: "in", default: 1.5, min: 0.5, max: 5, step: 0.25 }],
  hail: [{ id: "min_size_in", name: "Hail at least", type: "number", unit: "in", default: 1, min: 0.5, max: 5, step: 0.25 }],
  sighail: [{ id: "min_size_in", name: "Hail at least", type: "number", unit: "in", default: 2, min: 1, max: 6, step: 0.25 }],
  wind: [{ id: "min_wind_kt", name: "Wind at least", type: "number", unit: "kt", default: 50, min: 30, max: 120, step: 1 }],
  tropical_genesis: [{ id: "basins", name: "Basins", type: "multi", options: BASINS, default: ["al", "ep"] }],
  tropical_possible: [{ id: "basins", name: "Basins", type: "multi", options: BASINS, default: ["al", "ep"] }],
  wildfire: [{ id: "min_frp", name: "Fire power at least", type: "number", unit: "MW", default: 0, min: 0, max: 1000, step: 5 }],
};
const asList = (v: any): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

function defaults(cat: Catalog, target: string, prev?: Partial<TrainSpec>): TrainSpec {
  const t = cat.targets.find((x) => x.id === target) ?? cat.targets[0];
  const id = t?.id ?? target;
  const cand = t?.candidate ?? "radar_cell";
  const grid = cand === "grid_point";
  // a preset for this target carries the server's fully resolved defaults (sources, grid, match…)
  const pre = cat.presets.find((p) => p.target === id) ?? (id === "tropical_possible" ? cat.presets.find((p) => p.target === "tropical_genesis") : undefined);
  const base: any = JSON.parse(JSON.stringify(pre?.spec ?? cat.defaults ?? {}));
  delete base.preset;
  let ls = asList(t?.default_labels_source);
  if (!ls.length) ls = [(cat.label_sources.find((x) => x.targets?.includes(id)) ?? cat.label_sources[0])?.id].filter(Boolean) as string[];
  const algo = cat.algos.find((a) => a.id === base.algo) ?? cat.algos[0];
  const filters: Record<string, any> = { ...(pre ? base.filters : {}) };
  for (const f of t?.filters ?? FILTERS[id] ?? []) if (filters[f.id] == null || (Array.isArray(filters[f.id]) && !filters[f.id].length)) filters[f.id] = f.default;
  const yrs = cat.label_sources.find((x) => x.id === ls[0])?.years ?? [2015, new Date().getFullYear()];
  const ids = (l: any[] | undefined, d: string[]) => (l ?? d).map((x) => opt(x)[0]);
  return {
    ...base,
    name: prev?.name ?? "",
    target: id,
    candidate: cand,
    label_source: ls,
    years: pre && Array.isArray(base.years) ? base.years : [Math.max(yrs[0], yrs[1] - 4), yrs[1] - 1],
    region: base.region ?? {},
    filters,
    max_events: base.max_events ?? 400,
    neg_ratio: base.neg_ratio ?? 3,
    null_days: base.null_days ?? (grid ? 20 : 10),
    match: base.match ?? { radius_km: grid ? 150 : 15, before_min: grid ? 0 : 20, after_min: grid ? 0 : 10 },
    // the preset's resolved sources as they are (HRRR analyses, forecast-window fields, model / step too)
    sources: pre
      ? { ...base.sources, radar_products: base.sources?.radar_products ?? [], mrms: base.sources?.mrms ?? [], metar: !!base.sources?.metar, model: base.sources?.model ?? [], satellite: base.sources?.satellite ?? [], other: base.sources?.other ?? [], hrrr: base.sources?.hrrr ?? [], fcst: base.sources?.fcst ?? [], fcst_model: base.sources?.fcst_model || (base.sources?.fcst?.length ? "gfs" : ""), fcst_step_h: base.sources?.fcst_step_h ?? 0 }
      : {
          radar_products: grid ? [] : ids(cat.radar_products, DEF_RADAR),
          mrms: grid ? [] : ids(cat.mrms, DEF_MRMS).slice(0, 5),
          metar: !grid || id === "wildfire",
          model: grid ? ids(cat.model_fields, DEF_MODEL).slice(0, 12) : [],
          satellite: ids2(srcList(cat.sources?.satellite, DEF_SAT)).slice(0, 6),
          other: [],
          hrrr: [],
          fcst: [],
          fcst_model: "",
          fcst_step_h: 0,
        },
    // models 0.7: the target's own parameters (leads, hazard, thresholds… — sub-targets live here too)
    target_params: { ...Object.fromEntries((t?.params ?? []).filter((p) => p.default != null).map((p) => [p.id, p.default])), ...(base.target_params ?? {}) },
    task: (base.task === "regression" || base.task === "classification" ? base.task : undefined) ?? taskOf(id, t?.task),
    max_samples: base.max_samples ?? 0,
    features: base.features?.length ? base.features : undefined,
    algo: algo?.id ?? "gbdt",
    params: { ...Object.fromEntries((algo?.params ?? []).map((p) => [p.id, p.default])), ...(base.params ?? {}) },
    cv_folds: base.cv_folds ?? 0,
    time_limit_min: null,
  };
}

/** rough wall-clock estimate (minutes) for the UI */
export function estimateMin(s: Partial<TrainSpec>): number {
  const ev = s.max_events ?? 400;
  const samples = ev * (1 + (s.neg_ratio ?? 3)) + (s.null_days ?? 10) * 20;
  const nprod = (s.sources?.radar_products?.length ?? 5) + (s.sources?.mrms?.length ?? 3) * 0.5 + (s.sources?.model?.length ?? 0) * 0.1 + (s.sources?.metar ? 1 : 0);
  const vols = samples * (((s.match?.before_min ?? 20) + (s.match?.after_min ?? 10)) / 10 + 1) * 0.35;
  return Math.max(5, (vols * (1 + nprod * 0.25)) / 60 + (s.cv_folds ?? 5) * 2);
}

/* ---------- models 0.8: max training jobs per machine (GET/PUT /api/ml/settings) ---------- */
function MaxJobs() {
  useEffect(() => {
    loadMlSettings();
  }, [localUrl.value]);
  const st = mlSettings.value;
  const paused = jobs.value.filter((j) => j.state === "paused");
  const row = (ep: "main" | "local", label: string, Icon: any) => {
    const v = st[ep];
    const off = ep === "local" && !localUrl.value && !localIsMain.value;
    const pz = paused.filter((j) => j.ep === ep).length;
    return (
      <label class={`m8-mj ${off || (v && !v.supported) ? "off" : ""}`} title={off ? "The built-in server isn't running" : v && !v.supported ? "This server has no job limit setting yet" : `At most this many training jobs at once on ${label.toLowerCase()} (1–8). Lowering it pauses the newest jobs.`}>
        <Icon size={13} /> {label}
        <input
          type="number"
          min={1}
          max={8}
          disabled={off || !v?.supported}
          value={v?.max_jobs ?? 2}
          onChange={(e) => setMaxJobs(ep, +(e.target as HTMLInputElement).value)}
        />
        {pz > 0 && <small class="m8-paused">{pz} paused</small>}
      </label>
    );
  };
  return (
    <div class="m8-maxjobs">
      <span class="ml-flabel">
        Max training jobs <Help text="How many training jobs run at the same time on each machine (default 2). Extra jobs wait; lowering the limit pauses running ones until a slot frees up." />
      </span>
      {localIsMain.value ? row("main", "This computer", Laptop) : (
        <>
          {row("local", "App", Laptop)}
          {row("main", "Server", Server)}
        </>
      )}
    </div>
  );
}

/* ---------- models 0.8: training resources (spec.resources) ---------- */
const RES_PRESETS: [string, string, (cpu: number) => Resources][] = [
  ["light", "Light", (c) => ({ cpu_threads: Math.max(1, Math.round(c / 4)), ram_mb: 2048, download_concurrency: 2, io_concurrency: 2 })],
  ["balanced", "Balanced", (c) => ({ cpu_threads: Math.max(1, Math.round(c / 2)), ram_mb: 4096, download_concurrency: 6, io_concurrency: 4 })],
  ["max", "Max", (c) => ({ cpu_threads: c, ram_mb: 16384, download_concurrency: 16, io_concurrency: 8 })],
];
export function ResourcesEditor({ cat, value, onChange }: { cat: Catalog; value?: Resources; onChange: (r: Resources | undefined) => void }) {
  const cpu = Math.max(1, cat.server?.cpu_threads ?? (navigator.hardwareConcurrency || 8));
  const v = value ?? {};
  const set = (k: keyof Resources, x: number | undefined) => {
    const n = { ...v, [k]: x };
    for (const kk of Object.keys(n) as (keyof Resources)[]) if (n[kk] == null || !Number.isFinite(n[kk]!)) delete n[kk];
    onChange(Object.keys(n).length ? n : undefined);
  };
  const same = (r: Resources) => (Object.keys(r) as (keyof Resources)[]).every((k) => r[k] === v[k]);
  const num = (k: keyof Resources, label: string, min: number, max: number, step: number, unit: string, help: string) => (
    <Field label={label} help={help}>
      <span class="ml-num">
        <input type="number" min={min} max={max} step={step} placeholder="auto" value={v[k] ?? ""} onChange={(e) => {
          const t = (e.target as HTMLInputElement).value;
          set(k, t === "" ? undefined : Math.max(min, Math.min(max, Math.round(+t))));
        }} />
        {unit && <small class="muted">{unit}</small>}
      </span>
    </Field>
  );
  return (
    <div class="m8-res">
      <div class="ml-chips">
        <button class={`chip ${!value ? "on" : ""}`} onClick={(e) => (e.preventDefault(), onChange(undefined))}>
          Auto
        </button>
        {RES_PRESETS.map(([k, l, f]) => (
          <button key={k} class={`chip ${value && same(f(cpu)) ? "on" : ""}`} onClick={(e) => (e.preventDefault(), onChange(f(cpu)))}>
            {l}
          </button>
        ))}
      </div>
      <div class="ml-grid">
        {num("cpu_threads", "CPU threads", 1, Math.max(cpu, 64), 1, `of ${cpu}`, "Threads for feature extraction and training")}
        {num("ram_mb", "RAM limit", 256, 262144, 256, "MB", "Memory the job may use (samples are streamed to disk past it)")}
        {num("download_concurrency", "Downloads at once", 1, 64, 1, "", "Parallel archive downloads (radar volumes, MRMS, satellite)")}
        {num("io_concurrency", "Disk I/O at once", 1, 32, 1, "", "Parallel cache reads / writes")}
      </div>
    </div>
  );
}

export function TrainTab() {
  const [mode, setMode] = useState<"quick" | "custom">(trainDraft.value ? "custom" : "quick");
  useEffect(() => {
    loadCatalog();
  }, []);
  useEffect(() => {
    if (trainDraft.value) setMode("custom");
  }, [trainDraft.value]);
  const cat = catalog.value;
  return (
    <div class="ml-train">
      <MaxJobs />
      <div class="ml-train-top">
        <div class="seg ml-mode">
          <button class={mode === "quick" ? "on" : ""} onClick={() => setMode("quick")}>
            <Sparkles size={14} /> Quick
          </button>
          <button class={mode === "custom" ? "on" : ""} onClick={() => setMode("custom")}>
            <SlidersHorizontal size={14} /> Custom
          </button>
        </div>
        <span class="ml-note">
          <Info size={14} />
          <span>
            Training gathers historical radar volumes, MRMS, METARs and model analyses around past events, so it can take <b>hours</b>. It runs in the background: close this window or keep working, and follow it under <a onClick={() => (mlTab.value = "jobs")}>Jobs</a>. There is no time limit unless you set one; you can stop early and keep the best model so far.
          </span>
        </span>
      </div>
      {!cat && <div class={catalogErr.value ? "ml-err" : "ml-empty"}>{catalogErr.value || "Loading the training catalog…"}{catalogErr.value && <button class="btn sm ghost" onClick={() => loadCatalog(true)}>Retry</button>}</div>}
      {cat && mode === "quick" && <Quick cat={cat} />}
      {cat && mode === "custom" && <Custom cat={cat} />}
    </div>
  );
}

function TimeLimit({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const known = TIME_LIMITS.some(([k]) => k === String(value ?? ""));
  const [custom, setCustom] = useState(!known);
  return (
    <span class="ml-tl">
      <select
        value={custom ? "c" : String(value ?? "")}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === "c") return setCustom(true);
          setCustom(false);
          onChange(v ? +v : null);
        }}
      >
        {TIME_LIMITS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      {custom && (
        <>
          <input type="number" min={5} step={5} value={value ?? 90} onChange={(e) => onChange(Math.max(5, +(e.target as HTMLInputElement).value))} />
          <span class="muted">min</span>
        </>
      )}
    </span>
  );
}

function useWhere(): [Ep, (e: Ep) => void] {
  const w = mlPrefs().trainWhere === "local" && canLocal() ? "local" : "main";
  return [w, (e: Ep) => update((s) => (s.ml = { ...(s.ml ?? {}), trainWhere: e }))];
}

/** models 0.8: presets grouped by family; intensity from the preset (or its id / name suffix) */
const INT_RE = /[\s_·:-]*(quick|medium|thorough|intensive)\s*$/i;
export interface Family {
  key: string;
  name: string;
  target: string;
  presets: Preset[];
}
export function presetFamilies(presets: Preset[]): Family[] {
  const out = new Map<string, Family>();
  for (const p of presets) {
    const int = (p.intensity ? String(p.intensity) : p.id.match(INT_RE)?.[1] ?? p.name.match(INT_RE)?.[1] ?? "").toLowerCase();
    const key = p.family ?? (int ? p.id.replace(INT_RE, "") : p.id);
    const name = p.family_name ?? (int ? p.name.replace(INT_RE, "") : p.name);
    if (!out.has(key)) out.set(key, { key, name, target: p.target, presets: [] });
    out.get(key)!.presets.push({ ...p, intensity: int || undefined });
  }
  return [...out.values()];
}
const INT_ORDER = (i?: string) => INTENSITIES.findIndex(([k]) => k === i);

function Quick({ cat }: { cat: Catalog }) {
  const presets = cat.presets;
  const fams = useMemo(() => presetFamilies(presets), [presets]);
  const [sel, setSel] = useState<Preset | null>(() => {
    const f = fams[0];
    return f ? f.presets.find((p) => p.intensity === "medium") ?? f.presets[0] : null;
  });
  const [name, setName] = useState("");
  const [limit, setLimit] = useState<number | null>(null);
  const [where, setWhere] = useWhere();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Resources | undefined>(undefined);
  const [showRes, setShowRes] = useState(false);
  const fam = sel ? fams.find((f) => f.presets.some((p) => p.id === sel.id)) : undefined;
  const autoName = sel ? `${(fam?.name ?? sel.name).replace(/\s*\(.*\)$/, "")}${sel.intensity ? ` · ${sel.intensity}` : ""} · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "";
  if (!presets.length) return <div class="ml-empty">The server offers no presets — use Custom.</div>;
  return (
    <div class="ml-quick">
      <div class="ml-presets m8-fams">
        {fams.map((f) => {
          const cur = f.presets.find((p) => p.id === sel?.id);
          const shown = cur ?? f.presets.find((p) => p.intensity === "medium") ?? f.presets[0];
          const est = shown.est_min ?? estimateMin(shown.spec ?? {});
          const td = cat.targets.find((t) => t.id === f.target);
          const o = outputOf(f.target, td?.output);
          const ints = [...f.presets].sort((a, b) => INT_ORDER(a.intensity) - INT_ORDER(b.intensity));
          const hasInts = ints.some((p) => p.intensity);
          return (
            <div key={f.key} class={`ml-preset m8-fam ${cur ? "on" : ""}`} style={{ "--tc": tmeta(f.target).color }} onClick={() => !cur && setSel(shown)}>
              <div class="m8-fam-top">
                <TIcon t={f.target} size={34} />
                <div>
                  <b>{f.name}</b>
                  <span>{shown.description ?? td?.description ?? tmeta(f.target).name}</span>
                  <small>
                    ≈ {fmtDur(est * 60)}
                    {shown.spec?.years ? ` · ${shown.spec.years[0]}–${shown.spec.years[1]}` : ""}
                    {shown.spec?.max_events ? ` · ${shown.spec.max_events.toLocaleString()} events` : ""}
                  </small>
                  {o !== "detections" && <em class="ml-out">{o === "grid" ? "→ weather layer" : "→ outlook"}</em>}
                  {(td?.non_us || td?.regions?.some((r) => !/^(us|conus)$/i.test(r))) && (
                    <em class="m8-cov">
                      <Globe2 size={10} /> outside the US too
                    </em>
                  )}
                </div>
              </div>
              <div class="m8-ints">
                {hasInts ? (
                  INTENSITIES.map(([k, l]) => {
                    const p = ints.find((x) => x.intensity === k);
                    return (
                      <button key={k} class={`m8-intb ${k} ${p && sel?.id === p.id ? "on" : ""}`} disabled={!p} title={p ? `${p.name} · ≈ ${fmtDur((p.est_min ?? estimateMin(p.spec ?? {})) * 60)}${p.spec?.max_events ? ` · ${p.spec.max_events} events` : ""}` : "Not offered for this model"} onClick={(e) => (e.stopPropagation(), p && setSel(p))}>
                        {l}
                      </button>
                    );
                  })
                ) : (
                  <button class={`m8-intb ${cur ? "on" : ""}`} onClick={(e) => (e.stopPropagation(), setSel(shown))}>
                    Select
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div class="ml-quick-go">
        <Field label="Name">
          <input value={name} placeholder={autoName} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Where" help="Server: trains on the main server (keeps going when this app is closed). This computer: uses the server built into the app — keep the app open.">
          <WhereToggle value={where} onChange={setWhere} />
        </Field>
        <Field label="Time limit" help="Stop after this long and keep the best model so far. No limit = train until done.">
          <TimeLimit value={limit} onChange={setLimit} />
        </Field>
        <Field label="Resources" help="CPU threads, memory and download / disk concurrency for this job (Auto = the server decides)">
          <button class={`btn sm ghost ${showRes ? "on" : ""}`} onClick={(e) => (e.preventDefault(), setShowRes(!showRes))}>
            <Cpu size={13} /> {res ? `${res.cpu_threads ?? "auto"} threads · ${res.ram_mb ? `${Math.round(res.ram_mb / 1024)} GB` : "auto"}` : "Auto"}
          </button>
        </Field>
        <button
          class="btn ml-start"
          disabled={!sel || busy}
          onClick={async () => {
            if (!sel) return;
            setBusy(true);
            const id = await startTraining(where, { preset: sel.id, name: name.trim() || autoName, time_limit_min: limit, ...(res ? { resources: res } : {}) } as any);
            setBusy(false);
            if (id) mlTab.value = "jobs";
          }}
        >
          <Rocket size={15} /> Start training
        </button>
      </div>
      {showRes && <ResourcesEditor cat={cat} value={res} onChange={setRes} />}
    </div>
  );
}

function ParamInput({ p, value, onChange }: { p: ParamDef; value: any; onChange: (v: any) => void }) {
  const v = value ?? p.default;
  if (p.type === "bool") return <input type="checkbox" checked={!!v} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />;
  if (p.type === "choice" || p.options?.length)
    return (
      <select value={String(v)} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        {(p.options ?? []).map((o) => {
          const [k, l] = typeof o === "string" ? [o, o] : Array.isArray(o) ? o : [o.id, o.name];
          return (
            <option key={k} value={k}>
              {l}
            </option>
          );
        })}
      </select>
    );
  if (p.type === "string") return <input value={v ?? ""} onChange={(e) => onChange((e.target as HTMLInputElement).value)} />;
  const step = p.step ?? (p.type === "int" ? 1 : Math.abs(+(p.default ?? 1)) < 1 ? 0.01 : 0.1);
  return <input type="number" min={p.min} max={p.max} step={step} value={v} onChange={(e) => onChange(p.type === "int" ? Math.round(+(e.target as HTMLInputElement).value) : +(e.target as HTMLInputElement).value)} />;
}

function FilterInput({ f, value, onChange }: { f: FilterDef; value: any; onChange: (v: any) => void }) {
  const v = value ?? f.default;
  if (f.type === "bool")
    return (
      <label class="ml-check">
        <input type="checkbox" checked={!!v} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} /> {f.name}
      </label>
    );
  if (f.type === "multi") {
    const arr: string[] = Array.isArray(v) ? v : [];
    return (
      <Field label={f.name} help={f.help}>
        <div class="ml-chips">
          {(f.options ?? []).map(([k, l]) => (
            <button key={k} class={`chip ${arr.includes(k) ? "on" : ""}`} onClick={(e) => (e.preventDefault(), onChange(arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]))}>
              {l}
            </button>
          ))}
        </div>
      </Field>
    );
  }
  return (
    <Field label={`${f.name}${f.unit ? ` (${f.unit})` : ""}`} help={f.help}>
      {f.type === "choice" ? (
        <select value={String(v)} onChange={(e) => {
          const x = (e.target as HTMLSelectElement).value;
          onChange(/^-?\d+(\.\d+)?$/.test(x) ? +x : x);
        }}>
          {(f.options ?? []).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      ) : (
        <input type="number" min={f.min} max={f.max} step={f.step ?? 1} value={v} onChange={(e) => onChange(+(e.target as HTMLInputElement).value)} />
      )}
    </Field>
  );
}

/** models 0.7: sub-targets (outlook hazard, storm threshold, tropical window) are target_params:
 *  outlook → hazard; storm_forecast → dbz / truth "glm"; tropical_forecast → lead_days */
function subOn(target: string, id: string, tp: Record<string, any>): boolean {
  if (target === "outlook") return String(tp.hazard ?? "any") === id;
  if (target === "storm_forecast") return id === "glm" ? tp.truth === "glm" : tp.truth !== "glm" && +tp.dbz === +id;
  if (target === "tropical_forecast") return (Array.isArray(tp.lead_days) ? tp.lead_days : []).map(Number).includes(+id);
  return tp.subtarget === id;
}
function subSet(target: string, id: string, tp: Record<string, any>): Record<string, any> {
  if (target === "outlook") return { ...tp, hazard: id };
  if (target === "storm_forecast") return id === "glm" ? { ...tp, truth: "glm" } : { ...tp, truth: "cref", dbz: +id };
  if (target === "tropical_forecast") {
    const cur: number[] = (Array.isArray(tp.lead_days) ? tp.lead_days : []).map(Number);
    const next = cur.includes(+id) ? cur.filter((x) => x !== +id) : [...cur, +id].sort((a, b) => a - b);
    return { ...tp, lead_days: next.length ? next : cur };
  }
  return { ...tp, subtarget: id };
}
/** models 0.7: task, sub-target and the target's own params (catalog targets[].params, incl. leads) */
function TargetExtras({ cat, s, set }: { cat: Catalog; s: TrainSpec; set: (p: Partial<TrainSpec>) => void }) {
  const t = cat.targets.find((x) => x.id === s.target);
  if (!t) return null;
  const subs = (t.subtargets ?? []).map((x) => (typeof x === "string" ? { id: x, name: x.replace(/_/g, " ") } : x));
  const tp = s.target_params ?? {};
  // the outlook's hazard chips are its `hazard` choice param: don't show it twice
  const params = (t.params ?? []).filter((p) => !(s.target === "outlook" && p.id === "hazard" && subs.length));
  const tasks = (t.tasks ?? []).filter((x) => x === "classification" || x === "regression");
  if (!subs.length && !params.length && tasks.length < 2) return null;
  return (
    <div class="ml-grid ml-tx">
      {tasks.length > 1 && (
        <Field label="Task" help="Classification predicts a probability (e.g. P(≥ 40 dBZ)); regression predicts the value itself (e.g. max reflectivity in dBZ)">
          <div class="seg">
            {tasks.map((k) => (
              <button key={k} class={(s.task ?? t.task) === k ? "on" : ""} onClick={(e) => (e.preventDefault(), set({ task: k }))}>
                {k === "regression" ? "Value" : "Probability"}
              </button>
            ))}
          </div>
        </Field>
      )}
      {subs.length > 0 && !(s.target === "storm_forecast" && s.task === "regression") && (
        <Field label={t.output === "outlook" ? "Hazard" : s.target === "tropical_forecast" ? "Formation within" : "Predict"} wide>
          <div class="ml-chips">
            {subs.map((x) => (
              <button key={x.id} class={`chip ${subOn(s.target, x.id, tp) ? "on" : ""}`} title={(x as any).help} onClick={(e) => (e.preventDefault(), set({ target_params: subSet(s.target, x.id, tp) }))}>
                {x.name}
              </button>
            ))}
          </div>
        </Field>
      )}
      {params.map((p) => (
        <Field key={p.id} label={`${p.name}${p.unit ? ` (${p.unit})` : ""}`} help={p.help} wide={p.type === "multi" || p.type.endsWith("_list") || (optChoices(p).length > 4 && p.type !== "choice")}>
          <OptInput key={`${s.target}|${p.id}|${JSON.stringify(tp[p.id])}`} p={p} value={tp[p.id]} onChange={(v) => set({ target_params: { ...tp, [p.id]: v } })} />
        </Field>
      ))}
    </div>
  );
}

function Checks({ all, sel, onChange, cols = 3 }: { all: [string, string][]; sel: string[]; onChange: (v: string[]) => void; cols?: number }) {
  return (
    <div class="ml-checks" style={{ "--cols": String(cols) }}>
      {all.map(([k, l]) => (
        <label key={k} class="ml-check">
          <input type="checkbox" checked={sel.includes(k)} onChange={(e) => onChange((e.target as HTMLInputElement).checked ? [...sel, k] : sel.filter((x) => x !== k))} />
          <span title={`${l} (${k})`}>{l}</span>
        </label>
      ))}
    </div>
  );
}

/** forecast field available from the chosen NWP model (catalog fcst_vars[].gfs / .hrrr) */
function fcAvail(cat: Catalog, id: string, model: string): boolean {
  const v: any = srcList(cat.sources?.fcst_vars, []).find((x) => typeof x !== "string" && x.id === id);
  if (!v || typeof v === "string") return true;
  if (model === "hrrr") return v.hrrr !== false;
  if (model === "gfs") return v.gfs !== false;
  return v.gfs !== false || v.hrrr !== false;
}
const AGG: Record<string, string> = { at: "at the lead", max: "window max", min: "window min", mean: "window mean", sum: "window total", tend: "tendency" };
function FcstSources({ cat, s, set }: { cat: Catalog; s: TrainSpec; set: (p: Partial<TrainSpec>) => void }) {
  const models: string[] = Array.isArray(cat.sources?.fcst_models) ? cat.sources!.fcst_models : ["gfs", "hrrr", "auto"];
  const fm = s.sources.fcst_model || "gfs";
  const all = srcList(cat.sources?.fcst_vars, []).filter((x) => typeof x === "string" || fcAvail(cat, x.id, fm));
  const MN: Record<string, string> = { gfs: "GFS", hrrr: "HRRR (≤ 18 h)", auto: "Auto (HRRR ≤ 18 h, else GFS)" };
  return (
    <div class="ml-fcst">
      <span class="ml-flabel">
        Forecast window (NWP) <Help text="Model forecast fields valid over the target's window (MOS-like): the value at the lead, or the window's max / min / mean / total. Needed by temperature, precipitation, storm, tropical and outlook models." />
      </span>
      <div class="ml-fcst-opts">
        <select value={fm} onChange={(e) => set({ sources: { ...s.sources, fcst_model: (e.target as HTMLSelectElement).value } })} title="Forecast model">
          {models.map((m) => (
            <option key={m} value={m}>
              {MN[m] ?? m}
            </option>
          ))}
        </select>
        <label class="muted small" style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexDirection: "row" }} title="Forecast-hour step when summarising a window (0 = automatic)">
          step <input type="number" min={0} max={48} step={1} value={s.sources.fcst_step_h ?? 0} onChange={(e) => set({ sources: { ...s.sources, fcst_step_h: Math.max(0, Math.round(+(e.target as HTMLInputElement).value)) } })} style={{ width: "52px" }} /> h
        </label>
      </div>
      <Checks
        all={all.map((x) => {
          const [k, l] = opt(x as any);
          const agg = typeof x === "string" ? "" : AGG[(x as any).agg] ?? (x as any).agg ?? "";
          return [k, agg ? `${l} · ${agg}` : l] as [string, string];
        })}
        sel={s.sources.fcst ?? []}
        onChange={(v) => set({ sources: { ...s.sources, fcst: v, fcst_model: v.length ? fm : s.sources.fcst_model } })}
        cols={2}
      />
    </div>
  );
}

function Custom({ cat }: { cat: Catalog }) {
  const draft = trainDraft.value;
  const [s, setS] = useState<TrainSpec>(() => {
    const d = defaults(cat, draft?.target ?? cat.targets[0]?.id ?? "tornado", draft ?? undefined);
    return draft ? ({ ...d, ...draft, label_source: asList(draft.label_source).length ? asList(draft.label_source) : d.label_source, match: { ...d.match, ...(draft.match ?? {}) }, sources: { ...d.sources, ...(draft.sources ?? {}) }, region: draft.region ?? {}, filters: { ...d.filters, ...(draft.filters ?? {}) } } as TrainSpec) : d;
  });
  useEffect(() => () => void (trainDraft.value = null), []);
  const [where, setWhere] = useWhere();
  const [busy, setBusy] = useState(false);
  // models 0.7: retraining an existing model (opened from the model's "Retrain…")
  const [rt] = useState<{ ep: Ep; id: string; name: string; version?: number } | null>(() => (draft as any)?.__retrain ?? null);
  const [rtMode, setRtMode] = useState<RetrainMode>("replace");
  const set = (p: Partial<TrainSpec>) => setS((x) => ({ ...x, ...p }));
  const tdef = cat.targets.find((t) => t.id === s.target);
  const cand = cat.candidates.find((c) => c.id === s.candidate);
  const lsrcs = cat.label_sources.filter((l) => !l.targets?.length || l.targets.includes(s.target));
  const lsSel = cat.label_sources.filter((l) => s.label_source.includes(l.id));
  const algo = cat.algos.find((a) => a.id === s.algo);
  const filters = tdef?.filters ?? FILTERS[s.target] ?? [];
  const groups = useMemo(() => {
    const g = new Map<string, { id: string; name: string; unit?: string }[]>();
    for (const f of cand?.features ?? []) {
      const k = f.group || "Other";
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(f);
    }
    return [...g.entries()];
  }, [cand]);
  const allFeat = !s.features;
  const fsel = new Set(s.features ?? []);
  const yrs: [number, number] = lsSel.length ? [Math.max(...lsSel.map((l) => l.years[0])), Math.max(...lsSel.map((l) => l.years[1]))] : [1990, new Date().getFullYear()];
  const est = estimateMin(s);
  const pickRegion = async () => {
    const b = await pickBox();
    if (b) set({ region: { ...s.region, bbox: b } });
  };
  return (
    <div class="ml-custom">
      <div class="ml-form">
        <section>
          {rt && (
            <div class="ml-rt-banner">
              <b>Retraining “{rt.name}”</b> <small class="muted">v{rt.version ?? 1} → v{(rt.version ?? 1) + 1}</small>
              <span class="muted small">Every setting below can change (sources, features, algorithm…). The job runs where the model is.</span>
              <ModeSwitch value={rtMode} onChange={setRtMode} name={rt.name} />
            </div>
          )}
          <h4>1 · What to detect / forecast</h4>
          <div class="ml-grid">
            <Field label="Name" wide>
              <input value={s.name} placeholder={`${tmeta(s.target).name} model`} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
            </Field>
            <Field label="Target" help={tdef?.description}>
              <div class="ml-tsel">
                <TIcon t={s.target} size={20} />
                <select
                  value={s.target}
                  onChange={(e) => {
                    const t = (e.target as HTMLSelectElement).value;
                    setS((x) => ({ ...defaults(cat, t), name: x.name, algo: x.algo, params: x.params, cv_folds: x.cv_folds, time_limit_min: x.time_limit_min }));
                  }}
                >
                  {cat.targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label="Candidates" help="What the model scores: radar cells (storm objects tracked on each radar volume) or points on a regular grid (tropical genesis, wildfire).">
              <select value={s.candidate} onChange={(e) => set({ candidate: (e.target as HTMLSelectElement).value, features: undefined })}>
                {cat.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Events (labels) from" wide help="Where the historical 'yes' cases come from: storm reports, warnings, best tracks, satellite fires… Pick one or more.">
              <div class="ml-chips">
                {lsrcs.map((l) => {
                  const on = s.label_source.includes(l.id);
                  return (
                    <button key={l.id} class={`chip ${on ? "on" : ""}`} title={`${l.name} (${l.years[0]}–${l.years[1]})`} onClick={(e) => (e.preventDefault(), set({ label_source: on ? s.label_source.filter((x) => x !== l.id) : [...s.label_source, l.id] }))}>
                      {l.name.replace(/\s*\(.*\)$/, "")}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Years">
              <span class="ml-range">
                <input type="number" min={yrs[0]} max={yrs[1]} value={s.years[0]} onChange={(e) => set({ years: [Math.max(yrs[0], Math.min(+(e.target as HTMLInputElement).value, s.years[1])), s.years[1]] })} />
                –
                <input type="number" min={yrs[0]} max={yrs[1]} value={s.years[1]} onChange={(e) => set({ years: [s.years[0], Math.min(yrs[1], Math.max(+(e.target as HTMLInputElement).value, s.years[0]))] })} />
              </span>
            </Field>
            {filters.map((f) => (
              <FilterInput key={f.id} f={f} value={s.filters[f.id]} onChange={(v) => set({ filters: { ...s.filters, [f.id]: v } })} />
            ))}
          </div>
          {/* models 0.7: what the model produces, sub-targets, leads and the target's own parameters */}
          <TargetExtras cat={cat} s={s} set={set} />
        </section>

        <section>
          <h4>2 · Region</h4>
          <div class="ml-region">
            <div class="ml-chips">
              <button class={`chip ${!s.region.states?.length ? "on" : ""}`} onClick={() => set({ region: { ...s.region, states: [] } })}>
                All US
              </button>
              <button class="chip" onClick={() => set({ region: { ...s.region, states: PLAINS } })}>
                Plains
              </button>
              <button class="chip" onClick={() => set({ region: { ...s.region, states: DIXIE } })}>
                Dixie Alley
              </button>
              <span class="ml-sep" />
              {s.region.bbox ? (
                <span class="chip on">
                  Box {s.region.bbox.map((v) => v.toFixed(1)).join(", ")}
                  <button class="ml-x" title="Remove the box" onClick={() => set({ region: { ...s.region, bbox: undefined } })}>
                    <X size={11} />
                  </button>
                </span>
              ) : null}
              <button class="chip" onClick={pickRegion}>
                <SquareDashed size={12} /> Draw box on map
              </button>
              {/* models 0.8: targets the server can train outside the US */}
              {(tdef?.non_us || tdef?.regions?.some((r) => !/^(us|conus)$/i.test(r))) && (
                <button
                  class={`chip ${(s.region as any).outside_us ? "on" : ""}`}
                  title={`Train on a region outside the US (${(tdef?.regions ?? ["global"]).filter((r) => !/^(us|conus)$/i.test(r)).join(", ")}): draw its box on the map`}
                  onClick={async () => {
                    const b = await pickBox();
                    if (b) set({ region: { bbox: b, states: [], outside_us: true } as any });
                  }}
                >
                  <Globe2 size={12} /> Outside the US…
                </button>
              )}
            </div>
            {(s.region as any).outside_us && <small class="muted m8-nonus">Outside the US: labels and inputs come from global sources (fewer reports, coarser data) — the model shows its coverage and confidence.</small>}
            <div class="ml-states">
              {STATES.map((st) => {
                const on = s.region.states?.includes(st);
                return (
                  <button key={st} class={on ? "on" : ""} onClick={() => set({ region: { ...s.region, states: on ? s.region.states!.filter((x) => x !== st) : [...(s.region.states ?? []), st] } })}>
                    {st}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section>
          <h4>3 · Samples</h4>
          <div class="ml-grid">
            <Field label="Max events" help="Historical events to sample (more = better model, longer training)">
              <input type="number" min={10} max={100000} step={50} value={s.max_events} onChange={(e) => set({ max_events: +(e.target as HTMLInputElement).value })} />
            </Field>
            <Field label="Negatives per event" help="Non-event cells/points sampled for each event (near the event in space and time: the hard cases)">
              <input type="number" min={0.5} max={50} step={0.5} value={s.neg_ratio} onChange={(e) => set({ neg_ratio: +(e.target as HTMLInputElement).value })} />
            </Field>
            <Field label="Null days" help="Extra quiet days with storms but no events, to teach the model what 'nothing happened' looks like">
              <input type="number" min={0} max={1000} value={s.null_days} onChange={(e) => set({ null_days: +(e.target as HTMLInputElement).value })} />
            </Field>
            <Field label="Match radius (km)" help="A cell within this distance of a report counts as the event">
              <input type="number" min={1} max={500} value={s.match.radius_km} onChange={(e) => set({ match: { ...s.match, radius_km: +(e.target as HTMLInputElement).value } })} />
            </Field>
            <Field label="Lead before (min)" help="Scans up to this long BEFORE the event are labelled positive (lets the model warn early)">
              <input type="number" min={0} max={360} step={5} value={s.match.before_min} onChange={(e) => set({ match: { ...s.match, before_min: +(e.target as HTMLInputElement).value } })} />
            </Field>
            <Field label="Max samples" help="Stratified cap on the training samples (0 = no cap); grid targets sample many points per case">
              <input type="number" min={0} max={5000000} step={5000} value={s.max_samples ?? 0} onChange={(e) => set({ max_samples: Math.max(0, Math.round(+(e.target as HTMLInputElement).value)) })} />
            </Field>
            <Field label="After (min)">
              <input type="number" min={0} max={360} step={5} value={s.match.after_min} onChange={(e) => set({ match: { ...s.match, after_min: +(e.target as HTMLInputElement).value } })} />
            </Field>
          </div>
        </section>

        <section>
          <h4>
            4 · Data sources{" "}
            <button
              class="chip"
              title="Tick every source the server offers (more data per sample; longer gathering)"
              onClick={(e) => {
                e.preventDefault();
                const c = cat.sources ?? {};
                set({
                  sources: {
                    radar_products: s.candidate === "grid_point" ? s.sources.radar_products : (cat.radar_products ?? DEF_RADAR).map((x) => opt(x)[0]),
                    mrms: (cat.mrms ?? DEF_MRMS).map((x) => opt(x)[0]),
                    model: (cat.model_fields ?? DEF_MODEL).map((x) => opt(x)[0]),
                    metar: true,
                    satellite: ids2(srcList(c.satellite, DEF_SAT)),
                    other: ids2(srcList(c.other, DEF_OTHER)),
                    hrrr: ids2(srcList(c.hrrr_vars, [])),
                    fcst: ids2(srcList(c.fcst_vars, [])).filter((id) => fcAvail(cat, id, s.sources.fcst_model || "gfs")),
                    fcst_model: s.sources.fcst_model || "gfs",
                    fcst_step_h: s.sources.fcst_step_h ?? 0,
                  },
                });
              }}
            >
              Use every source
            </button>
          </h4>
          <div class="ml-src">
            <div>
              <span class="ml-flabel">NEXRAD / TDWR products</span>
              <Checks all={(cat.radar_products ?? DEF_RADAR).map(opt)} sel={s.sources.radar_products} onChange={(v) => set({ sources: { ...s.sources, radar_products: v } })} cols={2} />
            </div>
            <div>
              <span class="ml-flabel">MRMS</span>
              <Checks all={(cat.mrms ?? DEF_MRMS).map(opt)} sel={s.sources.mrms} onChange={(v) => set({ sources: { ...s.sources, mrms: v } })} cols={2} />
            </div>
            <div>
              <span class="ml-flabel">Model analysis (GFS)</span>
              <Checks all={(cat.model_fields ?? DEF_MODEL).map(opt)} sel={s.sources.model} onChange={(v) => set({ sources: { ...s.sources, model: v } })} cols={2} />
              <label class="ml-check ml-metar">
                <input type="checkbox" checked={s.sources.metar} onChange={(e) => set({ sources: { ...s.sources, metar: (e.target as HTMLInputElement).checked } })} /> Nearby METARs (surface obs)
              </label>
            </div>
            {/* models 0.7: HRRR analyses and NWP forecast fields over the target window */}
            {!!srcList(cat.sources?.hrrr_vars, []).length && (
              <div>
                <span class="ml-flabel">
                  HRRR analysis <Help text="3 km HRRR analysis fields at the case time (CONUS, 2014+). Cell and grid models." />
                </span>
                <Checks all={srcList(cat.sources?.hrrr_vars, []).map((x) => opt(x as any))} sel={s.sources.hrrr ?? []} onChange={(v) => set({ sources: { ...s.sources, hrrr: v } })} cols={2} />
              </div>
            )}
            {!!srcList(cat.sources?.fcst_vars, []).length && (
              <FcstSources cat={cat} s={s} set={set} />
            )}
            {/* models 0.7: satellite (GOES ABI bands, cooling rate, GLM) and every other source group */}
            <div>
              <span class="ml-flabel">
                Satellite <Help text="GOES-East/West ABI bands, derived cloud-top cooling / overshooting tops, and GLM lightning, sampled around each case (archive on AWS)." />
              </span>
              {groupsOf(srcList(cat.sources?.satellite, DEF_SAT)).map(([g, all]) => (
                <div key={g} class="ml-srcg">
                  {g && <small class="muted">{g}</small>}
                  <Checks all={all} sel={s.sources.satellite ?? []} onChange={(v) => set({ sources: { ...s.sources, satellite: [...(s.sources.satellite ?? []).filter((x) => !all.some(([k]) => k === x)), ...v] } })} cols={1} />
                </div>
              ))}
            </div>
            <div>
              <span class="ml-flabel">Other sources</span>
              {groupsOf(srcList(cat.sources?.other, DEF_OTHER)).map(([g, all]) => (
                <div key={g} class="ml-srcg">
                  {g && <small class="muted">{g}</small>}
                  <Checks all={all} sel={s.sources.other ?? []} onChange={(v) => set({ sources: { ...s.sources, other: [...(s.sources.other ?? []).filter((x) => !all.some(([k]) => k === x)), ...v] } })} cols={1} />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <h4>
            5 · Features <small class="muted">{allFeat ? `all ${cand?.features.length ?? ""}` : `${fsel.size} of ${cand?.features.length ?? 0}`}</small>
          </h4>
          <label class="ml-check">
            <input type="checkbox" checked={allFeat} onChange={(e) => set({ features: (e.target as HTMLInputElement).checked ? undefined : (cand?.features ?? []).map((f) => f.id) })} /> Use all features (recommended)
          </label>
          {!allFeat && (
            <div class="ml-feats">
              {groups.map(([g, fs]) => {
                const n = fs.filter((f) => fsel.has(f.id)).length;
                return (
                  <div key={g} class="ml-fgroup">
                    <label class="ml-check ml-fg-head">
                      <input
                        type="checkbox"
                        checked={n === fs.length}
                        ref={(el) => void (el && (el.indeterminate = n > 0 && n < fs.length))}
                        onChange={(e) => {
                          const on = (e.target as HTMLInputElement).checked;
                          const next = new Set(fsel);
                          for (const f of fs) on ? next.add(f.id) : next.delete(f.id);
                          set({ features: [...next] });
                        }}
                      />
                      <b>{g}</b> <small class="muted">{n}/{fs.length}</small>
                    </label>
                    {fs.map((f) => (
                      <label key={f.id} class="ml-check">
                        <input
                          type="checkbox"
                          checked={fsel.has(f.id)}
                          onChange={(e) => {
                            const next = new Set(fsel);
                            (e.target as HTMLInputElement).checked ? next.add(f.id) : next.delete(f.id);
                            set({ features: [...next] });
                          }}
                        />
                        {f.name}
                        {f.unit && <small class="muted"> {f.unit}</small>}
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <h4>6 · Algorithm</h4>
          <div class="ml-grid">
            <Field label="Algorithm" help={algo?.help}>
              <select
                value={s.algo}
                onChange={(e) => {
                  const a = cat.algos.find((x) => x.id === (e.target as HTMLSelectElement).value);
                  set({ algo: a?.id ?? "", params: Object.fromEntries((a?.params ?? []).map((p) => [p.id, p.default])) });
                }}
              >
                {cat.algos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            {(algo?.params ?? []).map((p) => (
              <Field key={p.id} label={p.name} help={p.help}>
                <ParamInput p={p} value={s.params[p.id]} onChange={(v) => set({ params: { ...s.params, [p.id]: v } })} />
              </Field>
            ))}
            <Field label="CV folds" help="0 = one held-out set; 2–10 = cross-validation folds, split by event day so the score reflects unseen storms">
              <input type="number" min={0} max={10} value={s.cv_folds} onChange={(e) => set({ cv_folds: +(e.target as HTMLInputElement).value })} />
            </Field>
          </div>
        </section>
      </div>
      <aside class="ml-go">
        <div class="ml-go-card">
          <div class="ml-go-head">
            <TIcon t={s.target} size={30} />
            <div>
              <b>{s.name || `${tmeta(s.target).name} model`}</b>
              <small class="muted">
                {s.years[0]}–{s.years[1]} · {s.region.states?.length ? `${s.region.states.length} states` : s.region.bbox ? "box" : "all US"} · up to {s.max_events} events
              </small>
            </div>
          </div>
          {!rt && (
            <Field label="Where">
              <WhereToggle value={where} onChange={setWhere} />
            </Field>
          )}
          {(() => {
            const o = outputOf(s.target, tdef?.output);
            return (
              <div class="ml-go-out muted small">
                {(s.task ?? taskOf(s.target, tdef?.task)) === "regression" ? "Regression (predicts a value)" : "Classification (predicts a probability)"} · when run: {o === "grid" ? "a weather layer (forecast grid)" : o === "outlook" ? "an SPC-style outlook layer" : "detections on the map"}
              </div>
            );
          })()}
          <Field label="Time limit" help="None by default: training runs until it's done. Stop early any time from Jobs.">
            <TimeLimit value={s.time_limit_min ?? null} onChange={(v) => set({ time_limit_min: v })} />
          </Field>
          <div class="m8-res-wrap">
            <span class="ml-flabel">
              <Cpu size={12} /> Resources <Help text="CPU threads, memory and download / disk concurrency for this job (Auto = the server decides)" />
            </span>
            <ResourcesEditor cat={cat} value={(s as any).resources} onChange={(r) => set({ resources: r } as any)} />
          </div>
          <div class="ml-est">
            Rough estimate <b>≈ {fmtDur(est * 60)}</b> <Help text="Depends mostly on how many radar volumes must be downloaded and on the server's CPU. Cached data makes later runs faster." />
          </div>
          <button
            class="btn ml-start"
            disabled={busy || !s.target || !s.label_source.length || (!s.sources.radar_products.length && !s.sources.mrms.length && !s.sources.model.length && !s.sources.metar && !s.sources.satellite?.length && !s.sources.other?.length && !s.sources.hrrr?.length && !s.sources.fcst?.length)}
            onClick={async () => {
              setBusy(true);
              const body: TrainSpec = { ...s, name: s.name.trim() || `${tmeta(s.target).name} model` };
              delete (body as any).__retrain;
              // sub-targets and leads travel in target_params (the server has no `subtarget` / uses grid.lead_hours only for genesis)
              delete (body as any).subtarget;
              if (!body.sources.fcst?.length) body.sources = { ...body.sources, fcst_model: "" };
              if (!body.max_samples) delete body.max_samples;
              let id: string | null = null;
              if (rt) {
                delete (body as any).preset; // the model's spec already holds what the preset gave
                const m = models.value.find((x) => x.ep === rt.ep && x.id === rt.id);
                id = m ? await retrainModel(m, body, rtMode) : null;
              } else id = await startTraining(where, body);
              setBusy(false);
              if (id) mlTab.value = "jobs";
            }}
          >
            <Rocket size={15} /> {rt ? (rtMode === "replace" ? "Retrain (replace)" : "Retrain as new model") : "Start training"}
          </button>
          <small class="muted">Runs in the background. You can close this window.</small>
        </div>
      </aside>
    </div>
  );
}
