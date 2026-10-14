# Phase 8 hotfix checklist (0.8.1)

As before, everything new was tested only with sample or mocked data. Please check it against live data. If something fails, send a screenshot, the line from Settings → Sources, or the server log line.

**Installing / updating:**
- **Linux:** run `join-appimage.sh` in the folder with the parts, or run `install-latest.sh`.
- **Windows:** run `join-windows.cmd` in the folder with the parts, or run `install-latest.cmd`.
- **No releases needed:** every build is also on the repository's `builds` branch. Installs and updates (app and server) use whichever is newer, a GitHub release or the `builds` branch.

## Part 1 — Fixes and changes from the Phase 8 checklist

### Crashes and performance
- [ ] **Satellite + radar in panes:** use a quad layout with satellite (full disk) in one pane and radar in the others. Play the loop and pan for a few minutes. The app shouldn't freeze or crash, and maps keep loading.
- [ ] **After a crash:** starting again always works, with no need to delete app data.
  - Two failed starts in a row → the next start is in **safe mode** with a banner. "Restore layout" brings your panes back.
  - `--safe-mode` also starts in safe mode.
  - A hung window offers Wait / Reload / Reload in safe mode.
- [ ] **Instability detection with 3 panes:** zooming into it and clicking it no longer freezes the app.
- [ ] **Settings → Performance:**
  - Presets: Auto / Quality / Balanced / Low-end.
  - Settings: render resolution, max FPS, animations, max panes, image size, frame cache, and more.
  - An FPS / memory readout.
  - On your PC, Auto should look the same as before.

### Panes
- [ ] **Crosshair:** with "Center crosshair value" on, every pane shows its own crosshair and value at its centre.
- [ ] **Unlink main:** in the Panes menu, turn "Main map – Pos" off. The main map then moves freely, and linked panes still move together.
- [ ] **Radar sites** show in every radar pane straight away.
- [ ] **Drawing:** with panes open, "All panes" in the Draw bar is on by default. Drawings show in position-linked panes at the same spot.
- [ ] **Clicking in panes:** alerts and model detections can be clicked in every pane, with the same popup.
- [ ] **Detections button:** each pane header has a show/hide button for model detections (while Model detections is on).
- [ ] **New panes** load the product their selector shows, with no need to pick it again.
- [ ] **Pop-out button** sits beside the link buttons and is easy to click.
- [ ] **Dropdown headers** ("Level II · KTLX", "MRMS …") are dark with readable text.
- [ ] **Custom layouts** (Settings → Pane layouts):
  - Dragging in any direction merges whole panes.
  - A click just selects.
  - Touch drags work.
- [ ] **Popover:** the pane popover stays open after you pick a layout. This was not checked last round.

### Detection models
- [ ] **Deleting a running model** removes its legend rows, detections and layers. A leftover "(deleted)" row can be closed with ×.
- [ ] **Duplicates:** a large storm shows at most a few detections per model, even when several radars see it. This covers storm track and instability too.
- [ ] **No pile-up:** leave a storm-track model running for an hour. You should get one track per storm, and the count should stay flat.
- [ ] **Probability and confidence:** popups and the detections list show both, plus what the confidence is based on.
- [ ] **Summaries:** every detection starts with a one-sentence summary (e.g. "It is predicted this storm will intensify from 52 dBZ to 57+ dBZ over the next 30 minutes (62% chance), with a confidence of 81% (high).").
- [ ] **Intensification highlight:** these detections fill the storm outline. Hovering or selecting one brightens it.
- [ ] **Gate by confidence:** the P/C switch on the detections gate filters any model by confidence, storm track included.
- [ ] **Enable all / Stop all** in the Models list follow the Server / This computer filter.
- [ ] **Shared training data:** run two jobs that use the same radars. The log shows shared volumes and "shared data: N requests".
- [ ] **History mode:** "Run on this range" runs on archived data and animates without overlapping areas. Each model shows a History compatible / Live only tag. Not checked last round.
- [ ] **Animations:** detections follow the timeline, forecast models make frames every 1 h, and grid models have a "past runs" layer. Not checked last round.
- [ ] **Storm track model:** a predicted track with a cone, plus speed and strength at +15/30/45/60 min. Not checked last round.

### Layers and UI
- [ ] **Identify:** in Layers, click the locate icon on an active layer, or "Identify on map" in its settings.
  - Rings pulse around items for 5 s. When there are many items, they're grouped with counts and stay visible zoomed out.
  - If none are in view, "Zoom to N" finds them.
  - With Reduce motion on, the rings don't move.
- [ ] **Rail order:**
  - Drag rail buttons (and the separator) to reorder.
  - Right-click for Move up/down and Reset order, or use Alt+↑/↓ on a focused button.
  - The order is kept after a restart.
- [ ] **Stats panels:** drag the right edge, bottom edge or corner to resize; double-click a handle to reset. Stretching the merged panel taller goes from one line, to the dense grid, to the full System / Server process / App view.
- [ ] **Emergency services:** shelters and cooling/warming centres load.
  - When there are none, the layer's settings say why ("FEMA: 0 open shelters now", "OSM: none mapped here"). FEMA open shelters are usually zero outside disasters.
  - A real failure shows an error.

### Cameras, timelapses, radio, notifications
- [ ] **Camera recording:** in a camera viewer, press Rec → "Start (until stopped)" or "Record for…" (a preset or minutes/hours).
  - The button shows elapsed and remaining time. Click it to change the end; ■ stops.
  - Works for snapshot, HLS and YouTube cameras.
- [ ] **Video timelapses:** TL works on HLS and YouTube camera viewers too. It needs ffmpeg, plus yt-dlp for YouTube; without them TL is disabled and the reason is shown.
- [ ] **Timelapse length:** Recordings → Timelapses → "Video every N min/hours/days/weeks" or "One video until <date/time>". The default is still one video per day, with warning chapters.
- [ ] **Daily webcam timelapses** (from Phase 8): one video per day with warning/report chapters. Your note was cut off ("I clicked TL and verified that the …"); please check it again.
- [ ] **Radio scanner:**
  - "Watch all for SAME", with audio muted or on one station.
  - Tick several stations → **Mix** (volume, mute and S = solo per station).
  - "+ Scan" on a state or on Favorites.
  - It still jumps to the station that fires.
- [ ] **Notification templates:** … → Notifications → edit a channel → Message.
  - Edit the title and text with {event}, {headline}, {area}, … and see a live preview. The test message uses it.
  - A rule's "Send to" has its own template, which overrides the channel's.
  - Blank = today's message.

### Updates from the repository
- [ ] **Linux install:** `curl -fsSL https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/install-latest.sh | bash`. It installs from the `builds` branch (there are no releases yet). Press Ctrl+C mid-download, then run it again: it resumes.
- [ ] **Windows install:** `install-latest.cmd` (also with `-Portable`) installs from the `builds` branch.
- [ ] **App update:** Settings → Updates shows "(repository build)" and downloads with % and speed. "Restart to update" replaces the AppImage, or runs the installer or the portable swap on Windows. You can only test this once a newer build than 0.8.1 is published.
- [ ] **Server update:** `./start.sh --update`, `start.ps1 -Update` and the server's Updates page take the `builds` branch when it's newer.

## Part 2 — Still unchecked from Phase 8

- [ ] **Ensemble probabilities** (layer menu → Ensembles): GEFS / ECMWF chance of ≥ X, mean, spread, min/max, threshold picker.
- [ ] **Severe parameters** (layer menu → Severe): STP, SCP, SHIP, CAPE, shear, SRH and more, plus one-click composites.
- [ ] **Forecast confidence:** a high/medium/low line per day, and spread bands on the charts.
- [ ] **Radar → Derived products:** ΔREF / ΔVEL, ZDR columns, QC reflectivity (CC and texture sliders).
- [ ] **Lightning jumps** (Layers → Severe).
- [ ] **Model reports** (Models window → Reports): timeline, CSV/GeoJSON export, Share to Team.
- [ ] **Model ensembles and A/B compare** (Models window).
- [ ] **Chaser toolkit** (… menu): positions, safe-zone guide, route warnings, chase logs.
- [ ] **Earthquakes and tsunamis:** ShakeMap contours and NOAA tsunami messages.

## Part 3 — Still unchecked from earlier

- [ ] YouTube recording.
- [ ] Bandwidth saver, GPS track, camera badges, mPING.
- [ ] Placefiles, debris signatures (TDS).
- [ ] Desktop widgets, route weather.
- [ ] Offline maps, plugins, share live view, Team.

## Your cut-off item
One line in your panes notes ended at "Add a button to". Tell me what the button should do and I'll add it.
