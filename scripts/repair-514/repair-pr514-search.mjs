#!/usr/bin/env node
// One-time PR-514 repair. It reads immutable SQL from the reviewed Git object;
// the workflow provides the standard scoped-E2E verification callback.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const COMMIT = "8c7053e7024433f46791eac1b186c1b7a7cf10ec";
const REF = "bnkipfoqggwyttbykjfn";
const API = `https://${REF}.supabase.co`;
const LOCK = "sandra-e2e-suite";
const ARM = "APPLY_PR514_BNKIP_SEARCH_PACKET";
const HISTORY = { count: 198, min: "001", max: "20260908081620" };
const MIGRATIONS = [
  ["20260909000000", "global_search", "supabase/migrations/20260909000000_global_search.sql", "6660abc18dd316d276a24cfc039cebe263500bb3b0dc3bde4f3e0088ed3a39a3"],
  ["20260909080600", "search_relevance_fixes", "supabase/migrations/20260909080600_search_relevance_fixes.sql", "7aa4a7b3c6d6b94a83c54d06014b01cbbe23889bcb9d5fbe75bc1539168f7542"],
  ["20260909084500", "search_global_definer_scoping", "supabase/migrations/20260909084500_search_global_definer_scoping.sql", "2286f4c114131550bc7ab647df29f023c0ee93a467beccd29c2c3cd25010e2cb"],
].map(([version, name, path, sha256]) => Object.freeze({ version, name, path, sha256 }));

export class RepairError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new RepairError(code); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function required(env, name) { if (!env[name]) fail("R514_ENV_MISSING"); return env[name]; }

export function parseConfiguration(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true") fail("R514_GITHUB_RUNNER_REQUIRED");
  const databaseUrl = required(env, "REPAIR_514_DB_URL");
  const apiUrl = required(env, "REPAIR_514_API_URL");
  const anonKey = required(env, "REPAIR_514_ANON_KEY");
  let db; let api;
  try { db = new URL(databaseUrl); api = new URL(apiUrl); } catch { fail("R514_URL_INVALID"); }
  // URL TLS parameters could override the explicit trusted TLS configuration.
  if (!/^postgres(?:ql)?:$/u.test(db.protocol) || db.searchParams.size !== 0) fail("R514_DB_URL_UNSAFE");
  if (db.port !== "6543" || !/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(db.hostname)) fail("R514_POOLER_REQUIRED");
  if (decodeURIComponent(db.username) !== `postgres.${REF}`) fail("R514_DB_TARGET_MISMATCH");
  if (api.origin !== API || api.pathname !== "/" || api.search || api.hash || api.username || api.password) fail("R514_API_TARGET_MISMATCH");
  return { databaseUrl, apiUrl: API, anonKey };
}

function gitShow(path) {
  try { return execFileSync("git", ["show", `${COMMIT}:${path}`], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { fail("R514_REVIEWED_SOURCE_UNAVAILABLE"); }
}

export function readReviewedMigration(entry, show = gitShow) {
  const sql = show(entry.path);
  if (typeof sql !== "string" || sql.length === 0) fail("R514_SOURCE_EMPTY");
  if (hash(sql) !== entry.sha256) fail("R514_SOURCE_HASH_MISMATCH");
  // `pg` executes the exact source as one simple-protocol query. The ledger
  // receives that same exact immutable source as its sole statement value.
  return { ...entry, sql, statements: [sql], statementsSha256: hash(JSON.stringify([sql])) };
}

export const loadReviewedMigrations = (show = gitShow) => MIGRATIONS.map((entry) => readReviewedMigration(entry, show));

function nativeClient(config, purpose) {
  return new Client({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15_000, query_timeout: purpose === "lease" ? 20_000 : 150_000 });
}
async function connect(client) { try { await client.connect(); } catch { fail("R514_DB_CONNECT_OR_TLS_FAILED"); } }

function leaseHolder(config, factory) {
  let client; let timer; let lost = false;
  const assertHealthy = () => { if (lost) fail("R514_LEASE_LOST"); };
  return {
    async acquire() {
      client = factory(config, "lease"); await connect(client);
      try {
        await client.query("begin");
        await client.query("set local statement_timeout=0");
        await client.query("set local idle_in_transaction_session_timeout='15min'");
        const lock = await client.query("select pg_try_advisory_xact_lock(hashtext($1)) as acquired", [LOCK]);
        if (lock.rows[0]?.acquired !== true) fail("R514_LEASE_BUSY");
      } catch (error) {
        await client.query("rollback").catch(() => {}); await client.end().catch(() => {});
        if (error instanceof RepairError) throw error;
        fail("R514_LEASE_ACQUIRE_FAILED");
      }
      client.on("error", () => { lost = true; });
      timer = setInterval(() => client.query("select 1").catch(() => { lost = true; }), 30_000);
      timer.unref(); assertHealthy();
    },
    assertHealthy,
    async release() { if (client) { clearInterval(timer); client.removeAllListeners("error"); await client.query("commit").catch(() => {}); await client.end().catch(() => {}); client = undefined; } },
  };
}

const COLUMNS = {
  properties: ["id", "org_id", "address", "city", "state", "zip", "market", "apn", "mls_number", "deleted_at", "updated_at", "homeowner_contact_id", "agent_contact_id"],
  contacts: ["id", "org_id", "first_name", "last_name", "entity_name", "email", "phone_1", "phone_2", "phone_3", "created_at"],
  messages: ["id", "org_id", "contact_id", "property_id", "conversation_id", "channel", "direction", "body", "from_address", "to_address", "created_at"],
  memberships: ["org_id", "user_id", "access_status", "deletion_prepared_at", "access_expires_at"],
};

async function inspectPreflight(client, migrations) {
  try {
    const [identity, history, targets, objects, columns] = await Promise.all([
      client.query("select current_database() as database,current_user as current_user"),
      client.query("select version::text as version,name,statements from supabase_migrations.schema_migrations order by version"),
      client.query("select version::text as version from supabase_migrations.schema_migrations where version=any($1::text[])", [migrations.map((m) => m.version)]),
      client.query(`select to_regnamespace('extensions') is not null as extensions_schema,to_regprocedure('auth.uid()') is not null as auth_uid,
        not exists(select 1 from pg_extension where extname='pg_trgm') as trgm_absent,
        to_regprocedure('public.search_global(text,integer)') is null as global_absent,to_regprocedure('public.search_prefix_tsquery(text)') is null as prefix_absent,
        (select count(*)=0 from pg_attribute where attrelid in ('public.properties'::regclass,'public.contacts'::regclass,'public.messages'::regclass) and attname=any(array['search_text','phone_digits','fts']) and attnum>0 and not attisdropped) as generated_absent,
        (select count(*)=0 from pg_class where relnamespace='public'::regnamespace and relname=any(array['properties_search_text_gin','contacts_search_text_gin','contacts_phone_digits_gin','messages_fts_gin'])) as indexes_absent,
        not has_schema_privilege('anon','public','create') as anon_create_denied,not has_schema_privilege('authenticated','public','create') as auth_create_denied`),
      client.query("select table_name,column_name from information_schema.columns where table_schema='public' and table_name=any($1::text[])", [Object.keys(COLUMNS)]),
    ]);
    return { identity: identity.rows[0], history: history.rows, targets: targets.rows, objects: objects.rows[0], columns: columns.rows };
  } catch { fail("R514_PREFLIGHT_QUERY_FAILED"); }
}

function assertPreflight(value) {
  if (value.identity?.database !== "postgres" || value.identity?.current_user !== "postgres") fail("R514_EXECUTOR_IDENTITY_MISMATCH");
  const versions = value.history.map((row) => row.version);
  if (versions.length !== HISTORY.count || versions[0] !== HISTORY.min || versions.at(-1) !== HISTORY.max) fail("R514_HISTORY_BASELINE_MISMATCH");
  if (value.targets.length !== 0) fail("R514_TARGET_HISTORY_NOT_ABSENT");
  const object = value.objects;
  if (!object?.extensions_schema || !object.auth_uid || !object.trgm_absent || !object.global_absent || !object.prefix_absent || !object.generated_absent || !object.indexes_absent || !object.anon_create_denied || !object.auth_create_denied) fail("R514_OBJECT_PREFLIGHT_MISMATCH");
  const found = new Map();
  for (const row of value.columns) { if (!found.has(row.table_name)) found.set(row.table_name, new Set()); found.get(row.table_name).add(row.column_name); }
  for (const [table, required] of Object.entries(COLUMNS)) if (!required.every((column) => found.get(table)?.has(column))) fail("R514_CAUSAL_PREREQUISITE_MISSING");
}

export async function withTransaction(client, fn) {
  let commitAttempted = false;
  try {
    await client.query("begin"); await client.query("set local lock_timeout='5s'"); await client.query("set local statement_timeout='120s'"); await client.query("set local idle_in_transaction_session_timeout='5min'");
    const result = await fn(); commitAttempted = true; await client.query("commit"); return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    // A broken connection while COMMIT is in flight leaves the server outcome
    // unknowable. Do not describe this as a rolled-back pre-commit failure.
    if (commitAttempted) fail("R514_COMMIT_OUTCOME_UNKNOWN_STATE_PRESERVED");
    throw error;
  }
}

export async function applyAtomically(client, migrations, lease) {
  try {
    return await withTransaction(client, async () => {
      const before = await inspectPreflight(client, migrations); lease.assertHealthy(); assertPreflight(before);
      for (const migration of migrations) {
        await client.query(migration.sql); lease.assertHealthy();
        await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,$3::text[])", [migration.version, migration.name, migration.statements]);
      }
      lease.assertHealthy(); return before;
    });
  } catch (error) { if (error instanceof RepairError) throw error; fail("R514_ATOMIC_APPLY_FAILED"); }
}

function finalBody(migrations) {
  const sql = migrations.at(-1).sql; const start = sql.indexOf("as $$", sql.indexOf("create or replace function public.search_global")); const end = sql.indexOf("$$;", start);
  if (start < 0 || end < 0) fail("R514_REVIEWED_SOURCE_INVALID"); return sql.slice(start + 5, end);
}

async function verifyCatalog(client, before, migrations) {
  try {
    const [history, proc, generated, indexes, extension] = await Promise.all([
      client.query("select version::text as version,name,statements from supabase_migrations.schema_migrations order by version"),
      client.query(`select p.prosecdef,p.prosrc,p.proconfig,pg_get_userbyid(p.proowner) as owner,has_function_privilege('anon',p.oid,'execute') as anon_execute,has_function_privilege('authenticated',p.oid,'execute') as auth_execute,has_function_privilege('service_role',p.oid,'execute') as service_execute,has_schema_privilege('anon','public','create') as anon_create,has_schema_privilege('authenticated','public','create') as auth_create from pg_proc p where p.oid='public.search_global(text,integer)'::regprocedure`),
      client.query("select attrelid::regclass::text as table_name,attname,attgenerated from pg_attribute where attrelid=any(array['public.properties'::regclass,'public.contacts'::regclass,'public.messages'::regclass]) and attname=any(array['search_text','phone_digits','fts']) and attnum>0 and not attisdropped order by table_name,attname"),
      client.query("select relname from pg_class where relnamespace='public'::regnamespace and relname=any(array['properties_search_text_gin','contacts_search_text_gin','contacts_phone_digits_gin','messages_fts_gin']) order by relname"),
      client.query("select extnamespace::regnamespace::text as schema_name from pg_extension where extname='pg_trgm'"),
    ]);
    const expected = [...before, ...migrations.map((m) => ({ version: m.version, name: m.name, statements: m.statements }))].sort((a, b) => a.version.localeCompare(b.version));
    if (!same(history.rows, expected)) fail("R514_UNRELATED_HISTORY_CHANGE");
    const p = proc.rows[0];
    if (!p || !p.prosecdef || p.owner !== "postgres" || p.prosrc !== finalBody(migrations) || !p.proconfig?.includes("search_path=public, pg_temp") || p.anon_execute || !p.auth_execute || !p.service_execute || p.anon_create || p.auth_create) fail("R514_FINAL_FUNCTION_SECURITY_MISMATCH");
    const generatedActual = generated.rows.map((row) => `${row.table_name.replace("public.", "")}:${row.attname}`);
    if (!same(generatedActual, ["contacts:phone_digits", "contacts:search_text", "messages:fts", "properties:search_text"]) || !generated.rows.every((row) => row.attgenerated === "s")) fail("R514_GENERATED_CATALOG_MISMATCH");
    if (!same(indexes.rows.map((row) => row.relname), ["contacts_phone_digits_gin", "contacts_search_text_gin", "messages_fts_gin", "properties_search_text_gin"]) || extension.rows[0]?.schema_name !== "extensions") fail("R514_SEARCH_CATALOG_MISMATCH");
  } catch (error) { if (error instanceof RepairError) throw error; fail("R514_POSTCOMMIT_CATALOG_FAILED"); }
}

// Callback must use the existing job-scoped fixture lifecycle to prove scoped
// positive RPC, authenticated no-membership zero rows, anon denial, cleanup.
export async function runRepair({ verifyAuthenticated, env = process.env, clientFactory = nativeClient, sourceLoader = loadReviewedMigrations } = {}) {
  if (env.REPAIR_514_EXECUTE !== ARM) fail("R514_EXECUTION_NOT_ARMED");
  if (typeof verifyAuthenticated !== "function") fail("R514_VERIFY_ADAPTER_REQUIRED");
  const config = parseConfiguration(env); const migrations = sourceLoader(); const lease = leaseHolder(config, clientFactory); let executor; let committed = false;
  try {
    await lease.acquire(); executor = clientFactory(config, "executor"); await connect(executor);
    const preflightOnly = env.REPAIR_514_MODE === "preflight";
    if (preflightOnly) { const value = await withTransaction(executor, async () => { const inspected = await inspectPreflight(executor, migrations); assertPreflight(inspected); return inspected; }); return { status: "preflight-passed", sourceCommit: COMMIT }; }
    const before = await applyAtomically(executor, migrations, lease); committed = true; lease.assertHealthy();
    await verifyCatalog(executor, before.history, migrations); lease.assertHealthy();
    await verifyAuthenticated({ apiUrl: config.apiUrl, anonKey: config.anonKey, assertLeaseHealthy: lease.assertHealthy }); lease.assertHealthy();
    return { status: "applied-and-verified", sourceCommit: COMMIT, versions: migrations.map((m) => m.version) };
  } catch (error) {
    if (committed) throw new RepairError("R514_POSTCOMMIT_VERIFICATION_FAILED_STATE_PRESERVED");
    if (error instanceof RepairError) throw error; throw new RepairError("R514_UNEXPECTED_PRECOMMIT_FAILURE");
  } finally { await executor?.end().catch(() => {}); await lease.release(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stderr.write("R514_VERIFY_ADAPTER_REQUIRED\n"); process.exitCode = 1;
}
