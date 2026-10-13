const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Optional settings injection (first-run provisioning / automated screenshots)
try {
  if (process.env.TBW_SETTINGS && !location.hash.includes("popout") && !location.pathname.endsWith("widget.html") /* workflow 0.6 */) window.localStorage.setItem("tbw.settings.v1", process.env.TBW_SETTINGS);
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
  onOpenFile: (cb) => {
    const h = (_e, f) => cb(f);
    ipcRenderer.on("open-file", h);
    ipcRenderer.invoke("renderer-ready").then((list) => (list || []).forEach(cb));
    return () => ipcRenderer.removeListener("open-file", h);
  },
});
