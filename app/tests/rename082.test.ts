// 0.8.2: TheBigWeather → Stormiq. userData migration (electron/rename.cjs) and update compatibility:
// a builds branch made by tools/publish-builds.sh lists the old TheBigWeather-<v>-… names too, so
// an installed 0.8.1 app (which only knows the old names) still finds and downloads the update.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, linkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const req = createRequire(import.meta.url);
const RN = req("../electron/rename.cjs");
const RU = req("../electron/repoupdate.cjs");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function testPlanUserDataMigration() {
  const p = RN.planUserDataMigration;
  assert.equal(p({ oldExists: false, newExists: false }), "none");
  assert.equal(p({ oldExists: false, newExists: true, newEntries: ["Local Storage"] }), "none");
  assert.equal(p({ oldExists: true, newExists: false }), "move");
  assert.equal(p({ oldExists: true, newExists: true, newEntries: ["Local Storage", "desktop.json"] }), "keep-new");
  // a new folder Chromium created before we ran (lock files, crash dumps) holds nothing of the user's
  assert.equal(p({ oldExists: true, newExists: true, newEntries: [] }), "replace-empty");
  assert.equal(p({ oldExists: true, newExists: true, newEntries: ["SingletonLock", "Crashpad"] }), "replace-empty");
  assert.equal(RN.OLD_NAME, "TheBigWeather");
  assert.equal(RN.NEW_NAME, "Stormiq");
}

function tree(dir: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
}

export function testMigrateUserDataFs() {
  const base = mkdtempSync(join(tmpdir(), "tbw-rn-"));
  try {
    const oldDir = join(base, "TheBigWeather"), newDir = join(base, "Stormiq");
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    // nothing to do
    assert.deepEqual(RN.migrateUserData({ oldDir, newDir, log }), { action: "none", method: null });
    // move: settings, crash guard, nested storage come along
    tree(oldDir, { "crashguard.json": '{"fails":1}', "desktop.json": "{}", "Local Storage/leveldb/000003.log": "ls" });
    let r = RN.migrateUserData({ oldDir, newDir, log });
    assert.deepEqual(r, { action: "move", method: "rename" });
    assert.ok(!existsSync(oldDir));
    assert.equal(readFileSync(join(newDir, "crashguard.json"), "utf8"), '{"fails":1}');
    assert.equal(readFileSync(join(newDir, "Local Storage/leveldb/000003.log"), "utf8"), "ls");
    assert.match(logs.join("\n"), /moved/);
    // both have data: keep the new one, leave the old one alone
    tree(oldDir, { "desktop.json": '{"old":true}' });
    r = RN.migrateUserData({ oldDir, newDir, log });
    assert.equal(r.action, "keep-new");
    assert.equal(readFileSync(join(newDir, "desktop.json"), "utf8"), "{}");
    assert.ok(existsSync(join(oldDir, "desktop.json")));
    // the new folder only has Chromium's lock file: the old data replaces it
    rmSync(newDir, { recursive: true });
    tree(newDir, { SingletonLock: "" });
    r = RN.migrateUserData({ oldDir, newDir, log });
    assert.deepEqual(r, { action: "replace-empty", method: "rename" });
    assert.equal(readFileSync(join(newDir, "desktop.json"), "utf8"), '{"old":true}');
    // rename fails (another drive / a locked file on Windows): copy, keep the old folder
    rmSync(newDir, { recursive: true });
    tree(oldDir, { "desktop.json": '{"copy":1}', "plugins/a.js": "x" });
    const fsFail = {
      ...req("node:fs"),
      renameSync: () => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      },
    };
    r = RN.migrateUserData({ oldDir, newDir, fs: fsFail, log });
    assert.deepEqual(r, { action: "move", method: "copy" });
    assert.equal(readFileSync(join(newDir, "plugins/a.js"), "utf8"), "x");
    assert.ok(existsSync(join(oldDir, "desktop.json")), "the old folder stays after a copy");
    assert.match(logs.join("\n"), /copied .*EXDEV/);
    // same folder (e.g. --user-data-dir pointing at it): never touched
    assert.equal(RN.migrateUserData({ oldDir: newDir, newDir, log }).action, "none");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** The 0.8.1 app's lookup (repoupdate.cjs before the rename): old names only. */
const name081 = (kind: string, v: string) => ({ appimage: `TheBigWeather-${v}-x86_64.AppImage`, nsis: `TheBigWeather-${v}-setup.exe`, portable: `TheBigWeather-${v}-portable.exe` })[kind]!;

export async function testPublishBuildsAliasesFor081() {
  const have = (t: string) => spawnSync("bash", ["-c", `command -v ${t}`]).status === 0;
  if (!["bash", "git", "sha256sum", "split"].every(have)) return console.log("     (skipped: needs bash, git, sha256sum, split)");
  const base = mkdtempSync(join(tmpdir(), "tbw-pb-"));
  try {
    const from = join(base, "assets"), out = join(base, "branch");
    mkdirSync(from);
    const files: Record<string, Buffer> = {
      "Stormiq-0.8.2-x86_64.AppImage": randomBytes(250_000),
      "Stormiq-0.8.2-setup.exe": randomBytes(90_000),
      "Stormiq-0.8.2-portable.exe": randomBytes(70_000),
      "tbw-server-0.8.2-linux-x86_64": randomBytes(5_000),
    };
    for (const [n, b] of Object.entries(files)) writeFileSync(join(from, n), b);
    linkSync(join(from, "Stormiq-0.8.2-portable.exe"), join(from, "TheBigWeather-0.8.2-portable.exe")); // release.sh's alias
    const r = spawnSync("bash", [join(ROOT, "tools/publish-builds.sh"), "--dry-run", "--from", from, "--part-size", "64K"], { env: { ...process.env, TBW_BUILDS_DIR: out }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const m = RU.parseManifest(readFileSync(join(out, "manifest.json"), "utf8"));
    const parts = readdirSync(join(out, "parts"));
    assert.ok(parts.every((p) => !p.startsWith("TheBigWeather-")), "aliases add no part files");
    const sums = RU.parseSums(readFileSync(join(out, "SHA256SUMS"), "utf8"));
    for (const kind of ["appimage", "nsis", "portable"]) {
      const n = RU.appAssetName(kind, "0.8.2"), o = name081(kind, "0.8.2");
      assert.ok(m.files[n] && m.files[o], `${kind}: both names listed`);
      assert.deepEqual(m.files[o], m.files[n], `${kind}: alias = same entry`);
      assert.equal(sums[o], sums[n]);
      // the 0.8.2 app takes the new name
      assert.equal(RU.pickAssetName(kind, "0.8.2", (x: string) => !!m.files[x]), n);
    }
    assert.ok(!m.files["TheBigWeather-tbw-server-0.8.2-linux-x86_64"] && m.files["tbw-server-0.8.2-linux-x86_64"], "server assets keep their names");
    // a 0.8.1 app downloads the AppImage by its old name from the branch and gets the right bytes
    const srv = createServer((q, s) => {
      const f = join(out, decodeURIComponent((q.url || "/").replace(/^\/builds\//, "")));
      if (!f.startsWith(out) || !existsSync(f) || !statSync(f).isFile()) return void s.writeHead(404).end();
      s.writeHead(200).end(readFileSync(f));
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    try {
      const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}/builds`;
      const dest = join(base, "dl", name081("appimage", "0.8.2"));
      await RU.downloadAsset({ fetchFn: fetch, entry: m.files[name081("appimage", "0.8.2")], base: baseUrl, dest });
      assert.ok(readFileSync(dest).equals(files["Stormiq-0.8.2-x86_64.AppImage"]));
    } finally {
      await new Promise((res) => srv.close(res));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
