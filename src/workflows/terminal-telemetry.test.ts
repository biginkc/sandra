import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  client: vi.fn(),
  capture: vi.fn(),
  flush: vi.fn(),
  tag: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  getClient: sentry.client,
  captureException: sentry.capture,
  flush: sentry.flush,
  withScope: (callback: (scope: { setTag: typeof sentry.tag }) => void) => callback({ setTag: sentry.tag }),
}));

import { reportTerminalWorkflowFailure } from "./terminal-telemetry";

describe("terminal Workflow reporting", () => {
  beforeEach(() => vi.resetAllMocks());

  it("captures only a controlled classification and awaits a bounded flush", async () => {
    sentry.client.mockReturnValue({});
    let completeFlush!: () => void;
    sentry.flush.mockReturnValue(new Promise<void>((resolve) => { completeFlush = resolve; }));
    const pending = reportTerminalWorkflowFailure("skip_trace_submit");
    expect(sentry.capture).toHaveBeenCalledWith(expect.objectContaining({ message: "Workflow terminal failure: skip_trace_submit" }));
    expect(sentry.tag.mock.calls).toEqual(expect.arrayContaining([["operation", "skip_trace_submit"], ["kind", "terminal_failure"]]));
    expect(sentry.flush).toHaveBeenCalledWith(2_000);
    completeFlush();
    await pending;
  });

  it("leaves business execution intact when delivery rejects", async () => {
    sentry.client.mockReturnValue({});
    sentry.flush.mockRejectedValue(new Error("transport unavailable"));
    await expect(reportTerminalWorkflowFailure("skip_trace_submit")).resolves.toBeUndefined();
  });
});
