import { useEffect, useState } from "preact/hooks";
import { ServerEditor } from "./panels/SettingsPanel";
import { update, uid } from "../store";
import { Radar, Monitor } from "lucide-preact";

const LOCAL = ["http://127.0.0.1:8787", "http://localhost:8787"];

/** A server running on this same computer needs no token. */
export async function findLocalServer(): Promise<{ url: string; name: string } | null> {
  for (const url of LOCAL) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`${url}/api/local`, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.local) return { url, name: j.name || "This computer" };
    } catch {
      /* not running */
    }
  }
  return null;
}

export function ConnectDialog() {
  const [local, setLocal] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const probe = () => findLocalServer().then((l) => alive && l && setLocal(l));
    probe();
    const t = setInterval(probe, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const useLocal = () =>
    update((s) => {
      const id = uid();
      s.servers.push({ id, name: "This computer", url: local!.url, token: "" });
      s.activeServer = id;
    });
  return (
    <div class="modal-back">
      <div class="modal glass">
        <div class="brand">
          <Radar size={28} />
          <div>
            <h1>TheBigWeather</h1>
            <p class="muted">Connect to your server to begin.</p>
          </div>
        </div>
        {local && (
          <button class="btn local-btn" onClick={useLocal}>
            <Monitor size={15} /> Use the server on this computer <span class="muted small">({local.url} · no token)</span>
          </button>
        )}
        <ServerEditor />
        <p class="muted small">
          Run <code>./start.sh</code> on your server. It prints the URL and token. On the same computer no token is needed.
        </p>
      </div>
    </div>
  );
}
