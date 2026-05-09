import { describe, it, expect } from "vitest";

describe("slack/signature", () => {
  it.todo("verifySlackSignature accepts a valid HMAC over v0:{ts}:{body}");
  it.todo(
    "verifySlackSignature rejects when timestamp is missing or non-numeric",
  );
  it.todo(
    "verifySlackSignature rejects when timestamp is older than 5 minutes",
  );
  it.todo("verifySlackSignature rejects when signature is tampered");
  it.todo("verifySlackSignature uses timingSafeEqual to compare");
});
