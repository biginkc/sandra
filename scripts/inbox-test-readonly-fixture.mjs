#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parse } from "pg-connection-string";
import pg from "pg";

const { Client } = pg;

export const TEST_REF = "ncsngxlcyxylaeskiteu";
export const PROD_REF = "copflsklaefwzipsrjqz";
export const BBB_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
export const LOCK_KEY = "sandra-integration-suite";
export const ACK_ENV = "INBOX_RO_FIXTURE_ACK";
export const DB_ENV = "TEST_SUPABASE_DB_URL";
export const SUPABASE_URL_ENV = "TEST_SUPABASE_URL";
export const SERVICE_ROLE_KEY_ENV = "TEST_SUPABASE_SERVICE_ROLE_KEY";
export const TEST_MODE_ENV = "INBOX_RO_FIXTURE_TEST_MODE";
export const PURPOSE = "J5a shared-readonly PRE->POST queued-set baseline on TEST";
export const MAX_LEASE_MS = 6 * 60 * 60 * 1000;
export const FIXTURE_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const FIXTURE_ORG_NAME = "Inbox RO fixture (permanent, inert)";
export const FIXTURE_EMAILS = Object.freeze([
  "inbox-ro-fixture@fixtures.invalid",
  "inbox-ro-fixture@fixtures.test",
]);

function uuidV5(namespace, name) {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(Buffer.concat([namespaceBytes, Buffer.from(name)])).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const FIXTURE_IDS = Object.freeze({
  organization: uuidV5(FIXTURE_NAMESPACE, "org"),
  user: uuidV5(FIXTURE_NAMESPACE, "user"),
  membership: uuidV5(FIXTURE_NAMESPACE, "membership"),
  messages: Object.freeze({
    scheduled: uuidV5(FIXTURE_NAMESPACE, "m1"),
    unscheduled: uuidV5(FIXTURE_NAMESPACE, "m2"),
  }),
});

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
const EXPECTED_METADATA = Object.freeze({
  inbox_ro_fixture: Object.freeze({ permanent: true, purpose: PURPOSE }),
});
const MESSAGE_SHAPES = Object.freeze({
  [FIXTURE_IDS.messages.scheduled]: Object.freeze({ body: "Inbox RO fixture m1 (permanent, inert)", scheduled: "2099-12-31T00:00:00.000Z" }),
  [FIXTURE_IDS.messages.unscheduled]: Object.freeze({ body: "Inbox RO fixture m2 (permanent, inert)", scheduled: null }),
});

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
  const result = { mode: null, runId: null, owner: null, receipt: null, leaseSeconds: null, readyFile: null, leaseExpiresAt: null };
  const modes = new Map([
    ["--create", "create"],
    ["--verify", "verify"],
    ["--remove", "removed"],
    ["--cleanup", "removed"],
    ["--hold-lock", "hold-lock"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (modes.has(arg)) {
      assert(result.mode === null, "MULTIPLE_MODES");
      result.mode = modes.get(arg);
      continue;
    }
    if (["--run-id", "--owner", "--receipt", "--lease-seconds", "--ready-file", "--lease-expires-at"].includes(arg)) {
      const value = argv[++index];
      assert(value !== undefined && value !== "", "MISSING_OPTION_VALUE", `missing value for ${arg}`);
      const key = {
        "--run-id": "runId",
        "--owner": "owner",
        "--receipt": "receipt",
        "--lease-seconds": "leaseSeconds",
        "--ready-file": "readyFile",
        "--lease-expires-at": "leaseExpiresAt",
      }[arg];
      result[key] = value;
      continue;
    }
    if (arg.startsWith("--db-url=") || arg.startsWith("--database-url=") || arg.startsWith("--url=")) {
      fail("DB_URL_ARG_REFUSED", "the database URL is accepted only from TEST_SUPABASE_DB_URL");
    }
    if (["--db-url", "--database-url", "--url"].includes(arg)) {
      fail("DB_URL_ARG_REFUSED", "the database URL is accepted only from TEST_SUPABASE_DB_URL");
    }
    fail("UNKNOWN_OPTION", `unknown option ${arg}`);
  }
  assert(result.mode !== null, "MODE_REQUIRED", "choose --create, --verify, or --hold-lock");
  if (result.mode === "removed") return result;
  if (result.mode !== "hold-lock") safeRunId(result.runId);
  if (result.mode === "create") {
    assert(result.owner, "OWNER_REQUIRED", "--owner is required for --create");
    assert(/^[^\r\n]{1,160}$/.test(result.owner), "INVALID_OWNER");
  }
  if (result.mode === "hold-lock") {
    safeRunId(result.runId);
    assert(result.readyFile, "READY_FILE_REQUIRED");
    assert(result.leaseExpiresAt && !Number.isNaN(Date.parse(result.leaseExpiresAt)), "INVALID_LEASE_EXPIRY");
  }
  if (result.leaseSeconds !== null) {
    const seconds = Number(result.leaseSeconds);
    assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_LEASE_MS / 1000, "INVALID_LEASE", "lease must be an integer between 1 and 21600 seconds");
    result.leaseSeconds = seconds;
  }
  return result;
}

function rawAuthority(raw) {
  return String(raw).match(/^[a-z]+:\/\/([^/?#]*)/i)?.[1] ?? null;
}

function parseDbTarget(raw) {
  const authority = rawAuthority(raw);
  assert(authority !== null && !authority.includes("%"), "TARGET_REFUSED", "database authority must not contain encoded characters");
  assert(!String(raw).includes("?") && !String(raw).includes("#"), "TARGET_REFUSED", "database URL options are refused");
  let fields;
  try { fields = parse(raw); } catch { fail("DB_URL_INVALID", "database URL is invalid"); }
  const allowed = new Set(["user", "password", "host", "port", "database"]);
  assert(Object.keys(fields).every(key => allowed.has(key)), "TARGET_REFUSED", "database URL options are refused");
  assert(fields.host && !fields.host.includes("/") && !fields.host.startsWith("\\"), "TARGET_REFUSED", "socket paths are refused");
  assert(fields.database === "postgres", "TARGET_REFUSED", "database must be postgres");
  assert(fields.password !== undefined && fields.password !== "", "TARGET_REFUSED", "database password is required");
  return fields;
}

function parseSupabaseApiTarget(raw) {
  assert(!String(raw).includes("%"), "TARGET_REFUSED", "Supabase URL must not contain encoded characters");
  let url;
  try { url = new URL(raw); } catch { fail("SUPABASE_URL_INVALID", "Supabase URL is invalid"); }
  assert(!url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "TARGET_REFUSED", "Supabase URL must have no credentials, path or options");
  return url;
}

export function assertSafeTarget(env = process.env) {
  assert(env[ACK_ENV] === TEST_REF, "ACK_REQUIRED", `${ACK_ENV} must equal the TEST project ref`);
  assert(!Object.prototype.hasOwnProperty.call(env, "MESSAGING_PROVIDER"), "MESSAGING_PROVIDER_REFUSED", "MESSAGING_PROVIDER must be unset");
  assert(!env.CI && !env.GITHUB_ACTIONS, "CI_REFUSED", "CI targets are refused");
  const rawDb = env[DB_ENV];
  assert(rawDb, "DB_URL_REQUIRED", `${DB_ENV} is required and must not be read from a file or argument`);
  assert(!String(rawDb).includes(PROD_REF), "PRODUCTION_REFUSED", "Production project ref is refused");
  const dbFields = parseDbTarget(rawDb);
  const rawApi = env[SUPABASE_URL_ENV];
  assert(rawApi, "SUPABASE_URL_REQUIRED", `${SUPABASE_URL_ENV} is required and must not be read from a file or argument`);
  assert(!String(rawApi).includes(PROD_REF), "PRODUCTION_REFUSED", "Production project ref is refused");
  const apiUrl = parseSupabaseApiTarget(rawApi);
  const localDb = dbFields.host === "127.0.0.1" && Number(dbFields.port) >= 55000 && Number(dbFields.port) <= 59999;
  const localApi = apiUrl.hostname === "127.0.0.1" && Number(apiUrl.port) >= 55000 && Number(apiUrl.port) <= 59999 && apiUrl.protocol === "http:";
  if (localDb || localApi) {
    assert(localDb && localApi, "TARGET_REFUSED", "database and Supabase API must both be loopback targets");
    assert(localDb && localApi && env[TEST_MODE_ENV] === "1" && env.NODE_ENV === "test", "LOCAL_TARGET_REFUSED", "loopback targets are allowed only by this tool's NODE_ENV=test local tests");
    assert(dbFields.user === "postgres", "TARGET_REFUSED", "local database user is not allowed");
    return { kind: "local-test", dbFields, apiUrl };
  }
  assert(/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(dbFields.host), "TARGET_REFUSED", "only the TEST session-pooler host is allowed");
  assert(dbFields.user === `postgres.${TEST_REF}` && Number(dbFields.port) === 5432, "TARGET_REFUSED", "only the TEST session-pooler credentials are allowed");
  assert(apiUrl.protocol === "https:" && apiUrl.hostname === `${TEST_REF}.supabase.co` && (apiUrl.port === "" || apiUrl.port === "443"), "TARGET_REFUSED", "only the TEST Supabase API target is allowed");
  assert(!env[TEST_MODE_ENV], "HOSTED_TEST_MODE_REFUSED", "local-test mode cannot target a hosted TEST target");
  return { kind: "shared-test", dbFields, apiUrl };
}

export function buildDbConfig(env = process.env) {
  const target = assertSafeTarget(env);
  return {
    host: target.dbFields.host,
    port: Number(target.dbFields.port),
    user: target.dbFields.user,
    password: target.dbFields.password,
    database: target.dbFields.database,
    options: undefined,
  };
}

export async function openDb(env = process.env, ClientConstructor = Client) {
  const db = new ClientConstructor(buildDbConfig(env));
  await db.connect();
  return db;
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
  assert(receipt?.redacted === true && receipt.target_ref === TEST_REF, "RECEIPT_INVALID", "receipt is not a fixture receipt for TEST");
  safeRunId(receipt.run_id);
  return { ...receipt, ids: FIXTURE_IDS };
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

export async function q(db, statement, values = []) {
  assert(!String(statement).includes(";"), "SQL_STATEMENT_REFUSED", "SQL statement terminators are not allowed");
  const keyword = String(statement).trim().match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  assert(["select", "insert", "begin", "commit", "rollback", "set"].includes(keyword), "SQL_STATEMENT_REFUSED", "SQL statement keyword is not allowed");
  if (keyword === "insert" && /\bdo\s+update\b/i.test(statement)) {
    fail("SQL_STATEMENT_REFUSED", "insert conflict action is not allowed");
  }
  return db.query(statement, values);
}

function openAuthAdmin(env = process.env) {
  assert(env[SERVICE_ROLE_KEY_ENV], "SERVICE_ROLE_KEY_REQUIRED", `${SERVICE_ROLE_KEY_ENV} is required only from the environment`);
  const admin = createClient(env[SUPABASE_URL_ENV], env[SERVICE_ROLE_KEY_ENV], {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  return Object.freeze({
    createUser: input => admin.createUser(input),
    getUserById: id => admin.getUserById(id),
  });
}

function expectedAuthMetadata() {
  return {
    inbox_ro_fixture: {
      org_id: FIXTURE_IDS.organization,
      membership_id: FIXTURE_IDS.membership,
      message_ids: [FIXTURE_IDS.messages.scheduled, FIXTURE_IDS.messages.unscheduled],
      permanent: true,
    },
  };
}

function isFixtureEmail(email) {
  return FIXTURE_EMAILS.includes(email);
}

async function createFixedAuthUser(authAdmin) {
  const existing = await authAdmin.getUserById(FIXTURE_IDS.user);
  if (existing.data?.user) {
    assert(isFixtureEmail(existing.data.user.email), "FIXTURE_DRIFT", "auth email is not one of the fixed reserved-TLD fixture addresses");
    return existing.data.user;
  }
  assert(existing.error?.status === 404, "AUTH_LOOKUP_FAILED", "Supabase admin getUserById failed");
  const errors = [];
  for (const email of FIXTURE_EMAILS) {
    const result = await authAdmin.createUser({
      id: FIXTURE_IDS.user,
      email,
      email_confirm: false,
      ban_duration: "876000h",
      app_metadata: expectedAuthMetadata(),
    });
    if (!result.error && result.data?.user?.id === FIXTURE_IDS.user) return result.data.user;
    errors.push(`${email}: ${result.error?.message ?? "no user response"}`);
  }
  fail("AUTH_CREATE_FAILED", errors.join("; "));
}

async function schemaPreflight(db) {
  const columns = (await q(db, `
    select table_schema, table_name, column_name
    from information_schema.columns
    where (table_schema, table_name) in (('public','organizations'),('public','memberships'),('public','messages'),('auth','users'),('auth','identities'))
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
    "auth.users": ["id", "email", "email_confirmed_at", "banned_until", "last_sign_in_at", "raw_app_meta_data"],
    "auth.identities": ["user_id", "provider"],
  })) {
    assert(byTable.has(table), "SCHEMA_PRECONDITION_FAILED", `${table} is missing`);
    for (const column of required) assert(byTable.get(table).has(column), "SCHEMA_PRECONDITION_FAILED", `${table}.${column} is missing`);
  }
  const providerCheck = (await q(db, `
    select exists (
      select 1 from pg_constraint
      where conrelid='public.messages'::regclass and pg_get_constraintdef(oid) like '%mock%'
    ) as present
  `)).rows[0].present;
  assert(providerCheck, "SCHEMA_PRECONDITION_FAILED", "messages.provider does not allow mock");
}

function expectedMembership() {
  return {
    user_id: FIXTURE_IDS.user,
    org_id: FIXTURE_IDS.organization,
    role: "owner",
    access_status: "active",
    access_expires_at: null,
    deletion_prepared_at: null,
    metadata: EXPECTED_METADATA,
  };
}

async function relationDiagnostics(db) {
  await q(db, "select pg_stat_clear_snapshot()");
  const { rows } = await q(db, `
    select
      pg_relation_filenode('public.messages'::regclass)::text as messages_filenode,
      coalesce((select n_tup_ins::text from pg_stat_all_tables where relid='public.memberships'::regclass), '0') as memberships_n_tup_ins
  `);
  return rows[0];
}

async function settledRelationDiagnostics(db, minimumMembershipInserts) {
  let latest = await relationDiagnostics(db);
  let stableReads = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (Number(latest.memberships_n_tup_ins) >= minimumMembershipInserts) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const confirmed = await relationDiagnostics(db);
      if (confirmed.memberships_n_tup_ins === latest.memberships_n_tup_ins) stableReads += 1;
      else stableReads = 0;
      if (stableReads >= 1) return confirmed;
      latest = confirmed;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    latest = await relationDiagnostics(db);
  }
  return latest;
}

async function messageReferences(db, messageIds) {
  const refs = [];
  const columns = (await q(db, `
    select table_schema, table_name, column_name
    from information_schema.columns
    where table_schema not in ('pg_catalog','information_schema')
      and column_name ilike '%message_id%'
  `)).rows;
  for (const column of columns) {
    const qualified = quoteTable(column.table_schema, column.table_name);
    const result = await q(db, `select count(*)::int as count from ${qualified} where ${quoteIdent(column.column_name)}::text = any($1::text[])`, [messageIds]);
    if (result.rows[0].count > 0) refs.push(`${column.table_schema}.${column.table_name}.${column.column_name}:${result.rows[0].count}`);
  }
  return refs;
}

export async function verifyFixture(db, {
  checkLock = false,
  expectedDiagnostics = null,
  lock = null,
  leaseExpiresAt = null,
  allowMissing = false,
} = {}) {
  const failures = [];
  const missing = [];
  const org = (await q(db, "select id::text,name from public.organizations where id=$1", [FIXTURE_IDS.organization])).rows[0];
  if (!org) missing.push("organization");
  else {
    if (org.id === BBB_ORG_ID) failures.push("fixture organization is the BMH org");
    if (org.name !== FIXTURE_ORG_NAME) failures.push("organization marker changed");
  }

  const user = (await q(db, "select id::text,email,email_confirmed_at,banned_until,last_sign_in_at,raw_app_meta_data from auth.users where id=$1", [FIXTURE_IDS.user])).rows[0];
  if (!user) missing.push("user");
  else {
    if (!isFixtureEmail(user.email)) failures.push("auth email marker changed");
    if (user.email_confirmed_at !== null) failures.push("auth user is email-confirmed");
    if (user.last_sign_in_at !== null) failures.push("auth user has signed in");
    if (!user.banned_until || Date.parse(user.banned_until) <= Date.parse("2100-01-01T00:00:00.000Z")) failures.push("auth user is not banned past 2100");
    if (canonicalJson(user.raw_app_meta_data?.inbox_ro_fixture) !== canonicalJson(expectedAuthMetadata().inbox_ro_fixture)) failures.push("auth app metadata stamp changed");
    if (user.raw_app_meta_data?.provider !== "email") failures.push("auth provider marker changed");
    if (canonicalJson(user.raw_app_meta_data?.providers) !== canonicalJson(["email"])) failures.push("auth providers marker changed");
  }

  const identities = (await q(db, "select provider from auth.identities where user_id=$1 order by provider", [FIXTURE_IDS.user])).rows;
  if (identities.length > 1) failures.push("auth user has more than one identity");
  if (identities.some(identity => identity.provider !== "email")) failures.push("auth user has a non-email identity");

  const memberships = (await q(db, `
    select id::text,user_id::text,org_id::text,role,access_status,access_expires_at,deletion_prepared_at
    from public.memberships
    where id=$1 or org_id=$2 or user_id=$3
    order by id
  `, [FIXTURE_IDS.membership, FIXTURE_IDS.organization, FIXTURE_IDS.user])).rows;
  if (!memberships.some(membership => membership.id === FIXTURE_IDS.membership)) missing.push("membership");
  if (memberships.length > 1) failures.push("fixture org or user has more than one membership");
  for (const membership of memberships) {
    const wanted = expectedMembership();
    if (membership.id === FIXTURE_IDS.membership && (membership.user_id !== wanted.user_id || membership.org_id !== wanted.org_id)) {
      failures.push("fixed membership id belongs to another user or organization");
      continue;
    }
    if (membership.id !== FIXTURE_IDS.membership || membership.user_id !== wanted.user_id || membership.org_id !== wanted.org_id || membership.role !== wanted.role || membership.access_status !== wanted.access_status || membership.access_expires_at !== wanted.access_expires_at || membership.deletion_prepared_at !== wanted.deletion_prepared_at) {
      failures.push("membership is not exactly one active owner membership");
    }
  }

  const messages = (await q(db, `
    select id::text,org_id::text,channel,direction,status,provider,contact_id::text,property_id::text,campaign_id::text,conversation_id::text,from_address,to_address,body,metadata,scheduled_for as scheduled,external_id
    from public.messages where id=any($1::uuid[]) or org_id=$2 order by id
  `, [[FIXTURE_IDS.messages.scheduled, FIXTURE_IDS.messages.unscheduled], FIXTURE_IDS.organization])).rows;
  for (const id of [FIXTURE_IDS.messages.scheduled, FIXTURE_IDS.messages.unscheduled]) if (!messages.some(message => message.id === id)) missing.push(`message:${id}`);
  if (messages.length > 2) failures.push(`expected only the two fixed fixture messages, found ${messages.length}`);
  for (const row of messages) {
    const wanted = MESSAGE_SHAPES[row.id];
    if (!wanted) {
      failures.push(`unexpected message id ${row.id}`);
      continue;
    }
    if (row.org_id !== FIXTURE_IDS.organization) {
      failures.push(`fixed message ${row.id} belongs to another organization`);
      continue;
    }
    if (row.channel !== "sms" || row.direction !== "outbound" || row.status !== "queued" || row.provider !== "mock") failures.push(`message ${row.id} is not inert queued mock SMS`);
    for (const column of ["contact_id", "property_id", "campaign_id", "conversation_id", "from_address", "to_address", "external_id"]) if (row[column] !== null) failures.push(`message ${row.id}.${column} is not null`);
    if (row.body !== wanted.body || (row.scheduled?.toISOString?.() ?? row.scheduled) !== wanted.scheduled) failures.push(`message ${row.id} body or schedule changed`);
    if (jsonHash(row.metadata) !== jsonHash(EXPECTED_METADATA)) failures.push(`message ${row.id} metadata changed`);
  }
  if (messages.length === 2 && new Set(messages.map(row => row.id)).size === 2) {
    if (!messages.some(row => row.id === FIXTURE_IDS.messages.scheduled) || !messages.some(row => row.id === FIXTURE_IDS.messages.unscheduled)) failures.push("fixed message ids are incomplete");
  }

  const refs = await messageReferences(db, [FIXTURE_IDS.messages.scheduled, FIXTURE_IDS.messages.unscheduled]);
  if (refs.length) failures.push(`provider-attempt or webhook references present: ${refs.join(",")}`);
  if (!allowMissing && missing.length) failures.push(...missing.map(value => `${value} missing`));
  if (expectedDiagnostics) {
    const diagnostics = await relationDiagnostics(db);
    if (expectedDiagnostics.messages_filenode !== diagnostics.messages_filenode) failures.push("messages filenode changed (reset detected)");
  }
  if (checkLock) {
    const held = await lockHeld(db, lock?.backend_pid);
    if (!held) failures.push("integration lock is not held by the recorded holder");
    if (!leaseExpiresAt || Date.parse(leaseExpiresAt) <= Date.now()) failures.push("fixture lease expired");
  }
  return { pass: failures.length === 0, failures, missing };
}

function holderProcessMatchesRun(holder, runId) {
  const command = holderCommand(holder?.pid);
  if (!command || !command.includes(scriptPath)) return false;
  if (!/(?:^|\s)--hold-lock(?:\s|$)/.test(command)) return false;
  const escapedRunId = String(runId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)--run-id\\s+${escapedRunId}(?:\\s|$)`).test(command);
}

async function exclusionFailures(db, { runId, lock, leaseExpiresAt }) {
  const failures = [];
  if (!holderProcessMatchesRun(lock, runId)) failures.push("recorded holder process is not alive for this run_id");
  const leaseExpiryMs = Date.parse(leaseExpiresAt ?? "");
  if (!Number.isFinite(leaseExpiryMs) || leaseExpiryMs <= Date.now()) failures.push("fixture lease expired");
  if (!lock?.backend_pid || !(await lockHeld(db, lock.backend_pid))) failures.push("integration lock is not held by the recorded holder");
  return failures;
}

export async function requireExclusion(db, { runId, lock, leaseExpiresAt }) {
  const failures = await exclusionFailures(db, { runId, lock, leaseExpiresAt });
  if (failures.length) fail("STALE_RECEIPT", `${failures.join("; ")}; start a new run-id`);
}

export async function lockHeld(db, backendPid, lockKey = LOCK_KEY) {
  if (!backendPid) return false;
  return (await q(db, `
    select exists(
      select 1
      from pg_locks
      where pid=$1
        and locktype='advisory'
        and granted
        and classid=(((hashtext($2)::bigint >> 32) & 4294967295)::oid)
        and objid=((hashtext($2)::bigint & 4294967295)::oid)
        and objsubid=1
    ) as held
  `, [backendPid, lockKey])).rows[0].held;
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
  const readyDir = path.join(tmpdir(), `sandra-ro-fixture-lock-${process.pid}-${runId}`);
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

export function stopOwnedHolder(holder, runId) {
  if (!holder?.pid) return false;
  const command = holderCommand(holder.pid);
  if (!command) return false;
  if (!command.includes(scriptPath) || !command.includes("--hold-lock") || !command.includes(`--run-id ${runId}`)) fail("LOCK_OWNER_MISMATCH", "recorded holder is not this tool's holder; refusing to signal it");
  process.kill(holder.pid, "SIGTERM");
  return true;
}

async function holdLock({ env, leaseExpiresAt, readyFile, ClientConstructor }) {
  assertSafeTarget(env);
  const leaseMs = Date.parse(leaseExpiresAt) - Date.now();
  assert(Number.isFinite(leaseMs) && leaseMs > 0 && leaseMs <= MAX_LEASE_MS, "INVALID_LEASE", "lock lease must be in the future and no longer than six hours");
  const db = await openDb(env, ClientConstructor);
  let closed = false;
  let heartbeat;
  let expiry;
  const close = async (code = 0) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    await db.end().catch(() => {});
    process.exitCode = code;
  };
  await q(db, "set statement_timeout=0");
  const lockResult = await q(db, "select pg_try_advisory_lock(hashtext($1)) as acquired", [LOCK_KEY]);
  if (!lockResult.rows[0].acquired) {
    await db.end().catch(() => {});
    fail("LOCK_ALREADY_HELD", "the integration suite lock is already held");
  }
  const backendPid = (await q(db, "select pg_backend_pid()::int as pid")).rows[0].pid;
  const readyTemp = `${readyFile}.tmp-${process.pid}`;
  writeFileSync(readyTemp, `${JSON.stringify({ backend_pid: backendPid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(readyTemp, readyFile);
  heartbeat = setInterval(() => { q(db, "select 1").catch(() => close(1)); }, 30_000);
  heartbeat.unref();
  expiry = setTimeout(() => close(0), Math.max(0, Date.parse(leaseExpiresAt) - Date.now()));
  expiry.unref();
  process.on("SIGTERM", () => { close(0); });
  process.on("SIGINT", () => { close(0); });
  await new Promise(resolve => { process.once("beforeExit", resolve); });
}

async function insertFixture(db, authAdmin, exclusion) {
  await requireExclusion(db, exclusion);
  await createFixedAuthUser(authAdmin);
  await requireExclusion(db, exclusion);
  const messageValues = [
    FIXTURE_IDS.messages.scheduled, FIXTURE_IDS.organization, MESSAGE_SHAPES[FIXTURE_IDS.messages.scheduled].body, JSON.stringify(EXPECTED_METADATA),
    FIXTURE_IDS.messages.unscheduled, MESSAGE_SHAPES[FIXTURE_IDS.messages.unscheduled].body,
  ];
  await q(db, "begin");
  try {
    await requireExclusion(db, exclusion);
    await q(db, "insert into public.organizations(id,name) values ($1,$2) on conflict (id) do nothing", [FIXTURE_IDS.organization, FIXTURE_ORG_NAME]);
    await requireExclusion(db, exclusion);
    await q(db, "insert into public.memberships(id,user_id,org_id,role,access_status,access_expires_at,deletion_prepared_at) values ($1,$2,$3,'owner','active',null,null) on conflict (id) do nothing", [FIXTURE_IDS.membership, FIXTURE_IDS.user, FIXTURE_IDS.organization]);
    await requireExclusion(db, exclusion);
    await q(db, `
      insert into public.messages(id,org_id,channel,direction,status,provider,contact_id,property_id,campaign_id,conversation_id,from_address,to_address,body,metadata,scheduled_for,external_id)
      values ($1,$2,'sms','outbound','queued','mock',null,null,null,null,null,null,$3,$4::jsonb,'2099-12-31T00:00:00Z',null),
             ($5,$2,'sms','outbound','queued','mock',null,null,null,null,null,null,$6,$4::jsonb,null,null)
      on conflict (id) do nothing
    `, messageValues);
    await requireExclusion(db, exclusion);
    await q(db, "commit");
  } catch (error) {
    await q(db, "rollback").catch(() => {});
    throw error;
  }
}

function buildFixtureRecord({ runId, owner, leaseExpiresAt, diagnostics, binding, receiptFile, holder }) {
  return {
    redacted: true,
    version: 2,
    target_ref: TEST_REF,
    run_id: runId,
    owner,
    purpose: PURPOSE,
    ids: FIXTURE_IDS,
    lease_expires_at: leaseExpiresAt,
    script: binding,
    lock: { pid: holder.pid, backend_pid: holder.backend_pid, acquired_at: holder.acquired_at },
    receipt_file: receiptFile,
    diagnostics,
    state: "creating",
  };
}

async function usingDb(fn, env, ClientConstructor) {
  const db = await openDb(env, ClientConstructor);
  try { return await fn(db); } finally { await db.end(); }
}

function drift(result) {
  if (!result.pass) fail("FIXTURE_DRIFT", result.failures.join("; "));
}

async function runCreate(args, env, ClientConstructor) {
  assertSafeTarget(env);
  assertSourceGuards();
  await usingDb(schemaPreflight, env, ClientConstructor);
  const receiptFile = receiptPathFor(args.runId, env, args.receipt);
  const existing = existsSync(receiptFile) ? readReceipt(receiptFile) : null;
  if (existing) {
    assert(existing.run_id === args.runId, "RECEIPT_RUN_ID_MISMATCH");
    const db = await openDb(env, ClientConstructor);
    try {
      await requireExclusion(db, { runId: existing.run_id, lock: existing.lock, leaseExpiresAt: existing.lease_expires_at });
      const pre = await verifyFixture(db, { allowMissing: true });
      drift(pre);
      const currentDiagnostics = await relationDiagnostics(db);
      const missing = pre.missing.length > 0;
      if (!missing && existing.diagnostics && existing.diagnostics.messages_filenode !== currentDiagnostics.messages_filenode) {
        fail("FIXTURE_DRIFT", "fixture diagnostics changed while all fixed rows remained present");
      }
      if (missing) {
        await insertFixture(db, openAuthAdmin(env), { runId: existing.run_id, lock: existing.lock, leaseExpiresAt: existing.lease_expires_at });
        const membershipInsert = pre.missing.includes("membership") ? 1 : 0;
        existing.diagnostics = await settledRelationDiagnostics(db, Number(currentDiagnostics.memberships_n_tup_ins) + membershipInsert);
      }
      const result = await verifyFixture(db, { expectedDiagnostics: existing.diagnostics });
      drift(result);
      await requireExclusion(db, { runId: existing.run_id, lock: existing.lock, leaseExpiresAt: existing.lease_expires_at });
      existing.state = "active";
      writeReceipt(receiptFile, existing);
      console.log(JSON.stringify({ mode: "create", idempotent: true, run_id: existing.run_id, receipt: receiptFile, ids: FIXTURE_IDS, lease_expires_at: existing.lease_expires_at }));
      return;
    } finally { await db.end(); }
  }
  const leaseSeconds = args.leaseSeconds ?? 6 * 60 * 60;
  if (env[TEST_MODE_ENV] !== "1") assert(args.leaseSeconds === null, "LEASE_OVERRIDE_REFUSED", "short leases are available only to local tests");
  const startedAt = new Date();
  const leaseExpiresAt = new Date(startedAt.getTime() + leaseSeconds * 1000).toISOString();
  assert(Date.parse(leaseExpiresAt) - startedAt.getTime() <= MAX_LEASE_MS, "INVALID_LEASE");
  const holder = await startLockHolder({ env, runId: args.runId, leaseExpiresAt });
  let db;
  try {
    db = await openDb(env, ClientConstructor);
    await schemaPreflight(db);
    const exclusion = { runId: args.runId, lock: holder, leaseExpiresAt };
    await requireExclusion(db, exclusion);
    const pre = await verifyFixture(db, { allowMissing: true });
    drift(pre);
    const diagnostics = await relationDiagnostics(db);
    const receipt = buildFixtureRecord({ runId: args.runId, owner: args.owner, leaseExpiresAt, diagnostics, binding: currentScriptBinding(), receiptFile, holder });
    writeReceipt(receiptFile, receipt);
    await insertFixture(db, openAuthAdmin(env), exclusion);
    receipt.diagnostics = await settledRelationDiagnostics(db, Number(diagnostics.memberships_n_tup_ins) + 1);
    const result = await verifyFixture(db, { expectedDiagnostics: receipt.diagnostics });
    drift(result);
    await requireExclusion(db, exclusion);
    receipt.state = "active";
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify({ mode: "create", idempotent: false, run_id: args.runId, receipt: receiptFile, ids: FIXTURE_IDS, lease_expires_at: leaseExpiresAt, lock: receipt.lock }));
  } catch (error) {
    if (db) await db.end().catch(() => {});
    try { stopOwnedHolder(holder, args.runId); } catch {}
    throw error;
  }
  await db.end();
}

async function runVerify(args, env, ClientConstructor) {
  assertSafeTarget(env);
  assertSourceGuards();
  const file = receiptPathFor(args.runId, env, args.receipt);
  const receipt = readReceipt(file);
  assert(receipt.run_id === args.runId, "RECEIPT_RUN_ID_MISMATCH");
  const db = await openDb(env, ClientConstructor);
  try {
    await schemaPreflight(db);
    const exclusion = { runId: receipt.run_id, lock: receipt.lock, leaseExpiresAt: receipt.lease_expires_at };
    await requireExclusion(db, exclusion);
    const result = await verifyFixture(db, { expectedDiagnostics: receipt.diagnostics });
    drift(result);
    await requireExclusion(db, exclusion);
    console.log(JSON.stringify({ mode: "verify", pass: true, run_id: receipt.run_id, ids: FIXTURE_IDS, lease_expires_at: receipt.lease_expires_at }));
  } finally { await db.end(); }
}

export async function run(args = parseArgs(process.argv.slice(2)), env = process.env, { ClientConstructor = Client } = {}) {
  if (args.mode === "removed") fail("MODE_REMOVED", "--remove and --cleanup are permanently removed");
  if (args.mode === "hold-lock") return holdLock({ env, runId: args.runId, leaseExpiresAt: args.leaseExpiresAt, readyFile: args.readyFile, ClientConstructor });
  if (args.mode === "create") return runCreate(args, env, ClientConstructor);
  if (args.mode === "verify") return runVerify(args, env, ClientConstructor);
  fail("MODE_REQUIRED");
}

export { FixtureError, parseArgs };

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch(error => {
    const code = error?.code ?? "FIXTURE_FAILED";
    console.error(`INBOX_RO_FIXTURE_ERROR ${code}: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
