// Detection models → Train: Quick (presets, a few clicks) and Custom (every knob, from the catalog).

import { useEffect, useMemo, useState } from "preact/hooks";
import { Rocket, Sparkles, SlidersHorizontal, SquareDashed, X, Info } from "lucide-preact";
import { catalog, catalogErr, loadCatalog, startTraining, trainDraft, mlTab, mlPrefs, canLocal } from "../../ml/client";
import { tmeta } from "../../ml/targets";
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
    sources: pre
      ? { radar_products: base.sources?.radar_products ?? [], mrms: base.sources?.mrms ?? [], metar: !!base.sources?.metar, model: base.sources?.model ?? [] }
      : {
          radar_products: grid ? [] : ids(cat.radar_products, DEF_RADAR),
          mrms: grid ? [] : ids(cat.mrms, DEF_MRMS).slice(0, 5),
          metar: !grid || id === "wildfire",
          model: grid ? ids(cat.model_fields, DEF_MODEL).slice(0, 12) : [],
        },
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

function Quick({ cat }: { cat: Catalog }) {
  const presets = cat.presets;
  const [sel, setSel] = useState<Preset | null>(presets[0] ?? null);
  const [name, setName] = useState("");
  const [limit, setLimit] = useState<number | null>(null);
  const [where, setWhere] = useWhere();
  const [busy, setBusy] = useState(false);
  const autoName = sel ? `${sel.name.replace(/\s*\(.*\)$/, "")} · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "";
  if (!presets.length) return <div class="ml-empty">The server offers no presets — use Custom.</div>;
  return (
    <div class="ml-quick">
      <div class="ml-presets">
        {presets.map((p) => {
          const est = p.est_min ?? estimateMin(p.spec ?? {});
          return (
            <button key={p.id} class={`ml-preset ${sel?.id === p.id ? "on" : ""}`} style={{ "--tc": tmeta(p.target).color }} onClick={() => setSel(p)}>
              <TIcon t={p.target} size={34} />
              <div>
                <b>{p.name}</b>
                <span>{p.description ?? cat.targets.find((t) => t.id === p.target)?.description ?? tmeta(p.target).name}</span>
                <small>≈ {fmtDur(est * 60)}{p.spec?.years ? ` · ${p.spec.years[0]}–${p.spec.years[1]}` : ""}{p.spec?.max_events ? ` · ${p.spec.max_events} events` : ""}</small>
              </div>
            </button>
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
        <button
          class="btn ml-start"
          disabled={!sel || busy}
          onClick={async () => {
            if (!sel) return;
            setBusy(true);
            const id = await startTraining(where, { preset: sel.id, name: name.trim() || autoName, time_limit_min: limit });
            setBusy(false);
            if (id) mlTab.value = "jobs";
          }}
        >
          <Rocket size={15} /> Start training
        </button>
      </div>
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

function Custom({ cat }: { cat: Catalog }) {
  const draft = trainDraft.value;
  const [s, setS] = useState<TrainSpec>(() => {
    const d = defaults(cat, draft?.target ?? cat.targets[0]?.id ?? "tornado", draft ?? undefined);
    return draft ? ({ ...d, ...draft, label_source: asList(draft.label_source).length ? asList(draft.label_source) : d.label_source, match: { ...d.match, ...(draft.match ?? {}) }, sources: { ...d.sources, ...(draft.sources ?? {}) }, region: draft.region ?? {}, filters: { ...d.filters, ...(draft.filters ?? {}) } } as TrainSpec) : d;
  });
  useEffect(() => () => void (trainDraft.value = null), []);
  const [where, setWhere] = useWhere();
  const [busy, setBusy] = useState(false);
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
          <h4>1 · What to detect</h4>
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
            </div>
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
            <Field label="After (min)">
              <input type="number" min={0} max={360} step={5} value={s.match.after_min} onChange={(e) => set({ match: { ...s.match, after_min: +(e.target as HTMLInputElement).value } })} />
            </Field>
          </div>
        </section>

        <section>
          <h4>4 · Data sources</h4>
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
          <Field label="Where">
            <WhereToggle value={where} onChange={setWhere} />
          </Field>
          <Field label="Time limit" help="None by default: training runs until it's done. Stop early any time from Jobs.">
            <TimeLimit value={s.time_limit_min ?? null} onChange={(v) => set({ time_limit_min: v })} />
          </Field>
          <div class="ml-est">
            Rough estimate <b>≈ {fmtDur(est * 60)}</b> <Help text="Depends mostly on how many radar volumes must be downloaded and on the server's CPU. Cached data makes later runs faster." />
          </div>
          <button
            class="btn ml-start"
            disabled={busy || !s.target || !s.label_source.length || (!s.sources.radar_products.length && !s.sources.mrms.length && !s.sources.model.length && !s.sources.metar)}
            onClick={async () => {
              setBusy(true);
              const body: TrainSpec = { ...s, name: s.name.trim() || `${tmeta(s.target).name} model` };
              const id = await startTraining(where, body);
              setBusy(false);
              if (id) mlTab.value = "jobs";
            }}
          >
            <Rocket size={15} /> Start training
          </button>
          <small class="muted">Runs in the background. You can close this window.</small>
        </div>
      </aside>
    </div>
  );
}
