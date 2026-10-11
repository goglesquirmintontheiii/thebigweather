# TheBigWeather

Radar and weather workstation: a Linux desktop app (AppImage) plus a self-hosted server that does the heavy lifting.

**Status:** Phase 2 of 6 (see [PLAN.md](PLAN.md)). Test list: [docs/PHASE2_CHECKLIST.md](docs/PHASE2_CHECKLIST.md).

## Quick start

### 1. Server (your VPS or PC)

```bash
./start.sh                          # LAN mode: http://<machine>:8787
./start.sh --domain wx.example.com  # HTTPS via Caddy (ports 80/443 must reach the box)
./start.sh --domain wx.example.com --install-service   # run on boot (systemd)
```

`start.sh` prints the **server URL** and **token** at the end. Run `./start.sh --help` for every option.

- A prebuilt server binary is in `server/bin/` (needs glibc 2.38+, e.g. Ubuntu 24.04 / Debian 13).
- On older systems `start.sh` installs Rust and builds from source automatically (a few minutes).
- Config lives in `server/data/config.toml`.

### 2. Desktop app

```bash
chmod +x TheBigWeather-0.2.1-x86_64.AppImage
./TheBigWeather-0.2.1-x86_64.AppImage
```

On first launch, paste the server URL and token. If the server runs on the same computer, click **Use the server on this computer** — no token needed (turn this off with `local_no_auth = false` under `[server]` in the config).

The UI also works in a browser at the server URL (phones too, until the Android app exists).

## Phase 2 features

**Layer menu** (top left of the header) switches the weather layer without opening a panel. Search, or browse by category:

- **Radar:** Level II, Level III, and MRMS radar mosaics
- **Future:** 6 hr future radar (HRRR, every 15 min), 24 hr future radar (HRRR), 72 hr future radar (RRFS), and 48 hr future snowfall (total from now). Each picks the freshest run that reaches the full time span and falls back to another model if one is late.
- **MRMS:** reflectivity, precip type and rate, hail (MESH, POSH), rotation tracks, azimuthal shear, lightning probability, VIL, echo tops, QPE 1–72 h
- **Satellite:** GOES-19/18 all 16 bands for CONUS, Full Disk, Meso 1 and 2 (values on hover); GeoColor, Air Mass, Dust and Fire RGB; Himawari-9
- **Models:** HRRR, RRFS, NAM 3 km, NAM 12 km, RAP, NBM, GFS, ECMWF IFS, HAFS-A/B. Fields include reflectivity, precip, snow, temperature, dewpoint, RH, wind, gusts, pressure, visibility, clouds, CAPE, helicity, updraft helicity, PWAT, 850 mb temperature, 500 mb height and 250 mb wind. Pick the run, plus the storm for HAFS.
- **Forecast:** NDFD grids (temperature, highs and lows, feels-like, dewpoint, RH, precip chance and amount, snow, ice, sky cover, wind, gusts, WBGT, and tornado, hail and damaging-wind probabilities)
- **Surface:** live analysis interpolated from every METAR (temperature, dewpoint, RH, wind, gust, pressure, visibility, feels-like, dewpoint depression)

How it works: the server decodes GRIB2 and NetCDF, reprojects to the map, and sends only what's on screen as compact raw values. The app colors them on the GPU, so values under the cursor are exact and units follow your settings (°F/°C, in/mm, mi/km, mph/kt).

**Fixes and changes from Phase 1 testing**
- Arrow keys step frames and tilts only (the map no longer moves)
- Level III: one button per product with a tilt selector (↑ ↓ works); switching between NEXRAD and TDWR sites picks the matching product; clear messages when a site doesn't publish a product (e.g. LPLA)
- RapidSweep: off by default; progress bar under the header and a live beam line on the map
- Ctrl+click radar sites to show several radars together (plain click shows one)
- OpenFreeMap or CARTO tiles for Dark, Light and Road (Layers panel); OpenFreeMap is the default
- Lower memory use: smaller sweep and GPU caches, live sweeps freed immediately, capped JS heap
- No token needed from the same computer
- Hover the server stats bars for details (per-core load, swap, process memory, totals)
- FPS counter, top right (Settings → FPS counter)

## Phase 1 features

**Radar**
- NEXRAD Level II, current and history, from the AWS bucket
- RapidSweep: live chunks drawn as the radar scans
- TDWR Level II through the live chunk feed
- Level III (base, dual-pol, derived, precip, TDWR products)
- Open local Level II files (or drop one on the map)

**Rendering**
- GPU radar renderer: instant color tables, smoothing, opacity
- Exact values under the cursor and the crosshair, with beam height
- `.pal` color table import; colorblind-safe tables

**Alerts**
- NWS alerts with standard colors
- Tornado Emergency / PDS / damage-threat tags
- Alert list and alert text panel
- Notifications for your saved points, with sound and desktop popups

**Map**
- Basemaps: Dark, Light, Road, Dark roadmap (vector), Terrain, Satellite, Google satellite (key), Offline
- Toolbar:
  - play/pause
  - locate
  - screenshot
  - distance and bearing from the radar
  - crosshair
  - measure
  - radar sites toggle
- Range rings, saved points, county and state lines

**Server**
- Draggable server stats panel (CPU, RAM, disk, network)
- Data source health panel
- API keys stored on the server
- Hardware profiles: full on big machines, lite on small VPSes

## Hotkeys

| Key | Action |
|---|---|
| `Space` | play/pause |
| `←` `→` | previous / next frame |
| `↑` `↓` | tilt up / down (Level II and Level III) |
| `1`–`6` | REF, VEL, SW, ZDR, CC, PHI |
| `C` | crosshair |
| `B` | bearing from radar |
| `M` | measure |
| `R` | radar sites |
| `L` | locate |
| `S` | screenshot |
| `Esc` | close / cancel |

## Development

```bash
cd server && cargo build --release      # server
cd app && npm install && npm run dev    # UI in a browser (vite)
cd app && npm run dist                  # AppImage -> app/release/
```

Offline testing with sample data:

```bash
tbw-server -c data/config.toml \
  --replay-dir <folder of Level II chunk files> --replay-site TORD \
  --alerts-fixture tools/fixtures/alerts_demo.geojson \
  --grid-dir <folder of GRIB2/NetCDF files named <layer>__<file>> \
  --metar-fixture <metars.cache.csv>
```

## Data sources

- NOAA NEXRAD and TDWR via AWS Open Data: `unidata-nexrad-level2`, `-level2-chunks`, `-level3`
- MRMS, HRRR, RRFS, NAM, RAP, NBM, GFS, HAFS, GOES-19/18 via NOAA Open Data on AWS
- ECMWF open data (IFS 0.25°, CC-BY-4.0)
- NDFD via tgftp.nws.noaa.gov; METARs via aviationweather.gov
- NASA GIBS (GeoColor and RGB composites, Himawari)
- National Weather Service API (alerts)
- Map tiles: © OpenStreetMap contributors, CARTO, Esri, OpenFreeMap
