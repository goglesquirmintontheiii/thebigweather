// Electron shell for TheBigWeather.
const { app, BrowserWindow, ipcMain, shell, screen, nativeTheme, protocol, net, session, desktopCapturer } = require("electron");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");

const isDev = !!process.env.TBW_DEV_URL;
const DIST = path.join(__dirname, "..", "dist");

// Serve the UI from app://tbw so fetch, module workers and storage behave like a normal secure origin.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
nativeTheme.themeSource = "dark";

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
    show: !process.env.TBW_SHOT_HIDDEN,
    icon: path.join(__dirname, "..", "build", "icon.png"),
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

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
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
});
app.on("window-all-closed", () => app.quit());
