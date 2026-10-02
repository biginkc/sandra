import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { rng, sleep } from "./trace";

/**
 * Lock-order regressions found by the stress gate. Each interleaving is forced
 * with a delay trigger (installed by the harness in the scratch database only):
 * a connection that sets stress.delay_ms sleeps inside its row update, after
 * the row is locked and before the next lock, which is exactly the window the
 * old lock order deadlocked in. Without the fix migration these fail with
 * "deadlock detected" or DNC_LOCKED.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(33));
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;
const requestOf = async (property: string) => (await q("select * from public.norma_call_requests where property_id = $1 order by created_at desc limit 1", [property]))[0];
const deadlocks = () => h.trace.events.filter((e) => (e.detail as { code?: string } | undefined)?.code === "40P01");

/** Run SQL on its own connection with a delay trigger armed (after the row lock, before the next lock). */
async function delayed<T>(on: "request" | "enrollment", ms: number, run: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await h.scratch.pool.connect();
  const guc = `stress.delay_${on}_ms`;
  try {
    await c.query(`set ${guc} = ${Math.floor(ms)}`);
    return await run(c);
  } finally {
    await c.query(`reset ${guc}`).catch(() => undefined);
    c.release();
  }
}

describe("one lock order: request -> enrollments -> property", () => {
  it("a reply holding the enrollment row does not deadlock a new request for the same lead", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    const e = ctx.lead.enrollments[0]!;
    // A: the reply path's enrollment update (locks the row, then the property inside its guard trigger).
    const reply = delayed("enrollment", 600, (c) => c.query("update public.sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply', updated_at = now() where id = $1", [e]));
    await sleep(150);
    const press = h.requestCall(ctx, h.world.rep1, { actor: "lock-order-press" });
    const [, res] = await Promise.all([reply, press]);
    expect(deadlocks()).toEqual([]);
    expect(res.ok).toBe(true);
    // The reply kept the pause it recorded; the request did not overwrite it.
    expect((await q("select pause_reason from public.sequence_enrollments where id = $1", [e]))[0].pause_reason).toBe("inbound_reply");
  });

  it("a completing call and a reply on the same lead do not deadlock (not_interested writes the property)", async () => {
    const ctx = await h.lead({ enrollments: ["paused:call_in_progress"] }, { kind: "not_interested" });
    await h.requestCall(ctx, h.world.rep1);
    const e = ctx.lead.enrollments[0]!;
    const reply = delayed("enrollment", 600, (c) => c.query("update public.sequence_enrollments set pause_reason = 'inbound_reply', updated_at = now() where id = $1", [e]));
    await sleep(150);
    const hook = h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    const [, res] = await Promise.all([reply, hook]);
    expect(deadlocks()).toEqual([]);
    expect(res.status).toBe(200);
    expect((await requestOf(ctx.lead.property)).status).toBe("completed");
  });

  it("a new request while the previous call's completion is mid-flight waits for it instead of deadlocking", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "not_interested" });
    await h.requestCall(ctx, h.world.rep1);
    const first = await requestOf(ctx.lead.property);
    // X: the completion, slowed right after it updates the request row.
    const complete = delayed("request", 700, (c) =>
      c.query("select public.fn_norma_complete_call($1, $2, 'not_interested', '{}'::jsonb) as r", [first.id, first.bland_call_id]),
    );
    await sleep(200);
    const press = h.requestCall(ctx, h.world.rep2, { actor: "lock-order-press2" });
    const [done, res] = await Promise.all([complete, press]);
    expect(deadlocks()).toEqual([]);
    expect(done.rows[0].r.result).toBe("applied");
    // The lead is now not_interested, so the second request is blocked, not errored.
    expect(res).toMatchObject({ ok: false });
    expect((res as { code: string }).code).not.toBe("error");
  });
});

describe("a do-not-contact lock cannot land between a read and the write that depends on it", () => {
  // X reads the lead as unlocked, then updates an enrollment (slowed after its row lock). A DNC lock that
  // lands in that window used to make the enrollment guard raise DNC_LOCKED: the webhook answered 500.
  it.each(["paused:call_in_progress", "drip created in the check-then-write gap"] as const)("completion (%s) and a DNC lock racing: the completion applies, then the lock", async (seed) => {
    const gap = seed.startsWith("drip");
    const ctx = await h.lead({ enrollments: gap ? [] : ["paused:call_in_progress"] }, { kind: "reached" });
    await h.requestCall(ctx, h.world.rep1);
    if (gap) {
      await q("insert into public.sequence_enrollments(org_id, sequence_id, property_id, contact_id, status, next_run_at) values ($1, $2, $3, $4, 'active', now())", [h.world.org, h.world.sequences[0], ctx.lead.property, ctx.lead.contact]);
    }
    const request = await requestOf(ctx.lead.property);
    const complete = delayed("enrollment", 700, (c) => c.query("select public.fn_norma_complete_call($1, $2, 'reached_no_callback', '{}'::jsonb) as r", [request.id, request.bland_call_id]));
    await sleep(200);
    const lock = h.dnc(ctx, "lock");
    const [done] = await Promise.all([complete, lock]);
    expect(done.rows[0].r.result).toBe("applied");
    expect((await requestOf(ctx.lead.property)).status).toBe("completed");
    expect((await q("select is_dnc_locked from public.properties where id = $1", [ctx.lead.property]))[0].is_dnc_locked).toBe(true);
  });
});
