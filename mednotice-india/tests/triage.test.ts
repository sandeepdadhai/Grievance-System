import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-triage-"));

const { triage } = await import("../server/triage.js");

const INDIA_SLA = { P1: 2, P2: 12, P3: 48, P4: 168 } as const;

test("patient death with cardiac arrest escalates to P1 with critical drivers", () => {
  const result = triage({
    complaint:
      "My husband waited four hours in the emergency room with chest pain. He went into cardiac arrest and died before anyone treated him. The triage nurse ignored him.",
    symptoms: "Crushing chest pain and shortness of breath.",
    category: "Negligence",
    incidentDate: new Date().toISOString().slice(0, 10),
    country: "IN",
  });
  assert.equal(result.priority, "P1");
  assert.ok(result.score >= 78);
  assert.equal(result.category, "Negligence");
  assert.ok(result.signals.some((s) => /death/i.test(s.label)));
  assert.equal(result.slaHours, 2);
  assert.ok(result.regulatoryBasis.some((r) => /Consumer Protection|Bharatiya Nyaya/.test(r)));
  assert.equal(result.humanReviewRecommended, true);
});

test("denial of emergency maternity care is categorised and prioritised", () => {
  const result = triage({
    complaint:
      "I was 34 weeks pregnant with heavy bleeding. The emergency department refused to treat me and sent me to another hospital. I was bleeding for two hours and lost consciousness.",
    symptoms: "Heavy vaginal bleeding, dizziness.",
    category: "Other",
    incidentDate: new Date().toISOString().slice(0, 10),
    country: "IN",
  });
  assert.equal(result.category, "Denial of Care");
  assert.ok(["P1", "P2"].includes(result.priority));
  assert.equal(result.slaHours, INDIA_SLA[result.priority]);
  assert.ok(result.regulatoryBasis.some((r) => /Charter of Patients|Clinical Establishments/.test(r)));
});

test("Hindi-language emergency narratives are triaged by the India matrix", () => {
  const result = triage({
    complaint:
      "मेरी पत्नी 34 सप्ताह की गर्भवती थी और उसे तेज़ रक्तस्राव हो रहा था। अस्पताल की इमरजेंसी ने इलाज से मना कर दिया। दो घंटे बाद वह बेहोश हो गई।",
    symptoms: "तेज़ योनि रक्तस्राव, चक्कर और बेहोशी।",
    category: "Other",
    incidentDate: new Date().toISOString().slice(0, 10),
    country: "IN",
  });
  assert.equal(result.category, "Denial of Care");
  assert.ok(["P1", "P2"].includes(result.priority));
  assert.equal(result.slaHours, INDIA_SLA[result.priority]);
  assert.ok(result.signals.some((s) => /Hindi/.test(s.label)));
  assert.ok(result.regulatoryBasis.length > 0);
});

test("billing-only disputes never escalate above P3", () => {
  const result = triage({
    complaint:
      "I was double charged for the same MRI and the billing office sent my account to a recovery agent. The invoice is for ₹1,24,000 although my insurer already paid.",
    category: "Billing Fraud",
    country: "IN",
  });
  assert.equal(result.category, "Billing Fraud");
  assert.ok(["P3", "P4"].includes(result.priority));
  assert.ok(result.score < 78);
});

test("privacy complaints are categorised without clinical escalation", () => {
  const result = triage({
    complaint:
      "My clinic shared my medical records with my employer without consent. My diagnosis was disclosed to HR and I never authorised the transfer of my data.",
    country: "IN",
  });
  assert.equal(result.category, "Data Privacy");
  assert.ok(["P3", "P4"].includes(result.priority));
  assert.ok(result.regulatoryBasis.some((r) => /Digital Personal Data Protection/.test(r)));
});

test("infrastructure complaints are low acuity but correctly categorised", () => {
  const result = triage({
    complaint: "The signage to the new outpatient clinic is unclear and the waiting area was dirty. I walked 40 minutes to find the entrance.",
    country: "IN",
  });
  assert.equal(result.category, "Infrastructure/Facility Issue");
  assert.ok(["P3", "P4"].includes(result.priority));
  assert.ok(result.categoryConfidence > 0 && result.categoryConfidence <= 1);
});

test("every priority maps to the India SLA matrix", () => {
  for (let i = 0; i < 25; i += 1) {
    const result = triage({
      complaint: `Follow-up appointment ${i} was delayed and I received no response to my calls or emails. The waiting area was dirty.`,
      country: "IN",
    });
    assert.equal(result.slaHours, INDIA_SLA[result.priority]);
  }
});
