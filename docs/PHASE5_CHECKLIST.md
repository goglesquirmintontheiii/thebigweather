# Phase 5 test checklist

Version 0.5.0. My build machine can't reach the live feeds, so everything new was tested here with sample or mocked data only. That includes synthetic radar volumes, OPERA/CWA sample files and mocked feed responses. Please check against live data on your PC and VPS. If something fails, send a screenshot, the line from Settings → Sources, or the server log line.

Restart the server with the new build (`./start.sh` again). It now offers to install **yt-dlp** as well as ffmpeg.

## Re-test from Phase 4

- [ ] **Himawari:** the three Himawari layers load (IR and Air Mass now use the level NASA actually has).
- [ ] **Server stats panel:** Settings → Sources → "Server stats panel" brings it back. It now stays on screen.
- [ ] **Server RAM:** after 10+ minutes of use, around 3 GB on your PC and around 1 GB on the VPS.
- [ ] **Watch outlines:** click inside a watch (when there is one).
- [ ] **Recordings:** these are still unchecked from Phase 4. Play, Sync, timelapse, record on warnings, export and import.
- [ ] **Files & backup:** export settings, then import them back.
- [ ] **Audio:** alert sound preview and read-aloud.
- [ ] **mPING:** if you get a key.

## Your Phase 4 changes

- [ ] **Hurricanes:** a large spinning cyclone symbol at each storm's current position, coloured by category.
- [ ] **Frames:** no preset buttons. The time length takes minutes, hours or days.
- [ ] **Alert sounds:** with "My points only", tick which points (with an "All points" tick).
- [ ] **Legend value:** with V on or Shift held, hover the legend bar to read the value there. Hovering the map puts a marker on the bar.
- [ ] **Noise filter:** drag the two handles on the legend bar. The map updates while you drag.
  - The wheel over a handle nudges it.
  - `,` / `.` move the low handle while the legend is hovered.
  - `|v|` hides low speeds both ways for velocity.
  - The filter is saved per product.
- [ ] **Panes:**
  - Radar towers show in every pane; click one to pick that radar.
  - Each pane, including the main map, has a product dropdown.
  - The header no longer has the product buttons.
- [ ] **Linked windows:** open a second window (grid button → window icon), then turn on **Link**.
  - Position, timeline, radars and history mode follow.
  - "Sync layers" also syncs overlays.
- [ ] **Forecast:** the sun/cloud button opens a big window with:
  - charts you can toggle, with a hover readout
  - a 48 h table
  - 14 days with NWS text
  - alerts at the point
  - an **Ensembles** tab (plumes) and a **Sounding** button.
- [ ] **Weather radio:**
  - The radio button opens a big window, which can be popped out.
  - **Player** opens a media-player popup with pause, seeking back through everything played so far, Go live and Record.
- [ ] **Search:** "Near" picks one of your points; results are sorted by distance from it.
- [ ] **Multi-radar loops:** Ctrl+click 2–3 radars and play the loop. Each radar now uses its own volume nearest the frame time, so the seams line up and nothing flickers.
- [ ] **Cameras:** one click on a camera opens the viewer.
  - It's bigger and can be resized from the corner.
  - It has an Info section.
  - **● Rec** (15 min–2 h) is in the viewer.
- [ ] **YouTube recording:** works once yt-dlp is on the server. Without it, the Rec button says so.
- [ ] **Screen recording:** the toolbar button next to Screenshot saves a WebM to Downloads/TheBigWeather.
- [ ] **Radar recording:** the ● button in the timeline records the shown radars and product, and stops them again.
- [ ] **Historical mode:** the calendar-clock button (toolbar or timeline).
  - Pick From/To (up to 7 days) and Load. All radars use that range.
  - Warnings, watches, MDs, storm reports and storm cells replay as the loop plays.
  - Live-only layers are hidden. "Live" goes back.
  - Level III switches to Level II for the range.
- [ ] **Traffic:** add a TomTom key (free) in Settings → API keys, then Layers → Traffic. You'll get flow colours, plus incidents from zoom 9.
- [ ] **Rotation (selected radar):** Layers → Severe. Couplets from the current Level II volume are drawn as TVS (red), meso (yellow) or weak. This is my own detector, so expect some false hits; the gear sets a minimum strength.
- [ ] **Rotation scan:** Layers → Severe → Rotation scan shows two buttons under the header, **Tornadic rotation** and **Supercells**.
  - They scan every US radar (NWS storm attributes) and ring the hits.
  - The list flies to each one.
- [ ] **Layer shortcuts:** right-click a layer row, or use the keyboard button in its settings, and press keys. Combos (Ctrl+Shift+T) and two-key sequences (G then R) work. `?` lists all shortcuts.
- [ ] **3D:** the cube button (or Shift+3) on a Level II radar. Right-drag to tilt and rotate. The panel has threshold, density, height scale, resolution and floor. MRMS 3D is in the same panel.
- [ ] **Raspberry Shake:** Layers → Hazards → Raspberry Shake. Click a station for the seismograph window.
  - Views: waveform, spectrogram and helicorder, with filters and nearby quakes.
  - Data is at least 30 min old.

## Missed plan items (now added)

See `docs/PLAN_AUDIT.md` for the full list.

- [ ] **Storm cells:** Layers → Severe → Storm tracks.
  - Motion arrows with 15-min ticks, TVS/meso/hail icons.
  - "Storm table" in its gear.
  - ETAs to your points.
- [ ] **Spaghetti models:** Layers → Tropical, when a storm is active.
- [ ] **Recon center fixes:** Layers → Tropical.
- [ ] **Hazards and environment:**
  - volcanoes
  - HMS fire and smoke
  - drought monitor
  - air quality (AQI)
  - Social Vulnerability Index
  - NOHRSC snow depth
  - HeatRisk
  - Kp (in the Aurora gear)
- [ ] **HRRR smoke:** layer menu → Models → HRRR → Smoke.
- [ ] **More models:** GEFS mean, CMC GDPS, CMC HRDPS and ICON-EU.
- [ ] **Wind particles:** Layers → Surface, choosing the model and level.
- [ ] **Soundings:** right-click the map → "Sounding here" (model).
  - In the window, switch to observed balloon soundings, or show the stations on the map.
  - It has the Skew-T, hodograph and indices.
- [ ] **Cross-section:** toolbar … → Cross-section. Click two points on a Level II radar and drag the ends.
- [ ] **Storm-relative velocity:** the control appears with Level II velocity. Choose Auto, a cell you click, or a manual motion.
- [ ] **Derived Level II products:** Composite Refl., Echo Tops and VIL in the product list.
- [ ] **Loop export:** toolbar … → Export loop, as GIF, WebM or MP4.
- [ ] **Workspaces:** toolbar … → Workspaces. Save, switch, export and import.
- [ ] **Bandwidth saver and Appearance:** in Settings. Appearance covers accent colour, UI scale and panel opacity.
- [ ] **METAR pins:** click a station → Pin. The panel can be dragged and popped out.
- [ ] **GPS track:** toolbar … → GPS track. Record, export GPX, and see the nearest warning and spotters.
- [ ] **Camera badges:** a red dot while recording, and a 360° badge for your own cameras.

## Phase 5: international radar

- [ ] **European radars:** the radar panel shows US / Europe chips once European sites are listed.
  - About 210 single-site radars come from EUMETNET OPERA (20 countries) plus FMI for Finland.
  - They work like NEXRAD: products, tilts, loop, history (24 h), extra radars, 3D, cross-section and rotation.
  - Most countries only publish reflectivity and velocity; the Netherlands and Finland are full dual-pol.
- [ ] **Layer menu → World:**
  - **Europe:** OPERA reflectivity and rain-rate composites, and DWD Germany.
  - **Canada:** GeoMet rain and snow.
  - **Mexico:** SMN, each radar or all at once. Best effort: their site has certificate problems.
  - **Japan:** JMA.
  - **Asia:** Taiwan CWA composite and PAGASA Philippines.
  - Each one animates on the normal timeline.
- [ ] **Not added:**
  - Hong Kong: its licence forbids reuse, and the image has the map burned in.
  - Singapore, Malaysia and India: no usable map bounds.
  - KMA: needs a key, and I couldn't verify its format.
  - UK, Italy and Austria: not in the open OPERA set.
