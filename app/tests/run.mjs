// Tiny test runner: `node tests/run.mjs [filter]` runs tests/*.test.ts with Node's built-in type stripping
// (extensionless relative imports resolve to .ts).
import { register } from "node:module";
import { spawnSync } from "node:child_process";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(spec, ctx, next) {
  if (/^\\.\\.?\\//.test(spec) && !/\\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL?.startsWith("file:")) {
    const u = new URL(spec + ".ts", ctx.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
  }
  return next(spec, ctx);
}`),
);

const dir = new URL("./", import.meta.url);
const only = process.argv[2];
let fail = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".test.ts") && (!only || f.includes(only)))) {
  const mod = await import(new URL(f, dir).href);
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== "function" || !name.startsWith("test")) continue;
    const t0 = performance.now();
    try {
      await fn();
      console.log(`ok   ${f} ${name} (${(performance.now() - t0).toFixed(0)} ms)`);
    } catch (e) {
      fail++;
      console.log(`FAIL ${f} ${name}\n     ${e?.stack ?? e}`);
    }
  }
}
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
