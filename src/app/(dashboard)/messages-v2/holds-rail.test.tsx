import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ageTone, HoldsRail } from "./holds-rail";
import type { OpenHold, PipelineRunStep, RunWithSteps } from "./types";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const hold = (
  id: string,
  minsAgo: number,
  steps: PipelineRunStep[] = [],
  over: Partial<RunWithSteps> = {},
  withRun = true,
): OpenHold<RunWithSteps> => ({
  id,
  property_id: id,
  conversation_id: `c-${id}`,
  sources: ["needs_attention"],
  since: iso(minsAgo),
  reason: "Needs attention",
  run: withRun
    ? {
        id: `r-${id}`,
        org_id: "o",
        inbound_message_id: `m-${id}`,
        property_id: id,
        contact_id: null,
        conversation_id: `c-${id}`,
        status: "closed",
        mode: "automatic",
        final_outcome: null,
        reason: null,
        classification_run_id: null,
        claim_id: null,
        outbound_message_id: null,
        inbound_preview: `preview ${id}`,
        started_at: iso(minsAgo),
        completed_at: iso(minsAgo),
        steps,
        ...over,
      }
    : null,
});
const holdStep = (
  run_id: string,
  name: string,
  detail: Record<string, unknown> = {},
): PipelineRunStep => ({
  id: `s-${run_id}`,
  run_id,
  org_id: "o",
  seq: 1,
  kind: "hold",
  name,
  result: "held",
  detail,
  created_at: "",
});

describe("ageTone", () => {
  it("is neutral under an hour, amber over 1h, red over 4h", () => {
    expect(ageTone(30 * 60_000)).toBe("neutral");
    expect(ageTone(61 * 60_000)).toBe("amber");
    expect(ageTone(241 * 60_000)).toBe("red");
  });
});

describe("HoldsRail", () => {
  it("renders holds in the order given with why-held and age badges", () => {
    render(
      <HoldsRail
        holds={[
          hold("a", 300, [holdStep("a", "needs_human_review")]),
          hold("b", 90),
          hold("c", 5),
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    const cards = screen.getAllByTestId("hold-card");
    expect(cards).toHaveLength(3);
    expect(
      within(cards[0]).getByText(/needs_human_review/),
    ).toBeInTheDocument();
    expect(within(cards[0]).getByTestId("hold-age")).toHaveAttribute(
      "data-tone",
      "red",
    );
    expect(within(cards[1]).getByTestId("hold-age")).toHaveAttribute(
      "data-tone",
      "amber",
    );
    expect(within(cards[2]).getByTestId("hold-age")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
  });

  it("falls back to the run reason when there is no hold step", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5, [], { reason: "low_confidence" })]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/low_confidence/)).toBeInTheDocument();
  });

  it("renders a runless fallback card from the hold itself (older than the seam)", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5, [], {}, false)]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("hold-card")).toHaveTextContent(
      "Needs attention",
    );
    expect(screen.queryByText(/preview a/)).not.toBeInTheDocument();
  });

  it("shows the hold step even when the run status is closed", () => {
    render(
      <HoldsRail
        holds={[
          hold("a", 5, [holdStep("a", "needs_human_review")], {
            status: "closed",
          }),
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/needs_human_review/)).toBeInTheDocument();
  });

  it("disables every action with a Phase 2 tooltip", () => {
    render(<HoldsRail holds={[hold("a", 5)]} labels={new Map()} nowMs={NOW} />);
    for (const name of ["Send", "Edit", "Take over", "Assign", "Dismiss"]) {
      const btn = screen.getByRole("button", { name: new RegExp(`^${name}`) });
      expect(btn).toBeDisabled();
      expect(btn.closest("[title]")).toHaveAttribute("title", "Phase 2");
    }
  });

  it("shows the empty state and the shadow scorecard placeholder", () => {
    render(<HoldsRail holds={[]} labels={new Map()} nowMs={NOW} />);
    expect(screen.getByText(/no open holds/i)).toBeInTheDocument();
    expect(
      screen.getByText(/available after 2h of shadow traffic/i),
    ).toBeInTheDocument();
  });
});

describe("HoldsRail degraded states", () => {
  const meta = (over: Partial<import("./types").HoldsMeta> = {}) => ({
    total: 0,
    shown: 0,
    truncated: false,
    totalState: "exact" as const,
    failed: [],
    contextErrors: [],
    ...over,
  });
  it("shows an explicit unavailable state, not an empty rail, when a source failed", () => {
    render(
      <HoldsRail
        holds={[]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ failed: ["jev_decision"] })}
      />,
    );
    expect(screen.getByTestId("holds-unavailable")).toHaveTextContent(
      "Holds unavailable — Jev decision query failed",
    );
    expect(screen.queryByText("No open holds.")).toBeNull();
  });
  it("shows total and shown when truncated", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ total: 350, shown: 1, truncated: true })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /350, 1 shown/ }),
    ).toBeInTheDocument();
  });
  it("labels a capped total as incomplete and an unavailable count explicitly", () => {
    const { unmount } = render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({
          total: 2000,
          shown: 1,
          truncated: true,
          totalState: "capped",
        })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /2,000\+ holds \(incomplete\)/ }),
    ).toBeInTheDocument();
    unmount();
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ totalState: "unavailable" })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /count unavailable/ }),
    ).toBeInTheDocument();
  });
  it("shows 'draft status unavailable' when the drafts query failed, without hiding holds", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ failed: ["pending_draft"] })}
      />,
    );
    expect(screen.getByTestId("holds-unavailable")).toHaveTextContent(
      "Holds unavailable — reply draft",
    );
    expect(screen.getAllByTestId("hold-card")).toHaveLength(1);
  });
  it("never says 'No open holds' when only the drafts query failed", () => {
    render(
      <HoldsRail
        holds={[]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ failed: ["pending_draft"], totalState: "unavailable" })}
      />,
    );
    expect(screen.getByTestId("holds-unavailable")).toHaveTextContent(
      "Holds unavailable — reply draft",
    );
    expect(screen.queryByText("No open holds.")).toBeNull();
  });
  it("labels a truncated-source total as incomplete", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({
          total: 1,
          shown: 1,
          truncated: true,
          totalState: "incomplete",
        })}
      />,
    );
    const h = screen.getByRole("heading", { name: /incomplete/ });
    expect(h).toHaveTextContent("1+ holds (incomplete)");
    expect(h).not.toHaveTextContent("2,000");
  });
  it("shows the dead-letter marker on a hold with saved reply text", () => {
    render(
      <HoldsRail
        holds={[{ ...hold("a", 5), dead_letter: true }, hold("b", 5)]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getAllByTestId("dead-letter")).toHaveLength(1);
    expect(screen.getByTestId("dead-letter")).toHaveTextContent(
      "reply text saved for review",
    );
  });
  it("shows delivered-late instead of saved-for-review when sent_late exists", () => {
    render(
      <HoldsRail
        holds={[{ ...hold("a", 5), dead_letter: true, dead_letter_late: true }]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getByTestId("dead-letter-late")).toHaveTextContent(
      "reply was delivered late — do not re-send",
    );
    expect(screen.queryByTestId("dead-letter")).toBeNull();
    expect(screen.queryByText(/saved for review/)).toBeNull();
  });
  it("renders a send_timeout_then_sent flag-only hold as muted informational", () => {
    render(
      <HoldsRail
        holds={[
          {
            ...hold("a", 5),
            flag_reason: "send_timeout_then_sent",
            dead_letter_late: true,
          },
          { ...hold("b", 5), flag_reason: "send_timeout" },
        ]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    const cards = screen.getAllByTestId("hold-card");
    expect(cards[0]).toHaveAttribute("data-informational", "true");
    expect(cards[0]).toHaveClass("opacity-70");
    expect(cards[1]).not.toHaveAttribute("data-informational");
    expect(
      within(cards[0]).getByText("Informational — already delivered"),
    ).toBeInTheDocument();
  });
  it("says dead-letter status unavailable when that lookup failed", () => {
    render(
      <HoldsRail
        holds={[hold("a", 5)]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ deadLetterUnavailable: true })}
      />,
    );
    expect(screen.getByTestId("dead-letter-unavailable")).toHaveTextContent(
      "dead-letter status unavailable",
    );
  });
  it("flags context lookup errors", () => {
    render(
      <HoldsRail
        holds={[]}
        labels={new Map()}
        nowMs={NOW}
        meta={meta({ contextErrors: ["step lookup"] })}
      />,
    );
    expect(screen.getByTestId("holds-context-errors")).toHaveTextContent(
      "step lookup",
    );
  });
  it("shows 'age unknown' when the hold time is unknown", () => {
    const h = { ...hold("a", 5), since: null };
    render(<HoldsRail holds={[h]} labels={new Map()} nowMs={NOW} />);
    expect(screen.getByTestId("hold-age")).toHaveTextContent("age unknown");
  });
  it("shows the draft-held fact (never a body) when a pending draft exists", () => {
    render(
      <HoldsRail
        holds={[{ ...hold("a", 5), draft_held: true }, hold("b", 5)]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    expect(screen.getAllByTestId("draft-held")).toHaveLength(1);
    expect(screen.getByTestId("draft-held")).toHaveTextContent(
      "Claude draft held (Phase 1 to act)",
    );
  });
});
