# TheBigWeather 0.8.1 builds

Automatic build files (commit `3f0b6eb1f280`). This branch is replaced on every publish.

- Linux: `curl -fsSL https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/builds/install-latest.sh | bash`
- Windows: download `install-latest.cmd` from this branch and run it.
- By hand: download the branch as a ZIP, then run `join-appimage.sh` (Linux) or `join-windows.cmd` (Windows)
  to rebuild the files from `parts/` (checked against `SHA256SUMS`).
