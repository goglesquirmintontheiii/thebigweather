// p8: Settings → Updates: app auto-update (desktop) and the local server's self-update.

import { useEffect, useState } from "preact/hooks";
import { Download, RefreshCw, RotateCw, ExternalLink } from "lucide-preact";
import { Toggle } from "../ui/panels/RadarPanel";
import { toast } from "../store";
import { appUpdate, hasAppUpdater, watchAppUpdate, checkApp, downloadApp, installApp, setAutoUpdate, openReleasePage, serverUpdateStatus, updateServer, fmtSpeed, type ServerUpdateState } from "./update";

const when = (t: number) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

function AppUpdates() {
  useEffect(watchAppUpdate, []);
  const u = appUpdate.value;
  if (!u) return null;
  const busy = u.state === "checking" || u.state === "downloading" || u.state === "installing";
  let line = `Version ${u.current}`;
  if (u.state === "checking") line += " · checking…";
  else if (u.state === "latest") line += " · up to date";
  else if (u.state === "available") line += ` · ${u.version} is available`;
  else if (u.state === "downloading") line += ` · downloading ${u.version} ${u.progress}% ${fmtSpeed(u.bytesPerSecond)}`;
  else if (u.state === "downloaded") line += ` · ${u.version} is ready`;
  else if (u.state === "error") line += ` · couldn't check (${u.error || "offline?"})`;
  return (
    <>
      <div class="row">
        <span class="muted small">{line}</span>
        {u.supported && (
          <button class="icon-btn" title="Check now" disabled={busy} onClick={() => checkApp()}>
            <RefreshCw size={13} />
          </button>
        )}
      </div>
      {u.supported ? (
        <>
          <Toggle label="Check daily and download updates in the background" on={u.auto} set={(v) => setAutoUpdate(v)} />
          {u.state === "available" && !u.auto && (
            <button class="btn" onClick={() => downloadApp()}>
              <Download size={13} /> Download {u.version}
            </button>
          )}
          {u.state === "downloading" && <progress max={100} value={u.progress} style={{ width: "100%" }} />}
          {u.state === "downloaded" && (
            <button class="btn primary" onClick={() => installApp()}>
              <RotateCw size={13} /> Restart to update to {u.version}
            </button>
          )}
          {u.notes && (u.state === "available" || u.state === "downloaded" || u.state === "downloading") && <pre class="muted small" style={{ whiteSpace: "pre-wrap", maxHeight: "10em", overflow: "auto" }}>{u.notes.slice(0, 2000)}</pre>}
          <div class="muted small">Last check: {when(u.lastCheck)}. Updates come from GitHub releases (stable only); the built-in server updates with the app.</div>
        </>
      ) : (
        <div class="muted small">
          Automatic updates aren't available here ({u.reason}).{" "}
          <button class="icon-btn" title="Open the releases page" onClick={() => openReleasePage()}>
            <ExternalLink size={12} />
          </button>
        </div>
      )}
    </>
  );
}

function ServerUpdates() {
  const [s, setS] = useState<ServerUpdateState | null>(null);
  const [busy, setBusy] = useState("");
  const load = (refresh = false) => serverUpdateStatus(refresh).then(setS);
  useEffect(() => void load(), []);
  // only for a server on this computer that isn't the app's own built-in one
  if (!s || s.managed) return null;
  return (
    <>
      <div class="row">
        <span class="muted small">
          Server {s.current}
          {s.error ? ` · couldn't check (${s.error})` : s.update_available ? ` · ${s.latest} is available` : s.latest ? " · up to date" : ""}
        </span>
        <button class="icon-btn" title="Check now" disabled={!!busy} onClick={() => load(true)}>
          <RefreshCw size={13} />
        </button>
      </div>
      {s.update_available &&
        (s.can_update ? (
          <button
            class="btn"
            disabled={!!busy}
            onClick={async () => {
              setBusy("Downloading and verifying…");
              const r = await updateServer();
              setBusy("");
              if (r.ok) toast(`Server updated to ${r.version}; it is restarting`);
              else toast(`Server update failed: ${r.error}`, "error");
              setTimeout(() => load(true), 8000);
            }}
          >
            <Download size={13} /> {busy || `Update the server to ${s.latest}`}
          </button>
        ) : (
          <div class="muted small">{s.reason ?? "Update with ./start.sh --update or start.ps1 -Update."}</div>
        ))}
    </>
  );
}

export function UpdatesSection() {
  if (!hasAppUpdater()) {
    // browser: only the server part (when the browser runs on the server's computer)
    return (
      <section>
        <label class="lbl">Updates</label>
        <ServerUpdates />
        <div class="muted small">
          <button class="icon-btn" title="Open the releases page" onClick={() => openReleasePage()}>
            <ExternalLink size={12} />
          </button>{" "}
          Releases on GitHub
        </div>
      </section>
    );
  }
  return (
    <section>
      <label class="lbl">Updates</label>
      <AppUpdates />
      <ServerUpdates />
    </section>
  );
}
