// A small draggable glass panel (cross-section, METAR, GPS track, …). Header drags; buttons don't.
// 0.8.2: shared Mac-style title bar (pop-out · close · minimize · maximize); double-click the title
// bar to maximize / restore; fills a pop-out OS window.

import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { WinButtons, IN_OS_WIN, isMin, isMax, minimize, toggleMax, forget, canPop, popWindow, onBarDbl, titleText, ghostOut, isPopped } from "./winframe";

let topZ = 30;

export function FloatPanel(props: { title: ComponentChildren; x: number; y: number; w?: number; cls?: string; onClose: () => void; tools?: ComponentChildren; children: ComponentChildren; onMove?: (x: number, y: number) => void; /** 0.8.2: window id (default from the class) */ wid?: string; /** 0.8.2: pop out another way */ onPopout?: () => void }) {
  const [pos, setPos] = useState<[number, number]>([props.x, props.y]);
  const [z, setZ] = useState(() => ++topZ);
  const ref = useRef<HTMLDivElement>(null);
  const id = props.wid ?? `f:${(props.cls ?? "").trim().split(/\s+/)[0] || titleText(props.title)}`;
  const os = IN_OS_WIN;
  const min = !os && isMin(id);
  const max = !os && isMax(id);
  useLayoutEffect(
    () => () => {
      if (os) return;
      if (!isMin(id)) ghostOut(ref.current);
      forget(id);
    },
    [],
  );
  const down = (e: PointerEvent) => {
    if (os || max || (e.target as HTMLElement).closest("button,input,select,a")) return;
    e.preventDefault();
    const sx = e.clientX - pos[0],
      sy = e.clientY - pos[1];
    const el = ref.current!;
    let p: [number, number] = pos;
    const move = (ev: PointerEvent) => {
      p = [Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - sx)), Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - sy))];
      el.style.left = `${p[0]}px`;
      el.style.top = `${p[1]}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPos(p);
      props.onMove?.(p[0], p[1]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  if (!os && isPopped(id) && !props.onPopout) return null; // shown in its own window
  const zoom = () => toggleMax(id);
  const onPop = props.onPopout ?? (canPop(id) ? () => popWindow(id) : undefined);
  return (
    <div
      ref={ref}
      class={`fpanel glass ${props.cls ?? ""}${min ? " wf-minimized" : ""}${max ? " wf-max" : ""}${os ? " wf-osframe" : ""}`}
      style={os ? undefined : { left: `${pos[0]}px`, top: `${pos[1]}px`, width: props.w ? `${props.w}px` : undefined, zIndex: max ? 36 : z }}
      onPointerDown={() => setZ(++topZ)}
    >
      <div class="fpanel-head wf-bar" onPointerDown={down as any} onDblClick={os ? undefined : (onBarDbl(zoom) as any)}>
        <WinButtons os={os} onClose={props.onClose} onMin={() => minimize(id, titleText(props.title, ref.current, ".fpanel-title"), undefined, props.onClose)} onZoom={zoom} zoomed={max} onPop={onPop} />
        <span class="fpanel-title">{props.title}</span>
        {props.tools}
      </div>
      <div class="fpanel-body">{props.children}</div>
    </div>
  );
}
