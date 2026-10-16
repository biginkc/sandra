import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoachCallContext } from "./coach-call-context";
import { CallNextRowView } from "./call-next-row";
import { SNAPSHOT_AT, stripItem, queueRowFixture } from "./call-next-test-support";

const handlers = () => ({
  onCall: vi.fn(),
  onCallToday: vi.fn(),
  onNotToday: vi.fn(),
  onDeadNurture: vi.fn(),
});
const renderRow = (over: Partial<Parameters<typeof CallNextRowView>[0]> = {}, h = handlers()) => {
  render(
    <ul>
      <CallNextRowView
        item={stripItem("lead-1", "inbound_text")}
        now={new Date(SNAPSHOT_AT)}
        canAct
        {...h}
        {...over}
      />
    </ul>,
  );
  return h;
};

describe("<CallNextRowView />", () => {
  it("shows name, address and a plain-text reason with stable test ids", () => {
    renderRow();
    expect(screen.getByTestId("call-next-row-lead-1")).toBeInTheDocument();
    expect(screen.getByText("Owner lead-1")).toBeInTheDocument();
    expect(screen.getByText("lead-1 Main St")).toBeInTheDocument();
    expect(screen.getByTestId("call-next-reason-lead-1")).toHaveTextContent("Texted you 2d ago");
  });

  it("names the temperature in text, not only by colour", () => {
    renderRow({ item: { ...stripItem("lead-1"), row: queueRowFixture("lead-1", { temperature: "hot" }) } });
    expect(screen.getByText("hot lead")).toBeInTheDocument();
  });

  it("Call fires its handler once with the lead id", async () => {
    const h = renderRow();
    await userEvent.click(screen.getByTestId("call-next-action-call-lead-1"));
    expect(h.onCall).toHaveBeenCalledExactlyOnceWith("lead-1");
    expect(h.onCallToday).not.toHaveBeenCalled();
  });

  it.each([
    ["call-next-action-call-today-lead-1", "onCallToday"],
    ["call-next-action-not-today-lead-1", "onNotToday"],
    ["call-next-action-dead-nurture-lead-1", "onDeadNurture"],
  ] as const)("menu item %s calls %s once", async (testId, handler) => {
    const h = renderRow();
    await userEvent.click(screen.getByTestId("call-next-menu-lead-1"));
    await userEvent.click(await screen.findByTestId(testId));
    expect(h[handler]).toHaveBeenCalledExactlyOnceWith("lead-1");
    for (const other of ["onCall", "onCallToday", "onNotToday", "onDeadNurture"] as const)
      if (other !== handler) expect(h[other]).not.toHaveBeenCalled();
  });

  it("is operable from the keyboard", async () => {
    const h = renderRow();
    const trigger = screen.getByTestId("call-next-menu-lead-1");
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const item = await screen.findByTestId("call-next-action-not-today-lead-1");
    expect(item).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(
      [h.onCallToday, h.onNotToday, h.onDeadNurture].reduce((n, fn) => n + fn.mock.calls.length, 0),
    ).toBe(1);
  });

  it("disables Call and the menu when the viewer is not the member (owner viewing a rep)", () => {
    renderRow({ canAct: false });
    expect(screen.getByTestId("call-next-action-call-lead-1")).toBeDisabled();
    expect(screen.getByTestId("call-next-menu-lead-1")).toBeDisabled();
  });

  it.each([
    ["a DNC contact", { contactDnc: true }],
    ["no phone numbers", { phones: [], phone: null }],
    ["only blank phone numbers", { phones: [" "] }],
  ])("disables Call (but keeps the menu) for %s", (_label, over) => {
    renderRow({ item: { ...stripItem("lead-1"), row: queueRowFixture("lead-1", over) } });
    expect(screen.getByTestId("call-next-action-call-lead-1")).toBeDisabled();
    expect(screen.getByTestId("call-next-menu-lead-1")).toBeEnabled();
  });

  it("disables both while this lead's change is saving", () => {
    renderRow({ busy: true });
    expect(screen.getByTestId("call-next-action-call-lead-1")).toBeDisabled();
    expect(screen.getByTestId("call-next-menu-lead-1")).toBeDisabled();
  });

  it("shows no Call with coach without the Dialpad route", () => {
    renderRow();
    expect(screen.queryByText("Call with coach")).not.toBeInTheDocument();
  });

  it("with the route on, shows Call with coach and it opens the softphone path for that lead", async () => {
    const coach = vi.fn();
    const h = handlers();
    render(
      <CoachCallContext.Provider value={{ call: coach, disabled: false }}>
        <ul>
          <CallNextRowView item={stripItem("lead-1", "inbound_text")} now={new Date(SNAPSHOT_AT)} canAct {...h} />
        </ul>
      </CoachCallContext.Provider>,
    );
    await userEvent.click(screen.getByText("Call with coach"));
    expect(coach).toHaveBeenCalledExactlyOnceWith("lead-1");
    expect(h.onCall).not.toHaveBeenCalled();
  });

  it("disables Call with coach while a Dialpad call is active", () => {
    render(
      <CoachCallContext.Provider value={{ call: vi.fn(), disabled: true }}>
        <ul>
          <CallNextRowView item={stripItem("lead-1", "inbound_text")} now={new Date(SNAPSHOT_AT)} canAct {...handlers()} />
        </ul>
      </CoachCallContext.Provider>,
    );
    expect(screen.getByText("Call with coach")).toBeDisabled();
  });
});
