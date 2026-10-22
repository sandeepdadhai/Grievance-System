import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mn-crypto-"));

const { encryptField, decryptField, encryptBuffer, decryptBuffer, hashPassword, verifyPassword, maskEmail, maskName, maskText, maskPayload, sha256Hex } = await import(
  "../server/crypto.js"
);

test("AES-256-GCM field encryption round-trips and never stores plaintext", () => {
  const plaintext = "Synthetic patient narrative with identifier 123-45-6789";
  const encrypted = encryptField(plaintext)!;
  assert.ok(encrypted.startsWith("v1:"));
  assert.ok(!encrypted.includes("Synthetic"));
  assert.equal(decryptField(encrypted), plaintext);
});

test("field decryption rejects tampered ciphertext", () => {
  const encrypted = encryptField("tamper me")!;
  const parts = encrypted.split(":");
  parts[3] = `${parts[3].slice(0, -2)}AA`;
  assert.equal(decryptField(parts.join(":")), "[decryption failed]");
});

test("binary envelope encryption round-trips", () => {
  const data = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
  const encrypted = encryptBuffer(data);
  assert.notDeepEqual(encrypted, data);
  assert.deepEqual(decryptBuffer(encrypted), data);
});

test("scrypt password hashes verify and reject wrong passwords", async () => {
  const hash = await hashPassword("Correct-Horse-9!");
  assert.ok(hash.startsWith("scrypt$"));
  assert.equal(await verifyPassword("Correct-Horse-9!", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("PII masking preserves shape while removing identifiers", () => {
  assert.match(maskEmail("maria.santos@example.com"), /^m\*+@e\*+\.com$/);
  assert.equal(maskName("Maria Santos"), "M**** S*****");
  const masked = maskText("Contact Maria Santos at maria.santos@example.com or +1 555 123 4567. MRN: AB-99123", ["Maria Santos"]);
  assert.ok(!masked.includes("maria.santos"));
  assert.ok(!masked.includes("555 123 4567"));
  assert.ok(!masked.includes("AB-99123"));
  assert.ok(masked.includes("M****"));
});

test("payload masking recurses through objects and redacts contact fields", () => {
  const masked = maskPayload(
    { patient: { name: "Maria Santos", email: "maria.santos@example.com" }, narrative: "Maria Santos was seen at St. Mary's.", markers: [1, 2] },
    ["Maria Santos"],
  ) as { patient: { name: string; email: string }; narrative: string };
  assert.ok(!JSON.stringify(masked).includes("maria.santos"));
  assert.ok(!masked.narrative.includes("Maria Santos"));
  assert.equal(masked.patient.email, "***masked***");
});

test("sha256 is stable", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
