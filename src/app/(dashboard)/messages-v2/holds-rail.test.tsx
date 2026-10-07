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
        id: `r-${id}`, org_id: "o", inbound_message_id: `m-${id}`, property_id: id, contact_id: null,
        conversation_id: `c-${id}`, status: "closed", mode: "automatic", final_outcome: null,
        reason: null, classification_run_id: null, claim_id: null, outbound_message_id: null,
        inbound_preview: `preview ${id}`, started_at: iso(minsAgo), completed_at: iso(minsAgo), steps, ...over,
      }
    : null,
});
const holdStep = (run_id: string, name: string, detail: Record<string, unknown> = {}): PipelineRunStep => ({
  id: `s-${run_id}`, run_id, org_id: "o", seq: 1, kind: "hold", name, result: "held", detail, created_at: "",
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
        holds={[hold("a", 300, [holdStep("a", "needs_human_review")]), hold("b", 90), hold("c", 5)]}
        labels={new Map()}
        nowMs={NOW}
      />,
    );
    const cards = screen.getAllByTestId("hold-card");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]).getByText(/needs_human_review/)).toBeInTheDocument();
    expect(within(cards[0]).getByTestId("hold-age")).toHaveAttribute("data-tone", "red");
    expect(within(cards[1]).getByTestId("hold-age")).toHaveAttribute("data-tone", "amber");
    expect(within(cards[2]).getByTestId("hold-age")).toHaveAttribute("data-tone", "neutral");
  });

  it("falls back to the run reason when there is no hold step", () => {
    render(<HoldsRail holds={[hold("a", 5, [], { reason: "low_confidence" })]} labels={new Map()} nowMs={NOW} />);
    expect(screen.getByText(/low_confidence/)).toBeInTheDocument();
  });

  it("renders a runless fallback card from the hold itself (older than the seam)", () => {
    render(<HoldsRail holds={[hold("a", 5, [], {}, false)]} labels={new Map()} nowMs={NOW} />);
    expect(screen.getByTestId("hold-card")).toHaveTextContent("Needs attention");
    expect(screen.queryByText(/preview a/)).not.toBeInTheDocument();
  });

  it("shows the hold step even when the run status is closed", () => {
    render(
      <HoldsRail holds={[hold("a", 5, [holdStep("a", "needs_human_review")], { status: "closed" })]} labels={new Map()} nowMs={NOW} />,
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
    expect(screen.getByText(/available after 2h of shadow traffic/i)).toBeInTheDocument();
  });
});
