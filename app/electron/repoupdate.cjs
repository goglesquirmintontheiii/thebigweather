// 0.8.1: updates without a GitHub release. Pure helpers + downloader for the `builds` branch
// (tools/publish-builds.sh): manifest.json + parts/<asset>.partNN (<= 45 MB each), served by
// raw.githubusercontent.com. Also used for release assets the app installs itself (portable .exe).
// No Electron imports here (unit-tested in app/tests/repoupdate.test.ts).
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "goglesquirmintontheiii/thebigweather";
const BRANCH = "builds";

// ---------- versions ----------
/** "v1.2.3-beta.1+meta" → {core:[1,2,3], pre:["beta",1]}; null when not a version. */
function parseSemver(s) {
  const m = /^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?\s*$/.exec(String(s ?? ""));
  if (!m) return null;
  return { core: [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)], pre: m[4] ? m[4].split(".").map((x) => (/^\d+$/.test(x) ? +x : x)) : [] };
}
/** Semver order (a prerelease sorts before its release). Invalid versions sort lowest. → -1 | 0 | 1 */
function cmpVersion(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p > q ? 1 : -1;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

/**
 * Which update to take: the newer of the latest release and the builds branch (a tie goes to the
 * release), and only when it is newer than `current`. → {source: "release"|"repo", version} | null
 */
function pickUpdate(current, releaseVersion, repoVersion) {
  let best = null;
  if (releaseVersion && parseSemver(releaseVersion)) best = { source: "release", version: releaseVersion };
  if (repoVersion && parseSemver(repoVersion) && (!best || cmpVersion(repoVersion, best.version) > 0)) best = { source: "repo", version: repoVersion };
  return best && cmpVersion(best.version, current) > 0 ? best : null;
}

// ---------- manifest ----------
const HEX64 = /^[0-9a-f]{64}$/;
/** Validate a builds manifest (text or object). Throws with a short message when it is broken. */
function parseManifest(input) {
  const m = typeof input === "string" ? JSON.parse(input) : input;
  if (!m || typeof m !== "object") throw new Error("manifest: not an object");
  if (!parseSemver(m.version)) throw new Error("manifest: bad version");
  if (!m.files || typeof m.files !== "object") throw new Error("manifest: no files");
  for (const [name, f] of Object.entries(m.files)) {
    if (!Number.isSafeInteger(f?.size) || f.size < 0 || !HEX64.test(f?.sha256 ?? "") || !Array.isArray(f.parts) || !f.parts.length) throw new Error(`manifest: bad entry ${name}`);
    let sum = 0;
    for (const p of f.parts) {
      if (typeof p?.path !== "string" || !p.path.startsWith("parts/") || p.path.includes("..") || !Number.isSafeInteger(p.size) || p.size < 0 || !HEX64.test(p.sha256 ?? "")) throw new Error(`manifest: bad part of ${name}`);
      sum += p.size;
    }
    if (sum !== f.size) throw new Error(`manifest: parts of ${name} don't add up`);
  }
  return { version: String(m.version).replace(/^[vV]/, ""), date: String(m.date ?? ""), commit: String(m.commit ?? ""), files: m.files };
}

/** Asset names the app uses, per install kind. */
function appAssetName(kind, version) {
  if (kind === "appimage") return `TheBigWeather-${version}-x86_64.AppImage`;
  if (kind === "nsis") return `TheBigWeather-${version}-setup.exe`;
  if (kind === "portable") return `TheBigWeather-${version}-portable.exe`;
  return null;
}

/** "version: 0.8.1" from electron-builder's latest*.yml */
function ymlVersion(text) {
  const m = /^version:\s*['"]?([^'"\s]+)/m.exec(String(text ?? ""));
  return m ? m[1] : null;
}
/** SHA256SUMS text → {name: sha256} */
function parseSums(text) {
  const out = {};
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(l);
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

// ---------- network ----------
async function getText(fetchFn, url, { timeout = 20000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetchFn(url, { headers: { "User-Agent": "TheBigWeather", ...headers }, signal: ac.signal, cache: "no-store" });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Current builds-branch manifest, pinned to the branch's commit when the GitHub API answers (so a
 * publish during the download can't mix versions); otherwise the branch name (+ per-part checksums).
 * → {ref, base, manifest} | null when the branch has no manifest (404).
 */
async function buildsInfo({ fetchFn, repo = REPO, branch = BRANCH, rawBase, apiBase = "https://api.github.com" }) {
  const raw = (rawBase || `https://raw.githubusercontent.com/${repo}`).replace(/\/$/, "");
  let ref = branch;
  try {
    const sha = (await getText(fetchFn, `${apiBase}/repos/${repo}/commits/${branch}`, { timeout: 10000, headers: { Accept: "application/vnd.github.sha" } })).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) ref = sha;
  } catch {}
  let text;
  try {
    text = await getText(fetchFn, `${raw}/${ref}/manifest.json`);
  } catch (e) {
    if (ref === branch) {
      if (e.status === 404) return null;
      throw e;
    }
    ref = branch;
    try {
      text = await getText(fetchFn, `${raw}/${ref}/manifest.json`);
    } catch (e2) {
      if (e2.status === 404) return null;
      throw e2;
    }
  }
  return { ref, base: `${raw}/${ref}`, manifest: parseManifest(text) };
}

/** Hash bytes [start, start+len) of a file. */
async function hashRange(file, start, len) {
  if (len === 0) return crypto.createHash("sha256").digest("hex");
  const h = crypto.createHash("sha256");
  await new Promise((res, rej) => fs.createReadStream(file, { start, end: start + len - 1 }).on("data", (c) => h.update(c)).on("end", res).on("error", rej));
  return h.digest("hex");
}

/**
 * Download an asset part by part into `dest`, checking each part's SHA-256 while it streams in and
 * the whole file at the end. Parts already in `dest` (an interrupted earlier download) are
 * re-checked and kept. `entry` = {size, sha256, parts:[{path|url, size, sha256}]}; `base` resolves
 * part paths. onProgress({received, total, bytesPerSecond}). Resolves to dest.
 */
async function downloadAsset({ fetchFn, entry, base, dest, onProgress, signal, retries = 3, partTimeout = 15 * 60_000 }) {
  const total = entry.size;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let have = 0;
  try {
    have = fs.statSync(dest).size;
  } catch {}
  let off = 0, keep = true, received = 0, cur = 0; // received: this session (speed); cur: current part
  const t0 = Date.now();
  let lastEmit = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 250) return;
    lastEmit = now;
    const dt = (now - t0) / 1000;
    onProgress?.({ received: off + cur, total, bytesPerSecond: dt > 0.5 ? Math.round(received / dt) : 0 });
  };
  for (const p of entry.parts) {
    if (keep && have >= off + p.size && (await hashRange(dest, off, p.size)) === p.sha256) {
      off += p.size;
      emit(true);
      continue;
    }
    if (keep) {
      keep = false;
      fs.writeFileSync(dest, "", { flag: "a" });
      fs.truncateSync(dest, off);
    }
    const url = p.url || `${base}/${p.path}`;
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new Error("cancelled");
      let got = 0;
      cur = 0;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), partTimeout);
        const onAbort = () => ac.abort();
        signal?.addEventListener?.("abort", onAbort);
        try {
          const r = await fetchFn(url, { headers: { "User-Agent": "TheBigWeather" }, signal: ac.signal, cache: "no-store" });
          if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} for ${p.path || p.url}`);
          const h = crypto.createHash("sha256");
          const fd = fs.openSync(dest, "r+");
          try {
            let pos = off;
            for await (const chunk of r.body) {
              const b = Buffer.from(chunk);
              got += b.length;
              if (got > p.size) throw new Error("part is larger than expected");
              h.update(b);
              fs.writeSync(fd, b, 0, b.length, pos);
              pos += b.length;
              received += b.length;
              cur = got;
              emit(false);
            }
          } finally {
            fs.closeSync(fd);
          }
          if (got !== p.size || h.digest("hex") !== p.sha256) throw new Error(`checksum mismatch in ${p.path || "download"}`);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        received -= got;
        cur = 0;
        fs.truncateSync(dest, off);
        if (signal?.aborted) throw new Error("cancelled");
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (lastErr) throw lastErr;
    off += p.size;
    cur = 0;
  }
  if (fs.statSync(dest).size !== off) fs.truncateSync(dest, off);
  if (off !== total || (await hashRange(dest, 0, total)) !== entry.sha256) {
    try {
      fs.unlinkSync(dest);
    } catch {}
    throw new Error("the joined file doesn't match its checksum");
  }
  emit(true);
  return dest;
}

// ---------- installing ----------
/** Replace the AppImage atomically: copy next to it, chmod +x, rename over it. */
function installAppImage(src, appImage) {
  const dir = path.dirname(appImage);
  const tmp = path.join(dir, `.${path.basename(appImage)}.update-${process.pid}`);
  try {
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, appImage);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
  try {
    fs.unlinkSync(src);
  } catch {}
}

/** Can we write next to this file (the AppImage / portable .exe)? */
function dirWritable(file) {
  const t = path.join(path.dirname(file), `.tbw-write-test-${process.pid}`);
  try {
    fs.writeFileSync(t, "x");
    fs.unlinkSync(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows portable: a .cmd that waits until the running .exe can be replaced (the portable
 * launcher holds it until the app exits), moves the new one over it and starts it.
 */
function portableSwapScript(newExe, exe) {
  return [
    "@echo off",
    "setlocal",
    `set "NEW=${newExe}"`,
    `set "DST=${exe}"`,
    "set n=0",
    ":retry",
    'move /y "%NEW%" "%DST%" >nul 2>&1 && goto ok',
    "set /a n+=1",
    "if %n% geq 180 goto end",
    "ping -n 2 127.0.0.1 >nul",
    "goto retry",
    ":ok",
    'start "" "%DST%"',
    ":end",
    '(goto) 2>nul & del "%~f0"',
    "",
  ].join("\r\n");
}

module.exports = { REPO, BRANCH, parseSemver, cmpVersion, pickUpdate, parseManifest, appAssetName, ymlVersion, parseSums, getText, buildsInfo, hashRange, downloadAsset, installAppImage, dirWritable, portableSwapScript };
