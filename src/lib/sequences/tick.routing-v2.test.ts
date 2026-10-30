import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendSmsToContact } from "@/lib/messaging/send";

import { processEnrollmentTick } from "./tick";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: vi.fn() }));

const BOOKING_BODY =
  "Hey, Mel again. Our calendar is pretty full, but I can get you in at {{slot_time}} today to talk about {{property_address}}. Want it?";

// vi.fn invocation orders are global, so a probe call stamps a write in the same order as the RPCs.
const probe = vi.fn();
const writeOrder: { accepted?: number } = {};

const ENROLLMENT = {
  id: "enrollment-1",
  org_id: "org-1",
  sequence_id: "seq-v2",
  property_id: "property-1",
  contact_id: "contact-1",
  current_step_index: 0,
  enrolled_by_user_id: null,
  status: "active",
};

/**
 * In-memory boundary for a routing v2 (book_appointment) enrollment. Records every write and
 * RPC so the tests can assert what processEnrollmentTick did around the v2 gate.
 */
function fixture(opts: {
  sendCheck?: string;
  claimResult?: string;
  slotWindow?: "any" | "morning" | "afternoon";
  routingV2Key?: string | null;
  appendOptOut?: boolean;
  runWriteFails?: boolean;
  markError?: string;
  lastStep?: boolean;
  chainError?: string;
} = {}) {
  const writes: Array<{ table: string; op: string; payload: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "routing_v2_enrollment_send_check") return { data: opts.sendCheck ?? "ok", error: null };
    if (fn === "routing_v2_claim_drip_send") return { data: opts.claimResult ?? "ok", error: null };
    if (fn === "routing_v2_chain_after_completion") {
      return opts.chainError ? { data: null, error: { message: opts.chainError } } : { data: "next-enrollment", error: null };
    }
    if (fn === "routing_v2_mark_drip_claim_sent") {
      return opts.markError ? { data: null, error: { message: opts.markError } } : { data: "claim-1", error: null };
    }
    return { data: [{ outcome: "active" }], error: null };
  });
  const from = vi.fn((table: string) => {
    let op = "select";
    let payload: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const result = () => {
      const ok = (data: unknown) => ({ data, error: null });
      if (op !== "select") writes.push({ table, op, payload, filters: { ...filters } });
      if (table === "sequence_steps") {
        if ("id" in filters) return ok({ slot_window: opts.slotWindow ?? "any" });
        if (filters.step_index === 0) {
          return ok({
            id: "step-1", step_index: 0, action_type: "send_sms", template_body: BOOKING_BODY,
            template_id: null, template_category: null, target_status: null, delay_after_previous_minutes: 1440,
          });
        }
        return ok(opts.lastStep ? null : { delay_after_previous_minutes: 1440 });
      }
      if (table === "properties") {
        return ok({
          id: "property-1", status: "new_lead", state: "MO", address: "4821 Oak Ridge Dr",
          city: "Kansas City", zip: "64111", market: "KC", org_id: null, outreach_dispo: null, is_dnc_locked: false,
        });
      }
      if (table === "contacts") return ok({ first_name: "Pat", last_name: "Seller" });
      if (table === "sequences") {
        return ok({ routing_v2_key: opts.routingV2Key === undefined ? "book_appointment" : opts.routingV2Key, append_opt_out: opts.appendOptOut ?? false });
      }
      if (table === "sequence_step_runs") {
        if (op === "update" && payload.attempt_outcome === "accepted") {
          probe();
          writeOrder.accepted = probe.mock.invocationCallOrder.at(-1);
          if (opts.runWriteFails) return { data: null, error: { message: "run write failed" } };
        }
        return ok({ id: "run-1" });
      }
      if (table === "sequence_enrollments") return ok({ id: "enrollment-1" });
      throw new Error(`Unexpected table: ${table}`);
    };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.in = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.is = chain;
    builder.eq = (k: string, v: unknown) => { filters[k] = v; return builder; };
    builder.neq = (k: string, v: unknown) => { filters[`neq_${k}`] = v; return builder; };
    builder.gt = (k: string, v: unknown) => { filters[`gt_${k}`] = v; return builder; };
    builder.insert = (v: Record<string, unknown>) => { op = "insert"; payload = v; return builder; };
    builder.update = (v: Record<string, unknown>) => { op = "update"; payload = v; return builder; };
    builder.maybeSingle = builder.single = () => Promise.resolve(result());
    builder.then = (resolve: (v: ReturnType<typeof result>) => unknown) => resolve(result());
    return builder;
  });
  return { client: { from, rpc } as never, rpc, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(sendSmsToContact).mockResolvedValue({ status: "sent", messageId: "msg-1", externalId: "p-1" });
});
afterEach(() => vi.useRealTimers());

describe("processEnrollmentTick — routing v2 wiring", () => {
  it("send with slot: fills {{slot_time}} in the seller's zone, no opt-out appended, check-and-claim before the send", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z")); // 13:07 CDT (MO) -> 3:15 slot
    const { client, rpc } = fixture();
    const outcome = await processEnrollmentTick(client, ENROLLMENT);
    expect(outcome.status).not.toBe("failed");
    expect(sendSmsToContact).toHaveBeenCalledTimes(1);
    const body = vi.mocked(sendSmsToContact).mock.calls[0]![1].body;
    expect(body).toBe(
      "Hey, Mel again. Our calendar is pretty full, but I can get you in at 3:15 today to talk about 4821 Oak Ridge Dr. Want it?",
    );
    expect(body).not.toMatch(/\{\{|slot_time|STOP/);
    expect(body).not.toMatch(/at\s+today/); // never blank
    const names = rpc.mock.calls.map((c) => c[0]);
    expect(names.indexOf("routing_v2_enrollment_send_check")).toBeLessThan(names.indexOf("routing_v2_claim_drip_send"));
    expect(rpc).toHaveBeenCalledWith("routing_v2_claim_drip_send", { p_enrollment_id: "enrollment-1", p_step_run_id: "run-1" });
    // The claim is the last thing before the provider call.
    const order = (fn: string) => rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex((c) => c[0] === fn)]!;
    const sendAt = vi.mocked(sendSmsToContact).mock.invocationCallOrder[0]!;
    expect(order("routing_v2_claim_drip_send")).toBeLessThan(sendAt);
    // After the accepted send the claim is consumed.
    expect(order("routing_v2_mark_drip_claim_sent")).toBeGreaterThan(sendAt);
    expect(rpc).toHaveBeenCalledWith("routing_v2_mark_drip_claim_sent", { p_step_run_id: "run-1", p_outcome: "sent" });
  });

  it("accepted send: the claim is consumed BEFORE the run write, even when the run write fails", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client, rpc, writes } = fixture({ runWriteFails: true });
    const outcome = await processEnrollmentTick(client, ENROLLMENT);
    expect(outcome).toMatchObject({ status: "failed", message: expect.stringContaining("run write failed") });
    expect(rpc).toHaveBeenCalledWith("routing_v2_mark_drip_claim_sent", { p_step_run_id: "run-1", p_outcome: "sent" });
    const markAt = rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex((c) => c[0] === "routing_v2_mark_drip_claim_sent")]!;
    expect(markAt).toBeGreaterThan(vi.mocked(sendSmsToContact).mock.invocationCallOrder[0]!);
    expect(writes.find((w) => w.table === "sequence_step_runs" && w.payload.attempt_outcome === "accepted")).toBeTruthy();
    expect(markAt).toBeLessThan(writeOrder.accepted!);
  });

  it.each([
    ["db_error after provider acceptance", { status: "db_error", messageId: "m1", externalId: "p1", deliveryOutcome: "accepted", error: "receipt write failed" }, "sent"],
    ["db_error with an external id only", { status: "db_error", messageId: "m1", externalId: "p1", error: "receipt write failed" }, "sent"],
    ["provider_unknown", { status: "provider_unknown", messageId: "m1", error: "timeout" }, "unknown"],
    ["provider_failed, outcome unknown", { status: "provider_failed", messageId: "m1", error: "x", deliveryOutcome: "unknown" }, "unknown"],
  ] as const)("%s: the claim is closed right after the provider call (%s)", async (_label, sendResult, expected) => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    vi.mocked(sendSmsToContact).mockResolvedValue(sendResult as never);
    const { client, rpc, writes } = fixture();
    const outcome = await processEnrollmentTick(client, ENROLLMENT);
    expect(outcome.status).toBe("failed");
    expect(rpc).toHaveBeenCalledWith("routing_v2_mark_drip_claim_sent", { p_step_run_id: "run-1", p_outcome: expected });
    expect(writes).toContainEqual(expect.objectContaining({
      table: "sequence_enrollments", payload: expect.objectContaining({ pause_reason: "reconciliation_required" }),
    }));
  });

  it("provider never reached (definitive rejection / not attempted): the claim is not closed as sent", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    vi.mocked(sendSmsToContact).mockResolvedValue({ status: "provider_failed", messageId: "m1", error: "x", providerAttempted: false } as never);
    const { client, rpc } = fixture();
    await processEnrollmentTick(client, ENROLLMENT);
    expect(rpc).not.toHaveBeenCalledWith("routing_v2_mark_drip_claim_sent", expect.anything());
  });

  it("a claim-close failure after an accepted send is surfaced and held for reconciliation, not swallowed", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client, writes } = fixture({ markError: "db down" });
    const outcome = await processEnrollmentTick(client, ENROLLMENT);
    expect(outcome).toMatchObject({ status: "failed", message: expect.stringContaining("routing v2 claim close failed: db down") });
    expect(writes).toContainEqual(expect.objectContaining({
      table: "sequence_enrollments", payload: expect.objectContaining({ pause_reason: "reconciliation_required" }),
    }));
    // The accepted run is still recorded (never released for a resend).
    expect(writes).toContainEqual(expect.objectContaining({
      table: "sequence_step_runs", payload: expect.objectContaining({ attempt_outcome: "accepted" }),
    }));
  });

  it("final v2 step sent: the enrollment completes and chains (Said they'd call -> Book appointment v2)", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client, rpc, writes } = fixture({ lastStep: true, routingV2Key: "said_theyd_call" });
    expect((await processEnrollmentTick(client, ENROLLMENT)).status).toBe("sent");
    expect(writes).toContainEqual(expect.objectContaining({
      table: "sequence_enrollments", payload: expect.objectContaining({ status: "completed" }),
    }));
    expect(rpc).toHaveBeenCalledWith("routing_v2_chain_after_completion", { p_enrollment_id: "enrollment-1" });
    const order = (fn: string) => rpc.mock.invocationCallOrder[rpc.mock.calls.findIndex((c) => c[0] === fn)]!;
    expect(order("routing_v2_chain_after_completion")).toBeGreaterThan(order("routing_v2_mark_drip_claim_sent"));
  });

  it("a chain failure after the final send is reported, never turns the sent text into a failure", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client } = fixture({ lastStep: true, chainError: "boom" });
    expect((await processEnrollmentTick(client, ENROLLMENT)).status).toBe("sent");
  });

  it("legacy final step: completes exactly as before and never chains", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client, rpc } = fixture({ lastStep: true, routingV2Key: null, appendOptOut: true });
    expect((await processEnrollmentTick(client, ENROLLMENT)).status).toBe("sent");
    expect(rpc).not.toHaveBeenCalledWith("routing_v2_chain_after_completion", expect.anything());
  });

  it("wait: a slot outside the window reschedules (no claim, no send)", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z")); // 13:07 CDT; morning window already gone
    const { client, writes, rpc } = fixture({ slotWindow: "morning" });
    const outcome = await processEnrollmentTick(client, ENROLLMENT);
    expect(outcome).toEqual({
      status: "rescheduled_slot_window", enrollmentId: "enrollment-1", nextRunAt: "2026-10-15T13:00:00.000Z",
    });
    expect(sendSmsToContact).not.toHaveBeenCalled();
    expect(writes.some((w) => w.table === "sequence_step_runs")).toBe(false);
    expect(writes).toContainEqual(expect.objectContaining({
      table: "sequence_enrollments", op: "update", payload: expect.objectContaining({ next_run_at: "2026-10-15T13:00:00.000Z" }),
    }));
    expect(rpc).not.toHaveBeenCalledWith("routing_v2_claim_drip_send", expect.anything());
  });

  it("blocked at the send check: no claim, no send; a takeover reports paused", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client, writes } = fixture({ sendCheck: "person_took_over" });
    expect(await processEnrollmentTick(client, ENROLLMENT)).toEqual({
      status: "paused", enrollmentId: "enrollment-1", reason: "routing_v2_person_took_over",
    });
    expect(sendSmsToContact).not.toHaveBeenCalled();
    expect(writes.some((w) => w.table === "sequence_step_runs")).toBe(false);
  });

  it.each(["not_active", "flag_off", "missing"])("blocked %s is a skip, never a fake 'paused'", async (reason) => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client } = fixture({ sendCheck: reason });
    expect(await processEnrollmentTick(client, ENROLLMENT)).toEqual({
      status: "skipped_not_eligible", enrollmentId: "enrollment-1", stepIndex: 0, reason: `routing_v2_${reason}`,
    });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("reply wins between the gate and the send: the check-and-claim refuses, run is skipped, nothing sent", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client, writes } = fixture({ claimResult: "not_active" });
    expect(await processEnrollmentTick(client, ENROLLMENT)).toEqual({
      status: "skipped_not_eligible", enrollmentId: "enrollment-1", stepIndex: 0, reason: "routing_v2_not_active",
    });
    expect(sendSmsToContact).not.toHaveBeenCalled();
    expect(writes).toContainEqual(expect.objectContaining({
      table: "sequence_step_runs", op: "update",
      payload: expect.objectContaining({ skipped_reason: "not_eligible", attempt_outcome: "not_attempted" }),
    }));
  });

  it("legacy drips never call the v2 RPCs", async () => {
    vi.setSystemTime(new Date("2026-10-14T18:07:00Z"));
    const { client, rpc } = fixture({ routingV2Key: null, appendOptOut: true });
    await processEnrollmentTick(client, ENROLLMENT);
    expect(rpc).not.toHaveBeenCalledWith("routing_v2_enrollment_send_check", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("routing_v2_claim_drip_send", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("routing_v2_mark_drip_claim_sent", expect.anything());
  });
});
