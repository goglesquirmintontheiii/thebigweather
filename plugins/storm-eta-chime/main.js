// Storm ETA chime — plays a short chime (and shows a toast) when a radar-tracked storm cell is
// forecast to reach one of your saved points within the next N minutes.
export default async function (tbw) {
  const KEY = "storm-eta-chime.minutes";
  let minutes = Number(localStorage.getItem(KEY)) || 15;
  const heard = new Map(); // "cell@point" -> time chimed (each pair chimes at most once per 45 min)
  let rows = [];
  let checked = 0;
  let el = null;
  let ctx = null;

  function chime() {
    try {
      ctx = ctx || new AudioContext();
      const t0 = ctx.currentTime + 0.02;
      [880, 1175, 1568].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * 0.16);
        g.gain.linearRampToValueAtTime(0.22, t0 + i * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.16 + 0.6);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + i * 0.16);
        o.stop(t0 + i * 0.16 + 0.65);
      });
    } catch {
      /* audio blocked */
    }
  }

  // same track model as the app: the cell moves toward dir_to at sknt for up to an hour;
  // "arrives" when its path passes within 5 km of the point
  function eta(c, lat, lon) {
    const p = c.properties || {};
    const [clon, clat] = c.geometry.coordinates;
    const k = Math.cos((clat * Math.PI) / 180) * 111195;
    const dx = (lon - clon) * k;
    const dy = (lat - clat) * 111195;
    if (Math.hypot(dx, dy) < 5000) return 0;
    if (p.dir_to == null || !(p.sknt > 0)) return null;
    const mpm = (p.sknt * 1852) / 60;
    const a = (p.dir_to * Math.PI) / 180;
    const along = dx * Math.sin(a) + dy * Math.cos(a);
    const cross = Math.abs(dx * Math.cos(a) - dy * Math.sin(a));
    if (along < 0 || along > mpm * 60 + 5000 || cross > 5000) return null;
    return Math.round(along / mpm);
  }

  function render() {
    if (!el) return;
    const t = checked ? new Date(checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "…";
    el.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px";
    head.append("Chime when a storm is within ");
    const sel = document.createElement("select");
    for (const m of [5, 10, 15, 20, 30, 45, 60]) sel.add(new Option(`${m} min`, String(m), false, m === minutes));
    sel.onchange = () => {
      minutes = Number(sel.value);
      localStorage.setItem(KEY, String(minutes));
      render();
    };
    head.append(sel);
    el.append(head);
    if (!rows.length) {
      const p = document.createElement("div");
      p.style.cssText = "color:#8b97a6;font-size:12px";
      p.textContent = tbw.settings().points?.length ? `No storms heading for your points (checked ${t}).` : "Save a point (My points) to get chimes.";
      el.append(p);
    }
    for (const r of rows) {
      const d = document.createElement("div");
      d.style.cssText = `display:flex;justify-content:space-between;font-size:12px;padding:3px 0;color:${r.min <= minutes ? "#fbbf24" : "inherit"}`;
      d.textContent = `${r.point}`;
      const b = document.createElement("b");
      b.textContent = r.min === 0 ? "now" : `${r.min} min`;
      d.append(b);
      el.append(d);
    }
    const test = document.createElement("button");
    test.textContent = "Test chime";
    test.className = "btn sm ghost";
    test.style.marginTop = "6px";
    test.onclick = chime;
    el.append(test);
  }

  async function check() {
    let fc;
    try {
      fc = await tbw.fetchServer("/api/ovl/stormattr");
    } catch {
      return;
    }
    const pts = tbw.settings().points || [];
    const now = Date.now();
    rows = [];
    let ring = null;
    for (const pt of pts) {
      let best = null;
      for (const c of fc?.features || []) {
        if (!c.geometry?.coordinates) continue;
        const m = eta(c, pt.lat, pt.lon);
        if (m != null && (!best || m < best.min)) best = { min: m, id: `${c.properties?.nexrad}-${c.properties?.storm_id}` };
      }
      if (!best) continue;
      rows.push({ point: pt.name, min: best.min });
      const key = `${best.id}@${pt.id}`;
      if (best.min <= minutes && !(now - (heard.get(key) || 0) < 45 * 60000)) {
        heard.set(key, now);
        ring = ring || `${pt.name}: storm in ${best.min === 0 ? "now" : `${best.min} min`}`;
      }
    }
    rows.sort((a, b) => a.min - b.min);
    checked = now;
    if (ring) {
      chime();
      tbw.toast(ring, "warn");
    }
    render();
  }

  // the panel also gets a sidebar button and a command palette entry (Stormiq 0.8.3+)
  const panel = tbw.addPanel(
    "Storm ETA chime",
    (e) => {
      el = e;
      render();
      return () => (el = null);
    },
    { keywords: "storm eta chime sound alarm" },
  );
  // command palette (Ctrl+K) entries — the ids match "commands" in plugin.json (older apps don't have these calls)
  tbw.addCommand?.({ id: "open", title: "Open panel", keywords: "show eta", run: () => panel.show?.() });
  tbw.addCommand?.({ id: "test", title: "Play test chime", keywords: "sound try", run: chime });
  tbw.addCommand?.({ id: "check", title: "Check storms now", keywords: "refresh eta", run: check });
  tbw.addSetting?.({
    id: "minutes",
    title: "Storm ETA chime within",
    keywords: "minutes warning time",
    options: [5, 10, 15, 20, 30, 45, 60].map((m) => ({ label: `${m} min`, value: m })),
    get: () => minutes,
    set: (v) => {
      minutes = Number(v) || 15;
      localStorage.setItem(KEY, String(minutes));
      render();
    },
  });
  check();
  const timer = setInterval(check, 120000);
  return () => {
    clearInterval(timer);
    ctx?.close();
  };
}
