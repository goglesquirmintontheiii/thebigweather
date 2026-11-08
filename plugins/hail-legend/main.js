// Hail size quick legend — a small panel that turns hail sizes in inches into everyday objects,
// and lists the radar-estimated hail sizes of storm cells near the map view.
const SIZES = [
  [0.25, "Pea", "#94a3b8"],
  [0.5, "Marble", "#94a3b8"],
  [0.75, "Penny", "#a3e635"],
  [0.88, "Nickel", "#a3e635"],
  [1.0, "Quarter", "#facc15"],
  [1.25, "Half dollar", "#facc15"],
  [1.5, "Ping-pong ball", "#fb923c"],
  [1.75, "Golf ball", "#fb923c"],
  [2.0, "Hen egg", "#ef4444"],
  [2.5, "Tennis ball", "#ef4444"],
  [2.75, "Baseball", "#d946ef"],
  [4.0, "Grapefruit", "#d946ef"],
  [4.5, "Softball", "#d946ef"],
];

export function objectFor(inches) {
  let best = SIZES[0];
  for (const s of SIZES) if (inches >= s[0] - 0.06) best = s;
  return best;
}

export default async function (tbw) {
  let el = null;
  let cells = [];
  const mm = () => tbw.settings().units?.distance === "km";

  function render() {
    if (!el) return;
    el.innerHTML = "";
    const tbl = document.createElement("div");
    tbl.style.cssText = "display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;font-size:12px;align-items:center";
    for (const [inch, name, col] of SIZES) {
      const dot = document.createElement("i");
      const px = 6 + inch * 4;
      dot.style.cssText = `display:inline-block;width:${px}px;height:${px}px;border-radius:50%;background:${col};justify-self:center`;
      const n = document.createElement("span");
      n.textContent = name;
      const v = document.createElement("span");
      v.style.color = "#8b97a6";
      v.textContent = mm() ? `${Math.round(inch * 25.4)} mm` : `${inch.toFixed(2).replace(/0$/, "")}″`;
      tbl.append(dot, n, v);
    }
    el.append(tbl);
    const note = document.createElement("div");
    note.style.cssText = "font-size:11px;color:#8b97a6;margin:6px 0 4px";
    note.textContent = "1″ (quarter) and up is severe; 2″ (hen egg) and up is significant.";
    el.append(note);
    if (cells.length) {
      const h = document.createElement("div");
      h.style.cssText = "font-size:12px;font-weight:600;margin-top:4px";
      h.textContent = "Hail in view";
      el.append(h);
      for (const c of cells.slice(0, 6)) {
        const [, name, col] = objectFor(c.size);
        const d = document.createElement("div");
        d.style.cssText = "display:flex;justify-content:space-between;font-size:12px";
        d.append(`Cell ${c.id}`);
        const b = document.createElement("b");
        b.style.color = col;
        b.textContent = `${c.size}″ · ${name}`;
        d.append(b);
        el.append(d);
      }
    }
  }

  let all = [];
  function inView() {
    const b = tbw.map.getBounds();
    cells = all
      .filter((f) => (f.properties?.max_size ?? 0) > 0 && f.geometry?.coordinates && b.contains(f.geometry.coordinates))
      .map((f) => ({ id: `${f.properties.nexrad ?? ""} ${f.properties.storm_id ?? ""}`.trim(), size: f.properties.max_size }))
      .sort((a, b) => b.size - a.size);
    render();
  }
  async function refresh() {
    try {
      all = (await tbw.fetchServer("/api/ovl/stormattr"))?.features || [];
    } catch {
      all = [];
    }
    inView();
  }

  tbw.addPanel("Hail size legend", (e) => {
    el = e;
    render();
    return () => (el = null);
  });
  tbw.on("moveend", inView);
  refresh();
  const t = setInterval(refresh, 120000);
  return () => clearInterval(t);
}
