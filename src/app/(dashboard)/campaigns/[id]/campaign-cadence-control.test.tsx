import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyCampaignCadenceChange,
  pauseCampaignSends,
  previewCampaignCadenceChange,
  refresh,
  resumeCampaignSends,
} = vi.hoisted(() => ({
    applyCampaignCadenceChange: vi.fn(),
    pauseCampaignSends: vi.fn(),
    previewCampaignCadenceChange: vi.fn(),
    resumeCampaignSends: vi.fn(),
    refresh: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("../actions", () => ({
  applyCampaignCadenceChange,
  pauseCampaignSends,
  previewCampaignCadenceChange,
  resumeCampaignSends,
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
    pauseCampaignSends.mockResolvedValue({
      ok: true,
      data: { affectedCount: 10, pendingCount: 2, pausedCount: 10 },
    });
    resumeCampaignSends.mockResolvedValue({
      ok: true,
      data: previewResult,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("previews a cadence change before enabling apply", async () => {
    const user = userEvent.setup();
    renderControl();

    expect(screen.getByRole("button", { name: /apply cadence/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /preview cadence/i }));

    expect(previewCampaignCadenceChange).toHaveBeenCalledWith("campaign-1", 8);
    expect(
      await screen.findByText(/10 unsent queued messages at 8s cadence/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /apply cadence/i })).toBeEnabled();
  });

  it("does not apply when the operator cancels the confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderControl();

    await user.click(screen.getByRole("button", { name: /preview cadence/i }));
    await screen.findByText(/10 unsent queued messages at 8s cadence/);
    await user.click(screen.getByRole("button", { name: /apply cadence/i }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(applyCampaignCadenceChange).not.toHaveBeenCalled();
  });

  it("passes operator confirmation to the apply action after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderControl();

    await user.click(screen.getByRole("button", { name: /preview cadence/i }));
    await screen.findByText(/10 unsent queued messages at 8s cadence/);
    await user.click(screen.getByRole("button", { name: /apply cadence/i }));

    expect(applyCampaignCadenceChange).toHaveBeenCalledWith(
      "campaign-1",
      8,
      true,
    );
    expect(await screen.findByText(/^Applied:/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("pauses queued campaign sends after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderControl();

    await user.click(screen.getByRole("button", { name: /pause sends/i }));

    expect(pauseCampaignSends).toHaveBeenCalledWith("campaign-1", true);
    expect(await screen.findByText(/^Paused:/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("resumes paused campaign sends with the selected cadence", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderControl({ campaignStatus: "paused", queuedCount: 0, pausedCount: 10 });

    await user.click(screen.getByRole("button", { name: /resume sends/i }));

    expect(resumeCampaignSends).toHaveBeenCalledWith("campaign-1", 8, true);
    expect(await screen.findByText(/^Resumed:/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows a visible error when resume returns ok:false (prod statement timeout)", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    resumeCampaignSends.mockResolvedValue({
      ok: false,
      error: {
        code: "CADENCE_CHANGE_FAILED",
        message: "canceling statement due to statement timeout",
      },
    });
    renderControl({ campaignStatus: "paused", queuedCount: 0, pausedCount: 2720 });

    await user.click(screen.getByRole("button", { name: /resume sends/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Resume failed: canceling statement due to statement timeout",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows a visible error when pause returns ok:false", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    pauseCampaignSends.mockResolvedValue({
      ok: false,
      error: { code: "CAMPAIGN_PAUSE_FAILED", message: "pause boom" },
    });
    renderControl();

    await user.click(screen.getByRole("button", { name: /pause sends/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Pause failed: pause boom");
  });

  it("shows a visible error when apply returns ok:false", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    applyCampaignCadenceChange.mockResolvedValue({
      ok: false,
      error: { code: "CADENCE_CHANGE_FAILED", message: "apply boom" },
    });
    renderControl();

    await user.click(screen.getByRole("button", { name: /preview cadence/i }));
    await screen.findByText(/^Preview:/);
    await user.click(screen.getByRole("button", { name: /apply cadence/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Apply cadence failed: apply boom");
  });

  it("shows a visible error when the server action itself rejects", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    resumeCampaignSends.mockRejectedValue(new Error("Failed to fetch"));
    renderControl({ campaignStatus: "paused", queuedCount: 0, pausedCount: 10 });

    await user.click(screen.getByRole("button", { name: /resume sends/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Resume failed: Failed to fetch");
  });
});

function renderControl(
  overrides: Partial<ComponentProps<typeof CampaignCadenceControl>> = {},
) {
  return render(
    <CampaignCadenceControl
      campaignId="campaign-1"
      campaignStatus="completed"
      queuedCount={10}
      pausedCount={0}
      pendingCount={2}
      currentPaceSeconds={8}
      {...overrides}
    />,
  );
}
