import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobFailureNotifier } from "./job-failure-notifier";

const { toastError, limitMock } = vi.hoisted(() => ({
  toastError: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError },
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select() {
        return this;
      },
      in() {
        return this;
      },
      gte() {
        return this;
      },
      order() {
        return this;
      },
      limit: limitMock,
    }),
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.clearAllMocks();
});

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

describe("<JobFailureNotifier />", () => {
  it("does not duplicate a job across polling cycles", async () => {
    limitMock.mockResolvedValue({
      data: [
        {
          id: "job-1",
          status: "failed",
          title: "Import",
          type: "csv",
          error_message: "bad row",
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });

    const { unmount } = render(<JobFailureNotifier />);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(limitMock).toHaveBeenCalledTimes(2));
    expect(toastError).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("tears down polling while hidden and fetches once before resuming when visible", () => {
    vi.useFakeTimers();
    limitMock.mockResolvedValue({ data: [], error: null });

    const { unmount } = render(<JobFailureNotifier />);
    expect(limitMock).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(15_000);
    expect(limitMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(limitMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(limitMock).toHaveBeenCalledTimes(3);

    unmount();
    vi.advanceTimersByTime(5_000);
    expect(limitMock).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after a rejected request", () => {
    vi.useFakeTimers();
    limitMock
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ data: [], error: null });

    const { unmount } = render(<JobFailureNotifier />);
    vi.advanceTimersByTime(5_000);
    expect(limitMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("keeps the timer alive when a request never settles", () => {
    vi.useFakeTimers();
    limitMock.mockImplementation(() => new Promise(() => {}));

    const { unmount } = render(<JobFailureNotifier />);
    vi.advanceTimersByTime(15_000);
    expect(limitMock).toHaveBeenCalledTimes(4);

    unmount();
  });
});
