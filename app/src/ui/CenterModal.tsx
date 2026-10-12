// Big centered window (forecast, weather radio, seismograph): Esc / × to close, header drag.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { X } from "lucide-preact";

export function CenterModal({ title, sub, icon, actions, onClose, children, cls = "", popped = false }: { title: ComponentChildren; sub?: ComponentChildren; icon?: ComponentChildren; actions?: ComponentChildren; onClose: () => void; children: ComponentChildren; cls?: string; popped?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (popped) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT") && (t as HTMLInputElement).value) return;
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, popped]);
  const drag = (e: PointerEvent) => {
    if (popped || (e.target as HTMLElement).closest("button,input,select,a")) return;
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
  const box = (
    <div ref={ref} class={`cmodal glass ${cls} ${popped ? "popped" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
      <div class="cm-head" onPointerDown={drag as any}>
        {icon && <span class="cm-icon">{icon}</span>}
        <div class="cm-title">
          <h2>{title}</h2>
          {sub && <small class="muted">{sub}</small>}
        </div>
        <div class="cm-actions">{actions}</div>
        {!popped && (
          <button class="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={17} />
          </button>
        )}
      </div>
      <div class="cm-body">{children}</div>
    </div>
  );
  if (popped) return box;
  return (
    <div class="cmodal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      {box}
    </div>
  );
}
