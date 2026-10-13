# Phase 8 test checklist (0.8.0)

Everything new was tested only with sample or mocked data, because my build machine can't reach the live feeds. Please check against live data. If something fails, send a screenshot, the line from Settings → Sources, or the server log line.

**Installing:**
- **From now on:** releases go on GitHub, and future updates install themselves (Settings → Updates).
- **This version:** use the files I sent.
- **Afterwards:** `install-latest.sh` (Linux) / `install-latest.cmd` (Windows) download the newest release, and `./start.sh --update` / `start.ps1 -Update` update the server.

## Part 1 — Fixes and changes from the Phase 7 checklist

### Radio
- [ ] Decoded SAME alerts, test alerts included, appear on the map **immediately**. The pin button in the SAME bar turns this off.
- [ ] The Fast / Better / Best transcription picker is a proper button group, not a cut-off dropdown.
- [ ] The big player's seek bar shows **audio levels**: bars over everything played, with a live peak meter.

### Historical Storms and stats
- [ ] **Tornadoes tab:** click a track on the map to select it.
- [ ] **Stats panels:** resize with the corner handle; double-click the handle to reset.

### Detection models
- [ ] **Export:** export saves the file and shows where it went. It worked before, but the confirmation was hidden behind the window.
- [ ] **No Run tab:** each model's page has its own run settings, Enable/Stop, **Run now (all radars)**, Test, its detections list and its layers.
- [ ] **Radar choices:** All US / by state / picked on map / radars on screen. The NEXRAD-only and TDWR-only buttons are gone.
- [ ] **History mode:** with history mode on, "Run on this range" runs the model on archived data. Each model shows a **History compatible** or **Live only** tag.
- [ ] **Instability and flood risk:** show as a weather layer, highlighted areas, or both.
- [ ] **Training resources:** CPU threads, RAM, downloads and disk I/O, with Auto/Light/Balanced/Max presets. Jobs show live CPU/RAM/network use.
- [ ] **Animations:** detections follow the timeline. Forecast models make frames every 1 h by default (adjustable), and grid models have a "past runs" layer.
- [ ] **Presets:**
  - One card per model type, with **Quick / Medium / Thorough / Intensive** buttons.
  - Every type has all four. Intensive uses the most data, sources and resolution.
- [ ] **Intensity switcher** on a model's page when you've trained it at several intensities.
- [ ] **Max training jobs:** App and Server inputs at the top of Train (1–8, default 2). Lowering it pauses the newest jobs.
- [ ] **Models list:**
  - sizes on disk
  - a Server / This computer / Both filter
  - models in training are listed greyed out with progress
  - **Move to…** (server ↔ this computer)
- [ ] **Per-model gates:** the detections legend expands into one gate per model.
- [ ] **Stopping a model** hides its detections.
- [ ] **Storm track model (new):** predicted track with a cone, plus speed and strength at +15/30/45/60 min.
- [ ] **Jobs:** **Retry** on failed jobs; resume works in place.
- [ ] **Resuming after a restart:** jobs interrupted by closing the app or stopping the server resume automatically. Downloaded training data (storm reports included) is kept until the job finishes.
- [ ] **Outside the US:** grid models (flood, precipitation, temperature, instability, tropical, storms) can run anywhere. US-only inputs drop out, and the model shows "lower confidence".

### Panes
- [ ] **Pop-out:** pop a pane out into its own window (map and product selector only).
- [ ] **Pane window:** a "Pane window" button opens a new pane-only window, linked to the main map.
- [ ] **Custom layouts:** Settings → Pane layouts has a grid editor with merged cells, up to 6 maps.
- [ ] **Icons:** proper layout icons, including "three", plus a panes icon on the toolbar.
- [ ] **Popover:** the pane popover stays open after you pick a layout.
- [ ] **Swipe:** vertical, horizontal or diagonal (rotate handle). Both product selectors follow their side; the selector bug is fixed.
- [ ] **Per-pane linking:** choose Position / Time / Layers for each pane and each window.

### Other
- [ ] **Seismic events layer** (Seismographs window → events bar, or Layers → Hazards):
  - Events detected on your **starred** stations (up to 20), matched to USGS quakes where possible.
  - Settings: minimum level, stations, period.
  - Click an event to compare those stations at that time.
- [ ] **Radar recording:** starts with the current volume and keeps recording new ones, also from the real-time feed.
- [ ] **Briefing audio:** speaks even when the system has no voices, using a built-in offline voice. Settings: engine, voice, rate, and a "Test voice" button. Read-aloud uses the same voice.
- [ ] **Built-in server:** runs next to a dedicated server; it picks a free port and uses its own data folder. If it fails, the reason is shown.
- [ ] **yt-dlp:** now kept in `server/bin` and compared with the latest release, so it no longer shows "outdated" again after updating.
- [ ] **CPU display:** server CPU is now 0–100 % of the whole machine; the per-core value is in the tooltip.
- [ ] **Level II "403 Forbidden" warnings:** NOAA moved Level II to the `unidata-nexrad-level2` bucket, which is now used first. A bucket that returns 403 is skipped for an hour.
- [ ] **Updates:** Settings → Updates checks GitHub, downloads in the background and asks to restart.

## Part 2 — Phase 8

### Forecast data
- [ ] **Ensemble probabilities** (layer menu → Ensembles):
  - GEFS (31 members) and ECMWF (51): chance of ≥ X rain/snow (6–72 h), wind, gusts (ECMWF) and temperature.
  - Also mean, spread, min and max.
  - Pick the threshold above the legend.
- [ ] **Severe parameters** (layer menu → Severe):
  - **From HRRR/RAP:** STP, SCP, SHIP, CAPE types, CIN, LCL, shear, SRH, lapse rates, DCAPE, PWAT and theta-e.
  - **One-click composites:** e.g. STP + SRH contours.
- [ ] **Forecast confidence:**
  - A high/medium/low line per day in the Forecast tab.
  - Model spread bands on the charts.

### Radar and detection
- [ ] **Radar panel → Derived products:**
  - **ΔREF / ΔVEL:** change since the previous volume.
  - **ZDR columns:** depth above the freezing level.
  - **QC reflectivity:** non-weather echoes removed, with a CC slider and a texture slider.
  - **Bio/clutter mask.**
  - **Beam-blockage map** for the current radar.
- [ ] **Lightning jumps** (Layers → Severe): GLM flash-rate jumps per storm.
- [ ] **Model reports:** detections that last 3 cycles become reports.
  - Models window → Reports: a timeline, CSV/GeoJSON export and Share to Team.
- [ ] **Ensembles and A/B compare** (Models window):
  - Combine models (mean/max/vote/weighted).
  - Compare 2+ models on the same past events, with scorecards and a per-event table.

### Situational awareness
- [ ] **Dashboard** (rail):
  - One tab per saved point: conditions, alerts, nearby storms with ETA, radar thumbnail, 12 h chart, AQI/pollen.
  - Save, copy or print a summary card.
- [ ] **Alert timeline** (rail): warnings, watches, MDs, reports and model reports in lanes for an area. Click an item → Replay.
- [ ] **Chaser toolkit** (… menu):
  - Positions for you and your team, with storm-relative motion.
  - A safe-zone guide around a chosen storm.
  - Warnings and closures along your route.
  - Auto-saved chase logs (GPS, snapshots, photos) with zip export.
- [ ] **Emergency services** (Layers): FEMA open shelters, hospitals, and cooling/warming centres (OpenStreetMap, from zoom 6).
- [ ] **Earthquakes and tsunamis:**
  - USGS ShakeMap intensity contours, linked to the Seismographs window.
  - NOAA tsunami messages and areas.

### Data and media
- [ ] **Satellite:**
  - GOES fire detections.
  - Overshooting tops and cloud-top cooling.
  - Fog / low cloud layer (layer menu → Satellite).
- [ ] **Daily webcam timelapses:**
  - Turn on "TL" in a snapshot camera's viewer, or use Recordings → Timelapses.
  - You get one video per day, with warning and report tags as chapters.
- [ ] **Radio scanner** (Weather radio window → Scanner):
  - The server listens to all your scanner stations at once for SAME (needs ffmpeg). The app cycles or holds the audio and jumps to a station when its alert tone or header arrives.
  - "Keep on server" leaves monitoring running 24/7.
  - Without ffmpeg, the app decodes up to 4 stations itself.
- [ ] **Data export** (… menu, or a layer's settings):
  - Overlays → CSV / GeoJSON / KML.
  - Grid frames → CSV / GeoJSON / NetCDF.
  - Radar sweeps → NetCDF.
  - Charts → PNG/SVG.

### App and platform
- [ ] **Notification channels** (… menu → Notifications): ntfy, Pushover, email (SMTP), Discord, Telegram and webhooks, each with a test button and quiet hours.
- [ ] **Server-side rules:** set a rule to run on the Server or Both, so it works with the app closed.
  - The rule uses the saved point's position.
  - New conditions: SAME alerts from the scanner, and weather station (PWS) values.
  - A log of what fired.
- [ ] **Command palette** (Ctrl+K): search layers, menus, settings, places, radars, saved points, workspaces and commands.
- [ ] **Accessibility** (Settings → Accessibility; all off by default):
  - colour-vision-safe colours
  - text size and high contrast
  - reduced motion
  - keyboard navigation and screen-reader labels

## Part 3 — Still unchecked from earlier

- [ ] Read-aloud of new warnings, and YouTube recording.
- [ ] Bandwidth saver, GPS track, camera badges, mPING.
- [ ] Placefiles, debris signatures (TDS), Dealias, Inspector.
- [ ] Desktop widgets, route weather, notification rules (app side).
- [ ] Offline maps, plugins, share live view, Team.
