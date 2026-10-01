import { describe, expect, it } from "vitest";

import { nextDirectCallState, staleOutcome, type DirectCallEvent, type DirectCallRow } from "./transitions";

const CREATED = "2026-10-01T12:00:00.000Z";
const at = (secs: number) => new Date(new Date(CREATED).getTime() + secs * 1000);

function row(overrides: Partial<DirectCallRow> = {}): DirectCallRow {
  return {
    id: "call-1",
    status: "browser_connecting",
    browser_leg_id: "B",
    seller_leg_id: null,
    destination_e164: "+15550001111",
    caller_id_e164: "+15550002222",
    created_at: CREATED,
    connected_at: null,
    updated_at: CREATED,
    ...overrides,
  };
}
const ev = (type: string, id: string | null, role: "browser" | "seller" | null = null, extra: Partial<DirectCallEvent> = {}): DirectCallEvent => ({
  type,
  callControlId: id,
  role,
  occurredAt: null,
  hangupCause: null,
  ...extra,
});

describe("nextDirectCallState", () => {
  it("dials the seller bridged to the browser leg when the browser answers", () => {
    const r = nextDirectCallState(row(), ev("call.answered", "B", "browser"), at(5));
    expect(r.patch).toEqual({ status: "seller_dialing", seller_dial_state: "pending" });
    expect(r.commands).toHaveLength(1);
    const cmd = r.commands[0];
    expect(cmd).toMatchObject({
      kind: "dial_seller",
      to: "+15550001111",
      from: "+15550002222",
      linkTo: "B",
      bridgeOnAnswer: true,
      bridgeIntent: false,
      timeoutSecs: 30,
      timeLimitSecs: 7195,
      clientState: { directCallId: "call-1", role: "seller" },
    });
    expect(cmd).not.toHaveProperty("parkAfterUnbridge");
  });

  it("refuses a stale browser answer and hangs the leg up without dialing the seller", () => {
    const r = nextDirectCallState(row(), ev("call.answered", "B", "browser"), at(61));
    expect(r.patch).toMatchObject({ status: "failed", failure_reason: "browser_answer_stale", browser_hangup_pending: true });
    expect(r.commands).toEqual([]);
  });

  it("marks the call connected when the seller answers", () => {
    const r = nextDirectCallState(row({ status: "seller_dialing" }), ev("call.answered", "S", "seller", { occurredAt: "2026-10-01T12:00:09.000Z" }), at(9));
    expect(r.patch).toEqual({ status: "connected", seller_leg_id: "S", connected_at: "2026-10-01T12:00:09.000Z" });
    expect(r.commands).toEqual([]);
  });

  it("hangs up the seller when the browser hangs up mid-call, and ends the call", () => {
    const r = nextDirectCallState(
      row({ status: "connected", seller_leg_id: "S", connected_at: CREATED }),
      ev("call.hangup", "B", "browser", { hangupCause: "normal_clearing" }),
      at(30),
    );
    expect(r.patch).toMatchObject({ status: "ended", hangup_cause: "normal_clearing", browser_hangup_pending: false, seller_hangup_pending: true });
    expect(r.commands).toEqual([]);
  });

  it("hangs up the browser when the seller hangs up", () => {
    const r = nextDirectCallState(row({ status: "connected", seller_leg_id: "S", connected_at: CREATED }), ev("call.hangup", "S", "seller"), at(30));
    expect(r.patch).toMatchObject({ status: "ended", browser_hangup_pending: true, seller_hangup_pending: false });
  });

  it("fails the call when the seller never answered", () => {
    const r = nextDirectCallState(row({ status: "seller_dialing", seller_leg_id: "S" }), ev("call.hangup", "S", "seller", { hangupCause: "no_answer" }), at(40));
    expect(r.patch).toMatchObject({ status: "failed", failure_reason: "seller_not_answered", hangup_cause: "no_answer", browser_hangup_pending: true });
  });

  it("treats a hangup after an operator hangup request as a clean end", () => {
    const r = nextDirectCallState(row({ status: "ending" }), ev("call.hangup", "B", "browser"), at(3));
    expect(r.patch?.status).toBe("ended");
  });

  it("does nothing for duplicate events on a finished or already-advanced call", () => {
    expect(nextDirectCallState(row({ status: "ended" }), ev("call.hangup", "B", "browser"), at(80))).toEqual({ patch: null, commands: [] });
    expect(nextDirectCallState(row({ status: "seller_dialing" }), ev("call.answered", "B", "browser"), at(6))).toEqual({ patch: null, commands: [] });
    expect(nextDirectCallState(row({ status: "connected", seller_leg_id: "S" }), ev("call.answered", "S", "seller"), at(6))).toEqual({ patch: null, commands: [] });
  });

  it("hangs up a leg that answers after the call already ended", () => {
    const r = nextDirectCallState(row({ status: "failed" }), ev("call.answered", "B", "browser"), at(20));
    expect(r.patch).toEqual({ browser_hangup_pending: true });
    expect(r.commands).toEqual([]);
  });

  it("ignores events for legs that are not this call's", () => {
    expect(nextDirectCallState(row(), ev("call.answered", "OTHER", null), at(2))).toEqual({ patch: null, commands: [] });
    expect(nextDirectCallState(row(), ev("call.answered", "OTHER", "browser"), at(2))).toEqual({ patch: null, commands: [] });
    expect(nextDirectCallState(row(), ev("call.answered", null, "browser"), at(2))).toEqual({ patch: null, commands: [] });
  });

  it("adopts a leg id learned from client_state when the Dial response has not been stored yet", () => {
    const r = nextDirectCallState(row({ browser_leg_id: null }), ev("call.answered", "B", "browser"), at(3));
    expect(r.patch).toMatchObject({ browser_leg_id: "B", status: "seller_dialing" });
  });

  it("records bridged without changing state", () => {
    expect(nextDirectCallState(row({ status: "connected", seller_leg_id: "S" }), ev("call.bridged", "S", "seller"), at(10))).toEqual({ patch: null, commands: [] });
  });

  it("clears a leg's pending teardown when the provider confirms it hung up", () => {
    const r = nextDirectCallState(row({ status: "ended", seller_leg_id: "S", seller_hangup_pending: true }), ev("call.hangup", "S", "seller"), at(30));
    expect(r.patch).toEqual({ seller_hangup_pending: false, seller_hangup_acked_at: null });
  });

  it("never replays a pending Dial, however fresh: it is an unknown outcome and the call fails (blocker 2)", () => {
    for (const updated of [at(19).toISOString(), at(5).toISOString(), CREATED]) {
      const r = nextDirectCallState(
        row({ status: "seller_dialing", seller_dial_state: "pending", updated_at: updated }),
        ev("call.answered", "B", "browser"),
        at(20),
      );
      expect(r.commands).toEqual([]);
      expect(r.patch).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown", seller_dial_state: "unknown", browser_hangup_pending: true });
    }
  });

  it("never re-sends an unknown Dial, and a sent Dial is a no-op", () => {
    const unknown = nextDirectCallState(row({ status: "seller_dialing", seller_dial_state: "unknown" }), ev("call.answered", "B", "browser"), at(20));
    expect(unknown.commands).toEqual([]);
    expect(unknown.patch).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown", browser_hangup_pending: true });
    const sent = nextDirectCallState(row({ status: "seller_dialing", seller_dial_state: "sent" }), ev("call.answered", "B", "browser"), at(20));
    expect(sent).toEqual({ patch: null, commands: [] });
  });

  it("issues no Dial once teardown has begun (ending, pending hangup, teardown_pending, orphan)", () => {
    for (const over of [
      { status: "ending" as const },
      { browser_hangup_pending: true },
      { seller_hangup_pending: true },
      { failure_reason: "teardown_pending" },
      { orphan_hangup_leg_ids: ["X"] },
    ]) {
      const r = nextDirectCallState(row(over), ev("call.answered", "B", "browser"), at(5));
      expect(r.commands).toEqual([]);
      expect(r.patch).toEqual({ browser_hangup_pending: true });
    }
  });

  it("confirms an orphan leg when its hangup webhook arrives", () => {
    const r = nextDirectCallState(row({ status: "failed", orphan_hangup_leg_ids: ["ORPHAN"] }), ev("call.hangup", "ORPHAN", "seller"), at(30));
    expect(r).toEqual({ patch: null, commands: [], orphanConfirmed: "ORPHAN" });
  });

  it("flags a seller leg first seen on a failed call (after an unknown dial) for teardown", () => {
    const r = nextDirectCallState(row({ status: "failed", seller_dial_state: "unknown" }), ev("call.initiated", "LATE", "seller"), at(30));
    expect(r.patch).toEqual({ seller_leg_id: "LATE", seller_hangup_pending: true });
  });

  it("reports stale outcomes without ever treating time as teardown", () => {
    expect(staleOutcome(row(), at(100))).toBeNull();
    expect(staleOutcome(row(), at(151))).toBe("failed");
    expect(staleOutcome(row({ status: "ending", updated_at: CREATED }), at(61))).toBe("ended");
    expect(staleOutcome(row({ status: "connected", seller_leg_id: "S" }), at(7201 + 300))).toBe("ended");
    expect(staleOutcome(row({ status: "connected", failure_reason: "teardown_pending" }), at(5))).toBe("ended");
    expect(staleOutcome(row({ status: "ended" }), at(99999))).toBeNull();
  });
});
