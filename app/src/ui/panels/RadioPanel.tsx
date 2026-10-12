import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../../api";
import { settings, update, toast, uid } from "../../store";
import { playStream, stopStream, nowPlaying, radioState, openPlayer, expandSimple, type Stream } from "../../radio";
import { radioOpen } from "../RadioCenter";
import { popout, canPopout, popoutSpec } from "../../popout";
import { Search, Play, Square, Star, Plus, Trash2, ExternalLink, Loader, AudioLines, Maximize2 } from "lucide-preact";
import { Toggle } from "./RadarPanel";

export function NowPlaying({ compact = false }: { compact?: boolean }) {
  const s = nowPlaying.value;
  if (!s) return null;
  const st = radioState.value;
  return (
    <div class={`now-playing ${compact ? "compact glass" : ""}`}>
      <span class={`np-dot ${st}`} />
      <div class="np-name">
        <b>{s.call ?? s.name}</b>
        <small class="muted">{st === "loading" ? "Connecting…" : st === "error" ? "Stream unavailable" : s.call ? s.name : "Playing"}</small>
      </div>
      <input type="range" min={0} max={1} step={0.05} value={settings.value.radio.volume} title="Volume" onInput={(e) => update((x) => (x.radio.volume = +(e.target as HTMLInputElement).value))} />
      {/* p7: same station in the full media player (no gap in the audio) */}
      {popoutSpec?.kind !== "radio" && (
        <button class="icon-btn np-expand" title="Expand to the full player (seek, record, SAME, transcript)" onClick={expandSimple}>
          <Maximize2 size={13} />
        </button>
      )}
      {canPopout() && (
        <button class="icon-btn" title="Pop out" onClick={() => (popout({ kind: "radio", title: s.name, width: 380, height: 160, data: s }), stopStream())}>
          <ExternalLink size={13} />
        </button>
      )}
      <button class="icon-btn" title="Stop" onClick={stopStream}>
        <Square size={13} />
      </button>
    </div>
  );
}

export function RadioPanel() {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [nn, setNn] = useState("");
  const [nu, setNu] = useState("");
  const r = settings.value.radio;
  useEffect(() => {
    api
      .get("/api/ovl/radio")
      .then((v) => setStreams(v.streams.map((s: any) => ({ id: s.id, name: `${s.city}, ${s.state}`, url: s.url, call: s.call, city: s.city, state: s.state }))))
      .catch((e) => setErr(e.message));
  }, []);
  const qq = q.trim().toLowerCase();
  const list = useMemo(() => (streams ?? []).filter((s) => !qq || `${s.call} ${s.city} ${s.state}`.toLowerCase().includes(qq)), [streams, qq]);
  const favs = (streams ?? []).filter((s) => r.favorites.includes(s.id));
  const states = [...new Set(list.map((s) => s.state!))];
  const fav = (id: string) => update((x) => (x.radio.favorites = x.radio.favorites.includes(id) ? x.radio.favorites.filter((f) => f !== id) : [...x.radio.favorites, id]));
  const row = (s: Stream) => {
    const on = nowPlaying.value?.url === s.url;
    return (
      <div key={s.id} class={`radio-row ${on ? "on" : ""}`}>
        <button class="icon-btn" title={on ? "Stop" : "Listen"} onClick={() => (on ? stopStream() : playStream(s))}>
          {on && radioState.value === "loading" ? <Loader size={13} class="spin" /> : on ? <Square size={13} /> : <Play size={13} />}
        </button>
        <span class="rcall">{s.call}</span>
        <span class="rname">{s.city ?? s.name}</span>
        <button class="icon-btn" title="Player (seek, record)" onClick={() => openPlayer(s)}>
          <AudioLines size={12} />
        </button>
        {s.id && !s.id.startsWith("custom:") && (
          <button class={`icon-btn ${r.favorites.includes(s.id) ? "fav" : ""}`} title="Favorite" onClick={() => fav(s.id)}>
            <Star size={12} />
          </button>
        )}
      </div>
    );
  };
  return (
    <div class="stack">
      <button class="btn sm ghost" onClick={() => (radioOpen.value = true)}>
        <Maximize2 size={13} /> Open big view
      </button>
      <NowPlaying />
      <section>
        <div class="search">
          <Search size={14} />
          <input placeholder="Call sign, city or state" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <Toggle label="Show stations on the map" on={!!settings.value.ovl.nwr?.on} set={(v) => update((x) => (x.ovl.nwr = { ...(x.ovl.nwr ?? {}), on: v }))} />
      </section>
      {favs.length > 0 && !qq && (
        <section>
          <label class="lbl">Favorites</label>
          {favs.map(row)}
        </section>
      )}
      <section>
        <label class="lbl">My streams</label>
        {r.custom.map((c, i) => (
          <div key={i} class={`radio-row ${nowPlaying.value?.url === c.url ? "on" : ""}`}>
            <button class="icon-btn" onClick={() => (nowPlaying.value?.url === c.url ? stopStream() : playStream({ id: `custom:${i}`, name: c.name, url: c.url }))}>
              {nowPlaying.value?.url === c.url ? <Square size={13} /> : <Play size={13} />}
            </button>
            <span class="rname">{c.name}</span>
            <button class="icon-btn" title="Remove" onClick={() => update((x) => x.radio.custom.splice(i, 1))}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {adding ? (
          <div class="custom-bm-form">
            <input placeholder="Name" value={nn} onInput={(e) => setNn((e.target as HTMLInputElement).value)} />
            <input placeholder="Stream URL (mp3/aac/Icecast)" value={nu} onInput={(e) => setNu((e.target as HTMLInputElement).value.trim())} />
            <div class="row">
              <button
                class="btn sm"
                disabled={!/^https?:\/\//.test(nu)}
                onClick={() => {
                  update((x) => x.radio.custom.push({ name: nn.trim() || "Stream", url: nu }));
                  setAdding(false);
                  setNn("");
                  setNu("");
                  void uid;
                }}
              >
                Add
              </button>
              <button class="btn sm ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button class="btn sm ghost" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add a stream URL
          </button>
        )}
      </section>
      <section>
        <label class="lbl">NOAA Weather Radio {streams ? `· ${list.length}` : ""}</label>
        {!streams && !err && <div class="muted small">Loading stations…</div>}
        {err && <div class="err-text small">{err}</div>}
        {states.map((st) => (
          <div key={st} class="radio-state">
            <div class="radio-st">{st}</div>
            {list.filter((s) => s.state === st).map(row)}
          </div>
        ))}
        <p class="muted small">Streams by wxradio.org (noaaweatherradio.org), volunteer-run, for direct listening. Expect up to 30 s delay. Not for protection of life or property.</p>
      </section>
    </div>
  );
}

void toast;
