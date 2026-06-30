import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { applyCampaignCadenceChange, previewCampaignCadenceChange, refresh } =
  vi.hoisted(() => ({
    applyCampaignCadenceChange: vi.fn(),
    previewCampaignCadenceChange: vi.fn(),
    refresh: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("../actions", () => ({
  applyCampaignCadenceChange,
  previewCampaignCadenceChange,
}));

import { CampaignCadenceControl } from "./campaign-cadence-control";

const previewResult = {
  affectedCount: 10,
  firstScheduledFor: "2026-06-30T18:05:00.000Z",
  lastScheduledFor: "2026-06-30T18:06:12.000Z",
  paceSeconds: 8,
  startAfterSeconds: 300,
};

describe("<CampaignCadenceControl />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewCampaignCadenceChange.mockResolvedValue({
      ok: true,
      data: previewResult,
    });
    applyCampaignCadenceChange.mockResolvedValue({
      ok: true,
      data: previewResult,
    });
  });

  it("previews a cadence change before enabling apply", async () => {
    const user = userEvent.setup();
    render(
      <CampaignCadenceControl
        campaignId="campaign-1"
        currentPaceSeconds={8}
      />,
    );

    expect(screen.getByRole("button", { name: /apply reschedule/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /preview/i }));

    expect(previewCampaignCadenceChange).toHaveBeenCalledWith("campaign-1", 8);
    expect(
      await screen.findByText(/10 future queued messages at 8s cadence/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply reschedule/i })).toBeEnabled();
  });

  it("does not apply when the operator cancels the confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <CampaignCadenceControl
        campaignId="campaign-1"
        currentPaceSeconds={8}
      />,
    );

    await user.click(screen.getByRole("button", { name: /preview/i }));
    await screen.findByText(/10 future queued messages at 8s cadence/);
    await user.click(screen.getByRole("button", { name: /apply reschedule/i }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(applyCampaignCadenceChange).not.toHaveBeenCalled();
  });

  it("passes operator confirmation to the apply action after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <CampaignCadenceControl
        campaignId="campaign-1"
        currentPaceSeconds={8}
      />,
    );

    await user.click(screen.getByRole("button", { name: /preview/i }));
    await screen.findByText(/10 future queued messages at 8s cadence/);
    await user.click(screen.getByRole("button", { name: /apply reschedule/i }));

    expect(applyCampaignCadenceChange).toHaveBeenCalledWith(
      "campaign-1",
      8,
      true,
    );
    expect(await screen.findByText(/^Applied:/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
