// Server settings (only when the connected server runs on this computer): resource budgets,
// caches, radar/grid/recorder tunables (rendered generically), credentials, logs, and
// save → restart → reconnect. Talks to the local-only /api/admin/* endpoints.

import { useEffect, useMemo, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { api } from "../api";
import { settings, update, activeServer, toast } from "../store";
import { fmtBytes } from "../util";
import { sameHost, serverInfo, refreshInfo } from "../clientstats";
import { CenterModal } from "./CenterModal";
import { Toggle } from "./panels/RadarPanel";
import { KeysEditor } from "./panels/SettingsPanel";
import { ServerCog, Gauge, HardDrive, SlidersHorizontal, KeyRound, ScrollText, RotateCw, Copy, Eye, EyeOff, Trash2, RefreshCw, TriangleAlert, Check, Loader } from "lucide-preact";

export const serverSettingsOpen = signal(false);

type Tab = "general" | "caches" | "tuning" | "access" | "logs";
const KNOWN = new Set(["server", "profile", "radar", "grid", "recorder", "effective", "keys", "paths", "restart_required_fields"]);
const EDITABLE_SERVER = new Set(["name", "bind", "public_url", "local_no_auth"]);

const get = (o: any, path: string) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
function nest(edits: Record<string, any>) {
  const out: any = {};
  for (const [p, v] of Object.entries(edits)) {
    const ks = p.split(".");
    let o = out;
    ks.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
    o[ks[ks.length - 1]] = v;
  }
  return out;
}

/** units guessed from a field name */
function unitOf(name: string): string {
  const n = name.toLowerCase();
  const m: [RegExp, string][] = [
    [/_mb$/, "MB"],
    [/_gb$/, "GB"],
    [/_kb$/, "KB"],
    [/_bytes$/, "bytes"],
    [/_ms$/, "ms"],
    [/(_s|_sec|_secs|_seconds)$/, "s"],
    [/(_min|_mins|_minutes)$/, "min"],
    [/(_h|_hours)$/, "h"],
    [/_days$/, "days"],
    [/(_pct|_percent)$/, "%"],
    [/_km$/, "km"],
    [/_deg$/, "°"],
    [/_dbz$/, "dBZ"],
    [/frames$/, "frames"],
    [/threads$/, "threads"],
  ];
  return m.find(([r]) => r.test(n))?.[1] ?? "";
}
const pretty = (k: string) => k.replace(/_(mb|gb|kb|ms|s|secs|sec|min|mins|h|hours|days|pct|percent|km|deg)$/i, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function Field({ label, path, err, restart, children, hint }: { label: string; path: string; err?: string; restart?: boolean; children: ComponentChildren; hint?: ComponentChildren }) {
  return (
    <div class={`ssf ${err ? "bad" : ""}`} data-path={path}>
      <div class="ssf-l">
        <span>{label}</span>
        {restart && (
          <span class="ss-rs" title="Takes effect after a restart">
            <RotateCw size={10} />
          </span>
        )}
      </div>
      <div class="ssf-c">{children}</div>
      {hint && <div class="ssf-h muted small">{hint}</div>}
      {err && <div class="ssf-h err-text small">{err}</div>}
    </div>
  );
}

export function ServerSettingsSection() {
  useEffect(() => {
    refreshInfo();
  }, []);
  if (!sameHost.value) return null;
  const info = serverInfo.value;
  return (
    <section>
      <label class="lbl">Server on this computer</label>
      <div class="muted small">
        {info?.name ?? activeServer.value?.name} · {info?.profile?.name ?? "?"} profile{info?.version ? ` · v${info.version}` : ""}
      </div>
      <button class="btn sm" onClick={() => (serverSettingsOpen.value = true)}>
        <ServerCog size={13} /> Server settings…
      </button>
      <div class="muted small">Memory and CPU budgets, caches, credentials and logs.</div>
    </section>
  );
}

export function ServerSettings() {
  if (!serverSettingsOpen.value) return null;
  return <ServerSettingsBody />;
}

function ServerSettingsBody() {
  const [tab, setTab] = useState<Tab>("general");
  const [cfg, setCfg] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState<string[] | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const load = () =>
    api
      .get("/api/admin/config")
      .then((c) => (setCfg(c), setLoadErr(null)))
      .catch((e) => setLoadErr(e.status === 403 || e.status === 404 ? "This server doesn't allow remote administration (only from the same computer, newer servers)." : e.message));
  useEffect(() => {
    load();
  }, [settings.value.activeServer]);
  const rsf: string[] = cfg?.restart_required_fields ?? [];
  const needsRestart = (p: string) => rsf.includes(p) || rsf.includes(p.split(".").pop()!);
  const val = (p: string) => (p in edits ? edits[p] : get(cfg, p));
  const set = (p: string, v: any) => {
    const orig = get(cfg, p);
    const n = { ...edits };
    if (JSON.stringify(orig) === JSON.stringify(v)) delete n[p];
    else n[p] = v;
    setEdits(n);
    if (errors[p]) {
      const e = { ...errors };
      delete e[p];
      setErrors(e);
    }
  };
  const errOf = (p: string) => errors[p] ?? errors[p.split(".").pop()!];
  const dirty = Object.keys(edits);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.send("PUT", "/api/admin/config", nest(edits));
      const errs: Record<string, string> = r.errors ?? {};
      setErrors(errs);
      if (Object.keys(errs).length) toast(`${Object.keys(errs).length} setting${Object.keys(errs).length > 1 ? "s" : ""} not saved`, "error");
      const kept: Record<string, any> = {};
      for (const p of dirty) if (errs[p] ?? errs[p.split(".").pop()!]) kept[p] = edits[p];
      setEdits(kept);
      if (r.restart_required) setRestartNeeded(Array.isArray(r.restart_required) ? r.restart_required : (r.applied ?? dirty).filter((p: string) => needsRestart(p)));
      else if (r.ok !== false) toast("Server settings saved");
      await load();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    setRestarting("Restarting the server…");
    try {
      await api.send("POST", "/api/admin/restart", {});
    } catch {
      /* the connection may drop as it restarts */
    }
    const base = api.base;
    const t0 = Date.now();
    let sawDown = false;
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() - t0 < 90000) {
      try {
        const h = await fetch(base + "/api/health", { cache: "no-store" });
        if (h.ok && (sawDown || Date.now() - t0 > 6000)) break;
      } catch {
        sawDown = true;
        setRestarting("Waiting for the server to come back…");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    setRestarting("Reconnecting…");
    const s = activeServer.value;
    api.configure(undefined);
    api.configure(s);
    await new Promise((r) => setTimeout(r, 800));
    await load();
    refreshInfo();
    setRestarting(null);
    setRestartNeeded(null);
    toast("Server restarted");
  };

  const eff = cfg?.effective ?? {};
  const ramMb = eff.ram_total_mb ?? 16384;
  const TABS: [Tab, string, any][] = [
    ["general", "Resources", Gauge],
    ["caches", "Caches", HardDrive],
    ["tuning", "Data tuning", SlidersHorizontal],
    ["access", "Access & keys", KeyRound],
    ["logs", "Logs", ScrollText],
  ];

  return (
    <CenterModal cls="ss" icon={<ServerCog size={20} />} title="Server settings" sub={cfg ? `${cfg.server?.name ?? "Server"} · ${cfg.paths?.config ?? ""}` : "This computer"} onClose={() => (serverSettingsOpen.value = false)} actions={<button class="icon-btn" title="Reload" onClick={load}><RefreshCw size={15} /></button>}>
      <div class="ss-grid">
        <nav class="ss-nav">
          {TABS.map(([k, l, I]) => (
            <button key={k} class={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              <I size={15} /> {l}
              {k !== "logs" && k !== "caches" && dirty.some((p) => tabOf(p) === k) && <span class="ss-dot" />}
            </button>
          ))}
        </nav>
        <div class="ss-main">
          {loadErr && <div class="err-text">{loadErr}</div>}
          {!cfg && !loadErr && <div class="muted">Loading…</div>}
          {cfg && tab === "general" && (
            <div class="ss-sec">
              <Field label="Profile" path="profile.mode" err={errOf("profile.mode")} restart={needsRestart("profile.mode")} hint={`Effective: ${eff.profile ?? "?"} · Lite skips heavy products (3D, high-res models) for small machines.`}>
                <div class="seg">
                  {["auto", "lite", "full"].map((m) => (
                    <button key={m} class={val("profile.mode") === m ? "on" : ""} onClick={() => set("profile.mode", m)}>
                      {m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </Field>
              <Field
                label="Memory budget"
                path="profile.memory_mb"
                err={errOf("profile.memory_mb")}
                restart={needsRestart("profile.memory_mb")}
                hint={
                  <>
                    This computer has {fmtBytes(ramMb * 1048576)} RAM · effective now {eff.memory_mb ? fmtBytes(eff.memory_mb * 1048576) : "?"} · default (0 = auto): 40% of RAM, min 4 GB
                  </>
                }
              >
                <input type="range" min={0} max={ramMb} step={256} value={val("profile.memory_mb") ?? 0} onInput={(e) => set("profile.memory_mb", +(e.target as HTMLInputElement).value)} />
                <span class="ss-num">
                  <input type="number" min={0} step={0.5} value={+((val("profile.memory_mb") ?? 0) / 1024).toFixed(1)} onChange={(e) => set("profile.memory_mb", Math.round(+(e.target as HTMLInputElement).value * 1024))} /> GB
                </span>
                <span class="ss-pct muted">{val("profile.memory_mb") ? `${Math.round((val("profile.memory_mb") / ramMb) * 100)}%` : "auto"}</span>
              </Field>
              <Field label="CPU budget" path="profile.cpu_percent" err={errOf("profile.cpu_percent")} restart={needsRestart("profile.cpu_percent")} hint={`Share of ${eff.cpus ?? "?"} CPU threads the server may keep busy (decoding, rendering).`}>
                <input type="range" min={10} max={100} step={5} value={val("profile.cpu_percent") ?? 100} onInput={(e) => set("profile.cpu_percent", +(e.target as HTMLInputElement).value)} />
                <span class="ss-num">
                  <input type="number" min={5} max={100} value={val("profile.cpu_percent") ?? 100} onChange={(e) => set("profile.cpu_percent", +(e.target as HTMLInputElement).value)} /> %
                </span>
              </Field>
              <Field label="Worker threads" path="profile.threads" err={errOf("profile.threads")} restart={needsRestart("profile.threads")} hint={`0 = automatic · effective now ${eff.threads ?? "?"}`}>
                <span class="ss-num">
                  <input type="number" min={0} max={eff.cpus ?? 256} value={val("profile.threads") ?? 0} onChange={(e) => set("profile.threads", +(e.target as HTMLInputElement).value)} /> threads
                </span>
              </Field>
              <Field label="Disk cache" path="profile.disk_cache_mb" err={errOf("profile.disk_cache_mb")} restart={needsRestart("profile.disk_cache_mb")} hint={`Downloaded radar/model files kept on disk · effective ${eff.disk_cache_mb ? fmtBytes(eff.disk_cache_mb * 1048576) : "?"} · in ${cfg.paths?.cache ?? cfg.server?.data_dir ?? "data dir"}`}>
                <input type="range" min={512} max={Math.max(200 * 1024, val("profile.disk_cache_mb") ?? 0)} step={512} value={val("profile.disk_cache_mb") ?? 0} onInput={(e) => set("profile.disk_cache_mb", +(e.target as HTMLInputElement).value)} />
                <span class="ss-num">
                  <input type="number" min={0.5} step={0.5} value={+((val("profile.disk_cache_mb") ?? 0) / 1024).toFixed(1)} onChange={(e) => set("profile.disk_cache_mb", Math.round(+(e.target as HTMLInputElement).value * 1024))} /> GB
                </span>
              </Field>
              <GenericObj cfg={cfg} prefix="profile" skip={["mode", "memory_mb", "cpu_percent", "threads", "disk_cache_mb"]} val={val} set={set} errOf={errOf} rs={needsRestart} />
              <Other cfg={cfg} />
            </div>
          )}
          {cfg && tab === "caches" && <Caches />}
          {cfg && tab === "tuning" && (
            <div class="ss-sec">
              {["radar", "grid", "recorder"].map((k) =>
                cfg[k] && typeof cfg[k] === "object" ? (
                  <div key={k}>
                    <h3 class="ss-h">{k === "grid" ? "Models & satellite grids" : k === "recorder" ? "Recorder" : "Radar"}</h3>
                    <GenericObj cfg={cfg} prefix={k} val={val} set={set} errOf={errOf} rs={needsRestart} />
                  </div>
                ) : null,
              )}
            </div>
          )}
          {cfg && tab === "access" && <Access cfg={cfg} val={val} set={set} errOf={errOf} rs={needsRestart} />}
          {tab === "logs" && <Logs />}
        </div>
      </div>
      {(dirty.length > 0 || restartNeeded || restarting) && (
        <div class={`ss-bar ${restartNeeded || restarting ? "warn" : ""}`}>
          {restarting ? (
            <>
              <Loader size={15} class="spin" /> {restarting}
            </>
          ) : restartNeeded ? (
            <>
              <TriangleAlert size={15} />
              <span>Restart required{restartNeeded.length ? ` for ${restartNeeded.join(", ")}` : ""}.</span>
              <span class="ss-fill" />
              {dirty.length > 0 && (
                <button class="btn sm ghost" disabled={saving} onClick={save}>
                  Save {dirty.length} more
                </button>
              )}
              <button class="btn sm ghost" onClick={() => setRestartNeeded(null)}>
                Later
              </button>
              <button class="btn sm" onClick={restart}>
                <RotateCw size={13} /> Restart server
              </button>
            </>
          ) : (
            <>
              <span>
                {dirty.length} unsaved change{dirty.length > 1 ? "s" : ""}
                {dirty.some(needsRestart) && <span class="muted"> · some need a restart</span>}
              </span>
              <span class="ss-fill" />
              <button class="btn sm ghost" onClick={() => (setEdits({}), setErrors({}))}>
                Discard
              </button>
              <button class="btn sm" disabled={saving} onClick={save}>
                <Check size={13} /> {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      )}
    </CenterModal>
  );
}

function tabOf(p: string): Tab {
  const k = p.split(".")[0];
  return k === "profile" ? "general" : k === "server" ? "access" : "tuning";
}

interface FieldsProps {
  val: (p: string) => any;
  set: (p: string, v: any) => void;
  errOf: (p: string) => string | undefined;
  rs: (p: string) => boolean;
}

function GenericObj({ cfg, prefix, skip = [], ...f }: FieldsProps & { cfg: any; prefix: string; skip?: string[] }) {
  const obj = get(cfg, prefix);
  if (!obj || typeof obj !== "object") return null;
  return (
    <>
      {Object.keys(obj)
        .filter((k) => !skip.includes(k))
        .map((k) => {
          const p = `${prefix}.${k}`;
          const orig = obj[k];
          const v = f.val(p);
          const u = unitOf(k);
          if (orig && typeof orig === "object" && !Array.isArray(orig))
            return (
              <div key={p} class="ss-nest">
                <h4>{pretty(k)}</h4>
                <GenericObj cfg={cfg} prefix={p} {...f} />
              </div>
            );
          return (
            <Field key={p} label={pretty(k)} path={p} err={f.errOf(p)} restart={f.rs(p)}>
              {typeof orig === "boolean" ? (
                <label class="toggle compact">
                  <input type="checkbox" checked={!!v} onChange={(e) => f.set(p, (e.target as HTMLInputElement).checked)} />
                  <i />
                </label>
              ) : typeof orig === "number" ? (
                <span class="ss-num">
                  <input type="number" step={Number.isInteger(orig) ? 1 : 0.1} value={v} onChange={(e) => f.set(p, +(e.target as HTMLInputElement).value)} /> {u}
                </span>
              ) : typeof orig === "string" ? (
                <input class="ss-text" value={v} onChange={(e) => f.set(p, (e.target as HTMLInputElement).value)} />
              ) : (
                <code class="ss-ro" title="Read-only here">
                  {JSON.stringify(orig)}
                </code>
              )}
            </Field>
          );
        })}
    </>
  );
}

function Other({ cfg }: { cfg: any }) {
  const ks = Object.keys(cfg).filter((k) => !KNOWN.has(k));
  const paths = cfg.paths ?? {};
  return (
    <>
      <h3 class="ss-h">Paths</h3>
      {Object.entries(paths).map(([k, v]) => (
        <Field key={k} label={pretty(k)} path={`paths.${k}`}>
          <code class="ss-ro">{String(v)}</code>
        </Field>
      ))}
      {cfg.server?.data_dir && (
        <Field label="Data dir" path="server.data_dir">
          <code class="ss-ro">{cfg.server.data_dir}</code>
        </Field>
      )}
      {ks.length > 0 && (
        <>
          <h3 class="ss-h">Other (read-only)</h3>
          {ks.map((k) => (
            <Field key={k} label={pretty(k)} path={k}>
              <code class="ss-ro">{JSON.stringify(cfg[k])}</code>
            </Field>
          ))}
        </>
      )}
    </>
  );
}

function Caches() {
  const [list, setList] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .get("/api/admin/caches")
      .then((l) => setList(Array.isArray(l) ? l : l.caches ?? []))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const clear = async (id: string, name: string) => {
    if (!confirm(`Clear ${name}?`)) return;
    try {
      await api.send("POST", `/api/admin/caches/clear?id=${encodeURIComponent(id)}`, {});
      toast(`Cleared ${name}`);
      load();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const total = (list ?? []).reduce((a, c) => a + (c.bytes ?? 0), 0);
  return (
    <div class="ss-sec">
      {err && <div class="err-text">{err}</div>}
      {!list && !err && <div class="muted">Loading…</div>}
      {list && (
        <>
          <div class="ss-cachehead">
            <span class="muted">
              {list.length} caches · {fmtBytes(total)} in use
            </span>
            <button class="btn sm ghost" onClick={() => clear("all", "all caches")}>
              <Trash2 size={13} /> Clear all
            </button>
          </div>
          <table class="ss-caches">
            <tbody>
              {list.map((c) => {
                const pct = c.cap_bytes ? (c.bytes / c.cap_bytes) * 100 : 0;
                return (
                  <tr key={c.id}>
                    <td class="nm">
                      <b>{c.name}</b>
                      <small class="muted">{c.items != null ? `${c.items.toLocaleString()} items` : ""}</small>
                    </td>
                    <td class="bar">
                      <span class={`mbar ${pct > 90 ? "hi" : pct > 70 ? "mid" : ""}`}>
                        <i style={{ width: `${Math.min(100, pct)}%` }} />
                      </span>
                    </td>
                    <td class="r">
                      {fmtBytes(c.bytes ?? 0)}
                      {c.cap_bytes ? <span class="muted"> / {fmtBytes(c.cap_bytes)}</span> : ""}
                    </td>
                    <td>
                      <button class="btn sm ghost" onClick={() => clear(c.id, c.name)}>
                        Clear
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p class="muted small">Cache caps follow the memory and disk budgets (Resources). Clearing only frees space; data is re-downloaded when needed.</p>
        </>
      )}
    </div>
  );
}

function Access({ cfg, ...f }: FieldsProps & { cfg: any }) {
  const srv = activeServer.value;
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const token = srv?.token ?? "";
  const regen = async () => {
    if (!confirm("Make a new access token? Other devices using the old one will need the new token.")) return;
    setBusy(true);
    try {
      const r = await api.send("POST", "/api/admin/token", {});
      if (r.token && srv) {
        update((s) => {
          const x = s.servers.find((y) => y.id === srv.id);
          if (x) x.token = r.token;
        });
        setShow(true);
        toast("New token saved for this app");
      }
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const keys: Record<string, boolean> = cfg.keys ?? {};
  const nSet = Object.values(keys).filter(Boolean).length;
  return (
    <div class="ss-sec">
      <h3 class="ss-h">Access token</h3>
      <Field label="Token" path="token" hint="Other devices connect with this token. This app's copy updates automatically when you make a new one.">
        <code class="ss-token">{token ? (show ? token : "•".repeat(Math.min(32, token.length))) : <span class="muted">none stored (local access without a token)</span>}</code>
        {token && (
          <>
            <button class="icon-btn" title={show ? "Hide" : "Show"} onClick={() => setShow(!show)}>
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button class="icon-btn" title="Copy" onClick={() => navigator.clipboard?.writeText(token).then(() => toast("Token copied"))}>
              <Copy size={14} />
            </button>
          </>
        )}
        <button class="btn sm ghost" disabled={busy} onClick={regen}>
          <RotateCw size={13} /> Regenerate
        </button>
      </Field>
      <Field label="No token needed from this computer" path="server.local_no_auth" err={f.errOf("server.local_no_auth")} restart={f.rs("server.local_no_auth")} hint="Apps on the same computer connect without the token.">
        <label class="toggle compact">
          <input type="checkbox" checked={!!f.val("server.local_no_auth")} onChange={(e) => f.set("server.local_no_auth", (e.target as HTMLInputElement).checked)} />
          <i />
        </label>
      </Field>
      <h3 class="ss-h">Network</h3>
      <Field label="Server name" path="server.name" err={f.errOf("server.name")} restart={f.rs("server.name")}>
        <input class="ss-text" value={f.val("server.name") ?? ""} onChange={(e) => f.set("server.name", (e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="Listen address" path="server.bind" err={f.errOf("server.bind")} restart hint={<span class="warn-text">Changing this needs a restart; a wrong address can make the server unreachable from other devices (127.0.0.1 = this computer only, 0.0.0.0 = the whole network).</span>}>
        <input class="ss-text" value={f.val("server.bind") ?? ""} onChange={(e) => f.set("server.bind", (e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="Public URL" path="server.public_url" err={f.errOf("server.public_url")} restart={f.rs("server.public_url")} hint="The address other devices use (shown in share links).">
        <input class="ss-text" placeholder="https://wx.example.com" value={f.val("server.public_url") ?? ""} onChange={(e) => f.set("server.public_url", (e.target as HTMLInputElement).value)} />
      </Field>
      {Object.keys(cfg.server ?? {})
        .filter((k) => !EDITABLE_SERVER.has(k) && k !== "data_dir")
        .map((k) => (
          <Field key={k} label={pretty(k)} path={`server.${k}`}>
            <code class="ss-ro">{JSON.stringify(cfg.server[k])}</code>
          </Field>
        ))}
      <h3 class="ss-h">
        API keys <small class="muted">{nSet} of {Object.keys(keys).length} set</small>
      </h3>
      <div class="ss-keys">
        {Object.entries(keys).map(([k, on]) => (
          <span key={k} class={`chip ${on ? "on" : ""}`}>
            {on ? <Check size={11} /> : null} {k}
          </span>
        ))}
      </div>
      <KeysEditor />
    </div>
  );
}

function Logs() {
  const [lines, setLines] = useState<string[]>([]);
  const [auto, setAuto] = useState(true);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .get("/api/admin/logs?n=200")
      .then((r) => (setLines(Array.isArray(r) ? r : r.lines ?? []), setErr(null)))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    if (!auto) return;
    const t = window.setInterval(load, 3000);
    return () => clearInterval(t);
  }, [auto]);
  const shown = useMemo(() => (q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : lines), [lines, q]);
  return (
    <div class="ss-sec ss-logs">
      <div class="ss-cachehead">
        <input class="ss-text" placeholder="Filter" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <Toggle label="Auto-refresh" on={auto} set={setAuto} />
        <button class="icon-btn" title="Refresh" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      {err && <div class="err-text">{err}</div>}
      <pre class="ss-log">
        {shown.map((l, i) => (
          <div key={i} class={/\bERROR\b/.test(l) ? "e" : /\bWARN/.test(l) ? "w" : ""}>
            {l}
          </div>
        ))}
      </pre>
    </div>
  );
}
