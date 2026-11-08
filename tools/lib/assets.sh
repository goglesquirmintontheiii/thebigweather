# Shared by tools/release.sh and tools/publish-builds.sh (source it; needs bash).
#
#   tbw_collect_assets ROOT VERSION OUT WINDOWS STRICT
#
# Copies the already built files into OUT with their published names:
#   Stormiq-<v>-x86_64.AppImage (+ latest-linux.yml)              app/release
#   Stormiq-<v>-setup.exe (+ .blockmap, latest.yml), Stormiq-<v>-portable.exe
#   (named TheBigWeather-<v>-… before 0.8.2; see tbw_alias_old_names)
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
  _tbw_need "$rel/Stormiq-$V-x86_64.AppImage" "Stormiq-$V-x86_64.AppImage" || return 1
  [[ -f "$rel/latest-linux.yml" ]] && cp "$rel/latest-linux.yml" "$OUT/"
  if (( WINDOWS )); then
    for f in "Stormiq-$V-setup.exe" "Stormiq-$V-setup.exe.blockmap" "Stormiq-$V-portable.exe" latest.yml; do
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
    local d="$stage/$1/Stormiq-server" s
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
    chmod +x "$stage/linux/Stormiq-server/start.sh" "$stage/linux/Stormiq-server/server/bin/tbw-server"
    tar -C "$stage/linux" -czf "$OUT/tbw-server-$V-linux-x86_64.tar.gz" Stormiq-server
  fi
  if (( WINDOWS )) && [[ -f "$ROOT/server/bin/tbw-server.exe" && -f "$ROOT/app/dist/index.html" ]]; then
    _tbw_bundle windows "$ROOT/server/bin/tbw-server.exe" start.ps1 start.cmd install-latest.ps1 install-latest.cmd README.md
    for f in ffmpeg.exe yt-dlp.exe; do [[ -f "$ROOT/server/bin/$f" ]] && cp "$ROOT/server/bin/$f" "$stage/windows/Stormiq-server/server/bin/"; done
    (cd "$stage/windows" && zip -qr "$OUT/tbw-server-$V-windows-x86_64.zip" Stormiq-server)
  fi
  rm -rf "$stage"
  cp "$ROOT/install-latest.sh" "$ROOT/install-latest.ps1" "$ROOT/install-latest.cmd" "$OUT/"
  (cd "$OUT" && sha256sum -- * | grep -v ' SHA256SUMS$' > SHA256SUMS)
}

# 0.8.2 rename: installed 0.8.1 apps look for TheBigWeather-<v>-… names. For a GitHub release,
# hard-link the portable .exe under its old name (0.8.1 portable apps download the release asset by
# name; the AppImage / installer update through latest*.yml, which names the new files) and add it
# to SHA256SUMS. The builds branch lists old names in its manifest instead (tools/publish-builds.sh).
#   tbw_alias_old_names OUT VERSION
tbw_alias_old_names() {
  local OUT="$1" V="$2" n="Stormiq-$2-portable.exe" o="TheBigWeather-$2-portable.exe"
  [[ -f "$OUT/$n" && ! -e "$OUT/$o" ]] || return 0
  ln "$OUT/$n" "$OUT/$o" 2>/dev/null || cp "$OUT/$n" "$OUT/$o"
  (cd "$OUT" && sha256sum -- * | grep -v ' SHA256SUMS$' > SHA256SUMS)
  echo "    $o (same file as $n, for 0.8.1 portable apps)"
}
