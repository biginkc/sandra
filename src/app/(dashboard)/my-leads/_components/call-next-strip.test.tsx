import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CallNextStrip } from "./call-next-strip";
import { SNAPSHOT_AT, stripItem, queueRowFixture } from "./call-next-test-support";
import type { MyLeadsStripProps } from "./types";

const props = (over: Partial<MyLeadsStripProps> = {}): MyLeadsStripProps => ({
  rows: [],
  excluded: [],
  hiddenCount: 0,
  snapshotAt: SNAPSHOT_AT,
  canAct: true,
  triageOpen: false,
  triage: null,
  triageLoading: false,
  triageError: null,
  onToggleTriage: vi.fn(),
  onLoadMoreTriage: vi.fn(),
  onCall: vi.fn(),
  onCallToday: vi.fn(),
  onNotToday: vi.fn(),
  onDeadNurture: vi.fn(),
  ...over,
});

describe("<CallNextStrip />", () => {
  it("renders the rows in the order given, each with its reason", () => {
    const rows = [
      stripItem("a", "pinned_call_today"),
      stripItem("b", "appointment_overdue", { reasonAt: "2026-10-03T15:00:00Z" }),
      stripItem("c", "inbound_text"),
    ];
    render(<CallNextStrip {...props({ rows })} />);
    const strip = screen.getByTestId("call-next-strip");
    const listed = within(strip).getAllByTestId(/^call-next-row-/).map((el) => el.getAttribute("data-testid"));
    expect(listed).toEqual(["call-next-row-a", "call-next-row-b", "call-next-row-c"]);
    expect(screen.getByTestId("call-next-reason-a")).toHaveTextContent("Pinned: call today");
    expect(screen.getByTestId("call-next-reason-b")).toHaveTextContent("Callback 2 days overdue");
    expect(screen.getByTestId("call-next-reason-c")).toHaveTextContent("Texted you 2d ago");
    expect(screen.getByTestId("call-next-count")).toHaveTextContent("3 shown");
  });

  it("says so when nobody needs a call", () => {
    render(<CallNextStrip {...props()} />);
    expect(screen.getByText("Nobody needs a call right now.")).toBeInTheDocument();
    expect(screen.queryByTestId("call-next-hidden")).not.toBeInTheDocument();
  });

  it("shows the hidden count and a collapsed list of leads that need a phone number", async () => {
    render(
      <CallNextStrip
        {...props({
          hiddenCount: 4,
          excluded: [
            { propertyId: "x", address: "9 Elm", reason: "no_phone" },
            { propertyId: "y", address: "7 Oak", reason: "contact_dnc" },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("call-next-hidden")).toHaveTextContent("4 hidden today");
    expect(screen.queryByTestId("call-next-excluded")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("call-next-excluded-toggle"));
    const list = screen.getByTestId("call-next-excluded");
    expect(list).toHaveTextContent("9 Elm");
    expect(list).toHaveTextContent("no phone number");
    expect(list).toHaveTextContent("7 Oak");
    expect(list).toHaveTextContent("do not contact");
  });

  it("toggles triage and reflects the pressed state", async () => {
    const onToggleTriage = vi.fn();
    const { rerender } = render(<CallNextStrip {...props({ onToggleTriage })} />);
    const chip = screen.getByTestId("call-next-triage-chip");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(chip);
    expect(onToggleTriage).toHaveBeenCalledOnce();
    rerender(
      <CallNextStrip
        {...props({
          triageOpen: true,
          triage: { rows: [{ propertyId: "t1", lastTouchAt: null, row: queueRowFixture("t1") }], totalCount: 1, cursor: null },
        })}
      />,
    );
    expect(screen.getByTestId("call-next-triage-chip")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("call-next-triage")).toBeInTheDocument();
    expect(screen.getByTestId("call-next-row-t1")).toBeInTheDocument();
    expect(screen.getByTestId("call-next-reason-t1")).toHaveTextContent("Not touched yet");
  });

  it("shows a save error as an alert", () => {
    render(<CallNextStrip {...props({ error: "The change could not be saved. Please retry." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
  });

  it("passes row actions straight through", async () => {
    const p = props({ rows: [stripItem("a")] });
    render(<CallNextStrip {...p} />);
    await userEvent.click(screen.getByTestId("call-next-action-call-a"));
    expect(p.onCall).toHaveBeenCalledExactlyOnceWith("a");
    await userEvent.click(screen.getByTestId("call-next-menu-a"));
    await userEvent.click(await screen.findByTestId("call-next-action-dead-nurture-a"));
    expect(p.onDeadNurture).toHaveBeenCalledExactlyOnceWith("a");
  });
});
