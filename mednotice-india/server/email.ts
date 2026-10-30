import fs from "node:fs";
import path from "node:path";
import { EMAIL_API_KEY, EMAIL_API_URL, EMAIL_ENABLED, EMAIL_FROM, EMAIL_SIMULATE, OUTBOX_DIR } from "./config.js";
import { randomCode } from "./crypto.js";

/**
 * Transactional email transport — one-time passwords for patients who sign in
 * with the email address on their account.
 *
 * Only two runtime values are needed to go live: EMAIL_API_URL and
 * EMAIL_API_KEY. The endpoint receives a JSON POST of {from, to, subject, text}
 * with an `Authorization: Bearer <key>` header, which is the shape exposed by
 * Resend, Postmark and the SES HTTP bridge. No SDK is used.
 *
 * Two transport modes:
 *  - LIVE       — the provider accepted the message and returned an id.
 *  - SIMULATED  — credentials absent (or EMAIL_SIMULATE=1). The exact payload
 *                 is written to $DATA_DIR/outbox so a reviewer can read the
 *                 code. Nothing leaves the machine.
 */

export type EmailStatus = {
  enabled: boolean;
  /** True when the server holds credentials for a live provider. */
  configured: boolean;
  /** True when messages are written to $DATA_DIR/outbox instead of being sent. */
  simulated: boolean;
  from: string;
};

export function emailStatus(): EmailStatus {
  const configured = Boolean(EMAIL_API_URL && EMAIL_API_KEY);
  return {
    enabled: EMAIL_ENABLED,
    configured,
    simulated: !configured || EMAIL_SIMULATE,
    from: EMAIL_FROM,
  };
}

export type EmailSendResult = {
  provider: string;
  /** Provider-side message id when one was returned, else the outbox file name. */
  reference: string | null;
  simulated: boolean;
  error: string | null;
};

function writeOutbox(to: string, subject: string, text: string, kind: string): string {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(OUTBOX_DIR, `email-${Date.now()}-${randomCode(5)}.txt`);
  const body = [
    `channel: EMAIL`,
    `kind: ${kind}`,
    `to: ${to}`,
    `from: ${EMAIL_FROM}`,
    `subject: ${subject}`,
    `sent_at: ${new Date().toISOString()}`,
    "",
    text,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, { mode: 0o600 });
  return path.basename(file);
}

/**
 * Send one transactional email. Never throws: callers decide whether a
 * delivery failure should stop the workflow. In simulation the message lands
 * in the outbox and the returned reference is the outbox filename.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  kind: string;
}): Promise<EmailSendResult> {
  const status = emailStatus();
  if (!status.enabled) {
    return { provider: "EMAIL", reference: null, simulated: true, error: "Email channel is disabled (EMAIL_ENABLED=0)" };
  }
  if (status.simulated) {
    const file = writeOutbox(input.to, input.subject, input.text, input.kind);
    return { provider: "OUTBOX", reference: file, simulated: true, error: null };
  }
  try {
    const res = await fetch(EMAIL_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${EMAIL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: input.to, subject: input.subject, text: input.text }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await res.text().catch(() => "")) as string;
    let parsed: { id?: string; messageId?: string; message?: string; error?: string } = {};
    try {
      parsed = payload ? JSON.parse(payload) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const detail = parsed.message ?? parsed.error ?? payload.slice(0, 200);
      return { provider: "EMAIL", reference: null, simulated: false, error: `HTTP ${res.status}: ${detail}` };
    }
    return { provider: "EMAIL", reference: parsed.id ?? parsed.messageId ?? null, simulated: false, error: null };
  } catch (err) {
    return { provider: "EMAIL", reference: null, simulated: false, error: (err as Error).message };
  }
}
