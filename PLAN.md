# TheBigWeather — Plan

## Ground rules from the user
- UI text should be kept short, uncluttered.
- UI inspired by **RadarOmega**, with features from **RadarScope**.
- More features = better, but must run well on the user's PC (96GB DDR5, Ryzen 9850X3D, NVMe) **and** on a 4-vCore / 16GB VPS (reduced functionality OK on low end). Use high-end hardware well, but don't continuously max it out.
- Android app and VR app (Phase 9) are **planned only** — do NOT build until the user asks.

## Stack (agreed)
| Part | Choice | Why |
|---|---|---|
| Server | **Rust** (tokio + axum) | Fast decode/render, low RAM, single binary; runs on 4-vCore VPS |
| Desktop UI | **TypeScript + MapLibre GL + custom WebGL2 layers** | GPU radar rendering, instant colormap changes |
| Desktop shell | **Electron → `.AppImage`** (user approved) | Chromium WebGL more reliable on Linux than WebKitGTK; true OS windows for multi-monitor |
| Android (later) | Capacitor wrapping same UI with mobile layout | Shared code |
| Storage | SQLite (WAL) + NVMe file cache with size limits | No DB server |

## Core architecture
- **Server sends data, not pictures.** Server decodes radar/model/MRMS/satellite into compact quantized binary (zstd). Client colors it on the GPU (RadarScope style) → instant custom colormaps, exact crosshair readouts, smoothing toggle, small transfers.
- **Hardware profiles** auto-detected at startup:
  - **Full** (PC): continuous ingest of chosen radars, all model hours, live chunk streaming, deep cache. Worker threads capped ~60% of cores by default (adjustable).
  - **Lite** (VPS): on-demand fetching, fewer model hours, smaller cache, live chunks for 1–2 radars.
- **WebSocket push** for new sweeps, alerts, chunks, server stats — no client polling.
- **`start.sh`**: installs deps, builds/downloads binary, creates config, picks profile, step-by-step console output, then runs. Optional systemd service install.
- **Connection/auth:** VPS has a domain → public HTTPS via **Caddy** (auto Let's Encrypt cert, set up by `start.sh`). Apps authenticate with a token (paste or QR pairing). Apps can save multiple servers (VPS, home PC) and switch between them.
- **Storage defaults:** radar cache auto-sizes to free disk with low-disk warning. Recordings never auto-deleted. VPS has no bandwidth cap. User records sparingly.
- **Source health + fallbacks:** status light per source, retries, backup sources.
- **Hot-updatable source definitions:** camera lists/simple feed URLs live in config files, fixable without rebuild.
- **Auto-update** for AppImage and server.
- **Offline basemap regions** (for chasing with poor signal).
- **Settings export/sync** between desktop and Android.
- **Colorblind-safe palettes**, units, timezone (UTC/local).
- **Attribution/licensing page.**
- **API-key settings page.** Missing keys just disable that source.
- Build-environment note: Claude's cloud workspace can't reach NOAA/DWD etc. Live data is first tested on the user's machine; each phase ships with a quick test checklist.

## Basemaps (one at a time)
Terrain, Satellite, Dark, Light, Road network, Dark roadmap, Google satellite.
- Google satellite: Google ToS forbids direct tile scraping → support via **Google Map Tiles API (key)**; Esri World Imagery / NASA imagery as keyless alternatives.

## Weather layers (one visible at a time)
- **NEXRAD Level II** — AWS public S3 for history; chunks bucket for **RapidSweep-style** live sweeps.
- **NEXRAD Level III** — NWS public sources.
- **TDWR** (45 FAA Terminal Doppler radars) — first-class radars. 150 m Doppler gate resolution; 1-min updates for some products in hazardous mode. Level II + Level III via NWS/NCEI/tgftp.
- **MRMS** (AWS): reflectivity, winter weather, 1/2/4/24h/current hail, 2/24h rotation, 30min/1h lightning prob, severe hail prob, VIL, 1/6/24/48/72h precip accumulation.
- **Models:** HRRR, RRFS (verify operational status), NAM 3km/12km, RAP, GFS, ECMWF open data, GEFS, CMC/RDPS/HRDPS, ICON, NBM, **HAFS-A/B** (HWRF & HMON are retired — HAFS replaces them). Ensembles: GEFS, ECMWF ENS, HREF, SREF.
- **METAR-interpolated** layers (temp, wind, etc.).
- **Satellite:** GOES-19, GOES-18, Himawari-9 (regional/sub-regional/full disk; GeoColor-style, all ABI bands, SWIR, WV, LWIR), GLM lightning. Plus **Meteosat (MTG/MSG** incl. MTG lightning imager; EUMETView WMS keyless for imagery, EUMETSAT account for raw), **GK-2A**, **VIIRS/MODIS** polar passes incl. VIIRS Day/Night Band (NASA GIBS, keyless), **GPM IMERG**, **ASCAT** ocean winds, **NOAA HMS** fire/smoke.
- **NDFD** (AWS), **Air quality** (AirNow public data files keyless + Open-Meteo AQ keyless; AirNow API optional), **NWS HeatRisk**.
- **International radar:**
  - Full single-site volumes (done): ~210 European radars from **EUMETNET OPERA** open data (24 h) plus **FMI** Finland.
  - Canada: per-radar views cropped from the ECCC national composite (ECCC publishes no open single-site volumes); GeoMet rain/snow composites.
  - Composites (done): OPERA Europe, DWD Germany, Mexico (SMN), Japan (JMA), Taiwan (CWA), Philippines (PAGASA).
  - Global fallback: NOAA satellite-derived rain rate (RRQPE, 60S–70N). RainViewer free API is too restricted now (zoom 7 max, one color scheme since Jan 2026) — don't rely on it. LibreWXR (github.com/JoshuaKimsey/LibreWXR) is a useful reference for source regions.
- **US niche/university radars** (where public; some image-only): MZZU (Univ. of Missouri X-band), Valparaiso Univ. C-band dual-pol (Indiana), Purdue XTRRA (Indiana, public images), Georgia Gwinnett/GT/UGA X-band. To check: UAH ARMOR, CSU-CHILL, OU research radars, CASA DFW X-band network, NASA NPOL/KWAJ. "WLX" unidentified — ask user. FAA ASR and TV station radars are not public.

## Overlays (multiple at once)
- Weather alerts; custom points (home, work, etc.)
- Mesoscale Discussions; SPC outlooks
- Tropical: tracks, outlooks, winds, hurricane hunters, spaghetti models
- Hydrological, fire weather, winter weather, climatological (CPC) outlooks
- METARs; marine (tide points, NDBC buoys + **NOAA BuoyCAMs**)
- Surface fronts; LSRs; **mPING** (see licensing note below)
- Lightning (GOES GLM, Blitzortung)
- Spotter Network (account); storm chasers (click for video)
- Power outages (best-effort public sources); Cycloneport stations
- Rotation highlights
- **Traffic cameras** (see Cameras section), Hazcams
- NWS offices; NOAA Weather Radio transmitters
- GeoJSON/JSON/KML/KMZ user files
- Aviation: flights (adsb.lol / airplanes.live keyless ADS-B), center fixes, flight paths, recon missions, PIREPs, airports, TAFs, SIGMETs (aviationweather.gov)
- YouTube feeds (user places icon + URL)
- Raspberry Shake nodes; volcanic activity + VAAC ash advisories
- Draggable server hardware stats (CPU, RAM used/free, disk used/free, net up/down)
- CDC/ATSDR Social Vulnerability Index (NWS GIS)
- **ISS:** position computed client-side from CelesTrak TLE (SGP4), ground track, visibility footprint, next visible pass over saved points; click → NASA live ISS stream in draggable/pop-out panel (stream may show blue screen during LOS). Bonus toggles: Tiangong, Hubble, weather satellites.
- **Waffle House Index:** locations from OpenStreetMap (brand-tagged). Status (green open / yellow limited / red closed) from Waffle House's store locator **only if toggle enabled — toggle OFF by default**. Light polling, more often near hurricane/tornado watches. Cluster "% closed" summary. Falls back to locations-only if blocked. (Public fan trackers received cease-and-desist letters over trademark; this is a private personal app.)
- **Ships layer (new):** AIS via aisstream.io (free key, global; strongest near coasts; stale tag far offshore). Keyless regional: Norway Kystverket open AIS, Finland Digitraffic (Baltic). **Cruise ship webcams** (e.g. Viking 360°/220° bridge cams) mapped to live ship positions; click ship → cam (360° in draggable panorama viewer). User can add ships/cam URLs. Optional general ship traffic filter by type.
- Extra data: Iowa Environmental Mesonet (archives for case-study mode), mesonets (Oklahoma, West TX, NY State, Kentucky; Synoptic optional), SWPC space weather (aurora oval, Kp), NOHRSC snow, wind profilers, upper-air soundings, SST & ocean currents, NIFC fire perimeters, NASA FIRMS hotspots, USGS gauges & earthquakes, NOAA tides, drought monitor, HRRR smoke, wind particle animation.

## Cameras
- **US:** ingest directly from state DOT/511 sources (Caltrans, TxDOT, 511NY, FDOT, GDOT, TDOT, KYTC, ALGO, MDOT, etc.), expand state by state.
- **International:** Canada (511 Ontario, DriveBC, Québec 511, 511 Alberta, others), UK/Ireland (Traffic Scotland, Traffic Wales, TII, England motorways), Nordics (Finland Digitraffic, Norway Statens vegvesen, Sweden Trafikverket key, Iceland), Asia-Pacific (Hong Kong, Singapore, Taiwan, NZTA, Australia NSW key / QLD / others), Europe to check (Spain DGT, France, Italy, Germany, Netherlands, Switzerland, Czechia, Poland), South Korea ITS (key), Japan (patchy), parts of LatAm. One adapter per source. Include mountain-pass/weather/ski cams.
- **TrafficVision.live:** their ToS forbids scrapers/bots and bulk DB extraction without permission; they offer API/licensing by contact. Implement as **optional source with key field**, with required attribution. Not scraped.
- **Camera icons by type** (shape, not just color): video stream = play triangle; YouTube = YouTube-style rounded rect; snapshot = still camera; 360°/panoramic = circle-arrow badge. Offline = greyed; recording = red dot.
- **Camera recording** (server-side): video streams saved without re-encoding (ffmpeg copy); snapshot cams saved per refresh → playback/timelapse MP4. Concurrency limited by hardware profile. Scheduled recording; **record-on-alert** (cams inside new warning polygons). Shared library with radar recordings; synced playback against radar. Disclaimer under every feed: recording/redistributing some feeds may require owner permission. YouTube recording via yt-dlp on the server (added at the user's request in 0.5; check stream owners' terms).

## Bottom toolbar
Play/pause radar animation · locate me (pinpoint + zoom) · screenshot · distance/bearing from selected radar to screen center · center crosshair showing current layer value · measure tool · show/hide radar sites · drawing mode.

## Drawing mode
Shapes · undo/redo · brush size · brush color · clear all · optional persist after exit (anchored to map coords, stays on pan/zoom) with an X at top-right of each persisted drawing to delete.

## Sidebar extra menus
- **Weather radio** — NOAA Weather Radio streams; user-added stream URLs (Broadcastify has no open API), preload public ones.
- **Custom files manager** — KML/KMZ/GeoJSON.
- **Forecast** — 24h and 7-day (temps, rain chance, wind, etc.).
- **Overpass search** — small collapsible menu.
- **Import/Export** — export single recordings or all as one `.zip` (radar, camera, other weather data); import into any server.

## Notable features
- Extreme customizability (colormap editor w/ `.pal` import, themes, keybinds, per-layer opacity/smoothing, alert sound rules)
- Dual/quad pane (synced or independent pan/zoom/time)
- Custom colormaps
- Niche/educational radars
- Radar history via public S3
- Draggable camera/METAR panels that pop out to other monitors; correct mixed-DPI scaling
- Optional audio alerts (new alerts / new sweeps)
- Record up to 4 products of one radar simultaneously; recordings library + playback

### Added features
- **Radar analysis:** storm cell tracking with motion arrows + ETAs to saved points; Level III hail/TVS/meso attribute table; vertical cross-sections; 3D volume view; storm-relative & dealiased velocity; derived products from Level II (echo tops, VIL, composite); hail swath accumulation.
- **Alerts:** notify only when a saved point is inside a polygon; Tornado Emergency/PDS highlighting; full alert text panel; desktop notifications (Android push later).
- **Forecast tools:** click for model sounding (Skew-T + hodograph) or meteogram; observed soundings; ensemble plumes; wind particle layer.
- **Map/playback:** one global synced timeline; adjustable loop speed + last-frame dwell; range rings; **case study mode** (replay past events w/ radar, warnings, reports synced); export loops as GIF/MP4.
- **Workflow:** saved workspaces (e.g. "chase day", "winter"); full hotkeys; data source health panel; bandwidth-saver mode.
- **Extra overlays:** wildfire perimeters/hotspots, river gauges/floods, drought monitor, HRRR smoke, earthquakes, GPS track recording + distance to nearby chasers.

## API keys (all free; optional)
Synoptic, AirNow, aisstream.io, mPING, Spotter Network, EUMETSAT, KMA, Trafikverket, NSW road agency, Google Map Tiles (optional), TrafficVision (if granted).

**Keyless alternatives:**
| Keyed | Keyless alternative |
|---|---|
| Synoptic | NWS API station obs + Iowa Environmental Mesonet |
| AirNow API | AirNow public data files (files.airnowtech.org) + Open-Meteo AQ |
| aisstream.io | Regional only: Norway Kystverket, Finland Digitraffic |
| EUMETSAT | EUMETView WMS (imagery, no registration) |
| Google satellite | Esri / NASA imagery |
| KMA, Trafikverket, Spotter Network | None good — keys/accounts free |

**mPING licensing:** research license excludes the most recent 48h; real-time requires commercial license; general-user license allows viewing last 4h on mPING's own site only (no collecting/redistributing). Default: mPING button opens their official live map in a panel. User may apply for access.

## Build phases
1. **Foundation:** server, `start.sh`, HTTPS (Caddy), Electron shell, basemaps, NEXRAD L2/L3 + TDWR with RapidSweep and history, alerts, bottom toolbar, settings + API-key page.
2. **Gridded data:** MRMS, satellite, METAR interpolation, NDFD, models.
3. **Overlays:** SPC/WPC/NHC/CPC, METARs, marine, LSRs, lightning, aviation, cameras, ships, ISS, Waffle House, file imports.
4. **Power features:** multi-pane, drawing, recording (radar + cameras), import/export, pop-out windows, audio alerts, Overpass search, forecast menu, radio menu.
5. **International & niche radars.**
6. **New features + Windows** (see "Phase 6 plan" below): a feature-development phase, plus a Windows app (.exe installer) and Windows support for the server.
7. **Detection models + extras** (see "Phase 7 plan"): severe-weather detection models you train and run yourself, power outages, laptop-friendly 3D, radio player size switch.
8. **Feature phase** (see "Phase 8 plan").
9. **Android + VR** — only when the user asks (see "Phase 9 plan").
10. **Publication** — accounts, permissions, tiers, licensing, security review and multi-server connections (see "Phase 10 plan").

Each phase ends with a working AppImage + server and a test checklist (from Phase 6 also a Windows .exe).

## Phase 6 plan — new features + Windows

Ideas drawn from RadarScope, RadarOmega, The Weather Channel, WeatherWise, MyRadar, Windy, GRLevelX, Rainmeter and similar tools. Grouped by area; all keyless unless marked.

**Radar and severe weather**
- **GRLevelX placefile support:** load placefiles by URL or file (icons, lines, polygons, text, refresh), as used by chasers and many services.
- **Tornado debris signature (TDS) detection:** CC drop + low ZDR + strong rotation at low tilts, highlighted and listed.
- **Hail detection from dual-pol:** hail size discrimination (HSDA-style) and MESH-like estimates from Level II, with hail swath accumulation over a loop.
- **Rotation tracks from Level II:** accumulate the rotation detector over time into tracks, like MRMS rotation tracks but per radar and higher resolution.
- **Velocity dealiasing for display:** cleaner velocity and SRV.
- **"Inspector" readout:** every product's value at the cursor at once (REF, VEL, ZDR, CC, KDP, SW), RadarScope-style.
- **Radar nowcast:** extrapolate the last loop 0–60 min ahead with optical flow, marked "forecast".
- **NWS Damage Assessment Toolkit:** surveyed tornado tracks and damage points (public ArcGIS), plus the SPC historical tornado track database.
- **Lightning proximity alarms:** for saved points and GPS (GOES GLM), with "last strike" distance and time.

**Forecast and data**
- **Gridded contours:** isobars, isotherms, heights and thickness, and wind barbs drawn as vector layers with labels on top of any model field.
- **Model comparison:** a point meteogram across all models at once, plus a swipe/compare slider between two weather layers on the map.
- **Marine:** waves (GFS-Wave / WW3), ocean currents (RTOFS), SST anomalies, rip-current and surf forecasts (NWS).
- **Hurricanes:** NHC wind-speed probabilities, peak storm surge and inundation maps, arrival-of-winds times.
- **Flooding:** MRMS FLASH (CREST unit streamflow), NWM high-flow and rapid-onset flooding, USGS flood-inundation maps.
- **Winter:** road-condition reports from state 511 feeds, snow-to-liquid ratios, frost/freeze and wind-chill grids.
- **Climate:** daily records and normals, departures, and climate summaries for saved points (NOAA ACIS).
- **Health and outdoors:** pollen (Open-Meteo, Europe), UV, wildfire smoke forecast, stargazing (cloud, seeing, moon).
- **Personal weather stations:** CWOP/APRS weather stations (keyless via public feeds) as a dense observation layer.
- **Space weather:** SDO/SOHO solar imagery, CME arrivals, and the auroral oval forecast timeline.

**Workflow and app**
- **Desktop widgets (Rainmeter-style):** small always-on-top windows — mini radar, current conditions, alert ticker, countdown to storm arrival — plus a tray icon with alerts.
- **Route weather:** plan a drive (OSRM routing, keyless); radar, alerts and forecast along the route with ETAs, plus storm-intercept suggestions for chasers.
- **Rules engine for notifications:** for example "TOR polygon within 10 mi of GPS", "rotation score > X near home", "lightning within 5 mi", or "AQI > 150", each with its own sound, desktop, TTS or webhook action.
- **Audio briefings:** a spoken summary of alerts, nowcast and forecast for a point, on demand or scheduled.
- **Share links:** the server hosts a read-only live view of a workspace (radar, warnings, drawings) for friends or family.
- **Live collaboration:** shared drawings, positions and notes between users of one server, for chase teams.
- **Wall / kiosk mode:** full-screen auto-cycling layouts for a second monitor or TV.
- **Visual polish (WeatherWise-style):** smoother radar shading options, glow and 3D terrain hillshade, animated precipitation-type textures, and a light theme.
- **Offline basemap regions:** download vector tiles for chosen areas.
- **Plugin/script API:** user JavaScript that adds layers, data sources or panels.

**Windows**
- **Windows app:** an Electron NSIS installer (.exe) plus a portable .exe, with auto-start option, tray icon, file associations (.pal, placefiles, Level II files) and correct mixed-DPI scaling.
- **Windows server:** build tbw-server for x86_64-pc-windows-msvc. Windows paths, config and data folders under %ProgramData%/TheBigWeather, a `start.ps1` equivalent of `start.sh` (prebuilt binary, optional ffmpeg and yt-dlp via winget, firewall rule, optional Windows service), and HTTPS via Caddy for Windows.
- **Bundled local server:** the Windows and Linux apps can run a bundled server themselves for one-computer setups, so there is no separate install.

## Phase 7 plan — detection models + extras (done in 0.7.0)

- **Detection models menu:**
  - Create, train, manage and run your own models for tornadoes, supercells, hail, damaging wind, debris, flash floods, tropical genesis / possible formation, and wildfires.
  - Training uses historical NEXRAD Level II, MRMS, METARs and GFS analyses, with labels from SPC reports, IEM storm reports and warnings, HURDAT2/IBTrACS and NOAA HMS fires.
  - One-click presets plus a fully custom form.
  - Training runs on the server or on this computer, has no time limit unless set, and can be stopped early.
  - Models run on one, several or all US radars (TDWRs included). Detections are drawn with icons, probability rings and cell boxes.
  - Models can be exported and imported.
- **More model types:** storm intensification, instability, temperature/precipitation/storm forecasts (served as weather layers), tropical development, SPC-style outlooks (Day 1/2/3/4–7), flood prediction. Satellite (GOES ABI/GLM), HRRR and forecast-window features, regression, a probability gate, many run options, retrain and continue-training (also for imported models).
- **Power outages layer:** utility outage maps (KUBRA Storm Center utilities, Duke Energy, Hydro-Québec) as a county choropleth plus outage points.
- **Better laptop support in 3D:** on-screen orbit controls, keyboard, Shift/Alt+drag, Orbit-drag mode and auto-rotate.
- **Radio player size switch:** small ↔ big media player without interrupting playback.

## Phase 8 plan — features (done in 0.8.0)

**Forecasting and verification**
- **Ensemble probability maps:** chance of ≥ X inches of rain or snow, or ≥ Y mph gusts, from GEFS and ECMWF ensemble members (server-side), with a threshold picker.
- **Severe-weather parameter maps:** SPC-mesoanalysis-style fields from HRRR/RAP — STP, SCP, bulk shear, SRH, lapse rates, DCAPE — plus composite overlays.
- **Point forecast confidence:** spread between models on the forecast chart, with a plain-language confidence line.

**Radar and detection**
- **Automatic storm reports from your models:** detections that persist become "model reports" on a timeline, which you can export or share with your team.
- **Model ensembles and A/B testing:** combine several of your detection models, or compare two on the same historical events (scorecards).
- **Velocity and differential reflectivity "difference" products:** frame-to-frame change maps (growth/decay) and ZDR columns highlighted as updraft indicators.
- **Lightning jump detection:** sudden increases in GLM flash rate per storm cell, flagged as a severe precursor.
- **Radar data quality tools:** a clutter / biological echo filter using dual-pol (toggle) and a beam-blockage map per radar.

**Situational awareness**
- **Personal dashboard menu:** one screen per saved point with current conditions, warnings, nearby storms with ETA, a 12-hour mini-meteogram, radar thumbnail, AQI and pollen — and a printable or shareable summary card.
- **Alert timeline:** a scrollable timeline of every warning, watch, MD, report and model detection for an area, with click-to-replay.
- **Chaser toolkit:** live position sharing with storm-relative motion vectors, a "safe zone" guide (core/hook/inflow areas from the storm's motion), road-network flood and closure warnings along the route, and auto-saved chase logs (GPS + radar + photos).
- **Shelters and emergency info:** open shelters (FEMA OpenFEMA and Red Cross where public), hospitals, cooling and warming centres near a point.
- **Earthquake and tsunami alerts:** USGS ShakeMap intensity overlays and NOAA tsunami messages, linked to the seismograph menu.

**Data and media**
- **Satellite derived products:** GOES fire temperature hotspots, cloud-top cooling (overshooting tops), and fog/low-cloud probability.
- **Webcam auto-timelapses:** daily timelapses for chosen cameras, with weather-event tags.
- **Audio radio scanner:** the server decodes SAME on many NOAA Weather Radio streams at once; the app cycles audio and jumps to the station with an alert.
- **Data export:** any layer's current data to CSV/GeoJSON/KML; radar sweeps to NetCDF; cross-sections and charts to PNG/SVG.

**App and platform**
- **Notification channels:** push to phone via ntfy.sh or Pushover (self-hostable), email (SMTP), Discord and Telegram, all driven by the rules engine on the server so alerts work when the app is closed.
- **Server-side rules:** the rules engine can also run on the server (24/7), not just in the app.
- **Command palette:** Ctrl+K to search every layer, menu, setting, place, radar and command.
- **Accessibility:** colour-vision-safe palettes everywhere, screen-reader labels, keyboard-only navigation and larger-text mode (all off by default; current look unchanged).
- **Also from the Phase 7 checklist:** GitHub releases with install scripts and auto-update, pane pop-outs, custom pane layouts, per-pane linking and swipe orientations, a seismic events layer, and many detection-model improvements (per-model runs, history-mode runs, intensities, resource budgets, storm track model).

## Phase 9 plan — Android + VR (only when asked)

**Android:** Capacitor app reusing the UI with a mobile layout (see Stack). It adds push alerts for saved points and GPS, background location for "alerts where I am", widgets, and Android Auto / car-friendly mode.

**VR (Meta Quest 3 / 3S):** full functionality, with multi-window support.
- **Platform:** a Horizon OS app built as a WebXR + PWA hybrid from the same codebase, so every feature works. It is packaged for the Quest store or sideloading.
- **Panels:** windowed mode uses several 2D panels side by side (map, cameras, radio, forecast, seismograph, radar panes), resizable and placeable in space.
- **Immersive mode:**
  - a 3D globe or tabletop terrain with radar volumes, isosurfaces and lightning in true 3D, which you can walk around and scale with hand tracking
  - storm "fly-through"
  - time scrubbing with a hand-held timeline
- **Immersive weather at a saved point:** pick a saved point and the headset simulates its current weather around you — rain, snow, storms with lightning and thunder, clear skies, overcast, night with scattered clouds and stars, fog and wind — driven by live observations, radar and forecast data.
- **VR navigation in 3D mode:** fly over the map with the thumbsticks (move, strafe, rise and descend, snap/smooth turn), look around freely, and grab-and-drag the world; teleport to places or storms.
- **Windows:** full support for at least 6 app windows at once (map panes, cameras, radio, forecast, seismograph, models…), each movable, resizable and anchorable in space.
- **A true immersive app, not a flat sideloaded panel:** even in 2D mode the UI is laid out in 3D space — curved main map, side panels floating at angles around you, toolbars and legends as separate spatial elements with depth, shadows and hand-reachable controls.
- **Passthrough (mixed reality):** place the tabletop storm or alert dashboards in your room.
- **Input:** controllers and hand tracking, voice commands (switch layers, play loop), and keyboard/mouse support.
- **Performance:** foveated rendering, reduced-resolution volumes, and server-side tiling sized for Quest GPUs.

## Phase 10 plan — publication (only when asked)

A large phase that turns TheBigWeather into a product others can install and use safely.

**Accounts and sign-in**
- Full registration with email verification, sign-in, sign-out, "remember this device", password reset by email link, and password change.
- Optional two-factor authentication (TOTP apps, recovery codes) and passkeys/WebAuthn.
- Sessions list with remote sign-out, login alerts, account lockout and rate limits, and CAPTCHA-free abuse protection (proof-of-work or rate-based).
- Account deletion and data export (GDPR-style).

**Permissions**
- Roles (owner, admin, member, viewer, guest) plus fine-grained permissions per feature: radar/history access, recordings, cameras, models (train, run, export), server settings, shares, Team rooms, API keys, notification channels.
- Per-resource sharing (models, workspaces, recordings, layouts) with view/edit rights.
- Groups/teams with shared resources, invitations by link or email.
- An audit log of sign-ins and changes, filterable and exportable.

**Account tiers and licensing**
- Tiers (e.g. Free, Plus, Pro, Server/Org) with limits on frames, history depth, recordings, model training jobs, concurrent radars and windows.
- Licence keys for self-hosted servers (offline-verifiable signed licences), trial periods, and a licence management page.
- Optional payments integration (e.g. Stripe or Paddle) behind a provider interface; invoices and receipts by email.
- Clear data-source attributions and licence compliance per feed (some feeds are non-commercial or personal-use only and must be disabled or replaced in commercial tiers).

**Multiple servers at once**
- The app connects to several servers simultaneously (e.g. a home server, a friend's server, a public server) with a combined layer list, per-layer server badges, failover for the same data, and per-server sign-in.
- Merged alerts, models and detections from all connected servers, with conflict-free IDs.

**Security**
- A thorough security review: dependency audit, fuzzing of every parser (Level II, GRIB, HDF5, miniSEED, KML, placefiles), SSRF and path-traversal tests, rate limits, CSP hardening, Electron hardening (context isolation, sandbox, no remote code), signed updates, and secrets at rest.
- Penetration-test checklist, security.txt, a responsible-disclosure policy and release signing (code-signing certificates for Windows, AppImage signatures).

**Distribution**
- Public website and documentation, onboarding tutorial, crash reporting (opt-in), privacy policy and terms, and a support channel.

## Status
- Phase 1: done, user-tested; fixes from testing shipped with Phase 2.
- Phase 2: done, user-tested; fixes shipped with Phase 3.
- Phase 3: done, user-tested; fixes and requested changes shipped with Phase 4.
- Phase 4: done, user-tested; fixes and requested changes shipped with Phase 5.
- Phase 5: done (this build, 0.5.0). Test with `docs/PHASE5_CHECKLIST.md`. A full plan audit is in `docs/PLAN_AUDIT.md` (missing items added; the rest explained).
- Deferred from Phase 3: Blitzortung (its terms forbid third-party apps without approval; GOES GLM is used instead); NOAA Weather Radio transmitter map (no official machine-readable list with coordinates; revisit with the Phase 4 radio menu); Spotter Network / chasers and mPING (need accounts, so they move to Phase 4 with the account-based features).
- Phase 4 notes:
  - NWR transmitter coordinates aren't published in a machine-readable list, so stations are mapped at their stream's city (geocoded once, cached).
  - Live chaser video aggregators have no public APIs. Spotter Network's public streamer feed is used instead.
  - mPING needs a free key; its general license allows the last 4 hours.
- Phase 5 notes: European single-site volumes come from the EUMETNET OPERA open data (24 h) and FMI. Composites cover Canada, Mexico, Japan, Taiwan and the Philippines. Hong Kong, Singapore, Malaysia, India and KMA were left out (licence, no georeferencing, or key). Niche US radars publish no open data.
- Phase 5: user-tested; fixes and requested changes shipped as 0.5.1.
- Phase 6: done (0.6.0). Test with `docs/PHASE6_CHECKLIST.md` (also covers 0.5.1). Not done from the Phase 6 list: "Glow" radar style, RTOFS ocean currents (only huge archives on AWS), surf/rip-current forecasts (no keyless source).
- Phase 6: user-tested; fixes shipped with Phase 7.
- Phase 7: done (0.7.0). Test with `docs/PHASE7_CHECKLIST.md`, which also lists the Phase 6 items not yet checked. Canada: ECCC sells single-site volumes (cost-recovered); only per-station GIF images and the national composite are open, so Canadian radars stay composite crops plus a per-station image viewer.
- Phase 7: user-tested; fixes and requested changes shipped with Phase 8.
- Phase 8: done (0.8.0). Test with `docs/PHASE8_CHECKLIST.md` (also covers the Phase 7 follow-ups and unchecked items).
- Next: Phase 9 (Android + VR) and Phase 10 (publication) only when asked.

---

