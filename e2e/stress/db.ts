import pg from "pg";

import { ciDatabaseUrl, handleTarget } from "../support/my-leads-close-fixture";
import type { StressConfig } from "./config";
import { assertFreshCounts, assertOnlyHarnessData, LaneRefusal } from "./guards";

export type Db = pg.Pool;

/** One pool, opened only after the lane guards passed, and re-checked to be configured for loopback. */
export function openDb(cfg: StressConfig): Db {
  const url = ciDatabaseUrl({ ...process.env, E2E_CI_SUPABASE_DB_URL: cfg.dbUrl });
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  if (handleTarget(pool) !== "loopback") {
    void pool.end();
    throw new LaneRefusal("DB_HANDLE_NOT_LOOPBACK", "the pool is not configured for a loopback host.");
  }
  return pool;
}

export async function assertFreshDatabase(db: Db, cfg: StressConfig): Promise<void> {
  const r = await db.query<{ properties: string; untagged: string }>(
    "select count(*)::text as properties, count(*) filter (where address not like $1)::text as untagged from public.properties",
    [`${cfg.runTag}%`],
  );
  assertFreshCounts({ properties: Number(r.rows[0]!.properties), untaggedProperties: Number(r.rows[0]!.untagged) }, cfg.runTag);
}

/** Run BEFORE any reset: the database must hold only harness leads (any run tag). */
export async function assertOnlyHarnessRows(db: Db): Promise<void> {
  const r = await db.query<{ properties: string; foreign: string }>("select count(*)::text as properties, count(*) filter (where address not like 'STRESS-%')::text as foreign from public.properties");
  assertOnlyHarnessData({ properties: Number(r.rows[0]!.properties), nonHarnessProperties: Number(r.rows[0]!.foreign) });
}

/** One transaction as service_role (the outbox/cron functions require that claim). */
export async function asService<T>(db: Db, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("select set_config('request.jwt.claim.role','service_role',true)");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** One transaction as the authenticated member (JWT sub claim), the way the app's server actions call RPCs. */
export async function asRep<T>(db: Db, userId: string, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    await c.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await c.query("set local role authenticated");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export type PgError = Error & { code?: string };
export const errCode = (e: unknown): string => String((e as PgError).code ?? (e as Error).message ?? e);
