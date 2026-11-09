import { Toggle } from "./RadarPanel";
import { settings, update } from "../../store";
import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { api } from "../../api";
import { connection } from "../../store";
import { fmtAge } from "../../util";
import { sameHost } from "../../clientstats"; // shake/stats/server 0.6
import { dataSources, setDataSource } from "../../datasrc"; // 0.8.4

export const sources = signal<any[]>([]);

api.on("hello", (m) => (sources.value = m.sources ?? []));
api.on("source", (m) => {
  const next = sources.value.filter((s) => s.id !== m.source.id);
  next.push(m.source);
  next.sort((a, b) => a.id.localeCompare(b.id));
  sources.value = next;
});

export function SourcesPanel() {
  useEffect(() => {
    api.get("/api/sources").then((s) => (sources.value = s)).catch(() => {});
  }, []);
  const conn = connection.value;
  /* 0.8.4: toggles per source; the status rows of each source show under its name */
  const catalog = dataSources.value;
  const known = new Set(catalog.map((c) => c.id));
  const statusOf = (id: string) => sources.value.filter((s) => s.ds === id);
  const groups = [...new Set(catalog.map((c) => c.group))];
  const loose = sources.value.filter((s) => !s.ds || !known.has(s.ds));
  const line = (s: any) => (s.status === "ok" ? `${s.detail} · ${s.last_ok ? fmtAge(s.last_ok) : ""}` : s.status === "error" ? s.last_error?.slice(0, 80) : s.detail || s.status);
  return (
    <div class="stack" data-set="data-sources">
      <Toggle label="Server stats panel (CPU, RAM, disk, network)" on={settings.value.panels.stats.open} set={(v) => update((x) => (x.panels.stats = { ...x.panels.stats, open: v }))} />
      {/* shake/stats/server 0.6 */}
      <Toggle label="App stats panel (this computer: app CPU, RAM, GPU, heap, FPS)" on={!!settings.value.panels.appstats?.open} set={(v) => update((x) => (x.panels.appstats = { ...(x.panels.appstats ?? { x: -1, y: 300 }), open: v }))} />
      {sameHost.value && (settings.value.panels.stats.open || settings.value.panels.appstats?.open) && <div class="muted small">The server runs on this computer, so both show in one panel.</div>}
      {/* end shake/stats/server 0.6 */}
      <div class="source-row">
        <span class={`sdot ${conn === "online" ? "ok" : conn === "connecting" ? "idle" : "error"}`} />
        <span class="sname">Server connection</span>
        <span class="sdetail">{conn}</span>
      </div>
      {groups.map((g) => (
        <div key={g} class="ds-group">
          <h4 class="ds-h">{g}</h4>
          {catalog
            .filter((c) => c.group === g)
            .map((c) => {
              const rows = statusOf(c.id);
              const worst = rows.find((r) => r.status === "error") ?? rows.find((r) => r.status === "ok") ?? rows[0];
              return (
                <div key={c.id} class={`ds-row${c.enabled ? "" : " off"}`} data-set={`ds-${c.id}`}>
                  <span class={`sdot ${c.enabled ? worst?.status ?? "idle" : "disabled"}`} />
                  <span class="sname">{c.name}</span>
                  <span class="sdetail" title={worst?.last_error ?? ""}>
                    {c.enabled ? (worst ? line(worst) : "") : "Off"}
                  </span>
                  <label class="toggle compact" title={c.enabled ? "Turn off" : "Turn on"}>
                    <input type="checkbox" checked={c.enabled} aria-label={c.name} onChange={(e) => setDataSource(c.id, (e.target as HTMLInputElement).checked)} />
                    <i />
                  </label>
                </div>
              );
            })}
        </div>
      ))}
      {loose.length > 0 && catalog.length > 0 && <h4 class="ds-h">Other</h4>}
      {loose.map((s) => (
        <div key={s.id} class="source-row" title={s.last_error ?? ""}>
          <span class={`sdot ${s.status}`} />
          <span class="sname">{s.name}</span>
          <span class="sdetail">{line(s)}</span>
        </div>
      ))}
      {!catalog.length && !sources.value.length && <div class="muted">Sources appear once the server starts fetching data.</div>}
    </div>
  );
}
