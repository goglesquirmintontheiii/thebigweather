import { frameIndex, playing, stepFrame } from "../anim";
import { liveSweep } from "../radar/controller";
import { activeFrames, isForecast } from "../active";
import { settings } from "../store";
import { fmtTime } from "../util";
import { SkipBack, SkipForward } from "lucide-preact";

export function Timeline() {
  const fs = activeFrames.value;
  if (fs.length < 2) return null;
  const idx = Math.min(frameIndex.value, fs.length - 1);
  const cur = fs[idx];
  const set = (i: number) => {
    playing.value = false;
    frameIndex.value = i;
  };
  const many = fs.length > 48;
  const radar = settings.value.weather.kind === "radar";
  return (
    <div class="timeline glass">
      <button class="icon-btn" onClick={() => stepFrame(-1)} title="Previous frame (←)">
        <SkipBack size={14} />
      </button>
      {many ? (
        <input class="tl-range" type="range" min={0} max={fs.length - 1} value={idx} onInput={(e) => set(+(e.target as HTMLInputElement).value)} />
      ) : (
        <div class="ticks">
          {fs.map((f, i) => (
            <button
              key={f.key}
              class={`tick ${i === idx ? "on" : ""} ${f.state === "ok" ? "ok" : f.state === "err" ? "err" : ""} ${f.live ? "live" : ""}`}
              title={`${f.label ? f.label + " · " : ""}${fmtTime(f.time, true)}`}
              onClick={() => set(i)}
            />
          ))}
          {radar && liveSweep.value && <span class="tick live-partial" title="Sweep in progress" />}
        </div>
      )}
      <span class="tl-time">
        {isForecast.value && cur?.label ? <b class="tl-fh">{cur.label}</b> : null}
        {fmtTime(cur?.time ?? 0, isForecast.value)}
      </span>
      <button class="icon-btn" onClick={() => stepFrame(1)} title="Next frame (→)">
        <SkipForward size={14} />
      </button>
    </div>
  );
}
