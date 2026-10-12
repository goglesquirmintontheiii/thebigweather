// Saved workspaces: save the current setup by name, switch, rename, overwrite, delete, export/import.

import { useState } from "preact/hooks";
import { settings } from "../../store";
import { saveWorkspace, applyWorkspace, deleteWorkspace, overwriteWorkspace, renameWorkspace, exportWorkspaces, importWorkspaces } from "../../workspaces";
import { Save, Trash2, Download, Upload, RefreshCw, Check } from "lucide-preact";
import { Toggle } from "./RadarPanel";

const PRESETS = ["Chase day", "Winter", "Tropical", "Aviation"];

function summary(w: any): string {
  const d = w.data;
  const wx = d.weather?.kind === "radar" ? `${d.radar?.site ?? ""} ${d.radar?.product ?? ""}` : d.weather?.kind === "grid" ? d.weather.id : d.weather?.id ?? "";
  const n = Object.values(d.ovl ?? {}).filter((o: any) => o?.on).length;
  const panes = d.panes?.layout && d.panes.layout !== "1" ? ` · ${d.panes.layout} panes` : "";
  return `${wx} · ${n} layers${panes}`;
}

export function WorkspacePanel() {
  const list = settings.value.workspaces;
  const [name, setName] = useState("");
  const [keys, setKeys] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const save = () => {
    saveWorkspace(name || `Workspace ${list.length + 1}`, keys);
    setName("");
  };
  return (
    <div class="stack">
      <section>
        <label class="lbl">Save current setup</label>
        <div class="row">
          <input placeholder="Name (e.g. Chase day)" value={name} list="ws-presets" onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          <datalist id="ws-presets">
            {PRESETS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <button class="btn sm" onClick={save}>
            <Save size={13} /> Save
          </button>
        </div>
        <Toggle label="Include keybinds" on={keys} set={setKeys} />
        <div class="muted small">View, weather layer, radar, overlays + options, panes, basemap, legend filters, color tables.</div>
      </section>
      <section>
        <label class="lbl">Workspaces</label>
        <div class="ws-list">
          {list.map((w) => (
            <div key={w.id} class="ws-row">
              {edit === w.id ? (
                <input
                  value={editName}
                  autoFocus
                  onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (renameWorkspace(w.id, editName), setEdit(null));
                    if (e.key === "Escape") setEdit(null);
                  }}
                  onBlur={() => (renameWorkspace(w.id, editName), setEdit(null))}
                />
              ) : (
                <button class="ws-main" title="Switch to this workspace" onClick={() => applyWorkspace(w.id)} onDblClick={() => (setEdit(w.id), setEditName(w.name))}>
                  <b>{w.name}</b>
                  <small class="muted">
                    {summary(w)}
                    {w.keys ? " · keys" : ""}
                  </small>
                </button>
              )}
              <button class="icon-btn" title="Overwrite with the current setup" onClick={() => overwriteWorkspace(w.id)}>
                <RefreshCw size={13} />
              </button>
              <button class="icon-btn" title="Export" onClick={() => exportWorkspaces([w.id])}>
                <Download size={13} />
              </button>
              <button class="icon-btn danger" title="Delete" onClick={() => deleteWorkspace(w.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!list.length && <div class="muted small">None yet. Double-click a name to rename.</div>}
        </div>
        <div class="row">
          <button class="btn sm ghost" onClick={() => exportWorkspaces()} disabled={!list.length}>
            <Download size={13} /> Export all
          </button>
          <button class="btn sm ghost" onClick={importWorkspaces}>
            <Upload size={13} /> Import
          </button>
        </div>
      </section>
    </div>
  );
}

/** Toolbar quick switcher (dropdown). */
export function WorkspaceMenu({ onClose }: { onClose: () => void }) {
  const list = settings.value.workspaces;
  const [name, setName] = useState("");
  return (
    <div class="ws-menu glass" onPointerDown={(e) => e.stopPropagation()}>
      <div class="ws-menu-head">Workspaces</div>
      {list.map((w) => (
        <button key={w.id} class="ws-item" onClick={() => (applyWorkspace(w.id), onClose())}>
          <b>{w.name}</b>
          <small class="muted">{summary(w)}</small>
        </button>
      ))}
      {!list.length && <div class="muted small" style={{ padding: "4px 8px" }}>No saved workspaces</div>}
      <div class="ws-quick">
        <input placeholder="Save as…" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && (saveWorkspace(name), setName(""))} />
        <button class="icon-btn" title="Save" disabled={!name.trim()} onClick={() => (saveWorkspace(name), setName(""))}>
          <Check size={14} />
        </button>
      </div>
    </div>
  );
}
