import { describe, expect, it, vi } from "vitest";

import type { DirectCallTarget } from "./contract";
import { createDirectCallService, type DirectCallServiceDeps } from "./service";
import { FakeStore, makeRow } from "./test-support";
import { TelnyxApiError } from "./telnyx";

const ENDED_422 = () => new TelnyxApiError("Telnyx returned 422: Call has already ended", "rejected", 422, { code: "90018" });

const ENV = {
  DIRECT_CALL_PILOT_USER_IDS: "user-1",
  TELNYX_DIRECT_API_KEY: "SECRET-KEY-123",
  TELNYX_DIRECT_CONNECTION_ID: "conn",
  TELNYX_DIRECT_APP_ID: "app",
  TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY: "pub",
  DIRECT_CALL_CALLER_ID_E164: "+15550002222",
  DIRECT_CALL_CONTAINMENT_VERIFIED: "true",
};
const REQ = "44444444-4444-4444-8444-444444444444";
const REQ2 = "55555555-5555-4555-8555-555555555555";

const target = (over: Partial<DirectCallTarget>): DirectCallTarget => ({
  propertyId: null, contactId: null, phoneE164: "+15550008888", maskedPhone: "(555) 000-8888", name: "Manual call", address: null, state: null,
  startedAt: "2026-10-01T12:00:00.000Z", ...over,
});

function setup(overrides: Partial<DirectCallServiceDeps> = {}) {
  const store = new FakeStore();
  const telnyx = {
    dial: vi.fn(async (_s: unknown, _p: Record<string, unknown>) => ({ callControlId: "BROWSER-LEG" })),
    hangup: vi.fn(async (_s: unknown, _leg: string, _cmd: string) => undefined),
    getCall: vi.fn(async (_s: unknown, _leg: string) => ({ isAlive: false })),
    listActiveCalls: vi.fn(async (_s: unknown) => ({ calls: [] as Array<{ callControlId: string; clientState: Record<string, unknown> | null }>, complete: true })),
    sendDtmf: vi.fn(async (_s: unknown, _leg: string, _d: string) => undefined),
    createCredential: vi.fn(async () => ({ id: "cred-1", sipUsername: "gencred123" })),
    createToken: vi.fn(async () => "jwt-token"),
  };
  const prepareLeadCall = vi.fn(async (propertyId: string) => ({ ok: true as const, data: target({ propertyId, contactId: "contact-1", phoneE164: "+15550009999", name: "Pat Seller" }) }));
  const prepareManualCall = vi.fn(async () => ({ ok: true as const, data: target({ propertyId: null, contactId: null, phoneE164: "+15550008888" }) }));
  const resumeFailedSoftphoneCall = vi.fn(async () => undefined);
  const report = vi.fn();
  const sealCallIdentity = vi.fn((a: { callId: string; userId: string; phoneE164: string }) => ({
    capability: `sealed:${a.callId}:${a.userId}:${a.phoneE164}`,
    training: a.phoneE164 === "+15550007777",
  }));
  const clock = { now: new Date("2026-10-01T12:00:00.000Z") };
  store.clock = () => clock.now;
  const service = createDirectCallService({
    store, env: ENV, now: () => clock.now,
    prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall, sealCallIdentity, telnyx, report, ...overrides,
  });
  return { store, telnyx, prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall, sealCallIdentity, report, service, clock };
}

describe("direct call service", () => {
  it("refuses everything for non-pilot users", async () => {
    const { service, telnyx } = setup();
    expect(await service.getRtcToken("user-2")).toMatchObject({ ok: false, errorCode: "not_enabled" });
    expect(await service.startCall("user-2", { kind: "manual", phone: "5550008888", clientRequestId: REQ })).toMatchObject({ ok: false, errorCode: "not_enabled" });
    expect(telnyx.createCredential).not.toHaveBeenCalled();
  });

  it("creates a credential once and mints a token", async () => {
    const { service, telnyx } = setup();
    const first = await service.getRtcToken("user-1");
    const second = await service.getRtcToken("user-1");
    expect(first).toEqual({ ok: true, data: { token: "jwt-token", sipUsername: "gencred123" } });
    expect(second.ok).toBe(true);
    expect(telnyx.createCredential).toHaveBeenCalledTimes(1);
  });

  it("starts a lead call with the prepared destination, never a browser-supplied one", async () => {
    const { service, telnyx, store } = setup();
    const result = await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    expect(result.ok).toBe(true);
    const dial = telnyx.dial.mock.calls[0][1];
    expect(dial).toMatchObject({
      to: "sip:gencred123@sip.telnyx.com",
      from: "+15550002222",
      timeoutSecs: 30,
      timeLimitSecs: 7200,
      clientState: { role: "browser" },
      customHeaders: [{ name: "X-Sandra-Direct-Call-Id", value: expect.any(String) }],
    });
    const row = [...store.calls.values()][0];
    expect(row).toMatchObject({ destination_e164: "+15550009999", caller_id_e164: "+15550002222", status: "browser_connecting", browser_leg_id: "BROWSER-LEG" });
    if (result.ok) {
      expect(result.data).toMatchObject({ directCallId: row.id, browserLegId: "BROWSER-LEG", correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id } });
      // The server-prepared target's display fields travel back so the UI never has to prepare itself.
      expect(result.data.target).toMatchObject({ propertyId: "prop-1", name: "Pat Seller", maskedPhone: "(555) 000-8888" });
    }
    // The browser Dial's unresolved row existed before the Dial and is resolved by the stored leg.
    expect(store.openFor(row.id)).toEqual([]);
  });

  it("anchors bounded cleanup to actual browser dispatch after delayed prepare and credential work", async () => {
    const ctx = setup({ env: { ...ENV, DIRECT_CALL_TIME_LIMIT_SECS: "180" } });
    const startMs = ctx.clock.now.getTime();
    ctx.prepareManualCall.mockImplementationOnce(async () => {
      ctx.clock.now = new Date(startMs + 70_000);
      return { ok: true as const, data: target({}) };
    });
    ctx.telnyx.createCredential.mockImplementationOnce(async () => {
      ctx.clock.now = new Date(startMs + 75_000);
      return { id: "cred-delayed", sipUsername: "gencred-delayed" };
    });
    let providerLatestEnd = 0;
    ctx.telnyx.dial.mockImplementationOnce(async (_settings, params) => {
      providerLatestEnd = ctx.clock.now.getTime() + Number(params.timeLimitSecs) * 1000;
      throw new Error("unknown provider outcome");
    });

    const result = await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    expect(result).toMatchObject({ ok: false, errorCode: "start_failed", reserved: true });
    const row = [...ctx.store.calls.values()][0];
    const cleanup = [...ctx.store.cleanups.values()].find((c) => c.kind === "unresolved_dial" && c.dial_role === "browser")!;
    expect(row.time_limit_secs).toBe(180);
    expect(ctx.telnyx.dial.mock.calls[0][1]).toMatchObject({ timeLimitSecs: 180 });
    expect(new Date(cleanup.resolve_after!).getTime()).toBe(startMs + 75_000 + 55_000);
    expect(new Date(cleanup.backstop_at!).getTime()).toBeGreaterThanOrEqual(providerLatestEnd);
    expect(new Date(cleanup.next_attempt_at!).getTime()).toBeGreaterThan(startMs + 45_000);
  });

  it("refuses a browser Dial when the dispatch marker response exceeds its allowance", async () => {
    const ctx = setup({ env: { ...ENV, DIRECT_CALL_TIME_LIMIT_SECS: "180" } });
    const mark = ctx.store.markDialStarted.bind(ctx.store);
    vi.spyOn(ctx.store, "markDialStarted").mockImplementation(async (...args) => {
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 120_000);
      return mark(...args);
    });

    const result = await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    const row = [...ctx.store.calls.values()][0];
    expect(result).toMatchObject({ ok: false, errorCode: "start_failed", reserved: true });
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "failed", failure_reason: "browser_dial_dispatch_window_expired" });
    expect(ctx.store.openFor(row.id)).toEqual([]);
  });

  it("does not Dial when cancellation wins while the dispatch marker write is in flight", async () => {
    const ctx = setup({ env: { ...ENV, DIRECT_CALL_TIME_LIMIT_SECS: "180" } });
    const mark = ctx.store.markDialStarted.bind(ctx.store);
    let release!: () => void;
    const response = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(ctx.store, "markDialStarted").mockImplementation(async (...args) => {
      const result = await mark(...args);
      await response;
      return result;
    });

    const starting = ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    await vi.waitFor(() => expect(ctx.store.markDialStarted).toHaveBeenCalled());
    expect(await ctx.service.cancelByRequest("user-1", REQ)).toMatchObject({ ok: true, data: { tombstoned: false } });
    release();
    await expect(starting).resolves.toMatchObject({ ok: false, errorCode: "cancelled", reserved: true });
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    const row = [...ctx.store.calls.values()][0];
    expect(ctx.store.openFor(row.id)).toEqual([]);
  });

  it("ignores a PSTN destination smuggled into the input", async () => {
    const { service, store, prepareLeadCall } = setup();
    await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ, phoneE164: "+19998887777", destination: "+19998887777" } as never);
    expect(prepareLeadCall).toHaveBeenCalledWith("prop-1");
    expect([...store.calls.values()][0].destination_e164).toBe("+15550009999");
  });

  it("returns the prepare error unchanged and does nothing else", async () => {
    const prepareLeadCall = vi.fn(async () => ({ ok: false as const, error: "Calling is unavailable during quiet hours." }));
    const { service, telnyx, store, resumeFailedSoftphoneCall } = setup({ prepareLeadCall });
    const result = await service.startCall("user-1", { kind: "lead", propertyId: "p", clientRequestId: REQ });
    expect(result).toEqual({ ok: false, error: "Calling is unavailable during quiet hours.", reserved: false });
    expect(store.calls.size).toBe(0);
    expect(telnyx.dial).not.toHaveBeenCalled();
    expect(resumeFailedSoftphoneCall).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent call before preparing anything", async () => {
    const { service, prepareLeadCall, prepareManualCall } = setup();
    await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    prepareLeadCall.mockClear();
    const second = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 });
    expect(second).toMatchObject({ ok: false, errorCode: "call_in_progress" });
    expect(prepareLeadCall).not.toHaveBeenCalled();
    expect(prepareManualCall).not.toHaveBeenCalled();
  });

  it("resumes the lead and fails the row when the browser Dial fails", async () => {
    const { service, telnyx, store, resumeFailedSoftphoneCall, report } = setup();
    telnyx.dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx request timed out.", "unknown", null));
    const result = await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    expect(result).toMatchObject({ ok: false, errorCode: "start_failed" });
    const failedRow = [...store.calls.values()][0];
    expect(failedRow).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown" });
    // The unknown Dial stays an open obligation (a leg may exist) and holds the operator lock.
    expect(store.openFor(failedRow.id).map((c) => `${c.kind}:${c.dial_role}`)).toEqual(["unresolved_dial:browser"]);
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1);
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledWith("prop-1");
    expect(telnyx.dial).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalled();
  });

  it("does not leak the API key in returned errors", async () => {
    const { service, telnyx } = setup();
    telnyx.dial.mockRejectedValueOnce(new Error("failed with Authorization: Bearer SECRET-KEY-123"));
    const start = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    telnyx.createToken.mockRejectedValueOnce(new Error("Bearer SECRET-KEY-123"));
    const token = await service.getRtcToken("user-1");
    expect(JSON.stringify([start, token])).not.toMatch(/SECRET-KEY|Bearer|Authorization/);
  });

  it("replays an in-flight request id instead of dialing twice", async () => {
    const { service, telnyx } = setup();
    const a = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    const b = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    // The replay carries the same call identity (the target is only returned by the original start).
    expect(b).toEqual({ ok: true, data: { ...(a as { data: object }).data, target: undefined } });
    expect(telnyx.dial).toHaveBeenCalledTimes(1);
  });

  it("only exposes a user's own calls", async () => {
    const { service } = setup();
    const started = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    if (!started.ok) throw new Error("setup failed");
    const id = started.data.directCallId;
    expect(await service.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "browser_connecting" } });
    expect(await service.getStatus("user-2", id)).toMatchObject({ ok: false, errorCode: "not_found" });
    expect(await service.control("user-2", id, { action: "hangup" })).toMatchObject({ ok: false });
  });

  it("hangs up both known legs and marks the call ending", async () => {
    const { service, telnyx, store } = setup();
    const started = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    if (!started.ok) throw new Error("setup failed");
    const id = started.data.directCallId;
    store.calls.set(id, { ...store.calls.get(id)!, status: "connected", seller_leg_id: "SELLER-LEG" });
    expect(await service.control("user-1", id, { action: "hangup" })).toEqual({ ok: true, data: { accepted: true } });
    expect(telnyx.hangup.mock.calls.map((c) => c[1]).sort()).toEqual(["BROWSER-LEG", "SELLER-LEG"]);
    // 2xx = accepted, not confirmed: the rows stay open until the hangup webhook / a status check says the legs are gone.
    expect(store.calls.get(id)).toMatchObject({ status: "ending" });
    expect(store.legRow("BROWSER-LEG")).toMatchObject({ confirmed_at: null, acked_at: expect.any(String) });
    expect(store.legRow("SELLER-LEG")).toMatchObject({ confirmed_at: null, acked_at: expect.any(String) });
  });

  it("sends DTMF to the seller leg only while connected, and validates the digit", async () => {
    const { service, telnyx, store } = setup();
    const started = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    if (!started.ok) throw new Error("setup failed");
    const id = started.data.directCallId;
    expect(await service.control("user-1", id, { action: "dtmf", digit: "5" })).toMatchObject({ ok: false, errorCode: "not_connected" });
    store.calls.set(id, { ...store.calls.get(id)!, status: "connected", seller_leg_id: "SELLER-LEG" });
    expect(await service.control("user-1", id, { action: "dtmf", digit: "5" })).toMatchObject({ ok: true });
    expect(telnyx.sendDtmf).toHaveBeenCalledWith(expect.anything(), "SELLER-LEG", "5");
    expect(await service.control("user-1", id, { action: "dtmf", digit: "55" as never })).toMatchObject({ ok: false, errorCode: "invalid_request" });
  });

  describe("review blockers", () => {
    async function started(setupResult: ReturnType<typeof setup>) {
      const r = await setupResult.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
      if (!r.ok) throw new Error("setup failed");
      return r.data.directCallId;
    }

    it("issues no browser token and starts no call unless containment is verified", async () => {
      const store = new FakeStore();
      const noContainment = setup({ store, env: { ...ENV, DIRECT_CALL_CONTAINMENT_VERIFIED: undefined } });
      expect(await noContainment.service.getRtcToken("user-1")).toMatchObject({ ok: false, errorCode: "not_enabled" });
      expect(await noContainment.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ })).toMatchObject({ ok: false, errorCode: "not_enabled" });
      expect(noContainment.telnyx.createToken).not.toHaveBeenCalled();
      expect(noContainment.telnyx.createCredential).not.toHaveBeenCalled();
    });

    it("lets a user removed from the pilot hang up and read their own call, but not start or dial digits", async () => {
      const ctx = setup();
      const id = await started(ctx);
      const removed = createDirectCallService({
        store: ctx.store, env: { ...ENV, DIRECT_CALL_PILOT_USER_IDS: "someone-else" }, now: () => ctx.clock.now,
        prepareLeadCall: ctx.prepareLeadCall, prepareManualCall: ctx.prepareManualCall, resumeFailedSoftphoneCall: ctx.resumeFailedSoftphoneCall,
        sealCallIdentity: ctx.sealCallIdentity, telnyx: ctx.telnyx, report: ctx.report,
      });
      expect(await removed.getStatus("user-1", id)).toMatchObject({ ok: true });
      expect(await removed.control("user-1", id, { action: "hangup" })).toEqual({ ok: true, data: { accepted: true } });
      expect(ctx.telnyx.hangup).toHaveBeenCalledWith(expect.anything(), "BROWSER-LEG", expect.any(String));
      expect(await removed.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 })).toMatchObject({ ok: false, errorCode: "not_enabled" });
      expect(await removed.control("user-1", id, { action: "dtmf", digit: "1" })).toMatchObject({ ok: false, errorCode: "not_enabled" });
    });

    it("keeps a failed hangup as a backed-off row, separates accepted from confirmed, and only reports cleanupPending=false once confirmed", async () => {
      const ctx = setup();
      const id = await started(ctx);
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "connected", seller_leg_id: "SELLER-LEG" });
      ctx.telnyx.hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null)).mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      expect(await ctx.service.control("user-1", id, { action: "hangup" })).toMatchObject({ ok: false, errorCode: "hangup_failed" });
      expect(ctx.store.calls.get(id)).toMatchObject({ status: "ending" });
      expect(ctx.store.legRow("BROWSER-LEG")).toMatchObject({ confirmed_at: null, attempts: 1 });
      expect(ctx.store.legRow("SELLER-LEG")).toMatchObject({ confirmed_at: null, attempts: 1 });
      // Polling inside the backoff window makes no provider request at all.
      const before = ctx.telnyx.hangup.mock.calls.length;
      await ctx.service.getStatus("user-1", id);
      expect(ctx.telnyx.hangup.mock.calls.length).toBe(before);
      // After the backoff the browser hangup fails again, the seller hangup is accepted (2xx).
      ctx.clock.now = new Date("2026-10-01T12:00:11.000Z");
      ctx.telnyx.hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      await ctx.service.getStatus("user-1", id);
      expect(ctx.store.legRow("BROWSER-LEG")).toMatchObject({ acked_at: null, attempts: 2 });
      expect(ctx.store.legRow("SELLER-LEG")?.acked_at).not.toBeNull();
      // The call goes terminal while legs are unconfirmed: not authoritative yet.
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "ended" });
      const during = await ctx.service.getStatus("user-1", id);
      expect(during).toMatchObject({ ok: true, data: { status: "ended", failureReason: "teardown_pending", cleanupPending: true } });
      // Both legs eventually check out dead / are hung up: confirmed.
      ctx.clock.now = new Date("2026-10-01T12:01:00.000Z");
      await ctx.service.getStatus("user-1", id);
      ctx.clock.now = new Date("2026-10-01T12:02:00.000Z");
      const after = await ctx.service.getStatus("user-1", id);
      expect(after).toMatchObject({ ok: true, data: { status: "ended", cleanupPending: false } });
      expect(ctx.telnyx.getCall).toHaveBeenCalled();
    });

    it("re-sends the hangup (with a fresh command id) when an acknowledged leg is still alive at the re-check", async () => {
      const ctx = setup();
      const id = await started(ctx);
      await ctx.service.control("user-1", id, { action: "hangup" });
      const first = ctx.telnyx.hangup.mock.calls.length;
      ctx.telnyx.getCall.mockResolvedValue({ isAlive: true });
      ctx.clock.now = new Date("2026-10-01T12:00:11.000Z");
      const view = await ctx.service.getStatus("user-1", id);
      expect(ctx.telnyx.hangup.mock.calls.length).toBe(first + 1);
      const ids = ctx.telnyx.hangup.mock.calls.map((c) => c[2]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(view).toMatchObject({ ok: true, data: { cleanupPending: true } });
    });

    it("hangs up every known leg of a stale row before releasing the operator, and reports teardown_pending meanwhile", async () => {
      const ctx = setup();
      const id = await started(ctx);
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "seller_dialing", seller_leg_id: "SELLER-LEG" });
      ctx.clock.now = new Date("2026-10-01T12:05:00.000Z");
      ctx.telnyx.hangup.mockRejectedValue(new TelnyxApiError("down", "unknown", null));
      const stuck = await ctx.service.getStatus("user-1", id);
      expect(stuck).toMatchObject({ ok: true, data: { status: "seller_dialing", failureReason: "teardown_pending", cleanupPending: true } });
      expect(ctx.telnyx.hangup.mock.calls.map((c) => c[1]).sort()).toEqual(["BROWSER-LEG", "SELLER-LEG"]);
      // The lock is still held: a new call is refused.
      expect(await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 })).toMatchObject({ ok: false, errorCode: "call_in_progress" });
      // Provider accepts the hangups: accepted is not confirmed, so the lock still holds.
      ctx.telnyx.hangup.mockReset();
      ctx.telnyx.hangup.mockResolvedValue(undefined);
      ctx.clock.now = new Date("2026-10-01T12:05:20.000Z");
      expect(await ctx.service.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "seller_dialing" } });
      // Later the legs check out dead and the lock is released.
      ctx.clock.now = new Date("2026-10-01T12:06:00.000Z");
      const released = await ctx.service.getStatus("user-1", id);
      expect(released).toMatchObject({ ok: true, data: { status: "failed", failureReason: "stale_unresolved", cleanupPending: false } });
    });

    it("refuses a new call while a terminal call still has cleanup unconfirmed, retrying it first and preparing nothing (blocker 1, C1)", async () => {
      const ctx = setup();
      const id = await started(ctx);
      // Hangup webhook made the row terminal, opposite-leg cleanup not yet confirmed.
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "ended", seller_leg_id: "SELLER-LEG" });
      ctx.store.addCleanup({ direct_call_id: id, kind: "leg", leg_id: "SELLER-LEG" });
      ctx.prepareManualCall.mockClear();
      ctx.telnyx.hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      const refused = await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 });
      expect(refused).toMatchObject({ ok: false, errorCode: "teardown_pending" });
      expect(ctx.telnyx.hangup).toHaveBeenCalledWith(expect.anything(), "SELLER-LEG", expect.any(String)); // retried first
      expect(ctx.prepareManualCall).not.toHaveBeenCalled();
      // Inside the backoff window: still locked, no provider traffic.
      const calls = ctx.telnyx.hangup.mock.calls.length;
      expect(await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 })).toMatchObject({ ok: false, errorCode: "teardown_pending" });
      expect(ctx.telnyx.hangup.mock.calls.length).toBe(calls);
      // Confirmed ended (hangup accepted, then status shows it dead): the operator is released.
      ctx.clock.now = new Date("2026-10-01T12:00:10.000Z");
      await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 });
      ctx.clock.now = new Date("2026-10-01T12:00:40.000Z");
      expect(await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 })).toMatchObject({ ok: true });
    });

    it("keeps the operator locked while a late/orphan leg row is unconfirmed, then releases it (blocker 3)", async () => {
      const ctx = setup();
      const id = await started(ctx);
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "failed" });
      ctx.store.addCleanup({ direct_call_id: id, kind: "leg", leg_id: "ORPHAN" });
      ctx.telnyx.getCall.mockResolvedValue({ isAlive: true });
      expect(await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 })).toMatchObject({ ok: false, errorCode: "teardown_pending" });
      expect(ctx.telnyx.hangup).toHaveBeenCalledWith(expect.anything(), "ORPHAN", expect.any(String));
      expect(ctx.store.legRow("ORPHAN")?.confirmed_at).toBeNull();
      expect(await ctx.service.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "failed", cleanupPending: true } });
      ctx.telnyx.getCall.mockResolvedValue({ isAlive: false });
      ctx.clock.now = new Date("2026-10-01T12:01:00.000Z");
      expect(await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 })).toMatchObject({ ok: true });
      expect(ctx.store.legRow("ORPHAN")?.confirmed_at).not.toBeNull();
    });

    it("treats a 422/90018 'already ended' hangup refusal as confirmation, but not a 404, when sweeping", async () => {
      const ctx = setup();
      const id = await started(ctx);
      ctx.clock.now = new Date("2026-10-01T12:05:00.000Z");
      ctx.telnyx.hangup.mockRejectedValue(new TelnyxApiError("Telnyx returned 404", "rejected", 404));
      expect(await ctx.service.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "browser_connecting", cleanupPending: true } });
      ctx.telnyx.hangup.mockReset();
      ctx.telnyx.hangup.mockRejectedValue(ENDED_422());
      ctx.clock.now = new Date("2026-10-01T12:05:20.000Z");
      expect(await ctx.service.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "failed", failureReason: "stale_unresolved" } });
    });

    it("lets the operator hang up even when the provider key is gone: the obligation is recorded and the lock holds (B6)", async () => {
      const ctx = setup();
      const id = await started(ctx);
      const keyless = createDirectCallService({
        store: ctx.store, env: { ...ENV, TELNYX_DIRECT_API_KEY: undefined }, now: () => ctx.clock.now,
        prepareLeadCall: ctx.prepareLeadCall, prepareManualCall: ctx.prepareManualCall, resumeFailedSoftphoneCall: ctx.resumeFailedSoftphoneCall,
        sealCallIdentity: ctx.sealCallIdentity, telnyx: ctx.telnyx, report: ctx.report,
      });
      expect(await keyless.control("user-1", id, { action: "hangup" })).toMatchObject({ ok: false, errorCode: "hangup_failed" });
      expect(ctx.store.legRow("BROWSER-LEG")).toMatchObject({ confirmed_at: null });
      expect(await keyless.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "ending", cleanupPending: true } });
      expect(await ctx.store.operatorBusy("user-1")).toBe("call");
      expect(ctx.telnyx.hangup).not.toHaveBeenCalled();
    });

    it("returns a sealed call identity from the same sealer for the prepared target, on start and on replay", async () => {
      const ctx = setup();
      const a = await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
      if (!a.ok) throw new Error("setup failed");
      expect(a.data.callCapability).toBe(`sealed:${a.data.directCallId}:user-1:+15550008888`);
      expect(ctx.sealCallIdentity).toHaveBeenCalledWith({ callId: a.data.directCallId, userId: "user-1", phoneE164: "+15550008888" });
      const b = await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
      expect(b).toEqual({ ok: true, data: { ...a.data, target: undefined } });
    });

    it("refuses to start an internal-training call it cannot seal, without dialing", async () => {
      const prepareManualCall = vi.fn(async () => ({ ok: true as const, data: target({ phoneE164: "+15550007777" }) }));
      const sealCallIdentity = vi.fn(() => ({ capability: null, training: true }));
      const ctx = setup({ prepareManualCall, sealCallIdentity });
      expect(await ctx.service.startCall("user-1", { kind: "manual", phone: "5550007777", clientRequestId: REQ })).toMatchObject({ ok: false, errorCode: "start_failed" });
      expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    });

    it("prepares the call before creating a Telnyx credential", async () => {
      const prepareLeadCall = vi.fn(async () => ({ ok: false as const, error: "Calling is unavailable during quiet hours." }));
      const ctx = setup({ prepareLeadCall });
      await ctx.service.startCall("user-1", { kind: "lead", propertyId: "p", clientRequestId: REQ });
      expect(ctx.telnyx.createCredential).not.toHaveBeenCalled();
    });
  });
});

describe("lead resume obligations (resume_pending), worked only from the operator's session (#743-2)", () => {
  const PENDING = "99999999-9999-4999-8999-999999999999";
  const seedPending = (store: FakeStore, over: Record<string, unknown> = {}) =>
    store.add(makeRow({ id: PENDING, status: "failed", ended_at: "2026-10-01T12:00:00.000Z", property_id: "prop-1", resume_pending: true, ...over }));

  it("a status poll resumes the lead once and clears the obligation", async () => {
    const { service, store, resumeFailedSoftphoneCall } = setup();
    seedPending(store);
    await service.getStatus("user-1", PENDING);
    await service.getStatus("user-1", PENDING);
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1);
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledWith("prop-1");
    expect(store.calls.get(PENDING)?.resume_pending).toBe(false);
  });

  it("keeps the obligation when the resume throws, does not hammer it inside the lease, and retries after", async () => {
    const { service, store, resumeFailedSoftphoneCall, report, clock } = setup();
    resumeFailedSoftphoneCall.mockRejectedValueOnce(new Error("not_authorized"));
    seedPending(store);
    await service.getStatus("user-1", PENDING);
    expect(store.calls.get(PENDING)?.resume_pending).toBe(true);
    expect(report).toHaveBeenCalledWith(expect.any(Error), "direct_call_resume");
    await service.getStatus("user-1", PENDING);
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1); // leased
    clock.now = new Date(clock.now.getTime() + 31_000);
    await service.getStatus("user-1", PENDING);
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledTimes(2);
    expect(store.calls.get(PENDING)?.resume_pending).toBe(false);
  });

  it("clears the obligation without resuming when another direct call has taken the property since", async () => {
    const { service, store, resumeFailedSoftphoneCall } = setup();
    seedPending(store);
    store.add(makeRow({ id: "88888888-8888-4888-8888-888888888888", operator_user_id: "user-2", property_id: "prop-1", status: "seller_dialing", browser_leg_id: "other" }));
    await service.getStatus("user-1", PENDING);
    expect(resumeFailedSoftphoneCall).not.toHaveBeenCalled();
    expect(store.calls.get(PENDING)?.resume_pending).toBe(false);
  });

  it("never works another operator's obligation", async () => {
    const { service, store, resumeFailedSoftphoneCall } = setup();
    seedPending(store, { operator_user_id: "user-2" });
    store.add(makeRow({ id: "77777777-7777-4777-8777-777777777777", status: "ended", operator_user_id: "user-1" }));
    await service.getStatus("user-1", "77777777-7777-4777-8777-777777777777");
    expect(resumeFailedSoftphoneCall).not.toHaveBeenCalled();
    expect(store.calls.get(PENDING)?.resume_pending).toBe(true);
  });

  it("start resumes a pending lead BEFORE reserving or preparing the next call", async () => {
    const { service, store, resumeFailedSoftphoneCall, prepareLeadCall } = setup();
    seedPending(store);
    const result = await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    expect(result.ok).toBe(true);
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1);
    expect(resumeFailedSoftphoneCall.mock.invocationCallOrder[0]).toBeLessThan(prepareLeadCall.mock.invocationCallOrder[0]);
  });

  it("an owned hangup control works pending resumes too", async () => {
    const { service, store, resumeFailedSoftphoneCall } = setup();
    seedPending(store);
    await service.control("user-1", PENDING, { action: "hangup" });
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1);
  });

  it("reads the call's open cleanup rows once per poll even when the call is stale", async () => {
    const { service, store } = setup();
    store.add(makeRow({ id: PENDING, status: "browser_connecting", created_at: "2026-10-01T11:00:00.000Z", browser_leg_id: null }));
    const spy = vi.spyOn(store, "openCleanupsForCall");
    await service.getStatus("user-1", PENDING);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("start errors say whether anything was reserved (#744-1)", () => {
  const start = (ctx: ReturnType<typeof setup>, input: Record<string, unknown> = { kind: "lead", propertyId: "prop-1" }, user = "user-1") =>
    ctx.service.startCall(user, { ...input, clientRequestId: REQ } as never);

  it("proven pre-reservation refusals carry reserved:false", async () => {
    expect(await start(setup(), undefined, "user-2")).toMatchObject({ ok: false, errorCode: "not_enabled", reserved: false });
    expect(await start(setup(), { kind: "lead" })).toMatchObject({ ok: false, errorCode: "invalid_request", reserved: false });
    const busy = setup();
    await busy.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 });
    expect(await start(busy)).toMatchObject({ ok: false, errorCode: "call_in_progress", reserved: false });
    const cleanup = setup();
    cleanup.store.add(makeRow({ id: "66666666-6666-4666-8666-666666666666", status: "ended" }));
    cleanup.store.addCleanup({ direct_call_id: "66666666-6666-4666-8666-666666666666", kind: "leg", leg_id: "held", next_attempt_at: "2099-01-01T00:00:00.000Z" });
    expect(await start(cleanup)).toMatchObject({ ok: false, errorCode: "teardown_pending", reserved: false });
    const refused = setup({ prepareLeadCall: vi.fn(async () => ({ ok: false as const, error: "Quiet hours." })) });
    expect(await start(refused)).toEqual({ ok: false, error: "Quiet hours.", reserved: false });
  });

  it("a prepare refusal whose reservation could not be discarded is reserved:true", async () => {
    const ctx = setup({ prepareLeadCall: vi.fn(async () => ({ ok: false as const, error: "Quiet hours." })) });
    vi.spyOn(ctx.store, "discardReservation").mockRejectedValueOnce(new Error("db"));
    expect(await start(ctx)).toEqual({ ok: false, error: "Quiet hours.", reserved: true });
  });

  it("an unknown or refused browser Dial is reserved:true (the reservation and its cleanup exist)", async () => {
    const unknown = setup();
    unknown.telnyx.dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx request timed out.", "unknown", null));
    expect(await start(unknown)).toMatchObject({ ok: false, errorCode: "start_failed", reserved: true });
    const refused = setup();
    refused.telnyx.dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx returned 422", "rejected", 422));
    expect(await start(refused)).toMatchObject({ ok: false, errorCode: "start_failed", reserved: true });
  });

  it("a reserve failure of unknown outcome is reserved:true", async () => {
    const ctx = setup();
    vi.spyOn(ctx.store, "beginCall").mockRejectedValueOnce(new Error("db"));
    expect(await start(ctx)).toMatchObject({ ok: false, errorCode: "start_failed", reserved: true });
  });

  it("keeps a definite invalid preparation target unreserved", async () => {
    const ctx = setup();
    vi.spyOn(ctx.store, "beginCall").mockResolvedValueOnce({ outcome: "invalid_target" });
    expect(await start(ctx)).toEqual({ ok: false, error: "A valid lead is required.", errorCode: "invalid_request", reserved: false });
    expect(ctx.prepareLeadCall).not.toHaveBeenCalled();
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
  });

  it("a request cancelled during prepare still records the prepared target, so the terminal move carries resume_pending", async () => {
    const ctx = setup();
    ctx.prepareLeadCall.mockImplementation(async (propertyId: string) => {
      const row = [...ctx.store.calls.values()][0];
      await ctx.store.updateIfStatus(row.id, ["browser_connecting"], { status: "ending" }); // hangup raced the prepare
      return { ok: true as const, data: target({ propertyId, contactId: "contact-1", phoneE164: "+15550009999" }) };
    });
    const result = await ctx.service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    expect(result).toMatchObject({ ok: false });
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    expect([...ctx.store.calls.values()][0]).toMatchObject({ property_id: "prop-1", contact_id: "contact-1", destination_e164: "+15550009999", status: "failed" });
    // resume_pending was set by the terminal move, then worked (and cleared) by the resume step of the same start.
    expect(ctx.resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1);
    expect(ctx.resumeFailedSoftphoneCall).toHaveBeenCalledWith("prop-1");
  });

  it("retains preparation ownership when cleanup ends a cancelled lead before prepare returns", async () => {
    const ctx = setup();
    const preparedTarget = target({ propertyId: "prop-1", contactId: "contact-1", phoneE164: "+15550009999", name: "Pat Seller" });
    let release!: (value: { ok: true; data: DirectCallTarget }) => void;
    ctx.prepareLeadCall.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const starting = ctx.service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    await vi.waitFor(() => expect(ctx.store.calls.size).toBe(1));
    const id = [...ctx.store.calls.keys()][0];
    expect(ctx.store.calls.get(id)).toMatchObject({ preparation_property_id: "prop-1", property_id: null });
    expect(await ctx.service.cancelByRequest("user-1", REQ)).toMatchObject({ ok: true, data: { tombstoned: false } });

    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    await expect(ctx.service.getStatusByRequest("user-1", REQ)).resolves.toMatchObject({ ok: true, data: { status: "ended", cleanupPending: false } });
    expect(ctx.store.calls.get(id)).toMatchObject({ status: "ended", property_id: null, preparation_property_id: "prop-1", resume_pending: false });
    expect(await ctx.store.operatorBusy("user-1")).toBeNull();

    release({ ok: true, data: preparedTarget });
    await expect(starting).resolves.toMatchObject({ ok: false, errorCode: "cancelled", reserved: true });
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    expect(ctx.store.calls.get(id)).toMatchObject({ status: "ended", property_id: "prop-1", preparation_property_id: null, resume_pending: false });
    expect(ctx.resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1);
    expect(ctx.resumeFailedSoftphoneCall).toHaveBeenCalledWith("prop-1");
  });

  it("does not resume a late prepared lead over a newer live call on that property", async () => {
    const ctx = setup();
    const preparedTarget = target({ propertyId: "prop-1", contactId: "contact-1", phoneE164: "+15550009999", name: "Pat Seller" });
    let releaseA!: (value: { ok: true; data: DirectCallTarget }) => void;
    let releaseB!: (value: { ok: true; data: DirectCallTarget }) => void;
    let preparationCount = 0;
    ctx.prepareLeadCall.mockImplementation(() => new Promise((resolve) => {
      preparationCount += 1;
      if (preparationCount === 1) releaseA = resolve;
      else releaseB = resolve;
    }));

    const startingA = ctx.service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    await vi.waitFor(() => expect(ctx.store.calls.size).toBe(1));
    await ctx.service.cancelByRequest("user-1", REQ);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    await ctx.service.getStatusByRequest("user-1", REQ);

    // B has paused the same property but is still preparing, so its property_id is null and only
    // preparation_property_id carries the ownership that must block A's late resume.
    const startingB = ctx.service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ2 });
    await vi.waitFor(() => expect(ctx.store.calls.size).toBe(2));
    const rows = [...ctx.store.calls.values()];
    const idA = rows.find((row) => row.client_request_id === REQ)!.id;
    const idB = rows.find((row) => row.client_request_id === REQ2)!.id;
    expect(ctx.store.calls.get(idB)).toMatchObject({ status: "browser_connecting", property_id: null, preparation_property_id: "prop-1" });

    releaseA({ ok: true, data: preparedTarget });
    await expect(startingA).resolves.toMatchObject({ ok: false, errorCode: "cancelled", reserved: true });
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    expect(ctx.resumeFailedSoftphoneCall).not.toHaveBeenCalled();
    expect(ctx.store.calls.get(idA)).toMatchObject({ property_id: "prop-1", preparation_property_id: null, resume_pending: false });
    expect(ctx.store.calls.get(idB)).toMatchObject({ property_id: null, preparation_property_id: "prop-1" });

    releaseB({ ok: true, data: preparedTarget });
    await expect(startingB).resolves.toMatchObject({ ok: true });
    expect(ctx.telnyx.dial).toHaveBeenCalledTimes(1);
    expect(ctx.resumeFailedSoftphoneCall).not.toHaveBeenCalled();
  });

  it("keeps a late manually resolved target after cleanup and resumes it once", async () => {
    const ctx = setup();
    const preparedTarget = target({ propertyId: "prop-1", contactId: "contact-1", phoneE164: "+15550009999", name: "Resolved manual seller" });
    let release!: (value: { ok: true; data: DirectCallTarget }) => void;
    ctx.prepareManualCall.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const starting = ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    await vi.waitFor(() => expect(ctx.store.calls.size).toBe(1));
    const id = [...ctx.store.calls.keys()][0];
    expect(ctx.store.calls.get(id)).toMatchObject({ preparation_property_id: null, property_id: null });
    await expect(ctx.service.cancelByRequest("user-1", REQ)).resolves.toMatchObject({ ok: true, data: { tombstoned: false } });

    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    await expect(ctx.service.getStatusByRequest("user-1", REQ)).resolves.toMatchObject({ ok: true, data: { status: "ended", cleanupPending: false } });
    expect(ctx.store.calls.get(id)).toMatchObject({ status: "ended", preparation_property_id: null, property_id: null, resume_pending: false });
    expect(ctx.resumeFailedSoftphoneCall).not.toHaveBeenCalled();

    release({ ok: true, data: preparedTarget });
    await expect(starting).resolves.toMatchObject({ ok: false, errorCode: "cancelled", reserved: true });
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    expect(ctx.store.calls.get(id)).toMatchObject({ status: "ended", property_id: "prop-1", preparation_property_id: null, resume_pending: false });
    expect(ctx.resumeFailedSoftphoneCall).toHaveBeenCalledTimes(1);
    expect(ctx.resumeFailedSoftphoneCall).toHaveBeenCalledWith("prop-1");
  });

  it("does not resume a late manual target over a newer known-property preparation", async () => {
    const ctx = setup();
    const preparedTarget = target({ propertyId: "prop-1", contactId: "contact-1", phoneE164: "+15550009999", name: "Resolved manual seller" });
    let releaseManual!: (value: { ok: true; data: DirectCallTarget }) => void;
    let releaseLead!: (value: { ok: true; data: DirectCallTarget }) => void;
    ctx.prepareManualCall.mockImplementation(() => new Promise((resolve) => { releaseManual = resolve; }));
    ctx.prepareLeadCall.mockImplementation(() => new Promise((resolve) => { releaseLead = resolve; }));

    const startingManual = ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    await vi.waitFor(() => expect(ctx.store.calls.size).toBe(1));
    await ctx.service.cancelByRequest("user-1", REQ);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    await ctx.service.getStatusByRequest("user-1", REQ);

    const startingLead = ctx.service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ2 });
    await vi.waitFor(() => expect(ctx.store.calls.size).toBe(2));
    const rows = [...ctx.store.calls.values()];
    const manualId = rows.find((row) => row.client_request_id === REQ)!.id;
    const leadId = rows.find((row) => row.client_request_id === REQ2)!.id;
    expect(ctx.store.calls.get(leadId)).toMatchObject({ status: "browser_connecting", property_id: null, preparation_property_id: "prop-1" });

    releaseManual({ ok: true, data: preparedTarget });
    await expect(startingManual).resolves.toMatchObject({ ok: false, errorCode: "cancelled", reserved: true });
    expect(ctx.telnyx.dial).not.toHaveBeenCalled();
    expect(ctx.resumeFailedSoftphoneCall).not.toHaveBeenCalled();
    expect(ctx.store.calls.get(manualId)).toMatchObject({ property_id: "prop-1", preparation_property_id: null, resume_pending: false });
    expect(ctx.store.calls.get(leadId)).toMatchObject({ property_id: null, preparation_property_id: "prop-1" });

    releaseLead({ ok: true, data: preparedTarget });
    await expect(startingLead).resolves.toMatchObject({ ok: true });
    expect(ctx.telnyx.dial).toHaveBeenCalledTimes(1);
    expect(ctx.resumeFailedSoftphoneCall).not.toHaveBeenCalled();
  });
});
