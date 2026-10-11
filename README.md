# TheBigWeather

Radar and weather workstation: a Linux desktop app (AppImage) plus a self-hosted server that does the heavy lifting.

**Status:** Phase 1 of 6 (see [PLAN.md](PLAN.md)).

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
chmod +x TheBigWeather-0.1.0-x86_64.AppImage
./TheBigWeather-0.1.0-x86_64.AppImage
```

On first launch, paste the server URL and token.

The UI also works in a browser at the server URL (phones too, until the Android app exists).

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
| `↑` `↓` | tilt up / down |
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
  --alerts-fixture tools/fixtures/alerts_demo.geojson
```

## Data sources

- NOAA NEXRAD and TDWR via AWS Open Data: `unidata-nexrad-level2`, `-level2-chunks`, `-level3`
- National Weather Service API (alerts)
- Map tiles: © OpenStreetMap contributors, CARTO, Esri, OpenFreeMap
