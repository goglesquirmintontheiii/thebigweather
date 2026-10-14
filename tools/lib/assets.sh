# Shared by tools/release.sh and tools/publish-builds.sh (source it; needs bash).
#
#   tbw_collect_assets ROOT VERSION OUT WINDOWS STRICT
#
# Copies the already built files into OUT with their published names:
#   TheBigWeather-<v>-x86_64.AppImage (+ latest-linux.yml)        app/release
#   TheBigWeather-<v>-setup.exe (+ .blockmap, latest.yml), TheBigWeather-<v>-portable.exe
#   tbw-server-<v>-linux-x86_64, tbw-server-<v>-windows-x86_64.exe   server/bin
#   tbw-web-<v>.zip                                                   app/dist
#   tbw-server-<v>-linux-x86_64.tar.gz, tbw-server-<v>-windows-x86_64.zip   server bundles
#   install-latest.sh/.ps1/.cmd, SHA256SUMS
# WINDOWS=0 skips the Windows files. STRICT=1 fails on a missing Linux AppImage / server binary;
# STRICT=0 only notes missing files (publish what exists).

tbw_collect_assets() {
  local ROOT="$1" V="$2" OUT="$3" WINDOWS="$4" STRICT="$5"
  local rel="$ROOT/app/release" f
  _tbw_need() { # $1 = source, $2 = destination name
    if [[ -f "$1" ]]; then cp "$1" "$OUT/$2"; return 0; fi
    if (( STRICT )); then echo "error: missing $1" >&2; return 1; fi
    echo "    (missing ${1#"$ROOT"/})"
    return 0
  }
  rm -rf "$OUT"; mkdir -p "$OUT"
  _tbw_need "$rel/TheBigWeather-$V-x86_64.AppImage" "TheBigWeather-$V-x86_64.AppImage" || return 1
  [[ -f "$rel/latest-linux.yml" ]] && cp "$rel/latest-linux.yml" "$OUT/"
  if (( WINDOWS )); then
    for f in "TheBigWeather-$V-setup.exe" "TheBigWeather-$V-setup.exe.blockmap" "TheBigWeather-$V-portable.exe" latest.yml; do
      [[ -f "$rel/$f" ]] && cp "$rel/$f" "$OUT/" || echo "    (missing $f)"
    done
  fi
  _tbw_need "$ROOT/server/bin/tbw-server" "tbw-server-$V-linux-x86_64" || return 1
  if (( WINDOWS )); then
    _tbw_need "$ROOT/server/bin/tbw-server.exe" "tbw-server-$V-windows-x86_64.exe" || return 1
  fi

  # web app zip (files at the root, as the server's self-update expects)
  if [[ -f "$ROOT/app/dist/index.html" ]]; then
    (cd "$ROOT/app/dist" && zip -qr "$OUT/tbw-web-$V.zip" .) || return 1
  else
    (( STRICT )) && { echo "error: app/dist is not built" >&2; return 1; }
    echo "    (missing app/dist)"
  fi

  # server bundles: start scripts + binary + data tables + web app
  local stage; stage="$(mktemp -d)"
  _tbw_bundle() { # $1 = platform dir name, $2 = binary path, rest = scripts
    local d="$stage/$1/TheBigWeather-server" s
    mkdir -p "$d/server/bin" "$d/server/data" "$d/app"
    cp "$2" "$d/server/bin/"
    echo "$V" > "$d/server/VERSION"
    cp "$ROOT"/server/data/camera_sources.json "$ROOT"/server/data/level3_products.json "$ROOT"/server/data/sites.json "$d/server/data/"
    cp -r "$ROOT/app/dist" "$d/app/dist"
    shift 2
    for s in "$@"; do cp "$ROOT/$s" "$d/"; done
  }
  if [[ -f "$ROOT/server/bin/tbw-server" && -f "$ROOT/app/dist/index.html" ]]; then
    _tbw_bundle linux "$ROOT/server/bin/tbw-server" start.sh install-latest.sh README.md
    chmod +x "$stage/linux/TheBigWeather-server/start.sh" "$stage/linux/TheBigWeather-server/server/bin/tbw-server"
    tar -C "$stage/linux" -czf "$OUT/tbw-server-$V-linux-x86_64.tar.gz" TheBigWeather-server
  fi
  if (( WINDOWS )) && [[ -f "$ROOT/server/bin/tbw-server.exe" && -f "$ROOT/app/dist/index.html" ]]; then
    _tbw_bundle windows "$ROOT/server/bin/tbw-server.exe" start.ps1 start.cmd install-latest.ps1 install-latest.cmd README.md
    for f in ffmpeg.exe yt-dlp.exe; do [[ -f "$ROOT/server/bin/$f" ]] && cp "$ROOT/server/bin/$f" "$stage/windows/TheBigWeather-server/server/bin/"; done
    (cd "$stage/windows" && zip -qr "$OUT/tbw-server-$V-windows-x86_64.zip" TheBigWeather-server)
  fi
  rm -rf "$stage"
  cp "$ROOT/install-latest.sh" "$ROOT/install-latest.ps1" "$ROOT/install-latest.cmd" "$OUT/"
  (cd "$OUT" && sha256sum -- * | grep -v ' SHA256SUMS$' > SHA256SUMS)
}
