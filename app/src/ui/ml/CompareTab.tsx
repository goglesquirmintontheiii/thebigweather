// models 0.8 (Phase 8): ensembles (a virtual model combining selected models) and A/B comparisons
// (score 2+ models on the same historical events → scorecards, charts and per-event outcomes).

import { useEffect, useMemo, useState } from "preact/hooks";
import { Combine, Scale, Play, Check, X, Trophy } from "lucide-preact";
import { models, loadModels, mkey, selModel, mlTab, localIsMain } from "../../ml/client";
import { createEnsemble, ENS_METHODS, startCompare, compareRes, type Scorecard, type CompareResult } from "../../ml/m8";
import { tmeta } from "../../ml/targets";
import type { Ep, Model } from "../../ml/types";
import { TIcon, EpBadge, Field, Help, f2, pct } from "./common";
import { fmtTime } from "../../util";

const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#fb923c"];
const PLAINS = ["TX", "OK", "KS", "NE", "SD", "ND", "CO", "IA", "MO"];
const DIXIE = ["LA", "MS", "AL", "TN", "AR", "GA", "KY"];

export function CompareTab() {
  useEffect(() => {
    loadModels();
  }, []);
  const [sel, setSel] = useState<string[]>([]);
  const all = models.value.filter((m) => !m.training);
  const chosen = sel.map((k) => all.find((m) => mkey(m) === k)).filter(Boolean) as Model[];
  const ep: Ep | undefined = chosen[0]?.ep;
  const target = chosen[0]?.target;
  const toggle = (m: Model) => {
    const k = mkey(m);
    if (sel.includes(k)) return setSel(sel.filter((x) => x !== k));
    // one machine per comparison / ensemble
    setSel([...sel.filter((x) => x.startsWith(`${m.ep}|`)), k]);
  };
  const res = compareRes.value;
  return (
    <div class="m8-cmp">
      <div class="m8-cmp-pick">
        <span class="ml-flabel">
          Models <small class="muted">· pick 2 or more (same machine; same target recommended)</small>
        </span>
        <div class="m8-cmp-list">
          {all.map((m) => {
            const on = sel.includes(mkey(m));
            const other = !!ep && m.ep !== ep;
            const diff = !!target && m.target !== target;
            return (
              <button key={mkey(m)} class={`ml-rm ${on ? "on" : ""} ${other || diff ? "dim" : ""}`} onClick={() => toggle(m)} title={other ? "On the other machine (selecting it starts a new selection)" : diff ? "Different target" : ""}>
                <input type="checkbox" checked={on} tabIndex={-1} />
                <TIcon t={m.target} size={20} />
                <span>
                  <b>{m.name}</b>
                  <small>
                    {tmeta(m.target).name} · AUC {f2(m.metrics?.auc, 3)} · CSI {f2(m.metrics?.csi)}
                    {m.intensity ? ` · ${m.intensity}` : ""}
                  </small>
                </span>
                {m.ep === "local" && !localIsMain.value && <EpBadge ep="local" />}
              </button>
            );
          })}
        </div>
      </div>
      <div class="m8-cmp-forms">
        <EnsembleForm chosen={chosen} />
        <CompareForm chosen={chosen} />
      </div>
      {res && <Scorecards r={res} />}
    </div>
  );
}

function EnsembleForm({ chosen }: { chosen: Model[] }) {
  const [name, setName] = useState("");
  const [method, setMethod] = useState("mean");
  const [w, setW] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const auto = chosen.length ? `${tmeta(chosen[0].target).name} ensemble (${chosen.length})` : "";
  const weights = chosen.map((m) => w[mkey(m)] ?? 1);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return (
    <div class="ml-box m8-ens-form">
      <h4>
        <Combine size={14} /> Ensemble <Help text="A virtual model: it runs its members and combines their probabilities. It appears in Models and runs like any model." />
      </h4>
      <div class="ml-grid">
        <Field label="Name" wide>
          <input value={name} placeholder={auto} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Method" wide>
          <select value={method} onChange={(e) => setMethod((e.target as HTMLSelectElement).value)}>
            {ENS_METHODS.map(([k, l, h]) => (
              <option key={k} value={k} title={h}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <small class="muted">{ENS_METHODS.find(([k]) => k === method)?.[2]}</small>
      {method === "weighted" && chosen.length > 0 && (
        <div class="m8-weights">
          {chosen.map((m, i) => (
            <label key={mkey(m)} class="m8-w">
              <span>{m.name}</span>
              <input type="range" min={0} max={5} step={0.1} value={weights[i]} onInput={(e) => setW({ ...w, [mkey(m)]: +(e.target as HTMLInputElement).value })} />
              <b>{Math.round((weights[i] / sum) * 100)}%</b>
            </label>
          ))}
          <button class="btn xs ghost" onClick={() => setW(Object.fromEntries(chosen.map((m) => [mkey(m), Math.max(0.1, ((m.metrics?.csi ?? 0.3) * 10) | 0 || 1)])))}>
            Weight by CSI
          </button>
        </div>
      )}
      <button
        class="btn"
        disabled={chosen.length < 2 || busy}
        onClick={async () => {
          setBusy(true);
          const m = await createEnsemble(chosen[0].ep, { name: name.trim() || auto, members: chosen.map((m) => m.id), method, ...(method === "weighted" ? { weights: weights.map((x) => +(x / sum).toFixed(4)) } : {}) });
          setBusy(false);
          if (m) {
            selModel.value = mkey(m);
            mlTab.value = "models";
          }
        }}
      >
        <Combine size={14} /> {busy ? "Creating…" : `Create ensemble${chosen.length ? ` of ${chosen.length}` : ""}`}
      </button>
    </div>
  );
}

function CompareForm({ chosen }: { chosen: Model[] }) {
  const y = new Date().getFullYear();
  const [years, setYears] = useState<[number, number]>([y - 1, y - 1]);
  const [states, setStates] = useState<string[]>([]);
  const [maxEv, setMaxEv] = useState(300);
  const [minMag, setMinMag] = useState(0);
  const [busy, setBusy] = useState(false);
  const res = compareRes.value;
  const running = !!res && !["done", "failed", "cancelled"].includes(res.state);
  const isTor = chosen.some((m) => m.target === "tornado" || m.target === "debris");
  return (
    <div class="ml-box m8-ab-form">
      <h4>
        <Scale size={14} /> A/B compare <Help text="Scores every picked model on the same historical events (and the same non-events), so the numbers compare directly." />
      </h4>
      <div class="ml-grid">
        <Field label="Years">
          <span class="ml-range">
            <input type="number" min={1995} max={y} value={years[0]} onChange={(e) => setYears([+(e.target as HTMLInputElement).value, Math.max(years[1], +(e.target as HTMLInputElement).value)])} />–
            <input type="number" min={1995} max={y} value={years[1]} onChange={(e) => setYears([Math.min(years[0], +(e.target as HTMLInputElement).value), +(e.target as HTMLInputElement).value])} />
          </span>
        </Field>
        <Field label="Max events">
          <input type="number" min={10} max={20000} step={50} value={maxEv} onChange={(e) => setMaxEv(Math.max(10, +(e.target as HTMLInputElement).value))} />
        </Field>
        {isTor && (
          <Field label="Rating at least">
            <select value={String(minMag)} onChange={(e) => setMinMag(+(e.target as HTMLSelectElement).value)}>
              {[0, 1, 2, 3, 4].map((v) => (
                <option key={v} value={v}>
                  EF{v}+
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Region" wide>
          <div class="ml-chips">
            <button class={`chip ${!states.length ? "on" : ""}`} onClick={(e) => (e.preventDefault(), setStates([]))}>
              All US
            </button>
            <button class={`chip ${states.join() === PLAINS.join() ? "on" : ""}`} onClick={(e) => (e.preventDefault(), setStates(PLAINS))}>
              Plains
            </button>
            <button class={`chip ${states.join() === DIXIE.join() ? "on" : ""}`} onClick={(e) => (e.preventDefault(), setStates(DIXIE))}>
              Dixie
            </button>
          </div>
        </Field>
      </div>
      <button
        class="btn"
        disabled={chosen.length < 2 || busy || running}
        onClick={async () => {
          setBusy(true);
          await startCompare(chosen[0].ep, chosen.map((m) => m.id), { years, region: states.length ? { states } : {}, max_events: maxEv, ...(isTor && minMag ? { filters: { min_mag: minMag } } : {}) });
          setBusy(false);
        }}
      >
        <Play size={14} /> {running ? "Comparing…" : `Compare ${chosen.length >= 2 ? chosen.length : ""} models`}
      </button>
      {running && (
        <div class="ml-prog">
          <div class="ml-bar live">
            <i style={{ width: `${Math.round(res!.progress * 100)}%` }} />
          </div>
          <span class="ml-prog-pct">{Math.round(res!.progress * 100)}%</span>
        </div>
      )}
      {res?.state === "failed" && <div class="ml-err">{res.error ?? "The comparison failed"}</div>}
    </div>
  );
}

/* ---------- results ---------- */
const METRICS: [keyof Scorecard, string, boolean, (v: any) => string][] = [
  ["auc", "AUC", true, (v) => f2(v, 3)],
  ["csi", "CSI", true, (v) => f2(v)],
  ["pod", "POD", true, (v) => pct(v)],
  ["far", "FAR", false, (v) => pct(v)],
  ["brier", "Brier", false, (v) => f2(v, 3)],
  ["lead_min", "Lead time", true, (v) => (v == null ? "—" : `${Math.round(v)} min`)],
];
function best(sc: Scorecard[], k: keyof Scorecard, hi: boolean) {
  const vs = sc.map((s) => s[k]).filter((v) => typeof v === "number") as number[];
  if (vs.length < 2) return undefined;
  return hi ? Math.max(...vs) : Math.min(...vs);
}
function Scorecards({ r }: { r: CompareResult }) {
  const sc = r.scorecards;
  const [evFilter, setEvFilter] = useState<"all" | "split" | "missed">("all");
  const color = (id: string) => COLORS[Math.max(0, sc.findIndex((s) => s.model_id === id)) % COLORS.length];
  const evs = useMemo(() => {
    if (evFilter === "all") return r.events;
    return r.events.filter((e) => {
      const hits = sc.map((s) => !!e.outcomes[s.model_id]?.hit);
      return evFilter === "split" ? hits.some(Boolean) && !hits.every(Boolean) : !hits.some(Boolean);
    });
  }, [r.events, evFilter, sc.length]);
  if (!sc.length) return r.state === "done" ? <div class="ml-empty">No scores came back.</div> : null;
  const winner = (() => {
    const b = best(sc, "csi", true);
    return b == null ? undefined : sc.find((s) => s.csi === b)?.model_id;
  })();
  return (
    <div class="m8-score">
      <h4>
        Scorecard <small class="muted">{r.events.length ? `${r.events.length} events` : ""}{r.t ? ` · ${fmtTime(r.t, true)}` : ""}</small>
      </h4>
      <div class="m8-cards">
        {sc.map((s) => (
          <div key={s.model_id} class={`m8-card ${s.model_id === winner ? "win" : ""}`} style={{ "--mc": color(s.model_id) }}>
            <div class="m8-card-h">
              <i />
              <b>{s.name}</b>
              {s.model_id === winner && (
                <span class="m8-win">
                  <Trophy size={11} /> best CSI
                </span>
              )}
            </div>
            <div class="m8-card-m">
              {METRICS.map(([k, l, hi, fmt]) => {
                const b = best(sc, k, hi);
                return (
                  <span key={k as string} class={b != null && s[k] === b ? "best" : ""}>
                    <small>{l}</small>
                    {fmt(s[k])}
                  </span>
                );
              })}
            </div>
            <div class="m8-card-c muted small">
              {s.hits ?? "—"} hits · {s.misses ?? "—"} misses · {s.false_alarms ?? "—"} false alarms
            </div>
          </div>
        ))}
      </div>
      <div class="m8-charts">
        <BarChart sc={sc} color={color} />
        <RelChart sc={sc} color={color} />
      </div>
      {r.events.length > 0 && (
        <div class="m8-events">
          <div class="m8-ev-head">
            <span class="ml-flabel">Per-event outcomes</span>
            <div class="seg">
              {(
                [
                  ["all", "All"],
                  ["split", "Models disagree"],
                  ["missed", "Missed by all"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} class={evFilter === k ? "on" : ""} onClick={() => setEvFilter(k)}>
                  {l}
                </button>
              ))}
            </div>
            <small class="muted">{evs.length} shown</small>
          </div>
          <div class="m8-ev-wrap">
            <table class="ml-table m8-ev">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>When</th>
                  {sc.map((s) => (
                    <th key={s.model_id} style={{ color: color(s.model_id) }}>
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evs.slice(0, 300).map((e) => (
                  <tr key={e.id}>
                    <td>{e.desc ?? e.kind ?? e.id}</td>
                    <td>{e.t ? fmtTime(e.t, true) : "—"}</td>
                    {sc.map((s) => {
                      const o = e.outcomes[s.model_id] ?? {};
                      return (
                        <td key={s.model_id} class={o.hit ? "hit" : "miss"}>
                          {o.hit ? <Check size={12} /> : <X size={12} />} {o.prob != null ? `${Math.round(o.prob * (o.prob <= 1 ? 100 : 1))}%` : ""}
                          {o.hit && o.lead_min != null ? <small> +{Math.round(o.lead_min)}′</small> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** grouped bars: one group per metric (0–1 scale), one bar per model */
function BarChart({ sc, color }: { sc: Scorecard[]; color: (id: string) => string }) {
  const ks = METRICS.filter(([k]) => k !== "lead_min" && sc.some((s) => typeof s[k] === "number"));
  const W = 420, H = 190, l = 30, b = 24, t = 10;
  const gw = (W - l - 8) / Math.max(1, ks.length);
  const bw = Math.min(22, (gw - 12) / Math.max(1, sc.length));
  const y = (v: number) => t + (1 - Math.max(0, Math.min(1, v))) * (H - t - b);
  return (
    <div class="ml-box m8-chart">
      <h4>Scores <small class="muted">higher is better except FAR and Brier</small></h4>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={l} x2={W - 4} y1={y(v)} y2={y(v)} class="m8-grid" />
            <text x={l - 4} y={y(v) + 3} class="m8-ax" text-anchor="end">
              {v}
            </text>
          </g>
        ))}
        {ks.map(([k, lab], gi) => (
          <g key={k as string}>
            {sc.map((s, i) => {
              const v = s[k] as number | undefined;
              if (typeof v !== "number") return null;
              const x = l + gi * gw + 6 + i * bw;
              return (
                <rect key={s.model_id} x={x} y={y(v)} width={bw - 2} height={Math.max(0, H - b - y(v))} rx={2} fill={color(s.model_id)}>
                  <title>{`${s.name} · ${lab} ${v.toFixed(3)}`}</title>
                </rect>
              );
            })}
            <text x={l + gi * gw + gw / 2} y={H - 7} class="m8-ax" text-anchor="middle">
              {lab}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** reliability curves per model */
function RelChart({ sc, color }: { sc: Scorecard[]; color: (id: string) => string }) {
  const has = sc.filter((s) => s.reliability?.length);
  const W = 260, H = 190, p = 28;
  const X = (v: number) => p + v * (W - p - 8), Y = (v: number) => 8 + (1 - v) * (H - p - 8);
  return (
    <div class="ml-box m8-chart">
      <h4>Reliability</h4>
      {!has.length ? (
        <div class="muted small">No reliability data</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
          <line x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} class="m8-diag" />
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <text x={X(v)} y={H - 8} class="m8-ax" text-anchor="middle">
                {v}
              </text>
              <text x={p - 4} y={Y(v) + 3} class="m8-ax" text-anchor="end">
                {v}
              </text>
            </g>
          ))}
          {has.map((s) => (
            <polyline key={s.model_id} fill="none" stroke={color(s.model_id)} stroke-width={2} points={s.reliability!.map((b) => `${X(b.p)},${Y(b.obs)}`).join(" ")} />
          ))}
        </svg>
      )}
    </div>
  );
}
