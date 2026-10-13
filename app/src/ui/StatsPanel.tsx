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
import { Cpu, X, GripVertical, MonitorCog, Server, Minimize2, Maximize2 } from "lucide-preact";

const stats = signal<any>(null);
const history = signal<number[]>([]);
let lastPush = 0;
/** handles the flat Stats shape and a nested {system, process} one */
function norm(s: any) {
  if (!s) return s;
  const sys = s.system ?? {};
  const pr = s.process ?? s.proc ?? {};
  const o = { ...sys, ...s };
  // server: proc_cpu = % of the whole machine (0–100) when proc_cpu_cores (% of one core) is sent;
  // older servers sent proc_cpu per core and proc_cpu_pct per machine
  const cores = Number(s.cores ?? sys.cores) || 1;
  if (s.proc_cpu_cores != null) {
    o.proc_cpu = s.proc_cpu;
    o.proc_cpu_cores = s.proc_cpu_cores;
  } else if (s.proc_cpu_pct != null || s.proc_cpu != null) {
    o.proc_cpu = s.proc_cpu_pct ?? Math.min(100, s.proc_cpu / cores);
    o.proc_cpu_cores = s.proc_cpu != null ? s.proc_cpu : s.proc_cpu_pct * cores;
  } else {
    const c = pr.cpu ?? pr.cpu_percent;
    o.proc_cpu = c;
  }
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
/* radio/dash 0.8: resizable stats panels — the corner handle scales the whole panel (content
 * included); the scale is remembered per panel (and per mini/full variant). */
const SCALE_KEY = "tbw.stats.scale";
const scales = signal<Record<string, number>>((() => {
  try {
    return JSON.parse(localStorage.getItem(SCALE_KEY) || "{}") || {};
  } catch {
    return {};
  }
})());
function setScale(k: string, v: number | null) {
  const n = { ...scales.value };
  if (v == null) delete n[k];
  else n[k] = Math.round(v * 100) / 100;
  scales.value = n;
  try {
    localStorage.setItem(SCALE_KEY, JSON.stringify(n));
  } catch {
    /* ignore */
  }
}
const MIN_SCALE = 0.75;
const MAX_SCALE = 2.5;

function Floater({ pk, title, icon, onClose, children, w: w0 = 220, cls = "", extra }: { pk: PanelKey; title: ComponentChildren; icon: ComponentChildren; onClose: () => void; children: ComponentChildren; w?: number; cls?: string; extra?: ComponentChildren }) {
  const p = settings.value.panels[pk] ?? { open: true, x: -1, y: 300 };
  const ref = useRef<HTMLDivElement>(null);
  const sk = `${pk}${cls.includes("stats-mini") ? ".mini" : cls.includes("stats-dense") ? ".dense" : ""}`;
  const sc = scales.value[sk] ?? 1;
  const w = Math.round(w0 * sc);
  const onResize = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = ref.current!;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const h0 = el.offsetHeight;
    const s0 = sc;
    let last = s0;
    (el.firstElementChild as HTMLElement).style.width = `${w0}px`;
    const move = (ev: PointerEvent) => {
      // drag along the panel's diagonal: project the pointer move onto it (short, wide panels
      // scale mostly with horizontal moves)
      const W = w0 * s0;
      const f = 1 + ((ev.clientX - x0) * W + (ev.clientY - y0) * h0) / (W * W + h0 * h0);
      last = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s0 * f));
      const inner = el.firstElementChild as HTMLElement;
      el.style.width = `${w0 * last}px`;
      el.style.height = `${inner.offsetHeight * last}px`;
      inner.style.transform = `scale(${last})`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setScale(sk, Math.abs(last - 1) < 0.03 ? null : last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // the scaled content doesn't take layout space: size the frame from the content's own height
  useEffect(() => {
    const el = ref.current;
    const inner = el?.firstElementChild as HTMLElement | null;
    if (!el || !inner) return;
    const fit = () => (el.style.height = sc === 1 ? "" : `${inner.offsetHeight * sc}px`);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [sc]);
  /* end radio/dash 0.8 */
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
    <div ref={ref} class={`stats glass stats-${pk} ${cls} ${sc !== 1 ? "scaled" : ""}`} style={{ left: `${x}px`, top: `${y}px`, width: `${w}px` }}>
      <div class="stats-zoom" style={sc === 1 ? undefined : { width: `${w0}px`, transform: `scale(${sc})` }}>
        <div class="stats-head" onPointerDown={onDown as any}>
          <GripVertical size={12} />
          {icon}
          <span>{title}</span>
          {extra}
          <button class="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
            <X size={12} />
          </button>
        </div>
        {children}
      </div>
      {/* radio/dash 0.8: resize handle (double-click: original size) */}
      <span class="stats-resize" role="separator" aria-label="Resize panel" title={`Drag to resize (${Math.round(sc * 100)}%) · double-click to reset`} onPointerDown={onResize as any} onDblClick={() => setScale(sk, null)} />
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
      <div class="srow" data-tip={`TheBigWeather server process\n${s.proc_cpu != null ? `${s.proc_cpu.toFixed(1)}% of the whole machine${s.proc_cpu_cores != null ? `\n${(s.proc_cpu_cores / 100).toFixed(2)} cores busy (${s.proc_cpu_cores.toFixed(0)}% of one core)` : ""}` : "CPU not reported"}`}>
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
        <Merged s={s} c={c} />
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

/* ---------- p7: dense merged "This computer" panel ---------- */
const MINI_KEY = "tbw.stats.mini";
const statsMini = signal<boolean>((() => {
  try {
    return localStorage.getItem(MINI_KEY) === "1";
  } catch {
    return false;
  }
})());
function setMini(v: boolean) {
  statsMini.value = v;
  try {
    localStorage.setItem(MINI_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}
const detail = signal<string | null>(null);

/** short byte counts: 1.9G, 512M, 80K */
function sb(b: number | null | undefined): string {
  if (b == null || !isFinite(b)) return "—";
  const u = ["", "K", "M", "G", "T"];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b < 10 && i ? 1 : 0)}${u[i]}`;
}
const pc = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(v < 10 ? 1 : 0)}%`);

/** one compact cell: optional tiny bar + value */
function C({ v, t, tip, pre }: { v?: number | null; t: ComponentChildren; tip?: string; pre?: string }) {
  return (
    <span class="sc" title={tip}>
      {pre && <i class="sc-pre">{pre}</i>}
      {v != null && <Bar v={v} />}
      <b>{t}</b>
    </span>
  );
}

function MiniSpark({ h }: { h: number[] }) {
  if (h.length < 2) return null;
  const path = h.map((v, i) => `${i === 0 ? "M" : "L"}${(i / Math.max(1, h.length - 1)) * 100},${20 - (Math.min(100, v) / 100) * 19}`).join(" ");
  return (
    <svg class="sc-spark" viewBox="0 0 100 20" preserveAspectRatio="none">
      <path d={path} />
    </svg>
  );
}

function Merged({ s, c }: { s: any; c: ClientStats | null }) {
  const mini = statsMini.value;
  const ipc = hasIpc();
  // system figures: the server's (same machine) or the app's own
  const sysCpu: number | null = s?.cpu ?? c?.sys_cpu ?? null;
  const memTot: number = s?.mem_total ?? c?.mem_total ?? 0;
  const memUsed: number = s ? s.mem_used : c && c.mem_total ? c.mem_total - c.mem_available : 0;
  const memPct = memTot ? (memUsed / memTot) * 100 : null;
  const cores = s?.cores ?? c?.cores ?? 1;
  const appCpu = ipc && c ? c.app_cpu : null;
  const appMem = ipc && c ? c.app_mem : null;
  const gpu = ipc ? c?.procs.gpu : undefined;
  const heapPct = c?.heap_used && c.heap_limit ? (c.heap_used / c.heap_limit) * 100 : null;
  const diskPct = s?.disk_total ? ((s.disk_total - s.disk_free) / s.disk_total) * 100 : null;
  const rows: { k: string; label: string; cells: ComponentChildren; det: string; spark?: number[] }[] = [
    {
      k: "cpu",
      label: "CPU",
      spark: s ? history.value : undefined,
      cells: (
        <>
          <C v={sysCpu} t={pc(sysCpu)} tip="Whole machine" />
          <C v={s?.proc_cpu} t={pc(s?.proc_cpu)} tip={`Server process (share of the whole machine)${s?.proc_cpu_cores != null ? ` · ${(s.proc_cpu_cores / 100).toFixed(2)} cores busy` : ""}`} />
          <C v={appCpu} t={pc(appCpu)} tip="App, all processes (share of the whole machine)" />
        </>
      ),
      det: [
        s?.cpu_name || c?.cpu_name || "",
        `${cores} threads${s?.cpu_mhz ? ` · ${(s.cpu_mhz / 1000).toFixed(2)} GHz` : ""}`,
        s?.load1 != null ? `Load ${s.load1.toFixed(2)} / ${s.load5?.toFixed(2)} / ${s.load15?.toFixed(2)}` : c?.load ? `Load ${c.load.map((x) => x.toFixed(2)).join(" / ")}` : "",
        s?.per_core?.length ? `Per core: ${s.per_core.map((x: number) => Math.round(x)).join(" ")}` : "",
        c && ipc ? Object.entries(c.procs).map(([k, v]) => `${k === "main" ? "Main" : k === "renderer" ? "Window" : k === "gpu" ? "GPU" : "Other"}${v.n > 1 ? `×${v.n}` : ""} ${(v.cpu / Math.max(1, c.cores)).toFixed(1)}%`).join(" · ") : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      k: "ram",
      label: "RAM",
      cells: (
        <>
          <C v={memPct} t={memTot ? `${sb(memTot - memUsed)} free` : "—"} tip="Whole machine (bar = used)" />
          <C v={s?.proc_rss && memTot ? (s.proc_rss / memTot) * 100 : null} t={sb(s?.proc_rss)} tip="Server resident memory" />
          <C v={appMem != null && memTot ? (appMem / memTot) * 100 : null} t={sb(appMem)} tip="App, all processes" />
        </>
      ),
      det: [
        memTot ? `Used ${fmtBytes(memUsed)} of ${fmtBytes(memTot)}` : "",
        s?.swap_total ? `Swap ${fmtBytes(s.swap_used)} / ${fmtBytes(s.swap_total)}` : "",
        s?.proc_threads ? `Server threads ${s.proc_threads}` : "",
        c && ipc ? Object.entries(c.procs).map(([k, v]) => `${k === "main" ? "Main" : k === "renderer" ? "Window" : k === "gpu" ? "GPU" : "Other"} ${fmtBytes(v.mem)}`).join(" · ") : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      k: "gfx",
      label: "GFX",
      cells: (
        <>
          <C pre="GPU" t={gpu ? sb(gpu.mem) : "—"} tip="GPU process memory" />
          <C pre="Heap" v={heapPct} t={sb(c?.heap_used)} tip="JavaScript heap" />
          <C pre="FPS" t={c?.fps == null ? "idle" : String(c.fps)} tip="Map frames per second (idle when nothing changes)" />
        </>
      ),
      det: [gpu ? `GPU process ${fmtBytes(gpu.mem)} · ${(gpu.cpu / Math.max(1, cores)).toFixed(1)}% CPU (driver buffers not included)` : "", c?.heap_used != null ? `JS heap ${fmtBytes(c.heap_used)} of ${fmtBytes(c.heap_limit ?? 0)}` : ""].filter(Boolean).join("\n"),
    },
    {
      k: "io",
      label: "I/O",
      cells: (
        <>
          <C pre="Disk" v={diskPct} t={s ? `${sb(s.disk_free)}` : "—"} tip="Free space on the data disk (bar = used)" />
          <C t={s ? `↓${sb(s.net_rx_bps)} ↑${sb(s.net_tx_bps)}` : "—"} tip="Machine network, per second" />
          <C t={c ? `↓${sb(c.net_rx_bps)}/s` : "—"} tip="App HTTP received per second" />
        </>
      ),
      det: [
        s ? `${s.disk_mount || "data"}${s.disk_fs ? ` (${s.disk_fs})` : ""}: ${fmtBytes(s.disk_free)} free of ${fmtBytes(s.disk_total)}` : "",
        s ? `Net since start ↓ ${fmtBytes(s.net_rx_total ?? 0)} ↑ ${fmtBytes(s.net_tx_total ?? 0)}` : "",
        c ? `App HTTP since start ${fmtBytes(c.net_rx_total)} (WebSocket not counted)` : "",
        s ? `${s.clients ?? 0} app${s.clients === 1 ? "" : "s"} connected · server up ${upTxt(s.uptime ?? 0)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  const close = () => update((x) => ((x.panels.stats = { ...x.panels.stats, open: false }), (x.panels.appstats = { ...(x.panels.appstats ?? { x: -1, y: 300 }), open: false })));
  const toggle = (
    <button class="icon-btn" title={mini ? "Show details" : "Mini (one line)"} onPointerDown={(e) => e.stopPropagation()} onClick={() => setMini(!mini)}>
      {mini ? <Maximize2 size={11} /> : <Minimize2 size={11} />}
    </button>
  );
  if (mini)
    return (
      <Floater
        pk="stats"
        cls="stats-dense stats-mini"
        w={300}
        icon={<Cpu size={11} />}
        extra={toggle}
        onClose={close}
        title={
          <span class="smini">
            <C pre="CPU" v={sysCpu} t={pc(sysCpu)} tip="Whole machine CPU" />
            <C pre="RAM" v={memPct} t={memTot ? sb(memTot - memUsed) : "—"} tip="Free memory" />
            <C pre="App" t={`${pc(appCpu)} ${sb(appMem)}`} tip="App CPU / memory" />
            <C pre="FPS" t={c?.fps == null ? "–" : String(c.fps)} />
          </span>
        }
      >
        {null}
      </Floater>
    );
  return (
    <Floater pk="stats" cls="stats-dense" w={282} title="This computer" icon={<Cpu size={11} />} extra={toggle} onClose={close}>
      <div class="sd-grid">
        <span />
        <i class="sd-col">System</i>
        <i class="sd-col">Server</i>
        <i class="sd-col">App</i>
        {rows.map((r) => (
          <div key={r.k} class={`sd-row ${detail.value === r.k ? "open" : ""}`} onClick={() => (detail.value = detail.value === r.k ? null : r.k)} title="Click for details">
            {r.spark && <MiniSpark h={r.spark} />}
            <span class="sd-l">{r.label}</span>
            {r.cells}
            {detail.value === r.k && r.det && <pre class="sd-det">{r.det}</pre>}
          </div>
        ))}
      </div>
    </Floater>
  );
}
