# Phase 8 test checklist (0.8.0)

Everything new was tested only with sample or mocked data, because my build machine can't reach the live feeds. Please check against live data. If something fails, send a screenshot, the line from Settings → Sources, or the server log line.

**Installing:**
- **From now on:** releases go on GitHub, and future updates install themselves (Settings → Updates).
- **This version:** use the files I sent.
- **Afterwards:** `install-latest.sh` (Linux) / `install-latest.cmd` (Windows) download the newest release, and `./start.sh --update` / `start.ps1 -Update` update the server.

## Part 1 — Fixes and changes from the Phase 7 checklist

### Radio
- [PASS] Decoded SAME alerts, test alerts included, appear on the map **immediately**. The pin button in the SAME bar turns this off.
- [PASS] The Fast / Better / Best transcription picker is a proper button group, not a cut-off dropdown.
- [PASS] The big player's seek bar shows **audio levels**: bars over everything played, with a live peak meter.

### Historical Storms and stats
- [PASS] **Tornadoes tab:** click a track on the map to select it.
- [PASS - But let me stretch in both directions, and if I stretch a merged panel vertically enough it should expand everything to be closer the original merged stats view] **Stats panels:** resize with the corner handle; double-click the handle to reset.

### Detection models
- [PASS] **Export:** export saves the file and shows where it went. It worked before, but the confirmation was hidden behind the window.
- [PASS] **No Run tab:** each model's page has its own run settings, Enable/Stop, **Run now (all radars)**, Test, its detections list and its layers.
- [PASS] **Radar choices:** All US / by state / picked on map / radars on screen. The NEXRAD-only and TDWR-only buttons are gone.
- [NOT CHECKED] **History mode:** with history mode on, "Run on this range" runs the model on archived data. Each model shows a **History compatible** or **Live only** tag.
- [PASS] **Instability and flood risk:** show as a weather layer, highlighted areas, or both.
- [PASS] **Training resources:** CPU threads, RAM, downloads and disk I/O, with Auto/Light/Balanced/Max presets. Jobs show live CPU/RAM/network use.
- [NOT CHECKED] **Animations:** detections follow the timeline. Forecast models make frames every 1 h by default (adjustable), and grid models have a "past runs" layer.
- [PASS] **Presets:**
  - One card per model type, with **Quick / Medium / Thorough / Intensive** buttons.
  - Every type has all four. Intensive uses the most data, sources and resolution.
- [PASS] **Intensity switcher** on a model's page when you've trained it at several intensities.
- [PASS] **Max training jobs:** App and Server inputs at the top of Train (1–8, default 2). Lowering it pauses the newest jobs.
- [PASS] **Models list:**
  - sizes on disk
  - a Server / This computer / Both filter
  - models in training are listed greyed out with progress
  - **Move to…** (server ↔ this computer)
- [PASS - However, I deleted some models that were running, but the legends are still showing even though the models are gone, and I cannot close the legends.] **Per-model gates:** the detections legend expands into one gate per model.
- [PASS] **Stopping a model** hides its detections.
- [] **Storm track model (new):** predicted track with a cone, plus speed and strength at +15/30/45/60 min.
- [PASS] **Jobs:** **Retry** on failed jobs; resume works in place.
- [PASS] **Resuming after a restart:** jobs interrupted by closing the app or stopping the server resume automatically. Downloaded training data (storm reports included) is kept until the job finishes.
- [PASS] **Outside the US:** grid models (flood, precipitation, temperature, instability, tropical, storms) can run anywhere. US-only inputs drop out, and the model shows "lower confidence".

### Panes
- [PASS] **Pop-out:** pop a pane out into its own window (map and product selector only).
- [PASS] **Pane window:** a "Pane window" button opens a new pane-only window, linked to the main map.
- [NOT CHECKED] **Custom layouts:** Settings → Pane layouts has a grid editor with merged cells, up to 6 maps.
- [PASS] **Icons:** proper layout icons, including "three", plus a panes icon on the toolbar.
- [NOT CHECKED] **Popover:** the pane popover stays open after you pick a layout.
- [PASS] **Swipe:** vertical, horizontal or diagonal (rotate handle). Both product selectors follow their side; the selector bug is fixed.
- [PASS] **Per-pane linking:** choose Position / Time / Layers for each pane and each window.

Quick panel changes:
- When the "center crosshair value" option is enabled, the crosshair should appear in the center of all linked panes rather than the screen's center and should show values at the center of all panes
- Allow me to unlink the main panel - if I unlink the main panel then linked panels still stay linked together, but the main map becomes able to move freely
- (If radar locations are shown) show all the radar locations ("KLVX", "KTLX", etc) on the map in all panels. For some reason until I select a product manually, this doesn't happen.
- When drawing with multiple panels open and linked, have an additional drawing option to have that drawing appear in all linked panels, in the same location on the map. Should be on be default.
- Add a button to 
- Make items such as weather alerts and model detections interactable on all panels, not just the main one
- Add a button to show/hide trainable model detections for panels (similar to the layer toggle button)

Panel bugs and issues:
- When opening new panels, even though it shows a product is selected, no radar data loads in the panel until I actually open the products dropdown and click on a product.
- The button to pop out a panel is visually clipped inside of the product selector and is hard to click because of that
- (Even in single panel / regular mode) the product selector's seperator items ("Level II - [station]", "MRMS - Reflectivity", etc) have a white background and gray text, so they are extremely difficult to read.
- (For example) opening a satellite image in one panel (full disk) and radar imagery in the others results in the entire app freezing and crashing, even on my high-end gaming PC. The server seems to be unaffected. I'm not sure if this is a bug or just the result of a lot of intensive graphics rendering creating a lot of hardware load, but it should not be crashing the app completely. When I did this on my laptop with a CONUS region, the app partially stopped responding for a short time (I could move the map around but the map would not load and only already loaded map was visible) and then the app fully froze and crashed shortly after. After the app crash, attempting to run it again would result in a javascript error "Uncaught Exception\nType Error: Object has been destroyed\n at EventEmitter.<anonymous> (/tmp/.mount/TheBigGHUBVa/resources/app.asar/electron/main.cjs:473:14)\nat EVentEmitter.emit (node:events:514:28)" and I had to delete all app data under ~./config/TheBigWeather to get it to start again.
- (Unsure if panel related or not), when clicking on a trainable instability model detection with 3 panes open, the app immediately froze completely but never crashed. Right before clicking, as I was zooming into the detection, my computer started ramping up as if hardware util had started to spike.

### Other
- [PASS] **Seismic events layer** (Seismographs window → events bar, or Layers → Hazards):
  - Events detected on your **starred** stations (up to 20), matched to USGS quakes where possible.
  - Settings: minimum level, stations, period.
  - Click an event to compare those stations at that time.
- [PASS] **Radar recording:** starts with the current volume and keeps recording new ones, also from the real-time feed.
- [PASS] **Briefing audio:** speaks even when the system has no voices, using a built-in offline voice. Settings: engine, voice, rate, and a "Test voice" button. Read-aloud uses the same voice.
- [PASS] **Built-in server:** runs next to a dedicated server; it picks a free port and uses its own data folder. If it fails, the reason is shown.
- [PASS] **yt-dlp:** now kept in `server/bin` and compared with the latest release, so it no longer shows "outdated" again after updating.
- [PASS] **CPU display:** server CPU is now 0–100 % of the whole machine; the per-core value is in the tooltip.
- [PASS] **Level II "403 Forbidden" warnings:** NOAA moved Level II to the `unidata-nexrad-level2` bucket, which is now used first. A bucket that returns 403 is skipped for an hour.
- [PASS] **Updates:** Settings → Updates checks GitHub, downloads in the background and asks to restart.

## Part 2 — Phase 8

### Forecast data
- [NOT CHECKED] **Ensemble probabilities** (layer menu → Ensembles):
  - GEFS (31 members) and ECMWF (51): chance of ≥ X rain/snow (6–72 h), wind, gusts (ECMWF) and temperature.
  - Also mean, spread, min and max.
  - Pick the threshold above the legend.
- [NOT CHECKED] **Severe parameters** (layer menu → Severe):
  - **From HRRR/RAP:** STP, SCP, SHIP, CAPE types, CIN, LCL, shear, SRH, lapse rates, DCAPE, PWAT and theta-e.
  - **One-click composites:** e.g. STP + SRH contours.
- [NOT CHECKED] **Forecast confidence:**
  - A high/medium/low line per day in the Forecast tab.
  - Model spread bands on the charts.

### Radar and detection
- [PARTIALLY CHECKED] **Radar panel → Derived products:**
  - [NOT CHECKED] **ΔREF / ΔVEL:** change since the previous volume.
  - [NOT CHECKED] **ZDR columns:** depth above the freezing level.
  - [NOT CHECKED] **QC reflectivity:** non-weather echoes removed, with a CC slider and a texture slider.
  - [PASS] **Bio/clutter mask.**
  - [PASS] **Beam-blockage map** for the current radar.
- [NOT CHECKED] **Lightning jumps** (Layers → Severe): GLM flash-rate jumps per storm.
- [NOT CHECKED] **Model reports:** detections that last 3 cycles become reports.
  - Models window → Reports: a timeline, CSV/GeoJSON export and Share to Team.
- [NOT CHECKED] **Ensembles and A/B compare** (Models window):
  - Combine models (mean/max/vote/weighted).
  - Compare 2+ models on the same past events, with scorecards and a per-event table.

### Situational awareness
- [PASS] **Dashboard** (rail):
  - One tab per saved point: conditions, alerts, nearby storms with ETA, radar thumbnail, 12 h chart, AQI/pollen.
  - Save, copy or print a summary card.
- [PASS] **Alert timeline** (rail): warnings, watches, MDs, reports and model reports in lanes for an area. Click an item → Replay.
- [NOT CHECKED] **Chaser toolkit** (… menu):
  - Positions for you and your team, with storm-relative motion.
  - A safe-zone guide around a chosen storm.
  - Warnings and closures along your route.
  - Auto-saved chase logs (GPS, snapshots, photos) with zip export.
- [PASS, Though I don't see any FEMA open shelters or cooling/warming centers] **Emergency services** (Layers): FEMA open shelters, hospitals, and cooling/warming centres (OpenStreetMap, from zoom 6).
- [NOT CHECKED] **Earthquakes and tsunamis:**
  - USGS ShakeMap intensity contours, linked to the Seismographs window.
  - NOAA tsunami messages and areas.

### Data and media
- [PASS] **Satellite:**
  - GOES fire detections.
  - Overshooting tops and cloud-top cooling.
  - Fog / low cloud layer (layer menu → Satellite).
- [Partially checked - I clicked TL and verified that the ] **Daily webcam timelapses:**
  - Turn on "TL" in a snapshot camera's viewer, or use Recordings → Timelapses.
  - You get one video per day, with warning and report tags as chapters.
- [PASS - But allow me to easily listen for SAME headers in multiple feeds at once] **Radio scanner** (Weather radio window → Scanner):
  - The server listens to all your scanner stations at once for SAME (needs ffmpeg). The app cycles or holds the audio and jumps to a station when its alert tone or header arrives.
  - "Keep on server" leaves monitoring running 24/7.
  - Without ffmpeg, the app decodes up to 4 stations itself.
- [PASS] **Data export** (… menu, or a layer's settings):
  - Overlays → CSV / GeoJSON / KML.
  - Grid frames → CSV / GeoJSON / NetCDF.
  - Radar sweeps → NetCDF.
  - Charts → PNG/SVG.

### App and platform
- [PASS - But let me customize the message sent with] **Notification channels** (… menu → Notifications): ntfy, Pushover, email (SMTP), Discord, Telegram and webhooks, each with a test button and quiet hours.
- [PASS] **Server-side rules:** set a rule to run on the Server or Both, so it works with the app closed.
  - The rule uses the saved point's position.
  - New conditions: SAME alerts from the scanner, and weather station (PWS) values.
  - A log of what fired.
- [PASS] **Command palette** (Ctrl+K): search layers, menus, settings, places, radars, saved points, workspaces and commands.
- [PASS] **Accessibility** (Settings → Accessibility; all off by default):
  - colour-vision-safe colours
  - text size and high contrast
  - reduced motion
  - keyboard navigation and screen-reader labels

## Part 3 — Still unchecked from earlier

- [PASS for reading aloud new warnings, NOT CHECKED for youtube recording] Read-aloud of new warnings, and YouTube recording.
- [NOT CHECKED] Bandwidth saver, GPS track, camera badges, mPING.
- [PASS for Dealias, PASS for inspector, NOT CHECKED for everything else] Placefiles, debris signatures (TDS), Dealias, Inspector.
- [PASS for notification rules, NOT CHECKED for everything else] Desktop widgets, route weather, notification rules (app side).
- [NOT CHECKED] Offline maps, plugins, share live view, Team.

Some changes I want:
- Add a button to identify a layer's items on a map (make a pulsing animation around them, or if there are a lot of items then pulse around groups of them with the pulsing being visible even when zoomed out quite a bit)
- Make models not only show result confidence but also probability (for example - with storm intensification, it would show probability of it intensifying and confidence in that prediction)
- Make model results have short summaries like "It is predicted x will intensify to y intensity over the next z minutes, with a confidence of abc" or "There is x amount of instability here with a confidence of y"
- Make the storm intensification model highlight the storm or area associated with a detection
- Make camera recording able to be start/stopped manually or done based on an amount of time
- Allow me to use the gate to filter out low confidence storm track predictions made by the storm track trainable model
- Add a button to enable and disable all trainable models at once (or all app/server ones if a filter option is selected)
- Allow me to do timelapses with video cameras
- Allow me to set the length of a single timelapse video (in weeks, days, hours, etc, or by setting an end date/time)
- Allow me to rearrange the items in the rail/sidebar

Bugs I found:
- Deleting a trainable model while its running leaves the legend for it up and I can't close them (as mentioned above)
- The storm track model and storm instability model creates hundreds of detections for single large storms (a few detections for the same storm is fine if its a large storm, as storms can split up or merge together)
- Running a storm track model seems to continue to make more and more detections for the same storms, causing them to seemingly build up slowly (I currently have 2312 storm track predictions from my medium model)

Your choice, if you think it could be helpful:
- Some sort of rendering options or some way to be able to run the app on slower hardware


Basic checks (because im not sure if this is already implemented). If this isn't implemented then implement it:
- Models training simealtaneously should be able to share data. For example if 2 models want access to the same radar's L2 reflectivity for the same amount of time, they should be able to share it instead of making 2 seperate requests. Same applies to satellite data, METARs, and everything else. You can pre-calculate what data needs to be downloaded when training starts and keep track of it to make this happen if needed.

Also:
- See if you can come up with more features to expand on phase 9's VR and mobile app plans, or if you can come up with any other features not related to the VR and mobile apps, you can put those in the phase 9 plan aswell.
