const { contextBridge, ipcRenderer } = require("electron");

// Optional settings injection (first-run provisioning / automated screenshots)
try {
  if (process.env.TBW_SETTINGS && !location.hash.includes("popout")) window.localStorage.setItem("tbw.settings.v1", process.env.TBW_SETTINGS);
} catch {}

contextBridge.exposeInMainWorld("tbw", {
  capture: () => ipcRenderer.invoke("capture"),
  info: () => ipcRenderer.invoke("app-info"),
  download: (url, name) => ipcRenderer.invoke("download", url, name),
  popout: (spec) => ipcRenderer.invoke("popout", spec),
  isElectron: true,
});
