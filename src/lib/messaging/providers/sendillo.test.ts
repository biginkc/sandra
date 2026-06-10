import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";

import { getMessagingProvider, getWebhookProvider } from "../registry";
import { MockMessagingProvider } from "./mock";
import {
  SendilloMessagingProvider,
  sendilloFromEnv,
} from "./sendillo";

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = {
  MESSAGING_PROVIDER: process.env.MESSAGING_PROVIDER,
  SENDILLO_API_KEY: process.env.SENDILLO_API_KEY,
  SENDILLO_FROM_NUMBER: process.env.SENDILLO_FROM_NUMBER,
  SENDILLO_WEBHOOK_SECRET: process.env.SENDILLO_WEBHOOK_SECRET,
};

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  process.env.MESSAGING_PROVIDER = ORIGINAL_ENV.MESSAGING_PROVIDER;
  process.env.SENDILLO_API_KEY = ORIGINAL_ENV.SENDILLO_API_KEY;
  process.env.SENDILLO_FROM_NUMBER = ORIGINAL_ENV.SENDILLO_FROM_NUMBER;
  process.env.SENDILLO_WEBHOOK_SECRET = ORIGINAL_ENV.SENDILLO_WEBHOOK_SECRET;
});

function mockFetch(response: { status: number; body: unknown }) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(response.body),
    json: async () => response.body,
  } as unknown as Response);
}

describe("SendilloMessagingProvider.sendSms", () => {
  it("posts JSON to the official /api/v1/messages endpoint with bearer auth", async () => {
    mockFetch({
      status: 200,
      body: { data: { messageId: "snd_123", status: "sent" } },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await provider.sendSms({ to: "+18165551234", body: "hello there" });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://www.sendillo.com/api/v1/messages");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sendillo-test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      from: "+18165550000",
      to: "+18165551234",
      body: "hello there",
    });
  });

  it("returns messageId and status from the documented response envelope", async () => {
    mockFetch({
      status: 200,
      body: { data: { messageId: "snd_456", status: "queued" } },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const result = await provider.sendSms({
      to: "+18165551234",
      body: "hello there",
    });

    expect(result).toMatchObject({
      externalId: "snd_456",
      providerStatus: "queued",
      raw: { data: { messageId: "snd_456", status: "queued" } },
    });
  });

  it("throws ProviderError on non-2xx responses", async () => {
    mockFetch({
      status: 422,
      body: { error: { message: "invalid to number" } },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(
      provider.sendSms({ to: "+18165551234", body: "hello there" }),
    ).rejects.toMatchObject({
      errorClass: "provider",
      provider: "sendillo",
      details: expect.objectContaining({ status: 422 }),
    });
  });

  it("throws when a success response has no message id", async () => {
    mockFetch({ status: 200, body: { data: { status: "queued" } } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(
      provider.sendSms({ to: "+18165551234", body: "hello there" }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("SendilloMessagingProvider inbound contract", () => {
  it("keeps webhook verification gated until a shared secret is configured", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    expect(
      provider.verifyWebhookSignature("{}", new Headers(), "https://example.test"),
    ).toBe(false);
  });

  it("rejects webhook URL query secrets even when the shared secret is configured", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
      "sendillo-secret",
    );

    expect(
      provider.verifyWebhookSignature(
        "{}",
        new Headers(),
        "https://example.test/api/webhooks/sendillo/sms?secret=sendillo-secret",
      ),
    ).toBe(false);
  });

  it("accepts a configured shared secret from a header", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
      "sendillo-secret",
    );
    const headers = new Headers({
      authorization: "Bearer sendillo-secret",
    });

    expect(
      provider.verifyWebhookSignature("{}", headers, "https://example.test"),
    ).toBe(true);
  });

  it("parses inbound.received JSON payloads into the shared inbound shape", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const events = provider.parseInboundWebhook(
      JSON.stringify({
        event: "inbound.received",
        data: {
          messageId: "snd_in_123",
          from: "+18165551234",
          to: "+18165550000",
          body: "hello inbound",
          receivedAt: "2026-06-08T12:00:00Z",
          mediaUrls: ["https://cdn.sendillo.test/mms.jpg"],
        },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "snd_in_123",
      from: "+18165551234",
      to: "+18165550000",
      body: "hello inbound",
      mediaUrls: ["https://cdn.sendillo.test/mms.jpg"],
    });
    expect(events[0].receivedAt).toBeInstanceOf(Date);
  });

  it("ignores non-inbound events from the webhook stream", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const events = provider.parseInboundWebhook(
      JSON.stringify({
        event: "message.delivered",
        data: {
          messageId: "snd_status_123",
          from: "+18165550000",
          to: "+18165551234",
          body: "status only",
        },
      }),
    );

    expect(events).toEqual([]);
  });
});

describe("sendilloFromEnv / registry", () => {
  it("requires both SENDILLO_API_KEY and SENDILLO_FROM_NUMBER", () => {
    delete process.env.SENDILLO_API_KEY;
    delete process.env.SENDILLO_FROM_NUMBER;

    expect(() => sendilloFromEnv()).toThrow(ConfigurationError);
  });

  it("registry resolves sendillo when configured", () => {
    process.env.MESSAGING_PROVIDER = "sendillo";
    process.env.SENDILLO_API_KEY = "sendillo-test-key";
    process.env.SENDILLO_FROM_NUMBER = "+18165550000";

    const provider = getMessagingProvider();

    expect(provider).toBeInstanceOf(SendilloMessagingProvider);
    expect(provider?.providerId).toBe("sendillo");
  });

  it("webhook provider resolution keeps mock isolated for route tests", () => {
    process.env.MESSAGING_PROVIDER = "mock";

    const provider = getWebhookProvider("sendillo");

    expect(provider).toBeInstanceOf(MockMessagingProvider);
    expect(provider?.providerId).toBe("mock");
  });

  it("webhook provider resolution does not require MESSAGING_PROVIDER when sendillo creds exist", () => {
    delete process.env.MESSAGING_PROVIDER;
    process.env.SENDILLO_API_KEY = "sendillo-test-key";
    process.env.SENDILLO_FROM_NUMBER = "+18165550000";

    const provider = getWebhookProvider("sendillo");

    expect(provider).toBeInstanceOf(SendilloMessagingProvider);
    expect(provider?.providerId).toBe("sendillo");
  });
});
