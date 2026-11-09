// 0.8.4: RainViewer radars whose picture has its own basemap and legend can't be laid over the map:
// the agency's image animates in this floating panel instead, on the normal timeline.

import { X } from "lucide-preact";
import { settings, update } from "../store";
import { frameIndex } from "../anim";
import { intlPanelFrames, intlSource, intlTimes } from "../intl/radar";

export function RvPanel() {
  const w = settings.value.weather;
  if (w.kind !== "intl") return null;
  const s = intlSource(w.id);
  if (s?.display !== "panel") return null;
  const urls = intlPanelFrames();
  const cur = Math.max(0, Math.min(frameIndex.value, urls.length - 1));
  const t = intlTimes.value[cur];
  return (
    <div class="rv-panel glass">
      <div class="rv-panel-head">
        <b>{s.name}</b>
        {t ? <small class="muted">{new Date(t).toISOString().slice(11, 16)} UTC</small> : null}
        <button class="icon-btn" title="Close" aria-label="Close" onClick={() => update((x) => (x.weather = { kind: "radar" }))}>
          <X size={14} />
        </button>
      </div>
      <div class="rv-panel-stage">
        {urls.map((u, i) => (
          <img key={u} src={u} alt="" style={{ visibility: i === cur ? "visible" : "hidden" }} />
        ))}
        {!urls.length && <div class="muted">No images right now</div>}
      </div>
      <small class="muted">{s.attribution} · agency image, not aligned to the map</small>
    </div>
  );
}
