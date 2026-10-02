#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const { Client } = pg;

export const TEST_REF = "ncsngxlcyxylaeskiteu";
export const PROD_REF = "copflsklaefwzipsrjqz";
export const LOCK_KEY = "sandra-integration-suite";
export const ACK_ENV = "INBOX_RO_FIXTURE_ACK";
export const DB_ENV = "TEST_SUPABASE_DB_URL";
export const SUPABASE_URL_ENV = "TEST_SUPABASE_URL";
export const SERVICE_ROLE_KEY_ENV = "TEST_SUPABASE_SERVICE_ROLE_KEY";
export const TEST_MODE_ENV = "INBOX_RO_FIXTURE_TEST_MODE";
export const PURPOSE = "J5a shared-readonly PRE->POST queued-set baseline on TEST";
export const MAX_LEASE_MS = 6 * 60 * 60 * 1000;

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const sendSourcePath = path.join(repoRoot, "src/lib/messaging/send.ts");
const tickSourcePath = path.join(repoRoot, "src/app/api/cron/sequence-tick/handlers.ts");
const repSmsScopeSourcePath = path.join(repoRoot, "src/lib/messaging/rep-sms-scope.ts");
const EXPECTED_MESSAGE_COLUMNS = [
  "id", "org_id", "channel", "direction", "status", "provider", "contact_id",
  "property_id", "campaign_id", "conversation_id", "from_address", "to_address",
  "body", "metadata", "scheduled_for", "external_id",
];
const COUNTER_ALLOWLIST = new Set([
  "public.memberships.my_leads_revision",
  "public.messages.inbox_inbound_revision",
  "public.hugo_owner_guard_serialization.version",
]);
const ANCHOR_TABLES = new Map([
  ["public.organizations", "org"],
  ["auth.users", "user"],
]);
const SUPABASE_MANAGED_APPEND_ONLY_TABLES = new Set([
  "auth.audit_log_entries",
  "realtime.messages",
]);

class FixtureError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "FixtureError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new FixtureError(code, message);
}

function assert(condition, code, message = code) {
  if (!condition) fail(code, message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonHash(value) {
  return sha256(canonicalJson(value));
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteTable(schema, name) {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

function safeRunId(value) {
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value ?? ""), "INVALID_RUN_ID", "run id must be 1-64 ASCII letters, digits, '.', '_' or '-'");
  return value;
}

function parseArgs(argv) {
  const result = { mode: null, runId: null, owner: null, receipt: null, leaseSeconds: null, readyFile: null, leaseExpiresAt: null, lease_seconds: null, lease_expires_at: null };
  const modes = new Map([
    ["--create", "create"],
    ["--status", "status"],
    ["--verify", "status"],
    ["--remove", "remove"],
    ["--cleanup", "remove"],
    ["--hold-lock", "hold-lock"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (modes.has(arg)) {
      assert(result.mode === null, "MULTIPLE_MODES");
      result.mode = modes.get(arg);
      continue;
    }
    if (["--run-id", "--owner", "--receipt", "--lease-seconds", "--ready-file", "--lease-expires-at"].includes(arg)) {
      const value = argv[++i];
      assert(value !== undefined && value !== "", "MISSING_OPTION_VALUE", `missing value for ${arg}`);
      const key = {
        "--run-id": "runId",
        "--owner": "owner",
        "--receipt": "receipt",
        "--lease-seconds": "lease_seconds",
        "--ready-file": "readyFile",
        "--lease-expires-at": "lease_expires_at",
      }[arg];
      result[key] = value;
      continue;
    }
    if (arg === "--db-url" || arg === "--database-url" || arg === "--url") {
      fail("DB_URL_ARG_REFUSED", "the database URL is accepted only from TEST_SUPABASE_DB_URL");
    }
    fail("UNKNOWN_OPTION", `unknown option ${arg}`);
  }
  assert(result.mode !== null, "MODE_REQUIRED", "choose --create, --status, or --remove");
  if (result.mode !== "hold-lock") safeRunId(result.runId);
  if (result.mode === "create") {
    assert(result.owner, "OWNER_REQUIRED", "--owner is required for --create");
    assert(/^[^\r\n]{1,160}$/.test(result.owner), "INVALID_OWNER");
  }
  if (result.lease_seconds !== null) {
    const seconds = Number(result.lease_seconds);
    assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_LEASE_MS / 1000, "INVALID_LEASE", "lease must be an integer between 1 and 21600 seconds");
    result.leaseSeconds = seconds;
  }
  if (result.lease_expires_at !== null) {
    assert(!Number.isNaN(Date.parse(result.lease_expires_at)), "INVALID_LEASE_EXPIRY");
    result.leaseExpiresAt = result.lease_expires_at;
  }
  return result;
}

function isLoopbackTarget(url) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    && Number(url.port) >= 55000
    && Number(url.port) <= 59999;
}

function isLoopbackSupabaseUrl(url) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    && Number(url.port) >= 55000
    && Number(url.port) <= 59999
    && url.protocol === "http:"
    && url.pathname === "/"
    && !url.username
    && !url.password
    && !url.search
    && !url.hash;
}

function isHostedTestTarget(url) {
  return url.hostname.endsWith(".pooler.supabase.com")
    && decodeURIComponent(url.username) === `postgres.${TEST_REF}`
    && (url.port === "" || url.port === "5432");
}

function isHostedTestSupabaseUrl(url) {
  return url.protocol === "https:"
    && url.hostname === `${TEST_REF}.supabase.co`
    && url.pathname === "/"
    && !url.username
    && !url.password
    && !url.search
    && !url.hash;
}

export function assertSafeTarget(env = process.env) {
  assert(env[ACK_ENV] === TEST_REF, "ACK_REQUIRED", `${ACK_ENV} must equal the TEST project ref`);
  assert(Object.prototype.hasOwnProperty.call(env, "MESSAGING_PROVIDER") === false, "MESSAGING_PROVIDER_REFUSED", "MESSAGING_PROVIDER must be unset");
  assert(!env.CI && !env.GITHUB_ACTIONS, "CI_REFUSED", "CI targets are refused");
  const raw = env[DB_ENV];
  assert(raw, "DB_URL_REQUIRED", `${DB_ENV} is required and must not be read from a file or argument`);
  assert(!String(raw).includes(PROD_REF), "PRODUCTION_REFUSED", "Production project ref is refused");
  let url;
  try { url = new URL(raw); } catch { fail("DB_URL_INVALID", "database URL is invalid"); }
  assert(["postgres:", "postgresql:"].includes(url.protocol), "DB_URL_INVALID", "database URL must use postgres:// or postgresql://");
  assert(url.pathname === "/postgres" && !url.search && !url.hash, "DB_URL_INVALID", "database URL must target the postgres database without query options");
  const rawSupabaseUrl = env[SUPABASE_URL_ENV];
  assert(rawSupabaseUrl, "SUPABASE_URL_REQUIRED", `${SUPABASE_URL_ENV} is required and must not be read from a file or argument`);
  let supabaseUrl;
  try { supabaseUrl = new URL(rawSupabaseUrl); } catch { fail("SUPABASE_URL_INVALID", "Supabase URL is invalid"); }
  assert(!String(rawSupabaseUrl).includes(PROD_REF), "PRODUCTION_REFUSED", "Production project ref is refused");
  const localApi = isLoopbackSupabaseUrl(supabaseUrl);
  if (localApi) {
    assert(env[TEST_MODE_ENV] === "1" && env.NODE_ENV === "test", "LOCAL_TARGET_REFUSED", "loopback Supabase URLs are allowed only by this tool's NODE_ENV=test local tests");
  } else {
    assert(isHostedTestSupabaseUrl(supabaseUrl), "TARGET_REFUSED", "only the TEST Supabase API project target is allowed");
    assert(!env[TEST_MODE_ENV], "HOSTED_TEST_MODE_REFUSED", "local-test mode cannot target a hosted Supabase API");
  }
  if (isLoopbackTarget(url)) {
    assert(env[TEST_MODE_ENV] === "1" && env.NODE_ENV === "test", "LOCAL_TARGET_REFUSED", "loopback targets are allowed only by this tool's NODE_ENV=test local tests");
    return { kind: "local-test", url, supabaseUrl };
  }
  assert(isHostedTestTarget(url), "TARGET_REFUSED", "only the TEST session-pooler project target is allowed");
  assert(!env[TEST_MODE_ENV], "HOSTED_TEST_MODE_REFUSED", "local-test mode cannot target a hosted database");
  return { kind: "shared-test", url, supabaseUrl };
}

function receiptPathFor(runId, env = process.env, explicit = null) {
  const dir = explicit
    ? path.dirname(explicit)
    : path.resolve(env.INBOX_RO_FIXTURE_RECEIPT_DIR ?? path.join(env.HOME ?? tmpdir(), ".sandra-inbox-fixture"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!explicit && !env.INBOX_RO_FIXTURE_RECEIPT_DIR) chmodSync(dir, 0o700);
  return explicit ? path.resolve(explicit) : path.join(dir, `lease-test-ro-fixture-${runId}.json`);
}

function readReceipt(file) {
  assert(existsSync(file), "RECEIPT_MISSING", `receipt not found: ${file}`);
  let receipt;
  try { receipt = JSON.parse(readFileSync(file, "utf8")); } catch { fail("RECEIPT_INVALID", "receipt is not valid JSON"); }
  assert(receipt?.redacted === true, "RECEIPT_INVALID", "receipt is not a redacted fixture receipt");
  safeRunId(receipt.run_id);
  assert(receipt.target_ref === TEST_REF, "RECEIPT_TARGET_INVALID");
  return receipt;
}

function writeReceipt(file, receipt) {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function currentScriptBinding() {
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(); } catch {}
  return { commit, sha256: sha256(readFileSync(scriptPath)) };
}

function assertSourceGuards() {
  const send = readFileSync(sendSourcePath, "utf8");
  const tick = readFileSync(tickSourcePath, "utf8");
  const repSmsScope = readFileSync(repSmsScopeSourcePath, "utf8");
  assert(send.includes("queued message missing contact/property/to_address"), "SEND_GUARD_NOT_PRESENT", "the checked-out send guard is not present");
  assert(send.includes("if (!msg.contact_id || !msg.property_id || !msg.to_address)"), "SEND_GUARD_NOT_PRESENT", "the checked-out send guard shape is not present");
  assert(send.includes("if (msg.provider !== provider.providerId)"), "PROVIDER_GUARD_NOT_PRESENT", "the checked-out provider identity guard is not present");
  assert(tick.includes(".lte(\"scheduled_for\", nowIso)") && tick.includes(".not(\"scheduled_for\", \"is\", null)"), "SCHEDULER_GUARD_NOT_PRESENT", "the checked-out scheduler due-row guard is not present");
  assert(repSmsScope.includes("SENDILLO_ORG_SCOPE_DENIED_MESSAGE") && repSmsScope.includes("assertSendilloOrganizationScope"), "SENDILLO_SCOPE_GUARD_NOT_PRESENT", "the checked-out Sendillo organization fence is not present");
}

async function openDb(env = process.env) {
  const db = new Client({ connectionString: env[DB_ENV], options: "-c extra_float_digits=3" });
  await db.connect();
  return db;
}

function openAuthAdmin(env = process.env) {
  assert(env[SERVICE_ROLE_KEY_ENV], "SERVICE_ROLE_KEY_REQUIRED", `${SERVICE_ROLE_KEY_ENV} is required only from the environment`);
  return createClient(env[SUPABASE_URL_ENV], env[SERVICE_ROLE_KEY_ENV], {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
}

async function createAuthUser(authAdmin, receipt) {
  const { data, error } = await authAdmin.createUser({
    id: receipt.ids.user,
    email: receipt.marker.email,
    email_confirm: false,
  });
  assert(!error && data?.user?.id === receipt.ids.user, "AUTH_CREATE_FAILED", "Supabase admin createUser failed");
}

async function deleteAuthUser(authAdmin, receipt) {
  const { error } = await authAdmin.deleteUser(receipt.ids.user);
  assert(!error, "AUTH_DELETE_FAILED", "Supabase admin deleteUser failed");
}

async function schemaPreflight(db) {
  const columns = (await db.query(`
    select table_schema, table_name, column_name
    from information_schema.columns
    where (table_schema, table_name) in (('public','organizations'),('public','memberships'),('public','messages'),('auth','users'))
  `)).rows;
  const byTable = new Map();
  for (const row of columns) {
    const key = `${row.table_schema}.${row.table_name}`;
    if (!byTable.has(key)) byTable.set(key, new Set());
    byTable.get(key).add(row.column_name);
  }
  for (const [table, required] of Object.entries({
    "public.organizations": ["id", "name"],
    "public.memberships": ["id", "user_id", "org_id", "role", "access_status", "access_expires_at", "deletion_prepared_at"],
    "public.messages": EXPECTED_MESSAGE_COLUMNS,
    "auth.users": ["id", "email", "email_confirmed_at", "encrypted_password"],
  })) {
    assert(byTable.has(table), "SCHEMA_PRECONDITION_FAILED", `${table} is missing`);
    for (const column of required) assert(byTable.get(table).has(column), "SCHEMA_PRECONDITION_FAILED", `${table}.${column} is missing`);
  }
  const providerCheck = (await db.query(`
    select exists (
      select 1 from pg_constraint
      where conrelid='public.messages'::regclass and pg_get_constraintdef(oid) like '%mock%'
    ) as present
  `)).rows[0].present;
  assert(providerCheck, "SCHEMA_PRECONDITION_FAILED", "messages.provider does not allow mock");
}

function fixtureIds(runId) {
  return {
    organization: randomUUID(),
    user: randomUUID(),
    membership: randomUUID(),
    messages: { scheduled: randomUUID(), unscheduled: randomUUID() },
    runId,
  };
}

function buildFixtureRecord({ runId, owner, leaseExpiresAt, ids, baseline, diagnostics, binding, receiptFile }) {
  const marker = {
    org_name: `Inbox RO fixture ${runId}`,
    email: `e2e-ro-fixture+${runId}@bmhgroupkc.com`,
    message_prefix: `inbox-ro-fixture ${runId}`,
  };
  return {
    redacted: true,
    version: 1,
    target_ref: TEST_REF,
    run_id: runId,
    owner,
    purpose: PURPOSE,
    marker,
    ids,
    created_at: new Date().toISOString(),
    lease_expires_at: leaseExpiresAt,
    script: binding,
    receipt_file: receiptFile,
    diagnostics,
    baseline,
    state: "creating",
  };
}

function expectedMetadata(receipt) {
  return {
    inbox_ro_fixture: {
      run_id: receipt.run_id,
      owner: receipt.owner,
      purpose: PURPOSE,
      lease_expires_at: receipt.lease_expires_at,
      script_sha256: receipt.script.sha256,
    },
  };
}

async function relationDiagnostics(db) {
  await db.query("select pg_stat_clear_snapshot()");
  const { rows } = await db.query(`
    select
      pg_relation_filenode('public.messages'::regclass)::text as messages_filenode,
      coalesce((select n_tup_ins::text from pg_stat_all_tables where relid='public.memberships'::regclass), '0') as memberships_n_tup_ins
  `);
  return rows[0];
}

async function settledRelationDiagnostics(db, minimumMembershipInserts) {
  let latest = await relationDiagnostics(db);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (Number(latest.memberships_n_tup_ins) >= minimumMembershipInserts) {
      const confirmed = await relationDiagnostics(db);
      if (confirmed.memberships_n_tup_ins === latest.memberships_n_tup_ins) return confirmed;
      latest = confirmed;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    latest = await relationDiagnostics(db);
  }
  return latest;
}

async function discoverTables(db) {
  const pgArray = value => Array.isArray(value)
    ? value
    : (typeof value === "string" && value.startsWith("{") && value.endsWith("}")
      ? value.slice(1, -1).split(",").filter(Boolean).map(item => item.replace(/^"|"$/g, ""))
      : []);
  return (await db.query(`
    select n.nspname as schema_name, c.relname as table_name,
      array_agg(a.attname order by a.attnum) filter (where a.attnum > 0 and not a.attisdropped) as columns,
      array_agg(a.attname order by array_position(i.indkey, a.attnum)) filter (where i.indisprimary and a.attnum = any(i.indkey)) as primary_key
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    left join pg_attribute a on a.attrelid=c.oid
    left join pg_index i on i.indrelid=c.oid and i.indisprimary
    where c.relkind in ('r','p')
      and n.nspname not like 'pg\\_%' escape '\\'
      and n.nspname <> 'information_schema'
    group by n.nspname,c.relname
    order by n.nspname,c.relname
  `)).rows.map(row => ({
    key: `${row.schema_name}.${row.table_name}`,
    schema: row.schema_name,
    name: row.table_name,
    columns: pgArray(row.columns).filter(Boolean),
    primaryKey: pgArray(row.primary_key).filter(Boolean),
  }));
}

function encodeColumn(ref) {
  return `case when ${ref} is null then 'N' else length(${ref}::text)::text || ':' || ${ref}::text end`;
}

function rowKeyExpression(table, columns) {
  const keyColumns = table.primaryKey.length ? table.primaryKey : columns;
  if (!keyColumns.length) return "md5('')";
  return `md5(array_to_string(array[${keyColumns.map(column => encodeColumn(`t.${quoteIdent(column)}`)).join(",")}], ''))`;
}

function rowHashExpression(table, columns) {
  const counter = columns.find(column => COUNTER_ALLOWLIST.has(`${table.key}.${column}`));
  const hashColumns = columns.filter(column => column !== counter);
  if (!hashColumns.length) return "md5('')";
  return `md5(array_to_string(array[${hashColumns.map(column => encodeColumn(`t.${quoteIdent(column)}`)).join(",")}], ''))`;
}

async function snapshotTable(db, table) {
  const qualified = quoteTable(table.schema, table.name);
  const key = rowKeyExpression(table, table.columns);
  const hash = rowHashExpression(table, table.columns);
  const counter = table.columns.find(column => COUNTER_ALLOWLIST.has(`${table.key}.${column}`)) ?? null;
  const counterExpr = counter ? `t.${quoteIdent(counter)}::text` : "null::text";
  const rows = (await db.query(`select ${key} as row_key, ${hash} as row_hash, ${counterExpr} as counter_value from ${qualified} t order by row_key`)).rows;
  const byKey = {};
  for (const row of rows) {
    if (!byKey[row.row_key]) byKey[row.row_key] = [];
    byKey[row.row_key].push({ hash: row.row_hash, counter: row.counter_value });
  }
  return { columns: table.columns, primary_key: table.primaryKey, counter, rows: byKey };
}

async function snapshotOwnedRowKeysFromTables(db, tables, ids) {
  const keys = new Set();
  for (const table of tables) {
    const predicate = ownedPredicate(table);
    if (!predicate) continue;
    const key = rowKeyExpression(table, table.columns);
    const rows = (await db.query(
      `select ${key} as row_key from ${quoteTable(table.schema, table.name)} t where ${predicate}`,
      [[ids.organization], [ids.user]],
    )).rows;
    for (const row of rows) keys.add(`${table.key}:${row.row_key}`);
  }
  return keys;
}

async function snapshotInReadOnlyTransaction(db, ids = null) {
  await db.query("begin isolation level repeatable read read only");
  try {
    const tables = await discoverTables(db);
    const snapshot = {};
    for (const table of tables) snapshot[table.key] = await snapshotTable(db, table);
    const ownedKeys = ids ? await snapshotOwnedRowKeysFromTables(db, tables, ids) : null;
    await db.query("commit");
    return { snapshot: { tables: snapshot }, ownedKeys };
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

export async function snapshotDatabase(db, { ids = null } = {}) {
  const { snapshot, ownedKeys } = await snapshotInReadOnlyTransaction(db, ids);
  if (ownedKeys) snapshot.owned_row_keys = [...ownedKeys].sort();
  return snapshot;
}

function ownedPredicate(table) {
  const predicates = [];
  const anchor = ANCHOR_TABLES.get(table.key);
  if (anchor === "org" && table.columns.includes("id")) predicates.push(`t.${quoteIdent("id")}::text = any($1::text[])`);
  if (anchor === "user" && table.columns.includes("id")) predicates.push(`t.${quoteIdent("id")}::text = any($2::text[])`);
  if (table.columns.includes("org_id")) predicates.push(`t.${quoteIdent("org_id")}::text = any($1::text[])`);
  if (table.columns.includes("user_id")) predicates.push(`t.${quoteIdent("user_id")}::text = any($2::text[])`);
  return predicates.length
    ? `(\$1::text[] is not null and \$2::text[] is not null and (${predicates.join(" or ")}))`
    : null;
}

async function ownedCounts(db, orgId, userId) {
  const tables = await discoverTables(db);
  const counts = {};
  for (const table of tables) {
    const predicate = ownedPredicate(table);
    if (!predicate) continue;
    const result = await db.query(`select count(*)::int as count from ${quoteTable(table.schema, table.name)} t where ${predicate}`, [[orgId], [userId]]);
    if (result.rows[0].count > 0) counts[table.key] = result.rows[0].count;
  }
  return counts;
}

export async function snapshotOwnedRowKeys(db, ids) {
  const { ownedKeys } = await snapshotInReadOnlyTransaction(db, ids);
  return ownedKeys;
}

function isOwnedIdTable(table) {
  return Boolean(table) && (
    ANCHOR_TABLES.has(table.key)
    || table.columns.includes("org_id")
    || table.columns.includes("user_id")
  );
}

function compareSnapshotDelta(
  before,
  after,
  {
    allowedOwnedKeys = new Set(),
    allowedOwnedKinds = new Set(["added", "changed", "removed"]),
    allowManagedAppendOnly = false,
    failUnownedChanges = true,
  } = {},
) {
  const failures = [];
  const changes = [];
  const managedAppendOnlyTables = new Set();
  const beforeTables = new Set(Object.keys(before.tables));
  const afterTables = new Set(Object.keys(after.tables));
  for (const key of beforeTables) {
    if (afterTables.has(key)) continue;
    const table = before.tables[key];
    changes.push({ table: key, kind: "table_vanished", owned: isOwnedIdTable(table) });
    if (failUnownedChanges || isOwnedIdTable(table)) failures.push(`table vanished: ${key}`);
  }
  for (const key of afterTables) {
    if (beforeTables.has(key)) continue;
    const table = after.tables[key];
    changes.push({ table: key, kind: "table_added", owned: isOwnedIdTable(table) });
    if (failUnownedChanges || isOwnedIdTable(table)) failures.push(`new table: ${key}`);
  }
  for (const [key, beforeTable] of Object.entries(before.tables)) {
    const afterTable = after.tables[key];
    if (!afterTable) continue;
    if (JSON.stringify(beforeTable.columns) !== JSON.stringify(afterTable.columns)) {
      changes.push({ table: key, kind: "columns_changed", owned: isOwnedIdTable(beforeTable) || isOwnedIdTable(afterTable) });
      if (failUnownedChanges || isOwnedIdTable(beforeTable) || isOwnedIdTable(afterTable)) failures.push(`columns changed: ${key}`);
    }
    const beforeMap = new Map(Object.entries(beforeTable.rows));
    const afterMap = new Map(Object.entries(afterTable.rows));
    for (const rowKey of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
      const values = beforeMap.get(rowKey);
      const next = afterMap.get(rowKey);
      const hashesChanged = !values || !next || JSON.stringify(values.map(value => value.hash)) !== JSON.stringify(next.map(value => value.hash));
      const countersChanged = values && next && beforeTable.counter
        ? JSON.stringify(values.map(value => value.counter).sort()) !== JSON.stringify(next.map(value => value.counter).sort())
        : false;
      if (!hashesChanged && !countersChanged) continue;
      const change = !values ? "added" : !next ? "removed" : "changed";
      const identity = `${key}:${rowKey}`;
      changes.push({ table: key, row_key: rowKey, kind: change, owned: allowedOwnedKeys.has(identity) });
      if (SUPABASE_MANAGED_APPEND_ONLY_TABLES.has(key)) managedAppendOnlyTables.add(key);
      const managedAllowed = allowManagedAppendOnly && SUPABASE_MANAGED_APPEND_ONLY_TABLES.has(key);
      const ownedChangeAllowed = allowedOwnedKeys.has(identity) && allowedOwnedKinds.has(change);
      const counterAdvanceAllowed = beforeTable.counter
        && COUNTER_ALLOWLIST.has(`${key}.${beforeTable.counter}`)
        && values
        && next
        && !hashesChanged
        && countersChanged;
      const ownedKeyMutation = allowedOwnedKeys.has(identity) && !ownedChangeAllowed;
      if (ownedKeyMutation || (!managedAllowed && !ownedChangeAllowed && !counterAdvanceAllowed && failUnownedChanges)) {
        failures.push(`${change === "changed" ? "content hash changed" : `row ${change}`}: ${identity}`);
      }
      if (beforeTable.counter && values && next) {
        const oldCounters = values.map(value => value.counter).sort();
        const newCounters = next.map(value => value.counter).sort();
        if (oldCounters.length !== newCounters.length) failures.push(`counter row count changed: ${key}:${rowKey}`);
        for (let i = 0; i < Math.min(oldCounters.length, newCounters.length); i += 1) {
          const oldValue = oldCounters[i] === null ? null : Number(oldCounters[i]);
          const newValue = newCounters[i] === null ? null : Number(newCounters[i]);
          if (oldValue === null || newValue === null) {
            if (oldValue !== newValue) failures.push(`counter became null/non-null: ${key}:${rowKey}`);
          } else if (newValue < oldValue) failures.push(`counter decreased: ${key}:${rowKey}`);
        }
      }
    }
  }
  return {
    failures,
    changes,
    managed_append_only_tables_changed: [...managedAppendOnlyTables].sort(),
  };
}

function snapshotContainsRow(snapshot, identity) {
  const separator = identity.indexOf(":");
  if (separator < 0) return false;
  const table = snapshot.tables[identity.slice(0, separator)];
  return Boolean(table?.rows?.[identity.slice(separator + 1)]);
}

function compareSnapshots(baseline, current) {
  return compareSnapshotDelta(baseline, current).failures;
}

async function messageReferences(db, messageIds) {
  const refs = [];
  const columns = (await db.query(`
    select table_schema, table_name, column_name
    from information_schema.columns
    where table_schema not in ('pg_catalog','information_schema')
      and column_name ilike '%message_id%'
  `)).rows;
  for (const column of columns) {
    const qualified = quoteTable(column.table_schema, column.table_name);
    const result = await db.query(`select count(*)::int as count from ${qualified} where ${quoteIdent(column.column_name)}::text = any($1::text[])`, [messageIds]);
    if (result.rows[0].count > 0) refs.push(`${column.table_schema}.${column.table_name}.${column.column_name}:${result.rows[0].count}`);
  }
  return refs;
}

async function verifyFixture(db, receipt, { checkLock = false } = {}) {
  const failures = [];
  const { ids, marker } = receipt;
  const expected = expectedMetadata(receipt);
  const org = (await db.query("select id::text,name from public.organizations where id=$1", [ids.organization])).rows[0];
  if (!org) failures.push("organization missing");
  else {
    if (org.id === "00000000-0000-0000-0000-000000000bbb") failures.push("fixture organization is the BMH org");
    if (org.name !== marker.org_name) failures.push("organization marker changed");
  }
  const user = (await db.query("select id::text,email,email_confirmed_at,encrypted_password from auth.users where id=$1", [ids.user])).rows[0];
  if (!user) failures.push("passwordless auth user missing");
  else {
    if (user.email !== marker.email) failures.push("auth email marker changed");
    if (user.email_confirmed_at !== null) failures.push("auth user is email-confirmed");
    if (user.encrypted_password !== null && user.encrypted_password !== "") failures.push("auth user unexpectedly has a password");
  }
  const membership = (await db.query("select id::text,user_id::text,org_id::text,role,access_status,access_expires_at,deletion_prepared_at from public.memberships where id=$1", [ids.membership])).rows[0];
  if (!membership) failures.push("membership missing");
  else if (membership.user_id !== ids.user || membership.org_id !== ids.organization || membership.role !== "owner" || membership.access_status !== "active" || membership.access_expires_at !== null || membership.deletion_prepared_at !== null) failures.push("membership is not exactly one active owner membership");
  const messages = (await db.query(`
    select id::text,org_id::text,channel,direction,status,provider,contact_id::text,property_id::text,campaign_id::text,conversation_id::text,from_address,to_address,body,metadata,scheduled_for as scheduled,external_id
    from public.messages where org_id=$1 order by id
  `, [ids.organization])).rows;
  if (messages.length !== 2) failures.push(`expected exactly two fixture messages, found ${messages.length}`);
  const expectedRows = new Map([
    [ids.messages.scheduled, { body: `${marker.message_prefix} m1 not deliverable`, scheduled: "2099-12-31T00:00:00.000Z" }],
    [ids.messages.unscheduled, { body: `${marker.message_prefix} m2 not deliverable`, scheduled: null }],
  ]);
  for (const row of messages) {
    const wanted = expectedRows.get(row.id);
    if (!wanted) { failures.push(`unexpected message id ${row.id}`); continue; }
    if (row.channel !== "sms" || row.direction !== "outbound" || row.status !== "queued" || row.provider !== "mock") failures.push(`message ${row.id} is not inert queued mock SMS`);
    for (const column of ["contact_id", "property_id", "campaign_id", "conversation_id", "from_address", "to_address", "external_id"]) if (row[column] !== null) failures.push(`message ${row.id}.${column} is not null`);
    if (row.body !== wanted.body || (row.scheduled?.toISOString?.() ?? row.scheduled) !== wanted.scheduled) failures.push(`message ${row.id} body/schedule changed`);
    if (jsonHash(row.metadata) !== jsonHash(expected)) failures.push(`message ${row.id} metadata changed`);
  }
  const refs = await messageReferences(db, [ids.messages.scheduled, ids.messages.unscheduled]);
  if (refs.length) failures.push(`provider-attempt/webhook references present: ${refs.join(",")}`);
  const counts = await ownedCounts(db, ids.organization, ids.user);
  const allowed = new Set(["public.organizations", "auth.users", "auth.identities", "public.memberships", "public.messages"]);
  for (const [table, count] of Object.entries(counts)) if (!allowed.has(table)) failures.push(`unexpected owned row(s) in ${table}: ${count}`);
  if ((counts["public.organizations"] ?? 0) !== 1) failures.push("owned organization count is not one");
  if ((counts["auth.users"] ?? 0) !== 1) failures.push("owned auth user count is not one");
  if ((counts["public.memberships"] ?? 0) !== 1) failures.push("owned membership count is not one");
  if ((counts["public.messages"] ?? 0) !== 2) failures.push("owned message count is not two");
  const diagnostics = await relationDiagnostics(db);
  if (receipt.diagnostics.messages_filenode !== diagnostics.messages_filenode) failures.push("messages filenode changed (reset detected)");
  if (receipt.diagnostics.memberships_n_tup_ins !== diagnostics.memberships_n_tup_ins) failures.push("memberships n_tup_ins changed (reset diagnostic)");
  if (checkLock) {
    const lock = await lockHeld(db, receipt.lock?.backend_pid);
    if (!lock) failures.push("integration lock is not held by the recorded holder");
    if (Date.parse(receipt.lease_expires_at) <= Date.now()) failures.push("fixture lease expired");
  }
  return { pass: failures.length === 0, failures, counts, diagnostics };
}

async function lockHeld(db, backendPid) {
  if (!backendPid) return false;
  return (await db.query(`
    select exists(
      select 1
      from pg_locks
      where pid=$1
        and locktype='advisory'
        and granted
        and classid=0::oid
        and objid=((hashtext($2)::bigint & 4294967295)::oid)
        and objsubid=1
    ) as held
  `, [backendPid, LOCK_KEY])).rows[0].held;
}

async function waitForFile(file, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fail("LOCK_START_FAILED", "lock holder did not report readiness");
}

async function startLockHolder({ env, runId, leaseExpiresAt }) {
  const readyDir = path.join(tmpdir(), `sandra-ro-fixture-lock-${process.pid}-${randomUUID()}`);
  mkdirSync(readyDir, { recursive: true });
  const readyFile = path.join(readyDir, "ready.json");
  let child;
  try {
    child = spawn(process.execPath, [scriptPath, "--hold-lock", "--run-id", runId, "--lease-expires-at", leaseExpiresAt, "--ready-file", readyFile], {
      env: { ...env }, detached: true, stdio: "ignore",
    });
    child.unref();
    const ready = await waitForFile(readyFile, child);
    try { unlinkSync(readyFile); } catch {}
    try { rmdirSync(readyDir); } catch {}
    return { pid: child.pid, ...ready, readyDir };
  } catch (error) {
    if (child?.pid && child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch {}
    }
    try { unlinkSync(readyFile); } catch {}
    try { rmdirSync(readyDir); } catch {}
    throw error;
  }
}

function holderCommand(pid) {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(); } catch { return ""; }
}

function stopOwnedHolder(holder, runId) {
  if (!holder?.pid) return false;
  const command = holderCommand(holder.pid);
  if (!command) return false;
  if (!command || !command.includes(scriptPath) || !command.includes("--hold-lock") || !command.includes(`--run-id ${runId}`)) fail("LOCK_OWNER_MISMATCH", "recorded holder is not this tool's holder; refusing to signal it");
  process.kill(holder.pid, "SIGTERM");
  return true;
}

async function holdLock({ env, leaseExpiresAt, readyFile }) {
  assertSafeTarget(env);
  const leaseMs = Date.parse(leaseExpiresAt) - Date.now();
  assert(Number.isFinite(leaseMs) && leaseMs > 0 && leaseMs <= MAX_LEASE_MS, "INVALID_LEASE", "lock lease must be in the future and no longer than six hours");
  const db = await openDb(env);
  let closed = false;
  const close = async (code = 0) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    await db.end().catch(() => {});
    process.exitCode = code;
  };
  await db.query("set statement_timeout=0");
  const lockResult = await db.query("select pg_try_advisory_lock(hashtext($1)) as acquired", [LOCK_KEY]);
  if (!lockResult.rows[0].acquired) {
    await db.end().catch(() => {});
    fail("LOCK_ALREADY_HELD", "the integration suite lock is already held");
  }
  const backendPid = (await db.query("select pg_backend_pid()::int as pid")).rows[0].pid;
  const readyTemp = `${readyFile}.tmp-${process.pid}`;
  writeFileSync(readyTemp, `${JSON.stringify({ backend_pid: backendPid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(readyTemp, readyFile);
  const heartbeat = setInterval(() => { db.query("select 1").catch(() => close(1)); }, 30_000);
  heartbeat.unref();
  const expiry = setTimeout(() => close(0), Math.max(0, Date.parse(leaseExpiresAt) - Date.now()));
  expiry.unref();
  process.on("SIGTERM", () => { close(0); });
  process.on("SIGINT", () => { close(0); });
  await new Promise(resolve => { process.once("beforeExit", resolve); });
}

async function insertFixture(db, receipt, authAdmin) {
  const { ids, marker } = receipt;
  const metadata = expectedMetadata(receipt);
  let authCreated = false;
  await db.query("begin");
  try {
    await db.query("insert into public.organizations(id,name) values ($1,$2)", [ids.organization, marker.org_name]);
    await createAuthUser(authAdmin, receipt);
    authCreated = true;
    await db.query(`insert into public.memberships(id,user_id,org_id,role,access_status,access_expires_at,deletion_prepared_at) values ($1,$2,$3,'owner','active',null,null)`, [ids.membership, ids.user, ids.organization]);
    await db.query(`
      insert into public.messages(id,org_id,channel,direction,status,provider,contact_id,property_id,campaign_id,conversation_id,from_address,to_address,body,metadata,scheduled_for,external_id)
      values ($1,$2,'sms','outbound','queued','mock',null,null,null,null,null,null,$3,$4,'2099-12-31T00:00:00Z',null),
             ($5,$2,'sms','outbound','queued','mock',null,null,null,null,null,null,$6,$4,null,null)
    `, [ids.messages.scheduled, ids.organization, `${marker.message_prefix} m1 not deliverable`, metadata, ids.messages.unscheduled, `${marker.message_prefix} m2 not deliverable`]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    if (authCreated) await deleteAuthUser(authAdmin, receipt).catch(() => {});
    throw error;
  }
}

async function deleteOwnedTenantRows(db, receipt, messageIds) {
  const orgId = receipt.ids.organization;
  const userId = receipt.ids.user;
  await db.query("begin");
  let ownerGuardDisabled = false;
  try {
    const ownerGuard = await db.query(`
      select 1
      from pg_trigger
      where tgrelid = 'public.memberships'::regclass
        and tgname = 'trg_hugo_membership_owner_guard'
        and not tgenabled = 'D'
    `);
    if (ownerGuard.rowCount) {
      await db.query("alter table public.memberships disable trigger trg_hugo_membership_owner_guard");
      ownerGuardDisabled = true;
    }
    if (messageIds.length) {
      await db.query(`delete from public.messages where id=any($1::uuid[]) and org_id=$2 and metadata->'inbox_ro_fixture'->>'run_id'=$3`, [messageIds, orgId, receipt.run_id]);
    }
    const tables = await discoverTables(db);
    for (let pass = 0; pass < 5; pass += 1) {
      for (const table of tables) {
        if (table.key === "public.organizations" || table.key === "auth.users" || table.key === "public.messages" || table.key === "public.memberships") continue;
        const predicate = ownedPredicate(table);
        if (!predicate) continue;
        await db.query("savepoint delete_owned_row");
        try {
          await db.query(`delete from ${quoteTable(table.schema, table.name)} t where ${predicate}`, [[orgId], [userId]]);
          await db.query("release savepoint delete_owned_row");
        } catch (error) {
          await db.query("rollback to savepoint delete_owned_row");
          if (error?.code !== "23503") throw error;
        }
      }
    }
    await db.query("delete from public.memberships where org_id=$1 and user_id=$2", [orgId, userId]);
    if (ownerGuardDisabled) await db.query("alter table public.memberships enable trigger trg_hugo_membership_owner_guard");
    await db.query("commit");
  } catch (error) {
    if (ownerGuardDisabled) await db.query("alter table public.memberships enable trigger trg_hugo_membership_owner_guard").catch(() => {});
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

async function deleteOwnedRows(db, receipt, authAdmin) {
  await deleteOwnedTenantRows(db, receipt, Object.values(receipt.ids.messages));
  const orgId = receipt.ids.organization;
  const userId = receipt.ids.user;
  const authRow = await db.query("select 1 from auth.users where id=$1 and email=$2", [userId, receipt.marker.email]);
  if (authRow.rowCount) await deleteAuthUser(authAdmin, receipt);
  await db.query("begin");
  try {
    await db.query("delete from public.organizations where id=$1 and name=$2", [orgId, receipt.marker.org_name]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

export async function deleteOwnedRowsForTest(db, receipt, { skipMessageId }) {
  const messageIds = Object.values(receipt.ids.messages).filter(id => id !== skipMessageId);
  return deleteOwnedTenantRows(db, receipt, messageIds);
}

export async function residueCheck(db, receipt, { preDeleteSnapshot, preDeleteOwnedKeys } = {}) {
  const current = await snapshotDatabase(db);
  assert(preDeleteSnapshot?.tables, "RESIDUE_PRE_SNAPSHOT_REQUIRED", "cleanup requires a pre-delete database snapshot");
  assert(preDeleteOwnedKeys, "RESIDUE_PRE_KEYS_REQUIRED", "cleanup requires pre-delete owned row keys");
  const allowedOwnedKeys = new Set(preDeleteOwnedKeys);
  const cleanupDelta = compareSnapshotDelta(preDeleteSnapshot, current, {
    allowedOwnedKeys,
    allowedOwnedKinds: new Set(["removed"]),
    allowManagedAppendOnly: true,
    failUnownedChanges: false,
  });
  const missingOwnedRemovalFailures = [...allowedOwnedKeys]
    .filter(identity => snapshotContainsRow(current, identity))
    .map(identity => `owned row remains: ${identity}`);
  const failures = [...cleanupDelta.failures, ...missingOwnedRemovalFailures];
  const counts = await ownedCounts(db, receipt.ids.organization, receipt.ids.user);
  for (const [table, count] of Object.entries(counts)) if (count > 0) failures.push(`owned rows remain: ${table}:${count}`);
  return {
    pass: failures.length === 0,
    failures,
    snapshot: current,
    cleanup_delta: cleanupDelta,
    managed_append_only_tables_changed: cleanupDelta.managed_append_only_tables_changed,
  };
}

async function runCreate(args, env) {
  assertSafeTarget(env);
  assertSourceGuards();
  await usingDb(async db => schemaPreflight(db));
  const receiptFile = receiptPathFor(args.runId, env, args.receipt);
  if (existsSync(receiptFile)) {
    const prior = readReceipt(receiptFile);
    assert(prior.run_id === args.runId, "RECEIPT_RUN_ID_MISMATCH");
    const db = await openDb(env);
    try {
      const result = await verifyFixture(db, prior, { checkLock: true });
      if (!result.pass) fail("FIXTURE_INTEGRITY_FAILED", result.failures.join("; "));
      console.log(JSON.stringify({ mode: "create", idempotent: true, run_id: prior.run_id, receipt: receiptFile, ids: prior.ids, lease_expires_at: prior.lease_expires_at }));
      return;
    } finally { await db.end(); }
  }
  const leaseSeconds = args.leaseSeconds ?? 6 * 60 * 60;
  if (env[TEST_MODE_ENV] !== "1") assert(args.leaseSeconds === null, "LEASE_OVERRIDE_REFUSED", "short leases are available only to local tests");
  const startedAt = new Date();
  const leaseExpiresAt = new Date(startedAt.getTime() + leaseSeconds * 1000).toISOString();
  assert(Date.parse(leaseExpiresAt) - startedAt.getTime() <= MAX_LEASE_MS, "INVALID_LEASE");
  const ids = fixtureIds(args.runId);
  const binding = currentScriptBinding();
  const holder = await startLockHolder({ env, runId: args.runId, leaseExpiresAt });
  let db;
  let authAdmin;
  let receipt;
  let inserted = false;
  try {
    db = await openDb(env);
    authAdmin = openAuthAdmin(env);
    await schemaPreflight(db);
    const baseline = await snapshotDatabase(db);
    const diagnostics = await relationDiagnostics(db);
    receipt = buildFixtureRecord({ runId: args.runId, owner: args.owner, leaseExpiresAt, ids, baseline, diagnostics, binding, receiptFile });
    receipt.lock = { holder_pid: holder.pid, pid: holder.pid, backend_pid: holder.backend_pid, acquired_at: holder.acquired_at };
    writeReceipt(receiptFile, receipt);
    await insertFixture(db, receipt, authAdmin);
    inserted = true;
    receipt.post_insert = await snapshotDatabase(db);
    const ownedKeys = await snapshotOwnedRowKeys(db, receipt.ids);
    receipt.owned_row_keys = [...ownedKeys].sort();
    const createDelta = compareSnapshotDelta(receipt.baseline, receipt.post_insert, {
      allowedOwnedKeys: ownedKeys,
      allowManagedAppendOnly: true,
    });
    if (createDelta.failures.length) fail("CREATE_RESIDUE_PROOF_FAILED", createDelta.failures.join("; "));
    receipt.create_delta = {
      changes: createDelta.changes,
      managed_append_only_tables_changed: createDelta.managed_append_only_tables_changed,
    };
    receipt.diagnostics = await settledRelationDiagnostics(
      db,
      Number(diagnostics.memberships_n_tup_ins) + 1,
    ).then(current => ({ ...receipt.diagnostics, ...current }));
    const verified = await verifyFixture(db, receipt, { checkLock: true });
    if (!verified.pass) fail("FIXTURE_INTEGRITY_FAILED", verified.failures.join("; "));
    receipt.state = "active";
    receipt.updated_at = new Date().toISOString();
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify({ mode: "create", idempotent: false, run_id: args.runId, receipt: receiptFile, ids: receipt.ids, lease_expires_at: receipt.lease_expires_at, lock: receipt.lock }));
  } catch (error) {
    if (db) await db.end().catch(() => {});
    if (inserted && receipt && authAdmin) {
      const cleanupDb = await openDb(env).catch(() => null);
      if (cleanupDb) {
        try { await deleteOwnedRows(cleanupDb, receipt, authAdmin); } catch {}
        await cleanupDb.end().catch(() => {});
      }
    }
    try { stopOwnedHolder(holder, args.runId); } catch {}
    throw error;
  }
  await db.end();
}

async function runStatus(args, env) {
  assertSafeTarget(env);
  const file = receiptPathFor(args.runId, env, args.receipt);
  const receipt = readReceipt(file);
  assert(receipt.run_id === args.runId, "RECEIPT_RUN_ID_MISMATCH");
  const db = await openDb(env);
  try {
    const result = await verifyFixture(db, receipt, { checkLock: receipt.state === "active" });
    if (!result.pass) fail("FIXTURE_INTEGRITY_FAILED", result.failures.join("; "));
    console.log(JSON.stringify({ mode: "status", pass: true, run_id: receipt.run_id, ids: receipt.ids, state: receipt.state, lease_expires_at: receipt.lease_expires_at }));
  } finally { await db.end(); }
}

async function runRemove(args, env) {
  assertSafeTarget(env);
  const file = receiptPathFor(args.runId, env, args.receipt);
  const receipt = readReceipt(file);
  assert(receipt.run_id === args.runId, "RECEIPT_RUN_ID_MISMATCH");
  const db = await openDb(env);
  const authAdmin = openAuthAdmin(env);
  let preVerify;
  let preDeleteSnapshot;
  let preDeleteOwnedKeys;
  try {
    preVerify = await verifyFixture(db, receipt, { checkLock: false });
    preDeleteSnapshot = await snapshotDatabase(db, { ids: receipt.ids });
    preDeleteOwnedKeys = new Set(preDeleteSnapshot.owned_row_keys);
    await deleteOwnedRows(db, receipt, authAdmin);
    const residue = await residueCheck(db, receipt, { preDeleteSnapshot, preDeleteOwnedKeys });
    if (!residue.pass) {
      receipt.state = "cleanup_failed";
      receipt.updated_at = new Date().toISOString();
      receipt.cleanup = {
        pre_verify_failures: preVerify.failures,
        residue_failures: residue.failures,
        cleanup_delta: residue.cleanup_delta,
        managed_append_only_tables_changed: residue.managed_append_only_tables_changed,
      };
      writeReceipt(file, receipt);
      try { stopOwnedHolder(receipt.lock, receipt.run_id); } catch {}
      fail("RESIDUE_REMAINED", residue.failures.join("; "));
    }
    const holder = receipt.lock;
    if (holder?.pid) stopOwnedHolder(holder, receipt.run_id);
    receipt.state = "removed";
    receipt.removed_at = new Date().toISOString();
    receipt.updated_at = receipt.removed_at;
    receipt.cleanup = {
      pre_verify_failures: preVerify.failures,
      residue: "zero",
      cleanup_delta: residue.cleanup_delta,
      managed_append_only_tables_changed: residue.managed_append_only_tables_changed,
    };
    writeReceipt(file, receipt);
    console.log(JSON.stringify({ mode: "remove", pass: true, run_id: receipt.run_id, receipt: file, residue: "zero", pre_verify_failures: preVerify.failures, managed_append_only_tables_changed: residue.managed_append_only_tables_changed }));
  } finally { await db.end(); }
}

async function usingDb(fn) {
  const db = await openDb(process.env);
  try { return await fn(db); } finally { await db.end(); }
}

async function run(args = parseArgs(process.argv.slice(2)), env = process.env) {
  if (args.mode === "hold-lock") return holdLock({ env, runId: args.runId, leaseExpiresAt: args.leaseExpiresAt, readyFile: args.readyFile });
  if (args.mode === "create") return runCreate(args, env);
  if (args.mode === "status") return runStatus(args, env);
  if (args.mode === "remove") return runRemove(args, env);
  fail("MODE_REQUIRED");
}

export { FixtureError, compareSnapshots, deleteOwnedRows, expectedMetadata, parseArgs, run, verifyFixture };

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch(error => {
    const code = error?.code ?? "FIXTURE_FAILED";
    console.error(`INBOX_RO_FIXTURE_ERROR ${code}: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
