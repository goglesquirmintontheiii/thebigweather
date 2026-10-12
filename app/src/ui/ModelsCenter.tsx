// Detection models window: create/train models for tornadoes, supercells, hail, wind, debris, flash
// floods, tropical genesis, wildfires…; manage, export/import, and run them on US radars. The map
// layer lives in overlays/mldefs.ts, the API client in ml/client.ts.

import { useEffect } from "preact/hooks";
import { BrainCircuit, Boxes, GraduationCap, Activity, Radar, Check, X } from "lucide-preact";
import { CenterModal } from "./CenterModal";
import { mlOpen, mlTab, activeJobs, loadJobs, loadRun, runState, models, type MlTab, catalog, loadCatalog, localUrl, detections, selModel, trainDraft, jobs, runningOn, pollDetections } from "../ml/client";
import { pickMode, finishPick } from "../ml/pick";
import { ModelsTab } from "./ml/ModelsTab";
import { TrainTab } from "./ml/TrainTab";
import { JobsTab } from "./ml/JobsTab";
import { RunTab } from "./ml/RunTab";

export { mlOpen };

function PickBar() {
  const p = pickMode.value;
  if (!p) return null;
  return (
    <div class="ml-pickbar glass">
      {p.kind === "radars" ? (
        <span>
          <b>Click radar sites</b> to add or remove them · {p.sel.length} selected
        </span>
      ) : (
        <span>
          <b>Click two corners</b> of the training region{p.pts.length === 1 ? " · one more" : p.pts.length === 2 ? " · done? (click again to restart)" : ""}
        </span>
      )}
      <button class="btn sm" disabled={p.kind === "bbox" && p.pts.length < 2} onClick={() => finishPick(true)}>
        <Check size={13} /> Done
      </button>
      <button class="btn sm ghost" onClick={() => finishPick(false)}>
        <X size={13} /> Cancel
      </button>
    </div>
  );
}

export function ModelsCenter() {
  const open = mlOpen.value;
  useEffect(() => {
    if (!open) return;
    loadCatalog();
    loadRun();
    loadJobs();
    // light background refresh for the tab badges (the Jobs tab polls faster itself)
    const t = window.setInterval(() => document.visibilityState !== "hidden" && mlTab.value !== "jobs" && loadJobs(), 15_000);
    return () => clearInterval(t);
  }, [open]);
  if (!open) return null;
  const t = mlTab.value;
  const nAct = activeJobs.value.length;
  const nRun = Object.values(runState.value).filter((r) => r?.enabled).length;
  const tabs: [MlTab, string, any, any][] = [
    ["models", "Models", Boxes, models.value.length || null],
    ["train", "Train", GraduationCap, null],
    ["jobs", "Jobs", Activity, nAct ? <small class="ml-badge live">{nAct}</small> : null],
    ["run", "Run", Radar, nRun ? <small class="ml-badge live">on</small> : null],
  ];
  const picking = !!pickMode.value;
  return (
    <>
    {picking && <PickBar />}
    <CenterModal cls={`mlcenter${picking ? " ml-hidden" : ""}`} title="Detection models" sub="Train models on historical radar, MRMS, METAR and model data to detect tornadoes, supercells, hail, wind, tropical genesis, wildfires… and run them on live radars" icon={<BrainCircuit size={18} />} onClose={() => (pickMode.value ? finishPick(false) : (mlOpen.value = false))}>
      <div class="hs-tabs ml-tabs">
        {tabs.map(([id, l, Icon, badge]) => (
          <button key={id} class={t === id ? "on" : ""} onClick={() => (mlTab.value = id)}>
            <Icon size={14} /> {l}
            {typeof badge === "number" ? <small>{badge}</small> : badge}
          </button>
        ))}
      </div>
      <div class="ml-body">
        {t === "models" && <ModelsTab />}
        {t === "train" && <TrainTab />}
        {t === "jobs" && <JobsTab />}
        {t === "run" && <RunTab />}
      </div>
    </CenterModal>
    </>
  );
}

// console / screenshot handle
(window as any).__tbwML = { mlOpen, mlTab, models, jobs, runState, detections, catalog, selModel, trainDraft, localUrl, pickMode, runningOn, pollDetections };
