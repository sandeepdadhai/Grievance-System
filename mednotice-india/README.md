# MedNotice India

India-only patient grievance and case-management platform. Patients across the country file complaints and upload
medical records; the platform screens documents for tampering, extracts structured fields, assigns a clinical
priority and category, routes the case to MoHFW, the National Health Authority or the relevant State Health
Department, and keeps a hash-chained audit trail for every access and decision.

Runs offline with synthetic data — no cloud services or API keys required.

This is a standalone project. The multi-jurisdictional version lives alongside it in `../mednotice-global`.

---

## Quick start

```bash
npm install
npm run dev          # API on :4100 + Vite on :3001
# open http://localhost:3001
```

Production build:

```bash
npm run build        # client -> client/dist, server -> dist/server
npm start            # Express serves the SPA and the API on :4100
```

Tests and typecheck:

```bash
npm test             # 60 unit + end-to-end tests (node:test via tsx)
npm run typecheck
```

Node 22.5+ is required (the project uses the built-in `node:sqlite` module, so there is no native dependency).

If you run this project beside the global one, keep the port split: global uses 3000/4000, India uses 3001/4100.

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

If you only touched React code you can run `npm run build` on its own — Express reads `client/dist` from disk — but `npm run share` is the safe default because a server-side change needs the restart.

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
| `server/notifications.ts` | Persisted queue, retry/backoff, email outbox, signed webhooks |
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
