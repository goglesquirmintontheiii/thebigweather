// Team panel (Phase 6 live collaboration): create/join a room by code, members (follow, fly to),
// position sharing, shared drawings, pins and notes.

import { useEffect, useRef, useState } from "preact/hooks";
import { Users, LogOut, Plus, LocateFixed, Eye, EyeOff, Copy, Trash2, MapPin, Send, RefreshCw, PenTool } from "lucide-preact";
import { toast } from "../store";
import { FloatPanel } from "./FloatPanel";
import { viewer } from "../share/share";
import {
  teamOpen,
  team,
  teamStatus,
  teamError,
  me,
  memberList,
  teamDrawings,
  pins,
  notes,
  following,
  prefs,
  setPrefs,
  pinDraft,
  join,
  leave,
  createRoom,
  listRooms,
  rename,
  addNote,
  deletePin,
  follow,
  flyTo,
  copyDrawing,
  deleteTeamDrawing,
  setPosMode,
} from "../share/collab";

const COLORS = ["#3fb7ff", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#bf5af2", "#ff2d92", "#ffffff"];

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

export function CollabPanel() {
  if (!teamOpen.value || viewer.value) return null;
  return (
    <FloatPanel title={<><Users size={14} /> Team{team.value ? ` · ${team.value.name}` : ""}</>} x={Math.max(20, window.innerWidth - 420)} y={90} w={340} cls="team-panel" onClose={() => (teamOpen.value = false)}>
      {team.value || teamStatus.value === "connecting" ? <Room /> : <Lobby />}
    </FloatPanel>
  );
}

function Identity() {
  const p = prefs.value;
  const [name, setName] = useState(p.name);
  return (
    <div class="team-id">
      <input placeholder="Your name" maxLength={40} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={() => name !== p.name && rename(name.trim(), p.color)} onKeyDown={(e) => e.key === "Enter" && rename(name.trim(), p.color)} />
      <div class="team-colors">
        {COLORS.map((c) => (
          <button key={c} class={`swatch ${p.color === c ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => rename(name.trim() || p.name, c)} />
        ))}
      </div>
    </div>
  );
}

function Lobby() {
  const [code, setCode] = useState(prefs.value.room);
  const [rname, setRname] = useState("");
  const [rooms, setRooms] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const load = () =>
    listRooms()
      .then(setRooms)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <div class="stack">
      <Identity />
      <label class="lbl">Join a room</label>
      <div class="row">
        <input class="team-code" placeholder="CODE" maxLength={12} value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && join(code)} />
        <button class="btn sm" disabled={!code.trim()} onClick={() => join(code)}>
          Join
        </button>
      </div>
      <label class="lbl">New room</label>
      <div class="row">
        <input placeholder="Room name (e.g. Chase team)" maxLength={60} value={rname} onInput={(e) => setRname((e.target as HTMLInputElement).value)} />
        <button
          class="btn sm"
          onClick={() =>
            createRoom(rname)
              .then((r) => (join(r.code), toast(`Room ${r.code} created · share the code with your team`)))
              .catch((e) => setErr(e.message))
          }
        >
          <Plus size={13} /> Create
        </button>
      </div>
      {teamError.value && <div class="err small">{teamError.value}</div>}
      {err && <div class="err small">{err}</div>}
      <div class="row">
        <label class="lbl">Rooms on this server</label>
        <button class="icon-btn" title="Refresh" onClick={load}>
          <RefreshCw size={13} />
        </button>
      </div>
      {rooms && !rooms.length && <div class="muted small">No rooms yet.</div>}
      {rooms?.map((r) => (
        <button key={r.code} class="team-room" onClick={() => join(r.code)}>
          <b>{r.name}</b>
          <small class="muted">
            {r.code} · {r.members.length} online · active {ago(r.active)}
          </small>
        </button>
      ))}
      <div class="muted small">Rooms close after 24 hours without activity.</div>
    </div>
  );
}

function Room() {
  const p = prefs.value;
  const [tab, setTab] = useState<"members" | "notes" | "map">("members");
  const t = team.value;
  return (
    <div class="stack">
      <div class="row team-head">
        <span class={`dot ${teamStatus.value === "online" ? "online" : "connecting"}`} />
        <span>
          Code <b class="team-codeview">{t?.code ?? p.room}</b>
        </span>
        <button class="icon-btn" title="Copy the room code" onClick={() => t && navigator.clipboard?.writeText(t.code).then(() => toast("Code copied"))}>
          <Copy size={13} />
        </button>
        <div style={{ flex: 1 }} />
        <button class="btn sm ghost" title="Leave the room" onClick={() => leave(true)}>
          <LogOut size={13} /> Leave
        </button>
      </div>
      <Identity />
      <div class="row">
        <label class="muted small">My position</label>
        <select value={p.pos} onChange={(e) => setPosMode((e.target as HTMLSelectElement).value as any)}>
          <option value="off">Hidden</option>
          <option value="gps">GPS</option>
          <option value="center">Map centre</option>
        </select>
      </div>
      <label class="chk">
        <input type="checkbox" checked={p.shareView} onChange={(e) => setPrefs({ shareView: (e.target as HTMLInputElement).checked })} /> Let others follow my map view
      </label>
      <label class="chk">
        <input type="checkbox" checked={p.shareDraw} onChange={(e) => setPrefs({ shareDraw: (e.target as HTMLInputElement).checked })} /> Share my drawings
      </label>
      <div class="seg">
        <button class={tab === "members" ? "on" : ""} onClick={() => setTab("members")}>
          Members ({memberList.value.length})
        </button>
        <button class={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
          Notes ({notes.value.length})
        </button>
        <button class={tab === "map" ? "on" : ""} onClick={() => setTab("map")}>
          Map ({Object.keys(teamDrawings.value).length + pins.value.length})
        </button>
      </div>
      {tab === "members" && <Members />}
      {tab === "notes" && <Notes />}
      {tab === "map" && <MapItems />}
      {teamError.value && <div class="err small">{teamError.value}</div>}
    </div>
  );
}

function Members() {
  return (
    <div class="team-list">
      {memberList.value.map((m) => (
        <div key={m.id} class="team-row">
          <i class="team-dot" style={{ background: m.color }} />
          <span>
            <b>{m.name}</b>
            {m.id === me.value && <small class="muted"> (you)</small>}
            {m.pos && <small class="muted"> · pos {ago(m.pos.t)}</small>}
          </span>
          {m.pos && (
            <button class="icon-btn" title="Show on map" onClick={() => flyTo(m.pos!.lon, m.pos!.lat)}>
              <LocateFixed size={13} />
            </button>
          )}
          {m.id !== me.value && (
            <button class={`icon-btn ${following.value === m.id ? "on" : ""}`} title={following.value === m.id ? "Stop following" : m.view ? "Follow this member's map view" : "Not sharing their view"} disabled={!m.view && following.value !== m.id} onClick={() => follow(following.value === m.id ? null : m.id)}>
              {following.value === m.id ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Notes() {
  const [text, setText] = useState("");
  const [here, setHere] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [notes.value.length]);
  const post = () => {
    if (!text.trim()) return;
    addNote(text.trim(), here);
    setText("");
  };
  return (
    <div class="stack">
      <div class="team-notes">
        {notes.value.map((n) => (
          <div key={n.id} class="team-note">
            <b style={{ color: n.color }}>{n.by_name}</b> <small class="muted">{ago(n.t)}</small>
            {n.lat != null && (
              <button class="icon-btn" title="Show on map" onClick={() => flyTo(n.lon!, n.lat!)}>
                <MapPin size={11} />
              </button>
            )}
            <div>{n.text}</div>
          </div>
        ))}
        {!notes.value.length && <div class="muted small">No notes yet.</div>}
        <div ref={end} />
      </div>
      <div class="row">
        <input placeholder="Note to the team…" maxLength={1000} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && post()} />
        <button class="icon-btn" title="Send" onClick={post}>
          <Send size={14} />
        </button>
      </div>
      <label class="chk small">
        <input type="checkbox" checked={here} onChange={(e) => setHere((e.target as HTMLInputElement).checked)} /> Attach the map centre
      </label>
    </div>
  );
}

function MapItems() {
  const [pin, setPin] = useState("");
  return (
    <div class="stack">
      <div class="row">
        <input placeholder="Pin text (e.g. Hail 1.75in)" maxLength={500} value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} />
        <button class={`btn sm ${pinDraft.value != null ? "on" : ""}`} title="Then click the map" onClick={() => (pinDraft.value = pinDraft.value != null ? null : pin.trim())}>
          <MapPin size={13} /> {pinDraft.value != null ? "Click map…" : "Place"}
        </button>
      </div>
      <div class="team-list">
        {pins.value.map((p) => (
          <div key={p.id} class="team-row">
            <i class="team-dot" style={{ background: p.color }} />
            <span>
              {p.text || "Pin"} <small class="muted">· {p.by_name}</small>
            </span>
            <button class="icon-btn" title="Show on map" onClick={() => flyTo(p.lon, p.lat)}>
              <LocateFixed size={13} />
            </button>
            <button class="icon-btn danger" title="Remove pin" onClick={() => deletePin(p.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {Object.values(teamDrawings.value).map((d) => (
          <div key={d.group} class="team-row">
            <PenTool size={12} style={{ color: d.color }} />
            <span>
              {d.name || "Drawing"} <small class="muted">· {d.by_name} · {d.geojson?.features?.length ?? 0} shapes</small>
            </span>
            <button class="icon-btn" title="Copy into my drawings" onClick={() => copyDrawing(d.group)}>
              <Copy size={13} />
            </button>
            <button class="icon-btn danger" title="Remove from the room" onClick={() => deleteTeamDrawing(d.group)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {!pins.value.length && !Object.keys(teamDrawings.value).length && <div class="muted small">No pins or shared drawings. Turn on "Share my drawings" and use drawing mode (D).</div>}
      </div>
    </div>
  );
}
