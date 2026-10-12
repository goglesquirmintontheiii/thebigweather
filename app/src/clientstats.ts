// App/client computer stats (Electron main process via IPC, plus renderer heap, map FPS and
// HTTP traffic) and same-host detection for merging them with the server stats panel.

import { signal, effect } from "@preact/signals";
import { api } from "./api";
import { activeServer, connection } from "./store";
import { fps } from "./map/mapview";

export interface ClientStats {
  t: number;
  sys_cpu: number | null;
  cores: number;
  cpu_name: string;
  mem_total: number;
  mem_available: number;
  load?: number[];
  app_cpu: number;
  app_mem: number;
  procs: Record<string, { cpu: number; mem: number; n: number }>;
  uptime: number;
  hostname: string;
  addrs: string[];
  heap_used?: number;
  heap_limit?: number;
  fps: number | null;
  net_rx_bps: number;
  net_rx_total: number;
}

export const client = signal<ClientStats | null>(null);
export const clientHist = signal<number[]>([]);
/** server /api/info (refreshed on connect) */
export const serverInfo = signal<any>(null);
/** the connected server runs on this computer */
export const sameHost = signal(false);

const ipc = () => (window as any).tbw?.clientStats as (() => Promise<any>) | undefined;

// HTTP bytes received by the renderer (resource timing transferSize, cheap; WebSocket not included)
let rxTotal = 0;
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries() as PerformanceResourceTiming[]) rxTotal += e.transferSize || 0;
  }).observe({ type: "resource", buffered: true });
} catch {
  /* unsupported */
}

let users = 0;
let timer: number | undefined;
let lastRx = 0;
let lastT = 0;
let addrs: string[] = [];

async function poll() {
  const f = ipc();
  let base: any = {};
  if (f) {
    try {
      base = await f();
      addrs = base.addrs ?? addrs;
    } catch {
      /* main process busy */
    }
  }
  const now = performance.now();
  const dt = lastT ? (now - lastT) / 1000 : 0;
  const rate = dt > 0 ? (rxTotal - lastRx) / dt : 0;
  lastRx = rxTotal;
  lastT = now;
  const pm = (performance as any).memory;
  const s: ClientStats = {
    t: Date.now(),
    sys_cpu: base.sys_cpu ?? null,
    cores: base.cores ?? navigator.hardwareConcurrency ?? 0,
    cpu_name: base.cpu_name ?? "",
    mem_total: base.mem_total ?? 0,
    mem_available: base.mem_available ?? 0,
    load: base.load,
    app_cpu: base.app_cpu ?? 0,
    app_mem: base.app_mem ?? 0,
    procs: base.procs ?? {},
    uptime: base.uptime ?? performance.now() / 1000,
    hostname: base.hostname ?? "",
    addrs: base.addrs ?? [],
    heap_used: pm?.usedJSHeapSize,
    heap_limit: pm?.jsHeapSizeLimit,
    fps: fps.value,
    net_rx_bps: rate,
    net_rx_total: rxTotal,
  };
  client.value = s;
  clientHist.value = [...clientHist.value, f ? s.app_cpu : 0].slice(-40);
  updateSame();
}

/** start polling while a stats panel is shown; returns the stop function */
export function useClientStats(): () => void {
  if (users++ === 0) {
    poll();
    timer = window.setInterval(poll, 2000);
  }
  return () => {
    if (--users === 0) clearInterval(timer);
  };
}

export const hasIpc = () => !!ipc();

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;
function hostOf(url: string) {
  try {
    return new URL(/^https?:/.test(url) ? url : `http://${url}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}
function updateSame() {
  const info = serverInfo.value;
  const srv = activeServer.value;
  if (!srv) {
    sameHost.value = false;
    return;
  }
  if (typeof info?.same_host === "boolean") {
    sameHost.value = info.same_host;
    return;
  }
  const h = hostOf(srv.url);
  sameHost.value = LOCAL.test(h) || addrs.includes(h);
}

export async function refreshInfo() {
  try {
    serverInfo.value = await api.get("/api/info");
  } catch {
    serverInfo.value = null;
  }
  updateSame();
}

let lastKey = "";
effect(() => {
  const s = activeServer.value;
  const c = connection.value;
  const key = `${s?.url}|${s?.token}|${c === "online"}`;
  if (key === lastKey) return;
  lastKey = key;
  serverInfo.value = null;
  updateSame();
  if (s) refreshInfo();
});
// pick up local interface addresses once even without a panel open (for same-host detection)
if (ipc())
  ipc()!()
    .then((b) => {
      addrs = b?.addrs ?? [];
      updateSame();
    })
    .catch(() => {});
