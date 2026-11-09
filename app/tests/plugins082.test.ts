// 0.8.2: plugin marketplace — registry / manifest helpers, safe markdown, and the repo's registry.json.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseRegistry, entryBase, assetUrl, validateManifest, cmpVersion, verifyHash, sha256hex, matches, descIsFile, DEFAULT_REGISTRY, visibleRail, openTargets } from "../src/plugins/marketcore";

// 0.8.4 (SIQ-485): Show / Hide in panel, Open
export function testRailHiddenAndOpen() {
  const rail = [{ pid: "a", id: "1", panel: "pa" }, { pid: "b", id: "2" }, { pid: "c", id: "3", panel: "pc" }];
  if (visibleRail(rail, []).length !== 3) throw new Error("every button shows by default");
  const v = visibleRail(rail, [{ id: "a", railHidden: true }, { id: "b" }]);
  if (v.map((b) => b.pid).join() !== "b,c") throw new Error("only the hidden plugin's button goes");
  const panels = [{ pid: "a", id: "pa" }, { pid: "a", id: "pa2" }, { pid: "c", id: "pc" }];
  if (openTargets("a", panels, rail)?.panels.map((p) => p.id).join() !== "pa,pa2") throw new Error("Open: all the plugin's panels");
  if (openTargets("b", panels, rail)?.button?.id !== "2") throw new Error("Open: a plain rail button");
  if (openTargets("x", panels, rail) !== null) throw new Error("Open: nothing to open");
}
import { parseMarkdown, parseInline, firstText } from "../src/plugins/mdparse";

const assert = (c: any, m = "assertion failed") => {
  if (!c) throw new Error(m);
};
const throws = async (f: () => any, re: RegExp) => {
  try {
    await f();
  } catch (e: any) {
    assert(re.test(e.message), `wrong error: ${e.message}`);
    return;
  }
  throw new Error(`expected an error matching ${re}`);
};

export function testEntryBase() {
  assert(entryBase(DEFAULT_REGISTRY, { path: "storm-eta-chime" }) === "https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/plugins/storm-eta-chime/", "folder");
  assert(entryBase(DEFAULT_REGISTRY, { repo: "a/b" }) === "https://raw.githubusercontent.com/a/b/main/", "repo root");
  assert(entryBase(DEFAULT_REGISTRY, { repo: "a/b", ref: "v2", path: "./plug/" }) === "https://raw.githubusercontent.com/a/b/v2/plug/", "repo path");
  assert(entryBase("http://localhost:8080/plugins/registry.json", { id: "x" }) === "http://localhost:8080/plugins/x/", "id as folder");
}

export function testParseRegistryDropsBadEntries() {
  const r = parseRegistry({ schema: 1, plugins: [{ path: "ok" }, { repo: "bad repo" }, { path: "../escape" }, { repo: "a/b", ref: "x y" }, { path: "/abs" }, null, { repo: "o/n", ref: "main", path: "." }] });
  assert(r.plugins.length === 2, `kept ${r.plugins.length}`);
  throwsSync(() => parseRegistry({ nope: 1 }));
}
function throwsSync(f: () => any) {
  try {
    f();
  } catch {
    return;
  }
  throw new Error("expected throw");
}

export function testAssetUrlStaysInFolder() {
  const base = "https://raw.githubusercontent.com/a/b/main/p/";
  assert(assetUrl(base, "icon.png") === base + "icon.png", "plain");
  assert(assetUrl(base, "screenshots/one.png") === base + "screenshots/one.png", "sub");
  for (const bad of ["../x.png", "/x.png", "https://evil/x.png", "javascript:alert(1)", "a\\b.png", "", 5])
    assert(assetUrl(base, bad as any) === null, `rejects ${bad}`);
}

export function testValidateManifest() {
  const ok = validateManifest({ id: "hail-legend", name: "Hail", version: "1.0.0", entry: "main.js", screenshots: ["a.png", { src: "b.png", caption: "B" }], permissions: ["map"] });
  assert(ok.screenshots!.length === 2, "shots");
  for (const [m, re] of [
    [{ id: "Bad ID", name: "x", version: "1.0.0", entry: "main.js" }, /id/],
    [{ id: "x", version: "1.0.0", entry: "main.js" }, /name/],
    [{ id: "x", name: "x", version: "one", entry: "main.js" }, /version/],
    [{ id: "x", name: "x", version: "1.0.0", entry: "../main.js" }, /entry/],
    [{ id: "x", name: "x", version: "1.0.0", entry: "main.js", icon: "https://x/i.png" }, /icon/],
    [{ id: "x", name: "x", version: "1.0.0", entry: "main.js", homepage: "http://x" }, /homepage/],
  ] as const) {
    let msg = "";
    try {
      validateManifest(m);
    } catch (e: any) {
      msg = e.message;
    }
    assert(re.test(msg), `expected ${re}, got "${msg}"`);
  }
}

export function testVersions() {
  assert(cmpVersion("1.0.10", "1.0.9") > 0, "numeric");
  assert(cmpVersion("1.0", "1.0.0") === 0, "short");
  assert(cmpVersion("1.0.0-beta", "1.0.0") < 0, "pre-release");
  assert(cmpVersion("0.8.1", "0.8.2") < 0, "app");
}

export async function testHashes() {
  assert((await sha256hex("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256");
  const e = { sha256: { "main.js": await sha256hex("code") } };
  assert((await verifyHash(e, "main.js", "code")) === true, "match");
  assert((await verifyHash(e, "other.js", "x")) === false, "unlisted passes");
  await throws(() => verifyHash(e, "main.js", "tampered"), /checksum/);
}

export function testSearchAndDesc() {
  const m = validateManifest({ id: "storm-eta-chime", name: "Storm ETA chime", version: "1.0.0", entry: "main.js", summary: "Plays a chime", tags: ["sound"] });
  assert(matches(m, "chime") && matches(m, "STORM sound") && !matches(m, "hail"), "search");
  assert(descIsFile("README.md") && !descIsFile("# Hi\ntext") && !descIsFile("../x.md"), "desc file");
}

export function testMarkdownIsSafe() {
  const b = parseMarkdown('# Title\n\nHello <script>alert(1)</script> **bold** [x](javascript:alert(1)) [ok](https://a.b) ![i](shot.png) <img src=x onerror=alert(1)>');
  assert(b[0].t === "h" && (b[0] as any).level === 1, "heading");
  const p = (b[1] as any).c;
  const flat = JSON.stringify(p);
  assert(flat.includes("<script>alert(1)</script>"), "raw html stays text");
  assert(!p.some((x: any) => x.t === "a" && /javascript/.test(x.href)), "no javascript: links");
  assert(p.some((x: any) => x.t === "a" && x.href === "https://a.b"), "https link");
  assert(!p.some((x: any) => x.t === "img"), "relative image dropped without a resolver");
  const withBase = parseInline("![i](shot.png)", (u, k) => (k === "img" && !u.includes(":") ? "https://base/" + u : null));
  assert(withBase[0].t === "img" && (withBase[0] as any).src === "https://base/shot.png", "resolver");
}

export function testMarkdownBlocks() {
  const b = parseMarkdown("- one\n- *two*\n\n1. a\n2. b\n\n> quote\n\n```\ncode <b>\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n---\ntext  \nbreak");
  assert(b.map((x) => x.t).join(",") === "ul,ol,quote,pre,table,hr,p", b.map((x) => x.t).join(","));
  assert((b[3] as any).v === "code <b>", "code verbatim");
  assert((b[4] as any).rows[0].length === 2, "table");
  assert((b[6] as any).c.some((x: any) => x.t === "br"), "hard break");
  assert(firstText("# T\n\nFirst **para** here.\n\nSecond") === "First para here.", "firstText");
}

const ROOT = new URL("../../plugins/", import.meta.url);
export function testRepoRegistryMatchesFiles() {
  const reg = parseRegistry(JSON.parse(readFileSync(new URL("registry.json", ROOT), "utf8")));
  assert(reg.plugins.length >= 2, "two example plugins");
  for (const e of reg.plugins.filter((p) => p.path)) {
    const dir = new URL(`${e.path}/`, ROOT);
    const m = validateManifest(JSON.parse(readFileSync(new URL("plugin.json", dir), "utf8")));
    for (const f of [m.entry, m.icon, m.banner, m.description, ...(m.screenshots ?? []).map((s) => (typeof s === "string" ? s : s.src))].filter(Boolean) as string[])
      assert(existsSync(new URL(f, dir)), `${e.path}/${f} exists`);
    for (const [f, h] of Object.entries(e.sha256 ?? {})) {
      const got = createHash("sha256").update(readFileSync(new URL(f, dir))).digest("hex");
      assert(got === h, `${e.path}/${f} checksum is current (run node tools/plugins-registry.mjs)`);
    }
  }
}
