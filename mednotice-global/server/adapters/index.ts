import { get } from "../db.js";
import { JURISDICTIONS, findJurisdiction } from "../config.js";
import { findAuthority, listAuthorities } from "../registry.js";
import { fhirAdapter } from "./fhir.js";
import { hl7Adapter } from "./hl7v2.js";
import { restAdapter } from "./rest.js";
import { soapAdapter } from "./soap.js";
import type { AdapterConfig, AdapterKind, RoutingAdapter } from "./types.js";

const IMPLEMENTATIONS: Record<AdapterKind, RoutingAdapter> = {
  FHIR: fhirAdapter,
  HL7v2: hl7Adapter,
  REST: restAdapter,
  SOAP: soapAdapter,
};

export type AdapterRow = {
  code: string;
  name: string;
  country: string;
  kind: AdapterKind;
  endpoint: string;
  status_endpoint: string | null;
  auth_type: string;
  auth_config_enc: string | null;
  mapping_json: string;
  enabled: number;
  simulate: number;
  created_at: string;
  updated_at: string;
};

export function implementationFor(kind: string): RoutingAdapter {
  const impl = IMPLEMENTATIONS[kind as AdapterKind];
  if (!impl) throw new Error(`Unsupported adapter kind: ${kind}`);
  return impl;
}

function inferKind(code: string): AdapterKind {
  if (/HL7/i.test(code)) return "HL7v2";
  if (/SOAP/i.test(code)) return "SOAP";
  if (/FHIR/i.test(code)) return "FHIR";
  return "REST";
}

/**
 * Resolve an adapter configuration. A DB row always wins; otherwise a
 * configuration-only fallback is derived from the jurisdiction registry so a
 * new country can be onboarded without code changes.
 */
export function resolveAdapter(code: string): { config: AdapterConfig; row: AdapterRow | null } {
  const row = get<AdapterRow>("SELECT * FROM adapters WHERE code = ?", code);
  if (row) {
    return {
      row,
      config: {
        code: row.code,
        kind: row.kind,
        endpoint: row.endpoint,
        statusEndpoint: row.status_endpoint ?? null,
        authType: row.auth_type,
        authConfig: row.auth_config_enc ? (JSON.parse(row.auth_config_enc) as Record<string, string>) : null,
        mapping: JSON.parse(row.mapping_json || "{}"),
        simulate: Boolean(row.simulate),
      },
    };
  }

  for (const jurisdiction of JURISDICTIONS) {
    const j = findJurisdiction(jurisdiction.code);
    const authority = listAuthorities({ country: jurisdiction.code, includeInactive: true }).find((a) => a.adapter === code);
    if (authority && j) {
      return {
        row: null,
        config: {
          code,
          kind: inferKind(code),
          endpoint: authority.webhook,
          statusEndpoint: null,
          authType: "NONE",
          mapping: { jurisdiction: j.code, fallback: true },
          simulate: true,
        },
      };
    }
  }
  throw new Error(`Unknown adapter: ${code}`);
}

export function adapterForAuthority(authorityId: string): string {
  const found = findAuthority(authorityId);
  return found?.authority.adapter ?? "US-FHIR";
}

export function listAdapters(): Array<AdapterRow & { maskedAuth: boolean }> {
  const rows = get<AdapterRow[]>("SELECT * FROM adapters ORDER BY country, code") as AdapterRow[];
  return [...(rows as unknown as Array<AdapterRow & { maskedAuth: boolean }>)].map((r) => ({ ...r, maskedAuth: Boolean(r.auth_config_enc) }));
}
