import { JURISDICTIONS } from "./config.js";
import type { CaseRow } from "./models.js";

export type ChatSuggestion = { label: string; href: string };

export type ChatIntent =
  | "greeting"
  | "emergency"
  | "status"
  | "submit"
  | "documents"
  | "timeline"
  | "rights"
  | "privacy"
  | "cost"
  | "escalation"
  | "community"
  | "signup"
  | "thanks"
  | "fallback";

export type ChatReply = {
  reply: string;
  intent: ChatIntent;
  suggestions: ChatSuggestion[];
  emergency?: boolean;
};

export type CaseStatusSummary = {
  id: string;
  status: string;
  priority: string;
  verificationStatus: string;
  category: string;
  facilityName: string | null;
  authorityName: string | null;
  createdAt: string;
  slaDueAt: string;
  resolvedAt: string | null;
  lastEvent: string | null;
  documents: number;
};

const S = {
  track: { label: "Track a case", href: "/track" },
  submit: { label: "File a grievance", href: "/submit" },
  signup: { label: "Create a patient account", href: "/signup" },
  community: { label: "Community forum", href: "/community" },
  portal: { label: "Patient workspace", href: "/portal" },
  rights: { label: "Patient rights", href: "/community" },
};

/** Devanagari or common Romanised Hindi markers switch the reply language. */
export function isHindi(message: string): boolean {
  return /[\u0900-\u097F]/.test(message) || /\b(kya|kaise|nahi|nahin|mujhe|mera|meri|shikayat|madad|kab|kitna|kahan|paisa|dastavez|hal)\b/i.test(message);
}

const INTENT_PATTERNS: Array<{ intent: ChatIntent; patterns: RegExp[] }> = [
  {
    intent: "emergency",
    patterns: [
      /chest pain|heart attack|can'?t breathe|breathless|unconscious|severe bleeding|bleeding heavily|stroke|suicide|kill myself|self harm|overdose|सीने में दर्द|दिल का दौरा|खून बह|सांस नहीं|बेहोश|आत्महत्या/i,
    ],
  },
  {
    intent: "status",
    patterns: [/status|track|where is my|case update|kya hua|स्थिति|ट्रैक|कहाँ है|update on my case|check my case/i],
  },
  {
    intent: "submit",
    patterns: [/how (do|can) i (file|submit|complain)|file a (complaint|grievance)|submit a (complaint|grievance)|new complaint|register a grievance|शिकायत (कैसे|दर्ज)/i],
  },
  {
    intent: "documents",
    patterns: [/document|upload|attachment|evidence|pdf|scan|report|prescription|bill|दस्तावेज|अपलोड|रिपोर्ट/i],
  },
  {
    intent: "timeline",
    patterns: [/how long|sla|deadline|time ?frame|when will|resolution time|kitna (samay|din)|कितना समय|कब तक|समय सीमा/i],
  },
  {
    intent: "rights",
    patterns: [/rights|charter|entitle|compensation|अधिकार|चार्टर|मुआवजा/i],
  },
  {
    intent: "privacy",
    patterns: [/privacy|data protection|dpdp|consent|delete my data|anonymous|गोपनीयता|डेटा|सहमति/i],
  },
  {
    intent: "cost",
    patterns: [/cost|fee|charge|free|pay|paisa|शुल्क|पैसा|कितना लगेगा/i],
  },
  {
    intent: "escalation",
    patterns: [/escalate|appeal|not satisfied|unhappy|no response|ignored|शिकायत बढ़|कोई जवाब नहीं/i],
  },
  {
    intent: "community",
    patterns: [/community|forum|post|discuss|feedback|अनुभव|समुदाय|फोरम/i],
  },
  {
    intent: "signup",
    patterns: [/sign ?up|register|create (an )?account|पंजीकरण|खाता बन/i],
  },
  { intent: "greeting", patterns: [/^(hi|hello|hey|namaste|namaskar|good (morning|afternoon|evening))\b|नमस्ते|नमस्कार/i] },
  { intent: "thanks", patterns: [/thank|thanks|dhanyavad|धन्यवाद|शुक्रिया/i] },
];

export function classify(message: string): ChatIntent {
  const text = message.trim();
  for (const entry of INTENT_PATTERNS) {
    if (entry.patterns.some((p) => p.test(text))) return entry.intent;
  }
  return "fallback";
}

const SLA_LINE = JURISDICTIONS[0].slaHours;

function faq(intent: ChatIntent, hi: boolean): ChatReply {
  const pick = (en: string, hindi: string) => (hi ? hindi : en);
  switch (intent) {
    case "emergency":
      return {
        intent,
        emergency: true,
        reply: pick(
          "This assistant cannot give medical advice. If someone is in immediate danger, call 108 (ambulance) or 112 (emergency services) now, or go to the nearest emergency department. For mental-health crisis support, Tele-MANAS is available on 14416. You can file a grievance about the care you received once the person is safe.",
          "यह सहायक चिकित्सीय सलाह नहीं दे सकता। यदि किसी की जान को तत्काल खतरा है, तो अभी 108 (एम्बुलेंस) या 112 (आपातकालीन सेवा) पर कॉल करें या नज़दीकी आपातकालीन विभाग जाएँ। मानसिक स्वास्थ्य संकट के लिए टेली-मानस 14416 पर उपलब्ध है। सुरक्षित होने के बाद आप देखभाल के बारे में शिकायत दर्ज कर सकते हैं।",
        ),
        suggestions: [S.submit, S.track],
      };
    case "status":
      return {
        intent,
        reply: pick(
          "I can look up a case for you. If you filed as a guest, share the case reference (CASE-YYYY-XXXXXX) and the access code from your submission. If you signed in, open your patient workspace and I can summarise your latest case.",
          "मैं आपका केस देख सकता हूँ। यदि आपने अतिथि के रूप में शिकायत दर्ज की थी, तो केस संख्या (CASE-YYYY-XXXXXX) और सबमिशन के समय मिला एक्सेस कोड बताएँ। यदि आप साइन इन हैं, तो अपना रोगी कार्यक्षेत्र खोलें और मैं आपके नवीनतम केस का सारांश दिखाऊँगा।",
        ),
        suggestions: [S.track, S.portal],
      };
    case "submit":
      return {
        intent,
        reply: pick(
          "Filing a grievance takes about ten minutes. Choose the hospital and health authority, describe what happened (at least 40 characters), add any discharge summary, bill or prescription, and consent to data processing. You receive a case reference and — for guest submissions — an access code. Priority is assigned automatically: P1 emergencies are due to the authority within 2 hours, P2 in 12 hours, P3 in 48 hours and P4 in 7 days.",
          "शिकायत दर्ज करने में लगभग दस मिनट लगते हैं। अस्पताल और स्वास्थ्य प्राधिकरण चुनें, क्या हुआ बताएँ (कम से कम 40 अक्षर), डिस्चार्ज सारांश, बिल या पर्चा जोड़ें और डेटा प्रोसेसिंग की सहमति दें। आपको केस संख्या मिलती है और अतिथि शिकायत के लिए एक्सेस कोड भी। प्राथमिकता स्वतः तय होती है: P1 आपातकाल 2 घंटे, P2 12 घंटे, P3 48 घंटे और P4 7 दिन में प्राधिकरण तक पहुँचनी चाहिए।",
        ),
        suggestions: [S.submit, S.signup],
      };
    case "documents":
      return {
        intent,
        reply: pick(
          "Attach up to 8 files (12 MB each): discharge summaries, itemised bills, prescriptions or photographs. PDFs with a text layer are verified automatically. Scans without a text layer, edited metadata or duplicate files are queued for manual review — that is normal, not a rejection. Aadhaar, PAN and phone numbers are masked before anything is shared with the authority.",
          "अधिकतम 8 फ़ाइलें (प्रत्येक 12 MB) जोड़ें: डिस्चार्ज सारांश, विस्तृत बिल, पर्चे या फ़ोटो। टेक्स्ट वाली PDF स्वतः सत्यापित होती हैं। बिना टेक्स्ट वाले स्कैन, बदले गए मेटाडेटा या डुप्लिकेट फ़ाइलें मैन्युअल समीक्षा में जाती हैं — यह सामान्य है, अस्वीकृति नहीं। आधार, पैन और फ़ोन नंबर प्राधिकरण को भेजने से पहले छिपाए जाते हैं।",
        ),
        suggestions: [S.submit, S.track],
      };
    case "timeline":
      return {
        intent,
        reply: pick(
          `Response targets depend on priority: P1 ${SLA_LINE.P1}h, P2 ${SLA_LINE.P2}h, P3 ${SLA_LINE.P3}h, P4 ${SLA_LINE.P4}h. The case page shows the live countdown and every status change on the timeline. Manual document review is separate from the SLA clock and runs in submission order.`,
          `प्रतिक्रिया समय प्राथमिकता पर निर्भर है: P1 ${SLA_LINE.P1} घंटे, P2 ${SLA_LINE.P2} घंटे, P3 ${SLA_LINE.P3} घंटे, P4 ${SLA_LINE.P4} घंटे। केस पृष्ठ पर लाइव समय और हर स्थिति परिवर्तन दिखता है। मैन्युअल दस्तावेज़ समीक्षा SLA घड़ी से अलग है और दर्ज क्रम में होती है।`,
        ),
        suggestions: [S.track, S.rights],
      };
    case "rights":
      return {
        intent,
        reply: pick(
          "The Charter of Patients' Rights 2021 gives you rights to information, informed consent, emergency care, a second opinion, grievance redressal and privacy. Complaints can reference the Charter, the Clinical Establishments Act 2010, the Consumer Protection Act 2019 and — for data handling — the DPDP Act 2023.",
          "रोगी अधिकार चार्टर 2021 आपको सूचना, सहमति, आपातकालीन देखभाल, दूसरी राय, शिकायत निवारण और गोपनीयता का अधिकार देता है। शिकायत में चार्टर, क्लिनिकल एस्टैब्लिशमेंट्स अधिनियम 2010, उपभोक्ता संरक्षण अधिनियम 2019 और डेटा के लिए DPDP अधिनियम 2023 का हवाला दिया जा सकता है।",
        ),
        suggestions: [S.submit, S.community],
      };
    case "privacy":
      return {
        intent,
        reply: pick(
          "Narratives, contact details and documents are encrypted at rest with AES-256-GCM. Only the reviewing authority and assigned compliance staff can read the full record; auditors see masked identifiers. Guest cases are reachable only with the access code. Records are retained for three years under the platform policy, and every access is written to a tamper-evident audit chain.",
          "विवरण, संपर्क और दस्तावेज़ AES-256-GCM से एन्क्रिप्ट रहते हैं। पूरा रिकॉर्ड केवल समीक्षा प्राधिकरण और नियुक्त अधिकारी देख सकते हैं; ऑडिटर को छिपे पहचानकर्ता दिखते हैं। अतिथि केस केवल एक्सेस कोड से खुलते हैं। रिकॉर्ड तीन वर्ष रखे जाते हैं और हर एक्सेस छेड़छाड़-प्रमाण ऑडिट श्रृंखला में दर्ज होती है।",
        ),
        suggestions: [S.community, S.submit],
      };
    case "cost":
      return {
        intent,
        reply: pick(
          "Filing, tracking and escalating a grievance on MedNotice Global is free for patients. You do not need an account, and the platform never asks for payment to route a case to a health authority. Treat any request for money in the name of this portal as fraudulent.",
          "मेडनोटिस इंडिया पर शिकायत दर्ज करना, ट्रैक करना और आगे बढ़ाना रोगियों के लिए निःशुल्क है। खाता ज़रूरी नहीं है और यह प्लेटफ़ॉर्म केस प्राधिकरण तक भेजने के लिए कभी भुगतान नहीं मांगता। इस पोर्टल के नाम पर पैसे की मांग को धोखाधड़ी मानें।",
        ),
        suggestions: [S.submit, S.track],
      };
    case "escalation":
      return {
        intent,
        reply: pick(
          "If the SLA has passed without a substantive response, open the case and use the timeline to see whether it was routed or awaiting manual review. You can attach a follow-up grievance quoting the original reference, or post in the community for guidance. Regulator escalation routes are listed on each case page.",
          "यदि SLA बीत गया है और कोई ठोस जवाब नहीं आया, तो केस खोलकर देखें कि वह भेजा गया था या मैन्युअल समीक्षा में है। आप मूल केस संख्या का हवाला देते हुए अनुवर्ती शिकायत जोड़ सकते हैं, या मार्गदर्शन के लिए समुदाय में लिख सकते हैं। नियामक एस्केलेशन मार्ग हर केस पृष्ठ पर दिए हैं।",
        ),
        suggestions: [S.track, S.community],
      };
    case "community":
      return {
        intent,
        reply: pick(
          "The community forum is where patients and guests compare experiences, ask about documents and share feedback. You can post and comment without an account by choosing a display name, or sign in to post under your patient profile. Moderators can edit, hide or remove content that breaks the guidelines.",
          "समुदाय फोरम में रोगी और अतिथि अनुभव साझा करते हैं, दस्तावेज़ों के बारे में पूछते हैं और प्रतिक्रिया देते हैं। आप बिना खाता बनाए प्रदर्शित नाम चुनकर पोस्ट और टिप्पणी कर सकते हैं, या साइन इन करके अपनी रोगी प्रोफ़ाइल से लिख सकते हैं। दिशानिर्देश तोड़ने वाली सामग्री को मॉडरेटर संपादित, छिपा या हटा सकते हैं।",
        ),
        suggestions: [S.community, S.signup],
      };
    case "signup":
      return {
        intent,
        reply: pick(
          "A patient account keeps every grievance, document and reply in one workspace, so you do not need to save access codes. Sign up with your name, email and a 12-character password; you can still file anonymously as a guest at any time.",
          "रोगी खाता हर शिकायत, दस्तावेज़ और जवाब एक ही जगह रखता है, इसलिए एक्सेस कोड सहेजने की ज़रूरत नहीं। अपने नाम, ईमेल और 12 अक्षरों के पासवर्ड से पंजीकरण करें; आप कभी भी अतिथि के रूप में गुमनाम शिकायत दर्ज कर सकते हैं।",
        ),
        suggestions: [S.signup, S.submit],
      };
    case "greeting":
      return {
        intent,
        reply: pick(
          "Hello. I can explain how grievance intake works, what documents to attach, how priorities and deadlines are set, or look up the status of a case. What would you like to do?",
          "नमस्ते। मैं बता सकता हूँ कि शिकायत कैसे दर्ज होती है, कौन से दस्तावेज़ जोड़ें, प्राथमिकता और समय सीमा कैसे तय होती है, या किसी केस की स्थिति देख सकता हूँ। आप क्या करना चाहेंगे?",
        ),
        suggestions: [S.submit, S.track, S.community],
      };
    case "thanks":
      return {
        intent,
        reply: pick("You're welcome. If anything is unclear about your case, the tracking page and the community forum are good next steps.", "आपका स्वागत है। केस के बारे में कुछ भी अस्पष्ट हो तो ट्रैकिंग पृष्ठ और समुदाय फोरम अगले कदम हैं।"),
        suggestions: [S.track, S.community],
      };
    default:
      return {
        intent: "fallback",
        reply: pick(
          "I can help with filing a grievance, documents and verification, priorities and deadlines, patient rights, privacy, escalation, or checking a case status. Tell me which one you need — for case status, include the case reference and access code.",
          "मैं शिकायत दर्ज करने, दस्तावेज़ और सत्यापन, प्राथमिकता और समय सीमा, रोगी अधिकार, गोपनीयता, एस्केलेशन या केस की स्थिति में मदद कर सकता हूँ। बताएँ आपको क्या चाहिए — केस स्थिति के लिए केस संख्या और एक्सेस कोड दें।",
        ),
        suggestions: [S.submit, S.track, S.signup, S.community],
      };
  }
}

export function faqReply(intent: ChatIntent, hi: boolean): ChatReply {
  return faq(intent, hi);
}

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "submitted and queued for routing",
  ROUTED: "routed to the health authority",
  PENDING_REVIEW: "awaiting manual document review",
  UNDER_REVIEW: "under review by the authority",
  ROUTE_FAILED: "held because routing failed and is being retried",
  RESOLVED: "resolved and closed",
  REJECTED: "rejected after document verification",
};

function slaText(dueAt: string): string {
  const diff = new Date(dueAt).getTime() - Date.now();
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return `${diff < 0 ? "overdue by" : "due in"} ${hours > 0 ? `${hours}h ` : ""}${minutes}m`;
}

export function describeCase(row: CaseRow, authorityName: string | null, documentCount: number, hi: boolean): { reply: string; summary: CaseStatusSummary } {
  const timeline = (() => {
    try {
      const parsed = JSON.parse(row.timeline_json || "[]") as Array<{ date: string; event: string }>;
      return parsed.length ? parsed[parsed.length - 1] : null;
    } catch {
      return null;
    }
  })();
  const status = STATUS_LABELS[row.status] ?? row.status.toLowerCase().replace(/_/g, " ");
  const summary: CaseStatusSummary = {
    id: row.id,
    status: row.status,
    priority: row.priority,
    verificationStatus: row.verification_status,
    category: row.category,
    facilityName: row.facility_name,
    authorityName,
    createdAt: row.created_at,
    slaDueAt: row.sla_due_at,
    resolvedAt: row.resolved_at,
    lastEvent: timeline?.event ?? null,
    documents: documentCount,
  };
  const reply = hi
    ? `केस ${row.id} अभी ${status} है। प्राथमिकता ${row.priority} (${row.category}) और दस्तावेज़ सत्यापन ${row.verification_status} है। ${row.facility_name ?? "अस्पताल"} · ${authorityName ?? row.authority_id}। SLA ${row.resolved_at ? "पूरा हुआ" : slaText(row.sla_due_at)}।${timeline ? ` अंतिम अपडेट: ${timeline.event}.` : ""}`
    : `Case ${row.id} is ${status}. Priority ${row.priority} (${row.category}) and document verification is ${row.verification_status}. ${row.facility_name ?? "Facility"} · ${authorityName ?? row.authority_id}. SLA ${row.resolved_at ? "met and closed" : slaText(row.sla_due_at)}.${timeline ? ` Last update: ${timeline.event}.` : ""}`;
  return { reply, summary };
}

export const CASE_ID_PATTERN = /CASE-\d{4}-[A-Z0-9]{4,12}/i;
