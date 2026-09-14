import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: vi.fn(), capture: vi.fn(), flush: vi.fn(), tag: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.capture,
  flush: mocks.flush,
  withScope: (callback: (scope: { setTag: typeof mocks.tag }) => void) => callback({ setTag: mocks.tag }),
}));
vi.mock("./lib/errors/sentry-server-client", () => ({ ensureSentryServerClient: mocks.active }));

import { onRequestError } from "./instrumentation";

describe("Next server request error hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.active.mockReturnValue(true);
    mocks.flush.mockResolvedValue(true);
  });

  it("captures an unhandled error with safe route classification and awaits delivery", async () => {
    const error = new Error("private customer detail");
    await onRequestError(error, {}, { routePath: "/api/leads/[id]", routeType: "route" });
    expect(mocks.capture).toHaveBeenCalledWith(error, {
      mechanism: { handled: false, type: "auto.function.nextjs.on_request_error" },
    });
    expect(mocks.tag).toHaveBeenCalledWith("surface", "server_request");
    expect(mocks.tag).toHaveBeenCalledWith("errorClass", "unexpected");
    expect(mocks.tag).toHaveBeenCalledWith("routePattern", "/api/leads/[id]");
    expect(mocks.flush).toHaveBeenCalledWith(2_000);
  });

  it("does not capture without an active server client", async () => {
    mocks.active.mockReturnValue(false);
    await onRequestError(new Error("not sent"), {}, { routePath: "/api/leads/[id]", routeType: "route" });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });
});
