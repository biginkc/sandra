import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoachCallContext } from "../_components/coach-call-context";
import type { WorkFacts } from "./contract";
import { NOW, workFacts } from "./test-support";
import { WorkRow, type WorkRowProps } from "./work-row";

const handlers = () => ({
  onToggle: vi.fn(), onAction: vi.fn(), onOpenText: vi.fn(), onCallToday: vi.fn(), onUndoCallToday: vi.fn(),
  onSetDrip: vi.fn(), onBrokenAction: vi.fn(), onDismissBroken: vi.fn(),
});

function renderRow(facts: WorkFacts, over: Partial<WorkRowProps> = {}, h = handlers()) {
  const view = render(<WorkRow facts={facts} now={NOW} expanded={false} canAct {...h} {...over} />);
  return { h, ...view };
}

const dueFacts = () => workFacts("due", "4", { at: "2026-10-14T14:30:00Z", soon: false }, { stage: "contacted" });

describe("collapsed row", () => {
  it("shows the zip after the state when the facts carry one", () => {
    renderRow(workFacts("due", "4", { at: "2026-10-14T14:30:00Z", soon: false }, { zip: "64111" }));
    expect(screen.getByTestId("work-row-address-lead-1")).toHaveTextContent("lead-1 Main St, Kansas City, MO 64111");
  });
  it("shows name, stage pill, full address, bold headline in the reason tone and two buttons", () => {
    renderRow(dueFacts());
    const row = screen.getByTestId("work-row-lead-1");
    expect(row).toHaveAttribute("data-lead-id", "lead-1");
    expect(within(row).getByText("Owner lead-1")).toBeInTheDocument();
    expect(screen.getByTestId("work-row-stage-lead-1")).toHaveTextContent("Contacted");
    expect(screen.getByTestId("work-row-address-lead-1")).toHaveTextContent("lead-1 Main St, Kansas City, MO");
    const headline = screen.getByTestId("work-row-headline-lead-1");
    expect(headline).toHaveTextContent("Due · callback 9:30 AM");
    expect(headline.className).toContain("text-red-700");
    expect(screen.getByTestId("work-row-primary-lead-1")).toHaveTextContent("Call");
    expect(screen.getByTestId("work-row-open-lead-lead-1")).toBeInTheDocument();
    expect(screen.queryByTestId("work-row-call-lead-1")).not.toBeInTheDocument();
  });
  it("collapsed action group has exactly the design's button count", () => {
    const count = () => {
      const group = within(screen.getByRole("group", { name: /Actions for/ }));
      return group.queryAllByRole("button").length + group.queryAllByRole("link").length;
    };
    // Primary + Open lead.
    const due = renderRow(dueFacts());
    expect(count()).toBe(2);
    due.unmount();
    // Documented exception: a Call today row also shows Undo (it is the only way back from a pin), so three.
    const pinned = renderRow(workFacts("call_today", "2", {}, { stage: "contacted" }));
    expect(count()).toBe(3);
    expect(screen.getByTestId("work-row-undo-lead-1")).toBeInTheDocument();
    pinned.unmount();
    // Waiting rows and Under contract rows carry nothing asked of the rep: Open lead only.
    const waiting = renderRow(workFacts("texted_last", "13", { at: "2026-10-14T15:00:00Z", by: "human" }));
    expect(count()).toBe(1);
    waiting.unmount();
    renderRow(workFacts("under_contract", "12", {}, { stage: "under_contract" }));
    expect(count()).toBe(1);
  });
  it("stage colors the border", () => {
    const stages = { not_contacted: "border-l-blue-500", contacted: "border-l-teal-600", needs_offer: "border-l-amber-500", offer_sent: "border-l-violet-500", under_contract: "border-l-green-600" } as const;
    for (const [stage, cls] of Object.entries(stages)) {
      const { unmount } = renderRow(workFacts("due", "4", {}, { stage: stage as WorkFacts["stage"] }));
      expect(screen.getByTestId("work-row-lead-1").className).toContain(cls);
      unmount();
    }
  });
  it("Open lead is a link to the lead page in a new tab", () => {
    renderRow(dueFacts());
    const link = screen.getByTestId("work-row-open-lead-lead-1");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/leads/lead-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
  it("clicking the row toggles; clicking its buttons does not", async () => {
    const { h } = renderRow(dueFacts());
    await userEvent.click(screen.getByText("Owner lead-1"));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("work-row-primary-lead-1"));
    await userEvent.click(screen.getByTestId("work-row-open-lead-lead-1"));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("work-row-toggle-lead-1"));
    expect(h.onToggle).toHaveBeenCalledTimes(2);
  });
  it("primary Call fires the start-call action", async () => {
    const { h } = renderRow(dueFacts());
    await userEvent.click(screen.getByTestId("work-row-primary-lead-1"));
    expect(h.onAction).toHaveBeenCalledExactlyOnceWith("start-call", "lead-1");
  });
  it("primary for New reply is Reply (opens the thread)", async () => {
    const { h } = renderRow(workFacts("new_reply", "5", { at: "2026-10-14T14:12:00Z", kind: "text" }));
    await userEvent.click(screen.getByTestId("work-row-primary-lead-1"));
    expect(h.onOpenText).toHaveBeenCalledExactlyOnceWith("lead-1");
  });
  it("primary for Nothing planned is Set drip", async () => {
    const { h } = renderRow(workFacts("nothing_planned", "15", {}));
    await userEvent.click(screen.getByTestId("work-row-primary-lead-1"));
    expect(h.onSetDrip).toHaveBeenCalledExactlyOnceWith("lead-1");
  });
  it("Nothing planned with a waiting text: primary is Send text (opens the thread), not Set drip", async () => {
    const { h } = renderRow(workFacts("nothing_planned", "6a", { variant: "text_waiting", at: "2026-10-14T15:00:00Z" }, { labels: ["text_waiting"] }));
    expect(screen.getByTestId("work-row-primary-lead-1")).toHaveTextContent("Send text");
    await userEvent.click(screen.getByTestId("work-row-primary-lead-1"));
    expect(h.onOpenText).toHaveBeenCalledExactlyOnceWith("lead-1");
    expect(h.onSetDrip).not.toHaveBeenCalled();
  });
  it("Broken primary is the first item's fix", async () => {
    const item = { kind: "drip_stuck" as const, action: "fix_drip" as const, at: null, refId: "e1" };
    const { h } = renderRow(workFacts("broken", "6", { kind: "drip_stuck" }, { broken: [item] }));
    expect(screen.getByTestId("work-row-primary-lead-1")).toHaveTextContent("Fix drip");
    await userEvent.click(screen.getByTestId("work-row-primary-lead-1"));
    expect(h.onBrokenAction).toHaveBeenCalledExactlyOnceWith(item, "lead-1");
  });
  it("Waiting rows show only Open lead", () => {
    renderRow(workFacts("texted_last", "13", { at: "2026-10-14T15:00:00Z", by: "human" }));
    expect(screen.queryByTestId("work-row-primary-lead-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("work-row-open-lead-lead-1")).toBeInTheDocument();
  });
  it("no phone disables Call and shows why", () => {
    renderRow(workFacts("due", "4", { at: "2026-10-14T14:30:00Z" }, { hasPhone: false, labels: ["no_phone"] }));
    expect(screen.getByTestId("work-row-primary-lead-1")).toBeDisabled();
    expect(screen.getByTestId("work-row-disabled-reason-call-lead-1")).toHaveTextContent("No phone number");
    expect(screen.getByTestId("work-row-label-no_phone-lead-1")).toHaveTextContent("No phone");
  });
  it("shows the opened-from-lead tag and label chips", () => {
    renderRow(dueFacts(), { openedFromLead: true });
    expect(screen.getByText("Opened from lead page")).toBeInTheDocument();
    renderRow(workFacts("due", "4", {}, { labels: ["norma_calling"], propertyId: "lead-2" }));
    expect(screen.getByTestId("work-row-label-norma_calling-lead-2")).toHaveTextContent("Norma calling");
  });
  it("exposes the slot icon", () => {
    renderRow(workFacts("new_reply", "5", {}, { latestInbound: { at: "2026-10-14T14:12:00Z", kind: "text", messageId: "m", handled: false, contactOnly: false } }));
    expect(screen.getByRole("img", { name: "New reply not answered" })).toBeInTheDocument();
  });
});

describe("expanded row", () => {
  it("shows labeled lines, the conversation slot and the six buttons", () => {
    renderRow(dueFacts(), { expanded: true, conversation: <p>convo here</p> });
    const lines = screen.getByTestId("work-row-lines-lead-1");
    for (const label of ["DRIP", "NEXT STEP", "LAST TOUCH", "ATTEMPTS", "MOTIVATION"]) expect(lines).toHaveTextContent(label);
    expect(lines).not.toHaveTextContent("CLEARS");
    expect(screen.getByTestId("work-row-conversation-lead-1")).toHaveTextContent("convo here");
    for (const t of ["call", "log-attempt", "call-today", "set-drip", "open-lead", "more"]) expect(screen.getByTestId(`work-row-${t}-lead-1`)).toBeInTheDocument();
    expect(screen.getByTestId("work-row-toggle-lead-1")).toHaveAttribute("aria-expanded", "true");
  });
  it("the reason primary is a full-width extra button when it is not Call", async () => {
    const { h } = renderRow(workFacts("new_reply", "5", { at: "2026-10-14T14:12:00Z" }), { expanded: true });
    expect(screen.getByTestId("work-row-primary-lead-1").className).toContain("w-full");
    await userEvent.click(screen.getByTestId("work-row-primary-lead-1"));
    expect(h.onOpenText).toHaveBeenCalledWith("lead-1");
  });
  it("Call, Log attempt, Call today, Set drip fire their callbacks", async () => {
    const { h } = renderRow(dueFacts(), { expanded: true });
    await userEvent.click(screen.getByTestId("work-row-call-lead-1"));
    await userEvent.click(screen.getByTestId("work-row-log-attempt-lead-1"));
    await userEvent.click(screen.getByTestId("work-row-call-today-lead-1"));
    await userEvent.click(screen.getByTestId("work-row-set-drip-lead-1"));
    expect(h.onAction.mock.calls).toEqual([["start-call", "lead-1"], ["log-attempt", "lead-1"]]);
    expect(h.onCallToday).toHaveBeenCalledExactlyOnceWith("lead-1");
    expect(h.onSetDrip).toHaveBeenCalledExactlyOnceWith("lead-1");
    expect(h.onToggle).not.toHaveBeenCalled();
  });
  it("More menu is stage-aware and fires the existing action kinds", async () => {
    const { h } = renderRow(workFacts("due", "4", {}, { stage: "offer_sent" }), { expanded: true });
    await userEvent.click(screen.getByTestId("work-row-more-lead-1"));
    expect(await screen.findByTestId("work-row-menu-decline-offer-lead-1")).toHaveTextContent("Offer declined");
    expect(screen.queryByTestId("work-row-menu-ready-for-offer-lead-1")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("work-row-menu-decline-offer-lead-1"));
    expect(h.onAction).toHaveBeenCalledExactlyOnceWith("decline-offer", "lead-1");
    expect(h.onToggle).not.toHaveBeenCalled();
  });
  it("More > Text opens the thread; Call with coach uses the coach context", async () => {
    const coach = { call: vi.fn(), disabled: false };
    const h = handlers();
    render(
      <CoachCallContext.Provider value={coach}>
        <WorkRow facts={dueFacts()} now={NOW} expanded canAct {...h} />
      </CoachCallContext.Provider>,
    );
    await userEvent.click(screen.getByTestId("work-row-more-lead-1"));
    await userEvent.click(await screen.findByTestId("work-row-menu-text-lead-1"));
    expect(h.onOpenText).toHaveBeenCalledWith("lead-1");
    await userEvent.click(screen.getByTestId("work-row-more-lead-1"));
    await userEvent.click(await screen.findByTestId("work-row-menu-coach-lead-1"));
    expect(coach.call).toHaveBeenCalledExactlyOnceWith("lead-1");
  });
  it("Call today rows show CLEARS and Undo", async () => {
    const { h } = renderRow(workFacts("call_today", "2", { pinnedAt: "2026-10-14T13:05:00Z" }), { expanded: true });
    expect(screen.getByTestId("work-row-lines-lead-1")).toHaveTextContent("CLEARS");
    expect(screen.queryByTestId("work-row-call-today-lead-1")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("work-row-undo-lead-1"));
    expect(h.onUndoCallToday).toHaveBeenCalledExactlyOnceWith("lead-1");
  });
  it("pinnedUndo shows Undo (collapsed too) on a row that is not the active pin", async () => {
    const { h } = renderRow(dueFacts(), { pinnedUndo: true });
    await userEvent.click(screen.getByTestId("work-row-undo-lead-1"));
    expect(h.onUndoCallToday).toHaveBeenCalledWith("lead-1");
    expect(h.onToggle).not.toHaveBeenCalled();
  });
  it("lists every broken item with its fix; Dismiss only when refId is set", async () => {
    const broken = [
      { kind: "text_not_delivered" as const, action: "resend" as const, at: "2026-10-14T15:00:00Z", refId: "led-1" },
      { kind: "norma_needs_review" as const, action: "review" as const, at: null, refId: null },
    ];
    const { h } = renderRow(workFacts("broken", "6", { kind: "text_not_delivered" }, { broken }), { expanded: true });
    expect(screen.getByTestId("work-row-broken-lead-1")).toHaveTextContent("Norma call needs review");
    expect(screen.getByTestId("work-row-broken-fix-0-lead-1")).toHaveTextContent("Resend");
    expect(screen.getByTestId("work-row-broken-fix-1-lead-1")).toHaveTextContent("Review");
    expect(screen.getByTestId("work-row-broken-dismiss-0-lead-1")).toBeInTheDocument();
    expect(screen.queryByTestId("work-row-broken-dismiss-1-lead-1")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("work-row-broken-fix-1-lead-1"));
    expect(h.onBrokenAction).toHaveBeenCalledWith(broken[1], "lead-1");
    await userEvent.click(screen.getByTestId("work-row-broken-dismiss-0-lead-1"));
    expect(h.onDismissBroken).toHaveBeenCalledExactlyOnceWith("lead-1", "led-1");
  });
  it("has no Not today control", () => {
    renderRow(dueFacts(), { expanded: true });
    expect(screen.queryByText(/not today/i)).not.toBeInTheDocument();
  });
});

describe("canAct = false (owner viewing a rep)", () => {
  it("disables every button except Open lead", async () => {
    const item = { kind: "text_not_delivered" as const, action: "resend" as const, at: null, refId: "r" };
    const { h } = renderRow(workFacts("broken", "6", { kind: "text_not_delivered" }, { broken: [item] }), { expanded: true, canAct: false });
    for (const button of screen.getAllByRole("button")) {
      if (button.getAttribute("data-testid") === "work-row-toggle-lead-1") continue; // reading is allowed
      expect(button, button.textContent ?? "").toBeDisabled();
    }
    const link = screen.getByTestId("work-row-open-lead-lead-1");
    expect(link).toHaveAttribute("href", "/leads/lead-1");
    await userEvent.click(screen.getByTestId("work-row-call-lead-1"));
    expect(h.onAction).not.toHaveBeenCalled();
  });
  it("collapsed buttons are disabled too, rows can still expand", async () => {
    const { h } = renderRow(dueFacts(), { canAct: false });
    expect(screen.getByTestId("work-row-primary-lead-1")).toBeDisabled();
    await userEvent.click(screen.getByText("Owner lead-1"));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("busy", () => {
  it("disables the action buttons", () => {
    renderRow(dueFacts(), { busy: true, expanded: true });
    expect(screen.getByTestId("work-row-call-lead-1")).toBeDisabled();
    expect(screen.getByTestId("work-row-more-lead-1")).toBeDisabled();
    expect(screen.getByTestId("work-row-open-lead-lead-1")).not.toHaveAttribute("disabled");
  });
});
