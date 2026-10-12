// Example TheBigWeather plugin: "Nearest METAR temperature at cursor".
// Shows the temperature, wind and distance of the METAR station nearest to the mouse in a small
// panel, and draws a ring around that station. Load it from Settings → Plugins → Load .js file.

export default async function (tbw) {
  const units = tbw.settings().units;
  let stations = [];

  async function load() {
    try {
      const fc = await tbw.fetchServer("/api/ovl/metar");
      stations = (fc.features || []).filter((f) => f.properties && f.properties.t != null);
    } catch (e) {
      tbw.toast("couldn't load METARs: " + e.message, "warn");
    }
  }
  await load();
  const timer = setInterval(load, 5 * 60 * 1000);
  tbw.onUnload(() => clearInterval(timer));

  const ring = tbw.addGeoJSONLayer("nearest", { type: "FeatureCollection", features: [] }, {
    type: "circle",
    paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#f59e0b", "circle-stroke-width": 2.5 },
  });

  let out = null;
  tbw.addPanel("Nearest METAR", (el) => {
    el.innerHTML = '<div style="font-size:22px;font-weight:700" data-t>—</div><div data-s style="opacity:.75"></div>';
    out = el;
    return () => (out = null);
  });

  const R = 6371e3, rad = Math.PI / 180;
  const dist = (a, b, c, d) => {
    const x = Math.sin(((c - a) * rad) / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  let last = 0;
  tbw.on("mousemove", (e) => {
    const now = performance.now();
    if (now - last < 60 || !stations.length) return;
    last = now;
    const { lat, lng } = e.lngLat;
    let best = null, bd = Infinity;
    for (const f of stations) {
      const [lon, la] = f.geometry.coordinates;
      const d = dist(lat, lng, la, lon);
      if (d < bd) (bd = d), (best = f);
    }
    if (!best || !out) return;
    const p = best.properties;
    const t = units.temp === "F" ? `${Math.round(p.t * 1.8 + 32)}°F` : `${Math.round(p.t)}°C`;
    const km = bd / 1000;
    const d = units.distance === "km" ? `${km.toFixed(0)} km` : `${(km / 1.609).toFixed(0)} mi`;
    out.querySelector("[data-t]").textContent = `${p.id}  ${t}`;
    out.querySelector("[data-s]").textContent = `${d} away · wind ${p.wd ?? "VRB"}° ${p.ws != null ? Math.round(p.ws) + " kt" : "—"}`;
    ring.setData({ type: "FeatureCollection", features: [best] });
  });
}
