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

  // Codex round 12 (finding 1): a 2xx with no reconcilable id is "accepted
  // without a provable receipt" — the SAME uncertainty class as a
  // transport failure or abort, flagged `acceptedWithoutId` so callers
  // route it to `aborted_ambiguous`, never the confirmed-non-delivery
  // `provider_error`.
  it("throws with details.acceptedWithoutId when a success response has no message id", async () => {
    mockFetch({ status: 200, body: { data: { status: "queued" } } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(
      provider.sendSms({ to: "+18165551234", body: "hello there" }),
    ).rejects.toMatchObject({
      errorClass: "provider",
      provider: "sendillo",
      details: expect.objectContaining({ acceptedWithoutId: true }),
    });
  });

  // Codex round 9 (finding 1): the internal DEFAULT_SEND_TIMEOUT_MS timer
  // aborts the SAME controller as an external opts.signal — no caller
  // signal is passed at all here, so this proves the internal timer alone
  // produces a ProviderError with abort provenance preserved.
  it("marks details.isAbort on the thrown ProviderError when its own internal send timeout fires (no external signal)", async () => {
    vi.useFakeTimers();
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("This operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
    );
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const pending = provider.sendSms({ to: "+18165551234", body: "hello there" });
    const assertion = expect(pending).rejects.toMatchObject({
      errorClass: "provider",
      provider: "sendillo",
      details: expect.objectContaining({ isAbort: true }),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  // Codex round 12 (finding 1): a non-abort `fetch()` rejection is a raw
  // transport failure with no HTTP response ever received — it proves
  // NOTHING about whether Sendillo received the request before the
  // connection dropped, so it's flagged `transportFailure` (never
  // `isAbort`) so callers (rep-sms.ts) route it to the same
  // never-retryable `aborted_ambiguous` outcome as an actual abort,
  // instead of the confirmed-non-delivery `provider_error`.
  it("does not mark details.isAbort, but DOES mark details.transportFailure, for an ordinary (non-abort) network failure — connection reset mid-flight", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("getaddrinfo ENOTFOUND www.sendillo.com"),
    );
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(
      provider.sendSms({ to: "+18165551234", body: "hello there" }),
    ).rejects.toMatchObject({
      errorClass: "provider",
      provider: "sendillo",
      details: { transportFailure: true },
    });
  });

  // Codex round 10 (finding 4): a signal that's ALREADY aborted before
  // sendSms is even called is a stronger, PROVABLE non-delivery — no fetch
  // should ever be issued for it, unlike a mid-flight abort (round 9 tests
  // above), which can't rule out the request having already reached
  // Sendillo.
  describe("Codex round 10 (finding 4): pre-aborted signal — checked before the fetch is ever issued", () => {
    it("throws immediately with details.notSent, and never calls fetch, when the signal is already aborted", async () => {
      const provider = new SendilloMessagingProvider(
        "sendillo-test-key",
        "+18165550000",
      );
      const controller = new AbortController();
      controller.abort();

      await expect(
        provider.sendSms(
          { to: "+18165551234", body: "hello there" },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({
        errorClass: "provider",
        provider: "sendillo",
        details: expect.objectContaining({ isAbort: true, notSent: true }),
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("closes the recheck race: a signal that flips to aborted between the initial check and attaching the listener still prevents the fetch", async () => {
      const provider = new SendilloMessagingProvider(
        "sendillo-test-key",
        "+18165550000",
      );
      let reads = 0;
      // false on the FIRST read (the pre-fetch check), true from the SECOND
      // read onward (the recheck right after the abort listener is
      // attached) — simulates the signal aborting in the narrow gap
      // between the two checks, which the recheck exists to close.
      const signal = {
        get aborted() {
          reads += 1;
          return reads > 1;
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as AbortSignal;

      await expect(
        provider.sendSms({ to: "+18165551234", body: "hello there" }, { signal }),
      ).rejects.toMatchObject({
        errorClass: "provider",
        provider: "sendillo",
        details: expect.objectContaining({ isAbort: true, notSent: true }),
      });
      expect(global.fetch).not.toHaveBeenCalled();
      // The listener was attached (and torn back down) even though the
      // recheck fired before any fetch — the attach/detach pairing must
      // stay balanced.
      expect(signal.addEventListener).toHaveBeenCalledTimes(1);
      expect(signal.removeEventListener).toHaveBeenCalledTimes(1);
    });

    it("a signal that's still live at both checks proceeds to fetch normally", async () => {
      mockFetch({
        status: 200,
        body: { data: { messageId: "snd_live", status: "sent" } },
      });
      const provider = new SendilloMessagingProvider(
        "sendillo-test-key",
        "+18165550000",
      );
      const controller = new AbortController();

      const result = await provider.sendSms(
        { to: "+18165551234", body: "hello there" },
        { signal: controller.signal },
      );

      expect(result.externalId).toBe("snd_live");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
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

  it("accepts the configured shared secret from Sendillo's target URL query", () => {
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
    ).toBe(true);
  });

  it("rejects the wrong Sendillo target URL query secret", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
      "sendillo-secret",
    );

    expect(
      provider.verifyWebhookSignature(
        "{}",
        new Headers(),
        "https://example.test/api/webhooks/sendillo/sms?secret=wrong",
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

  it("rejects the wrong Sendillo header secret", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
      "sendillo-secret",
    );
    const headers = new Headers({
      "x-sendillo-webhook-secret": "wrong",
    });

    expect(
      provider.verifyWebhookSignature("{}", headers, "https://example.test"),
    ).toBe(false);
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

describe("SendilloMessagingProvider status contract", () => {
  it("parses message.sent into the shared status shape", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const events = provider.parseStatusWebhook!(
      JSON.stringify({
        event: "message.sent",
        data: {
          messageId: "snd_status_sent_001",
          sentAt: "2026-06-10T16:54:00.000Z",
        },
      }),
    );

    expect(events).toEqual([
      {
        kind: "sent",
        externalId: "snd_status_sent_001",
        timestamp: new Date("2026-06-10T16:54:00.000Z"),
      },
    ]);
  });

  it("parses message.delivered into the shared status shape", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const events = provider.parseStatusWebhook!(
      JSON.stringify({
        event: "message.delivered",
        data: {
          messageId: "snd_status_delivered_001",
          deliveredAt: "2026-06-10T16:55:54.627Z",
        },
      }),
    );

    expect(events).toEqual([
      {
        kind: "delivered",
        externalId: "snd_status_delivered_001",
        timestamp: new Date("2026-06-10T16:55:54.627Z"),
      },
    ]);
  });

  it("parses message.failed and carries forward provider error text", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const events = provider.parseStatusWebhook!(
      JSON.stringify({
        event: "message.failed",
        data: {
          messageId: "snd_status_failed_001",
          failedAt: "2026-06-10T16:56:30.000Z",
          error: "carrier rejected recipient",
        },
      }),
    );

    expect(events).toEqual([
      {
        kind: "failed",
        externalId: "snd_status_failed_001",
        timestamp: new Date("2026-06-10T16:56:30.000Z"),
        errorMessage: "carrier rejected recipient",
      },
    ]);
  });

  it("ignores unknown status events", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const events = provider.parseStatusWebhook!(
      JSON.stringify({
        event: "message.queued",
        data: {
          messageId: "snd_status_queued_001",
        },
      }),
    );

    expect(events).toEqual([]);
  });

  it("rejects status events when the provider timestamp is missing", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    expect(() =>
      provider.parseStatusWebhook!(
        JSON.stringify({
          event: "message.delivered",
          data: {
            messageId: "snd_status_missing_timestamp_001",
          },
        }),
      ),
    ).toThrow(/missing deliveredAt\/sentAt\/createdAt/i);
  });

  it("rejects status events when the provider timestamp is invalid", () => {
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    expect(() =>
      provider.parseStatusWebhook!(
        JSON.stringify({
          event: "message.failed",
          data: {
            messageId: "snd_status_invalid_timestamp_001",
            failedAt: "not-a-date",
          },
        }),
      ),
    ).toThrow(/invalid timestamp/i);
  });
});

describe("SendilloMessagingProvider.listPurchasedNumbers", () => {
  it("GETs the purchased-numbers endpoint with bearer auth", async () => {
    mockFetch({ status: 200, body: { data: [] } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await provider.listPurchasedNumbers();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://www.sendillo.com/api/v1/numbers/purchased");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sendillo-test-key",
      Accept: "application/json",
    });
  });

  it("parses a {data:[...]} envelope and maps number fields", async () => {
    mockFetch({
      status: 200,
      body: {
        data: [
          {
            id: "num_1",
            phoneNumber: "+18165550001",
            status: "active",
            messagingStatus: "ready",
          },
          {
            numberId: "num_2",
            phone_number: "+18165550002",
            status: "active",
            messaging_status: "pending",
          },
        ],
      },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const numbers = await provider.listPurchasedNumbers();

    expect(numbers).toHaveLength(2);
    expect(numbers[0]).toMatchObject({
      phoneE164: "+18165550001",
      providerNumberId: "num_1",
      status: "active",
      messagingStatus: "ready",
    });
    expect(numbers[1]).toMatchObject({
      phoneE164: "+18165550002",
      providerNumberId: "num_2",
      messagingStatus: "pending",
    });
    // Raw entries preserved for the catalog audit column.
    expect(numbers[0].raw).toMatchObject({ id: "num_1" });
  });

  it("parses a top-level array and accepts number/phone field aliases", async () => {
    mockFetch({
      status: 200,
      body: [
        { number: "+18165550003", status: "active" },
        { phone: "+18165550004" },
      ],
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const numbers = await provider.listPurchasedNumbers();

    expect(numbers.map((n) => n.phoneE164)).toEqual([
      "+18165550003",
      "+18165550004",
    ]);
    expect(numbers[1].providerNumberId).toBeNull();
    expect(numbers[1].status).toBeNull();
  });

  it("skips entries without any recognizable phone number field", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({
      status: 200,
      body: {
        items: [
          { id: "num_missing_phone", status: "active" },
          { phoneNumber: "+18165550005" },
        ],
      },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const numbers = await provider.listPurchasedNumbers();

    expect(numbers).toHaveLength(1);
    expect(numbers[0].phoneE164).toBe("+18165550005");
    expect(errorSpy).toHaveBeenCalledWith(
      "[reportError]",
      expect.objectContaining({
        tags: { surface: "sendillo_catalog_parse" },
        extra: expect.objectContaining({
          label: "purchased numbers",
          providerEntryId: "num_missing_phone",
          reason: "missing phone",
        }),
      }),
    );
  });

  it("throws ProviderError including the status on non-OK responses", async () => {
    mockFetch({
      status: 503,
      body: { error: { message: "upstream unavailable" } },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(provider.listPurchasedNumbers()).rejects.toMatchObject({
      errorClass: "provider",
      provider: "sendillo",
      message: expect.stringContaining("503"),
      details: expect.objectContaining({ status: 503 }),
    });
  });

  it("throws ProviderError when the response is not a list in any known envelope", async () => {
    mockFetch({ status: 200, body: { data: { unexpected: true } } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(provider.listPurchasedNumbers()).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe("SendilloMessagingProvider.listFromNumbers", () => {
  it("maps the purchased-numbers catalog into DialpadFromOption shape for the composer", async () => {
    mockFetch({
      status: 200,
      body: {
        data: [
          { id: "num_1", phoneNumber: "+18165550001", status: "active" },
          { id: "num_2", phoneNumber: "+18165550002", status: "inactive" },
        ],
      },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const options = await provider.listFromNumbers();

    expect(options).toEqual([
      {
        number: "+18165550001",
        ownerName: "Sendillo",
        ownerType: "sendillo",
        status: "active",
      },
      {
        number: "+18165550002",
        ownerName: "Sendillo",
        ownerType: "sendillo",
        status: "inactive",
      },
    ]);
  });

  it("falls back to a non-'available' status when the provider omits one, so the composer's Dialpad-only unassigned filter never hides a real Sendillo number", async () => {
    mockFetch({
      status: 200,
      body: { data: [{ number: "+18165550003" }] },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const options = await provider.listFromNumbers();

    expect(options).toHaveLength(1);
    expect(options[0].status).not.toBe("available");
  });

  it("propagates the underlying ProviderError when the catalog fetch fails", async () => {
    mockFetch({ status: 503, body: { error: { message: "down" } } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(provider.listFromNumbers()).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("returns an empty list rather than throwing when the account has no purchased numbers", async () => {
    mockFetch({ status: 200, body: { data: [] } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(provider.listFromNumbers()).resolves.toEqual([]);
  });
});

describe("SendilloMessagingProvider.listProviderCampaigns", () => {
  it("GETs the campaigns endpoint with bearer auth", async () => {
    mockFetch({ status: 200, body: { data: [] } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await provider.listProviderCampaigns();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://www.sendillo.com/api/v1/campaigns");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sendillo-test-key",
    });
  });

  it("parses a {data:[...]} envelope and maps campaign fields", async () => {
    mockFetch({
      status: 200,
      body: {
        data: [
          {
            id: "camp_1",
            name: "10DLC Main",
            brand: "BMH",
            useCase: "low_volume",
            status: "active",
          },
          {
            campaignId: "camp_2",
            title: "Titled Campaign",
            brandName: "Brand Two",
            use_case: "marketing",
          },
        ],
      },
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const campaigns = await provider.listProviderCampaigns();

    expect(campaigns).toHaveLength(2);
    expect(campaigns[0]).toMatchObject({
      externalId: "camp_1",
      name: "10DLC Main",
      brand: "BMH",
      useCase: "low_volume",
      status: "active",
    });
    expect(campaigns[1]).toMatchObject({
      externalId: "camp_2",
      name: "Titled Campaign",
      brand: "Brand Two",
      useCase: "marketing",
      status: null,
    });
  });

  it("parses a top-level array and skips entries without an id", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({
      status: 200,
      body: [
        { name: "No Id Campaign" },
        { id: "camp_3", name: "Has Id" },
      ],
    });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    const campaigns = await provider.listProviderCampaigns();

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].externalId).toBe("camp_3");
    expect(errorSpy).toHaveBeenCalledWith(
      "[reportError]",
      expect.objectContaining({
        tags: { surface: "sendillo_catalog_parse" },
        extra: expect.objectContaining({
          label: "campaigns",
          providerEntryId: null,
          reason: "missing id",
        }),
      }),
    );
  });

  it("throws ProviderError including the status on non-OK responses", async () => {
    mockFetch({ status: 401, body: { message: "bad key" } });
    const provider = new SendilloMessagingProvider(
      "sendillo-test-key",
      "+18165550000",
    );

    await expect(provider.listProviderCampaigns()).rejects.toMatchObject({
      errorClass: "provider",
      provider: "sendillo",
      message: expect.stringContaining("401"),
      details: expect.objectContaining({ status: 401 }),
    });
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
