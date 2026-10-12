// Camera marker badges: a red dot on cameras being recorded on the server (from the shared
// /api/rec list that the recordings panel and camera viewers keep fresh) and a circle-arrow badge
// on 360°/panoramic cameras (my cameras flagged 360°).

import { effect } from "@preact/signals";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { settings } from "../store";
import { mapRef } from "../map/mapview";
import { recs } from "../ui/panels/RecordPanel";

const SRC = "cam-badges";

function panoIcon(map: MLMap) {
  if (map.hasImage("badge-360")) return;
  const R = 2, S = 14;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S * R;
  const c = cv.getContext("2d")!;
  c.scale(R, R);
  c.fillStyle = "#0b1220";
  c.strokeStyle = "#fff";
  c.lineWidth = 1;
  c.beginPath();
  c.arc(S / 2, S / 2, S / 2 - 0.6, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.strokeStyle = "#7dd3fc";
  c.lineWidth = 1.6;
  c.beginPath();
  c.arc(S / 2, S / 2, 3.6, -Math.PI * 0.15, Math.PI * 1.45);
  c.stroke();
  // arrow head
  const a = -Math.PI * 0.15, x = S / 2 + Math.cos(a) * 3.6, y = S / 2 + Math.sin(a) * 3.6;
  c.fillStyle = "#7dd3fc";
  c.beginPath();
  c.moveTo(x + 2.4, y - 0.4);
  c.lineTo(x - 1.2, y - 2.2);
  c.lineTo(x - 0.4, y + 1.8);
  c.closePath();
  c.fill();
  const img = c.getImageData(0, 0, S * R, S * R);
  map.addImage("badge-360", { width: S * R, height: S * R, data: new Uint8Array(img.data.buffer) }, { pixelRatio: R });
}

function ensure(map: MLMap) {
  panoIcon(map);
  if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  if (!map.getLayer(`${SRC}-rec`))
    map.addLayer({
      id: `${SRC}-rec`,
      type: "circle",
      source: SRC,
      filter: ["==", ["get", "k"], "rec"],
      paint: { "circle-radius": 4.2, "circle-color": "#ef4444", "circle-stroke-color": "#fff", "circle-stroke-width": 1.2, "circle-translate": [9, -9] },
    });
  if (!map.getLayer(`${SRC}-pano`))
    map.addLayer({
      id: `${SRC}-pano`,
      type: "symbol",
      source: SRC,
      filter: ["==", ["get", "k"], "pano"],
      layout: { "icon-image": "badge-360", "icon-offset": [-9, -9], "icon-allow-overlap": true, "icon-ignore-placement": true },
    });
}

function features() {
  const out: any[] = [];
  const o = settings.value.ovl;
  if (o.cameras?.on || o.mycams?.on)
  for (const r of recs.value) {
    const c = r.camera;
    if (r.kind !== "camera" || r.status !== "recording" || !c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    out.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { k: "rec", id: c.id } });
  }
  if (settings.value.ovl.mycams?.on)
    for (const c of settings.value.myCams) {
      if (!(c.pano || /\b360\b|panoram/i.test(c.name)) || !Number.isFinite(c.lat)) continue;
      out.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { k: "pano", id: c.id } });
    }
  return out;
}

function draw(map: MLMap) {
  if (!map.getStyle()) return;
  ensure(map);
  (map.getSource(SRC) as GeoJSONSource).setData({ type: "FeatureCollection", features: features() });
  // keep the badges above camera icons added later
  for (const l of [`${SRC}-rec`, `${SRC}-pano`]) if (map.getLayer(l)) map.moveLayer(l);
}

let hooked: MLMap | null = null;
effect(() => {
  const map = mapRef.value;
  void recs.value;
  void settings.value.myCams;
  void settings.value.ovl;
  if (!map) return;
  if (hooked !== map) {
    hooked = map;
    map.on("style.load", () => setTimeout(() => draw(map), 50));
  }
  if ((map as any).style?._loaded) setTimeout(() => draw(map), 50);
});
