#!/usr/bin/env bash
# Publish the built app / server files to the `builds` branch of the repository, so installs and
# auto-updates work without creating a GitHub release.
#
#   tools/publish-builds.sh                    collect what is built (app/release, server/bin, app/dist) and push
#   tools/publish-builds.sh --dry-run          build the branch commit locally (release/builds-branch), don't push
#   tools/publish-builds.sh --from DIR         publish the files in DIR (e.g. release/v0.8.1 from release.sh --dry-run)
#   tools/publish-builds.sh --remote NAME      git remote name or URL/path to push to (default: origin)
#   tools/publish-builds.sh --branch NAME      branch name (default: builds)
#   tools/publish-builds.sh --no-windows       leave out the Windows files
#   tools/publish-builds.sh --part-size 45M    largest part (default 45M; GitHub warns at 50 MB, refuses 100 MB)
#
# Build first (tools/release.sh --dry-run builds and collects everything, or npm run dist / cargo
# build). Needs only git with push access (whatever credentials git already uses), sha256sum, split.
#
# The branch is REPLACED by a single new commit on every publish (force push), so old binaries
# don't pile up in the repository. Layout:
#   manifest.json        {version, date, commit, files: {"<asset>": {size, sha256, parts: [{path, size, sha256}]}}}
#   SHA256SUMS           sha256 of every whole asset
#   parts/<asset>.partNN the asset split in order (cat them together, or use the join scripts)
#   install-latest.*, join-*  installers (they download and join the parts) and offline join scripts
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="origin"; BRANCH="builds"; DRY=0; FROM=""; WINDOWS=1; PART="45M"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --from) FROM="$(cd "$2" && pwd)"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --no-windows) WINDOWS=0; shift ;;
    --part-size) PART="$2"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)"; exit 1 ;;
  esac
done
say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }
for t in git sha256sum split; do command -v "$t" >/dev/null || die "please install $t"; done

# part size in bytes
case "$PART" in
  *[Mm]) PB=$(( ${PART%[Mm]} * 1024 * 1024 )) ;;
  *[Kk]) PB=$(( ${PART%[Kk]} * 1024 )) ;;
  *) PB=$(( PART )) ;;
esac
(( PB > 0 && PB <= 95 * 1024 * 1024 )) || die "--part-size must be between 1 byte and 95M"
(( PB <= 50 * 1000 * 1000 )) || echo "    note: parts over 50 MB make GitHub print a warning"

cd "$ROOT"
V="$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' app/package.json | head -1)"
[[ -n "$V" ]] || die "no version in app/package.json"
CV="$(sed -nE 's/^version = "([^"]+)"/\1/p' server/Cargo.toml | head -1)"
[[ "$V" == "$CV" ]] || echo "    warning: app/package.json ($V) and server/Cargo.toml ($CV) versions differ"
COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
git -C "$ROOT" diff --quiet HEAD 2>/dev/null || echo "    note: the working tree has uncommitted changes (manifest commit = $COMMIT)"

stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
if [[ -n "$FROM" ]]; then
  ASSETS="$FROM"
else
  ASSETS="$stage/assets"
  say "collecting the built files"
  # shellcheck source=lib/assets.sh
  source "$ROOT/tools/lib/assets.sh"
  tbw_collect_assets "$ROOT" "$V" "$ASSETS" "$WINDOWS" 0 || die "collecting failed"
fi

# what goes into parts/ (everything users download; not the updater metadata / installers)
names=()
for f in "$ASSETS"/*; do
  [[ -f "$f" ]] || continue
  n="$(basename "$f")"
  case "$n" in
    SHA256SUMS|latest*.yml|*.blockmap|install-latest.*|join-*) continue ;;
    *-windows-*|*.exe) (( WINDOWS )) || continue ;;
  esac
  names+=("$n")
done
(( ${#names[@]} )) || die "nothing to publish in $ASSETS (build first, or use --from DIR)"

if (( DRY )); then WORK="$ROOT/release/builds-branch"; else WORK="$stage/branch"; fi
rm -rf "$WORK"; mkdir -p "$WORK/parts"
say "splitting ${#names[@]} files into parts of at most $PART"
{
  echo "{"
  echo "  \"version\": \"$V\","
  echo "  \"date\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"commit\": \"$COMMIT\","
  echo "  \"files\": {"
} > "$WORK/manifest.json"
: > "$WORK/SHA256SUMS"
i=0
for n in "${names[@]}"; do
  src="$ASSETS/$n"
  size="$(stat -c %s "$src")"
  sum="$(sha256sum "$src" | cut -d' ' -f1)"
  echo "$sum  $n" >> "$WORK/SHA256SUMS"
  if (( size == 0 )); then : > "$WORK/parts/$n.part00"; else split -b "$PB" -d -a 2 "$src" "$WORK/parts/$n.part"; fi
  i=$((i + 1))
  {
    echo "    \"$n\": { \"size\": $size, \"sha256\": \"$sum\", \"parts\": ["
    first=1
    for pp in "$WORK/parts/$n".part[0-9][0-9]; do
      p="$(basename "$pp")"
      ps="$(stat -c %s "$WORK/parts/$p")"; ph="$(sha256sum "$WORK/parts/$p" | cut -d' ' -f1)"
      (( first )) || echo ","
      printf '      { "path": "parts/%s", "size": %s, "sha256": "%s" }' "$p" "$ps" "$ph"
      first=0
    done
    echo
    if (( i < ${#names[@]} )); then echo "    ] },"; else echo "    ] }"; fi
  } >> "$WORK/manifest.json"
  np=("$WORK/parts/$n".part[0-9][0-9])
  echo "    $n ($(( size / 1024 / 1024 )) MB, ${#np[@]} parts)"
done
printf '  }\n}\n' >> "$WORK/manifest.json"

# installers + offline join scripts at the root
cp "$ROOT/install-latest.sh" "$ROOT/install-latest.ps1" "$ROOT/install-latest.cmd" "$ROOT/tools/join-appimage.sh" "$ROOT/tools/join-windows.ps1" "$ROOT/tools/join-windows.cmd" "$WORK/"
chmod +x "$WORK/install-latest.sh" "$WORK/join-appimage.sh"
cat > "$WORK/README.md" <<EOF
# TheBigWeather $V builds

Automatic build files (commit \`${COMMIT:0:12}\`). This branch is replaced on every publish.

- Linux: \`curl -fsSL https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/$BRANCH/install-latest.sh | bash\`
- Windows: download \`install-latest.cmd\` from this branch and run it.
- By hand: download the branch as a ZIP, then run \`join-appimage.sh\` (Linux) or \`join-windows.cmd\` (Windows)
  to rebuild the files from \`parts/\` (checked against \`SHA256SUMS\`).
EOF

say "creating the $BRANCH commit"
git init -q "$WORK"
git -C "$WORK" checkout -q --orphan "$BRANCH" 2>/dev/null || git -C "$WORK" symbolic-ref HEAD "refs/heads/$BRANCH"
# same identity / credentials / http settings as the main repository
GN="$(git -C "$ROOT" config user.name || echo "TheBigWeather builds")"
GE="$(git -C "$ROOT" config user.email || echo "builds@thebigweather.invalid")"
while read -r k v; do [[ -n "$k" ]] && git -C "$WORK" config --add "$k" "$v"; done < <(git -C "$ROOT" config --local --get-regexp '^(credential|http|url)\.' 2>/dev/null || true)
git -C "$WORK" add -A
git -C "$WORK" -c user.name="$GN" -c user.email="$GE" -c commit.gpgsign=false commit -q -m "TheBigWeather $V builds (main ${COMMIT:0:12})"
SHA="$(git -C "$WORK" rev-parse HEAD)"
big="$(find "$WORK/parts" -type f -size +$(( 95 * 1024 ))k | head -1)"
[[ -z "$big" ]] || die "$big is too big for GitHub"
echo "    commit $SHA ($(du -sh "$WORK/parts" | cut -f1) in parts/)"

if (( DRY )); then
  say "dry run: not pushing. The branch is in $WORK"
  exit 0
fi
if URL="$(git -C "$ROOT" remote get-url "$REMOTE" 2>/dev/null)"; then :; else URL="$REMOTE"; fi
say "pushing $BRANCH to $URL (replaces the previous builds)"
git -C "$WORK" push --force "$URL" "HEAD:refs/heads/$BRANCH"
say "done: version $V, $BRANCH @ ${SHA:0:12}"
case "$URL" in
  *github.com*) echo "    manifest: https://raw.githubusercontent.com/$(printf '%s' "$URL" | sed -E 's#.*github.com[:/]##; s#\.git$##')/$BRANCH/manifest.json" ;;
esac
