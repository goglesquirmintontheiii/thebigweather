# Storm ETA chime

Get a **gentle three-note chime** when a radar-tracked storm cell is forecast to reach one of your
saved points — even when the app is in the background.

## How it works

- Every 2 minutes it reads the NEXRAD storm cell list from your server.
- Each cell's track (direction and speed) is projected one hour ahead, the same way the app's
  storm ETA does it. A cell "arrives" when its path passes within **5 km** of a point.
- When the soonest cell is within your chosen time (default *15 minutes*), you hear the chime
  and see a toast. Each cell chimes at most once per point every 45 minutes.

## Settings

Pick the warning time in the plugin's panel: 5, 10, 15, 20, 30, 45 or 60 minutes.
Use **Test chime** to check your volume.

> Storm tracks are estimates. Always follow official warnings.

| Needs | Why |
| --- | --- |
| Server | Storm cell list (`/api/ovl/stormattr`) |
| Settings | Your saved points |
| Audio | The chime |
