import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DirectCallStatus,
  DirectCallStatusView,
} from "@/lib/direct-calling/contract";

vi.mock("@/lib/direct-calling/client-actions", () => ({
  controlDirectCall: vi.fn(),
  getDirectCallStatus: vi.fn(),
  getDirectRtcToken: vi.fn(),
  startDirectCall: vi.fn(),
}));

import {
  TelnyxDirectCallTransport,
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
  return { transport, deps, client, states, calls, notify };
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

  it("surfaces an operator_busy refusal as a state and releases the client", async () => {
    const h = harness();
    h.deps.startCall.mockResolvedValue({ ok: false, error: "busy", errorCode: "operator_busy" } as never);
    await h.transport.start(target);
    expect(h.states).toEqual(["operator_busy"]);
    expect(h.client.disconnect).toHaveBeenCalled();
  });

  it("throws other start refusals", async () => {
    const h = harness();
    h.deps.startCall.mockResolvedValue({ ok: false, error: "Calling is unavailable during quiet hours." } as never);
    await expect(h.transport.start(target)).rejects.toThrow(/quiet hours/);
  });
});
