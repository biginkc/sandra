import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Harness } from "./harness";
import { rng } from "./trace";

/**
 * The legacy claim stays disabled (20261009010000_norma_legacy_claim_disable) and the queue runtime sends through the v2 claim.
 * Schema half: fn_norma_claim_dispatch returns false and writes nothing, with signature, owner, grants and search_path identical
 * to the pre-disable function. Runtime half: the button path (requestNormaCallCore -> dispatchNormaCall) dials once through v2 and
 * never through the legacy claim. (The stage-time version of this file asserted the OLD runtime's in_flight -> dispatch_rejected
 * path; that runtime is gone once this PR deploys.)
 */
// Reference chain = main without BOTH cutover schemas (stage 2 is stacked on stage 1).
const LEGACY_CLAIM = "20261009010000_norma_legacy_claim_disable.sql,20261009010100_norma_call_queue.sql";
const FN = "public.fn_norma_claim_dispatch(uuid,integer)";
const FN_META_SQL = `
  select p.prosecdef, p.proisstrict, p.provolatile, p.proretset, p.proconfig, p.proacl::text as acl,
         pg_get_userbyid(p.proowner) as owner, pg_get_function_arguments(p.oid) as args,
         pg_get_function_result(p.oid) as result, p.prosrc
    from pg_proc p where p.oid = '${FN}'::regprocedure`;

let h: Harness;
let legacyDrop: (() => Promise<void>) | null = null;
let legacyMeta: Record<string, unknown>;

beforeAll(async () => {
  // The runtime fails closed without queue limits (the workflow supplies the same test values).
  vi.stubEnv("NORMA_QUEUE_MAX_CONCURRENT", "1000");
  vi.stubEnv("NORMA_QUEUE_DAILY_CAP", "100000");
  vi.stubEnv("NORMA_QUEUE_CAP_TZ", "America/Chicago");
  h = await Harness.create(rng(101));
  // Reference: the same chain WITHOUT stage 1, built through the harness's own exclusion switch.
  vi.stubEnv("NORMA_STRESS_EXCLUDE_MIGRATIONS", LEGACY_CLAIM);
  vi.resetModules();
  const legacyDb = await import("./db");
  const legacy = await legacyDb.createScratchDb();
  legacyDrop = legacy.drop;
  // The reference must be genuinely pre-disable in EVERY config. Where the source already holds the full chain the exclusion
  // switch cannot remove 20261009010000 from the clone, so put the original definition back from the migration that last
  // defined it (20261008090100, the same block the forward-recovery file restores), then refuse to continue unless the
  // reference really has the original body: the comparison below can never pass against a reference that is itself disabled.
  const original = readFileSync(path.join(process.cwd(), "supabase/migrations/20261008090100_norma_retry_next_step_union_reviewed.sql"), "utf8");
  const block = /create or replace function public\.fn_norma_claim_dispatch\(p_request_id uuid, p_expected_attempt integer default null\)[\s\S]*?grant execute on function public\.fn_norma_claim_dispatch\(uuid, integer\) to service_role;/i.exec(original);
  if (!block) throw new Error("legacy-claim reference: original fn_norma_claim_dispatch block not found in 20261008090100");
  const isDisabled = async () => /return false/i.test(String((await legacy.pool.query(FN_META_SQL)).rows[0].prosrc));
  if (await isDisabled()) await legacy.pool.query(block[0]);
  if (await isDisabled()) throw new Error("legacy-claim reference still has the disabled body: the pre-disable comparison would be vacuous");
  const referenceBody = String((await legacy.pool.query(FN_META_SQL)).rows[0].prosrc);
  if (!/update public\.norma_call_requests/i.test(referenceBody)) throw new Error("legacy-claim reference does not look like the original claim");
  legacyMeta = (await legacy.pool.query(FN_META_SQL)).rows[0];
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await legacyDrop?.();
  await h?.close();
});

const open = (r: unknown) => (r as { ok?: boolean }).ok;

async function snapshot(ctxProperty: string) {
  const p = h.scratch.pool;
  const q = async (sql: string, args: unknown[] = []) => JSON.stringify((await p.query(sql, args)).rows);
  return {
    requests: await q("select * from public.norma_call_requests order by id"),
    pauses: await q("select * from public.norma_enrollment_pauses order by to_jsonb(norma_enrollment_pauses)::text"),
    enrollments: await q("select * from public.sequence_enrollments where property_id = $1 order by id", [ctxProperty]),
    tasks: await q("select * from public.tasks where source_key like 'norma_call:%' order by id"),
    auditSeq: (await p.query("select coalesce(max(seq), 0)::int as n from stress.audit")).rows[0].n as number,
  };
}

describe("stage 1: fn_norma_claim_dispatch is disabled and nothing else about it moved", () => {
  it("returns false and writes nothing, for a live requested row, a wrong attempt and an unknown id", async () => {
    const ctx = await h.lead({ enrollments: ["active"] });
    const made = await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
    const requestId = (made as { requestId?: string }).requestId ?? (await h.scratch.pool.query("select id from public.norma_call_requests where property_id=$1", [ctx.lead.property])).rows[0].id;
    const before = await snapshot(ctx.lead.property);
    expect(JSON.parse(before.requests).find((r: { id: string }) => r.id === requestId).status).toBe("requested");

    const p = h.scratch.pool;
    for (const args of [[requestId, null], [requestId, 1], [requestId, 2], ["00000000-0000-4000-8000-000000000000", null]]) {
      const r = await p.query(`select public.fn_norma_claim_dispatch($1::uuid, $2::integer) as v`, args);
      expect(r.rows[0].v).toBe(false);
    }
    expect(await snapshot(ctx.lead.property)).toEqual(before);
  });

  it("still refuses a non-service caller (the role check was kept)", async () => {
    const c = await h.scratch.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local \"request.jwt.claim.role\" = 'authenticated'");
      await expect(c.query("select public.fn_norma_claim_dispatch(gen_random_uuid(), null)")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("keeps signature, owner, security definer, search_path, volatility and grants identical to the pre-disable function; only the body differs", async () => {
    const now = (await h.scratch.pool.query(FN_META_SQL)).rows[0];
    const { prosrc: nowBody, ...nowRest } = now;
    const { prosrc: legacyBody, ...legacyRest } = legacyMeta as { prosrc: string };
    expect(nowRest).toEqual(legacyRest);
    expect(nowBody).not.toEqual(legacyBody);
    expect(String(nowBody)).toMatch(/return false/i);
    expect(String(legacyBody)).not.toMatch(/return false/i);
    for (const role of ["anon", "authenticated"]) {
      expect((await h.scratch.pool.query(`select has_function_privilege('${role}', '${FN}', 'execute') as v`)).rows[0].v).toBe(false);
    }
    expect((await h.scratch.pool.query(`select count(*)::int as n from aclexplode((select proacl from pg_proc where oid = '${FN}'::regprocedure)) a where a.grantee = 0`)).rows[0].n).toBe(0);
    expect((await h.scratch.pool.query(`select has_function_privilege('service_role', '${FN}', 'execute') as v`)).rows[0].v).toBe(true);
  });
});

describe("the button path sends through v2, never the legacy claim", () => {
  it("one call is dialled and bound; the legacy claim still says no for that very request and changes nothing", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", webhooksBeforeResponse: 0 });
    const sendsBefore = h.bland.sends.length;
    const reportsBefore = h.reports.length;

    const res = await h.requestCall(ctx, h.world.rep1);
    expect(res).toMatchObject({ ok: true, code: "calling" });
    expect(h.bland.sends.length).toBe(sendsBefore + 1);

    const row = (await h.scratch.pool.query("select id, status, bland_call_id, send_attempted_at, queue_entry_id from public.norma_call_requests where property_id=$1", [ctx.lead.property])).rows[0];
    expect(row.status).toBe("dispatched");
    expect(row.bland_call_id).toBeTruthy();
    expect(row.send_attempted_at).not.toBeNull();
    expect(row.queue_entry_id).toBeNull();

    const before = await snapshot(ctx.lead.property);
    expect((await h.scratch.pool.query("select public.fn_norma_claim_dispatch($1::uuid, null) as v", [row.id])).rows[0].v).toBe(false);
    expect(await snapshot(ctx.lead.property)).toEqual(before);
    expect(h.bland.sends.length).toBe(sendsBefore + 1);

    await h.finish(ctx);
    expect((await h.scratch.pool.query("select status from public.norma_call_requests where id=$1", [row.id])).rows[0].status).toBe("completed");
    expect(h.reports.slice(reportsBefore)).toEqual([]);
  });
});
