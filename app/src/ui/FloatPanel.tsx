// A small draggable glass panel (cross-section, METAR, GPS track). Header drags; buttons don't.

import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { X } from "lucide-preact";

let topZ = 30;

export function FloatPanel(props: { title: ComponentChildren; x: number; y: number; w?: number; cls?: string; onClose: () => void; tools?: ComponentChildren; children: ComponentChildren; onMove?: (x: number, y: number) => void }) {
  const [pos, setPos] = useState<[number, number]>([props.x, props.y]);
  const [z, setZ] = useState(() => ++topZ);
  const ref = useRef<HTMLDivElement>(null);
  const down = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,select,a")) return;
    e.preventDefault();
    const sx = e.clientX - pos[0], sy = e.clientY - pos[1];
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
  return (
    <div ref={ref} class={`fpanel glass ${props.cls ?? ""}`} style={{ left: `${pos[0]}px`, top: `${pos[1]}px`, width: props.w ? `${props.w}px` : undefined, zIndex: z }} onPointerDown={() => setZ(++topZ)}>
      <div class="fpanel-head" onPointerDown={down as any}>
        <span class="fpanel-title">{props.title}</span>
        {props.tools}
        <button class="icon-btn" title="Close" onClick={props.onClose}>
          <X size={14} />
        </button>
      </div>
      <div class="fpanel-body">{props.children}</div>
    </div>
  );
}
