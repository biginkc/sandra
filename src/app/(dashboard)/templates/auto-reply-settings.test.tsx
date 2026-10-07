import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AutoReplySettingsSection } from "./auto-reply-settings";
import type { AutoReplySettings } from "./auto-reply-types";

const { setAutoReplyMapping } = vi.hoisted(() => ({ setAutoReplyMapping: vi.fn() }));
vi.mock("./auto-reply-actions", () => ({ setAutoReplyMapping }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const templates = [
  { id: "a", name: "Approved A", approved_for_auto_send: true },
  { id: "b", name: "Approved B", approved_for_auto_send: true },
  { id: "c", name: "Draft C", approved_for_auto_send: false },
];

const settings = (over: Partial<AutoReplySettings> = {}): AutoReplySettings => ({
  orgId: "org",
  mappings: [],
  labelAutomation: { nurture: true, not_interested: true, new_lead: false },
  ...over,
});

beforeEach(() => {
  setAutoReplyMapping.mockReset();
  setAutoReplyMapping.mockResolvedValue({ ok: true, data: null });
});

describe("<AutoReplySettingsSection />", () => {
  it("lists only the outcomes that may be answered automatically", () => {
    render(<AutoReplySettingsSection settings={settings()} templates={templates} />);
    expect(screen.getByTestId("auto-reply-row-nurture")).toBeVisible();
    expect(screen.getByTestId("auto-reply-row-not_interested")).toBeVisible();
    expect(screen.getByTestId("auto-reply-row-new_lead")).toBeVisible();
    for (const never of ["opted_out", "dnc", "wrong_number"]) {
      expect(screen.queryByTestId(`auto-reply-row-${never}`)).not.toBeInTheDocument();
    }
  });

  it("offers approved templates only, defaulting to no automatic reply", () => {
    render(<AutoReplySettingsSection settings={settings()} templates={templates} />);
    const select = screen.getByTestId("auto-reply-select-nurture") as HTMLSelectElement;
    expect(select.value).toBe("");
    const names = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["No automatic reply", "Approved A", "Approved B"]);
  });

  it("choosing a template saves the mapping for that outcome", async () => {
    const user = userEvent.setup();
    render(<AutoReplySettingsSection settings={settings()} templates={templates} />);
    await user.selectOptions(screen.getByTestId("auto-reply-select-nurture"), "b");
    await waitFor(() =>
      expect(setAutoReplyMapping).toHaveBeenCalledWith({ outcome: "nurture", templateId: "b", active: true }),
    );
  });

  it("choosing 'No automatic reply' removes the mapping", async () => {
    const user = userEvent.setup();
    render(
      <AutoReplySettingsSection
        settings={settings({ mappings: [{ id: "m", outcome: "nurture", templateId: "a", active: true }] })}
        templates={templates}
      />,
    );
    await user.selectOptions(screen.getByTestId("auto-reply-select-nurture"), "");
    await waitFor(() =>
      expect(setAutoReplyMapping).toHaveBeenCalledWith({ outcome: "nurture", templateId: null, active: true }),
    );
  });

  it("the Active checkbox keeps the template and flips only active", async () => {
    const user = userEvent.setup();
    render(
      <AutoReplySettingsSection
        settings={settings({ mappings: [{ id: "m", outcome: "nurture", templateId: "a", active: true }] })}
        templates={templates}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Active: Nurture" }));
    await waitFor(() =>
      expect(setAutoReplyMapping).toHaveBeenCalledWith({ outcome: "nurture", templateId: "a", active: false }),
    );
  });

  it("warns when a mapped template is no longer approved, and when the label is switched off", () => {
    render(
      <AutoReplySettingsSection
        settings={settings({
          mappings: [
            { id: "m1", outcome: "nurture", templateId: "c", active: true },
            { id: "m2", outcome: "new_lead", templateId: "a", active: true },
          ],
        })}
        templates={templates}
      />,
    );
    const nurture = screen.getByTestId("auto-reply-row-nurture");
    expect(within(nurture).getByText("This template is not approved, so nothing will be sent.")).toBeVisible();
    expect(within(nurture).getByRole("option", { name: "Draft C (not approved)" })).toBeInTheDocument();
    const lead = screen.getByTestId("auto-reply-row-new_lead");
    expect(within(lead).getByText("Automation for this label is off, so nothing will be sent.")).toBeVisible();
  });
});
