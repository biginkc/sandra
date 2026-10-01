import { describe, expect, it, vi } from "vitest";

import { createDirectCallService, type DirectCallServiceDeps } from "./service";
import { FakeStore } from "./test-support";
import { TelnyxApiError } from "./telnyx";

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

function setup(overrides: Partial<DirectCallServiceDeps> = {}) {
  const store = new FakeStore();
  const telnyx = {
    dial: vi.fn(async (_s: unknown, _p: Record<string, unknown>) => ({ callControlId: "BROWSER-LEG" })),
    hangup: vi.fn(async (_s: unknown, _leg: string, _cmd: string) => undefined),
    sendDtmf: vi.fn(async (_s: unknown, _leg: string, _d: string) => undefined),
    createCredential: vi.fn(async () => ({ id: "cred-1", sipUsername: "gencred123" })),
    createToken: vi.fn(async () => "jwt-token"),
  };
  const prepareLeadCall = vi.fn(async (propertyId: string) => ({ ok: true as const, data: { propertyId, contactId: "contact-1", phoneE164: "+15550009999" } }));
  const prepareManualCall = vi.fn(async () => ({ ok: true as const, data: { propertyId: null, contactId: null, phoneE164: "+15550008888" } }));
  const resumeFailedSoftphoneCall = vi.fn(async () => undefined);
  const report = vi.fn();
  const sealCallIdentity = vi.fn((a: { callId: string; userId: string; phoneE164: string }) => ({
    capability: `sealed:${a.callId}:${a.userId}:${a.phoneE164}`,
    training: a.phoneE164 === "+15550007777",
  }));
  const clock = { now: new Date("2026-10-01T12:00:00.000Z") };
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
    if (result.ok) expect(result.data).toMatchObject({ directCallId: row.id, browserLegId: "BROWSER-LEG", correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id } });
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
    expect(result).toEqual({ ok: false, error: "Calling is unavailable during quiet hours." });
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
    expect([...store.calls.values()][0]).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown" });
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
    expect(b).toEqual(a);
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
    expect(store.calls.get(id)).toMatchObject({ status: "ending", browser_hangup_pending: false, seller_hangup_pending: false });
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

    it("keeps a failed hangup pending and retries it from a later hangup request and from status polling", async () => {
      const ctx = setup();
      const id = await started(ctx);
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "connected", seller_leg_id: "SELLER-LEG" });
      ctx.telnyx.hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null)).mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      expect(await ctx.service.control("user-1", id, { action: "hangup" })).toMatchObject({ ok: false, errorCode: "hangup_failed" });
      expect(ctx.store.calls.get(id)).toMatchObject({ status: "ending", browser_hangup_pending: true, seller_hangup_pending: true });
      // Polling retries the teardown; one leg gets through.
      ctx.telnyx.hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      await ctx.service.getStatus("user-1", id);
      expect(ctx.store.calls.get(id)).toMatchObject({ browser_hangup_pending: true, seller_hangup_pending: false });
      // The call goes terminal while a leg is still unconfirmed; hangup retries it from the terminal row.
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "ended" });
      const view = await ctx.service.getStatus("user-1", id);
      expect(ctx.store.calls.get(id)?.browser_hangup_pending).toBe(false);
      expect(view).toMatchObject({ ok: true, data: { status: "ended" } });
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, browser_hangup_pending: true });
      ctx.telnyx.hangup.mockRejectedValueOnce(new TelnyxApiError("down", "unknown", null));
      const stuck = await ctx.service.getStatus("user-1", id);
      expect(stuck).toMatchObject({ ok: true, data: { status: "ended", failureReason: "teardown_pending" } });
      expect(await ctx.service.control("user-1", id, { action: "hangup" })).toEqual({ ok: true, data: { accepted: true } });
      expect(ctx.store.calls.get(id)?.browser_hangup_pending).toBe(false);
    });

    it("hangs up every known leg of a stale row before releasing the operator, and reports teardown_pending meanwhile", async () => {
      const ctx = setup();
      const id = await started(ctx);
      ctx.store.calls.set(id, { ...ctx.store.calls.get(id)!, status: "seller_dialing", seller_leg_id: "SELLER-LEG" });
      ctx.clock.now = new Date("2026-10-01T12:05:00.000Z");
      ctx.telnyx.hangup.mockRejectedValue(new TelnyxApiError("down", "unknown", null));
      const stuck = await ctx.service.getStatus("user-1", id);
      expect(stuck).toMatchObject({ ok: true, data: { status: "seller_dialing", failureReason: "teardown_pending" } });
      expect(ctx.telnyx.hangup.mock.calls.map((c) => c[1]).sort()).toEqual(["BROWSER-LEG", "SELLER-LEG"]);
      // The lock is still held: a new call is refused.
      expect(await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 })).toMatchObject({ ok: false, errorCode: "call_in_progress" });
      // Provider recovers: legs confirmed, then the lock is released.
      ctx.telnyx.hangup.mockReset();
      ctx.telnyx.hangup.mockResolvedValue(undefined);
      const released = await ctx.service.getStatus("user-1", id);
      expect(released).toMatchObject({ ok: true, data: { status: "failed", failureReason: "stale_unresolved" } });
      expect(ctx.store.calls.get(id)).toMatchObject({ browser_hangup_pending: false, seller_hangup_pending: false });
    });

    it("treats a leg the provider says is already gone as torn down when sweeping", async () => {
      const ctx = setup();
      const id = await started(ctx);
      ctx.clock.now = new Date("2026-10-01T12:05:00.000Z");
      ctx.telnyx.hangup.mockRejectedValue(new TelnyxApiError("Telnyx returned 404", "rejected", 404));
      expect(await ctx.service.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "failed", failureReason: "stale_unresolved" } });
    });

    it("returns a sealed call identity from the same sealer for the prepared target, on start and on replay", async () => {
      const ctx = setup();
      const a = await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
      if (!a.ok) throw new Error("setup failed");
      expect(a.data.callCapability).toBe(`sealed:${a.data.directCallId}:user-1:+15550008888`);
      expect(ctx.sealCallIdentity).toHaveBeenCalledWith({ callId: a.data.directCallId, userId: "user-1", phoneE164: "+15550008888" });
      const b = await ctx.service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
      expect(b).toEqual(a);
    });

    it("refuses to start an internal-training call it cannot seal, without dialing", async () => {
      const prepareManualCall = vi.fn(async () => ({ ok: true as const, data: { propertyId: null, contactId: null, phoneE164: "+15550007777" } }));
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
