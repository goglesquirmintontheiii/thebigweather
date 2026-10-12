// Timeline record button: record the radar(s) on screen now (one server recording per site).

import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Circle, Square, X } from "lucide-preact";
import { settings } from "../store";
import { productName } from "../radar/controller";
import { radarRec, radarRecActive, radarRecPlan, startRadarRec, stopRadarRec, forgetRadarRec, fmtElapsed } from "../radarrec";
import { loadRecs } from "./panels/RecordPanel";

const DUR: [number, string][] = [
  [0, "Until stopped"],
  [30, "30 min"],
  [60, "1 h"],
  [120, "2 h"],
  [360, "6 h"],
];

/** the timeline clips its children: place the popover in window coordinates, above the button */
function popPos(el: HTMLElement | null) {
  if (!el) return {};
  const r = el.getBoundingClientRect();
  return { left: `${Math.max(8, Math.min(window.innerWidth - 318, r.right - 300))}px`, bottom: `${window.innerHeight - r.top + 14}px` };
}

export function RadarRecButton() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [mins, setMins] = useState(0);
  const [, tick] = useState(0);
  const on = radarRecActive.value;
  const r = radarRec.value;
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    // the server ends timed recordings: notice it
    const p = setInterval(loadRecs, 10_000);
    return () => (clearInterval(t), clearInterval(p));
  }, [on]);
  // ended on its own: forget it
  useEffect(() => {
    if (r && !on) forgetRadarRec();
  }, [on]);
  if (settings.value.weather.kind !== "radar" && !on) return null;
  const plan = radarRecPlan();
  const src = settings.value.radar.source;
  return (
    <span class="rrec">
      {open &&
        !on &&
        createPortal(
          <div class="rrec-pop glass" style={popPos(btn.current)}>
            <div class="tl-pop-head">
              <b>Record radar</b>
              <button class="icon-btn" onClick={() => setOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <div class="rrec-what">
              <span class="muted">Radars</span>
              <b>{plan.map((p) => p.site).join(", ")}</b>
              <span class="muted">Product</span>
              <b>{src === "L2" ? "Level II · all products" : `${productName(plan[0]?.products[0] ?? "")} (L3)`}</b>
            </div>
            <div class="chips">
              {DUR.map(([m, l]) => (
                <button key={m} class={`chip ${mins === m ? "on" : ""}`} onClick={() => setMins(m)}>
                  {l}
                </button>
              ))}
            </div>
            <button class="btn sm rec-btn" onClick={() => (setOpen(false), startRadarRec(mins))}>
              <Circle size={12} class="rec-dot" /> Start
            </button>
            <p class="muted small">Saved on the server · Recordings panel to play back.</p>
          </div>,
          document.body,
        )}
      <button ref={btn} class={`tl-btn rrec-btn ${on ? "rec-on" : open ? "on" : ""}`} title={on ? "Stop radar recording" : "Record radar"} onClick={() => (on ? stopRadarRec() : setOpen(!open))}>
        {on ? (
          <>
            <i class="rec-pulse" />
            <span>{fmtElapsed(Date.now() - (r?.start ?? Date.now()))}</span>
            <Square size={11} />
          </>
        ) : (
          <Circle size={12} class="rec-dot" />
        )}
      </button>
    </span>
  );
}
