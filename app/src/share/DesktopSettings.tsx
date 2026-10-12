// Desktop app options (Electron only): built-in server, close to tray, start with the computer.
// Also the "Run the server in this app" button of the first-run connect dialog.

import { useEffect, useState } from "preact/hooks";
import { Cpu, FolderOpen } from "lucide-preact";
import { Toggle } from "../ui/panels/RadarPanel";
import { hasDesktop, getDesktop, setDesktop, localServer, useBuiltinServer, type DesktopPrefs } from "./desktop";
import { toast } from "../store";

export function DesktopSection() {
  const [d, setD] = useState<DesktopPrefs | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (!hasDesktop()) return;
    getDesktop().then(setD);
    const t = setInterval(() => getDesktop().then(setD), 4000);
    return () => clearInterval(t);
  }, []);
  if (!hasDesktop() || !d) return null;
  const set = async (p: Partial<DesktopPrefs>) => setD(await setDesktop(p));
  const srv = d.server;
  return (
    <section>
      <label class="lbl">Desktop</label>
      {srv.available ? (
        <>
          <Toggle
            label="Run a server inside this app"
            on={d.localServer}
            set={async (v) => {
              if (v) {
                setBusy("Starting…");
                await useBuiltinServer();
                setBusy("");
                setD(await getDesktop());
              } else {
                setD({ ...d, server: await localServer("stop"), localServer: false });
              }
            }}
          />
          <div class="muted small">
            {busy ||
              (srv.running
                ? `Running at ${srv.url} (pid ${srv.pid}) · data in ${srv.data}`
                : srv.error
                  ? `Stopped: ${srv.error}`
                  : "For a one-computer setup: no separate install. Stops when the app quits.")}
            {srv.running && (
              <button class="icon-btn" title="Open the server's data folder (config, logs)" onClick={() => localServer("logs")}>
                <FolderOpen size={12} />
              </button>
            )}
          </div>
        </>
      ) : (
        <div class="muted small">This build has no bundled server.</div>
      )}
      <Toggle label="Close to the tray (keep alerts running)" on={d.closeToTray} set={(v) => set({ closeToTray: v })} />
      <Toggle label={`Start with ${d.platform === "win32" ? "Windows" : "the computer"}`} on={d.autoStart} set={(v) => (set({ autoStart: v }), v && !d.closeToTray && toast("Tip: turn on “Close to the tray” to start hidden in the tray"))} />
    </section>
  );
}

/** First-run dialog option. */
export function BuiltinServerButton() {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (hasDesktop()) localServer("status").then((s) => setOk(s.available));
  }, []);
  if (!ok) return null;
  return (
    <button
      class="btn local-btn"
      disabled={!!busy}
      onClick={async () => {
        setBusy("Starting the built-in server…");
        await useBuiltinServer(setBusy);
        setBusy("");
      }}
    >
      <Cpu size={15} /> {busy || "Run the server in this app"} <span class="muted small">(this computer only · no setup)</span>
    </button>
  );
}
