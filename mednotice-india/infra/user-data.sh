#!/bin/bash
set -euo pipefail

# 1 GiB swap: t3.micro has 1 GiB RAM and the Vite/tsc build needs headroom.
SWAPFILE=/swapfile
if [ ! -f "$SWAPFILE" ]; then
  fallocate -l 1G "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=1024 status=none
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null
  swapon "$SWAPFILE"
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl jq ca-certificates gnupg software-properties-common

# Node 24 (node:sqlite needs >= 22.5)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
{ echo "node $(node -v)"; echo "npm $(npm -v)"; } > /var/log/mednotice-node.txt 2>&1

# ------------------------------------------------------------------ app source
APP=/srv/mednotice
mkdir -p "$APP"
cd "$APP"
if [ -d Grievance-System/.git ]; then
  cd Grievance-System
  git fetch --quiet --all || true
  git checkout -q cc660efc854b1ae79110992fc8e083b1c7b1e306
else
  git clone --quiet https://github.com/sandeepdadhai/Grievance-System.git
  cd Grievance-System
  git checkout -q cc660efc854b1ae79110992fc8e083b1c7b1e306
fi
cd mednotice-india

npm ci --no-audit --no-fund
npm run build

# ------------------------------------------------------------- persistent data
mkdir -p /var/lib/mednotice
chmod 700 /var/lib/mednotice

# Nitro exposes /dev/sdf as /dev/nvme1n1; wait for it, format once, mount.
for _ in $(seq 1 15); do
  DEV=""
  for d in /dev/nvme1n1 /dev/nvme2n1 /dev/xvdf /dev/nvme1n2; do
    if [ -b "$d" ] && ! findmnt -n "$d" >/dev/null 2>&1; then DEV="$d"; break; fi
  done
  if [ -n "$DEV" ]; then
    if ! blkid "$DEV" >/dev/null 2>&1; then mkfs.ext4 -F "$DEV" >/dev/null; fi
    mount "$DEV" /var/lib/mednotice
    grep -q "$DEV" /etc/fstab || echo "$DEV /var/lib/mednotice ext4 defaults,nofail 0 2" >> /etc/fstab
    echo "mounted $DEV at /var/lib/mednotice" >> /var/log/mednotice-data-volume.txt
    break
  fi
  sleep 2
done
chmod 700 /var/lib/mednotice

# ---------------------------------------------------------------- runtime env
cat > /etc/mednotice.env <<'ENV'
NODE_ENV=production
DATA_DIR=/var/lib/mednotice
PORT=4100
ENV
chmod 600 /etc/mednotice.env

cat > /etc/systemd/system/mednotice.service <<'UNIT'
[Unit]
Description=MedNotice India (Express + SQLite)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/mednotice/Grievance-System/mednotice-india
EnvironmentFile=/etc/mednotice.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now mednotice

# --------------------------------------------- reverse proxy (HTTP for now)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy || true

cat > /etc/caddy/Caddyfile <<'CADDY'
:80 {
	reverse_proxy 127.0.0.1:4100
}
CADDY

systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy >/dev/null 2>&1 || true

# ------------------------------------------------------------ readiness gate
for i in $(seq 1 180); do
  if curl -fsS http://127.0.0.1:4100/api/health 2>/dev/null | grep -q '"valid":true'; then
    echo "app healthy after $((i*2))s"
    break
  fi
  sleep 2
done
curl -fsS http://127.0.0.1:4100/api/health || true
