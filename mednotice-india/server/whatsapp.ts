import fs from "node:fs";
import path from "node:path";
import {
  OUTBOX_DIR,
  WHATSAPP_API_VERSION,
  WHATSAPP_DEFAULT_COUNTRY,
  WHATSAPP_ENABLED,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_SIMULATE,
  WHATSAPP_TEMPLATE_LANG,
  WHATSAPP_TEMPLATE_NAME,
  WHATSAPP_TOKEN,
} from "./config.js";

/**
 * WhatsApp Cloud API transport (Meta Graph API).
 *
 * Only two runtime values are needed to go live: a permanent access token and
 * the phone number id of the sending WhatsApp Business number. No SDK is used;
 * the Graph endpoint is a plain HTTPS POST.
 *
 * Two transport modes:
 *  - LIVE       — the Graph API accepted the message and returned a wamid.
 *  - SIMULATED  — credentials absent (or WHATSAPP_SIMULATE=1). The exact
 *                 payload is written to $DATA_DIR/outbox so a reviewer can see
 *                 what would have been sent. Nothing leaves the machine.
 */

export type WhatsAppStatus = {
  enabled: boolean;
  configured: boolean;
  simulated: boolean;
  /** Last four digits of the sending number id, never the whole value. */
  senderHint: string | null;
  apiVersion: string;
  templateName: string | null;
  templateLanguage: string;
  defaultCountry: string;
};

export type WhatsAppSendResult = {
  provider: "WHATSAPP_CLOUD" | "OUTBOX";
  simulated: boolean;
  /** WhatsApp message id (wamid) or the local outbox file name. */
  reference: string;
};

export type WhatsAppMessage = {
  /** Notification id, used for the simulated outbox file name. */
  id: string;
  /** Recipient in international format without a leading plus. */
  to: string;
  subject: string;
  body: string;
  /** Positional body parameters when a template is used. */
  params?: string[];
};

export function whatsappStatus(): WhatsAppStatus {
  const configured = Boolean(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID);
  return {
    enabled: WHATSAPP_ENABLED,
    configured,
    simulated: !configured || WHATSAPP_SIMULATE,
    senderHint: WHATSAPP_PHONE_NUMBER_ID ? WHATSAPP_PHONE_NUMBER_ID.slice(-4) : null,
    apiVersion: WHATSAPP_API_VERSION,
    templateName: WHATSAPP_TEMPLATE_NAME || null,
    templateLanguage: WHATSAPP_TEMPLATE_LANG,
    defaultCountry: WHATSAPP_DEFAULT_COUNTRY,
  };
}

/**
 * Normalise user input to the digits-only international form the Cloud API
 * expects ("+91 98100 01000" → "919810001000").
 *
 * Numbers entered without a country code get the default (India) prefix, so a
 * local "098100 01000" and an international "+91 98100 01000" are the same
 * number as far as the customer is concerned.
 */
export function normalizeWhatsAppNumber(raw: string, defaultCountry = WHATSAPP_DEFAULT_COUNTRY): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (!/^[+()\d][\d\s()+-]*$/.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (!trimmed.startsWith("+")) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = `${defaultCountry}${digits.replace(/^0+/, "")}`;
    else if (digits.length <= 11) digits = `${defaultCountry}${digits}`;
  }

  // E.164 allows 7–15 digits; WhatsApp requires a country code, and every
  // number this platform accepts is at least a 10-digit national number.
  if (digits.length < 10 || digits.length > 15 || digits.startsWith("0")) return null;
  return digits;
}

/** Masked form for logs, the audit trail and the console. */
export function maskWhatsAppNumber(digits: string): string {
  const clean = (digits ?? "").replace(/\D/g, "");
  if (clean.length < 6) return "***";
  return `+${clean.slice(0, clean.length - 4 > 2 ? 2 : 1)} ${"*".repeat(Math.max(0, clean.length - 6))}${clean.slice(-4)}`;
}

function writeOutboxCopy(message: WhatsAppMessage): string {
  const safe = message.id.replace(/[^A-Za-z0-9_-]/g, "");
  const file = path.join(OUTBOX_DIR, `${safe}.wa.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        channel: "WHATSAPP",
        simulated: true,
        reason: "WhatsApp Cloud API credentials are not configured on this deployment",
        to: `+${message.to}`,
        subject: message.subject,
        body: message.body,
        template: WHATSAPP_TEMPLATE_NAME ? { name: WHATSAPP_TEMPLATE_NAME, language: WHATSAPP_TEMPLATE_LANG, params: message.params ?? [] } : null,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return path.basename(file);
}

function graphPayload(message: WhatsAppMessage): Record<string, unknown> {
  if (WHATSAPP_TEMPLATE_NAME) {
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: message.to,
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATE_NAME,
        language: { code: WHATSAPP_TEMPLATE_LANG },
        components: message.params?.length
          ? [{ type: "body", parameters: message.params.map((text) => ({ type: "text", text })) }]
          : [],
      },
    };
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: message.to,
    type: "text",
    text: { preview_url: false, body: message.body },
  };
}

/**
 * Deliver one message. Throws on a rejected send so the notification queue
 * applies its usual retry/backoff policy; the Graph error message is preserved
 * in `notifications.last_error`.
 */
export async function sendWhatsAppMessage(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
  if (!WHATSAPP_ENABLED) throw new Error("WhatsApp channel is disabled (WHATSAPP_ENABLED=0)");

  const status = whatsappStatus();
  if (status.simulated) {
    return { provider: "OUTBOX", simulated: true, reference: writeOutboxCopy(message) };
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(graphPayload(message)),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }

  if (!res.ok) {
    const detail = parsed.error?.error_data?.details ?? parsed.error?.message ?? text.slice(0, 200);
    throw new Error(`WhatsApp Cloud API HTTP ${res.status}: ${detail}${parsed.error?.code ? ` (code ${parsed.error.code})` : ""}`);
  }

  const wamid = parsed.messages?.[0]?.id;
  if (!wamid) throw new Error("WhatsApp Cloud API accepted the request but returned no message id");
  return { provider: "WHATSAPP_CLOUD", simulated: false, reference: wamid };
}
