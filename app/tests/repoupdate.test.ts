// 0.8.1: updates from the `builds` branch — version order, manifest checks, part-by-part download
// with checksums, resume and retry (electron/repoupdate.cjs, against a local HTTP server).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RU = createRequire(import.meta.url)("../electron/repoupdate.cjs");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function testVersionOrder() {
  const c = RU.cmpVersion;
  assert.equal(c("0.8.1", "0.8.0"), 1);
  assert.equal(c("v0.10.0", "0.9.9"), 1);
  assert.equal(c("0.8.1", "0.8.1"), 0);
  assert.equal(c("0.8", "0.8.0"), 0);
  assert.equal(c("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(c("0.8.1-beta", "0.8.1"), -1);
  assert.equal(c("0.8.1", "0.8.1-rc.1"), 1);
  assert.equal(c("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  assert.equal(c("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(c("1.0.0-beta", "1.0.0-alpha.9"), 1);
  assert.equal(c("1.0.0-1", "1.0.0-a"), -1);
  assert.equal(c("garbage", "0.0.1"), -1);
  assert.equal(c("0.0.1", ""), 1);
  // the semver spec's example order
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i + 1 < order.length; i++) assert.equal(c(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
}

export function testPickUpdate() {
  const p = RU.pickUpdate;
  assert.deepEqual(p("0.8.0", "0.8.1", "0.8.1"), { source: "release", version: "0.8.1" }); // tie → release
  assert.deepEqual(p("0.8.0", "0.8.1", "0.8.2"), { source: "repo", version: "0.8.2" });
  assert.deepEqual(p("0.8.0", null, "0.8.1"), { source: "repo", version: "0.8.1" });
  assert.deepEqual(p("0.8.0", "0.8.1", null), { source: "release", version: "0.8.1" });
  assert.equal(p("0.8.1", "0.8.1", "0.8.1-rc.2"), null);
  assert.equal(p("0.8.1", null, null), null);
  assert.equal(p("0.9.0", "0.8.1", "0.8.2"), null);
}

function makeManifest(files: Record<string, Buffer>, partSize: number) {
  const parts: Record<string, Buffer> = {};
  const m: any = { version: "0.8.2", date: "2026-10-14T00:00:00Z", commit: "abc1234", files: {} };
  for (const [name, data] of Object.entries(files)) {
    const ps = [];
    for (let i = 0, k = 0; i < data.length || k === 0; i += partSize, k++) {
      const b = data.subarray(i, i + partSize);
      const path = `parts/${name}.part${String(k).padStart(2, "0")}`;
      parts[path] = b;
      ps.push({ path, size: b.length, sha256: sha(b) });
    }
    m.files[name] = { size: data.length, sha256: sha(data), parts: ps };
  }
  return { m, parts };
}

export function testManifest() {
  const { m } = makeManifest({ "a.bin": randomBytes(1000) }, 300);
  const r = RU.parseManifest(JSON.stringify(m));
  assert.equal(r.version, "0.8.2");
  assert.equal(r.files["a.bin"].parts.length, 4);
  const bad = (f: (x: any) => void, msg: RegExp) => {
    const x = structuredClone(m);
    f(x);
    assert.throws(() => RU.parseManifest(x), msg);
  };
  bad((x) => (x.version = "latest"), /version/);
  bad((x) => (x.files["a.bin"].parts[1].size += 1), /add up/);
  bad((x) => (x.files["a.bin"].parts[0].path = "../etc/passwd"), /bad part/);
  bad((x) => (x.files["a.bin"].sha256 = "xyz"), /bad entry/);
  assert.equal(RU.appAssetName("appimage", "0.8.2"), "TheBigWeather-0.8.2-x86_64.AppImage");
  assert.equal(RU.appAssetName("portable", "0.8.2"), "TheBigWeather-0.8.2-portable.exe");
  assert.equal(RU.ymlVersion("version: 0.8.1\nfiles:\n  - url: x\n"), "0.8.1");
  const h = "a".repeat(64);
  assert.deepEqual(RU.parseSums(`${h}  one.exe\r\n${"B".repeat(64)} *two.zip\n`), { "one.exe": h, "two.zip": "b".repeat(64) });
  assert.match(RU.portableSwapScript("C:\\x\\a.exe.new", "C:\\x\\a.exe"), /move \/y "%NEW%" "%DST%"[^\n]*\r\n/);
}

/** Local server for parts; `hook(path, n)` may return a replacement body (n = how often this path was asked for). */
async function serve(files: Record<string, Buffer | string>, hook?: (p: string, n: number) => Buffer | undefined) {
  const hits: Record<string, number> = {};
  const srv = createServer((req, res) => {
    const p = decodeURIComponent((req.url || "/").slice(1));
    hits[p] = (hits[p] || 0) + 1;
    const body = hook?.(p, hits[p]) ?? files[p];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => srv.close(r)) };
}

export async function testDownloadJoinResumeRetry() {
  const data = randomBytes(300_000);
  const { m, parts } = makeManifest({ "TheBigWeather-0.8.2-x86_64.AppImage": data }, 128 * 1024);
  const name = "TheBigWeather-0.8.2-x86_64.AppImage";
  const entry = m.files[name];
  const files: Record<string, Buffer> = {};
  for (const [p, b] of Object.entries(parts)) files[`builds/${p}`] = b;
  // the second part comes back corrupted the first time
  let corrupted = false;
  const s = await serve(files, (p) => (p.endsWith(".part01") && !corrupted ? ((corrupted = true), Buffer.alloc(files[p].length, 7)) : undefined));
  const dir = mkdtempSync(join(tmpdir(), "tbw-ru-"));
  try {
    const dest = join(dir, name);
    const seen: number[] = [];
    await RU.downloadAsset({ fetchFn: fetch, entry, base: `${s.base}/builds`, dest, onProgress: (x: any) => seen.push(x.received), retries: 3 });
    assert.ok(readFileSync(dest).equals(data), "joined file equals the original");
    assert.equal(s.hits[`builds/${entry.parts[1].path}`], 2, "the corrupted part was fetched again");
    assert.equal(seen[seen.length - 1], data.length);

    // resume: first part present and good, second part half there → only parts 2 and 3 are fetched
    writeFileSync(dest, Buffer.concat([data.subarray(0, 128 * 1024 + 5000)]));
    for (const k of Object.keys(s.hits)) delete s.hits[k];
    await RU.downloadAsset({ fetchFn: fetch, entry, base: `${s.base}/builds`, dest });
    assert.ok(readFileSync(dest).equals(data));
    assert.equal(s.hits[`builds/${entry.parts[0].path}`], undefined, "verified part 1 was kept");
    assert.equal(s.hits[`builds/${entry.parts[1].path}`], 1);

    // whole file already complete: nothing downloaded
    for (const k of Object.keys(s.hits)) delete s.hits[k];
    await RU.downloadAsset({ fetchFn: fetch, entry, base: `${s.base}/builds`, dest });
    assert.equal(Object.keys(s.hits).length, 0);

    // a part that never matches → error, and no partial file pretending to be complete
    const bad = structuredClone(entry);
    bad.parts[2].sha256 = "0".repeat(64);
    rmSync(dest);
    await assert.rejects(RU.downloadAsset({ fetchFn: fetch, entry: bad, base: `${s.base}/builds`, dest, retries: 2 }), /checksum/);
    assert.equal(statSync(dest).size, bad.parts[0].size + bad.parts[1].size);

    // single-part entry with an absolute url (release asset for the portable .exe)
    const one = { size: data.length, sha256: sha(data), parts: [{ url: `${s.base}/whole`, size: data.length, sha256: sha(data) }] };
    files["whole"] = data;
    const d2 = join(dir, "whole.exe");
    await RU.downloadAsset({ fetchFn: fetch, entry: one, base: "", dest: d2 });
    assert.ok(readFileSync(d2).equals(data));
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function testBuildsInfoPinsCommit() {
  const { m } = makeManifest({ "x.bin": randomBytes(10) }, 300);
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const s = await serve({ [`repos/o/r/commits/builds`]: commit + "\n", [`raw/${commit}/manifest.json`]: JSON.stringify(m), "raw/builds/manifest.json": JSON.stringify(m) });
  try {
    const a = await RU.buildsInfo({ fetchFn: fetch, repo: "o/r", rawBase: `${s.base}/raw`, apiBase: s.base });
    assert.equal(a.ref, commit);
    assert.equal(a.base, `${s.base}/raw/${commit}`);
    assert.equal(a.manifest.version, "0.8.2");
    // API unavailable → branch name
    const b = await RU.buildsInfo({ fetchFn: fetch, repo: "o/r", rawBase: `${s.base}/raw`, apiBase: `${s.base}/nope` });
    assert.equal(b.ref, "builds");
    // no builds branch → null
    assert.equal(await RU.buildsInfo({ fetchFn: fetch, repo: "o/r", branch: "none", rawBase: `${s.base}/raw`, apiBase: `${s.base}/nope` }), null);
  } finally {
    await s.close();
  }
}

export function testInstallAppImage() {
  const dir = mkdtempSync(join(tmpdir(), "tbw-ai-"));
  try {
    const app = join(dir, "TheBigWeather.AppImage");
    const src = join(dir, "new.AppImage");
    writeFileSync(app, "old");
    writeFileSync(src, "new");
    assert.ok(RU.dirWritable(app));
    RU.installAppImage(src, app);
    assert.equal(readFileSync(app, "utf8"), "new");
    assert.ok(!existsSync(src));
    if (process.platform !== "win32") assert.equal(statSync(app).mode & 0o777, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
