# Stormiq 0.8.4 builds

Automatic build files (commit `598b8bf39af8`). This branch is replaced on every publish.

- Linux: `curl -fsSL https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/builds/install-latest.sh | bash`
- Windows: download `install-latest.cmd` from this branch and run it.
- By hand: download the branch as a ZIP, then run `join-appimage.sh` (Linux) or `join-windows.cmd` (Windows)
  to rebuild the files from `parts/` (checked against `SHA256SUMS`).
- Stormiq was called TheBigWeather before 0.8.2: `TheBigWeather-0.8.4-…` entries in `manifest.json` /
  `SHA256SUMS` are the same files as `Stormiq-0.8.4-…` (for apps that update from 0.8.1).
