import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callAction, refreshSkipTraceBalanceAction } = vi.hoisted(() => ({
  callAction: vi.fn(),
  refreshSkipTraceBalanceAction: vi.fn(),
}));

vi.mock("@/lib/errors/call-action", () => ({ callAction }));
vi.mock("../credit-actions", () => ({ refreshSkipTraceBalanceAction }));

import { RefreshCreditsButton } from "./refresh-credits-button";

describe("RefreshCreditsButton", () => {
  beforeEach(() => {
    callAction.mockReset();
    refreshSkipTraceBalanceAction.mockReset();
  });

  it("calls the refresh action and passes the expected feedback messages", async () => {
    const actionResult = Promise.resolve({
      ok: true as const,
      data: { credits: 6692, capturedAt: "2026-08-10T16:15:00.000Z" },
    });
    refreshSkipTraceBalanceAction.mockReturnValue(actionResult);
    callAction.mockResolvedValue(await actionResult);
    const user = userEvent.setup();

    render(<RefreshCreditsButton />);
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(refreshSkipTraceBalanceAction).toHaveBeenCalledOnce();
    expect(callAction).toHaveBeenCalledWith(actionResult, {
      successMessage: "Skip-trace credits refreshed",
      fallbackMessage: "Could not refresh provider credits",
    });
  });

  it("disables the control while the refresh is pending", async () => {
    let resolveAction!: (value: {
      ok: true;
      data: { credits: number; capturedAt: string };
    }) => void;
    const actionResult = new Promise<{
      ok: true;
      data: { credits: number; capturedAt: string };
    }>((resolve) => {
      resolveAction = resolve;
    });
    refreshSkipTraceBalanceAction.mockReturnValue(actionResult);
    callAction.mockImplementation(async (promise) => promise);
    const user = userEvent.setup();

    render(<RefreshCreditsButton />);
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

    resolveAction({
      ok: true,
      data: { credits: 6692, capturedAt: "2026-08-10T16:15:00.000Z" },
    });
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeEnabled();
  });
});
