// Big weather-radio window: station browser (search, state, favorites, my streams), details,
// simple listening, and DVR player pop-ups. Can pop out into its own window.

import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { settings, update, openPanel } from "../store";
import { playStream, stopStream, nowPlaying, radioState, openPlayer, players, closePlayer, type Stream } from "../radio";
import { popout } from "../popout";
import { mapRef } from "../map/mapview";
import { CenterModal } from "./CenterModal";
import { NowPlaying } from "./panels/RadioPanel";
import { Toggle } from "./panels/RadarPanel";
import { Search, Play, Square, Star, Plus, Trash2, Radio, PictureInPicture2, PanelLeft, MapPin, AudioLines, Loader, Copy, X } from "lucide-preact";
import { ScanLine } from "lucide-preact"; // radio/dash 0.8
import { ScannerPanel, ScanRowBtn, scanView } from "./Scanner"; // radio/dash 0.8
import { scanOn } from "../same/scanner"; // radio/dash 0.8

export const radioOpen = signal(false);

let cache: Stream[] | null = null;
let coords: Map<string, [number, number]> | null = null;

export function RadioCenter({ popped = false }: { popped?: boolean }) {
  if (!popped && !radioOpen.value) return null;
  return <RadioBody popped={popped} />;
}

function RadioBody({ popped }: { popped: boolean }) {
  const [streams, setStreams] = useState<Stream[] | null>(cache);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [st, setSt] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [sel, setSel] = useState<Stream | null>(null);
  const [adding, setAdding] = useState(false);
  const [nn, setNn] = useState("");
  const [nu, setNu] = useState("");
  const [, setTick] = useState(0);
  const r = settings.value.radio;
  useEffect(() => {
    if (cache) return;
    api
      .get("/api/ovl/radio")
      .then((v) => {
        cache = v.streams.map((s: any) => ({ id: s.id, name: `${s.city}, ${s.state}`, url: s.url, call: s.call, city: s.city, state: s.state }));
        setStreams(cache);
      })
      .catch((e) => setErr(e.message));
    if (!coords)
      api
        .get("/api/ovl/radiomap")
        .then((fc) => {
          coords = new Map();
          for (const f of fc.features ?? []) if (f.geometry?.coordinates) coords.set(String(f.properties?.id ?? f.properties?.url), f.geometry.coordinates);
          setTick((t) => t + 1);
        })
        .catch(() => {});
  }, []);
  const custom: Stream[] = r.custom.map((c, i) => ({ id: `custom:${i}`, name: c.name, url: c.url }));
  const qq = q.trim().toLowerCase();
  const all = streams ?? [];
  const states = useMemo(() => [...new Set(all.map((s) => s.state!).filter(Boolean))].sort(), [streams]);
  const list = useMemo(
    () => all.filter((s) => (!qq || `${s.call} ${s.city} ${s.state}`.toLowerCase().includes(qq)) && (!st || s.state === st) && (!favOnly || r.favorites.includes(s.id))),
    [streams, qq, st, favOnly, r.favorites],
  );
  const favs = all.filter((s) => r.favorites.includes(s.id));
  const groups = useMemo(() => {
    const m = new Map<string, Stream[]>();
    for (const s of list) {
      const k = s.state ?? "";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);
  const fav = (id: string) => update((x) => (x.radio.favorites = x.radio.favorites.includes(id) ? x.radio.favorites.filter((f) => f !== id) : [...x.radio.favorites, id]));
  const close = () => (radioOpen.value = false);
  const isPlayer = (s: Stream) => players.value.some((w) => w.id === s.url);
  const row = (s: Stream) => {
    const on = nowPlaying.value?.url === s.url;
    return (
      <div key={s.id} class={`rc-row ${on || isPlayer(s) ? "on" : ""} ${sel?.id === s.id ? "sel" : ""}`} onClick={() => setSel(s)}>
        <button class="icon-btn" title={on ? "Stop" : "Listen"} onClick={(e) => (e.stopPropagation(), on ? stopStream() : playStream(s))}>
          {on && radioState.value === "loading" ? <Loader size={13} class="spin" /> : on ? <Square size={13} /> : <Play size={13} />}
        </button>
        {s.call && <span class="rcall">{s.call}</span>}
        <span class="rname">{s.city ?? s.name}</span>
        <button class="btn sm ghost rc-pl" title="Open in a player (seek, record)" onClick={(e) => (e.stopPropagation(), openPlayer(s))}>
          <AudioLines size={12} /> Player
        </button>
        {(scanView.value || scanOn.value) && <ScanRowBtn s={s} /> /* radio/dash 0.8 */}
        {!s.id.startsWith("custom:") && (
          <button class={`icon-btn ${r.favorites.includes(s.id) ? "fav" : ""}`} title="Favorite" onClick={(e) => (e.stopPropagation(), fav(s.id))}>
            <Star size={12} />
          </button>
        )}
      </div>
    );
  };
  const c = sel ? coords?.get(sel.id) : null;
  return (
    <CenterModal
      cls="rc"
      popped={popped}
      icon={<Radio size={20} />}
      title="Weather radio"
      sub={streams ? `${all.length} NOAA Weather Radio streams` : "Loading…"}
      onClose={close}
      actions={
        <>
          {/* radio/dash 0.8: scanner */}
          <button class={`btn sm ${scanView.value ? "" : "ghost"} rc-scanbtn ${scanOn.value ? "live" : ""}`} aria-pressed={scanView.value} title="Scanner: monitor several stations for alerts, cycle or hold the audio" onClick={() => (scanView.value = !scanView.value)}>
            <ScanLine size={13} /> Scanner{scanOn.value ? " · on" : ""}
          </button>
          {!popped && (
          <>
            <button class="icon-btn" title="Pop out to its own window" onClick={() => (popout({ kind: "radiocenter", title: "Weather radio", width: 1040, height: 720 }), close())}>
              <PictureInPicture2 size={15} />
            </button>
            <button class="icon-btn" title="Compact side panel" onClick={() => ((openPanel.value = "radio"), close())}>
              <PanelLeft size={15} />
            </button>
          </>
          )}
        </>
      }
    >
      <div class={`rc-grid ${scanView.value ? "scanning" : ""}`}>
        <div class="rc-left">
          <div class="rc-filters">
            <div class="search">
              <Search size={14} />
              <input placeholder="Call sign, city or state" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </div>
            <select value={st} onChange={(e) => setSt((e.target as HTMLSelectElement).value)}>
              <option value="">All states</option>
              {states.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            <button class={`chip ${favOnly ? "on" : ""}`} onClick={() => setFavOnly(!favOnly)} title="Favorites only">
              <Star size={12} /> {favs.length}
            </button>
          </div>
          <div class="rc-list">
            {!streams && !err && <div class="muted small">Loading stations…</div>}
            {err && <div class="err-text small">{err}</div>}
            {favs.length > 0 && !qq && !st && !favOnly && (
              <div class="radio-state">
                <div class="radio-st">Favorites</div>
                {favs.map(row)}
              </div>
            )}
            {groups.map(([k, ss]) => (
              <div key={k} class="radio-state">
                <div class="radio-st">
                  {k} <small class="muted">{ss.length}</small>
                </div>
                {ss.map(row)}
              </div>
            ))}
            {streams && !list.length && <div class="muted small">No stations match.</div>}
          </div>
        </div>
        {scanView.value ? (
          <div class="rc-right rc-scanner">
            <ScannerPanel />
          </div>
        ) : (
        <div class="rc-right">
          <section class="rc-card">
            {sel ? (
              <>
                <div class="rc-sel-head">
                  <div>
                    <div class="rc-sel-call">{sel.call ?? sel.name}</div>
                    <div class="muted">{sel.call ? `${sel.city}, ${sel.state}` : "My stream"}</div>
                  </div>
                  <button class="icon-btn" title="Close" onClick={() => setSel(null)}>
                    <X size={14} />
                  </button>
                </div>
                <div class="rc-url">
                  <code title={sel.url}>{sel.url}</code>
                  <button class="icon-btn" title="Copy URL" onClick={() => navigator.clipboard?.writeText(sel.url)}>
                    <Copy size={12} />
                  </button>
                </div>
                {c && (
                  <div class="muted small">
                    {c[1].toFixed(3)}, {c[0].toFixed(3)} (stream placed at its city)
                  </div>
                )}
                <div class="row wrap">
                  <button class="btn sm" onClick={() => (nowPlaying.value?.url === sel.url ? stopStream() : playStream(sel))}>
                    {nowPlaying.value?.url === sel.url ? <Square size={12} /> : <Play size={12} />} {nowPlaying.value?.url === sel.url ? "Stop" : "Listen"}
                  </button>
                  <button class="btn sm ghost" onClick={() => openPlayer(sel)}>
                    <AudioLines size={12} /> Player
                  </button>
                  {!sel.id.startsWith("custom:") && (
                    <button class={`btn sm ghost ${r.favorites.includes(sel.id) ? "fav" : ""}`} onClick={() => fav(sel.id)}>
                      <Star size={12} /> {r.favorites.includes(sel.id) ? "Favorite" : "Add favorite"}
                    </button>
                  )}
                  {c && mapRef.value && !popped && (
                    <button
                      class="btn sm ghost"
                      onClick={() => {
                        update((x) => (x.ovl.nwr = { ...(x.ovl.nwr ?? {}), on: true }));
                        mapRef.value!.flyTo({ center: c, zoom: Math.max(mapRef.value!.getZoom(), 7) });
                        close();
                      }}
                    >
                      <MapPin size={12} /> Show on map
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div class="muted small">Pick a station for details. "Player" opens a recorder with a seek bar over everything heard since it started.</div>
            )}
          </section>
          <NowPlaying />
          {players.value.length > 0 && (
            <section>
              <label class="lbl">Open players</label>
              {players.value.map((w) => (
                <div key={w.id} class="rc-row on">
                  <AudioLines size={13} />
                  <span class="rname">{w.p.stream.call ?? w.p.stream.name}</span>
                  <small class="muted">{w.p.snap.value.rec ? "● Recording" : w.p.snap.value.status}</small>
                  <button class="icon-btn" title="Close player" onClick={() => closePlayer(w.id)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </section>
          )}
          {!popped && (
            <section>
              <Toggle label="Show stations on the map" on={!!settings.value.ovl.nwr?.on} set={(v) => update((x) => (x.ovl.nwr = { ...(x.ovl.nwr ?? {}), on: v }))} />
            </section>
          )}
          <section>
            <label class="lbl">My streams</label>
            {custom.map((s, i) => (
              <div key={s.id} class={`rc-row ${sel?.id === s.id ? "sel" : ""}`} onClick={() => setSel(s)}>
                <button class="icon-btn" onClick={(e) => (e.stopPropagation(), nowPlaying.value?.url === s.url ? stopStream() : playStream(s))}>
                  {nowPlaying.value?.url === s.url ? <Square size={13} /> : <Play size={13} />}
                </button>
                <span class="rname">{s.name}</span>
                <button class="btn sm ghost rc-pl" onClick={(e) => (e.stopPropagation(), openPlayer(s))}>
                  <AudioLines size={12} /> Player
                </button>
                <button class="icon-btn" title="Remove" onClick={(e) => (e.stopPropagation(), update((x) => x.radio.custom.splice(i, 1)))}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {adding ? (
              <div class="custom-bm-form">
                <input placeholder="Name" value={nn} onInput={(e) => setNn((e.target as HTMLInputElement).value)} />
                <input placeholder="Stream URL (mp3, aac, m3u8, pls)" value={nu} onInput={(e) => setNu((e.target as HTMLInputElement).value.trim())} />
                <div class="row">
                  <button
                    class="btn sm"
                    disabled={!/^https?:\/\//.test(nu)}
                    onClick={() => {
                      update((x) => x.radio.custom.push({ name: nn.trim() || "Stream", url: nu }));
                      setAdding(false);
                      setNn("");
                      setNu("");
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
            {popped && <p class="muted small">Changes to favorites and streams made in this window aren't saved.</p>}
          </section>
          <p class="muted small">Streams by wxradio.org (volunteer-run). Please keep to one or two streams at a time. Expect up to 30 s delay. Not for protection of life or property.</p>
        </div>
        )}
      </div>
    </CenterModal>
  );
}
