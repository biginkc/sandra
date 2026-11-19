import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";

/**
 * Routing v2 DB suites (stress review A-7): every suite must pass on a FULLY migrated stack,
 * not only at its own base. A suite that re-applies or rolls back an older routing v2
 * migration first calls this INSIDE its own (rolled-back) test transaction:
 *   1. it removes routing v2 runtime rows (outbox, transitions, live evidence, claims, v2
 *      enrollments, test tags) that newer rollbacks refuse to drop over;
 *   2. it applies every routing v2 rollback NEWER than the suite's own migration, newest
 *      first, each in a savepoint (a rollback that does not apply, e.g. not installed, is
 *      skipped), so nothing newer depends on the objects the suite drops or re-creates.
 * Everything is undone by the suite's transaction rollback; the stack itself never changes.
 */
const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const ROLLBACKS = path.resolve(__dirname, "../../../supabase/rollbacks");
const strip = (s: string) => s.replace(/^\s*(begin|commit);\s*$/gim, "");

export async function unwindRoutingV2After(db: Client, version: string): Promise<string[]> {
  const purge = [
    "update public.properties set test_run_id = null where test_run_id is not null",
    "delete from public.test_send_refusals",
    "delete from public.routing_v2_outbox",
    "delete from public.routing_v2_drip_send_claims",
    "delete from public.routing_v2_reply_transitions",
    "delete from public.routing_v2_live_decisions",
    "delete from public.sequence_enrollments where routing_v2_engine = 'v2' or sequence_id in (select id from public.sequences where routing_v2_key is not null)",
  ];
  await db.query("set local session_replication_role = replica");
  for (const q of purge) {
    await db.query("savepoint unwind_purge");
    try {
      await db.query(q);
      await db.query("release savepoint unwind_purge");
    } catch {
      await db.query("rollback to savepoint unwind_purge");
    }
  }
  await db.query("set local session_replication_role = origin");
  const applied: string[] = [];
  const newer = readdirSync(ROLLBACKS)
    .filter((f) => /^\d{14}_routing_v2_.*\.sql$/.test(f) && f.slice(0, 14) > version)
    .filter((f) => readdirSync(MIGRATIONS).includes(f))
    .sort()
    .reverse();
  for (const f of newer) {
    await db.query("savepoint unwind_rb");
    try {
      await db.query(strip(readFileSync(path.join(ROLLBACKS, f), "utf8")));
      await db.query("release savepoint unwind_rb");
      applied.push(f);
    } catch {
      await db.query("rollback to savepoint unwind_rb");
    }
  }
  return applied;
}

/**
 * Shared-stack repair for the few routing v2 DB suites that must COMMIT an older migration (or its
 * rollback) because a second connection needs it: afterwards, re-apply every routing v2 migration
 * NEWER than `version`, committed and in order, so the stack ends with exactly the schema the full
 * migration chain defines (otherwise later suites on the same stack see the older bodies and
 * missing columns). Call it from the suite's afterAll with a connection that holds no open
 * transaction.
 */
export async function reapplyRoutingV2After(db: Client, version: string): Promise<string[]> {
  const newer = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}_routing_v2_.*\.sql$/.test(f) && f.slice(0, 14) > version)
    .sort();
  for (const f of newer) {
    await db.query(`begin; ${strip(readFileSync(path.join(MIGRATIONS, f), "utf8"))}; commit;`);
  }
  return newer;
}
