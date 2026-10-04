import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { claimNormaDispatch } from "../rpc";
import { Harness } from "./harness";
import { rng } from "./trace";

let h: Harness;
beforeAll(async () => { h = await Harness.create(rng(611)); });
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await h?.close(); });
const q = async (sql: string, args: unknown[] = []) => (await h.scratch.pool.query(sql, args)).rows;
const row = async (id: string) => (await q("select * from public.norma_call_requests where id=$1", [id]))[0]!;
const ledger = (id: string) => q("select * from public.norma_enrollment_pauses where request_id=$1 order by enrollment_id", [id]);

// Real signed fake-provider completions and committed SQL; no provider network.
describe.each([false, true])("combined maintenance/retry ownership (protected=%s)", (protectedPause) => {
  it("keeps the retry and pauses held, then releases fencing/grace while signed completions remain available", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "no_answer_status", secondKind: "no_answer_status" });
    expect(await h.requestCall(ctx, h.world.rep1)).toMatchObject({ ok: true, code: "calling" });
    const first = h.bland.callsForNumber(ctx.lead.phone)[0]!;
    const id = (await q("select id from public.norma_call_requests where property_id=$1", [ctx.lead.property]))[0]!.id as string;
    await h.scratch.advance(10 * 60_000);
    vi.stubEnv("NORMA_MAINTENANCE_HOLD", "1");
    // Signed first completion still schedules SQL retry; ordinary dispatch holds.
    expect(await h.bland.webhook(first, "good")).toMatchObject({ status: 200, body: { status: "applied", retry: "not_claimed" } });
    if (protectedPause) await q("update public.sequence_enrollments set pause_reason='provider_failed' where id=$1", [ctx.lead.enrollments[0]]);
    const before = await row(id);
    const heldLedger = await ledger(id);
    expect(before).toMatchObject({ status: "requested", attempt: 2, bland_call_id: null, first_bland_call_id: first.callId });
    expect(Date.now() - Date.parse(before.created_at)).toBeGreaterThan(9 * 60_000);
    expect(Math.abs(Date.now() - Date.parse(before.updated_at))).toBeLessThan(5000);
    expect(heldLedger).toHaveLength(1);
    expect(heldLedger[0]).toMatchObject({ released_at: null });
    expect(await h.dispatch(id)).toEqual({ status: "not_claimed" });
    expect(await h.reconcile({ includeNeedsReview: true })).toMatchObject({ maintenanceHeld: true, scanned: 0, errors: 0 });
    expect(await row(id)).toEqual(before);
    expect(await ledger(id)).toEqual(heldLedger);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(1);
    // Invalid signatures still fail while held; signed replay has no new effects.
    expect((await h.bland.webhook(first, "bad_signature")).status).toBe(401);
    expect((await h.bland.webhook(first, "good")).body.status).toBe("replayed");
    expect(await ledger(id)).toEqual(heldLedger);
    vi.stubEnv("NORMA_MAINTENANCE_HOLD", "false");
    expect(await claimNormaDispatch(h.client("stale-attempt"), id, 1)).toBe(false);
    const grace = await h.reconcile();
    expect(grace.errors).toBe(0);
    expect(grace.waiting).toBeGreaterThan(0);
    const waiting = await row(id);
    expect(waiting).toMatchObject({ status: "requested", attempt: 2, bland_call_id: null });
    expect(Date.parse(waiting.next_check_at)).toBeGreaterThan(Date.parse(before.next_check_at));
    expect(await ledger(id)).toEqual(heldLedger);
    expect(await h.dispatch(id)).toMatchObject({ status: "dispatched" });
    const calls = h.bland.callsForNumber(ctx.lead.phone);
    expect(calls).toHaveLength(2);
    expect(await row(id)).toMatchObject({ attempt: 2, status: "dispatched", bland_call_id: calls[1]!.callId, first_bland_call_id: first.callId });
    vi.stubEnv("NORMA_MAINTENANCE_HOLD", "1");
    expect((await h.bland.webhook(calls[1]!, "good")).body.status).toBe("applied");
    expect((await h.bland.webhook(calls[1]!, "good")).body.status).toBe("replayed");
    expect(await row(id)).toMatchObject({ attempt: 2, status: "completed", outcome: "no_answer" });
    const finalLedger = await ledger(id);
    expect(finalLedger[0]!.released_at).not.toBeNull();
    const enrollment = (await q("select status,pause_reason from public.sequence_enrollments where id=$1", [ctx.lead.enrollments[0]]))[0];
    expect(enrollment).toEqual(protectedPause ? { status: "paused", pause_reason: "provider_failed" } : { status: "active", pause_reason: null });
    expect(Number((await q("select count(*) as n from public.lead_events where source_id=$1 and event_type='norma_call_completed'", [id]))[0]!.n)).toBe(1);
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
  });
});
