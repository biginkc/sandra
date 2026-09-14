import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubSentryEvent } from "./sentry-privacy";

describe("scrubSentryEvent", () => {
  it("removes customer data and webhook secrets while preserving stack locations", () => {
    const event = {
      request: { url: "https://example.com/api/webhooks/secret-token", data: "phone=5551234567" },
      user: { email: "customer@example.com" },
      extra: { phone: "5551234567" },
      breadcrumbs: [{ message: "SMS body" }],
      message: "customer@example.com failed",
      transaction: "/api/webhooks/secret-token",
      tags: { surface: "handled", phone: "5551234567" },
      exception: { values: [{ value: "phone 5551234567", stacktrace: { frames: [{ filename: "src/lib/foo.ts", lineno: 42, vars: { phone: "5551234567" }, context_line: "secret-token" }] } }] },
    } as unknown as ErrorEvent;

    const scrubbed = scrubSentryEvent(event);
    expect(JSON.stringify(scrubbed)).not.toMatch(/5551234567|customer@example.com|secret-token|SMS body/);
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({ filename: "src/lib/foo.ts", lineno: 42 });
    expect(scrubbed.tags).toEqual({ surface: "handled", errorClass: "unknown" });
  });
});
