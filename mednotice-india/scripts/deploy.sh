#!/usr/bin/env bash
#
# MedNotice India — one-command deployment.
#
#   ./scripts/deploy.sh          # from mednotice-india/
#   npm run deploy               # same thing
#
# What it does, in order:
#   1. checks that the server is reachable over SSH
#   2. pulls the branch, installs dependencies and builds both front ends
#   3. writes /etc/mednotice.env, keeping secrets that are already on the server
#   4. writes both systemd units and the Caddy reverse proxy, then restarts them
#   5. waits for /api/health and verifies both public URLs from your machine
#
# Edit the settings block below once. After that the same command deploys every
# later change. Any setting can also be overridden for a single run:
#
#   SSH_HOST=203.0.113.10 ADMIN_BASIC_PASSWORD='a-new-password' ./scripts/deploy.sh
#
set -euo pipefail

# ------------------------------- settings ---------------------------------

# Where to deploy
SSH_HOST="${SSH_HOST:-54.79.127.229}"       # Public IPv4 of the server (auto-assigned: changes if the instance is stopped)
SSH_USER="${SSH_USER:-ubuntu}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/terraform-key.pem}"

# What to deploy
GIT_BRANCH="${GIT_BRANCH:-main}"
REMOTE_REPO="${REMOTE_REPO:-/srv/mednotice/Grievance-System}"
APP_SUBDIR="${APP_SUBDIR:-mednotice-india}"
DATA_DIR_REMOTE="${DATA_DIR_REMOTE:-/var/lib/mednotice}"

# How it is exposed
PUBLIC_URL="${PUBLIC_URL:-http://$SSH_HOST}"   # patient origin, no port (Caddy serves :80 and, with a Let's Encrypt IP certificate, :443)
PATIENT_PORT="${PATIENT_PORT:-4102}"           # patient Node process, behind Caddy
ADMIN_PORT="${ADMIN_PORT:-4100}"               # staff console origin — open this port in the firewall
ADMIN_BIND="${ADMIN_BIND:-0.0.0.0}"            # use 127.0.0.1 to keep the console private to the box

# Console credentials and policy
ADMIN_BASIC_USER="${ADMIN_BASIC_USER:-admin}"
ADMIN_BASIC_PASSWORD="${ADMIN_BASIC_PASSWORD:-admin@123}"   # set to "" to keep the password already on the server
ADMIN_ALLOWED_IPS="${ADMIN_ALLOWED_IPS:-}"         # e.g. 203.0.113.4,198.51.100.7 — empty = no IP filter

# Node runtime
RUN_MODE="${RUN_MODE:-development}"            # production needs HTTPS: the session cookie is Secure

# Post-deploy checks (1 = on, 0 = skip)
VERIFY="${VERIFY:-1}"

# ---------------------------------------------------------------------------

log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }
q() { printf '%q' "$1"; }

command -v ssh >/dev/null 2>&1 || die "ssh is required"
[ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY  (set SSH_KEY=/path/to/key.pem)"
[ -r "$SSH_KEY" ] || die "SSH key is not readable: $SSH_KEY"

SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -p "$SSH_PORT" -i "$SSH_KEY" "$SSH_USER@$SSH_HOST")

log "checking SSH access to $SSH_USER@$SSH_HOST:$SSH_PORT"
"${SSH[@]}" true 2>/dev/null || die "cannot reach $SSH_USER@$SSH_HOST — is the instance running, and is the key correct?"

remote_env="SSH_HOST=$(q "$SSH_HOST") GIT_BRANCH=$(q "$GIT_BRANCH") \
REMOTE_REPO=$(q "$REMOTE_REPO") APP_SUBDIR=$(q "$APP_SUBDIR") DATA_DIR_REMOTE=$(q "$DATA_DIR_REMOTE") \
PUBLIC_URL=$(q "$PUBLIC_URL") PATIENT_PORT=$(q "$PATIENT_PORT") ADMIN_PORT=$(q "$ADMIN_PORT") \
ADMIN_BIND=$(q "$ADMIN_BIND") ADMIN_BASIC_USER=$(q "$ADMIN_BASIC_USER") \
ADMIN_BASIC_PASSWORD=$(q "$ADMIN_BASIC_PASSWORD") ADMIN_ALLOWED_IPS=$(q "$ADMIN_ALLOWED_IPS") \
RUN_MODE=$(q "$RUN_MODE")"

log "deploying branch '$GIT_BRANCH' to $SSH_HOST (patient :$PATIENT_PORT behind Caddy :80, console :$ADMIN_PORT)"
"${SSH[@]}" "$remote_env bash -s" <<'REMOTE'
set -euo pipefail

REPO="$REMOTE_REPO"
APP="$REPO/$APP_SUBDIR"

command -v node >/dev/null 2>&1 || { echo "[remote] node is not installed on this server"; exit 1; }
echo "[remote] node $(node -v)"

# ---------------------------------------------------------------- source
if [ -d "$REPO/.git" ]; then
  sudo git -C "$REPO" fetch --quiet origin
  sudo git -C "$REPO" reset --hard --quiet "origin/$GIT_BRANCH"
else
  echo "[remote] cloning the repository (first run)"
  sudo mkdir -p "$(dirname "$REPO")"
  sudo git clone --quiet --branch "$GIT_BRANCH" https://github.com/sandeepdadhai/Grievance-System.git "$REPO"
fi
echo "[remote] commit: $(sudo git -C "$REPO" log -1 --oneline)"

cd "$APP"

# ---------------------------------------------------------------- build
echo "[remote] installing dependencies"
sudo npm ci --no-audit --no-fund >/tmp/deploy-ci.log 2>&1 || { tail -20 /tmp/deploy-ci.log; exit 1; }

echo "[remote] building the patient app and the staff console"
sudo env VITE_ADMIN_URL="$PUBLIC_URL:$ADMIN_PORT" npm run build >/tmp/deploy-build.log 2>&1 || { tail -30 /tmp/deploy-build.log; exit 1; }
grep -E "dist/(patient|admin)/.*\.(html|js)" /tmp/deploy-build.log | tail -4

# ---------------------------------------------------------------- config
echo "[remote] writing /etc/mednotice.env"
# Email settings are written only when the caller passes them, so an ordinary
# redeploy never clears a mailbox configuration that already lives on the server.
EMAIL_BLOCK=""
EMAIL_MANAGED=""
for name in EMAIL_ENABLED EMAIL_API_URL EMAIL_API_KEY EMAIL_FROM EMAIL_ADMIN_RECIPIENTS EMAIL_SIMULATE; do
  value="${!name:-}"
  [ -n "$value" ] || continue
  EMAIL_BLOCK="${EMAIL_BLOCK}${name}=${value}"$'\n'
  EMAIL_MANAGED="${EMAIL_MANAGED}|${name}"
done

MANAGED="^(NODE_ENV|DATA_DIR|PORT|ADMIN_HOST|ADMIN_PORT|ADMIN_BASIC_USER|ADMIN_BASIC_PASSWORD|ADMIN_ALLOWED_IPS|PUBLIC_URL${EMAIL_MANAGED})="
KEEP=""
EXISTING_PW=""
if sudo test -f /etc/mednotice.env; then
  KEEP=$(sudo grep -Ev "$MANAGED" /etc/mednotice.env || true)
  EXISTING_PW=$(sudo sed -n 's/^ADMIN_BASIC_PASSWORD=//p' /etc/mednotice.env | head -1)
fi

PW="$ADMIN_BASIC_PASSWORD"
[ -n "$PW" ] || PW="$EXISTING_PW"
[ -n "$PW" ] || PW=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | cut -c1-20)

sudo mkdir -p "$DATA_DIR_REMOTE"
sudo chmod 700 "$DATA_DIR_REMOTE"
sudo tee /etc/mednotice.env >/dev/null <<ENV
# Managed by mednotice-india/scripts/deploy.sh — edit the script's settings block, not this file.
NODE_ENV=$RUN_MODE
DATA_DIR=$DATA_DIR_REMOTE
PORT=$PATIENT_PORT
ADMIN_HOST=$ADMIN_BIND
ADMIN_PORT=$ADMIN_PORT
ADMIN_BASIC_USER=$ADMIN_BASIC_USER
ADMIN_BASIC_PASSWORD=$PW
ADMIN_ALLOWED_IPS=$ADMIN_ALLOWED_IPS
PUBLIC_URL=$PUBLIC_URL
$EMAIL_BLOCK
# Everything below was preserved from the previous deployment.
$KEEP
ENV
sudo chmod 600 /etc/mednotice.env

# ---------------------------------------------------------------- services
echo "[remote] writing systemd units"
NODE_BIN=$(command -v node)
sudo tee /etc/systemd/system/mednotice.service >/dev/null <<UNIT
[Unit]
Description=MedNotice India (patient app + API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP
EnvironmentFile=/etc/mednotice.env
ExecStart=$NODE_BIN dist/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/mednotice-admin.service >/dev/null <<UNIT
[Unit]
Description=MedNotice India staff console (separate frontend)
After=network-online.target mednotice.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP
EnvironmentFile=/etc/mednotice.env
ExecStart=$NODE_BIN dist/server/admin.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

echo "[remote] writing the Caddy reverse proxy (:80 plain, :443 TLS -> 127.0.0.1:$PATIENT_PORT)"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
{
	default_sni $SSH_HOST
}

# Plain HTTP stays available: this demo has no domain, and some clients only
# ever request http://.
http://$SSH_HOST {
	reverse_proxy 127.0.0.1:$PATIENT_PORT
}

# Publicly trusted certificate for the bare IP. Let's Encrypt only issues IP
# certificates under the short-lived (6 day) profile, HTTP-01 only, and TLS
# clients send no SNI to an IP, hence default_sni above. Caddy renews it on its
# own; nothing is stored in the repository.
https://$SSH_HOST {
	tls {
		issuer acme {
			profile shortlived
			disable_tlsalpn_challenge
		}
	}
	reverse_proxy 127.0.0.1:$PATIENT_PORT
}
CADDY
sudo caddy validate --config /etc/caddy/Caddyfile >/tmp/deploy-caddy.log 2>&1 || { cat /tmp/deploy-caddy.log; exit 1; }

echo "[remote] restarting services"
sudo systemctl daemon-reload
sudo systemctl enable mednotice mednotice-admin >/dev/null 2>&1
sudo systemctl restart mednotice
sudo systemctl restart mednotice-admin
sudo systemctl restart caddy

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PATIENT_PORT/api/health" >/dev/null 2>&1 && break
  sleep 2
done

echo "[remote] services: $(systemctl is-active mednotice mednotice-admin caddy | tr '\n' ' ')"
curl -fsS "http://127.0.0.1:$PATIENT_PORT/api/health" || { echo "[remote] the API did not become healthy"; journalctl -u mednotice -n 20 --no-pager; exit 1; }
echo
REMOTE

log "services are up"

CONSOLE_PW=$("${SSH[@]}" "sudo sed -n 's/^ADMIN_BASIC_PASSWORD=//p' /etc/mednotice.env | head -1")

if [ "$VERIFY" = "1" ]; then
  log "verifying public endpoints from this machine"
  patient_code=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$PUBLIC_URL/" 2>/dev/null || true)
  console_code=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "http://$SSH_HOST:$ADMIN_PORT/admin" 2>/dev/null || true)
  console_auth=$(curl -s -u "$ADMIN_BASIC_USER:$CONSOLE_PW" -o /dev/null -w '%{http_code}' -m 25 \
    "http://$SSH_HOST:$ADMIN_PORT/admin" 2>/dev/null || true)

  patient_tls=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "https://$SSH_HOST/" 2>/dev/null || true)

  printf '%-12s %-42s %s\n' "patient" "$PUBLIC_URL/" "${patient_code:-000}"
  printf '%-12s %-42s %s\n' "patient-TLS" "https://$SSH_HOST/" "${patient_tls:-000}"
  printf '%-12s %-42s %s\n' "console" "http://$SSH_HOST:$ADMIN_PORT/admin" "${console_code:-000} (with credentials: ${console_auth:-000})"

  [ "$patient_code" = "200" ] || warn "the patient app did not answer 200 — check: ssh $SSH_USER@$SSH_HOST 'journalctl -u mednotice -n 50'"
  if [ "$patient_tls" != "200" ]; then
    warn "https did not answer 200 — check the certificate: ssh $SSH_USER@$SSH_HOST 'journalctl -u caddy -n 50'"
  fi
  if [ "$console_code" = "000" ] || [ "$console_auth" = "000" ]; then
    warn "the console port $ADMIN_PORT is not reachable from the internet."
    warn "the app is running; open TCP $ADMIN_PORT in the firewall/security group, then reload the URL."
    warn "AWS: EC2 -> Security groups -> the instance's group -> Edit inbound rules -> Custom TCP $ADMIN_PORT."
  elif [ "$console_auth" != "200" ]; then
    warn "the console answered $console_auth with the script's credentials — check ADMIN_BASIC_USER/ADMIN_BASIC_PASSWORD"
  fi
fi

cat <<SUMMARY

  Deployed $( "${SSH[@]}" "sudo git -C '$REMOTE_REPO' log -1 --pretty=%h" )

  Patient app    ${PUBLIC_URL}/
                 https://${SSH_HOST}/   (Let's Encrypt IP certificate)
  Staff console  http://${SSH_HOST}:${ADMIN_PORT}/admin

  Console gate   user: ${ADMIN_BASIC_USER}
                 password: ${CONSOLE_PW}
                 (stored in /etc/mednotice.env on the server; set ADMIN_BASIC_PASSWORD to rotate it)

  Staff login    admin@mednotice.in / Admin!2345   (change it under Admin -> Users)
  Logs           ssh ${SSH_USER}@${SSH_HOST} 'journalctl -u mednotice -u mednotice-admin -f'

SUMMARY
