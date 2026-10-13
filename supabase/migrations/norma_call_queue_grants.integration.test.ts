import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

/**
 * Grant regression guard for 20261009010100_norma_call_queue.sql.
 *
 * Runs against a run-owned, full-chain DISPOSABLE database (queue migrations already applied) and only ever works inside a
 * rolled-back transaction. The queue migration must not change ANY privilege that 20261008135000 (inbound call records) set:
 * its RLS policies call norma_private.can_access_callbacks as `authenticated`, which needs USAGE on schema norma_private and
 * EXECUTE on the function.
 *
 * Baseline = the ACLs of a database built WITHOUT 20261009010000/20261009010100. They are pinned below; when
 * TEST_SUPABASE_PREQUEUE_DB_URL points at such a database, the pinned values are also checked against it live.
 */
const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const prequeueUrl = process.env.TEST_SUPABASE_PREQUEUE_DB_URL ? requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_PREQUEUE_DB_URL) : null;

const PINNED = {
  nspacl: "{postgres=UC/postgres,authenticated=U/postgres}",
  can_access_callbacks: "{postgres=X/postgres,authenticated=X/postgres}",
  associate_inbound_call: "{postgres=X/postgres,authenticated=X/postgres}",
  fn_norma_eligibility: "{postgres=X/postgres,service_role=X/postgres}",
};

async function snapshot(db: Client) {
  const q = async (sql: string) => (await db.query(sql)).rows[0]?.acl ?? null;
  return {
    nspacl: await q("select nspacl::text acl from pg_namespace where nspname = 'norma_private'"),
    can_access_callbacks: await q("select proacl::text acl from pg_proc where pronamespace = 'norma_private'::regnamespace and proname = 'can_access_callbacks'"),
    associate_inbound_call: await q("select proacl::text acl from pg_proc where pronamespace = 'norma_private'::regnamespace and proname = 'associate_inbound_call'"),
    fn_norma_eligibility: await q("select proacl::text acl from pg_proc where pronamespace = 'public'::regnamespace and proname = 'fn_norma_eligibility'"),
  };
}

let db: Client;
beforeAll(async () => {
  db = new Client({ connectionString: url });
  await db.connect();
  const applied = await db.query("select to_regclass('public.norma_queue_entries') is not null and to_regclass('public.norma_inbound_calls') is not null a");
  if (applied.rows[0].a !== true) throw new Error("full-chain database required (queue and inbound-call migrations applied)");
  await db.query("begin");
});
afterAll(async () => {
  await db?.query("rollback").catch(() => {});
  await db?.end();
});

describe("queue migration leaves pre-existing grants alone", () => {
  it("(1) norma_private schema + inbound RLS helper ACLs equal the pre-queue values", async () => {
    const now = await snapshot(db);
    expect(now).toEqual(PINNED);
    if (prequeueUrl) {
      const pre = new Client({ connectionString: prequeueUrl });
      await pre.connect();
      try {
        expect(await snapshot(pre)).toEqual(PINNED); // pinned values really are the pre-queue values
        expect(now).toEqual(await snapshot(pre));
      } finally {
        await pre.end();
      }
    }
  });

  it("(2) an org A member reads org A's inbound call through RLS and never org B's", async () => {
    const a = randomUUID(), b = randomUUID(), user = randomUUID(), owner = randomUUID();
    await db.query("savepoint grants_rls");
    try {
      await db.query("insert into auth.users(id,email) values ($1,$2),($3,$4)", [user, `${user}@example.invalid`, owner, `${owner}@example.invalid`]);
      await db.query("insert into organizations(id,name) values ($1,'Grants A'),($2,'Grants B')", [a, b]);
      await db.query("insert into memberships(user_id,org_id,role,access_status) values ($1,$2,'owner','active'),($3,$2,'member','active')", [owner, a, user]);
      await db.query(
        `insert into norma_inbound_calls(org_id,provider_call_id,from_e164,to_e164) values ($1,'grants-a','+18165551001','+18165551002'),($2,'grants-b','+18165551001','+18165551003')`,
        [a, b],
      );
      await db.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)", [user]);
      await db.query("set local role authenticated");
      const rows = (await db.query("select provider_call_id, org_id from norma_inbound_calls order by provider_call_id")).rows;
      expect(rows).toEqual([{ provider_call_id: "grants-a", org_id: a }]);
    } finally {
      await db.query("reset role").catch(() => {});
      await db.query("rollback to savepoint grants_rls");
    }
  });

  it("(3) authenticated cannot execute any queue function", async () => {
    const fns = (
      await db.query(
        `select p.oid, p.oid::regprocedure::text sig, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec, has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec
           from pg_proc p
          where (p.pronamespace = 'norma_private'::regnamespace and p.proname like 'fn\\_norma\\_%')
             or (p.pronamespace = 'public'::regnamespace and p.proname in ('fn_norma_queue_enqueue','fn_norma_queue_claim','fn_norma_create_request_v2','fn_norma_claim_dispatch_v2',
               'fn_norma_mark_sending','fn_norma_queue_settle','fn_norma_queue_pause','fn_norma_queue_resume','fn_norma_queue_cancel','fn_norma_queue_block_reason',
               'fn_norma_queue_next_slot','fn_norma_queue_next_slot_for','fn_norma_queue_apply_presend','fn_norma_queue_release_expired_leases','fn_norma_queue_sweep_blocks',
               'fn_norma_queue_sweep_replies','fn_norma_queue_pause_unknown_state','fn_norma_eligibility'))`,
      )
    ).rows;
    expect(fns.length).toBeGreaterThan(30);
    expect(fns.filter((f) => f.auth_exec || f.anon_exec).map((f) => f.sig)).toEqual([]);
    // And for real, with the schema USAGE the inbound policies rely on still in place.
    await db.query("savepoint grants_exec");
    try {
      await db.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await db.query("set local role authenticated");
      await expect(db.query("select norma_private.fn_norma_wallclock()")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("reset role").catch(() => {});
      await db.query("rollback to savepoint grants_exec");
    }
  });
});
