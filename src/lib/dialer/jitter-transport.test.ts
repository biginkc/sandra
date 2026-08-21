import { describe, expect, it, vi } from "vitest";

import {
  JitterCallTransport,
  mapTelnyxCallState,
  type JitterTransportDependencies,
} from "./jitter-transport";

const CALL_TOKEN = "11111111-1111-4111-8111-111111111111";

const cancelData = {
  call_id: "00000000-0000-4000-8000-000000000011",
  session_id: "session-1",
  status: "ended" as const,
  teardown: {
    released_batch_claims: 1,
    revoked_bindings: 1,
    revoked_device_leases: 1,
    ended_shifts: 1,
    released_worker_leases: 1,
  },
};

function target(overrides: Record<string, unknown> = {}) {
  return { phoneE164: "+18165550123", callToken: CALL_TOKEN, ...overrides };
}

class FakeRtcClient {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly connect = vi.fn(async () => this.emit("telnyx.ready"));
  readonly disconnect = vi.fn(async () => undefined);
  readonly login = vi.fn(async () => undefined);

  on(eventName: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
    return this;
  }

  emit(eventName: string, value?: unknown): void {
    for (const handler of this.handlers.get(eventName) ?? []) handler(value);
  }
}

class FakeCall {
  id = "browser-leg-1";
  direction = "inbound";
  state = "ringing";
  sipCode = 0;
  sipReason = "";
  cause = "";
  readonly answer = vi.fn(async () => undefined);
  readonly hangup = vi.fn(async () => undefined);
  readonly muteAudio = vi.fn();
  readonly unmuteAudio = vi.fn();
  readonly hold = vi.fn(async () => undefined);
  readonly unhold = vi.fn(async () => undefined);
}

function transportHarness(overrides: Partial<JitterTransportDependencies> = {}) {
  const rtc = new FakeRtcClient();
  let now = Date.parse("2026-08-21T20:00:00.000Z");
  let pageHide: (() => void) | null = null;
  const dependencies: JitterTransportDependencies = {
    startCall: vi.fn(async () => ({ ok: true as const, data: { callId: "call-1", batchId: "batch-1" } })),
    getToken: vi.fn(async () => ({
      ok: true as const,
      data: {
        rtc_token: "rtc-token-1",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T20:05:00.000Z",
      },
    })),
    connect: vi.fn(async () => ({ ok: true as const, data: { dialing: true as const } })),
    cancel: vi.fn(async () => ({ ok: true as const, data: cancelData })),
    createRtcClient: vi.fn(async () => rtc),
    createRemoteAudio: vi.fn(() => null),
    subscribePageHide: vi.fn((handler) => {
      pageHide = handler;
      return vi.fn();
    }),
    sendCancelBeacon: vi.fn(() => false),
    now: () => now,
    registrationTimeoutMs: 100,
    ...overrides,
  };
  return {
    rtc,
    dependencies,
    transport: new JitterCallTransport(dependencies),
    setNow(value: number) { now = value; },
    firePageHide() { pageHide?.(); },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("JitterCallTransport", () => {
  it("runs start -> token -> RTC register -> connect, controls the call, and tears down", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    await expect(harness.transport.start(target({
      propertyId: "property-1",
      contactId: "contact-1",
    }))).resolves.toEqual({ id: "call-1" });
    expect(harness.dependencies.startCall).toHaveBeenCalledBefore(harness.dependencies.getToken as ReturnType<typeof vi.fn>);
    expect(harness.dependencies.getToken).toHaveBeenCalledBefore(harness.dependencies.connect as ReturnType<typeof vi.fn>);

    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    expect(call.answer).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.connect).toHaveBeenNthCalledWith(1, "call-1", "registered");
    expect(harness.dependencies.connect).toHaveBeenCalledTimes(1);
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    expect(harness.dependencies.connect).toHaveBeenNthCalledWith(2, "call-1", "accepted");
    harness.transport.mute(true);
    harness.transport.mute(false);
    harness.transport.hold(true);
    harness.transport.hold(false);
    await flush();
    expect(call.muteAudio).toHaveBeenCalledTimes(1);
    expect(call.unmuteAudio).toHaveBeenCalledTimes(1);
    expect(call.hold).toHaveBeenCalledTimes(1);
    expect(call.unhold).toHaveBeenCalledTimes(1);

    harness.setNow(Date.parse("2026-08-21T20:00:03.900Z"));
    await expect(harness.transport.hangup()).resolves.toEqual({
      durationSeconds: 3,
      outcome: "connected_human",
    });
    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith("call-1", "hangup");
    expect(harness.rtc.disconnect).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["connecting", "ringing", "live", "ended"]);
  });

  it.each([
    [409, "operator_busy"],
    [422, "not_callable"],
  ] as const)("maps a %s start envelope to the distinct %s state without inventing a call to cancel", async (status, errorCode) => {
    const startCall = vi.fn(async () => ({
      ok: false as const,
      status,
      error: "Cannot start.",
      errorCode,
    }));
    const harness = transportHarness({ startCall });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await expect(harness.transport.start(target())).rejects.toMatchObject({ name: errorCode });
    expect(states).toEqual(["connecting", errorCode]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("retries a lost accepted-phase response while the same call remains active", async () => {
    const connect = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { dialing: true } })
      .mockRejectedValueOnce(new Error("accepted response lost"))
      .mockResolvedValueOnce({ ok: true, data: { dialing: true } });
    const harness = transportHarness({ connect });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    expect(connect).toHaveBeenNthCalledWith(1, "call-1", "registered");
    expect(connect).toHaveBeenNthCalledWith(2, "call-1", "accepted");
    expect(connect).toHaveBeenNthCalledWith(3, "call-1", "accepted");
    expect(states).toEqual(["connecting", "ringing", "live"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("rejects an expired initial RTC token and cancels the provisioned session", async () => {
    const getToken = vi.fn(async () => ({
      ok: true as const,
      data: {
        rtc_token: "expired-token",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T19:59:59.000Z",
      },
    }));
    const harness = transportHarness({ getToken });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await expect(harness.transport.start(target())).rejects.toMatchObject({
      name: "rtc_token_expired",
    });
    expect(harness.dependencies.createRtcClient).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).toHaveBeenCalledWith("call-1", "failed");
    expect(states).toEqual(["connecting", "failed"]);
  });

  it("refreshes the short-lived token on Telnyx's expiry warning", async () => {
    const getToken = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: { rtc_token: "rtc-token-1", sip_identity: "operator-1", expires_at: "2026-08-21T20:05:00.000Z" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { rtc_token: "rtc-token-2", sip_identity: "operator-1", expires_at: "2026-08-21T20:10:00.000Z" },
      });
    const harness = transportHarness({ getToken });
    await harness.transport.start(target());
    harness.rtc.emit("telnyx.warning", { warning: { code: 34_001 } });
    await flush();
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(harness.rtc.login).toHaveBeenCalledWith({ creds: { login_token: "rtc-token-2" } });
  });

  it("does not relogin with a refreshed token after teardown starts", async () => {
    let resolveRefresh!: (value: {
      ok: true;
      data: { rtc_token: string; sip_identity: string; expires_at: string };
    }) => void;
    const getToken = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: { rtc_token: "rtc-token-1", sip_identity: "operator-1", expires_at: "2026-08-21T20:05:00.000Z" },
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    const harness = transportHarness({ getToken });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    harness.rtc.emit("telnyx.warning", { warning: { code: 34_001 } });
    await flush();
    await harness.transport.hangup();
    resolveRefresh({
      ok: true,
      data: { rtc_token: "late-token", sip_identity: "operator-1", expires_at: "2026-08-21T20:10:00.000Z" },
    });
    await flush();
    expect(harness.rtc.login).not.toHaveBeenCalled();
    expect(states).toEqual(["connecting", "ended"]);
  });

  it("maps a remote terminal event and RTC errors to idempotent teardown", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    const unexpectedCall = new FakeCall();
    unexpectedCall.id = "unexpected-browser-leg";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: unexpectedCall });
    expect(unexpectedCall.answer).not.toHaveBeenCalled();
    call.state = "hangup";
    call.cause = "NORMAL_CLEARING";
    call.sipReason = "Normal Clearing";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    harness.rtc.emit("telnyx.error", { error: new Error("late duplicate error") });
    await flush();
    expect(states).toEqual(["connecting", "ringing", "live", "ended"]);
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith("call-1", "hangup");
  });

  it("keeps failed outcome and real duration when RTC fails after the call became live", async () => {
    const harness = transportHarness();
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    harness.setNow(Date.parse("2026-08-21T20:00:04.200Z"));
    harness.rtc.emit("telnyx.error", { error: new Error("media failed") });
    await flush();
    await expect(harness.transport.hangup()).resolves.toEqual({ durationSeconds: 4, outcome: "failed" });
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith("call-1", "failed");
  });

  it("fails locally without rejecting hangup when the cancel Server Action throws", async () => {
    const cancel = vi.fn(async () => { throw new Error("action transport failed"); });
    const harness = transportHarness({ cancel });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    await expect(harness.transport.hangup()).resolves.toEqual({ durationSeconds: 0, outcome: "failed" });
    expect(states).toEqual(["connecting", "failed"]);
    expect(harness.rtc.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate hold signaling and fails closed when hold state cannot be trusted", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    harness.transport.hold(true);
    await flush();
    call.state = "held";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    harness.rtc.emit("telnyx.error", { error: { code: 44_001, message: "HOLD_FAILED" } });
    await flush();
    expect(call.hold).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith("call-1", "failed");
    expect(states).toEqual(["connecting", "ringing", "live", "failed"]);
  });

  it("does not turn a BYE send warning into a second terminal path", async () => {
    const harness = transportHarness();
    await harness.transport.start(target());
    const hangup = harness.transport.hangup();
    harness.rtc.emit("telnyx.error", { error: { code: 44_003, message: "BYE_SEND_FAILED" } });
    await expect(hangup).resolves.toMatchObject({ outcome: "failed" });
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
  });

  it("fails closed when mute state cannot be trusted", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.muteAudio.mockImplementationOnce(() => { throw new Error("mute failed"); });
    harness.transport.mute(true);
    await flush();
    expect(states).toEqual(["connecting", "ringing", "live", "failed"]);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith("call-1", "failed");
  });

  it("allows Telnyx signaling recovery instead of canceling on a transient socket loss", async () => {
    const harness = transportHarness();
    await harness.transport.start(target());
    const originalCall = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: originalCall });
    originalCall.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: originalCall });
    harness.transport.mute(true);
    harness.rtc.emit("telnyx.socket.close");
    harness.rtc.emit("telnyx.error", { error: { code: 45_002, message: "WEBSOCKET_ERROR" } });
    harness.rtc.emit("telnyx.ready");
    const recoveredCall = new FakeCall() as FakeCall & { recoveredCallId: string };
    recoveredCall.id = "browser-leg-2";
    recoveredCall.recoveredCallId = "browser-leg-1";
    recoveredCall.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recoveredCall });
    await flush();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(originalCall.muteAudio).toHaveBeenCalledTimes(1);
    expect(recoveredCall.muteAudio).toHaveBeenCalledTimes(1);
  });

  it("captures duration at terminal intent instead of including slow cancel latency", async () => {
    let resolveCancel!: (value: { ok: true; data: typeof cancelData }) => void;
    const cancel = vi.fn(() => new Promise<{ ok: true; data: typeof cancelData }>((resolve) => {
      resolveCancel = resolve;
    }));
    const harness = transportHarness({ cancel });
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    harness.setNow(Date.parse("2026-08-21T20:00:02.900Z"));
    const result = harness.transport.hangup();
    await flush();
    harness.setNow(Date.parse("2026-08-21T20:00:20.000Z"));
    resolveCancel({ ok: true, data: cancelData });
    await expect(result).resolves.toEqual({ durationSeconds: 2, outcome: "connected_human" });
  });

  it("uses the authenticated same-origin beacon on pagehide and avoids duplicate cancellation", async () => {
    const sendCancelBeacon = vi.fn(() => true);
    const harness = transportHarness({ sendCancelBeacon });
    await harness.transport.start(target());
    harness.firePageHide();
    await flush();
    expect(sendCancelBeacon).toHaveBeenCalledWith("call-1", "abandoned");
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(harness.rtc.disconnect).toHaveBeenCalledTimes(1);
    await harness.transport.hangup();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

});

describe("mapTelnyxCallState", () => {
  it("maps Telnyx conference-leg states onto the unchanged Sandra seam", () => {
    expect(mapTelnyxCallState({ direction: "inbound", state: "ringing" }, false)).toBe("ringing");
    expect(mapTelnyxCallState({ state: "active" }, false)).toBe("live");
    expect(mapTelnyxCallState({ state: "held" }, true)).toBe("live");
    expect(mapTelnyxCallState({ state: "hangup" }, true)).toBe("ended");
    expect(mapTelnyxCallState({ state: "hangup", cause: "NORMAL_CLEARING", sipReason: "Normal Clearing" }, true)).toBe("ended");
    expect(mapTelnyxCallState({ state: "destroy" }, false)).toBe("failed");
    expect(mapTelnyxCallState({ state: "hangup", sipCode: 486, sipReason: "Busy Here" }, false)).toBe("failed");
  });
});
