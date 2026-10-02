import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import {
  ACK_ENV,
  DB_ENV,
  SERVICE_ROLE_KEY_ENV,
  SUPABASE_URL_ENV,
  PROD_REF,
  TEST_MODE_ENV,
  TEST_REF,
  assertSafeTarget,
  deleteOwnedRowsForTest,
  residueCheck,
  snapshotDatabase,
} from "./inbox-test-readonly-fixture.mjs";

const { Client } = pg;
const script = path.resolve("scripts/inbox-test-readonly-fixture.mjs");
let workdir;
let stackDir;
let apiPort;
let port;
let authPort;
let dataApiUrl;
let dataServiceRoleKey;
let authStubUrl;
let authStubProcess;
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
  throw new Error("no disposable local port available in 55000-59999");
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

async function waitForFile(file, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (existsSync(file)) return;
    if (child.exitCode !== null) throw new Error(`local auth stub exited with ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("local auth stub did not start");
}

async function waitForSupabaseApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${dataApiUrl}/auth/v1/settings`, {
        headers: { apikey: dataServiceRoleKey },
      });
      if (response.status < 500 && response.status !== 404) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("local GoTrue API did not start");
}

async function startAuthStub() {
  authPort = await freePort();
  const readyFile = path.join(workdir, "auth-stub.ready");
  authStubProcess = spawn(process.execPath, [path.resolve("scripts/inbox-test-readonly-fixture-auth-stub.mjs")], {
    env: {
      ...process.env,
      INBOX_RO_FIXTURE_AUTH_STUB_DB_URL: dbUrl,
      INBOX_RO_FIXTURE_AUTH_STUB_PORT: String(authPort),
      INBOX_RO_FIXTURE_AUTH_STUB_READY_FILE: readyFile,
    },
    stdio: "ignore",
  });
  await waitForFile(readyFile, authStubProcess);
  unlinkSync(readyFile);
  authStubUrl = `http://127.0.0.1:${authPort}/`;
}

async function startDisposableSupabase() {
  stackDir = mkdtempSync(path.join(tmpdir(), "sandra-inbox-ro-supabase-"));
  const supabaseDir = path.join(stackDir, "supabase");
  run("supabase", ["init", "--workdir", stackDir]);
  const generatedConfig = readFileSync(path.join(supabaseDir, "config.toml"), "utf8");
  const repoConfig = readFileSync(path.resolve("supabase/config.toml"), "utf8");
  const majorVersion = repoConfig.match(/^major_version\s*=\s*(\d+)$/m)?.[1];
  assert.equal(majorVersion, "17");
  const usedPorts = new Set();
  const nextPort = async () => {
    let candidate;
    do {
      candidate = await freePort();
    } while (usedPorts.has(candidate));
    usedPorts.add(candidate);
    return candidate;
  };
  apiPort = await nextPort();
  port = await nextPort();
  const shadowPort = await nextPort();
  const poolerPort = await nextPort();
  const studioPort = await nextPort();
  const smtpPort = await nextPort();
  const analyticsPort = await nextPort();
  const config = generatedConfig
    .replace(/^project_id\s*=.*$/m, `project_id = "sandra-ro-${Date.now()}-${process.pid}"`)
    .replace(/(\[api\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${apiPort}`)
    .replace(/(\[db\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${port}`)
    .replace(/(\[db\][\s\S]*?^shadow_port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${shadowPort}`)
    .replace(/(\[db\.pooler\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${poolerPort}`)
    .replace(/(\[studio\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${studioPort}`)
    .replace(/(\[local_smtp\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${smtpPort}`)
    .replace(/(\[analytics\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${analyticsPort}`)
    .replace(/(\[db\][\s\S]*?^major_version\s*=\s*)\d+/m, (_, prefix) => `${prefix}${majorVersion}`);
  writeFileSync(path.join(supabaseDir, "config.toml"), config);
  mkdirSync(path.join(supabaseDir, "migrations"), { recursive: true });
  for (const file of readdirSync(path.resolve("supabase/migrations")).filter(name => name.endsWith(".sql"))) {
    cpSync(path.resolve("supabase/migrations", file), path.join(supabaseDir, "migrations", file));
  }
  run("supabase", [
    "start", "--workdir", stackDir,
    "--exclude", "studio,edge-runtime,logflare,vector,supavisor,storage-api,imgproxy,realtime,postgres-meta,mailpit",
    "--ignore-health-check",
  ], { timeout: 180_000 });
  const status = JSON.parse(run("supabase", ["status", "--workdir", stackDir, "--output", "json"]));
  assert.equal(status.DB_URL, `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`);
  assert.equal(status.API_URL, `http://127.0.0.1:${apiPort}`);
  dataApiUrl = status.API_URL;
  dataServiceRoleKey = status.SERVICE_ROLE_KEY;
  dbUrl = status.DB_URL;
  await waitForDb();
  db = new Client({ connectionString: dbUrl });
  await db.connect();
  await waitForSupabaseApi();
  await startAuthStub();
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
  await startDisposableSupabase();
  baseEnv = {
    ...process.env,
    [DB_ENV]: dbUrl,
    [SUPABASE_URL_ENV]: authStubUrl,
    [SERVICE_ROLE_KEY_ENV]: "local-test-service-role-key",
    [ACK_ENV]: TEST_REF,
    [TEST_MODE_ENV]: "1",
    NODE_ENV: "test",
    INBOX_RO_FIXTURE_RECEIPT_DIR: workdir,
    INBOX_RO_FIXTURE_DATA_API_URL: dataApiUrl,
    INBOX_RO_FIXTURE_DATA_SERVICE_ROLE_KEY: dataServiceRoleKey,
  };
  delete baseEnv.MESSAGING_PROVIDER;
});

after(async () => {
  if (authStubProcess && authStubProcess.exitCode === null) {
    await new Promise(resolve => {
      authStubProcess.once("close", resolve);
      authStubProcess.kill("SIGTERM");
    });
  }
  if (db) await db.end().catch(() => {});
  if (stackDir) {
    try { run("supabase", ["stop", "--workdir", stackDir, "--no-backup"], { timeout: 120_000 }); } catch {}
    rmSync(stackDir, { recursive: true, force: true });
  }
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("T1 inertness: the real Vitest sender and sequence-tick paths prove both rows are inert", async () => {
  const result = cli(["--status", "--run-id", "does-not-exist"]);
  assert.notEqual(result.status, 0);
  const vitest = path.resolve("node_modules/vitest/vitest.mjs");
  const t1 = run(process.execPath, [vitest, "run", "--config", path.resolve("vitest.inbox-ro-fixture.config.ts"), "scripts/inbox-test-readonly-fixture.t1.test.ts"], {
    env: childEnv({ INBOX_RO_FIXTURE_T1_DATA_API_URL: dataApiUrl, INBOX_RO_FIXTURE_T1_DATA_SERVICE_ROLE_KEY: dataServiceRoleKey }),
    timeout: 30_000,
  });
  assert.match(t1, /PASS|Test Files/);
});

test("T2 target guards: Production, other targets, CI, provider env, and missing ack fail before DB access", async () => {
  const unchangedBefore = await db.query("select count(*)::int as count from public.organizations");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [DB_ENV]: `postgresql://postgres.${PROD_REF}@db.example.invalid:5432/postgres` }), error => error.code === "PRODUCTION_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [SUPABASE_URL_ENV]: `https://${PROD_REF}.supabase.co/` }), error => error.code === "PRODUCTION_REFUSED");
  assert.throws(() => assertSafeTarget({ ...baseEnv, [SUPABASE_URL_ENV]: "https://other-project.supabase.co/" }), error => error.code === "TARGET_REFUSED");
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
  const resetReceipt = receipt("t5-reset");
  resetReceipt.baseline = await snapshotDatabase(db);
  resetReceipt.post_insert = resetReceipt.baseline;
  writeFileSync(path.join(workdir, "lease-test-ro-fixture-t5-reset.json"), `${JSON.stringify(resetReceipt)}\n`);
  const remove = cli(["--remove", "--run-id", "t5-reset"]);
  assert.equal(remove.status, 0, remove.stderr || remove.stdout);
  assert.deepEqual(await ownedRows(created.ids.organization, created.ids.user), { orgs: "0", users: "0", memberships: "0", messages: "0" });
});

test("T6 cleanup: zero residue passes, but a mutation that skips one delete fails the residue proof", async () => {
  const created = await create("t6-cleanup");
  const rec = receipt("t6-cleanup");
  const mutationDb = new Client({ connectionString: dbUrl });
  await mutationDb.connect();
  await deleteOwnedRowsForTest(mutationDb, rec, { skipMessageId: rec.ids.messages.scheduled });
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
