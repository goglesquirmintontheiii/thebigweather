import { ServerEditor } from "./panels/SettingsPanel";
import { Radar } from "lucide-preact";

export function ConnectDialog() {
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
        <ServerEditor />
        <p class="muted small">
          Run <code>./start.sh</code> on your server. It prints the URL and token.
        </p>
      </div>
    </div>
  );
}
