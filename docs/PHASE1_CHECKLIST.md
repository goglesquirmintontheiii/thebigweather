# Phase 1 test checklist

My build box can't reach NOAA, the NWS or the map tile servers, so these items need a real network. Tick what works and tell me what doesn't, with a screenshot or the server log line.

## Server

- [ ] `./start.sh` finishes and prints a URL and token.
- [ ] VPS: `./start.sh --domain <your domain>` gets an HTTPS certificate; `https://<domain>/api/health` shows `"ok":true`.
- [ ] `--install-service` survives a reboot (`systemctl status tbw-server`).
- [ ] Sources panel: *NEXRAD Level II archive*, *NWS alerts* and *Radar site table* turn green within a minute.

## Radar

- [ ] Your nearest NEXRAD loads the latest frame in a few seconds.
- [ ] REF / VEL / SW / ZDR / CC / PHI all switch quickly; tilts switch with ↑ ↓.
- [ ] RapidSweep: during weather, the header shows a % and new data paints over the old sweep.
- [ ] Animation: 12+ frames play smoothly (Space).
- [ ] History: pick a past date/time → Load → frames from that day.
- [ ] A TDWR site (e.g. TORD, TDFW) shows data (live feed).
- [ ] Level III: N0B, N0G, N0C, N0H, DVL, EET and DAA each load.
- [ ] Opening a Level II file from disk works.

## Map

- [ ] Each basemap shows tiles (Google needs a Map Tiles key in Settings → API keys).
- [ ] Labels and roads draw above the radar on Dark, Light, Road and Dark roadmap.
- [ ] Crosshair, measure, bearing, locate and screenshot all work.
- [ ] The stats panel drags and remembers its position.

## Alerts

- [ ] Active alerts draw with the right colors; zone-based alerts (watches, advisories) fill their counties.
- [ ] Clicking a polygon opens the text; the Alerts list filters (Warnings / In view / My points / All) work.
- [ ] A new warning over a saved point triggers a toast, a sound and a desktop notification.

## Performance (please note numbers)

- [ ] Server CPU while idle, and while streaming 1–2 live sites.
- [ ] App RAM after 10 minutes of looping.
- [ ] Time to switch to a new radar site.
