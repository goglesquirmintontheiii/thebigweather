// data 0.8: Notifications panel — the server's delivery channels (ntfy, Pushover, email/SMTP,
// Discord, Telegram, webhook): list, add, edit, test, delete (GET/PUT /api/notify/channels,
// POST /api/notify/test), plus the server-side rules log (GET /api/rules/log).

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { BellRing, Plus, Trash2, Send, Pencil, RefreshCw, Check, X } from "lucide-preact";
import { api, ApiError } from "../api";
import { toast, uid } from "../store";
import { FloatPanel } from "./FloatPanel";
import { fmtTime } from "../util";

export type ChanType = "ntfy" | "pushover" | "email" | "discord" | "telegram" | "webhook";
export interface Channel {
  id: string;
  type: ChanType;
  name: string;
  enabled: boolean;
  config: Record<string, any>;
}
type Field = { k: string; label: string; ph?: string; secret?: boolean; req?: boolean; kind?: "text" | "number" | "bool" | "select"; opts?: [string, string][] };
export const CHAN_TYPES: Record<ChanType, { name: string; fields: Field[]; hint: string }> = {
  ntfy: {
    name: "ntfy",
    hint: "Push to the ntfy app: subscribe to the same topic on your phone.",
    fields: [
      { k: "server", label: "Server", ph: "https://ntfy.sh" },
      { k: "topic", label: "Topic", ph: "my-storm-alerts-8f3k", req: true },
      { k: "token", label: "Access token", ph: "optional", secret: true },
      { k: "priority", label: "Priority", kind: "select", opts: [["3", "Default"], ["4", "High"], ["5", "Urgent"], ["2", "Low"]] },
    ],
  },
  pushover: {
    name: "Pushover",
    hint: "Pushover user key and an application API token from pushover.net.",
    fields: [
      { k: "user", label: "User key", req: true, secret: true },
      { k: "token", label: "App token", req: true, secret: true },
      { k: "device", label: "Device", ph: "optional" },
      { k: "priority", label: "Priority", kind: "select", opts: [["0", "Normal"], ["1", "High"], ["2", "Emergency (repeat until acknowledged)"], ["-1", "Quiet"]] },
    ],
  },
  email: {
    name: "Email (SMTP)",
    hint: "Sent by the server through your SMTP account.",
    fields: [
      { k: "host", label: "SMTP host", ph: "smtp.gmail.com", req: true },
      { k: "port", label: "Port", ph: "587", kind: "number" },
      { k: "tls", label: "Security", kind: "select", opts: [["starttls", "STARTTLS (587)"], ["tls", "TLS (465)"], ["none", "None"]] },
      { k: "username", label: "Username" },
      { k: "password", label: "Password", secret: true },
      { k: "from", label: "From", ph: "alerts@example.com", req: true },
      { k: "to", label: "To", ph: "me@example.com, team@example.com", req: true },
    ],
  },
  discord: { name: "Discord", hint: "Server settings → Integrations → Webhooks → copy URL.", fields: [{ k: "url", label: "Webhook URL", ph: "https://discord.com/api/webhooks/…", req: true, secret: true }] },
  telegram: {
    name: "Telegram",
    hint: "Create a bot with @BotFather; the chat id is your user or group id.",
    fields: [
      { k: "bot_token", label: "Bot token", req: true, secret: true },
      { k: "chat_id", label: "Chat id", req: true },
    ],
  },
  webhook: {
    name: "Webhook",
    hint: "POSTs JSON {rule, message, time, vars} to your URL.",
    fields: [
      { k: "url", label: "URL", ph: "https://…", req: true },
      { k: "method", label: "Method", kind: "select", opts: [["POST", "POST"], ["PUT", "PUT"]] },
      { k: "headers", label: "Headers (JSON)", ph: '{"Authorization": "Bearer …"}' },
    ],
  },
};

export const notifyOpen = signal(false);
export const channels = signal<Channel[]>([]);
export const chanState = signal<{ loading: boolean; error: string; supported: boolean | null }>({ loading: false, error: "", supported: null });

/** accept an array, {channels: [...]}, or an id-keyed object; tolerate missing fields */
function parseChannels(j: any): Channel[] {
  const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.channels) ? j.channels : j && typeof j === "object" ? Object.entries(j).map(([id, v]: any) => ({ id, ...v })) : [];
  return arr
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const type = (String(c.type ?? c.kind ?? "webhook").toLowerCase() === "smtp" ? "email" : String(c.type ?? c.kind ?? "webhook").toLowerCase()) as ChanType;
      const { id, type: _t, kind: _k, name, enabled, config, ...rest } = c;
      return { id: String(id ?? uid()), type: CHAN_TYPES[type] ? type : "webhook", name: String(name ?? CHAN_TYPES[type]?.name ?? type), enabled: enabled !== false, config: { ...(config && typeof config === "object" ? config : rest) } };
    });
}
export async function loadChannels() {
  chanState.value = { ...chanState.value, loading: true, error: "" };
  try {
    channels.value = parseChannels(await api.get("/api/notify/channels"));
    chanState.value = { loading: false, error: "", supported: true };
  } catch (e: any) {
    const nf = e instanceof ApiError && (e.status === 404 || e.status === 405);
    chanState.value = { loading: false, error: nf ? "" : e.message, supported: nf ? false : chanState.value.supported };
  }
}
async function save(list: Channel[]) {
  try {
    const r = await api.send("PUT", "/api/notify/channels", { channels: list });
    const back = parseChannels(r);
    channels.value = back.length || !list.length ? back : list;
    return true;
  } catch (e: any) {
    toast(`Couldn't save channels: ${e.message}`, "error");
    return false;
  }
}
export async function testChannel(id: string) {
  try {
    const r: any = await api.send("POST", "/api/notify/test", { channel_id: id });
    if (r?.ok === false || r?.error) toast(`Test failed: ${r.error ?? "error"}`, "warn", 8000);
    else toast(`Test sent via ${channels.value.find((c) => c.id === id)?.name ?? id}`);
  } catch (e: any) {
    toast(`Test failed: ${e.message}`, "warn", 8000);
  }
}

const masked = (v: any) => typeof v === "string" && /^(\*+|•+|\*{3}.*|.*\*{4,}.*)$/.test(v);

export function NotifyPanel() {
  if (!notifyOpen.value) return null;
  return (
    <FloatPanel title={<><BellRing size={14} /> Notifications</>} x={Math.max(16, window.innerWidth / 2 - 220)} y={80} w={440} cls="p8-notify" onClose={() => (notifyOpen.value = false)}>
      <Body />
    </FloatPanel>
  );
}

function Body() {
  const [tab, setTab] = useState<"ch" | "log">("ch");
  useEffect(() => {
    loadChannels();
  }, []);
  return (
    <div class="p8-notify-body">
      <div class="seg sm">
        <button class={tab === "ch" ? "on" : ""} onClick={() => setTab("ch")}>
          Channels
        </button>
        <button class={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>
          Server rules log
        </button>
      </div>
      {tab === "ch" ? <Channels /> : <ServerLog />}
    </div>
  );
}

function Channels() {
  const st = chanState.value;
  const [edit, setEdit] = useState<Channel | null>(null);
  const [addType, setAddType] = useState<ChanType>("ntfy");
  if (st.supported === false) return <div class="muted small">This server has no notification channels yet (needs the data 0.8 server). Rules still notify on this computer.</div>;
  return (
    <>
      <div class="row">
        <select value={addType} onChange={(e) => setAddType((e.target as HTMLSelectElement).value as ChanType)}>
          {Object.entries(CHAN_TYPES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.name}
            </option>
          ))}
        </select>
        <button class="btn sm" onClick={() => setEdit({ id: uid(), type: addType, name: CHAN_TYPES[addType].name, enabled: true, config: {} })}>
          <Plus size={13} /> Add channel
        </button>
        <button class="icon-btn" title="Reload" onClick={loadChannels}>
          <RefreshCw size={13} class={st.loading ? "spin" : ""} />
        </button>
      </div>
      {st.error && <div class="err-text small">{st.error}</div>}
      {edit && !channels.value.some((c) => c.id === edit.id) && <Editor c={edit} isNew onDone={() => setEdit(null)} />}
      <div class="p8-chans">
        {!channels.value.length && !st.loading && <div class="muted small">No channels yet. Add one, test it, then pick it in a rule's actions (rules that run on the server).</div>}
        {channels.value.map((c) =>
          edit?.id === c.id ? (
            <Editor key={c.id} c={edit} onDone={() => setEdit(null)} />
          ) : (
            <div key={c.id} class={`p8-chan ${c.enabled ? "" : "off"}`}>
              <span class={`p8-chan-type t-${c.type}`}>{CHAN_TYPES[c.type]?.name ?? c.type}</span>
              <div class="p8-chan-main">
                <b>{c.name}</b>
                <small class="muted">{summary(c)}</small>
              </div>
              <label class="toggle mini" title="Enabled">
                <input type="checkbox" checked={c.enabled} onChange={(e) => save(channels.value.map((x) => (x.id === c.id ? { ...x, enabled: (e.target as HTMLInputElement).checked } : x)))} />
                <i />
              </label>
              <button class="icon-btn" title="Send a test message" onClick={() => testChannel(c.id)}>
                <Send size={13} />
              </button>
              <button class="icon-btn" title="Edit" onClick={() => setEdit(structuredClone(c))}>
                <Pencil size={13} />
              </button>
              <button class="icon-btn danger" title="Delete" onClick={() => confirm(`Delete channel ${c.name}?`) && save(channels.value.filter((x) => x.id !== c.id))}>
                <Trash2 size={13} />
              </button>
            </div>
          ),
        )}
      </div>
      <div class="muted small">Secrets are stored on the server and shown masked. Channels deliver for rules set to run on the server (Rules → Run on).</div>
    </>
  );
}
function summary(c: Channel): string {
  const k = c.config;
  switch (c.type) {
    case "ntfy":
      return `${(k.server || "https://ntfy.sh").replace(/^https?:\/\//, "")}/${k.topic ?? "?"}`;
    case "email":
      return `${k.to ?? "?"} via ${k.host ?? "?"}`;
    case "telegram":
      return `chat ${k.chat_id ?? "?"}`;
    case "webhook":
      return String(k.url ?? "").replace(/^https?:\/\//, "").slice(0, 48);
    case "discord":
      return "webhook";
    case "pushover":
      return k.device ? `device ${k.device}` : "all devices";
  }
  return "";
}

function Editor({ c, isNew, onDone }: { c: Channel; isNew?: boolean; onDone: () => void }) {
  const [d, setD] = useState<Channel>(c);
  const spec = CHAN_TYPES[d.type];
  const ok = spec.fields.every((f) => !f.req || masked(c.config[f.k]) || String(d.config[f.k] ?? "").trim());
  const set = (k: string, v: any) => setD({ ...d, config: { ...d.config, [k]: v } });
  const commit = async () => {
    if (d.type === "webhook" && d.config.headers) {
      try {
        JSON.parse(d.config.headers);
      } catch {
        return toast("Headers must be JSON", "warn");
      }
    }
    const list = isNew ? [...channels.value, d] : channels.value.map((x) => (x.id === d.id ? d : x));
    if (await save(list)) onDone();
  };
  return (
    <div class="p8-chan-edit">
      <div class="row">
        <span>Name</span>
        <input value={d.name} onInput={(e) => setD({ ...d, name: (e.target as HTMLInputElement).value })} />
      </div>
      {spec.fields.map((f) => (
        <div class="row" key={f.k}>
          <span>
            {f.label}
            {f.req ? " *" : ""}
          </span>
          {f.kind === "select" ? (
            <select value={String(d.config[f.k] ?? f.opts![0][0])} onChange={(e) => set(f.k, (e.target as HTMLSelectElement).value)}>
              {f.opts!.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          ) : (
            <input type={(f.secret ? "password" : f.kind === "number" ? "number" : "text") as any} placeholder={masked(c.config[f.k]) ? "(unchanged)" : f.ph} value={masked(d.config[f.k]) ? "" : d.config[f.k] ?? ""} onInput={(e) => set(f.k, f.kind === "number" ? +(e.target as HTMLInputElement).value : (e.target as HTMLInputElement).value)} />
          )}
        </div>
      ))}
      <div class="muted small">{spec.hint}</div>
      <div class="row">
        <button class="btn sm" disabled={!ok} onClick={commit}>
          <Check size={13} /> Save
        </button>
        <button class="btn sm ghost" onClick={onDone}>
          <X size={13} /> Cancel
        </button>
      </div>
    </div>
  );
}

function ServerLog() {
  const [log, setLog] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    api
      .get("/api/rules/log")
      .then((j: any) => (setLog(Array.isArray(j) ? j : Array.isArray(j?.log) ? j.log : Array.isArray(j?.entries) ? j.entries : []), setErr("")))
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? "This server doesn't run rules yet." : e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  const chName = (id: string) => channels.value.find((c) => c.id === id)?.name ?? id;
  return (
    <>
      <div class="row">
        <span class="muted small">Rules the server evaluated and what it delivered.</span>
        <button class="icon-btn" title="Reload" onClick={load}>
          <RefreshCw size={13} />
        </button>
      </div>
      {err && <div class="muted small">{err}</div>}
      <div class="rl-log p8-slog">
        {log && !log.length && <div class="muted small">Nothing fired on the server yet.</div>}
        {(log ?? []).slice(0, 200).map((l, i) => {
          const t = typeof l.t === "number" ? l.t : Date.parse(l.time ?? l.t ?? "");
          const dl: any[] = Array.isArray(l.deliveries) ? l.deliveries : Array.isArray(l.channels) ? l.channels.map((c: any) => (typeof c === "string" ? { channel: c, ok: l.ok !== false } : c)) : [];
          return (
            <div key={i} class={l.ok === false || l.error ? "bad" : ""}>
              <span>{Number.isFinite(t) ? fmtTime(t, true) : "—"}</span> <b>{l.rule ?? l.rule_name ?? l.name ?? "rule"}</b> {l.msg ?? l.message ?? ""}
              {dl.length > 0 && (
                <small class="p8-dl">
                  {dl.map((x, k) => (
                    <i key={k} class={x.ok === false ? "bad" : "ok"} title={x.error ?? ""}>
                      {chName(String(x.channel ?? x.channel_id ?? x.id ?? "?"))}
                      {x.ok === false ? " ✗" : " ✓"}
                    </i>
                  ))}
                </small>
              )}
              {l.error && <small class="err-text"> {String(l.error)}</small>}
            </div>
          );
        })}
      </div>
    </>
  );
}

(window as any).__tbwNotify = { notifyOpen, channels, loadChannels, parseChannels };
