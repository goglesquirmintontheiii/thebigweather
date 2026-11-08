// 0.8.2: TheBigWeather → Stormiq. Electron's userData folder follows productName, so the first
// Stormiq start moves <appData>/TheBigWeather to <appData>/Stormiq (settings, localStorage,
// IndexedDB, crash guard, plugins, offline tiles, bundled-server data). Pure planning + an fs-based
// mover with injectable fs (unit-tested in app/tests/rename082.test.ts). No Electron imports here.
"use strict";
const nodeFs = require("node:fs");
const path = require("node:path");

const OLD_NAME = "TheBigWeather";
const NEW_NAME = "Stormiq";

// Entries Chromium / Electron may create in a fresh userData folder before (or right after) this
// runs. A new folder holding only these has no user data yet and may be replaced by the old one.
const TRANSIENT = new Set(["Crashpad", "crashpad", "SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile", "logs", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "ShaderCache", "GrShaderCache", "Code Cache", "component_crx_cache", "Crash Reports", ".DS_Store"]);

/**
 * What to do with the old and new userData folders.
 * newEntries: names inside the new folder (only looked at when it exists).
 * → "none" (no old folder) | "keep-new" (both have data: keep the new one) | "move" (only the old one)
 *   | "replace-empty" (the new one exists but holds nothing of the user's: move the old one over it)
 */
function planUserDataMigration({ oldExists, newExists, newEntries = [] }) {
  if (!oldExists) return "none";
  if (!newExists) return "move";
  return newEntries.some((n) => !TRANSIENT.has(n)) ? "keep-new" : "replace-empty";
}

/**
 * Move oldDir → newDir following the plan. rename first; when that fails (another drive, a file
 * locked on Windows) copy recursively and leave the old folder in place.
 * → {action, method: "rename"|"copy"|null, error?}
 */
function migrateUserData({ oldDir, newDir, fs = nodeFs, log = () => {} }) {
  const exists = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (path.resolve(oldDir) === path.resolve(newDir)) return { action: "none", method: null };
  const oldExists = exists(oldDir);
  const newExists = exists(newDir);
  let newEntries = [];
  if (newExists && oldExists) {
    try {
      newEntries = fs.readdirSync(newDir);
    } catch {}
  }
  const action = planUserDataMigration({ oldExists, newExists, newEntries });
  if (action === "none") return { action, method: null };
  if (action === "keep-new") {
    log(`userData: both ${oldDir} and ${newDir} exist; keeping ${newDir}`);
    return { action, method: null };
  }
  if (action === "replace-empty") {
    try {
      fs.rmSync(newDir, { recursive: true, force: true });
    } catch (e) {
      log(`userData: can't clear the empty ${newDir}: ${e.message}`);
      return { action, method: null, error: e.message };
    }
  }
  try {
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    log(`userData: moved ${oldDir} → ${newDir}`);
    return { action, method: "rename" };
  } catch (e) {
    try {
      fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false });
      log(`userData: copied ${oldDir} → ${newDir} (rename failed: ${e.code || e.message}); the old folder is kept`);
      return { action, method: "copy" };
    } catch (e2) {
      log(`userData: migration from ${oldDir} failed: ${e2.message}`);
      return { action, method: null, error: e2.message };
    }
  }
}

/** Linux autostart entry names: the current one and the ones to remove. */
const AUTOSTART_FILE = "stormiq.desktop";
const OLD_AUTOSTART_FILES = ["thebigweather.desktop"];

module.exports = { OLD_NAME, NEW_NAME, TRANSIENT, planUserDataMigration, migrateUserData, AUTOSTART_FILE, OLD_AUTOSTART_FILES };
