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
});
