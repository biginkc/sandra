import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";

import { TwilioMessagingProvider, twilioFromEnv } from "./twilio";
import { getMessagingProvider } from "../registry";

const ORIGINAL_FETCH = global.fetch;
const ACCOUNT_SID = "ACtestaccountsid000000000000000000";
const AUTH_TOKEN = "test-auth-token";
const MSG_SVC_SID = "MGtestmessagingservicesid00000000";
const FROM_NUMBER = "+18165550000";

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
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

/** Mint a valid X-Twilio-Signature for the given URL + form pairs. */
function signTwilio(
  authToken: string,
  fullUrl: string,
  form: Record<string, string>,
): string {
  let canonical = fullUrl;
  for (const k of Object.keys(form).sort()) canonical += k + form[k];
  return createHmac("sha1", authToken).update(canonical).digest("base64");
}

function makeProviderWithService(): TwilioMessagingProvider {
  return new TwilioMessagingProvider({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MSG_SVC_SID,
  });
}

function makeProviderWithFrom(): TwilioMessagingProvider {
  return new TwilioMessagingProvider({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fromNumber: FROM_NUMBER,
  });
}

// ---------------------------------------------------------------------------
// sendSms
// ---------------------------------------------------------------------------
describe("TwilioMessagingProvider.sendSms", () => {
  it("posts to /Accounts/{sid}/Messages.json with form-encoded body + basic auth", async () => {
    mockFetch({
      status: 201,
      body: { sid: "SMabc", status: "queued" },
    });
    const p = makeProviderWithService();
    await p.sendSms({ to: "+18165551234", body: "hello" });

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const expectedAuth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString(
      "base64",
    );
    expect(headers.Authorization).toBe(`Basic ${expectedAuth}`);
  });

  it("uses MessagingServiceSid when configured (preferred for 10DLC)", async () => {
    mockFetch({ status: 201, body: { sid: "SMabc", status: "queued" } });
    const p = makeProviderWithService();
    await p.sendSms({ to: "+18165551234", body: "hi" });
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const params = new URLSearchParams(init.body as string);
    expect(params.get("MessagingServiceSid")).toBe(MSG_SVC_SID);
    expect(params.get("From")).toBeNull();
    expect(params.get("To")).toBe("+18165551234");
    expect(params.get("Body")).toBe("hi");
  });

  it("falls back to From when only TWILIO_FROM_NUMBER is set", async () => {
    mockFetch({ status: 201, body: { sid: "SMabc", status: "queued" } });
    const p = makeProviderWithFrom();
    await p.sendSms({ to: "+18165551234", body: "hi" });
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const params = new URLSearchParams(init.body as string);
    expect(params.get("From")).toBe(FROM_NUMBER);
    expect(params.get("MessagingServiceSid")).toBeNull();
    expect(params.get("To")).toBe("+18165551234");
    expect(params.get("Body")).toBe("hi");
  });

  it("returns externalId / providerStatus / raw on success", async () => {
    mockFetch({
      status: 201,
      body: { sid: "SMabc123", status: "queued", price: null },
    });
    const p = makeProviderWithService();
    const result = await p.sendSms({ to: "+18165551234", body: "hi" });
    expect(result.externalId).toBe("SMabc123");
    expect(result.providerStatus).toBe("queued");
    expect(result.raw).toMatchObject({ sid: "SMabc123", status: "queued" });
  });

  it("throws ProviderError with status code on non-2xx", async () => {
    mockFetch({
      status: 400,
      body: { code: 21610, message: "Recipient unsubscribed" },
    });
    const p = makeProviderWithService();
    await expect(
      p.sendSms({ to: "+18165551234", body: "hi" }),
    ).rejects.toMatchObject({
      errorClass: "provider",
      provider: "twilio",
      details: expect.objectContaining({ status: 400 }),
    });
  });

  it("throws ProviderError when fetch itself throws (network)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNRESET"),
    );
    const p = makeProviderWithService();
    await expect(
      p.sendSms({ to: "+18165551234", body: "hi" }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError when 2xx response is missing sid", async () => {
    mockFetch({ status: 201, body: { status: "queued" } }); // no sid
    const p = makeProviderWithService();
    await expect(
      p.sendSms({ to: "+18165551234", body: "hi" }),
    ).rejects.toThrow(/sid/i);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------
describe("TwilioMessagingProvider.verifyWebhookSignature", () => {
  const fullUrl = "https://app.example.com/api/webhooks/twilio/sms";
  const form = {
    MessageSid: "SMabc",
    From: "+18165551111",
    To: FROM_NUMBER,
    Body: "hello",
  };
  const rawBody = new URLSearchParams(form).toString();

  it("returns true for a valid X-Twilio-Signature", () => {
    const sig = signTwilio(AUTH_TOKEN, fullUrl, form);
    const headers = new Headers({ "X-Twilio-Signature": sig });
    const p = makeProviderWithService();
    expect(p.verifyWebhookSignature(rawBody, headers, fullUrl)).toBe(true);
  });

  it("returns false when fullUrl doesn't match what Twilio signed", () => {
    const sig = signTwilio(AUTH_TOKEN, fullUrl, form);
    const headers = new Headers({ "X-Twilio-Signature": sig });
    const p = makeProviderWithService();
    expect(
      p.verifyWebhookSignature(
        rawBody,
        headers,
        "https://app.example.com/api/webhooks/twilio/different",
      ),
    ).toBe(false);
  });

  it("returns false when body is tampered after signing", () => {
    const sig = signTwilio(AUTH_TOKEN, fullUrl, form);
    const headers = new Headers({ "X-Twilio-Signature": sig });
    const tamperedForm = { ...form, Body: "tampered" };
    const tamperedBody = new URLSearchParams(tamperedForm).toString();
    const p = makeProviderWithService();
    expect(p.verifyWebhookSignature(tamperedBody, headers, fullUrl)).toBe(false);
  });

  it("returns false when X-Twilio-Signature header is missing", () => {
    const headers = new Headers();
    const p = makeProviderWithService();
    expect(p.verifyWebhookSignature(rawBody, headers, fullUrl)).toBe(false);
  });

  it("returns false when fullUrl is undefined (Twilio scheme requires it)", () => {
    const sig = signTwilio(AUTH_TOKEN, fullUrl, form);
    const headers = new Headers({ "X-Twilio-Signature": sig });
    const p = makeProviderWithService();
    expect(p.verifyWebhookSignature(rawBody, headers, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseInboundWebhook
// ---------------------------------------------------------------------------
describe("TwilioMessagingProvider.parseInboundWebhook", () => {
  it("extracts externalId / from / to / body from form-encoded body", () => {
    const body = new URLSearchParams({
      MessageSid: "SMabc",
      From: "+18165551111",
      To: FROM_NUMBER,
      Body: "hello there",
    }).toString();
    const p = makeProviderWithService();
    const events = p.parseInboundWebhook(body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "SMabc",
      from: "+18165551111",
      to: FROM_NUMBER,
      body: "hello there",
    });
    expect(events[0].receivedAt).toBeInstanceOf(Date);
  });

  it("extracts mediaUrls from MediaUrl0..N when NumMedia > 0", () => {
    const body = new URLSearchParams({
      MessageSid: "SMabc",
      From: "+18165551111",
      To: FROM_NUMBER,
      Body: "photo",
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/.../Media/MEa",
      MediaUrl1: "https://api.twilio.com/.../Media/MEb",
    }).toString();
    const p = makeProviderWithService();
    const events = p.parseInboundWebhook(body);
    expect(events[0].mediaUrls).toEqual([
      "https://api.twilio.com/.../Media/MEa",
      "https://api.twilio.com/.../Media/MEb",
    ]);
  });

  it("throws ProviderError when required field is missing", () => {
    const body = new URLSearchParams({
      MessageSid: "SMabc",
      // From missing
      To: FROM_NUMBER,
      Body: "hi",
    }).toString();
    const p = makeProviderWithService();
    expect(() => p.parseInboundWebhook(body)).toThrow(ProviderError);
  });
});

// ---------------------------------------------------------------------------
// twilioFromEnv + registry
// ---------------------------------------------------------------------------
describe("twilioFromEnv", () => {
  const ENV_KEYS = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_MESSAGING_SERVICE_SID",
    "TWILIO_FROM_NUMBER",
    "MESSAGING_PROVIDER",
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("throws ConfigurationError when ACCOUNT_SID + AUTH_TOKEN are missing", () => {
    expect(() => twilioFromEnv()).toThrow(ConfigurationError);
  });

  it("throws ConfigurationError when neither MESSAGING_SERVICE_SID nor FROM_NUMBER is set", () => {
    process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    expect(() => twilioFromEnv()).toThrow(ConfigurationError);
  });

  it("registry returns TwilioMessagingProvider when MESSAGING_PROVIDER=twilio", async () => {
    process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.TWILIO_MESSAGING_SERVICE_SID = MSG_SVC_SID;
    process.env.MESSAGING_PROVIDER = "twilio";
    const p = await getMessagingProvider();
    expect(p).toBeInstanceOf(TwilioMessagingProvider);
    expect(p?.providerId).toBe("twilio");
  });
});
