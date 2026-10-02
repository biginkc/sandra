import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import {
  ACK_ENV,
  DB_ENV,
  FIXTURE_IDS,
  FIXTURE_ORG_NAME,
  SERVICE_ROLE_KEY_ENV,
  SUPABASE_URL_ENV,
  TEST_MODE_ENV,
  TEST_REF,
  assertSafeTarget,
  openDb,
  parseArgs,
  q,
  run,
  stopOwnedHolder,
} from "./inbox-test-readonly-fixture.mjs";

const { Client } = pg;
const script = path.resolve("scripts/inbox-test-readonly-fixture.mjs");
const UNRELATED_IDS = Object.freeze({
  organization: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  membership: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  savedFilter: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  job: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  thirdMessage: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  secondMembership: "11111111-2222-4333-8444-555555555555",
  authProbeInvalid: "22222222-3333-4444-8555-666666666666",
  authProbeTest: "33333333-4444-4555-8666-777777777777",
  authParityReal: "44444444-5555-4666-8777-888888888888",
  authParityStub: "55555555-6666-4777-8888-999999999999",
});

let workdir;
let stackDir;
let apiPort;
let dbPort;
let dataApiUrl;
let dataServiceRoleKey;
let dbUrl;
let baseEnv;
let db;
let activeReceipt;
let goTrueEmailDomain;
let authStubProcess;
let authStubUrl;

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

async function freePort() {
  const net = await import("node:net");
  const start = 55000 + Math.floor(Math.random() * 5000);
  for (let offset = 0; offset < 5000; offset += 1) {
    const candidate = 55000 + ((start - 55000 + offset) % 5000);
    const available = await new Promise(resolve => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error("no disposable local port available in 55000-59999");
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

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${dataApiUrl}/auth/v1/settings`, { headers: { apikey: dataServiceRoleKey } });
      if (response.status < 500 && response.status !== 404) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("local GoTrue API did not start");
}

async function waitForFile(file, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (existsSync(file)) return;
    if (child.exitCode !== null) throw new Error(`local auth stub exited with ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("local auth stub did not start");
}

async function startAuthStub() {
  const authPort = await freePort();
  const readyFile = path.join(workdir, "auth-stub.ready");
  authStubProcess = spawn(process.execPath, [path.resolve("scripts/inbox-test-readonly-fixture-auth-stub.mjs")], {
    env: {
      ...process.env,
      INBOX_RO_FIXTURE_AUTH_STUB_DB_URL: dbUrl,
      INBOX_RO_FIXTURE_AUTH_STUB_PORT: String(authPort),
      INBOX_RO_FIXTURE_AUTH_STUB_READY_FILE: readyFile,
      INBOX_RO_FIXTURE_AUTH_STUB_EMAIL_DOMAIN: goTrueEmailDomain,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForFile(readyFile, authStubProcess);
  unlinkSync(readyFile);
  authStubUrl = `http://127.0.0.1:${authPort}/`;
}

async function probeGoTrueEmailDomain() {
  const admin = createClient(dataApiUrl, dataServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
  const invalid = await admin.createUser({ id: UNRELATED_IDS.authProbeInvalid, email: "gotrue-domain-probe@fixtures.invalid", email_confirm: false });
  if (!invalid.error) return "fixtures.invalid";
  const testDomain = await admin.createUser({ id: UNRELATED_IDS.authProbeTest, email: "gotrue-domain-probe@fixtures.test", email_confirm: false });
  if (!testDomain.error) return "fixtures.test";
  throw new Error(`GoTrue rejected both permitted fixture email domains: ${invalid.error.message}; ${testDomain.error.message}`);
}

async function startDisposableSupabase() {
  workdir = mkdtempSync(path.join(tmpdir(), "sandra-inbox-ro-fixture-test-"));
  stackDir = mkdtempSync(path.join(tmpdir(), "sandra-inbox-ro-supabase-"));
  const supabaseDir = path.join(stackDir, "supabase");
  runCommand("supabase", ["init", "--workdir", stackDir]);
  const generatedConfig = readFileSync(path.join(supabaseDir, "config.toml"), "utf8");
  const repoConfig = readFileSync(path.resolve("supabase/config.toml"), "utf8");
  const majorVersion = repoConfig.match(/^major_version\s*=\s*(\d+)$/m)?.[1];
  assert.equal(majorVersion, "17");
  const ports = [];
  const nextPort = async () => {
    let candidate;
    do { candidate = await freePort(); } while (ports.includes(candidate));
    ports.push(candidate);
    return candidate;
  };
  apiPort = await nextPort();
  dbPort = await nextPort();
  const shadowPort = await nextPort();
  const poolerPort = await nextPort();
  const studioPort = await nextPort();
  const smtpPort = await nextPort();
  const analyticsPort = await nextPort();
  const config = generatedConfig
    .replace(/^project_id\s*=.*$/m, `project_id = "sandra-ro-${Date.now()}-${process.pid}"`)
    .replace(/(\[api\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${apiPort}`)
    .replace(/(\[db\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${dbPort}`)
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
  runCommand("supabase", ["start", "--workdir", stackDir, "--exclude", "studio,edge-runtime,logflare,vector,supavisor,storage-api,imgproxy,realtime,postgres-meta,mailpit", "--ignore-health-check"], { timeout: 180_000 });
  const status = JSON.parse(runCommand("supabase", ["status", "--workdir", stackDir, "--output", "json"]));
  assert.equal(status.DB_URL, `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`);
  assert.equal(status.API_URL, `http://127.0.0.1:${apiPort}`);
  dataApiUrl = status.API_URL;
  dataServiceRoleKey = status.SERVICE_ROLE_KEY;
  dbUrl = status.DB_URL;
  await waitForDb();
  db = new Client({ connectionString: dbUrl });
  await db.connect();
  await waitForApi();
  goTrueEmailDomain = await probeGoTrueEmailDomain();
  await startAuthStub();
  baseEnv = {
    ...process.env,
    [DB_ENV]: dbUrl,
    [SUPABASE_URL_ENV]: authStubUrl,
    [SERVICE_ROLE_KEY_ENV]: "local-test-service-role-key",
    [ACK_ENV]: TEST_REF,
    [TEST_MODE_ENV]: "1",
    NODE_ENV: "test",
    INBOX_RO_FIXTURE_RECEIPT_DIR: workdir,
    INBOX_RO_FIXTURE_T1_DATA_API_URL: dataApiUrl,
    INBOX_RO_FIXTURE_T1_DATA_SERVICE_ROLE_KEY: dataServiceRoleKey,
  };
  delete baseEnv.MESSAGING_PROVIDER;
}

function childEnv(overrides = {}) {
  const env = { ...baseEnv, ...overrides };
  delete env.MESSAGING_PROVIDER;
  return env;
}

function cli(args, overrides = {}) {
  try {
    const stdout = runCommand(process.execPath, [script, ...args], { env: childEnv(overrides) });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function jsonOutput(result) {
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function receipt(runId) {
  return JSON.parse(readFileSync(path.join(workdir, `lease-test-ro-fixture-${runId}.json`), "utf8"));
}

async function createFixture(runId, leaseSeconds = 120) {
  const result = cli(["--create", "--run-id", runId, "--owner", "fixture-test", "--lease-seconds", String(leaseSeconds)]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  activeReceipt = receipt(runId);
  return jsonOutput(result);
}

async function fixtureHashes() {
  const queries = [
    ["organization", "select coalesce(string_agg(row_to_json(t)::text, E'\\n' order by t.id), '') as hash from public.organizations t where t.id=$1", [FIXTURE_IDS.organization]],
    ["user", "select coalesce(string_agg(row_to_json(t)::text, E'\\n' order by t.id), '') as hash from auth.users t where t.id=$1", [FIXTURE_IDS.user]],
    ["membership", "select coalesce(string_agg(row_to_json(t)::text, E'\\n' order by t.id), '') as hash from public.memberships t where t.org_id=$1 or t.user_id=$2", [FIXTURE_IDS.organization, FIXTURE_IDS.user]],
    ["messages", "select coalesce(string_agg(row_to_json(t)::text, E'\\n' order by t.id), '') as hash from public.messages t where t.org_id=$1", [FIXTURE_IDS.organization]],
  ];
  const hashes = {};
  for (const [name, sql, values] of queries) hashes[name] = (await db.query(sql, values)).rows[0].hash;
  return hashes;
}

async function unrelatedHashes() {
  const rows = await db.query(`
    select
      (select md5(row_to_json(t)::text) from public.organizations t where id=$1) as org_hash,
      (select md5(row_to_json(t)::text) from auth.users t where id=$2) as user_hash,
      (select md5(row_to_json(t)::text) from public.memberships t where id=$3) as membership_hash,
      (select md5(row_to_json(t)::text) from public.saved_filters t where id=$4) as preset_hash
  `, [UNRELATED_IDS.organization, UNRELATED_IDS.user, UNRELATED_IDS.membership, UNRELATED_IDS.savedFilter]);
  return rows.rows[0];
}

function fixtureAppMetadata() {
  return {
    inbox_ro_fixture: {
      org_id: FIXTURE_IDS.organization,
      membership_id: FIXTURE_IDS.membership,
      message_ids: [FIXTURE_IDS.messages.scheduled, FIXTURE_IDS.messages.unscheduled],
      permanent: true,
    },
  };
}

async function authParityRow(id) {
  const user = (await db.query("select email,email_confirmed_at,last_sign_in_at,banned_until,encrypted_password,raw_app_meta_data from auth.users where id=$1", [id])).rows[0];
  const identities = (await db.query("select provider from auth.identities where user_id=$1 order by provider", [id])).rows.map(row => row.provider);
  return { user, identities };
}

async function plantUnrelatedRows() {
  await db.query("insert into public.organizations(id,name) values ($1,$2) on conflict (id) do nothing", [UNRELATED_IDS.organization, "Unrelated protected organization"]);
  const admin = createClient(dataApiUrl, dataServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
  const found = await admin.getUserById(UNRELATED_IDS.user);
  if (!found.data?.user) {
    const created = await admin.createUser({ id: UNRELATED_IDS.user, email: "unrelated-fixture@fixtures.invalid", email_confirm: false });
    assert.equal(created.error, null, created.error?.message);
  }
  await db.query("insert into public.memberships(id,user_id,org_id,role,access_status) values ($1,$2,$3,'owner','active') on conflict (id) do nothing", [UNRELATED_IDS.membership, UNRELATED_IDS.user, UNRELATED_IDS.organization]);
  await db.query(`
    insert into public.saved_filters(id,org_id,user_id,name,filters_json,starred,is_base)
    values ($1,$2,$3,'Unrelated saved preset','{"v":1,"blocks":[]}'::jsonb,true,false)
    on conflict (id) do nothing
  `, [UNRELATED_IDS.savedFilter, UNRELATED_IDS.organization, UNRELATED_IDS.user]);
}

async function jobHash() {
  return (await db.query("select md5(row_to_json(j)::text) as hash from public.jobs j where id=$1", [UNRELATED_IDS.job])).rows[0].hash;
}

async function waitForReady(file, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (child.exitCode !== null) throw new Error(`holder exited with ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("holder did not become ready");
}

async function startDirectHolder(runId, seconds) {
  const readyFile = path.join(workdir, `${runId}.ready.json`);
  const leaseExpiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  const child = spawn(process.execPath, [script, "--hold-lock", "--run-id", runId, "--lease-expires-at", leaseExpiresAt, "--ready-file", readyFile], { env: childEnv(), stdio: "ignore" });
  const ready = await waitForReady(readyFile, child);
  unlinkSync(readyFile);
  return { child, ready, leaseExpiresAt };
}

async function stopDirectHolder(holder) {
  if (holder.child.exitCode === null) holder.child.kill("SIGTERM");
  await new Promise(resolve => holder.child.once("close", resolve));
}

before(async () => {
  await startDisposableSupabase();
});

after(async () => {
  if (activeReceipt) {
  try { stopOwnedHolder(activeReceipt.lock, activeReceipt.run_id); } catch {}
  }
  if (authStubProcess && authStubProcess.exitCode === null) {
    await new Promise(resolve => {
      authStubProcess.once("close", resolve);
      authStubProcess.kill("SIGTERM");
    });
  }
  if (db) await db.end().catch(() => {});
  if (stackDir) {
    try { runCommand("supabase", ["stop", "--workdir", stackDir, "--no-backup"], { timeout: 120_000 }); } catch {}
    rmSync(stackDir, { recursive: true, force: true });
  }
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("AT9 real local GoTrue: create, verify, recreate, and stub parity", async () => {
  const realEnv = { [SUPABASE_URL_ENV]: dataApiUrl, [SERVICE_ROLE_KEY_ENV]: dataServiceRoleKey };
  const created = cli(["--create", "--run-id", "at9-real-gotrue", "--owner", "fixture-test", "--lease-seconds", "120"], realEnv);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const verified = cli(["--verify", "--run-id", "at9-real-gotrue"], realEnv);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  const recreated = cli(["--create", "--run-id", "at9-real-gotrue", "--owner", "fixture-test", "--lease-seconds", "120"], realEnv);
  assert.equal(recreated.status, 0, recreated.stderr || recreated.stdout);
  const at9Receipt = receipt("at9-real-gotrue");
  stopOwnedHolder(at9Receipt.lock, at9Receipt.run_id);

  const realAdmin = createClient(dataApiUrl, dataServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
  const stubAdmin = createClient(authStubUrl, dataServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
  const parityMetadata = { inbox_ro_fixture: { parity: true } };
  const realParity = await realAdmin.createUser({ id: UNRELATED_IDS.authParityReal, email: `parity-real@${goTrueEmailDomain}`, email_confirm: false, ban_duration: "876000h", app_metadata: parityMetadata });
  const stubParity = await stubAdmin.createUser({ id: UNRELATED_IDS.authParityStub, email: `parity-stub@${goTrueEmailDomain}`, email_confirm: false, ban_duration: "876000h", app_metadata: parityMetadata });
  assert.equal(realParity.error, null, realParity.error?.message);
  assert.equal(stubParity.error, null, stubParity.error?.message);
  const realRow = await authParityRow(UNRELATED_IDS.authParityReal);
  const stubRow = await authParityRow(UNRELATED_IDS.authParityStub);
  for (const row of [realRow, stubRow]) {
    assert.match(row.user.encrypted_password, /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/);
    assert.equal(row.user.email_confirmed_at, null);
    assert.equal(row.user.last_sign_in_at, null);
    assert.ok(Date.parse(row.user.banned_until) > Date.parse("2100-01-01T00:00:00.000Z"));
    assert.deepEqual(row.user.raw_app_meta_data.inbox_ro_fixture, parityMetadata.inbox_ro_fixture);
    assert.equal(row.user.raw_app_meta_data.provider, "email");
    assert.deepEqual(row.user.raw_app_meta_data.providers, ["email"]);
    assert.deepEqual(row.identities, ["email"]);
  }
  assert.deepEqual(
    { email_confirmed_at: realRow.user.email_confirmed_at, last_sign_in_at: realRow.user.last_sign_in_at, metadata: realRow.user.raw_app_meta_data, identities: realRow.identities },
    { email_confirmed_at: stubRow.user.email_confirmed_at, last_sign_in_at: stubRow.user.last_sign_in_at, metadata: stubRow.user.raw_app_meta_data, identities: stubRow.identities },
  );
  console.log("AT9 real-GoTrue: --create, --verify, second --create PASS; stub parity PASS (bcrypt-shaped opaque hash, provider/providers, one email identity)");
});

test("T1 real queued-message inertness stays green before the AT checks", async () => {
  const vitest = path.resolve("node_modules/vitest/vitest.mjs");
  const result = runCommand(process.execPath, [vitest, "run", "--config", path.resolve("vitest.inbox-ro-fixture.config.ts"), "scripts/inbox-test-readonly-fixture.t1.test.ts"], {
    env: childEnv(),
    timeout: 45_000,
  });
  assert.match(result, /PASS|Test Files/);
  activeReceipt = null;
});

test("AT1 Astra target repro: parse effective fields and never pass a connection string", async () => {
  const hostedEnv = { ...baseEnv, [SUPABASE_URL_ENV]: `https://${TEST_REF}.supabase.co/` };
  const cases = [
    [`postgresql://postgres.${TEST_REF}:postgres@%2Ftmp%2Fnon-test.pooler.supabase.com:5432/postgres`, "database authority must not contain encoded characters"],
    [`postgresql://postgres.${TEST_REF}:postgres@aws-1-us-east-1.pooler.supabase.com:5432/postgres?host=/tmp`, "database URL options are refused"],
    [`postgresql://postgres.${TEST_REF}:postgres@aws-1-us-east-1.pooler.supabase.com:5432/postgres?options=`, "database URL options are refused"],
    [`postgresql://postgres.${TEST_REF}:postgres@/tmp/postgres`, "socket paths are refused"],
    ["postgresql://postgres.ncsngxlcyxylaeskiteu:postgres@wrong.example.invalid:5432/postgres", "only the TEST session-pooler host is allowed"],
    [`postgresql://wrong-user:${TEST_REF}@aws-1-us-east-1.pooler.supabase.com:5432/postgres`, "only the TEST session-pooler credentials are allowed"],
    [`postgresql://postgres.${TEST_REF}:postgres@aws-1-us-east-1.pooler.supabase.com:5433/postgres`, "only the TEST session-pooler credentials are allowed"],
    [`postgresql://postgres.${TEST_REF}:postgres@aws-1-us-east-1.pooler.supabase.com:5432/not-postgres`, "database must be postgres"],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => assertSafeTarget({ ...hostedEnv, [DB_ENV]: raw }), error => error.code === "TARGET_REFUSED" && error.message === message, message);
  }
  let constructorOptions;
  let connectCalls = 0;
  class SpyClient {
    constructor(options) { constructorOptions = options; }
    async connect() { connectCalls += 1; }
    async end() {}
  }
  const client = await openDb(baseEnv, SpyClient);
  await client.end();
  assert.equal(connectCalls, 1);
  assert.deepEqual(Object.keys(constructorOptions).sort(), ["database", "host", "options", "password", "port", "user"]);
  assert.equal(Object.hasOwn(constructorOptions, "connectionString"), false);
  assert.equal(constructorOptions.host, "127.0.0.1");
  assert.equal(constructorOptions.port, dbPort);
});

test("AT2 Astra receipt and mode repro: unrelated rows survive every forged-id path", async () => {
  await plantUnrelatedRows();
  const before = await unrelatedHashes();
  const created = await createFixture("at2-receipt");
  const forgedFile = path.join(workdir, "forged-receipt.json");
  const forged = { ...receipt("at2-receipt"), ids: { organization: UNRELATED_IDS.organization, user: UNRELATED_IDS.user, membership: UNRELATED_IDS.membership, messages: { scheduled: UNRELATED_IDS.thirdMessage, unscheduled: UNRELATED_IDS.job } } };
  writeFileSync(forgedFile, `${JSON.stringify(forged)}\n`);
  for (const args of [["--remove", "--run-id", "at2-receipt"], ["--cleanup", "--run-id", "at2-receipt"]]) {
    const removed = cli(args);
    assert.notEqual(removed.status, 0);
    assert.match(removed.stderr, /MODE_REMOVED/);
    assert.deepEqual(await unrelatedHashes(), before);
  }
  const forgedCreate = cli(["--create", "--run-id", "at2-receipt", "--owner", "fixture-test", "--receipt", forgedFile]);
  assert.equal(forgedCreate.status, 0, forgedCreate.stderr || forgedCreate.stdout);
  assert.deepEqual(jsonOutput(forgedCreate).ids, created.ids);
  assert.deepEqual(await unrelatedHashes(), before);
  const forgedVerify = cli(["--verify", "--run-id", "at2-receipt", "--receipt", forgedFile]);
  assert.equal(forgedVerify.status, 0, forgedVerify.stderr || forgedVerify.stdout);
  assert.deepEqual(jsonOutput(forgedVerify).ids, created.ids);
  assert.deepEqual(await unrelatedHashes(), before);
});

test("AT3 Astra lifecycle repro: a jobs.created_by reference stays intact across lock release and expiry", async () => {
  await db.query("insert into public.jobs(id,org_id,created_by,type,status) values ($1,$2,$3,'csv_import','queued') on conflict (id) do nothing", [UNRELATED_IDS.job, FIXTURE_IDS.organization, FIXTURE_IDS.user]);
  const before = await jobHash();
  const verified = cli(["--verify", "--run-id", "at2-receipt"]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(await jobHash(), before);
  stopOwnedHolder(activeReceipt.lock, activeReceipt.run_id);
  activeReceipt = null;
  const released = await startDirectHolder("at3-release", 30);
  assert.equal((await db.query("select pg_try_advisory_lock(hashtext($1)) as acquired", ["sandra-integration-suite"])).rows[0].acquired, false);
  assert.equal(await jobHash(), before);
  await stopDirectHolder(released);
  const expiring = await startDirectHolder("at3-expire", 1);
  await new Promise(resolve => expiring.child.once("close", resolve));
  assert.equal(await jobHash(), before);
  await createFixture("at3-lifecycle");
  assert.equal(await jobHash(), before);
});

test("AT4 q allowlist: every accepted call reaches db.query and every forbidden call is rejected", async () => {
  let calls = 0;
  const statements = ["select 1", "insert into x values (1)", "begin", "commit", "rollback", "set statement_timeout=0"];
  for (const statement of statements) await q({ query: async () => { calls += 1; } }, statement);
  assert.equal(calls, statements.length);
  for (const statement of [
    "delete from x",
    "truncate x",
    "update x set id=1",
    "drop table x",
    "alter table x add column y text",
    "merge into x using y on true when matched then update set id=1",
    "insert into x values (1) on conflict (id) do update set id=1",
    "select 1; delete from x",
  ]) await assert.rejects(() => q({ query: async () => { calls += 1; } }, statement), error => error.code === "SQL_STATEMENT_REFUSED");
  assert.equal(calls, statements.length);
});

test("AT5 drift is refused without changing the mutated rows", async () => {
  const runId = activeReceipt.run_id;
  const originalPassword = (await db.query("select encrypted_password from auth.users where id=$1", [FIXTURE_IDS.user])).rows[0].encrypted_password;
  const originalMetadata = (await db.query("select raw_app_meta_data from auth.users where id=$1", [FIXTURE_IDS.user])).rows[0].raw_app_meta_data;
  const cases = [
    {
      name: "to_address",
      expectation: "drift",
      mutate: () => db.query("update public.messages set to_address='+15550001111' where id=$1", [FIXTURE_IDS.messages.scheduled]),
      restore: () => db.query("update public.messages set to_address=null where id=$1", [FIXTURE_IDS.messages.scheduled]),
    },
    {
      name: "status",
      expectation: "drift",
      mutate: () => db.query("update public.messages set status='sent' where id=$1", [FIXTURE_IDS.messages.scheduled]),
      restore: () => db.query("update public.messages set status='queued' where id=$1", [FIXTURE_IDS.messages.scheduled]),
    },
    {
      name: "unban",
      expectation: "drift",
      mutate: () => db.query("update auth.users set banned_until=null where id=$1", [FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set banned_until=timestamptz '2101-01-01' where id=$1", [FIXTURE_IDS.user]),
    },
    {
      name: "ban expires before 2100",
      expectation: "drift",
      mutate: () => db.query("update auth.users set banned_until=timestamptz '2099-12-31' where id=$1", [FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set banned_until=timestamptz '2101-01-01' where id=$1", [FIXTURE_IDS.user]),
    },
    {
      name: "third message",
      expectation: "drift",
      mutate: () => db.query("insert into public.messages(id,org_id,channel,direction,status,provider,body) values ($1,$2,'sms','outbound','queued','mock','third fixture row')", [UNRELATED_IDS.thirdMessage, FIXTURE_IDS.organization]),
      restore: () => db.query("delete from public.messages where id=$1", [UNRELATED_IDS.thirdMessage]),
    },
    {
      name: "second membership",
      expectation: "drift",
      mutate: () => db.query("insert into public.memberships(id,user_id,org_id,role,access_status) values ($1,$2,$3,'member','active')", [UNRELATED_IDS.secondMembership, UNRELATED_IDS.user, FIXTURE_IDS.organization]),
      restore: () => db.query("delete from public.memberships where id=$1", [UNRELATED_IDS.secondMembership]),
    },
    {
      name: "squatter org",
      expectation: "drift",
      mutate: () => db.query("update public.organizations set name='Squatter at fixed fixture id' where id=$1", [FIXTURE_IDS.organization]),
      restore: () => db.query("update public.organizations set name=$1 where id=$2", [FIXTURE_ORG_NAME, FIXTURE_IDS.organization]),
    },
    {
      name: "squatter at fixed m1 id in another org",
      expectation: "drift",
      mutate: () => db.query("update public.messages set org_id=$1 where id=$2", [UNRELATED_IDS.organization, FIXTURE_IDS.messages.scheduled]),
      restore: () => db.query("update public.messages set org_id=$1 where id=$2", [FIXTURE_IDS.organization, FIXTURE_IDS.messages.scheduled]),
    },
    {
      name: "squatter at fixed membership id in another org and user",
      expectation: "drift",
      mutate: async () => {
        await db.query("set session_replication_role='replica'");
        try {
          await db.query("update public.memberships set org_id=$1,user_id=$2 where id=$3", [UNRELATED_IDS.organization, UNRELATED_IDS.authParityReal, FIXTURE_IDS.membership]);
        } finally {
          await db.query("set session_replication_role='origin'");
        }
      },
      restore: async () => {
        await db.query("set session_replication_role='replica'");
        try {
          await db.query("update public.memberships set org_id=$1,user_id=$2 where id=$3", [FIXTURE_IDS.organization, FIXTURE_IDS.user, FIXTURE_IDS.membership]);
        } finally {
          await db.query("set session_replication_role='origin'");
        }
      },
    },
    {
      name: "email confirmed",
      expectation: "drift",
      mutate: () => db.query("update auth.users set email_confirmed_at=now() where id=$1", [FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set email_confirmed_at=null where id=$1", [FIXTURE_IDS.user]),
    },
    {
      name: "last sign in",
      expectation: "drift",
      mutate: () => db.query("update auth.users set last_sign_in_at=now() where id=$1", [FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set last_sign_in_at=null where id=$1", [FIXTURE_IDS.user]),
    },
    {
      name: "nested auth stamp",
      expectation: "drift",
      mutate: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify({ ...originalMetadata, inbox_ro_fixture: { ...originalMetadata.inbox_ro_fixture, org_id: UNRELATED_IDS.organization } }), FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify(originalMetadata), FIXTURE_IDS.user]),
    },
    {
      name: "provider marker",
      expectation: "drift",
      mutate: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify({ ...originalMetadata, provider: "google" }), FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify(originalMetadata), FIXTURE_IDS.user]),
    },
    {
      name: "providers marker",
      expectation: "drift",
      mutate: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify({ ...originalMetadata, providers: ["google"] }), FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify(originalMetadata), FIXTURE_IDS.user]),
    },
    {
      name: "non-email identity",
      expectation: "drift",
      mutate: () => db.query("insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at) values (gen_random_uuid(),'fixture-google',$1,$2::jsonb,'google',null,now(),now())", [FIXTURE_IDS.user, JSON.stringify({ sub: "fixture-google" })]),
      restore: () => db.query("delete from auth.identities where user_id=$1 and provider='google'", [FIXTURE_IDS.user]),
    },
    {
      name: "second email identity",
      expectation: "drift",
      mutate: () => db.query("insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at) values (gen_random_uuid(),'fixture-second-email',$1,$2::jsonb,'email',null,now(),now())", [FIXTURE_IDS.user, JSON.stringify({ sub: "fixture-second-email" })]),
      restore: () => db.query("delete from auth.identities where user_id=$1 and provider_id='fixture-second-email'", [FIXTURE_IDS.user]),
    },
    {
      name: "opaque encrypted password change",
      expectation: "pass",
      mutate: () => db.query("update auth.users set encrypted_password=crypt('fixture-opaque-change',gen_salt('bf',10)) where id=$1", [FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set encrypted_password=$1 where id=$2", [originalPassword, FIXTURE_IDS.user]),
    },
    {
      name: "extra GoTrue metadata key",
      expectation: "pass",
      mutate: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify({ ...originalMetadata, provider: "email", providers: ["email"], go_true_extra: "ignored" }), FIXTURE_IDS.user]),
      restore: () => db.query("update auth.users set raw_app_meta_data=$1::jsonb where id=$2", [JSON.stringify(originalMetadata), FIXTURE_IDS.user]),
    },
  ];
  for (const current of cases) {
    await current.mutate();
    const mutated = await fixtureHashes();
    for (const mode of ["--create", "--verify"]) {
      const result = cli([mode, "--run-id", runId, ...(mode === "--create" ? ["--owner", "fixture-test"] : [])]);
      if (current.expectation === "drift") {
        assert.notEqual(result.status, 0, current.name);
        assert.match(result.stderr, /FIXTURE_DRIFT/, current.name);
      } else {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
      assert.deepEqual(await fixtureHashes(), mutated, current.name);
    }
    await current.restore();
    const restored = cli(["--verify", "--run-id", runId]);
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  }
});

test("AT5 fixed-id completeness: verify refuses each missing fixed row and create restores it", async () => {
  const runId = activeReceipt.run_id;
  await db.query("delete from public.messages where id=$1", [FIXTURE_IDS.messages.unscheduled]);
  const missingMessage = cli(["--verify", "--run-id", runId]);
  assert.notEqual(missingMessage.status, 0);
  assert.match(missingMessage.stderr, /FIXTURE_DRIFT/);
  const restoredMessage = cli(["--create", "--run-id", runId, "--owner", "fixture-test"]);
  assert.equal(restoredMessage.status, 0, restoredMessage.stderr || restoredMessage.stdout);

  await db.query("set session_replication_role='replica'");
  try {
    await db.query("delete from public.memberships where id=$1", [FIXTURE_IDS.membership]);
  } finally {
    await db.query("set session_replication_role='origin'");
  }
  const missingMembership = cli(["--verify", "--run-id", runId]);
  assert.notEqual(missingMembership.status, 0);
  assert.match(missingMembership.stderr, /FIXTURE_DRIFT/);
  const restoredMembership = cli(["--create", "--run-id", runId, "--owner", "fixture-test"]);
  assert.equal(restoredMembership.status, 0, restoredMembership.stderr || restoredMembership.stdout);
});

test("AT6 fixed-id re-create after reset restores the same five owned rows", async () => {
  stopOwnedHolder(activeReceipt.lock, activeReceipt.run_id);
  activeReceipt = null;
  await db.query("select public.reset_tenant_tables()");
  const recreated = await createFixture("at6-recreate");
  assert.notEqual(recreated.run_id, "at3-lifecycle");
  assert.deepEqual(recreated.ids, FIXTURE_IDS);
  const counts = (await db.query(`
    select
      (select count(*) from public.organizations where id=$1) +
      (select count(*) from auth.users where id=$2) +
      (select count(*) from public.memberships where id=$1 or user_id=$2) +
      (select count(*) from public.messages where org_id=$1) as total
  `, [FIXTURE_IDS.organization, FIXTURE_IDS.user])).rows[0];
  assert.equal(Number(counts.total), 5);
  const verify = cli(["--verify", "--run-id", "at6-recreate"]);
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
});

test("AT7 removed modes fail before constructing a database client", async () => {
  let constructors = 0;
  class SpyClient {
    constructor() { constructors += 1; }
  }
  await assert.rejects(() => run(parseArgs(["--remove"]), {}, { ClientConstructor: SpyClient }), error => error.code === "MODE_REMOVED");
  await assert.rejects(() => run(parseArgs(["--cleanup"]), {}, { ClientConstructor: SpyClient }), error => error.code === "MODE_REMOVED");
  assert.equal(constructors, 0);
  assert.match(cli(["--remove", "--run-id", "at6-recreate"]).stderr, /MODE_REMOVED/);
  assert.match(cli(["--cleanup", "--run-id", "at6-recreate"]).stderr, /MODE_REMOVED/);
});

test("AT8 closed login surface: fixed user is banned, reserved-TLD, unconfirmed and email-only", async () => {
  const row = (await db.query("select email,banned_until,email_confirmed_at,last_sign_in_at,raw_app_meta_data from auth.users where id=$1", [FIXTURE_IDS.user])).rows[0];
  assert.equal(row.email, `inbox-ro-fixture@${goTrueEmailDomain}`);
  assert.ok(Date.parse(row.banned_until) > Date.parse("2100-01-01T00:00:00.000Z"));
  assert.equal(row.email_confirmed_at, null);
  assert.equal(row.last_sign_in_at, null);
  assert.deepEqual(row.raw_app_meta_data.inbox_ro_fixture, fixtureAppMetadata().inbox_ro_fixture);
  assert.deepEqual(row.raw_app_meta_data.providers, ["email"]);
  const identities = (await db.query("select provider from auth.identities where user_id=$1 order by provider", [FIXTURE_IDS.user])).rows.map(identity => identity.provider);
  assert.ok(identities.length <= 1);
  assert.deepEqual(identities.filter(provider => provider !== "email"), []);
});
