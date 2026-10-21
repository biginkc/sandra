import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigurationError } from "@/lib/errors/classes";

import { DropCowboyVoicemailDropProvider, dropCowboyFromEnv } from "./providers/dropcowboy";
import {
  getMockVoicemailDropLog,
  MockVoicemailDropProvider,
  resetMockVoicemailDropState,
  setMockVoicemailDropResult,
} from "./providers/mock";
import { classifyReasonCode } from "./reason-codes";
import { getVoicemailDropProvider, isVoicemailDropEnabled } from "./registry";
import type { VoicemailDropSendInput } from "./types";

// Payloads below are written from the Drop Cowboy OpenAPI spec examples
// (AsyncResponse, AsyncError, SendBadRequest, SendMissingCredentials,
// SendQueueNoReceipt, ThrottleError, SendOutcome, DeliveryStatusData).

const SECRET = "whsec_test";
const NOW_MS = 1_790_000_000_000;

const ttsInput: VoicemailDropSendInput = {
  idempotencyKey: "step-run-123",
  to: "+13125550142",
  audio: { kind: "tts", ttsBody: "Hi Pat, this is Norma.", voiceId: "11111111-1111-4111-8111-111111111111" },
  phoneLineId: "22222222-2222-4222-8222-222222222222",
  foreignId: "33333333-3333-4333-8333-333333333333",
  callbackUrl: "https://example.test/api/webhooks/dropcowboy/rvm-callback/s3cret",
  mobileOnly: true,
  maxAttempts: 1,
  postalCode: "64111",
};

function respond(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function provider(fetchImpl: typeof fetch, timeoutMs?: number) {
  return new DropCowboyVoicemailDropProvider({
    apiKey: "key",
    apiSecret: "secret",
    webhookSecret: SECRET,
    fetchImpl,
    timeoutMs,
  });
}

describe("dropcowboy sendDrop", () => {
  it("posts to /rvm with auth, idempotency and the plan's body (tts)", async () => {
    const fetchImpl = respond(202, { message_id: "9b2f0c1e-0000-4000-8000-000000000001", status: "queued" });
    const result = await provider(fetchImpl as unknown as typeof fetch).sendDrop(ttsInput);

    expect(result).toMatchObject({ outcome: "accepted", httpStatus: 202, messageId: "9b2f0c1e-0000-4000-8000-000000000001" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api-v2.dropcowboy.com/rvm");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-key"]).toBe("key");
    expect(headers["x-secret"]).toBe("secret");
    expect(headers["Idempotency-Key"]).toBe("step-run-123");
    expect(JSON.parse(init.body as string)).toEqual({
      to: "+13125550142",
      phone_line_id: ttsInput.phoneLineId,
      foreign_id: ttsInput.foreignId,
      callback_url: ttsInput.callbackUrl,
      mobile_only: true,
      max_attempts: 1,
      postal_code: "64111",
      tts_body: "Hi Pat, this is Norma.",
      voice_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("sends media_id and no tts fields for a media drop", async () => {
    const fetchImpl = respond(202, { message_id: "m", status: "queued" });
    await provider(fetchImpl as unknown as typeof fetch).sendDrop({
      ...ttsInput,
      postalCode: null,
      audio: { kind: "media", mediaId: "44444444-4444-4444-8444-444444444444" },
    });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.media_id).toBe("44444444-4444-4444-8444-444444444444");
    expect(body).not.toHaveProperty("tts_body");
    expect(body).not.toHaveProperty("voice_id");
    expect(body).not.toHaveProperty("postal_code");
  });

  it.each([
    [429, { message: "Too Many Requests" }],
    [500, { status: "error" }],
  ])("%i → not_queued", async (status, body) => {
    const result = await provider(respond(status, body) as unknown as typeof fetch).sendDrop(ttsInput);
    expect(result).toMatchObject({ outcome: "not_queued", httpStatus: status });
  });

  it("502 SendQueueNoReceipt → unknown/no_receipt", async () => {
    const result = await provider(
      respond(502, {
        type: "https://api-v2.dropcowboy.com/errors/internal-error",
        title: "Bad Gateway",
        status: 502,
        detail: "The message was not queued. It is safe to retry.",
      }) as unknown as typeof fetch,
    ).sendDrop(ttsInput);
    expect(result).toMatchObject({ outcome: "unknown", httpStatus: 502, cause: "no_receipt" });
  });

  it("400 → bad_request with detail", async () => {
    const result = await provider(
      respond(400, {
        type: "https://api-v2.dropcowboy.com/errors/validation-error",
        title: "Validation Error",
        status: 400,
        detail: "The request body must be a non-empty JSON object.",
        details: [],
      }) as unknown as typeof fetch,
    ).sendDrop(ttsInput);
    expect(result).toMatchObject({
      outcome: "bad_request",
      detail: "The request body must be a non-empty JSON object.",
    });
  });

  it("401 → unauthorized", async () => {
    const result = await provider(
      respond(401, { title: "Unauthorized", status: 401, detail: "Send an API key in X-Key and X-Secret." }) as unknown as typeof fetch,
    ).sendDrop(ttsInput);
    expect(result).toMatchObject({ outcome: "unauthorized", httpStatus: 401 });
  });

  it("undocumented status → unknown/unexpected_status (never retried)", async () => {
    const result = await provider(respond(503, null) as unknown as typeof fetch).sendDrop(ttsInput);
    expect(result).toMatchObject({ outcome: "unknown", httpStatus: 503, cause: "unexpected_status" });
  });

  it("network error → unknown/network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await provider(fetchImpl as unknown as typeof fetch).sendDrop(ttsInput);
    expect(result).toMatchObject({ outcome: "unknown", httpStatus: null, cause: "network" });
  });

  it("timeout → unknown/timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const result = await provider(fetchImpl as unknown as typeof fetch, 10).sendDrop(ttsInput);
    expect(result).toMatchObject({ outcome: "unknown", cause: "timeout" });
  });
});

function sign(body: string, ts: string, secret = SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

describe("webhook signature", () => {
  const p = provider(vi.fn() as unknown as typeof fetch);
  const body = '{"event":"contact.rvm.status"}';
  const ts = String(NOW_MS / 1000);

  it("accepts a valid signature (Headers and plain object)", () => {
    expect(p.verifyWebhookSignature(body, new Headers({ "X-Signature": sign(body, ts), "X-Timestamp": ts }), NOW_MS)).toEqual({ valid: true });
    expect(p.verifyWebhookSignature(body, { "x-signature": sign(body, ts), "x-timestamp": ts }, NOW_MS)).toEqual({ valid: true });
  });

  it("rejects a tampered body, wrong secret, or missing headers", () => {
    expect(p.verifyWebhookSignature(body + " ", { "x-signature": sign(body, ts), "x-timestamp": ts }, NOW_MS)).toEqual({ valid: false, reason: "mismatch" });
    expect(p.verifyWebhookSignature(body, { "x-signature": sign(body, ts, "other"), "x-timestamp": ts }, NOW_MS)).toEqual({ valid: false, reason: "mismatch" });
    expect(p.verifyWebhookSignature(body, { "x-timestamp": ts }, NOW_MS)).toEqual({ valid: false, reason: "missing_headers" });
    expect(p.verifyWebhookSignature(body, { "x-signature": "v1=abc", "x-timestamp": ts }, NOW_MS)).toEqual({ valid: false, reason: "bad_format" });
  });

  it("rejects a stale timestamp (> 300s)", () => {
    const old = String(NOW_MS / 1000 - 301);
    expect(p.verifyWebhookSignature(body, { "x-signature": sign(body, old), "x-timestamp": old }, NOW_MS)).toEqual({ valid: false, reason: "stale" });
    const ok = String(NOW_MS / 1000 - 299);
    expect(p.verifyWebhookSignature(body, { "x-signature": sign(body, ok), "x-timestamp": ok }, NOW_MS)).toEqual({ valid: true });
  });
});

describe("parsers", () => {
  const p = provider(vi.fn() as unknown as typeof fetch);

  it("parses a SendOutcome callback with foreign_id and drop_id", () => {
    const ev = p.parseCallback(
      JSON.stringify({
        drop_id: "5f0c2a1b-1111-4222-8333-444455556666",
        team_id: "aaaaaaaa-0000-4000-8000-000000000000",
        phone_number: "+13125550142",
        product_code: "rvm",
        status: "success",
        reason: "",
        reason_code: 0,
        product_cost: 0.03,
        compliance_fee: 0.005,
        tts_fee: 0.01,
        attempt_date: "2026-10-20T15:00:00Z",
        foreign_id: ttsInput.foreignId,
        proof_of_delivery_url: "https://api-v2.dropcowboy.com/campaign/public/receipts/tok",
      }),
    );
    expect(ev).toMatchObject({
      kind: "callback",
      foreignId: ttsInput.foreignId,
      dropId: "5f0c2a1b-1111-4222-8333-444455556666",
      status: "success",
      reasonClass: "success",
      reason: null,
      proofUrl: "https://api-v2.dropcowboy.com/campaign/public/receipts/tok",
    });
    expect(ev.cost).toBeCloseTo(0.045);
  });

  it("parses the short pre-send failure callback", () => {
    const ev = p.parseCallback(
      JSON.stringify({ status: "failure", reason: "Script Too Long", reason_code: 3021, product_code: "rvm", phone_number: "+13125550142", foreign_id: "f" }),
    );
    expect(ev).toMatchObject({ dropId: null, status: "failure", reasonCode: 3021, reasonClass: "config", cost: null });
  });

  it("parses contact.rvm.status and contact.rvm.receipt", () => {
    const status = p.parseStatusWebhook(
      JSON.stringify({
        event_id: "e1e1e1e1-0000-4000-8000-000000000000",
        event: "contact.rvm.status",
        event_at: NOW_MS,
        data: {
          team_id: "aaaaaaaa-0000-4000-8000-000000000000",
          drop_id: "65a1f0c2b3d4e5f6a7b8c9d0",
          campaign_type: "rvm",
          status: "failure",
          reason: "VoiceMail Full",
          reason_code: 4002,
          to: "+13125550142",
          contact_id: null,
        },
      }),
    );
    expect(status).toMatchObject({ kind: "status", dropId: "65a1f0c2b3d4e5f6a7b8c9d0", reasonClass: "delivery", to: "+13125550142" });

    const receipt = p.parseStatusWebhook(
      JSON.stringify({
        event_id: "e2",
        event: "contact.rvm.receipt",
        event_at: NOW_MS,
        data: {
          team_id: "t",
          drop_id: "65a1f0c2b3d4e5f6a7b8c9d0",
          status: "success",
          reason_code: 0,
          proof_of_delivery_url: "https://x.test/r",
          receipt_ready_at: "2026-10-20T15:01:00Z",
        },
      }),
    );
    expect(receipt).toMatchObject({ kind: "receipt", proofUrl: "https://x.test/r", receiptReadyAt: "2026-10-20T15:01:00Z" });
  });

  it("rejects non-JSON, other events and missing event_id", () => {
    expect(() => p.parseStatusWebhook("nope")).toThrow();
    expect(() => p.parseStatusWebhook(JSON.stringify({ event_id: "e", event: "contact.sms.status", data: { status: "success" } }))).toThrow();
    expect(() => p.parseStatusWebhook(JSON.stringify({ event: "contact.rvm.status", data: { status: "success" } }))).toThrow();
    expect(() => p.parseCallback("[]")).toThrow();
    expect(() => p.parseCallback(JSON.stringify({ status: "maybe" }))).toThrow();
  });
});

describe("classifyReasonCode", () => {
  it.each([
    [0, "success", false],
    [3021, "config", false],
    [4010, "config", false],
    [4016, "consent", false],
    [6005, "consent", true],
    [6011, "consent", true],
    [4001, "delivery", false],
    [4002, "delivery", false],
    [4007, "delivery", false],
    [4013, "unclassified", false],
    [null, "unclassified", false],
  ] as const)("%s → %s", (code, cls, unverified) => {
    expect(classifyReasonCode(code)).toEqual({ reasonCode: code, reasonClass: cls, unverified });
  });
});

describe("registry", () => {
  it("unset → feature off", () => {
    expect(getVoicemailDropProvider({} as NodeJS.ProcessEnv)).toBeNull();
    expect(isVoicemailDropEnabled({ VOICEMAIL_DROP_PROVIDER: " " } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("selects dropcowboy and mock; rejects unknown", () => {
    const env = {
      VOICEMAIL_DROP_PROVIDER: "DropCowboy",
      DROPCOWBOY_API_KEY: "k",
      DROPCOWBOY_API_SECRET: "s",
      DROPCOWBOY_WEBHOOK_SECRET: "w",
    } as unknown as NodeJS.ProcessEnv;
    expect(getVoicemailDropProvider(env)?.id).toBe("dropcowboy");
    expect(isVoicemailDropEnabled(env)).toBe(true);
    expect(getVoicemailDropProvider({ VOICEMAIL_DROP_PROVIDER: "mock" } as unknown as NodeJS.ProcessEnv)?.id).toBe("mock");
    expect(() => getVoicemailDropProvider({ VOICEMAIL_DROP_PROVIDER: "voicedrop" } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });

  it("dropcowboy without credentials → ConfigurationError", () => {
    expect(() => dropCowboyFromEnv({ VOICEMAIL_DROP_PROVIDER: "dropcowboy" } as unknown as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });
});

describe("mock provider", () => {
  afterEach(() => resetMockVoicemailDropState());

  it("logs sends, defaults to accepted, and honours a forced result", async () => {
    const m = new MockVoicemailDropProvider();
    expect((await m.sendDrop(ttsInput)).outcome).toBe("accepted");
    setMockVoicemailDropResult({ outcome: "unknown", httpStatus: 502, cause: "no_receipt", raw: null });
    expect((await m.sendDrop(ttsInput)).outcome).toBe("unknown");
    expect(getMockVoicemailDropLog()).toHaveLength(2);
    expect(m.verifyWebhookSignature("", { "x-mock-signature": "valid" })).toEqual({ valid: true });
    expect(m.verifyWebhookSignature("", {}).valid).toBe(false);
  });
});
