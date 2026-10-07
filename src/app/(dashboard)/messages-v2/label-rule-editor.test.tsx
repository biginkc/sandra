import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LabelRuleEditor } from "./label-rule-editor";
import type { ModeBadge } from "./types";

const { setLabelRule, refresh } = vi.hoisted(() => ({ setLabelRule: vi.fn(), refresh: vi.fn() }));
vi.mock("./threshold-actions", () => ({ setLabelRule }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

type Rule = NonNullable<ModeBadge["rule"]>;
const badge = (over: Partial<ModeBadge> & { rule?: Partial<Rule> } = {}) =>
  ({
    label: "nurture" as const,
    mode: "AUTO" as const,
    minConfidence: 0.95,
    ...over,
    rule: { minConfidence: 0.95, automationEnabled: true, version: 4, ...over.rule },
  }) as ModeBadge & { rule: Rule; label: "nurture" };

function setup(b = badge()) {
  render(<LabelRuleEditor orgId="org-1" badge={b} text="nurture [AUTO ≥0.95]" />);
  return userEvent.setup();
}

const open = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Edit rule for nurture" }));

beforeEach(() => {
  setLabelRule.mockReset();
  refresh.mockReset();
  setLabelRule.mockResolvedValue({ ok: true, data: { minConfidence: 0.95, automationEnabled: false, version: 5 } });
});

describe("<LabelRuleEditor />", () => {
  it("renders the badge as a button and shows the current rule text exactly", async () => {
    const user = setup();
    expect(screen.getByText("nurture [AUTO ≥0.95]")).toBeVisible();
    await open(user);
    expect(screen.getByTestId("current-rule-text")).toHaveTextContent(
      "nurture: auto-apply at native confidence ≥ 0.95 (ON)",
    );
    expect(screen.getByRole("radio", { name: "On" })).toBeChecked();
    expect(screen.getByTestId("rule-cutoff-input")).toHaveValue("0.95");
  });

  it("flipping the switch shows the exact resulting rule before anything is saved", async () => {
    const user = setup();
    await open(user);
    await user.click(screen.getByRole("radio", { name: "Off" }));

    expect(screen.getByTestId("new-rule-text")).toHaveTextContent(
      "nurture: auto-apply at native confidence ≥ 0.95 (OFF)",
    );
    expect(setLabelRule).not.toHaveBeenCalled();
  });

  it("a typed cutoff is shown verbatim in the resulting rule, and saved exactly", async () => {
    const user = setup();
    await open(user);
    const input = screen.getByTestId("rule-cutoff-input");
    await user.clear(input);
    await user.type(input, "0.925");
    expect(screen.getByTestId("new-rule-text")).toHaveTextContent(
      "nurture: auto-apply at native confidence ≥ 0.925 (ON)",
    );
    await user.click(screen.getByTestId("apply-rule"));

    await waitFor(() =>
      expect(setLabelRule).toHaveBeenCalledWith({
        orgId: "org-1",
        outcome: "nurture",
        minConfidence: 0.925,
        automationEnabled: true,
        expectedVersion: 4,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("an invalid cutoff blocks Apply and explains why; nothing is guessed", async () => {
    const user = setup();
    await open(user);
    const input = screen.getByTestId("rule-cutoff-input");
    await user.clear(input);
    await user.type(input, "1.5");

    expect(screen.getByRole("alert")).toHaveTextContent(/number from 0 to 1/);
    expect(screen.getByTestId("apply-rule")).toBeDisabled();
    expect(screen.getByTestId("new-rule-text")).toHaveTextContent("Choose On or Off and type a cutoff.");
  });

  it("Apply is disabled until something actually changes", async () => {
    const user = setup();
    await open(user);
    expect(screen.getByTestId("apply-rule")).toBeDisabled();
    expect(screen.getByTestId("apply-rule")).toHaveTextContent("No change");
    await user.click(screen.getByRole("radio", { name: "Off" }));
    expect(screen.getByTestId("apply-rule")).toBeEnabled();
  });

  it("cancelling saves nothing", async () => {
    const user = setup();
    await open(user);
    await user.click(screen.getByRole("radio", { name: "Off" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(setLabelRule).not.toHaveBeenCalled();
  });

  it("an unknown switch state is never assumed: the owner must choose", async () => {
    const user = setup(badge({ mode: "UNKNOWN", rule: { minConfidence: null, automationEnabled: null, version: 1 } }));
    await open(user);
    expect(screen.getByTestId("current-rule-text")).toHaveTextContent(/not fully known/);
    expect(screen.getByRole("radio", { name: "On" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Off" })).not.toBeChecked();
    expect(screen.getByTestId("apply-rule")).toBeDisabled();
  });

  it("a failed save keeps the dialog open and does not refresh", async () => {
    setLabelRule.mockResolvedValue({ ok: false, error: { code: "X", message: "Someone else changed this rule." } });
    const user = setup();
    await open(user);
    await user.click(screen.getByRole("radio", { name: "Off" }));
    await user.click(screen.getByTestId("apply-rule"));
    await waitFor(() => expect(setLabelRule).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("warns when the classifier is not in automatic mode", async () => {
    const user = setup(badge({ mode: "SHADOW" }));
    await open(user);
    expect(screen.getByText(/not in automatic mode/)).toBeVisible();
  });
});
