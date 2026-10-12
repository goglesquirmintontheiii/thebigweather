# TheBigWeather plugins

Plugins are small JavaScript files that add map layers, data sources or panels to the app.
Manage them in **Settings → Plugins**: load a `.js` file, add one by URL, paste code, or (desktop app)
drop files into the plugin folder shown there (`<userData>/plugins`). Each plugin can be enabled,
disabled, reloaded and removed. Errors are caught and shown next to the plugin.

> **Security:** a plugin runs inside the app's window with the same rights as the app itself
> (your settings, the server token, the network). Only use code you wrote or trust.

## Format

Either an ES module with a default export:

```js
export default async function (tbw) {
  tbw.toast("Hello from my plugin");
  return () => {/* optional cleanup when disabled */};
}
```

or a plain script, which runs as the body of that function (`tbw` is in scope):

```js
tbw.toast("Hello");
```

## The `tbw` API (version 1)

Everything a plugin registers through the API is removed automatically when it is disabled or reloaded.

| Member | Description |
| --- | --- |
| `tbw.version` | API version (1). |
| `tbw.plugin` | `{ id, name }` of this plugin. |
| `tbw.map` | The MapLibre GL map (`maplibregl.Map`). Use it freely; things added directly are not cleaned up for you. |
| `tbw.addGeoJSONLayer(id, data, style?)` | Add a GeoJSON source + layer(s) that survive basemap changes. `data` is a GeoJSON object or URL. `style` is `{ type?, paint?, layout?, filter?, minzoom? }` or an array of them (one layer each). The type defaults from the geometry (circle / line / fill). Returns `{ setData(data), remove() }`. |
| `tbw.addSource(id, sourceSpec, layers?)` | Add a raw MapLibre source and layers (layer ids are prefixed). Not re-added after a basemap change. Returns the source id. |
| `tbw.addPanel(title, render)` | A floating panel; `render(el)` fills the element and may return a cleanup function. Returns a function that removes the panel. |
| `tbw.onFrame(cb)` | `cb({ index })` whenever the shown animation frame changes. Returns an unsubscribe function. |
| `tbw.onAlert(cb)` | `cb(feature)` for each newly seen NWS alert (GeoJSON feature with `properties.event`, `areaDesc`, `id` …). |
| `tbw.on(event, cb)` | Map events (`click`, `mousemove`, `moveend` …), removed with the plugin. |
| `tbw.toast(msg, kind?)` | Show a toast (`"info"`, `"warn"`, `"error"`). |
| `tbw.fetchServer(path, as?)` | GET from the connected TheBigWeather server with its token, e.g. `"/api/ovl/metar"`. `as`: `"json"` (default), `"text"`, `"arrayBuffer"`. |
| `tbw.settings()` | A read-only copy of the app settings (units, saved points …). |
| `tbw.onUnload(fn)` | Run `fn` when the plugin is disabled or reloaded. |

Useful server paths: `/api/ovl/<id>` for any overlay feed (e.g. `metar`, `glm`, `lsr`, `spc?day=1&kind=cat`,
`stormattr`, `airquality`, `forecast?lat=..&lon=..`), `/api/alerts`, `/api/grid/frames?layer=cref&n=6`.

## Example

`tools/plugins/example.js` — *Nearest METAR temperature at cursor*: keeps the METAR list, finds the
station nearest to the mouse, shows its temperature and wind in a panel and rings it on the map.

```js
export default async function (tbw) {
  let stations = (await tbw.fetchServer("/api/ovl/metar")).features;
  const ring = tbw.addGeoJSONLayer("nearest", { type: "FeatureCollection", features: [] },
    { type: "circle", paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#f59e0b", "circle-stroke-width": 2.5 } });
  let out;
  tbw.addPanel("Nearest METAR", (el) => { out = el; });
  tbw.on("mousemove", (e) => {
    // … find the nearest station to e.lngLat, then:
    // out.textContent = `${p.id} ${t}`; ring.setData({ type: "FeatureCollection", features: [best] });
  });
}
```
