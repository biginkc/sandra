import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearNeedsHumanAttention, retrySuppressionForProperty, listOutstandingSuppressionFailures } =
  vi.hoisted(() => ({
    clearNeedsHumanAttention: vi.fn(),
    retrySuppressionForProperty: vi.fn(),
    listOutstandingSuppressionFailures: vi.fn(),
  }));

vi.mock("./ai-actions", () => ({
  clearNeedsHumanAttention,
  retrySuppressionForProperty,
  listOutstandingSuppressionFailures,
}));

import { AiAttentionBanner } from "./ai-attention-banner";

const NOW_MS = new Date("2026-08-17T12:00:00.000Z").getTime();

describe("<AiAttentionBanner />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOutstandingSuppressionFailures.mockResolvedValue({ ok: true, data: { reviewIds: [] } });
  });

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

  it("renders the suppression warning when the attention flag is off but suppression is outstanding", async () => {
    listOutstandingSuppressionFailures.mockResolvedValue({ ok: true, data: { reviewIds: ["r1"] } });
    render(
      <AiAttentionBanner propertyId="prop-1" initialVisible={false} reason={null} nowMs={NOW_MS} />,
    );
    expect(await screen.findByTestId("ai-attention-suppression-warning")).toHaveTextContent(
      "1 confirmed opt-out still needs suppression",
    );
    expect(screen.getByTestId("ai-attention-retry-suppression")).toBeInTheDocument();
    expect(listOutstandingSuppressionFailures).toHaveBeenCalledWith("prop-1");
  });

  it("stays hidden when the flag is off and nothing is outstanding", async () => {
    render(
      <AiAttentionBanner propertyId="prop-1" initialVisible={false} reason={null} nowMs={NOW_MS} />,
    );
    await waitFor(() => expect(listOutstandingSuppressionFailures).toHaveBeenCalled());
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

  it("shows Retry suppression and a dismiss warning only for suppression_incomplete", async () => {
    const { unmount } = render(
      <AiAttentionBanner propertyId="prop-1" initialVisible reason="low_confidence" nowMs={NOW_MS} />,
    );
    expect(screen.queryByTestId("ai-attention-retry-suppression")).toBeNull();
    unmount();
    render(
      <AiAttentionBanner propertyId="prop-1" initialVisible reason="suppression_incomplete" nowMs={NOW_MS} />,
    );
    expect(screen.getByTestId("ai-attention-suppression-warning")).toHaveTextContent(
      "Suppression is incomplete",
    );
    expect(screen.getByRole("button", { name: "Dismiss anyway" })).toBeInTheDocument();
  });

  it("retry success hides the banner; failure keeps it with the warning", async () => {
    const user = userEvent.setup();
    retrySuppressionForProperty
      .mockResolvedValueOnce({ ok: false, error: { message: "Confirmed, but suppression incomplete — retry." } })
      .mockResolvedValueOnce({ ok: true, data: { cleared: true, remaining: 0 } });
    render(
      <AiAttentionBanner propertyId="prop-1" initialVisible reason="suppression_incomplete" nowMs={NOW_MS} />,
    );
    await user.click(screen.getByRole("button", { name: "Retry suppression" }));
    expect(await screen.findByTestId("ai-attention-failure")).toHaveTextContent("suppression incomplete");
    expect(screen.getByTestId("ai-attention-banner")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry suppression" }));
    expect(retrySuppressionForProperty).toHaveBeenCalledWith("prop-1");
    expect(screen.queryByTestId("ai-attention-banner")).toBeNull();
  });

  it("accepts the id-carrying reason and lists each outstanding failed review with a count", async () => {
    listOutstandingSuppressionFailures.mockResolvedValue({
      ok: true,
      data: { reviewIds: ["review-a", "review-b"] },
    });
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        reason="suppression_incomplete:review-a"
        nowMs={NOW_MS}
      />,
    );
    expect(await screen.findByRole("button", { name: "Retry suppression (2)" })).toBeInTheDocument();
    expect(screen.getByTestId("ai-attention-suppression-warning")).toHaveTextContent(
      "2 confirmed opt-outs still need suppression",
    );
    expect(screen.queryByText(/review-a/)).toBeNull();
  });

  it("shows Retry suppression when a failed review hides behind a preserved timeout reason", async () => {
    listOutstandingSuppressionFailures.mockResolvedValue({ ok: true, data: { reviewIds: ["review-a"] } });
    render(
      <AiAttentionBanner propertyId="prop-1" initialVisible reason="send_timeout:msg-1" nowMs={NOW_MS} />,
    );
    expect(await screen.findByTestId("ai-attention-retry-suppression")).toBeInTheDocument();
  });

  it("updates the outstanding count after a partial retry", async () => {
    const user = userEvent.setup();
    listOutstandingSuppressionFailures.mockResolvedValue({
      ok: true,
      data: { reviewIds: ["review-a", "review-b"] },
    });
    retrySuppressionForProperty.mockResolvedValueOnce({ ok: true, data: { cleared: false, remaining: 1 } });
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        reason="suppression_incomplete:review-a"
        nowMs={NOW_MS}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Retry suppression (2)" }));
    expect(await screen.findByRole("button", { name: "Retry suppression" })).toBeInTheDocument();
    expect(screen.getByTestId("ai-attention-banner")).toBeInTheDocument();
  });

  it("does not claim a count when the loaded count is 0 or the load failed", async () => {
    listOutstandingSuppressionFailures.mockResolvedValue({ ok: true, data: { reviewIds: [] } });
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        reason="suppression_incomplete:review-a"
        nowMs={NOW_MS}
      />,
    );
    const warning = await screen.findByTestId("ai-attention-suppression-warning");
    await waitFor(() => expect(listOutstandingSuppressionFailures).toHaveBeenCalled());
    expect(warning).toHaveTextContent("Suppression status loading or unavailable");
    expect(warning).not.toHaveTextContent("1 confirmed opt-out");
  });

  it("says 1 confirmed opt-out only when exactly one is loaded", async () => {
    listOutstandingSuppressionFailures.mockResolvedValue({ ok: true, data: { reviewIds: ["review-a"] } });
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        reason="suppression_incomplete:review-a"
        nowMs={NOW_MS}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ai-attention-suppression-warning")).toHaveTextContent(
        "1 confirmed opt-out still needs suppression",
      ),
    );
  });

  it("counts the ids carried in the reason when the ledger is unreadable", async () => {
    listOutstandingSuppressionFailures.mockResolvedValue({ ok: false, error: { message: "ledger down" } });
    render(
      <AiAttentionBanner
        propertyId="prop-1"
        initialVisible
        reason="suppression_incomplete:review-a,review-b,review-c"
        nowMs={NOW_MS}
      />,
    );
    await waitFor(() => expect(listOutstandingSuppressionFailures).toHaveBeenCalled());
    expect(screen.getByTestId("ai-attention-suppression-warning")).toHaveTextContent(
      "3 confirmed opt-outs still need suppression",
    );
    expect(screen.getByRole("button", { name: "Retry suppression (3)" })).toBeInTheDocument();
    expect(screen.queryByText(/review-a/)).toBeNull();
  });
});
