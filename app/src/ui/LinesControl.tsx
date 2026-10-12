// data 0.6: "Contours" and "Wind barbs" controls for gridded layers, docked above the legend.

import { useEffect, useState } from "preact/hooks";
import { Spline, Wind, ChevronDown } from "lucide-preact";
import { settings } from "../store";
import { d6, setD6, linesTarget, contourFields, preset, displayUnit, linesStatus } from "../grid/contours";

const LEVELS: [string, string][] = [
  ["10m", "10 m"],
  ["850", "850 hPa"],
  ["500", "500 hPa"],
  ["250", "250 hPa"],
];

/** keep the dock just above the legend (it moves with the legend's size and position) */
function useAnchor() {
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  useEffect(() => {
    const upd = () => {
      const el = document.querySelector<HTMLElement>(".legend:not(.top)");
      if (!el) return setPos({ right: 12, bottom: 120 });
      const r = el.getBoundingClientRect();
      setPos({ right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.top + 6) });
    };
    upd();
    const t = setInterval(upd, 700);
    window.addEventListener("resize", upd);
    return () => (clearInterval(t), window.removeEventListener("resize", upd));
  }, []);
  return pos;
}

export function LinesControl() {
  const t = linesTarget.value;
  const pos = useAnchor();
  const [open, setOpen] = useState(false);
  void settings.value.data6;
  if (!t || !pos) return null;
  const o = d6();
  const fields = contourFields();
  const cdef = t.cdef;
  const p = preset(cdef);
  const st = linesStatus.value;
  const unit = displayUnit(cdef);
  return (
    <div class="d6-lines glass" style={{ right: `${pos.right}px`, bottom: `${pos.bottom}px` }}>
      <div class="d6-row">
        <button class={`chip ${o.contours ? "on" : ""}`} title="Contour lines with labels" onClick={() => setD6((d) => (d.contours = !d.contours))}>
          <Spline size={13} /> Contours
        </button>
        <button class={`chip ${o.barbs ? "on" : ""}`} title={t.wave ? "Wave direction arrows" : "Wind barbs (knots)"} disabled={!t.model} onClick={() => setD6((d) => (d.barbs = !d.barbs))}>
          <Wind size={13} /> {t.wave ? "Wave arrows" : "Barbs"}
        </button>
        <button class={`icon-btn ${open ? "on" : ""}`} title="Contour and barb settings" onClick={() => setOpen(!open)}>
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <div class="d6-opts">
          <label>
            <span>Contour</span>
            <select value={o.cfield} onChange={(e) => setD6((d) => ((d.cfield = (e.target as HTMLSelectElement).value), (d.interval = undefined), (d.base = undefined)))}>
              <option value="">Layer on screen</option>
              {t.model &&
                fields
                  .filter((f) => f.id !== t.layer.id)
                  .map((f) => (
                    <option key={f.id} value={f.id.split("/").pop()}>
                      {f.name}
                    </option>
                  ))}
            </select>
          </label>
          <label>
            <span>Every</span>
            <input type="number" step="any" min="0" placeholder={p ? String(p.interval) : "auto"} value={o.interval ?? ""} onChange={(e) => setD6((d) => (d.interval = (e.target as HTMLInputElement).value === "" ? undefined : +(e.target as HTMLInputElement).value))} />
            <small class="muted">{unit}</small>
          </label>
          <label>
            <span>From</span>
            <input type="number" step="any" placeholder={p ? String(p.base) : "auto"} value={o.base ?? ""} onChange={(e) => setD6((d) => (d.base = (e.target as HTMLInputElement).value === "" ? undefined : +(e.target as HTMLInputElement).value))} />
            <small class="muted">{unit}</small>
          </label>
          <label>
            <span>Color</span>
            <input type="color" value={o.ccolor} onInput={(e) => setD6((d) => (d.ccolor = (e.target as HTMLInputElement).value))} />
            <label class="d6-chk">
              <input type="checkbox" checked={o.labels} onChange={(e) => setD6((d) => (d.labels = (e.target as HTMLInputElement).checked))} /> Labels
            </label>
          </label>
          {t.model && !t.wave && (
            <label>
              <span>Barbs</span>
              <div class="seg sm">
                {LEVELS.map(([k, n]) => (
                  <button key={k} class={o.blevel === k ? "on" : ""} onClick={() => setD6((d) => (d.blevel = k as any))}>
                    {n}
                  </button>
                ))}
              </div>
            </label>
          )}
          {t.model && (
            <label>
              <span>{t.wave ? "Arrows" : "Barb color"}</span>
              <input type="color" value={o.bcolor} onInput={(e) => setD6((d) => (d.bcolor = (e.target as HTMLInputElement).value))} />
            </label>
          )}
        </div>
      )}
      {(st.contours || st.barbs || st.loading) && (
        <div class="d6-st muted">
          {st.loading ? "Loading…" : [st.contours, st.barbs].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}
