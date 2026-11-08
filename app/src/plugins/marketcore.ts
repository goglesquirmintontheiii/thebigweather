// 0.8.2: plugin marketplace — pure helpers (no DOM / store), shared by market.ts and the tests.
//
// A registry is a JSON file (plugins/registry.json in the repo, see plugins/README.md):
//   { "schema": 1, "name": "...", "plugins": [ <entry>, ... ] }
// An entry is either a folder next to the registry   { "path": "storm-eta-chime", "sha256": { "main.js": "<hex>" } }
// or an external GitHub repo                         { "repo": "owner/name", "ref": "main", "path": "." }
// Either way the folder holds a plugin.json manifest (see Manifest).

export const DEFAULT_REGISTRY = "https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/plugins/registry.json";

export interface RegistryEntry {
  /** folder next to the registry (default: id) */
  path?: string;
  /** external GitHub repo "owner/name" */
  repo?: string;
  /** branch / tag / commit for `repo` (default "main") */
  ref?: string;
  id?: string;
  /** sha256 hex per file (relative to the plugin folder); checked on install when present */
  sha256?: Record<string, string>;
  /** cached copy of a few manifest fields (written by tools/plugins-registry.mjs) */
  name?: string;
  version?: string;
  summary?: string;
}
export interface Registry {
  schema: number;
  name?: string;
  plugins: RegistryEntry[];
}
export interface Shot {
  src: string;
  caption?: string;
}
export interface Manifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  /** one line, shown on cards */
  summary?: string;
  /** markdown file in the plugin folder (e.g. "README.md") or inline markdown */
  description?: string;
  icon?: string;
  banner?: string;
  screenshots?: (string | Shot)[];
  /** the plugin's JavaScript file (one ES module or plain script) */
  entry: string;
  permissions?: string[];
  minAppVersion?: string;
  homepage?: string;
  tags?: string[];
}

export const PERMISSIONS: Record<string, string> = {
  map: "Add layers to the map",
  panel: "Show floating panels",
  alerts: "Read weather alerts",
  server: "Read data from your server",
  settings: "Read your settings (points, units)",
  audio: "Play sounds",
  network: "Connect to other websites",
  notifications: "Show notifications",
};

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,100}$/;
const REL_RE = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9_. /()-]+$/;

/** a safe relative file path inside the plugin folder */
export const isRelPath = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length < 200 && REL_RE.test(p) && !/^[a-z]+:/i.test(p);

export function parseRegistry(j: any): Registry {
  if (!j || typeof j !== "object" || !Array.isArray(j.plugins)) throw new Error("not a plugin registry (no \"plugins\" list)");
  const plugins: RegistryEntry[] = [];
  for (const e of j.plugins) {
    if (!e || typeof e !== "object") continue;
    if (e.repo != null && (typeof e.repo !== "string" || !REPO_RE.test(e.repo))) continue;
    if (e.ref != null && (typeof e.ref !== "string" || !REF_RE.test(e.ref))) continue;
    if (e.path != null && e.path !== "." && !isRelPath(e.path)) continue;
    if (!e.repo && !e.path && !(typeof e.id === "string" && ID_RE.test(e.id))) continue;
    plugins.push(e);
  }
  return { schema: Number(j.schema) || 1, name: typeof j.name === "string" ? j.name : undefined, plugins };
}

/** The folder URL (ending in "/") a registry entry points at. */
export function entryBase(registryUrl: string, e: RegistryEntry): string {
  if (e.repo) {
    const p = (e.path ?? ".").replace(/^\.\/?/, "").replace(/\/+$/, "");
    return `https://raw.githubusercontent.com/${e.repo}/${e.ref || "main"}/${p ? p + "/" : ""}`;
  }
  const p = (e.path ?? e.id ?? "").replace(/\/+$/, "");
  return new URL(p + "/", registryUrl).href;
}

/** URL of a file inside a plugin folder, or null when the path isn't a safe relative path. */
export function assetUrl(base: string, rel: unknown): string | null {
  if (!isRelPath(rel)) return null;
  const u = new URL(rel.replace(/^\.\//, ""), base);
  return u.href.startsWith(base) ? u.href : null;
}

/** Check a manifest; returns a cleaned copy or throws with a short reason. */
export function validateManifest(m: any): Manifest {
  if (!m || typeof m !== "object") throw new Error("manifest is not an object");
  const str = (k: string, max = 200) => {
    const v = m[k];
    if (v == null) return undefined;
    if (typeof v !== "string" || v.length > max) throw new Error(`"${k}" must be text (≤ ${max} chars)`);
    return v;
  };
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) throw new Error('"id" must be lowercase letters, digits, . _ -');
  if (!str("name", 60)) throw new Error('"name" is required');
  if (!/^\d+\.\d+(\.\d+)?([-+][\w.]+)?$/.test(m.version ?? "")) throw new Error('"version" must look like 1.0.0');
  if (!isRelPath(m.entry) || !/\.m?js$/.test(m.entry)) throw new Error('"entry" must be a .js file in the plugin folder');
  for (const k of ["icon", "banner"]) if (m[k] != null && !isRelPath(m[k])) throw new Error(`"${k}" must be a file in the plugin folder`);
  const shots = m.screenshots == null ? undefined : Array.isArray(m.screenshots) ? m.screenshots : null;
  if (shots === null) throw new Error('"screenshots" must be a list');
  const cleanShots = shots?.slice(0, 12).map((s: any) => {
    const src = typeof s === "string" ? s : s?.src;
    if (!isRelPath(src)) throw new Error("screenshot paths must be files in the plugin folder");
    return typeof s === "string" ? s : { src, caption: typeof s.caption === "string" ? s.caption.slice(0, 200) : undefined };
  });
  const perms = m.permissions == null ? undefined : Array.isArray(m.permissions) ? m.permissions.filter((p: any) => typeof p === "string").slice(0, 20) : null;
  if (perms === null) throw new Error('"permissions" must be a list');
  const homepage = str("homepage", 300);
  if (homepage && !/^https:\/\//.test(homepage)) throw new Error('"homepage" must be an https:// link');
  const minApp = str("minAppVersion", 20);
  if (minApp && !/^\d+(\.\d+){0,2}$/.test(minApp)) throw new Error('"minAppVersion" must look like 0.8.2');
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    author: str("author", 80),
    summary: str("summary", 160),
    description: str("description", 20000),
    icon: m.icon,
    banner: m.banner,
    screenshots: cleanShots,
    entry: m.entry,
    permissions: perms,
    minAppVersion: minApp,
    homepage,
    tags: Array.isArray(m.tags) ? m.tags.filter((t: any) => typeof t === "string").slice(0, 8) : undefined,
  };
}

/** Is `description` a file to fetch (vs inline markdown)? */
export const descIsFile = (d?: string) => !!d && /\.(md|markdown|txt)$/i.test(d) && isRelPath(d) && !d.includes("\n");

/** Compare versions like 1.2.3 (pre-release suffix sorts before the release). */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).split(/[-+]/);
  const pb = String(b).split(/[-+]/);
  const na = pa[0].split(".").map((x) => parseInt(x, 10) || 0);
  const nb = pb[0].split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (pa.length !== pb.length) return pa.length > pb.length ? -1 : 1;
  return 0;
}

export async function sha256hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Throws when a listed hash doesn't match. Files without a listed hash pass. */
export async function verifyHash(e: RegistryEntry, rel: string, data: ArrayBuffer | Uint8Array | string): Promise<boolean> {
  const want = e.sha256?.[rel] ?? e.sha256?.[rel.replace(/^\.\//, "")];
  if (!want) return false;
  const got = await sha256hex(data);
  if (got.toLowerCase() !== want.toLowerCase()) throw new Error(`${rel}: checksum doesn't match the registry — not installed`);
  return true;
}

/** Search text match on name / summary / author / tags. */
export function matches(m: Manifest, q: string): boolean {
  const s = `${m.name} ${m.summary ?? ""} ${m.author ?? ""} ${(m.tags ?? []).join(" ")} ${m.id}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => s.includes(w));
}
