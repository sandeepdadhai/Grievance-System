# MedNotice-Global

Multi-jurisdictional patient grievance and case-management platform. Patients file complaints and upload
medical records; the platform screens documents for tampering, extracts structured fields, assigns a clinical
priority and category, routes the case to the correct hospital or ministry system, and keeps a hash-chained
audit trail for every access and decision.

Runs offline with synthetic data — no cloud services or API keys required.

---

## Feature set

MedNotice Global now carries the same workflows as MedNotice India, applied to
all six configured tenants (US, DE, GB, IN, SG, BR):

* multi-jurisdiction intake with per-country SLA matrices and complaint categories
* document forensics (PDF/image/DICOM), field extraction and licence registry checks
* clinical triage with English, German, Portuguese and Hindi critical-term detection
* adapter routing (FHIR R4, HL7 v2, REST envelopes, SOAP 1.2) with retry, re-route and status polling
* authority directory and facility registry managed at runtime, per-facility workspaces
* patient self-registration with consent capture, patient portal and WhatsApp opt-in
* community forum with guest and patient posts plus moderation
* custom roles built from a capability catalogue, with facility-scoped data access
* communications desk, unified audit trail and tamper-evident hash chain
* in-app assistant that answers questions and looks up a case without leaking identifiers

## Quick start

```bash
npm install
npm run dev          # API on :4000 + Vite on :3000
# open http://localhost:3000
```

Production build:

```bash
npm run build        # client -> client/dist, server -> dist/server
npm start            # Express serves the SPA and the API on :4000
```

Tests and typecheck:

```bash
npm test             # 42 unit + end-to-end tests (node:test via tsx)
npm run typecheck
```

Node 22.5+ is required (the project uses the built-in `node:sqlite` module, so there is no native dependency).

---

## Architecture

```
                    ┌──────────────────────────────────────────────────────────┐
 Patient portal     │  React SPA (Vite)                                        │
 (multi-tenant)     │  intake · upload pre-screen · tracking · admin console   │
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
              licence and      SLA matrix   REST / SOAP webhooks    record
              facility checks
                    └───────────────┴──────────┴──────────┴───────────┘
                                    SQLite (WAL) + AES-256-GCM
```

Module boundaries live in `server/`:

| Path | Responsibility |
| --- | --- |
| `server/config.ts` | Jurisdiction/authority registry, SLA matrix, key bootstrap |
| `server/db.ts` | Schema, typed query helpers, transactions |
| `server/crypto.ts` | scrypt passwords, field/binary AES-256-GCM, PII masking |
| `server/auth.ts` | Sessions, cookies, role guards, jurisdiction scoping |
| `server/verification/` | PDF forensics, EXIF/PNG/DICOM checks, field extraction, scoring |
| `server/triage.ts` | Clinical prioritisation + categorisation + regulatory citations |
| `server/adapters/` | FHIR, HL7 v2, REST template, SOAP implementations |
| `server/routing.ts` | Payload masking, transmission, adapter acknowledgement handling |
| `server/notifications.ts` | Persisted queue, retry/backoff, email outbox, signed webhooks |
| `server/audit.ts` | Append-only hash chain and verification |
| `server/routes/` | Public, auth, cases, documents, admin, webhook sink |

---

## Demo accounts

| Role | Email | Password | Scope |
| --- | --- | --- | --- |
| Super Administrator | `admin@mednotice.demo` | `Admin!2345` | Global, users, adapters |
| Ministry Reviewer | `reviewer@ministry.demo` | `Review!2345` | Germany only |
| Hospital Compliance | `compliance@hospital.demo` | `Comply!2345` | United States only |
| System Auditor | `auditor@mednotice.demo` | `Audit!2345` | Read-only, PII masked |
| Patient | `patient@demo.io` | `Patient!2345` | Own cases (seeded case 000101) |

Guest tracking demo: case `CASE-2026-000101` with access code `DEMO-ACCESS`.

---

## What each module implements

**1. Patient ingestion**
Six jurisdictions (US, DE, GB, IN, SG, BR), nine health authorities and a facility registry drive dynamic
validation. Guest submissions receive a one-time access code (stored only as a SHA-256 hash); signed-in patients
see their cases in a portal. The browser pre-screens files by magic bytes, extension and SHA-256 before upload.

**2. Document verification**
- PDF: header validity, incremental revisions (`%%EOF`/`startxref`), producer/creator toolchain, creation vs
  modification timestamps, font families and embedding, active content, digital-signature containers, text layer.
- Images: JPEG/PNG/DICOM magic bytes, dimensions, editor metadata (`Photoshop`, `Canva`, …), appended data after
  EOI, concatenated JPEG frames, DICOM tags.
- Cross-checks: physician licence registry (active/suspended/revoked/expired + name match), facility-on-document
  vs complaint target, duplicate SHA-256 across cases, unmasked national IDs / payment-card patterns.
- Trust score starts at 78 with weighted findings; ≥75 `VERIFIED`, 40–74 `PENDING_MANUAL_REVIEW`, <40
  `REJECTED`. A revoked licence is a hard fail. Bundle status is the worst document status.
- Structured extraction: patient, physician, licence/NPI, ICD-10/ICD-11 code, facility, dates of service, MRN.

**3. Triage**
Weighted signals (critical terms such as cardiac arrest or death, high-acuity terms, vulnerable groups, incident
recency, ongoing harm, high-value disputes) produce a 0–100 score → P1–P4, mapped to per-jurisdiction SLA hours
(US 1/4/24/72h, DE 2/8/48/120h, …). Category assignment scores seven categories plus the patient's declared
prior. Financial-only disputes are capped at P3. Every result includes the drivers and the regulatory basis.

**4. Routing**
- `FHIR` — R4 transaction Bundle (Patient + Task with `stat/urgent/asap/routine` + DocumentReference per file).
- `HL7v2` — ORU^R01 with escaped delimiters and OBX segments for priority, score, narrative, documents.
- `REST` — configuration-driven envelope rendered from `{{caseId}}`, `{{priority}}`, `{{complaint}}`, etc.
- `SOAP` — SOAP 1.2 envelope with operation/namespace from config.
Adapters are database rows; a new authority needs no code change. Each transmission is persisted with latency,
HTTP status and masked request/response. `simulate=true` produces deterministic sandbox acknowledgements so the
demo works offline.

**5. Notifications**
Every routed case enqueues email (written to `data/outbox/*.eml` in this build) and webhook deliveries; P1 adds a
duty-officer escalation. Webhooks are HMAC-SHA256 signed with `x-mednotice-signature`. Failures retry with
exponential backoff up to five attempts. Sandbox hosts are delivered to a local inbox so the flow is observable.

**6. Admin console**
Global/country-scoped metrics (open, P1, SLA breaches, verification queue, SLA compliance, 14-day trend,
priority donut, country/category distributions), filterable case queue, full case file with findings and extracted
fields, document approval/rejection, triage override with SLA recalculation, re-route, resolve/reopen, user and
role management, adapter registry with live payload preview, audit viewer with chain verification, delivery
monitor, compliance workspace with registries and a masking playground.

---

## Security & compliance controls

| Control | Implementation |
| --- | --- |
| Encryption at rest | AES-256-GCM field encryption for narratives/identifiers, envelope encryption for uploaded files, key file `0600` (use `MASTER_KEY` from a KMS in production) |
| Transport | TLS at the edge; `HttpOnly`, `SameSite=Lax`, `Secure` (production) session cookies |
| CSRF | Same-origin enforcement on all mutations, plus SameSite cookies |
| AuthN | scrypt password hashing, 12-hour server-side sessions, session revocation on password change |
| AuthZ | Five roles; patients limited to their own cases; reviewers scoped to their country; auditors read-only and PII-masked |
| Audit | Append-only SHA-256 hash chain over actor, action, entity, IP, user agent and details; `/api/admin/audit/verify` replays the chain |
| Minimisation | Cross-border payloads and stored transmission logs mask names, emails, phones and MRNs; client IP and user agent captured |
| Retention | Per-jurisdiction retention metadata surfaced in the compliance workspace |
| Input safety | Zod validation, 12 MB × 8 file limits, MIME/size checks, parameterised SQL, CSP and security headers |
| Rate limiting | Login, submission, tracking and webhook sinks |

HIPAA/GDPR notes: the audit/log design follows §164.312(b) and Art. 30/32 intent, breach-relevant events are
captured, and special-category data paths require consent (enforced at intake). This is a reference architecture,
not a certification; production deployments need a DPIA, BAAs/processor agreements, KMS-backed keys, and
jurisdiction-specific legal review.

---

## Adding a country

1. Add a jurisdiction entry in `server/config.ts` (regulator, frameworks, SLA hours, retention, authorities).
2. Seed facilities (`facilities`) and physician licences (`physician_licenses`).
3. Add an adapter row (UI → Adapters → New adapter) with protocol, endpoint and mapping; or rely on the
   configuration-only fallback derived from the authority's `adapter` code.
4. Nothing in the verification, triage or audit modules changes.

## Tests

`npm test` covers:

- AES-256-GCM round-trips, tamper detection, scrypt verification, PII masking.
- PDF/image forensics: clean record, word-processor provenance, Photoshop provenance, revoked/expired licences,
  facility mismatch, renamed files, duplicate digests, unsupported payloads, locale-aware extraction.
- Triage: P1 death escalation, maternity denial, billing cap, privacy/infrastructure categories, SLA matrices.
- Adapters: FHIR bundle shape and priority mapping, HL7 escaping/ACK, REST templates, SOAP escaping, masking.
- End-to-end API: guest submission → verification → routing → tracking, RBAC denial, suspicious bundle held for
  review then approved and routed, SLA recalculation on override, cross-origin rejection, audit-chain integrity,
  and confirmation that outbound payloads contain no direct identifiers.

## Known limitations (by design for this build)

- Document authenticity uses deterministic structural heuristics and registries, not a trained vision model or an
  external OCR/NLP provider. Findings are explainable but not a substitute for forensic examination.
- External health authorities are simulated (`adapters.simulate=1`); switch to `simulate=0` and supply credentials
  to call real endpoints.
- Email is written to a local outbox instead of an SMTP relay.
- SQLite and an in-process notification worker make this a single-node deployment; production would move to
  Postgres/object storage and a durable queue.
- `/api/_sink/webhook` is an unauthenticated local development sink.
