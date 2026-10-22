import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-triage-"));

const { triage } = await import("../server/triage.js");

test("patient death with cardiac arrest escalates to P1 with critical drivers", () => {
  const result = triage({
    complaint:
      "My husband waited four hours in the emergency room with chest pain. He went into cardiac arrest and died before anyone treated him. The triage nurse ignored him.",
    symptoms: "Crushing chest pain and shortness of breath.",
    category: "Negligence",
    incidentDate: new Date().toISOString().slice(0, 10),
    country: "US",
  });
  assert.equal(result.priority, "P1");
  assert.ok(result.score >= 78);
  assert.equal(result.category, "Negligence");
  assert.ok(result.signals.some((s) => /death/i.test(s.label)));
  assert.equal(result.slaHours, 1);
  assert.ok(result.regulatoryBasis.length > 0);
  assert.equal(result.humanReviewRecommended, true);
});

test("denial of emergency maternity care is categorised and prioritised", () => {
  const result = triage({
    complaint:
      "I was 34 weeks pregnant with heavy bleeding. The emergency department refused to treat me and sent me to another hospital. I was bleeding for two hours and lost consciousness.",
    symptoms: "Heavy vaginal bleeding, dizziness.",
    category: "Other",
    incidentDate: new Date().toISOString().slice(0, 10),
    country: "DE",
  });
  assert.equal(result.category, "Denial of Care");
  assert.ok(["P1", "P2"].includes(result.priority));
  assert.equal(result.slaHours, result.priority === "P1" ? 2 : 8);
  assert.ok(result.regulatoryBasis.some((r) => /SGB V|Patientenrechte/.test(r)));
});

test("billing-only disputes never escalate above P3", () => {
  const result = triage({
    complaint:
      "I was double charged for the same MRI and the billing office sent my account to a debt collector. The invoice is for $12,400 although insurance already paid.",
    category: "Billing Fraud",
    country: "US",
  });
  assert.equal(result.category, "Billing Fraud");
  assert.ok(["P3", "P4"].includes(result.priority));
  assert.ok(result.score < 78);
});

test("privacy complaints are categorised without clinical escalation", () => {
  const result = triage({
    complaint:
      "My clinic shared my medical records with my employer without consent. My diagnosis was disclosed to HR and I never authorised the transfer of my data.",
    country: "SG",
  });
  assert.equal(result.category, "Data Privacy");
  assert.ok(["P3", "P4"].includes(result.priority));
});

test("infrastructure complaints are low acuity but correctly categorised", () => {
  const result = triage({
    complaint: "The signage to the new outpatient clinic is unclear and the waiting area was dirty. I walked 40 minutes to find the entrance.",
    country: "DE",
  });
  assert.equal(result.category, "Infrastructure/Facility Issue");
  assert.ok(["P3", "P4"].includes(result.priority));
  assert.ok(result.categoryConfidence > 0 && result.categoryConfidence <= 1);
});

test("SLA follows the jurisdiction matrix", () => {
  const us = triage({ complaint: "Scheduled follow-up was delayed by three weeks and I received no response to my calls or emails about the appointment.", country: "US" });
  const de = triage({ complaint: "Scheduled follow-up was delayed by three weeks and I received no response to my calls or emails about the appointment.", country: "DE" });
  assert.equal(us.priority, de.priority);
  if (us.priority === "P3") {
    assert.equal(us.slaHours, 24);
    assert.equal(de.slaHours, 48);
  }
});
