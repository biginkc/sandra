import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";
import { applyMyLeadsChain } from "@tests/integration/my-leads-housekeeping-fixture";

/**
 * RED fixture for the Norma call queue. Local-only: everything runs inside ONE
 * rollback-only transaction on a verified loopback database; each test gets a
 * SAVEPOINT that is rolled back, so tests are isolated and nothing is committed.
 *
 * The queue migration's version number is NOT reserved yet, so it is located by
 * filename SUFFIX (same technique as norma-followup-fixture.ts), never by a
 * hardcoded version.
 */
export const QUEUE_MIGRATION_SUFFIX = "_norma_call_queue.sql";
/** PROPOSED — needs review: optional separate "migration 1" of plan [G1] (legacy claim always false). */
export const LEGACY_CLAIM_MIGRATION_SUFFIX = "_norma_legacy_claim_disable.sql";

const migrationsDir = path.join(process.cwd(), "supabase/migrations");
const strip = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");
const loadNamed = (name: string) => strip(readFileSync(path.join(migrationsDir, name), "utf8"));

/** The already-admitted Norma chain the queue builds on (mirrors 20261004090000_norma_call_twice.integration.test.ts). */
const EXISTING_NORMA_MIGRATIONS = [
  "20261002120000_norma_call_requests.sql",
  "20261002120100_norma_m2_hardening.sql",
  "20261002120200_norma_m2_review_fixes.sql",
  "20261002120300_norma_dnc_lock_task_writes.sql",
  "20261002120400_norma_create_request_serialize.sql",
  "20261002120500_norma_lock_order.sql",
];
const INBOUND_CALL_RECORDS_MIGRATION = "20261008135000_norma_inbound_call_records.sql";
const RETRY_MIGRATION = "20261008090100_norma_retry_next_step_union_reviewed.sql";

/** Locate the queue migration by suffix. Throws a clear RED error when it does not exist yet. */
export function findQueueMigration(): string {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(QUEUE_MIGRATION_SUFFIX));
  if (files.length === 0) {
    throw new Error(
      `queue migration not found (RED): no supabase/migrations/*${QUEUE_MIGRATION_SUFFIX}. ` +
        "This is the expected RED state until the queue migration is written.",
    );
  }
  if (files.length > 1) {
    throw new Error(`expected exactly one *${QUEUE_MIGRATION_SUFFIX}, found: ${files.join(", ")}`);
  }
  return files[0]!;
}

function findOptionalLegacyClaimMigration(): string | null {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(LEGACY_CLAIM_MIGRATION_SUFFIX));
  if (files.length > 1) throw new Error(`expected at most one *${LEGACY_CLAIM_MIGRATION_SUFFIX}, found: ${files.join(", ")}`);
  return files[0] ?? null;
}

/** True when the queue migration is already in the database (a run-owned full-chain stack). */
async function queueAlreadyApplied(db: Client): Promise<boolean> {
  return (await db.query("select to_regclass('public.norma_queue_entries') is not null and to_regclass('public.norma_queue_control') is not null as a")).rows[0].a === true;
}

export type QueueChainOptions = {
  /**
   * Runs after the existing Norma chain is applied and BEFORE the queue migration(s) (and before the optional
   * legacy-claim migration 1): lets a test seed pre-migration rows ([E3], [F3], [G1]).
   */
  beforeQueueMigration?: (db: Client) => Promise<void>;
};

/** Apply the full chain, then the queue migration(s), inside the caller-owned rollback transaction. */
export async function applyQueueChain(db: Client, opts: QueueChainOptions = {}): Promise<void> {
  const queueFile = findQueueMigration(); // fail fast, before touching the database
  await applyMyLeadsChain(db, []);
  await db.query(EXISTING_NORMA_MIGRATIONS.map(loadNamed).join("\n"));
  await applyMyLeadsChain(db, ["schema", "createFn"]);
  await db.query(loadNamed(RETRY_MIGRATION)); // norma_retry_admission stays OFF (plan [H7])
  if (opts.beforeQueueMigration) await opts.beforeQueueMigration(db);
  // The queue's merge_duplicate_properties is rebuilt from the latest definition (inbound call records), so that
  // migration must already be in place, exactly as it is on main before the queue migration (20261009010100 > 20261008135000).
  await db.query(loadNamed(INBOUND_CALL_RECORDS_MIGRATION));
  const legacy = findOptionalLegacyClaimMigration();
  if (legacy) await db.query(loadNamed(legacy));
  await db.query(loadNamed(queueFile));
}

export type QueueFixture = {
  db: Client;
  /** Run `fn` inside a SAVEPOINT that is always rolled back. */
  isolated<T>(fn: (db: Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** One connection + one rollback-only transaction + migrations applied once (call from beforeAll). */
export async function openQueueFixture(connectionString: string, opts: QueueChainOptions = {}): Promise<QueueFixture> {
  const url = requireLoopbackPostgresUrl(connectionString);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    // Applied mode: a run-owned DISPOSABLE database built from the full current chain already contains the queue migrations, and the
    // My Leads fixture guard cannot roll a fully-migrated chain back. The schema is then exactly production's: skip the replay and
    // run each test in its rollback savepoint. A scenario that must seed rows BEFORE the migration cannot run there and says so.
    if (await queueAlreadyApplied(db)) {
      if (opts.beforeQueueMigration) throw new Error("PRE_QUEUE_STATE_REQUIRED: this scenario seeds rows before the queue migration, but the database already has it (full-chain mode)");
    } else {
      await applyQueueChain(db, opts);
    }
  } catch (error) {
    await db.query("rollback").catch(() => {});
    await db.end();
    throw error;
  }
  let n = 0;
  return {
    db,
    async isolated(fn) {
      const name = `queue_t${++n}`;
      await db.query(`savepoint ${name}`);
      try {
        return await fn(db);
      } finally {
        await db.query("reset role").catch(() => {});
        await db.query(`rollback to savepoint ${name}`);
      }
    },
    async close() {
      await db.query("rollback").catch(() => {});
      await db.end();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Concurrency fixture: a run-owned disposable DATABASE on the loopback server with COMMITTED data and as many
// connections as a test wants. The rollback-only fixture above cannot show a race (a second session cannot see
// uncommitted rows). Mirrors src/lib/norma/stress/db.ts: create database, clone the schema of the source database
// with pg_dump | psql (read-only on the source), apply the migration chain, drop at the end.
// ---------------------------------------------------------------------------------------------------------------
export type ConcurrentFixture = {
  readonly name: string;
  readonly url: string;
  /** Autocommit table-owner connection for observation and operator-style writes. */
  readonly owner: Client;
  /** A fresh connection (ended by close()). */
  connect(): Promise<Client>;
  /** Run `fn` on its own connection inside begin/commit (committed data). */
  seed<T>(fn: (db: Client) => Promise<T>): Promise<T>;
  /** Move the SQL clock seam (norma_private.fn_norma_wallclock reads public.zz_test_clock). */
  setClock(iso: string): Promise<void>;
  /** Delete every norma_call_request so capacity counts start from zero (triggers off, disposable database only). */
  resetRequests(): Promise<void>;
  close(): Promise<void>;
};

const TEST_CLOCK_SQL = `
create table public.zz_test_clock (singleton boolean primary key default true check (singleton), at timestamptz not null);
insert into public.zz_test_clock (at) values ('2030-01-07T17:00:00Z');
create or replace function norma_private.fn_norma_wallclock() returns timestamptz language sql volatile as $w$ select at from public.zz_test_clock $w$;
`;

export async function openConcurrentFixture(connectionString: string): Promise<ConcurrentFixture> {
  const base = requireLoopbackPostgresUrl(connectionString);
  findQueueMigration(); // RED: fail before creating anything
  const name = `q_${randomBytes(5).toString("hex")}`;
  const withDb = (db: string) => {
    const u = new URL(base);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const url = withDb(name);
  const admin = new Client({ connectionString: base });
  const clients: Client[] = [];
  let owner: Client | undefined;
  let created = false;
  const teardown = async () => {
    await Promise.all(clients.splice(0).map((c) => c.end().catch(() => {})));
    if (owner) await owner.end().catch(() => {});
    if (created) await admin.query(`drop database if exists ${name} with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  };
  const connect = async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    clients.push(c);
    return c;
  };
  try {
    await admin.connect();
    await admin.query(`create database ${name}`);
    created = true;
    const dump = execFileSync("pg_dump", ["--schema-only", "--no-owner", base], { maxBuffer: 256 * 1024 * 1024 });
    // No ON_ERROR_STOP (same as src/lib/norma/stress/db.ts): the Supabase platform objects in the dump (realtime.list_changes' SET log_min_messages,
    // ALTER DEFAULT PRIVILEGES FOR supabase_admin, pg_reload_conf / pg_stat_statements_reset grants) cannot be replayed by the postgres role. Every
    // OTHER error still fails the clone, so a real schema/constraint/grant problem in public/auth/storage is never swallowed.
    const load = spawnSync("psql", ["-q", "-X", "-d", url], { input: dump, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
    const PLATFORM_NOISE = /realtime\.list_changes|grant options cannot be granted back to your own grantor|permission denied for function (pg_reload_conf|pg_stat_statements_reset)|permission denied to change default privileges|permission denied to set parameter "log_min_messages"/;
    const cloneErrors = String(load.stderr).split("\n").filter((l) => /\bERROR:/.test(l) && !PLATFORM_NOISE.test(l));
    if (load.error || load.status !== 0 || cloneErrors.length) throw new Error(`schema clone into ${name} failed (psql exit ${load.status ?? "n/a"}): ${load.error?.message ?? cloneErrors.slice(0, 5).join(" | ") ?? String(load.stderr).slice(0, 2000)}`);
    owner = new Client({ connectionString: url });
    await owner.connect();
    if (await queueAlreadyApplied(owner)) {
      // Full-chain source: the clone already has every migration; schema-only dumps drop seed rows, so copy the queue/Norma seed tables' data.
      const seed = execFileSync("pg_dump", ["--data-only", "--no-owner", "-t", "public.norma_state_timezones", "-t", "public.norma_queue_control", "-t", "public.norma_retry_admission", base], { maxBuffer: 64 * 1024 * 1024 });
      const loaded = spawnSync("psql", ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-d", url], { input: seed, encoding: "utf8" });
      if (loaded.error || loaded.status !== 0) throw new Error(`seed copy into ${name} failed: ${loaded.error?.message ?? String(loaded.stderr).slice(0, 500)}`);
    } else {
      await applyQueueChain(owner); // autocommit: each migration is committed
    }
    await owner.query(TEST_CLOCK_SQL);
  } catch (error) {
    await teardown();
    throw error;
  }
  const o = owner;
  return {
    name,
    url,
    owner: o,
    connect,
    async seed(fn) {
      const c = await connect();
      try {
        await c.query("begin");
        const r = await fn(c);
        await c.query("commit");
        return r;
      } catch (e) {
        await c.query("rollback").catch(() => {});
        throw e;
      }
    },
    async setClock(iso) {
      await o.query("update public.zz_test_clock set at = $1::timestamptz", [iso]);
    },
    async resetRequests() {
      await o.query("begin");
      try {
        await o.query("set local session_replication_role = replica");
        await o.query("delete from public.norma_call_requests");
        await o.query("commit");
      } catch (e) {
        await o.query("rollback").catch(() => {});
        throw e;
      }
    },
    close: teardown,
  };
}
