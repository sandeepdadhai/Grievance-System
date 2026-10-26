import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export const db = new DatabaseSync(path.join(DATA_DIR, "mednotice.sqlite"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  country TEXT,
  organisation TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  consent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_role TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  access_code_hash TEXT,
  patient_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  patient_name_enc TEXT,
  patient_email_enc TEXT,
  patient_phone_enc TEXT,
  patient_name_masked TEXT,
  patient_email_masked TEXT,
  country TEXT NOT NULL,
  region TEXT,
  authority_id TEXT NOT NULL,
  facility_id TEXT,
  facility_name TEXT,
  category TEXT NOT NULL,
  category_confidence REAL NOT NULL DEFAULT 0,
  priority TEXT NOT NULL,
  priority_score INTEGER NOT NULL DEFAULT 0,
  triage_json TEXT NOT NULL DEFAULT '{}',
  complaint_enc TEXT NOT NULL,
  symptoms_enc TEXT,
  timeline_json TEXT NOT NULL DEFAULT '[]',
  incident_date TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  verification_status TEXT NOT NULL DEFAULT 'PENDING',
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  consent_data_sharing INTEGER NOT NULL DEFAULT 0,
  cross_border_allowed INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'en',
  source TEXT NOT NULL DEFAULT 'PORTAL',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sla_due_at TEXT NOT NULL,
  resolved_at TEXT,
  authority_status TEXT,
  authority_status_at TEXT,
  authority_reference TEXT
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority);
CREATE INDEX IF NOT EXISTS idx_cases_country ON cases(country);
CREATE INDEX IF NOT EXISTS idx_cases_created ON cases(created_at);
CREATE INDEX IF NOT EXISTS idx_cases_patient ON cases(patient_user_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT,
  kind TEXT NOT NULL,
  page_count INTEGER,
  has_text_layer INTEGER,
  verification_status TEXT NOT NULL,
  score INTEGER NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  extracted_json TEXT NOT NULL DEFAULT '{}',
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT,
  uploaded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);

CREATE TABLE IF NOT EXISTS case_reviews (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  previous_json TEXT NOT NULL DEFAULT '{}',
  new_json TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  ip TEXT,
  user_agent TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS transmissions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  adapter_code TEXT NOT NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  reference TEXT
);

CREATE INDEX IF NOT EXISTS idx_transmissions_case ON transmissions(case_id);
CREATE INDEX IF NOT EXISTS idx_transmissions_created ON transmissions(created_at);

CREATE TABLE IF NOT EXISTS case_status_syncs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  transmission_id TEXT,
  authority_id TEXT NOT NULL,
  adapter_code TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  remote_status TEXT,
  remote_reference TEXT,
  message TEXT,
  http_status INTEGER,
  latency_ms INTEGER,
  applied INTEGER NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 0,
  response_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_syncs_case ON case_status_syncs(case_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_status_syncs_checked ON case_status_syncs(checked_at);

CREATE TABLE IF NOT EXISTS adapters (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_endpoint TEXT,
  auth_type TEXT NOT NULL DEFAULT 'NONE',
  auth_config_enc TEXT,
  mapping_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  simulate INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS authorities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  region TEXT NOT NULL,
  adapter TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  webhook TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authorities_country ON authorities(country);

CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT,
  letterhead_keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'VERIFIED'
);

CREATE TABLE IF NOT EXISTS physician_licenses (
  license_no TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  facility_id TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  source TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  is_guest INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'General',
  status TEXT NOT NULL DEFAULT 'VISIBLE',
  pinned INTEGER NOT NULL DEFAULT 0,
  edit_note TEXT,
  edited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  edited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_posts_status ON community_posts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_community_posts_author ON community_posts(author_user_id);

CREATE TABLE IF NOT EXISTS community_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  is_guest INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'VISIBLE',
  edit_note TEXT,
  edited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  edited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_community_comments_status ON community_comments(status);
`);

/** Additive column migration for databases created before a field existed. */
function ensureColumn(table: string, column: string, ddl: string): void {
  const columns = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

ensureColumn("users", "consent_at", "TEXT");
/** Facility-bound accounts only see cases filed against their own facility. */
ensureColumn("users", "facility_id", "TEXT");
ensureColumn("facilities", "updated_at", "TEXT");
ensureColumn("cases", "authority_status", "TEXT");
ensureColumn("cases", "authority_status_at", "TEXT");
ensureColumn("cases", "authority_reference", "TEXT");
ensureColumn("transmissions", "reference", "TEXT");
ensureColumn("adapters", "status_endpoint", "TEXT");
/** WhatsApp number for patient notifications (AES-256-GCM encrypted). */
ensureColumn("users", "phone_enc", "TEXT");
ensureColumn("users", "whatsapp_opt_in", "INTEGER NOT NULL DEFAULT 0");
/** Queue payload for channels that need structured fields (WhatsApp templates). */
ensureColumn("notifications", "meta_json", "TEXT");
ensureColumn("notifications", "provider_ref", "TEXT");

export function nowIso(): string {
  return new Date().toISOString();
}

export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function count(sql: string, ...params: unknown[]): number {
  const row = get<{ n: number }>(sql, ...params);
  return Number(row?.n ?? 0);
}
