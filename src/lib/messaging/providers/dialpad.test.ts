import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DialpadMessagingProvider } from "./dialpad";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function makeProvider(secret = "shh-test-secret") {
  return new DialpadMessagingProvider("fake-api-key", "+18165550000", secret);
}

/**
 * Mint a valid HS256 JWT for the given payload + secret. Dialpad
 * signs webhook deliveries this way and puts the full JWT string in
 * the request body.
 */
function mintJwt(payload: object, secret = "shh-test-secret"): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

describe("DialpadMessagingProvider.verifyWebhookSignature (JWT)", () => {
  it("accepts a correctly-signed JWT body", () => {
    const p = makeProvider();
    const jwt = mintJwt({ ok: true });
    expect(p.verifyWebhookSignature(jwt, new Headers())).toBe(true);
  });

  it("rejects a JWT whose payload was tampered after signing", () => {
    const p = makeProvider();
    const jwt = mintJwt({ ok: true });
    const [h, , sig] = jwt.split(".");
    const tampered = Buffer.from(JSON.stringify({ ok: false })).toString(
      "base64url",
    );
    const badJwt = `${h}.${tampered}.${sig}`;
    expect(p.verifyWebhookSignature(badJwt, new Headers())).toBe(false);
  });

  it("rejects a JWT signed with a different secret", () => {
    const p = makeProvider("real-secret");
    const jwt = mintJwt({ ok: true }, "wrong-secret");
    expect(p.verifyWebhookSignature(jwt, new Headers())).toBe(false);
  });

  it("rejects a malformed body (not three dot-separated segments)", () => {
    const p = makeProvider();
    expect(p.verifyWebhookSignature("just-a-string", new Headers())).toBe(
      false,
    );
    expect(p.verifyWebhookSignature("one.two", new Headers())).toBe(false);
  });

  it("rejects an empty body", () => {
    const p = makeProvider();
    expect(p.verifyWebhookSignature("", new Headers())).toBe(false);
  });
});

describe("DialpadMessagingProvider.sendSms", () => {
  it("passes an abort signal so cron drain cannot hang indefinitely", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ id: "dp-msg-1", status: "sent" }),
    } as unknown as Response);

    const p = makeProvider();
    await p.sendSms({ to: "+18165551234", body: "hello" });

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("DialpadMessagingProvider.parseInboundWebhook (JWT payloads)", () => {
  const p = makeProvider();

  it("accepts a single-event JWT payload", () => {
    const jwt = mintJwt({
      id: "msg_abc",
      from_number: "+18165551111",
      to_number: "+18165550000",
      text: "hi there",
      timestamp: "2026-04-21T10:00:00Z",
    });
    const events = p.parseInboundWebhook(jwt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "msg_abc",
      from: "+18165551111",
      to: "+18165550000",
      body: "hi there",
    });
    expect(events[0].receivedAt).toBeInstanceOf(Date);
  });

  it("preserves MMS media URLs when present", () => {
    const jwt = mintJwt({
      id: "m1",
      from_number: "+18165551111",
      to_number: "+18165550000",
      text: "photo attached",
      media_urls: ["https://dialpad.cdn/abc.jpg"],
    });
    const events = p.parseInboundWebhook(jwt);
    expect(events[0].mediaUrls).toEqual(["https://dialpad.cdn/abc.jpg"]);
  });

  it("accepts a wrapped {events: [...]} payload", () => {
    const jwt = mintJwt({
      events: [
        {
          id: "m1",
          from_number: "+18165551111",
          to_number: "+18165550000",
          text: "first",
        },
        {
          id: "m2",
          from_number: "+18165552222",
          to_number: "+18165550000",
          text: "second",
        },
      ],
    });
    const events = p.parseInboundWebhook(jwt);
    expect(events).toHaveLength(2);
    expect(events[0].externalId).toBe("m1");
    expect(events[1].externalId).toBe("m2");
  });

  it("throws when signature is invalid", () => {
    // Mint with wrong secret → verify fails inside parseInboundWebhook.
    const jwt = mintJwt({ id: "m1" }, "wrong-secret");
    expect(() => p.parseInboundWebhook(jwt)).toThrow(/signed JWT/i);
  });

  it("throws when required fields are missing from an otherwise-valid JWT", () => {
    const jwt = mintJwt({ text: "missing ids" });
    expect(() => p.parseInboundWebhook(jwt)).toThrow(/missing id/i);
  });
});
