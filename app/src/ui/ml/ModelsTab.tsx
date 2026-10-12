// Detection models → Models: list, search/filter, detail (metrics, charts, importance, spec), manage.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Search, Upload, Download, Copy, Trash2, Pencil, Check, X, RefreshCw, Play, Server, Laptop, Tag } from "lucide-preact";
import { models, modelsErr, modelsLoading, loadModels, loadModel, selModel, mkey, patchModel, deleteModel, exportModel, importModel, copyModel, trainDraft, mlTab, runningOn, catalog, canLocal, localIsMain } from "../../ml/client";
import { tmeta, TARGETS } from "../../ml/targets";
import type { Model, Ep } from "../../ml/types";
import { TIcon, EpBadge, pct, f2, fmtDay, scoresAt, Help } from "./common";
import { ThresholdChart, RocChart, ReliabilityChart } from "./charts";
import { runPreset } from "./RunTab";

export function ModelsTab() {
  const [q, setQ] = useState("");
  const [tgt, setTgt] = useState("");
  const [lab, setLab] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    loadModels();
  }, []);
  const all = models.value;
  const labels = useMemo(() => [...new Set(all.flatMap((m) => m.labels))].sort(), [all]);
  const list = all.filter((m) => {
    if (tgt && m.target !== tgt) return false;
    if (lab && !m.labels.includes(lab)) return false;
    if (q) {
      const s = q.toLowerCase();
      return m.name.toLowerCase().includes(s) || m.labels.some((l) => l.toLowerCase().includes(s)) || tmeta(m.target).name.toLowerCase().includes(s) || (m.notes ?? "").toLowerCase().includes(s);
    }
    return true;
  });
  const sel = all.find((m) => mkey(m) === selModel.value) ?? (selModel.value ? undefined : list[0]);
  return (
    <div
      class="ml-models"
      onDragOver={(e) => (e.preventDefault(), e.stopPropagation())}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        for (const f of [...(e.dataTransfer?.files ?? [])]) importModel(f);
      }}
    >
      <div class="ml-list">
        <div class="ml-list-tools">
          <label class="ml-search">
            <Search size={14} />
            <input placeholder="Search models, labels…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </label>
          <button class="icon-btn" title="Refresh" onClick={() => loadModels()}>
            <RefreshCw size={15} class={modelsLoading.value ? "spin" : ""} />
          </button>
          <button class="icon-btn" title="Import a .tbwmodel file (or drop it here)" onClick={() => fileRef.current?.click()}>
            <Upload size={15} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".tbwmodel,application/octet-stream"
            hidden
            onChange={(e) => {
              const fs = (e.target as HTMLInputElement).files;
              for (const f of [...(fs ?? [])]) importModel(f);
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </div>
        <div class="ml-filters">
          <select value={tgt} onChange={(e) => setTgt((e.target as HTMLSelectElement).value)}>
            <option value="">All targets</option>
            {Object.entries(TARGETS).map(([k, t]) => (
              <option key={k} value={k}>
                {t.name}
              </option>
            ))}
          </select>
          {labels.map((l) => (
            <button key={l} class={`chip ${lab === l ? "on" : ""}`} onClick={() => setLab(lab === l ? "" : l)}>
              {l}
            </button>
          ))}
        </div>
        {modelsErr.value && <div class="ml-err">{modelsErr.value}</div>}
        <div class="ml-cards">
          {list.map((m) => (
            <ModelCard key={mkey(m)} m={m} on={!!sel && mkey(sel) === mkey(m)} />
          ))}
          {!list.length && !modelsLoading.value && (
            <div class="ml-empty">
              {all.length ? "No models match." : "No models yet."}
              <button class="btn sm" onClick={() => (mlTab.value = "train")}>
                Train your first model
              </button>
              <small class="muted">or drop a .tbwmodel file here to import one</small>
            </div>
          )}
        </div>
      </div>
      <div class="ml-detail">{sel ? <ModelDetail key={mkey(sel)} m={sel} /> : <div class="ml-empty">Pick a model</div>}</div>
    </div>
  );
}

function ModelCard({ m, on }: { m: Model; on: boolean }) {
  const n = runningOn.value.get(mkey(m));
  const mt = m.metrics ?? {};
  return (
    <button class={`ml-card ${on ? "on" : ""}`} onClick={() => (selModel.value = mkey(m))}>
      <TIcon t={m.target} size={26} />
      <div class="ml-card-main">
        <div class="ml-card-title">
          <b>{m.name}</b>
          {n != null && (
            <span class="ml-live" title="Running now">
              <i /> {n ? `${n} radar${n > 1 ? "s" : ""}` : "running"}
            </span>
          )}
        </div>
        <div class="ml-card-sub">
          <span>{tmeta(m.target).name}</span>
          <span>·</span>
          <span>{fmtDay(m.created)}</span>
          {m.ep === "local" && !localIsMain.value && <EpBadge ep="local" />}
        </div>
        {m.labels.length > 0 && (
          <div class="ml-chips">
            {m.labels.slice(0, 4).map((l) => (
              <span key={l} class="ml-lab">
                {l}
              </span>
            ))}
            {m.labels.length > 4 && <span class="ml-lab">+{m.labels.length - 4}</span>}
          </div>
        )}
      </div>
      <div class="ml-card-k">
        <span>
          <small>AUC</small>
          {f2(mt.auc)}
        </span>
        <span>
          <small>CSI</small>
          {f2(mt.csi)}
        </span>
      </div>
    </button>
  );
}

function LabelEditor({ m }: { m: Model }) {
  const [v, setV] = useState("");
  const known = [...new Set(models.value.flatMap((x) => x.labels))].filter((l) => !m.labels.includes(l));
  const add = (raw: string) => {
    const l = raw.trim().replace(/,$/, "");
    if (!l || m.labels.includes(l)) return setV("");
    patchModel(m, { labels: [...m.labels, l] });
    setV("");
  };
  return (
    <div class="ml-labels">
      <Tag size={13} class="muted" />
      {m.labels.map((l) => (
        <span key={l} class="ml-lab edit">
          {l}
          <button title="Remove label" onClick={() => patchModel(m, { labels: m.labels.filter((x) => x !== l) })}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        class="ml-lab-in"
        list="ml-known-labels"
        placeholder="+ label"
        value={v}
        onInput={(e) => {
          const t = (e.target as HTMLInputElement).value;
          if (t.endsWith(",")) add(t);
          else setV(t);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") add(v);
          if (e.key === "Backspace" && !v && m.labels.length) patchModel(m, { labels: m.labels.slice(0, -1) });
        }}
        onBlur={() => v && add(v)}
      />
      <datalist id="ml-known-labels">
        {known.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </div>
  );
}

function ModelDetail({ m }: { m: Model }) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(m.name);
  const [thr, setThr] = useState(m.threshold ?? 0.5);
  const [confirmDel, setConfirmDel] = useState(false);
  const [notes, setNotes] = useState(m.notes ?? "");
  const thrTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!m.importance?.length || !m.metrics?.reliability) loadModel(m.ep, m.id);
  }, [m.id, m.ep]);
  useEffect(() => setThr(m.threshold ?? 0.5), [m.threshold]);
  useEffect(() => setNotes(m.notes ?? ""), [m.notes]);
  const mt = m.metrics ?? {};
  const live = scoresAt(mt, thr);
  const setThreshold = (t: number) => {
    setThr(t);
    clearTimeout(thrTimer.current);
    thrTimer.current = window.setTimeout(() => patchModel(m, { threshold: t }), 600);
  };
  const other: Ep = m.ep === "local" ? "main" : "local";
  const n = runningOn.value.get(mkey(m));
  return (
    <div class="ml-det">
      <div class="ml-det-head">
        <TIcon t={m.target} size={40} />
        <div class="ml-det-title">
          {edit ? (
            <form
              class="ml-rename"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() && name !== m.name) patchModel(m, { name: name.trim() });
                setEdit(false);
              }}
            >
              <input value={name} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEdit(false), setName(m.name))} />
              <button class="icon-btn" title="Save">
                <Check size={15} />
              </button>
            </form>
          ) : (
            <h3 onDblClick={() => setEdit(true)}>
              {m.name}
              <button class="icon-btn" title="Rename" onClick={() => (setName(m.name), setEdit(true))}>
                <Pencil size={13} />
              </button>
            </h3>
          )}
          <div class="ml-det-sub">
            <span style={{ color: tmeta(m.target).color }}>{tmeta(m.target).name}</span>
            <span>· {m.candidate === "grid_point" ? "grid points" : "radar cells"}</span>
            <span>· {catalog.value?.algos.find((a) => a.id === m.algo)?.name ?? m.algo ?? "model"}</span>
            <span>· trained {fmtDay(m.created)}</span>
            <EpBadge ep={m.ep} />
            {n != null && (
              <span class="ml-live">
                <i /> running on {n} radar{n === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <LabelEditor m={m} />
        </div>
        <div class="ml-det-actions">
          <button class="btn sm" title="Run this model on radars" onClick={() => runPreset([mkey(m)])}>
            <Play size={13} /> Run
          </button>
          <button class="btn sm ghost" title="Download as a .tbwmodel file" onClick={() => exportModel(m)}>
            <Download size={13} /> Export
          </button>
          <button
            class="btn sm ghost"
            title="Open the training form with this model's settings"
            onClick={() => {
              trainDraft.value = { ...(m.spec ?? {}), name: `${m.name} (copy)` };
              mlTab.value = "train";
            }}
          >
            <Copy size={13} /> Duplicate settings
          </button>
          {canLocal() && (
            <button class="btn sm ghost" title={other === "main" ? "Copy this model to the main server" : "Copy this model to this computer"} onClick={() => copyModel(m, other)}>
              {other === "main" ? <Server size={13} /> : <Laptop size={13} />} Copy to {other === "main" ? "server" : "this computer"}
            </button>
          )}
          {confirmDel ? (
            <span class="ml-confirm">
              Delete?
              <button class="btn sm danger" onClick={() => deleteModel(m)}>
                Delete
              </button>
              <button class="btn sm ghost" onClick={() => setConfirmDel(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button class="icon-btn danger" title="Delete model" onClick={() => setConfirmDel(true)}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      <div class="ml-metrics">
        <Metric k="AUC" v={f2(mt.auc, 3)} help="Area under the ROC curve: 0.5 = coin flip, 1 = perfect ranking" />
        <Metric k="PR-AUC" v={f2(mt.pr_auc, 3)} help="Area under the precision–recall curve (more telling than AUC for rare events)" />
        <Metric k="CSI" v={f2(live?.csi ?? mt.csi)} help="Critical success index at the threshold: hits / (hits + misses + false alarms)" hl />
        <Metric k="POD" v={pct(live?.pod ?? mt.pod)} help="Probability of detection at the threshold" hl />
        <Metric k="FAR" v={pct(live?.far ?? mt.far)} help="False-alarm ratio at the threshold" hl />
        <Metric k="Brier" v={f2(mt.brier, 3)} help="Mean squared probability error (lower is better)" />
        <Metric k={mt.positives != null ? `Samples · ${mt.positives.toLocaleString()} events` : "Samples"} v={mt.samples != null ? mt.samples.toLocaleString() : mt.confusion ? (mt.confusion.tp + mt.confusion.fp + mt.confusion.fn + mt.confusion.tn).toLocaleString() : "—"} help="Training samples (positive = event)" />
      </div>

      <div class="ml-thr">
        <span class="ml-flabel">
          Detection threshold <Help text="Probability at which a detection counts as a hit (shown as moderate). Lower = catch more events but more false alarms. POD/FAR/CSI above update live; saved automatically." />
        </span>
        <input type="range" min={0.05} max={0.95} step={0.01} value={thr} onInput={(e) => setThreshold(+(e.target as HTMLInputElement).value)} />
        <b>{thr.toFixed(2)}</b>
        {mt.best_csi_threshold != null && Math.abs(mt.best_csi_threshold - thr) > 0.005 && (
          <button class="btn xs ghost" onClick={() => setThreshold(mt.best_csi_threshold!)}>
            Best CSI ({mt.best_csi_threshold.toFixed(2)})
          </button>
        )}
        {live && (
          <span class="muted small">
            POD {pct(live.pod)} · FAR {pct(live.far)} · CSI {f2(live.csi)}
          </span>
        )}
      </div>

      <div class="ml-charts">
        <ThresholdChart m={mt} thr={thr} onPick={setThreshold} />
        <RocChart m={mt} />
        <ReliabilityChart m={mt} />
      </div>

      <div class="ml-row2">
        <div class="ml-box">
          <h4>Feature importance</h4>
          <Importance m={m} />
        </div>
        <div class="ml-col">
          {mt.confusion && (
            <div class="ml-box">
              <h4>Confusion matrix <small class="muted">(validation, at training threshold {f2(mt.threshold ?? mt.best_csi_threshold)})</small></h4>
              <Confusion c={mt.confusion} />
            </div>
          )}
          {!!mt.cv?.length && (
            <div class="ml-box">
              <h4>Cross-validation</h4>
              <table class="ml-table">
                <thead>
                  <tr>
                    <th>Fold</th>
                    <th>AUC</th>
                    <th>CSI</th>
                  </tr>
                </thead>
                <tbody>
                  {mt.cv.map((f) => (
                    <tr key={f.fold}>
                      <td>{f.fold}</td>
                      <td>{f2(f.auc, 3)}</td>
                      <td>{f2(f.csi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div class="ml-box">
            <h4>Training setup</h4>
            <SpecSummary m={m} />
          </div>
          <div class="ml-box">
            <h4>Notes</h4>
            <textarea class="ml-notes" placeholder="What this model is for, what worked…" value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} onBlur={() => notes !== (m.notes ?? "") && patchModel(m, { notes })} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ k, v, help, hl }: { k: string; v: string; help?: string; hl?: boolean }) {
  return (
    <div class={`ml-metric ${hl ? "hl" : ""}`} title={help}>
      <small>{k}</small>
      <b>{v}</b>
    </div>
  );
}

function Confusion({ c }: { c: { tp: number; fp: number; fn: number; tn: number } }) {
  const tot = c.tp + c.fp + c.fn + c.tn || 1;
  const cell = (v: number, cls: string, l: string) => (
    <div class={`ml-cm ${cls}`} style={{ "--a": String(0.12 + 0.5 * Math.sqrt(v / tot)) }}>
      <b>{v.toLocaleString()}</b>
      <small>{l}</small>
    </div>
  );
  return (
    <div class="ml-cmx">
      <span />
      <small class="muted">Event</small>
      <small class="muted">No event</small>
      <small class="muted ml-cm-side">Detected</small>
      {cell(c.tp, "good", "hits")}
      {cell(c.fp, "bad", "false alarms")}
      <small class="muted ml-cm-side">Not detected</small>
      {cell(c.fn, "bad", "misses")}
      {cell(c.tn, "good", "correct nulls")}
    </div>
  );
}

function featInfo(m: Model, id: string) {
  const f = m.feature_schema?.find((x) => x.id === id) ?? catalog.value?.candidates.flatMap((c) => c.features).find((x) => x.id === id);
  return { name: f?.name ?? id, unit: f?.unit ?? "", group: f?.group ?? "" };
}

function Importance({ m }: { m: Model }) {
  const imp = [...(m.importance ?? [])].sort((a, b) => b.gain - a.gain).slice(0, 20);
  if (!imp.length) return <div class="muted small">No importance data</div>;
  const max = imp[0].gain || 1;
  const tot = (m.importance ?? []).reduce((a, x) => a + Math.max(0, x.gain), 0) || 1;
  return (
    <div class="ml-imp">
      {imp.map((x) => {
        const f = featInfo(m, x.id);
        return (
          <div key={x.id} class="ml-imp-row" title={`${f.name}${f.unit ? ` (${f.unit})` : ""}${f.group ? ` · ${f.group}` : ""} · ${((x.gain / tot) * 100).toFixed(1)}% of total gain`}>
            <span class="ml-imp-name">{f.name}</span>
            <span class="ml-imp-bar">
              <i style={{ width: `${(x.gain / max) * 100}%` }} />
            </span>
            <span class="ml-imp-v">{((x.gain / tot) * 100).toFixed(1)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function SpecSummary({ m }: { m: Model }) {
  const s: any = m.spec ?? {};
  const cat = catalog.value;
  const ls = cat?.label_sources.find((x) => x.id === s.label_source)?.name ?? s.label_source;
  const src = s.sources ?? {};
  const rows: [string, string][] = [
    ["Labels from", ls ?? "—"],
    ["Years", Array.isArray(s.years) ? `${s.years[0]}–${s.years[1]}` : "—"],
    ["Region", s.region?.states?.length ? s.region.states.join(", ") : s.region?.bbox ? `box ${s.region.bbox.map((v: number) => v.toFixed(1)).join(", ")}` : "CONUS"],
    ["Events", s.max_events != null ? `up to ${s.max_events}` : "—"],
    ["Negatives", s.neg_ratio != null ? `${s.neg_ratio}× per event${s.null_days ? ` + ${s.null_days} null days` : ""}` : "—"],
    ["Matching", s.match ? `${s.match.radius_km} km · −${s.match.before_min}/+${s.match.after_min} min` : "—"],
    ["Radar", src.radar_products?.length ? src.radar_products.join(", ") : "—"],
    ["MRMS", src.mrms?.length ? src.mrms.join(", ") : "—"],
    ["METARs", src.metar ? "yes" : "no"],
    ["Model fields", src.model?.length ? src.model.join(", ") : "—"],
    ["Features", s.features?.length ? `${s.features.length} selected` : m.feature_schema?.length ? `${m.feature_schema.length} (all)` : "all"],
    ["Algorithm", `${cat?.algos.find((a) => a.id === (s.algo ?? m.algo))?.name ?? s.algo ?? m.algo ?? "—"}${m.params || s.params ? ` (${Object.entries(m.params ?? s.params ?? {}).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`],
    ["CV folds", s.cv_folds != null ? String(s.cv_folds) : "—"],
  ];
  if (s.filters && Object.keys(s.filters).length) rows.splice(2, 0, ["Filters", Object.entries(s.filters).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("/") : v}`).join(", ")]);
  return (
    <dl class="ml-spec">
      {rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}

