import fs from "node:fs";
import path from "node:path";
import {
  OUTBOX_DIR,
  SMS_API_KEY,
  SMS_API_URL,
  SMS_ENABLED,
  SMS_PROVIDER,
  SMS_SENDER_ID,
  SMS_SIMULATE,
  SMS_TWILIO_FROM,
  SMS_TWILIO_SID,
  SMS_TWILIO_TOKEN,
} from "./config.js";
import { randomCode } from "./crypto.js";

export type SmsStatus = {
  enabled: boolean;
  /** True when the server holds credentials for a live gateway. */
  configured: boolean;
  provider: string;
  /** True when messages are written to $DATA_DIR/outbox instead of being sent. */
  simulated: boolean;
};

function credentialsPresent(): boolean {
  if (SMS_PROVIDER === "twilio") return Boolean(SMS_TWILIO_SID && SMS_TWILIO_TOKEN && SMS_TWILIO_FROM);
  if (SMS_PROVIDER === "generic") return Boolean(SMS_API_URL && SMS_API_KEY);
  return false;
}

export function smsStatus(): SmsStatus {
  const configured = credentialsPresent();
  return {
    enabled: SMS_ENABLED,
    configured,
    provider: SMS_PROVIDER,
    simulated: !configured || SMS_SIMULATE,
  };
}

export type SmsSendResult = {
  provider: string;
  /** Gateway-side message id when the gateway returned one. */
  reference: string | null;
  simulated: boolean;
  error: string | null;
};

/**
 * Write the message to the local outbox. This is the demonstration path: it
 * keeps the whole one-time-password flow exercisable without a paid gateway,
 * exactly like the WhatsApp channel's simulation mode.
 */
function writeOutbox(to: string, text: string, kind: string): string {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(OUTBOX_DIR, `sms-${Date.now()}-${randomCode(5)}.txt`);
  const body = [
    `channel: SMS`,
    `kind: ${kind}`,
    `to: ${to}`,
    `provider: ${SMS_PROVIDER} (simulated)`,
    `sent_at: ${new Date().toISOString()}`,
    `sender: ${SMS_SENDER_ID}`,
    "",
    text,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, { mode: 0o600 });
  return path.basename(file);
}

async function sendTwilio(to: string, text: string): Promise<SmsSendResult> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${SMS_TWILIO_SID}/Messages.json`;
  const auth = Buffer.from(`${SMS_TWILIO_SID}:${SMS_TWILIO_TOKEN}`).toString("base64");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: `+${to}`, From: SMS_TWILIO_FROM, Body: text }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok) {
    return { provider: "twilio", reference: null, simulated: false, error: payload.message ?? `HTTP ${res.status}` };
  }
  return { provider: "twilio", reference: payload.sid ?? null, simulated: false, error: null };
}

/**
 * Generic HTTP gateway: POST ${SMS_API_URL} with a JSON body of
 * {to, message, sender}, authenticated with `Authorization: Bearer ${SMS_API_KEY}`.
 * This covers the Indian aggregators (MSG91, Kaleyra, Gupshup, …) once their
 * send endpoint is wired to that contract.
 */
async function sendGeneric(to: string, text: string): Promise<SmsSendResult> {
  const res = await fetch(SMS_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${SMS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ to, message: text, sender: SMS_SENDER_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string; error?: string };
  if (!res.ok) {
    return { provider: SMS_PROVIDER, reference: null, simulated: false, error: payload.error ?? `HTTP ${res.status}` };
  }
  return { provider: SMS_PROVIDER, reference: payload.id ?? payload.messageId ?? null, simulated: false, error: null };
}

/**
 * Send a transactional SMS. Never throws: callers decide whether a delivery
 * failure should stop the workflow. In simulation the message lands in the
 * outbox and the returned reference is the outbox filename.
 */
export async function sendSms(input: { to: string; text: string; kind: string }): Promise<SmsSendResult> {
  const status = smsStatus();
  if (!status.enabled) {
    return { provider: status.provider, reference: null, simulated: true, error: "SMS channel is disabled (SMS_ENABLED=0)" };
  }
  if (status.simulated) {
    const file = writeOutbox(input.to, input.text, input.kind);
    return { provider: "OUTBOX", reference: file, simulated: true, error: null };
  }
  try {
    return status.provider === "twilio" ? await sendTwilio(input.to, input.text) : await sendGeneric(input.to, input.text);
  } catch (err) {
    return { provider: status.provider, reference: null, simulated: false, error: (err as Error).message };
  }
}
