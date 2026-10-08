import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Harness } from "../stress/harness";
import { rng } from "../stress/trace";

/**
 * Stage 1 of the Norma queue cutover (20261009010000_norma_legacy_claim_disable) on the POST-disable schema.
 * Runs MAIN's current runtime (requestNormaCallCore, dispatchNormaCall, reconcileNormaCalls) against it, because the
 * deployed runtime is exactly what faces this schema between stage 1 and the queue runtime. The legacy stress suite
 * (which dials through the legacy claim) runs on the PRE-disable schema in its own workflow step.
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
  h = await Harness.create(rng(101));
  // Reference: the same chain WITHOUT stage 1, built through the harness's own exclusion switch.
  vi.stubEnv("NORMA_STRESS_EXCLUDE_MIGRATIONS", LEGACY_CLAIM);
  vi.resetModules();
  const legacyDb = await import("../stress/db");
  vi.unstubAllEnvs();
  const legacy = await legacyDb.createScratchDb();
  legacyDrop = legacy.drop;
  legacyMeta = (await legacy.pool.query(FN_META_SQL)).rows[0];
});
afterAll(async () => {
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

describe("stage 1: the CURRENT runtime button path against the disabled claim", () => {
  it("stays requested, never dials, then reconcile rejects it and releases the drip pauses", async () => {
    const ctx = await h.lead({ enrollments: ["active"] });
    const reportsBefore = h.reports.length;
    const sendsBefore = h.bland.sends.length;

    const res = await h.requestCall(ctx, h.world.rep1);
    // The rep sees an ordinary "call already in flight" answer; nothing throws.
    expect(open(res)).toBe(false);
    expect(res).toMatchObject({ ok: false, code: "in_flight" });

    const row = async () =>
      (await h.scratch.pool.query("select id, status, outcome, bland_call_id, dispatch_started_at from public.norma_call_requests where property_id=$1", [ctx.lead.property])).rows[0];
    const first = await row();
    expect(first.status).toBe("requested");
    expect(first.bland_call_id).toBeNull();
    expect(first.dispatch_started_at).toBeNull();

    const pauses = async () =>
      (await h.scratch.pool.query("select released_at from public.norma_enrollment_pauses where request_id = $1", [first.id])).rows;
    const held = await pauses();
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((x) => x.released_at === null)).toBe(true);
    const enrollmentStatus = async () =>
      (await h.scratch.pool.query("select status, pause_reason from public.sequence_enrollments where id = $1", [ctx.lead.enrollments[0]])).rows[0];
    expect((await enrollmentStatus()).status).toBe("paused");

    // Two minutes in: reconcile retries the dispatch, the claim still says no, the row is left waiting.
    await h.advance(2 * 60_000);
    await h.reconcile();
    expect((await row()).status).toBe("requested");
    expect((await enrollmentStatus()).status).toBe("paused");

    // Past the five-minute stranded window: rejected, pauses released, drip back to active.
    await h.advance(4 * 60_000);
    await h.reconcile();
    const done = await row();
    expect(done.status).toBe("dispatch_rejected");
    expect((await pauses()).every((x) => x.released_at !== null)).toBe(true);
    expect((await enrollmentStatus()).status).toBe("active");

    // Nothing was sent, nothing crashed.
    expect(h.bland.sends.length).toBe(sendsBefore);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(0);
    expect(h.reports.slice(reportsBefore)).toEqual([]);
  });
});
