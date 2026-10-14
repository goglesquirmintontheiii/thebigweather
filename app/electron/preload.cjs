const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Optional settings injection (first-run provisioning / automated screenshots)
try {
  if (process.env.TBW_SETTINGS && !location.hash.includes("popout") && !location.pathname.endsWith("widget.html") /* workflow 0.6 */) window.localStorage.setItem("tbw.settings.v1", process.env.TBW_SETTINGS);
} catch {}

// 0.8.1: safe mode (after crashes, or --safe-mode): before the app reads its settings, keep the
// layout aside ("tbw.settings.safe-backup") and start with one map, no satellite imagery, no 3D.
// Same rules as safeSettings() in crashguard.cjs (this sandboxed preload can't require it).
const SAFE_KEY = "tbw.settings.v1";
const SAFE_BACKUP = "tbw.settings.safe-backup";
let tbwSafe = { active: false, reason: "" };
try {
  tbwSafe = ipcRenderer.sendSync("safe-mode-get") || tbwSafe;
} catch {}
const tbwMainPage = !location.hash.includes("popout") && !location.pathname.endsWith("widget.html");
try {
  if (tbwSafe.active && tbwMainPage) {
    const raw = window.localStorage.getItem(SAFE_KEY);
    if (raw) {
      if (!window.localStorage.getItem(SAFE_BACKUP)) window.localStorage.setItem(SAFE_BACKUP, raw); // the oldest = the real layout
      const s = JSON.parse(raw) || {};
      const o = { ...s, panes: { ...(s.panes || {}), layout: "1" } };
      const w = s.weather || {};
      if (w.kind === "gibs" || (w.kind === "grid" && /^goes\//.test(String(w.id || "")))) o.weather = { kind: "radar" };
      if (o.view3d) o.view3d = { ...o.view3d, on: false };
      window.localStorage.setItem(SAFE_KEY, JSON.stringify(o));
    }
  }
  tbwSafe.backup = tbwMainPage && !!window.localStorage.getItem(SAFE_BACKUP);
} catch {}

contextBridge.exposeInMainWorld("tbw", {
  capture: () => ipcRenderer.invoke("capture"),
  info: () => ipcRenderer.invoke("app-info"),
  download: (url, name) => ipcRenderer.invoke("download", url, name),
  popout: (spec) => ipcRenderer.invoke("popout", spec),
  screenRec: {
    open: () => ipcRenderer.invoke("screenrec-open"),
    write: (id, buf) => ipcRenderer.invoke("screenrec-write", id, buf),
    close: (id) => ipcRenderer.invoke("screenrec-close", id),
  },
  /* workflow */
  saveFile: (name, buf) => ipcRenderer.invoke("save-file", name, buf),
  captureBuf: (rect) => ipcRenderer.invoke("capture-buf", rect),
  setZoom: (f) => webFrame.setZoomFactor(f),
  clientStats: () => ipcRenderer.invoke("client-stats"), // shake/stats/server 0.6
  /* workflow 0.6: desktop widgets, offline tiles, kiosk, plugins */
  wf6: {
    widgetOpen: (cfg) => ipcRenderer.invoke("wf6-widget-open", cfg),
    widgetClose: (id) => ipcRenderer.invoke("wf6-widget-close", id),
    widgetSet: (id, o) => ipcRenderer.invoke("wf6-widget-set", id, o),
    onWidgetClosed: (cb) => ipcRenderer.on("wf6-widget-closed", (_e, id) => cb(id)),
    tileGet: (k) => ipcRenderer.invoke("wf6-tile-get", k),
    tilePut: (k, b) => ipcRenderer.invoke("wf6-tile-put", k, b),
    tileDel: (k) => ipcRenderer.invoke("wf6-tile-del", k),
    tileUsage: () => ipcRenderer.invoke("wf6-tile-usage"),
    argv: () => ipcRenderer.invoke("wf6-argv"),
    fullscreen: (on) => ipcRenderer.invoke("wf6-fullscreen", on),
    flash: () => ipcRenderer.invoke("wf6-flash"),
    pluginsDir: () => ipcRenderer.invoke("wf6-plugins-dir"),
  },
  isElectron: true,
  /* Phase 6: tray, desktop options, bundled server, file associations */
  tray: {
    update: (info) => ipcRenderer.invoke("tray-update", info),
    onMute: (cb) => {
      const h = (_e, v) => cb(!!v);
      ipcRenderer.on("tray-mute", h);
      return () => ipcRenderer.removeListener("tray-mute", h);
    },
  },
  desktop: {
    get: () => ipcRenderer.invoke("desktop-get"),
    set: (patch) => ipcRenderer.invoke("desktop-set", patch),
  },
  localServer: (action) => ipcRenderer.invoke("local-server", action || "status"),
  /* p8: app auto-update (electron-updater, GitHub releases) */
  update: {
    get: () => ipcRenderer.invoke("update-get"),
    check: () => ipcRenderer.invoke("update-check"),
    download: () => ipcRenderer.invoke("update-download"),
    install: () => ipcRenderer.invoke("update-install"),
    set: (p) => ipcRenderer.invoke("update-set", p),
    openPage: () => ipcRenderer.invoke("update-open-page"),
    onState: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on("update-state", h);
      return () => ipcRenderer.removeListener("update-state", h);
    },
  },
  /* 0.8.1: safe mode banner, Settings → Performance */
  safe: {
    info: () => ({ ...tbwSafe }),
    /** put the layout from before safe mode back and start normally */
    restore: () => {
      try {
        const b = window.localStorage.getItem(SAFE_BACKUP);
        if (b) window.localStorage.setItem(SAFE_KEY, b);
        window.localStorage.removeItem(SAFE_BACKUP);
      } catch {}
      try {
        ipcRenderer.sendSync("safe-mode-clear");
      } catch {}
      location.reload();
    },
    /** keep the trimmed layout; the next start is normal */
    keep: () => {
      try {
        window.localStorage.removeItem(SAFE_BACKUP);
      } catch {}
      try {
        ipcRenderer.sendSync("safe-mode-clear");
      } catch {}
    },
  },
  perf: { setThrottle: (on) => ipcRenderer.invoke("perf-throttle", !!on) },
  // automated screenshots keep today's full quality (their software GL would pick Low-end)
  perfForce: process.env.TBW_PERF || (process.env.TBW_SHOT ? "quality" : ""),
  onOpenFile: (cb) => {
    const h = (_e, f) => cb(f);
    ipcRenderer.on("open-file", h);
    ipcRenderer.invoke("renderer-ready").then((list) => (list || []).forEach(cb));
    return () => ipcRenderer.removeListener("open-file", h);
  },
});
