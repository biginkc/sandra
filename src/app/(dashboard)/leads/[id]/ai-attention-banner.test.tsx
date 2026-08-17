import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearNeedsHumanAttention } = vi.hoisted(() => ({
  clearNeedsHumanAttention: vi.fn(),
}));

vi.mock("./ai-actions", () => ({ clearNeedsHumanAttention }));

import { AiAttentionBanner } from "./ai-attention-banner";

const NOW_MS = new Date("2026-08-17T12:00:00.000Z").getTime();

describe("<AiAttentionBanner />", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses Mark handled copy backed by the existing clear action", async () => {
    const user = userEvent.setup();
    clearNeedsHumanAttention.mockResolvedValue({ ok: true, data: undefined });
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        reason="low_confidence"
        nowMs={NOW_MS}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mark handled" }));
    expect(clearNeedsHumanAttention).toHaveBeenCalledWith("prop-1");
    expect(screen.queryByTestId("ai-attention-banner")).toBeNull();
  });

  it("shows a truthful failure and retries the same clear action", async () => {
    const user = userEvent.setup();
    clearNeedsHumanAttention
      .mockResolvedValueOnce({ ok: false, error: { message: "save failed" } })
      .mockResolvedValueOnce({ ok: true, data: undefined });
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        reason={null}
        nowMs={NOW_MS}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Mark handled" }));
    expect(await screen.findByTestId("ai-attention-failure")).toHaveTextContent(
      "save failed",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(clearNeedsHumanAttention).toHaveBeenCalledTimes(2);
  });

  it("formats relative age from the request instant, not the client clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2030-01-01T00:00:00.000Z").getTime(),
    );
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        escalatedAt="2026-08-17T11:55:00.000Z"
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByText("5m ago")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
