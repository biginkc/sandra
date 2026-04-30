import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { RetrySkipTraceButton } from "./retry-skip-trace-button";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("./actions", () => ({
  retryFailedSkipTraceItems: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

describe("<RetrySkipTraceButton />", () => {
  it("renders the retry button with the property count and shows cost in the dialog", async () => {
    const user = userEvent.setup();
    render(
      <RetrySkipTraceButton
        jobId="job-1"
        retryCount={3}
        inFlightChildId={null}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Retry 3 retryable$/ });
    expect(trigger).toBeVisible();

    await user.click(trigger);

    expect(
      screen.getByRole("heading", { name: "Retry skip-trace?" }),
    ).toBeVisible();
    expect(screen.getByText(/Estimated cost: \$0\.06/)).toBeVisible();
  });

  it("renders a 'Retry running…' link instead of the button when a child is in flight", () => {
    render(
      <RetrySkipTraceButton
        jobId="job-1"
        retryCount={3}
        inFlightChildId="child-job-99"
      />,
    );

    const link = screen.getByRole("link", { name: "Retry running…" });
    expect(link).toHaveAttribute("href", "/jobs/child-job-99");
    expect(
      screen.queryByRole("button", { name: /^Retry/ }),
    ).not.toBeInTheDocument();
  });

  it("cancelling the dialog does not invoke the retry action", async () => {
    const user = userEvent.setup();
    const { retryFailedSkipTraceItems } = await import("./actions");
    render(
      <RetrySkipTraceButton
        jobId="job-1"
        retryCount={2}
        inFlightChildId={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Retry 2 retryable$/ }));
    expect(
      screen.getByRole("heading", { name: "Retry skip-trace?" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(retryFailedSkipTraceItems).not.toHaveBeenCalled();
  });
});
