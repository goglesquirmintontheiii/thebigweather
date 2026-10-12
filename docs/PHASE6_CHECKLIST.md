# Phase 6 test checklist (0.6.0)

This list covers two rounds: the Phase 5 follow-ups (0.5.1) and Phase 6 (0.6.0). Everything new was tested only with sample or mocked data, because my build machine can't reach the live feeds. Please check against live data. If something fails, send a screenshot, the line from Settings → Sources, or the server log line.

**Install:**
- **Linux:** run `./start.sh` again for the server, and use the AppImage for the app.
- **Windows:** run `start.cmd` (or `start.ps1`) for the server, and `TheBigWeather-0.6.0-setup.exe` or `-portable.exe` for the app.
- **One-computer setups:** the app can now run the server itself. Choose "Run the server in this app" on first start, or turn it on under Settings → Desktop.

## Part 1 — Phase 5 follow-ups (0.5.1)

### Fixes

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

### Changes you asked for

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

### Still unchecked from before

- [ ] Watch outlines, recordings (radar and camera, timelapse, record on warnings, export and import), read-aloud, YouTube recording, radar recording from the timeline, bandwidth saver, GPS track, camera badges, mPING.

## Part 2 — Phase 6 (0.6.0)

### Radar and severe weather
- [ ] **Placefiles** (… menu → Placefiles):
  - Add a GRLevelX placefile by URL, or drop a local file on the map.
  - Icons, lines, polygons, text and images draw, and the file refreshes on its own schedule.
- [ ] **Debris signatures (TDS)** (Layers → Severe): low CC, near-zero ZDR and high reflectivity next to a rotation couplet. These show as a pulsing purple outline.
- [ ] **Hail:**
  - "Hail (dual-pol)": size classes per storm, plus a MESH estimate.
  - "Hail swath (loop)": the largest hail over the loop.
- [ ] **Rotation tracks (loop):** rotation detections joined frame to frame and coloured by strength.
- [ ] **Dealias** (radar panel, Level II velocity): cleans up folded velocities. Storm-relative velocity uses the cleaned data.
- [ ] **Inspector** (`I`, or … menu): every product's value at the cursor, plus hail, debris and rotation flags.
- [ ] **Damage surveys** (NWS damage survey tool): tracks, swaths and points coloured by EF rating.
- [ ] **Tornado history** (SPC, 1950 to last year): filter by years and rating.
- [ ] **Lightning near my points** (… menu): a chip shows the last strike within 10 mi of a saved point.

### Forecast and data
- [ ] **Contours / Barbs** (buttons above the legend, model layers):
  - isobars, heights and temperatures with labels
  - wind barbs at 10 m, 850, 500 or 250 mb
  - contours of a different field (e.g. MSLP over precipitation)
- [ ] **Model comparison:** Forecast window → Models tab, or right-click → "Compare models here". About 8 models side by side.
- [ ] **Swipe compare** (grid button → Swipe): drag the divider between two weather layers.
- [ ] **Nowcast** (layer menu → Future): MRMS radar pushed 10–60 min ahead from its recent motion, labelled as forecast.
- [ ] **Flooding** (layer menu → Water):
  - MRMS FLASH (streamflow, return periods, ratio to flash-flood guidance)
  - Stream flooding layer (National Water Model)
- [ ] **Hurricanes:** NHC wind-speed probabilities (34/50/64 kt), storm surge / surge flooding, arrival of tropical-storm winds.
- [ ] **Marine:** GFS-Wave height, period and direction (Water tab), and SST anomaly.
- [ ] **Road conditions (511):** Iowa, the Midwest states and Pennsylvania.
- [ ] **Climate:** Forecast window → Climate tab, or right-click → "Climate here". Normals, records with years, last 30 days, and month-to-date departures.
- [ ] **Health and Stars tabs** in the Forecast window:
  - Health: pollen (Europe), UV, AQI.
  - Stars: moon, darkness, clouds, seeing.
- [ ] **Personal weather stations (CWOP):** station plots. The server listens to the APRS feed only while the layer is on.
- [ ] **Space weather:** the Aurora layer gear → Space weather. SDO/LASCO images, solar wind, X-ray class, alerts, aurora timeline.

### Workflow and app
- [ ] **Desktop widgets** (… menu → Desktop widgets):
  - Six kinds: mini radar, current conditions, alert ticker, storm countdown, lightning, clock.
  - Each is a small frameless window with always-on-top, opacity and click-through options. They reopen on start.
- [ ] **Tray icon:** Show, Mini radar, Mute alerts, Close to tray, Quit. It shows a red dot or count for warnings on your points.
- [ ] **Route weather** (… menu):
  - Plan a drive and see warnings, radar and forecast at each point when you'd reach it.
  - "Intercept" suggests roads to reach a storm.
- [ ] **Rules** (… menu → Notification rules):
  - Conditions include warnings, rotation, lightning, storm arrival, AQI, temperature/gust, SPC risk and dBZ at a point.
  - Actions include sound, desktop notification, speech, flash, webhook and opening a layer or workspace.
  - Rules sync through the server.
- [ ] **Briefing** (… menu, or per saved point): a spoken summary. It can also run on a daily schedule.
- [ ] **Kiosk mode** (… menu, or `--kiosk`): full screen cycling your workspaces, with a clock and alert banner.
- [ ] **Look** (Settings → Appearance):
  - Dark / Light / Auto theme.
  - Radar look: Classic or Smooth.
  - Terrain shading and 3D terrain.
  - Animated snow/rain while the MRMS precipitation-type layer is shown.
- [ ] **Offline maps** (Settings): download basemap tiles for an area and zoom range, then use them without internet.
- [ ] **Plugins** (Settings): load your own JavaScript. See `docs/PLUGINS.md` and `tools/plugins/example.js`.
- [ ] **Share live view** (… menu): a link opens a read-only view of your map. With Live on, it follows your view and drawings.
- [ ] **Team** (… menu): create or join a room by code, and share positions, drawings, pins and notes; follow a member's view.

### Windows
- [ ] **Windows app:** installer and portable .exe, tray, auto-start, file associations (`.pal`, `.tbwws`, `.ar2v`). The .exe files are unsigned, so Windows SmartScreen may warn: choose More info → Run anyway.
- [ ] **Windows server:**
  - `start.cmd` / `start.ps1` creates the config and prints the URL and token.
  - Optional: `-InstallService`, ffmpeg and yt-dlp through winget, a firewall rule, HTTPS with `-Domain`.
- [ ] **Built-in server** (Settings → Desktop): the app runs its own server, with no separate install.
