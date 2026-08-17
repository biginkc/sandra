import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeadIdentityActions } from "./lead-identity-actions";

describe("<LeadIdentityActions />", () => {
  it("preserves the narrow identity and action priority before secondary controls", () => {
    render(
      <LeadIdentityActions
        workingState={<button>Stage</button>}
        primaryActions={<button>Book appointment</button>}
        recordSignals={<span>SMS: OK to text</span>}
        automationActions={<button>Run skip trace</button>}
      />,
    );

    const panel = screen.getByTestId("lead-identity-actions");
    const working = screen.getByTestId("lead-working-state-controls");
    const primary = screen.getByTestId("lead-primary-actions");
    const secondary = screen.getByTestId("lead-secondary-actions");

    expect(panel).toHaveClass("rounded-xl");
    expect(panel).toHaveClass("[&_button]:min-h-11", "sm:[&_button]:min-h-8");
    expect(working).toHaveClass("flex-col", "sm:flex-row");
    expect(primary).toHaveClass("flex-col", "sm:flex-row");
    expect(working.compareDocumentPosition(primary)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(primary.compareDocumentPosition(secondary)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
