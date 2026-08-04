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
  vi.clearAllMocks();
});

describe("<JobFailureNotifier />", () => {
  it("does not duplicate a job when visibility refreshes during a poll", async () => {
    let resolveQuery!: (value: {
      data: Array<{
        id: string;
        status: "failed";
        title: string;
        type: string;
        error_message: string | null;
        created_at: string;
      }>;
      error: null;
    }) => void;
    limitMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );

    render(<JobFailureNotifier />);
    expect(limitMock).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(limitMock).toHaveBeenCalledTimes(1);

    resolveQuery({
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

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  });
});
