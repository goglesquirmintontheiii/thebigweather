#!/usr/bin/env bash
# TheBigWeather server launcher.
#
#   ./start.sh                         set up (first run) and start the server
#   ./start.sh --domain wx.example.com set up HTTPS with Caddy for that domain
#   ./start.sh --install-service       install + start systemd services (runs on boot)
#   ./start.sh --help                  all options
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
BIN_DIR="$SERVER_DIR/bin"
BIN="$BIN_DIR/tbw-server"
DATA_DIR="$SERVER_DIR/data"
CONFIG="$DATA_DIR/config.toml"
CADDY="$BIN_DIR/caddy"
CADDYFILE="$DATA_DIR/Caddyfile"
CADDY_VERSION="2.10.2"
PORT=8787

# ---------- pretty output ----------
if [[ -t 1 ]]; then
  B=$'\e[1m'; DIM=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; N=""
fi
step() { echo "${C}==>${N} ${B}$*${N}"; }
ok()   { echo "    ${G}✓${N} $*"; }
info() { echo "    ${DIM}$*${N}"; }
warn() { echo "    ${Y}!${N} $*"; }
die()  { echo "${R}✗ $*${N}" >&2; exit 1; }

usage() {
  cat <<EOF
${B}TheBigWeather server${N}

Usage: ./start.sh [options]

  --domain NAME        Serve over HTTPS at NAME (Caddy + Let's Encrypt). Needs ports 80/443.
  --email ADDR         Contact email (sent to NWS in the User-Agent, used for Let's Encrypt).
  --lan                Listen on all interfaces without HTTPS (home network use).
  --port N             Server port (default 8787).
  --install-service    Install systemd services so the server starts on boot, then exit.
  --uninstall-service  Remove the systemd services.
  --rebuild            Rebuild the server from source even if a binary exists.
  --new-token          Generate a new app access token.
  --token              Print the app access token.
  --profile            Show the detected hardware profile.
  --replay DIR         Replay a folder of Level II chunk files as a live radar (testing).
  -h, --help           This help.

First run creates server/data/config.toml. Edit it any time and restart.
EOF
}

DOMAIN=""; EMAIL=""; LAN=0; INSTALL=0; UNINSTALL=0; REBUILD=0; NEWTOKEN=0; SHOWTOKEN=0; SHOWPROFILE=0; REPLAY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --lan) LAN=1; shift ;;
    --port) PORT="${2:-8787}"; shift 2 ;;
    --install-service) INSTALL=1; shift ;;
    --uninstall-service) UNINSTALL=1; shift ;;
    --rebuild) REBUILD=1; shift ;;
    --new-token) NEWTOKEN=1; shift ;;
    --token) SHOWTOKEN=1; shift ;;
    --profile) SHOWPROFILE=1; shift ;;
    --replay) REPLAY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || die "This server runs on Linux."

SUDO=""
if [[ $EUID -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

pkg_install() {
  # pkg_install <apt names> -- <dnf names> -- <pacman names>
  local apt=() dnf=() pac=() cur=apt
  for a in "$@"; do
    if [[ "$a" == "--" ]]; then
      if [[ $cur == apt ]]; then cur=dnf; else cur=pac; fi
      continue
    fi
    case $cur in apt) apt+=("$a") ;; dnf) dnf+=("$a") ;; pac) pac+=("$a") ;; esac
  done
  if command -v apt-get >/dev/null; then
    info "apt-get install ${apt[*]}"
    $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${apt[@]}" >/dev/null
  elif command -v dnf >/dev/null; then
    info "dnf install ${dnf[*]}"
    $SUDO dnf install -y -q "${dnf[@]}" >/dev/null
  elif command -v pacman >/dev/null; then
    info "pacman -S ${pac[*]}"
    $SUDO pacman -Sy --noconfirm --needed "${pac[@]}" >/dev/null
  elif command -v zypper >/dev/null; then
    info "zypper install ${apt[*]}"
    $SUDO zypper -n install "${apt[@]}" >/dev/null
  else
    return 1
  fi
}

echo
echo "${B}  TheBigWeather server${N}  ${DIM}$(cat "$SERVER_DIR/VERSION" 2>/dev/null || echo dev)${N}"
echo

# ---------- 1. basic tools ----------
step "Checking basic tools"
need=()
for t in curl tar; do command -v "$t" >/dev/null || need+=("$t"); done
if ((${#need[@]})); then
  warn "missing: ${need[*]} — installing"
  pkg_install "${need[@]}" -- "${need[@]}" -- "${need[@]}" || die "Please install: ${need[*]}"
fi
ok "curl, tar"

# ---------- 2. server binary ----------
step "Preparing the server binary"
mkdir -p "$BIN_DIR" "$DATA_DIR"

bin_works() { [[ -x "$BIN" ]] && "$BIN" --version >/dev/null 2>&1; }

src_newer() {
  [[ -d "$SERVER_DIR/src" && -x "$BIN" ]] || return 1
  [[ -n "$(find "$SERVER_DIR/src" "$SERVER_DIR/Cargo.toml" "$SERVER_DIR/data/level3_products.json" -newer "$BIN" -print -quit 2>/dev/null)" ]]
}

build_from_source() {
  info "building from source (first build takes a few minutes)"
  if ! command -v cc >/dev/null 2>&1 || ! command -v pkg-config >/dev/null 2>&1 || ! command -v cmake >/dev/null 2>&1; then
    info "installing compiler toolchain"
    pkg_install build-essential pkg-config cmake clang -- gcc gcc-c++ make pkgconf-pkg-config cmake clang -- base-devel pkgconf cmake clang \
      || die "Could not install build tools. Install gcc, make, pkg-config and cmake, then re-run."
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
      export PATH="$HOME/.cargo/bin:$PATH"
    else
      info "installing Rust (rustup, current user only)"
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
      export PATH="$HOME/.cargo/bin:$PATH"
    fi
  fi
  ok "rust $(cargo --version | awk '{print $2}')"
  local jobs
  jobs=$(nproc 2>/dev/null || echo 2)
  # leave a core free on small machines so the box stays responsive while building
  if (( jobs > 2 )); then jobs=$((jobs - 1)); fi
  (cd "$SERVER_DIR" && cargo build --release -j "$jobs" 2>&1 | grep -E "^(error|warning: unused)|Compiling tbw|Finished" | sed 's/^/    /') \
    || die "Build failed. See the errors above."
  cp "$SERVER_DIR/target/release/tbw-server" "$BIN"
  ok "built $BIN"
}

if (( REBUILD )) || ! bin_works; then
  if [[ -x "$BIN" ]] && ! bin_works; then warn "bundled binary doesn't run on this system — rebuilding"; fi
  build_from_source
elif src_newer && command -v cargo >/dev/null 2>&1; then
  warn "source changed since last build — rebuilding"
  build_from_source
else
  ok "using $("$BIN" --version)"
fi

# ---------- small commands ----------
if (( SHOWTOKEN )); then "$BIN" -c "$CONFIG" token; exit 0; fi
if (( NEWTOKEN )); then
  echo "New token: $("$BIN" -c "$CONFIG" new-token)"
  warn "Apps using the old token must be updated. Restart the server to apply."
  exit 0
fi
if (( SHOWPROFILE )); then "$BIN" -c "$CONFIG" profile; exit 0; fi

# ---------- 3. config ----------
step "Configuration"
set_cfg() { # set_cfg key value  (string values; keys are unique in the file)
  local k="$1" v="$2"
  if grep -qE "^$k = " "$CONFIG"; then
    sed -i "s|^$k = .*|$k = \"$v\"|" "$CONFIG"
  fi
}
get_cfg() { grep -E "^$1 = " "$CONFIG" 2>/dev/null | head -1 | sed -E 's/^[^=]+= *"?([^"]*)"?.*/\1/'; }

FIRST_RUN=0
if [[ ! -f "$CONFIG" ]]; then
  FIRST_RUN=1
  "$BIN" -c "$CONFIG" token >/dev/null
  ok "created $CONFIG"
  if [[ -z "$DOMAIN" && -z "$EMAIL" && $LAN -eq 0 && -t 0 ]]; then
    echo
    echo "    ${B}First-run setup${N} ${DIM}(press Enter to skip any question)${N}"
    read -r -p "    Domain for HTTPS (e.g. wx.example.com, blank = none): " DOMAIN || true
    read -r -p "    Contact email for the NWS API (recommended): " EMAIL || true
    echo
  fi
  set_cfg data_dir "data"
  set_cfg web_dir "../app/dist"
else
  ok "found $CONFIG"
fi

# remember domain choice for later runs
if [[ -n "$DOMAIN" ]]; then
  set_cfg public_url "https://$DOMAIN"
else
  existing="$(get_cfg public_url)"
  if [[ "$existing" == https://* ]] && (( ! LAN )); then DOMAIN="${existing#https://}"; fi
fi
if [[ -n "$EMAIL" ]]; then
  set_cfg user_agent "TheBigWeather/$(cat "$SERVER_DIR/VERSION" 2>/dev/null || echo 0.1) ($EMAIL)"
fi
if [[ -n "$DOMAIN" ]]; then
  set_cfg bind "127.0.0.1:$PORT"
  ok "HTTPS mode for $DOMAIN (server listens on 127.0.0.1:$PORT behind Caddy)"
else
  set_cfg bind "0.0.0.0:$PORT"
  ok "LAN mode: http://<this-machine>:$PORT"
fi
"$BIN" -c "$CONFIG" profile | sed -n 's/^  "\(name\|cores\|ram_gb\|threads\|memory_mb\)": \(.*\),\?$/    profile \1: \2/p' | tr -d ',"' | tr -d '"'

# ---------- 4. HTTPS (Caddy) ----------
if [[ -n "$DOMAIN" ]]; then
  step "HTTPS with Caddy"
  if [[ ! -x "$CADDY" ]]; then
    arch="$(uname -m)"; case "$arch" in x86_64) carch=amd64 ;; aarch64|arm64) carch=arm64 ;; armv7l) carch=armv7 ;; *) die "unsupported arch $arch" ;; esac
    url="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${carch}.tar.gz"
    info "downloading Caddy $CADDY_VERSION"
    tmp="$(mktemp -d)"
    curl -fsSL "$url" -o "$tmp/caddy.tgz" || die "Could not download Caddy from $url"
    tar -xzf "$tmp/caddy.tgz" -C "$tmp" caddy
    mv "$tmp/caddy" "$CADDY"; chmod +x "$CADDY"; rm -rf "$tmp"
  fi
  ok "caddy $("$CADDY" version | awk '{print $1}')"
  if [[ $EUID -ne 0 ]]; then
    if [[ -n "$SUDO" ]]; then
      $SUDO setcap cap_net_bind_service=+ep "$CADDY" 2>/dev/null && ok "allowed Caddy to use ports 80/443" || warn "couldn't setcap Caddy; run as root or use --install-service"
    else
      warn "not root and no sudo: Caddy may not be able to bind ports 80/443"
    fi
  fi
  cat > "$CADDYFILE" <<EOF
{
	${EMAIL:+email $EMAIL}
	admin off
}

$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
  ok "wrote $CADDYFILE"
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow 80/tcp >/dev/null && $SUDO ufw allow 443/tcp >/dev/null && ok "opened ports 80/443 in ufw"
  fi
  if command -v dig >/dev/null 2>&1; then
    ip="$(dig +short "$DOMAIN" | tail -1)"
    [[ -n "$ip" ]] && info "$DOMAIN resolves to $ip" || warn "$DOMAIN doesn't resolve yet — HTTPS will fail until DNS points here"
  fi
fi

# ---------- 5. systemd ----------
if (( UNINSTALL )); then
  step "Removing systemd services"
  $SUDO systemctl disable --now tbw-server.service tbw-caddy.service 2>/dev/null || true
  $SUDO rm -f /etc/systemd/system/tbw-server.service /etc/systemd/system/tbw-caddy.service
  $SUDO systemctl daemon-reload
  ok "removed"
  exit 0
fi

if (( INSTALL )); then
  step "Installing systemd services"
  command -v systemctl >/dev/null || die "systemd not found"
  user="$(id -un)"
  extra=""
  [[ -n "$REPLAY" ]] && extra=" --replay-dir $REPLAY"
  $SUDO tee /etc/systemd/system/tbw-server.service >/dev/null <<EOF
[Unit]
Description=TheBigWeather server
After=network-online.target
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=$SERVER_DIR
ExecStart=$BIN -c $CONFIG$extra
Restart=always
RestartSec=3
Nice=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  if [[ -n "$DOMAIN" ]]; then
    $SUDO tee /etc/systemd/system/tbw-caddy.service >/dev/null <<EOF
[Unit]
Description=TheBigWeather HTTPS (Caddy)
After=network-online.target tbw-server.service
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=$DATA_DIR
Environment=XDG_DATA_HOME=$DATA_DIR/caddy-data
Environment=XDG_CONFIG_HOME=$DATA_DIR/caddy-config
ExecStart=$CADDY run --config $CADDYFILE --adapter caddyfile
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
  fi
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now tbw-server.service >/dev/null
  ok "tbw-server.service running"
  if [[ -n "$DOMAIN" ]]; then
    $SUDO systemctl enable --now tbw-caddy.service >/dev/null
    ok "tbw-caddy.service running"
  fi
  info "logs: journalctl -u tbw-server -f"
fi

# ---------- 6. connection info ----------
TOKEN="$("$BIN" -c "$CONFIG" token)"
if [[ -n "$DOMAIN" ]]; then URL="https://$DOMAIN"; else
  lanip="$(hostname -I 2>/dev/null | awk '{print $1}')"; URL="http://${lanip:-localhost}:$PORT"
fi
step "Connect your apps"
echo "    Server URL : ${B}$URL${N}"
echo "    Token      : ${B}$TOKEN${N}"
if command -v qrencode >/dev/null 2>&1; then
  echo "    Pair code (scan from the Android app later):"
  qrencode -t ANSIUTF8 "tbw://$URL#$TOKEN" | sed 's/^/    /'
fi
echo "    ${DIM}In the desktop app: Settings → Server → add URL + token.${N}"
echo "    ${DIM}A browser at $URL also works (paste the token when asked).${N}"
echo

if (( INSTALL )); then exit 0; fi

# ---------- 7. run ----------
CADDY_PID=""
cleanup() {
  [[ -n "$CADDY_PID" ]] && kill "$CADDY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ -n "$DOMAIN" ]]; then
  if systemctl is-active --quiet tbw-caddy.service 2>/dev/null; then
    info "Caddy already running as a service"
  else
    step "Starting Caddy"
    XDG_DATA_HOME="$DATA_DIR/caddy-data" XDG_CONFIG_HOME="$DATA_DIR/caddy-config" \
      "$CADDY" run --config "$CADDYFILE" --adapter caddyfile >"$DATA_DIR/caddy.log" 2>&1 &
    CADDY_PID=$!
    sleep 1
    kill -0 "$CADDY_PID" 2>/dev/null && ok "Caddy running (log: $DATA_DIR/caddy.log)" || warn "Caddy exited — see $DATA_DIR/caddy.log"
  fi
fi

if systemctl is-active --quiet tbw-server.service 2>/dev/null; then
  warn "tbw-server.service is already running. Stop it first: sudo systemctl stop tbw-server"
  exit 1
fi

step "Starting server ${DIM}(Ctrl+C to stop)${N}"
args=(-c "$CONFIG")
[[ -n "$REPLAY" ]] && args+=(--replay-dir "$REPLAY")
cd "$SERVER_DIR"
"$BIN" "${args[@]}"
