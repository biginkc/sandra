import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { preflightPromoteLeads, createPromoteLeadsJob } = vi.hoisted(() => ({
  preflightPromoteLeads: vi.fn(),
  createPromoteLeadsJob: vi.fn(),
}));

vi.mock("./promote-leads-actions", () => ({
  preflightPromoteLeads,
  createPromoteLeadsJob,
}));

import { PromoteLeadsDialog } from "./promote-leads-dialog";

beforeEach(() => {
  preflightPromoteLeads.mockReset();
  createPromoteLeadsJob.mockReset();
  preflightPromoteLeads.mockResolvedValue({
    ok: true,
    data: { selected: 6, eligible: 3, dncLocked: 2, staleOrNotProspect: 1 },
  });
  createPromoteLeadsJob.mockResolvedValue({
    ok: true,
    data: { jobId: "job-123", duplicate: false, status: "queued", counts: { pending: 3 }, workflowRunId: "run-1" },
  });
});

describe("PromoteLeadsDialog", () => {
  it("shows truthful selected, eligible, permanent-DNC, and stale counts before confirmation", async () => {
    render(
      <PromoteLeadsDialog
        open
        onOpenChange={vi.fn()}
        orgId="org-1"
        propertyIds={["a", "b", "c", "d", "e", "f"]}
        onStarted={vi.fn()}
      />,
    );

    const counts = await screen.findByLabelText("Promotion eligibility");
    expect(counts).toHaveTextContent("6 selected");
    expect(counts).toHaveTextContent("3 eligible");
    expect(counts).toHaveTextContent("2 permanently DNC locked");
    expect(counts).toHaveTextContent("1 stale or already a Lead");
    expect(screen.getByText(/runs in the background/i)).toBeVisible();
  });

  it("starts only after explicit confirmation and exposes View progress", async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    render(
      <PromoteLeadsDialog
        open
        onOpenChange={vi.fn()}
        orgId="org-1"
        propertyIds={["a", "b", "c", "d", "e", "f"]}
        onStarted={onStarted}
      />,
    );
    await screen.findByRole("button", { name: "Promote 3 to Leads" });
    expect(createPromoteLeadsJob).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Promote 3 to Leads" }));
    await waitFor(() => expect(createPromoteLeadsJob).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("link", { name: "View progress" })).toHaveAttribute("href", "/jobs/job-123");
    expect(onStarted).toHaveBeenCalledWith("job-123");
  });

  it("disables promotion when nothing remains eligible", async () => {
    preflightPromoteLeads.mockResolvedValue({
      ok: true,
      data: { selected: 2, eligible: 0, dncLocked: 2, staleOrNotProspect: 0 },
    });
    render(
      <PromoteLeadsDialog
        open
        onOpenChange={vi.fn()}
        orgId="org-1"
        propertyIds={["a", "b"]}
        onStarted={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: "No eligible prospects" })).toBeDisabled();
    expect(createPromoteLeadsJob).not.toHaveBeenCalled();
  });

  it("does not claim background work started when every item became DNC before creation", async () => {
    const user = userEvent.setup();
    createPromoteLeadsJob.mockResolvedValue({
      ok: true,
      data: {
        jobId: "job-terminal",
        duplicate: false,
        status: "completed",
        counts: { promoted: 0, dnc_locked: 3 },
        workflowRunId: null,
      },
    });
    render(
      <PromoteLeadsDialog
        open
        onOpenChange={vi.fn()}
        orgId="org-1"
        propertyIds={["a", "b", "c"]}
        onStarted={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Promote 3 to Leads" }));
    expect(await screen.findByText("Promotion finished. No background work was needed.")).toBeVisible();
    expect(screen.queryByText("Promotion started in the background.")).toBeNull();
  });

  it("recovers from a rejected eligibility check", async () => {
    preflightPromoteLeads
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({
        ok: true,
        data: { selected: 2, eligible: 2, dncLocked: 0, staleOrNotProspect: 0 },
      });
    const user = userEvent.setup();
    render(
      <PromoteLeadsDialog
        open
        onOpenChange={vi.fn()}
        orgId="org-1"
        propertyIds={["a", "b"]}
        onStarted={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Promote 2 to Leads" })).toBeEnabled();
    expect(preflightPromoteLeads).toHaveBeenCalledTimes(2);
  });

  it("restores confirmation after a rejected job creation", async () => {
    createPromoteLeadsJob.mockRejectedValueOnce(new Error("Network unavailable"));
    const user = userEvent.setup();
    render(
      <PromoteLeadsDialog
        open
        onOpenChange={vi.fn()}
        orgId="org-1"
        propertyIds={["a", "b", "c"]}
        onStarted={vi.fn()}
      />,
    );

    const confirm = await screen.findByRole("button", { name: "Promote 3 to Leads" });
    await user.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    expect(confirm).toBeEnabled();
  });
});
