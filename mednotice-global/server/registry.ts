import { all, get, nowIso, run } from "./db.js";
import { JURISDICTIONS, findJurisdiction, type Authority, type Jurisdiction } from "./config.js";

/**
 * Directory registry for health authorities and facilities.
 *
 * The code-defined catalogue in `config.ts` seeds the registry on first boot;
 * after that the database is the source of truth so administrators can add,
 * edit and retire authorities and facilities at runtime. Every runtime lookup
 * (routing, notifications, verification, patient intake) goes through here.
 */

export type AuthorityRecord = {
  id: string;
  name: string;
  country: string;
  region: string;
  adapter: string;
  contactEmail: string;
  webhook: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type FacilityRecord = {
  id: string;
  name: string;
  authorityId: string;
  country: string;
  city: string | null;
  letterheadKeywords: string[];
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
};

type AuthorityRow = {
  id: string;
  name: string;
  country: string;
  region: string;
  adapter: string;
  contact_email: string;
  webhook: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type FacilityRow = {
  id: string;
  name: string;
  authority_id: string;
  country: string;
  city: string | null;
  letterhead_keywords: string;
  status: string;
  updated_at: string | null;
};

/** Facility statuses that patients may pick during intake. */
export const PATIENT_VISIBLE_FACILITY_STATUS = "VERIFIED";

function authorityFromRow(row: AuthorityRow): AuthorityRecord {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    region: row.region,
    adapter: row.adapter,
    contactEmail: row.contact_email,
    webhook: row.webhook,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function facilityFromRow(row: FacilityRow): FacilityRecord {
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(row.letterhead_keywords || "[]");
    if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    keywords = [];
  }
  return {
    id: row.id,
    name: row.name,
    authorityId: row.authority_id,
    country: row.country,
    city: row.city,
    letterheadKeywords: keywords,
    status: row.status,
    createdAt: null,
    updatedAt: row.updated_at,
  };
}

function configuredAuthority(id: string): { jurisdiction: Jurisdiction; authority: Authority } | undefined {
  for (const jurisdiction of JURISDICTIONS) {
    const authority = jurisdiction.authorities.find((a) => a.id === id);
    if (authority) return { jurisdiction, authority };
  }
  return undefined;
}

/**
 * Insert the code-defined catalogue once. Administrator edits are never
 * overwritten — a row that already exists is left untouched.
 */
export function seedAuthorities(): void {
  const now = nowIso();
  for (const jurisdiction of JURISDICTIONS) {
    for (const authority of jurisdiction.authorities) {
      run(
        `INSERT OR IGNORE INTO authorities (id, name, country, region, adapter, contact_email, webhook, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        authority.id,
        authority.name,
        jurisdiction.code,
        authority.region,
        authority.adapter,
        authority.contactEmail,
        authority.webhook,
        now,
        now,
      );
    }
  }
}

export function listAuthorities(opts: { country?: string; includeInactive?: boolean } = {}): AuthorityRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.country) {
    where.push("country = ?");
    params.push(opts.country.toUpperCase());
  }
  if (!opts.includeInactive) where.push("status = 'ACTIVE'");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return all<AuthorityRow>(`SELECT * FROM authorities ${clause} ORDER BY country, name`, ...params).map(authorityFromRow);
}

export function getAuthority(id: string): AuthorityRecord | undefined {
  const row = get<AuthorityRow>("SELECT * FROM authorities WHERE id = ?", id.toUpperCase());
  return row ? authorityFromRow(row) : undefined;
}

/**
 * Resolve an authority for routing and notifications. The registry row wins;
 * the code catalogue is the fallback for databases that were never seeded.
 */
export function findAuthority(id: string): { jurisdiction: Jurisdiction; authority: Authority } | undefined {
  const row = get<AuthorityRow>("SELECT * FROM authorities WHERE id = ?", id.toUpperCase());
  if (row) {
    const jurisdiction = findJurisdiction(row.country) ?? findJurisdiction("IN");
    if (!jurisdiction) return undefined;
    return {
      jurisdiction,
      authority: {
        id: row.id,
        name: row.name,
        region: row.region,
        adapter: row.adapter,
        contactEmail: row.contact_email,
        webhook: row.webhook,
      },
    };
  }
  return configuredAuthority(id);
}

export function listFacilities(opts: { authorityId?: string; includeInactive?: boolean; patientVisibleOnly?: boolean } = {}): FacilityRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.authorityId) {
    where.push("authority_id = ?");
    params.push(opts.authorityId.toUpperCase());
  }
  if (opts.patientVisibleOnly) {
    where.push("status = ?");
    params.push(PATIENT_VISIBLE_FACILITY_STATUS);
  } else if (!opts.includeInactive) {
    where.push("status != 'CLOSED'");
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return all<FacilityRow>(`SELECT * FROM facilities ${clause} ORDER BY country, name`, ...params).map(facilityFromRow);
}

export function getFacility(id: string): FacilityRecord | undefined {
  const row = get<FacilityRow>("SELECT * FROM facilities WHERE id = ?", id.toUpperCase());
  return row ? facilityFromRow(row) : undefined;
}

export function facilityCountForAuthority(authorityId: string): number {
  const row = get<{ n: number }>("SELECT COUNT(*) AS n FROM facilities WHERE authority_id = ?", authorityId);
  return Number(row?.n ?? 0);
}

export function caseCountForAuthority(authorityId: string): number {
  const row = get<{ n: number }>("SELECT COUNT(*) AS n FROM cases WHERE authority_id = ?", authorityId);
  return Number(row?.n ?? 0);
}

export function caseCountForFacility(facilityId: string): number {
  const row = get<{ n: number }>("SELECT COUNT(*) AS n FROM cases WHERE facility_id = ?", facilityId);
  return Number(row?.n ?? 0);
}
