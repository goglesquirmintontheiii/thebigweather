// 0.8.1 perf: Settings → Performance, the FPS / memory readout, the safe-mode banner and the
// "map graphics lost" banner.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { settings, update } from "../store";
import { Toggle } from "./panels/RadarPanel";
import { perf, perfCfg, setPerf, hardware, safeInfo, safeAnswered, restoreLayout, keepSafe, glLost } from "../perf";
import { autoPreset, softwareGpu, type PerfPreset, type PerfValues } from "../perfcore";
import { fps } from "../map/mapview";
import { rasterBudget } from "../grid/budget";

const PRESET_NAMES: Record<PerfPreset, string> = { auto: "Auto", quality: "Quality", balanced: "Balanced", low: "Low-end" };

function Opt<K extends keyof PerfValues>({ k, label, choices, hint }: { k: K; label: string; choices: [PerfValues[K], string][]; hint?: string }) {
  const v = perf.value[k];
  const set = perfCfg.value.over[k] !== undefined;
  return (
    <div class="row" title={hint}>
      <span>
        {label}
        {set && (
          <button class="icon-btn" title="Back to the preset's value" aria-label={`Reset ${label}`} onClick={() => setPerf((c) => delete c.over[k])} style={{ marginLeft: 4, fontSize: 10 }}>
            ↺
          </button>
        )}
      </span>
      <select value={String(v)} aria-label={label} onChange={(e) => setPerf((c) => (c.over[k] = choices.find(([x]) => String(x) === (e.target as HTMLSelectElement).value)![0]))}>
        {choices.map(([x, l]) => (
          <option key={String(x)} value={String(x)}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PerfSection() {
  const c = perfCfg.value;
  const p = perf.value;
  const hw = hardware();
  const auto = autoPreset(hw);
  const pick = (k: PerfPreset) => {
    setPerf((x) => ((x.preset = k), (x.over = {})));
    // the 3D view's grid follows the lighter presets (Quality leaves it as set)
    const eff = k === "auto" ? auto : k;
    if (eff !== "quality" && settings.value.view3d.res !== "lo") update((s) => (s.view3d.res = "lo"));
  };
  return (
    <section>
      <label class="lbl">Performance</label>
      <div class="row">
        <span>Preset</span>
        <div class="seg">
          {(["auto", "quality", "balanced", "low"] as const).map((k) => (
            <button key={k} class={c.preset === k ? "on" : ""} style={{ whiteSpace: "nowrap" }} onClick={() => pick(k)} title={k === "auto" ? `Picked from this computer: ${PRESET_NAMES[auto]}` : undefined}>
              {PRESET_NAMES[k]}
            </button>
          ))}
        </div>
      </div>
      <div class="muted small">
        {c.preset === "auto" ? `Auto → ${PRESET_NAMES[auto]}` : PRESET_NAMES[c.preset]} · {hw.cores ?? "?"} cores{hw.memGB ? ` · ${hw.memGB}+ GB` : ""}
        {softwareGpu(hw.gpu) ? " · software graphics (no GPU)" : ""}
        {safeInfo.value?.active ? " · safe mode: Low-end until restart" : ""}
      </div>
      <Opt k="pixelRatio" label="Render resolution" choices={[[1, "100%"], [0.85, "85%"], [0.75, "75%"], [0.6, "60%"], [0.5, "50%"]]} hint="Map pixels drawn per screen pixel. Lower = faster, softer." />
      <Opt k="maxFps" label="Max frame rate" choices={[[0, "Unlimited"], [60, "60 fps"], [30, "30 fps"]]} />
      <Opt k="anim" label="Animations & particles" choices={[[true, "On"], [false, "Off"]]} hint="Wind particles, pulsing, transitions" />
      <Opt k="maxPanes" label="Max extra panes" choices={[[8, "No limit"], [5, "5"], [4, "4"], [3, "3"], [2, "2"], [1, "1"], [0, "None"]]} hint="Each pane is a full map. Extra ones show as off." />
      <Opt k="imgRes" label="Satellite / grid image size" choices={[[2400, "Full (2400 px)"], [1600, "1600 px"], [1024, "1024 px"], [768, "768 px"]]} />
      <Opt k="cacheMB" label="Frame cache" choices={[[2048, "2 GB"], [1024, "1 GB"], [512, "512 MB"], [256, "256 MB"], [192, "192 MB"], [128, "128 MB"]]} hint="Decoded frames kept for animation, all maps together. Long loops get smaller images to fit." />
      <Opt k="radarQ" label="Radar smoothing" choices={[["high", "As set"], ["med", "Light at most"], ["low", "Off"]]} />
      <Opt k="prefetch" label="Preload frames" choices={[["all", "Whole loop"], ["near", "Next few"], ["none", "Next only"]]} />
      <Opt k="pauseHidden" label="Pause when hidden" choices={[[false, "Off"], [true, "On"]]} hint="Stop drawing while the window is minimised or hidden" />
      <div class="row">
        <span>3D grid</span>
        <div class="seg">
          {(["lo", "hi"] as const).map((r) => (
            <button key={r} class={settings.value.view3d.res === r ? "on" : ""} onClick={() => update((s) => (s.view3d.res = r))}>
              {r === "lo" ? "Coarse" : "Fine"}
            </button>
          ))}
        </div>
      </div>
      <Toggle label="FPS / memory readout" on={c.hud} set={(v) => setPerf((x) => (x.hud = v))} />
      {p.preset !== "quality" && <div class="muted small">Quality draws everything at full detail.</div>}
    </section>
  );
}

/* ---------- FPS / memory readout ---------- */
const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
function PerfHud() {
  const [mem, setMem] = useState<{ js?: number; app?: number; gpu?: number }>({});
  const on = perfCfg.value.hud;
  useEffect(() => {
    if (!on) return;
    const tick = async () => {
      const js = (performance as any).memory?.usedJSHeapSize as number | undefined;
      let app: number | undefined, gpu: number | undefined;
      try {
        const s = await (window as any).tbw?.clientStats?.();
        app = s?.app_mem;
        gpu = s?.procs?.gpu?.mem;
      } catch {
        /* browser */
      }
      setMem({ js, app, gpu });
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [on]);
  if (!on) return null;
  const f = fps.value;
  return (
    <div class="glass" style={{ position: "fixed", left: 8, bottom: 8, zIndex: 60, padding: "3px 8px", fontSize: 11, fontVariantNumeric: "tabular-nums", pointerEvents: "none", borderRadius: 6 }} aria-hidden="true">
      {f == null ? "idle" : `${f} fps`}
      {mem.js != null && ` · JS ${mb(mem.js)}`}
      {` · frames ${mb(rasterBudget.total)}`}
      {mem.app != null && ` · app ${mb(mem.app)}`}
      {mem.gpu != null && ` · GPU proc ${mb(mem.gpu)}`}
    </div>
  );
}

/* ---------- banners ---------- */
const bannerStyle = { position: "fixed", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 80, padding: "8px 12px", display: "flex", gap: 8, alignItems: "center", borderRadius: 8, maxWidth: "calc(100vw - 24px)" } as const;
function Banners() {
  const s = safeInfo.value;
  if (glLost.value)
    return (
      <div class="glass" role="alert" style={bannerStyle}>
        <span>Map graphics were reset by the system.</span>
        <button class="btn sm" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  if (!s?.active || safeAnswered.value) return null;
  const why = s.reason === "crash" ? "after a crash" : s.reason === "flag" ? "(--safe-mode)" : "";
  return (
    <div class="glass" role="alert" style={bannerStyle}>
      <span>Started in safe mode {why} — one map, no satellite or 3D, Low-end performance.</span>
      {s.backup && (
        <button class="btn sm" onClick={restoreLayout}>
          Restore layout
        </button>
      )}
      <button class="btn sm ghost" onClick={keepSafe}>
        Keep safe
      </button>
    </div>
  );
}

let mounted = false;
export function mountPerfUi() {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const el = document.createElement("div");
  el.id = "tbw-perf-ui";
  document.body.appendChild(el);
  render(
    <>
      <PerfHud />
      <Banners />
    </>,
    el,
  );
}
