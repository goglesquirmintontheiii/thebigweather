# Phase 4 test checklist

I tested these here with sample data:
- file imports, including a 450 kB KML and a 180 MB GeoJSON
- the camera database importer, on a synthetic 195 MB file with 135k records
- drawing, panes, and the forecast/radio panels
- the recording, export and import round trip, with a still camera and an HLS stream through ffmpeg

My build machine can't reach the live feeds, so please check those on yours. If something fails, send a screenshot, the line from Settings → Sources, or the line from the server log.

## Phase 3 fixes (re-test)

- [ ] **Popups:** click a lightning bolt, storm track or camera, then drag the map. The popup stays on the item, and closes once the item leaves the screen.
- [ ] **Custom basemap:** Basemap tab (new map icon in the left rail) → Custom tile servers. Your server's tiles show.
  - CARTO names are now off unless you turn them on in the server's settings (pencil).
  - Saving test-loads one tile and tells you if it fails.
  - TMS servers can use `{-y}`.
- [ ] **Himawari:** the three Himawari layers load. The app now asks NASA which times exist and which image format each layer uses.
- [ ] **Server RAM:** after 10+ minutes of looping and switching, the server should stay around 3 GB on your PC.
  - On the VPS, around 1 GB.
  - Set `memory_mb` under `[profile]` in config.toml to change it.
- [ ] **Watch outlines:** click inside a watch. The info panel on the right shows the type, number, times, and probabilities when SPC provides them.
- [ ] **Storm reports:** icons for tornado, funnel, hail, wind, flood, rain, snow, ice and lightning, a bit bigger.
  - The gear has a "Types" filter and a size slider.
- [ ] **Lightning:** bolt icons that start white and fade through orange to dark red, then disappear.
- [ ] **Hurricanes:** click a cone, track or forecast point. The info panel shows class, wind, pressure, motion, position and advisory, with links to the advisory, discussion and graphics.
- [ ] **NWS offices:** markers sit on the office buildings. Positions come from OpenStreetMap where an office is mapped there.
- [ ] **METAR display:** the gear → Show offers detailed plot, temperature, dewpoint, wind direction, wind speed, visibility or flight category.
  - Plots are bigger.
  - Click a station for the wind compass and sky-cover graph.
- [ ] **Flights:** move around a lot. You should get no 429 errors, since the server now makes at most one request every 2.5 s and backs off when told to.
  - Click a plane for its track since takeoff, colored by altitude, falling back to "since it appeared".
  - New options: hide planes on the ground, altitude filter.
- [ ] **My cameras:** right-click the map → Add camera here. Try a YouTube live URL, a `.m3u8` and an image URL. *(not checked last time)*
- [ ] **Ship cameras:** click a ship → Add ship camera. It appears in that ship's popup. *(not checked last time)*
- [ ] **ISS and satellites:** the gear has separate ISS / Tiangong / Hubble / "all stations + weather sats" switches.
  - The ring is small by default (visibility footprint is optional) and no longer covers the whole map near the date line.
  - Click any satellite for its trail (20 min by default, adjustable).
- [ ] **Aurora:** clearly visible on the dark map. There's a "Hide below" option.
- [ ] **Waffle House status:** turn on Store status and zoom into a town.
  - Up to 30 stores nearest the center get checked: green open, yellow limited hours, red closed.
  - The count shows in the layer row.
  - Stores without a website link are matched through the store number or the city page.
- [ ] **Import:** drop a KML and a big GeoJSON (.json) on the map, or use Files & backup → Import.
  - Both draw.
  - A "Reading…" row shows while it works.
  - Both survive a restart.

## Phase 3 change requests

- [ ] **History:** the clock button on the timeline opens the date/time picker, with −1 h / −3 h / −6 h / −1 day / +1 h buttons and **Live** to go back.
  - Works for radar, MRMS, GOES and NASA imagery. Model runs are picked in the header as before.
- [ ] **Frames:** timeline → sliders button.
  - Count mode: up to 120 radar frames.
  - Time mode: 15 min to 24 h, or any number of minutes.
- [ ] **Scrubbing:** click-drag across the frame boxes, or scroll the wheel over them.
- [ ] **Speed:** 0.25–16 fps, plus "Pause on last".
- [ ] **RapidSweep on several radars:** turn RapidSweep on, then Ctrl+click two or three more radars. Each one shows its live partial sweep and its own beam line.
- [ ] **Layer settings window:** each gear opens a centered window with options, display (color, opacity, size, labels, show-from-zoom, draw above weather, refresh rate), and the layer's extras.
- [ ] **Weather alerts settings:** Layers → Weather alerts gear.
  - Show/hide each category or type.
  - Per type: fill and border colors, border style and width, solid / striped / checkered / no fill, fill strength, sound when new (chime, beeps, alarm, siren, with preview), and flash time.
  - Category settings apply to every type inside.
  - Also here: "Read new warnings aloud" and "Sounds for my points only".
- [ ] **Basemap tab:** the Layers tab only has layers now (with a search box). Basemaps are in their own tab.
- [ ] **Smoothing:** a slider from Off to Max, for radar and gridded layers.
- [ ] **Cursor value:** the new pointer button on the toolbar (or V) shows the value next to the mouse. Holding Shift shows it temporarily.
- [ ] **Legend:** click it to move it to a wide strip at the top, and click again to move it back.
- [ ] **Overlapping alerts:** click where several alerts overlap. The panel shows "1/3" arrows, most urgent first. Watches, storms and MDs at that spot are included too. `[` and `]` also step through them.
- [ ] **Loading bars:** a thin bar on the timeline fills as frames load, and a moving line shows while the current frame loads.
- [ ] **More options:** ships (vessel type, moving only), fires, quakes (color by depth/age), PIREPs, SIGMETs (hazard), buoys (label), fronts (H/L, symbols), flights, cameras (stills / video).

## Camera database

- [ ] Put `filtereddb.json` in `server/data/uploads/`. Within a minute, the server log shows records → kept, and inactive / duplicate counts.
  - You can also run `./tbw-server camdb` in the server folder to see the stats.
  - It's cached as a 3 MB file, so later restarts load in under a second.
- [ ] Cameras layer: zoomed out shows numbered clusters (click to zoom in); zoomed in shows single cameras.
- [ ] Gear → Camera sources: a **Camera database** group lists each database source with on/off.
  - The note at the bottom says how many were left out because a live source already shows them.
- [ ] Open a few database cameras: stills, `.m3u8` video, and ones flagged "no cache-buster".

## Phase 4

- [ ] **Panes:** the grid button on the toolbar picks 1, 2 side-by-side, 2 stacked, 3 or 4 panes.
  - Each extra pane picks a radar product (same radar as the main map) or any gridded layer.
  - They follow the main timeline.
  - The link button syncs or unsyncs their position.
- [ ] **Second window:** grid button → window icon opens another full map window with its own layers. It's good for a second monitor, and doesn't change your main settings.
- [ ] **Drawing:** pen button (or D).
  - Tools: freehand, line, arrow, rectangle, circle, polygon (double-click or Enter to finish), text, eraser, and a move-map hand.
  - Also: colors, size, fill, undo/redo (Ctrl+Z / Ctrl+Y), clear.
  - With **Keep** on, drawings stay after closing, with an × to delete each one, and survive restarts.
- [ ] **Pop-out cameras:** the window icon on a camera panel opens it in its own window. The same goes for the radio player.
- [ ] **Recordings (record button in the left rail):**
  - [ ] Record radar now: Level II saves whole volumes; Level III saves up to 4 products. Try 15 min, then Play. It loads as a loop, with "Recording: …" in the header.
  - [ ] Schedule one with a start time.
  - [ ] Camera: click a camera → Record (60 min). Stills save each refresh; video streams are copied with ffmpeg (no re-encoding). YouTube is refused (watch-only).
  - [ ] Play a camera recording: scrub it, or tick **Sync** so it follows the radar loop's time.
  - [ ] Timelapse (film icon) on a still-camera recording downloads an MP4.
  - [ ] Record on warnings: pick event types, minutes and the number of cameras. A new warning then records the nearest radar plus cameras inside the polygon.
  - [ ] Export one or all as .zip (saved to Downloads/TheBigWeather), then Import the zip, ideally on the VPS server too.
- [ ] **Forecast (sun/cloud button):** 24-hour chart (temperature, dewpoint, rain chance), hourly strip, and 7 days.
  - Uses NWS in the US and Open-Meteo elsewhere.
  - Pick a saved point or the map center.
- [ ] **Weather radio:** the list loads from wxradio.org. Play one station; volume, favorites and your own stream URLs work.
  - "Show stations on the map" places them at their city. NOAA doesn't publish transmitter coordinates in a usable list, so the map uses city positions.
- [ ] **Search:** "Go to a place" (OpenStreetMap). "Find on the map" covers hospitals, shelters, gas and others, a name, or a tag like `amenity=cafe` in the current view.
- [ ] **Spotter Network:** Layers → Chasers & reports. Spotters show with heading arrows; streamers are red.
- [ ] **mPING:** add your mPING key in Settings → API keys, then turn on mPING reports.
- [ ] **Files & backup:** export settings to a file, then import it back.
- [ ] **Audio:** new-warning sounds per type and read-aloud. Test with the sound preview button in the alert settings.
