import crypto from "node:crypto";
import type { AdapterAck, AdapterConfig, BuiltRequest, CasePayload, RoutingAdapter } from "./types.js";

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tag(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export const soapAdapter: RoutingAdapter = {
  kind: "SOAP",
  build(payload: CasePayload, config: AdapterConfig): BuiltRequest {
    const mapping = config.mapping ?? {};
    const operation = tag(String(mapping.operation ?? "SubmitComplaint"));
    const namespace = xml(String(mapping.namespace ?? "urn:mednotice:complaint:v1"));
    const fields: Array<[string, string]> = [
      ["CaseReference", payload.caseId],
      ["Jurisdiction", payload.country],
      ["AuthorityCode", payload.authorityId],
      ["FacilityName", payload.facilityName],
      ["Priority", payload.priority],
      ["PriorityScore", String(payload.priorityScore)],
      ["Category", payload.category],
      ["VerificationStatus", payload.verificationStatus],
      ["Narrative", payload.complaint],
      ["Symptoms", payload.symptoms ?? ""],
      ["PatientName", payload.patient.name],
      ["PatientEmail", payload.patient.email],
      ["SubmittedAt", payload.createdAt],
      ["PiiMasked", String(payload.masked)],
    ];
    const documentXml = payload.documents
      .map(
        (doc) =>
          `      <Document><FileName>${xml(doc.filename)}</FileName><Digest>${xml(doc.sha256)}</Digest><Status>${xml(doc.status)}</Status><TrustScore>${doc.score}</TrustScore></Document>`,
      )
      .join("\n");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:mn="${namespace}">
  <soap:Header>
    <mn:Security><mn:Source>MEDNOTICE-GLOBAL</mn:Source><mn:Jurisdiction>${xml(payload.country)}</mn:Jurisdiction></mn:Security>
  </soap:Header>
  <soap:Body>
    <mn:${operation}>
${fields.map(([k, v]) => `      <mn:${k}>${xml(v)}</mn:${k}>`).join("\n")}
      <mn:Documents>
${documentXml || "      <!-- no documents -->"}
      </mn:Documents>
    </mn:${operation}>
  </soap:Body>
</soap:Envelope>`;
    return {
      payload: body,
      contentType: "application/soap+xml; charset=utf-8",
      summary: `SOAP 1.2 ${operation} envelope (${namespace})`,
      headers: mapping.soapAction ? { SOAPAction: String(mapping.soapAction) } : {},
    };
  },
  parseAck(status: number, body: string, simulated: boolean): AdapterAck {
    if (simulated) return { ok: true, ackId: `sim-soap-${crypto.randomUUID().slice(0, 8)}`, message: "SOAP acknowledgement received from simulator", httpStatus: 200 };
    const fault = /<(?:\w+:)?Fault[\s>]/.test(body);
    const ackId = body.match(/<(?:[\w]+:)?(?:CaseReference|AcknowledgementId|ReceiptId)>([^<]+)</)?.[1] ?? null;
    return {
      ok: status >= 200 && status < 300 && !fault,
      ackId,
      message: fault ? "SOAP Fault returned by endpoint" : `SOAP endpoint responded HTTP ${status}`,
      httpStatus: status,
    };
  },
  simulate(payload) {
    return {
      status: 200,
      body: `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><SubmitComplaintResponse><CaseReference>${xml(payload.caseId)}</CaseReference><AcknowledgementId>${crypto.randomUUID()}</AcknowledgementId><Status>ACCEPTED</Status></SubmitComplaintResponse></soap:Body></soap:Envelope>`,
    };
  },
};
