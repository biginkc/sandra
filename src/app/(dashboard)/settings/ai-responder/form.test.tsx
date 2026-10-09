import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiResponderConfigForm } from "./form";
import type { AiResponderConfigRow } from "./actions";
import type { Result } from "@/lib/errors/result";

/**
 * Root review of 3e4ee3b1 (jev-root-round12-review.md), finding 3: the
 * "Use Jev automatic classification" switch — its own save action, own
 * visible save/error state, and loads/displays the persisted
 * classifier_provider/classifier_mode it maps to/from.
 */
const { updateAiResponderConfig, updateJevAutomaticClassification } = vi.hoisted(() => ({
  updateAiResponderConfig: vi.fn(async (): Promise<Result<null>> => ({ ok: true, data: null })),
  updateJevAutomaticClassification: vi.fn(async (): Promise<Result<null>> => ({ ok: true, data: null })),
}));

vi.mock("./actions", () => ({
  updateAiResponderConfig,
  updateJevAutomaticClassification,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function config(overrides: Partial<AiResponderConfigRow> = {}): AiResponderConfigRow {
  return {
    id: "config-1",
    active: true,
    model: "claude-sonnet-5",
    system_prompt: "You are a helpful assistant.",
    max_turns: 3,
    min_confidence: 0.8,
    business_hours_only: false,
    reply_delay_min_seconds: 0,
    reply_delay_max_seconds: 0,
    escalation_keywords: ["stop", "lawyer"],
    updated_at: "2026-09-21T00:00:00.000Z",
    classifier_provider: "legacy",
    classifier_mode: "shadow",
    ...overrides,
  };
}

describe("<AiResponderConfigForm /> — Jev automatic classification switch", () => {
  beforeEach(() => {
    updateAiResponderConfig.mockClear();
    updateJevAutomaticClassification.mockClear();
    updateJevAutomaticClassification.mockResolvedValue({ ok: true, data: null });
  });

  it("loads/displays the persisted state: legacy/shadow shows disabled, unchecked, and the save button already reads Saved", () => {
    render(<AiResponderConfigForm initial={config({ classifier_provider: "legacy", classifier_mode: "shadow" })} />);
    expect(screen.getByText("legacy / shadow")).toBeInTheDocument();
    expect(screen.getByTestId("jev-automatic-toggle")).not.toBeChecked();
    expect(screen.getByTestId("jev-automatic-save")).toHaveTextContent("Saved");
    expect(screen.getByTestId("jev-automatic-save")).toBeDisabled();
  });

  it("loads/displays the persisted state: provider='jev' + mode='automatic' shows enabled and checked", () => {
    render(<AiResponderConfigForm initial={config({ classifier_provider: "jev", classifier_mode: "automatic" })} />);
    expect(screen.getByText("Jev automatic")).toBeInTheDocument();
    expect(screen.getByTestId("jev-automatic-toggle")).toBeChecked();
  });

  it("toggling and saving calls updateJevAutomaticClassification with enabled=true, and updates the displayed state on success", async () => {
    const user = userEvent.setup();
    render(<AiResponderConfigForm initial={config({ classifier_provider: "legacy", classifier_mode: "shadow" })} />);

    await user.click(screen.getByTestId("jev-automatic-toggle"));
    expect(screen.getByTestId("jev-automatic-save")).not.toBeDisabled();
    await user.click(screen.getByTestId("jev-automatic-save"));

    await waitFor(() => {
      expect(updateJevAutomaticClassification).toHaveBeenCalledWith({ configId: "config-1", enabled: true });
    });
    await waitFor(() => {
      expect(screen.getByText("Jev automatic")).toBeInTheDocument();
    });
    expect(updateAiResponderConfig).not.toHaveBeenCalled();
  });

  it("shows a visible inline error and does NOT flip the displayed state when the save fails", async () => {
    updateJevAutomaticClassification.mockResolvedValueOnce({
      ok: false,
      error: { code: "VALIDATION", message: "TYPESAFE_API_KEY is not configured on this environment." },
    });
    const user = userEvent.setup();
    render(<AiResponderConfigForm initial={config({ classifier_provider: "legacy", classifier_mode: "shadow" })} />);

    await user.click(screen.getByTestId("jev-automatic-toggle"));
    await user.click(screen.getByTestId("jev-automatic-save"));

    await waitFor(() => {
      expect(screen.getByTestId("jev-automatic-error")).toHaveTextContent("TYPESAFE_API_KEY is not configured");
    });
    // Displayed persisted state stays legacy/shadow — the save did not
    // actually take effect server-side.
    expect(screen.getByText("legacy / shadow")).toBeInTheDocument();
  });
});
