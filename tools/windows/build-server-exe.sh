#!/usr/bin/env bash
# Cross-compile tbw-server.exe for Windows (x86_64-pc-windows-gnu) on Linux with mingw-w64,
# and copy it to server/bin/tbw-server.exe (picked up by start.ps1 and the Windows app build).
#
#   tools/windows/build-server-exe.sh
#
# Needs: mingw-w64 (apt-get install mingw-w64) and the Rust std for the target
# (rustup target add x86_64-pc-windows-gnu). When rustup can't download the target std
# (offline mirrors), set TBW_BUILD_STD=1 to build std from the rust-src component instead
# (needs `rustup component add rust-src` or the matching library/ sources in the sysroot).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T=x86_64-pc-windows-gnu
command -v x86_64-w64-mingw32-gcc >/dev/null || { echo "install mingw-w64 first (apt-get install mingw-w64)"; exit 1; }
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
extra=()
if [[ "${TBW_BUILD_STD:-0}" == 1 ]] || ! rustup target list --installed 2>/dev/null | grep -qx "$T"; then
  if ! rustup target add "$T" 2>/dev/null; then
    echo "rustup couldn't add $T: building std from source (-Zbuild-std)"
    export RUSTC_BOOTSTRAP=1
    extra=(-Zbuild-std=std,panic_abort)
  fi
fi
cd "$ROOT/server"
cargo build --release --target "$T" "${extra[@]}"
out="${CARGO_TARGET_DIR:-$ROOT/server/target}/$T/release/tbw-server.exe"
mkdir -p "$ROOT/server/bin"
cp "$out" "$ROOT/server/bin/tbw-server.exe"
x86_64-w64-mingw32-strip "$ROOT/server/bin/tbw-server.exe" 2>/dev/null || true
ls -la "$ROOT/server/bin/tbw-server.exe"
