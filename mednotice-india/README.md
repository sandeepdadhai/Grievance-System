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
npm test             # 52 unit + end-to-end tests (node:test via tsx)
npm run typecheck
```

Node 22.5+ is required (the project uses the built-in `node:sqlite` module, so there is no native dependency).

If you run this project beside the global one, keep the port split: global uses 3000/4000, India uses 3001/4100.

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
| `server/config.ts` | India jurisdiction, health-authority registry, SLA matrix, key bootstrap |
| `server/db.ts` | Schema, typed query helpers, transactions |
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
| `server/routes/` | Public, auth, cases, documents, admin, roles, community, assistant, webhook sink |

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
department. Adding another state or Union Territory is a configuration and seed change — see *Adding a state*.

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
management, community moderation, adapter registry with live payload preview, audit viewer with chain verification,
delivery monitor, compliance workspace with NMC/facility registries and an Aadhaar/PAN masking playground.

**7. Patient self-service**
Self-registration (`POST /api/auth/signup`) creates a `PATIENT` account, records consent, opens a session immediately
and lists all of that patient's cases in `/portal`. Password policy is 12+ characters with mixed case, a digit and a
symbol. Staff accounts remain administrator-provisioned.

**8. Custom roles**
Super administrators compose roles from a permission catalogue (case view/review/route/resolve, delivery, compliance,
community moderation and audit). User, role and adapter administration stay reserved for Super Administrators and are
not assignable to custom roles. A custom role is always derived from one staff capability family
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

**10. Community**
`/community` hosts posts and comments from patients and guests. Guests choose a display name; signed-in users post
under their account name. Topics cover billing, denials of care, documents, feedback, accessibility, privacy and general
experience; guidelines are enforced by length limits, plain-text storage and moderation. Moderators with the
`community.moderate` permission can review every post and comment, edit content (with an audit note), hide or restore
it, or remove it permanently. Hidden and removed content disappears from the public feed and detail pages.

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

## Adding a state

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

## Known limitations (by design for this build)

- Document authenticity uses deterministic structural heuristics and registries, not a trained vision model or an
  external OCR/NLP provider. Findings are explainable but not a substitute for forensic examination.
- External health authorities are simulated (`adapters.simulate=1`); switch to `simulate=0` and supply credentials
  to call real endpoints such as ABDM sandbox or state grievance portals.
- Email is written to a local outbox instead of an SMTP relay.
- SQLite and an in-process notification worker make this a single-node deployment; production would move to
  Postgres/object storage and a durable queue.
- `/api/_sink/webhook` is an unauthenticated local development sink.
