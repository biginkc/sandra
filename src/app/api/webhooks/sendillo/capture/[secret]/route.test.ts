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

describe("POST /api/webhooks/sendillo/capture/[secret]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("SENDILLO_CAPTURE_SECRET", "capture-secret");

    insertMock.mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ insert: insertMock });
    createClientMock.mockReturnValue({ from: fromMock });
  });

  it("returns 503 when no capture secret is configured", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");

    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture/anything", {
        method: "POST",
        body: "{}",
      }),
      { params: Promise.resolve({ secret: "anything" }) },
    );

    expect(response.status).toBe(503);
  });

  it("returns 401 when the secret path segment is wrong", async () => {
    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture/wrong", {
        method: "POST",
        body: "{}",
      }),
      { params: Promise.resolve({ secret: "wrong" }) },
    );

    expect(response.status).toBe(401);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("lists recent captures for the deployment-local database", async () => {
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
      new Request("https://sandra.test/api/webhooks/sendillo/capture/capture-secret"),
      { params: Promise.resolve({ secret: "capture-secret" }) },
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
      new Request("https://sandra.test/api/webhooks/sendillo/capture/capture-secret", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sendillo-attempt": "1",
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
      { params: Promise.resolve({ secret: "capture-secret" }) },
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
  });

  it("treats duplicate inserts as successful capture", async () => {
    insertMock.mockResolvedValueOnce({ error: { code: "23505" } });

    const response = await POST(
      new Request("https://sandra.test/api/webhooks/sendillo/capture/capture-secret", {
        method: "POST",
        body: JSON.stringify({ event: "message.delivered", messageId: "msg_dup" }),
      }),
      { params: Promise.resolve({ secret: "capture-secret" }) },
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
