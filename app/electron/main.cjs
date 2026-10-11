// Electron shell for TheBigWeather.
const { app, BrowserWindow, ipcMain, shell, screen, nativeTheme, protocol, net } = require("electron");
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

ipcMain.handle("app-info", () => ({ version: app.getVersion(), platform: process.platform, displays: screen.getAllDisplays().length }));

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.whenReady().then(() => {
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
