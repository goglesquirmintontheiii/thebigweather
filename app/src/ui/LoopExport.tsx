// "Export loop" dialog (toolbar) and the progress bar with cancel.

import { loopDialog, loopProgress, loopOpts, runLoopExport, cancelLoopExport, mp4Supported, canWindow, type LoopOpts } from "../loopexport";
import { frameCount } from "../anim";
import { X, Film } from "lucide-preact";
import { mapRef } from "../map/mapview";
import { createPortal } from "preact/compat";

const set = (p: Partial<LoopOpts>) => (loopOpts.value = { ...loopOpts.value, ...p });

export function LoopExportDialog() {
  const pr = loopProgress.value;
  if (pr)
    return (
      <div class="loopx loopx-prog glass">
        <Film size={14} />
        <span>
          {pr.phase === "capture" ? "Capturing" : "Encoding"} {pr.i + 1}/{pr.n}
        </span>
        <div class="loopx-bar">
          <i style={{ width: `${((pr.i + 1) / pr.n) * 100}%` }} />
        </div>
        <button class="btn sm ghost" onClick={cancelLoopExport}>
          Cancel
        </button>
      </div>
    );
  if (!loopDialog.value) return null;
  const o = loopOpts.value;
  const n = frameCount.value;
  const mp4 = mp4Supported();
  const est = Math.max(1, n) * Math.max(1, o.loops || 1) / o.fps;
  const r = mapRef.value?.getContainer().getBoundingClientRect();
  return (
    <>
    {o.area === "crop" && r && createPortal(
      <div class="loopx loopx-crop" style={{ left: `${r.left + (r.width - Math.min(r.width, o.crop[0])) / 2}px`, top: `${r.top + (r.height - Math.min(r.height, o.crop[1])) / 2}px`, width: `${Math.min(r.width, o.crop[0])}px`, height: `${Math.min(r.height, o.crop[1])}px` }} />,
      document.body,
    )}
    <div class="loopx loopx-dlg glass">
      <div class="loopx-head">
        <b>Export loop</b>
        <small class="muted">{n} frames</small>
        <button class="icon-btn" title="Close" onClick={() => (loopDialog.value = false)}>
          <X size={14} />
        </button>
      </div>
      <div class="seg">
        {(["gif", "mp4", "webm"] as const).map((f) => (
          <button key={f} class={o.format === f ? "on" : ""} disabled={f === "mp4" && !mp4} title={f === "mp4" && !mp4 ? "MP4 isn't supported here — use WebM" : undefined} onClick={() => set({ format: f })}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      <div class="row">
        <span>Area</span>
        <select value={o.area} onChange={(e) => set({ area: (e.target as HTMLSelectElement).value as any })}>
          <option value="map">Map</option>
          <option value="crop">Map, cropped</option>
          <option value="window" disabled={!canWindow()}>
            Whole window
          </option>
        </select>
      </div>
      {o.area === "crop" && (
        <div class="row">
          <span>Size</span>
          <input type="number" min={160} max={4000} step={10} value={o.crop[0]} onInput={(e) => set({ crop: [+(e.target as HTMLInputElement).value || 800, o.crop[1]] })} />
          <span>×</span>
          <input type="number" min={120} max={4000} step={10} value={o.crop[1]} onInput={(e) => set({ crop: [o.crop[0], +(e.target as HTMLInputElement).value || 600] })} />
        </div>
      )}
      <div class="row">
        <span>Scale</span>
        <select value={String(o.scale)} onChange={(e) => set({ scale: +(e.target as HTMLSelectElement).value })}>
          <option value="1">100%</option>
          <option value="0.75">75%</option>
          <option value="0.5">50%</option>
        </select>
        <span>FPS</span>
        <select value={String(o.fps)} onChange={(e) => set({ fps: +(e.target as HTMLSelectElement).value })}>
          {[2, 3, 4, 6, 8, 10, 12, 15].map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <div class="row">
        <span>Loops</span>
        <select value={String(o.loops)} onChange={(e) => set({ loops: +(e.target as HTMLSelectElement).value })}>
          {o.format === "gif" && <option value="0">Forever</option>}
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
        {o.area !== "window" && (
          <label class="chk">
            <input type="checkbox" checked={o.decor} onChange={(e) => set({ decor: (e.target as HTMLInputElement).checked })} /> Legend &amp; time
          </label>
        )}
      </div>
      <button
        class="btn"
        disabled={n < 1}
        onClick={() => {
          if (o.format !== "gif" && o.loops === 0) set({ loops: 1 });
          runLoopExport();
        }}
      >
        <Film size={14} /> Export{o.format !== "gif" ? ` · ~${Math.ceil(est)} s` : ""}
      </button>
      <div class="muted small">Saved to Downloads/TheBigWeather</div>
    </div>
    </>
  );
}
