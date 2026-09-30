#!/usr/bin/env node

import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import process from "node:process";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const PINNED_CA_FINGERPRINT =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

const HEX64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n([\s\S]*?)\r?\n-----END CERTIFICATE-----/;

export const SOURCE_WRITERS = Object.freeze([
  ["public.messages", "zzzzz_inbox_message_direct"],
  ["public.messages", "zzz_inbox_guard_inbound_revision_insert"],
  ["public.messages", "zzz_inbox_guard_inbound_revision_update"],
  ["public.messages", "inbox_capture_inbound_head"],
  ["public.properties", "zzzzz_inbox_parent"],
  ["public.properties", "zzzzzz_inbox_policy"],
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
  ["auth.sessions", "zzzzzzz_inbox_access"],
  ["inbox_message_capture.dirty", "maintained_queue"],
  ["inbox_maintained.rows", "bridge_projection"],
  ["inbox_maintained.rows", "bridge_filter_projection"],
]);

const CATALOG_SCHEMAS = Object.freeze([
  "inbox_backfill",
  "inbox_bridge",
  "inbox_capture_boundary",
  "inbox_control",
  "inbox_maintained",
  "inbox_message_capture",
  "inbox_parent",
  "inbox_policy",
  "inbox_safety",
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

function projectionRecord(row) {
  const summary = row.summary;
  if (!summary || summary.exists !== true) return null;
  const unknown = row.target_kind === "unknown_sender";
  const assigned = summary.assigned_user_id == null ? "Unassigned" : "Assigned";
  const latest = unknown ? summary.latest_at : summary.last_message_at;
  return {
    target_kind: row.target_kind,
    target_id: row.target_id,
    projection_revision: String(row.revision),
    source_generation: String(row.source_generation),
    name: String((unknown ? (summary.raw_sender_key || "Unknown sender") : (summary.contact_name || summary.thread_customer_phone || "Unknown contact"))).slice(0, 2000),
    context: String(unknown ? "Unknown sender" : (summary.property_address || "No property linked")).slice(0, 2000),
    preview: String(unknown ? (summary.latest_preview || "") : (summary.last_message_preview || "")).slice(0, 2000),
    time_label: String(latest || ""),
    outcome_label: unknown ? (summary.is_dismissed === true ? "Dismissed" : "Unknown sender") : String(summary.outreach_dispo || "No outcome"),
    assigned_label: assigned,
    unread: unknown ? null : Number(summary.unread_count || 0) > 0,
    latest_at: iso(latest),
    visible_active: Boolean(unknown ? summary.visible_unknown : summary.visible_all_hide_noise),
    visible_dismissed: unknown && Boolean(summary.visible_dismissed),
    visible_review: !unknown && Boolean(summary.visible_review),
    visible_unread: !unknown && Boolean(summary.visible_unread_hide_noise),
  };
}

function actualProjectionRecord(row) {
  return {
    target_kind: row.target_kind,
    target_id: row.target_id,
    projection_revision: String(row.projection_revision),
    source_generation: String(row.source_generation),
    name: row.name,
    context: row.context,
    preview: row.preview,
    time_label: row.time_label,
    outcome_label: row.outcome_label,
    assigned_label: row.assigned_label,
    unread: row.unread,
    latest_at: iso(row.latest_at),
    visible_active: row.visible_active,
    visible_dismissed: row.visible_dismissed,
    visible_review: row.visible_review,
    visible_unread: row.visible_unread,
  };
}

function hashRows(rows) {
  return digestJson(rows.map(stable).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function orgDigest(orgId) {
  return sha256(`org:${orgId}`);
}

async function catalogFingerprint(client) {
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
        AND (tn.nspname=ANY($1::text[]) OR c.oid IN (
          'public.messages'::regclass,
          'public.properties'::regclass,
          'public.contacts'::regclass,
          'public.ai_disposition_reviews'::regclass,
          'public.consent_events'::regclass,
          'public.message_threads'::regclass,
          'public.sms_phone_suppressions'::regclass,
          'public.memberships'::regclass
        ))
      ORDER BY tn.nspname,c.oid::regclass::text,t.tgname`,
    [CATALOG_SCHEMAS],
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
  if (raw.digest !== digestJson(payload) || raw.capture_generation !== generation) {
    return { pass: false, code: "SOURCE_WRITER_ATTESTATION_INVALID" };
  }
  return { pass: true, digest: raw.digest };
}

async function readAttestation(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ReconciliationBlocked("SOURCE_WRITER_ATTESTATION_INVALID");
  }
}

async function collectOrgReconciliation(client) {
  const orgRows = (await client.query("SELECT id::text AS id FROM public.organizations ORDER BY id")).rows;
  const sourceRows = (await client.query(
    `SELECT org_id::text AS org_id,target_kind,target_id::text AS target_id,revision,source_generation,summary
       FROM inbox_maintained.rows
      ORDER BY org_id,target_kind,target_id`,
  )).rows;
  const projectionRows = (await client.query(
    `SELECT org_id::text AS org_id,target_kind,target_id::text AS target_id,projection_revision,source_generation,
            name,context,preview,time_label,outcome_label,assigned_label,unread,latest_at,
            visible_active,visible_dismissed,visible_review,visible_unread
       FROM inbox_bridge.summaries
      ORDER BY org_id,target_kind,target_id`,
  )).rows;
  const byOrg = new Map(orgRows.map(({ id }) => [id, { source: [], projection: [], tombstones: 0 }]));
  for (const row of sourceRows) {
    if (!byOrg.has(row.org_id)) byOrg.set(row.org_id, { source: [], projection: [], tombstones: 0 });
    const target = byOrg.get(row.org_id);
    const record = projectionRecord(row);
    if (record) target.source.push(record);
    else target.tombstones++;
  }
  for (const row of projectionRows) {
    if (!byOrg.has(row.org_id)) byOrg.set(row.org_id, { source: [], projection: [], tombstones: 0 });
    byOrg.get(row.org_id).projection.push(actualProjectionRecord(row));
  }
  const perOrg = [];
  for (const [id, value] of [...byOrg.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const expected = new Map(value.source.map((row) => [`${row.target_kind}|${row.target_id}`, row]));
    const actual = new Map(value.projection.map((row) => [`${row.target_kind}|${row.target_id}`, row]));
    let mismatches = 0;
    let orphan = 0;
    for (const [key, row] of expected) {
      if (!actual.has(key)) mismatches++;
      else if (JSON.stringify(stable(row)) !== JSON.stringify(stable(actual.get(key)))) mismatches++;
    }
    for (const key of actual.keys()) if (!expected.has(key)) { mismatches++; orphan++; }
    perOrg.push({
      org_digest: orgDigest(id),
      source_count: value.source.length,
      projection_count: value.projection.length,
      tombstone_count: value.tombstones,
      orphan_projection_count: orphan,
      mismatch_count: mismatches,
      source_hash: hashRows(value.source),
      projection_hash: hashRows(value.projection),
    });
  }
  return {
    organizations: perOrg.length,
    mismatched_organizations: perOrg.filter((row) => row.mismatch_count !== 0 || row.source_count !== row.projection_count).length,
    per_org: perOrg,
    pass: perOrg.every((row) => row.mismatch_count === 0 && row.source_count === row.projection_count),
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
  expectedCatalogFingerprint,
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
      per_org: reconciliation.per_org,
    },
    fingerprints: {
      expected_catalog: typeof expectedCatalogFingerprint === "string" && HEX64.test(expectedCatalogFingerprint) ? expectedCatalogFingerprint.toLowerCase() : null,
      live_catalog: liveCatalogFingerprint,
      live_capture: state.liveCaptureFingerprint,
      source_writer: writer.trigger_fingerprint,
    },
    source_writer_attestation: {
      present: Boolean(sourceWriterAttestation),
      digest: attestation.digest ?? null,
      path_supplied: Boolean(attestationPath),
    },
    source_writer_coverage: {
      required_trigger_count: writer.required_trigger_count,
      observed_trigger_count: writer.observed_trigger_count,
      missing_trigger_count: writer.missing_trigger_count,
      disabled_trigger_count: writer.disabled_trigger_count,
      digest: writer.trigger_fingerprint,
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

export async function reconcileAndMaybeWrite(client, {
  expectedCatalogFingerprint,
  sourceWriterAttestation,
  attestationPath,
  writeMarkers = false,
} = {}) {
  const initial = await readOnlyEvidence(client, { expectedCatalogFingerprint, sourceWriterAttestation, attestationPath });
  if (initial.status !== "ready") return { status: "blocked", evidence: initial, marker_write: null };
  if (!writeMarkers) return { status: "ready", evidence: initial, marker_write: null };

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
  const result = { writeMarkers: false, output: null, expectedCatalogFingerprint: env.INBOX_RECONCILIATION_EXPECTED_CATALOG_SHA256 ?? null, attestationPath: env.INBOX_RECONCILIATION_SOURCE_WRITER_ATTESTATION ?? null, target: env.INBOX_RECONCILIATION_TARGET ?? "production" };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--write-markers") result.writeMarkers = true;
    else if (value === "--output") result.output = argv[++index] ?? null;
    else if (value === "--expected-catalog-fingerprint") result.expectedCatalogFingerprint = argv[++index] ?? null;
    else if (value === "--source-writer-attestation") result.attestationPath = argv[++index] ?? null;
    else if (value === "--target") result.target = argv[++index] ?? null;
    else if (value === "--help") result.help = true;
    else throw new Error("ARGUMENT_INVALID");
  }
  return result;
}

function redactedError(error) {
  return error instanceof ReconciliationBlocked ? error.code : /^[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "RECONCILIATION_FAILED";
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = args(argv, env);
  if (parsed.help) {
    process.stdout.write("Dry-run: node scripts/inbox-reconcile-completion.mjs\nMutation: add --write-markers\nDatabase: INBOX_RECONCILIATION_DATABASE_URL\n");
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
    });
    const output = { mode: parsed.writeMarkers ? "write-markers" : "dry-run", ...result, connection };
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
