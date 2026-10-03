#!/usr/bin/env node

import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import process from "node:process";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const CATALOG_ARTIFACT = JSON.parse(readFileSync(new URL("./inbox-reconcile-catalog.expected.json", import.meta.url), "utf8"));
export const EXPECTED_CATALOG_FINGERPRINT = CATALOG_ARTIFACT.catalog_fingerprint;

export const PINNED_CA_FINGERPRINT =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

const HEX64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n([\s\S]*?)\r?\n-----END CERTIFICATE-----/;
const RECOVERY_REBUILD_TIMEOUT_MS = 90_000;
const RECOVERY_BATCH_SIZE = 20;
const RECOVERY_SOURCE_BATCH_SIZE = 100;
const RECOVERY_LOCK_TIMEOUT = "50ms";
const RECOVERY_TARGET_TXN_BUDGET_MS = 25;
const RECOVERY_SKIP_RETRY_ATTEMPTS = 4;
const RECOVERY_SKIP_RETRY_BACKOFF_MS = 25;
const RECOVERY_SKIP_RETRY_MAX_BACKOFF_MS = 200;

export const SOURCE_WRITERS = Object.freeze([
  ["public.messages", "zzzzz_inbox_message_direct"],
  ["public.messages", "zzzzzzzz_inbox_operation_target"],
  ["public.messages", "zzz_inbox_guard_inbound_revision_insert"],
  ["public.messages", "zzz_inbox_guard_inbound_revision_update"],
  ["public.messages", "inbox_capture_inbound_head"],
  ["public.ai_disposition_reviews", "zzzzzzzz_inbox_operation_target"],
  ["public.properties", "zzzzz_inbox_parent"],
  ["public.properties", "zzzzzz_inbox_policy"],
  ["public.properties", "zzzzzzzzz_inbox_sms_scope"],
  ["public.properties", "zzzzzzz_inbox_reply_context"],
  ["public.contacts", "zzzzz_inbox_parent"],
  ["public.contacts", "zzzzzz_inbox_policy"],
  ["public.ai_disposition_reviews", "zzzzz_inbox_parent_review"],
  ["public.ai_disposition_reviews", "zzzzzz_inbox_policy"],
  ["public.consent_events", "zzzzz_inbox_safety_consent"],
  ["public.consent_events", "zzzzzz_inbox_policy"],
  ["public.message_threads", "zzzzz_inbox_safety_thread"],
  ["public.message_threads", "zzzzz_inbox_backfill_collision"],
  ["public.message_threads", "zzzzzz_inbox_policy"],
  ["public.sms_phone_suppressions", "zzzzz_inbox_safety_suppression"],
  ["public.sms_phone_suppressions", "zzzzzz_inbox_policy"],
  ["public.memberships", "zzzzzz_inbox_policy"],
  ["public.memberships", "zzzzzzz_inbox_access"],
  ["public.sequence_enrollments", "zzzzzzzzz_inbox_sms_scope"],
  ["public.provider_sender_numbers", "zzzzzzz_inbox_reply_context"],
  ["public.organizations", "zzzzzzz_inbox_reply_context"],
  ["auth.sessions", "zzzzzzz_inbox_access"],
  ["inbox_message_capture.dirty", "maintained_queue"],
  ["inbox_maintained.rows", "bridge_projection"],
  ["inbox_maintained.rows", "bridge_filter_projection"],
]);

const CATALOG_SCHEMAS = Object.freeze([
  "inbox_capture_boundary",
  "inbox_control",
  "inbox_summary_contract",
  "inbox_unknown_summary",
  "inbox_authenticated_detail",
  "inbox_maintained",
  "inbox_message_capture",
  "inbox_parent",
  "inbox_policy",
  "inbox_safety",
  "inbox_backfill",
  "inbox_bridge",
  "inbox_read",
  "inbox_operations",
  "inbox_saved_actions",
  "inbox_operation_domain",
  "inbox_action_api",
  "inbox_reply_context",
  "inbox_reply_preparation",
  "inbox_reply_review",
  "inbox_reply_send",
]);

const CATALOG_RELATIONS = Object.freeze([
  "public.messages",
  "public.properties",
  "public.contacts",
  "public.ai_disposition_reviews",
  "public.consent_events",
  "public.message_threads",
  "public.sms_phone_suppressions",
  "public.memberships",
  "public.sequence_enrollments",
  "public.provider_sender_numbers",
  "auth.sessions",
]);

const sql = (text, values = []) => ({ text, values });

export class ReconciliationBlocked extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class ReconciliationCommitted extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
    this.committed = true;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function digestJson(value) {
  return sha256(JSON.stringify(stable(value)));
}

function fingerprint(raw) {
  return createHash("sha256").update(raw).digest("hex").toUpperCase().match(/../g).join(":");
}

function canonicalPem(raw) {
  const text = raw.toString("utf8");
  const blocks = [...text.matchAll(PEM_BLOCK)];
  const match = CERTIFICATE.exec(text);
  if (blocks.length !== 1 || !match) throw new Error("TLS_CA_INVALID");
  if (text.slice(0, match.index).trim() || text.slice(match.index + match[0].length).trim()) {
    throw new Error("TLS_CA_INVALID");
  }
  const encoded = match[1].replace(/\r?\n/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("TLS_CA_INVALID");
  const der = Buffer.from(encoded, "base64");
  if (!der.length || der.toString("base64") !== encoded) throw new Error("TLS_CA_INVALID");
  const cert = new X509Certificate(der);
  const canonical = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
  if (canonical.trimEnd() !== match[0]) throw new Error("TLS_CA_INVALID");
  return { cert, der, pem: canonical };
}

export function pinnedCa(env = process.env, expected = PINNED_CA_FINGERPRINT) {
  const path = env.INBOX_RECONCILIATION_CA_FILE ?? env.NODE_EXTRA_CA_CERTS;
  if (!path) throw new Error("TLS_CA_REQUIRED");
  let parsed;
  try {
    parsed = canonicalPem(readFileSync(path));
  } catch (error) {
    if (error?.message === "TLS_CA_INVALID") throw error;
    throw new Error("TLS_CA_INVALID");
  }
  if (fingerprint(parsed.der) !== expected) throw new Error("TLS_CA_PIN_MISMATCH");
  return { path, ...parsed, fingerprint: expected };
}

function parseDsn(dsn) {
  let url;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("DATABASE_URL_INVALID");
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.hash) {
    throw new Error("DATABASE_URL_INVALID");
  }
  if ([...url.searchParams.keys()].some((key) => /^ssl/i.test(key))) throw new Error("DATABASE_URL_TLS_QUERY_REFUSED");
  if ([...url.searchParams.keys()].length) throw new Error("DATABASE_URL_QUERY_REFUSED");
  return url;
}

export function connectionConfig({ dsn, target = "production", env = process.env } = {}) {
  const url = parseDsn(dsn);
  if (target === "local-fixture") {
    if (env.INBOX_RECONCILIATION_LOCAL_FIXTURE !== "true") throw new Error("LOCAL_FIXTURE_NOT_AUTHORIZED");
    if (url.hostname !== "127.0.0.1" || !url.port) throw new Error("LOCAL_FIXTURE_TARGET_REFUSED");
    return {
      host: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: false,
    };
  }
  if (!['test', 'production'].includes(target) || isIP(url.hostname) || url.hostname === "localhost" || url.hostname.includes(":")) {
    throw new Error("HOSTED_TARGET_REFUSED");
  }
  const ca = pinnedCa(env);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: {
      rejectUnauthorized: true,
      ca: ca.pem,
      servername: url.hostname,
      checkServerIdentity: tls.checkServerIdentity,
      minVersion: "TLSv1.2",
    },
  };
}

function tlsEvidence(client, dsn, ca) {
  const config = client.connectionParameters?.ssl;
  if (!config || config.rejectUnauthorized !== true || config.ca !== ca.pem || config.servername !== new URL(dsn).hostname || config.checkServerIdentity !== tls.checkServerIdentity || config.minVersion !== "TLSv1.2") {
    throw new Error("TLS_CONFIG_DOWNGRADE");
  }
  const socket = client.connection?.stream;
  if (!(socket instanceof tls.TLSSocket) || !socket.encrypted || !socket.authorized) throw new Error("TLS_SOCKET_UNVERIFIED");
  const protocol = socket.getProtocol();
  if (!['TLSv1.2', 'TLSv1.3'].includes(protocol)) throw new Error("TLS_PROTOCOL_REFUSED");
  const peer = socket.getPeerCertificate(true);
  if (!peer?.raw || tls.checkServerIdentity(new URL(dsn).hostname, peer) !== undefined) throw new Error("TLS_HOSTNAME_MISMATCH");
  return { protocol, cipher: socket.getCipher()?.name ?? "unknown", pinned_ca_fingerprint: ca.fingerprint };
}

export async function connectDatabase({ dsn, target = "production", env = process.env } = {}) {
  const config = connectionConfig({ dsn, target, env });
  const client = new Client(config);
  try {
    await client.connect();
    const connection = config.ssl === false ? { transport: "local-fixture" } : tlsEvidence(client, dsn, pinnedCa(env));
    return { client, connection };
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

function sourceWriterKeys() {
  return new Set(SOURCE_WRITERS.map(([table, name]) => `${table}|${name}`));
}

function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function hashRows(rows) {
  return digestJson(rows.map(stable).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function orgDigest(orgId) {
  return sha256(`org:${orgId}`);
}

export async function catalogFingerprint(client) {
  const functions = (await client.query(sql(
    `SELECT n.nspname AS schema_name,
            p.oid::regprocedure::text AS signature,
            p.prokind,
            p.prosecdef,
            coalesce(p.proconfig, ARRAY[]::text[]) AS config,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=ANY($1::text[])
      ORDER BY n.nspname,p.oid::regprocedure::text`,
    [CATALOG_SCHEMAS],
  ))).rows;
  const tables = (await client.query(sql(
    `SELECT n.nspname AS schema_name,
            c.relname,
            c.relkind,
            c.relrowsecurity,
            coalesce(jsonb_agg(jsonb_build_object(
              'name',a.attname,
              'type',format_type(a.atttypid,a.atttypmod),
              'not_null',a.attnotnull,
              'default',pg_get_expr(d.adbin,d.adrelid)
            ) ORDER BY a.attnum) FILTER (WHERE a.attnum>0 AND NOT a.attisdropped), '[]'::jsonb) AS columns
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid=c.oid
       LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m')
      GROUP BY n.nspname,c.relname,c.relkind,c.relrowsecurity
      ORDER BY n.nspname,c.relname`,
    [CATALOG_SCHEMAS],
  ))).rows;
  const triggers = (await client.query(sql(
    `SELECT tn.nspname AS schema_name,
            c.oid::regclass::text AS relation,
            t.tgname,
            t.tgenabled,
            pg_get_triggerdef(t.oid) AS trigger_definition,
            pg_get_functiondef(t.tgfoid) AS function_definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace tn ON tn.oid=c.relnamespace
      WHERE NOT t.tgisinternal
        AND (tn.nspname=ANY($1::text[]) OR format('%I.%I',tn.nspname,c.relname)=ANY($2::text[]))
      ORDER BY tn.nspname,c.oid::regclass::text,t.tgname`,
    [CATALOG_SCHEMAS, CATALOG_RELATIONS],
  ))).rows;
  return digestJson({ functions, tables, triggers });
}

async function collectSourceWriterEvidence(client) {
  const rows = (await client.query(
    `SELECT n.nspname||'.'||c.relname AS relation, t.tgname, t.tgenabled,
            pg_get_triggerdef(t.oid) AS trigger_definition,
            pg_get_functiondef(t.tgfoid) AS function_definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal
        AND (n.nspname||'.'||c.relname)=ANY($1::text[])
      ORDER BY relation,t.tgname`,
    [[...new Set(SOURCE_WRITERS.map(([table]) => table))]],
  )).rows;
  const observed = new Map(rows.map((row) => [`${row.relation}|${row.tgname}`, row]));
  const required = sourceWriterKeys();
  const missing = [...required].filter((key) => !observed.has(key));
  const disabled = [...required].filter((key) => observed.get(key) && !['O', 'A'].includes(observed.get(key).tgenabled));
  return {
    required_trigger_count: required.size,
    observed_trigger_count: [...required].filter((key) => observed.has(key)).length,
    missing_trigger_count: missing.length,
    disabled_trigger_count: disabled.length,
    trigger_fingerprint: digestJson(rows),
    pass: missing.length === 0 && disabled.length === 0,
  };
}

function expectedAttestationPayload(attestation) {
  return {
    capture_generation: attestation.capture_generation,
    bypass_since_install: attestation.bypass_since_install,
    covered_tables: [...attestation.covered_tables].sort(),
    catalog_fingerprint: attestation.catalog_fingerprint,
  };
}

export function attestationDigest(attestation) {
  return digestJson(expectedAttestationPayload(attestation));
}

function validateAttestation(raw, { generation, expectedCatalogFingerprint }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { pass: false, code: "SOURCE_WRITER_ATTESTATION_INVALID" };
  if (!UUID.test(String(raw.capture_generation ?? ""))) return { pass: false, code: "SOURCE_WRITER_ATTESTATION_INVALID" };
  if (raw.bypass_since_install !== false || raw.catalog_fingerprint !== expectedCatalogFingerprint || !Array.isArray(raw.covered_tables)) {
    return { pass: false, code: "SOURCE_WRITER_ATTESTATION_INVALID" };
  }
  const requiredTables = [...new Set(SOURCE_WRITERS.map(([table]) => table))].sort();
  if (JSON.stringify([...new Set(raw.covered_tables)].sort()) !== JSON.stringify(requiredTables)) {
    return { pass: false, code: "SOURCE_WRITER_ATTESTATION_INVALID" };
  }
  const payload = expectedAttestationPayload(raw);
  if (raw.operator_assertion_digest !== digestJson(payload) || raw.capture_generation !== generation) {
    return { pass: false, code: "SOURCE_WRITER_ATTESTATION_INVALID" };
  }
  return { pass: true, operator_assertion_digest: raw.operator_assertion_digest };
}

async function readAttestation(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ReconciliationBlocked("SOURCE_WRITER_ATTESTATION_INVALID");
  }
}

function rowKey(row) {
  return `${row.org_id}|${row.target_kind}|${row.target_id}`;
}

function targetMapKey(row) {
  return `${row.org_id}|${row.target_kind}|${row.target_id}`;
}

function compareProjectionRows(expectedRows, actualRows, ignoredKeys = new Set()) {
  const expected = new Map(expectedRows.filter((row) => !ignoredKeys.has(rowKey(row))).map((row) => [rowKey(row), row]));
  const actual = new Map(actualRows.filter((row) => !ignoredKeys.has(rowKey(row))).map((row) => [rowKey(row), row]));
  let missing = 0;
  let extra = 0;
  let mismatched = 0;
  for (const [key, value] of expected) {
    if (!actual.has(key)) missing++;
    else if (JSON.stringify(stable(value)) !== JSON.stringify(stable(actual.get(key)))) mismatched++;
  }
  for (const key of actual.keys()) if (!expected.has(key)) extra++;
  return { missing, extra, mismatched, total: missing + extra + mismatched };
}

function comparableSummary(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const copy = { ...summary };
  // J5a records the evaluation clock in the summary. It is evidence of when
  // the candidate was computed, not a source value that must equal the next
  // read-only snapshot's clock.
  delete copy.as_of;
  delete copy.cutoff;
  return copy;
}

async function collectOrgReconciliation(client, { observedAt = new Date().toISOString() } = {}) {
  // The target set is deliberately derived from the same canonical source tables
  // read by J5a capture/summary functions. The expected maintained candidate is
  // produced by inbox_maintained.snapshot(), not by a JavaScript summary clone.
  const result = await client.query(`
    WITH params AS (SELECT $1::timestamptz AS at_time),
    known_targets AS (
      SELECT DISTINCT org_id, 'known_conversation'::text AS target_kind, conversation_id AS target_id
      FROM public.messages WHERE channel='sms' AND conversation_id IS NOT NULL
      UNION
      SELECT DISTINCT org_id, 'known_conversation'::text, conversation_id
      FROM public.ai_disposition_reviews WHERE conversation_id IS NOT NULL
      UNION
      SELECT DISTINCT org_id, 'known_conversation'::text, conversation_id
      FROM public.message_threads WHERE conversation_id IS NOT NULL
    ),
    unknown_sources AS (
      SELECT DISTINCT org_id, from_address AS raw_sender
      FROM public.messages
      WHERE channel='sms' AND direction='inbound' AND contact_id IS NULL
        AND from_address IS NOT NULL AND from_address<>''
    ),
    unknown_targets AS (
      SELECT u.org_id, u.raw_sender, 'unknown_sender'::text AS target_kind, g.sender_group_id AS target_id
      FROM unknown_sources u
      JOIN inbox_message_capture.sender_groups g
        ON g.org_id=u.org_id AND g.raw_sender COLLATE "C"=u.raw_sender COLLATE "C"
    ),
    base_targets AS (
      SELECT * FROM known_targets
      UNION
      SELECT org_id,target_kind,target_id FROM unknown_targets
    ),
    dirty_targets AS (
      SELECT org_id,target_kind,target_id FROM inbox_message_capture.dirty
    ),
    all_targets AS (
      SELECT org_id,target_kind,target_id,true AS base_target FROM base_targets
      UNION
      SELECT d.org_id,d.target_kind,d.target_id,false
      FROM dirty_targets d
      WHERE NOT EXISTS (
        SELECT 1 FROM base_targets b
        WHERE b.org_id=d.org_id AND b.target_kind=d.target_kind AND b.target_id=d.target_id
      )
    ),
    canonical AS (
      SELECT a.org_id::text,a.target_kind,a.target_id::text,a.base_target,
             d.generation::text AS dirty_generation,
             q.org_id IS NOT NULL AS queue_pending,
             candidate.candidate,
             CASE WHEN r.org_id IS NULL THEN NULL ELSE jsonb_build_object(
               'org_id',r.org_id::text,'target_kind',r.target_kind,'target_id',r.target_id::text,
               'revision',r.revision::text,'source_generation',r.source_generation::text,
               'summary',r.summary,'next_expiry',r.next_expiry
             ) END AS actual
      FROM all_targets a
      LEFT JOIN inbox_message_capture.dirty d
        ON d.org_id=a.org_id AND d.target_kind=a.target_kind AND d.target_id=a.target_id
      LEFT JOIN inbox_maintained.queue q
        ON q.org_id=a.org_id AND q.target_kind=a.target_kind AND q.target_id=a.target_id
      LEFT JOIN inbox_maintained.rows r
        ON r.org_id=a.org_id AND r.target_kind=a.target_kind AND r.target_id=a.target_id
      LEFT JOIN LATERAL (
        SELECT inbox_maintained.snapshot(a.org_id,a.target_kind,a.target_id,params.at_time) AS candidate
        FROM params
      ) candidate ON true
    ),
    expected_bridge AS (
      SELECT jsonb_build_object(
        'org_id',c.org_id,'target_kind',c.target_kind,'target_id',c.target_id,
        'projection_revision',c.candidate->>'expected_revision','source_generation',c.candidate->>'generation',
        'name',left(CASE WHEN c.target_kind='unknown_sender' THEN coalesce(s->>'raw_sender_key','Unknown sender') ELSE coalesce(nullif(s->>'contact_name',''),s->>'thread_customer_phone','Unknown contact') END,2000),
        'context',left(CASE WHEN c.target_kind='unknown_sender' THEN 'Unknown sender' ELSE coalesce(s->>'property_address','No property linked') END,2000),
        'preview',left(coalesce(CASE WHEN c.target_kind='unknown_sender' THEN s->>'latest_preview' ELSE s->>'last_message_preview' END,''),2000),
        'time_label',coalesce(CASE WHEN c.target_kind='unknown_sender' THEN s->>'latest_at' ELSE s->>'last_message_at' END,''),
        'outcome_label',CASE WHEN c.target_kind='unknown_sender' THEN CASE WHEN (s->>'is_dismissed')::boolean THEN 'Dismissed' ELSE 'Unknown sender' END ELSE coalesce(s->>'outreach_dispo','No outcome') END,
        'assigned_label',CASE WHEN s->>'assigned_user_id' IS NULL THEN 'Unassigned' ELSE 'Assigned' END,
        'unread',CASE WHEN c.target_kind='unknown_sender' THEN NULL ELSE coalesce((s->>'unread_count')::bigint,0)>0 END,
        'latest_at',CASE WHEN c.target_kind='unknown_sender' THEN s->>'latest_at' ELSE s->>'last_message_at' END,
        'visible_active',CASE WHEN c.target_kind='unknown_sender' THEN coalesce((s->>'visible_unknown')::boolean,false) ELSE coalesce((s->>'visible_all_hide_noise')::boolean,false) END,
        'visible_dismissed',c.target_kind='unknown_sender' AND coalesce((s->>'visible_dismissed')::boolean,false),
        'visible_review',c.target_kind<>'unknown_sender' AND coalesce((s->>'visible_review')::boolean,false),
        'visible_unread',c.target_kind<>'unknown_sender' AND coalesce((s->>'visible_unread_hide_noise')::boolean,false)
      ) AS row
      FROM canonical c
      CROSS JOIN LATERAL (SELECT c.candidate->'summary' AS s) summary
      WHERE c.candidate IS NOT NULL AND c.candidate->'summary'->>'exists'='true'
    ),
    expected_filter AS (
      SELECT jsonb_build_object(
        'org_id',c.org_id,'target_kind',c.target_kind,'target_id',c.target_id,'revision',c.candidate->>'expected_revision',
        'latest_at',CASE WHEN c.target_kind='unknown_sender' THEN s->>'latest_at' ELSE s->>'last_message_at' END,
        'contact_id',s->>'contact_id','has_recent',coalesce((s->>'has_recent')::boolean,false),
        'is_noise',coalesce((s->>'is_noise')::boolean,false),
        'assignable',coalesce(s->>'property_status'<>'prospect',false),
        'assigned_user_id',s->>'assigned_user_id',
        'unread',CASE WHEN c.target_kind='unknown_sender' THEN NULL ELSE coalesce((s->>'unread_count')::bigint,0)>0 END,
        'escalated',coalesce(s->>'ai_responder_status'='escalated',false),
        'needs_outcome',coalesce((s->>'needs_outcome')::boolean,false),
        'review',s->>'ai_disposition_review_id' IS NOT NULL AND NOT coalesce((s->>'is_test_traffic')::boolean,false),
        'unknown_active',coalesce((s->>'visible_unknown')::boolean,false),
        'unknown_dismissed',coalesce((s->>'visible_dismissed')::boolean,false),
        'outreach_dispo',s->>'outreach_dispo'
      ) AS row
      FROM canonical c
      CROSS JOIN LATERAL (SELECT c.candidate->'summary' AS s) summary
      WHERE c.candidate IS NOT NULL AND c.candidate->'summary'->>'exists'='true'
    ),
    actual_bridge AS (
      SELECT jsonb_build_object(
        'org_id',r.org_id::text,'target_kind',r.target_kind,'target_id',r.target_id::text,
        'projection_revision',r.projection_revision::text,'source_generation',r.source_generation::text,
        'name',r.name,'context',r.context,'preview',r.preview,'time_label',r.time_label,
        'outcome_label',r.outcome_label,'assigned_label',r.assigned_label,'unread',r.unread,
        'latest_at',r.latest_at,'visible_active',r.visible_active,'visible_dismissed',r.visible_dismissed,
        'visible_review',r.visible_review,'visible_unread',r.visible_unread
      ) AS row
      FROM inbox_bridge.summaries r
    ),
    actual_filter AS (
      SELECT jsonb_build_object(
        'org_id',r.org_id::text,'target_kind',r.target_kind,'target_id',r.target_id::text,'revision',r.revision::text,
        'latest_at',r.latest_at,'contact_id',r.contact_id,'has_recent',r.has_recent,'is_noise',r.is_noise,
        'assignable',r.assignable,'assigned_user_id',r.assigned_user_id,'unread',r.unread,
        'escalated',r.escalated,'needs_outcome',r.needs_outcome,'review',r.review,
        'unknown_active',r.unknown_active,'unknown_dismissed',r.unknown_dismissed,'outreach_dispo',r.outreach_dispo
      ) AS row
      FROM inbox_bridge.filter_rows r
    )
    SELECT
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',id::text) ORDER BY id) FROM public.organizations),'[]'::jsonb) AS organizations,
      coalesce((SELECT jsonb_agg(jsonb_build_object('org_id',u.org_id::text,'mapped',EXISTS(SELECT 1 FROM unknown_targets t WHERE t.org_id=u.org_id AND t.raw_sender COLLATE "C"=u.raw_sender COLLATE "C")) ORDER BY u.org_id,u.raw_sender) FROM unknown_sources u),'[]'::jsonb) AS unknown_sources,
      coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.org_id,c.target_kind,c.target_id) FROM canonical c),'[]'::jsonb) AS canonical_rows,
      coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.org_id,r.target_kind,r.target_id) FROM inbox_maintained.rows r),'[]'::jsonb) AS maintained_rows,
      coalesce((SELECT jsonb_agg(row ORDER BY row->>'org_id',row->>'target_kind',row->>'target_id') FROM expected_bridge),'[]'::jsonb) AS expected_bridge,
      coalesce((SELECT jsonb_agg(row ORDER BY row->>'org_id',row->>'target_kind',row->>'target_id') FROM actual_bridge),'[]'::jsonb) AS actual_bridge,
      coalesce((SELECT jsonb_agg(row ORDER BY row->>'org_id',row->>'target_kind',row->>'target_id') FROM expected_filter),'[]'::jsonb) AS expected_filter,
      coalesce((SELECT jsonb_agg(row ORDER BY row->>'org_id',row->>'target_kind',row->>'target_id') FROM actual_filter),'[]'::jsonb) AS actual_filter
  `, [observedAt]);
  const payload = result.rows[0];
  const organizations = (payload.organizations ?? []).map(({ id }) => String(id));
  const canonicalRows = payload.canonical_rows ?? [];
  const maintainedRows = payload.maintained_rows ?? [];
  const unknownSources = payload.unknown_sources ?? [];
  const expectedBridge = payload.expected_bridge ?? [];
  const actualBridge = payload.actual_bridge ?? [];
  const expectedFilter = payload.expected_filter ?? [];
  const actualFilter = payload.actual_filter ?? [];
  const byOrg = new Map(organizations.map((id) => [id, { canonical: [], maintained: [], expectedBridge: [], actualBridge: [], expectedFilter: [], actualFilter: [], unknownSources: [] }]));
  const add = (map, row, field) => {
    const org = String(row.org_id);
    if (!map.has(org)) map.set(org, { canonical: [], maintained: [], expectedBridge: [], actualBridge: [], expectedFilter: [], actualFilter: [], unknownSources: [] });
    map.get(org)[field].push(row);
  };
  for (const row of canonicalRows) add(byOrg, row, "canonical");
  for (const row of maintainedRows) add(byOrg, row, "maintained");
  for (const row of expectedBridge) add(byOrg, row, "expectedBridge");
  for (const row of actualBridge) add(byOrg, row, "actualBridge");
  for (const row of expectedFilter) add(byOrg, row, "expectedFilter");
  for (const row of actualFilter) add(byOrg, row, "actualFilter");
  for (const row of unknownSources) add(byOrg, row, "unknownSources");

  const diff = { marker_keys: new Map(), extra_projection_keys: new Map() };
  const addMarkerKey = (row) => {
    const key = rowKey(row);
    const target = { org_id: String(row.org_id), target_kind: row.target_kind, target_id: String(row.target_id) };
    if (row.dirty_generation === null || row.dirty_generation === undefined) diff.marker_keys.set(key, { ...target, missing: true });
    else diff.marker_keys.set(key, { ...target, missing: false });
  };
  const perOrg = [];
  for (const [orgId, value] of [...byOrg.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const targetExpected = new Map();
    const targetActual = new Map();
    const pendingKeys = new Set();
    let baseCount = 0;
    let canonicalMissing = 0;
    let recoveryCanonicalMissing = 0;
    for (const row of value.canonical) {
      const key = rowKey(row);
      if (row.base_target) baseCount++;
      if (row.candidate === null) canonicalMissing++;
      if (row.candidate !== null) targetExpected.set(key, row.candidate);
      if (row.actual !== null) targetActual.set(key, row.actual);
      const pending = row.queue_pending === true && row.dirty_generation !== null &&
        (row.actual === null || String(row.dirty_generation) !== String(row.actual.source_generation));
      if (pending) pendingKeys.add(key);
      if (row.candidate === null && !pending) recoveryCanonicalMissing++;
      if (row.base_target && row.candidate === null && !pending) addMarkerKey(row);
    }
    let maintainedMissing = 0;
    let recoveryMaintainedMissing = 0;
    let maintainedMismatched = 0;
    let recoveryTargetMismatches = 0;
    for (const row of value.canonical) {
      const key = rowKey(row);
      const pending = pendingKeys.has(key);
      if (row.base_target && row.actual === null) {
        maintainedMissing++;
        if (!pending) recoveryMaintainedMissing++;
        if (!pending && row.candidate !== null) addMarkerKey(row);
      }
      if (row.candidate === null || row.actual === null) {
        if (row.candidate === null && row.actual !== null && !pending) addMarkerKey(row);
        continue;
      }
      const actual = row.actual;
      const candidate = row.candidate;
      if (actual.revision !== candidate.expected_revision || actual.source_generation !== candidate.generation || JSON.stringify(stable(comparableSummary(actual.summary))) !== JSON.stringify(stable(comparableSummary(candidate.summary))) || iso(actual.next_expiry) !== iso(candidate.summary?.next_window_expiry)) {
        maintainedMismatched++;
        if (!pending) recoveryTargetMismatches++;
      }
      if (!pending && (actual.revision !== candidate.expected_revision || actual.source_generation !== candidate.generation || JSON.stringify(stable(comparableSummary(actual.summary))) !== JSON.stringify(stable(comparableSummary(candidate.summary))) || iso(actual.next_expiry) !== iso(candidate.summary?.next_window_expiry))) addMarkerKey(row);
    }
    const baseTargetKeys = new Set(value.canonical.filter((row) => row.base_target).map(rowKey));
    for (const row of value.maintained) {
      if (baseTargetKeys.has(rowKey(row))) continue;
      if (row.summary?.exists === true) {
        maintainedMismatched++;
        diff.extra_projection_keys.set(rowKey(row), { org_id: String(row.org_id), target_kind: row.target_kind, target_id: String(row.target_id) });
      }
    }
    const maintainedExtra = value.maintained.filter((row) => !baseTargetKeys.has(rowKey(row)) && row.summary?.exists !== false && row.summary?.exists !== true).length;
    const bridgeComparison = compareProjectionRows(value.expectedBridge, value.actualBridge);
    const filterComparison = compareProjectionRows(value.expectedFilter, value.actualFilter);
    const recoveryBridgeComparison = compareProjectionRows(value.expectedBridge, value.actualBridge, pendingKeys);
    const recoveryFilterComparison = compareProjectionRows(value.expectedFilter, value.actualFilter, pendingKeys);
    const projectionKeys = new Set([
      ...value.expectedBridge.map(rowKey),
      ...value.actualBridge.map(rowKey),
      ...value.expectedFilter.map(rowKey),
      ...value.actualFilter.map(rowKey),
    ]);
    for (const key of projectionKeys) {
      if (pendingKeys.has(key)) continue;
      const expectedBridge = value.expectedBridge.find((row) => rowKey(row) === key);
      const actualBridge = value.actualBridge.find((row) => rowKey(row) === key);
      const expectedFilter = value.expectedFilter.find((row) => rowKey(row) === key);
      const actualFilter = value.actualFilter.find((row) => rowKey(row) === key);
      if (JSON.stringify(stable(expectedBridge ?? null)) !== JSON.stringify(stable(actualBridge ?? null)) || JSON.stringify(stable(expectedFilter ?? null)) !== JSON.stringify(stable(actualFilter ?? null))) {
        const target = value.canonical.find((row) => rowKey(row) === key);
        if (target) addMarkerKey(target);
      }
    }
    const unknownMappingMissing = value.unknownSources.filter((row) => row.mapped !== true).length;
    const mismatchCount = canonicalMissing + maintainedMissing + maintainedMismatched + maintainedExtra + bridgeComparison.total + filterComparison.total + unknownMappingMissing;
    const recoveryMismatchCount = recoveryCanonicalMissing + recoveryMaintainedMissing + recoveryTargetMismatches + maintainedExtra + recoveryBridgeComparison.total + recoveryFilterComparison.total + unknownMappingMissing;
    const expectedTargets = [...targetExpected.values()].map((row) => ({ target_kind: row.target_kind, target_id: row.target_id, source_generation: row.generation, summary: row.summary }));
    const actualTargets = [...targetActual.values()].map((row) => ({ target_kind: row.target_kind, target_id: row.target_id, source_generation: row.source_generation, summary: row.summary }));
    perOrg.push({
      org_digest: orgDigest(orgId),
      base_conversation_count: baseCount,
      unknown_source_count: value.unknownSources.length,
      unknown_mapping_missing_count: unknownMappingMissing,
      maintained_count: value.maintained.length,
      canonical_missing_count: canonicalMissing,
      maintained_missing_count: maintainedMissing,
      maintained_extra_count: maintainedExtra,
      maintained_mismatch_count: maintainedMismatched,
      projection_count: value.actualBridge.length,
      filter_count: value.actualFilter.length,
      projection_missing_count: bridgeComparison.missing,
      projection_extra_count: bridgeComparison.extra,
      projection_mismatch_count: bridgeComparison.mismatched,
      filter_missing_count: filterComparison.missing,
      filter_extra_count: filterComparison.extra,
      filter_mismatch_count: filterComparison.mismatched,
      mismatch_count: mismatchCount,
      recovery_mismatch_count: recoveryMismatchCount,
      pending_count: pendingKeys.size,
      source_hash: hashRows(expectedTargets),
      maintained_hash: hashRows(actualTargets),
      projection_hash: hashRows(value.actualBridge),
      filter_hash: hashRows(value.actualFilter),
    });
  }
  return {
    source_tables: ["public.messages", "public.ai_disposition_reviews", "public.message_threads"],
    unknown_source_table: "public.messages",
    organizations: perOrg.length,
    mismatched_organizations: perOrg.filter((row) => row.mismatch_count !== 0).length,
    recovery_mismatched_organizations: perOrg.filter((row) => row.recovery_mismatch_count !== 0).length,
    per_org: perOrg,
    pass: perOrg.every((row) => row.mismatch_count === 0),
    recovery_pass: perOrg.every((row) => row.recovery_mismatch_count === 0),
    diff: {
      marker_keys: [...diff.marker_keys.values()],
      extra_projection_keys: [...diff.extra_projection_keys.values()],
    },
  };
}

async function collectRouteEdgeReconciliation(client) {
  // This is deliberately independent of capture dirty rows and projection
  // evidence. The expected set mirrors zzzzz_inbox_message_direct exactly:
  // only SMS messages with a conversation_id and a canonical phone produce an
  // edge; every other existing edge is stale and must be removed.
  const result = await client.query(`
    WITH normalized AS (
      SELECT m.org_id,m.id AS message_id,m.channel,m.conversation_id,d.digits
        FROM public.messages m
        CROSS JOIN LATERAL (
          SELECT regexp_replace(
            coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),
            '[^0-9]','','g'
          ) AS digits
        ) d
    ),
    expected AS (
      SELECT org_id,message_id,conversation_id,
             CASE WHEN length(digits)=10 THEN '+1'||digits
                  WHEN length(digits)=11 AND left(digits,1)='1' THEN '+'||digits
             END AS phone_e164
        FROM normalized
       WHERE channel='sms' AND conversation_id IS NOT NULL
         AND (length(digits)=10 OR (length(digits)=11 AND left(digits,1)='1'))
    ),
    actual AS (
      SELECT org_id,message_id,conversation_id,phone_e164
        FROM inbox_message_capture.route_edges
    ),
    comparison AS (
      SELECT e.org_id AS expected_org_id,e.message_id AS expected_message_id,
             e.conversation_id AS expected_conversation_id,e.phone_e164 AS expected_phone_e164,
             a.org_id AS actual_org_id,a.message_id AS actual_message_id,
             a.conversation_id AS actual_conversation_id,a.phone_e164 AS actual_phone_e164
        FROM expected e
        FULL OUTER JOIN actual a ON a.org_id=e.org_id AND a.message_id=e.message_id
    )
    SELECT
      count(*) FILTER (WHERE expected_message_id IS NOT NULL)::int AS expected_count,
      count(*) FILTER (WHERE actual_message_id IS NOT NULL)::int AS actual_count,
      count(*) FILTER (WHERE expected_message_id IS NOT NULL AND actual_message_id IS NULL)::int AS missing_count,
      count(*) FILTER (WHERE expected_message_id IS NULL AND actual_message_id IS NOT NULL)::int AS extra_count,
      count(*) FILTER (
        WHERE expected_message_id IS NOT NULL AND actual_message_id IS NOT NULL
          AND (expected_conversation_id IS DISTINCT FROM actual_conversation_id
            OR expected_phone_e164 IS DISTINCT FROM actual_phone_e164)
      )::int AS mismatched_count
    FROM comparison
  `);
  const row = result.rows[0] ?? {};
  const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
  return { ...counts, total: counts.missing_count + counts.extra_count + counts.mismatched_count, pass: counts.missing_count + counts.extra_count + counts.mismatched_count === 0 };
}

async function collectState(client) {
  const rollout = (await client.query(
    `SELECT singleton,serving_enabled,backfill_complete,reconciliation_complete
       FROM inbox_control.rollout
      WHERE singleton`,
  )).rows;
  const baseline = (await client.query(
    "SELECT stage FROM inbox_control.baseline_progress WHERE singleton",
  )).rows;
  const generation = (await client.query(
    "SELECT generation::text AS generation FROM inbox_capture_boundary.generation WHERE singleton",
  )).rows;
  const jobs = (await client.query(
    `SELECT o.id::text AS org_id,j.stream,j.claim_token::text AS claim_token,j.capture_fingerprint,j.completed_at
       FROM public.organizations o
       LEFT JOIN inbox_backfill.jobs j ON j.org_id=o.id
      ORDER BY o.id`,
  )).rows;
  const pending = (await client.query(
    `SELECT
       (SELECT count(*)::int FROM inbox_backfill.jobs WHERE stream<>'done' OR claim_token IS NOT NULL) AS backfill_pending,
       (SELECT count(*)::int FROM inbox_parent.work WHERE generation>ack OR claim_token IS NOT NULL) AS parent_pending,
       (SELECT count(*)::int FROM inbox_safety.routes WHERE generation>ack OR claim_token IS NOT NULL) AS safety_pending,
       (SELECT count(*)::int FROM inbox_maintained.queue) AS queue_pending,
       (SELECT count(*)::int FROM inbox_maintained.rows WHERE next_expiry IS NOT NULL AND next_expiry<=statement_timestamp()) AS due_expiry,
       (SELECT count(*)::int FROM inbox_message_capture.dirty d
          LEFT JOIN inbox_maintained.rows r USING(org_id,target_kind,target_id)
         WHERE r.org_id IS NULL OR r.source_generation<>d.generation OR r.summary IS NULL OR jsonb_typeof(r.summary->'exists') IS DISTINCT FROM 'boolean') AS capture_pending,
       (SELECT count(*)::int FROM inbox_maintained.rows r
          LEFT JOIN inbox_message_capture.dirty d USING(org_id,target_kind,target_id)
         WHERE d.org_id IS NULL) AS maintained_without_capture`,
  )).rows[0];
  const collisions = (await client.query(
    `SELECT count(*) FILTER (WHERE generation>ack OR duplicate_thread_ids IS NOT NULL)::int AS unresolved,
            count(*) FILTER (WHERE cardinality(duplicate_thread_ids)=2)::int AS duplicate_threads
       FROM inbox_backfill.collisions`,
  )).rows[0];
  const baseDuplicates = (await client.query(
    `SELECT org_id::text AS org_id,
            count(*)::int AS duplicate_group_count,
            sum(thread_count - 1)::int AS duplicate_excess_count
       FROM (
         SELECT org_id,conversation_id,count(*)::int AS thread_count
           FROM public.message_threads
          WHERE conversation_id IS NOT NULL
          GROUP BY org_id,conversation_id
         HAVING count(*) > 1
       ) duplicates
      GROUP BY org_id
      ORDER BY org_id`,
  )).rows;
  const liveCaptureFingerprint = (await client.query("SELECT inbox_backfill.fingerprint() AS fingerprint")).rows[0]?.fingerprint ?? null;
  const jobFingerprintMismatches = jobs.filter((job) => job.capture_fingerprint !== liveCaptureFingerprint).length;
  return { rollout: rollout[0] ?? null, baseline: baseline[0] ?? null, generation: generation[0]?.generation ?? null, jobs, pending, collisions, baseDuplicates, liveCaptureFingerprint, jobFingerprintMismatches };
}

export async function collectEvidence(client, {
  expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT,
  sourceWriterAttestation,
  attestationPath,
  observedAt = new Date().toISOString(),
} = {}) {
  const state = await collectState(client);
  const writer = await collectSourceWriterEvidence(client);
  const liveCatalogFingerprint = await catalogFingerprint(client);
  const routeEdges = await collectRouteEdgeReconciliation(client);
  const attestation = validateAttestation(sourceWriterAttestation, {
    generation: state.generation,
    expectedCatalogFingerprint,
  });
  const backfillComplete = state.jobs.length > 0 && state.jobs.every((job) => job.stream === "done" && job.claim_token === null && job.completed_at !== null && job.capture_fingerprint === state.liveCaptureFingerprint);
  const baselineComplete = state.baseline?.stage === "done";
  const noPendingWork = Object.values(state.pending).every((value) => Number(value) === 0);
  const noCollisions = Number(state.collisions.unresolved) === 0 && Number(state.collisions.duplicate_threads) === 0;
  const noBaseTableDuplicates = state.baseDuplicates.length === 0;
  const markersConsistent = state.rollout && (state.rollout.backfill_complete === state.rollout.reconciliation_complete);
  const catalogMatch = typeof expectedCatalogFingerprint === "string" && HEX64.test(expectedCatalogFingerprint) && liveCatalogFingerprint === expectedCatalogFingerprint.toLowerCase();
  const reconciliation = await collectOrgReconciliation(client);
  const checks = {
    serving_disabled: state.rollout?.serving_enabled === false,
    marker_state_consistent: Boolean(markersConsistent),
    baseline_complete: baselineComplete,
    backfill_complete: backfillComplete,
    no_pending_work: noPendingWork,
    no_unresolved_collisions: noCollisions,
    no_base_table_duplicates: noBaseTableDuplicates,
    projection_reconciled: reconciliation.pass,
    filter_reconciled: reconciliation.pass,
    catalog_fingerprint_match: catalogMatch,
    source_writer_coverage: writer.pass,
    source_writer_attestation: attestation.pass,
    capture_fingerprint_stable: state.jobFingerprintMismatches === 0 && state.liveCaptureFingerprint !== null,
    route_edges_reconciled: routeEdges.pass,
  };
  const errors = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name.toUpperCase());
  const evidence = {
    evidence_version: 1,
    observed_at: observedAt,
    serving_enabled: state.rollout?.serving_enabled ?? null,
    markers: {
      backfill_complete: state.rollout?.backfill_complete ?? null,
      reconciliation_complete: state.rollout?.reconciliation_complete ?? null,
    },
    baseline: { stage: state.baseline?.stage ?? null },
    backfill: {
      organization_count: state.jobs.length,
      pending_count: Number(state.pending.backfill_pending),
      fingerprint_mismatch_count: state.jobFingerprintMismatches,
    },
    pending: Object.fromEntries(Object.entries(state.pending).map(([key, value]) => [key, Number(value)])),
    collisions: {
      unresolved_count: Number(state.collisions.unresolved),
      duplicate_thread_count: Number(state.collisions.duplicate_threads),
    },
    base_table_duplicates: {
      organization_count: state.baseDuplicates.length,
      duplicate_group_count: state.baseDuplicates.reduce((sum, row) => sum + Number(row.duplicate_group_count), 0),
      duplicate_excess_count: state.baseDuplicates.reduce((sum, row) => sum + Number(row.duplicate_excess_count), 0),
      organizations: state.baseDuplicates.map((row) => ({
        org_digest: orgDigest(row.org_id),
        duplicate_group_count: Number(row.duplicate_group_count),
        duplicate_excess_count: Number(row.duplicate_excess_count),
      })),
    },
    reconciliation: {
      organizations: reconciliation.organizations,
      mismatched_organizations: reconciliation.mismatched_organizations,
      source_tables: reconciliation.source_tables,
      unknown_source_table: reconciliation.unknown_source_table,
      per_org: reconciliation.per_org,
    },
    fingerprints: {
      expected_catalog: typeof expectedCatalogFingerprint === "string" && HEX64.test(expectedCatalogFingerprint) ? expectedCatalogFingerprint.toLowerCase() : null,
      expected_catalog_source: CATALOG_ARTIFACT.source,
      live_catalog: liveCatalogFingerprint,
      live_capture: state.liveCaptureFingerprint,
      source_writer: writer.trigger_fingerprint,
    },
    source_writer_attestation: {
      present: Boolean(sourceWriterAttestation),
      operator_assertion_digest: attestation.operator_assertion_digest ?? null,
      path_supplied: Boolean(attestationPath),
      label: "operator assertion; not a cryptographic signature",
    },
    source_writer_coverage: {
      required_trigger_count: writer.required_trigger_count,
      observed_trigger_count: writer.observed_trigger_count,
      missing_trigger_count: writer.missing_trigger_count,
      disabled_trigger_count: writer.disabled_trigger_count,
      trigger_fingerprint: writer.trigger_fingerprint,
    },
    route_edges: routeEdges,
    checks,
    status: errors.length === 0 ? "ready" : "blocked",
    errors,
  };
  evidence.evidence_digest = digestJson({ ...evidence, observed_at: undefined, evidence_digest: undefined });
  return evidence;
}

async function readOnlyEvidence(client, options) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const evidence = await collectEvidence(client, options);
    await client.query("COMMIT");
    return evidence;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function collectRecoverySafety(client, { expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT } = {}) {
  const state = await collectState(client);
  const writer = await collectSourceWriterEvidence(client);
  const liveCatalogFingerprint = await catalogFingerprint(client);
  const catalogMatch = typeof expectedCatalogFingerprint === "string" && HEX64.test(expectedCatalogFingerprint) && liveCatalogFingerprint === expectedCatalogFingerprint.toLowerCase();
  const noCollisions = Number(state.collisions.unresolved) === 0 && Number(state.collisions.duplicate_threads) === 0;
  const noBaseTableDuplicates = state.baseDuplicates.length === 0;
  const checks = {
    serving_disabled: state.rollout?.serving_enabled === false,
    source_writer_coverage: writer.pass,
    catalog_fingerprint_match: catalogMatch,
    no_unresolved_collisions: noCollisions,
    no_base_table_duplicates: noBaseTableDuplicates,
  };
  const errors = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name.toUpperCase());
  return { state, writer, liveCatalogFingerprint, checks, errors, error_code: errors.length ? `RECOVERY_GATE_${errors[0]}` : null };
}

async function collectRecoveryPlan(client, { expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT, observedAt = new Date().toISOString() } = {}) {
  const safety = await collectRecoverySafety(client, { expectedCatalogFingerprint });
  const reconciliation = await collectOrgReconciliation(client, { observedAt });
  const routeEdges = await collectRouteEdgeReconciliation(client);
  const boundaryCount = Number((await client.query("SELECT count(*)::int AS count FROM inbox_read.boundaries")).rows[0]?.count ?? 0);
  const { state, writer, liveCatalogFingerprint } = safety;
  const evidence = {
    evidence_version: 3,
    observed_at: observedAt,
    mode: "capture-bypass-recovery",
    capture_generation: state.generation,
    serving_enabled: state.rollout?.serving_enabled ?? null,
    read_boundary_count: boundaryCount,
    planned: {
      capture_generation_bump: boundaryCount > 0,
      invalidate_prior_read_boundaries: boundaryCount,
      marker_key_count: reconciliation.diff.marker_keys.length,
      extra_projection_key_count: reconciliation.diff.extra_projection_keys.length,
      marker_write: false,
      serving_write: false,
    },
    reconciliation: {
      organizations: reconciliation.organizations,
      mismatched_organizations: reconciliation.mismatched_organizations,
      recovery_mismatched_organizations: reconciliation.recovery_mismatched_organizations,
      source_tables: reconciliation.source_tables,
      unknown_source_table: reconciliation.unknown_source_table,
      per_org: reconciliation.per_org,
    },
    collisions: {
      unresolved_count: Number(state.collisions.unresolved),
      duplicate_thread_count: Number(state.collisions.duplicate_threads),
    },
    base_table_duplicates: {
      organization_count: state.baseDuplicates.length,
      duplicate_group_count: state.baseDuplicates.reduce((sum, row) => sum + Number(row.duplicate_group_count), 0),
      duplicate_excess_count: state.baseDuplicates.reduce((sum, row) => sum + Number(row.duplicate_excess_count), 0),
      organizations: state.baseDuplicates.map((row) => ({
        org_digest: orgDigest(row.org_id),
        duplicate_group_count: Number(row.duplicate_group_count),
        duplicate_excess_count: Number(row.duplicate_excess_count),
      })),
    },
    fingerprints: {
      expected_catalog: typeof expectedCatalogFingerprint === "string" && HEX64.test(expectedCatalogFingerprint) ? expectedCatalogFingerprint.toLowerCase() : null,
      expected_catalog_source: CATALOG_ARTIFACT.source,
      live_catalog: liveCatalogFingerprint,
      source_writer: writer.trigger_fingerprint,
    },
    source_writer_coverage: {
      required_trigger_count: writer.required_trigger_count,
      observed_trigger_count: writer.observed_trigger_count,
      missing_trigger_count: writer.missing_trigger_count,
      disabled_trigger_count: writer.disabled_trigger_count,
      trigger_fingerprint: writer.trigger_fingerprint,
    },
    route_edges: routeEdges,
    checks: {
      ...safety.checks,
      route_edges_reconciled: routeEdges.pass,
      recovery_gate: reconciliation.recovery_pass && routeEdges.pass,
    },
    status: safety.errors.length === 0 ? "ready" : "blocked",
    errors: safety.errors,
    error_code: safety.error_code,
    recovery_error_code: reconciliation.recovery_pass && routeEdges.pass ? null : routeEdges.pass ? "RECOVERY_RECONCILIATION_FAILED" : "RECOVERY_ROUTE_EDGE_RECONCILIATION_FAILED",
  };
  evidence.evidence_digest = digestJson({ ...evidence, observed_at: undefined, evidence_digest: undefined });
  // The diff is operator-internal work input. Keep UUIDs out of the digest-only
  // receipt and CLI output; H2'/H5 of research-reconcile-recovery-locking.md
  // require rerunning this snapshot instead of persisting a cursor.
  Object.defineProperty(evidence, "_recoveryDiff", { value: reconciliation.diff, enumerable: false });
  return evidence;
}

async function readOnlyRecoveryPlan(client, options) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const evidence = await collectRecoveryPlan(client, options);
    await client.query("COMMIT");
    return evidence;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function rebuildCaptureAndProjection(client, _observedAt, {
  expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT,
  deadline = Date.now() + RECOVERY_REBUILD_TIMEOUT_MS,
  batchSize = RECOVERY_BATCH_SIZE,
  sourceBatchSize = RECOVERY_SOURCE_BATCH_SIZE,
  onBatchBeforeCommit,
  onBatchCommitted,
  onRouteEdgeCandidates,
} = {}) {
  // Research H1/H2/H5: recovery does not compute or publish while holding a
  // dirty-row lock. It only writes a short-lived marker transaction; the
  // existing projection worker owns snapshot()/finish_work().
  const resultCounts = {
    sender_batches: 0,
    sender_retries: 0,
    sender_repairs_skipped: 0,
    route_batches: 0,
    route_retries: 0,
    route_repairs_skipped: 0,
    stale_route_edges_deleted: 0,
    stale_route_edge_retries: 0,
    stale_route_edges_skipped: 0,
    marker_batches: 0,
    marker_rows: 0,
    marker_retries: 0,
    stale_projection_rows_deleted: 0,
    committed_batch_count: 0,
  };
  let committedBatchCount = 0;

  const runBatch = async (kind, work) => {
    if (Date.now() > deadline) throw new ReconciliationBlocked("RECOVERY_REBUILD_TIMEOUT");
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    let committed = false;
    try {
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query(`SET LOCAL lock_timeout='${RECOVERY_LOCK_TIMEOUT}'`);
      const value = await work();
      await onBatchBeforeCommit?.({ kind, ...value });
      await client.query("COMMIT");
      committed = true;
      committedBatchCount++;
      resultCounts.committed_batch_count = committedBatchCount;
      await onBatchCommitted?.({ kind, batch_number: committedBatchCount, ...value });
      return value;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  };

  const retrySkippedBatch = async (kind, work, retryCounter) => {
    for (let attempt = 0; ; attempt++) {
      const value = await runBatch(kind, work);
      if (Number(value.skipped_count ?? 0) === 0 || attempt >= RECOVERY_SKIP_RETRY_ATTEMPTS - 1) return value;
      resultCounts[retryCounter]++;
      if (Date.now() > deadline) throw new ReconciliationBlocked("RECOVERY_REBUILD_TIMEOUT");
      const backoff = Math.min(RECOVERY_SKIP_RETRY_MAX_BACKOFF_MS, RECOVERY_SKIP_RETRY_BACKOFF_MS * (2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  };

  for (;;) {
    const value = await retrySkippedBatch("sender-groups", async () => {
      const result = await client.query(
        `WITH candidates AS MATERIALIZED (
           SELECT DISTINCT m.org_id,m.from_address AS raw_sender
             FROM public.messages m
            WHERE m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL
              AND m.from_address IS NOT NULL AND m.from_address<>''
              AND NOT EXISTS (
                SELECT 1 FROM inbox_message_capture.sender_groups g
                 WHERE g.org_id=m.org_id AND g.raw_sender COLLATE "C"=m.from_address COLLATE "C"
              )
         ),
         picked_messages AS MATERIALIZED (
           SELECT m.org_id,m.from_address AS raw_sender
             FROM public.messages m
            WHERE m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL
              AND m.from_address IS NOT NULL AND m.from_address<>''
              AND NOT EXISTS (
                SELECT 1 FROM inbox_message_capture.sender_groups g
                 WHERE g.org_id=m.org_id AND g.raw_sender COLLATE "C"=m.from_address COLLATE "C"
              )
            ORDER BY m.org_id,m.from_address COLLATE "C",m.id
            LIMIT $1
            FOR NO KEY UPDATE SKIP LOCKED
         ),
         picked AS MATERIALIZED (
           SELECT DISTINCT org_id,raw_sender FROM picked_messages
         ),
         resolved AS (
           SELECT p.org_id,p.raw_sender,
                  inbox_message_capture.sender_id(p.org_id,p.raw_sender) AS sender_group_id
             FROM picked p
         )
         SELECT (SELECT count(*)::int FROM candidates) AS candidate_count,
                coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.org_id,r.raw_sender) FROM resolved r),'[]'::jsonb) AS rows`,
        [sourceBatchSize],
      );
      const candidateCount = Number(result.rows[0]?.candidate_count ?? 0);
      const rows = result.rows[0]?.rows ?? [];
      return {
        rows,
        row_count: rows.length,
        skipped_count: candidateCount <= sourceBatchSize ? Math.max(0, candidateCount - rows.length) : 0,
      };
    }, "sender_retries");
    resultCounts.sender_batches++;
    resultCounts.sender_repairs_skipped += value.skipped_count;
    if (value.row_count === 0) break;
  }

  for (;;) {
    const value = await retrySkippedBatch("route-edges", async () => {
      const result = await client.query(
        `WITH normalized AS MATERIALIZED (
           SELECT m.id,m.org_id,m.channel,m.conversation_id,
                  CASE WHEN length(d.digits)=10 THEN '+1'||d.digits
                       WHEN length(d.digits)=11 AND left(d.digits,1)='1' THEN '+'||d.digits
                  END AS phone_e164
             FROM public.messages m
             CROSS JOIN LATERAL (
               SELECT regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g') AS digits
             ) d
         ),
         candidates AS MATERIALIZED (
           SELECT n.id,n.org_id,n.conversation_id,n.channel='sms' AND n.conversation_id IS NOT NULL AS canonical_eligible,n.phone_e164
             FROM normalized n
             LEFT JOIN inbox_message_capture.route_edges e ON e.org_id=n.org_id AND e.message_id=n.id
            WHERE ((NOT (n.channel='sms' AND n.conversation_id IS NOT NULL) OR n.phone_e164 IS NULL) AND e.message_id IS NOT NULL)
               OR ((n.channel='sms' AND n.conversation_id IS NOT NULL) AND n.phone_e164 IS NOT NULL
                   AND (e.message_id IS NULL OR e.conversation_id IS DISTINCT FROM n.conversation_id OR e.phone_e164 IS DISTINCT FROM n.phone_e164))
         ),
         picked AS MATERIALIZED (
           SELECT c.*
             FROM candidates c
             JOIN public.messages m ON m.org_id=c.org_id AND m.id=c.id
            ORDER BY c.org_id,c.id
            LIMIT $1
            FOR NO KEY UPDATE OF m SKIP LOCKED
         )
         SELECT (SELECT count(*)::int FROM candidates) AS candidate_count,
                coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.org_id,p.id) FROM picked p),'[]'::jsonb) AS rows`,
        [sourceBatchSize],
      );
      const candidateCount = Number(result.rows[0]?.candidate_count ?? 0);
      const rows = result.rows[0]?.rows ?? [];
      await onRouteEdgeCandidates?.(rows);
      if (rows.length > 0) {
        const payload = JSON.stringify(rows);
        // The source locks remain held until this transaction commits. The
        // delete and upsert are set-based, so the writer cannot observe a
        // per-row DELETE-then-INSERT gap.
        await client.query(
          `DELETE FROM inbox_message_capture.route_edges e
             USING jsonb_to_recordset($1::jsonb) AS p(org_id uuid,id uuid)
            WHERE e.org_id=p.org_id AND e.message_id=p.id`,
          [payload],
        );
        await client.query(
          `INSERT INTO inbox_message_capture.route_edges(org_id,message_id,conversation_id,phone_e164)
           SELECT p.org_id,p.id,p.conversation_id,p.phone_e164
             FROM jsonb_to_recordset($1::jsonb) AS p(org_id uuid,id uuid,conversation_id uuid,canonical_eligible boolean,phone_e164 text)
            WHERE p.canonical_eligible AND p.phone_e164 IS NOT NULL
           ON CONFLICT(org_id,message_id) DO UPDATE
             SET conversation_id=excluded.conversation_id,phone_e164=excluded.phone_e164`,
          [payload],
        );
      }
      return {
        rows,
        row_count: rows.length,
        skipped_count: candidateCount <= sourceBatchSize ? Math.max(0, candidateCount - rows.length) : 0,
      };
    }, "route_retries");
    resultCounts.route_batches++;
    resultCounts.route_repairs_skipped += value.skipped_count;
    if (value.row_count === 0) break;
  }

  const staleRouteEdges = await runBatch("stale-route-edges", async () => {
    const result = await client.query(`
      DELETE FROM inbox_message_capture.route_edges e
       WHERE NOT EXISTS (
         SELECT 1 FROM public.messages m
          WHERE m.org_id=e.org_id AND m.id=e.message_id
       )
          OR EXISTS (
         SELECT 1
           FROM public.messages m
           CROSS JOIN LATERAL (
             SELECT regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g') AS digits
           ) d
          WHERE m.org_id=e.org_id AND m.id=e.message_id
            AND (m.channel<>'sms' OR m.conversation_id IS NULL
              OR (CASE WHEN length(d.digits)=10 THEN '+1'||d.digits
                       WHEN length(d.digits)=11 AND left(d.digits,1)='1' THEN '+'||d.digits
                  END) IS NULL)
       )
    `);
    return { rows: result.rowCount, row_count: result.rowCount, skipped_count: 0 };
  });
  resultCounts.stale_route_edges_deleted += staleRouteEdges.rows;

  const plan = await readOnlyRecoveryPlan(client, { expectedCatalogFingerprint });
  if (plan.status !== "ready") throw new ReconciliationBlocked(plan.error_code ?? "RECOVERY_GATE_BLOCKED");
  const markerKeys = plan._recoveryDiff.marker_keys;
  let adaptiveBatchSize = Math.min(100, Math.max(1, Number(batchSize) || RECOVERY_BATCH_SIZE));
  const markChunk = async (keys) => {
    const started = Date.now();
    try {
      const value = await runBatch("targets", async () => {
        // Keep the approved marker-write recheck, but keep it metadata-only:
        // the report's H1/H2 rule forbids snapshot()/publish() under the
        // dirty-row lock. Locking this singleton does not lock message writes.
        const rollout = (await client.query("SELECT serving_enabled FROM inbox_control.rollout WHERE singleton FOR SHARE")).rows[0];
        if (rollout?.serving_enabled !== false) throw new ReconciliationBlocked("RECOVERY_GATE_SERVING_DISABLED");
        const picked = (await client.query(
          `SELECT d.org_id,d.target_kind,d.target_id
             FROM inbox_message_capture.dirty d
             JOIN jsonb_to_recordset($1::jsonb) AS r(org_id uuid,target_kind text,target_id uuid)
               ON d.org_id=r.org_id AND d.target_kind=r.target_kind AND d.target_id=r.target_id
            ORDER BY d.org_id,d.target_kind,d.target_id
            FOR NO KEY UPDATE SKIP LOCKED`,
          [JSON.stringify(keys)],
        )).rows;
        if (picked.length > 0) {
          await client.query(
            `UPDATE inbox_message_capture.dirty d
                SET generation=d.generation+1
               FROM jsonb_to_recordset($1::jsonb) AS r(org_id uuid,target_kind text,target_id uuid)
              WHERE d.org_id=r.org_id AND d.target_kind=r.target_kind AND d.target_id=r.target_id`,
            [JSON.stringify(picked)],
          );
        }
        const inserted = (await client.query(
          `INSERT INTO inbox_message_capture.dirty(org_id,target_kind,target_id,generation)
           SELECT r.org_id,r.target_kind,r.target_id,1
             FROM jsonb_to_recordset($1::jsonb) AS r(org_id uuid,target_kind text,target_id uuid)
            WHERE NOT EXISTS (
              SELECT 1 FROM inbox_message_capture.dirty d
               WHERE d.org_id=r.org_id AND d.target_kind=r.target_kind AND d.target_id=r.target_id
            )
           ON CONFLICT(org_id,target_kind,target_id) DO NOTHING
           RETURNING org_id,target_kind,target_id`,
          [JSON.stringify(keys)],
        )).rows;
        return { rows: [...picked, ...inserted], row_count: picked.length + inserted.length };
      });
      return value;
    } catch (error) {
      if (error?.code !== "55P03" || keys.length === 1) throw error;
      throw Object.assign(error, { recovery_retryable: true });
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed > RECOVERY_TARGET_TXN_BUDGET_MS) adaptiveBatchSize = Math.max(1, Math.floor(adaptiveBatchSize / 2));
      else if (elapsed < 5) adaptiveBatchSize = Math.min(100, Math.max(adaptiveBatchSize, adaptiveBatchSize * 2));
    }
  };

  let remaining = markerKeys.slice();
  while (remaining.length > 0) {
    if (Date.now() > deadline) throw new ReconciliationBlocked("RECOVERY_REBUILD_TIMEOUT");
    const chunk = remaining.slice(0, adaptiveBatchSize);
    try {
      const value = await markChunk(chunk);
      resultCounts.marker_batches++;
      resultCounts.marker_rows += value.row_count;
      const completed = new Set(value.rows.map(targetMapKey));
      if (completed.size === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        remaining = remaining.filter((key) => !completed.has(targetMapKey(key)));
      }
    } catch (error) {
      if (!error.recovery_retryable) throw error;
      resultCounts.marker_retries++;
      adaptiveBatchSize = Math.max(1, Math.floor(adaptiveBatchSize / 2));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  for (;;) {
    const value = await runBatch("stale-projections", async () => {
      let deleted = 0;
      for (const relation of ["inbox_bridge.summaries", "inbox_bridge.filter_rows", "inbox_maintained.rows"]) {
        const result = await client.query(
          `WITH stale AS (
             SELECT p.org_id,p.target_kind,p.target_id
               FROM ${relation} p
              WHERE NOT EXISTS (
                SELECT 1 FROM inbox_message_capture.dirty d
                 WHERE d.org_id=p.org_id AND d.target_kind=p.target_kind AND d.target_id=p.target_id
              )
              ORDER BY p.org_id,p.target_kind,p.target_id
              LIMIT $1
              FOR UPDATE OF p SKIP LOCKED
           )
           DELETE FROM ${relation} p
            USING stale
            WHERE p.org_id=stale.org_id AND p.target_kind=stale.target_kind AND p.target_id=stale.target_id`,
          [adaptiveBatchSize],
        );
        deleted += result.rowCount;
      }
      return { rows: deleted };
    });
    resultCounts.stale_projection_rows_deleted += value.rows;
    if (value.rows === 0) break;
  }

  resultCounts.marker_chunk_size = adaptiveBatchSize;
  return resultCounts;
}

async function transitionCaptureBoundary(client, expectedCatalogFingerprint) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  let committed = false;
  try {
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SELECT singleton FROM inbox_control.rollout WHERE singleton FOR UPDATE");
    // H1/H2 of research-reconcile-recovery-locking.md: the only work under
    // the rollout lock is a metadata/safety recheck and (when necessary) one
    // generation transition. Projection computation is never here.
    const safety = await collectRecoverySafety(client, { expectedCatalogFingerprint });
    if (safety.errors.length > 0) throw new ReconciliationBlocked(safety.error_code ?? "RECOVERY_GATE_BLOCKED");
    const oldGeneration = safety.state.generation;
    const boundaryCount = Number((await client.query("SELECT count(*)::int AS count FROM inbox_read.boundaries")).rows[0]?.count ?? 0);
    let generation = oldGeneration;
    let invalidated = 0;
    if (boundaryCount > 0) {
      generation = (await client.query("UPDATE inbox_capture_boundary.generation SET generation=gen_random_uuid() WHERE singleton RETURNING generation::text AS generation")).rows[0]?.generation;
      if (!generation) throw new ReconciliationBlocked("CAPTURE_GENERATION_MISSING");
      invalidated = (await client.query("DELETE FROM inbox_read.boundaries WHERE generation IS DISTINCT FROM $1::uuid", [generation])).rowCount;
    }
    await client.query("COMMIT");
    committed = true;
    return {
      capture_generation_before: oldGeneration,
      capture_generation_after: generation,
      capture_generation_bumped: generation !== oldGeneration,
      read_boundaries_invalidated: invalidated,
    };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function runCaptureRecovery(client, {
  expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT,
  apply = false,
  recoveryBatchSize = RECOVERY_BATCH_SIZE,
  recoverySourceBatchSize = RECOVERY_SOURCE_BATCH_SIZE,
  onRecoveryBatchBeforeCommit,
  onRecoveryBatchCommitted,
  onRecoveryRouteEdgeCandidates,
} = {}) {
  const initial = await readOnlyRecoveryPlan(client, { expectedCatalogFingerprint });
  if (initial.status !== "ready") return { status: "blocked", evidence: initial, recovery: null };
  if (!apply) return { status: "recovery-dry-run", evidence: initial, recovery: { applied: false } };
  let committed = false;
  try {
    const transition = await transitionCaptureBoundary(client, expectedCatalogFingerprint);
    committed = true;
    // H2'/H5: recompute the DIFF after every interruption. No cursor or
    // source-generation digest is carried across runs; consistent keys are
    // absent from the next DIFF and therefore are not bumped again.
    const rebuild = await rebuildCaptureAndProjection(client, new Date().toISOString(), {
      expectedCatalogFingerprint,
      batchSize: recoveryBatchSize,
      sourceBatchSize: recoverySourceBatchSize,
      onBatchBeforeCommit: onRecoveryBatchBeforeCommit,
      onRouteEdgeCandidates: onRecoveryRouteEdgeCandidates,
      onBatchCommitted: async (context) => {
        committed = true;
        await onRecoveryBatchCommitted?.(context);
      },
    });
    const after = await readOnlyRecoveryPlan(client, { expectedCatalogFingerprint });
    if (after.status !== "ready") throw new ReconciliationBlocked(after.error_code ?? "RECOVERY_GATE_BLOCKED");
    after.recovery = {
      applied: true,
      ...transition,
      rebuild,
      final_gate: "single_repeatable_read_snapshot",
    };
    if (Number(rebuild.route_repairs_skipped ?? 0) > 0) {
      after.recovery.incomplete_reason = "ROUTE_EDGE_REPAIRS_SKIPPED";
      after.evidence_digest = digestJson({ ...after, observed_at: undefined, evidence_digest: undefined });
      return { status: "recovery-incomplete", evidence: after, recovery: after.recovery };
    }
    if (after.checks.recovery_gate !== true) {
      throw new ReconciliationBlocked(after.recovery_error_code ?? "RECOVERY_RECONCILIATION_FAILED");
    }
    after.evidence_digest = digestJson({ ...after, observed_at: undefined, evidence_digest: undefined });
    return { status: "recovery-written", evidence: after, recovery: after.recovery };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    if (committed && !(error instanceof ReconciliationCommitted)) {
      throw new ReconciliationCommitted("RECOVERY_COMMITTED_POSTCHECK_FAILED", error);
    }
    throw error;
  }
}

export async function reconcileAndMaybeWrite(client, {
  expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT,
  sourceWriterAttestation,
  attestationPath,
  writeMarkers = false,
  recoverCaptureBypass = false,
  applyCaptureRecovery = false,
  recoveryBatchSize = RECOVERY_BATCH_SIZE,
  recoverySourceBatchSize = RECOVERY_SOURCE_BATCH_SIZE,
  onRecoveryBatchBeforeCommit,
  onRecoveryBatchCommitted,
  onRecoveryRouteEdgeCandidates,
  beforeWrite,
} = {}) {
  if (recoverCaptureBypass) return runCaptureRecovery(client, {
    expectedCatalogFingerprint,
    apply: applyCaptureRecovery,
    recoveryBatchSize,
    recoverySourceBatchSize,
    onRecoveryBatchBeforeCommit,
    onRecoveryBatchCommitted,
    onRecoveryRouteEdgeCandidates,
  });
  const initial = await readOnlyEvidence(client, { expectedCatalogFingerprint, sourceWriterAttestation, attestationPath });
  if (initial.status !== "ready") return { status: "blocked", evidence: initial, marker_write: null };
  if (!writeMarkers) return { status: "ready", evidence: initial, marker_write: null };

  await beforeWrite?.(initial);

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  let committed = false;
  try {
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SELECT singleton FROM inbox_control.rollout WHERE singleton FOR UPDATE");
    const recheck = await collectEvidence(client, { expectedCatalogFingerprint, sourceWriterAttestation, attestationPath });
    if (recheck.status !== "ready") {
      await client.query("ROLLBACK");
      return { status: "blocked", evidence: recheck, marker_write: null };
    }
    const updated = await client.query(
      `UPDATE inbox_control.rollout
          SET backfill_complete=true,reconciliation_complete=true
        WHERE singleton
          AND serving_enabled=false
          AND backfill_complete=false
          AND reconciliation_complete=false`,
    );
    if (updated.rowCount === 1) {
      await client.query("COMMIT");
      committed = true;
      const after = await readOnlyEvidence(client, { expectedCatalogFingerprint, sourceWriterAttestation, attestationPath });
      if (after.status !== "ready") throw new ReconciliationBlocked(`MARKER_POSTCHECK_FAILED_${after.errors[0] ?? "BLOCKED"}`);
      return { status: "written", evidence: after, marker_write: { rows_changed: 1 } };
    }
    const row = (await client.query(
      "SELECT backfill_complete,reconciliation_complete,serving_enabled FROM inbox_control.rollout WHERE singleton",
    )).rows[0];
    if (row?.serving_enabled === false && row?.backfill_complete === true && row?.reconciliation_complete === true) {
      await client.query("COMMIT");
      committed = true;
      const after = await readOnlyEvidence(client, { expectedCatalogFingerprint, sourceWriterAttestation, attestationPath });
      if (after.status !== "ready") throw new ReconciliationBlocked(`MARKER_POSTCHECK_FAILED_${after.errors[0] ?? "BLOCKED"}`);
      return { status: "idempotent", evidence: after, marker_write: { rows_changed: 0 } };
    }
    throw new ReconciliationBlocked("MARKER_STATE_CHANGED");
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    if (committed && !(error instanceof ReconciliationCommitted)) {
      throw new ReconciliationCommitted("MARKER_COMMITTED_POSTCHECK_FAILED", error);
    }
    throw error;
  }
}

function args(argv, env = process.env) {
  const result = { writeMarkers: false, recoverCaptureBypass: false, applyCaptureRecovery: false, output: null, expectedCatalogFingerprint: env.INBOX_RECONCILIATION_EXPECTED_CATALOG_SHA256 ?? EXPECTED_CATALOG_FINGERPRINT, attestationPath: env.INBOX_RECONCILIATION_SOURCE_WRITER_ATTESTATION ?? null, target: env.INBOX_RECONCILIATION_TARGET ?? "production" };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--write-markers") result.writeMarkers = true;
    else if (value === "--recover-capture-bypass") result.recoverCaptureBypass = true;
    else if (value === "--apply-capture-recovery") result.applyCaptureRecovery = true;
    else if (value === "--output") result.output = argv[++index] ?? null;
    else if (value === "--expected-catalog-fingerprint") result.expectedCatalogFingerprint = argv[++index] ?? null;
    else if (value === "--source-writer-attestation") result.attestationPath = argv[++index] ?? null;
    else if (value === "--target") result.target = argv[++index] ?? null;
    else if (value === "--help") result.help = true;
    else throw new Error("ARGUMENT_INVALID");
  }
  if ((result.writeMarkers && result.recoverCaptureBypass) || (result.applyCaptureRecovery && !result.recoverCaptureBypass)) throw new Error("ARGUMENT_COMBINATION_INVALID");
  return result;
}

function redactedError(error) {
  return error instanceof ReconciliationBlocked ? error.code : /^[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "RECONCILIATION_FAILED";
}

export function reconciliationExitCode(error) {
  return error instanceof ReconciliationCommitted ? 3 : 2;
}

function errorReport(error) {
  if (error instanceof ReconciliationCommitted) {
    return `${error.code}: change landed; post-commit verification failed, rerun to resume or verify`;
  }
  return redactedError(error);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = args(argv, env);
  if (parsed.help) {
    process.stdout.write("Dry-run: node scripts/inbox-reconcile-completion.mjs\nMutation: add --write-markers\nRecovery dry-run: add --recover-capture-bypass\nRecovery mutation: add --recover-capture-bypass --apply-capture-recovery\nDatabase: INBOX_RECONCILIATION_DATABASE_URL\n");
    return 0;
  }
  const dsn = env.INBOX_RECONCILIATION_DATABASE_URL;
  if (!dsn) throw new Error("DATABASE_URL_REQUIRED");
  const attestation = await readAttestation(parsed.attestationPath);
  const { client, connection } = await connectDatabase({ dsn, target: parsed.target, env });
  try {
    const result = await reconcileAndMaybeWrite(client, {
      expectedCatalogFingerprint: parsed.expectedCatalogFingerprint,
      sourceWriterAttestation: attestation,
      attestationPath: parsed.attestationPath,
      writeMarkers: parsed.writeMarkers,
      recoverCaptureBypass: parsed.recoverCaptureBypass,
      applyCaptureRecovery: parsed.applyCaptureRecovery,
    });
    const output = { mode: parsed.recoverCaptureBypass ? (parsed.applyCaptureRecovery ? "apply-capture-recovery" : "capture-recovery-dry-run") : (parsed.writeMarkers ? "write-markers" : "dry-run"), ...result, connection };
    const text = `${JSON.stringify(output, null, 2)}\n`;
    if (parsed.output) writeFileSync(parsed.output, text, { mode: 0o600 });
    else process.stdout.write(text);
    return ["blocked", "recovery-incomplete"].includes(result.status) ? 2 : 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${errorReport(error)}\n`);
    process.exitCode = reconciliationExitCode(error);
  });
}
