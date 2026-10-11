import { frames, frameIndex, playing, liveSweep } from "../radar/controller";
import { fmtTime } from "../util";
import { SkipBack, SkipForward } from "lucide-preact";

export function Timeline() {
  const fs = frames.value;
  if (fs.length < 2) return null;
  const idx = frameIndex.value;
  const go = (d: number) => {
    playing.value = false;
    frameIndex.value = (idx + d + fs.length) % fs.length;
  };
  return (
    <div class="timeline glass">
      <button class="icon-btn" onClick={() => go(-1)} title="Previous frame (←)">
        <SkipBack size={14} />
      </button>
      <div class="ticks">
        {fs.map((f, i) => (
          <button
            key={f.key}
            class={`tick ${i === idx ? "on" : ""} ${f.sweep ? "ok" : f.error ? "err" : ""} ${f.live ? "live" : ""}`}
            title={fmtTime(f.sweep?.start ?? f.time, true)}
            onClick={() => {
              playing.value = false;
              frameIndex.value = i;
            }}
          />
        ))}
        {liveSweep.value && <span class="tick live-partial" title="Sweep in progress" />}
      </div>
      <span class="tl-time">{fmtTime(fs[idx]?.sweep?.start ?? fs[idx]?.time)}</span>
      <button class="icon-btn" onClick={() => go(1)} title="Next frame (→)">
        <SkipForward size={14} />
      </button>
    </div>
  );
}
