import { useRef } from "preact/hooks";
import { settings, toast } from "../../store";
import { MyFiles } from "../OverlayList";
import { Download, Upload } from "lucide-preact";

const KEY = "tbw.settings.v1";

/** Map files plus a settings backup (export/import as JSON). */
export function FilesPanel() {
  const ref = useRef<HTMLInputElement>(null);
  const exportSettings = () => {
    const blob = new Blob([JSON.stringify({ app: "TheBigWeather", exported: new Date().toISOString(), settings: settings.value }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `TheBigWeather-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  return (
    <div class="stack">
      <MyFiles />
      <section>
        <label class="lbl">Settings backup</label>
        <p class="muted small">Layers, colors, points, alert rules, servers (with tokens), cameras and drawings. Keep the file private.</p>
        <div class="row">
          <button class="btn sm ghost" onClick={exportSettings}>
            <Download size={13} /> Export settings
          </button>
          <button class="btn sm ghost" onClick={() => ref.current?.click()}>
            <Upload size={13} /> Import settings
          </button>
          <input
            ref={ref}
            type="file"
            accept=".json"
            hidden
            onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              (e.target as HTMLInputElement).value = "";
              if (!f) return;
              try {
                const j = JSON.parse(await f.text());
                const s = j.settings ?? j;
                if (typeof s !== "object" || !s.radar || !s.view) throw new Error("not a TheBigWeather settings file");
                localStorage.setItem(KEY, JSON.stringify(s));
                toast("Settings imported, reloading…");
                setTimeout(() => location.reload(), 800);
              } catch (err: any) {
                toast(`Couldn't import: ${err.message}`, "error");
              }
            }}
          />
        </div>
        <p class="muted small">Radar and camera recordings export from the Recordings panel.</p>
      </section>
    </div>
  );
}
