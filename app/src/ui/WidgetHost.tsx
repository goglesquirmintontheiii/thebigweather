// workflow 0.6: Widgets panel — add/remove desktop widgets, choose their point, opacity,
// always-on-top and click-through lock.

import { Plus, Trash2, Eye, EyeOff, Lock, Unlock, Pin, PinOff } from "lucide-preact";
import { settings } from "../store";
import { WIDGET_KINDS, addWidget, removeWidget, setWidget, canNativeWidgets } from "../widgets/manager";

export function WidgetsPanel() {
  const list = settings.value.wf6.widgets;
  const pts = settings.value.points;
  const native = canNativeWidgets();
  return (
    <div class="stack wg-panel">
      <section>
        <label class="lbl">Add a widget</label>
        <div class="wgp-kinds">
          {WIDGET_KINDS.map((k) => (
            <button key={k.kind} class="wgp-kind" onClick={() => addWidget(k.kind)} title={k.note}>
              <Plus size={13} />
              <span>
                <b>{k.name}</b>
                <small>{k.note}</small>
              </span>
            </button>
          ))}
        </div>
        <div class="muted small">
          {native ? "Small frameless windows on your desktop — drag anywhere to move, drag an edge to resize; positions are remembered. Locked widgets ignore the mouse (click-through)." : "In a browser, widgets open as small pop-up windows (always-on-top, opacity and click-through need the desktop app)."}
        </div>
      </section>
      <section>
        <label class="lbl">Your widgets</label>
        {list.length === 0 && <div class="muted small">None yet.</div>}
        {list.map((w) => {
          const k = WIDGET_KINDS.find((x) => x.kind === w.kind)!;
          const usesPoint = w.kind !== "clock" && w.kind !== "alerts";
          return (
            <div key={w.id} class={`wgp-row ${w.open ? "" : "closed"}`}>
              <div class="wgp-top">
                <b>{k.name}</b>
                <button class="icon-btn" title={w.open ? "Hide" : "Show"} onClick={() => setWidget(w.id, (x) => (x.open = !x.open))}>
                  {w.open ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                {native && (
                  <>
                    <button class={`icon-btn ${w.onTop ? "on" : ""}`} title={w.onTop ? "Always on top" : "Normal window"} onClick={() => setWidget(w.id, (x) => (x.onTop = !x.onTop))}>
                      {w.onTop ? <Pin size={14} /> : <PinOff size={14} />}
                    </button>
                    <button class={`icon-btn ${w.locked ? "on" : ""}`} title={w.locked ? "Locked (click-through) — click to unlock" : "Lock (click-through)"} onClick={() => setWidget(w.id, (x) => (x.locked = !x.locked))}>
                      {w.locked ? <Lock size={14} /> : <Unlock size={14} />}
                    </button>
                  </>
                )}
                <button class="icon-btn danger" title="Remove" onClick={() => removeWidget(w.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
              {usesPoint && (
                <div class="row">
                  <span>Point</span>
                  <select value={w.point} onChange={(e) => setWidget(w.id, (x) => (x.point = (e.target as HTMLSelectElement).value))}>
                    {pts.length === 0 && <option value="">Map center</option>}
                    {pts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {w.kind === "radar" && (
                <div class="row">
                  <span>Zoom</span>
                  <input type="range" min={4} max={10} value={w.zoom ?? 7} onChange={(e) => setWidget(w.id, (x) => (x.zoom = +(e.target as HTMLInputElement).value))} />
                  <span class="val">{w.zoom ?? 7}</span>
                </div>
              )}
              {native && (
                <div class="row">
                  <span>Opacity</span>
                  <input type="range" min={30} max={100} step={5} value={Math.round(w.opacity * 100)} onChange={(e) => setWidget(w.id, (x) => (x.opacity = +(e.target as HTMLInputElement).value / 100))} />
                  <span class="val">{Math.round(w.opacity * 100)}%</span>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
