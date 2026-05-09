import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "./signature";

function slackSignature(secret: string, timestamp: string, rawBody: string) {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

describe("slack/signature", () => {
  it("verifySlackSignature accepts a valid HMAC over v0:{ts}:{body}", () => {
    const timestamp = "1760000000";
    const rawBody = "payload=%7B%22type%22%3A%22block_actions%22%7D";

    expect(
      verifySlackSignature({
        signingSecret: "test-secret",
        timestamp,
        signature: slackSignature("test-secret", timestamp, rawBody),
        rawBody,
        now: 1760000000,
      }),
    ).toBe(true);
  });

  it("verifySlackSignature rejects when timestamp is missing or non-numeric", () => {
    const signature = slackSignature("test-secret", "1760000000", "body");

    expect(
      verifySlackSignature({
        signingSecret: "test-secret",
        timestamp: null,
        signature,
        rawBody: "body",
        now: 1760000000,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        signingSecret: "test-secret",
        timestamp: "not-a-number",
        signature,
        rawBody: "body",
        now: 1760000000,
      }),
    ).toBe(false);
  });

  it("verifySlackSignature rejects when timestamp is older than 5 minutes", () => {
    const timestamp = "1760000000";
    const rawBody = "body";

    expect(
      verifySlackSignature({
        signingSecret: "test-secret",
        timestamp,
        signature: slackSignature("test-secret", timestamp, rawBody),
        rawBody,
        now: 1760000301,
      }),
    ).toBe(false);
  });

  it("verifySlackSignature rejects when signature length differs", () => {
    expect(
      verifySlackSignature({
        signingSecret: "test-secret",
        timestamp: "1760000000",
        signature: "v0=short",
        rawBody: "body",
        now: 1760000000,
      }),
    ).toBe(false);
  });

  it("verifySlackSignature rejects when signature is tampered", () => {
    const timestamp = "1760000000";

    expect(
      verifySlackSignature({
        signingSecret: "test-secret",
        timestamp,
        signature: slackSignature("test-secret", timestamp, "body"),
        rawBody: "tampered-body",
        now: 1760000000,
      }),
    ).toBe(false);
  });
});
