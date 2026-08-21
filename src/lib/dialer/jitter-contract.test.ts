import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JITTER_SOFTPHONE_PATHS,
  requestJitterCancel,
  requestJitterConnect,
  requestJitterSoftphone,
  requestJitterStartCall,
  requestJitterToken,
  signJitterSoftphoneBody,
} from "./jitter-contract";

const SERVICE_TOKEN = "test-service-token";

function contractServer(
  respond: (path: string, body: Record<string, unknown> | null) => Response,
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("authorization")).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(headers.get("x-sandra-signature")).toBe(
      `sha256=${createHmac("sha256", SERVICE_TOKEN).update(rawBody).digest("hex")}`,
    );
    return respond(url.pathname, rawBody ? JSON.parse(rawBody) as Record<string, unknown> : null);
  }) as unknown as typeof fetch;
}

describe("Sandra -> Jitter softphone contract proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls all four pinned endpoints with exact bearer, HMAC, and request bodies", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test/");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const seen: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    const server = contractServer((path, body) => {
      seen.push({ path, body });
      if (path === JITTER_SOFTPHONE_PATHS.startCall) {
        return Response.json({ sessionRef: "session-1", batchId: "batch-1" });
      }
      if (path === JITTER_SOFTPHONE_PATHS.token) {
        return Response.json({
          rtcToken: "short-lived-token",
          sipIdentity: "operator-1",
          expiresAt: "2026-08-21T20:30:00.000Z",
        });
      }
      if (path === JITTER_SOFTPHONE_PATHS.connect) return Response.json({ dialing: true });
      if (path === JITTER_SOFTPHONE_PATHS.cancel) return Response.json({ tornDown: true });
      return Response.json({ error: "not found", error_code: "not_found" }, { status: 404 });
    });

    await expect(requestJitterStartCall({
      operatorEmail: "operator@example.test",
      phoneE164: "+18165550123",
      propertyRef: "property-1",
      contactRef: "contact-1",
    }, server)).resolves.toEqual({ ok: true, data: { sessionRef: "session-1", batchId: "batch-1" } });
    await expect(requestJitterToken("session-1", server)).resolves.toMatchObject({ ok: true });
    await expect(requestJitterConnect("session-1", server)).resolves.toEqual({ ok: true, data: { dialing: true } });
    await expect(requestJitterCancel("session-1", "hangup", server)).resolves.toEqual({ ok: true, data: { tornDown: true } });

    expect(seen).toEqual([
      {
        path: JITTER_SOFTPHONE_PATHS.startCall,
        body: {
          operatorEmail: "operator@example.test",
          phoneE164: "+18165550123",
          propertyRef: "property-1",
          contactRef: "contact-1",
        },
      },
      { path: JITTER_SOFTPHONE_PATHS.token, body: { sessionRef: "session-1" } },
      { path: JITTER_SOFTPHONE_PATHS.connect, body: { sessionRef: "session-1" } },
      { path: JITTER_SOFTPHONE_PATHS.cancel, body: { sessionRef: "session-1", reason: "hangup" } },
    ]);
  });

  it("preserves pinned 409 and 422 error envelopes including the callable reason", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const busyServer = contractServer(() => Response.json(
      { error: "Operator already has a call.", error_code: "operator_busy" },
      { status: 409 },
    ));
    const blockedServer = contractServer(() => Response.json(
      { error: "Phone is not callable.", error_code: "not_callable", reason: "dnc" },
      { status: 422 },
    ));

    await expect(requestJitterStartCall({
      operatorEmail: "operator@example.test",
      phoneE164: "+18165550123",
    }, busyServer)).resolves.toEqual({
      ok: false,
      status: 409,
      error: "Operator already has a call.",
      errorCode: "operator_busy",
    });
    await expect(requestJitterStartCall({
      operatorEmail: "operator@example.test",
      phoneE164: "+18165550123",
    }, blockedServer)).resolves.toEqual({
      ok: false,
      status: 422,
      error: "Phone is not callable.",
      errorCode: "not_callable",
      reason: "dnc",
    });
  });

  it("returns a stable error for non-JSON and malformed success envelopes", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const nonJson = contractServer(() => new Response("gateway failed", { status: 503 }));
    const malformed = contractServer(() => Response.json({ sessionRef: "session-1" }));

    await expect(requestJitterToken("session-1", nonJson)).resolves.toEqual({
      ok: false,
      status: 503,
      error: "Jitter softphone request failed (503).",
      errorCode: "jitter_request_failed",
    });
    await expect(requestJitterStartCall({
      operatorEmail: "operator@example.test",
      phoneE164: "+18165550123",
    }, malformed)).resolves.toEqual({
      ok: false,
      status: 502,
      error: "Jitter softphone returned an invalid response.",
      errorCode: "jitter_contract_violation",
    });
  });

  it("signs a bodyless request over the exact empty string", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const server = contractServer((_path, body) => {
      expect(body).toBeNull();
      return Response.json({ tornDown: true });
    });
    await expect(requestJitterSoftphone({
      path: "/api/internal/sandra/softphone/bodyless-proof",
      validate: (value): value is { tornDown: true } => (
        Boolean(value && typeof value === "object" && "tornDown" in value && value.tornDown === true)
      ),
      fetchImpl: server,
    })).resolves.toEqual({ ok: true, data: { tornDown: true } });
    expect(signJitterSoftphoneBody(SERVICE_TOKEN)).toBe(
      `sha256=${createHmac("sha256", SERVICE_TOKEN).update("").digest("hex")}`,
    );
  });

  it("refuses to send the service credential over non-loopback HTTP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "http://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const server = vi.fn();
    await expect(requestJitterToken("session-1", server)).resolves.toEqual({
      ok: false,
      status: 503,
      error: "Jitter softphone base URL is invalid.",
      errorCode: "jitter_invalid_configuration",
    });
    expect(server).not.toHaveBeenCalled();
  });
});
