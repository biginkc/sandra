import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NEEDS_ATTENTION_CHIPS, WAITING_CHIPS } from "./contract";
import { WorkToolbar, WORK_SEARCH_MAX, type WorkToolbarProps } from "./work-toolbar";

const base = (over: Partial<WorkToolbarProps> = {}): WorkToolbarProps => ({
  tab: "needs_attention", chip: "all", stage: null, search: "",
  tabCounts: { needs_attention: 12, waiting: 40, all: 60 },
  chipCounts: { new_lead: 2, call_today: 1, due: 3, new_reply: 4, broken: 0, offer: 1, gone_quiet: 1, nothing_planned: 0, in_drip: 30, texted_last: 6, offer_out: 3, callback_booked: 1 },
  stageCounts: { not_contacted: 5, contacted: 4, needs_offer: 2, offer_sent: 1, under_contract: 0 },
  allExpanded: false,
  onTabChange: vi.fn(), onChipChange: vi.fn(), onStageChange: vi.fn(), onSearchChange: vi.fn(), onToggleAll: vi.fn(),
  ...over,
});
const setup = (over: Partial<WorkToolbarProps> = {}) => {
  const props = base(over);
  render(<WorkToolbar {...props} />);
  return props;
};

describe("<WorkToolbar />", () => {
  it("shows the three tabs with live counts and marks the selected one", () => {
    setup({ tab: "waiting" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Needs attention 12", "Waiting on them 40", "All leads 60"]);
    expect(screen.getByTestId("work-tab-waiting")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("work-tab-needs_attention")).toHaveAttribute("aria-selected", "false");
  });
  it("clicking a tab or using arrow keys changes the tab", async () => {
    const props = setup();
    await userEvent.click(screen.getByTestId("work-tab-all"));
    expect(props.onTabChange).toHaveBeenCalledWith("all");
    fireEvent.keyDown(screen.getByTestId("work-tab-needs_attention"), { key: "ArrowRight" });
    expect(props.onTabChange).toHaveBeenLastCalledWith("waiting");
  });
  it("Needs attention chips: binding order, All reasons last and selected, with counts", () => {
    setup();
    const group = screen.getByRole("group", { name: "Reason" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("data-testid"))).toEqual(NEEDS_ATTENTION_CHIPS.map((c) => `work-chip-${c}`));
    expect(chips.map((c) => c.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "New lead 2", "Call today 1", "Due 3", "New reply 4", "Broken 0", "Offer 1", "Gone quiet 1", "Nothing planned 0", "All reasons 12",
    ]);
    expect(screen.getByTestId("work-chip-all")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("work-chip-due")).toHaveAttribute("aria-pressed", "false");
  });
  it("Waiting chips end with All waiting", () => {
    setup({ tab: "waiting" });
    const chips = within(screen.getByRole("group", { name: "Reason" })).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("data-testid"))).toEqual(WAITING_CHIPS.map((c) => `work-chip-${c}`));
    expect(screen.getByTestId("work-chip-all")).toHaveTextContent("All waiting 40");
    expect(screen.getByTestId("work-chip-in_drip")).toHaveTextContent("In a drip 30");
  });
  it("All leads has no chips but keeps the stage select", () => {
    setup({ tab: "all" });
    expect(screen.queryByRole("group", { name: "Reason" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Stage" })).toBeInTheDocument();
  });
  it("chip click reports the chip; re-clicking the selected chip does nothing", async () => {
    const props = setup();
    await userEvent.click(screen.getByTestId("work-chip-due"));
    expect(props.onChipChange).toHaveBeenCalledWith("due");
    await userEvent.click(screen.getByTestId("work-chip-all"));
    expect(props.onChipChange).toHaveBeenCalledTimes(1);
  });
  it("Stage select lists counts and reports the choice", async () => {
    const props = setup();
    const select = screen.getByRole("combobox", { name: "Stage" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All stages (12)", "Not contacted (5)", "Contacted (4)", "Needs offer / Interested (2)", "Offer Sent (1)", "Under Contract (0)",
    ]);
    await userEvent.selectOptions(select, "offer_sent");
    expect(props.onStageChange).toHaveBeenCalledWith("offer_sent");
    await userEvent.selectOptions(select, "");
    expect(props.onStageChange).toHaveBeenLastCalledWith(null);
  });
  it("search is hidden behind the magnifier", async () => {
    const props = setup();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    const input = await screen.findByRole("searchbox");
    expect(input).toHaveAttribute("maxlength", String(WORK_SEARCH_MAX));
    expect(input).toHaveFocus();
    await userEvent.type(input, "ab");
    expect(props.onSearchChange).toHaveBeenLastCalledWith("b");
  });
  it("starts open when a search is active; closing clears it", async () => {
    const props = setup({ search: "smith" });
    expect(screen.getByRole("searchbox")).toHaveValue("smith");
    await userEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(props.onSearchChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
  it("caps pasted search text at 200 characters", () => {
    const props = setup({ search: "x" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "y".repeat(250) } });
    expect(props.onSearchChange).toHaveBeenCalledWith("y".repeat(200));
  });
  it("expand/collapse all icon", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(props.onToggleAll).toHaveBeenCalledTimes(1);
  });
  it("names the icon Collapse all when everything is open", () => {
    setup({ allExpanded: true });
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeInTheDocument();
  });
  it("is laid out to scroll on a phone", () => {
    setup();
    expect(screen.getByRole("tablist").className).toContain("overflow-x-auto");
    expect(screen.getByRole("group", { name: "Reason" }).className).toContain("overflow-x-auto");
  });
});
