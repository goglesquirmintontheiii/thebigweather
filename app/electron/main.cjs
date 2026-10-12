// Electron shell for TheBigWeather.
const { app, BrowserWindow, ipcMain, shell, screen, nativeTheme, protocol, net, session, desktopCapturer, Tray, Menu, nativeImage } = require("electron");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");

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
  win.on("close", (e) => {
    if (!quitting && desktop.closeToTray && tray && !process.env.TBW_SHOT) {
      e.preventDefault();
      win.hide();
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
  if (!win) return null;
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
  if (!win || !/^https?:\/\//.test(url)) return null;
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
  if (!win) return null;
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
  if (win && !win.wf6Hooked) {
    win.wf6Hooked = true;
    win.on("closed", () => {
      wf6Quitting = true;
      for (const x of wf6Widgets.values()) if (!x.isDestroyed()) x.destroy();
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
  if (win) {
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }
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
  tray.on("click", () => (win && win.isVisible() && win.isFocused() ? win.hide() : showMain()));
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
  };
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = netMod.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
async function pickPort() {
  // keep the last port so the app's server entry stays valid; 8788+ avoids a separate install on 8787
  for (const p of [desktop.localPort, 8788, 8789, 8790, 8791].filter(Boolean)) if (await portFree(p)) return p;
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
async function startLocalServer() {
  if (srv && srv.child && srv.child.exitCode === null) return serverStatus();
  const bin = serverBinary();
  if (!bin) {
    srvError = "This build has no bundled server (resources/server/tbw-server).";
    return serverStatus();
  }
  srvError = "";
  const port = await pickPort();
  if (port !== desktop.localPort) setDesktop({ localPort: port });
  const cfg = writeServerConfig(port);
  const log = serverLog();
  const child = spawn(bin, ["--config", cfg, "run"], {
    cwd: serverHome(),
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", RUST_LOG: process.env.RUST_LOG || "info,tower_http=warn" },
  });
  fs.closeSync(log);
  const prev = srv;
  srv = { child, port, url: `http://127.0.0.1:${port}`, started: Date.now(), restarts: prev ? prev.restarts : 0 };
  child.on("error", (err) => (srvError = err.message));
  child.on("exit", (code, sig) => {
    if (quitting || !desktop.localServer || !srv || srv.child !== child) return;
    srvError = `server exited (${sig || code})`;
    // crashed: restart with a growing delay, give up after a few quick failures
    const quick = Date.now() - srv.started < 30000;
    srv.restarts = quick ? srv.restarts + 1 : 0;
    if (srv.restarts > 4) return (srvError += "; not restarting — see server.log in the app data folder");
    setTimeout(() => desktop.localServer && !quitting && startLocalServer(), 1000 * 2 ** srv.restarts);
  });
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
  if (stopped || !srv || !srv.child || srv.child.exitCode !== null) return;
  e.preventDefault();
  stopLocalServer().finally(() => {
    stopped = true;
    app.quit();
  });
});

function phase6Ready() {
  setupTray();
  if (desktop.localServer) startLocalServer();
  openFilesFromArgv(process.argv);
  // keep the OS login item in sync with the saved setting (e.g. after reinstall)
  if (desktop.autoStart && process.platform !== "linux") applyAutoStart(true);
}
// ---------- end Phase 6 ----------
