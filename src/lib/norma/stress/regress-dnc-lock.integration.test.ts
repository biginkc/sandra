import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { rng } from "./trace";

/**
 * Regression tests for real bugs the stress gate found. Each one failed before
 * its fix (the commit message of each fix says which).
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(7));
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;
const requestOf = async (property: string) => (await q("select * from public.norma_call_requests where property_id = $1 order by created_at desc limit 1", [property]))[0];
const tasksOf = async (requestId: string) => q("select * from public.tasks where source_key = $1", [`norma_call:${requestId}`]);

describe("a DNC lock landing while a call is in flight (tasks on a locked lead are read-only)", () => {
  it.each(["callback", "reached", "wrong_number", "no_answer_status", "not_interested"] as const)(
    "%s: the late webhook still completes the request; no task is written to the locked lead",
    async (kind) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind });
      const res = await h.requestCall(ctx, h.world.rep1);
      expect(res).toMatchObject({ ok: true, code: "calling" });
      await h.dnc(ctx, "lock");
      const call = h.bland.callForNumber(ctx.lead.phone)!;
      const hook = await h.bland.webhook(call, "good");
      expect(hook.status).toBe(200);
      expect(hook.body.status).toBe("applied");
      const request = await requestOf(ctx.lead.property);
      if (kind === "no_answer_status") {
        // Call twice: the DNC lock landed before the retry, whose dial-time recheck refuses it. The
        // request ends rejected (first call on record, nothing dialled again), no task, drip stays opted out.
        expect(request.status).toBe("dispatch_rejected");
        expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
        expect(await tasksOf(request.id)).toHaveLength(0);
        expect((await q("select status from public.sequence_enrollments where id = $1", [ctx.lead.enrollments[0]]))[0].status).toBe("opted_out");
        return;
      }
      expect(request.status).toBe("completed");
      expect(await tasksOf(request.id)).toHaveLength(0);
      // The outbox row exists, so Slack still tells the team what happened.
      expect(await q("select 1 from public.norma_notifications where request_id = $1", [request.id])).toHaveLength(1);
      // The drip stays opted out.
      expect((await q("select status from public.sequence_enrollments where id = $1", [ctx.lead.enrollments[0]]))[0].status).toBe("opted_out");
    },
  );

  it("escalation to needs_review still works on a locked lead (no review task can be written)", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", send: "accept_timeout" });
    await h.requestCall(ctx, h.world.rep1);
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatch_unknown");
    await h.dnc(ctx, "lock");
    await h.advance(11 * 60_000);
    await h.reconcile();
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("needs_review");
    expect(await tasksOf(request.id)).toHaveLength(0);
  });

  it("a review task opened before the lock does not break the late completion", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "reached", send: "accept_timeout" });
    await h.requestCall(ctx, h.world.rep1);
    await h.advance(11 * 60_000);
    await h.reconcile();
    const parked = await requestOf(ctx.lead.property);
    expect(parked.status).toBe("needs_review");
    expect(await tasksOf(parked.id)).toHaveLength(1);
    await h.dnc(ctx, "lock");
    const hook = await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    expect(hook.status).toBe(200);
    expect((await requestOf(ctx.lead.property)).status).toBe("completed");
  });
});
