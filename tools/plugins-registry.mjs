#!/usr/bin/env node
// Plugin marketplace registry tool (0.8.2).
//
//   node tools/plugins-registry.mjs            validate every plugins/<id>/plugin.json and rewrite
//                                              plugins/registry.json (with sha256 checksums)
//   node tools/plugins-registry.mjs --check    validate only; exit 1 if registry.json is out of date
//   node tools/plugins-registry.mjs --remote   also download and validate the external repos' manifests
//   node tools/plugins-registry.mjs --add-repo owner/name[@ref][:path]
//                                              add an external GitHub repo entry
//
// Folder plugins are listed in folder-name order; external repo entries keep their order after them.
// The app checks the sha256 of plugin.json and the entry file on install when they're listed.
// For an external repo, checksums are only written when it's pinned to a commit (40-hex ref),
// because a branch can change at any time.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "plugins");
const REG = join(ROOT, "registry.json");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REL_RE = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9_. /()-]+$/;
const isRel = (p) => typeof p === "string" && p.length > 0 && p.length < 200 && REL_RE.test(p) && !/^[a-z]+:/i.test(p);
const PERMS = ["map", "panel", "alerts", "server", "settings", "audio", "network", "notifications"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
let errors = 0;
let warnings = 0;
const err = (where, msg) => (errors++, console.error(`✗ ${where}: ${msg}`));
const warn = (where, msg) => (warnings++, console.warn(`! ${where}: ${msg}`));

/** Validate a manifest object; `fileExists(rel)` / `fileSize(rel)` check referenced files (optional). */
function validate(where, m, fileExists, fileSize) {
  if (!m || typeof m !== "object") return err(where, "plugin.json is not an object");
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) err(where, '"id" must be lowercase letters, digits, . _ -');
  if (typeof m.name !== "string" || !m.name || m.name.length > 60) err(where, '"name" is required (≤ 60 chars)');
  if (!/^\d+\.\d+(\.\d+)?([-+][\w.]+)?$/.test(m.version ?? "")) err(where, '"version" must look like 1.0.0');
  if (!isRel(m.entry) || !/\.m?js$/.test(m.entry)) err(where, '"entry" must be a .js file in the plugin folder');
  if (m.summary != null && (typeof m.summary !== "string" || m.summary.length > 160)) err(where, '"summary" must be text (≤ 160 chars)');
  if (!m.summary) warn(where, 'no "summary" (one line shown on the card)');
  if (m.author != null && typeof m.author !== "string") err(where, '"author" must be text');
  for (const k of ["icon", "banner"]) if (m[k] != null && !isRel(m[k])) err(where, `"${k}" must be a file in the plugin folder`);
  if (!m.icon) warn(where, 'no "icon"');
  if (m.screenshots != null && !Array.isArray(m.screenshots)) err(where, '"screenshots" must be a list');
  for (const s of m.screenshots ?? []) if (!isRel(typeof s === "string" ? s : s?.src)) err(where, `bad screenshot ${JSON.stringify(s)}`);
  if (m.permissions != null && !Array.isArray(m.permissions)) err(where, '"permissions" must be a list');
  for (const p of m.permissions ?? []) if (!PERMS.includes(p)) warn(where, `unknown permission "${p}" (known: ${PERMS.join(", ")})`);
  if (m.homepage != null && !/^https:\/\//.test(m.homepage)) err(where, '"homepage" must be an https:// link');
  if (m.minAppVersion != null && !/^\d+(\.\d+){0,2}$/.test(m.minAppVersion)) err(where, '"minAppVersion" must look like 0.8.2');
  // 0.8.3: card background image + command palette commands
  const bg = m.card?.background;
  if (m.card != null && (typeof m.card !== "object" || Array.isArray(m.card))) err(where, '"card" must be an object, e.g. { "background": "card.webp" }');
  else if (bg != null) {
    const https = typeof bg === "string" && /^https:\/\//i.test(bg);
    if (https ? !/^https:\/\/[^\s"'()\\]+$/i.test(bg) || bg.length >= 500 : !isRel(bg) || !/\.(png|jpe?g|webp|gif|svg)$/i.test(bg)) err(where, '"card.background" must be an image file in the plugin folder (.png .jpg .webp .gif .svg) or an https:// link');
    else if (https) warn(where, '"card.background" is a link: it is not kept offline (a file in the plugin folder is)');
  }
  if (m.commands != null && !Array.isArray(m.commands)) err(where, '"commands" must be a list');
  const cmdIds = new Set();
  for (const c of Array.isArray(m.commands) ? m.commands : []) {
    if (!c || typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(c.id)) err(where, `command ${JSON.stringify(c?.id)}: "id" must be letters, digits, . _ : -`);
    else if (cmdIds.has(c.id)) err(where, `duplicate command id "${c.id}"`);
    else cmdIds.add(c.id);
    if (!c || typeof c.title !== "string" || !c.title || c.title.length > 80) err(where, `command ${JSON.stringify(c?.id)}: "title" is required (≤ 80 chars)`);
    if (c?.keywords != null && typeof c.keywords !== "string") err(where, `command ${JSON.stringify(c.id)}: "keywords" must be text`);
  }
  if (Array.isArray(m.commands) && m.commands.length > 50) warn(where, "only the first 50 commands are listed");
  const descFile = typeof m.description === "string" && /\.(md|markdown|txt)$/i.test(m.description) && !m.description.includes("\n") ? m.description : null;
  if (!fileExists) return;
  const files = [m.entry, m.icon, m.banner, descFile, isRel(bg) ? bg : null, ...(m.screenshots ?? []).map((s) => (typeof s === "string" ? s : s?.src))].filter((f) => isRel(f));
  for (const f of files) {
    if (!fileExists(f)) err(where, `missing file ${f}`);
    else if (fileSize && /\.(png|jpe?g|webp|gif)$/i.test(f) && fileSize(f) > 1_500_000) warn(where, `${f} is over 1.5 MB — consider shrinking it`);
  }
  if (fileSize && m.icon && fileExists(m.icon) && fileSize(m.icon) > 256 * 1024) warn(where, `icon over 256 KB is not kept offline`);
  if (fileSize && isRel(bg) && fileExists(bg) && fileSize(bg) > 256 * 1024) warn(where, `card.background over 256 KB is not kept offline — aim for < 80 KB (e.g. 720×180 WebP)`);
}

function loadRegistry() {
  if (!existsSync(REG)) return { schema: 1, name: "Stormiq plugins", plugins: [] };
  try {
    return JSON.parse(readFileSync(REG, "utf8"));
  } catch (e) {
    err("registry.json", `not valid JSON: ${e.message}`);
    return { schema: 1, plugins: [] };
  }
}

async function remoteManifest(e) {
  const p = (e.path ?? ".").replace(/^\.\/?/, "").replace(/\/+$/, "");
  const base = `https://raw.githubusercontent.com/${e.repo}/${e.ref || "main"}/${p ? p + "/" : ""}`;
  const r = await fetch(base + "plugin.json");
  if (!r.ok) throw new Error(`plugin.json: HTTP ${r.status} (${base}plugin.json)`);
  const text = await r.text();
  return { base, text, m: JSON.parse(text) };
}

async function main() {
  const old = loadRegistry();
  const reg = { schema: 1, name: old.name ?? "Stormiq plugins", plugins: [] };

  // --add-repo owner/name[@ref][:path]
  const ai = args.indexOf("--add-repo");
  const external = (old.plugins ?? []).filter((e) => e && e.repo);
  if (ai >= 0) {
    const spec = args[ai + 1] ?? "";
    const m = /^([^@:]+)(?:@([^:]+))?(?::(.+))?$/.exec(spec);
    if (!m || !REPO_RE.test(m[1])) {
      console.error("usage: --add-repo owner/name[@ref][:path]");
      process.exit(2);
    }
    if (external.some((e) => e.repo === m[1] && (e.path ?? ".") === (m[3] ?? "."))) console.log(`${m[1]} is already listed`);
    else external.push({ repo: m[1], ref: m[2] ?? "main", path: m[3] ?? "." });
  }

  // folder plugins
  const ids = new Set();
  for (const dir of readdirSync(ROOT).sort()) {
    const d = join(ROOT, dir);
    if (!statSync(d).isDirectory() || dir.startsWith(".") || dir.startsWith("_")) continue;
    const mf = join(d, "plugin.json");
    const where = `plugins/${dir}`;
    if (!existsSync(mf)) {
      warn(where, "no plugin.json — skipped");
      continue;
    }
    const raw = readFileSync(mf);
    let m;
    try {
      m = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      err(where, `plugin.json is not valid JSON: ${e.message}`);
      continue;
    }
    validate(where, m, (f) => existsSync(join(d, f)), (f) => statSync(join(d, f)).size);
    if (m.id !== dir) warn(where, `folder name and "id" differ ("${m.id}")`);
    if (ids.has(m.id)) err(where, `duplicate id "${m.id}"`);
    ids.add(m.id);
    const sha = { "plugin.json": sha256(raw) };
    if (isRel(m.entry) && existsSync(join(d, m.entry))) {
      const code = readFileSync(join(d, m.entry));
      if (code.includes("\r\n")) warn(where, `${m.entry} has Windows line endings — commit it with LF (plugins/.gitattributes) or the checksum won't match`);
      sha[m.entry] = sha256(code);
    }
    if (raw.includes("\r\n")) warn(where, "plugin.json has Windows line endings — commit it with LF or the checksum won't match");
    reg.plugins.push({ path: dir, id: m.id, name: m.name, version: m.version, summary: m.summary, sha256: sha });
  }

  // external repos
  for (const e of external) {
    const where = `repo ${e.repo}${e.path && e.path !== "." ? `:${e.path}` : ""}`;
    if (!REPO_RE.test(e.repo)) {
      err(where, "repo must be owner/name");
      continue;
    }
    const out = { repo: e.repo, ref: e.ref || "main", path: e.path || "." };
    if (has("--remote")) {
      try {
        const { base, text, m } = await remoteManifest(out);
        validate(where, m);
        if (ids.has(m.id)) err(where, `duplicate id "${m.id}"`);
        ids.add(m.id);
        Object.assign(out, { id: m.id, name: m.name, version: m.version, summary: m.summary });
        if (/^[0-9a-f]{40}$/.test(out.ref)) {
          const r = await fetch(base + m.entry);
          if (!r.ok) throw new Error(`${m.entry}: HTTP ${r.status}`);
          out.sha256 = { "plugin.json": sha256(Buffer.from(text, "utf8")), [m.entry]: sha256(Buffer.from(await r.arrayBuffer())) };
        }
      } catch (x) {
        err(where, x.message);
      }
    } else {
      for (const k of ["id", "name", "version", "summary", "sha256"]) if (e[k] != null) out[k] = e[k];
    }
    reg.plugins.push(out);
  }

  const text = JSON.stringify(reg, null, 2) + "\n";
  const same = existsSync(REG) && readFileSync(REG, "utf8") === text;
  console.log(`${reg.plugins.length} plugin(s) · ${errors} error(s) · ${warnings} warning(s)`);
  if (has("--check")) {
    if (!same) console.error("registry.json is out of date — run: node tools/plugins-registry.mjs");
    process.exit(errors || !same ? 1 : 0);
  }
  if (errors) {
    console.error("not written (fix the errors above)");
    process.exit(1);
  }
  if (!same) writeFileSync(REG, text);
  console.log(same ? "registry.json is up to date" : "wrote plugins/registry.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
