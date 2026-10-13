// models 0.7: retrain / train further, and the model's version history.
// "Retrain…" opens the Custom training form prefilled with the model's spec (TrainTab reads
// trainDraft.__retrain and calls POST /api/ml/models/{id}/retrain). "Train further…" is a small
// dialog for POST /api/ml/models/{id}/continue: more events / years / extra trees or epochs /
// learning rate, replacing the model or saving a new one. Both work for imported models and in a
// new session — everything needed is on the server; the job shows up under Jobs.

import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import { History, Layers3, X, Rocket, RotateCcw } from "lucide-preact";
import { continueModel, mlTab, trainDraft, type RetrainMode } from "../../ml/client";
import type { Model } from "../../ml/types";
import { Field, f2, fmtDay } from "./common";

export const continueFor = signal<Model | null>(null);

/** open the Custom form prefilled with the model's spec for a full retrain */
export function openRetrain(m: Model) {
  trainDraft.value = { ...(m.spec ?? {}), target: m.spec?.target ?? m.target, name: m.name, __retrain: { ep: m.ep, id: m.id, name: m.name, version: m.version ?? 1 } };
  mlTab.value = "train";
}

export function ModeSwitch({ value, onChange, name }: { value: RetrainMode; onChange: (v: RetrainMode) => void; name?: string }) {
  return (
    <div class="seg ml-mode-sw">
      <button class={value === "replace" ? "on" : ""} onClick={(e) => (e.preventDefault(), onChange("replace"))} title={`Replace ${name ? `“${name}”` : "the model"} with the new version (the old one stays in its history)`}>
        <RotateCcw size={13} /> Replace (new version)
      </button>
      <button class={value === "new" ? "on" : ""} onClick={(e) => (e.preventDefault(), onChange("new"))} title="Keep the current model and save the result as a separate model">
        <Layers3 size={13} /> Save as new model
      </button>
    </div>
  );
}

export function RetrainHost() {
  const m = continueFor.value;
  if (!m) return null;
  return <ContinueDialog key={`${m.ep}|${m.id}`} m={m} onClose={() => (continueFor.value = null)} />;
}

function ContinueDialog({ m, onClose }: { m: Model; onClose: () => void }) {
  const algo = String(m.algo ?? m.spec?.algo ?? "gbdt");
  const sp: any = m.spec ?? {};
  const y = new Date().getFullYear();
  const yrs: [number, number] = Array.isArray(sp.years) ? [sp.years[0], sp.years[1]] : [y - 3, y - 1];
  const [mode, setMode] = useState<RetrainMode>("replace");
  const [extra, setExtra] = useState(Math.max(50, Math.round((sp.max_events ?? 300) / 2)));
  const [years, setYears] = useState<[number, number]>([Math.min(yrs[1] + 1, y), y]);
  const [sameYears, setSameYears] = useState(false);
  const [rounds, setRounds] = useState(algo === "mlp" ? 50 : algo === "logreg" ? 20 : 200);
  const [lr, setLr] = useState<number>(+(m.params?.learning_rate ?? sp.params?.learning_rate ?? (algo === "mlp" ? 0.001 : 0.03)) / (algo === "gbdt" ? 1 : 2));
  const [name, setName] = useState(`${m.name} (further)`);
  const [busy, setBusy] = useState(false);
  const roundsLabel = algo === "mlp" ? "Extra epochs" : algo === "logreg" ? "Extra iterations" : "Extra trees";
  const go = async () => {
    setBusy(true);
    const body: any = { mode, extra_events: extra, learning_rate: lr, ...(sameYears ? {} : { years }), ...(mode === "new" ? { name } : {}) };
    if (algo === "mlp") body.epochs = rounds;
    else if (algo === "logreg") body.iterations = rounds;
    else body.n_trees = rounds;
    if (sp.region) body.region = sp.region;
    const id = await continueModel(m, body);
    setBusy(false);
    if (id) {
      onClose();
      mlTab.value = "jobs";
    }
  };
  return (
    <div class="ml-dlg-back" onClick={onClose}>
      <div class="ml-dlg glass" onClick={(e) => e.stopPropagation()}>
        <div class="ml-dlg-head">
          <b>Train further</b>
          <small class="muted">
            {m.name} · v{m.version ?? 1}
            {m.imported ? " · imported" : ""}
          </small>
          <button class="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>
        <p class="muted small">
          Keeps the model's features and adds training on more cases (warm start). To change sources or features, use <a onClick={() => (onClose(), openRetrain(m))}>Retrain</a>.
        </p>
        <div class="ml-grid">
          <Field label="More events" help="Additional historical events (plus their negatives) gathered for this round">
            <input type="number" min={0} max={100000} step={50} value={extra} onChange={(e) => setExtra(Math.max(0, +(e.target as HTMLInputElement).value))} />
          </Field>
          <Field label="Years" help="Where the new events come from (e.g. only the newest season). Untick to reuse the model's own years.">
            <span class="ml-range">
              <input type="checkbox" checked={!sameYears} onChange={(e) => setSameYears(!(e.target as HTMLInputElement).checked)} title="Use these years" />
              <input type="number" disabled={sameYears} value={years[0]} min={1990} max={y} onChange={(e) => setYears([+(e.target as HTMLInputElement).value, Math.max(years[1], +(e.target as HTMLInputElement).value)])} />–
              <input type="number" disabled={sameYears} value={years[1]} min={1990} max={y} onChange={(e) => setYears([Math.min(years[0], +(e.target as HTMLInputElement).value), +(e.target as HTMLInputElement).value])} />
            </span>
          </Field>
          <Field label={roundsLabel} help={algo === "gbdt" ? "Boosting rounds added on top of the existing trees" : "Training passes over old + new samples"}>
            <input type="number" min={1} max={10000} value={rounds} onChange={(e) => setRounds(Math.max(1, Math.round(+(e.target as HTMLInputElement).value)))} />
          </Field>
          <Field label="Learning rate" help="Usually lower than the original for fine-tuning">
            <input type="number" min={0.00001} max={1} step={0.001} value={lr} onChange={(e) => setLr(+(e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <Field label="Result" wide>
          <ModeSwitch value={mode} onChange={setMode} name={m.name} />
        </Field>
        {mode === "new" && (
          <Field label="New model name" wide>
            <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </Field>
        )}
        <div class="ml-dlg-go">
          <small class="muted">Runs {m.ep === "local" ? "on this computer" : "on the server"} · see Jobs</small>
          <button class="btn" disabled={busy} onClick={go}>
            <Rocket size={14} /> {busy ? "Starting…" : "Train further"}
          </button>
        </div>
      </div>
    </div>
  );
}

const KIND: Record<string, string> = { train: "Trained", retrain: "Retrained", continue: "Trained further" };
export function ModelHistory({ m }: { m: Model }) {
  const h = [...(m.history ?? [])].sort((a, b) => b.version - a.version);
  if (!h.length) return <div class="muted small">Version {m.version ?? 1} · no history recorded{m.imported ? " (imported)" : ""}</div>;
  const reg = m.task === "regression";
  const keys = reg ? ["mae", "rmse", "r2", "skill"] : ["auc", "csi", "pod", "far"];
  return (
    <table class="ml-table ml-hist">
      <thead>
        <tr>
          <th>
            <History size={12} /> Ver.
          </th>
          <th>When</th>
          <th>How</th>
          <th>Samples</th>
          {keys.map((k) => (
            <th key={k}>{k.toUpperCase()}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {h.map((e) => (
          <tr key={e.version} class={e.version === (m.version ?? 1) ? "cur" : ""}>
            <td>
              <b>v{e.version}</b>
              {e.version === (m.version ?? 1) && <small class="ml-cur">current</small>}
            </td>
            <td>{fmtDay(e.at)}</td>
            <td>{KIND[e.kind] ?? e.kind}</td>
            <td>{e.samples != null ? e.samples.toLocaleString() : "—"}</td>
            {keys.map((k) => {
              const v = e.metrics_summary?.[k] ?? e.metrics_summary?.[k === "auc" ? "roc_auc" : k];
              return <td key={k}>{k === "pod" || k === "far" ? (v != null ? `${Math.round(v * 100)}%` : "—") : f2(v, k === "auc" || k === "r2" ? 3 : 2)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
