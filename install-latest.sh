#!/usr/bin/env bash
# Install or update TheBigWeather from GitHub (Linux x86_64 / aarch64 server).
#
#   curl -fsSL https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/install-latest.sh | bash
#   bash install-latest.sh [--dir ~/TheBigWeather] [--app-only | --server-only] [--no-desktop-entry]
#                          [--version 0.8.0] [--source auto|release|repo]
#
# Source: the newer of the latest GitHub release and the `builds` branch of the repository
# (--source release / repo forces one). Builds-branch files come in parts that are checked and
# joined while downloading; an interrupted download resumes from the parts already there.
# Installs into DIR (default ~/TheBigWeather):
#   DIR/TheBigWeather.AppImage      the desktop app (it updates itself afterwards)
#   DIR/server/…, DIR/start.sh      the server bundle (start it with DIR/start.sh; update with --update)
# Every download is SHA-256 checked. Re-running updates in place and keeps server/data
# (config, token, recordings).
set -euo pipefail
REPO="${TBW_REPO:-goglesquirmintontheiii/thebigweather}"
RAW="${TBW_RAW_BASE:-https://raw.githubusercontent.com/$REPO}"   # <RAW>/<ref>/manifest.json
API="${TBW_API_BASE:-https://api.github.com}"
BRANCH="${TBW_BUILDS_BRANCH:-builds}"
# semver comparison (prerelease < release, numeric identifiers compare as numbers): prints -1, 0 or 1
ver_cmp() {
  local a="${1#[vV]}" b="${2#[vV]}" i x y
  a="${a%%+*}"; b="${b%%+*}"
  local ac="${a%%-*}" bc="${b%%-*}" ap="" bp=""
  [[ "$a" == *-* ]] && ap="${a#*-}"
  [[ "$b" == *-* ]] && bp="${b#*-}"
  local -a A B
  IFS=. read -r -a A <<<"$ac"; IFS=. read -r -a B <<<"$bc"
  for i in 0 1 2; do
    x="${A[$i]:-0}"; y="${B[$i]:-0}"
    [[ "$x" =~ ^[0-9]+$ ]] || x=0; [[ "$y" =~ ^[0-9]+$ ]] || y=0
    if (( 10#$x > 10#$y )); then echo 1; return; fi
    if (( 10#$x < 10#$y )); then echo -1; return; fi
  done
  if [[ -z "$ap" && -z "$bp" ]]; then echo 0; return; fi
  [[ -z "$ap" ]] && { echo 1; return; }
  [[ -z "$bp" ]] && { echo -1; return; }
  IFS=. read -r -a A <<<"$ap"; IFS=. read -r -a B <<<"$bp"
  for (( i = 0; i < ${#A[@]} || i < ${#B[@]}; i++ )); do
    (( i >= ${#A[@]} )) && { echo -1; return; }
    (( i >= ${#B[@]} )) && { echo 1; return; }
    x="${A[$i]}"; y="${B[$i]}"
    [[ "$x" == "$y" ]] && continue
    if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
      (( 10#$x > 10#$y )) && echo 1 || echo -1; return
    fi
    [[ "$x" =~ ^[0-9]+$ ]] && { echo -1; return; }
    [[ "$y" =~ ^[0-9]+$ ]] && { echo 1; return; }
    [[ "$x" > "$y" ]] && echo 1 || echo -1; return
  done
  echo 0
}
[[ "${TBW_SELFTEST:-}" == vercmp ]] && { ver_cmp "$1" "$2"; exit 0; }  # tests

DIR="$HOME/TheBigWeather"; APP=1; SERVER=1; DESKTOP=1; VERSION=""; SOURCE=auto
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --app-only) SERVER=0; shift ;;
    --server-only) APP=0; DESKTOP=0; shift ;;
    --no-desktop-entry) DESKTOP=0; shift ;;
    --version) VERSION="${2#v}"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 1 ;;
  esac
done
case "$SOURCE" in auto|release|repo) ;; *) echo "--source must be auto, release or repo"; exit 1 ;; esac
say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || die "this installer is for Linux; on Windows use install-latest.cmd"
for t in curl sha256sum tar; do command -v "$t" >/dev/null || die "please install $t"; done
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64; APP=0; DESKTOP=0; echo "note: the desktop app is x86_64 only; installing the server" ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac

# ---------- what is available ----------
REL=""; REL_V=""
if [[ "$SOURCE" != repo ]]; then
  if [[ -n "$VERSION" ]]; then api="$API/repos/$REPO/releases/tags/v$VERSION"; else api="$API/repos/$REPO/releases/latest"; fi
  say "looking up the latest release ($REPO)"
  if REL="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null)"; then
    REL_V="$(printf '%s' "$REL" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed -E 's/.*"v?([^"]*)"$/\1/')"
  fi
  [[ -n "$REL_V" ]] && echo "    release: $REL_V" || echo "    no release found"
fi
MAN=""; MAN_V=""; REF=""
if [[ "$SOURCE" != release ]]; then
  say "looking up the $BRANCH branch"
  # pin every download to the branch's current commit, so a publish during the download can't mix
  # versions (the API is rate-limited: fall back to the branch name + per-part checksums)
  sha="$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github.sha' "$API/repos/$REPO/commits/$BRANCH" 2>/dev/null || true)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] && REF="$sha" || REF="$BRANCH"
  MAN="$(curl -fsSL --max-time 30 "$RAW/$REF/manifest.json" 2>/dev/null || true)"
  if [[ -z "$MAN" && "$REF" != "$BRANCH" ]]; then REF="$BRANCH"; MAN="$(curl -fsSL --max-time 30 "$RAW/$REF/manifest.json" 2>/dev/null || true)"; fi
  MAN_V="$(printf '%s' "$MAN" | grep -o '"version": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
  [[ -n "$MAN_V" ]] && echo "    $BRANCH branch: $MAN_V" || echo "    no builds on the $BRANCH branch"
  [[ -n "$VERSION" && -n "$MAN_V" && "$(ver_cmp "$MAN_V" "$VERSION")" != 0 ]] && MAN_V=""
fi
if [[ -n "$REL_V" && ( -z "$MAN_V" || "$(ver_cmp "$REL_V" "$MAN_V")" != -1 ) ]]; then
  FROM=release; V="$REL_V"
elif [[ -n "$MAN_V" ]]; then
  FROM=repo; V="$MAN_V"
else
  die "nothing to install: no release${VERSION:+ v$VERSION} and no builds found (offline? rate-limited?)"
fi
say "TheBigWeather $V (from $([[ $FROM == release ]] && echo "the GitHub release" || echo "the repository's $BRANCH branch"))"

mkdir -p "$DIR"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
CACHE="$DIR/.download"  # builds-branch downloads (kept until installed, so a re-run resumes)

# ---------- downloads ----------
url_of() { printf '%s' "$REL" | grep -o '"browser_download_url": *"[^"]*"' | sed -E 's/.*"(https?:[^"]*)"$/\1/' | grep -F "/$1" | head -1; }
has_asset() { if [[ $FROM == release ]]; then [[ -n "$(url_of "$1")" ]]; else printf '%s' "$MAN" | grep -qF "\"$1\": {"; fi; }

# builds branch: download every part, check it, append it; check the whole file at the end
repo_fetch() { # $1 = asset name → prints the joined file's path
  local n="$1" out="$CACHE/$1" line want_size want_sum p ps ph off=0 i=0 total have ok try got
  line="$(printf '%s' "$MAN" | grep -F "\"$n\": {" | head -1)"
  [[ -n "$line" ]] || die "the $BRANCH branch has no $n"
  want_size="$(printf '%s' "$line" | sed -E 's/.*"size": *([0-9]+).*/\1/')"
  want_sum="$(printf '%s' "$line" | sed -E 's/.*"sha256": *"([0-9a-f]{64})".*/\1/')"
  mapfile -t parts < <(printf '%s\n' "$MAN" | grep -F "\"path\": \"parts/$n.part")
  total=${#parts[@]}
  (( total )) || die "the manifest lists no parts for $n"
  mkdir -p "$CACHE"
  # an earlier, interrupted download of the same file: keep the parts that still check out
  have=0; [[ -f "$out" ]] && have="$(stat -c %s "$out")"
  ok=1
  echo "    downloading $n ($(( want_size / 1024 / 1024 )) MB in $total parts)" >&2
  for line in "${parts[@]}"; do
    i=$((i + 1))
    p="$(printf '%s' "$line" | sed -E 's/.*"path": *"([^"]+)".*/\1/')"
    ps="$(printf '%s' "$line" | sed -E 's/.*"size": *([0-9]+).*/\1/')"
    ph="$(printf '%s' "$line" | sed -E 's/.*"sha256": *"([0-9a-f]{64})".*/\1/')"
    if (( ok && have >= off + ps )) && [[ "$(tail -c +$((off + 1)) "$out" | head -c "$ps" | sha256sum | cut -d' ' -f1)" == "$ph" ]]; then
      echo "    part $i/$total already here" >&2
      off=$((off + ps)); continue
    fi
    if (( ok )); then ok=0; [[ -f "$out" ]] && truncate -s "$off" "$out" || : > "$out"; fi
    for try in 1 2 3; do
      echo "    part $i/$total" >&2
      if curl -fL --progress-bar --retry 3 --max-time 900 -o "$out.part" "$RAW/$REF/$p" >&2; then
        got="$(sha256sum "$out.part" | cut -d' ' -f1)"
        [[ "$got" == "$ph" && "$(stat -c %s "$out.part")" == "$ps" ]] && break
        echo "    part $i/$total: checksum mismatch, retrying" >&2
      fi
      [[ $try == 3 ]] && { rm -f "$out.part"; die "can't download $p (if a new build was published meanwhile, run this again)"; }
      sleep 2
    done
    cat "$out.part" >> "$out"; rm -f "$out.part"
    off=$((off + ps))
  done
  (( off < $(stat -c %s "$out") )) && truncate -s "$off" "$out"
  got="$(sha256sum "$out" | cut -d' ' -f1)"
  if [[ "$got" != "$want_sum" || "$(stat -c %s "$out")" != "$want_size" ]]; then rm -f "$out"; die "checksum mismatch for $n after joining (run again)"; fi
  echo "    $n: checksum verified" >&2
  printf '%s' "$out"
}
release_fetch() { # $1 = asset name → prints the file's path
  local u want got
  u="$(url_of "$1")"
  [[ -n "$u" ]] || die "release v$V has no $1"
  if [[ ! -f "$tmp/SHA256SUMS" ]]; then
    local sums; sums="$(url_of SHA256SUMS)"; [[ -n "$sums" ]] || die "release v$V has no SHA256SUMS"
    curl -fsSL -o "$tmp/SHA256SUMS" "$sums" || die "can't download SHA256SUMS"
  fi
  echo "    downloading $1" >&2
  curl -fL --progress-bar --retry 3 -o "$tmp/$1" "$u" >&2 || die "download of $1 failed"
  want="$(awk -v n="$1" '$2==n || $2=="*"n {print $1}' "$tmp/SHA256SUMS")"
  got="$(sha256sum "$tmp/$1" | awk '{print $1}')"
  [[ -n "$want" && "$want" == "$got" ]] || die "checksum mismatch for $1 (download corrupted?)"
  printf '%s' "$tmp/$1"
}
fetch() { if [[ $FROM == release ]]; then release_fetch "$1"; else repo_fetch "$1"; fi; }

# ---------- install ----------
if (( SERVER )); then
  b="tbw-server-$V-linux-$ARCH.tar.gz"
  if has_asset "$b"; then
    f="$(fetch "$b")"
    say "installing the server into $DIR"
    tar -xzf "$f" -C "$tmp"
    src="$tmp/TheBigWeather-server"
    # keep data/ (config, token, recordings) and the old binary for rollback
    mkdir -p "$DIR/server/bin" "$DIR/server/data" "$DIR/app"
    [[ -x "$DIR/server/bin/tbw-server" ]] && mv -f "$DIR/server/bin/tbw-server" "$DIR/server/bin/tbw-server.old"
    cp -f "$src/server/bin/tbw-server" "$DIR/server/bin/tbw-server"
    cp -f "$src/server/VERSION" "$DIR/server/VERSION"
    cp -f "$src"/server/data/*.json "$DIR/server/data/" 2>/dev/null || true
    rm -rf "$DIR/app/dist.old"; [[ -d "$DIR/app/dist" ]] && mv "$DIR/app/dist" "$DIR/app/dist.old"
    cp -r "$src/app/dist" "$DIR/app/dist"
    for x in start.sh install-latest.sh README.md; do [[ -f "$src/$x" ]] && cp -f "$src/$x" "$DIR/"; done
    chmod +x "$DIR/start.sh" "$DIR/server/bin/tbw-server" "$DIR/install-latest.sh" 2>/dev/null || true
    [[ $FROM == repo ]] && rm -f "$f"
    echo "    start it with: $DIR/start.sh   (first run asks a few questions; --install-service runs it at boot)"
    if systemctl is-active --quiet tbw-server.service 2>/dev/null && grep -q "$DIR/server/bin/tbw-server" /etc/systemd/system/tbw-server.service 2>/dev/null; then
      sudo systemctl restart tbw-server.service && echo "    restarted tbw-server.service"
    fi
  else
    echo "    (version $V has no Linux $ARCH server bundle)"
  fi
fi

if (( APP )); then
  a="TheBigWeather-$V-x86_64.AppImage"
  f="$(fetch "$a")"
  say "installing the desktop app"
  mv -f "$f" "$DIR/TheBigWeather.AppImage"
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
rmdir "$CACHE" 2>/dev/null || true
say "done"
