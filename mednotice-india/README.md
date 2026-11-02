# MedNotice India

India-only patient grievance and case-management platform. Patients across the country file complaints and upload
medical records; the platform screens documents for tampering, extracts structured fields, assigns a clinical
priority and category, routes the case to MoHFW, the National Health Authority or the relevant State Health
Department, and keeps a hash-chained audit trail for every access and decision.

Runs offline with synthetic data — no cloud services or API keys required.

This is a standalone project. The multi-jurisdictional version lives alongside it in `../mednotice-global`.

---

## Setup guide — from zero to running

Pick one route:

| Route | Time | Use it when |
| --- | --- | --- |
| [A. Laptop](#a-run-it-on-your-own-machine) | 5 minutes | you want to see the platform working |
| [B. One server](#b-deploy-to-a-linux-server-the-quick-way) | 15 minutes | you want a permanent URL you control |
| [C. AWS EC2 with Terraform](#c-deploy-to-aws-ec2-automatically) | 15 minutes | you want the cloud instance this project was built for |

Nothing is needed beyond Node.js: the app uses the built-in `node:sqlite` module, stores files on disk and runs
the WhatsApp/SMS/email channels in simulation until you add credentials. No database server, no API key, no
cloud account.

---

### Dependencies

| Dependency | Version | Needed for | Install |
| --- | --- | --- | --- |
| **Node.js** | **22.5+** (24 recommended) | the API and both UI builds | see below |
| **npm** | 10+ | install + scripts | ships with Node |
| **git** | any | cloning the repository | `sudo apt-get install -y git` |
| Caddy | 2.x | *optional* — reverse proxy on port 80/443 in production | `sudo apt-get install -y caddy` |
| Terraform | 1.5+ | *optional* — route C only | see [route C](#c-deploy-to-aws-ec2-automatically) |
| AWS CLI | 2.x | *optional* — route C only | see [route C](#c-deploy-to-aws-ec2-automatically) |
| cloudflared | any | *optional* — `npm run share` instant public URL (downloaded by the script) | none |

**Ubuntu / Debian**

```bash
sudo apt-get update
sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # must print v22.5.0 or higher
```

**macOS**

```bash
brew install node@24 git
node -v
```

**Windows** — install the Node 24 LTS installer from nodejs.org, then work inside **WSL2** (Ubuntu) or Git Bash.
Every command below is bash; `node -v` must print v22.5.0 or higher.

---

### A. Run it on your own machine

```bash
# 1. get the code
git clone https://github.com/sandeepdadhai/Grievance-System.git
cd Grievance-System/mednotice-india

# 2. install (reproducible, uses package-lock.json)
npm ci

# 3. optional configuration — every value already has a working default
cp .env.example .env

# 4. start everything
npm run dev
```

| URL | What is there |
| --- | --- |
| <http://localhost:3001> | patient application (hot reload) |
| <http://localhost:3002> | staff console — separate bundle, separate dev server |
| <http://localhost:4100/api/health> | the API both UIs talk to |

The database, uploads and outbox are created under `mednotice-india/data/` on first start and seeded with demo
accounts. Sign in to the console with `admin@mednotice.in` / `Admin!2345` (full list under [Demo accounts](#demo-accounts)).

In development the patient app links to the console through `VITE_ADMIN_URL`, which defaults to the production
console port `4101`; either open <http://localhost:3002> directly, or run
`VITE_ADMIN_URL=http://localhost:3002 npm run dev` so the in-app "Staff console" link works too.

**Checks**

```bash
npm test          # 106 unit + end-to-end tests (node:test via tsx)
npm run typecheck # TypeScript, no emit
```

---

### B. Deploy to a Linux server (the quick way)

Works on any Ubuntu 22.04/24.04 box (EC2, Lightsail, Hetzner, a VM on your laptop). It runs two systemd services
from one checkout — the public patient app and the staff console — behind Caddy.

```bash
# ---- 1. system packages (Ubuntu 24.04) ----
sudo apt-get update -y
sudo apt-get install -y git curl caddy
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# ---- 2. code + build ----
sudo mkdir -p /srv/mednotice && cd /srv/mednotice
sudo git clone https://github.com/sandeepdadhai/Grievance-System.git
cd Grievance-System/mednotice-india
sudo npm ci --no-audit --no-fund
sudo env VITE_ADMIN_URL="http://<SERVER-IP>:4101" npm run build

# ---- 3. data directory + configuration ----
sudo mkdir -p /var/lib/mednotice && sudo chmod 700 /var/lib/mednotice
sudo tee /etc/mednotice.env >/dev/null <<'ENV'
NODE_ENV=production
DATA_DIR=/var/lib/mednotice
PORT=4100
ADMIN_HOST=127.0.0.1
ADMIN_PORT=4101
# Protect the console origin. Generate a password and set BOTH lines:
# ADMIN_BASIC_USER=ops
# ADMIN_BASIC_PASSWORD=replace-me
# Encrypt everything at rest with a key you keep (see "Data and backups"):
# MASTER_KEY=
ENV
sudo chmod 600 /etc/mednotice.env

# ---- 4. the two services ----
sudo tee /etc/systemd/system/mednotice.service >/dev/null <<'UNIT'
[Unit]
Description=MedNotice India (patient app + API)
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

sudo tee /etc/systemd/system/mednotice-admin.service >/dev/null <<'UNIT'
[Unit]
Description=MedNotice India staff console
After=network-online.target mednotice.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/mednotice/Grievance-System/mednotice-india
EnvironmentFile=/etc/mednotice.env
ExecStart=/usr/bin/node dist/server/admin.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now mednotice mednotice-admin

# ---- 5. reverse proxy: port 80 -> patient app ----
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
:80 {
	reverse_proxy 127.0.0.1:4100
}
CADDY
sudo systemctl restart caddy

# ---- 6. check it ----
curl -fsS http://127.0.0.1:4100/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
```

You now have:

| URL | What | Access |
| --- | --- | --- |
| `http://<SERVER-IP>/` | patient application | public |
| `http://127.0.0.1:4101/admin` | staff console | loopback only — reach it with the tunnel below |

**Reaching the console.** It binds to loopback, so it is not reachable from the internet at all. Use an SSH tunnel:

```bash
ssh -L 4101:127.0.0.1:4101 user@<SERVER-IP>
# then open http://localhost:4101 in your browser
```

If staff need a browser URL without SSH, publish it through Caddy on a port you open in the firewall, and keep a
second gate in front of it:

```caddy
:8080 {
	basic_auth {
		# caddy hash-password --plaintext 'your-password'
		ops <bcrypt-hash>
	}
	reverse_proxy 127.0.0.1:4101
}
```

`ADMIN_ALLOWED_IPS=203.0.113.4` (comma-separated) and `ADMIN_BASIC_USER`/`ADMIN_BASIC_PASSWORD` add the same
protection inside the app, so the console stays closed even if the proxy rule is later removed. Staff-role checks
on `/api/admin/*` are the real authorization in every case.

**Updating a running server** — after `git push` on your machine:

```bash
cd /srv/mednotice/Grievance-System
sudo git fetch origin && sudo git reset --hard origin/main
cd mednotice-india
sudo npm ci --no-audit --no-fund
sudo env VITE_ADMIN_URL="http://<SERVER-IP>:4101" npm run build
sudo systemctl restart mednotice mednotice-admin
```

Schema changes are applied automatically at start (`seed()`), and the SQLite file in `DATA_DIR` is kept.

---

### One-command deployment (`npm run deploy`)

`scripts/deploy.sh` performs all of route B for you — and every later update too. Set the values in one block at
the top of the file, then run it whenever you want to ship:

```bash
cd mednotice-india
$EDITOR scripts/deploy.sh     # server address, SSH key, ports, console credentials
npm run deploy                # or: bash scripts/deploy.sh
```

| Setting in the script | Default | Meaning |
| --- | --- | --- |
| `SSH_HOST` | `13.238.120.205` | server address (IP or DNS name) |
| `SSH_USER` / `SSH_PORT` / `SSH_KEY` | `ubuntu` / `22` / `infra/terraform-key.pem` | how to log in |
| `GIT_BRANCH` | `main` | which branch is deployed on the server |
| `REMOTE_REPO` / `APP_SUBDIR` | `/srv/mednotice/Grievance-System` / `mednotice-india` | where the checkout lives |
| `DATA_DIR_REMOTE` | `/var/lib/mednotice` | database, uploads, outbox on the server |
| `PUBLIC_URL` | `http://$SSH_HOST` | public origin of the patient app (no port — Caddy listens on 80) |
| `PATIENT_PORT` | `4102` | patient process behind Caddy |
| `ADMIN_PORT` / `ADMIN_BIND` | `4100` / `0.0.0.0` | staff console origin; open this port in the firewall, or bind `127.0.0.1` to keep it private |
| `ADMIN_BASIC_USER` | `ops` | HTTP Basic user for the console |
| `ADMIN_BASIC_PASSWORD` | empty | empty keeps the existing password; set it to rotate |
| `ADMIN_ALLOWED_IPS` | empty | comma-separated client allowlist for the console |
| `RUN_MODE` | `development` | use `production` only with HTTPS (Secure cookies) |
| `VERIFY` | `1` | `0` skips the post-deploy checks |

Any setting can be overridden for a single run without editing the file:

```bash
SSH_HOST=203.0.113.10 ADMIN_BASIC_PASSWORD='a-new-password' ./scripts/deploy.sh
```

The script is idempotent and safe to re-run. It checks SSH, pulls `GIT_BRANCH`, runs `npm ci`, builds both bundles
with `VITE_ADMIN_URL` pointing at the console origin, writes `/etc/mednotice.env`, installs both systemd units and
the Caddy reverse proxy, restarts everything, waits for `/api/health`, and finally checks both URLs from your
machine.

What it does **not** overwrite: anything already in `/etc/mednotice.env` that it does not manage — `MASTER_KEY`,
`WHATSAPP_*`, `SMS_*`, `EMAIL_*`, `OTP_*`, `AADHAAR_REQUIRED` — is copied forward on every run, and the console
password is generated once and reused.

If the console check reports `000`, the app is running but the port is firewalled. Open TCP `ADMIN_PORT` in the
security group (AWS: **EC2 → Security Groups → the instance's group → Edit inbound rules → Custom TCP 4100**).
Once the rule exists, no redeploy is needed — reload the URL.

---

### C. Deploy to AWS EC2 automatically

`infra/` contains a complete Terraform deployment: an Ubuntu 24.04 `t3.micro`, a separate 10 GB gp3 data volume,
a security group, an SSM role, systemd units and Caddy — all installed by `infra/user-data.sh` on first boot.

**Prerequisites**

```bash
# AWS credentials that may create EC2 resources (put them in mednotice-india/.env)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=ap-southeast-2
```

Terraform 1.5+ and the AWS CLI must be on `PATH`:

```bash
# Ubuntu/Debian
sudo apt-get install -y unzip
curl -fsSL https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_linux_amd64.zip -o /tmp/tf.zip
sudo unzip -o /tmp/tf.zip -d /usr/local/bin
sudo snap install aws-cli --classic   # or: pip install awscli
terraform -version
```

**Deploy**

```bash
cd infra
set -a; . ../.env; set +a          # export the three AWS_* values
./bootstrap.sh                     # one-time: SSM role + instance profile + security group
# put the two ids it prints into terraform.tfvars if they differ from the defaults
terraform init
terraform apply                    # creates the instance; user-data.sh installs and starts everything
./verify.sh "$(terraform output -raw public_ip)" terraform-key.pem
```

`terraform output` prints the URLs and the SSH command:

```bash
terraform output app_url_http     # patient app (Caddy on :80)
terraform output ssh_command      # ssh -i infra/terraform-key.pem ubuntu@<ip>
```

The boot script pins the commit in `var.git_commit` (`infra/variables.tf`). Set it to the commit you want deployed
before `terraform apply`:

```bash
terraform apply -var="git_commit=$(git -C .. rev-parse HEAD)"
```

The instance stops itself nightly and is restarted by `.github/workflows/ec2-schedule.yml` to stay inside the AWS
free tier. Read **[infra/README.md](infra/README.md)** before using it: it documents the org SCP restrictions, the
resources created outside Terraform, the free-tier power schedule, and why the public IP changes on every start
(there is no Elastic IP).

> This deployment currently serves the patient app on port 80. To also expose the staff console, add the Caddy
> `:8080` block from route B and open that port in the security group.

---

### Instant public URL (no server, no account)

```bash
npm run share
```

That builds both bundles, starts the API, opens a free Cloudflare quick tunnel and prints the public
`https://….trycloudflare.com` URL (written to `artifacts/share-link.txt`). It publishes the patient app only and
reuses the running tunnel on every rebuild, so the URL stays the same until the tunnel or machine restarts. Details,
including a named tunnel for a permanent custom domain: [Rebuilding the site and sharing it on one URL](#rebuilding-the-site-and-sharing-it-on-one-url).

---

### Ports, scripts and layout

| Port | Process | Dev | Production |
| --- | --- | --- | --- |
| 3001 | Vite, patient UI | ✓ | — (built files served by the API) |
| 3002 | Vite, staff console | ✓ | — |
| 4100 | `server/index.ts` — patient app + API | ✓ | ✓ (public, via Caddy) |
| 4101 | `server/admin.ts` — console + API | — | ✓ (loopback) |

| Script | What it does |
| --- | --- | --- |
| `npm ci` | clean, lockfile-exact dependency install |
| `npm run dev` | API + patient UI + console UI, all in one terminal |
| `npm run build` | builds both bundles (`build:patient`, `build:admin`) and compiles the server |
| `npm start` | runs the patient app + API from `dist/` |
| `npm run start:admin` | runs the staff console from `dist/` |
| `npm test` / `npm run typecheck` | test suite / TypeScript check |
| `npm run seed` | re-applies schema migrations and demo accounts |
| `npm run share` | build + start + public tunnel URL |

```
mednotice-india/
├── client/            React SPA
│   ├── index.html     patient entry          → dist/patient
│   ├── admin.html     console entry          → dist/admin
│   └── src/           pages, components, auth context
├── server/            Express API (SQLite, no external services)
│   ├── index.ts       patient app entry
│   ├── admin.ts       staff console entry
│   └── routes/        public · auth · cases · documents · admin · community · chat
├── tests/             106 node:test suites
├── infra/             Terraform, bootstrap script, user-data, verify script
└── data/              SQLite DB, uploads, outbox (created on first run, git-ignored)
```

---

### Configuration reference

All settings are environment variables, read from `.env` in development and `/etc/mednotice.env` in production.
Everything has a safe default — the demo runs with no configuration at all.

**Core**

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4100` | patient app + API port |
| `DATA_DIR` | `./data` | SQLite DB, encrypted uploads, outbox, generated key |
| `NODE_ENV` | `development` | `production` enables Secure cookies + HSTS — **requires HTTPS** |
| `PROJECT_ROOT` | `process.cwd()` | override when serving a build from another directory |
| `MASTER_KEY` | generated `0600` file | 32-byte base64 AES-256 key for encryption at rest. **Set this in production** |
| `PUBLIC_URL` | — | public origin used in WhatsApp links |

**Staff console**

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_HOST` | `127.0.0.1` | bind address of the console process |
| `ADMIN_PORT` | `4101` | console port |
| `ADMIN_ALLOWED_IPS` | empty | comma-separated client IPs; everyone else gets 403 |
| `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASSWORD` | empty | HTTP Basic challenge for the whole console origin; set both or neither |
| `VITE_ADMIN_URL` | `http://localhost:4101` | **build-time**: where the patient app links for staff sign-in |

**Patient identity**

| Variable | Default | Purpose |
| --- | --- | --- |
| `AADHAAR_REQUIRED` | `1` | `0` lets submissions through without a verified Aadhaar |
| `OTP_TTL_SECONDS` | `300` | one-time-password lifetime |
| `OTP_MAX_ATTEMPTS` | `5` | wrong-code attempts before the code is burned |
| `SMS_PROVIDER` | `generic` | `generic` (your aggregator) or `twilio` |
| `SMS_API_URL`, `SMS_API_KEY`, `SMS_SENDER_ID` | — | generic SMS gateway (`Authorization: Bearer`) |
| `SMS_TWILIO_SID`, `SMS_TWILIO_TOKEN`, `SMS_TWILIO_FROM` | — | Twilio credentials |
| `SMS_SIMULATE` / `SMS_ENABLED` | `0` / on | force simulation / disable the channel |
| `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` | — | email OTP gateway (Resend, Postmark, SES bridge) |
| `EMAIL_SIMULATE` / `EMAIL_ENABLED` | `0` / on | force simulation / disable the channel |

**Notifications**

| Variable | Default | Purpose |
| --- | --- | --- |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | — | switch WhatsApp from simulation to live delivery |
| `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` | `mednotice_case_update`, `en` | approved template |
| `WHATSAPP_API_VERSION` | `v21.0` | Graph API version |
| `WHATSAPP_DEFAULT_COUNTRY` | `91` | assumed country code |
| `WHATSAPP_SIMULATE` / `WHATSAPP_ENABLED` | `0` / on | force simulation / disable the channel |

**Background work**

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISPATCH_CRON_ENABLED` | on | `0` disables routing retries and status pulls (tests use this) |
| `DISPATCH_INTERVAL_MS` | `60000` | retry tick |
| `STATUS_SYNC_INTERVAL_MS` | `300000` | how often authority statuses are pulled |
| `DISPATCH_RETRY_DELAY_MS` | `300000` | backoff base |
| `DISPATCH_MAX_ATTEMPTS` | `3` | attempts before a transmission is failed |
| `STATUS_REQUEST_TIMEOUT_MS` | `10000` | outbound status request timeout |

Without credentials every channel writes the exact payload to `DATA_DIR/outbox/` and marks it sent with provider
`OUTBOX`, so the whole flow is demonstrable offline. See [WhatsApp delivery](#whatsapp-delivery).

---

### First checks after any deployment

```bash
# 1. API + audit chain
curl -s http://localhost:4100/api/health
#    {"status":"ok",...,"auditChain":{"valid":true,...}}

# 2. staff sign-in (cookie is written to /tmp/mn-cookies.txt)
curl -s -c /tmp/mn-cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"admin@mednotice.in","password":"Admin!2345"}' \
  http://localhost:4100/api/auth/login

# 3. admin API with that session
curl -s -b /tmp/mn-cookies.txt http://localhost:4100/api/admin/stats | head -c 200

# 4. patient UI is served by the API in production
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4100/
```

---

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module 'node:sqlite'` or a syntax error at start | Node is older than 22.5 — install Node 22.5+ and re-run `npm ci` |
| `EADDRINUSE :4100` | another process owns the port: `lsof -i :4100`, stop it or change `PORT` |
| Patient UI returns 404 after a restart | the build is missing — run `npm run build` (serves `client/dist/patient`) |
| Console returns 404 but the API works | build missing, or open `/admin` on the **console** origin, not the patient one |
| Console returns 401 in the browser | `ADMIN_BASIC_*` is set — enter those credentials first, then a staff account |
| Console returns 403 | your IP is not in `ADMIN_ALLOWED_IPS` |
| Staff sign-in works but every API call then 401 | `NODE_ENV=production` without HTTPS: the Secure cookie is dropped. Use HTTPS, or `NODE_ENV=development` while on plain HTTP |
| `403` on any POST/PUT/DELETE | same-origin check — open the UI from the same host and port you are posting to |
| `npm ci` fails after switching machines | delete `node_modules` and re-run; the lockfile is the source of truth |
| Tests fail with a lock or "database is locked" | another app instance is using `DATA_DIR`; the suite uses its own temporary directories |

---

### Data and backups

Everything that matters is in `DATA_DIR` (`./data` in development, `/var/lib/mednotice` in production):

| Path | Contents |
| --- | --- |
| `mednotice.db` (+ `-wal`, `-shm`) | the whole platform: users, cases, documents metadata, audit chain |
| `uploads/` | uploaded files, AES-256-GCM encrypted |
| `outbox/` | simulated email/SMS/WhatsApp payloads |
| `.master.key` | generated encryption key — **only when `MASTER_KEY` is not set** |

Back up by copying the directory (stop the service first, or copy the `-wal` file too), and always store
`MASTER_KEY` separately from the backups — without it the encrypted fields and uploads cannot be read. Generate one
for production with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Reset to a clean demo database: stop the service, `rm -rf data/*`, and start again — the next boot re-seeds.

If you run this project beside the global one, keep the port split: global uses 3000/4000, India uses 3001/4100.

---

## Patient app and staff console (two deployments)

The project builds two independent front ends from one codebase and one API:

| Bundle | Entry | Served by | Default origin |
| --- | --- | --- | --- |
| Patient application | `client/index.html` | `server/index.ts` | `:4100`, public |
| Staff console | `client/admin.html` | `server/admin.ts` | `127.0.0.1:4101`, loopback only |

Both processes use the same SQLite database, storage and outbox. The console bundle contains no patient
pages and the patient bundle contains no console pages, so what an anonymous visitor downloads never
includes the staff UI. The console keeps its `/admin/...` URLs on its own origin, so `/` redirects to
`/admin` there.

Restricting the console:

* `ADMIN_HOST` (default `127.0.0.1`) and `ADMIN_PORT` (default `4101`).
* Reach it without exposing it: `ssh -L 4101:127.0.0.1:4101 ubuntu@<host>`, then open `http://localhost:4101`.
* `ADMIN_ALLOWED_IPS=203.0.113.4,198.51.100.7` rejects other client addresses with 403.
* `ADMIN_BASIC_USER` + `ADMIN_BASIC_PASSWORD` add an HTTP Basic challenge in front of the whole origin;
  setting only one of them fails closed.
* The link in the patient app comes from `VITE_ADMIN_URL`, read at build time:
  `VITE_ADMIN_URL=https://admin.example.org npm run build:patient`.

Role checks on `/api/admin/*` remain the real authorization: hiding a bundle grants nothing, and a
patient session opened on the console origin is signed out and shown the staff sign-in form.

---

## Rebuilding the site and sharing it on one URL

To publish a change, run one command from the project root:

```bash
npm run share
```

That command installs dependencies if `node_modules` is missing, builds the SPA and the API, restarts the API process, **reuses the tunnel that is already running**, then prints the public URL. Because the tunnel is left untouched, the link stays exactly the same across rebuilds. Sessions are stored in SQLite, so people who are signed in are not logged out by a rebuild.

Runtime state and logs it manages (all inside the git-ignored `data/` and `artifacts/`):

| Path | Meaning |
| --- | --- |
| `data/web.pid` / `data/web.log` | API process id and its output |
| `data/tunnel.pid` / `data/tunnel.log` | tunnel process id and its output |
| `data/tunnel-url.txt` | the current public URL |
| `artifacts/share-link.txt` | human-readable link sheet (URL, build time, demo logins) |

If you only touched React code you can run `npm run build` on its own — the patient app reads `client/dist/patient` and the console reads `client/dist/admin` from disk — but `npm run share` is the safe default because a server-side change needs the restart.

### Why the free `*.trycloudflare.com` link changes

A Cloudflare *quick tunnel* is anonymous and tied to one running `cloudflared` process: the hostname exists only while that process lives, and every fresh start is assigned a new random hostname. Rebuilds do not change it (`npm run share` reuses the tunnel), but restarting the tunnel, the machine or the container does. Quick tunnels cannot be given a fixed hostname, so one permanent URL requires a named tunnel on a domain you control.

### Custom domain: named Cloudflare tunnel

Prerequisites: a domain whose DNS is managed by Cloudflare (the free plan is fine), and the app running on the machine that will host the tunnel (`localhost:4100`).

1. **Create the tunnel.** Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → connector **Cloudflared** → give it a name such as `mednotice-india`.
2. **Copy the connector token** from the install page (the long `eyJ...` string). It is a secret: put it only in `.env`, never in Git or a chat message.
3. **Add the public hostname** on the tunnel's **Public Hostname** tab:
   - Subdomain: `grievances`
   - Domain: `yourdomain.com`
   - Path: leave empty
   - Service: **HTTP** → `localhost:4100`
   - Save. Cloudflare creates the DNS record for you; do not add a proxied `A`/`CNAME` record by hand.
4. **Configure the server** in `.env` (already git-ignored):

   ```bash
   NODE_ENV=production
   CLOUDFLARE_TUNNEL_TOKEN=<token from step 2>
   PUBLIC_URL=https://grievances.yourdomain.com
   ```

   `PUBLIC_URL` must be the exact HTTPS hostname with no trailing slash; `scripts/share.sh` uses it to health-check the site and to print the link.
5. **Start it:** `npm run share`. The script detects the token, runs `cloudflared tunnel run --token …`, waits until `https://grievances.yourdomain.com/api/health` returns `200`, and prints that URL. Every later rebuild keeps this URL.
6. **Survive reboots (recommended on a real server):** install cloudflared as a service with the same token —

   ```bash
   sudo cloudflared service install <token from step 2>
   ```

   Once that service is up, `npm run share` sees the URL is already live and does not start a second connector.
7. **Verify:**

   ```bash
   curl -fsS https://grievances.yourdomain.com/api/health
   ```

Notes:

- With `NODE_ENV=production` the session cookie is `Secure`, which requires HTTPS — the tunnel provides it, so keep the production flag on when serving a real domain.
- The app has no built-in account gate: anyone with the URL reaches the demo logins, including admin and authority accounts. Never point a public custom domain at a database you care about; use a throwaway data set and put Cloudflare Access (Zero Trust → **Access** → **Applications**) in front of the hostname if it is meant to stay private.
- If your DNS cannot move to Cloudflare, host the same build on any machine or PaaS with a persistent volume for `data/` (SQLite, uploads and the master key live there). Only `npm run build && npm start` plus a reverse proxy is needed; the tunnel is optional.

### Hosting it properly (no tunnel, one permanent URL)

Step-by-step instructions for Render (recommended), Fly.io, Railway and a plain VPS — including persistent-disk layout, environment variables, custom domains, backups and moving the existing demo data — are in **[docs/hosting.md](docs/hosting.md)**.

---

## Architecture

```
                    ┌──────────────────────────────────────────────────────────┐
 Patient portal     │  React SPA (Vite)                                        │
 (India-wide)       │  intake · upload pre-screen · tracking · admin console   │
                    └───────────────┬──────────────────────────────────────────┘
                                    │ /api (same-origin cookie session)
                    ┌───────────────▼──────────────────────────────────────────┐
 API gateway        │  Express: auth · RBAC · rate limits · CSRF · validation  │
 (server/app.ts)    │  case intake · documents · admin · public tracking       │
                    └───┬──────────┬──────────┬──────────┬──────────┬──────────┘
                        │          │          │          │          │
              ┌─────────▼──┐ ┌─────▼─────┐ ┌──▼───────┐ ┌▼────────┐ ┌▼─────────┐
              │ Verification│ │ Triage    │ │ Routing  │ │Notifier │ │ Audit    │
              │  sub-agent  │ │ engine    │ │ adapters │ │ worker  │ │ chain    │
              └─────┬───────┘ └─────┬─────┘ └──┬───────┘ └┬────────┘ └┬─────────┘
                    │               │          │          │           │
              PDF/image        priority +   FHIR R4 /   email +     SHA-256
              forensics,       category +   HL7 v2 /    signed      hash per
              NMC licence      India SLA    REST / SOAP webhooks    record
              and facility     matrix
              checks
                    └───────────────┴──────────┴──────────┴───────────┘
                            SQLite (WAL) + AES-256-GCM
```

Module boundaries live in `server/`:

| Path | Responsibility |
| --- | --- |
| `server/config.ts` | India jurisdiction, seeded health-authority catalogue, SLA matrix, key bootstrap |
| `server/db.ts` | Schema, typed query helpers, transactions |
| `server/registry.ts` | Runtime directory of health authorities and facilities (DB-backed, seeded from `config.ts`) |
| `server/crypto.ts` | scrypt passwords, field/binary AES-256-GCM, PII masking |
| `server/auth.ts` | Sessions, cookies, role guards, permission guards, India scoping |
| `server/roles.ts` | Permission catalogue, built-in role defaults, custom role resolution |
| `server/chat.ts` | Assistant intent engine, bilingual answers, case-status summaries |
| `server/verification/` | PDF forensics, EXIF/PNG/DICOM checks, field extraction, scoring |
| `server/triage.ts` | Clinical prioritisation + categorisation + Indian regulatory citations |
| `server/adapters/` | FHIR, HL7 v2, REST template, SOAP implementations |
| `server/routing.ts` | Payload masking, transmission, adapter acknowledgement handling |
| `server/notifications.ts` | Persisted queue, retry/backoff, email outbox, signed webhooks, WhatsApp patient notices |
| `server/whatsapp.ts` | WhatsApp Cloud API transport: number normalisation, template/text payloads, simulated outbox |
| `server/audit.ts` | Append-only hash chain and verification |
| `server/routes/` | Public, auth, cases, documents, admin, roles, community, assistant, directory, webhook sink |

---

## Coverage

One national jurisdiction (`IN`) with six receiving authorities:

| Authority | Scope | Adapter |
| --- | --- | --- |
| Ministry of Health and Family Welfare | National | `IN-FHIR` |
| National Health Authority (ABDM / PM-JAY) | National | `IN-REST` |
| Directorate of Health Services, Delhi | Delhi | `IN-REST-DL` |
| Public Health Department, Maharashtra | Maharashtra | `IN-HL7-MH` |
| Health and Family Welfare Department, Karnataka | Karnataka | `IN-REST-KA` |
| Health and Family Welfare Department, Tamil Nadu | Tamil Nadu | `IN-REST-TN` |

Facilities are registered against an authority, so the state selection in the intake form determines the receiving
department. The catalogue above is only the starting point: **admin console → Directory** lets a super administrator
add, edit, retire and delete authorities and facilities at runtime, and every new entry becomes selectable by
patients immediately — no code change or redeploy. See *Managing the directory*.

Frameworks carried through intake, triage and the compliance workspace:

- Digital Personal Data Protection Act 2023
- Clinical Establishments (Registration and Regulation) Act 2010
- Charter of Patients' Rights 2021
- National Medical Commission Act 2019
- Consumer Protection Act 2019

---

## Demo accounts

| Role | Email | Password | Scope |
| --- | --- | --- | --- |
| Super Administrator | `admin@mednotice.in` | `Admin!2345` | All India, users, adapters |
| Ministry Reviewer | `reviewer@mohfw.gov.in` | `Review!2345` | India |
| Hospital Compliance | `compliance@aiims.edu` | `Comply!2345` | India · AIIMS New Delhi |
| System Auditor | `auditor@mednotice.in` | `Audit!2345` | Read-only, PII masked |
| Patient | `patient@demo.in` | `Patient!2345` | Own cases (seeded case 000101) |
| Patient (Hindi) | `rahul.verma@demo.in` | `Patient!2345` | Own cases (seeded Hindi case 000102) |

Guest tracking demo: case `CASE-2026-000101` with access code `DEMO-ACCESS`.

Patients can also register themselves at `/signup` with any name, email and a 12-character password; new accounts are
always `PATIENT` scoped and never receive staff access.

---

## What each module implements

**1. Patient ingestion**
A single India jurisdiction with six authorities and eleven seeded facilities (AIIMS New Delhi, Safdarjung, KEM
Mumbai, NIMHANS, Apollo Chennai, PGIMER, CMC Vellore, Jaslok, St. John's, JIPMER and Fortis Bengaluru) drive dynamic
validation. Guest submissions receive a one-time access code (stored only as a SHA-256 hash); signed-in patients see
their cases in a portal. Preferred language choices include English, Hindi, Marathi, Kannada, Tamil and Bengali. The
browser pre-screens files by magic bytes, extension and SHA-256 before upload.

**2. Document verification**
- PDF: header validity, incremental revisions (`%%EOF`/`startxref`), producer/creator toolchain, creation vs
  modification timestamps, font families and embedding, active content, digital-signature containers, text layer.
- Images: JPEG/PNG/DICOM magic bytes, dimensions, editor metadata (`Photoshop`, `Canva`, …), appended data after
  EOI, concatenated JPEG frames, DICOM tags.
- Cross-checks: NMC state medical register entries (active/suspended/revoked/expired + name match), facility-on-document
  vs complaint target, duplicate SHA-256 across cases, unmasked Aadhaar and PAN patterns.
- Trust score starts at 78 with weighted findings; ≥75 `VERIFIED`, 40–74 `PENDING_MANUAL_REVIEW`, <40
  `REJECTED`. A revoked licence is a hard fail. Bundle status is the worst document status.
- Structured extraction: patient, physician, NMC registration number, ICD-10/ICD-11 code, facility, dates of service
  (Indian dd/mm/yyyy and ISO), MRN.

**3. Triage**
Weighted signals (critical terms such as cardiac arrest or death — including Hindi terms such as मृत्यु, दिल का दौरा
and इलाज से मना — high-acuity terms, vulnerable groups, incident recency, ongoing harm, high-value disputes in ₹)
produce a 0–100 score → P1–P4, mapped to the India SLA matrix (P1 2h, P2 12h, P3 48h, P4 168h). Category assignment
scores seven categories plus the patient's declared prior. Financial-only disputes are capped at P3. Every result
includes the drivers and Indian regulatory basis (Charter of Patients' Rights, Clinical Establishments Act, DPDP Act
2023, Consumer Protection Act 2019, NMC regulations, BNS 2023).

**4. Routing**
- `FHIR` — R4 transaction Bundle (Patient + Task with `stat/urgent/asap/routine` + DocumentReference per file).
- `HL7v2` — ORU^R01 with escaped delimiters and OBX segments for priority, score, narrative, documents.
- `REST` — configuration-driven envelope rendered from `{{caseId}}`, `{{priority}}`, `{{facilityName}}`, etc.
- `SOAP` — SOAP 1.2 envelope with operation/namespace from config.
Adapters are database rows; a new state authority needs no code change. Each transmission is persisted with latency,
HTTP status and masked request/response. `simulate=true` produces deterministic sandbox acknowledgements so the
demo works offline.

**5. Notifications**
Every routed case enqueues email (written to `data/outbox/*.eml` in this build) and webhook deliveries; P1 adds a
duty-officer escalation. Webhooks are HMAC-SHA256 signed with `x-mednotice-signature`. Failures retry with
exponential backoff up to five attempts. Sandbox hosts are delivered to a local inbox so the flow is observable.

**WhatsApp to registered patients.** A patient who has opted in on their portal page gets a WhatsApp message when a
grievance is received and another whenever its status changes (resolved, reopened, or a status pulled from the health
authority). The number is stored AES-256-GCM encrypted on the user record and only ever read back masked; the audit
trail and the communications log hold `+91 ******1000`, never the full number. Messages carry the case reference,
facility, category and status — never the complaint text, documents or internal reviewer notes. Guests and patients
without opt-in are not messaged, and **Turn off** on the portal stops the channel immediately. Delivery uses the
message queue, so a failed send retries with the existing backoff and shows up as failed in the admin notifications
list. See [WhatsApp delivery](#whatsapp-delivery) for credentials.

**6. Admin console**
India-wide metrics (open, P1, SLA breaches, verification queue, SLA compliance, 14-day trend, priority donut,
state and category distributions), filterable case queue, full case file with findings and extracted fields,
document approval/rejection, triage override with SLA recalculation, re-route, resolve/reopen, user and role
management, community moderation, the authority/facility directory, adapter registry with live payload preview,
audit viewer with chain verification, the unified audit trail that merges every hash-chained decision with every
message the platform exchanged, a delivery monitor, a communications log and a compliance workspace with
NMC/facility registries and an Aadhaar/PAN masking playground.

**7. Patient self-service**
Self-registration (`POST /api/auth/signup`) creates a `PATIENT` account, records consent, opens a session immediately
and lists all of that patient's cases in `/portal`. Password policy is 12+ characters with mixed case, a digit and a
symbol. Staff accounts remain administrator-provisioned.

**8. Custom roles**
Super administrators compose roles from a permission catalogue (case view/review/route/resolve, delivery, compliance,
community moderation, audit, adapter configuration and directory management). User, role and adapter administration
stay reserved for Super Administrators and are not assignable to custom roles. A custom role is always derived from one staff capability family
(`MINISTRY_REVIEWER`, `HOSPITAL_COMPLIANCE` or `SYSTEM_AUDITOR`), so it can never exceed that family's data scope, and
it receives only the permissions ticked. Role changes, assignments and deletions are audited; a role in use cannot be
deleted, and built-in roles are immutable. Key endpoints: `GET/POST /api/admin/roles`, `PATCH/DELETE /api/admin/roles/:key`.
Case actions now enforce permissions in addition to the base role — a reviewer without `cases.resolve` cannot override
triage or close a case.

**9. Assistant**
A floating assistant is available on every public page (`POST /api/chat`). It answers questions about intake, documents,
verification, SLA targets, patient rights, privacy, cost and escalation in English or Hindi, warns immediately on
emergency language (108/112, Tele-MANAS 14416) and never gives medical advice. For case status it requires either the
signed-in patient's own case, or a case reference plus access code for guests; unauthorised lookups return no case data
and are audited (`CHAT_CASE_LOOKUP`, `CHAT_CASE_LOOKUP_DENIED`).

**10. Communications log**
**Admin → Communications** is a single chronological stream of every message the platform exchanged with a health
authority — email and webhook notices, case-bundle transmissions, department status pulls and inbound webhooks —
shown with the masked payload that actually left the platform and the chain entry that proves it.

**11. Unified audit trail**
**Admin → Audit log** is one append-only ledger of both the hash-chained decisions and the communications above, so
an auditor asking “what happened to this case?” can read the sequence of human decisions and the messages that carried
them in one place. Messages stay inside the reader’s jurisdiction; the chain itself is global. Readers without the
delivery permission see decisions only and never the message payloads.

**12. Community**
`/community` hosts posts and comments from patients and guests. Guests choose a display name; signed-in users post
under their account name. Topics cover billing, denials of care, documents, feedback, accessibility, privacy and general
experience; guidelines are enforced by length limits, plain-text storage and moderation. Moderators with the
`community.moderate` permission can review every post and comment, edit content (with an audit note), hide or restore
it, or remove it permanently. Hidden and removed content disappears from the public feed and detail pages.

**11. Authority & facility directory**
`/admin/directory` is the administration section for the health authorities and facilities that patients pick during
intake. Two tabs — authorities and facilities — with search, an authority filter, live facility/case counts, and
status badges.

- **Add**: an authority needs a reference (`IN-SHA-GJ`), name, region, adapter, contact email and webhook endpoint;
  a facility needs a reference (`FAC-IN-012`), name, owning authority, city and letterhead keywords used for
  document-tamper detection.
- **Edit**: every field except the reference can be changed in place; the new name is what patients see at intake.
- **Delete**: blocked with a clear reason when facilities or cases still reference the entry — retire it instead
  (`INACTIVE` for authorities, `CLOSED` for facilities) so historical cases keep their reference.
- **Visibility rules**: only `ACTIVE` authorities and `VERIFIED` facilities are offered to patients; a retired
  authority is rejected at submission, not just hidden.
- **Guardrails**: the adapter must exist before it can be assigned, references are immutable, every create, edit and
  delete is written to the hash-chained audit log, and the whole section is gated behind the `registry.manage`
  capability (held by `SUPER_ADMIN`, grantable to a custom role).

Changes take effect immediately: the intake form reads the registry, so a newly added authority and facility can be
selected and used to file a grievance in the same session.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/directory/authorities` | List every authority with facility and case counts |
| `POST /api/admin/directory/authorities` | Create an authority (`registry.manage`) |
| `PATCH /api/admin/directory/authorities/:id` | Edit an authority (`registry.manage`) |
| `DELETE /api/admin/directory/authorities/:id` | Delete an unreferenced authority (`registry.manage`) |
| `GET /api/admin/directory/facilities` | List every facility |
| `POST /api/admin/directory/facilities` | Create a facility (`registry.manage`) |
| `PATCH /api/admin/directory/facilities/:id` | Edit a facility (`registry.manage`) |
| `DELETE /api/admin/directory/facilities/:id` | Delete an unreferenced facility (`registry.manage`) |
| `GET /api/public/jurisdictions` | Intake list of active authorities (public) |
| `GET /api/public/facilities?authority=…` | Intake list of verified facilities (public) |

---

## Security & compliance controls

| Control | Implementation |
| --- | --- |
| Encryption at rest | AES-256-GCM field encryption for narratives/identifiers, envelope encryption for uploaded files, key file `0600` (use `MASTER_KEY` from a KMS in production) |
| Transport | TLS at the edge; `HttpOnly`, `SameSite=Lax`, `Secure` (production) session cookies |
| CSRF | Same-origin enforcement on all mutations, plus SameSite cookies |
| AuthN | scrypt password hashing, 12-hour server-side sessions, session revocation on password change |
| AuthZ | Built-in roles plus permission-scoped custom roles; patients limited to their own cases; reviewers scoped to India; auditors read-only and PII-masked |
| Audit | Append-only SHA-256 hash chain over actor, action, entity, IP, user agent and details; `/api/admin/audit/verify` replays the chain |
| Minimisation | Outbound payloads and stored transmission logs mask names, emails, phones, Aadhaar/PAN and MRNs; client IP and user agent captured |
| Retention | Three-year retention metadata surfaced in the compliance workspace |
| Input safety | Zod validation, 12 MB × 8 file limits, MIME/size checks, parameterised SQL, CSP and security headers |
| Rate limiting | Login, signup, submission, tracking, assistant, community posting and webhook sinks |

DPDP Act 2023 notes: consent is captured at intake, identifiers are minimised before routing, retention is bounded,
and breach-relevant events (access denials, document rejections, review decisions, transmissions) are audited. This
is a reference architecture, not a certification; production deployments need a DPIA, a grievance-redressal
process, KMS-backed keys and legal review under Indian law.

---

## Managing the directory

The catalogue in `server/config.ts` seeds the `authorities` table on first boot. After that the database is the
source of truth, so the usual path for a new state or Union Territory is the admin console:

1. Create the adapter first — **Adapters → New adapter** (protocol, endpoint, mapping). The directory refuses an
   adapter code that does not exist.
2. **Directory → New authority** — reference, name, region (state/UT), adapter, contact email (case notifications go
   here) and the webhook endpoint that receives routed grievances.
3. **Directory → New facility** — reference, name, owning authority, city and letterhead keywords.
4. The new entries appear in the patient intake form straight away. Patients pick the authority, then a verified
   facility under it, and the case is routed to that authority's adapter and mailbox.

Retiring instead of deleting: set an authority to `INACTIVE` or a facility to `CLOSED` to withdraw it from intake
while keeping existing cases intact. Entries that still have facilities or cases cannot be deleted — the API returns
`409` with the reason and the admin console offers retirement.

NMC licence registrations (`physician_licenses`, used by document verification) are still seeded from code, because
they are a registry of individual practitioners rather than a directory entry.

### Adding a state in code (optional)

The runtime path above needs no code change. If you prefer to ship a state as code:

1. Add an authority entry to `IN` in `server/config.ts` (name, state/UT region, adapter code, contact email, webhook).
2. Seed facilities (`facilities`) and NMC registrations (`physician_licenses`) for that state.
3. Add an adapter row (UI → Adapters → New adapter) with protocol, endpoint and mapping; or rely on the
   configuration-only fallback derived from the authority's `adapter` code.
4. Nothing in the verification, triage or audit modules changes.

## WhatsApp delivery

The channel talks to the **WhatsApp Cloud API** (Meta Graph API) directly over HTTPS — no SDK, no extra dependency.
Two values switch it from simulation to live delivery:

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_TOKEN` | Permanent System User access token with `whatsapp_business_messaging` permission |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number id of the sending WhatsApp Business number (not the phone number itself) |
| `WHATSAPP_TEMPLATE_NAME` | Pre-approved message template. Default `mednotice_case_update`; set to an empty string to send free-form text instead (works only inside a 24-hour customer service window or a sandbox) |
| `WHATSAPP_TEMPLATE_LANG` | Template language code, default `en` |
| `WHATSAPP_API_VERSION` | Graph API version, default `v21.0` |
| `WHATSAPP_DEFAULT_COUNTRY` | Country code assumed for numbers typed without one, default `91` |
| `WHATSAPP_SIMULATE` | `1` forces simulation even when credentials are present |
| `WHATSAPP_ENABLED` | `0` disables the channel entirely |
| `PUBLIC_URL` | Origin used for the "Open the case" link in messages |

**Getting the credentials.** In Meta Business Suite → WhatsApp Manager, register the business number, then create a
System User in Business Settings with a permanent token. The phone number id is shown on the API Setup page. Because
business-initiated messages are restricted, create and submit a template with three body parameters, for example:

```
MedNotice India: case {{1}} {{2}}. {{3}}. Open your patient workspace for details.
```

Approval usually takes minutes. Until then use `WHATSAPP_SIMULATE=1` and the outbox.

**Simulation mode (the default).** With no credentials the channel writes the exact payload it would have sent to
`data/outbox/<notification>.wa.json`, marks the notification `SENT` with provider ref `OUTBOX:<file>`, and shows
"Simulation mode" on the patient portal. Nothing leaves the machine, so the whole flow is demonstrable offline.

**What is sent.** One message on submission (`CASE_SUBMITTED`) and one per status change (`CASE_STATUS_CHANGED`: received,
under review, resolved, reopened, or a status pulled from the authority). Only registered patients who opted in are
messaged — the panel lives on the patient portal (**WhatsApp updates**), where the number can be changed or turned off.

**Verifying on a deployment.**

```bash
curl -s http://<host>/api/admin/notifications | jq '.whatsapp'   # channel mode, template, sender hint
curl -s http://<host>/api/admin/notifications | jq '.notifications[] | select(.channel=="WHATSAPP")'
```

With simulation on, `provider_ref` shows `OUTBOX:<file>`; on the instance the file is under
`/var/lib/mednotice/outbox`. With live credentials it shows the WhatsApp message id (`wamh…`) returned by Meta.

## Tests

`npm test` covers:

- AES-256-GCM round-trips, tamper detection, scrypt verification, PII masking.
- PDF/image forensics: clean record, word-processor provenance, Photoshop provenance, revoked/expired licences,
  facility mismatch, renamed files, duplicate digests, unsupported payloads, Indian date extraction.
- Triage: P1 death escalation, maternity denial, Hindi-language emergency narrative, billing cap, privacy and
  infrastructure categories, India SLA matrices.
- Adapters: FHIR bundle shape and priority mapping, HL7 escaping/ACK, REST templates, SOAP escaping, masking.
- End-to-end API: guest submission → verification → routing → tracking, RBAC denial, suspicious bundle held for
  review then approved and routed, SLA recalculation on override, cross-origin rejection, audit-chain integrity,
  and confirmation that outbound payloads contain no direct identifiers.
- Self-service: signup validation, duplicate/weak-password rejection, patient session scope, and denial of staff APIs.
- Roles: custom role creation, assignment, permission gating (case override denied, community allowed), role-in-use and
  built-in role protections, and audit entries for every role action.
- Community: guest and patient posting, comment creation, guest-name validation, hide/edit/restore/permanent removal of
  posts and comments, and disappearance from the public feed.
- Assistant: FAQ intents, emergency escalation, Hindi replies, authorised status lookup by access code and patient
  session, and no case data on an invalid access code.
- Directory: a new authority and facility are created by an administrator, become selectable by patients, accept a
  grievance that routes successfully, and disappear from intake when retired; deletion is blocked while cases or
  facilities reference the entry, and every change is written to the audit chain.

## Known limitations (by design for this build)

- Document authenticity uses deterministic structural heuristics and registries, not a trained vision model or an
  external OCR/NLP provider. Findings are explainable but not a substitute for forensic examination.
- External health authorities are simulated (`adapters.simulate=1`); switch to `simulate=0` and supply credentials
  to call real endpoints such as ABDM sandbox or state grievance portals.
- Email is written to a local outbox instead of an SMTP relay.
- SQLite and an in-process notification worker make this a single-node deployment; production would move to
  Postgres/object storage and a durable queue.
- `/api/_sink/webhook` is an unauthenticated local development sink.
