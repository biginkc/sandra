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

vi.mock("../leads/actions", () => ({
  verifyPropertiesBulk: vi.fn(),
}));

const { preflightSkipTrace, requestSkipTrace } = vi.hoisted(() => ({
  preflightSkipTrace: vi.fn(async () => ({
    ok: true,
    data: {
      requested: 3,
      eligible: 3,
      cassVerified: 3,
      cassUnverified: 0,
      notEligible: 0,
      killSwitchSkipped: 0,
      tracefyCreditsRequired: 3,
      tracefyCreditsAvailable: 100,
      tracefyCreditStatus: "sufficient",
      canLaunchSkipTrace: true,
      estimatedCassVerificationCostUsd: 0,
      cassVerificationPropertyIds: [],
    },
  })),
  requestSkipTrace: vi.fn(),
}));

vi.mock("@/lib/skip-trace/actions", () => ({
  approveSkipTraceJob: vi.fn(),
  preflightSkipTrace,
  requestSkipTrace,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe("<RetrySkipTraceButton />", () => {
  it("renders the retry button and opens skip-trace preflight before retrying", async () => {
    const user = userEvent.setup();
    const { retryFailedSkipTraceItems } = await import("./actions");
    render(
      <RetrySkipTraceButton
        jobId="job-1"
        propertyIds={["p1", "p2", "p3"]}
        retryCount={3}
        inFlightChildId={null}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Retry 3 retryable$/ });
    expect(trigger).toBeVisible();

    await user.click(trigger);

    expect(
      await screen.findByRole("heading", {
        name: "Retry skip-trace preflight",
      }),
    ).toBeVisible();
    expect(await screen.findByText("100 available / 3 needed")).toBeVisible();
    expect(preflightSkipTrace).toHaveBeenCalledWith(["p1", "p2", "p3"]);
    expect(retryFailedSkipTraceItems).not.toHaveBeenCalled();
    expect(requestSkipTrace).not.toHaveBeenCalled();
  });

  it("renders a 'Retry running…' link instead of the button when a child is in flight", () => {
    render(
      <RetrySkipTraceButton
        jobId="job-1"
        propertyIds={["p1", "p2", "p3"]}
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
        propertyIds={["p1", "p2"]}
        retryCount={2}
        inFlightChildId={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Retry 2 retryable$/ }));
    expect(
      await screen.findByRole("heading", {
        name: "Retry skip-trace preflight",
      }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(retryFailedSkipTraceItems).not.toHaveBeenCalled();
  });
});
