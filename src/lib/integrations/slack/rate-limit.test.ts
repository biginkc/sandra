import { ErrorCode, WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";

describe("Slack SDK rate-limit configuration", () => {
  it("rejects a real SDK 429 immediately with Retry-After metadata", async () => {
    const client = new WebClient("xoxb-test", {
      timeout: 5_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      adapter: async (config) => ({
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "600" },
        config,
        data: {},
      }),
    });
    const startedAt = Date.now();

    await expect(client.chat.unfurl({ channel: "C123", ts: "1.1", unfurls: {} })).rejects.toMatchObject({
      code: ErrorCode.RateLimitedError,
      retryAfter: 600,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
