# Hosting MedNotice India without a tunnel

The app is a single Node process: Express serves the React build and the API on one origin, and the same
process runs the dispatch cron, the authority status sync and the notification worker. That shape rules out
serverless platforms, but it deploys cleanly to any host that gives you an always-on process plus a
persistent disk.

- **Recommended: Render Web Service + persistent disk** — no Docker, no server admin, HTTPS and custom
  domain included. Roughly **$9.50/month** (Starter $7 + a 10 GB disk at $0.25/GB).
- **Cheapest managed: Fly.io** — about **$3.85/month** (shared-cpu-1x 512 MB + a 1 GB volume), but you own the
  Dockerfile and the volume.
- **Full control: a $6 VPS** — Caddy for automatic HTTPS, systemd for supervision.

## What the app requires from the host

| Requirement | Why |
| --- | --- |
| Node **22.5+** | The server uses the built-in `node:sqlite` module, so there is no native dependency. Verified on Node 24. |
| One **always-on** instance | The dispatcher retries failed transmissions every 60 s and sends notifications; a sleeping instance stops doing that. |
| A **writable disk that survives deploys** | SQLite database, AES-256 encrypted uploads, outbox emails and the generated master key all live under `DATA_DIR`. |
| **Exactly one instance** | SQLite and the upload directory are local files. Never scale horizontally. |
| `PORT` from the host, bound to `0.0.0.0` | Already implemented in `server/config.ts` and `server/index.ts`. |
| Health check `GET /api/health` | Returns JSON with the audit-chain status; every option below can poll it. |

Build command `npm ci && npm run build`, start command `npm start`.

Environment variables worth setting in production:

| Variable | Purpose |
| --- | --- |
| `DATA_DIR` | Absolute path to the mounted disk, e.g. `/var/data`. The app creates `storage/` and `outbox/` inside it. |
| `MASTER_KEY` | Base64 of 32 random bytes. Set it **once** and keep it safe — without it, uploaded files cannot be decrypted. If omitted, a key file is generated at `$DATA_DIR/.master.key`. |
| `NODE_ENV` | `production` turns on `Secure` session cookies and HSTS. Requires HTTPS, which every option here provides. |
| `PORT` | Provided by the host (Render/Fly); leave unset locally (`4100`). |

Useful to know before you deploy: `seed()` runs on every boot but is idempotent — it only inserts users and
cases into an empty database, so restarts and redeploys do not wipe your data. Schema changes are applied
automatically at startup against the mounted database.

## Option A — Render (recommended)

### 1. Get the code into a Git repository

Render deploys from Git. The project is already a repository; push it to GitHub/GitLab if it is not there yet.

```bash
git add .
git commit -m "MedNotice India"
git push origin main
```

If the repository contains both `mednotice-india` and `mednotice-global`, note the subdirectory — Render calls
it the **Root Directory**.

### 2. Create the web service

1. Render Dashboard → **New** → **Web Service** → connect the repository.
2. **Root Directory**: `mednotice-india` (skip if that folder is the repository root).
3. **Runtime**: Node. **Region**: the one closest to your users (Singapore for India).
4. **Build Command**: `npm ci && npm run build`
5. **Start Command**: `npm start`
6. **Health Check Path**: `/api/health`
7. **Instance type**: **Starter** (0.5 CPU / 512 MB, $7/mo). The Free instance cannot attach a disk, and it
   spins down after 15 minutes without traffic, which stops the dispatcher and deletes its local files.
8. **Instance count**: 1.

### 3. Add the persistent disk

Service → **Disks** → **Add Disk**:

- Name: `mednotice-data`
- Mount Path: `/var/data`
- Size: `10 GB` (plenty for a demo; disks can grow but cannot shrink)

### 4. Set the environment variables

Service → **Environment**:

```
DATA_DIR=/var/data
NODE_ENV=production
NODE_VERSION=24
MASTER_KEY=<paste the value generated below>
```

Generate the master key once, on your machine, and store it in your password manager:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 5. Deploy and check

Click **Manual Deploy → Deploy latest commit**. In the logs you should see:

```
[mednotice] API listening on http://0.0.0.0:<port>
[mednotice] audit chain: valid
```

Open the `https://<service>.onrender.com` URL, sign in with `admin@mednotice.in` / `Admin!2345`, then upload a
document to confirm the disk is writable. Restart the service once and confirm the case is still there —
that proves the mount, not the container filesystem, is being used.

### 6. Custom domain

Service → **Settings** → **Custom Domains** → **Add Custom Domain**:

1. Enter `grievances.yourdomain.com` and save.
2. Render shows the DNS record to create. At your DNS provider add a **CNAME** from `grievances` to the
   `onrender.com` hostname Render displays. For an apex/root domain (`yourdomain.com`) use the **A/ALIAS**
   record Render shows instead, and delete any conflicting `AAAA` record.
3. Wait for the status to become **Certificate issued** (usually minutes). Render provisions and renews TLS and
   redirects HTTP → HTTPS automatically.

### 7. Shipping updates

```bash
git push origin main
```

Render builds and deploys automatically. A disk-backed service cannot do zero-downtime deploys — Render stops
the old instance before starting the new one, so expect a few seconds of downtime. Sessions live in SQLite, so
signed-in users are not logged out.

### 8. Backups (do not skip)

Render disks are not backed up automatically, and the disk is the only copy of the database, the uploads and the
encryption key. Open the service **Shell** on a schedule and copy `data/` somewhere else, for example:

```bash
cd /var/data && tar czf - mednotice.sqlite storage .master.key | curl -T - https://your-bucket.example/backup.tgz
```

Test a restore at least once before you rely on it.

## Option B — Fly.io (cheapest managed option)

About **$3.69/30 days** for a `shared-cpu-1x` 512 MB machine plus **$0.15/GB-month** for a 1 GB volume. You need the
`flyctl` CLI and a small amount of Docker knowledge; `fly launch` generates the Dockerfile from the Node project.

```bash
# 1. create the app without deploying yet
fly auth login
fly launch --no-deploy --name mednotice-india --region sin

# 2. a volume lives on one machine in one region — SQLite needs exactly that
fly volumes create mednotice_data --app mednotice-india --region sin --size 1
```

Add these sections to the generated `fly.toml` (do not duplicate the ones that are already there):

```toml
[env]
  NODE_ENV = "production"
  DATA_DIR = "/data"

[http_service]
  internal_port = 4100          # keep this equal to the app's PORT
  force_https = true
  auto_stop_machines = "off"    # the dispatcher must keep running
  auto_start_machines = true

[[mounts]]
  source = "mednotice_data"
  destination = "/data"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"
```

Deploy and keep it to one machine:

```bash
fly secrets set MASTER_KEY=<base64 key from Option A step 4>
fly deploy --ha=false
fly scale count 1 --app mednotice-india
fly machine list --app mednotice-india     # must show exactly one machine
```

Custom domain:

```bash
fly certs add grievances.yourdomain.com --app mednotice-india
fly ips list --app mednotice-india         # gives the A / AAAA values to create
```

Create the A (IPv4) and AAAA (IPv6) records it prints at your DNS provider, then check with
`fly certs check grievances.yourdomain.com --app mednotice-india`. Fly issues the certificate once DNS resolves.

Two Fly-specific traps: a volume is bound to one machine, so never add a second machine and expect it to share
the database, and `fly deploy` on a single volume-backed machine restarts it (brief downtime, same as Render).

### Railway (similar to Render, usage-based)

Hobby is **$5/month including $5 of usage**, with volume storage at **$0.15/GB-month** (5 GB included). Create a
service from the repository, set the build/start commands and `DATA_DIR` the same way, attach a volume, and switch
**Serverless** off so the instance never sleeps. Custom domains need both the CNAME and TXT records Railway shows.

## Option C — A small VPS (full control)

A 1 GB DigitalOcean Droplet is **$6/month** (1 vCPU, 25 GB SSD, 1 TB transfer); Hetzner's CX23 offers 2 vCPU /
4 GB / 40 GB for about €5.99 plus VAT when it is available in your region. You get a fixed IPv4 address, so DNS is
a simple A record and nothing depends on a vendor's platform.

### 1. Create the server and point DNS at it

Create an Ubuntu LTS Droplet/Cloud server with your SSH key. Then, at your DNS provider, add an **A** record for
`grievances.yourdomain.com` pointing at the server's public IPv4 (plus an **AAAA** if you enabled IPv6).

### 2. Base setup

```bash
ssh root@SERVER_IP
adduser --disabled-password --gecos "" mednotice
apt update && apt install -y curl git ufw
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw --force enable

# Node 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
```

### 3. Put the app on the server

```bash
mkdir -p /srv/mednotice /var/lib/mednotice
chown -R mednotice:mednotice /srv/mednotice /var/lib/mednotice
su - mednotice
git clone https://github.com/<you>/<repo>.git /srv/mednotice/app
cd /srv/mednotice/app/mednotice-india
npm ci
npm run build
exit
```

### 4. Runtime configuration

Create `/etc/mednotice.env` (mode `600`, owner `mednotice`):

```bash
PORT=4100
DATA_DIR=/var/lib/mednotice
NODE_ENV=production
MASTER_KEY=<base64 key>
```

### 5. Run it under systemd

`/etc/systemd/system/mednotice.service`:

```ini
[Unit]
Description=MedNotice India
After=network.target

[Service]
User=mednotice
Group=mednotice
WorkingDirectory=/srv/mednotice/app/mednotice-india
EnvironmentFile=/etc/mednotice.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
chmod 600 /etc/mednotice.env && chown mednotice:mednotice /etc/mednotice.env
systemctl daemon-reload
systemctl enable --now mednotice
systemctl status mednotice
curl -fsS http://127.0.0.1:4100/api/health
```

### 6. HTTPS with Caddy

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
grievances.yourdomain.com {
    reverse_proxy 127.0.0.1:4100
}
```

```bash
systemctl reload caddy
curl -fsS https://grievances.yourdomain.com/api/health
```

Caddy obtains and renews the certificate automatically once DNS points at the server and ports 80/443 are open.

### 7. Deploying updates

```bash
su - mednotice
cd /srv/mednotice/app && git pull
cd mednotice-india && npm ci && npm run build
exit
systemctl restart mednotice
```

### 8. Backups on a VPS

Everything lives in `/var/lib/mednotice`. A nightly cron entry is enough:

```bash
0 3 * * * tar czf /root/mednotice-$(date +\%F).tgz -C /var/lib mednotice
```

Copy those archives off the server (rsync, object storage, `restic`). Keep `/var/lib/mednotice/.master.key` with
them — it is what makes the encrypted uploads readable later.

## Moving the existing demo data

The database, the encrypted uploads and the master key are the whole state. To carry the current demo over:

1. Stop the app so SQLite is not mid-write (`systemctl stop mednotice`, or `Ctrl-C` locally).
2. Copy `data/mednotice.sqlite`, `data/mednotice.sqlite-wal`, `data/mednotice.sqlite-shm`, `data/storage/`,
   `data/outbox/` and `data/.master.key` into the host's `DATA_DIR`.
3. Either leave `MASTER_KEY` unset (the copied `.master.key` is used) or set `MASTER_KEY` to that key's base64
   value. Never set a *different* key on a copied database — uploads become unreadable and new writes use a key
   you cannot reproduce.
4. Start the app and check `GET /api/health` reports `auditChain.valid: true`.

If you would rather start clean, deploy with an empty directory: the first boot seeds roles, authorities,
facilities, demo users and cases by itself.

## Why not Vercel, Netlify or Cloudflare Pages

Those platforms run request-scoped functions on a read-only filesystem. This app needs a writable disk that keeps
the SQLite file, uploads and encryption key between requests, and a process that keeps ticking when nobody is
browsing (the 60-second dispatch retry, the notification worker, the SLA sweep). You would have to replace SQLite
with a hosted database and move the workers to a queue — a different architecture, not a deployment tweak.

## Before you make it public

The seeded demo accounts include a super administrator (`admin@mednotice.in` / `Admin!2345`), authority reviewers
and facility officers, and their passwords are in the repository. On a public host, either:

- put Cloudflare Access (Zero Trust → Access → Applications), HTTP basic auth in Caddy, or an IP allow-list in
  front of the domain, **or**
- rotate the demo passwords and delete the accounts you do not need before loading any real data.

Also: keep `.env`/`/etc/mednotice.env` out of Git, set `MASTER_KEY`, and remember that the app stores personal
health information — the seeded records are synthetic, and nothing here has been through a compliance review.

## Verification checklist after any deploy

```bash
curl -fsS https://your.domain/api/health                    # 200 + "auditChain":{"valid":true,...}
curl -fsSI https://your.domain/ | head -1                   # 200, and http:// redirects to https://
```

Then in a browser: sign in as a facility account, open **My facility**, verify a pending document, resolve a case,
and confirm the audit page still lists the chain as valid. Finally restart the service and confirm the case,
its documents and the same sign-in still work — that is the test that proves persistent storage.

