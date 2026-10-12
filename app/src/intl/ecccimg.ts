// p7 Canada: the selected Canadian radar's own images. ECCC publishes no open single-site
// volumes (raw ODIM_H5/IRIS data is a cost-recovered feed) and no georeferenced per-site rasters;
// the only per-site product is the pre-rendered Datamart GIF loop (DPQPE rain/snow rate, lowest
// sweep, 240 km, every 6 min; CAPPI as fallback) at dd.weather.gc.ca/today/radar/… — what the
// websites showing "Canadian single-site radar" display. The map keeps the georeferenced 1 km
// composite cropped to the radar's range; this small floating viewer animates the station's own
// images next to it (the server lists them under `datamart` for `/api/intlradar?id=eccc_<site>`).
// Plain DOM so it needs no hook in the UI tree; imported from radar.ts.

import { effect, signal } from "@preact/signals";
import { api } from "../api";
import { settings } from "../store";
import { intlUrl, curPrecip } from "./radar";

interface Frame {
  t: number;
  precip: string;
  url: string;
}

/** site id the viewer was closed for (stays closed until another radar is picked) */
const closedFor = signal<string | null>(null);
let box: HTMLDivElement | null = null;
let timer = 0;
let frames: Frame[] = [];
let idx = 0;
let playing = true;
let shownFor = "";
let loadSeq = 0;
let refresh = 0;

const singleSite = (id: string) => /^eccc_c[a-z]{4}$/i.test(id);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function ensureBox(): HTMLDivElement {
  if (box) return box;
  box = el("div", "eccc-img glass");
  box.innerHTML = `<div class="eccc-head"><b class="eccc-title"></b><span class="eccc-play" role="button" title="Play / pause">❚❚</span><span class="eccc-x" role="button" title="Close">×</span></div>
<div class="eccc-pic"><img alt="ECCC radar image" draggable="false"/><div class="eccc-msg"></div></div>
<input class="eccc-slider" type="range" min="0" max="0" value="0"/>
<div class="eccc-foot"><span class="eccc-time"></span><a class="eccc-src" target="_blank" rel="noopener">ECCC Datamart</a></div>`;
  box.querySelector(".eccc-x")!.addEventListener("click", () => (closedFor.value = shownFor));
  box.querySelector(".eccc-play")!.addEventListener("click", () => {
    playing = !playing;
    box!.querySelector(".eccc-play")!.textContent = playing ? "❚❚" : "▶";
  });
  const sl = box.querySelector<HTMLInputElement>(".eccc-slider")!;
  sl.addEventListener("input", () => {
    playing = false;
    box!.querySelector(".eccc-play")!.textContent = "▶";
    show(+sl.value);
  });
  document.body.appendChild(box);
  return box;
}

function hide() {
  clearInterval(timer);
  clearInterval(refresh);
  timer = refresh = 0;
  box?.remove();
  box = null;
  shownFor = "";
  frames = [];
}

const fmt = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });

function show(i: number) {
  if (!box || !frames.length) return;
  idx = Math.max(0, Math.min(frames.length - 1, i));
  const f = frames[idx];
  const img = box.querySelector<HTMLImageElement>(".eccc-pic img")!;
  const u = intlUrl(f.url);
  if (img.getAttribute("src") !== u) img.src = u;
  box.querySelector<HTMLInputElement>(".eccc-slider")!.value = String(idx);
  box.querySelector(".eccc-time")!.textContent = `${fmt(f.t)} · ${idx + 1}/${frames.length}`;
  // warm the next image so the loop doesn't flicker
  const nx = frames[(idx + 1) % frames.length];
  if (nx) new Image().src = intlUrl(nx.url);
}

async function load(id: string) {
  const seq = ++loadSeq;
  const b = ensureBox();
  const msg = b.querySelector<HTMLElement>(".eccc-msg")!;
  const site = id.slice(5).toUpperCase();
  b.querySelector(".eccc-title")!.textContent = `${site} station image`;
  b.querySelector<HTMLAnchorElement>(".eccc-src")!.href = `https://dd.weather.gc.ca/today/radar/DPQPE/GIF/${site}/`;
  try {
    const r = await api.get<{ sources: any[] }>(`/api/intlradar?id=${encodeURIComponent(id)}`);
    if (seq !== loadSeq || shownFor !== id) return;
    const dm = r.sources?.[0]?.datamart;
    const want = curPrecip();
    const all: Frame[] = dm?.frames ?? [];
    let list = all.filter((f) => f.precip === want);
    if (!list.length) list = all;
    // last 2 hours (20 frames at 6 min)
    frames = list.slice(-20);
    b.querySelector<HTMLAnchorElement>(".eccc-src")!.href = `https://dd.weather.gc.ca/today/radar/${dm?.product ?? "DPQPE"}/GIF/${site}/`;
    b.querySelector(".eccc-title")!.textContent = `${site} · ${dm?.product ?? "DPQPE"} ${list[0]?.precip === "snow" ? "snow" : "rain"} (station image)`;
    const sl = b.querySelector<HTMLInputElement>(".eccc-slider")!;
    sl.max = String(Math.max(0, frames.length - 1));
    msg.textContent = frames.length ? "" : dm?.error ? `No station images: ${dm.error}` : "No station images listed today.";
    b.classList.toggle("empty", !frames.length);
    if (frames.length) show(frames.length - 1);
  } catch (e: any) {
    if (seq === loadSeq) msg.textContent = `Station images unavailable: ${e?.message ?? e}`;
  }
}

effect(() => {
  const w = settings.value.weather;
  const id = w.kind === "intl" ? w.id : "";
  const precip = w.kind === "intl" ? w.precip ?? "rain" : "";
  const closed = closedFor.value;
  if (!id || !singleSite(id) || closed === id || !api.base) {
    if (closed && closed !== id) closedFor.value = null;
    hide();
    return;
  }
  const key = `${id}|${precip}`;
  if (key === (box?.dataset.key ?? "")) return;
  shownFor = id;
  ensureBox().dataset.key = key;
  load(id);
  clearInterval(timer);
  // loop: 400 ms per frame, 1.5 s on the newest
  let hold = 0;
  timer = window.setInterval(() => {
    if (!playing || !frames.length) return;
    if (idx === frames.length - 1 && hold++ < 3) return;
    hold = 0;
    show((idx + 1) % frames.length);
  }, 400);
  clearInterval(refresh);
  refresh = window.setInterval(() => shownFor && load(shownFor), 6 * 60_000);
});
