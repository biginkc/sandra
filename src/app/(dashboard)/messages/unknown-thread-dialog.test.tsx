import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchUnknownSenderThread } from "./actions";
import { UnknownThreadDialog } from "./unknown-thread-dialog";

vi.mock("./actions", () => ({
  fetchUnknownSenderThread: vi.fn(),
}));

describe("<UnknownThreadDialog />", () => {
  beforeEach(() => {
    vi.mocked(fetchUnknownSenderThread).mockReset();
  });

  it("shows a retryable failure instead of claiming the thread is empty", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchUnknownSenderThread)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "THREAD_LOAD_FAILED", message: "database unavailable" },
      })
      .mockResolvedValueOnce({ ok: true, data: [] });

    render(
      <UnknownThreadDialog
        open
        onOpenChange={vi.fn()}
        fromAddress="+18165550123"
        nowMs={Date.parse("2026-08-17T12:00:00.000Z")}
      />,
    );

    expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
      "size-11",
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load this conversation.",
    );
    expect(
      screen.queryByText("No messages from this sender yet."),
    ).not.toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("min-h-11");
    await user.click(retry);

    expect(
      await screen.findByText("No messages from this sender yet."),
    ).toBeInTheDocument();
    expect(fetchUnknownSenderThread).toHaveBeenCalledTimes(2);
  });
});
