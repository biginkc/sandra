import { describe, expect, it, vi } from "vitest";

import { routingV2ClaimDripSend, routingV2TickGate } from "./tick-gate";

function client(opts: { key: string | null; check?: string; slotWindow?: string | null }) {
  const rpc = vi.fn(async () => ({ data: opts.check ?? "ok", error: null }));
  const from = vi.fn((table: string) => {
    const row = table === "sequences" ? { routing_v2_key: opts.key } : { slot_window: opts.slotWindow ?? null };
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
    return chain;
  });
  return { c: { from, rpc } as never, rpc, from };
}

const base = {
  enrollmentId: "e1",
  sequenceId: "s1",
  stepId: "st1",
  actionType: "send_sms",
  templateBody: "at {{slot_time}} today",
  propertyState: "MO",
};

describe("routingV2TickGate", () => {
  it("legacy drips pass straight through: no RPC, no step read", async () => {
    const { c, rpc, from } = client({ key: null });
    expect(await routingV2TickGate(c, base)).toEqual({ kind: "legacy" });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("v2: a failed send-time check blocks the send", async () => {
    const { c } = client({ key: "book_appointment", check: "flag_off" });
    expect(await routingV2TickGate(c, base)).toEqual({ kind: "blocked", reason: "flag_off" });
  });

  it("v2 booking step: fills the slot time in the seller's zone", async () => {
    const { c } = client({ key: "book_appointment" });
    const now = new Date("2026-10-14T18:07:00Z"); // 13:07 CDT
    expect(await routingV2TickGate(c, { ...base, now })).toEqual({ kind: "send", slotLabel: "3:15" });
  });

  it("v2 booking step: too late -> waits for the next morning", async () => {
    const { c } = client({ key: "book_appointment", slotWindow: "morning" });
    const now = new Date("2026-10-14T18:07:00Z");
    expect(await routingV2TickGate(c, { ...base, now })).toEqual({
      kind: "wait",
      nextRunAt: new Date("2026-10-15T13:00:00.000Z"),
    });
  });

  it("v2 non-booking step: sends with no slot", async () => {
    const { c } = client({ key: "price_too_high" });
    expect(await routingV2TickGate(c, { ...base, templateBody: "Hey, Mel here." })).toEqual({ kind: "send", slotLabel: null });
  });

  it("v2: an RPC error is an error (nothing written), not a block", async () => {
    const { c } = client({ key: "book_appointment" });
    (c as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await routingV2TickGate(c, base)).toEqual({ kind: "error", message: "routing_v2_send_check_failed: boom" });
  });
});

describe("routingV2ClaimDripSend", () => {
  it("ok / refusal / error", async () => {
    const rpc = vi.fn();
    const c = { rpc } as never;
    rpc.mockResolvedValueOnce({ data: "ok", error: null });
    expect(await routingV2ClaimDripSend(c, "e1", "r1")).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("routing_v2_claim_drip_send", { p_enrollment_id: "e1", p_step_run_id: "r1" });
    rpc.mockResolvedValueOnce({ data: "not_active", error: null });
    expect(await routingV2ClaimDripSend(c, "e1", "r1")).toEqual({ ok: false, reason: "not_active", error: false });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    expect(await routingV2ClaimDripSend(c, "e1", "r1")).toEqual({ ok: false, reason: "routing_v2_claim_failed: x", error: true });
  });
});
