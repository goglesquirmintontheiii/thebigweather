# Phase 7 test checklist (0.7.0)

Everything new was tested only with sample or mocked data, because my build machine can't reach the live feeds. Please check against live data. If something fails, send a screenshot, the line from Settings → Sources, or the server log line.

Update the server (`./start.sh` on Linux, `start.cmd` on Windows) and the app.

## Part 1 — Fixes from the Phase 6 checklist

- [ ] **Himawari:** shows without pressing Play. If NASA hasn't published the newest time yet, the app steps back to the newest time that has images.
- [ ] **Hurricane icon:** spins smoothly (30 fps) without moving the map.
- [ ] **Wind particles:** line width now goes down to 0.5 px.
- [ ] **3D on a laptop:** 3D no longer snaps back flat. A settings save used to reset the tilt, which is why you couldn't change the viewing angle.
- [ ] **Seismograph spectrograms:** no more stuck "Loading… 100%". Empty windows say "No data in this window".
- [ ] **SAME map outline:** each log entry's "Map" becomes "× Hide on map".
  - Tests clear after 60 s.
  - Real messages clear when they expire.
  - Clearing the log removes them all.
- [ ] **Transcription:**
  - New **Best** option (Whisper small, about 250 MB download).
  - Longer chunks, voice filtering and level control.
  - A weather vocabulary hint, which includes county names from recent SAME headers.
- [ ] **Historical Storms → Tornadoes tab (new):**
  - Search SPC tornadoes by years/dates, states, rating, injuries/deaths and area.
  - Selecting one draws its track. "Open in history" works for 1991 and later, when Level II radar starts.
  - The old "Tornado history" layer is gone from Layers.
- [ ] **Replay this:** opens a small window slider before replaying the alert.
- [ ] **Stats panel:** the merged panel is about a third of its old height. A mini mode (one line) is in the panel header.
- [ ] **Space weather:** has its own sun button on the left rail. The Aurora gear still links to it.
- [ ] **Canada radars:**
  - **What's open:** I checked again, and ECCC doesn't publish single-site radar data openly. Full volume scans are sold (cost-recovered data, about $1,600–2,000 a month). The only open per-radar data is each station's GIF images, which have no published map position.
  - **Station viewer:** when you pick a single Canadian radar, a small viewer now loops that station's own images, the last 2 hours. The map still shows the composite crop.
  - **The websites you found** almost certainly show those same GIFs. Send me a link if one of them shows something different.

## Part 2 — Phase 7

### Detection models (new rail button with a brain icon)
- [ ] **Train → Quick:** pick a preset, name it, choose Server or This computer, then Start. Presets:
  - Tornado (quick or thorough)
  - Supercell
  - Large hail, significant hail
  - Damaging wind
  - Debris
  - Tropical genesis
  - Wildfire
  - Flash flood
- [ ] **Training data:** the job downloads historical Level II volumes around past events and extracts storm-cell features. Labels come from SPC reports, IEM storm reports and HURDAT2/HMS. "Tornado quick" is about 500 volumes, roughly 20–40 min on a good connection.
- [ ] **Train → Custom:**
  - target and label sources
  - years and region (states, or a box on the map)
  - filters, event count and negative ratio
  - match radius and time window
  - data sources (radar products, MRMS, METARs, GFS)
  - features, algorithm and its settings
  - cross-validation, and an optional time limit
- [ ] **Jobs:** progress, counts, ETA and a live log.
  - **Stop early** keeps the best model so far.
  - **Cancel** and **Resume** (for interrupted or failed jobs).
- [ ] **Models:**
  - rename, labels, notes and delete
  - a threshold slider with live POD/FAR/CSI
  - charts and feature importance
  - export (`.tbwmodel`) and import
  - copy between this computer and the server
- [ ] **Run:**
  - Choose models and radars: All, NEXRAD, TDWR, by state, picked on the map, or the current radar plus extras.
  - A status per radar.
  - A detections list; click one to fly there.
  - "Test on <site>" runs once on the current radar.
- [ ] **Map:** detections show with an icon per type, a probability ring, a cell box and a motion arrow. High-probability ones pulse. The popup lists the top contributing features.
- [ ] **Rules:** a new condition, "Detection model hit nearby", in Notification rules.

### More model types (added after your request)
- [ ] **Storm intensification:** flags storms likely to grow (VIL / reflectivity jump) within a set lead (default 30 min). Learned from how tracked cells actually changed in past radar loops, optionally plus storm reports.
- [ ] **Instability:** a probability map of where strong storms (reports or ≥ 50 dBZ) are likely in the next few hours.
- [ ] **Temperature / precipitation / storm forecasts:** when run, they become weather layers (layer menu → My models). Forecast leads play on the timeline.
  - Temperature is checked against URMA/RTMA analyses.
  - Precipitation is checked against MRMS QPE.
  - Storms: probability of ≥ 40 dBZ or lightning, or maximum dBZ.
  - The thorough temperature preset adds P10/P90 range layers.
- [ ] **Tropical development:** chance of a tropical cyclone forming within 2, 5 or 7 days. Shown as a map plus outlined areas with %.
- [ ] **Outlooks:** SPC-style categories (TSTM → HIGH) for any severe, tornado, wind or hail.
  - Presets for Day 1, Day 2, Day 3 and Day 4–7, or a custom date range.
  - Show it with Run → "Show outlook". The map card switches day and hazard.
- [ ] **Flood:** areas likely to flood in the next hours, from current rainfall (MRMS QPE, FLASH), soil moisture and forecast rain.
- [ ] **More training data:**
  - **Satellite (GOES):** IR cloud-top temperature, cold-cloud fraction, cloud-top cooling, water vapour bands, visible.
  - **Lightning (GLM):** flash rates and lightning jumps.
  - **Analyses:** HRRR analysis fields, and GFS/HRRR forecast fields over the target window.
  - **More fields:** many more MRMS fields, METAR tendencies, Drought Monitor.
  - "Use every source" in the Custom form turns them all on.
- [ ] **Probability gate:** a two-handle bar (bottom-right) for model detections and outlooks.
  - Cut off low and/or high confidence; the map updates as you drag.
  - Scrub mode sweeps a fixed window through the probabilities, and ▶ sweeps it automatically.
  - Prediction weather layers use the normal legend gate.
- [ ] **Run options per model:**
  - threshold, min/max probability or value, persistence
  - cell filters, region (states or a box), leads
  - valid period / day, grid resolution, smoothing
  - ensemble, cadence, max detections, notify
  - outlook category levels
  - plus how many radars to run at once
- [ ] **Retrain / Train further** (model detail):
  - Retrain rebuilds the training data from the model's settings (which you can change) and trains from scratch.
  - Train further adds trees or epochs on more data.
  - Either one can replace the model (new version) or save a new one.
  - Works after restarts and for imported models. A Versions table shows each version's scores.

### Other Phase 7 items
- [ ] **Power outages (Layers → Hazards):**
  - Counties coloured by % of customers out, plus outage points.
  - Utilities covered: 35 KUBRA utilities (AEP, Ameren, ComEd, Dominion, DTE, FirstEnergy, Georgia/Alabama Power, Oncor, PECO, PSE&G and more), Duke Energy and Hydro-Québec.
  - The gear shows each utility's status.
  - Not covered: FPL, Entergy, Xcel, PG&E, SCE and others (no verified keyless feed).
- [ ] **3D on a laptop:**
  - **On-screen control:** tilt, rotate, zoom, orbit pad and reset.
  - **Keys:** W/S tilt, A/D rotate, Shift+arrows, PageUp/PageDown.
  - **Mouse/touchpad:** Shift+drag or Alt+drag orbits, and **Orbit drag** makes a plain drag orbit.
  - **Auto-rotate.**
- [ ] **Radio:** the small player has **Expand**, which opens the big player without stopping the audio.
  - The big player has **Compact**, which shrinks it to a small bar. SAME and transcription keep running.
  - The size is remembered per station.

## Part 3 — Not checked yet from Phase 6 and earlier

- [ ] METARs in history mode.
- [ ] Watch outlines.
- [ ] **Recordings:** radar and camera recording, timelapse, record on warnings, export and import, plus radar recording from the timeline.
- [ ] Read-aloud and YouTube recording.
- [ ] Bandwidth saver, GPS track, camera badges and mPING.
- [ ] Placefiles, debris signatures (TDS), Dealias, Inspector and Damage surveys.
- [ ] Desktop widgets, route weather, notification rules, briefing and kiosk mode.
- [ ] Offline maps, plugins, share live view and Team.
- [ ] The built-in server (Settings → Desktop).
