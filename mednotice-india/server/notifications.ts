import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { all, get, nowIso, run } from "./db.js";
import { audit } from "./audit.js";
import { findJurisdiction } from "./config.js";
import { findAuthority } from "./registry.js";
import { MASTER_KEY, OUTBOX_DIR } from "./config.js";
import { decryptField, maskEmail, maskName, maskText, randomCode } from "./crypto.js";
import type { CaseRow, DocumentRow } from "./models.js";

type NotificationRow = {
  id: string;
  case_id: string;
  channel: string;
  target: string;
  subject: string;
  body: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
};

const MAX_ATTEMPTS = 5;

function buildNotice(caseRow: CaseRow, documents: DocumentRow[], adapterCode: string) {
  const jurisdiction = findJurisdiction(caseRow.country);
  const authority = findAuthority(caseRow.authority_id);
  const patientName = decryptField(caseRow.patient_name_enc) ?? caseRow.patient_name_masked;
  const patientEmail = decryptField(caseRow.patient_email_enc) ?? caseRow.patient_email_masked;
  const triage = JSON.parse(caseRow.triage_json || "{}") as { signals?: Array<{ label: string }>; regulatoryBasis?: string[] };
  const verifyMix = documents.reduce<Record<string, number>>((acc, d) => {
    acc[d.verification_status] = (acc[d.verification_status] ?? 0) + 1;
    return acc;
  }, {});
  const maskedName = maskName(patientName);
  const maskedEmail = maskEmail(patientEmail);
  const summary = [
    `Case:            ${caseRow.id}`,
    `Jurisdiction:    ${jurisdiction?.name ?? caseRow.country} (${caseRow.authority_id})`,
    `Facility:        ${caseRow.facility_name ?? "not specified"}`,
    `Category:        ${caseRow.category} (confidence ${Math.round(caseRow.category_confidence * 100)}%)`,
    `Priority:        ${caseRow.priority} — score ${caseRow.priority_score}/100`,
    `Verification:    ${caseRow.verification_status} (${Object.entries(verifyMix).map(([k, v]) => `${k}×${v}`).join(", ") || "no documents"})`,
    `SLA response:    ${caseRow.sla_due_at}`,
    `Complainant:     ${maskedName} <${maskedEmail}>`,
    `Routing adapter: ${adapterCode}`,
    "",
    "Priority drivers:",
    ...(triage.signals ?? []).slice(0, 5).map((s) => `  • ${s.label}`),
    "",
    "Document summaries:",
    ...(documents.length
      ? documents.map((d) => `  • ${maskText(d.filename)} — ${d.verification_status} (trust ${d.score}/100, sha256 ${d.sha256.slice(0, 12)}… )`)
      : ["  • no documents attached"]),
    "",
    "Regulatory basis:",
    ...(triage.regulatoryBasis ?? jurisdiction?.frameworks ?? []).map((r) => `  • ${r}`),
    "",
    "Identifiers are masked in transit per the DPDP Act 2023 minimisation policy for outbound payloads.",
    "Open the MedNotice India console to review the complete case record.",
  ].join("\n");
  return {
    subject: `[${caseRow.priority}] ${caseRow.id} · ${caseRow.category} · ${caseRow.facility_name ?? caseRow.country}`,
    body: summary,
    jurisdiction,
    authority,
  };
}

/** Enqueue email + webhook notifications for a successfully routed case. */
export function queueCaseNotifications(
  caseRow: CaseRow,
  documents: DocumentRow[],
  meta: { adapterCode: string; transmissionId: string },
): number {
  const { subject, body, authority } = buildNotice(caseRow, documents, meta.adapterCode);
  const now = nowIso();
  const targets: Array<{ channel: "EMAIL" | "WEBHOOK"; target: string }> = [];
  if (authority) {
    targets.push({ channel: "EMAIL", target: authority.authority.contactEmail });
    targets.push({ channel: "WEBHOOK", target: authority.authority.webhook });
  }
  if (caseRow.priority === "P1") {
    targets.push({ channel: "EMAIL", target: "duty-officer@mednotice.in" });
  }

  let queued = 0;
  for (const t of targets) {
    const id = `NTF-${randomCode(10)}`;
    run(
      `INSERT INTO notifications (id, case_id, channel, target, subject, body, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?)`,
      id,
      caseRow.id,
      t.channel,
      t.target,
      subject,
      body,
      now,
      now,
    );
    queued += 1;
    audit({
      actor: { id: null, role: "SYSTEM" },
      action: "NOTIFICATION_QUEUED",
      entityType: "case",
      entityId: caseRow.id,
      details: { notificationId: id, channel: t.channel, target: t.target, transmissionId: meta.transmissionId },
    });
  }
  return queued;
}

function writeEmailFile(row: NotificationRow): string {
  const safe = row.id.replace(/[^A-Za-z0-9_-]/g, "");
  const file = path.join(OUTBOX_DIR, `${safe}.eml`);
  const content = [
    `From: MedNotice India <notifications@mednotice.in>`,
    `To: ${row.target}`,
    `Subject: ${row.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${row.id}@mednotice.in>`,
    `X-MedNotice-Case: ${row.case_id}`,
    `X-MedNotice-Classification: RESTRICTED — masked identifiers only`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    row.body,
  ].join("\r\n");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

async function deliverWebhook(row: NotificationRow, body: string): Promise<void> {
  const url = new URL(row.target);
  if (url.hostname.endsWith(".local") || url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    // Loopback transport for sandboxed demonstrations: record the delivery locally.
    run(
      "INSERT INTO webhook_events (received_at, source, payload_json) VALUES (?, ?, ?)",
      nowIso(),
      `mednotice:${row.case_id}`,
      JSON.stringify({ notificationId: row.id, target: row.target, body: JSON.parse(body) }),
    );
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(row.target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mednotice-event": "case.routed",
        "x-mednotice-delivery": row.id,
        "x-mednotice-signature": `sha256=${crypto.createHmac("sha256", MASTER_KEY).update(body).digest("hex")}`,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function sendOne(row: NotificationRow): Promise<void> {
  if (row.channel === "EMAIL") {
    writeEmailFile(row);
    return;
  }
  const caseRow = get<CaseRow>("SELECT * FROM cases WHERE id = ?", row.case_id);
  const jurisdiction = caseRow ? findJurisdiction(caseRow.country) : undefined;
  const payload = JSON.stringify({
    event: "case.routed",
    notificationId: row.id,
    caseId: row.case_id,
    priority: caseRow?.priority ?? null,
    category: caseRow?.category ?? null,
    facility: caseRow?.facility_name ?? null,
    country: caseRow?.country ?? null,
    authorityId: caseRow?.authority_id ?? null,
    verificationStatus: caseRow?.verification_status ?? null,
    slaDueAt: caseRow?.sla_due_at ?? null,
    crossBorderRestricted: Boolean(jurisdiction?.crossBorderRestricted),
    masked: true,
    summary: maskText(row.body.split("\n").slice(0, 6).join(" | ")),
    sentAt: nowIso(),
  });
  await deliverWebhook(row, payload);
}

export async function processPendingNotifications(limit = 20): Promise<{ processed: number; sent: number; retried: number; failed: number }> {
  const due = all<NotificationRow>(
    "SELECT * FROM notifications WHERE status = 'QUEUED' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
    nowIso(),
    limit,
  );
  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const row of due) {
    try {
      await sendOne(row);
      run("UPDATE notifications SET status = 'SENT', attempts = attempts + 1, sent_at = ? WHERE id = ?", nowIso(), row.id);
      sent += 1;
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "NOTIFICATION_SENT",
        entityType: "case",
        entityId: row.case_id,
        details: { notificationId: row.id, channel: row.channel, target: row.target },
      });
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = (err as Error).message.slice(0, 500);
      if (attempts >= MAX_ATTEMPTS) {
        run("UPDATE notifications SET status = 'FAILED', attempts = ?, last_error = ? WHERE id = ?", attempts, message, row.id);
        failed += 1;
      } else {
        const delayMs = Math.min(60_000, 5_000 * 2 ** (attempts - 1));
        run(
          "UPDATE notifications SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?",
          attempts,
          message,
          new Date(Date.now() + delayMs).toISOString(),
          row.id,
        );
        retried += 1;
      }
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "NOTIFICATION_FAILED",
        entityType: "case",
        entityId: row.case_id,
        details: { notificationId: row.id, channel: row.channel, attempts, error: message },
      });
    }
  }

  return { processed: due.length, sent, retried, failed };
}

/** Drain the queue synchronously (used by tests and the seed script). */
export async function drainNotifications(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    const result = await processPendingNotifications(25);
    if (result.processed === 0) return;
  }
}

let workerTimer: NodeJS.Timeout | null = null;

export function startNotificationWorker(intervalMs = 4000): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void processPendingNotifications(25).catch((err) => {
      audit({
        actor: { id: null, role: "SYSTEM" },
        action: "WORKER_ERROR",
        entityType: "notification",
        details: { error: (err as Error).message },
      });
    });
  }, intervalMs);
  workerTimer.unref();
}

export function stopNotificationWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

export function requeueNotification(id: string): void {
  run("UPDATE notifications SET status = 'QUEUED', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ?", nowIso(), id);
}
