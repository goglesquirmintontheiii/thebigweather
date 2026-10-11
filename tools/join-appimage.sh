#!/usr/bin/env bash
# Rebuilds TheBigWeather AppImage from its zipped parts and checks it.
# Usage: put this next to the 5 part zips (and SHA256.txt), then: bash join-appimage.sh
set -euo pipefail
cd "$(dirname "$0")"
first=$(ls -1 TheBigWeather-*-x86_64.AppImage.part0.zip 2>/dev/null | sort -V | tail -1)
[ -n "$first" ] || { echo "Put this script next to the TheBigWeather-…AppImage.partN.zip files"; exit 1; }
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
