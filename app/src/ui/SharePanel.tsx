// Share links (Phase 6): the "Share live view" dialog (toolbar … menu) and, in a shared view,
// the "Shared view · <name>" banner.

import { useEffect, useState } from "preact/hooks";
import { Share2, Copy, Trash2, Link, Eye, RefreshCw } from "lucide-preact";
import { settings, toast } from "../store";
import { FloatPanel } from "./FloatPanel";
import { shareDialog, viewer, createShare, listShares, deleteShare, type ShareInfo } from "../share/share";

const HOURS: [number, string][] = [
  [1, "1 hour"],
  [6, "6 hours"],
  [24, "1 day"],
  [72, "3 days"],
  [168, "1 week"],
  [720, "30 days"],
  [0, "Never"],
];

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch {
    toast(text, "info", 12000);
  }
}

function when(ms: number) {
  if (!ms) return "never";
  const d = ms - Date.now();
  if (d <= 0) return "expired";
  const h = d / 3600e3;
  return h < 1 ? `in ${Math.max(1, Math.round(d / 60e3))} min` : h < 48 ? `in ${Math.round(h)} h` : `in ${Math.round(h / 24)} days`;
}

export function SharePanel() {
  if (viewer.value) return <ViewerBanner />;
  if (!shareDialog.value) return null;
  return <ShareDialog />;
}

function ShareDialog() {
  const ws = settings.value.workspaces;
  const [src, setSrc] = useState<string>("current");
  const [name, setName] = useState("");
  const [hours, setHours] = useState(24);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<ShareInfo | null>(null);
  const [list, setList] = useState<ShareInfo[] | null>(null);
  const [err, setErr] = useState("");
  const refresh = () =>
    listShares()
      .then(setList)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    refresh();
  }, []);
  const make = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await createShare({ name: name.trim() || (src === "current" ? "Live view" : ws.find((w) => w.id === src)?.name || "Shared view"), src, hours, live });
      setMade(r);
      copy(r.url);
      refresh();
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  };
  return (
    <FloatPanel title={<><Share2 size={14} /> Share live view</>} x={Math.max(20, window.innerWidth / 2 - 190)} y={110} w={380} cls="share-panel" onClose={() => (shareDialog.value = false)}>
      <div class="stack share-form">
        <label class="lbl">What to share</label>
        <select value={src} onChange={(e) => setSrc((e.target as HTMLSelectElement).value)}>
          <option value="current">Current view (radar, layers, drawings)</option>
          {ws.map((w) => (
            <option key={w.id} value={w.id}>
              Workspace: {w.name}
            </option>
          ))}
        </select>
        <input placeholder="Name shown to viewers" value={name} maxLength={80} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <div class="row">
          <label class="muted small">Expires</label>
          <select value={hours} onChange={(e) => setHours(+(e.target as HTMLSelectElement).value)}>
            {HOURS.map(([h, l]) => (
              <option key={h} value={h}>
                {l}
              </option>
            ))}
          </select>
          <label class="chk">
            <input type="checkbox" checked={live} onChange={(e) => setLive((e.target as HTMLInputElement).checked)} /> Live
          </label>
        </div>
        <div class="muted small">
          {live ? "Viewers follow your view and drawings while this app is open." : "A fixed snapshot of the view; radar and warnings still update."} Viewers can look but not change settings, record or draw.
        </div>
        <button class="btn" disabled={busy} onClick={make}>
          <Link size={14} /> {busy ? "Creating…" : "Create link"}
        </button>
        {made && (
          <div class="share-made">
            <input readOnly value={made.url} onFocus={(e) => (e.target as HTMLInputElement).select()} />
            <button class="icon-btn" title="Copy link" onClick={() => copy(made.url)}>
              <Copy size={14} />
            </button>
          </div>
        )}
        {err && <div class="err small">{err}</div>}
        <div class="row">
          <label class="lbl">Active links</label>
          <button class="icon-btn" title="Refresh" onClick={refresh}>
            <RefreshCw size={13} />
          </button>
        </div>
        {list && !list.length && <div class="muted small">None yet.</div>}
        {list?.map((s) => (
          <div key={s.id} class="share-row">
            <span>
              <b>{s.name}</b>
              <small class="muted">
                {s.live ? "live · " : ""}expires {when(s.expires)} · <Eye size={11} /> {s.views}
              </small>
            </span>
            <button class="icon-btn" title="Copy link" onClick={() => copy(s.url)}>
              <Copy size={13} />
            </button>
            <button
              class="icon-btn danger"
              title="Delete link (viewers lose access)"
              onClick={() =>
                deleteShare(s.id)
                  .then(refresh)
                  .catch((e) => setErr(e.message))
              }
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </FloatPanel>
  );
}

function ViewerBanner() {
  const v = viewer.value!;
  return (
    <div class={`share-banner glass ${v.error ? "bad" : ""}`}>
      <Eye size={14} />
      <span>
        Shared view · <b>{v.name}</b>
        {v.server && <span class="muted"> · {v.server}</span>}
      </span>
      {v.error ? (
        <span class="err">{v.error}</span>
      ) : (
        v.live && (
          <label class="chk small" title="Move the map when the owner does">
            <input type="checkbox" checked={v.follow} onChange={(e) => (viewer.value = { ...v, follow: (e.target as HTMLInputElement).checked })} /> Follow
          </label>
        )
      )}
      {v.expires > 0 && <span class="muted small">expires {when(v.expires)}</span>}
    </div>
  );
}
