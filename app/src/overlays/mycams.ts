// The user's own cameras / streams (YouTube, HLS, image or web page), stored in settings.

import { effect } from "@preact/signals";
import { settings } from "../store";
import { setData } from "./manager";

export function camType(url: string): "yt" | "hls" | "img" | "page" {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "yt";
  if (u.includes(".m3u8")) return "hls";
  if (/\.(jpe?g|png|gif|webp)(\?|$)/.test(u) || u.includes("snapshot") || u.includes("/image")) return "img";
  return "page";
}

effect(() => {
  const cams = settings.value.myCams;
  const feats = cams
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => {
      const t = camType(c.url);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: { id: `my:${c.id}`, n: c.name, sn: "My camera", t, i: t === "img" ? c.url : null, v: t === "hls" || t === "yt" ? c.url : null, p: t === "page" ? c.url : null, r: 60, k: "mine", mine: c.id },
      };
    });
  setData("mycams", { type: "FeatureCollection", features: feats });
});
