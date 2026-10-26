import { Router } from "express";
import { z } from "zod";
import { all, count, get } from "../db.js";
import { sha256Hex, timingSafeEqualStr } from "../crypto.js";
import { audit } from "../audit.js";
import { asyncHandler, createRateLimiter, meta, parseBody } from "../http.js";
import { CASE_ID_PATTERN, classify, describeCase, faqReply, isHindi } from "../chat.js";
import { findAuthority } from "../registry.js";
import type { CaseRow } from "../models.js";

/**
 * Public assistant: answers intake questions and summarises case status for the
 * signed-in patient who owns the case, or for a guest holding the access code.
 * It never gives medical advice and never returns data without authorisation.
 */
export const chatRouter = Router();

const chatSchema = z.object({
  message: z.string().trim().min(1, "Type a question").max(600),
  caseId: z.string().trim().max(40).optional().or(z.literal("")),
  accessCode: z.string().trim().max(64).optional().or(z.literal("")),
});

const DISCLAIMER = "Automated assistant — not medical advice. Emergencies: call 108 or 112.";

function summarise(row: CaseRow, hi: boolean) {
  const authority = findAuthority(row.authority_id)?.authority.name ?? null;
  const documents = count("SELECT COUNT(*) AS n FROM documents WHERE case_id = ?", row.id);
  return describeCase(row, authority, documents, hi);
}

chatRouter.post(
  "/",
  createRateLimiter({
    bucket: "chat",
    windowMs: 60_000,
    max: 30,
    key: (req) => req.user?.id ?? meta(req).ip ?? "anonymous",
  }),
  asyncHandler((req, res) => {
    const body = parseBody(chatSchema, req.body);
    const hi = isHindi(body.message);
    const intent = classify(body.message);
    const explicit = body.caseId?.trim() || body.message.match(CASE_ID_PATTERN)?.[0] || "";
    const caseId = explicit ? explicit.toUpperCase() : null;

    if (caseId) {
      const row = get<CaseRow>("SELECT * FROM cases WHERE id = ?", caseId);
      const staff = req.user && req.user.baseRole !== "PATIENT";
      const scoped = Boolean(
        row &&
          req.user &&
          staff &&
          !["SUPER_ADMIN", "SYSTEM_AUDITOR"].includes(req.user.baseRole) &&
          req.user.country &&
          row.country !== req.user.country,
      );
      const owns = Boolean(row && req.user && row.patient_user_id === req.user.id);
      const codeOk = Boolean(
        row?.access_code_hash && body.accessCode && timingSafeEqualStr(row.access_code_hash, sha256Hex(body.accessCode.toUpperCase())),
      );
      const authorised = Boolean(row) && !scoped && (staff || owns || codeOk);

      if (!authorised) {
        audit({
          actor: req.user ? { id: req.user.id, role: req.user.role } : { id: null, role: "PUBLIC" },
          action: "CHAT_CASE_LOOKUP_DENIED",
          entityType: "case",
          entityId: caseId,
          ...meta(req),
          details: { reason: row ? "unauthorised" : "unknown reference", accessCodeProvided: Boolean(body.accessCode) },
        });
        const needsCode = Boolean(row) && !req.user && !body.accessCode;
        res.json({
          intent: "status",
          reply: needsCode
            ? hi
              ? "उस केस संख्या के लिए एक्सेस कोड आवश्यक है। शिकायत दर्ज करते समय मिला कोड भेजें, या ट्रैक पृष्ठ पर दोनों दर्ज करें।"
              : "That case reference needs its access code. Send the code you received when you submitted, or enter both on the tracking page."
            : hi
              ? "इस संख्या और कोड से कोई केस सत्यापित नहीं हो सका। दोनों की जाँच करें और फिर प्रयास करें।"
              : "I couldn't verify a case with that reference and access code. Check both and try again.",
          suggestions: [{ label: "Open tracking", href: "/track" }],
          disclaimer: DISCLAIMER,
        });
        return;
      }

      const { reply, summary } = summarise(row!, hi);
      audit({
        actor: req.user ? { id: req.user.id, role: req.user.role } : { id: null, role: "PUBLIC" },
        action: "CHAT_CASE_LOOKUP",
        entityType: "case",
        entityId: row!.id,
        ...meta(req),
        details: { channel: "assistant", viaAccessCode: !req.user },
      });
      res.json({
        intent: "status",
        reply,
        caseStatus: summary,
        suggestions: [
          { label: req.user ? "Open case" : "Track this case", href: req.user ? `/cases/${row!.id}` : "/track" },
          { label: "Community forum", href: "/community" },
        ],
        disclaimer: DISCLAIMER,
      });
      return;
    }

    // Signed-in patients can ask about their own case without a reference.
    if (intent === "status" && req.user?.baseRole === "PATIENT") {
      const rows = all<CaseRow>("SELECT * FROM cases WHERE patient_user_id = ? ORDER BY created_at DESC LIMIT 5", req.user.id);
      if (rows.length === 0) {
        res.json({
          intent: "status",
          reply: hi
            ? "आपके खाते से अभी कोई शिकायत दर्ज नहीं है। आप कुछ ही मिनटों में नई शिकायत दर्ज कर सकते हैं।"
            : "You don't have any grievances on this account yet. Filing one takes a few minutes and you can attach documents.",
          suggestions: [{ label: "File a grievance", href: "/submit" }],
          disclaimer: DISCLAIMER,
        });
        return;
      }
      const { reply, summary } = summarise(rows[0], hi);
      res.json({
        intent: "status",
        reply: rows.length > 1 ? `${reply}${hi ? ` आपके खाते में ${rows.length} केस हैं; कार्यक्षेत्र में सभी देखें।` : ` You have ${rows.length} cases in total — the workspace lists them all.`}` : reply,
        caseStatus: summary,
        suggestions: [{ label: "Patient workspace", href: "/portal" }, { label: "Community forum", href: "/community" }],
        disclaimer: DISCLAIMER,
      });
      return;
    }

    const faq = faqReply(intent, hi);
    res.json({ ...faq, disclaimer: DISCLAIMER });
  }),
);
