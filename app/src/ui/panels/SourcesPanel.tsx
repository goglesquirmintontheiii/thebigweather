import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { api } from "../../api";
import { connection } from "../../store";
import { fmtAge } from "../../util";

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
  return (
    <div class="stack">
      <div class="source-row">
        <span class={`sdot ${conn === "online" ? "ok" : conn === "connecting" ? "idle" : "error"}`} />
        <span class="sname">Server connection</span>
        <span class="sdetail">{conn}</span>
      </div>
      {sources.value.map((s) => (
        <div key={s.id} class="source-row" title={s.last_error ?? ""}>
          <span class={`sdot ${s.status}`} />
          <span class="sname">{s.name}</span>
          <span class="sdetail">
            {s.status === "ok" ? `${s.detail} · ${s.last_ok ? fmtAge(s.last_ok) : ""}` : s.status === "error" ? s.last_error?.slice(0, 80) : s.detail || s.status}
          </span>
        </div>
      ))}
      {!sources.value.length && <div class="muted">Sources appear once the server starts fetching data.</div>}
    </div>
  );
}
