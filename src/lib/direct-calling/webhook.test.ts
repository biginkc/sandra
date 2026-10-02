import { describe, expect, it, vi } from "vitest";

import { processDueCleanups } from "./cleanup";
import { FakeStore, makeRow } from "./test-support";
import { TelnyxApiError, encodeClientState } from "./telnyx";
import { processDirectCallWebhook, type WebhookDeps } from "./webhook";

const CALL = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-01T12:00:05.000Z");
const clock = { now: T0 };
const NOW = T0; // body() timestamps
const ENDED_422 = () => new TelnyxApiError("Telnyx returned 422: Call has already ended", "rejected", 422, { code: "90018" });

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
  clock.now = T0;
  const store = new FakeStore();
  store.clock = () => clock.now;
  store.add(makeRow(rowOverrides));
  const dial = vi.fn(async (_p: Record<string, unknown>) => ({ callControlId: "SELLER" }));
  const hangup = vi.fn(async (_leg: string, _cmd: string) => undefined);
  // Default: a leg we ask about is already dead (so a status re-check confirms it).
  const getCall = vi.fn(async (_leg: string) => ({ isAlive: false }));
  const listActiveCalls = vi.fn(async () => ({ calls: [] as Array<{ callControlId: string; clientState: Record<string, unknown> | null }>, complete: true }));
  const deps: WebhookDeps = { store, dial, hangup, getCall, listActiveCalls, now: () => clock.now, report: vi.fn(), };
  const advance = (secs: number) => (clock.now = new Date(clock.now.getTime() + secs * 1000));
  return { store, dial, hangup, getCall, listActiveCalls, deps, advance };
}

const answerBrowser = (id = "evt-answer-browser") => body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }, id);

describe("processDirectCallWebhook", () => {
  it("starts Coach only for the connected seller and retries a failed start without redialing", async () => {
    const { deps, dial, store } = setup({ status: "connected", seller_leg_id: "SELLER", connected_at: T0.toISOString() });
    const coachConnected = vi.fn().mockRejectedValueOnce(new Error("stream unavailable")).mockResolvedValue(undefined);
    deps.coachConnected = coachConnected;
    const event = body("call.bridged", "SELLER", { directCallId: CALL, role: "seller" }, "coach-bridge");
    await expect(processDirectCallWebhook(event, deps)).rejects.toThrow("stream unavailable");
    await processDirectCallWebhook(event, deps);
    await processDirectCallWebhook(event, deps);
    expect(coachConnected).toHaveBeenCalledTimes(2);
    expect(dial).not.toHaveBeenCalled();
    expect(store.calls.get(CALL)?.status).toBe("connected");
    await processDirectCallWebhook(body("call.bridged", "browser-leg", { directCallId: CALL, role: "browser" }, "browser-coach-bridge"), deps);
    expect(coachConnected).toHaveBeenCalledTimes(2);
  });

  it("dials the seller once when the browser leg answers", async () => {
    const { store, dial, deps } = setup();
    const out = await processDirectCallWebhook(answerBrowser(), deps);
    expect(out.result).toBe("processed");
    expect(dial).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledWith(expect.objectContaining({ to: "+15550001111", linkTo: "browser-leg", bridgeOnAnswer: true, bridgeIntent: false, recording: expect.objectContaining({ record: "record-from-answer", recordChannels: "dual", recordTrack: "both", recordFormat: "wav", recordMaxLength: expect.any(Number) }) }));
    expect(dial.mock.calls[0][0]).not.toHaveProperty("parkAfterUnbridge");
    expect(store.calls.get(CALL)).toMatchObject({ status: "seller_dialing", seller_leg_id: "SELLER", seller_dial_state: "sent" });
    // The seller Dial's unresolved row existed before the Dial and is resolved by the known leg.
    expect(store.openFor(CALL).filter((c) => c.kind === "unresolved_dial" && c.dial_role === "seller")).toEqual([]);
  });

  it("writes the unresolved-dial row in the same write as the pending state, before the Dial is sent", async () => {
    const { store, dial, deps } = setup();
    let during: { state: string | null | undefined; open: string[] } | null = null;
    dial.mockImplementationOnce(async () => {
      during = { state: store.calls.get(CALL)?.seller_dial_state, open: store.openFor(CALL).map((c) => `${c.kind}:${c.dial_role}`) };
      return { callControlId: "SELLER" };
    });
    await processDirectCallWebhook(answerBrowser(), deps);
    expect(during).toEqual({ state: "pending", open: ["unresolved_dial:seller"] });
  });

  it("refuses a seller Dial when the dispatch marker response exceeds its allowance", async () => {
    const { store, dial, deps } = setup();
    const mark = store.markDialStarted.bind(store);
    vi.spyOn(store, "markDialStarted").mockImplementation(async (...args) => {
      clock.now = new Date(clock.now.getTime() + 120_000);
      return mark(...args);
    });

    await processDirectCallWebhook(answerBrowser(), deps);
    expect(dial).not.toHaveBeenCalled();
    expect(store.calls.get(CALL)).toMatchObject({ status: "failed", failure_reason: "seller_dial_dispatch_window_expired", seller_dial_state: "unknown" });
    expect(store.openFor(CALL).some((c) => c.kind === "unresolved_dial")).toBe(false);
  });

  it("does no work for a duplicate event", async () => {
    const { dial, deps } = setup();
    const raw = body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }, "same-id");
    await processDirectCallWebhook(raw, deps);
    const second = await processDirectCallWebhook(raw, deps);
    expect(second.result).toBe("duplicate");
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it("captures a saved seller recording before acknowledging it and ignores a processed duplicate", async () => {
    const { deps } = setup({ status: "connected", seller_leg_id: "SELLER" });
    const recordingSaved = vi.fn(async () => undefined);
    deps.recordingSaved = recordingSaved;
    const raw = body("call.recording.saved", "SELLER", { directCallId: CALL, role: "seller" }, "recording-event", {
      recording_id: "rec-1", call_leg_id: "leg-1", call_session_id: "session-1",
    });
    await expect(processDirectCallWebhook(raw, deps)).resolves.toMatchObject({ result: "processed" });
    await expect(processDirectCallWebhook(raw, deps)).resolves.toMatchObject({ result: "duplicate" });
    expect(recordingSaved).toHaveBeenCalledTimes(1);
    expect(recordingSaved).toHaveBeenCalledWith(expect.objectContaining({ id: CALL, seller_leg_id: "SELLER" }), expect.objectContaining({ recordingId: "rec-1", callControlId: "SELLER" }));
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
    await processDirectCallWebhook(answerBrowser(), deps);
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

  it("fails the call and drops the browser leg when the seller dial times out (never re-dials); the Dial stays unresolved", async () => {
    const { store, dial, hangup, deps } = setup({ property_id: "prop-1" });
    dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx request timed out.", "unknown", null));
    await processDirectCallWebhook(answerBrowser(), deps);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(store.calls.get(CALL)).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown" });
    expect(hangup).toHaveBeenCalledWith("browser-leg", expect.any(String));
    expect(store.openFor(CALL).some((c) => c.kind === "unresolved_dial" && c.dial_role === "seller")).toBe(true);
    // The lead never connected: the obligation to resume is recorded (a webhook cannot resume itself).
    expect(store.calls.get(CALL)?.resume_pending).toBe(true);
  });

  it("a definitive seller Dial refusal resolves the unresolved row", async () => {
    const { store, dial, deps } = setup();
    dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx returned 422", "rejected", 422));
    await processDirectCallWebhook(answerBrowser(), deps);
    expect(store.calls.get(CALL)).toMatchObject({ status: "failed", failure_reason: "seller_dial_rejected" });
    expect(store.openFor(CALL).filter((c) => c.kind === "unresolved_dial")).toEqual([]);
  });

  it("hangs up a seller leg created after the call already ended (A9)", async () => {
    const { store, dial, hangup, deps } = setup();
    dial.mockImplementationOnce(async () => {
      store.calls.set(CALL, { ...store.calls.get(CALL)!, status: "ended" });
      return { callControlId: "LATE" };
    });
    await processDirectCallWebhook(answerBrowser(), deps);
    expect(hangup).toHaveBeenCalledWith("LATE", expect.any(String));
    expect(store.legRow("LATE")).toBeDefined();
  });

  it("propagates database failures so the route can answer 500", async () => {
    const { store, deps } = setup();
    store.failEventInsert = true;
    await expect(processDirectCallWebhook(answerBrowser(), deps)).rejects.toThrow("db down");
  });

  it("reprocesses a duplicate whose first attempt never finished", async () => {
    const { store, dial, deps } = setup();
    store.events.set("same-id", { directCallId: CALL, processed: false, type: "call.answered" });
    await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }, "same-id"), deps);
    expect(dial).toHaveBeenCalledTimes(1);
  });

  describe("review blockers", () => {
    it("treats an already-stored matching seller leg as success and does not hang it up (call.initiated won the race)", async () => {
      const { store, dial, hangup, deps } = setup();
      dial.mockImplementationOnce(async () => {
        await processDirectCallWebhook(body("call.initiated", "SELLER", { directCallId: CALL, role: "seller" }, "init"), deps);
        return { callControlId: "SELLER" };
      });
      await processDirectCallWebhook(answerBrowser(), deps);
      expect(hangup).not.toHaveBeenCalled();
      expect(store.calls.get(CALL)).toMatchObject({ status: "seller_dialing", seller_leg_id: "SELLER", seller_dial_state: "sent" });
      expect(store.legRow("SELLER")).toBeUndefined();
      expect(store.openFor(CALL)).toEqual([]);
    });

    it("persists a conflicting seller leg as a durable leg row, hangs it up, and keeps it until confirmed ended (blocker 3)", async () => {
      const { store, dial, hangup, getCall, deps, advance } = setup();
      getCall.mockResolvedValue({ isAlive: true });
      dial.mockImplementationOnce(async () => {
        store.calls.set(CALL, { ...store.calls.get(CALL)!, seller_leg_id: "OTHER" });
        return { callControlId: "SELLER" };
      });
      await processDirectCallWebhook(answerBrowser(), deps);
      expect(hangup).toHaveBeenCalledWith("SELLER", expect.any(String));
      expect(hangup).not.toHaveBeenCalledWith("OTHER", expect.any(String));
      // Hangup accepted but the leg is not confirmed gone: the row is remembered, not forgotten.
      expect(store.legRow("SELLER")).toMatchObject({ confirmed_at: null, acked_at: expect.any(String) });
      // A later event, after the re-check delay, finds it dead.
      getCall.mockResolvedValue({ isAlive: false });
      advance(30);
      await processDirectCallWebhook(body("call.bridged", "browser-leg", { directCallId: CALL, role: "browser" }, "later"), deps);
      expect(store.legRow("SELLER")?.confirmed_at).not.toBeNull();
    });

    it("confirms a leg row from its own hangup webhook without any provider request", async () => {
      const { store, hangup, deps } = setup({ status: "failed" });
      store.addCleanup({ direct_call_id: CALL, kind: "leg", leg_id: "ORPHAN" });
      hangup.mockRejectedValue(new TelnyxApiError("down", "unknown", null));
      await expect(
        processDirectCallWebhook(body("call.hangup", "ORPHAN", { directCallId: CALL, role: "seller" }, "orphan-gone"), deps),
      ).resolves.toMatchObject({ result: "processed" });
      expect(store.legRow("ORPHAN")?.confirmed_at).not.toBeNull();
      expect(hangup).not.toHaveBeenCalled();
    });

    it("a hangup handler working from a stale snapshot still tears down a seller leg stored concurrently (#743-3)", async () => {
      const { store, hangup, deps } = setup({ status: "seller_dialing", seller_dial_state: "pending", seller_leg_id: null });
      // The seller Dial's unresolved row (written with the pending transition).
      store.addCleanup({ direct_call_id: CALL, kind: "unresolved_dial", dial_role: "seller" });
      // The handler reads the row (seller_leg_id null); THEN the concurrent Dial response stores the leg and
      // resolves its unresolved row; THEN the handler's status-only compare-and-set lands.
      const realFind = store.findByLeg.bind(store);
      store.findByLeg = async (leg: string) => {
        const snapshot = await realFind(leg);
        await store.dialSucceeded(CALL, "SELLER", "seller");
        expect(store.openFor(CALL)).toEqual([]); // nothing left to remind anyone of the live seller leg
        return snapshot;
      };
      await processDirectCallWebhook(body("call.hangup", "browser-leg", { directCallId: CALL, role: "browser" }, "h-race"), deps);
      expect(store.calls.get(CALL)).toMatchObject({ status: "failed", seller_leg_id: "SELLER" });
      expect(store.legRow("SELLER")).toBeDefined();
      expect(hangup).toHaveBeenCalledWith("SELLER", expect.any(String));
      // The browser leg's own hangup was received: no cleanup is queued for it.
      expect(store.legRow("browser-leg")).toBeUndefined();
    });

    it("an open unresolved Dial row survives the move to a terminal status (#743-3)", async () => {
      const { store, deps } = setup({ status: "seller_dialing", seller_dial_state: "pending", seller_leg_id: null });
      store.addCleanup({ direct_call_id: CALL, kind: "unresolved_dial", dial_role: "seller", dial_started_at: "2026-10-01T12:00:00.000Z" });
      await processDirectCallWebhook(body("call.hangup", "browser-leg", { directCallId: CALL, role: "browser" }, "h-keep"), deps);
      expect(store.calls.get(CALL)?.status).toBe("failed");
      expect(store.openFor(CALL).map((c) => `${c.kind}:${c.dial_role}`)).toEqual(["unresolved_dial:seller"]);
    });

    it("a failed hangup is a durable, backed-off row: the webhook still answers 200 and the event is processed (#743-2)", async () => {
      const { store, hangup, deps, advance } = setup({ status: "failed" });
      store.addCleanup({ direct_call_id: CALL, kind: "leg", leg_id: "ORPHAN" });
      hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      const raw = body("call.bridged", "browser-leg", { directCallId: CALL, role: "browser" }, "orphan-retry");
      await expect(processDirectCallWebhook(raw, deps)).resolves.toMatchObject({ result: "processed" });
      expect(store.events.get("orphan-retry")?.processed).toBe(true);
      expect(store.legRow("ORPHAN")).toMatchObject({ confirmed_at: null, attempts: 1, last_error: expect.any(String) });
      // Redelivery inside the backoff window makes no provider request ...
      await processDirectCallWebhook(raw, deps);
      expect(hangup).toHaveBeenCalledTimes(1);
      // ... and a later trigger retries it.
      advance(10);
      await processDirectCallWebhook(body("call.bridged", "browser-leg", { directCallId: CALL, role: "browser" }, "orphan-retry-2"), deps);
      expect(hangup).toHaveBeenCalledTimes(2);
      expect(store.legRow("ORPHAN")?.acked_at).not.toBeNull();
    });

    it("keeps a terminal call's other leg autonomous after one hangup webhook and a transient failure", async () => {
      const { store, hangup, getCall, listActiveCalls, deps, advance } = setup({ status: "connected", seller_leg_id: "SELLER", connected_at: "2026-10-01T12:00:01.000Z" });
      hangup.mockRejectedValueOnce(new TelnyxApiError("provider unavailable", "unknown", 503));

      // The seller hangup webhook confirms that leg and transitions the call to
      // ended. The shared cleanup trigger attempts the browser leg once, but its
      // transient provider failure remains durable on the terminal call.
      await expect(processDirectCallWebhook(body("call.hangup", "SELLER", { directCallId: CALL, role: "seller" }, "terminal-retry"), deps)).resolves.toMatchObject({ result: "processed" });
      expect(store.calls.get(CALL)?.status).toBe("ended");
      expect(store.legRow("browser-leg")).toMatchObject({ attempts: 1, confirmed_at: null });

      // No event, browser poll, or manual action is needed: a later watchdog
      // pass claims the terminal row's pending obligation and retries it.
      advance(10);
      await processDueCleanups({ store, hangup, getCall, listActiveCalls, now: () => clock.now, report: vi.fn(), random: () => 0 }, "user-1");
      expect(hangup).toHaveBeenCalledTimes(2);
      expect(store.legRow("browser-leg")?.acked_at).not.toBeNull();
      expect(getCall).not.toHaveBeenCalled();
    });

    it("reconciles an unresolved Dial after its call is already terminal", async () => {
      const { store, hangup, getCall, listActiveCalls, advance } = setup({ status: "failed" });
      store.addCleanup({
        direct_call_id: CALL,
        kind: "unresolved_dial",
        dial_role: "seller",
        dial_started_at: T0.toISOString(),
        resolve_after: new Date(T0.getTime() - 1_000).toISOString(),
        backstop_at: new Date(T0.getTime() + 60_000).toISOString(),
      });

      await processDueCleanups({ store, hangup, getCall, listActiveCalls, now: () => clock.now, report: vi.fn(), random: () => 0 }, "user-1");
      expect(store.openFor(CALL)[0]?.empty_matches).toBe(1);
      advance(10);
      await processDueCleanups({ store, hangup, getCall, listActiveCalls, now: () => clock.now, report: vi.fn(), random: () => 0 }, "user-1");
      expect(store.openFor(CALL)).toEqual([]);
      expect(store.calls.get(CALL)?.status).toBe("failed");
      expect(hangup).not.toHaveBeenCalled();
      expect(getCall).not.toHaveBeenCalled();
    });

    it("persists the opposite-leg cleanup, answers 200, retries after backoff, and confirms only by webhook/status (blocker 1)", async () => {
      const { store, hangup, getCall, deps, advance } = setup({ status: "connected", seller_leg_id: "SELLER", connected_at: "2026-10-01T12:00:01.000Z" });
      hangup.mockRejectedValueOnce(new TelnyxApiError("Telnyx request timed out.", "unknown", null));
      const raw = body("call.hangup", "SELLER", { directCallId: CALL, role: "seller" }, "h-retry");
      await expect(processDirectCallWebhook(raw, deps)).resolves.toMatchObject({ result: "processed" });
      expect(store.calls.get(CALL)).toMatchObject({ status: "ended" });
      expect(store.legRow("browser-leg")).toMatchObject({ confirmed_at: null, attempts: 1 });
      advance(10);
      // Telnyx redelivers the same event: the transition is a no-op but the cleanup is retried.
      expect((await processDirectCallWebhook(raw, deps)).result).toBe("duplicate");
      expect(hangup).toHaveBeenCalledTimes(2);
      // Hangup accepted (2xx) is not confirmed: the row (and the operator lock with it) stays open ...
      expect(store.legRow("browser-leg")).toMatchObject({ confirmed_at: null, acked_at: expect.any(String) });
      expect(await store.operatorBusy("user-1")).toBe("cleanup");
      // ... until the browser leg's own hangup webhook confirms it.
      await processDirectCallWebhook(body("call.hangup", "browser-leg", { directCallId: CALL, role: "browser" }, "h-browser"), deps);
      expect(store.legRow("browser-leg")?.confirmed_at).not.toBeNull();
      expect(getCall).not.toHaveBeenCalled();
      expect(await store.operatorBusy("user-1")).toBeNull();
    });

    it("counts only 422/90018 'already ended' as confirmation; a 404 or another 422 stays pending", async () => {
      for (const [error, confirmed] of [
        [ENDED_422(), true],
        [new TelnyxApiError("Telnyx returned 404", "rejected", 404), false],
        [new TelnyxApiError("Telnyx returned 422", "rejected", 422, { code: "90001" }), false],
      ] as const) {
        const { store, hangup, deps } = setup({ status: "connected", seller_leg_id: "SELLER", connected_at: "2026-10-01T12:00:01.000Z" });
        hangup.mockRejectedValueOnce(error);
        await processDirectCallWebhook(body("call.hangup", "SELLER", { directCallId: CALL, role: "seller" }), deps);
        expect(store.legRow("browser-leg")?.confirmed_at !== null).toBe(confirmed);
      }
    });

    it("retries due cleanup on any later event for the call, including already-processed duplicates", async () => {
      const { store, hangup, deps } = setup({ status: "ended", seller_leg_id: "SELLER" });
      store.addCleanup({ direct_call_id: CALL, kind: "leg", leg_id: "SELLER" });
      const raw = body("call.bridged", "SELLER", { directCallId: CALL, role: "seller" }, "dup");
      store.events.set("dup", { directCallId: CALL, processed: true, type: "call.bridged" });
      const out = await processDirectCallWebhook(raw, deps);
      expect(out.result).toBe("duplicate");
      expect(hangup).toHaveBeenCalledWith("SELLER", expect.any(String));
      expect(store.legRow("SELLER")).toMatchObject({ confirmed_at: null, acked_at: expect.any(String) });
    });

    it("persists seller_dial_state=pending with the transition and 'sent' after the Dial", async () => {
      const { store, dial, deps } = setup();
      let during: string | null | undefined;
      dial.mockImplementationOnce(async () => {
        during = store.calls.get(CALL)?.seller_dial_state;
        return { callControlId: "SELLER" };
      });
      await processDirectCallWebhook(answerBrowser(), deps);
      expect(during).toBe("pending");
      expect(store.calls.get(CALL)?.seller_dial_state).toBe("sent");
    });

    it("never re-sends the Dial on a reprocessed browser answer: pending with no seller leg is an unknown outcome (blocker 2)", async () => {
      const { store, dial, hangup, deps } = setup({ status: "seller_dialing", seller_dial_state: "pending", updated_at: "2026-10-01T12:00:04.000Z" });
      store.addCleanup({ direct_call_id: CALL, kind: "unresolved_dial", dial_role: "seller" });
      await processDirectCallWebhook(answerBrowser("redelivered"), deps);
      expect(dial).not.toHaveBeenCalled();
      expect(store.calls.get(CALL)).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown", seller_dial_state: "unknown" });
      expect(hangup).toHaveBeenCalledWith("browser-leg", expect.any(String));
    });

    it("issues no Dial when teardown begins between the transition and the Dial (blocker 2)", async () => {
      const { store, dial, deps } = setup();
      const original = store.updateIfStatus.bind(store);
      store.updateIfStatus = async (id, statuses, patch, cleanups) => {
        const updated = await original(id, statuses, patch, cleanups);
        if (patch.status === "seller_dialing") store.calls.set(id, { ...store.calls.get(id)!, status: "ending" }); // e.g. operator hangup
        return updated;
      };
      await processDirectCallWebhook(answerBrowser(), deps);
      expect(dial).not.toHaveBeenCalled();
    });

    it("issues no Dial for a browser answer that arrives while the call is ending or being torn down", async () => {
      for (const over of [{ status: "ending" as const }, { failure_reason: "teardown_pending" }]) {
        const { dial, deps } = setup(over);
        await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }, `e-${JSON.stringify(over)}`), deps);
        expect(dial).not.toHaveBeenCalled();
      }
    });

    it("a late event for an old call while the operator holds a newer live call becomes a durable leg row; the newer call is untouched (A14, #743-2)", async () => {
      const { store, hangup, deps, advance } = setup({ status: "ended" });
      const newer = store.add(makeRow({ id: "99999999-9999-4999-8999-999999999999", status: "connected", browser_leg_id: "newer", seller_leg_id: "newer-s", client_request_id: "44444444-4444-4444-8444-444444444444" }));
      hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      const out = await processDirectCallWebhook(body("call.answered", "browser-leg", { directCallId: CALL, role: "browser" }, "late"), deps);
      expect(out.result).toBe("processed"); // 200: never a 500 for pending cleanup
      expect(store.events.get("late")?.processed).toBe(true);
      expect(hangup).toHaveBeenCalledWith("browser-leg", expect.any(String));
      // The failed hangup was NOT forgotten: it is a durable row that retries after backoff.
      expect(store.legRow("browser-leg")).toMatchObject({ confirmed_at: null, attempts: 1 });
      expect(store.calls.get(newer.id)).toMatchObject({ status: "connected" });
      advance(10);
      await processDirectCallWebhook(body("call.bridged", "browser-leg", { directCallId: CALL, role: "browser" }, "late-2"), deps);
      expect(hangup).toHaveBeenCalledTimes(2);
      expect(store.legRow("browser-leg")?.acked_at).not.toBeNull();
    });

    it("never resends an unknown Dial: fails dial_outcome_unknown, and a seller leg seen later is hung up", async () => {
      const { store, dial, hangup, deps } = setup();
      dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx request timed out.", "unknown", null));
      await processDirectCallWebhook(answerBrowser(), deps);
      expect(store.calls.get(CALL)).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown", seller_dial_state: "unknown" });
      // Redelivery of the browser answer does not Dial again.
      await processDirectCallWebhook(answerBrowser("again"), deps);
      expect(dial).toHaveBeenCalledTimes(1);
      // The seller leg turns up later.
      await processDirectCallWebhook(body("call.initiated", "GHOST", { directCallId: CALL, role: "seller" }, "ghost"), deps);
      expect(hangup).toHaveBeenCalledWith("GHOST", expect.any(String));
      expect(store.calls.get(CALL)).toMatchObject({ seller_leg_id: "GHOST" });
      expect(store.legRow("GHOST")).toMatchObject({ confirmed_at: null }); // accepted, not yet confirmed
      // The webhook revealed the leg: the unresolved Dial is resolved into that leg row.
      expect(store.openFor(CALL).some((c) => c.kind === "unresolved_dial")).toBe(false);
    });

    it("dial in flight when the browser ends: the operator lock holds until the Dial is reconciled (#743-1)", async () => {
      const { store, dial, deps } = setup();
      let release!: () => void;
      dial.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ callControlId: "SELLER" }); }));
      const answering = processDirectCallWebhook(answerBrowser(), deps);
      await vi.waitFor(() => expect(dial).toHaveBeenCalled());
      // Browser hangs up before the Dial returns: the row is over, but the seller Dial has no leg id yet.
      await processDirectCallWebhook(body("call.hangup", "browser-leg", { directCallId: CALL, role: "browser" }, "b-hangup"), deps);
      expect(store.calls.get(CALL)?.status).toBe("failed");
      expect(await store.operatorBusy("user-1")).toBe("cleanup");
      expect(store.openFor(CALL).map((c) => `${c.kind}:${c.dial_role}`)).toEqual(["unresolved_dial:seller"]);
      release();
      await answering;
      // The Dial's leg arrived after the call ended: it is a leg row and is hung up.
      expect(store.legRow("SELLER")).toBeDefined();
    });
  });
});
