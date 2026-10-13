#!/usr/bin/env bash
# Build and publish a TheBigWeather release on GitHub (release assets, not git files: the
# AppImage / installers are far over git's 100 MB file limit).
#
#   tools/release.sh                      build everything for the version in app/package.json and publish v<version>
#   tools/release.sh --version 0.8.0      set the version first (app/package.json, server/Cargo.toml, server/VERSION)
#   tools/release.sh --skip-build         only package + upload what is already built
#   tools/release.sh --draft              create the release as a draft (publish it on GitHub later)
#   tools/release.sh --notes FILE         release notes (default: generated from the commits since the last tag)
#   tools/release.sh --no-windows         skip the Windows server / installers (cross builds need mingw-w64)
#   tools/release.sh --dry-run            build and collect into release/v<version>/ but don't upload
#
# Needs: gh (logged in with a token that can write to the repo: `gh auth login`), cargo, node/npm,
# zip, sha256sum; for Windows assets mingw-w64 (tools/windows/build-server-exe.sh) and wine for
# electron-builder's NSIS step when not on Windows.
#
# Assets (what install-latest.sh / install-latest.ps1, the server's self-update and the app's
# auto-update look for — keep the names):
#   TheBigWeather-<v>-x86_64.AppImage, latest-linux.yml          desktop app, Linux (+ updater metadata)
#   TheBigWeather-<v>-setup.exe, latest.yml, *.blockmap          desktop app, Windows installer (+ updater metadata)
#   TheBigWeather-<v>-portable.exe                               desktop app, Windows portable
#   tbw-server-<v>-linux-x86_64, tbw-server-<v>-windows-x86_64.exe   bare server binaries (self-update)
#   tbw-server-<v>-linux-x86_64.tar.gz, tbw-server-<v>-windows-x86_64.zip   server bundles (start scripts, binary, web app)
#   tbw-web-<v>.zip                                              web app (browser UI served by the server)
#   install-latest.sh, install-latest.ps1, install-latest.cmd    installers
#   SHA256SUMS                                                   sha256 of every asset
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${TBW_RELEASE_REPO:-goglesquirmintontheiii/thebigweather}"
VERSION=""; SKIP_BUILD=0; DRAFT=0; NOTES=""; WINDOWS=1; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2#v}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --draft) DRAFT=1; shift ;;
    --notes) NOTES="$2"; shift 2 ;;
    --no-windows) WINDOWS=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 1 ;;
  esac
done
say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }

cd "$ROOT"
if [[ -n "$VERSION" ]]; then
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z"
  say "setting version $VERSION"
  node -e 'const f="app/package.json",p=require("./"+f);p.version=process.argv[1];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$VERSION"
  sed -i -E "0,/^version = \"[^\"]+\"/s//version = \"$VERSION\"/" server/Cargo.toml
  echo "$VERSION" > server/VERSION
  echo "    commit the version change before publishing (git commit -am \"v$VERSION\")"
fi
V="$(node -p 'require("./app/package.json").version')"
CV="$(sed -nE 's/^version = "([^"]+)"/\1/p' server/Cargo.toml | head -1)"
[[ "$V" == "$CV" ]] || die "app/package.json ($V) and server/Cargo.toml ($CV) versions differ (use --version)"
TAG="v$V"
OUT="$ROOT/release/$TAG"
(( DRY )) || { command -v gh >/dev/null || die "install the GitHub CLI (gh) and run gh auth login"; gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"; }

if (( ! SKIP_BUILD )); then
  say "server (Linux)"
  (cd server && cargo build --release)
  mkdir -p server/bin
  cp "${CARGO_TARGET_DIR:-server/target}/release/tbw-server" server/bin/tbw-server
  strip server/bin/tbw-server 2>/dev/null || true
  if (( WINDOWS )); then
    say "server (Windows, cross)"
    bash tools/windows/build-server-exe.sh
  fi
  say "web app + desktop app"
  (cd app && npm run build)
  targets=(--linux AppImage)
  (( WINDOWS )) && targets+=(--win nsis portable)
  (cd app && npx electron-builder "${targets[@]}" --x64 --publish never)
fi

say "collecting assets in $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"
rel="$ROOT/app/release"
cp "$rel/TheBigWeather-$V-x86_64.AppImage" "$OUT/"
[[ -f "$rel/latest-linux.yml" ]] && cp "$rel/latest-linux.yml" "$OUT/"
if (( WINDOWS )); then
  for f in "TheBigWeather-$V-setup.exe" "TheBigWeather-$V-setup.exe.blockmap" "TheBigWeather-$V-portable.exe" latest.yml; do
    [[ -f "$rel/$f" ]] && cp "$rel/$f" "$OUT/" || echo "    (missing $f)"
  done
fi
cp server/bin/tbw-server "$OUT/tbw-server-$V-linux-x86_64"
(( WINDOWS )) && cp server/bin/tbw-server.exe "$OUT/tbw-server-$V-windows-x86_64.exe"

# web app zip (files at the root, as the server's self-update expects)
(cd app/dist && zip -qr "$OUT/tbw-web-$V.zip" .)

# server bundles: start scripts + binary + data tables + web app
stage="$(mktemp -d)"
mk_bundle() { # $1 = platform dir name, $2 = binary path, rest = scripts
  local d="$stage/$1/TheBigWeather-server"
  mkdir -p "$d/server/bin" "$d/server/data" "$d/app"
  cp "$2" "$d/server/bin/"
  echo "$V" > "$d/server/VERSION"
  cp server/data/camera_sources.json server/data/level3_products.json server/data/sites.json "$d/server/data/"
  cp -r app/dist "$d/app/dist"
  shift 2
  for s in "$@"; do cp "$s" "$d/"; done
}
mk_bundle linux server/bin/tbw-server start.sh install-latest.sh README.md
chmod +x "$stage/linux/TheBigWeather-server/start.sh" "$stage/linux/TheBigWeather-server/server/bin/tbw-server"
tar -C "$stage/linux" -czf "$OUT/tbw-server-$V-linux-x86_64.tar.gz" TheBigWeather-server
if (( WINDOWS )); then
  mk_bundle windows server/bin/tbw-server.exe start.ps1 start.cmd install-latest.ps1 install-latest.cmd README.md
  for t in ffmpeg.exe yt-dlp.exe; do [[ -f "server/bin/$t" ]] && cp "server/bin/$t" "$stage/windows/TheBigWeather-server/server/bin/"; done
  (cd "$stage/windows" && zip -qr "$OUT/tbw-server-$V-windows-x86_64.zip" TheBigWeather-server)
fi
rm -rf "$stage"
cp install-latest.sh install-latest.ps1 install-latest.cmd "$OUT/"
(cd "$OUT" && sha256sum -- * | grep -v ' SHA256SUMS$' > SHA256SUMS)
ls -la "$OUT"

if (( DRY )); then say "dry run: not uploading"; exit 0; fi

if [[ -z "$NOTES" ]]; then
  NOTES="$(mktemp)"
  prev="$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)"
  {
    echo "## TheBigWeather $V"
    echo
    echo "Install or update: Linux \`curl -fsSL https://github.com/$REPO/releases/latest/download/install-latest.sh | bash\`,"
    echo "Windows: download and run \`install-latest.cmd\`. Installed apps update themselves (Settings → Updates)."
    echo
    if [[ -n "$prev" ]]; then echo "### Changes since $prev"; git log --no-merges --format='- %s' "$prev..HEAD" | head -60; fi
  } > "$NOTES"
fi
HEAD_SHA="$(git rev-parse HEAD)"
git branch -r --contains "$HEAD_SHA" 2>/dev/null | grep -q . || echo "    warning: $HEAD_SHA is not pushed; the tag will point at the remote default branch instead (git push first)"
args=(--repo "$REPO" --title "TheBigWeather $V" --notes-file "$NOTES")
(( DRAFT )) && args+=(--draft)
git branch -r --contains "$HEAD_SHA" 2>/dev/null | grep -q . && args+=(--target "$HEAD_SHA")
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  say "release $TAG exists: replacing its assets"
  gh release upload "$TAG" --repo "$REPO" --clobber "$OUT"/*
else
  say "creating release $TAG on $REPO"
  gh release create "$TAG" "${args[@]}" "$OUT"/*
fi
say "done: https://github.com/$REPO/releases/tag/$TAG"
