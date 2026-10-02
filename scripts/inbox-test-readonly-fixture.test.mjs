import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import {
  ACK_ENV,
  DB_ENV,
  PROD_REF,
  TEST_MODE_ENV,
  TEST_REF,
  assertSafeTarget,
  deleteOwnedRows,
  residueCheck,
} from "./inbox-test-readonly-fixture.mjs";

const { Client } = pg;
const script = path.resolve("scripts/inbox-test-readonly-fixture.mjs");
let workdir;
let socketDir;
let port;
let dbUrl;
let baseEnv;
let db;

async function freePort() {
  const net = await import("node:net");
  for (let candidate = 55000 + Math.floor(Math.random() * 5000); candidate < 60000; candidate += 1) {
    const available = await new Promise(resolve => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error("no disposable PG17 port available in 55000-59999");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

async function waitForDb() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = new Client({ connectionString: dbUrl });
      await probe.connect();
      await probe.end();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error("local PG17 did not start");
}

function childEnv(overrides = {}) {
  const env = { ...baseEnv, ...overrides };
  delete env.MESSAGING_PROVIDER;
  return env;
}

function cli(args, overrides = {}) {
  try {
    const stdout = run(process.execPath, [script, ...args], { env: childEnv(overrides) });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function jsonOutput(result) {
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  return JSON.parse(line);
}

async function ownedRows(orgId, userId) {
  return (await db.query(`
    select
      (select count(*) from public.organizations where id=$1) as orgs,
      (select count(*) from auth.users where id=$2) as users,
      (select count(*) from public.memberships where org_id=$1 or user_id=$2) as memberships,
      (select count(*) from public.messages where org_id=$1) as messages
  `, [orgId, userId])).rows[0];
}

async function create(runId, leaseSeconds = 30) {
  const result = cli(["--create", "--run-id", runId, "--owner", "fixture-test", "--lease-seconds", String(leaseSeconds)]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return jsonOutput(result);
}

function receipt(runId) {
  return JSON.parse(readFileSync(path.join(workdir, `lease-test-ro-fixture-${runId}.json`), "utf8"));
}

before(async () => {
  workdir = mkdtempSync(path.join(tmpdir(), "sandra-inbox-ro-fixture-test-"));
  socketDir = mkdtempSync(path.join(tmpdir(), "sro-socket-"));
  port = await freePort();
  const dataDir = path.join(workdir, "data");
  run("initdb", ["-D", dataDir, "-A", "trust", "-U", "postgres", "--no-locale"]);
  try {
    run("pg_ctl", ["-D", dataDir, "-l", path.join(workdir, "postgres.log"), "-o", `-p ${port} -h 127.0.0.1 -k ${socketDir} -c wal_level=logical`, "-w", "start"]);
  } catch (error) {
    error.message += `\n${readFileSync(path.join(workdir, "postgres.log"), "utf8")}`;
    throw error;
  }
  dbUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  baseEnv = {
    ...process.env,
    [DB_ENV]: dbUrl,
    [ACK_ENV]: TEST_REF,
    [TEST_MODE_ENV]: "1",
    NODE_ENV: "test",
    INBOX_RO_FIXTURE_RECEIPT_DIR: workdir,
  };
  delete baseEnv.MESSAGING_PROVIDER;
  await waitForDb();
  db = new Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("create role authenticated nologin; create role anon nologin; create role service_role nologin; create schema auth; create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz, encrypted_password text, created_at timestamptz default now(), updated_at timestamptz default now()); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$; create publication supabase_realtime;");
  for (const file of ["001_initial.sql", "008_allow_mock_message_provider.sql"]) await db.query(readFileSync(path.resolve("supabase/migrations", file), "utf8"));
  await db.query(`
    create table public.memberships (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      org_id uuid not null references public.organizations(id) on delete cascade,
      role text not null default 'member' check (role in ('owner','member')),
      access_status text not null default 'active',
      access_expires_at timestamptz,
      deletion_prepared_at timestamptz,
      created_at timestamptz not null default now(),
      unique(user_id,org_id)
    );
    alter table public.messages add column campaign_id uuid;
    alter table public.messages add column scheduled_for timestamptz;
    create or replace function public.reset_tenant_tables() returns void language plpgsql as $$
    declare snapshot_row record;
    begin
      create temp table fixture_memberships on commit drop as select * from public.memberships;
      truncate public.job_items, public.messages, public.memberships;
      insert into public.memberships select * from fixture_memberships;
    end $$;
  `);
});

after(async () => {
  if (db) await db.end().catch(() => {});
  if (workdir) {
    try { run("pg_ctl", ["-D", path.join(workdir, "data"), "-m", "immediate", "-w", "stop"], { stdio: "ignore" }); } catch {}
    rmSync(workdir, { recursive: true, force: true });
  }
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
});

test("T1 inertness: scheduler due selector is empty and the real send guard is present", async () => {
  const run = await create("t1-inert");
  const rows = await db.query("select id, scheduled_for from public.messages where org_id=$1 and status='queued' and scheduled_for <= now() and scheduled_for is not null", [run.ids.organization]);
  assert.equal(rows.rowCount, 0);
  const sendSource = readFileSync("src/lib/messaging/send.ts", "utf8");
  assert.match(sendSource, /if \(!msg\.contact_id \|\| !msg\.property_id \|\| !msg\.to_address\)/);
  assert.match(sendSource, /queued message missing contact\/property\/to_address/);
  const status = cli(["--status", "--run-id", "t1-inert"]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const remove = cli(["--remove", "--run-id", "t1-inert"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
});

test("T2 target guards: Production, other targets, CI, provider env, and missing ack fail before DB access", async () => {
  const unchangedBefore = await db.query("select count(*)::int as count from public.organizations");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [DB_ENV]: `postgresql://postgres.${PROD_REF}@db.example.invalid:5432/postgres` }), error => error.code === "PRODUCTION_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [DB_ENV]: "postgresql://postgres.other@aws-1-us-east-1.pooler.supabase.com:5432/postgres" }), error => error.code === "TARGET_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [DB_ENV]: `postgresql://postgres.${TEST_REF}@db.${TEST_REF}.supabase.co:5432/postgres` }), error => error.code === "TARGET_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [DB_ENV]: "postgresql://postgres@127.0.0.1:55400/postgres", [TEST_MODE_ENV]: undefined, NODE_ENV: "development" }), error => error.code === "LOCAL_TARGET_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, CI: "true" }), error => error.code === "CI_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, MESSAGING_PROVIDER: "mock" }), error => error.code === "MESSAGING_PROVIDER_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [ACK_ENV]: "wrong" }), error => error.code === "ACK_REQUIRED");
  const argUrl = cli(["--status", "--run-id", "does-not-connect", "--db-url", dbUrl]);
  assert.notEqual(argUrl.status, 0);
  assert.match(argUrl.stderr, /DB_URL_ARG_REFUSED/);
  const refused = cli(["--status", "--run-id", "does-not-connect"], { [DB_ENV]: `postgresql://postgres.${PROD_REF}@db.example.invalid:5432/postgres` });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /PRODUCTION_REFUSED/);
  const unchangedAfter = await db.query("select count(*)::int as count from public.organizations");
  assert.deepEqual(unchangedAfter.rows, unchangedBefore.rows);
});

test("T3 idempotent create: same run id leaves exactly five owned rows", async () => {
  const first = await create("t3-idempotent");
  const second = cli(["--create", "--run-id", "t3-idempotent", "--owner", "fixture-test"]);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(jsonOutput(second).idempotent, true);
  assert.deepEqual(await ownedRows(first.ids.organization, first.ids.user), { orgs: "1", users: "1", memberships: "1", messages: "2" });
  const remove = cli(["--remove", "--run-id", "t3-idempotent"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
});

test("T4 status verifies the exact marker, active owner, two rows, null tail, and passwordless user", async () => {
  const created = await create("t4-status");
  const status = cli(["--status", "--run-id", "t4-status"]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(jsonOutput(status).ids.organization, created.ids.organization);
  const rows = await db.query("select scheduled_for from public.messages where org_id=$1 order by scheduled_for nulls last", [created.ids.organization]);
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows[0].scheduled_for instanceof Date);
  assert.equal(rows.rows[1].scheduled_for, null);
  assert.equal((await db.query("select encrypted_password,email_confirmed_at from auth.users where id=$1", [created.ids.user])).rows[0].encrypted_password, null);
  const remove = cli(["--remove", "--run-id", "t4-status"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
});

test("T5 reset detection: filenode/stat diagnostics fail status, while the holder blocks a second lock", async () => {
  const created = await create("t5-reset", 5);
  const other = new Client({ connectionString: dbUrl });
  await other.connect();
  assert.equal((await other.query("select pg_try_advisory_lock(hashtext($1)) as acquired", ["sandra-integration-suite"])).rows[0].acquired, false);
  await other.end();
  await new Promise(resolve => setTimeout(resolve, 6000));
  const afterLease = new Client({ connectionString: dbUrl });
  await afterLease.connect();
  assert.equal((await afterLease.query("select pg_try_advisory_lock(hashtext($1)) as acquired", ["sandra-integration-suite"])).rows[0].acquired, true);
  await afterLease.query("select pg_advisory_unlock(hashtext($1))", ["sandra-integration-suite"]);
  await afterLease.end();
  await db.query("select public.reset_tenant_tables()");
  const status = cli(["--status", "--run-id", "t5-reset"]);
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /messages filenode changed|membership.*n_tup_ins changed/);
  const remove = cli(["--remove", "--run-id", "t5-reset"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  assert.deepEqual(await ownedRows(created.ids.organization, created.ids.user), { orgs: "0", users: "0", memberships: "0", messages: "0" });
});

test("T6 cleanup: zero residue passes, but a mutation that skips one delete fails the residue proof", async () => {
  const created = await create("t6-cleanup");
  const rec = receipt("t6-cleanup");
  const mutationDb = new Client({ connectionString: dbUrl });
  await mutationDb.connect();
  await deleteOwnedRows(mutationDb, rec, { skipMessageId: rec.ids.messages.scheduled });
  const failed = await residueCheck(mutationDb, rec);
  assert.equal(failed.pass, false);
  assert.ok(failed.failures.some(value => value.includes("owned rows remain") || value.includes("non-owned row count changed")));
  await mutationDb.end();
  const remove = cli(["--remove", "--run-id", "t6-cleanup"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  assert.deepEqual(await ownedRows(created.ids.organization, created.ids.user), { orgs: "0", users: "0", memberships: "0", messages: "0" });
});

test("T7 never sent: both rows remain queued with no external id and no message references", async () => {
  const created = await create("t7-never-sent");
  const rows = await db.query("select status,external_id,provider from public.messages where org_id=$1 order by id", [created.ids.organization]);
  assert.deepEqual(rows.rows, [{ status: "queued", external_id: null, provider: "mock" }, { status: "queued", external_id: null, provider: "mock" }]);
  const status = cli(["--status", "--run-id", "t7-never-sent"]);
  assert.equal(status.status, 0, status.stderr || status.stdout);
  const remove = cli(["--remove", "--run-id", "t7-never-sent"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
});
