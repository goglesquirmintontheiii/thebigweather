#!/usr/bin/env bash
# Rebuilds TheBigWeather AppImage from its zipped parts and checks it.
# Usage: put this next to the 5 part zips (and SHA256.txt), then: bash join-appimage.sh
set -euo pipefail
cd "$(dirname "$0")"
name=TheBigWeather-0.2.1-x86_64.AppImage
tmp=$(mktemp -d)
for i in 0 1 2 3 4; do
  z="$name.part$i.zip"
  [ -f "$z" ] || { echo "Missing $z"; exit 1; }
  unzip -o -q "$z" -d "$tmp"
done
# join the raw parts only, in order (never the .zip files)
cat "$tmp/$name.part0" "$tmp/$name.part1" "$tmp/$name.part2" "$tmp/$name.part3" "$tmp/$name.part4" > "$name"
rm -rf "$tmp"
chmod +x "$name"
want=$(cut -d' ' -f1 SHA256.txt 2>/dev/null || true)
got=$(sha256sum "$name" | cut -d' ' -f1)
if [ -n "$want" ] && [ "$want" != "$got" ]; then
  echo "Checksum mismatch: a part is incomplete. Re-download the parts and run again."
  exit 1
fi
echo "OK: $name ($( [ -n "$want" ] && echo checksum verified || echo no SHA256.txt to compare ))"
echo "Run it with: ./$name"
