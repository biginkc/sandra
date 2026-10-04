import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TriageList, type TriageListProps } from "./triage-list";
import { SNAPSHOT_AT, queueRowFixture } from "./call-next-test-support";

const base = (over: Partial<TriageListProps> = {}): TriageListProps => ({
  triage: null,
  loading: false,
  error: null,
  now: new Date(SNAPSHOT_AT),
  canAct: true,
  onLoadMore: vi.fn(),
  onCall: vi.fn(),
  onCallToday: vi.fn(),
  onNotToday: vi.fn(),
  onDeadNurture: vi.fn(),
  ...over,
});
const entry = (id: string, lastTouchAt: string | null) => ({ propertyId: id, lastTouchAt, row: queueRowFixture(id) });

describe("<TriageList />", () => {
  it("shows a loading line before the first page", () => {
    render(<TriageList {...base()} />);
    expect(screen.getByText("Loading untouched leads…")).toBeInTheDocument();
  });

  it("lists leads with how long since the last touch and pages with Load more", async () => {
    const props = base({
      triage: { rows: [entry("a", null), entry("b", "2026-09-01T15:00:00Z")], totalCount: 30, cursor: { touch: "2026-09-01T15:00:00Z", property: "b" } },
    });
    render(<TriageList {...props} />);
    expect(screen.getByText("30 leads untouched for 14+ days with no next step")).toBeInTheDocument();
    expect(screen.getByTestId("call-next-reason-a")).toHaveTextContent("Not touched yet");
    expect(screen.getByTestId("call-next-reason-b")).toHaveTextContent("Longest since last touch · 34d");
    await userEvent.click(screen.getByTestId("call-next-triage-more"));
    expect(props.onLoadMore).toHaveBeenCalledOnce();
  });

  it("has no Load more on the last page and an empty message with no rows", () => {
    render(<TriageList {...base({ triage: { rows: [], totalCount: 0, cursor: null } })} />);
    expect(screen.getByText("Nothing to triage.")).toBeInTheDocument();
    expect(screen.queryByTestId("call-next-triage-more")).not.toBeInTheDocument();
  });

  it("shows an error", () => {
    render(<TriageList {...base({ error: "The triage list could not load." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not load");
  });

  it("Dead / Nurture on a triage row goes through the same handler", async () => {
    const props = base({ triage: { rows: [entry("a", null)], totalCount: 1, cursor: null } });
    render(<TriageList {...props} />);
    await userEvent.click(screen.getByTestId("call-next-menu-a"));
    await userEvent.click(await screen.findByTestId("call-next-action-dead-nurture-a"));
    expect(props.onDeadNurture).toHaveBeenCalledExactlyOnceWith("a");
  });
});
