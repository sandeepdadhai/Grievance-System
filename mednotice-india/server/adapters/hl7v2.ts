import crypto from "node:crypto";
import type { AdapterAck, BuiltRequest, CasePayload, RoutingAdapter } from "./types.js";

function esc(value: string): string {
  return value.replace(/\\/g, "\\E\\").replace(/\|/g, "\\F\\").replace(/\^/g, "\\S\\").replace(/~/g, "\\R\\").replace(/\r?\n/g, "\\X0D\\");
}

function hl7Timestamp(iso: string): string {
  return iso.replace(/[-:TZ.]/g, "").slice(0, 14);
}

/** Builds a pipe-delimited HL7 v2.5 ORU^R01 observation message. */
export const hl7Adapter: RoutingAdapter = {
  kind: "HL7v2",
  build(payload: CasePayload): BuiltRequest {
    const controlId = `MN${Date.now().toString(36).toUpperCase()}`;
    const [family, ...given] = payload.patient.name.split(" ");
    const segments = [
      `MSH|^~\\&|MEDNOTICE|INDIA|${esc(payload.authorityId)}|${esc(payload.country)}|${hl7Timestamp(new Date().toISOString())}||ORU^R01|${controlId}|P|2.5|||||${payload.country}`,
      `PID|1||${esc(payload.caseId)}||${esc(family)}^${esc(given.join(" "))}|||||||||||${esc(payload.patient.email)}`,
      `PV1|1|${payload.priority === "P1" ? "E" : "O"}|||${esc(payload.facilityName)}||||||||||||||||${esc(payload.caseId)}`,
      `ORC|NW|${esc(payload.caseId)}|||||||${hl7Timestamp(payload.createdAt)}`,
      `OBR|1|${esc(payload.caseId)}||GRIEVANCE^Patient complaint^L|||${hl7Timestamp(payload.createdAt)}||||||||||${esc(payload.facilityName)}`,
      `OBX|1|ST|PRIORITY^Clinical priority^L||${payload.priority}||||||F`,
      `OBX|2|NM|SCORE^Priority score^L||${payload.priorityScore}||||||F`,
      `OBX|3|ST|CATEGORY^Case category^L||${esc(payload.category)}||||||F`,
      `OBX|4|TX|NARRATIVE^Complaint narrative^L||${esc(payload.complaint)}||||||F`,
      `OBX|5|TX|SYMPTOMS^Reported symptoms^L||${esc(payload.symptoms ?? "")}||||||F`,
      `OBX|6|ST|VERIF^Document verification^L||${payload.verificationStatus}||||||F`,
      ...payload.documents.map((doc, i) => `OBX|${7 + i}|ST|DOC${i + 1}^${esc(doc.filename)}^L||${doc.status}/${doc.sha256.slice(0, 16)}||||||F`),
    ];
    return {
      payload: `${segments.join("\r")}\r`,
      contentType: "application/hl7-v2",
      summary: `HL7 v2.5 ORU^R01 (${controlId}) with ${4 + payload.documents.length} OBX segments`,
    };
  },
  parseAck(status: number, body: string, simulated: boolean): AdapterAck {
    if (simulated) return { ok: true, ackId: `sim-hl7-${crypto.randomUUID().slice(0, 8)}`, message: "HL7 ACK AA received from simulator", httpStatus: 200 };
    const ackCode = body.match(/\bMSA\|([A-Z]{2})\|?([^|\r]*)/);
    const ok = status >= 200 && status < 300 && (!ackCode || ackCode[1] === "AA");
    return {
      ok,
      ackId: ackCode?.[2] || null,
      message: ackCode ? `HL7 MSA ${ackCode[1]}` : `HL7 endpoint returned HTTP ${status}`,
      httpStatus: status,
    };
  },
  simulate(payload) {
    return {
      status: 200,
      body: `MSH|^~\\&|${payload.authorityId}|${payload.country}|MEDNOTICE|INDIA|${hl7Timestamp(new Date().toISOString())}||ACK^R01|ACK${Date.now()}|P|2.5\rMSA|AA|${payload.caseId}\r`,
    };
  },
};
