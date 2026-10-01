import { describe, expect, it, vi } from "vitest";

import { FakeStore, makeRow } from "./test-support";
import { encodeClientState } from "./telnyx";
import { processDirectCallWebhook, type WebhookDeps } from "./webhook";

const CALL = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-01T12:00:05.000Z");

function body(type: string, leg: string | null, state: Record<string, string> | null, id = `evt-${type}-${leg}`, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    data: {
      id,
      event_type: type,
      occurred_at: NOW.toISOString(),
      payload: { call_control_id: leg, ...(state ? { client_state: encodeClientState(state) } : {}), ...extra },
    },
  });
}

function setup(rowOverrides = {}) {
  const store = new FakeStore();
  store.add(makeRow(rowOverrides));
  const dial = vi.fn(async (_p: Record<string, unknown>) => ({ callControlId: "SELLER" }));
  const hangup = vi.fn(async (_leg: string, _cmd: string) => undefined);
  const deps: WebhookDeps = { store, dial, hangup, now: () => NOW, report: vi.fn() };
  return { store, dial, hangup, deps };
}

describe("processDirectCallWebhook", () => {
  it("dials the seller once when the browser leg answers", async () => {
    const { store, dial, deps } = setup();
    const out = await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }), deps);
    expect(out.result).toBe("processed");
    expect(dial).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledWith(expect.objectContaining({ to: "+15550001111", linkTo: "browser-leg", bridgeOnAnswer: true, bridgeIntent: false }));
    expect(dial.mock.calls[0][0]).not.toHaveProperty("parkAfterUnbridge");
    expect(store.calls.get(CALL)).toMatchObject({ status: "seller_dialing", seller_leg_id: "SELLER" });
  });

  it("does no work for a duplicate event", async () => {
    const { dial, deps } = setup();
    const raw = body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }, "same-id");
    await processDirectCallWebhook(raw, deps);
    const second = await processDirectCallWebhook(raw, deps);
    expect(second.result).toBe("duplicate");
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it("stores events for unknown calls and never controls them", async () => {
    const { store, dial, hangup, deps } = setup();
    const out = await processDirectCallWebhook(body("call.answered", "someone-elses-leg", null), deps);
    expect(out.result).toBe("stored_only");
    expect(store.events.size).toBe(1);
    expect(dial).not.toHaveBeenCalled();
    expect(hangup).not.toHaveBeenCalled();
    // A forged client_state naming our call but a conflicting leg id is also ignored.
    const forged = await processDirectCallWebhook(body("call.answered", "other-leg", { directCallId: CALL, role: "browser" }, "forged"), deps);
    expect(forged.result).toBe("processed");
    expect(dial).not.toHaveBeenCalled();
    expect(hangup).not.toHaveBeenCalled();
  });

  it("does not dial and hangs up on a stale browser answer", async () => {
    const { store, dial, hangup, deps } = setup({ created_at: "2026-10-01T11:58:00.000Z" });
    await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }), deps);
    expect(dial).not.toHaveBeenCalled();
    expect(hangup).toHaveBeenCalledWith("browser-leg", expect.any(String));
    expect(store.calls.get(CALL)?.status).toBe("failed");
  });

  it("connects when the seller answers (seller leg id learned from client_state)", async () => {
    const { store, deps } = setup({ status: "seller_dialing" });
    await processDirectCallWebhook(body("call.answered", "SELLER", { directCallId: CALL, role: "seller" }), deps);
    expect(store.calls.get(CALL)).toMatchObject({ status: "connected", seller_leg_id: "SELLER" });
  });

  it("hangs up the other leg and ends the call when either side hangs up", async () => {
    const { store, hangup, deps } = setup({ status: "connected", seller_leg_id: "SELLER", connected_at: "2026-10-01T12:00:01.000Z" });
    await processDirectCallWebhook(body("call.hangup", "SELLER", { directCallId: CALL, role: "seller" }, "h1", { hangup_cause: "normal_clearing" }), deps);
    expect(hangup).toHaveBeenCalledWith("browser-leg", expect.any(String));
    expect(store.calls.get(CALL)).toMatchObject({ status: "ended", hangup_cause: "normal_clearing" });
  });

  it("fails the call and drops the browser leg when the seller dial times out (never re-dials)", async () => {
    const { store, dial, hangup, deps } = setup();
    const { TelnyxApiError } = await import("./telnyx");
    dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx request timed out.", "unknown", null));
    await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }), deps);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(store.calls.get(CALL)).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown" });
    expect(hangup).toHaveBeenCalledWith("browser-leg", expect.any(String));
  });

  it("hangs up a seller leg created after the call already ended", async () => {
    const { store, dial, hangup, deps } = setup();
    dial.mockImplementationOnce(async () => {
      store.calls.set(CALL, { ...store.calls.get(CALL)!, status: "ended" });
      return { callControlId: "LATE" };
    });
    await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }), deps);
    expect(hangup).toHaveBeenCalledWith("LATE", expect.any(String));
  });

  it("propagates database failures so the route can answer 500", async () => {
    const { store, deps } = setup();
    store.failEventInsert = true;
    await expect(processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }), deps)).rejects.toThrow("db down");
  });

  it("reprocesses a duplicate whose first attempt never finished", async () => {
    const { store, dial, deps } = setup();
    store.events.set("same-id", { directCallId: CALL, processed: false, type: "call.answered" });
    await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }, "same-id"), deps);
    expect(dial).toHaveBeenCalledTimes(1);
  });
});
