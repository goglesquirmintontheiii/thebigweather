#!/usr/bin/env bash
# Install or update TheBigWeather from the latest GitHub release (Linux x86_64 / aarch64 server).
#
#   curl -fsSL https://github.com/goglesquirmintontheiii/thebigweather/releases/latest/download/install-latest.sh | bash
#   bash install-latest.sh [--dir ~/TheBigWeather] [--app-only | --server-only] [--no-desktop-entry] [--version 0.8.0]
#
# Installs into DIR (default ~/TheBigWeather):
#   DIR/TheBigWeather.AppImage      the desktop app (it updates itself afterwards)
#   DIR/server/…, DIR/start.sh      the server bundle (start it with DIR/start.sh; update with --update)
# Every download is checked against the release's SHA256SUMS. Re-running updates in place and
# keeps server/data (config, token, recordings).
set -euo pipefail
REPO="${TBW_REPO:-goglesquirmintontheiii/thebigweather}"
DIR="$HOME/TheBigWeather"; APP=1; SERVER=1; DESKTOP=1; VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --app-only) SERVER=0; shift ;;
    --server-only) APP=0; DESKTOP=0; shift ;;
    --no-desktop-entry) DESKTOP=0; shift ;;
    --version) VERSION="${2#v}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 1 ;;
  esac
done
say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || die "this installer is for Linux; on Windows use install-latest.cmd"
for t in curl sha256sum tar; do command -v "$t" >/dev/null || die "please install $t"; done
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64; APP=0; DESKTOP=0; echo "note: the desktop app is x86_64 only; installing the server" ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

if [[ -n "$VERSION" ]]; then api="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"; else api="https://api.github.com/repos/$REPO/releases/latest"; fi
say "looking up the release ($REPO)"
rel="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "$api")" || die "can't reach the GitHub API (offline? rate-limited?)"
tag="$(printf '%s' "$rel" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
V="${tag#v}"
[[ -n "$V" ]] || die "no release found"
url_of() { printf '%s' "$rel" | grep -o '"browser_download_url": *"[^"]*"' | sed -E 's/.*"(https:[^"]*)"$/\1/' | grep -F "/$1" | head -1; }
say "TheBigWeather $V"

mkdir -p "$DIR"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fetch() { # $1 = asset name → $tmp/$1, checked
  local u; u="$(url_of "$1")"
  [[ -n "$u" ]] || die "release $tag has no $1"
  echo "    downloading $1"
  curl -fL --progress-bar --retry 3 -o "$tmp/$1" "$u" || die "download of $1 failed"
  local want got
  want="$(awk -v n="$1" '$2==n || $2=="*"n {print $1}' "$tmp/SHA256SUMS")"
  got="$(sha256sum "$tmp/$1" | awk '{print $1}')"
  [[ -n "$want" && "$want" == "$got" ]] || die "checksum mismatch for $1 (download corrupted?)"
}
sums="$(url_of SHA256SUMS)"; [[ -n "$sums" ]] || die "release $tag has no SHA256SUMS"
curl -fsSL -o "$tmp/SHA256SUMS" "$sums"

if (( SERVER )); then
  b="tbw-server-$V-linux-$ARCH.tar.gz"
  if [[ -n "$(url_of "$b")" ]]; then
    fetch "$b"
    say "installing the server into $DIR"
    tar -xzf "$tmp/$b" -C "$tmp"
    src="$tmp/TheBigWeather-server"
    # keep data/ (config, token, recordings) and the old binary for rollback
    mkdir -p "$DIR/server/bin" "$DIR/server/data" "$DIR/app"
    [[ -x "$DIR/server/bin/tbw-server" ]] && mv -f "$DIR/server/bin/tbw-server" "$DIR/server/bin/tbw-server.old"
    cp -f "$src/server/bin/tbw-server" "$DIR/server/bin/tbw-server"
    cp -f "$src/server/VERSION" "$DIR/server/VERSION"
    cp -f "$src"/server/data/*.json "$DIR/server/data/" 2>/dev/null || true
    rm -rf "$DIR/app/dist.old"; [[ -d "$DIR/app/dist" ]] && mv "$DIR/app/dist" "$DIR/app/dist.old"
    cp -r "$src/app/dist" "$DIR/app/dist"
    for f in start.sh install-latest.sh README.md; do [[ -f "$src/$f" ]] && cp -f "$src/$f" "$DIR/"; done
    chmod +x "$DIR/start.sh" "$DIR/server/bin/tbw-server" "$DIR/install-latest.sh" 2>/dev/null || true
    echo "    start it with: $DIR/start.sh   (first run asks a few questions; --install-service runs it at boot)"
    if systemctl is-active --quiet tbw-server.service 2>/dev/null && grep -q "$DIR/server/bin/tbw-server" /etc/systemd/system/tbw-server.service 2>/dev/null; then
      sudo systemctl restart tbw-server.service && echo "    restarted tbw-server.service"
    fi
  else
    echo "    (this release has no Linux $ARCH server bundle)"
  fi
fi

if (( APP )); then
  a="TheBigWeather-$V-x86_64.AppImage"
  fetch "$a"
  say "installing the desktop app"
  mv -f "$tmp/$a" "$DIR/TheBigWeather.AppImage"
  chmod +x "$DIR/TheBigWeather.AppImage"
  if (( DESKTOP )); then
    apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$apps"
    icon=""
    # the AppImage carries its icon; extract it once
    if (cd "$tmp" && "$DIR/TheBigWeather.AppImage" --appimage-extract '*.png' >/dev/null 2>&1); then
      p="$(ls "$tmp"/squashfs-root/*.png 2>/dev/null | head -1)"
      [[ -n "$p" ]] && cp "$p" "$DIR/icon.png" && icon="$DIR/icon.png"
    fi
    cat > "$apps/thebigweather.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=TheBigWeather
Comment=Radar and weather workstation
Exec="$DIR/TheBigWeather.AppImage" %F
Icon=${icon:-weather-storm}
Terminal=false
Categories=Science;Education;
MimeType=application/x-tbw-colortable;application/x-tbw-workspace;application/x-nexrad-level2;
EOF
    command -v update-desktop-database >/dev/null && update-desktop-database "$apps" >/dev/null 2>&1 || true
    echo "    added TheBigWeather to the applications menu"
  fi
  echo "    run it: $DIR/TheBigWeather.AppImage   (it updates itself: Settings → Updates)"
  command -v fusermount >/dev/null || command -v fusermount3 >/dev/null || echo "    note: AppImages need FUSE (e.g. sudo apt install libfuse2)"
fi
say "done"
