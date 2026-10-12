# 0.5.1 test checklist (Phase 5 follow-ups)

This round covers your Phase 5 checklist notes. Everything new was tested here with sample or mocked data only, so please check against live data.

Restart the server with the new build (`./start.sh`). `start.sh` now also takes `--memory-mb` and `--cpu-percent`.

## Fixes

- [ ] **Himawari and other satellite loops:** no more patches of other times. Only one image time shows; the previous frame stays until the next one has fully loaded.
- [ ] **Server memory:** the default is 40% of RAM (at least 4 GB). Expect about 38 GB on your PC and about 6.4 GB on the 16 GB VPS. Set it lower in the new Server settings, or with `memory_mb`.
- [ ] **Hurricane icon:** redrawn with smooth spiral bands, an eye and a category label. It spins counter-clockwise in the north and clockwise in the south.
- [ ] **Product dropdown:** sits top-centre of every pane, including single-pane mode. For layers without products it shows the layer name.
- [ ] **Rotation scan bar:** sits under the main pane's dropdown, with no overlap.
- [ ] **Storm cells:** the same storm seen by several radars is now one cell and one arrow ("Seen by" in the popup). The rotation scan works the same way.
- [ ] **AQI:** one marker per area, showing the worst pollutant; the popup lists all of them.
- [ ] **METAR pin:** bigger, and resizable from the corner.
- [ ] **Wind particles:**
  - Easier to see: an outline by default, and Colours, Line width and Trails options.
  - Smooth interpolation, and finer data when zoomed in.

## Changes you asked for

- [ ] **3D (the header "3D" button):** it only shows on layers that support it, which are Level II and MRMS reflectivity.
  - **Surfaces** mode is the default: solid 20/40/55 dBZ shells you can edit.
  - **Tops** draws a height axis with echo-top markers.
  - Hover for value and height.
  - **Cloud** mode is still there.
- [ ] **Seismographs (new rail button):**
  - **Browser:** search, region, distance and favourites, plus a "Show stations on map" switch. The layer is no longer in Layers.
  - **Viewer:**
    - all channels at once, and compare up to 12 stations
    - time ranges up to 12 h, live mode
    - filters, units (counts or velocity)
    - spectrogram, helicorder
    - measure tool with PSD
    - CSV/WAV export, and Listen
- [ ] **Radio player → SAME:** decodes alert headers (event, counties, expiry, sender) and the 1050 Hz tone. **Test** plays a sample Tornado Warning. **Map** outlines the counties.
- [ ] **Radio player → Transcribe:** live text under the player.
  - It runs on your PC (Whisper). The model downloads once (40–150 MB), then works offline.
  - Choose Fast or Better.
- [ ] **Loop vs history:**
  - The timeline sliders button is only for live loops.
  - The calendar is only for history, with its own step, max frames and speed.
  - Leaving history restores your loop.
- [ ] **Replay this:** on any alert, sets history to before and after the alert (default 30 min each, configurable).
- [ ] **Historical Storms (new rail button):**
  - **Warnings:** search by type, state, office, dates and text, then Open in history.
  - **Tropical:** search hurricanes since 1851 (Atlantic and East Pacific, plus other basins from IBTrACS). The track is drawn by category; pick a window and Open in history. The storm's position is ringed as the loop plays.
  - **Recent:** ranges you've opened before.
- [ ] **METARs in history:** station plots and METAR analysis layers use the archive (Iowa Environmental Mesonet).
- [ ] **Canada radars (World tab):**
  - "All Canada radars" plus each of the 33 radars, with a Rain/Snow switch.
  - Click a radar marker to pick it.
  - ECCC publishes no open single-site data, so each radar is cut from the national composite. RadarOmega most likely has a licensed feed.
- [ ] **Traffic without a key (Layers → Traffic & roads):**
  - "Road work & closures (open data)": US WZDx feeds, California CHP, Maryland.
  - "Traffic speeds (open data)": Finland, Maryland, New York City.
  - There's no keyless nationwide speed source, so TomTom stays for full flow colours.
- [ ] **Layers menu:** an Active section with "All off", Favourites (star), search, and collapsible groups with counts. The old "later phase" labels are gone.
- [ ] **Drawing:** everything drawn in one session is one drawing with one ×. "New drawing" starts another.
- [ ] **Server settings** (Settings → "Server on this computer"; only when the server runs on this PC):
  - memory, CPU %, threads and disk cache
  - caches with Clear buttons
  - data tuning
  - token and keys
  - logs
  - Restart
- [ ] **Stats panels:** a new App stats panel (Settings → Sources). When the server is on this computer, server and app stats merge into one "This computer" panel.

## Still unchecked from before

- [ ] Watch outlines, recordings (radar and camera, timelapse, record on warnings, export and import), read-aloud, YouTube recording, radar recording from the timeline, bandwidth saver, GPS track, camera badges, mPING.
