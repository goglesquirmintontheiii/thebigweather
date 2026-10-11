import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { api } from "../api";
import { settings, update } from "../store";
import { fmtBytes } from "../util";
import { Cpu, X, GripVertical } from "lucide-preact";

const stats = signal<any>(null);
const history = signal<number[]>([]);
api.on("hello", (m) => (stats.value = m.stats));
api.on("stats", (m) => {
  stats.value = m.stats;
  history.value = [...history.value, m.stats.cpu].slice(-40);
});

function Bar({ v }: { v: number }) {
  const cls = v > 85 ? "hi" : v > 60 ? "mid" : "";
  return (
    <span class={`mbar ${cls}`}>
      <i style={{ width: `${Math.min(100, Math.max(0, v))}%` }} />
    </span>
  );
}

export function StatsPanel() {
  const p = settings.value.panels.stats;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // keep on screen after window resizes
    const fix = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth || r.bottom > window.innerHeight) {
        update((s) => (s.panels.stats = { ...s.panels.stats, x: Math.max(8, window.innerWidth - r.width - 12), y: Math.max(8, Math.min(s.panels.stats.y, window.innerHeight - r.height - 12)) }));
      }
    };
    window.addEventListener("resize", fix);
    return () => window.removeEventListener("resize", fix);
  }, []);
  if (!p.open) return null;
  const s = stats.value;
  const x = p.x < 0 ? window.innerWidth - 232 : p.x;
  const onDown = (e: PointerEvent) => {
    const el = ref.current!;
    const ox = e.clientX - el.offsetLeft;
    const oy = e.clientY - el.offsetTop;
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - el.offsetWidth, ev.clientX - ox))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - el.offsetHeight, ev.clientY - oy))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      update((st) => (st.panels.stats = { ...st.panels.stats, x: el.offsetLeft, y: el.offsetTop }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const memPct = s ? (s.mem_used / s.mem_total) * 100 : 0;
  const diskPct = s && s.disk_total ? ((s.disk_total - s.disk_free) / s.disk_total) * 100 : 0;
  const h = history.value;
  const path = h.length > 1 ? h.map((v, i) => `${i === 0 ? "M" : "L"}${(i / 39) * 100},${30 - (v / 100) * 28}`).join(" ") : "";
  return (
    <div ref={ref} class="stats glass" style={{ left: `${x}px`, top: `${p.y}px` }}>
      <div class="stats-head" onPointerDown={onDown as any}>
        <GripVertical size={12} />
        <Cpu size={12} />
        <span>Server</span>
        <button class="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => update((st) => (st.panels.stats.open = false))}>
          <X size={12} />
        </button>
      </div>
      {s ? (
        <div class="stats-body">
          <div class="srow">
            <span>CPU</span>
            <Bar v={s.cpu} />
            <b>{s.cpu.toFixed(0)}%</b>
          </div>
          {path && (
            <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
              <path d={path} />
            </svg>
          )}
          <div class="srow">
            <span>RAM</span>
            <Bar v={memPct} />
            <b>{fmtBytes(s.mem_total - s.mem_used)} free</b>
          </div>
          <div class="srow">
            <span>Disk</span>
            <Bar v={diskPct} />
            <b>{fmtBytes(s.disk_free)} free</b>
          </div>
          <div class="srow net">
            <span>Net</span>
            <b>↓ {fmtBytes(s.net_rx_bps)}/s</b>
            <b>↑ {fmtBytes(s.net_tx_bps)}/s</b>
          </div>
        </div>
      ) : (
        <div class="stats-body muted small">No server data</div>
      )}
    </div>
  );
}
