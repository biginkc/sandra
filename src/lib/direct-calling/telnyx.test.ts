import { describe, expect, it, vi } from "vitest";

import type { TelnyxDirectSettings } from "./config";
import { TelnyxApiError, decodeClientState, encodeClientState, isLegAlreadyEnded, telnyxCreateToken, telnyxDial, telnyxHangup } from "./telnyx";

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

  it("recognises a hangup refused because the leg already ended", async () => {
    const gone = vi.fn(async () => new Response(JSON.stringify({ errors: [{ detail: "Call has already ended" }] }), { status: 422 }));
    const err = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: gone as never }).catch((e) => e);
    expect(isLegAlreadyEnded(err)).toBe(true);
    const missing = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: (async () => new Response("{}", { status: 404 })) as never }).catch((e) => e);
    expect(isLegAlreadyEnded(missing)).toBe(true);
    const down = await telnyxHangup(settings, "leg", "cmd", { fetchImpl: (async () => new Response("{}", { status: 503 })) as never }).catch((e) => e);
    expect(isLegAlreadyEnded(down)).toBe(false);
    expect(isLegAlreadyEnded(new Error("x"))).toBe(false);
  });
});
