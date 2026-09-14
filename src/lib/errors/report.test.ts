import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  getClient: vi.fn(() => ({})),
  withScope: vi.fn((callback: (scope: { setTag: (key: string, value: string) => void }) => void) => callback({ setTag: sentry.setTag })),
  setTag: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);

import { reportError } from "./report";

describe("reportError Sentry diagnostics", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.clearAllMocks();
  });

  it("normalizes a structured PostgREST failure without serializing customer details", () => {
    reportError({ code: "PGRST120", message: "phone 5551234567", details: "lead@example.com", status: 414 }, {
      errorClass: "database",
      tags: { surface: "skip_trace_claim", operation: "claim", kind: "queued", phone: "5551234567" },
      extra: { body: "secret" },
    });
    const captured = sentry.captureException.mock.calls[0][0] as Error;
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("database:PGRST120");
    expect(sentry.setTag.mock.calls).toEqual(expect.arrayContaining([
      ["surface", "skip_trace_claim"], ["operation", "claim"], ["code", "PGRST120"], ["httpStatus", "414"],
    ]));
    expect(JSON.stringify(sentry.setTag.mock.calls)).not.toContain("5551234567");
  });

  it("preserves an Error stack but rejects unsafe labels", () => {
    const error = new Error("customer@example.com");
    reportError(error, { tags: { surface: "sms_send", operation: "customer@example.com" } });
    expect(sentry.captureException).toHaveBeenCalledWith(error);
    expect(sentry.setTag).toHaveBeenCalledWith("surface", "sms_send");
    expect(sentry.setTag).not.toHaveBeenCalledWith("operation", expect.anything());
  });
});
