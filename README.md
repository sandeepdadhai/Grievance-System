# MedNotice workspace

Two independent projects share this workspace:

| Directory | Purpose | Dev ports |
| --- | --- | --- |
| `mednotice-global/` | Original multi-jurisdictional platform (US, DE, GB, IN, SG, BR). Unchanged. | web `3000`, API `4000` |
| `mednotice-india/` | India-only replica: one national jurisdiction, national authorities plus Delhi, Maharashtra, Karnataka and Tamil Nadu state health departments, DPDP Act 2023 controls, INR amounts, Hindi triage and NMC registrations. | web `3001`, console `3002`, API `4100` |

Each project has its own `package.json`, lockfile, database directory and demo accounts.

## Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | **22.5 or newer** (24 recommended) | The apps use the built-in `node:sqlite` module, so there is no native module to compile. |
| npm | 10+ | Ships with Node. |
| git | any | To clone the repository. |
| Caddy | 2.x | Optional — only for the production reverse proxy on port 80/443. |
| Terraform + AWS CLI | 1.5+ / 2.x | Optional — only for the automated AWS EC2 deployment. |

Ubuntu / Debian:

```bash
sudo apt-get update
sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # must print v22.5.0 or higher
```

macOS:

```bash
brew install node@24 git
node -v
```

Windows: install the Node 24 LTS installer from nodejs.org, then use WSL2 or Git Bash — every command here is bash.

## Run the main platform (India)

```bash
git clone https://github.com/sandeepdadhai/Grievance-System.git
cd Grievance-System/mednotice-india
npm ci                 # reproducible install from package-lock.json
cp .env.example .env   # optional — every value has a working default
npm run dev            # API :4100, patient UI :3001, staff console :3002
```

* Patient application — <http://localhost:3001>
* Staff console — <http://localhost:3002> (`admin@mednotice.in` / `Admin!2345`)
* API health — <http://localhost:4100/api/health>

No database server, cloud account or API key is needed: the SQLite database, encrypted uploads and message outbox
are created under `mednotice-india/data/` on first start.

Checks:

```bash
npm test           # 106 unit + end-to-end tests
npm run typecheck
```

## Production / single-command deployment

```bash
cd mednotice-india
npm run build        # patient -> client/dist/patient, console -> client/dist/admin, server -> dist/server
npm start            # patient app + API on :4100
npm run start:admin  # staff console + API on 127.0.0.1:4101
```

The full walkthrough — server hardening with systemd and Caddy, the Terraform AWS EC2 deployment, an instant public
URL with `npm run share`, the complete environment-variable reference, backups and troubleshooting — is in
**[mednotice-india/README.md → Setup guide](mednotice-india/README.md#setup-guide--from-zero-to-running)**.

## Run the original global platform

```bash
cd mednotice-global
npm install
npm run dev        # http://localhost:3000
```

See each project's README for architecture, demo accounts and compliance notes.
