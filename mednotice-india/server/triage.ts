import { findJurisdiction, type Priority } from "./config.js";

export type TriageSignal = {
  code: string;
  label: string;
  weight: number;
  detail: string;
};

export type TriageResult = {
  priority: Priority;
  score: number;
  category: string;
  categoryConfidence: number;
  signals: TriageSignal[];
  categoryScores: Record<string, number>;
  slaHours: number;
  dueAt: string;
  regulatoryBasis: string[];
  humanReviewRecommended: boolean;
};

const CRITICAL_TERMS: Array<[RegExp, string]> = [
  [/\b(died|death|deceased|fatal|fatality|passed away)\b/i, "Patient death reported"],
  [/\b(cardiac arrest|heart attack|respiratory arrest|stopped breathing)\b/i, "Cardiorespiratory arrest"],
  [/\b(sepsis|septic shock|severe infection|necrotizing)\b/i, "Sepsis / severe infection"],
  [/\b(hemorrhage|haemorrhage|bleeding out|blood loss)\b/i, "Severe haemorrhage"],
  [/\b(overdose|wrong dose|tenfold|10x dose|double dose)\b/i, "Medication overdose"],
  [/\b(wrong site|wrong leg|wrong arm|wrong kidney|wrong patient|wrong side)\b/i, "Wrong-site / wrong-patient event"],
  [/\b(brain damage|hypoxic|anoxic|permanent disability|paralysed|paralyzed)\b/i, "Permanent neurological harm"],
  [/\b(newborn|neonate|infant|stillbirth|miscarriage|eclampsia)\b/i, "Neonatal / obstetric emergency"],
  [/\b(suicide|self-harm|psychiatric emergency)\b/i, "Psychiatric emergency"],
  [/\b(anaphylaxis|severe allergic reaction|airway)\b/i, "Airway / anaphylaxis risk"],
  [/\bunresponsive|unconscious|coma\b/i, "Reduced consciousness"],
  [/मृत्यु|मौत|निधन|देहांत/, "Patient death reported (Hindi)"],
  [/दिल का दौरा|कार्डियक अरेस्ट|सांस रुक/, "Cardiorespiratory arrest (Hindi)"],
  [/तेज़ रक्तस्राव|अत्यधिक रक्तस्राव|खून बह/, "Severe haemorrhage (Hindi)"],
  [/बेहोश|अचेत/, "Reduced consciousness (Hindi)"],
];

const HIGH_TERMS: Array<[RegExp, string]> = [
  [/\b(emergency|emergency room|ER|A&E|casualty)\b/i, "Emergency care involved"],
  [/\b(refused|denied|turned away|rejected|not treated|no treatment)\b/i, "Care refusal / denial"],
  [/\b(severe pain|excruciating|unbearable|worsening|deteriorat)\b/i, "Severe or deteriorating symptoms"],
  [/\b(surgery|operation|post-?op|surgical)\b/i, "Surgical care involved"],
  [/\b(icu|intensive care|critical care|ventilat)\b/i, "Intensive care involved"],
  [/\b(complication|infection|abscess|gangrene|blood clot)\b/i, "Clinical complication"],
  [/\b(pregnan|maternity|obstetric|labour|labor)\b/i, "Pregnancy / maternity"],
  [/\b(child|minor|pediatric|paediatric|elderly|geriatric)\b/i, "Vulnerable patient group"],
  [/\b(misdiagnos|delayed diagnos|missed diagnos|wrong diagnos)\b/i, "Diagnostic error"],
  [/\b(medication error|prescription error|wrong medication|adverse drug)\b/i, "Medication error"],
  [/\b(negligent|negligence|malpractice|standard of care)\b/i, "Negligence alleged"],
  [/\b(permanent|life-?changing|disab|amputat)\b/i, "Long-term harm"],
  [/\b(still waiting|no response|ignored|abandoned)\b/i, "Abandonment / non-response"],
  [/\b(assault|abuse|misconduct)\b/i, "Abuse or misconduct alleged"],
  [/\b(ayushman|pm-?jay|cghs|esic|cashless|reimbursement)\b/i, "Public health scheme involved"],
  [/इलाज से मना|देखभाल से इनकार|भर्ती नहीं|इनकार कर/, "Care refusal / denial (Hindi)"],
  [/गर्भवती|प्रसव|मातृत्व/, "Pregnancy / maternity (Hindi)"],
  [/इमरजेंसी|आपातकाल|आपातकालीन/, "Emergency care involved (Hindi)"],
];

const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  "Billing Fraud": [
    /\b(bill|billing|invoice|charged|overcharg|double[- ]?charg|upcod|claim|reimburs|refund|copay|co-pay|deductible|debt collect|insurance)\b/i,
    /\b(amount|fee|cost|price|payment)\b/i,
  ],
  "Prescription Error": [
    /\b(prescription|medication|medicine|drug|dosage|dose|mg\b|pharmacy|pharmacist|refill|insulin|opioid|antibiotic|adverse reaction|side effect)\b/i,
  ],
  "Denial of Care": [
    /\b(refused|denied|denial|turned away|not admitted|no treatment|rejected|pre-?authoriz|waiting list|out of network|ayushman|pm-?jay|claim)\b/i,
    /इलाज से मना|देखभाल से इनकार|भर्ती नहीं|इनकार कर|अस्वीकार/,
  ],
  Negligence: [
    /\b(negligence|negligent|malpractice|misdiagnos|delayed diagnos|missed diagnos|surgical error|wrong site|complication|infection|unsafe discharge|birth injury|ignored|medical college|casualty|triage)\b/i,
    /लापरवाही|उपेक्षा|गलत इलाज/,
  ],
  "Infrastructure/Facility Issue": [
    /\b(dirty|hygiene|sanitation|equipment|broken|malfunction|elevator|wheelchair|waiting time|staffing|understaffed|bed|ward|food|cafeteria|parking|air conditioning|facility|ventilator|oxygen|toilet|bedding)\b/i,
  ],
  "Data Privacy": [
    /\b(privacy|confidential|data breach|leaked|shared my|unauthori[sz]ed access|consent|DPDP|records request|disclos)\b/i,
  ],
  Discrimination: [
    /\b(discriminat|racis|religio|disabilit|language barrier|immigrant|sexis|homophob|transphob|ageism|caste)\b/i,
  ],
};

const VULNERABLE_RE = /\b(infant|newborn|child|minor|pregnan|elderly|disabled|wheelchair|cancer|dementia)\b/i;

const CATEGORY_BASE: Record<string, number> = {
  "Denial of Care": 26,
  "Prescription Error": 24,
  Negligence: 24,
  "Data Privacy": 14,
  Discrimination: 14,
  "Infrastructure/Facility Issue": 10,
  "Billing Fraud": 8,
  Other: 6,
};

const REGULATORY_BASIS: Record<string, Record<string, string[]>> = {
  IN: {
    "Denial of Care": [
      "Charter of Patients' Rights (2021) — emergency care cannot be refused",
      "Clinical Establishments (Registration and Regulation) Act 2010",
      "Paschim Banga Khet Mazdoor Samity v. State of West Bengal (1996) 4 SCC 37",
    ],
    Negligence: [
      "Consumer Protection Act 2019 — deficiency in medical services",
      "Bharatiya Nyaya Sanhita 2023 s.106 — death by negligence",
      "National Medical Commission Act 2019 — standards of medical practice",
    ],
    "Billing Fraud": [
      "Consumer Protection Act 2019 s.2(47) — unfair trade practice",
      "Clinical Establishments Act 2010 — charging beyond notified rates",
      "Ayushman Bharat PM-JAY Health Benefit Package guidelines",
    ],
    "Prescription Error": [
      "NMC Registered Medical Practitioner (Professional Conduct) Regulations 2023",
      "Drugs and Cosmetics Act 1940 and Rules 1945",
    ],
    "Data Privacy": [
      "Digital Personal Data Protection Act 2023 ss.4, 8 and 33",
      "Information Technology Act 2000 s.43A with SPDI Rules 2011",
    ],
    "Infrastructure/Facility Issue": [
      "Clinical Establishments (Central Government) Rules 2012 — minimum standards",
      "Charter of Patients' Rights (2021) — quality of care",
    ],
    Discrimination: [
      "Constitution of India Arts. 14, 15 and 21",
      "Charter of Patients' Rights (2021) — non-discrimination",
    ],
    Other: ["Charter of Patients' Rights (2021)", "Digital Personal Data Protection Act 2023"],
  },
};

function categorize(text: string, declared: string | undefined): { category: string; confidence: number; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    let score = 0;
    for (const re of patterns) {
      const matches = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`));
      score += matches ? Math.min(matches.length, 4) : 0;
    }
    scores[category] = score;
  }
  if (declared && declared !== "Other" && scores[declared] !== undefined) {
    scores[declared] += 3; // patient-declared category is a prior, not a verdict
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topCategory, topScore] = sorted[0];
  const total = sorted.reduce((sum, [, s]) => sum + s, 0);
  if (topScore === 0) return { category: "Other", confidence: 0.4, scores };
  const confidence = Math.max(0.35, Math.min(0.97, topScore / Math.max(1, total)));
  return { category: topCategory, confidence: Number(confidence.toFixed(2)), scores };
}

export function triage(input: {
  complaint: string;
  symptoms?: string | null;
  category?: string | null;
  incidentDate?: string | null;
  country: string;
}): TriageResult {
  const text = `${input.complaint}\n${input.symptoms ?? ""}`.trim();
  const jurisdiction = findJurisdiction(input.country);
  const signals: TriageSignal[] = [];
  let score = 0;

  const { category, confidence, scores } = categorize(text, input.category ?? undefined);
  const base = CATEGORY_BASE[category] ?? 6;
  score += base;
  signals.push({
    code: "CATEGORY_BASE",
    label: `Baseline for ${category}`,
    weight: base,
    detail: `Category baseline contributes ${base} points to the clinical priority score.`,
  });

  for (const [re, label] of CRITICAL_TERMS) {
    const m = text.match(re);
    if (m) {
      const weight = 22;
      score += weight;
      signals.push({ code: "CRITICAL_TERM", label, weight, detail: `Matched "${m[0]}". Immediate escalation indicator.` });
    }
  }

  let highHits = 0;
  for (const [re, label] of HIGH_TERMS) {
    const m = text.match(re);
    if (m && highHits < 4) {
      highHits += 1;
      const weight = 9;
      score += weight;
      signals.push({ code: "HIGH_TERM", label, weight, detail: `Matched "${m[0]}".` });
    }
  }

  if (VULNERABLE_RE.test(text)) {
    score += 8;
    signals.push({
      code: "VULNERABLE_GROUP",
      label: "Vulnerable patient group",
      weight: 8,
      detail: "Complaint references a paediatric, obstetric, elderly, or disabled patient.",
    });
  }

  if (input.incidentDate) {
    const days = (Date.now() - new Date(input.incidentDate).getTime()) / 86_400_000;
    if (Number.isFinite(days) && days >= 0) {
      if (days <= 7) {
        score += 10;
        signals.push({ code: "RECENT_INCIDENT", label: "Incident within 7 days", weight: 10, detail: "Recent events carry elevated clinical risk." });
      } else if (days <= 30) {
        score += 5;
        signals.push({ code: "RECENT_INCIDENT", label: "Incident within 30 days", weight: 5, detail: "Recent events carry elevated clinical risk." });
      }
    }
  }

  if (/\b(still|ongoing|continues|worsening)\b.*\b(pain|bleed|fever|symptom|condition)\b/i.test(text)) {
    score += 6;
    signals.push({
      code: "ONGOING_HARM",
      label: "Harm appears ongoing",
      weight: 6,
      detail: "Language indicates the patient may still be at risk.",
    });
  }

  const currency = text.match(/(?:₹\s?|\brs\.?\s?|\binr\s?)([\d][\d,.]{2,})/i) ?? text.match(/(?:[$€£R$]\s?|\b(?:usd|eur|gbp|brl)\s?)([\d][\d,.]{2,})/i);
  if (currency && Number(currency[1].replace(/[,.]/g, "")) >= 10_000) {
    score += 4;
    signals.push({
      code: "HIGH_VALUE_DISPUTE",
      label: "High-value financial dispute",
      weight: 4,
      detail: `Disputed amount ${currency[0].trim()} exceeds the escalation threshold.`,
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let priority: Priority;
  if (score >= 78) priority = "P1";
  else if (score >= 52) priority = "P2";
  else if (score >= 30) priority = "P3";
  else priority = "P4";

  // Financial-only disputes never escalate beyond P3 without a clinical signal.
  if (category === "Billing Fraud" && !signals.some((s) => s.code === "CRITICAL_TERM" || s.code === "HIGH_TERM")) {
    if (priority === "P1" || priority === "P2") priority = "P3";
  }

  const slaHours = jurisdiction?.slaHours[priority] ?? 24;
  const dueAt = new Date(Date.now() + slaHours * 3_600_000).toISOString();
  const regulatoryBasis = [
    ...(jurisdiction?.frameworks ?? []).slice(0, 2),
    ...(REGULATORY_BASIS[input.country]?.[category] ?? []),
  ];

  return {
    priority,
    score,
    category,
    categoryConfidence: confidence,
    signals,
    categoryScores: scores,
    slaHours,
    dueAt,
    regulatoryBasis,
    humanReviewRecommended: priority === "P1" || confidence < 0.5,
  };
}
