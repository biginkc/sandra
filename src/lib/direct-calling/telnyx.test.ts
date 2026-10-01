import { describe, expect, it, vi } from "vitest";

import type { TelnyxDirectSettings } from "./config";
import { TelnyxApiError, decodeClientState, encodeClientState, isLegAlreadyEnded, telnyxCreateToken, telnyxDial, telnyxGetCallAlive, telnyxHangup, telnyxListActiveCalls } from "./telnyx";

const settings: TelnyxDirectSettings = { apiKey: "SECRET-KEY-123", connectionId: "conn", appId: "app", webhookPublicKey: "pub", callerIdE164: "+15550002222" };

describe("telnyx client", () => {
  it("sends the documented Dial body with Authorization only in headers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { call_control_id: "cc-1" } }), { status: 200 }));
    const out = await telnyxDial(settings, {
      to: "+15550001111", from: "+15550002222", clientState: { directCallId: "x", role: "seller" }, commandId: "cmd",
      timeoutSecs: 30, timeLimitSecs: 100, linkTo: "B", bridgeOnAnswer: true, bridgeIntent: false,
    }, { fetchImpl: fetchImpl as never });
    expect(out.callControlId).toBe("cc-1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/calls");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ connection_id: "app", link_to: "B", bridge_on_answer: true, bridge_intent: false, command_id: "cmd" });
    expect(sent).not.toHaveProperty("park_after_unbridge");
    expect(decodeClientState(sent.client_state)).toEqual({ directCallId: "x", role: "seller" });
  });

  it("classifies failures and redacts the key", async () => {
    const rejected = vi.fn(async () => new Response(JSON.stringify({ errors: [{ detail: "bad token SECRET-KEY-123" }] }), { status: 422 }));
    const err = await telnyxDial(settings, { to: "a", from: "b", clientState: {}, commandId: "c", timeoutSecs: 30, timeLimitSecs: 60 }, { fetchImpl: rejected as never }).catch((e) => e);
    expect(err).toBeInstanceOf(TelnyxApiError);
    expect(err.kind).toBe("rejected");
    expect(err.message).not.toContain("SECRET-KEY-123");
    const boom = vi.fn(async () => { throw Object.assign(new Error("Authorization: Bearer SECRET-KEY-123"), { name: "AbortError" }); });
    const timeout = await telnyxCreateToken(settings, "cred", { fetchImpl: boom as never }).catch((e) => e);
    expect(timeout.kind).toBe("unknown");
    expect(timeout.message).not.toMatch(/SECRET|Bearer/);
  });

  it("reads call liveness with GET /calls/{id}; only an explicit is_alive=false is gone; ambiguity is alive and any error (even 404) confirms nothing", async () => {
    const alive = vi.fn(async () => new Response(JSON.stringify({ data: { is_alive: true } }), { status: 200 }));
    expect(await telnyxGetCallAlive(settings, "cc 1", { fetchImpl: alive as never })).toEqual({ isAlive: true });
    const [url, init] = alive.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/calls/cc%201");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const dead = vi.fn(async () => new Response(JSON.stringify({ data: { is_alive: false } }), { status: 200 }));
    expect(await telnyxGetCallAlive(settings, "cc", { fetchImpl: dead as never })).toEqual({ isAlive: false });
    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(telnyxGetCallAlive(settings, "cc", { fetchImpl: missing as never })).rejects.toBeInstanceOf(TelnyxApiError);
    const odd = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    expect(await telnyxGetCallAlive(settings, "cc", { fetchImpl: odd as never })).toEqual({ isAlive: true });
    const down = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(telnyxGetCallAlive(settings, "cc", { fetchImpl: down as never })).rejects.toBeInstanceOf(TelnyxApiError);
  });

  it("reads the plain-text token", async () => {
    const fetchImpl = vi.fn(async () => new Response("jwt.value.here\n", { status: 201 }));
    expect(await telnyxCreateToken(settings, "cred-1", { fetchImpl: fetchImpl as never })).toBe("jwt.value.here");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.telnyx.com/v2/telephony_credentials/cred-1/token");
  });

  it("round-trips client_state", () => {
    expect(decodeClientState(encodeClientState({ a: "b" }))).toEqual({ a: "b" });
    expect(decodeClientState("%%%")).toBeNull();
    expect(decodeClientState(undefined)).toBeNull();
  });

  it("keeps the timeout armed while the response body is read", async () => {
    const stalled = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    }));
    const err = await telnyxDial(settings, { to: "a", from: "b", clientState: {}, commandId: "c", timeoutSecs: 30, timeLimitSecs: 60 }, { fetchImpl: stalled as never, timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(TelnyxApiError);
    expect(err.kind).toBe("unknown");
    expect(err.message).toMatch(/timed out/);
  });

  it("recognises only the documented 422/90018 hangup refusal as 'already ended'", async () => {
    const body = (code: string) => JSON.stringify({ errors: [{ code, title: "Call has already ended", detail: "Call has already ended" }] });
    const gone = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: (async () => new Response(body("90018"), { status: 422 })) as never }).catch((e) => e);
    expect(gone.code).toBe("90018");
    expect(isLegAlreadyEnded(gone)).toBe(true);
    const otherCode = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: (async () => new Response(body("90001"), { status: 422 })) as never }).catch((e) => e);
    expect(isLegAlreadyEnded(otherCode)).toBe(false);
    const missing = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: (async () => new Response("{}", { status: 404 })) as never }).catch((e) => e);
    expect(isLegAlreadyEnded(missing)).toBe(false); // an undocumented 404 confirms nothing
    const down = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: (async () => new Response("{}", { status: 503 })) as never }).catch((e) => e);
    expect(isLegAlreadyEnded(down)).toBe(false);
    expect(isLegAlreadyEnded(new Error("x"))).toBe(false);
  });

  it("surfaces Retry-After on a rate-limited response", async () => {
    const limited = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: "90103" }] }), { status: 429, headers: { "retry-after": "7" } }));
    const err = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: limited as never }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 7000, code: "90103" });
  });

  it("lists active calls on the Voice API app, following cursors, and flags a truncated listing", async () => {
    const state = encodeClientState({ directCallId: "call-1", role: "seller" });
    const pages = [
      { data: [{ call_control_id: "L1", client_state: state }], meta: { cursors: { after: "next-1" } } },
      { data: [{ call_control_id: "L2", client_state: null }], meta: { cursors: {} } },
    ];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(pages.shift()), { status: 200 }));
    const out = await telnyxListActiveCalls(settings, { fetchImpl: fetchImpl as never });
    expect(out.complete).toBe(true);
    expect(out.calls).toEqual([
      { callControlId: "L1", clientState: { directCallId: "call-1", role: "seller" } },
      { callControlId: "L2", clientState: null },
    ]);
    const urls = (fetchImpl.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
    expect(urls[0]).toBe("https://api.telnyx.com/v2/connections/app/active_calls?page%5Blimit%5D=250");
    expect(urls[1]).toContain("page%5Bafter%5D=next-1");
    const endless = vi.fn(async () => new Response(JSON.stringify({ data: [{ call_control_id: "X", client_state: null }], meta: { cursors: { after: "more" } } }), { status: 200 }));
    expect((await telnyxListActiveCalls(settings, { fetchImpl: endless as never })).complete).toBe(false);
  });
});
