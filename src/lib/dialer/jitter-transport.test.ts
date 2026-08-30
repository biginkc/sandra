import { describe, expect, it, vi } from "vitest";

import {
  JitterCallTransport,
  mapTelnyxCallState,
  type JitterTransportDependencies,
} from "./jitter-transport";
import type {
  JitterAudioHealthResponse,
  JitterAudioHealthSample,
  JitterProxyResult,
} from "./jitter-contract";

const CALL_TOKEN = "11111111-1111-4111-8111-111111111111";
const JITTER_LOCAL_MEDIA_SAMPLE_TIMEOUT_MS_FOR_TEST = 1_500;
const OPERATOR_CALL_CONTROL_ID = "v3:operator-browser-leg";

function registeredConnectData() {
  return {
    dialing: true as const,
    operator_attach_identity: {
      provider_id: "telnyx" as const,
      operator_provider_call_control_id: OPERATOR_CALL_CONTROL_ID,
      operator_call_operation_id: "operator_call_retry_1",
      run_id: "run-1",
      request_generation: "operator_call_retry_1",
    },
  };
}

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
  readonly socketDisconnect = vi.fn(() => this.emit("telnyx.socket.close"));
  readonly serverDisconnect = vi.fn(() => this.handlers.clear());
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
  telnyxIDs = { telnyxCallControlId: OPERATOR_CALL_CONTROL_ID };
  readonly answer = vi.fn(async () => undefined);
  readonly hangup = vi.fn(async () => undefined);
  readonly muteAudio = vi.fn();
  readonly unmuteAudio = vi.fn();
  readonly hold = vi.fn<() => Promise<unknown>>(async () => undefined);
  readonly unhold = vi.fn<() => Promise<unknown>>(async () => undefined);
}

function attachConnectedPeer(call: FakeCall): void {
  let packetsReceived = 0;
  (call as FakeCall & { peer: { instance: RTCPeerConnection } }).peer = {
    instance: {
      connectionState: "connected",
      getReceivers: vi.fn(() => [{
        track: { kind: "audio", readyState: "live", enabled: true },
      }]),
      getStats: vi.fn(async () => {
        packetsReceived += 1;
        return new Map([["audio", {
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived,
          bytesReceived: packetsReceived * 160,
        }]]);
      }),
    } as unknown as RTCPeerConnection,
  };
}

type UnavailableStatsMode = "peer missing" | "peer closed" | "getStats rejection" | "missing inbound counters";

function attachUnavailableStatsPeer(call: FakeCall, mode: UnavailableStatsMode): void {
  const typed = call as FakeCall & { peer?: { instance: RTCPeerConnection } };
  if (mode === "peer missing") {
    delete typed.peer;
    return;
  }
  typed.peer = {
    instance: {
      connectionState: mode === "peer closed" ? "closed" : "connected",
      getStats: vi.fn(async () => {
        if (mode === "getStats rejection") throw new Error("stats unavailable");
        return new Map([["outbound", { type: "outbound-rtp", kind: "audio", packetsSent: 1 }]]);
      }),
    } as unknown as RTCPeerConnection,
  };
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
        capabilities: { audio_health_media_state: "v1" as const },
      },
    })),
    getProviderStatus: vi.fn(async () => ({
      ok: true as const,
      data: { state: "active" as const },
    })),
    recoverAudio: vi.fn(async () => ({
      ok: true as const,
      data: { recovering: true as const },
    })),
    connect: vi.fn(async () => ({
      ok: true as const,
      data: registeredConnectData(),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("JitterCallTransport", () => {
  it("reports durable inbound RTP counters while the browser leg is live and stops on teardown", async () => {
    let scheduled: (() => void) | undefined;
    const stop = vi.fn();
    const scheduleAudioHealth = vi.fn((handler: () => void) => {
      scheduled = handler;
      return stop;
    });
    const reportAudioHealth = vi.fn(async (_callId: string, _sample: JitterAudioHealthSample) => ({
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
        media_state: "active",
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

  it("reports intentional hold and one fresh resume baseline before active health resumes", async () => {
    let scheduled: (() => void) | undefined;
    const reportAudioHealth = vi.fn(async (_callId: string, _sample: JitterAudioHealthSample) => ({
      ok: true as const,
      data: { accepted: true, status: "healthy" as const },
    }));
    const harness = transportHarness({
      reportAudioHealth,
      scheduleAudioHealth(handler) {
        scheduled = handler;
        return () => undefined;
      },
    });
    await harness.transport.start(target({ propertyId: "property-1" }));
    const call = new FakeCall() as FakeCall & { peer: { instance: RTCPeerConnection } };
    call.peer = {
      instance: {
        connectionState: "connected",
        getStats: vi.fn(async () => new Map([["audio", {
          type: "inbound-rtp", kind: "audio", packetsReceived: 12, bytesReceived: 2048,
        }]])),
      } as unknown as RTCPeerConnection,
    };
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(1));

    await expect(harness.transport.hold(true)).resolves.toBe(true);
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(2));
    expect(reportAudioHealth.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ media_state: "held" }),
    );

    await expect(harness.transport.hold(false)).resolves.toBe(true);
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(3));
    expect(reportAudioHealth.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ media_state: "resumed" }),
    );
    scheduled?.();
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(4));
    expect(reportAudioHealth.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({ media_state: "active" }),
    );
  });

  it.each<UnavailableStatsMode>([
    "peer missing",
    "peer closed",
    "getStats rejection",
    "missing inbound counters",
  ])("settles successful Hold as synchronizing when %s", async (mode) => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    attachConnectedPeer(call);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await vi.waitFor(() => expect(harness.dependencies.reportAudioHealth).toHaveBeenCalledTimes(1));

    attachUnavailableStatsPeer(call, mode);
    await expect(harness.transport.hold(true)).resolves.toBe(true);

    expect(call.hold).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("hold_sync_pending");
    expect(call.hangup).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it.each<UnavailableStatsMode>([
    "peer missing",
    "peer closed",
    "getStats rejection",
    "missing inbound counters",
  ])("settles successful Resume as synchronizing when %s", async (mode) => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    attachConnectedPeer(call);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await vi.waitFor(() => expect(harness.dependencies.reportAudioHealth).toHaveBeenCalledTimes(1));
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    expect(states.at(-1)).toBe("hold_sync_confirmed");

    attachUnavailableStatsPeer(call, mode);
    await expect(harness.transport.hold(false)).resolves.toBe(true);

    expect(call.unhold).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("resume_sync_pending");
    expect(call.hangup).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("replays the resume baseline after the server commits but the response is lost", async () => {
    let scheduled: (() => void) | undefined;
    const reportAudioHealth = vi
      .fn(async (
        _callId: string,
        _sample: JitterAudioHealthSample,
      ): Promise<JitterProxyResult<JitterAudioHealthResponse>> => ({
        ok: true as const,
        data: { accepted: true, status: "healthy" as const },
      }))
      .mockResolvedValueOnce({
        ok: true as const,
        data: { accepted: true, status: "healthy" as const },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        data: { accepted: true, status: "healthy" as const },
      })
      .mockRejectedValueOnce(new Error("resume response lost after commit"));
    const harness = transportHarness({
      reportAudioHealth,
      scheduleAudioHealth(handler) {
        scheduled = handler;
        return () => undefined;
      },
    });
    await harness.transport.start(target({ propertyId: "property-1" }));
    const call = new FakeCall() as FakeCall & { peer: { instance: RTCPeerConnection } };
    call.peer = {
      instance: {
        connectionState: "connected",
        getStats: vi.fn(async () => new Map([["audio", {
          type: "inbound-rtp", kind: "audio", packetsReceived: 12, bytesReceived: 2048,
        }]])),
      } as unknown as RTCPeerConnection,
    };
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(1));
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(2));
    await expect(harness.transport.hold(false)).resolves.toBe(true);

    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(3));
    expect(reportAudioHealth.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ media_state: "resumed" }),
    );
    scheduled?.();
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(4));
    expect(reportAudioHealth.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({ media_state: "resumed" }),
    );
    scheduled?.();
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(5));
    expect(reportAudioHealth.mock.calls[4]?.[1]).toEqual(
      expect.objectContaining({ media_state: "active" }),
    );
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

      expect(reportAudioHealth.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(reportAudioHealth.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ sample_sequence: 2 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  for (const on of [true, false] as const) {
    it(`bounds never-settling getStats after successful ${on ? "Hold" : "Resume"}`, async () => {
      vi.useFakeTimers();
      try {
        const harness = transportHarness();
        const states: string[] = [];
        harness.transport.onStateChange((state) => states.push(state));
        await harness.transport.start(target());
        const call = new FakeCall();
        harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
        call.state = on ? "active" : "held";
        attachUnavailableStatsPeer(call, "peer closed");
        harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
        (call as FakeCall & { peer: { instance: RTCPeerConnection } }).peer.instance = {
          connectionState: "connected",
          getStats: vi.fn(() => new Promise<RTCStatsReport>(() => undefined)),
        } as unknown as RTCPeerConnection;

        const control = harness.transport.hold(on);
        await vi.advanceTimersByTimeAsync(JITTER_LOCAL_MEDIA_SAMPLE_TIMEOUT_MS_FOR_TEST);
        await expect(control).resolves.toBe(true);

        expect(states).toContain(on ? "hold_sync_pending" : "resume_sync_pending");
        expect(harness.dependencies.cancel).not.toHaveBeenCalled();
        expect(call.hangup).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("bounds never-settling ordinary health stats and ignores their late completion after peer replacement", async () => {
    vi.useFakeTimers();
    try {
      let scheduled: (() => void) | undefined;
      const lateStats = deferred<RTCStatsReport>();
      const reportAudioHealth = vi.fn(async () => ({ ok: true as const, data: { accepted: true, status: "healthy" as const } }));
      const harness = transportHarness({
        reportAudioHealth,
        scheduleAudioHealth: vi.fn((handler) => { scheduled = handler; return () => undefined; }),
      });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.start(target());
      const call = new FakeCall() as FakeCall & { peer: { instance: RTCPeerConnection } };
      call.peer = { instance: {
        connectionState: "connected",
        getReceivers: () => [{ track: { kind: "audio", readyState: "live", enabled: true } }],
        getStats: vi.fn(() => lateStats.promise),
      } as unknown as RTCPeerConnection };
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      call.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.advanceTimersByTimeAsync(JITTER_LOCAL_MEDIA_SAMPLE_TIMEOUT_MS_FOR_TEST);
        scheduled?.();
        await flush();
      }
      await vi.advanceTimersByTimeAsync(JITTER_LOCAL_MEDIA_SAMPLE_TIMEOUT_MS_FOR_TEST);
      expect(states).toContain("audio_reconnect_required");
      const replacement = new FakeCall() as FakeCall & { recoveredCallId: string };
      replacement.id = "late-stats-replacement";
      replacement.recoveredCallId = call.id;
      replacement.state = "active";
      attachConnectedPeer(replacement);
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: replacement });
      lateStats.resolve(new Map([["audio", { type: "inbound-rtp", kind: "audio", packetsReceived: 99, bytesReceived: 999 }]]) as RTCStatsReport);
      await flush();
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(call.hangup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying current recovered media proof after an initially frozen window", async () => {
    let reads = 0;
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const original = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    original.state = "active";
    attachConnectedPeer(original);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    harness.rtc.emit("telnyx.error", { error: { code: 45_003 } });
    const replacement = new FakeCall() as FakeCall & { recoveredCallId: string; peer: { instance: RTCPeerConnection } };
    replacement.id = "delayed-media-leg";
    replacement.recoveredCallId = original.id;
    replacement.state = "active";
    replacement.peer = { instance: {
      connectionState: "connected",
      getReceivers: () => [{ track: { kind: "audio", readyState: "live", enabled: true } }],
      getStats: vi.fn(async () => {
        reads += 1;
        const packets = reads < 5 ? 10 : 10 + reads;
        return new Map([["audio", { type: "inbound-rtp", kind: "audio", packetsReceived: packets, bytesReceived: packets * 160 }]]);
      }),
    } as unknown as RTCPeerConnection };
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: replacement });

    await vi.waitFor(() => expect(states.at(-1)).toBe("live"));
    expect(reads).toBeGreaterThanOrEqual(5);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("bounds a never-settling recovered-media stats read and fences its late result", async () => {
    vi.useFakeTimers();
    try {
      const lateStats = deferred<RTCStatsReport>();
      const harness = transportHarness({ registrationTimeoutMs: 100 });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.start(target());
      const original = new FakeCall();
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
      original.state = "active";
      attachConnectedPeer(original);
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
      harness.rtc.emit("telnyx.error", { error: { code: 45_003 } });

      const stale = new FakeCall() as FakeCall & {
        recoveredCallId: string;
        peer: { instance: RTCPeerConnection };
      };
      stale.id = "never-settling-media-leg";
      stale.recoveredCallId = original.id;
      stale.state = "active";
      stale.peer = { instance: {
        connectionState: "connected",
        getReceivers: () => [{ track: { kind: "audio", readyState: "live", enabled: true } }],
        getStats: vi.fn(() => lateStats.promise),
      } as unknown as RTCPeerConnection };
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: stale });

      await vi.advanceTimersByTimeAsync(JITTER_LOCAL_MEDIA_SAMPLE_TIMEOUT_MS_FOR_TEST);
      expect(states.at(-1)).toBe("audio_reconnect_required");
      expect((harness.transport as unknown as { exactRecoveryAttachGeneration: number | null }).exactRecoveryAttachGeneration).toBeNull();

      const current = new FakeCall() as FakeCall & { recoveredCallId: string };
      current.id = "current-media-leg";
      current.recoveredCallId = stale.id;
      current.state = "active";
      attachConnectedPeer(current);
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: current });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(states.at(-1)).toBe("live"));

      const liveCount = states.filter((state) => state === "live").length;
      lateStats.resolve(new Map([["audio", {
        type: "inbound-rtp",
        kind: "audio",
        packetsReceived: 999,
        bytesReceived: 999_000,
      }]]) as RTCStatsReport);
      await flush();
      expect(states.filter((state) => state === "live")).toHaveLength(liveCount);
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(original.hangup).not.toHaveBeenCalled();
      expect(stale.hangup).not.toHaveBeenCalled();
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
    expect(harness.rtc.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    expect(states).toEqual([
      "connecting",
      "ringing",
      "live",
      "hold_sync_pending",
      "resume_sync_pending",
      "ended",
    ]);
  });

  it("retains a call that becomes live while the registered-connect response is lost", async () => {
    let rejectRegistered!: (error: Error) => void;
    const registered = new Promise<JitterProxyResult<{ dialing: true }>>(
      (_resolve, reject) => {
        rejectRegistered = reject;
      },
    );
    const connect = vi.fn(
      async (_callId: string, phase: "registered" | "accepted") => {
        if (phase === "registered") return registered;
        return { ok: true as const, data: { dialing: true as const } };
      },
    );
    const harness = transportHarness({ connect });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    const started = harness.transport.start(target({ propertyId: "property-1" }));
    for (let attempt = 0; attempt < 20 && connect.mock.calls.length === 0; attempt += 1) {
      await flush();
    }
    expect(connect).toHaveBeenCalledWith("call-1", "registered");
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();

    rejectRegistered(new Error("registered connect response lost"));
    await expect(started).resolves.toEqual({ id: "call-1" });
    await flush();

    expect(states).toContain("live");
    expect(states.at(-1)).toBe("audio_reconnect_required");
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(call.hangup).not.toHaveBeenCalled();
  });

  it("treats a late answer rejection after live as recoverable", async () => {
    let rejectAnswer!: (error: Error) => void;
    const answer = new Promise<undefined>((_resolve, reject) => {
      rejectAnswer = reject;
    });
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target({ propertyId: "property-1" }));
    const call = new FakeCall();
    call.answer.mockImplementationOnce(() => answer);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await flush();

    rejectAnswer(new Error("late answer acknowledgement failed"));
    await flush();

    expect(states.at(-1)).toBe("audio_reconnect_required");
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(call.hangup).not.toHaveBeenCalled();
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

  it("cancels a late start response after hangup begins", async () => {
    let resolveStart!: (value: {
      ok: true;
      data: { callId: string; batchId: string };
      ambiguous: false;
    }) => void;
    const startCall = vi.fn(
      () =>
        new Promise<{
          ok: true;
          data: { callId: string; batchId: string };
          ambiguous: false;
        }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const harness = transportHarness({ startCall });
    const start = harness.transport.start(target());
    await flush();

    const hangup = harness.transport.hangup();
    await flush();
    expect(harness.dependencies.cancelByStartIntent).toHaveBeenCalledWith(
      "intent-capability",
      "hangup",
    );

    resolveStart({
      ok: true,
      data: { callId: "late-call", batchId: "batch-1" },
      ambiguous: false,
    });
    await expect(start).rejects.toThrow("Call start was canceled.");
    await expect(hangup).resolves.toEqual({
      durationSeconds: 0,
      outcome: "failed",
    });
    expect(harness.dependencies.getToken).not.toHaveBeenCalled();
    expect(harness.dependencies.connect).not.toHaveBeenCalled();
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

  it("treats an explicit non-ambiguous 503 as authoritative: no retry, no fallback, no unconfirmed banner", async () => {
    const startCall = vi.fn(async () => ({
      ok: false as const,
      status: 503,
      error: "Jitter softphone is misconfigured.",
      errorCode: "jitter_invalid_configuration",
      ambiguous: false,
    }));
    const harness = transportHarness({ startCall });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await expect(harness.transport.start(target())).rejects.toMatchObject({
      name: "jitter_invalid_configuration",
    });
    expect(startCall).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancelByStartIntent).not.toHaveBeenCalled();
    expect(states).not.toContain("teardown_unconfirmed");
  });

  it("fails closed to teardown_unconfirmed when ambiguous and no cancelByStartIntent dependency exists", async () => {
    const startCall = vi.fn(async () => ({
      ok: false as const,
      status: 500,
      error: "May have provisioned.",
      errorCode: "softphone_start_failed",
      ambiguous: true,
    }));
    const harness = transportHarness({ startCall, cancelByStartIntent: undefined });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await expect(harness.transport.start(target())).rejects.toMatchObject({
      name: "softphone_start_failed",
    });
    expect(states).toContain("teardown_unconfirmed");
    expect(states).not.toContain("teardown_confirmed");
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
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(connect).toHaveBeenNthCalledWith(1, "call-1", "registered");
    expect(connect).toHaveBeenNthCalledWith(2, "call-1", "accepted");
    expect(connect).toHaveBeenNthCalledWith(3, "call-1", "accepted");
    expect(states).toEqual(["connecting", "ringing", "live"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("suppresses a latched recovered-media retry when the pending accepted request succeeds", async () => {
    const accepted = deferred<JitterProxyResult<{ dialing: true }>>();
    const connect = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { dialing: true } })
      .mockImplementationOnce(() => accepted.promise);
    const harness = transportHarness({ connect });
    await harness.transport.start(target());
    const original = new FakeCall();
    attachConnectedPeer(original);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    original.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

    const replacement = new FakeCall() as FakeCall & { recoveredCallId: string };
    replacement.id = "browser-leg-2";
    replacement.recoveredCallId = original.id;
    replacement.state = "active";
    attachConnectedPeer(replacement);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: replacement });
    await flush();
    accepted.resolve({ ok: true, data: { dialing: true } });
    await flush();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(2, "call-1", "accepted");
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(original.hangup).not.toHaveBeenCalled();
    expect(replacement.hangup).not.toHaveBeenCalled();
  });

  it("retries acceptance after every earlier response is lost once recovered media is usable", async () => {
    const connect = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { dialing: true } })
      .mockRejectedValueOnce(new Error("accepted response 1 lost"))
      .mockRejectedValueOnce(new Error("accepted response 2 lost"))
      .mockRejectedValueOnce(new Error("accepted response 3 lost"))
      .mockResolvedValue({ ok: true, data: { dialing: true } });
    const harness = transportHarness({ connect });
    await harness.transport.start(target());
    const original = new FakeCall();
    attachConnectedPeer(original);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    original.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(4));

    const recovered = new FakeCall() as FakeCall & { recoveredCallId: string };
    recovered.id = "browser-leg-2";
    recovered.recoveredCallId = "browser-leg-1";
    recovered.state = "active";
    attachConnectedPeer(recovered);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(5));
    expect(connect).toHaveBeenLastCalledWith("call-1", "accepted");
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

  it("keeps a local SDK terminal event nonterminal without exact provider proof", async () => {
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
    expect(states).toEqual(["connecting", "ringing", "live", "audio_reconnect_required"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("does not let delayed browser playback invalidate newer provider-terminal proof", async () => {
    let resolvePlay!: () => void;
    const play = new Promise<void>((resolve) => { resolvePlay = resolve; });
    let resolveStatus!: (value: JitterProxyResult<{ state: "terminal"; outcome: "ended" }>) => void;
    const status = new Promise<JitterProxyResult<{ state: "terminal"; outcome: "ended" }>>(
      (resolve) => { resolveStatus = resolve; },
    );
    const audio = {
      play: vi.fn(() => play),
      remove: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLAudioElement;
    const harness = transportHarness({
      createRemoteAudio: vi.fn(() => audio),
      getProviderStatus: vi.fn(() => status),
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "destroy";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    resolvePlay();
    await flush();
    expect(states.at(-1)).not.toBe("live");
    resolveStatus({ ok: true, data: { state: "terminal", outcome: "ended" } });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    expect(states.filter((state) => state === "ended")).toHaveLength(1);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(call.hangup).not.toHaveBeenCalled();
  });

  it("keeps real duration and lets explicit rep hangup end a call after a media error", async () => {
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
      outcome: "connected_human",
    });
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledWith(
      "call-1",
      "hangup",
    );
  });

  it("accepts delayed exact-provider terminal proof once without sending cancel", async () => {
    const getProviderStatus = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "terminal", outcome: "ended" } });
    const harness = transportHarness({ getProviderStatus });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "destroy";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    expect(getProviderStatus).toHaveBeenCalledTimes(10);
    expect(vi.mocked(harness.dependencies.sleep).mock.calls
      .reduce((total, [delay]) => total + delay, 0)).toBeGreaterThan(60_000);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("makes exact provider terminal authoritative before any later manual teardown", async () => {
    const harness = transportHarness({
      getProviderStatus: vi.fn(async () => ({
        ok: true as const,
        data: { state: "terminal" as const, outcome: "ended" as const },
      })),
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "destroy";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    expect(harness.transport.terminalIsAuthoritative?.()).toBe(true);
    await harness.transport.hangup();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(call.hangup).not.toHaveBeenCalled();
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
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
    expect(harness.rtc.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    expect(states).toEqual([
      "connecting",
      "teardown_unconfirmed",
      "failed",
      "teardown_confirmed",
    ]);
  });

  it("does not make a local pre-live failure authoritative when cancel never settles", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<JitterProxyResult<typeof cancelData>>(() => undefined));
      const harness = transportHarness({
        cancel,
        getToken: vi.fn(async () => ({
          ok: true as const,
          data: {
            rtc_token: "expired",
            sip_identity: "operator-1",
            expires_at: "2026-08-21T19:59:00.000Z",
            capabilities: { audio_health_media_state: "v1" as const },
          },
        })),
      });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      const start = harness.transport.start(target());
      const rejected = expect(start).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(6_000);
      await rejected;

      expect(cancel).toHaveBeenCalledTimes(3);
      expect(states).toContain("teardown_unconfirmed");
      expect(harness.transport.terminalIsAuthoritative()).toBe(false);
      expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not duplicate hold signaling or end a live call for a hold control error", async () => {
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
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(states).toEqual(["connecting", "ringing", "live", "hold_sync_pending"]);
  });

  it("returns a failed hold without cancelling the live call", async () => {
    const harness = transportHarness();
    await harness.transport.start(target());
    const call = new FakeCall();
    call.hold.mockRejectedValueOnce(new Error("hold rejected"));
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    await expect(harness.transport.hold(true)).resolves.toBe(false);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("keeps direct Hold false as failure until an exact current-call update corrects truth", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    call.hold.mockResolvedValueOnce(false);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    await expect(harness.transport.hold(true)).resolves.toBe(false);
    expect(states).not.toContain("hold_sync_pending");
    expect(states).not.toContain("hold_reapply_failed");
    expect(call.hold).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.reportAudioHealth).not.toHaveBeenCalled();

    // No follow-up provider event means local/UI/durable truth remains active.
    await flush();
    expect(states.at(-1)).toBe("live");
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    expect(states).toContain("hold_reapply_failed");
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("keeps direct Resume false as failure until an exact current-call update corrects truth", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    call.state = "held";
    call.unhold.mockResolvedValueOnce(false);

    const reportsBefore = vi.mocked(harness.dependencies.reportAudioHealth).mock.calls.length;
    await expect(harness.transport.hold(false)).resolves.toBe(false);
    expect(states).not.toContain("resume_sync_pending");
    expect(vi.mocked(harness.dependencies.reportAudioHealth).mock.calls).toHaveLength(reportsBefore);

    // No follow-up provider event leaves held truth intact and controls usable.
    await flush();
    expect(states.at(-1)).toBe("hold_sync_pending");
    call.state = "held";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    expect(states).toContain("resume_reapply_failed");
    await expect(harness.transport.hold(false)).resolves.toBe(true);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
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

  it("keeps the provider call live when browser mute control fails", async () => {
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
    expect(states).toEqual(["connecting", "ringing", "live", "audio_reconnect_required"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("ignores another incoming call while the connected Sandra leg stays live", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    const unrelated = new FakeCall();
    unrelated.id = "browser-leg-unrelated";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: unrelated });

    expect(unrelated.answer).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(states).toEqual(["connecting", "ringing", "live"]);
  });

  it("keeps a connected provider call live when browser media recovery exhausts", async () => {
    vi.useFakeTimers();
    try {
      const harness = transportHarness({ registrationTimeoutMs: 100 });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.start(target());
      const call = new FakeCall();
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      call.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

      harness.rtc.emit("telnyx.socket.close");
      await vi.advanceTimersByTimeAsync(100);

      expect(states).toEqual(["connecting", "ringing", "live", "audio_reconnect_required"]);
      expect(call.hangup).not.toHaveBeenCalled();
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat telnyx.ready without a recovered call attachment as usable media", async () => {
    vi.useFakeTimers();
    try {
      const harness = transportHarness({ registrationTimeoutMs: 100 });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.start(target());
      const call = new FakeCall();
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      call.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

      harness.rtc.emit("telnyx.socket.close");
      harness.rtc.emit("telnyx.ready");
      await vi.advanceTimersByTimeAsync(100);

      expect(states.at(-1)).toBe("audio_reconnect_required");
      expect(call.hangup).not.toHaveBeenCalled();
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps recovery pending when a replacement call attaches without usable media", async () => {
    vi.useFakeTimers();
    try {
      const harness = transportHarness({ registrationTimeoutMs: 100 });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.start(target());
      const call = new FakeCall();
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      call.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
      harness.rtc.emit("telnyx.socket.close");

      const recovered = new FakeCall() as FakeCall & { recoveredCallId: string };
      recovered.id = "browser-leg-2";
      recovered.recoveredCallId = "browser-leg-1";
      recovered.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });
      await vi.advanceTimersByTimeAsync(100);

      expect(states.at(-1)).toBe("audio_reconnect_required");
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes a pending hold onto a recovered replacement leg", async () => {
    let resolveHold!: () => void;
    const harness = transportHarness();
    await harness.transport.start(target());
    const original = new FakeCall();
    original.hold.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveHold = resolve; }),
    );
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    original.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    const pending = harness.transport.hold(true);

    const recovered = new FakeCall() as FakeCall & { recoveredCallId: string };
    recovered.id = "browser-leg-2";
    recovered.recoveredCallId = "browser-leg-1";
    recovered.state = "active";
    attachConnectedPeer(recovered);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });
    expect(recovered.hold).not.toHaveBeenCalled();

    resolveHold();
    await expect(pending).resolves.toBe(true);
    expect(recovered.hold).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("serializes a pending resume onto a held recovered replacement leg", async () => {
    let resolveResume!: () => void;
    const harness = transportHarness();
    await harness.transport.start(target());
    const original = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    original.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    original.state = "held";
    original.unhold.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveResume = resolve; }),
    );
    const pending = harness.transport.hold(false);

    const recovered = new FakeCall() as FakeCall & { recoveredCallId: string };
    recovered.id = "browser-leg-2";
    recovered.recoveredCallId = "browser-leg-1";
    recovered.state = "held";
    attachConnectedPeer(recovered);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });
    expect(recovered.unhold).not.toHaveBeenCalled();

    resolveResume();
    await expect(pending).resolves.toBe(true);
    expect(recovered.unhold).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it.each(["resolved false", "rejected"])(
    "reconciles recovered-call hold when reapply is %s",
    async (failure) => {
      const harness = transportHarness();
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.start(target());
      const original = new FakeCall();
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
      original.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
      await expect(harness.transport.hold(true)).resolves.toBe(true);
      harness.rtc.emit("telnyx.socket.close");

      const recovered = new FakeCall() as FakeCall & { recoveredCallId: string };
      recovered.id = "browser-leg-2";
      recovered.recoveredCallId = "browser-leg-1";
      recovered.state = "active";
      attachConnectedPeer(recovered);
      if (failure === "resolved false") recovered.hold.mockResolvedValueOnce(false);
      else recovered.hold.mockRejectedValueOnce(new Error("hold reapply rejected"));
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });
      await vi.waitFor(() => expect(states).toContain("hold_reapply_failed"));
      expect(states).toContain("hold_reapply_failed");
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    },
  );

  it("degrades visibly after bounded resumed-baseline acknowledgement failures", async () => {
    let scheduled: (() => void) | undefined;
    const reportAudioHealth = vi.fn(async () => ({
      ok: true as const,
      data: { accepted: false, pending: true, status: "monitoring" as const },
    }));
    const harness = transportHarness({
      reportAudioHealth,
      scheduleAudioHealth(handler) {
        scheduled = handler;
        return () => undefined;
      },
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    attachConnectedPeer(call);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(1));
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(2));
    await expect(harness.transport.hold(false)).resolves.toBe(true);
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(3));
    scheduled?.();
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(4));
    scheduled?.();
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(5));

    expect(states.at(-1)).toBe("audio_reconnect_required");
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("manually reconnects browser audio without canceling the connected provider call", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    harness.rtc.emit("telnyx.error", {
      error: { code: 45_003, message: "RECONNECTION_EXHAUSTED" },
    });

    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
    expect(harness.rtc.socketDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    const recoveredCall = new FakeCall() as FakeCall & { recoveredCallId: string };
    recoveredCall.id = "browser-leg-2";
    recoveredCall.recoveredCallId = "browser-leg-1";
    recoveredCall.state = "active";
    attachConnectedPeer(recoveredCall);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recoveredCall });

    await vi.waitFor(() => expect(states.at(-1)).toBe("live"));
    expect(states).toEqual([
      "connecting",
      "ringing",
      "live",
      "audio_reconnect_required",
      "audio_reconnecting",
      "live",
    ]);
    expect(call.hangup).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it.each(["connect rejection", "ready timeout"] as const)(
    "purges a retained client after %s so the next reconnect builds a fresh capable client",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const failedClient = new FakeRtcClient();
        if (failure === "connect rejection")
          failedClient.connect.mockRejectedValueOnce(new Error("registration rejected"));
        else failedClient.connect.mockResolvedValueOnce(undefined);
        const rebuiltClient = new FakeRtcClient();
        const createRtcClient = vi.fn()
          .mockResolvedValueOnce(failedClient)
          .mockResolvedValueOnce(rebuiltClient);
        const harness = transportHarness({ createRtcClient, registrationTimeoutMs: 100 });
        const states: string[] = [];
        harness.transport.onStateChange((state) => states.push(state));
        const retained = harness.transport.recover?.(
          { id: "call-1" },
          "2026-08-21T20:00:00.000Z",
        );
        if (failure === "ready timeout") await vi.advanceTimersByTimeAsync(100);
        await retained;

        expect(failedClient.serverDisconnect).toHaveBeenCalledTimes(1);
        expect(failedClient.socketDisconnect).not.toHaveBeenCalled();
        expect(failedClient.disconnect).not.toHaveBeenCalled();
        await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
        expect(createRtcClient).toHaveBeenCalledTimes(2);
        expect(harness.dependencies.recoverAudio).toHaveBeenCalledWith("call-1");
        const recovered = new FakeCall();
        recovered.id = "browser-leg-rebuilt";
        recovered.state = "active";
        attachConnectedPeer(recovered);
        rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: recovered });
        // Advance only the bounded Attach/media proof. Retained provider-proof
        // polling is intentionally persistent and must not be drained with
        // runAllTimers (which would manufacture an infinite retry loop).
        await vi.advanceTimersByTimeAsync(100);
        await vi.waitFor(() => expect(states.at(-1)).toBe("live"));
        await expect(harness.transport.hold(true)).resolves.toBe(true);
        expect(recovered.hold).toHaveBeenCalledTimes(1);
        expect(states).not.toContain("hold_reload_required");
        expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
        expect(rebuiltClient.socketDisconnect).not.toHaveBeenCalled();
        expect(harness.dependencies.cancel).not.toHaveBeenCalled();
        expect(recovered.hangup).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rebuilds RTC setup when the first retained client setup failed before construction", async () => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const harness = transportHarness({ prepareMicrophone });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
    expect(prepareMicrophone).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.createRtcClient).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.recoverAudio).toHaveBeenCalledWith("call-1");
    const recovered = new FakeCall();
    recovered.id = "browser-leg-rebuilt";
    recovered.state = "active";
    attachConnectedPeer(recovered);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });
    await vi.waitFor(() => expect(states.at(-1)).toBe("live"));
    await expect(harness.transport.hold(true)).resolves.toBe(true);
    expect(recovered.hold).toHaveBeenCalledTimes(1);
    expect(states).not.toContain("hold_reload_required");
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("times out a rebuilt registered client that never attaches usable media", async () => {
    vi.useFakeTimers();
    try {
      const prepareMicrophone = vi.fn()
        .mockRejectedValueOnce(new Error("mic denied once"))
        .mockResolvedValue(undefined);
      const harness = transportHarness({ prepareMicrophone, registrationTimeoutMs: 100 });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
      await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
      expect(states.at(-1)).toBe("audio_reconnecting");

      const emptyId = new FakeCall();
      emptyId.id = "";
      emptyId.state = "active";
      attachConnectedPeer(emptyId);
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: emptyId });
      const ringing = new FakeCall();
      ringing.id = "ringing-not-attach";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: ringing });
      expect((harness.transport as unknown as { exactRecoveryAttachGeneration: number | null }).exactRecoveryAttachGeneration).not.toBeNull();
      expect((harness.transport as unknown as { currentCall: unknown }).currentCall).toBeNull();
      expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBe(harness.rtc);
      const releaseClient = vi.spyOn(
        harness.transport as unknown as { releaseRecoveryClient: (client: unknown, audio: unknown) => void },
        "releaseRecoveryClient",
      );

      await vi.advanceTimersByTimeAsync(100);

      expect(states.at(-1)).toBe("audio_reconnect_required");
      expect(releaseClient).toHaveBeenCalledTimes(1);
      expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBeNull();
      expect(harness.rtc.serverDisconnect).toHaveBeenCalledTimes(1);
      expect(emptyId.answer).not.toHaveBeenCalled();
      expect(ringing.answer).not.toHaveBeenCalled();
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm a late timeout after a pinned-SDK-shaped Attach without recoveredCallId", async () => {
    vi.useFakeTimers();
    try {
      const prepareMicrophone = vi.fn()
        .mockRejectedValueOnce(new Error("mic denied once"))
        .mockResolvedValue(undefined);
      const remoteAudio = {
        play: vi.fn(async () => undefined),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        remove: vi.fn(),
      } as unknown as HTMLAudioElement;
      const rebuiltClient = new FakeRtcClient();
      const exact = new FakeCall();
      exact.id = "browser-leg-rebuilt";
      exact.state = "active";
      attachConnectedPeer(exact);
      rebuiltClient.connect.mockImplementation(async () => {
        rebuiltClient.emit("telnyx.ready");
        rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: exact });
      });
      const harness = transportHarness({
        prepareMicrophone,
        createRemoteAudio: vi.fn(() => remoteAudio),
        createRtcClient: vi.fn(async () => rebuiltClient),
        registrationTimeoutMs: 100,
      });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

      await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
      await vi.waitFor(() => expect(states.at(-1)).toBe("live"));
      const reconnectRequiredCount = states.filter((state) => state === "audio_reconnect_required").length;
      await vi.advanceTimersByTimeAsync(500);

      expect(states.at(-1)).toBe("live");
      expect(states.filter((state) => state === "audio_reconnect_required")).toHaveLength(reconnectRequiredCount);
      expect(remoteAudio.play).toHaveBeenCalled();
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(exact.hangup).not.toHaveBeenCalled();
      expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["missing", ""],
    ["mismatched", "v3:unrelated-operator-leg"],
  ] as const)("fails closed for a %s rebuilt Attach provider identity", async (_case, providerId) => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const rebuiltClient = new FakeRtcClient();
    const candidate = new FakeCall();
    candidate.id = "candidate-identity";
    candidate.state = "active";
    candidate.telnyxIDs.telnyxCallControlId = providerId;
    attachConnectedPeer(candidate);
    rebuiltClient.connect.mockImplementation(async () => {
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: candidate });
      rebuiltClient.emit("telnyx.ready");
    });
    const harness = transportHarness({
      prepareMicrophone,
      createRtcClient: vi.fn(async () => rebuiltClient),
      registrationTimeoutMs: 100,
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
    await vi.waitFor(() => expect(states.at(-1)).toBe("audio_reconnect_required"));
    expect(rebuiltClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect((harness.transport as unknown as { currentCall: unknown }).currentCall).toBeNull();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(candidate.hangup).not.toHaveBeenCalled();
    expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
  });

  it("fails closed when the exact provider identity changes after recovery bind", async () => {
    vi.useFakeTimers();
    try {
      const prepareMicrophone = vi.fn()
        .mockRejectedValueOnce(new Error("mic denied once"))
        .mockResolvedValue(undefined);
      const rebuiltClient = new FakeRtcClient();
      const candidate = new FakeCall();
      candidate.id = "candidate-bound";
      candidate.state = "active";
      attachConnectedPeer(candidate);
      const harness = transportHarness({
        prepareMicrophone,
        createRtcClient: vi.fn(async () => rebuiltClient),
        registrationTimeoutMs: 1_000,
        sleep: vi.fn((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
      });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
      await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: candidate });
      await vi.advanceTimersByTimeAsync(50);
      expect((harness.transport as unknown as { currentCall: unknown }).currentCall).toBe(candidate);

      candidate.telnyxIDs.telnyxCallControlId = "v3:changed-after-bind";
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: candidate });

      expect(states.at(-1)).toBe("audio_reconnect_required");
      expect(rebuiltClient.serverDisconnect).toHaveBeenCalledTimes(1);
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(candidate.hangup).not.toHaveBeenCalled();
      expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when rebuilt recovery observes two distinct Attach candidates", async () => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const rebuiltClient = new FakeRtcClient();
    const candidateA = new FakeCall();
    candidateA.id = "candidate-a";
    candidateA.state = "active";
    attachConnectedPeer(candidateA);
    const candidateB = new FakeCall();
    candidateB.id = "candidate-b";
    candidateB.state = "active";
    attachConnectedPeer(candidateB);
    rebuiltClient.connect.mockImplementation(async () => {
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: candidateA });
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: candidateB });
      rebuiltClient.emit("telnyx.ready");
    });
    const harness = transportHarness({
      prepareMicrophone,
      createRtcClient: vi.fn(async () => rebuiltClient),
      registrationTimeoutMs: 100,
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
    await vi.waitFor(() => expect(states.at(-1)).toBe("audio_reconnect_required"));
    expect(rebuiltClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(candidateA.answer).not.toHaveBeenCalled();
    expect(candidateB.answer).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(candidateA.hangup).not.toHaveBeenCalled();
    expect(candidateB.hangup).not.toHaveBeenCalled();
    expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
  });

  it("fails closed when one buffered Attach changes provider identity before bind", async () => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const rebuiltClient = new FakeRtcClient();
    const first = new FakeCall();
    first.id = "candidate-same-id";
    first.state = "active";
    const changed = new FakeCall();
    changed.id = first.id;
    changed.state = "active";
    changed.telnyxIDs.telnyxCallControlId = "v3:changed-before-bind";
    rebuiltClient.connect.mockImplementation(async () => {
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: first });
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: changed });
      rebuiltClient.emit("telnyx.ready");
    });
    const harness = transportHarness({
      prepareMicrophone,
      createRtcClient: vi.fn(async () => rebuiltClient),
      registrationTimeoutMs: 100,
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

    await expect(harness.transport.reconnectAudio()).resolves.toBe(false);

    expect(states.at(-1)).toBe("audio_reconnect_required");
    expect(rebuiltClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(first.hangup).not.toHaveBeenCalled();
    expect(changed.hangup).not.toHaveBeenCalled();
    expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
  });

  it("fails closed when a second Attach arrives after the first candidate is promoted but before media proof", async () => {
    vi.useFakeTimers();
    try {
      const prepareMicrophone = vi.fn()
        .mockRejectedValueOnce(new Error("mic denied once"))
        .mockResolvedValue(undefined);
      const rebuiltClient = new FakeRtcClient();
      const candidateA = new FakeCall();
      candidateA.id = "candidate-a";
      candidateA.state = "active";
      attachConnectedPeer(candidateA);
      const candidateB = new FakeCall();
      candidateB.id = "candidate-b";
      candidateB.state = "active";
      attachConnectedPeer(candidateB);
      const harness = transportHarness({
        prepareMicrophone,
        createRtcClient: vi.fn(async () => rebuiltClient),
        registrationTimeoutMs: 1_000,
        sleep: vi.fn((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
      });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
      await expect(harness.transport.reconnectAudio()).resolves.toBe(true);

      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: candidateA });
      await vi.advanceTimersByTimeAsync(50);
      expect((harness.transport as unknown as { currentCall: unknown }).currentCall).toBe(candidateA);
      rebuiltClient.emit("telnyx.notification", { type: "callUpdate", call: candidateB });

      expect(states.at(-1)).toBe("audio_reconnect_required");
      expect((harness.transport as unknown as { currentCall: unknown }).currentCall).toBeNull();
      expect(rebuiltClient.serverDisconnect).toHaveBeenCalledTimes(1);
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(candidateA.hangup).not.toHaveBeenCalled();
      expect(candidateB.hangup).not.toHaveBeenCalled();
      expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for rebuilt Telnyx ready before requesting registered operator origination", async () => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const rebuiltClient = new FakeRtcClient();
    let ready = false;
    rebuiltClient.connect.mockImplementation(async () => {
      ready = true;
      rebuiltClient.emit("telnyx.ready");
    });
    const connect = vi.fn(async (_callId: string, phase: "registered" | "accepted") => {
      if (phase === "registered" && !ready) throw new Error("operator origination before Telnyx ready");
      return { ok: true as const, data: phase === "registered" ? registeredConnectData() : { dialing: true as const } };
    });
    const harness = transportHarness({
      prepareMicrophone,
      createRtcClient: vi.fn(async () => rebuiltClient),
      connect,
    });
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);

    expect(ready).toBe(true);
    expect(connect).toHaveBeenCalledWith("call-1", "registered");
    expect(harness.dependencies.recoverAudio).toHaveBeenCalledBefore(connect);
    expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("purges a rebuilt client when registered operator origination fails and rebuilds on the next click", async () => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const firstClient = new FakeRtcClient();
    const secondClient = new FakeRtcClient();
    const createRtcClient = vi.fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const connect = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        status: 503,
        error: "registered response unavailable",
        errorCode: "jitter_unavailable",
        ambiguous: true,
      })
      .mockResolvedValueOnce({ ok: true as const, data: registeredConnectData() });
    const harness = transportHarness({ prepareMicrophone, createRtcClient, connect });
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

    await expect(harness.transport.reconnectAudio()).resolves.toBe(false);
    expect(firstClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBeNull();
    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);

    expect(createRtcClient).toHaveBeenCalledTimes(2);
    expect(secondClient.connect).toHaveBeenCalledTimes(1);
    expect(firstClient.socketDisconnect).not.toHaveBeenCalled();
    expect(firstClient.disconnect).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("purges a rebuilt client when registered success omits exact operator identity", async () => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const rebuiltClient = new FakeRtcClient();
    const harness = transportHarness({
      prepareMicrophone,
      createRtcClient: vi.fn(async () => rebuiltClient),
      connect: vi.fn(async () => ({ ok: true as const, data: { dialing: true as const } })),
    });
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

    await expect(harness.transport.reconnectAudio()).resolves.toBe(false);

    expect(rebuiltClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBeNull();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(rebuiltClient.disconnect).not.toHaveBeenCalled();
  });

  it("releases a rebuilt client whose registration fails so the next reconnect creates a fresh client", async () => {
    const prepareMicrophone = vi.fn()
      .mockRejectedValueOnce(new Error("mic denied once"))
      .mockResolvedValue(undefined);
    const failedClient = new FakeRtcClient();
    failedClient.connect.mockRejectedValue(new Error("registration failed"));
    const workingClient = new FakeRtcClient();
    const createRtcClient = vi.fn()
      .mockResolvedValueOnce(failedClient)
      .mockResolvedValueOnce(workingClient);
    const harness = transportHarness({ prepareMicrophone, createRtcClient });
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");

    await expect(harness.transport.reconnectAudio()).resolves.toBe(false);
    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);

    expect(createRtcClient).toHaveBeenCalledTimes(2);
    expect(failedClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(failedClient.socketDisconnect).not.toHaveBeenCalled();
    expect(failedClient.disconnect).not.toHaveBeenCalled();
    expect(workingClient.disconnect).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("retries accepted convergence when replacement media arrives before the lost response clears", async () => {
    const acceptedAttempts = [
      deferred<JitterProxyResult<{ dialing: true }>>(),
      deferred<JitterProxyResult<{ dialing: true }>>(),
      deferred<JitterProxyResult<{ dialing: true }>>(),
    ];
    let acceptedRequests = 0;
    const connect = vi.fn(async (_callId: string, phase: "registered" | "accepted") => {
      if (phase === "registered") return { ok: true as const, data: { dialing: true as const } };
      acceptedRequests += 1;
      if (acceptedRequests <= acceptedAttempts.length)
        return acceptedAttempts[acceptedRequests - 1]!.promise;
      return { ok: true as const, data: { dialing: true as const } };
    });
    const harness = transportHarness({ connect });
    await harness.transport.start(target());
    const original = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    original.state = "active";
    attachConnectedPeer(original);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    await vi.waitFor(() => expect(acceptedRequests).toBe(1));

    acceptedAttempts[0]!.reject(new Error("accepted response 1 lost"));
    await vi.waitFor(() => expect(acceptedRequests).toBe(2));
    acceptedAttempts[1]!.reject(new Error("accepted response 2 lost"));
    await vi.waitFor(() => expect(acceptedRequests).toBe(3));

    harness.rtc.emit("telnyx.error", { error: { code: 45_003 } });
    await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
    const replacement = new FakeCall() as FakeCall & { recoveredCallId: string };
    replacement.id = "browser-leg-2";
    replacement.recoveredCallId = original.id;
    replacement.state = "active";
    attachConnectedPeer(replacement);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: replacement });
    await vi.waitFor(() => expect(harness.transport.callHandle()).toEqual({ id: "call-1" }));
    expect(acceptedRequests).toBe(3);

    acceptedAttempts[2]!.reject(new Error("accepted response 3 lost"));
    await vi.waitFor(() => expect(acceptedRequests).toBe(4));

    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(original.hangup).not.toHaveBeenCalled();
    expect(replacement.hangup).not.toHaveBeenCalled();
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
  });

  it.each(["manual", "provider terminal"] as const)(
    "suppresses a latched accepted retry when %s teardown wins",
    async (winner) => {
      const acceptedAttempts = [
        deferred<JitterProxyResult<{ dialing: true }>>(),
        deferred<JitterProxyResult<{ dialing: true }>>(),
        deferred<JitterProxyResult<{ dialing: true }>>(),
      ];
      let acceptedRequests = 0;
      const connect = vi.fn(async (_callId: string, phase: "registered" | "accepted") => {
        if (phase === "registered") return { ok: true as const, data: { dialing: true as const } };
        acceptedRequests += 1;
        return acceptedAttempts[acceptedRequests - 1]?.promise ??
          { ok: true as const, data: { dialing: true as const } };
      });
      const harness = transportHarness({
        connect,
        getProviderStatus: vi.fn(async () => ({
          ok: true as const,
          data: { state: "terminal" as const, outcome: "ended" as const },
        })),
      });
      await harness.transport.start(target());
      const original = new FakeCall();
      attachConnectedPeer(original);
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
      original.state = "active";
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
      await vi.waitFor(() => expect(acceptedRequests).toBe(1));
      acceptedAttempts[0]!.reject(new Error("accepted response 1 lost"));
      await vi.waitFor(() => expect(acceptedRequests).toBe(2));
      acceptedAttempts[1]!.reject(new Error("accepted response 2 lost"));
      await vi.waitFor(() => expect(acceptedRequests).toBe(3));

      harness.rtc.emit("telnyx.error", { error: { code: 45_003 } });
      await expect(harness.transport.reconnectAudio()).resolves.toBe(true);
      const replacement = new FakeCall() as FakeCall & { recoveredCallId: string };
      replacement.id = "accepted-retry-replacement";
      replacement.recoveredCallId = original.id;
      replacement.state = "active";
      attachConnectedPeer(replacement);
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: replacement });
      await flush();

      if (winner === "manual") await harness.transport.hangup();
      else {
        replacement.state = "destroy";
        harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: replacement });
        await vi.waitFor(() => expect(harness.transport.terminalIsAuthoritative()).toBe(true));
      }
      acceptedAttempts[2]!.reject(new Error("accepted response 3 lost"));
      await flush();
      expect(acceptedRequests).toBe(3);
    },
  );

  it("does not resurrect signaling when manual Hang Up wins during deferred audio recovery", async () => {
    const recovery = deferred<JitterProxyResult<{ recovering: true }>>();
    const harness = transportHarness({ recoverAudio: vi.fn(() => recovery.promise) });
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    harness.rtc.emit("telnyx.error", { error: { code: 45_003 } });
    const connectCallsBefore = vi.mocked(harness.dependencies.connect).mock.calls.length;
    const reconnect = harness.transport.reconnectAudio();
    await vi.waitFor(() => expect(harness.dependencies.recoverAudio).toHaveBeenCalledOnce());
    await harness.transport.hangup();
    recovery.resolve({ ok: true, data: { recovering: true } });
    await expect(reconnect).resolves.toBe(false);
    expect(harness.dependencies.connect).toHaveBeenCalledTimes(connectCallsBefore);
    expect(call.hangup).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.cancel).toHaveBeenCalledTimes(1);
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
  });

  it("does not resurrect signaling when exact provider terminal proof wins during deferred audio recovery", async () => {
    const recovery = deferred<JitterProxyResult<{ recovering: true }>>();
    const harness = transportHarness({
      recoverAudio: vi.fn(() => recovery.promise),
      getProviderStatus: vi.fn(async () => ({ ok: true as const, data: { state: "terminal" as const, outcome: "ended" as const } })),
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    harness.rtc.emit("telnyx.error", { error: { code: 45_003 } });
    const connectCallsBefore = vi.mocked(harness.dependencies.connect).mock.calls.length;
    const reconnect = harness.transport.reconnectAudio();
    await vi.waitFor(() => expect(harness.dependencies.recoverAudio).toHaveBeenCalledOnce());
    call.state = "destroy";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    recovery.resolve({ ok: true, data: { recovering: true } });
    await expect(reconnect).resolves.toBe(false);
    expect(harness.dependencies.connect).toHaveBeenCalledTimes(connectCallsBefore);
    expect(call.hangup).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
  });

  it("degrades after bounded missing inbound health samples without ending the call", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall() as FakeCall & { peer: { instance: RTCPeerConnection } };
    call.peer = { instance: {
      connectionState: "connected",
      getStats: vi.fn(async () => { throw new Error("stats unavailable"); }),
    } as unknown as RTCPeerConnection };
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    for (let index = 0; index < 3; index += 1)
      await (harness.transport as unknown as { sampleAudioHealth(): Promise<void> }).sampleAudioHealth();
    expect(states.at(-1)).toBe("audio_reconnect_required");
    expect(call.hangup).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("restores a rehydrated provider-held call without automatically unholding it", async () => {
    const harness = transportHarness();
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
    const recovered = new FakeCall();
    recovered.state = "held";
    attachConnectedPeer(recovered);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });
    await vi.waitFor(() => expect(states).toContain("hold_restored"));
    expect(recovered.unhold).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
  });

  it("converges retained terminal proof even when no SDK call reattaches after reload", async () => {
    vi.useFakeTimers();
    try {
      const getProviderStatus = vi.fn()
        .mockResolvedValue({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
        .mockResolvedValueOnce({ ok: true, data: { state: "terminal", outcome: "ended" } });
      const harness = transportHarness({ getProviderStatus });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
      await vi.advanceTimersByTimeAsync(0);
      expect(states.at(-1)).toBe("audio_reconnect_required");

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(harness.rtc.serverDisconnect).toHaveBeenCalledTimes(1);
      expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("converges retained terminal proof when browser microphone recovery fails first", async () => {
    const getProviderStatus = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { state: "active" } })
      .mockResolvedValueOnce({ ok: true, data: { state: "terminal", outcome: "ended" } });
    const harness = transportHarness({
      prepareMicrophone: vi.fn(async () => { throw new Error("microphone denied"); }),
      getProviderStatus,
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    await expect(
      harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z"),
    ).resolves.toEqual({ id: "call-1" });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));

    expect(getProviderStatus).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
  });

  it("does not continue retained recovery when terminal proof wins during microphone setup", async () => {
    const microphone = deferred<void>();
    const providerProof = deferred<JitterProxyResult<{ state: "terminal"; outcome: "ended" }>>();
    const harness = transportHarness({
      prepareMicrophone: vi.fn(() => microphone.promise),
      getProviderStatus: vi.fn(() => providerProof.promise),
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    const recovery = harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
    await vi.waitFor(() => expect(harness.dependencies.prepareMicrophone).toHaveBeenCalledTimes(1));
    providerProof.resolve({ ok: true, data: { state: "terminal", outcome: "ended" } });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    microphone.resolve();
    await expect(recovery).resolves.toEqual({ id: "call-1" });

    expect(harness.dependencies.getToken).not.toHaveBeenCalled();
    expect(harness.dependencies.createRtcClient).not.toHaveBeenCalled();
    expect(states).toEqual(["audio_reconnect_required", "ended"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBeNull();
    expect((harness.transport as unknown as { remoteAudio: unknown }).remoteAudio).toBeNull();
  });

  it("does not continue retained recovery when terminal proof wins during token fetch", async () => {
    const token = deferred<Awaited<ReturnType<JitterTransportDependencies["getToken"]>>>();
    const providerProof = deferred<JitterProxyResult<{ state: "terminal"; outcome: "ended" }>>();
    const harness = transportHarness({
      getToken: vi.fn(() => token.promise),
      getProviderStatus: vi.fn(() => providerProof.promise),
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    const recovery = harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
    await vi.waitFor(() => expect(harness.dependencies.getToken).toHaveBeenCalledTimes(1));
    providerProof.resolve({ ok: true, data: { state: "terminal", outcome: "ended" } });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    token.resolve({
      ok: true,
      data: {
        rtc_token: "rtc-token-1",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T20:05:00.000Z",
        capabilities: { audio_health_media_state: "v1" },
      },
    });
    await expect(recovery).resolves.toEqual({ id: "call-1" });

    expect(harness.dependencies.createRtcClient).not.toHaveBeenCalled();
    expect(states).toEqual(["audio_reconnect_required", "ended"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
    expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBeNull();
  });

  it("disposes an unregistered retained client when terminal proof wins during client creation", async () => {
    const clientCreation = deferred<FakeRtcClient>();
    const providerProof = deferred<JitterProxyResult<{ state: "terminal"; outcome: "ended" }>>();
    const staleClient = new FakeRtcClient();
    const removeAudio = vi.fn();
    const audio = { remove: removeAudio } as unknown as HTMLAudioElement;
    const harness = transportHarness({
      createRemoteAudio: vi.fn(() => audio),
      createRtcClient: vi.fn(() => clientCreation.promise),
      getProviderStatus: vi.fn(() => providerProof.promise),
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    const recovery = harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
    await vi.waitFor(() => expect(harness.dependencies.createRtcClient).toHaveBeenCalledTimes(1));
    providerProof.resolve({ ok: true, data: { state: "terminal", outcome: "ended" } });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    clientCreation.resolve(staleClient);
    await expect(recovery).resolves.toEqual({ id: "call-1" });

    expect(staleClient.connect).not.toHaveBeenCalled();
    expect(staleClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(staleClient.disconnect).not.toHaveBeenCalled();
    expect(removeAudio).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["audio_reconnect_required", "ended"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBeNull();
    expect((harness.transport as unknown as { remoteAudio: unknown }).remoteAudio).toBeNull();
  });

  it("aborts retained registration when terminal proof wins while connect is pending", async () => {
    const connect = deferred<void>();
    const providerProof = deferred<JitterProxyResult<{ state: "terminal"; outcome: "ended" }>>();
    const staleClient = new FakeRtcClient();
    staleClient.connect.mockImplementation(() => connect.promise);
    const harness = transportHarness({
      createRtcClient: vi.fn(async () => staleClient),
      getProviderStatus: vi.fn(() => providerProof.promise),
    });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));

    const recovery = harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
    await vi.waitFor(() => expect(staleClient.connect).toHaveBeenCalledTimes(1));
    providerProof.resolve({ ok: true, data: { state: "terminal", outcome: "ended" } });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ended"));
    connect.resolve();
    await expect(recovery).resolves.toEqual({ id: "call-1" });

    expect(staleClient.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(staleClient.disconnect).not.toHaveBeenCalled();
    expect(states).toEqual(["audio_reconnect_required", "ended"]);
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
    expect((harness.transport as unknown as { rtcClient: unknown }).rtcClient).toBeNull();
    expect((harness.transport as unknown as { remoteAudio: unknown }).remoteAudio).toBeNull();
  });

  it("stops retained terminal probing after current replacement media is proven healthy", async () => {
    vi.useFakeTimers();
    try {
      const getProviderStatus = vi.fn(async () => ({ ok: true as const, data: { state: "active" as const } }));
      const harness = transportHarness({ getProviderStatus });
      const states: string[] = [];
      harness.transport.onStateChange((state) => states.push(state));
      await harness.transport.recover?.({ id: "call-1" }, "2026-08-21T20:00:00.000Z");
      const recovered = new FakeCall();
      recovered.state = "active";
      attachConnectedPeer(recovered);
      harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: recovered });
      await vi.waitFor(() => expect(states.at(-1)).toBe("live"));

      await vi.advanceTimersByTimeAsync(30_000);
      expect(states.at(-1)).toBe("live");
      expect(harness.dependencies.cancel).not.toHaveBeenCalled();
      expect(recovered.hangup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a current Jitter suspect response but ignores the same late response after peer replacement", async () => {
    let resolveReport!: (value: JitterProxyResult<JitterAudioHealthResponse>) => void;
    const reportAudioHealth = vi.fn(() => new Promise<JitterProxyResult<JitterAudioHealthResponse>>((resolve) => {
      resolveReport = resolve;
    }));
    const harness = transportHarness({ reportAudioHealth });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const original = new FakeCall();
    attachConnectedPeer(original);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    original.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: original });
    await vi.waitFor(() => expect(reportAudioHealth).toHaveBeenCalledTimes(1));
    const replacement = new FakeCall() as FakeCall & { recoveredCallId: string };
    replacement.id = "browser-leg-2";
    replacement.recoveredCallId = "browser-leg-1";
    replacement.state = "active";
    attachConnectedPeer(replacement);
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call: replacement });
    resolveReport({ ok: true, data: { accepted: true, status: "suspect" } });
    await flush();
    expect(states.at(-1)).not.toBe("audio_reconnect_required");

    vi.mocked(reportAudioHealth).mockResolvedValueOnce({
      ok: true,
      data: { accepted: true, status: "suspect" },
    });
    await (harness.transport as unknown as { sampleAudioHealth(): Promise<void> }).sampleAudioHealth();
    expect(states.at(-1)).toBe("audio_reconnect_required");
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
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
    attachConnectedPeer(recoveredCall);
    harness.rtc.emit("telnyx.notification", {
      type: "callUpdate",
      call: recoveredCall,
    });
    await vi.waitFor(() => expect(recoveredCall.muteAudio).toHaveBeenCalledTimes(1));
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

  it("does not hang up or cancel a connected call on pagehide", async () => {
    const sendCancelBeacon = vi.fn(() => true);
    const harness = transportHarness({ sendCancelBeacon });
    const states: string[] = [];
    harness.transport.onStateChange((state) => states.push(state));
    await harness.transport.start(target());
    const call = new FakeCall();
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });
    call.state = "active";
    harness.rtc.emit("telnyx.notification", { type: "callUpdate", call });

    harness.firePageHide();
    await flush();

    expect(states.at(-1)).toBe("audio_reconnect_required");
    expect(call.hangup).not.toHaveBeenCalled();
    expect(sendCancelBeacon).not.toHaveBeenCalled();
    expect(harness.dependencies.cancel).not.toHaveBeenCalled();
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
    expect(harness.rtc.serverDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.rtc.disconnect).not.toHaveBeenCalled();
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
