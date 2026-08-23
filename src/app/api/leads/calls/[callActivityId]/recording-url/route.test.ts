import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authGetUser, eq, maybeSingle, select } = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const query = {
      select: select.mockImplementation(() => query),
      eq: eq.mockImplementation(() => query),
      maybeSingle,
    };
    return {
      auth: { getUser: authGetUser },
      from: vi.fn(() => query),
    };
  }),
}));

import { GET } from "./route";

const fetchMock = vi.fn();

function call(overrides: Record<string, unknown> = {}) {
  return {
    id: "call-1",
    provider: "jitter",
    jitter_attempt_id: "attempt/1",
    jitter_session_id: "session scope",
    call_recordings: [{ status: "available" }],
    ...overrides,
  };
}

function request(callActivityId = "call-1") {
  return GET(
    new Request(`https://sandra.example.test/api/leads/calls/${callActivityId}/recording-url`),
    { params: Promise.resolve({ callActivityId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("JITTER_API_BASE_URL", "https://jitter.example.test");
  vi.stubEnv("JITTER_SANDRA_PLAYBACK_TOKEN", "playback-secret");
  authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  maybeSingle.mockResolvedValue({ data: call(), error: null });
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        signedUrl: "https://storage.example.test/call.wav",
        expiresAt: "2026-08-23T14:00:00.000Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/leads/calls/[callActivityId]/recording-url", () => {
  it("requires a normal dashboard session before looking up the call", async () => {
    authGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const response = await request();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Not signed in",
      error_code: "unauthorized",
    });
    expect(maybeSingle).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses the session RLS lookup and returns the same 404 for an inaccessible call", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const response = await request("other-org-call");

    expect(response.status).toBe(404);
    expect(eq).toHaveBeenCalledWith("id", "other-org-call");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-Jitter calls before contacting Jitter", async () => {
    maybeSingle.mockResolvedValueOnce({ data: call({ provider: "twilio" }), error: null });
    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "unsupported_provider" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [[], "recording_not_available"],
    [[{ status: "pending" }], "recording_not_available"],
    [[{ status: "failed" }], "recording_failed"],
  ])("maps unavailable recording state %# without contacting Jitter", async (statuses, errorCode) => {
    maybeSingle.mockResolvedValueOnce({ data: call({ call_recordings: statuses }), error: null });
    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: errorCode });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the Jitter session scope before contacting Jitter", async () => {
    maybeSingle.mockResolvedValueOnce({ data: call({ jitter_session_id: null }), error: null });
    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error_code: "missing_jitter_identity" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the session-scoped Jitter route with the server-only bearer and passes JSON through", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      signedUrl: "https://storage.example.test/call.wav",
      expiresAt: "2026-08-23T14:00:00.000Z",
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://jitter.example.test/api/internal/sandra/recordings/attempt%2F1?scopeId=session+scope",
    );
    expect(init).toMatchObject({
      cache: "no-store",
      headers: { authorization: "Bearer playback-secret" },
      redirect: "error",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves Jitter pending and failed status envelopes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Recording pending", error_code: "recording_pending" }), {
        status: 409,
      }),
    );
    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Recording pending",
      error_code: "recording_pending",
    });
  });

  it("maps Jitter transport and invalid-JSON failures without caching", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const unavailable = await request();
    expect(unavailable.status).toBe(502);
    await expect(unavailable.json()).resolves.toMatchObject({ error_code: "jitter_unavailable" });

    fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 502 }));
    const invalid = await request();
    expect(invalid.status).toBe(502);
    await expect(invalid.json()).resolves.toMatchObject({ error_code: "invalid_jitter_response" });
    expect(invalid.headers.get("cache-control")).toBe("no-store");
  });

  it("bounds the Jitter request and maps a deadline abort to 504", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
    );
    const response = await request();

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error_code: "jitter_timeout" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not follow an upstream redirect that could receive the bearer token", async () => {
    fetchMock.mockImplementationOnce((_url: URL, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      throw new TypeError("redirect mode is set to error");
    });
    const response = await request();

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a timeout while consuming Jitter JSON to the same stable 504", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: vi.fn().mockRejectedValue(
        Object.assign(new Error("body timed out"), { name: "TimeoutError" }),
      ),
    } as unknown as Response);
    const response = await request();

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error_code: "jitter_timeout" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when server playback configuration is absent", async () => {
    vi.stubEnv("JITTER_SANDRA_PLAYBACK_TOKEN", "");
    const response = await request();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error_code: "playback_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to send the bearer token to a cleartext Jitter origin", async () => {
    vi.stubEnv("JITTER_API_BASE_URL", "http://jitter.example.test");
    const response = await request();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error_code: "playback_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
