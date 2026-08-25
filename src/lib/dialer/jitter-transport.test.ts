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
  return {
    phoneE164: "+18165550123",
    callToken: CALL_TOKEN,
    intentCapability: "intent-capability",
    ...overrides,
  };
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

function transportHarness(
  overrides: Partial<JitterTransportDependencies> = {},
) {
  const rtc = new FakeRtcClient();
  let now = Date.parse("2026-08-21T20:00:00.000Z");
  let pageHide: (() => void) | null = null;
  const dependencies: JitterTransportDependencies = {
    prepareMicrophone: vi.fn(async () => undefined),
    startCall: vi.fn(async () => ({
      ok: true as const,
      data: { callId: "call-1", batchId: "batch-1" },
      ambiguous: false,
    })),
    getToken: vi.fn(async () => ({
      ok: true as const,
      data: {
        rtc_token: "rtc-token-1",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T20:05:00.000Z",
      },
    })),
    connect: vi.fn(async () => ({
      ok: true as const,
      data: { dialing: true as const },
    })),
    cancel: vi.fn(async () => ({ ok: true as const, data: cancelData })),
    cancelByStartIntent: vi.fn(async () => ({ ok: true as const, data: cancelData })),
    reportAudioHealth: vi.fn(async () => ({
      ok: true as const,
      data: { accepted: true, status: "healthy" as const },
    })),
    sendDigit: vi.fn(async () => ({ ok: true as const, data: { sent: true as const } })),
    createRtcClient: vi.fn(async () => rtc),
    createRemoteAudio: vi.fn(() => null),
    subscribePageHide: vi.fn((handler) => {
      pageHide = handler;
      return vi.fn(() => {
        if (pageHide === handler) pageHide = null;
      });
    }),
    sendCancelBeacon: vi.fn(() => false),
    sleep: vi.fn(async () => undefined),
    scheduleAudioHealth: vi.fn(() => () => undefined),
    now: () => now,
    registrationTimeoutMs: 100,
    ...overrides,
  };
  return {
    rtc,
    dependencies,
    transport: new JitterCallTransport(dependencies),
    setNow(value: number) {
      now = value;
    },
    firePageHide() {
      pageHide?.();
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("JitterCallTransport", () => {
  it("reports durable inbound RTP counters while the browser leg is live and stops on teardown", async () => {
    let scheduled: (() => void) | undefined;
    const stop = vi.fn();
    const scheduleAudioHealth = vi.fn((handler: () => void) => {
      scheduled = handler;
      return stop;
    });
    const reportAudioHealth = vi.fn(async () => ({
      ok: true as const,
      data: { accepted: true, status: "healthy" as const },
    }));
    const harness = transportHarness({
      scheduleAudioHealth,
      reportAudioHealth,
    });
    await harness.transport.start(target({ propertyId: "property-1" }));
    const stats = new Map<string, Record<string, unknown>>([
      [
        "audio-inbound",
        {
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived: 12,
          bytesReceived: 2048,
        },
      ],
    ]);
    const call = new FakeCall() as FakeCall & {
      peer: { instance: RTCPeerConnection };
    };
    call.peer = {
      instance: {
        connectionState: "connected",
        getStats: vi.fn(async () => stats),
      } as unknown as RTCPeerConnection,
    };
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(1));
    expect(reportAudioHealth).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({
        peer_connection_generation: 1,
        sample_sequence: 1,
        packets_received: 12,
        bytes_received: 2048,
      }),
    );
    scheduled?.();
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(2));

    await harness.transport.hangup();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("releases the sampling guard when an audio-health report stalls", async () => {
    vi.useFakeTimers();
    try {
      let scheduled: (() => void) | undefined;
      const held = new Promise<never>(() => undefined);
      const reportAudioHealth = vi
        .fn()
        .mockImplementationOnce(() => held)
        .mockResolvedValue({
          ok: true as const,
          data: { accepted: true, status: "healthy" as const },
        });
      const harness = transportHarness({
        reportAudioHealth,
        scheduleAudioHealth(handler) {
          scheduled = handler;
          return () => undefined;
        },
      });
      await harness.transport.start(target({ propertyId: "property-1" }));
      const stats = new Map<string, Record<string, unknown>>([
        [
          "audio-inbound",
          {
            type: "inbound-rtp",
            kind: "audio",
            packetsReceived: 12,
            bytesReceived: 2048,
          },
        ],
      ]);
      const call = new FakeCall() as FakeCall & {
        peer: { instance: RTCPeerConnection };
      };
      call.peer = {
        instance: {
          connectionState: "connected",
          getStats: vi.fn(async () => stats),
        } as unknown as RTCPeerConnection,
      };
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      call.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      await vi.advanceTimersByTimeAsync(0);
      expect(reportAudioHealth).toHaveBeenCalledTimes(1);

      scheduled?.();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(reportAudioHealth).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      scheduled?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(reportAudioHealth).toHaveBeenCalledTimes(2);
      expect(reportAudioHealth.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ sample_sequence: 2 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs start -> token -> RTC register -> connect, controls the call, and tears down", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    await expect(
      harness.transport.start(
        target({
          propertyId: "property-1",
          contactId: "contact-1",
        }),
      ),
    ).resolves.toEqual({ id: "call-1" });
    expect(harness.dependencies.prepareMicrophone).toHaveBeenCalledBefore(
      harness.dependencies.startCall as ReturnType<typeof vi.fn>,
    );
    expect(harness.dependencies.startCall).toHaveBeenCalledBefore(
      harness.dependencies.getToken as ReturnType<typeof vi.fn>,
    );
    expect(harness.dependencies.getToken).toHaveBeenCalledBefore(
      harness.dependencies.connect as ReturnType<typeof vi.fn>,
    );

    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    expect(call.answer).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.connect).toHaveBeenNthCalledWith(
      1,
      "call-1",
      "registered",
    );
    expect(harness.dependencies.connect).toHaveBeenCalledTimes(1);
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    expect(harness.dependencies.connect).toHaveBeenNthCalledWith(
      2,
      "call-1",
      "accepted",
    );
    harness.transport.mute(true);
    harness.transport.mute(false);
    await expect(harness.transport.sendDigit("5")).resolves.toBe(true);
    await harness.transport.hold(true);
    await expect(harness.transport.sendDigit("#")).resolves.toBe(false);
    await harness.transport.hold(false);
    await expect(harness.transport.sendDigit("#")).resolves.toBe(true);
    await flush();
    expect(call.muteAudio).toHaveBeenCalledTimes(1);
    expect(call.unmuteAudio).toHaveBeenCalledTimes(1);
    expect(call.hold).toHaveBeenCalledTimes(1);
    expect(call.unhold).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.sendDigit).toHaveBeenNthCalledWith(1, "call-1", "5");
    expect(harness.dependencies.sendDigit).toHaveBeenNthCalledWith(2, "call-1", "#");

    harness.setNow(Date.parse("2026-08-21T20:00:03.900Z"));
    await expect(harness.transport.hangup()).resolves.toEqual({
      durationSeconds: 3,
      outcome: "connected_human",
    });
    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "hangup",
    );
    expect(harness.rtc.disconnect).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["connecting", "ringing", "live", "ended"]);
  });

  it("serializes rapid digits and drops queued digits after hangup", async () => {
    const pending: Array<(value: { ok: true; data: { sent: true } }) => void> = [];
    const sendDigit = vi.fn(() => new Promise<{ ok: true; data: { sent: true } }>((resolve) => pending.push(resolve)));
    const harness = transportHarness({ sendDigit });
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();

    const first = harness.transport.sendDigit("1");
    const second = harness.transport.sendDigit("2");
    const third = harness.transport.sendDigit("3");
    await flush();
    expect(sendDigit).toHaveBeenCalledTimes(1);
    expect(sendDigit).toHaveBeenNthCalledWith(1, "call-1", "1");

    pending.shift()?.({ ok: true, data: { sent: true } });
    await expect(first).resolves.toBe(true);
    await flush();
    expect(sendDigit).toHaveBeenCalledTimes(2);
    expect(sendDigit).toHaveBeenNthCalledWith(2, "call-1", "2");

    const hangup = harness.transport.hangup();
    pending.shift()?.({ ok: true, data: { sent: true } });
    await expect(second).resolves.toBe(true);
    await expect(third).resolves.toBe(false);
    await hangup;
    expect(sendDigit).toHaveBeenCalledTimes(2);
  });

  it("drops queued digits across a completed hold and resume cycle", async () => {
    let resolveFirst: ((value: { ok: true; data: { sent: true } }) => void) | undefined;
    const sendDigit = vi.fn(() => new Promise<{ ok: true; data: { sent: true } }>((resolve) => { resolveFirst = resolve; }));
    const harness = transportHarness({ sendDigit });
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();

    const first = harness.transport.sendDigit("1");
    const stale = harness.transport.sendDigit("2");
    await flush();
    expect(sendDigit).toHaveBeenCalledTimes(1);
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    await expect(harness.transport.hold(false)).resolves.toBe(true);
    resolveFirst?.({ ok: true, data: { sent: true } });

    await expect(first).resolves.toBe(true);
    await expect(stale).resolves.toBe(false);
    expect(sendDigit).toHaveBeenCalledTimes(1);
  });

  it("fails before provisioning when microphone access is unavailable", async () => {
    const prepareMicrophone = vi.fn(async () => {
      throw new Error("Microphone access is required to place calls.");
    });
    const harness = transportHarness({ prepareMicrophone });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    await expect(harness.transport.start(target())).rejects.toThrow(
      "Microphone access is required",
    );

    expect(harness.dependencies.startCall).not.toHaveBeenCalled();
    expect(harness.dependencies.getToken).not.toHaveBeenCalled();
    expect(harness.dependencies.connect).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(states).toEqual(["connecting", "failed"]);
  });

  it.each([
    [409, "operator_busy"],
    [422, "not_callable"],
    [422, "caller_id_unavailable"],
  ] as const)(
    "maps a %s start envelope to the distinct %s state without inventing a call to cancel",
    async (status, errorCode) => {
      const startCall = vi.fn(async () => ({
        ok: false as const,
        status,
        error: "Cannot start.",
        errorCode,
        ambiguous: false,
      }));
      const harness = transportHarness({ startCall });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await expect(harness.transport.start(target())).rejects.toMatchObject({
        name: errorCode,
      });
      expect(states).toEqual(["connecting", errorCode]);
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(harness.dependencies.cancelByStartIntent).not.toHaveBeenCalled();
    },
  );

  it.each([
    [500, "softphone_start_failed"],
    [503, "caller_id_inventory_unavailable"],
  ] as const)(
    "uses start-intent teardown for a delivered %s after Jitter may have provisioned",
    async (status, errorCode) => {
      const startCall = vi.fn(async () => ({
        ok: false as const,
        status,
        error: "Cannot start.",
        errorCode,
        ambiguous: true,
      }));
      const harness = transportHarness({ startCall });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await expect(harness.transport.start(target())).rejects.toMatchObject({
        name: errorCode,
      });
      expect(harness.dependencies.cancelByStartIntent).toHaveBeenCalledWith(
        "intent-capability",
        "failed",
      );
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(states).toEqual(["connecting", "failed"]);
    },
  );

  it("uses start-intent teardown after a thrown/lost start response", async () => {
    const startCall = vi.fn()
      .mockRejectedValueOnce(new Error("start action response lost"))
      .mockRejectedValueOnce(new Error("start action response lost again"));
    const harness = transportHarness({ startCall });
    await expect(harness.transport.start(target())).rejects.toThrow(
      "start action response lost again",
    );
    expect(harness.dependencies.cancelByStartIntent).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("fires fallback for a delivered success with a lost or malformed body", async () => {
    const startCall = vi.fn(async () => ({
      ok: false as const,
      status: 502,
      error: "Jitter softphone returned an invalid response.",
      errorCode: "jitter_contract_violation",
      ambiguous: true,
    }));
    const harness = transportHarness({ startCall });
    await expect(harness.transport.start(target())).rejects.toMatchObject({
      name: "jitter_contract_violation",
    });
    expect(harness.dependencies.cancelByStartIntent).toHaveBeenCalledWith(
      "intent-capability",
      "failed",
    );
  });

  it("leaves teardown unconfirmed across repeated 404s and confirms only on 200", async () => {
    const startCall = vi.fn(async () => ({
      ok: false as const,
      status: 500,
      error: "May have provisioned.",
      errorCode: "softphone_start_failed",
      ambiguous: true,
    }));
    const cancelByStartIntent = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, status: 404, error: "Not found", errorCode: "not_found" })
      .mockResolvedValueOnce({ ok: false as const, status: 404, error: "Not found", errorCode: "not_found" })
      .mockResolvedValueOnce({ ok: false as const, status: 404, error: "Not found", errorCode: "not_found" })
      .mockResolvedValueOnce({ ok: true as const, data: cancelData });
    const harness = transportHarness({ startCall, cancelByStartIntent });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await expect(harness.transport.start(target())).rejects.toMatchObject({
      name: "softphone_start_failed",
    });
    expect(cancelByStartIntent).toHaveBeenCalledTimes(3);
    expect(states).toContain("teardown_unconfirmed");
    await harness.transport.hangup();
    expect(cancelByStartIntent).toHaveBeenCalledTimes(4);
    expect(states).toContain("teardown_confirmed");
  });

  it("does not mint or cancel by intent in simulated mode", async () => {
    const harness = transportHarness({
      cancelByStartIntent: vi.fn(async () => ({ ok: true as const, data: cancelData })),
    });
    await harness.transport.start(target({ intentCapability: undefined }));
    await harness.transport.hangup();
    expect(harness.dependencies.cancelByStartIntent).not.toHaveBeenCalled();
  });

  it("retries a lost accepted-phase response while the same call remains active", async () => {
    const connect = vi
      .fn()
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

  it("retries a lost start Server Action response with the identical call token", async () => {
    const startCall = vi
      .fn()
      .mockRejectedValueOnce(new Error("start action response lost"))
      .mockResolvedValueOnce({
        ok: true,
        data: { callId: "call-1", batchId: "batch-1" },
      });
    const harness = transportHarness({ startCall });
    const callTarget = target({
      propertyId: "property-1",
      contactId: "contact-1",
    });

    await expect(harness.transport.start(callTarget)).resolves.toEqual({
      id: "call-1",
    });
    expect(startCall).toHaveBeenCalledTimes(2);
    expect(startCall).toHaveBeenNthCalledWith(1, callTarget);
    expect(startCall).toHaveBeenNthCalledWith(2, callTarget);
    expect(startCall.mock.calls[1][0].callToken).toBe(CALL_TOKEN);
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
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "failed",
    );
    expect(states).toEqual(["connecting", "failed"]);
  });

  it("refreshes the short-lived token on Telnyx's expiry warning", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          rtc_token: "rtc-token-1",
          sip_identity: "operator-1",
          expires_at: "2026-08-21T20:05:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          rtc_token: "rtc-token-2",
          sip_identity: "operator-1",
          expires_at: "2026-08-21T20:10:00.000Z",
        },
      });
    const harness = transportHarness({ getToken });
    await harness.transport.start(target());
    harness.rtc.emit("telnyx.warning", { warning: { code: 34_001 } });
    await flush();
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(harness.rtc.login).toHaveBeenCalledWith({
      creds: { login_token: "rtc-token-2" },
    });
  });

  it("does not relogin with a refreshed token after teardown starts", async () => {
    let resolveRefresh!: (value: {
      ok: true;
      data: { rtc_token: string; sip_identity: string; expires_at: string };
    }) => void;
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          rtc_token: "rtc-token-1",
          sip_identity: "operator-1",
          expires_at: "2026-08-21T20:05:00.000Z",
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const harness = transportHarness({ getToken });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    harness.rtc.emit("telnyx.warning", { warning: { code: 34_001 } });
    await flush();
    await harness.transport.hangup();
    resolveRefresh({
      ok: true,
      data: {
        rtc_token: "late-token",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T20:10:00.000Z",
      },
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
    harness.rtc.emit("telnyx.notification", {
      type: "callUpdate",
      call: unexpectedCall,
    });
    expect(unexpectedCall.answer).not.toHaveBeenCalled();
    call.state = "hangup";
    call.cause = "NORMAL_CLEARING";
    call.sipReason = "Normal Clearing";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();
    harness.rtc.emit("telnyx.error", {
      error: new Error("late duplicate error"),
    });
    await flush();
    expect(states).toEqual(["connecting", "ringing", "live", "ended"]);
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "hangup",
    );
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
    await expect(harness.transport.hangup()).resolves.toEqual({
      durationSeconds: 4,
      outcome: "failed",
    });
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "failed",
    );
  });

  it("warns after bounded cancel retries and does not memoize the failed attempt", async () => {
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error("action transport failed 1"))
      .mockRejectedValueOnce(new Error("action transport failed 2"))
      .mockRejectedValueOnce(new Error("action transport failed 3"))
      .mockResolvedValueOnce({ ok: true, data: cancelData });
    const harness = transportHarness({ cancel });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    await expect(harness.transport.hangup()).resolves.toEqual({
      durationSeconds: 0,
      outcome: "failed",
    });
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(harness.dependencies.sleep).toHaveBeenCalledTimes(2);
    expect(states).toEqual(["connecting", "teardown_unconfirmed", "failed"]);
    await expect(harness.transport.hangup()).resolves.toEqual({
      durationSeconds: 0,
      outcome: "failed",
    });
    expect(cancel).toHaveBeenCalledTimes(4);
    expect(harness.rtc.disconnect).toHaveBeenCalledTimes(1);
    expect(states).toEqual([
      "connecting",
      "teardown_unconfirmed",
      "failed",
      "teardown_confirmed",
    ]);
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
    harness.rtc.emit("telnyx.error", {
      error: { code: 44_001, message: "HOLD_FAILED" },
    });
    await flush();
    expect(call.hold).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "failed",
    );
    expect(states).toEqual(["connecting", "ringing", "live", "failed"]);
  });

  it("does not turn a BYE send warning into a second terminal path", async () => {
    const harness = transportHarness();
    await harness.transport.start(target());
    const hangup = harness.transport.hangup();
    harness.rtc.emit("telnyx.error", {
      error: { code: 44_003, message: "BYE_SEND_FAILED" },
    });
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
    call.muteAudio.mockImplementationOnce(() => {
      throw new Error("mute failed");
    });
    harness.transport.mute(true);
    await flush();
    expect(states).toEqual(["connecting", "ringing", "live", "failed"]);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "failed",
    );
  });

  it("allows Telnyx signaling recovery instead of canceling on a transient socket loss", async () => {
    const harness = transportHarness();
    await harness.transport.start(target());
    const originalCall = new FakeCall();
    harness.rtc.emit("telnyx.notification", {
      type: "callUpdate",
      call: originalCall,
    });
    originalCall.state = "active";
    harness.rtc.emit("telnyx.notification", {
      type: "callUpdate",
      call: originalCall,
    });
    harness.transport.mute(true);
    harness.rtc.emit("telnyx.socket.close");
    harness.rtc.emit("telnyx.error", {
      error: { code: 45_002, message: "WEBSOCKET_ERROR" },
    });
    harness.rtc.emit("telnyx.ready");
    const recoveredCall = new FakeCall() as FakeCall & {
      recoveredCallId: string;
    };
    recoveredCall.id = "browser-leg-2";
    recoveredCall.recoveredCallId = "browser-leg-1";
    recoveredCall.state = "active";
    harness.rtc.emit("telnyx.notification", {
      type: "callUpdate",
      call: recoveredCall,
    });
    await flush();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(originalCall.muteAudio).toHaveBeenCalledTimes(1);
    expect(recoveredCall.muteAudio).toHaveBeenCalledTimes(1);
  });

  it("captures duration at terminal intent instead of including slow cancel latency", async () => {
    let resolveCancel!: (value: { ok: true; data: typeof cancelData }) => void;
    const cancel = vi.fn(
      () =>
        new Promise<{ ok: true; data: typeof cancelData }>((resolve) => {
          resolveCancel = resolve;
        }),
    );
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
    await expect(result).resolves.toEqual({
      durationSeconds: 2,
      outcome: "connected_human",
    });
  });

  it("treats an accepted pagehide beacon as queueing only and still confirms with the Server Action", async () => {
    const sendCancelBeacon = vi.fn(() => true);
    const harness = transportHarness({ sendCancelBeacon });
    await harness.transport.start(target());
    harness.firePageHide();
    await flush();
    expect(sendCancelBeacon).toHaveBeenCalledWith("call-1", "abandoned");
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "abandoned",
    );
    expect(harness.rtc.disconnect).toHaveBeenCalledTimes(1);
    await harness.transport.hangup();
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
  });

  it("queues the pagehide beacon while an authoritative cancel is still in flight", async () => {
    let resolveCancel!: (value: { ok: true; data: typeof cancelData }) => void;
    const cancel = vi.fn(
      () =>
        new Promise<{ ok: true; data: typeof cancelData }>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const sendCancelBeacon = vi.fn(() => true);
    const harness = transportHarness({ cancel, sendCancelBeacon });
    await harness.transport.start(target());
    const hangup = harness.transport.hangup();
    await flush();

    harness.firePageHide();
    expect(sendCancelBeacon).toHaveBeenCalledWith("call-1", "abandoned");
    expect(cancel).toHaveBeenCalledTimes(1);

    resolveCancel({ ok: true, data: cancelData });
    await hangup;
  });

  it("retains pagehide recovery after bounded cancel attempts remain unconfirmed", async () => {
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost 1"))
      .mockRejectedValueOnce(new Error("lost 2"))
      .mockRejectedValueOnce(new Error("lost 3"))
      .mockResolvedValueOnce({ ok: true, data: cancelData });
    const sendCancelBeacon = vi.fn(() => true);
    const harness = transportHarness({ cancel, sendCancelBeacon });
    await harness.transport.start(target());
    await harness.transport.hangup();

    harness.firePageHide();
    await flush();
    expect(sendCancelBeacon).toHaveBeenCalledWith("call-1", "abandoned");
    expect(cancel).toHaveBeenLastCalledWith("call-1", "abandoned");
    expect(cancel).toHaveBeenCalledTimes(4);
  });
});

describe("mapTelnyxCallState", () => {
  it("maps Telnyx conference-leg states onto the unchanged Sandra seam", () => {
    expect(
      mapTelnyxCallState({ direction: "inbound", state: "ringing" }, false),
    ).toBe("ringing");
    expect(mapTelnyxCallState({ state: "active" }, false)).toBe("live");
    expect(mapTelnyxCallState({ state: "held" }, true)).toBe("live");
    expect(mapTelnyxCallState({ state: "hangup" }, true)).toBe("ended");
    expect(
      mapTelnyxCallState(
        {
          state: "hangup",
          cause: "NORMAL_CLEARING",
          sipReason: "Normal Clearing",
        },
        true,
      ),
    ).toBe("ended");
    expect(mapTelnyxCallState({ state: "destroy" }, false)).toBe("failed");
    expect(
      mapTelnyxCallState(
        { state: "hangup", sipCode: 486, sipReason: "Busy Here" },
        false,
      ),
    ).toBe("failed");
  });
});
