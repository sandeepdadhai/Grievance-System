#!/usr/bin/env bash
#
# Rebuild the site and serve it behind ONE public URL.
#
#   npm run share
#
# What it does, in order:
#   1. installs dependencies if node_modules is missing
#   2. builds the SPA (client/dist) and the API (dist/server)
#   3. restarts the API on $PORT — sessions live in SQLite, so nobody is logged out
#   4. reuses the tunnel that is already running, so the public URL does NOT change
#      (a tunnel is only started when there is no live one, or when it stopped answering)
#   5. prints the URL and writes it to data/tunnel-url.txt
#
# Two tunnel modes, chosen automatically:
#   * CLOUDFLARE_TUNNEL_TOKEN set  -> named tunnel, stable URL = PUBLIC_URL
#                                     (this is the mode that gives you a custom domain)
#   * no token                     -> Cloudflare quick tunnel, random *.trycloudflare.com
#                                     hostname that changes whenever the tunnel restarts
#
# Configuration is read from ./.env when present (and from the environment).

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT=${PORT:-4100}
HOST=127.0.0.1
DATA_DIR=${DATA_DIR:-data}
PID_FILE="$DATA_DIR/web.pid"
LOG_FILE="$DATA_DIR/web.log"
TUNNEL_PID_FILE="$DATA_DIR/tunnel.pid"
TUNNEL_LOG="$DATA_DIR/tunnel.log"
URL_FILE="$DATA_DIR/tunnel-url.txt"
SHARE_FILE="artifacts/share-link.txt"
CLOUDFLARED="./.bin/cloudflared"

mkdir -p "$DATA_DIR" artifacts

log() { printf '\033[36m[share]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[share]\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m[share] %s\033[0m\n' "$*" >&2
  exit 1
}
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
api_up() { curl -fsS -o /dev/null --max-time 3 "http://$HOST:$PORT/api/health" 2>/dev/null; }
url_up() { curl -fsS -o /dev/null --max-time 10 "$1/api/health" 2>/dev/null; }

# ---------------------------------------------------------------- dependencies
if [ ! -d node_modules ]; then
  log "installing dependencies (npm ci)"
  npm ci --no-audit --no-fund
fi

# ------------------------------------------------------------------- build
log "building client and server"
npm run build

# ---------------------------------------------------------- restart the API
if [ -f "$PID_FILE" ]; then
  old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if alive "$old_pid"; then
    cmd=$(ps -o args= -p "$old_pid" 2>/dev/null || true)
    case "$cmd" in
      *dist/server/index.js*)
        log "stopping API (pid $old_pid)"
        kill "$old_pid" 2>/dev/null || true
        for _ in $(seq 1 40); do alive "$old_pid" || break; sleep 0.25; done
        alive "$old_pid" && kill -9 "$old_pid" 2>/dev/null || true
        ;;
      *)
        warn "pid file points at another process ($old_pid), leaving it alone"
        ;;
    esac
  fi
  rm -f "$PID_FILE"
fi

if api_up; then
  die "port $PORT is already serving another API process. Stop it first, then run npm run share again."
fi

log "starting API on :$PORT"
setsid nohup node dist/server/index.js >>"$LOG_FILE" 2>&1 </dev/null &
echo $! >"$PID_FILE"
api_pid=$(cat "$PID_FILE")

for _ in $(seq 1 60); do api_up && break; sleep 0.5; done
if ! api_up; then
  tail -20 "$LOG_FILE" >&2 || true
  die "API did not become healthy on http://$HOST:$PORT"
fi
log "API healthy (pid $api_pid), audit chain: $(curl -fsS "http://$HOST:$PORT/api/health" | sed -E 's/.*"auditChain":\{([^}]*)\}.*/\1/')"

# --------------------------------------------------------------- the tunnel
if [ ! -x "$CLOUDFLARED" ] && [ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  mkdir -p .bin
  case "$(uname -s)" in
    Linux) cf_os=linux ;;
    Darwin) cf_os=darwin ;;
    *) die "unsupported OS: $(uname -s) — install cloudflared yourself and put it at $CLOUDFLARED" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) cf_arch=amd64 ;;
    aarch64 | arm64) cf_arch=arm64 ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac
  log "downloading cloudflared ($cf_os-$cf_arch)"
  curl -fsSL -o "$CLOUDFLARED" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-$cf_os-$cf_arch"
  chmod +x "$CLOUDFLARED"
fi

stop_stale_tunnel() {
  [ -f "$TUNNEL_PID_FILE" ] || return 0
  stale=$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)
  if alive "$stale"; then
    cmd=$(ps -o args= -p "$stale" 2>/dev/null || true)
    case "$cmd" in
      *cloudflared*)
        log "stopping stale tunnel (pid $stale)"
        kill "$stale" 2>/dev/null || true
        for _ in $(seq 1 20); do alive "$stale" || break; sleep 0.25; done
        ;;
    esac
  fi
  rm -f "$TUNNEL_PID_FILE"
}

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  # Named tunnel: the hostname is configured in the Cloudflare dashboard and never changes.
  [ -n "${PUBLIC_URL:-}" ] || die "CLOUDFLARE_TUNNEL_TOKEN is set but PUBLIC_URL is not. Set PUBLIC_URL=https://your.domain (no trailing slash)."
  PUBLIC_URL=${PUBLIC_URL%/}

  if url_up "$PUBLIC_URL"; then
    log "named tunnel already serving $PUBLIC_URL"
    public_url=$PUBLIC_URL
  else
    stop_stale_tunnel
    log "starting named tunnel for $PUBLIC_URL"
    setsid nohup "$CLOUDFLARED" tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" >>"$TUNNEL_LOG" 2>&1 </dev/null &
    echo $! >"$TUNNEL_PID_FILE"
    for _ in $(seq 1 60); do url_up "$PUBLIC_URL" && break; sleep 1; done
    url_up "$PUBLIC_URL" || {
      tail -20 "$TUNNEL_LOG" >&2 || true
      die "named tunnel did not start serving $PUBLIC_URL — check the token and the public hostname in the dashboard"
    }
    public_url=$PUBLIC_URL
  fi
else
  # Quick tunnel: keep the current hostname for as long as that process lives.
  existing=""
  [ -f "$URL_FILE" ] && existing=$(head -1 "$URL_FILE" 2>/dev/null || true)

  if [ -n "$existing" ] && url_up "$existing"; then
    log "reusing live tunnel (URL unchanged)"
    public_url=$existing
  else
    stop_stale_tunnel
    : >"$TUNNEL_LOG"
    log "opening a new quick tunnel (this changes the public URL)"
    setsid nohup "$CLOUDFLARED" tunnel --url "http://$HOST:$PORT" --no-autoupdate >>"$TUNNEL_LOG" 2>&1 </dev/null &
    echo $! >"$TUNNEL_PID_FILE"
    public_url=""
    for _ in $(seq 1 60); do
      public_url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
      [ -n "$public_url" ] && break
      sleep 1
    done
    [ -n "$public_url" ] || {
      tail -20 "$TUNNEL_LOG" >&2 || true
      die "cloudflared did not report a public URL"
    }
    for _ in $(seq 1 30); do url_up "$public_url" && break; sleep 1; done
    url_up "$public_url" || die "tunnel $public_url is not answering yet — check $TUNNEL_LOG"
    warn "quick tunnel hostname changes if this tunnel is restarted; a named tunnel keeps one URL"
  fi
fi

# ------------------------------------------------------------------- report
echo "$public_url" >"$URL_FILE"
{
  echo "MedNotice India — public demo link"
  echo "$public_url"
  echo
  echo "API: node dist/server/index.js on $HOST:$PORT"
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    echo "Tunnel: named (stable hostname)"
  else
    echo "Tunnel: quick tunnel (hostname changes only if the tunnel restarts)"
  fi
  echo "Rebuilt (UTC): $(date -u +'%Y-%m-%d %H:%M')"
  echo "Facility demo: facility.aiims@mednotice.in / Facility!2345"
} >"$SHARE_FILE"

log "public URL: $public_url"
log "link file:  $SHARE_FILE"
log "rebuild again any time with: npm run share"
