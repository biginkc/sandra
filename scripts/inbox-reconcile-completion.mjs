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

async function captureDirtyGenerationDigest(client) {
  const rows = (await client.query(
    `SELECT org_id::text AS org_id,target_kind,target_id::text AS target_id,generation
       FROM inbox_message_capture.dirty
      ORDER BY org_id,target_kind,target_id`,
  )).rows;
  return digestJson(rows);
}

function compareProjectionRows(expectedRows, actualRows) {
  const expected = new Map(expectedRows.map((row) => [rowKey(row), row]));
  const actual = new Map(actualRows.map((row) => [rowKey(row), row]));
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
             candidate.candidate,
             CASE WHEN r.org_id IS NULL THEN NULL ELSE jsonb_build_object(
               'org_id',r.org_id::text,'target_kind',r.target_kind,'target_id',r.target_id::text,
               'revision',r.revision::text,'source_generation',r.source_generation::text,
               'summary',r.summary,'next_expiry',r.next_expiry
             ) END AS actual
      FROM all_targets a
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

  const perOrg = [];
  for (const [orgId, value] of [...byOrg.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const targetExpected = new Map();
    const targetActual = new Map();
    let baseCount = 0;
    let canonicalMissing = 0;
    for (const row of value.canonical) {
      const key = rowKey(row);
      if (row.base_target) baseCount++;
      if (row.candidate === null) canonicalMissing++;
      if (row.candidate !== null) targetExpected.set(key, row.candidate);
      if (row.actual !== null) targetActual.set(key, row.actual);
    }
    let maintainedMissing = 0;
    let maintainedMismatched = 0;
    for (const row of value.canonical) {
      if (row.base_target && row.actual === null) maintainedMissing++;
      if (row.candidate === null || row.actual === null) continue;
      const actual = row.actual;
      const candidate = row.candidate;
      if (actual.revision !== candidate.expected_revision || actual.source_generation !== candidate.generation || JSON.stringify(stable(comparableSummary(actual.summary))) !== JSON.stringify(stable(comparableSummary(candidate.summary))) || iso(actual.next_expiry) !== iso(candidate.summary?.next_window_expiry)) {
        maintainedMismatched++;
      }
    }
    const baseTargetKeys = new Set(value.canonical.filter((row) => row.base_target).map(rowKey));
    for (const row of value.maintained) {
      if (baseTargetKeys.has(rowKey(row))) continue;
      if (row.summary?.exists === true) maintainedMismatched++;
    }
    const maintainedExtra = value.maintained.filter((row) => !baseTargetKeys.has(rowKey(row)) && row.summary?.exists !== false && row.summary?.exists !== true).length;
    const bridgeComparison = compareProjectionRows(value.expectedBridge, value.actualBridge);
    const filterComparison = compareProjectionRows(value.expectedFilter, value.actualFilter);
    const unknownMappingMissing = value.unknownSources.filter((row) => row.mapped !== true).length;
    const mismatchCount = canonicalMissing + maintainedMissing + maintainedMismatched + maintainedExtra + bridgeComparison.total + filterComparison.total + unknownMappingMissing;
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
    per_org: perOrg,
    pass: perOrg.every((row) => row.mismatch_count === 0),
  };
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
  const liveCaptureFingerprint = (await client.query("SELECT inbox_backfill.fingerprint() AS fingerprint")).rows[0]?.fingerprint ?? null;
  const jobFingerprintMismatches = jobs.filter((job) => job.capture_fingerprint !== liveCaptureFingerprint).length;
  return { rollout: rollout[0] ?? null, baseline: baseline[0] ?? null, generation: generation[0]?.generation ?? null, jobs, pending, collisions, liveCaptureFingerprint, jobFingerprintMismatches };
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
  const attestation = validateAttestation(sourceWriterAttestation, {
    generation: state.generation,
    expectedCatalogFingerprint,
  });
  const backfillComplete = state.jobs.length > 0 && state.jobs.every((job) => job.stream === "done" && job.claim_token === null && job.completed_at !== null && job.capture_fingerprint === state.liveCaptureFingerprint);
  const baselineComplete = state.baseline?.stage === "done";
  const noPendingWork = Object.values(state.pending).every((value) => Number(value) === 0);
  const noCollisions = Number(state.collisions.unresolved) === 0 && Number(state.collisions.duplicate_threads) === 0;
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
    projection_reconciled: reconciliation.pass,
    filter_reconciled: reconciliation.pass,
    catalog_fingerprint_match: catalogMatch,
    source_writer_coverage: writer.pass,
    source_writer_attestation: attestation.pass,
    capture_fingerprint_stable: state.jobFingerprintMismatches === 0 && state.liveCaptureFingerprint !== null,
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

async function collectRecoveryPlan(client, { expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT, observedAt = new Date().toISOString() } = {}) {
  const state = await collectState(client);
  const writer = await collectSourceWriterEvidence(client);
  const liveCatalogFingerprint = await catalogFingerprint(client);
  const reconciliation = await collectOrgReconciliation(client, { observedAt });
  const sourceGenerationDigest = await captureDirtyGenerationDigest(client);
  const boundaryCount = Number((await client.query("SELECT count(*)::int AS count FROM inbox_read.boundaries")).rows[0]?.count ?? 0);
  const catalogMatch = typeof expectedCatalogFingerprint === "string" && HEX64.test(expectedCatalogFingerprint) && liveCatalogFingerprint === expectedCatalogFingerprint.toLowerCase();
  const checks = {
    serving_disabled: state.rollout?.serving_enabled === false,
    source_writer_coverage: writer.pass,
    catalog_fingerprint_match: catalogMatch,
    full_reconciliation: reconciliation.pass,
  };
  const evidence = {
    evidence_version: 2,
    observed_at: observedAt,
    mode: "capture-bypass-recovery",
    capture_generation: state.generation,
    source_generation_digest: sourceGenerationDigest,
    serving_enabled: state.rollout?.serving_enabled ?? null,
    read_boundary_count: boundaryCount,
    planned: {
      capture_generation_bump: true,
      invalidate_prior_read_boundaries: boundaryCount,
      rebuild_capture_targets: true,
      republish_maintained_rows: true,
      reconcile_bridge_summaries: true,
      reconcile_bridge_filter_rows: true,
      marker_write: false,
      serving_write: false,
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
      source_writer: writer.trigger_fingerprint,
    },
    source_writer_coverage: {
      required_trigger_count: writer.required_trigger_count,
      observed_trigger_count: writer.observed_trigger_count,
      missing_trigger_count: writer.missing_trigger_count,
      disabled_trigger_count: writer.disabled_trigger_count,
      trigger_fingerprint: writer.trigger_fingerprint,
    },
    checks,
    status: Object.values(checks).every(Boolean) ? "ready" : "blocked",
  };
  evidence.evidence_digest = digestJson({ ...evidence, observed_at: undefined, evidence_digest: undefined });
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

async function rebuildCaptureAndProjection(client, observedAt) {
  const deadline = Date.now() + RECOVERY_REBUILD_TIMEOUT_MS;
  await client.query("UPDATE inbox_message_capture.dirty SET generation=generation+1");
  const unknownSources = (await client.query(`
    SELECT DISTINCT org_id,from_address AS raw_sender
    FROM public.messages
    WHERE channel='sms' AND direction='inbound' AND contact_id IS NULL
      AND from_address IS NOT NULL AND from_address<>''
    ORDER BY org_id,raw_sender
  `)).rows;
  for (const source of unknownSources) {
    await client.query("SELECT inbox_message_capture.sender_id($1,$2)", [source.org_id, source.raw_sender]);
  }
  await client.query(`
    WITH known_targets AS (
      SELECT DISTINCT org_id,'known_conversation'::text AS target_kind,conversation_id AS target_id
      FROM public.messages WHERE channel='sms' AND conversation_id IS NOT NULL
      UNION
      SELECT DISTINCT org_id,'known_conversation'::text,conversation_id
      FROM public.ai_disposition_reviews WHERE conversation_id IS NOT NULL
      UNION
      SELECT DISTINCT org_id,'known_conversation'::text,conversation_id
      FROM public.message_threads WHERE conversation_id IS NOT NULL
    ), unknown_targets AS (
      SELECT m.org_id,'unknown_sender'::text AS target_kind,g.sender_group_id AS target_id
      FROM (SELECT DISTINCT org_id,from_address FROM public.messages WHERE channel='sms' AND direction='inbound' AND contact_id IS NULL AND from_address IS NOT NULL AND from_address<>'') m
      JOIN inbox_message_capture.sender_groups g ON g.org_id=m.org_id AND g.raw_sender COLLATE "C"=m.from_address COLLATE "C"
    ), targets AS (
      SELECT * FROM known_targets UNION SELECT * FROM unknown_targets
    )
    INSERT INTO inbox_message_capture.dirty(org_id,target_kind,target_id,generation)
    SELECT org_id,target_kind,target_id,1 FROM targets
    ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1
  `);
  const sourceGenerationDigest = await captureDirtyGenerationDigest(client);
  await client.query(`
    DELETE FROM inbox_bridge.summaries s
    WHERE NOT EXISTS (SELECT 1 FROM inbox_message_capture.dirty d WHERE d.org_id=s.org_id AND d.target_kind=s.target_kind AND d.target_id=s.target_id);
    DELETE FROM inbox_bridge.filter_rows f
    WHERE NOT EXISTS (SELECT 1 FROM inbox_message_capture.dirty d WHERE d.org_id=f.org_id AND d.target_kind=f.target_kind AND d.target_id=f.target_id);
    DELETE FROM inbox_maintained.rows r
    WHERE NOT EXISTS (SELECT 1 FROM inbox_message_capture.dirty d WHERE d.org_id=r.org_id AND d.target_kind=r.target_kind AND d.target_id=r.target_id);
    DELETE FROM inbox_message_capture.route_edges;
    INSERT INTO inbox_message_capture.route_edges(org_id,message_id,conversation_id,phone_e164)
    SELECT m.org_id,m.id,m.conversation_id,
      CASE WHEN length(regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g'))=10
        THEN '+1'||regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g')
        WHEN length(regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g'))=11
          AND left(regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g'),1)='1'
        THEN '+'||regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g') END
    FROM public.messages m
    WHERE m.channel='sms' AND m.conversation_id IS NOT NULL
      AND CASE WHEN length(regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g'))=10
        THEN '+1'||regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g')
        WHEN length(regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g'))=11
          AND left(regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g'),1)='1'
        THEN '+'||regexp_replace(coalesce(CASE WHEN m.direction='inbound' THEN m.from_address ELSE m.to_address END,''),'[^0-9]','','g') END IS NOT NULL
  `);
  const dirty = (await client.query("SELECT org_id,target_kind,target_id FROM inbox_message_capture.dirty ORDER BY org_id,target_kind,target_id")).rows;
  const resultCounts = { targets: dirty.length, applied: 0, already_applied: 0 };
  for (const row of dirty) {
    if (Date.now() > deadline) throw new ReconciliationBlocked("RECOVERY_REBUILD_TIMEOUT");
    const candidate = (await client.query(
      "SELECT inbox_maintained.snapshot($1,$2,$3,$4) AS candidate",
      [row.org_id, row.target_kind, row.target_id, observedAt],
    )).rows[0]?.candidate;
    if (!candidate) throw new ReconciliationBlocked("RECOVERY_SNAPSHOT_MISSING");
    const result = (await client.query("SELECT inbox_maintained.publish($1) AS result", [candidate])).rows[0]?.result;
    if (!['applied', 'already_applied'].includes(result)) throw new ReconciliationBlocked(`RECOVERY_PUBLISH_${String(result).toUpperCase()}`);
    resultCounts[result]++;
  }
  if (Date.now() > deadline) throw new ReconciliationBlocked("RECOVERY_REBUILD_TIMEOUT");
  const finalSourceGenerationDigest = await captureDirtyGenerationDigest(client);
  if (finalSourceGenerationDigest !== sourceGenerationDigest) throw new ReconciliationBlocked("RECOVERY_SOURCE_CHANGED");
  const cleared = await client.query("DELETE FROM inbox_maintained.queue");
  resultCounts.queue_cleared = cleared.rowCount;
  resultCounts.source_generation_digest = sourceGenerationDigest;
  return resultCounts;
}

async function runCaptureRecovery(client, {
  expectedCatalogFingerprint = EXPECTED_CATALOG_FINGERPRINT,
  apply = false,
} = {}) {
  const initial = await readOnlyRecoveryPlan(client, { expectedCatalogFingerprint });
  if (initial.serving_enabled === true) return { status: "blocked", evidence: initial, recovery: null };
  if (!apply) return { status: "recovery-dry-run", evidence: initial, recovery: { applied: false } };
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  let committed = false;
  try {
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SELECT singleton FROM inbox_control.rollout WHERE singleton FOR UPDATE");
    const recheck = await collectRecoveryPlan(client, { expectedCatalogFingerprint });
    if (!recheck.checks.serving_disabled) throw new ReconciliationBlocked("SERVING_ENABLED");
    if (!recheck.checks.catalog_fingerprint_match) throw new ReconciliationBlocked("CATALOG_FINGERPRINT_MISMATCH");
    if (!recheck.checks.source_writer_coverage) throw new ReconciliationBlocked("SOURCE_WRITER_COVERAGE");
    const oldGeneration = recheck.capture_generation;
    const generation = (await client.query("UPDATE inbox_capture_boundary.generation SET generation=gen_random_uuid() WHERE singleton RETURNING generation::text AS generation")).rows[0]?.generation;
    if (!generation) throw new ReconciliationBlocked("CAPTURE_GENERATION_MISSING");
    const invalidated = await client.query("DELETE FROM inbox_read.boundaries WHERE generation IS DISTINCT FROM $1::uuid", [generation]);
    const rebuild = await rebuildCaptureAndProjection(client, new Date().toISOString());
    const beforeCommit = await collectRecoveryPlan(client, { expectedCatalogFingerprint });
    if (!beforeCommit.checks.full_reconciliation) throw new ReconciliationBlocked("RECOVERY_RECONCILIATION_FAILED");
    await client.query("COMMIT");
    committed = true;
    const after = await readOnlyRecoveryPlan(client, { expectedCatalogFingerprint });
    if (!after.checks.full_reconciliation) throw new ReconciliationBlocked("RECOVERY_RECONCILIATION_FAILED");
    if (after.source_generation_digest !== rebuild.source_generation_digest) throw new ReconciliationBlocked("RECOVERY_SOURCE_CHANGED");
    after.recovery = {
      applied: true,
      capture_generation_before: oldGeneration,
      capture_generation_after: generation,
      read_boundaries_invalidated: invalidated.rowCount,
      rebuild,
      source_generation_stable: true,
    };
    after.evidence_digest = digestJson({ ...after, observed_at: undefined, evidence_digest: undefined });
    return { status: "recovery-written", evidence: after, recovery: after.recovery };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
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
  beforeWrite,
} = {}) {
  if (recoverCaptureBypass) return runCaptureRecovery(client, { expectedCatalogFingerprint, apply: applyCaptureRecovery });
  const initial = await readOnlyEvidence(client, { expectedCatalogFingerprint, sourceWriterAttestation, attestationPath });
  if (initial.status !== "ready") return { status: "blocked", evidence: initial, marker_write: null };
  if (!writeMarkers) return { status: "ready", evidence: initial, marker_write: null };

  await beforeWrite?.(initial);

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
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
      return { status: "written", evidence: recheck, marker_write: { rows_changed: 1 } };
    }
    const row = (await client.query(
      "SELECT backfill_complete,reconciliation_complete,serving_enabled FROM inbox_control.rollout WHERE singleton",
    )).rows[0];
    if (row?.serving_enabled === false && row?.backfill_complete === true && row?.reconciliation_complete === true) {
      await client.query("COMMIT");
      return { status: "idempotent", evidence: recheck, marker_write: { rows_changed: 0 } };
    }
    throw new ReconciliationBlocked("MARKER_STATE_CHANGED");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
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
    return result.status === "blocked" ? 2 : 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${redactedError(error)}\n`);
    process.exitCode = 2;
  });
}
