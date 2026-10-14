// Electron shell for TheBigWeather.
const { app, BrowserWindow, ipcMain, shell, screen, nativeTheme, protocol, net, session, desktopCapturer, Tray, Menu, nativeImage, dialog } = require("electron");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");
const guard = require("./crashguard.cjs"); // 0.8.1: crash-loop guard / safe mode

const isDev = !!process.env.TBW_DEV_URL;
const ICON = path.join(__dirname, "..", "build", "icon.png");
const DIST = path.join(__dirname, "..", "dist");

// Serve the UI from app://tbw so fetch, module workers and storage behave like a normal secure origin.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
nativeTheme.themeSource = "dark";
// Windows: desktop notifications and taskbar grouping need the installer's app id
if (process.platform === "win32") app.setAppUserModelId("app.thebigweather.desktop");

// GPU: prefer hardware; allow SwiftShader fallback so WebGL2 always works (VMs, remote desktops)
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
// keep the renderer heap bounded (radar sweeps are cached explicitly, so a big heap only hides garbage)
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
// Wayland when available, X11 otherwise
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
if (process.env.TBW_SOFTWARE_GL) {
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
}

if (!process.env.TBW_SHOT && !app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- 0.8.1: crash recovery, safe mode ----------
// A crashed or hung map window offers Reload / Reload in safe mode; two failed starts in a row (crash,
// hang or kill within the first minute) start in safe mode: one map, no satellite / 3D, Low-end
// performance settings. `--safe-mode` does the same on purpose. The layout from before is kept by the
// preload ("tbw.settings.safe-backup") and the in-app banner can restore it.
let safeMode = { active: false, reason: "" };
let guardState = null;
let loadedAt = 0;
let stableTimer = null;
let mainBad = false; // the main renderer crashed or hangs right now
let expectGone = null; // { safe } when we kill a hung renderer on purpose
const guardFile = () => path.join(app.getPath("userData"), "crashguard.json");
function guardLoad() {
  try {
    return JSON.parse(fs.readFileSync(guardFile(), "utf8"));
  } catch {
    return {};
  }
}
function guardSave(s) {
  guardState = s;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(guardFile(), JSON.stringify(s));
  } catch {}
}
function guardStart() {
  const flag = process.argv.includes("--safe-mode") || !!process.env.TBW_SAFE;
  if (process.env.TBW_SHOT) return void (safeMode = { active: flag, reason: flag ? "flag" : "" });
  const r = guard.onStart(guardLoad(), Date.now(), { flag });
  guardSave(r.state);
  safeMode = { active: r.safe, reason: r.reason };
  if (r.safe) console.warn(`[tbw] starting in safe mode (${r.reason})`);
}
const errLog = (msg) => {
  console.error(msg);
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "errors.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};
// never show Electron's "Uncaught Exception" box for a main-process slip (e.g. a window that is gone)
process.on("uncaughtException", (err) => errLog(`main: ${(err && err.stack) || err}`));
const alive = (w) => !!w && !w.isDestroyed();
function hookMainWindow(w) {
  const wc = w.webContents;
  wc.on("did-finish-load", () => {
    loadedAt = Date.now();
    mainBad = false;
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (!mainBad && guardState && guardState.pending) guardSave(guard.onStable());
    }, guard.STABLE_MS);
  });
  w.on("closed", () => {
    clearTimeout(stableTimer);
    if (win === w) win = null;
    // the main window is gone for good (not hidden to the tray): don't linger as a zombie that holds
    // the single-instance lock with pop-outs or widgets open
    if (!quitting && !(tray && desktop.closeToTray)) app.quit();
  });
}
/** Reload the main window (recreate it if it's gone); `kill` first for a hung renderer. */
function reloadMain(safeReason, kill) {
  if (safeReason) safeMode = { active: true, reason: safeReason };
  if (!alive(win)) return createWindow();
  if (kill) {
    expectGone = { at: Date.now() };
    try {
      win.webContents.forcefullyCrashRenderer();
      return; // render-process-gone reloads
    } catch {}
  }
  mainBad = false;
  win.webContents.reload();
}
function mainGone(d) {
  mainBad = true;
  if (expectGone && Date.now() - expectGone.at < 10_000) {
    expectGone = null;
    mainBad = false;
    return void setTimeout(() => alive(win) && win.webContents.reload(), 300);
  }
  const r = guard.onCrash(guardState || guardLoad(), Date.now(), loadedAt);
  guardSave(r.state);
  errLog(`renderer gone: ${d.reason} (${d.exitCode})`);
  if (process.env.TBW_SHOT) return app.exit(3);
  const loop = r.state.fails >= guard.FAILS_FOR_SAFE;
  dialog
    .showMessageBox(alive(win) ? win : undefined, {
      type: "error",
      title: "TheBigWeather",
      message: "The map window stopped",
      detail: `Reason: ${d.reason}${d.exitCode ? ` (code ${d.exitCode})` : ""}.${loop ? " It stopped right after starting again — safe mode opens one map without satellite or 3D." : ""}`,
      buttons: ["Reload", "Reload in safe mode", "Quit"],
      defaultId: loop ? 1 : 0,
      cancelId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 2) {
        quitting = true;
        return app.quit();
      }
      reloadMain(response === 1 ? "crash" : "", false);
    })
    .catch(() => reloadMain("", false));
}
app.on("render-process-gone", (_e, wc, d) => {
  if (!d || d.reason === "clean-exit") return;
  const w = BrowserWindow.fromWebContents(wc);
  if (!alive(w)) return;
  if (w === win) return mainGone(d);
  // pop-outs and widgets: reload quietly (at most every 30 s)
  errLog(`pop-out renderer gone: ${d.reason}`);
  if (Date.now() - (w.tbwGone || 0) < 30_000) return;
  w.tbwGone = Date.now();
  setTimeout(() => alive(w) && w.webContents.reload(), 1000);
});
app.on("child-process-gone", (_e, d) => {
  if (d && d.reason !== "clean-exit") errLog(`${d.type} process gone: ${d.reason} (${d.exitCode})`);
});
// a window that stops answering: Wait / Reload / Reload in safe mode (closes itself if it recovers)
app.on("browser-window-created", (_e, w) => {
  let ac = null;
  w.on("unresponsive", () => {
    if (w === win) mainBad = true;
    if (process.env.TBW_SHOT || ac) return;
    ac = new AbortController();
    const main = w === win;
    dialog
      .showMessageBox(w, {
        type: "warning",
        title: "TheBigWeather",
        message: "TheBigWeather isn't responding",
        detail: "The map is busy or stuck. Wait, or reload it.",
        buttons: main ? ["Wait", "Reload", "Reload in safe mode"] : ["Wait", "Reload"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: ac.signal,
      })
      .then(({ response }) => {
        ac = null;
        if (!response || !alive(w)) return;
        if (main) return reloadMain(response === 2 ? "manual" : "", true);
        try {
          w.webContents.forcefullyCrashRenderer();
        } catch {}
        setTimeout(() => alive(w) && w.webContents.reload(), 300);
      })
      .catch(() => (ac = null));
  });
  w.on("responsive", () => {
    if (w === win) mainBad = false;
    if (ac) ac.abort();
    ac = null;
  });
});
ipcMain.on("safe-mode-get", (e) => (e.returnValue = { ...safeMode }));
ipcMain.on("safe-mode-clear", (e) => {
  safeMode = { active: false, reason: "" };
  e.returnValue = true;
});
// Settings → Performance → pause hidden windows (the main window normally keeps drawing when hidden)
ipcMain.handle("perf-throttle", (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (alive(w)) w.webContents.setBackgroundThrottling(w === win ? !!on : true);
});
// ---------- end 0.8.1 ----------

const stateFile = () => path.join(app.getPath("userData"), "window.json");
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    // only restore if still on a connected display (multi-monitor setups change)
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + b.height > a.y + 50;
    });
    return visible ? b : null;
  } catch {
    return null;
  }
}

let win = null;
function createWindow() {
  const saved = loadBounds();
  const w = Number(process.env.TBW_WIDTH) || saved?.width || 1600;
  const h = Number(process.env.TBW_HEIGHT) || saved?.height || 960;
  win = new BrowserWindow({
    width: w,
    height: h,
    x: process.env.TBW_SHOT ? 0 : saved?.x,
    y: process.env.TBW_SHOT ? 0 : saved?.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#07090c",
    title: "TheBigWeather",
    autoHideMenuBar: true,
    show: !process.env.TBW_SHOT_HIDDEN && !startHidden(),
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (saved?.maximized && !process.env.TBW_SHOT) win.maximize();
  win.setMenuBarVisibility(false);
  hookMainWindow(win); // 0.8.1: crash / hang recovery, crash-loop guard

  // external links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  const save = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  win.on("close", save);
  // Phase 6: closing can hide the window to the tray instead of quitting
  const self = win; // 0.8.1: handlers act on their own window, never a later one
  win.on("close", (e) => {
    if (!quitting && desktop.closeToTray && tray && !process.env.TBW_SHOT) {
      e.preventDefault();
      self.hide();
      if (!desktop.trayHintShown && process.platform === "win32" && tray.displayBalloon) {
        tray.displayBalloon({ title: "TheBigWeather", content: "Still running in the tray. Right-click the icon to quit.", iconType: "info" });
        setDesktop({ trayHintShown: true });
      }
    }
  });

  if (isDev) win.loadURL(process.env.TBW_DEV_URL);
  else win.loadURL("app://tbw/index.html");

  if (process.env.TBW_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });

  win.webContents.on("console-message", (e) => {
    if (process.env.TBW_LOG_CONSOLE) console.log(`[renderer] ${e.message}`);
  });

  // automated screenshots (used for progress shots / CI)
  if (process.env.TBW_SHOT) {
    const delay = Number(process.env.TBW_SHOT_DELAY || 8000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (process.env.TBW_SHOT_JS) await win.webContents.executeJavaScript(process.env.TBW_SHOT_JS);
          await new Promise((r) => setTimeout(r, Number(process.env.TBW_SHOT_AFTER_JS || 1500)));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.TBW_SHOT, img.toPNG());
        } catch (err) {
          console.error("screenshot failed", err);
        }
        app.exit(0);
      }, delay);
    });
  }
}

ipcMain.handle("capture", async () => {
  if (!alive(win)) return null; // 0.8.1
  const img = await win.webContents.capturePage();
  const dir = path.join(app.getPath("pictures"), "TheBigWeather");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `TBW_${ts}.png`);
  fs.writeFileSync(file, img.toPNG());
  return file;
});

// downloads (recording exports): saved to ~/Downloads/TheBigWeather without a dialog
const pendingDownloads = new Map();
ipcMain.handle("download", async (_e, url, name) => {
  if (!alive(win) || !/^https?:\/\//.test(url)) return null; // 0.8.1
  const dir = path.join(app.getPath("downloads"), "TheBigWeather");
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve) => {
    pendingDownloads.set(url, { file: path.join(dir, name || "download"), resolve });
    win.webContents.downloadURL(url);
  });
});

// pop-out windows: a camera, the radio, or a second map, in its own OS window
const popouts = new Set();
ipcMain.handle("popout", (_e, spec) => {
  const w = new BrowserWindow({
    width: spec.width || 640,
    height: spec.height || 420,
    title: spec.title || "TheBigWeather",
    backgroundColor: "#07090c",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false },
  });
  w.setMenuBarVisibility(false);
  const hash = "#popout=" + encodeURIComponent(JSON.stringify(spec));
  if (isDev) w.loadURL(process.env.TBW_DEV_URL + hash);
  else w.loadURL("app://tbw/index.html" + hash);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  popouts.add(w);
  w.on("closed", () => popouts.delete(w));
  return true;
});

// ---------- screen recording (toolbar): the renderer streams WebM chunks, saved to Downloads/TheBigWeather ----------
const screenRecs = new Map();
ipcMain.handle("screenrec-open", () => {
  const dir = path.join(app.getPath("downloads"), "TheBigWeather");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `TheBigWeather-${ts}.webm`);
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  screenRecs.set(id, { file, fd: fs.openSync(file, "w") });
  return { id, file };
});
ipcMain.handle("screenrec-write", (_e, id, buf) => {
  const r = screenRecs.get(id);
  if (!r) return false;
  fs.writeSync(r.fd, Buffer.from(buf));
  return true;
});
ipcMain.handle("screenrec-close", (_e, id) => {
  const r = screenRecs.get(id);
  if (!r) return null;
  screenRecs.delete(id);
  fs.closeSync(r.fd);
  return r.file;
});
/** getDisplayMedia() from the app records the app itself (no picker): the requesting page's
 * frame (tab capture: just the app, works on X11/Wayland alike); the OS window/screen otherwise. */
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    let done = false;
    const reply = (v) => {
      if (done) return;
      done = true;
      try {
        cb(v);
      } catch (err) {
        console.error("screenrec", err.message);
      }
    };
    if (req.frame) {
      if (process.env.TBW_LOG_CONSOLE) console.log("[screenrec] capturing the app frame");
      return reply({ video: req.frame });
    }
    desktopCapturer
      .getSources({ types: ["window", "screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((srcs) => {
        const want = win && !win.isDestroyed() ? win.getMediaSourceId() : "";
        const pick = srcs.find((s) => s.id === want) || srcs.find((s) => s.name === "TheBigWeather") || srcs.find((s) => s.id.startsWith("screen:")) || srcs[0];
        if (process.env.TBW_LOG_CONSOLE) console.log(`[screenrec] sources=${srcs.length} want=${want} pick=${pick ? pick.id : "none"}`);
        reply(pick ? { video: pick } : {});
      })
      .catch(() => reply({}));
  });
}

// ---------- workflow: save files (loop export, workspaces, GPX) to Downloads/TheBigWeather; window frame grabs ----------
ipcMain.handle("save-file", (_e, name, buf) => {
  const dir = path.join(app.getPath("downloads"), "TheBigWeather");
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || "file").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
  const file = path.join(dir, safe);
  fs.writeFileSync(file, Buffer.from(buf));
  return file;
});
ipcMain.handle("capture-buf", async (_e, rect) => {
  if (!alive(win)) return null; // 0.8.1
  const img = await win.webContents.capturePage(rect || undefined);
  return img.toPNG();
});
// ---------- end workflow ----------
// ---------- shake/stats/server 0.6: client (app computer) stats ----------
const tbwOs = require("os");
let tbwLastCpu = null;
function tbwSysCpu() {
  let idle = 0, total = 0;
  const cs = tbwOs.cpus();
  for (const c of cs) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  const prev = tbwLastCpu;
  tbwLastCpu = { idle, total };
  if (!prev || total <= prev.total) return null;
  return Math.max(0, Math.min(100, (1 - (idle - prev.idle) / (total - prev.total)) * 100));
}
function tbwMemAvail() {
  // os.freemem() on Linux excludes reclaimable cache; MemAvailable is what tools show as free
  if (process.platform === "linux") {
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
      if (m) return +m[1] * 1024;
    } catch {}
  }
  return tbwOs.freemem();
}
ipcMain.handle("client-stats", () => {
  const cpus = tbwOs.cpus();
  const procs = {};
  let cpu = 0, mem = 0;
  for (const m of app.getAppMetrics()) {
    const t = m.type === "Browser" ? "main" : m.type === "Tab" ? "renderer" : m.type === "GPU" ? "gpu" : "other";
    const p = (procs[t] = procs[t] || { cpu: 0, mem: 0, n: 0 });
    const c = m.cpu ? m.cpu.percentCPUUsage : 0;
    const b = m.memory ? m.memory.workingSetSize * 1024 : 0;
    p.cpu += c;
    p.mem += b;
    p.n++;
    cpu += c;
    mem += b;
  }
  const addrs = [];
  for (const list of Object.values(tbwOs.networkInterfaces())) for (const a of list || []) addrs.push(a.address);
  return {
    sys_cpu: tbwSysCpu(),
    cores: cpus.length,
    cpu_name: cpus[0] ? cpus[0].model : "",
    mem_total: tbwOs.totalmem(),
    mem_available: tbwMemAvail(),
    load: tbwOs.loadavg(),
    // percentCPUUsage is per core: normalise to the whole machine like the system figure
    app_cpu: cpu / Math.max(1, cpus.length),
    app_mem: mem,
    procs,
    uptime: process.uptime(),
    hostname: tbwOs.hostname(),
    addrs,
  };
});
// ---------- end shake/stats/server 0.6 ----------
// ---------- workflow 0.6: desktop widget windows, offline map tiles, kiosk, plugins folder ----------
const wf6Crypto = require("node:crypto");
const wf6Widgets = new Map(); // id -> BrowserWindow
const wf6PosFile = () => path.join(app.getPath("userData"), "widgets.json");
function wf6LoadPos() {
  try {
    return JSON.parse(fs.readFileSync(wf6PosFile(), "utf8"));
  } catch {
    return {};
  }
}
let wf6PosTimer = null;
function wf6SavePos() {
  clearTimeout(wf6PosTimer);
  wf6PosTimer = setTimeout(() => {
    const all = wf6LoadPos();
    for (const [id, w] of wf6Widgets) if (!w.isDestroyed()) all[id] = w.getBounds();
    try {
      fs.mkdirSync(app.getPath("userData"), { recursive: true });
      fs.writeFileSync(wf6PosFile(), JSON.stringify(all));
    } catch {}
  }, 400);
}
function wf6Apply(w, o) {
  if (o.opacity != null) w.setOpacity(Math.max(0.2, Math.min(1, Number(o.opacity))));
  if (o.onTop != null) w.setAlwaysOnTop(!!o.onTop, "floating");
  if (o.locked != null) w.setIgnoreMouseEvents(!!o.locked, { forward: true });
}
ipcMain.handle("wf6-widget-open", (_e, cfg) => {
  const id = String(cfg.id || "");
  if (!id || !/^widget\.html\?/.test(String(cfg.url || ""))) return false;
  const old = wf6Widgets.get(id);
  if (old && !old.isDestroyed()) {
    wf6Apply(old, cfg);
    old.showInactive();
    return true;
  }
  const pos = wf6LoadPos()[id];
  const vis = pos && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return pos.x < a.x + a.width - 30 && pos.x + pos.width > a.x + 30 && pos.y < a.y + a.height - 30 && pos.y + pos.height > a.y + 10;
  });
  const wa = screen.getPrimaryDisplay().workArea;
  const n = wf6Widgets.size;
  const w = new BrowserWindow({
    width: vis ? pos.width : cfg.width || 280,
    height: vis ? pos.height : cfg.height || 160,
    x: vis ? pos.x : wa.x + wa.width - (cfg.width || 280) - 24,
    y: vis ? pos.y : wa.y + 24 + n * 30,
    minWidth: 160,
    minHeight: 50,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: cfg.onTop !== false,
    title: cfg.title || "TheBigWeather widget",
    backgroundColor: "#00000000",
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, backgroundThrottling: true },
  });
  wf6Widgets.set(id, w);
  if (isDev) w.loadURL(process.env.TBW_DEV_URL.replace(/\/?$/, "/") + cfg.url);
  else w.loadURL("app://tbw/" + cfg.url);
  w.once("ready-to-show", () => {
    wf6Apply(w, cfg);
    w.showInactive();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  w.on("moved", wf6SavePos);
  w.on("resized", wf6SavePos);
  w.on("closed", () => {
    if (wf6Widgets.get(id) === w) wf6Widgets.delete(id);
    if (win && !win.isDestroyed() && !wf6Quitting) win.webContents.send("wf6-widget-closed", id);
  });
  // widgets go away with the main window
  if (alive(win) && !win.wf6Hooked) {
    win.wf6Hooked = true;
    win.on("closed", () => {
      wf6Quitting = true;
      for (const x of wf6Widgets.values()) if (!x.isDestroyed()) x.destroy();
      if (mini && !mini.isDestroyed()) mini.destroy();
    });
  }
  return true;
});
let wf6Quitting = false;
ipcMain.handle("wf6-widget-close", (_e, id) => {
  const w = wf6Widgets.get(String(id));
  if (w && !w.isDestroyed()) w.close();
});
ipcMain.handle("wf6-widget-set", (_e, id, o) => {
  const w = wf6Widgets.get(String(id));
  if (w && !w.isDestroyed()) wf6Apply(w, o || {});
});
ipcMain.handle("wf6-argv", () => process.argv.slice(1));
ipcMain.handle("wf6-fullscreen", (_e, on) => {
  if (win && !win.isDestroyed()) win.setFullScreen(!!on);
});
ipcMain.handle("wf6-flash", () => {
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
});
// offline basemap tiles: <userData>/offline-tiles/ab/<sha1>
const wf6TileDir = () => path.join(app.getPath("userData"), "offline-tiles");
const wf6TileFile = (key) => {
  const h = wf6Crypto.createHash("sha1").update(String(key)).digest("hex");
  return path.join(wf6TileDir(), h.slice(0, 2), h);
};
ipcMain.handle("wf6-tile-get", async (_e, key) => {
  try {
    return await fs.promises.readFile(wf6TileFile(key));
  } catch {
    return null;
  }
});
ipcMain.handle("wf6-tile-put", async (_e, key, buf) => {
  const f = wf6TileFile(key);
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  await fs.promises.writeFile(f, Buffer.from(buf));
  return true;
});
ipcMain.handle("wf6-tile-del", async (_e, keys) => {
  let n = 0;
  for (const k of keys || []) {
    try {
      await fs.promises.unlink(wf6TileFile(k));
      n++;
    } catch {}
  }
  return n;
});
ipcMain.handle("wf6-tile-usage", async () => {
  let bytes = 0, files = 0;
  try {
    for (const d of await fs.promises.readdir(wf6TileDir())) {
      for (const f of await fs.promises.readdir(path.join(wf6TileDir(), d))) {
        const st = await fs.promises.stat(path.join(wf6TileDir(), d, f));
        bytes += st.size;
        files++;
      }
    }
  } catch {}
  return { bytes, files };
});
// plugins: .js files in <userData>/plugins
ipcMain.handle("wf6-plugins-dir", async () => {
  const dir = path.join(app.getPath("userData"), "plugins");
  await fs.promises.mkdir(dir, { recursive: true });
  const files = [];
  for (const f of await fs.promises.readdir(dir)) {
    if (!/\.m?js$/.test(f)) continue;
    try {
      files.push({ name: f, code: await fs.promises.readFile(path.join(dir, f), "utf8") });
    } catch {}
  }
  return { dir, files };
});
// ---------- end workflow 0.6 ----------
ipcMain.handle("app-info", () => ({ version: app.getVersion(), platform: process.platform, displays: screen.getAllDisplays().length }));

app.on("second-instance", (_e, argv) => {
  // 0.8.1: the main window may be gone (closed, crashed): recreate / reload it instead of touching a
  // destroyed object ("Object has been destroyed"); `--safe-mode` from a second start reloads safe
  if ((argv || []).includes("--safe-mode")) reloadMain("flag", alive(win) && mainBad);
  showMain();
  openFilesFromArgv(argv); // Phase 6: file associations (Windows/Linux pass the file as an argument)
});
/** Camera streams and embeds: public HLS servers rarely send CORS headers, and YouTube embeds
 * need an http(s) referrer, which an app:// page doesn't have. */
function setupMediaHeaders() {
  const ses = session.defaultSession;
  ses.on("will-download", (_e, item) => {
    const url = item.getURL();
    const p = pendingDownloads.get(url);
    if (!p) return;
    pendingDownloads.delete(url);
    item.setSavePath(p.file);
    item.once("done", (_ev, state) => p.resolve(state === "completed" ? p.file : null));
  });
  ses.webRequest.onBeforeSendHeaders({ urls: ["*://*.youtube.com/*", "*://*.youtube-nocookie.com/*", "*://*.googlevideo.com/*"] }, (d, cb) => {
    const h = d.requestHeaders;
    if (!h.Referer && !h.referer) h.Referer = "https://thebigweather.app/";
    cb({ requestHeaders: h });
  });
  const media = /\.(m3u8|ts|m4s|aac|mp4|key|vtt)(\?|$)/i;
  ses.webRequest.onHeadersReceived((d, cb) => {
    const h = d.responseHeaders || {};
    const has = Object.keys(h).some((k) => k.toLowerCase() === "access-control-allow-origin");
    const ct = String(h["content-type"] || h["Content-Type"] || "");
    // media streams, plus map tiles from custom tile servers that don't send CORS headers
    if (!has && (media.test(d.url) || d.resourceType === "media" || /mpegurl|^image\/|protobuf|vector-tile|^audio\/|application\/ogg|video\/mp2t|scpls/i.test(ct))) {
      h["Access-Control-Allow-Origin"] = ["*"];
    }
    cb({ responseHeaders: h });
  });
}

app.whenReady().then(() => {
  setupMediaHeaders();
  setupDisplayMedia();
  protocol.handle("app", (req) => {
    const u = new URL(req.url);
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, "");
    const file = path.join(DIST, p || "index.html");
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(fs.existsSync(file) ? file : path.join(DIST, "index.html")).toString());
  });
  // Phase 6: start the bundled server first so the window finds it on its first connect
  if (desktop.localServer) startLocalServer();
  guardStart(); // 0.8.1
  createWindow();
  phase6Ready();
});
app.on("window-all-closed", () => app.quit());

// ---------- Phase 6: desktop settings, tray, file associations, bundled server ----------
const { spawn } = require("node:child_process");
const netMod = require("node:net");

let quitting = false;
let tray = null;
const desktopFile = () => path.join(app.getPath("userData"), "desktop.json");
const DESKTOP_DEFAULTS = { closeToTray: false, autoStart: false, startHidden: false, localServer: false, localPort: 0, trayHintShown: false, muted: false };
let desktop = { ...DESKTOP_DEFAULTS };
try {
  desktop = { ...DESKTOP_DEFAULTS, ...JSON.parse(fs.readFileSync(desktopFile(), "utf8")) };
} catch {}
function setDesktop(patch) {
  desktop = { ...desktop, ...patch };
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(desktopFile(), JSON.stringify(desktop, null, 1));
  } catch {}
}
function startHidden() {
  return process.argv.includes("--hidden") && desktop.closeToTray;
}

/** Start with the computer: login item on Windows/macOS, an XDG autostart entry on Linux. */
function applyAutoStart(on) {
  if (process.platform === "linux") {
    const dir = path.join(app.getPath("appData"), "autostart");
    const file = path.join(dir, "thebigweather.desktop");
    try {
      if (on) {
        const exe = process.env.APPIMAGE || process.execPath;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=TheBigWeather\nExec="${exe}" --hidden\nIcon=thebigweather\nX-GNOME-Autostart-enabled=true\n`);
      } else fs.rmSync(file, { force: true });
    } catch (err) {
      console.error("autostart", err.message);
    }
    return;
  }
  // the portable .exe unpacks to a temp folder each run: register the .exe itself
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"], ...(exe ? { path: exe } : {}) });
}

ipcMain.handle("desktop-get", () => ({ ...desktop, platform: process.platform, server: serverStatus() }));
ipcMain.handle("desktop-set", (_e, patch) => {
  const allowed = ["closeToTray", "autoStart", "startHidden", "localServer", "muted"];
  const clean = {};
  for (const k of allowed) if (patch && k in patch) clean[k] = !!patch[k];
  const before = { ...desktop };
  setDesktop(clean);
  if ("autoStart" in clean && clean.autoStart !== before.autoStart) applyAutoStart(clean.autoStart);
  if ("localServer" in clean && clean.localServer !== before.localServer) clean.localServer ? startLocalServer() : stopLocalServer();
  if ("muted" in clean) rebuildTrayMenu();
  return { ...desktop, platform: process.platform, server: serverStatus() };
});

// ----- tray -----
let trayCount = 0;
let trayText = "";
let baseTrayImg = null;
function trayImage(count) {
  if (!baseTrayImg) {
    baseTrayImg = nativeImage.createFromPath(ICON);
    if (baseTrayImg.isEmpty()) return baseTrayImg;
    baseTrayImg = baseTrayImg.resize({ width: process.platform === "win32" ? 16 : 22, height: process.platform === "win32" ? 16 : 22, quality: "best" });
  }
  if (!count || baseTrayImg.isEmpty()) return baseTrayImg;
  // red dot in the corner when warnings cover a saved point
  const { width, height } = baseTrayImg.getSize();
  const buf = Buffer.from(baseTrayImg.toBitmap()); // BGRA
  const r = Math.max(3, Math.round(width * 0.28));
  const cx = width - r - 0.5, cy = r - 0.5;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const i = (y * width + x) * 4;
      const edge = d > r - 1;
      buf[i] = edge ? 255 : 48; // B
      buf[i + 1] = edge ? 255 : 59; // G
      buf[i + 2] = 255; // R
      buf[i + 3] = 255;
    }
  return nativeImage.createFromBitmap(buf, { width, height });
}
function showMain() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.webContents.isCrashed()) win.webContents.reload(); // 0.8.1: a crashed page comes back
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}
function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "Show TheBigWeather", click: showMain },
    { label: "Mini radar widget", click: openMiniRadar },
    { type: "separator" },
    {
      label: "Mute alerts",
      type: "checkbox",
      checked: !!desktop.muted,
      click: (item) => {
        setDesktop({ muted: item.checked });
        if (win && !win.isDestroyed()) win.webContents.send("tray-mute", item.checked);
      },
    },
    { label: "Close to tray", type: "checkbox", checked: !!desktop.closeToTray, click: (item) => setDesktop({ closeToTray: item.checked }) },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}
function setupTray() {
  if (process.env.TBW_SHOT || process.env.TBW_NO_TRAY) return;
  try {
    tray = new Tray(trayImage(0));
  } catch (err) {
    console.error("tray unavailable", err.message);
    tray = null;
    return;
  }
  tray.setToolTip("TheBigWeather");
  tray.on("click", () => (alive(win) && win.isVisible() && win.isFocused() ? win.hide() : showMain())); // 0.8.1
  rebuildTrayMenu();
}
ipcMain.handle("tray-update", (_e, info) => {
  const count = Math.max(0, Math.min(999, Number(info?.count) || 0));
  const text = String(info?.text || "").slice(0, 120);
  if (count !== trayCount && tray) tray.setImage(trayImage(count));
  trayCount = count;
  trayText = text;
  if (tray) tray.setToolTip(count ? `TheBigWeather · ${count} warning${count > 1 ? "s" : ""}${text ? "\n" + text : ""}` : "TheBigWeather");
  if (process.platform === "linux") app.setBadgeCount(count);
  if (process.platform === "win32" && win && !win.isDestroyed()) win.setOverlayIcon(count ? trayImage(count) : null, count ? `${count} warnings` : "");
  return true;
});
let mini = null;
function openMiniRadar() {
  if (mini && !mini.isDestroyed()) return mini.show(), mini.focus();
  mini = new BrowserWindow({
    width: 420,
    height: 380,
    title: "TheBigWeather · mini radar",
    alwaysOnTop: true,
    backgroundColor: "#07090c",
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false },
  });
  mini.setMenuBarVisibility(false);
  const hash = "#popout=" + encodeURIComponent(JSON.stringify({ kind: "map", title: "Mini radar", data: { panes: { layout: "1", sync: false, list: [] } } }));
  if (isDev) mini.loadURL(process.env.TBW_DEV_URL + hash);
  else mini.loadURL("app://tbw/index.html" + hash);
  mini.on("closed", () => (mini = null));
}

// ----- file associations: .pal colour tables, .tbwws workspaces, Level II volumes -----
const OPEN_EXT = /\.(pal|tbwws|ar2v|gz|bz2|nexrad|v06|v07|v08)$/i;
let pendingFiles = [];
let rendererReady = false;
function openFilesFromArgv(argv) {
  const files = (argv || []).slice(1).filter((a) => !a.startsWith("-") && OPEN_EXT.test(a) && fs.existsSync(a));
  for (const f of files) queueFile(f);
}
function queueFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024 * 1024) return;
    const item = { name: path.basename(file), data: fs.readFileSync(file) };
    if (rendererReady && win && !win.isDestroyed()) win.webContents.send("open-file", item);
    else pendingFiles.push(item);
  } catch (err) {
    console.error("open file", err.message);
  }
}
app.on("open-file", (e, file) => {
  e.preventDefault();
  queueFile(file);
});
ipcMain.handle("renderer-ready", () => {
  rendererReady = true;
  const list = pendingFiles;
  pendingFiles = [];
  return list;
});

// ----- bundled local server ("Run the server in this app") -----
let srv = null; // { child, port, url, started, restarts }
let srvError = "";
let srvLog = [];
function serverBinary() {
  const exe = process.platform === "win32" ? "tbw-server.exe" : "tbw-server";
  const cands = [
    process.env.TBW_SERVER_BIN,
    app.isPackaged ? path.join(process.resourcesPath, "server", exe) : null,
    path.join(__dirname, "..", "..", "server", "bin", exe),
    path.join(__dirname, "..", "resources", "server", exe),
  ].filter(Boolean);
  return cands.find((c) => fs.existsSync(c)) || null;
}
function serverHome() {
  return path.join(app.getPath("userData"), "server");
}
function serverStatus() {
  return {
    available: !!serverBinary(),
    enabled: !!desktop.localServer,
    running: !!(srv && srv.child && srv.child.exitCode === null),
    url: srv ? srv.url : "",
    port: srv ? srv.port : desktop.localPort || 0,
    pid: srv && srv.child ? srv.child.pid : 0,
    error: srvError,
    data: path.join(serverHome(), "data"),
    // p8: why it failed (last log lines) and a separate server found on this computer
    ready: !!(srv && srv.ready),
    log: srvError ? srvLog : [],
    dedicated,
  };
}
/** Free on loopback *and* on all interfaces: a separate server listening on 0.0.0.0 / [::] can
 * share a port with a 127.0.0.1 listener on Windows, so a loopback-only probe isn't enough. */
function portFreeOn(port, host) {
  return new Promise((resolve) => {
    const s = netMod.createServer();
    // only "in use" / "not allowed" mean taken (no IPv6 on this machine is fine)
    s.once("error", (e) => resolve(!(e && (e.code === "EADDRINUSE" || e.code === "EACCES"))));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}
async function portFree(port) {
  for (const h of ["127.0.0.1", "0.0.0.0", "::"]) if (!(await portFreeOn(port, h))) return false;
  return true;
}
async function pickPort() {
  // keep the last port so the app's server entry stays valid; 8787 = a separate install,
  // 8790 = the local model worker
  for (const p of [desktop.localPort, 8788, 8789, 8791, 8792].filter((p) => p && p !== 8787 && p !== 8790)) if (await portFree(p)) return p;
  return new Promise((resolve) => {
    const s = netMod.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
/** Config: loopback only, no token for this computer; other settings stay editable in Server settings. */
function writeServerConfig(port) {
  const cfg = path.join(serverHome(), "data", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const bind = `127.0.0.1:${port}`;
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, `[server]\nbind = "${bind}"\nname = "This app"\nlocal_no_auth = true\ndata_dir = "data"\n`);
  } else {
    let t = fs.readFileSync(cfg, "utf8");
    t = /^bind\s*=.*$/m.test(t) ? t.replace(/^bind\s*=.*$/m, `bind = "${bind}"`) : t.replace(/^\[server\]\s*$/m, `[server]\nbind = "${bind}"`);
    t = t.replace(/^local_no_auth\s*=.*$/m, "local_no_auth = true");
    // p8: an absolute data_dir copied from another install would make both servers share one data folder
    if (/^data_dir\s*=\s*"(\/|[A-Za-z]:)/m.test(t)) t = t.replace(/^data_dir\s*=.*$/m, 'data_dir = "data"');
    fs.writeFileSync(cfg, t);
  }
  return cfg;
}
function serverLog() {
  const f = path.join(serverHome(), "server.log");
  try {
    if (fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, f + ".1");
  } catch {}
  return fs.openSync(f, "a");
}
/** Last lines of the server log (shown when the server fails). */
function serverLogTail(n = 25) {
  try {
    const f = path.join(serverHome(), "server.log");
    const st = fs.statSync(f);
    const len = Math.min(st.size, 16384);
    const fd = fs.openSync(f, "r");
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len);
    fs.closeSync(fd);
    return b.toString("utf8").split(/\r?\n/).filter((l) => l.trim()).slice(-n).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  } catch {
    return [];
  }
}
/** The most useful line of the log tail: the last error. */
function logError(tail) {
  const e = [...tail].reverse().find((l) => /error|panicked|in use|denied|failed/i.test(l));
  return e ? e.replace(/^\S+\s+(ERROR|WARN)\s+/, "").slice(0, 300) : "";
}
/** Does this server binary know the p8 flags (--bind / --port-file)? Older dev builds don't. */
const binFlags = new Map();
function supportsPortFile(bin) {
  if (!binFlags.has(bin)) {
    try {
      const r = require("node:child_process").spawnSync(bin, ["--help"], { timeout: 8000, windowsHide: true, encoding: "utf8" });
      binFlags.set(bin, String(r.stdout || "").includes("--port-file"));
    } catch {
      binFlags.set(bin, false);
    }
  }
  return binFlags.get(bin);
}
/** A separately installed server on this computer (start.sh / start.ps1 / service), if any. */
let dedicated = "";
async function probeDedicated() {
  for (const p of [8787]) {
    try {
      const r = await net.fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (!srv || srv.port !== p)) return (dedicated = `http://127.0.0.1:${p}`);
    } catch {}
  }
  return (dedicated = "");
}
async function startLocalServer() {
  if (srv && srv.child && srv.child.exitCode === null) return serverStatus();
  const bin = serverBinary();
  if (!bin) {
    srvError = "This build has no bundled server (resources/server/tbw-server).";
    return serverStatus();
  }
  srvError = "";
  srvLog = [];
  probeDedicated().catch(() => {});
  const port = await pickPort();
  if (port !== desktop.localPort) setDesktop({ localPort: port });
  let cfg;
  try {
    cfg = writeServerConfig(port);
  } catch (e) {
    srvError = `can't write the server config in ${serverHome()}: ${e.message}`;
    return serverStatus();
  }
  const log = serverLog();
  const portFile = path.join(serverHome(), "port");
  try {
    fs.rmSync(portFile, { force: true });
  } catch {}
  const modern = supportsPortFile(bin);
  // --bind-fallback: if the port got taken meanwhile (or a dedicated server binds it), listen on
  // a free one and report it in the port file instead of failing
  const args = modern ? ["--config", cfg, "--bind", `127.0.0.1:${port}`, "--bind-fallback", "--port-file", portFile, "run"] : ["--config", cfg, "run"];
  const child = spawn(bin, args, {
    cwd: serverHome(),
    stdio: ["ignore", log, log],
    windowsHide: true,
    // TBW_MANAGED: the server updates with the app (no self-update); TBW_CONFIG/TBW_HOME from a
    // separate install must not redirect this server to that install's data
    env: { ...process.env, TBW_CONFIG: "", TBW_HOME: "", TBW_MANAGED: "desktop", NO_COLOR: "1", RUST_LOG: process.env.RUST_LOG || "info,tower_http=warn" },
  });
  fs.closeSync(log);
  const prev = srv;
  srv = { child, port, url: `http://127.0.0.1:${port}`, started: Date.now(), restarts: prev ? prev.restarts : 0, ready: !modern };
  child.on("error", (err) => (srvError = `can't start ${bin}: ${err.message}`));
  child.on("exit", (code, sig) => {
    if (quitting || !desktop.localServer || !srv || srv.child !== child) return;
    srvLog = serverLogTail();
    const why = logError(srvLog);
    srvError = `server exited (${sig || code})${why ? `: ${why}` : ""}`;
    // crashed: restart with a growing delay, give up after a few quick failures
    const quick = Date.now() - srv.started < 30000;
    srv.restarts = quick ? srv.restarts + 1 : 0;
    if (srv.restarts > 4) return (srvError += " — not restarting; see server.log in the app data folder");
    setTimeout(() => desktop.localServer && !quitting && startLocalServer(), 1000 * 2 ** srv.restarts);
  });
  if (modern) {
    // wait (up to 20 s) for the address the server really listens on
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && srv && srv.child === child && child.exitCode === null) {
      try {
        const a = fs.readFileSync(portFile, "utf8").trim();
        const p = Number(a.split(":").pop());
        if (p > 0) {
          srv.port = p;
          srv.url = `http://127.0.0.1:${p}`;
          srv.ready = true;
          if (p !== desktop.localPort) setDesktop({ localPort: p });
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    if (srv && srv.child === child && !srv.ready && child.exitCode === null) srvError = "the server is taking long to start (see server.log)";
  }
  return serverStatus();
}
function stopLocalServer() {
  if (!srv || !srv.child || srv.child.exitCode !== null) return Promise.resolve();
  const child = srv.child;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 6000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    // SIGTERM = graceful shutdown on Linux; Windows has no signals, so this terminates the process
    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
    }
  });
}
ipcMain.handle("local-server", async (_e, action) => {
  if (action === "start") {
    setDesktop({ localServer: true });
    return startLocalServer();
  }
  if (action === "stop") {
    setDesktop({ localServer: false });
    await stopLocalServer();
    srv = null;
    return serverStatus();
  }
  if (action === "logs") {
    shell.openPath(serverHome());
    return serverStatus();
  }
  return serverStatus();
});
// last resort (app.exit, crashes in the main process): never leave the server running
process.on("exit", () => {
  try {
    if (srv && srv.child && srv.child.exitCode === null) srv.child.kill();
  } catch {}
});
let stopped = false;
app.on("before-quit", (e) => {
  quitting = true;
  // 0.8.1: quitting normally before the first minute isn't a failed start (closing a hung window is)
  if (guardState && guardState.pending && !mainBad) guardSave(guard.onCleanQuit(guardState));
  // quitting (tray, Cmd+Q): widget windows close without telling the renderer, so they reopen next start
  wf6Quitting = true;
  if (stopped || !srv || !srv.child || srv.child.exitCode !== null) return;
  e.preventDefault();
  stopLocalServer().finally(() => {
    stopped = true;
    app.quit();
  });
});

function phase6Ready() {
  setupTray();
  openFilesFromArgv(process.argv);
  // keep the OS login item in sync with the saved setting (e.g. after reinstall)
  if (desktop.autoStart && process.platform !== "linux") applyAutoStart(true);
}
// ---------- end Phase 6 ----------

// ---------- p8: auto-update from GitHub (releases + the `builds` branch) ----------
// 0.8.1: two sources, whichever is newer (a tie goes to the release):
//  - GitHub release: electron-updater for the AppImage and the NSIS installer;
//  - the repository's `builds` branch (tools/publish-builds.sh, no release needed): the file is
//    downloaded in parts, checked and joined by electron/repoupdate.cjs, then installed here:
//    AppImage → atomic rename over $APPIMAGE + relaunch; installer → run setup.exe silently after
//    quitting; portable .exe → a small .cmd swaps the file once the app has exited and restarts it.
// The portable .exe also takes releases this way. Unpackaged dev runs only link to the download page.
// The bundled server (resources/server) updates with the app.
// Offline / nothing published: errors are kept in the state for the Updates section, never shown as dialogs.
const RU = require("./repoupdate.cjs");
const RELEASES_URL = `https://github.com/${RU.REPO}/releases/latest`;
const BUILDS_URL = `https://github.com/${RU.REPO}/tree/${RU.BRANCH}`;
/** source: "release" (GitHub release) | "repo" (builds branch) | "" */
const upd = { state: "idle", current: app.getVersion(), version: "", notes: "", date: "", progress: 0, bytesPerSecond: 0, error: "", supported: false, reason: "", lastCheck: 0, auto: true, url: RELEASES_URL, source: "" };
let updater = null; // electron-updater (AppImage / NSIS)
let updKind = null; // "appimage" | "nsis" | "portable"
let updPending = null; // {source, version, via: "updater"} | {source, version, name, entry, base}
let updFile = null; // downloaded + verified file (custom path)
let updBusy = false;
const updFetch = (u, o) => net.fetch(u, o);
const updDir = () => path.join(app.getPath("userData"), "updates");
const updErr = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 300);
function updSend() {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send("update-state", { ...upd });
    } catch {}
  }
}
function updSet(p) {
  Object.assign(upd, p);
  updSend();
}
function updNotes(n) {
  if (Array.isArray(n)) return n.map((x) => x.note || "").join("\n\n");
  return String(n || "").replace(/<[^>]+>/g, "");
}
function updNotify(v) {
  try {
    const { Notification } = require("electron");
    if (Notification.isSupported()) new Notification({ title: "TheBigWeather update ready", body: `Version ${v} is downloaded. Restart the app to update.`, silent: true }).show();
  } catch {}
}
function setupUpdater() {
  upd.auto = desktop.updAuto !== false;
  upd.lastCheck = desktop.updLastCheck || 0;
  if (!app.isPackaged) return (upd.reason = "development build");
  if (process.env.PORTABLE_EXECUTABLE_FILE) updKind = "portable";
  else if (process.platform === "win32") updKind = "nsis";
  else if (process.platform === "linux" && process.env.APPIMAGE) updKind = "appimage";
  else return (upd.reason = "only the AppImage updates itself");
  upd.supported = true;
  // files of versions already installed
  try {
    for (const f of fs.readdirSync(updDir())) {
      const v = /TheBigWeather-(.+?)-(?:x86_64\.AppImage|setup\.exe|portable\.exe)$/.exec(f)?.[1];
      if (!v || RU.cmpVersion(v, upd.current) <= 0) fs.rmSync(path.join(updDir(), f), { force: true });
    }
  } catch {}
  if (updKind !== "portable") {
    try {
      updater = require("electron-updater").autoUpdater;
    } catch {
      updater = null; // releases then go through the custom path too
    }
  }
  if (updater) {
    updater.autoDownload = false; // updCheck decides which source to download from
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false; // stable channel only
    updater.allowDowngrade = false;
    updater.logger = null;
    const mine = () => updPending && updPending.via === "updater";
    updater.on("download-progress", (p) => mine() && updSet({ state: "downloading", progress: Math.round(p.percent || 0), bytesPerSecond: p.bytesPerSecond || 0 }));
    updater.on("update-downloaded", (i) => {
      if (!mine()) return;
      updSet({ state: "downloaded", version: i.version, progress: 100, notes: updNotes(i.releaseNotes) || upd.notes });
      updNotify(i.version);
    });
    updater.on("error", (e) => mine() && upd.state === "downloading" && updSet({ state: "error", error: updErr(e) }));
  }
  // check at start (after the window is up) and daily
  const due = () => upd.auto && Date.now() - (desktop.updLastCheck || 0) > 24 * 3600_000;
  setTimeout(() => due() && updCheck().catch(() => {}), 15_000);
  setInterval(() => due() && updCheck().catch(() => {}), 3 * 3600_000);
}
/** Latest release version from electron-builder's update metadata (no API rate limit); null = no release. */
async function updReleaseVersion() {
  const yml = process.platform === "win32" ? "latest.yml" : "latest-linux.yml";
  try {
    return RU.ymlVersion(await RU.getText(updFetch, `https://github.com/${RU.REPO}/releases/latest/download/${yml}`));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
/** A release asset as a one-part entry (portable .exe / no electron-updater): sizes from the API, hash from SHA256SUMS. */
async function updReleaseEntry(name) {
  const rel = JSON.parse(await RU.getText(updFetch, `https://api.github.com/repos/${RU.REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } }));
  const a = (rel.assets || []).find((x) => x.name === name);
  const s = (rel.assets || []).find((x) => x.name === "SHA256SUMS");
  if (!a || !s) throw new Error(`the release has no ${name}`);
  const sha256 = RU.parseSums(await RU.getText(updFetch, s.browser_download_url))[name];
  if (!sha256) throw new Error(`SHA256SUMS has no ${name}`);
  return { entry: { size: a.size, sha256, parts: [{ url: a.browser_download_url, size: a.size, sha256 }] }, notes: updNotes(rel.body), date: rel.published_at || "" };
}
async function updCheck() {
  if (!upd.supported || updBusy) return { ...upd };
  if (upd.state === "downloading" || upd.state === "downloaded" || upd.state === "installing") return { ...upd };
  updBusy = true;
  setDesktop({ updLastCheck: Date.now() });
  upd.lastCheck = Date.now();
  updSet({ state: "checking", error: "" });
  try {
    const [rel, rep] = await Promise.allSettled([updReleaseVersion(), RU.buildsInfo({ fetchFn: updFetch })]);
    if (rel.status === "rejected" && rep.status === "rejected") throw rel.reason;
    const relV = rel.status === "fulfilled" ? rel.value : null;
    const repo = rep.status === "fulfilled" ? rep.value : null;
    const pick = RU.pickUpdate(upd.current, relV, repo && repo.manifest.version);
    upd.url = pick && pick.source === "repo" ? BUILDS_URL : RELEASES_URL;
    if (!pick) {
      updPending = null;
      updSet({ state: "latest", version: upd.current, source: "" });
      return { ...upd };
    }
    const name = RU.appAssetName(updKind, pick.version);
    if (pick.source === "release" && updater) {
      const r = await updater.checkForUpdates();
      const i = r && r.updateInfo;
      if (!i || RU.cmpVersion(i.version, upd.current) <= 0) {
        updSet({ state: "latest", version: upd.current, source: "" });
        return { ...upd };
      }
      updPending = { source: "release", version: i.version, via: "updater" };
      updSet({ state: "available", version: i.version, notes: updNotes(i.releaseNotes), date: i.releaseDate || "", source: "release", progress: 0 });
    } else if (pick.source === "release") {
      const r = await updReleaseEntry(name);
      updPending = { source: "release", version: pick.version, name, entry: r.entry, base: "" };
      updSet({ state: "available", version: pick.version, notes: r.notes, date: r.date, source: "release", progress: 0 });
    } else {
      const m = repo.manifest;
      const entry = m.files[name];
      if (!entry) throw new Error(`build ${m.version} has no ${name}`);
      updPending = { source: "repo", version: m.version, name, entry, base: repo.base };
      const c = m.commit && m.commit !== "unknown" ? ` (commit ${m.commit.slice(0, 7)})` : "";
      updSet({ state: "available", version: m.version, notes: `Repository build${c}.`, date: m.date, source: "repo", progress: 0 });
    }
  } catch (e) {
    updSet({ state: "error", error: updErr(e) });
    return { ...upd };
  } finally {
    updBusy = false;
  }
  if (upd.auto) updDownload().catch(() => {});
  return { ...upd };
}
async function updDownload() {
  const p = updPending;
  if (!p || upd.state === "downloading" || upd.state === "downloaded") return { ...upd };
  updSet({ state: "downloading", progress: 0, bytesPerSecond: 0, error: "" });
  try {
    if (p.via === "updater") {
      await updater.downloadUpdate(); // progress + "downloaded" come from the events
      return { ...upd };
    }
    const target = updKind === "appimage" ? process.env.APPIMAGE : updKind === "portable" ? process.env.PORTABLE_EXECUTABLE_FILE : null;
    if (target && !RU.dirWritable(target)) throw new Error(`can't write to ${path.dirname(target)}`);
    fs.mkdirSync(updDir(), { recursive: true });
    for (const f of fs.readdirSync(updDir())) if (f !== p.name) fs.rmSync(path.join(updDir(), f), { force: true });
    updFile = await RU.downloadAsset({
      fetchFn: updFetch,
      entry: p.entry,
      base: p.base,
      dest: path.join(updDir(), p.name),
      onProgress: (x) => updSet({ state: "downloading", progress: x.total ? Math.floor((100 * x.received) / x.total) : 0, bytesPerSecond: x.bytesPerSecond }),
    });
    if (updPending !== p) return { ...upd };
    updSet({ state: "downloaded", progress: 100, bytesPerSecond: 0 });
    updNotify(p.version);
  } catch (e) {
    updSet({ state: "error", error: updErr(e) });
  }
  return { ...upd };
}
async function updInstall() {
  const p = updPending;
  if (!p || upd.state !== "downloaded") return { ...upd };
  try {
    if (p.via !== "updater") {
      if (!updFile || !fs.existsSync(updFile)) throw new Error("the downloaded file is gone; check again");
      // put the new files in place first: nothing is stopped when this fails
      if (updKind === "appimage") RU.installAppImage(updFile, process.env.APPIMAGE);
      else if (updKind === "portable") {
        const exe = process.env.PORTABLE_EXECUTABLE_FILE;
        fs.copyFileSync(updFile, `${exe}.new`);
        const cmd = path.join(require("node:os").tmpdir(), `tbw-update-${process.pid}.cmd`);
        fs.writeFileSync(cmd, RU.portableSwapScript(`${exe}.new`, exe));
        fs.rmSync(updFile, { force: true });
        updFile = cmd;
      }
    }
  } catch (e) {
    updSet({ state: "error", error: updErr(e) });
    return { ...upd };
  }
  updSet({ state: "installing" });
  // stop the bundled server first so its binary can be replaced
  quitting = true;
  await stopLocalServer().catch(() => {});
  stopped = true;
  setImmediate(() => {
    if (p.via === "updater") return updater.quitAndInstall(false, true);
    if (updKind === "appimage") {
      app.relaunch({ execPath: process.env.APPIMAGE, args: process.argv.slice(1) });
      return app.exit(0);
    }
    const run = updKind === "nsis" ? [updFile, ["--updated", "/S", "--force-run"]] : [process.env.ComSpec || "cmd.exe", ["/d", "/c", updFile]];
    try {
      spawn(run[0], run[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch (e) {
      quitting = false;
      return updSet({ state: "error", error: updErr(e) });
    }
    app.quit();
  });
  return { ...upd };
}
ipcMain.handle("update-get", () => ({ ...upd }));
ipcMain.handle("update-check", () => updCheck());
ipcMain.handle("update-download", () => updDownload());
ipcMain.handle("update-set", (_e, p) => {
  if (p && typeof p.auto === "boolean") {
    setDesktop({ updAuto: p.auto });
    upd.auto = p.auto;
  }
  updSend();
  return { ...upd };
});
ipcMain.handle("update-install", () => updInstall());
ipcMain.handle("update-open-page", () => shell.openExternal(upd.url || RELEASES_URL));
app.whenReady().then(setupUpdater);
