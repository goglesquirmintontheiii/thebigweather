import { toasts } from "../store";
import { contextMenu, addPointAt, hover } from "../map/mapview";
import { displaySweep, activeTable } from "../radar/controller";
import { sampleAt } from "../radar/sweep";
import { fmtValue } from "../util";
import { toast } from "../store";

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast glass ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ContextMenu() {
  const m = contextMenu.value;
  if (!m) return null;
  void hover.value;
  const s = displaySweep.value;
  const r = s ? sampleAt(s, m.lat, m.lon) : null;
  const close = () => (contextMenu.value = null);
  return (
    <div class="ctx glass" style={{ left: `${m.x + 8}px`, top: `${m.y + 8}px` }} onMouseLeave={close}>
      <div class="ctx-title">
        {m.lat.toFixed(4)}, {m.lon.toFixed(4)}
        {r && !Number.isNaN(r.value) && <b> · {fmtValue(r.value, activeTable.value.units, activeTable.value.labels)}</b>}
      </div>
      <button
        onClick={() => {
          addPointAt(m.lat, m.lon);
          close();
        }}
      >
        Add point here
      </button>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(`${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}`);
          toast("Copied coordinates");
          close();
        }}
      >
        Copy coordinates
      </button>
    </div>
  );
}
