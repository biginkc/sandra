import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { checkInvariants } from "./invariants";
import { rng } from "./trace";

/**
 * PENDING JARRAD'S DECISION: "cancel review task on DNC-locked lead".
 *
 * This is the deterministic record of a known gap. It asserts TODAY'S behaviour
 * and is deliberately separate from the stochastic stress/soak runs (whose
 * invariant excuses this case so that random runs stay readable; this test is
 * what keeps the case visible).
 *
 * Sequence:
 *   1. A request escalates to needs_review and its "needs review" task opens.
 *   2. The lead is then do-not-contact locked (property lock, or the contact's
 *      do_not_contact flag; a registry-only entry does NOT reproduce it, because
 *      only those two make the task guard raise).
 *   3. A no_answer or not_interested webhook completes the request.
 *
 * Today: the request completes, but the review task stays OPEN. Closing it
 * raises DNC_LOCKED from the task guard, and fn_norma_complete_call swallows
 * that error so the completion itself still lands.
 *
 * Two candidate desired behaviours (neither is chosen, the guard is NOT changed):
 *   (a) the task stays open (what is asserted below): a human closes it by hand;
 *   (b) the DNC task guard allows status -> 'cancelled' for this one system close,
 *       so the review task is cancelled when the request settles.
 * If (b) is chosen this test is flipped to expect 'cancelled' and the invariant
 * excuse in invariants.ts (TODO: pending decision: cancel review task on
 * DNC-locked lead) is removed.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(91));
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;
const requestOf = async (property: string) => (await q("select * from public.norma_call_requests where property_id = $1 order by created_at desc limit 1", [property]))[0];
const tasksOf = async (requestId: string) => q("select id, status, title from public.tasks where source_key = $1", [`norma_call:${requestId}`]);

describe("pending decision: a review task opened before a DNC lock stays open after the request completes", () => {
  it.each([
    ["property lock", "lock", "no_answer_status"],
    ["property lock", "lock", "not_interested"],
    ["contact do-not-contact flag", "contact", "no_answer_status"],
    ["contact do-not-contact flag", "contact", "not_interested"],
  ] as const)("%s, then a %s webhook: request completes, review task is still open (today's behaviour)", async (_label, how, kind) => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind, send: "accept_timeout" });
    await h.requestCall(ctx, h.world.rep1);
    await h.advance(11 * 60_000);
    await h.reconcile();

    const parked = await requestOf(ctx.lead.property);
    expect(parked.status).toBe("needs_review");
    const before = await tasksOf(parked.id);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ status: "open" });
    expect(before[0]!.title).toMatch(/needs review/i);

    await h.dnc(ctx, how);

    const hook = await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    expect(hook.status).toBe(200);
    const settled = await requestOf(ctx.lead.property);
    expect(settled.status).toBe("completed");
    expect(["no_answer", "not_interested"]).toContain(settled.outcome);

    // The gap: the same review task, still open, on a lead nobody should call.
    const after = await tasksOf(parked.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0]!.id, status: "open" });
  });

  it("the invariant excuse covers exactly this case: a review task opened before the lock", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "no_answer_status", send: "accept_timeout" });
    await h.requestCall(ctx, h.world.rep1);
    await h.advance(11 * 60_000);
    await h.reconcile();
    const parked = await requestOf(ctx.lead.property);
    expect(parked.status).toBe("needs_review");
    const [task] = await tasksOf(parked.id);
    await h.dnc(ctx, "lock");
    expect((await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good")).status).toBe(200);
    expect((await requestOf(ctx.lead.property)).status).toBe("completed");
    expect(await tasksOf(parked.id)).toEqual([expect.objectContaining({ id: task!.id, status: "open" })]);

    // (a) The recorded trace passes, and only because of the excuse (outbox-delivery checks are out of scope: no Slack worker runs here).
    const flagged = (r: { violations: string[] }) => r.violations.filter((x) => x.startsWith("[3]") && x.includes(parked.id));
    expect(flagged(await checkInvariants(h, { settled: true }))).toEqual([]);

    const client = await h.scratch.pool.connect();
    try {
      await client.query("set session_replication_role = replica"); // bypass the DNC task guard for the fixtures below
      // (b1) Same trace, but the task is recorded as created AFTER the lock: no longer excused.
      await client.query("update stress.audit set seq = seq + 1000000 where tbl = 'tasks' and op = 'INSERT' and row_id = $1", [task!.id]);
      expect(flagged(await checkInvariants(h, { settled: true })).join("\n")).toMatch(/a task is open but this outcome needs none/);
      await client.query("update stress.audit set seq = seq - 1000000 where tbl = 'tasks' and op = 'INSERT' and row_id = $1", [task!.id]);
      expect(flagged(await checkInvariants(h, { settled: true }))).toEqual([]);
      // (b2) Same trace, but the open task is not the review task: not excused.
      await client.query("update public.tasks set title = 'Call the seller back' where id = $1", [task!.id]);
      expect(flagged(await checkInvariants(h, { settled: true })).join("\n")).toMatch(/a task is open but this outcome needs none/);
    } finally {
      await client.query("reset session_replication_role");
      client.release();
    }
  });
});
