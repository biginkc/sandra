import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubSentryEvent } from "./sentry-privacy";

describe("scrubSentryEvent", () => {
  it("groups state anomalies by safe signal and outcome without retaining entity fingerprints", () => {
    const event = {
      type: "error",
      fingerprint: ["private-job-123"],
      tags: { kind: "state", operation: "skiptrace_submission_unknown", outcome: "active", sourceId: "private-job-123" },
      exception: { values: [{ value: "private-job-123" }] },
    } as unknown as ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.fingerprint).toEqual(["sandra-state", "skiptrace_submission_unknown", "active"]);
    expect(JSON.stringify(scrubbed)).not.toContain("private-job-123");
  });
  it("keeps only safe sourcemap debug IDs and rewritten server frames", () => {
    const event = {
      type: "error",
      sdk: { name: "sentry.javascript.nextjs", version: "10.74.0", integrations: ["secret@customer.test"] },
      debug_meta: { images: [
        { type: "sourcemap", debug_id: "12345678-1234-1234-1234-123456789abc", code_file: "app:///_next/server/chunks/ssr/app.js" },
        { type: "sourcemap", debug_id: "87654321-1234-1234-1234-123456789abc", code_file: "https://evil.test/private.js" },
      ] },
      tags: { surface: "server_render" },
      exception: { values: [{ stacktrace: { frames: [{ filename: "app:///_next/server/chunks/ssr/app.js", lineno: 41 }] } }] },
    } as unknown as ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.debug_meta?.images).toEqual([{ type: "sourcemap", debug_id: "12345678-1234-1234-1234-123456789abc", code_file: "app:///_next/server/chunks/ssr/app.js" }]);
    expect(scrubbed.sdk).toEqual({ name: "sentry.javascript.nextjs", version: "10.74.0" });
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe("app:///_next/server/chunks/ssr/app.js");
    expect(JSON.stringify(scrubbed)).not.toContain("secret@customer.test");
  });
  it("separates synthetic operations while excluding caller fingerprints", () => {
    const event = { type: "error", fingerprint: ["private-id"], tags: { surface: "client", operation: "inbox_sync", kind: "invalid_wire" } } as unknown as ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.fingerprint).toEqual(["sandra-diagnostic", "client", "inbox_sync", "invalid_wire", "unclassified"]);
    expect(JSON.stringify(scrubbed)).not.toContain("private-id");
  });
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

  it("retains bounded diagnostic tags, release and static frames while excluding alternate leak fields", () => {
    const event = {
      release: "sandra@abc123",
      environment: "preview",
      tags: { surface: "skip_trace_claim", operation: "claim", kind: "queued", code: "PGRST120", errorClass: "database", phone: "5551234567", outcome: "customer@example.com" },
      fingerprint: ["customer@example.com"],
      sdkProcessingMetadata: { password: "secret-token" },
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: "secret-token" }, business: { phone: "5551234567" } },
      exception: { values: [{ type: "PostgrestError", value: "phone 5551234567", stacktrace: { frames: [
        { filename: "https://app.example.com/_next/static/chunks/app.js?token=secret-token", abs_path: "https://app.example.com/_next/static/chunks/app.js?token=secret-token", lineno: 12, colno: 5, vars: { customer: "customer@example.com" } },
        { filename: "https://app.example.com/leads/5551234567.js", lineno: 2 },
      ] } }] },
    } as unknown as ErrorEvent;
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.tags).toMatchObject({ surface: "skip_trace_claim", operation: "claim", kind: "queued", code: "PGRST120", errorClass: "database" });
    expect(scrubbed.exception?.values?.[0]?.value).toBe("database:PGRST120");
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({
      filename: "https://app.example.com/_next/static/chunks/app.js", lineno: 12, colno: 5,
    });
    expect(scrubbed.release).toBe("sandra@abc123");
    expect(JSON.stringify(scrubbed)).not.toMatch(/5551234567|customer@example.com|secret-token/);
  });
});
