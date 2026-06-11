import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, fromMock, createClientMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  fromMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import { GET, POST } from "./route";
import * as pathSecretRoute from "./[secret]/route";

describe("POST /api/webhooks/sendillo/capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("SENDILLO_CAPTURE_SECRET", "capture-secret");
    vi.stubEnv("SENDILLO_CAPTURE_ENABLED", "true");

    insertMock.mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ insert: insertMock });
    createClientMock.mockReturnValue({ from: fromMock });
  });

  it("returns 404 when capture is disabled", async () => {
    vi.stubEnv("SENDILLO_CAPTURE_ENABLED", "false");

    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(404);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns 503 when no capture secret is configured", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("SENDILLO_CAPTURE_ENABLED", "true");

    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture", {
        method: "POST",
        headers: { "x-sendillo-capture-secret": "anything" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(503);
  });

  it("returns 401 when the capture secret header is wrong", async () => {
    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture", {
        method: "POST",
        headers: { "x-sendillo-capture-secret": "wrong" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("lists recent captures when explicitly enabled and authorized", async () => {
    fromMock.mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  {
                    provider: "sendillo_capture",
                    event_type: "message.sent",
                    external_id: "msg_456",
                    signature_verified: false,
                    processing_status: "ignored",
                    received_at: "2026-06-08T15:00:00.000Z",
                    payload: { rawBody: "{\"event\":\"message.sent\"}" },
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    });

    const response = await GET(
      new Request("https://sandra.test/api/webhooks/sendillo/capture", {
        headers: { authorization: "Bearer capture-secret" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      events: [
        {
          provider: "sendillo_capture",
          event_type: "message.sent",
          external_id: "msg_456",
        },
      ],
    });
  });

  it("captures a parsed Sendillo payload into webhook_events", async () => {
    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sendillo-attempt": "1",
          "x-sendillo-capture-secret": "capture-secret",
        },
        body: JSON.stringify({
          event: "inbound.received",
          data: {
            messageId: "msg_123",
            from: "+18165550123",
            to: "+18165559876",
            body: "hello there",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith("webhook_events");
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "sendillo_capture",
      event_type: "inbound.received",
      external_id: "msg_123",
      signature_verified: false,
      processing_status: "ignored",
    });

    const insertedPayload = insertMock.mock.calls[0]?.[0]?.payload;
    expect(insertedPayload).toMatchObject({
      method: "POST",
      url: "https://sandra.test/api/webhooks/sendillo/capture",
      headers: {
        "content-type": "application/json",
        "x-sendillo-attempt": "1",
        "x-sendillo-capture-secret": "[redacted]",
      },
      rawBody: JSON.stringify({
        event: "inbound.received",
        data: {
          messageId: "msg_123",
          from: "+18165550123",
          to: "+18165559876",
          body: "hello there",
        },
      }),
      parsed: {
        event: "inbound.received",
        data: {
          messageId: "msg_123",
          from: "+18165550123",
          to: "+18165559876",
          body: "hello there",
        },
      },
    });
    expect(insertedPayload.headers.authorization).toBeUndefined();
  });

  it("accepts Sendillo capture credentials from the URL path segment", async () => {
    const response = await pathSecretRoute.POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture/capture-secret", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ event: "message.sent", messageId: "msg_path" }),
      }),
    );

    expect(response.status).toBe(200);
    const insertedPayload = insertMock.mock.calls[0]?.[0]?.payload;
    expect(insertedPayload.url).toBe(
      "https://sandra.test/api/webhooks/sendillo/capture/[redacted]",
    );
  });

  it("does not expose capture listing from the provider-facing path route", () => {
    expect("GET" in pathSecretRoute).toBe(false);
  });

  it("accepts the path credential even when an unrelated auth header is present", async () => {
    const response = await pathSecretRoute.POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture/capture-secret", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event: "message.sent", messageId: "msg_path_header" }),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects the wrong Sendillo capture path credential", async () => {
    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture/wrong", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("redacts auth-bearing headers before storing the capture", async () => {
    await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture?secret=nope", {
        method: "POST",
        headers: {
          authorization: "Bearer capture-secret",
          "x-sendillo-capture-secret": "capture-secret",
          "x-sendillo-webhook-secret": "sendillo-secret",
          "x-api-token": "abc123",
        },
        body: JSON.stringify({ event: "message.sent", messageId: "msg_redacted" }),
      }),
    );

    const insertedPayload = insertMock.mock.calls[0]?.[0]?.payload;
    expect(insertedPayload.url).toBe(
      "https://sandra.test/api/webhooks/sendillo/capture",
    );
    expect(insertedPayload.headers).toMatchObject({
      authorization: "[redacted]",
      "x-sendillo-capture-secret": "[redacted]",
      "x-sendillo-webhook-secret": "[redacted]",
      "x-api-token": "[redacted]",
    });
  });

  it("treats duplicate inserts as successful capture", async () => {
    insertMock.mockResolvedValueOnce({ error: { code: "23505" } });

    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture", {
        method: "POST",
        headers: { authorization: "Bearer capture-secret" },
        body: JSON.stringify({ event: "message.delivered", messageId: "msg_dup" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      eventType: "message.delivered",
      externalId: "msg_dup",
    });
  });
});
