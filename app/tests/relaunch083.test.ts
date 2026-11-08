// 0.8.3: restarting the AppImage after an update (electron/repoupdate.cjs): the command, arguments
// and environment of the new instance, and the new instance waiting for the old one to exit.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const RU = createRequire(import.meta.url)("../electron/repoupdate.cjs");

export function testAppImageRelaunchUsesAppImagePath() {
  const env = {
    APPIMAGE: "/home/u/Apps/Stormiq-0.8.2-x86_64.AppImage",
    APPDIR: "/tmp/.mount_StormiAbC",
    ARGV0: "Stormiq",
    OWD: "/home/u",
    HOME: "/home/u",
    LD_LIBRARY_PATH: "/tmp/.mount_StormiAbC/usr/lib:/opt/lib",
    PATH: "/tmp/.mount_StormiAbC:/tmp/.mount_StormiAbC/usr/bin:/usr/bin:/bin",
    XDG_DATA_DIRS: "/tmp/.mount_StormiAbC/usr/share",
    DISPLAY: ":0",
  };
  const r = RU.appImageRelaunch({ appImage: env.APPIMAGE, argv: ["--no-sandbox", "--updated-relaunch", "--inspect=9229"], env, pid: 4242 });
  assert.equal(r.cmd, "/home/u/Apps/Stormiq-0.8.2-x86_64.AppImage", "the AppImage file, never process.execPath inside the mount");
  assert.deepEqual(r.args, ["--no-sandbox", RU.RELAUNCH_FLAG]);
  assert.equal(r.env[RU.WAIT_PID_ENV], "4242");
  for (const k of ["APPIMAGE", "APPDIR", "ARGV0", "OWD"]) assert.ok(!(k in r.env), k);
  assert.equal(r.env.LD_LIBRARY_PATH, "/opt/lib");
  assert.equal(r.env.PATH, "/usr/bin:/bin");
  assert.ok(!("XDG_DATA_DIRS" in r.env), "only old-mount entries: dropped");
  assert.equal(r.env.HOME, "/home/u");
  assert.equal(r.env.DISPLAY, ":0");
  // a sibling folder that merely starts with the mount's name is kept
  const r2 = RU.appImageRelaunch({ appImage: "/a/S.AppImage", env: { APPDIR: "/tmp/.mount_X", PATH: "/tmp/.mount_Xyz/bin:/usr/bin" } });
  assert.equal(r2.env.PATH, "/tmp/.mount_Xyz/bin:/usr/bin");
  assert.ok(!(RU.WAIT_PID_ENV in r2.env));
}

export function testAppImageRelaunchRejectsBadPath() {
  assert.equal(RU.appImageRelaunch({ appImage: "", env: {} }), null);
  assert.equal(RU.appImageRelaunch({ appImage: "relative/S.AppImage", env: {} }), null);
  assert.equal(RU.appImageRelaunch({ appImage: undefined, env: {} }), null);
}

export function testWaitForExit() {
  let t = 0;
  const now = () => t;
  const sleep = (ms: number) => void (t += ms);
  // not set / ourselves / init: no wait
  assert.equal(RU.waitForExit({ pid: NaN, alive: () => true, sleep, now }), "none");
  assert.equal(RU.waitForExit({ pid: 77, self: 77, alive: () => true, sleep, now }), "none");
  assert.equal(RU.waitForExit({ pid: 1, alive: () => true, sleep, now }), "none");
  // already gone
  assert.equal(RU.waitForExit({ pid: 50, self: 1, alive: () => false, sleep, now }), "exited");
  // exits after ~1 s
  t = 0;
  assert.equal(RU.waitForExit({ pid: 50, self: 1, alive: () => t < 1000, sleep, now }), "exited");
  assert.ok(t >= 1000 && t < 1300, String(t));
  // never exits: gives up
  t = 0;
  assert.equal(RU.waitForExit({ pid: 50, self: 1, timeoutMs: 3000, alive: () => true, sleep, now }), "timeout");
  assert.ok(t >= 3000);
  // the real check: a pid that can't exist
  assert.equal(RU.waitForExit({ pid: 2 ** 22 + 12345, timeoutMs: 200 }), "exited");
}
