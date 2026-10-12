// Floating stats panels: server (CPU/RAM/disk/net + its process) and app (this computer's
// Electron processes, JS heap, FPS, HTTP traffic). When the server runs on this computer the two
// merge into one panel: System / Server process / App.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { api } from "../api";
import { settings, update } from "../store";
import { fmtBytes } from "../util";
import { client, clientHist, sameHost, useClientStats, hasIpc, type ClientStats } from "../clientstats";
import { Cpu, X, GripVertical, MonitorCog, Server } from "lucide-preact";

const stats = signal<any>(null);
const history = signal<number[]>([]);
let lastPush = 0;
/** handles the flat Stats shape and a nested {system, process} one */
function norm(s: any) {
  if (!s) return s;
  const sys = s.system ?? {};
  const pr = s.process ?? s.proc ?? {};
  const o = { ...sys, ...s };
  o.proc_cpu = s.proc_cpu ?? pr.cpu ?? pr.cpu_percent;
  o.proc_rss = s.proc_rss ?? pr.rss ?? pr.mem ?? pr.rss_bytes;
  o.proc_threads = s.proc_threads ?? pr.threads;
  return o;
}
function push(s: any) {
  s = norm(s);
  if (!s || typeof s.cpu !== "number") return;
  stats.value = s;
  history.value = [...history.value, s.cpu].slice(-40);
}
api.on("hello", (m) => m.stats && (stats.value = norm(m.stats)));
api.on("stats", (m) => {
  lastPush = Date.now();
  push(m.stats);
});

/** poll /api/stats when the socket isn't pushing (older servers, proxies that drop WS) */
function useServerPoll(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const tick = () => Date.now() - lastPush > 8000 && api.get("/api/stats").then(push).catch(() => {});
    tick();
    const t = window.setInterval(tick, 4000);
    return () => clearInterval(t);
  }, [on, settings.value.activeServer]);
}

function Bar({ v }: { v: number }) {
  const cls = v > 85 ? "hi" : v > 60 ? "mid" : "";
  return (
    <span class={`mbar ${cls}`}>
      <i style={{ width: `${Math.min(100, Math.max(0, v))}%` }} />
    </span>
  );
}

function Spark({ h }: { h: number[] }) {
  if (h.length < 2) return null;
  const path = h.map((v, i) => `${i === 0 ? "M" : "L"}${(i / 39) * 100},${30 - (Math.min(100, v) / 100) * 28}`).join(" ");
  return (
    <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
      <path d={path} />
    </svg>
  );
}

const upTxt = (sec: number) => {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

type PanelKey = "stats" | "appstats";

/** draggable glass box whose position lives in settings.panels[key] */
function Floater({ pk, title, icon, onClose, children, w = 220 }: { pk: PanelKey; title: string; icon: ComponentChildren; onClose: () => void; children: ComponentChildren; w?: number }) {
  const p = settings.value.panels[pk] ?? { open: true, x: -1, y: 300 };
  const ref = useRef<HTMLDivElement>(null);
  const setPos = (x: number, y: number) => update((st) => (st.panels[pk] = { ...(st.panels[pk] ?? { open: true }), x, y } as any));
  useEffect(() => {
    const fix = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth || r.bottom > window.innerHeight) setPos(Math.max(8, window.innerWidth - r.width - 12), Math.max(8, Math.min(p.y, window.innerHeight - r.height - 12)));
    };
    window.addEventListener("resize", fix);
    return () => window.removeEventListener("resize", fix);
  }, [p.y]);
  const x = p.x < 0 ? window.innerWidth - w - 12 : Math.max(0, Math.min(p.x, window.innerWidth - w - 10));
  const y = Math.max(0, Math.min(p.y, window.innerHeight - 120));
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
      setPos(el.offsetLeft, el.offsetTop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} class={`stats glass stats-${pk}`} style={{ left: `${x}px`, top: `${y}px`, width: `${w}px` }}>
      <div class="stats-head" onPointerDown={onDown as any}>
        <GripVertical size={12} />
        {icon}
        <span>{title}</span>
        <button class="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      {children}
    </div>
  );
}

/** machine-wide rows from the server's stats */
function SystemRows({ s }: { s: any }) {
  const memPct = (s.mem_used / s.mem_total) * 100;
  const cpuTip = [
    s.cpu_name ? `${s.cpu_name}` : "",
    `${s.cores} threads${s.cpu_mhz ? ` · ${(s.cpu_mhz / 1000).toFixed(2)} GHz` : ""}`,
    s.load1 != null ? `Load avg ${s.load1?.toFixed(2)} / ${s.load5?.toFixed(2)} / ${s.load15?.toFixed(2)}` : "",
    s.per_core?.length ? `Per core: ${s.per_core.map((c: number) => Math.round(c)).join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const memTip = [`Used ${fmtBytes(s.mem_used)} of ${fmtBytes(s.mem_total)} (${memPct.toFixed(0)}%)`, `Available ${fmtBytes(s.mem_available ?? s.mem_total - s.mem_used)}`, s.swap_total ? `Swap ${fmtBytes(s.swap_used)} / ${fmtBytes(s.swap_total)}` : "No swap"].join("\n");
  const diskTip = [`${s.disk_mount || "data"}${s.disk_fs ? ` (${s.disk_fs})` : ""}`, `Free ${fmtBytes(s.disk_free)} of ${fmtBytes(s.disk_total)}`, "Holds the radar/model download cache"].join("\n");
  const netTip = [`Total since start: ↓ ${fmtBytes(s.net_rx_total ?? 0)}  ↑ ${fmtBytes(s.net_tx_total ?? 0)}`, `${s.clients} app${s.clients === 1 ? "" : "s"} connected · up ${upTxt(s.uptime)}`].join("\n");
  const diskPct = s.disk_total ? ((s.disk_total - s.disk_free) / s.disk_total) * 100 : 0;
  return (
    <>
      <div class="srow" data-tip={cpuTip}>
        <span>CPU</span>
        <Bar v={s.cpu} />
        <b>{s.cpu.toFixed(0)}%</b>
      </div>
      <Spark h={history.value} />
      <div class="srow" data-tip={memTip}>
        <span>RAM</span>
        <Bar v={memPct} />
        <b>{fmtBytes(s.mem_total - s.mem_used)} free</b>
      </div>
      <div class="srow" data-tip={diskTip}>
        <span>Disk</span>
        <Bar v={diskPct} />
        <b>{fmtBytes(s.disk_free)} free</b>
      </div>
      <div class="srow net" data-tip={netTip}>
        <span>Net</span>
        <b>↓ {fmtBytes(s.net_rx_bps)}/s</b>
        <b>↑ {fmtBytes(s.net_tx_bps)}/s</b>
      </div>
    </>
  );
}

function ServerProcRows({ s }: { s: any }) {
  const rssPct = s.proc_rss && s.mem_total ? (s.proc_rss / s.mem_total) * 100 : 0;
  return (
    <>
      <div class="srow" data-tip={`TheBigWeather server process\n${s.proc_cpu != null ? `${s.proc_cpu.toFixed(1)}% of the whole machine` : "CPU not reported"}`}>
        <span>CPU</span>
        <Bar v={s.proc_cpu ?? 0} />
        <b>{s.proc_cpu != null ? `${s.proc_cpu.toFixed(0)}%` : "—"}</b>
      </div>
      <div class="srow" data-tip={`Resident memory ${fmtBytes(s.proc_rss ?? 0)}${s.proc_threads ? `\n${s.proc_threads} threads` : ""}`}>
        <span>RAM</span>
        <Bar v={rssPct} />
        <b>{s.proc_rss != null ? fmtBytes(s.proc_rss) : "—"}</b>
      </div>
      <div class="srow net">
        <span>Apps</span>
        <b>{s.clients ?? 0} connected</b>
        <b>up {upTxt(s.uptime ?? 0)}</b>
      </div>
    </>
  );
}

/** this computer's CPU/RAM (when the server is elsewhere, or no server data) */
function ClientSystemRows({ c }: { c: ClientStats }) {
  if (!c.mem_total) return null;
  const used = c.mem_total - c.mem_available;
  return (
    <>
      <div class="srow" data-tip={[c.cpu_name, `${c.cores} threads`, c.load ? `Load avg ${c.load.map((x) => x.toFixed(2)).join(" / ")}` : ""].filter(Boolean).join("\n")}>
        <span>CPU</span>
        <Bar v={c.sys_cpu ?? 0} />
        <b>{c.sys_cpu != null ? `${c.sys_cpu.toFixed(0)}%` : "—"}</b>
      </div>
      <div class="srow" data-tip={`Used ${fmtBytes(used)} of ${fmtBytes(c.mem_total)}`}>
        <span>RAM</span>
        <Bar v={(used / c.mem_total) * 100} />
        <b>{fmtBytes(c.mem_available)} free</b>
      </div>
    </>
  );
}

function AppRows({ c }: { c: ClientStats }) {
  const pr = c.procs;
  const memPct = c.mem_total ? (c.app_mem / c.mem_total) * 100 : 0;
  const memTip = [`All app processes ${fmtBytes(c.app_mem)}`, ...Object.entries(pr).map(([k, v]) => `${k === "main" ? "Main" : k === "renderer" ? "Window" : k === "gpu" ? "GPU" : "Other"}${v.n > 1 ? ` ×${v.n}` : ""}: ${fmtBytes(v.mem)} · ${(v.cpu / Math.max(1, c.cores)).toFixed(1)}% CPU`)].join("\n");
  const heapPct = c.heap_used && c.heap_limit ? (c.heap_used / c.heap_limit) * 100 : 0;
  const ipc = hasIpc();
  return (
    <>
      {ipc && (
        <>
          <div class="srow" data-tip={`TheBigWeather app, all processes\n${c.app_cpu.toFixed(1)}% of the whole machine (${c.cores} threads)`}>
            <span>CPU</span>
            <Bar v={c.app_cpu} />
            <b>{c.app_cpu.toFixed(c.app_cpu < 10 ? 1 : 0)}%</b>
          </div>
          <Spark h={clientHist.value} />
          <div class="srow" data-tip={memTip}>
            <span>RAM</span>
            <Bar v={memPct} />
            <b>{fmtBytes(c.app_mem)}</b>
          </div>
          {pr.gpu && (
            <div class="srow" data-tip={`GPU process memory (driver-side buffers not included)\n${(pr.gpu.cpu / Math.max(1, c.cores)).toFixed(1)}% CPU`}>
              <span>GPU</span>
              <Bar v={c.mem_total ? (pr.gpu.mem / c.mem_total) * 100 : 0} />
              <b>{fmtBytes(pr.gpu.mem)}</b>
            </div>
          )}
        </>
      )}
      {c.heap_used != null && (
        <div class="srow" data-tip={`JavaScript heap ${fmtBytes(c.heap_used)} of ${fmtBytes(c.heap_limit ?? 0)} limit`}>
          <span>Heap</span>
          <Bar v={heapPct} />
          <b>{fmtBytes(c.heap_used)}</b>
        </div>
      )}
      <div class="srow net" data-tip={`Map frames per second (idle when nothing changes)\nHTTP received since start: ${fmtBytes(c.net_rx_total)} (WebSocket not counted)`}>
        <span>FPS</span>
        <b>{c.fps == null ? "idle" : `${c.fps}`}</b>
        <b>↓ {fmtBytes(c.net_rx_bps)}/s</b>
      </div>
    </>
  );
}

function Sec({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <>
      <div class="ssec">{title}</div>
      {children}
    </>
  );
}

function ClientPoll() {
  useEffect(() => useClientStats(), []);
  return null;
}

export function StatsPanel() {
  const ps = settings.value.panels;
  const srvOn = ps.stats.open;
  const appOn = !!ps.appstats?.open;
  const merged = sameHost.value && (srvOn || appOn);
  useServerPoll(srvOn || merged);
  const s = stats.value;
  const c = client.value;
  if (merged)
    return (
      <>
        <ClientPoll />
        <Floater pk="stats" title="This computer" icon={<Cpu size={12} />} w={232} onClose={() => update((x) => ((x.panels.stats = { ...x.panels.stats, open: false }), (x.panels.appstats = { ...(x.panels.appstats ?? { x: -1, y: 300 }), open: false })))}>
          <div class="stats-body">
            <Sec title="System">{s ? <SystemRows s={s} /> : c ? <ClientSystemRows c={c} /> : <div class="muted small">No data</div>}</Sec>
            {s && (
              <Sec title="Server process">
                <ServerProcRows s={s} />
              </Sec>
            )}
            <Sec title="App">{c ? <AppRows c={c} /> : <div class="muted small">…</div>}</Sec>
          </div>
        </Floater>
      </>
    );
  return (
    <>
      {srvOn && (
        <Floater pk="stats" title="Server" icon={<Server size={12} />} onClose={() => update((st) => (st.panels.stats = { ...st.panels.stats, open: false }))}>
          {s ? (
            <div class="stats-body">
              <SystemRows s={s} />
              {(s.proc_cpu != null || s.proc_rss != null) && (
                <Sec title="Server process">
                  <ServerProcRows s={s} />
                </Sec>
              )}
            </div>
          ) : (
            <div class="stats-body muted small">No server data</div>
          )}
        </Floater>
      )}
      {appOn && (
        <>
          <ClientPoll />
          <Floater pk="appstats" title="App" icon={<MonitorCog size={12} />} onClose={() => update((st) => (st.panels.appstats = { ...(st.panels.appstats ?? { x: -1, y: 300 }), open: false }))}>
            <div class="stats-body">
              {c ? (
                <>
                  {c.mem_total > 0 && (
                    <Sec title={c.hostname ? `This computer · ${c.hostname}` : "This computer"}>
                      <ClientSystemRows c={c} />
                    </Sec>
                  )}
                  <Sec title="App">
                    <AppRows c={c} />
                  </Sec>
                </>
              ) : (
                <div class="muted small">…</div>
              )}
            </div>
          </Floater>
        </>
      )}
    </>
  );
}
