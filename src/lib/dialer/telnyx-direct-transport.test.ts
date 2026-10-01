import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DirectCallStatus,
  DirectCallStatusView,
} from "@/lib/direct-calling/contract";

vi.mock("@/lib/direct-calling/client-actions", () => ({
  cancelDirectCallByRequest: vi.fn(),
  controlDirectCall: vi.fn(),
  getDirectCallStatus: vi.fn(),
  getDirectCallStatusByRequest: vi.fn(),
  getDirectRtcToken: vi.fn(),
  startDirectCall: vi.fn(),
}));

import {
  TelnyxDirectCallTransport,
  createTelnyxRtcClient,
  mapDirectStatus,
  type DirectTransportDependencies,
} from "./telnyx-direct-transport";

const LEG = "browser-leg-1";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function view(status: DirectCallStatus, extra: Partial<DirectCallStatusView> = {}) {
  return {
    ok: true as const,
    data: {
      directCallId: CALL_ID,
      status,
      connectedAt: null,
      endedAt: null,
      hangupCause: null,
      failureReason: null,
      cleanupPending: false,
      ...extra,
    },
  };
}

function fakeCall(overrides: Record<string, unknown> = {}) {
  return {
    id: "sdk-call",
    direction: "inbound",
    state: "ringing",
    telnyxIDs: { telnyxCallControlId: LEG },
    options: { customHeaders: [] as Array<{ name: string; value: string }> },
    answer: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
    muteAudio: vi.fn(),
    unmuteAudio: vi.fn(),
    hold: vi.fn(async (): Promise<unknown> => ({})),
    unhold: vi.fn(async (): Promise<unknown> => ({})),
    ...overrides,
  };
}

const harnesses: Array<{ getStatus: { mockResolvedValue(v: unknown): unknown } }> = [];
afterEach(async () => {
  // Stop any background status poll so no loop outlives its test.
  for (const deps of harnesses.splice(0)) deps.getStatus.mockResolvedValue(view("ended"));
  await flush();
});

function harness(opts: { statuses?: DirectCallStatus[]; micError?: boolean } = {}) {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const client = {
    connect: vi.fn(async () => {
      queueMicrotask(() => handlers.get("telnyx.ready")?.());
    }),
    disconnect: vi.fn(async () => undefined),
    on(name: string, handler: (...a: unknown[]) => void) {
      handlers.set(name, handler);
      return client;
    },
  };
  const statuses = [...(opts.statuses ?? ["connected"])];
  const calls: string[] = [];
  const deps = {
    prepareMicrophone: vi.fn(async () => {
      calls.push("mic");
      if (opts.micError) throw new Error("Microphone access is required to place calls.");
    }),
    getToken: vi.fn(async () => {
      calls.push("token");
      return { ok: true as const, data: { token: "jwt", sipUsername: "sip-user" } };
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed arity for mock overrides
    startCall: vi.fn(async (_input: unknown) => {
      calls.push("start");
      return {
        ok: true as const,
        data: {
          directCallId: CALL_ID,
          browserLegId: LEG,
          correlationHeader: { name: "X-Sandra-Direct-Call-Id" as const, value: CALL_ID },
        },
      };
    }),
    getStatus: vi.fn(async () => {
      calls.push("status");
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return view(next);
    }),
    getStatusByRequest: vi.fn(async (_requestId: string) => {
      calls.push("status-by-request");
      return view("failed");
    }),
    cancelByRequest: vi.fn(async (_requestId: string) => {
      calls.push("cancel-by-request");
      return { ok: true as const, data: { directCallId: null as string | null, tombstoned: true } };
    }),
    control: vi.fn(async (_id: string, c: { action: string }) => {
      calls.push(`control:${c.action}`);
      return { ok: true as const, data: { accepted: true as const } };
    }),
    createRtcClient: vi.fn(async () => client),
    createRemoteAudio: vi.fn(() => null),
    sleep: vi.fn((ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2)))),
    now: () => 1_000_000,
    registrationTimeoutMs: 1_000,
  } satisfies DirectTransportDependencies;
  const transport = new TelnyxDirectCallTransport(deps as DirectTransportDependencies);
  harnesses.push(deps);
  const states: string[] = [];
  transport.onStateChange((s) => states.push(s));
  const notify = (call: unknown) =>
    handlers.get("telnyx.notification")?.({ type: "callUpdate", call });
  const emit = (name: string, payload?: unknown) => handlers.get(name)?.(payload);
  return { transport, deps, client, states, calls, notify, emit };
}

const target = { phoneE164: "+18165550123", propertyId: "prop-1", callToken: REQUEST_ID };

async function flush() {
  await new Promise((r) => setTimeout(r, 8));
}

describe("mapDirectStatus", () => {
  it("maps server statuses to transport states", () => {
    expect(mapDirectStatus("browser_connecting")).toBe("connecting");
    expect(mapDirectStatus("seller_dialing")).toBe("ringing");
    expect(mapDirectStatus("connected")).toBe("live");
    expect(mapDirectStatus("ended")).toBe("ended");
    expect(mapDirectStatus("failed")).toBe("failed");
    expect(mapDirectStatus("ending")).toBeNull();
  });
});

describe("TelnyxDirectCallTransport", () => {
  it("fails on mic denial without calling the server", async () => {
    const h = harness({ micError: true });
    await expect(h.transport.start(target)).rejects.toThrow(/Microphone/);
    expect(h.deps.getToken).not.toHaveBeenCalled();
    expect(h.deps.startCall).not.toHaveBeenCalled();
    expect(h.deps.control).not.toHaveBeenCalled();
  });

  it("starts a lead call with the request id and exposes the handle", async () => {
    const h = harness();
    const handle = await h.transport.start(target);
    expect(handle).toEqual({ id: CALL_ID });
    expect(h.transport.callHandle()).toEqual({ id: CALL_ID });
    expect(h.deps.startCall).toHaveBeenCalledWith({
      kind: "lead",
      propertyId: "prop-1",
      clientRequestId: REQUEST_ID,
    });
    expect(h.calls.slice(0, 3)).toEqual(["mic", "token", "start"]);
  });

  it("uses a manual start when there is no property and a fresh id for a non-uuid token", async () => {
    const h = harness();
    await h.transport.start({ phoneE164: "+18165550123", callToken: "not-a-uuid" });
    expect(h.deps.startCall).toHaveBeenCalledWith({
      kind: "manual",
      phone: "+18165550123",
      clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("answers only the matching leg and rejects any other invite unanswered", async () => {
    const h = harness();
    await h.transport.start(target);
    const stranger = fakeCall({ telnyxIDs: { telnyxCallControlId: "other" } });
    const match = fakeCall();
    h.notify(stranger);
    h.notify(match);
    await flush();
    expect(stranger.answer).not.toHaveBeenCalled();
    expect(stranger.hangup).toHaveBeenCalledTimes(1);
    expect(match.answer).toHaveBeenCalledTimes(1);
    expect(match.hangup).not.toHaveBeenCalled();
  });

  it("answers on the correlation header when the leg id is not yet known", async () => {
    const h = harness();
    await h.transport.start(target);
    const byHeader = fakeCall({
      telnyxIDs: { telnyxCallControlId: "" },
      options: { customHeaders: [{ name: "x-sandra-direct-call-id", value: CALL_ID }] },
    });
    h.notify(byHeader);
    await flush();
    expect(byHeader.answer).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong-header invite and a second invite after one was answered", async () => {
    const h = harness();
    await h.transport.start(target);
    const wrongHeader = fakeCall({
      telnyxIDs: { telnyxCallControlId: "x" },
      options: { customHeaders: [{ name: "X-Sandra-Direct-Call-Id", value: "someone-else" }] },
    });
    const first = fakeCall();
    const duplicate = fakeCall({ id: "dup" });
    h.notify(wrongHeader);
    h.notify(first);
    h.notify(duplicate);
    await flush();
    expect(wrongHeader.answer).not.toHaveBeenCalled();
    expect(first.answer).toHaveBeenCalledTimes(1);
    expect(duplicate.answer).not.toHaveBeenCalled();
    expect(duplicate.hangup).toHaveBeenCalledTimes(1);
  });

  it("rejects outbound or non-ringing updates without answering", async () => {
    const h = harness();
    await h.transport.start(target);
    const outbound = fakeCall({ direction: "outbound" });
    h.notify(outbound);
    await flush();
    expect(outbound.answer).not.toHaveBeenCalled();
  });

  it("holds an early invite until the start result identifies the call", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = h.deps.startCall.getMockImplementation()!;
    h.deps.startCall.mockImplementation(async (i: unknown) => {
      await gate;
      return original(i);
    });
    const starting = h.transport.start(target);
    await flush();
    const early = fakeCall();
    h.notify(early);
    await flush();
    expect(early.answer).not.toHaveBeenCalled();
    expect(early.hangup).not.toHaveBeenCalled();
    release();
    await starting;
    await flush();
    expect(early.answer).toHaveBeenCalledTimes(1);
  });

  it("polls status and maps connecting, ringing, live, then terminal", async () => {
    const h = harness({
      statuses: ["browser_connecting", "seller_dialing", "connected", "ended"],
    });
    await h.transport.start(target);
    await vi.waitFor(() => expect(h.transport.terminalIsAuthoritative()).toBe(true));
    expect(h.states).toEqual(["connecting", "ringing", "live", "ended"]);
    expect(h.transport.terminalIsAuthoritative()).toBe(true);
    expect(h.client.disconnect).toHaveBeenCalled();
  });

  it("marks failed as terminal and authoritative", async () => {
    const h = harness({ statuses: ["failed"] });
    await h.transport.start(target);
    await vi.waitFor(() => expect(h.transport.terminalIsAuthoritative()).toBe(true));
    expect(h.states).toContain("failed");
  });

  it("reports poll failures without ending the call", async () => {
    const h = harness();
    const errors: unknown[] = [];
    h.transport.onProviderStatusError((e) => errors.push(e));
    h.deps.getStatus.mockResolvedValue({ ok: false, error: "x", errorCode: "boom" } as never);
    await h.transport.start(target);
    await flush();
    expect(errors[0]).toMatchObject({ errorCode: "boom" });
    expect(h.transport.terminalIsAuthoritative()).toBe(false);
  });

  async function liveCall(h: ReturnType<typeof harness>) {
    await h.transport.start(target);
    const call = fakeCall();
    h.notify(call);
    await vi.waitFor(() => expect(h.states).toContain("live"));
    return call;
  }

  it("treats a resolved false hold as failure and true as success", async () => {
    const h = harness();
    const call = await liveCall(h);
    call.hold.mockResolvedValueOnce(false);
    expect(await h.transport.hold(true)).toBe(false);
    expect(await h.transport.hold(true)).toBe(true);
    expect(await h.transport.hold(false)).toBe(true);
    call.unhold.mockRejectedValueOnce(new Error("x"));
    expect(await h.transport.hold(false)).toBe(false);
  });

  it("mutes locally through the SDK", async () => {
    const h = harness();
    const call = await liveCall(h);
    expect(await h.transport.mute(true)).toBe(true);
    expect(call.muteAudio).toHaveBeenCalled();
    expect(await h.transport.mute(false)).toBe(true);
    expect(call.unmuteAudio).toHaveBeenCalled();
  });

  it("sends DTMF through the server control action", async () => {
    const h = harness();
    await liveCall(h);
    expect(await h.transport.sendDigit("5")).toBe(true);
    expect(h.deps.control).toHaveBeenCalledWith(CALL_ID, { action: "dtmf", digit: "5" });
    h.deps.control.mockResolvedValueOnce({ ok: false, error: "no" } as never);
    expect(await h.transport.sendDigit("6")).toBe(false);
  });

  it("hangs up through the server first, then the SDK, and waits for terminal proof", async () => {
    const h = harness({ statuses: ["connected", "connected", "ended"] });
    const call = await liveCall(h);
    const order: string[] = [];
    h.deps.control.mockImplementation(async (_id, c) => {
      order.push(`control:${c.action}`);
      return { ok: true as const, data: { accepted: true as const } };
    });
    call.hangup.mockImplementation(async () => {
      order.push("sdk-hangup");
    });
    const result = await h.transport.hangup();
    expect(order).toEqual(["control:hangup", "sdk-hangup"]);
    expect(h.transport.terminalIsAuthoritative()).toBe(true);
    expect(result.outcome).toBe("connected_human");
  });

  it("is not authoritative when the server never confirms the hangup", async () => {
    const h = harness({ statuses: ["connected"] });
    await liveCall(h);
    await h.transport.hangup();
    expect(h.transport.terminalIsAuthoritative()).toBe(false);
  });

  it("does not reconnect audio (no mid-call recovery in the pilot)", async () => {
    const h = harness();
    expect(await h.transport.reconnectAudio()).toBe(false);
  });

  it("maps the backend's call_in_progress refusal to the operator_busy state and releases the client", async () => {
    const h = harness();
    h.deps.startCall.mockResolvedValue({ ok: false, error: "busy", errorCode: "call_in_progress", reserved: false } as never);
    await h.transport.start(target);
    expect(h.states).toEqual(["operator_busy"]);
    expect(h.client.disconnect).toHaveBeenCalled();
    expect(h.deps.cancelByRequest).not.toHaveBeenCalled(); // proven pre-reservation: nothing to reconcile
  });

  it("throws other start refusals", async () => {
    const h = harness();
    h.deps.startCall.mockResolvedValue({ ok: false, error: "Calling is unavailable during quiet hours.", reserved: false } as never);
    await expect(h.transport.start(target)).rejects.toThrow(/quiet hours/);
    expect(h.deps.cancelByRequest).not.toHaveBeenCalled();
  });

  it("does not map codes the backend never emits to refusal states", async () => {
    for (const errorCode of ["operator_busy", "not_callable"]) {
      const h = harness();
      h.deps.startCall.mockResolvedValue({ ok: false, error: "x", errorCode, reserved: false } as never);
      await expect(h.transport.start(target)).rejects.toThrow("x");
      expect(h.states).toEqual([]);
    }
  });
});

describe("review blockers", () => {
  it("preserves a manual request that the UI prepared against a lead (propertyId present)", async () => {
    const h = harness();
    await h.transport.start({ ...target, directRequest: { kind: "manual", phone: "8165550123" } });
    expect(h.deps.startCall).toHaveBeenCalledWith({ kind: "manual", phone: "8165550123", clientRequestId: REQUEST_ID });
  });

  it("preserves a lead request", async () => {
    const h = harness();
    await h.transport.start({ phoneE164: "+18165550123", callToken: REQUEST_ID, directRequest: { kind: "lead", propertyId: "prop-9" } });
    expect(h.deps.startCall).toHaveBeenCalledWith({ kind: "lead", propertyId: "prop-9", clientRequestId: REQUEST_ID });
  });

  it("exposes the sealed call capability from the start result on the handle", async () => {
    const h = harness();
    const original = h.deps.startCall.getMockImplementation()!;
    h.deps.startCall.mockImplementation(async (i: unknown) => {
      const r = await original(i);
      return { ...r, data: { ...r.data, callCapability: "sealed-cap" } };
    });
    expect(await h.transport.start(target)).toEqual({ id: CALL_ID, callCapability: "sealed-cap" });
    expect(h.transport.callHandle()).toEqual({ id: CALL_ID, callCapability: "sealed-cap" });
  });

  it("creates the SDK client with no recovery: hangs up on unload and does not keep the socket alive", async () => {
    const ctor = vi.fn();
    vi.doMock("@telnyx/webrtc", () => ({
      TelnyxRTC: class {
        static webRTCInfo = () => ({ supportWebRTCAudio: true });
        constructor(options: unknown) {
          ctor(options);
        }
      },
    }));
    await createTelnyxRtcClient("jwt", null);
    expect(ctor).toHaveBeenCalledWith(expect.objectContaining({ hangupOnBeforeUnload: true, keepConnectionAliveOnSocketClose: false }));
    vi.doUnmock("@telnyx/webrtc");
  });

  it("a hangup during setup never reaches startDirectCall and never answers", async () => {
    const h = harness();
    let releaseMic!: () => void;
    h.deps.prepareMicrophone.mockImplementation(() => new Promise<void>((r) => (releaseMic = r)));
    const starting = h.transport.start(target);
    const startRejected = starting.catch((e: Error) => e.message);
    const hanging = h.transport.hangup();
    releaseMic();
    expect(await startRejected).toMatch(/cancelled/i);
    await hanging;
    expect(h.deps.startCall).not.toHaveBeenCalled();
    expect(h.deps.control).not.toHaveBeenCalled();
  });

  it("a hangup while startDirectCall is in flight ends the new call and never answers its invite", async () => {
    const h = harness({ statuses: ["connected", "ended"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = h.deps.startCall.getMockImplementation()!;
    h.deps.startCall.mockImplementation(async (i: unknown) => {
      await gate;
      return original(i);
    });
    const starting = h.transport.start(target);
    await flush();
    const early = fakeCall();
    h.notify(early);
    const hanging = h.transport.hangup();
    release();
    await starting;
    await hanging;
    expect(h.deps.control).toHaveBeenCalledWith(CALL_ID, { action: "hangup" });
    expect(early.answer).not.toHaveBeenCalled();
    const late = fakeCall({ id: "late" });
    h.notify(late);
    await flush();
    expect(late.answer).not.toHaveBeenCalled();
  });

  it("tears the call down when the browser connection errors or closes after registration", async () => {
    for (const event of ["telnyx.error", "telnyx.socket.close", "telnyx.socket.error"]) {
      const h = harness({ statuses: ["connected"] });
      await h.transport.start(target);
      h.deps.control.mockClear();
      h.emit(event, { error: new Error("lost") });
      await flush();
      expect(h.deps.control).toHaveBeenCalledWith(CALL_ID, { action: "hangup" });
    }
  });

  it("does not treat a pre-registration error as a call teardown", async () => {
    const h = harness();
    h.client.connect.mockImplementation(async () => {
      queueMicrotask(() => h.emit("telnyx.error", { error: new Error("bad login") }));
    });
    await expect(h.transport.start(target)).rejects.toThrow("bad login");
    expect(h.deps.control).not.toHaveBeenCalled();
    expect(h.deps.startCall).not.toHaveBeenCalled();
  });

  describe("teardown confirmation (cleanupPending)", () => {
    it("does not accept a terminal status while cleanup is pending: warns, keeps polling, then confirms and ends", async () => {
      const h = harness({ statuses: ["connected"] });
      await h.transport.start(target);
      h.deps.getStatus.mockImplementation(async () => view("ended", { cleanupPending: true, failureReason: "teardown_pending" }));
      await vi.waitFor(() => expect(h.states).toContain("teardown_unconfirmed"));
      expect(h.states).not.toContain("ended");
      expect(h.transport.terminalIsAuthoritative()).toBe(false);
      const polls = h.deps.getStatus.mock.calls.length;
      await vi.waitFor(() => expect(h.deps.getStatus.mock.calls.length).toBeGreaterThan(polls)); // still polling
      expect(h.client.disconnect).not.toHaveBeenCalled();
      h.deps.getStatus.mockImplementation(async () => view("ended", { cleanupPending: false }));
      await vi.waitFor(() => expect(h.transport.terminalIsAuthoritative()).toBe(true));
      expect(h.states.slice(-3)).toEqual(["teardown_unconfirmed", "teardown_confirmed", "ended"]);
      expect(h.client.disconnect).toHaveBeenCalled();
    });

    it("fails closed when the server omits cleanupPending", async () => {
      const h = harness({ statuses: ["connected"] });
      await h.transport.start(target);
      h.deps.getStatus.mockImplementation(async () => view("failed", { cleanupPending: undefined as never }));
      await vi.waitFor(() => expect(h.states).toContain("teardown_unconfirmed"));
      expect(h.transport.terminalIsAuthoritative()).toBe(false);
    });
  });

  describe("shared teardown-and-confirm path", () => {
    it("socket loss while startDirectCall is in flight hangs the new call up with retries, polls, and publishes the final state", async () => {
      const h = harness({ statuses: ["connected"] });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = h.deps.startCall.getMockImplementation()!;
      h.deps.startCall.mockImplementation(async (i: unknown) => {
        await gate;
        return original(i);
      });
      let attempts = 0;
      h.deps.control.mockImplementation(async (_id: string, c: { action: string }) => {
        if (c.action !== "hangup") return { ok: true as const, data: { accepted: true as const } };
        attempts += 1;
        if (attempts <= 2) throw new Error("network");
        return { ok: true as const, data: { accepted: true as const } };
      });
      h.deps.getStatus.mockImplementation(async () => view(attempts >= 3 ? "ended" : "connected", { cleanupPending: attempts < 3 }));
      const starting = h.transport.start(target);
      await flush();
      h.emit("telnyx.socket.close");
      release();
      await starting;
      await vi.waitFor(() => expect(h.transport.terminalIsAuthoritative()).toBe(true));
      expect(attempts).toBe(3); // retried after failures, stopped once accepted
      expect(h.states[h.states.length - 1]).toBe("ended");
    });

    it("user hangup retries a failed server hangup with backoff and only then confirms", async () => {
      const h = harness({ statuses: ["connected"] });
      const call = fakeCall();
      await h.transport.start(target);
      h.notify(call);
      await flush();
      let attempts = 0;
      h.deps.control.mockImplementation(async () => {
        attempts += 1;
        return attempts < 3 ? ({ ok: false as const, error: "x", errorCode: "hangup_failed" } as never) : { ok: true as const, data: { accepted: true as const } };
      });
      h.deps.getStatus.mockImplementation(async () => (attempts >= 3 ? view("ended") : view("connected")));
      const result = await h.transport.hangup();
      expect(attempts).toBe(3);
      expect(h.transport.terminalIsAuthoritative()).toBe(true);
      expect(result.outcome).toBe("connected_human");
      expect(call.hangup).toHaveBeenCalledTimes(1);
    });

    it("an unconfirmed teardown publishes teardown_unconfirmed, keeps watching, and a retry hangup can still confirm", async () => {
      const h = harness({ statuses: ["connected"] });
      await h.transport.start(target);
      h.deps.getStatus.mockImplementation(async () => view("ending", { cleanupPending: true }));
      await h.transport.hangup();
      expect(h.states).toContain("teardown_unconfirmed");
      expect(h.transport.terminalIsAuthoritative()).toBe(false);
      h.deps.control.mockClear();
      h.deps.getStatus.mockImplementation(async () => view("ended"));
      await h.transport.hangup(); // provider's retryTeardown
      expect(h.deps.control).toHaveBeenCalledWith(CALL_ID, { action: "hangup" });
      expect(h.transport.terminalIsAuthoritative()).toBe(true);
    });

    it("pagehide and a failed answer use the same path", async () => {
      const fakeWindow = new EventTarget();
      vi.stubGlobal("window", fakeWindow);
      const h = harness({ statuses: ["connected"] });
      await h.transport.start(target);
      h.deps.control.mockClear();
      fakeWindow.dispatchEvent(new Event("pagehide"));
      await flush();
      vi.unstubAllGlobals();
      expect(h.deps.control).toHaveBeenCalledWith(CALL_ID, { action: "hangup" });
      const h2 = harness({ statuses: ["connected"] });
      await h2.transport.start(target);
      h2.deps.control.mockClear();
      h2.notify(fakeCall({ answer: vi.fn(async () => { throw new Error("answer failed"); }) }));
      await flush();
      expect(h2.deps.control).toHaveBeenCalledWith(CALL_ID, { action: "hangup" });
    });
  });
});

describe("lost start response (#744-1)", () => {
  const lost = () => Object.assign(new Error("network error"), { name: "TypeError" });

  it("a start that was never submitted makes no cancel or status-by-request call", async () => {
    const mic = harness({ micError: true });
    await expect(mic.transport.start(target)).rejects.toThrow(/Microphone/);
    expect(mic.deps.cancelByRequest).not.toHaveBeenCalled();
    const cancelled = harness();
    const pending = cancelled.transport.start(target);
    void cancelled.transport.hangup(); // before registration finishes: the start is never sent
    await pending.catch(() => undefined);
    expect(cancelled.deps.startCall).not.toHaveBeenCalled();
    expect(cancelled.deps.cancelByRequest).not.toHaveBeenCalled();
    expect(cancelled.deps.getStatusByRequest).not.toHaveBeenCalled();
  });

  it("a submitted start whose response is lost is cancelled by request id and watched to a confirmed terminal before the failure is surfaced", async () => {
    const h = harness();
    h.deps.startCall.mockRejectedValueOnce(lost());
    h.deps.getStatusByRequest
      .mockResolvedValueOnce(view("ending", { cleanupPending: true }))
      .mockResolvedValueOnce(view("ended", { cleanupPending: true }))
      .mockResolvedValue(view("ended", { cleanupPending: false }));
    await expect(h.transport.start(target)).rejects.toThrow("network error");
    expect(h.deps.cancelByRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(h.deps.getStatusByRequest).toHaveBeenCalledTimes(3);
    expect(h.deps.getStatusByRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(h.states).not.toContain("teardown_unconfirmed");
    // Never treated as confirmed teardown without reconciliation: the cancel came BEFORE any "nothing to confirm".
    expect(h.deps.cancelByRequest.mock.invocationCallOrder[0]).toBeLessThan(h.deps.getStatusByRequest.mock.invocationCallOrder[0]);
  });

  it("an explicit start_failed after an unknown Dial (reserved:true) is reconciled by request id, never treated as torn down (#744-1)", async () => {
    const h = harness();
    h.deps.startCall.mockResolvedValueOnce({ ok: false, error: "Could not start the call. Try again.", errorCode: "start_failed", reserved: true } as never);
    h.deps.getStatusByRequest
      .mockResolvedValueOnce(view("failed", { cleanupPending: true })) // unknown Dial still open
      .mockResolvedValue(view("failed", { cleanupPending: false }));
    await expect(h.transport.start(target)).rejects.toThrow("Could not start the call");
    expect(h.deps.cancelByRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(h.deps.getStatusByRequest).toHaveBeenCalledTimes(2);
    expect(h.states).not.toContain("teardown_unconfirmed");
    expect(h.deps.cancelByRequest.mock.invocationCallOrder[0]).toBeLessThan(h.deps.getStatusByRequest.mock.invocationCallOrder[0]);
  });

  it("an unconfirmed reconciliation after start_failed warns and is not authoritative until it confirms", async () => {
    const h = harness();
    h.deps.startCall.mockResolvedValueOnce({ ok: false, error: "x", errorCode: "start_failed", reserved: true } as never);
    let confirmed = false;
    h.deps.getStatusByRequest.mockImplementation(async () => view("failed", { cleanupPending: !confirmed }));
    const started = h.transport.start(target).catch((e: unknown) => e);
    await vi.waitFor(() => expect(h.states).toContain("teardown_unconfirmed"));
    expect(h.transport.terminalIsAuthoritative()).toBe(false);
    await started;
    // The failed start's later hangup must not mark it confirmed while cleanup is still open.
    await h.transport.hangup();
    expect(h.transport.terminalIsAuthoritative()).toBe(false);
    confirmed = true;
    await vi.waitFor(() => expect(h.states).toContain("teardown_confirmed"));
    expect(h.transport.terminalIsAuthoritative()).toBe(true);
  });

  it("a start error without the reserved flag is reconciled too (safe default)", async () => {
    const h = harness();
    h.deps.startCall.mockResolvedValueOnce({ ok: false, error: "x", errorCode: "start_failed" } as never);
    h.deps.getStatusByRequest.mockResolvedValue(view("failed", { cleanupPending: false }));
    await expect(h.transport.start(target)).rejects.toThrow("x");
    expect(h.deps.cancelByRequest).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("retries a failing cancel with backoff, and an unconfirmed outcome warns, keeps watching, and later confirms", async () => {
    const h = harness();
    h.deps.startCall.mockRejectedValueOnce(lost());
    h.deps.cancelByRequest
      .mockRejectedValueOnce(lost())
      .mockResolvedValueOnce({ ok: false as const, error: "down" } as never)
      .mockResolvedValue({ ok: true as const, data: { directCallId: CALL_ID, tombstoned: false } });
    let confirmed = false;
    h.deps.getStatusByRequest.mockImplementation(async () => view("ended", { cleanupPending: !confirmed }));
    const started = h.transport.start(target).catch((e: unknown) => e);
    await vi.waitFor(() => expect(h.states).toContain("teardown_unconfirmed"));
    expect(h.deps.cancelByRequest.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.transport.terminalIsAuthoritative()).toBe(false);
    await started;
    confirmed = true;
    await vi.waitFor(() => expect(h.states).toContain("teardown_confirmed"));
    expect(h.transport.terminalIsAuthoritative()).toBe(true);
  });

  it("hanging up while the start is in flight tells the server by request id immediately", async () => {
    const h = harness();
    let release!: () => void;
    h.deps.startCall.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({ ok: true as const, data: { directCallId: CALL_ID, browserLegId: LEG, correlationHeader: { name: "X-Sandra-Direct-Call-Id" as const, value: CALL_ID } } });
      }),
    );
    h.deps.cancelByRequest.mockResolvedValue({ ok: true as const, data: { directCallId: CALL_ID, tombstoned: false } });
    h.deps.getStatus.mockResolvedValue(view("ended"));
    const started = h.transport.start(target);
    await vi.waitFor(() => expect(h.deps.startCall).toHaveBeenCalled());
    const hung = h.transport.hangup();
    expect(h.deps.cancelByRequest).toHaveBeenCalledWith(REQUEST_ID);
    release();
    await started;
    await hung;
    expect(h.deps.control).toHaveBeenCalledWith(CALL_ID, { action: "hangup" });
  });

  it("returns the server-prepared target on the call handle", async () => {
    const h = harness();
    const prepared = { propertyId: "prop-1", contactId: "c1", phoneE164: "+18165550123", maskedPhone: "(816) 555-0123", name: "Pat", address: "1 Main", state: "MO", startedAt: "2026-10-01T12:00:00.000Z" };
    h.deps.startCall.mockResolvedValueOnce({
      ok: true as const,
      data: { directCallId: CALL_ID, browserLegId: LEG, correlationHeader: { name: "X-Sandra-Direct-Call-Id" as const, value: CALL_ID }, target: prepared },
    } as never);
    const handle = await h.transport.start(target);
    expect(handle.target).toEqual(prepared);
  });
});
