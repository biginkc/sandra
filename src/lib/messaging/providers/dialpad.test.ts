import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DialpadMessagingProvider } from "./dialpad";

function makeProvider(secret = "shh-test-secret") {
  return new DialpadMessagingProvider("fake-api-key", "+18165550000", secret);
}

function sign(body: string, secret = "shh-test-secret"): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("DialpadMessagingProvider.verifyWebhookSignature", () => {
  it("accepts a correctly-signed body", () => {
    const p = makeProvider();
    const body = '{"ok": true}';
    const headers = new Headers({ "x-dialpad-signature": sign(body) });
    expect(p.verifyWebhookSignature(body, headers)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const p = makeProvider();
    const body = '{"ok": true}';
    const sig = sign(body);
    const tamperedBody = '{"ok": false}';
    const headers = new Headers({ "x-dialpad-signature": sig });
    expect(p.verifyWebhookSignature(tamperedBody, headers)).toBe(false);
  });

  it("rejects a missing header", () => {
    const p = makeProvider();
    expect(p.verifyWebhookSignature("{}", new Headers())).toBe(false);
  });

  it("rejects a signature signed with a different secret", () => {
    const p = makeProvider("real-secret");
    const body = "{}";
    const headers = new Headers({
      "x-dialpad-signature": sign(body, "wrong-secret"),
    });
    expect(p.verifyWebhookSignature(body, headers)).toBe(false);
  });

  it("rejects a signature of different length (before comparing bytes)", () => {
    const p = makeProvider();
    const body = "{}";
    const headers = new Headers({ "x-dialpad-signature": "too-short" });
    expect(p.verifyWebhookSignature(body, headers)).toBe(false);
  });
});

describe("DialpadMessagingProvider.parseInboundWebhook", () => {
  const p = makeProvider();

  it("accepts a single-event object shape", () => {
    const raw = JSON.stringify({
      id: "msg_abc",
      from_number: "+18165551111",
      to_number: "+18165550000",
      text: "hi there",
      timestamp: "2026-04-21T10:00:00Z",
    });
    const events = p.parseInboundWebhook(raw);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "msg_abc",
      from: "+18165551111",
      to: "+18165550000",
      body: "hi there",
    });
    expect(events[0].receivedAt).toBeInstanceOf(Date);
  });

  it("accepts a wrapped {events: [...]} shape", () => {
    const raw = JSON.stringify({
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
    const events = p.parseInboundWebhook(raw);
    expect(events).toHaveLength(2);
    expect(events[0].externalId).toBe("m1");
    expect(events[1].externalId).toBe("m2");
  });

  it("accepts a bare array shape", () => {
    const raw = JSON.stringify([
      {
        id: "m1",
        from_number: "+18165551111",
        to_number: "+18165550000",
        text: "solo",
      },
    ]);
    const events = p.parseInboundWebhook(raw);
    expect(events).toHaveLength(1);
  });

  it("preserves MMS media URLs when present", () => {
    const raw = JSON.stringify({
      id: "m1",
      from_number: "+18165551111",
      to_number: "+18165550000",
      text: "photo attached",
      media_urls: ["https://dialpad.cdn/abc.jpg"],
    });
    const events = p.parseInboundWebhook(raw);
    expect(events[0].mediaUrls).toEqual(["https://dialpad.cdn/abc.jpg"]);
  });

  it("throws on malformed JSON", () => {
    expect(() => p.parseInboundWebhook("not json")).toThrow(/not valid JSON/i);
  });

  it("throws when required fields are missing", () => {
    const raw = JSON.stringify({ text: "missing ids" });
    expect(() => p.parseInboundWebhook(raw)).toThrow(/missing id/i);
  });
});
