// Big centered window (forecast, weather radio, seismograph, …): header drag, Esc closes the top one.
// 0.8.2: shared Mac-style title bar (pop-out · close · minimize · maximize), open/close animation;
// in a pop-out OS window it fills the window and the title bar drags the window.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { WinButtons, IN_OS_WIN, isMin, isMax, minimize, toggleMax, forget, useEscClose, raiseWin, canPop, popWindow, onBarDbl, titleText, ghostOut } from "./winframe";
import { centerId } from "./wincore";

export function CenterModal({ title, sub, icon, actions, onClose, children, cls = "", popped: poppedProp = false }: { title: ComponentChildren; sub?: ComponentChildren; icon?: ComponentChildren; actions?: ComponentChildren; onClose: () => void; children: ComponentChildren; cls?: string; popped?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const popped = poppedProp || IN_OS_WIN;
  const id = centerId(cls, title);
  const min = !popped && isMin(id);
  const max = !popped && isMax(id);
  useEscClose(id, onClose, !popped && !min);
  // closed: forget minimized / maximized, fade a copy out
  useLayoutEffect(
    () => () => {
      if (!popped) {
        if (!isMin(id)) ghostOut(backRef.current);
        forget(id);
      }
    },
    [],
  );
  useEffect(() => {
    // maximize drops a dragged position; restore goes back to the centre
    const el = ref.current;
    if (el && !popped) for (const k of ["position", "margin", "left", "top"]) el.style.removeProperty(k);
  }, [max]);
  const drag = (e: PointerEvent) => {
    raiseWin(id);
    if (popped || max || (e.target as HTMLElement).closest("button,input,select,a")) return;
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const ox = e.clientX - r.left;
    const oy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      el.style.position = "fixed";
      el.style.margin = "0";
      el.style.left = `${Math.max(-r.width + 120, Math.min(window.innerWidth - 120, ev.clientX - ox))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 50, ev.clientY - oy))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const zoom = () => toggleMax(id);
  const box = (
    <div ref={ref} class={`cmodal glass ${cls} ${popped ? "popped" : ""}${max ? " wf-max" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
      <div class="cm-head wf-bar" onPointerDown={drag as any} onDblClick={popped ? undefined : (onBarDbl(zoom) as any)}>
        <WinButtons
          os={popped}
          onClose={onClose}
          onMin={() => minimize(id, titleText(title, ref.current, ".cm-title h2"), undefined, onClose)}
          onZoom={zoom}
          zoomed={max}
          onPop={canPop(id) ? () => popWindow(id) : undefined}
        />
        {icon && <span class="cm-icon">{icon}</span>}
        <div class="cm-title">
          <h2>{title}</h2>
          {sub && <small class="muted">{sub}</small>}
        </div>
        <div class="cm-actions">{actions}</div>
      </div>
      <div class="cm-body">{children}</div>
    </div>
  );
  if (popped) return box;
  return (
    <div ref={backRef} class={`cmodal-back${min ? " wf-minimized" : ""}${max ? " wf-maxback" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      {box}
    </div>
  );
}
