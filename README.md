# MedNotice workspace

Two independent projects share this workspace:

| Directory | Purpose | Dev ports |
| --- | --- | --- |
| `mednotice-global/` | Original multi-jurisdictional platform (US, DE, GB, IN, SG, BR). Unchanged. | web `3000`, API `4000` |
| `mednotice-india/` | India-only replica: one national jurisdiction, national authorities plus Delhi, Maharashtra, Karnataka and Tamil Nadu state health departments, DPDP Act 2023 controls, INR amounts, Hindi triage and NMC registrations. | web `3001`, API `4100` |

Each project has its own `package.json`, lockfile, database directory and demo accounts. Install and run them
independently:

```bash
# India-only platform
cd mednotice-india
npm install
npm run dev        # http://localhost:3001

# Original global platform
cd mednotice-global
npm install
npm run dev        # http://localhost:3000
```

Both use a local SQLite database under each project's `data/` directory and require no cloud services or API keys.
See each project's README for architecture, demo accounts and compliance notes.
