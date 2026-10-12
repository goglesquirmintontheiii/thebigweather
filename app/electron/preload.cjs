const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Optional settings injection (first-run provisioning / automated screenshots)
try {
  if (process.env.TBW_SETTINGS && !location.hash.includes("popout")) window.localStorage.setItem("tbw.settings.v1", process.env.TBW_SETTINGS);
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
  onOpenFile: (cb) => {
    const h = (_e, f) => cb(f);
    ipcRenderer.on("open-file", h);
    ipcRenderer.invoke("renderer-ready").then((list) => (list || []).forEach(cb));
    return () => ipcRenderer.removeListener("open-file", h);
  },
});
