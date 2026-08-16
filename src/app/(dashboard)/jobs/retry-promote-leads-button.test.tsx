import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { retryPromoteLeadsJob, routerPush } = vi.hoisted(() => ({
  retryPromoteLeadsJob: vi.fn(),
  routerPush: vi.fn(),
}));
vi.mock("../properties/promote-leads-actions", () => ({ retryPromoteLeadsJob }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn() }),
}));

import { RetryPromoteLeadsButton } from "./retry-promote-leads-button";

beforeEach(() => {
  retryPromoteLeadsJob.mockReset();
  routerPush.mockReset();
});
describe("RetryPromoteLeadsButton", () => {
  it("starts one replay-safe child and opens its progress page", async () => {
    retryPromoteLeadsJob.mockResolvedValue({
      ok: true,
      data: { jobId: "child-1", status: "queued", duplicate: false, counts: {}, workflowRunId: "run-1" },
    });
    const user = userEvent.setup();
    render(<RetryPromoteLeadsButton jobId="parent-1" retryableCount={2} inFlightChildId={null} />);
    await user.click(screen.getByRole("button", { name: "Retry 2 failed" }));
    await waitFor(() => expect(retryPromoteLeadsJob).toHaveBeenCalledTimes(1));
    expect(routerPush).toHaveBeenCalledWith("/jobs/child-1");
    const firstKey = retryPromoteLeadsJob.mock.calls[0][0].idempotencyKey;
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("links to an existing in-flight child instead of creating another retry", () => {
    render(<RetryPromoteLeadsButton jobId="parent-1" retryableCount={2} inFlightChildId="child-running" />);
    expect(screen.getByRole("link", { name: "Retry running…" })).toHaveAttribute("href", "/jobs/child-running");
    expect(screen.queryByRole("button", { name: /Retry 2/ })).toBeNull();
  });
});
