// Detection models → Jobs: training jobs on the server and on this computer, live progress + log.

import { useEffect, useRef, useState } from "preact/hooks";
import { CircleStop, X, ExternalLink, Server, ChevronDown, ChevronRight, Trash2, RefreshCw, RotateCcw, RotateCw, Cpu, MemoryStick, Network, PauseCircle, Laptop, Share2 } from "lucide-preact";
import { jobs, jobsErr, loadJobs, loadJob, jobAction, resumeJob, retryJob, selModel, mlTab, models, copyModel, loadModels, localIsMain, canLocal, localUrl, ensureLocal } from "../../ml/client";
import { mlSettings, loadMlSettings, fmtBytes } from "../../ml/m8"; // models 0.8
import { tmeta } from "../../ml/targets";
import type { Job } from "../../ml/types";
import { TIcon, EpBadge, fmtDur, f2 } from "./common";

const STATE: Record<string, [string, string]> = {
  queued: ["Queued", "q"],
  running: ["Running", "run"],
  stopping: ["Stopping…", "run"],
  done: ["Done", "ok"],
  failed: ["Failed", "bad"],
  cancelled: ["Cancelled", "off"],
  interrupted: ["Interrupted", "bad"],
  paused: ["Paused", "q"], // models 0.8: over the job limit
};
const PHASE: Record<string, string> = { "collect events": "Finding events", "list volumes": "Listing radar volumes", "fetch & extract": "Downloading radar data", environment: "Environment data", label: "Labelling", events: "Finding events", labels: "Collecting labels", fetch: "Downloading data", download: "Downloading data", features: "Extracting features", train: "Training", cv: "Cross-validating", tune: "Tuning", calibrate: "Calibrating", save: "Saving" };

export function JobsTab() {
  const [open, setOpen] = useState<string>("");
  // poll every 2 s while this tab is visible (and the window isn't hidden)
  useEffect(() => {
    loadJobs();
    loadMlSettings();
    const t = window.setInterval(() => document.visibilityState !== "hidden" && loadJobs(), 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!open) return;
    const [ep, id] = open.split("|") as ["main" | "local", string];
    loadJob(ep, id);
    const t = window.setInterval(() => loadJob(ep, id), 2000);
    return () => clearInterval(t);
  }, [open]);
  const list = jobs.value;
  const active = list.filter((j) => ["running", "queued", "stopping", "paused"].includes(j.state));
  // models 0.8: jobs on this computer are only listed while the built-in server runs — after the
  // app was closed, start it to see (and resume) interrupted jobs
  const localOff = canLocal() && !localUrl.value;
  const [starting, setStarting] = useState(false);
  const done = list.filter((j) => !active.includes(j));
  return (
    <div class="ml-jobs">
      <div class="ml-jobs-head">
        <span class="muted">{active.length ? `${active.length} active` : "Nothing training right now"} · updates every 2 s</span>
        <button class="icon-btn" title="Refresh" onClick={() => loadJobs()}>
          <RefreshCw size={15} />
        </button>
      </div>
      {jobsErr.value && <div class="ml-err">{jobsErr.value}</div>}
      {localOff && (
        <div class="m8-localoff">
          <Laptop size={14} />
          <span>The built-in server is off, so jobs on this computer aren't listed. Jobs interrupted when the app closed can be resumed once it runs.</span>
          <button
            class="btn sm"
            disabled={starting}
            onClick={async () => {
              setStarting(true);
              if (await ensureLocal()) await loadJobs();
              setStarting(false);
            }}
          >
            {starting ? "Starting…" : "Start it"}
          </button>
        </div>
      )}
      {!list.length && !jobsErr.value && (
        <div class="ml-empty">
          No training jobs yet.
          <button class="btn sm" onClick={() => (mlTab.value = "train")}>
            Train a model
          </button>
        </div>
      )}
      {[...active, ...done].map((j) => {
        const k = `${j.ep}|${j.id}`;
        return <JobCard key={k} j={j} open={open === k} toggle={() => setOpen(open === k ? "" : k)} />;
      })}
    </div>
  );
}

function JobCard({ j, open, toggle }: { j: Job; open: boolean; toggle: () => void }) {
  const [st, cls] = STATE[j.state] ?? [j.state, "off"];
  const live = j.state === "running" || j.state === "queued" || j.state === "stopping" || j.state === "paused";
  const c = j.counts ?? {};
  const p = Math.max(0, Math.min(1, j.progress ?? 0));
  const logRef = useRef<HTMLPreElement>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [j.log?.length, open]);
  const model = j.model_id ? models.value.find((m) => m.id === j.model_id && m.ep === j.ep) : undefined;
  const openModel = async () => {
    if (!model) await loadModels();
    selModel.value = `${j.ep}|${j.model_id}`;
    mlTab.value = "models";
  };
  const copyToMain = async () => {
    if (!model) await loadModels();
    const m = models.value.find((x) => x.id === j.model_id && x.ep === "local");
    if (m) copyModel(m, "main");
  };
  return (
    <div class={`ml-job ${cls} ${open ? "open" : ""}`}>
      <div class="ml-job-top">
        <button class="icon-btn" onClick={toggle} title={open ? "Hide log" : "Show log"}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <TIcon t={j.target ?? "custom"} size={24} />
        <div class="ml-job-title">
          <b>{j.name ?? `${tmeta(j.target ?? "").name} model`}</b>
          <div class="ml-job-sub">
            <span class={`ml-state ${cls}`}>{st}</span>
            {live && j.phase && j.state !== "paused" && <span>{PHASE[j.phase] ?? j.phase}</span>}
            {j.state === "paused" && (
              <span class="muted" title="Over the machine's max training jobs (Train tab) — resumes when a slot frees up">
                <PauseCircle size={11} /> waiting for a slot (max {mlSettings.value[j.ep]?.max_jobs ?? "?"})
              </span>
            )}
            <EpBadge ep={j.ep} />
            {j.kind && j.kind !== "train" && (
              <span class="ml-ver" title={`${j.kind === "continue" ? "Training further" : "Retraining"} model ${j.base_model ?? ""}${j.mode === "new" ? " · saved as a new model" : " · replaces it (new version)"}`}>
                {j.kind === "continue" ? "train further" : "retrain"} · {models.value.find((m) => m.id === j.base_model && m.ep === j.ep)?.name ?? j.base_model ?? "model"} · {j.mode === "new" ? "new model" : "replace"}
              </span>
            )}
            {j.started && <span class="muted">{j.state === "queued" ? "queued" : "started"} {new Date(j.started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
            {j.time_limit_min ? <span class="muted">limit {fmtDur(j.time_limit_min * 60)}</span> : null}
          </div>
        </div>
        <div class="ml-job-actions">
          {j.state === "running" && (
            <button class="btn sm ghost" title="Finish now and keep the best model trained so far" onClick={() => jobAction(j, "stop")}>
              <CircleStop size={13} /> Stop early
            </button>
          )}
          {live &&
            (confirm ? (
              <span class="ml-confirm">
                Cancel and discard?
                <button class="btn sm danger" onClick={() => jobAction(j, "delete")}>
                  Cancel job
                </button>
                <button class="btn sm ghost" onClick={() => setConfirm(false)}>
                  No
                </button>
              </span>
            ) : (
              <button class="btn sm ghost" title="Cancel (no model is saved)" onClick={() => setConfirm(true)}>
                <X size={13} /> Cancel
              </button>
            ))}
          {j.model_id && (
            <button class="btn sm" onClick={openModel}>
              <ExternalLink size={13} /> Open model
            </button>
          )}
          {j.model_id && j.ep === "local" && !localIsMain.value && (
            <button class="btn sm ghost" title="Export from this computer and import into the main server" onClick={copyToMain}>
              <Server size={13} /> Copy model to the main server
            </button>
          )}
          {!live && (j.resumable || (j.state === "interrupted" && j.ep === "local")) && (
            <button class="btn sm" title="Continue where it stopped (downloaded data is cached)" onClick={() => resumeJob(j)}>
              <RotateCcw size={13} /> Resume
            </button>
          )}
          {j.state === "failed" && (
            <button class="btn sm" title="Run the job again with the same settings" onClick={() => retryJob(j)}>
              <RotateCw size={13} /> Retry
            </button>
          )}
          {!live && (
            <button class="icon-btn danger" title="Remove from the list" onClick={() => jobAction(j, "delete")}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {((live && j.state !== "queued") || j.state === "done") && (
        <div class="ml-prog">
          <div class={`ml-bar ${live ? "live" : ""}`}>
            <i style={{ width: `${(j.state === "done" ? 1 : p) * 100}%` }} />
          </div>
          <span class="ml-prog-pct">{Math.round((j.state === "done" ? 1 : p) * 100)}%</span>
        </div>
      )}
      <div class="ml-job-stats">
        {c.events != null && (
          <span>
            <small>Events</small>
            {c.events.toLocaleString()}
          </span>
        )}
        {c.volumes_total != null && (
          <span>
            <small>Radar volumes</small>
            {(c.volumes_done ?? 0).toLocaleString()} / {c.volumes_total.toLocaleString()}
          </span>
        )}
        {c.samples != null && (
          <span>
            <small>Samples</small>
            {c.samples.toLocaleString()}
          </span>
        )}
        {c.positives != null && (
          <span>
            <small>Positives</small>
            {c.positives.toLocaleString()}
          </span>
        )}
        {j.train && live && (
          <span title="Latest boosting round / epoch; validation loss should keep falling">
            <small>Iteration {j.train.iteration ?? "—"}</small>loss {f2(j.train.train_loss, 3)} · val {f2(j.train.val_loss, 3)}
          </span>
        )}
        {/* models 0.8: live resource use against the job's limits */}
        {live && j.usage && (
          <span class="m8-usage" title="Live resource use">
            <small>Usage</small>
            <span class="m8-u-row">
            <span>
              <Cpu size={11} /> {j.usage.cpu_pct != null ? `${Math.round(j.usage.cpu_pct)}%` : "—"}
              {j.resources?.cpu_threads ? <i> · {j.resources.cpu_threads} thr</i> : null}
            </span>
            <span>
              <MemoryStick size={11} /> {j.usage.ram_mb != null ? (j.usage.ram_mb >= 1024 ? `${(j.usage.ram_mb / 1024).toFixed(1)} GB` : `${Math.round(j.usage.ram_mb)} MB`) : "—"}
              {j.resources?.ram_mb ? <i> / {j.resources.ram_mb >= 1024 ? `${Math.round(j.resources.ram_mb / 1024)} GB` : `${j.resources.ram_mb} MB`}</i> : null}
            </span>
            <span>
              <Network size={11} /> {j.usage.net_mbps != null ? `${j.usage.net_mbps.toFixed(1)} Mb/s` : "—"}
              {j.resources?.download_concurrency ? <i> · ×{j.resources.download_concurrency}</i> : null}
            </span>
            {/* 0.8.1: requests answered by another job's download */}
            {j.usage.shared ? (
              <span title="Data shared with other jobs running at the same time (downloaded once)">
                <Share2 size={11} /> {j.usage.shared} shared{j.usage.shared_bytes ? <i> · {fmtBytes(j.usage.shared_bytes)}</i> : null}
              </span>
            ) : null}
            </span>
          </span>
        )}
        {!live && j.resources && (j.resources.cpu_threads || j.resources.ram_mb) ? (
          <span>
            <small>Resources</small>
            {j.resources.cpu_threads ?? "auto"} threads · {j.resources.ram_mb ? `${Math.round(j.resources.ram_mb / 1024)} GB` : "auto"}
          </span>
        ) : null}
        <span>
          <small>Elapsed</small>
          {fmtDur(j.elapsed_s ?? (j.started ? (Date.now() - j.started) / 1000 : undefined))}
        </span>
        {live && (
          <span>
            <small>ETA</small>
            {j.eta_s != null ? fmtDur(j.eta_s) : "estimating…"}
          </span>
        )}
      </div>
      {j.error && <div class="ml-err ml-job-err">{j.error}</div>}
      {open && (
        <pre class="ml-log" ref={logRef}>
          {(j.log ?? []).length ? (j.log ?? []).join("\n") : "No log yet"}
        </pre>
      )}
    </div>
  );
}
