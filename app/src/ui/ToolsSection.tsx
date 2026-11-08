// 0.8.3: Settings → Recording tools: yt-dlp and Deno (YouTube camera recording) on the server,
// with a one-click download when missing (server: /api/tools, tooldl.rs).

import { useEffect, useState } from "preact/hooks";
import { Download, Check, RefreshCw } from "lucide-preact";
import { api } from "../api";
import { settings, toast } from "../store";
import { loadRecs } from "./panels/RecordPanel";
import { fmtBytes } from "../util";

interface ToolSt {
  found: boolean;
  path: string | null;
  asset: string | null;
  running: boolean;
  done: number;
  total: number;
  ok: boolean | null;
  msg: string;
}
type St = { ytdlp: ToolSt; deno: ToolSt; dir: string };

const TOOLS: { id: "ytdlp" | "deno"; name: string; what: string }[] = [
  { id: "ytdlp", name: "yt-dlp", what: "Records YouTube cameras" },
  { id: "deno", name: "Deno", what: "yt-dlp needs it for YouTube" },
];

export function ToolsSection() {
  const [st, setSt] = useState<St | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .get<St>("/api/tools")
      .then((r) => (setSt(r), setErr(null)))
      .catch((e) => (setSt(null), setErr(e?.status === 404 ? "This server is too old for one-click downloads." : null)));
  useEffect(() => {
    load();
  }, [settings.value.activeServer]);
  const busy = !!st && (st.ytdlp.running || st.deno.running);
  // poll while a download runs
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 700);
    return () => clearInterval(t);
  }, [busy]);
  // finished: refresh the recorder's view (Recordings, camera panels)
  const finished = st ? `${st.ytdlp.ok}/${st.deno.ok}` : "";
  useEffect(() => {
    if (st && !busy) loadRecs();
  }, [finished, busy]);
  const install = async (id: string, name: string) => {
    try {
      setSt(await api.send("POST", `/api/tools/${id}/install`, {}).then(() => api.get<St>("/api/tools")));
    } catch (e: any) {
      toast(`${name}: ${e.message}`, "error");
    }
  };
  if (!st)
    return err ? (
      <section>
        <label class="lbl">Recording tools</label>
        <div class="muted small">{err}</div>
      </section>
    ) : null;
  return (
    <section>
      <label class="lbl">Recording tools</label>
      {TOOLS.map(({ id, name, what }) => {
        const t = st[id];
        const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : 0;
        return (
          <div key={id} class="s83-tool">
            <div class="row">
              <span title={t.path ?? undefined}>
                <b>{name}</b> <span class="muted small">· {what}</span>
              </span>
              {t.found && !t.running ? (
                <span class="ok-text small s83-found">
                  <Check size={12} /> Found
                </span>
              ) : (
                <button class="btn sm" disabled={t.running || !t.asset} title={t.asset ? `Download ${t.asset} from GitHub` : "No build for this server's OS"} onClick={() => install(id, name)}>
                  {t.running ? <RefreshCw size={12} class="spin" /> : <Download size={12} />} {t.running ? "Downloading…" : `Download ${name}`}
                </button>
              )}
            </div>
            {t.running && (
              <div class="off-prog">
                <div class="bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <span>
                  {t.msg}
                  {t.done > 0 ? ` ${fmtBytes(t.done)}${t.total ? ` / ${fmtBytes(t.total)}` : ""}` : ""}
                </span>
              </div>
            )}
            {!t.running && t.ok === false && <div class="err-text small">{t.msg}</div>}
            {!t.running && t.ok === true && <div class="ok-text small">Installed: {t.msg}</div>}
            {!t.found && !t.running && !t.asset && <div class="muted small">No {name} build for this server's OS — install it manually.</div>}
          </div>
        );
      })}
      <div class="muted small s83-tdir">Downloads go to {st.dir} on the server.</div>
    </section>
  );
}
