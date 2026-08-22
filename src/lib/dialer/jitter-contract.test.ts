import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JITTER_SOFTPHONE_PATHS,
  requestJitterCancel,
  requestJitterAudioHealth,
  requestJitterConnect,
  requestJitterStartCall,
  requestJitterToken,
  signJitterSoftphoneBody,
} from "./jitter-contract";

const SERVICE_TOKEN = "test-service-token";
const CALL_ID = "00000000-0000-4000-8000-000000000011";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

type SeenRequest = {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | null;
  idempotencyKey: string | null;
};

function contractServer(respond: (request: SeenRequest) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("authorization")).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(headers.get("x-jitter-signature")).toBe(
      `sha256=${createHmac("sha256", SERVICE_TOKEN).update(rawBody).digest("hex")}`,
    );
    return respond({
      method: String(init?.method),
      path: url.pathname,
      search: url.search,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
      idempotencyKey: headers.get("idempotency-key"),
    });
  }) as unknown as typeof fetch;
}

function cancelResponse() {
  return {
    call_id: CALL_ID,
    session_id: "session-1",
    status: "ended",
    teardown: {
      released_batch_claims: 1,
      revoked_bindings: 1,
      revoked_device_leases: 1,
      ended_shifts: 1,
      released_worker_leases: 1,
    },
  };
}

describe("Sandra -> Jitter softphone CONTRACT v2 proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls every handler with exact methods, snake_case bodies, and response shapes", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test/");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const seen: SeenRequest[] = [];
    const server = contractServer((request) => {
      seen.push(request);
      if (request.path === JITTER_SOFTPHONE_PATHS.startCall) {
        return Response.json({
          call_id: CALL_ID,
          session_id: "session-1",
          batch_id: "batch-1",
          run_id: "run-1",
        });
      }
      if (request.path === JITTER_SOFTPHONE_PATHS.token) {
        return Response.json({
          rtc_token: "short-lived-token",
          sip_identity: "operator-1",
          expires_at: "2026-08-21T20:30:00.000Z",
        });
      }
      if (request.path === JITTER_SOFTPHONE_PATHS.connect)
        return Response.json({ dialing: true });
      if (request.path === JITTER_SOFTPHONE_PATHS.audioHealth)
        return Response.json({ accepted: true, status: "healthy" });
      if (request.path === JITTER_SOFTPHONE_PATHS.cancel)
        return Response.json(cancelResponse());
      return Response.json(
        { error: "not found", error_code: "not_found" },
        { status: 404 },
      );
    });

    await expect(
      requestJitterStartCall(
        {
          operator_id: "operator-1",
          phone_e164: "+18165550123",
          timezone: "America/Chicago",
        },
        IDEMPOTENCY_KEY,
        server,
      ),
    ).resolves.toEqual({
      ok: true,
      data: {
        call_id: CALL_ID,
        session_id: "session-1",
        batch_id: "batch-1",
        run_id: "run-1",
      },
    });
    await expect(requestJitterToken(CALL_ID, server)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      requestJitterConnect(CALL_ID, "registered", server),
    ).resolves.toEqual({
      ok: true,
      data: { dialing: true },
    });
    await expect(
      requestJitterConnect(CALL_ID, "accepted", server),
    ).resolves.toEqual({
      ok: true,
      data: { dialing: true },
    });
    await expect(
      requestJitterAudioHealth(
        CALL_ID,
        {
          controller_id: "00000000-0000-4000-8000-000000000021",
          peer_connection_generation: 1,
          sample_sequence: 2,
          packets_received: 12,
          bytes_received: 2048,
        },
        server,
      ),
    ).resolves.toEqual({
      ok: true,
      data: { accepted: true, status: "healthy" },
    });
    await expect(
      requestJitterCancel(CALL_ID, "hangup", server),
    ).resolves.toEqual({
      ok: true,
      data: cancelResponse(),
    });

    expect(seen).toEqual([
      {
        method: "POST",
        path: JITTER_SOFTPHONE_PATHS.startCall,
        search: "",
        body: {
          operator_id: "operator-1",
          phone_e164: "+18165550123",
          timezone: "America/Chicago",
        },
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      {
        method: "GET",
        path: JITTER_SOFTPHONE_PATHS.token,
        search: `?call_id=${CALL_ID}`,
        body: null,
        idempotencyKey: null,
      },
      {
        method: "POST",
        path: JITTER_SOFTPHONE_PATHS.connect,
        search: "",
        body: { call_id: CALL_ID, phase: "registered" },
        idempotencyKey: null,
      },
      {
        method: "POST",
        path: JITTER_SOFTPHONE_PATHS.connect,
        search: "",
        body: { call_id: CALL_ID, phase: "accepted" },
        idempotencyKey: null,
      },
      {
        method: "POST",
        path: JITTER_SOFTPHONE_PATHS.audioHealth,
        search: "",
        body: {
          call_id: CALL_ID,
          controller_id: "00000000-0000-4000-8000-000000000021",
          peer_connection_generation: 1,
          sample_sequence: 2,
          packets_received: 12,
          bytes_received: 2048,
        },
        idempotencyKey: null,
      },
      {
        method: "POST",
        path: JITTER_SOFTPHONE_PATHS.cancel,
        search: "",
        body: { call_id: CALL_ID, reason: "hangup" },
        idempotencyKey: null,
      },
    ]);
  });

  it("signs the token GET over the exact empty body", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const server = contractServer((request) => {
      expect(request).toMatchObject({
        method: "GET",
        body: null,
        search: `?call_id=${CALL_ID}`,
      });
      return Response.json({
        rtc_token: "short-lived-token",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T20:30:00.000Z",
      });
    });

    await expect(requestJitterToken(CALL_ID, server)).resolves.toMatchObject({
      ok: true,
    });
    expect(signJitterSoftphoneBody(SERVICE_TOKEN)).toBe(
      `sha256=${createHmac("sha256", SERVICE_TOKEN).update("").digest("hex")}`,
    );
  });

  it("retries start-call with the identical Idempotency-Key and exact body", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const seen: SeenRequest[] = [];
    const server = contractServer((request) => {
      seen.push(request);
      if (seen.length === 1) throw new Error("connection reset after write");
      return Response.json({
        call_id: CALL_ID,
        session_id: "session-1",
        batch_id: "batch-1",
        run_id: "run-1",
      });
    });

    await expect(
      requestJitterStartCall(
        {
          operator_id: "operator-1",
          phone_e164: "+18165550123",
          timezone: "America/Chicago",
        },
        IDEMPOTENCY_KEY,
        server,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[0].idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(seen[1]).toEqual(seen[0]);
  });

  it("preserves v2's distinct operator_busy and not_callable envelopes", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const busyServer = contractServer(() =>
      Response.json(
        { error: "Operator already has a call.", error_code: "operator_busy" },
        { status: 409 },
      ),
    );
    const blockedServer = contractServer(() =>
      Response.json(
        { error: "Phone is not callable.", error_code: "not_callable" },
        { status: 422 },
      ),
    );
    const body = {
      operator_id: "operator-1",
      phone_e164: "+18165550123",
      timezone: "America/Chicago",
    };

    await expect(
      requestJitterStartCall(body, IDEMPOTENCY_KEY, busyServer),
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: "Operator already has a call.",
      errorCode: "operator_busy",
    });
    await expect(
      requestJitterStartCall(body, IDEMPOTENCY_KEY, blockedServer),
    ).resolves.toEqual({
      ok: false,
      status: 422,
      error: "Phone is not callable.",
      errorCode: "not_callable",
    });
  });

  it("returns a stable error for non-JSON and malformed success envelopes", async () => {
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "https://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const nonJson = contractServer(
      () => new Response("gateway failed", { status: 400 }),
    );
    const malformed = contractServer(() => Response.json({ call_id: CALL_ID }));

    await expect(requestJitterToken(CALL_ID, nonJson)).resolves.toEqual({
      ok: false,
      status: 400,
      error: "Jitter softphone request failed (400).",
      errorCode: "jitter_request_failed",
    });
    await expect(
      requestJitterStartCall(
        {
          operator_id: "operator-1",
          phone_e164: "+18165550123",
          timezone: "America/Chicago",
        },
        IDEMPOTENCY_KEY,
        malformed,
      ),
    ).resolves.toEqual({
      ok: false,
      status: 502,
      error: "Jitter softphone returned an invalid response.",
      errorCode: "jitter_contract_violation",
    });
  });

  it("refuses to send the service credential over non-loopback HTTP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JITTER_SOFTPHONE_BASE_URL", "http://jitter.example.test");
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", SERVICE_TOKEN);
    const server = vi.fn();
    await expect(requestJitterToken(CALL_ID, server)).resolves.toEqual({
      ok: false,
      status: 503,
      error: "Jitter softphone base URL is invalid.",
      errorCode: "jitter_invalid_configuration",
    });
    expect(server).not.toHaveBeenCalled();
  });
});
