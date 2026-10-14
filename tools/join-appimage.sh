#!/usr/bin/env bash
# Rebuilds TheBigWeather files from their parts and checks them.
# Usage:
#   - builds branch (downloaded as a ZIP): run bash join-appimage.sh [FILE...] in its folder; it
#     joins parts/<file>.partNN into <file> for every file (or the ones named) and checks SHA256SUMS.
#   - plain parts sent in chat: put this next to the <file>.partNN files and SHA256SUMS, then run it.
#   - zipped release parts: put this next to the …AppImage.partN.zip files (and SHA256.txt), then run it.
set -euo pipefail
cd "$(dirname "$0")"
PD=parts
[[ -d parts ]] || PD=.
if [[ -f SHA256SUMS ]] && compgen -G "$PD/*.part[0-9][0-9]" >/dev/null; then
  if (( $# )); then names=("$@"); else mapfile -t names < <(awk '{print $2}' SHA256SUMS); fi
  bad=0
  for name in "${names[@]}"; do
    ps=("$PD/$name".part[0-9][0-9])
    if [[ ! -f "${ps[0]}" ]]; then [[ $PD == . && $# -eq 0 ]] && continue; echo "No parts for $name"; bad=1; continue; fi
    cat "${ps[@]}" > "$name.joining"
    want="$(awk -v n="$name" '$2==n {print $1}' SHA256SUMS)"
    got="$(sha256sum "$name.joining" | cut -d' ' -f1)"
    if [[ "$want" != "$got" ]]; then echo "Checksum mismatch for $name: a part is incomplete"; rm -f "$name.joining"; bad=1; continue; fi
    mv -f "$name.joining" "$name"
    case "$name" in *.AppImage|tbw-server-*-linux-x86_64|tbw-server-*-linux-aarch64) chmod +x "$name" ;; esac
    echo "OK: $name (checksum verified)"
  done
  exit "$bad"
fi
first=$(ls -1 TheBigWeather-*-x86_64.AppImage.part0.zip 2>/dev/null | sort -V | tail -1)
[ -n "$first" ] || { echo "Put this script next to the TheBigWeather-…AppImage.partN.zip files (or in the builds branch folder)"; exit 1; }
name=${first%.part0.zip}
tmp=$(mktemp -d)
n=$(ls -1 "$name".part*.zip | wc -l)
for i in $(seq 0 $((n - 1))); do
  z="$name.part$i.zip"
  [ -f "$z" ] || { echo "Missing $z"; exit 1; }
  unzip -o -q "$z" -d "$tmp"
done
# join the raw parts only, in order (never the .zip files)
: > "$name"
for i in $(seq 0 $((n - 1))); do cat "$tmp/$name.part$i" >> "$name"; done
rm -rf "$tmp"
chmod +x "$name"
want=$(grep -F "$name" SHA256.txt 2>/dev/null | cut -d' ' -f1 || true)
[ -n "$want" ] || want=$(head -1 SHA256.txt 2>/dev/null | cut -d' ' -f1 || true)
got=$(sha256sum "$name" | cut -d' ' -f1)
if [ -n "$want" ] && [ "$want" != "$got" ]; then
  echo "Checksum mismatch: a part is incomplete. Re-download the parts and run again."
  exit 1
fi
echo "OK: $name ($( [ -n "$want" ] && echo checksum verified || echo no SHA256.txt to compare ))"
echo "Run it with: ./$name"
