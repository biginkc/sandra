import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LeadIdentityActions } from "./lead-identity-actions";

describe("<LeadIdentityActions />", () => {
  it("keeps working state, next action, and signals in the final responsive order", () => {
    render(
      <LeadIdentityActions
        workingState={<button>Stage</button>}
        nextAction={<button>Next action</button>}
        recordSignals={<span>SMS: OK to text</span>}
      />,
    );

    const panel = screen.getByTestId("lead-working-state-bar");
    const working = screen.getByTestId("lead-working-state-controls");
    const next = screen.getByRole("button", { name: "Next action" });
    const signals = screen.getByTestId("lead-record-signals");

    expect(panel).toHaveClass("[&_button]:min-h-9");
    expect(working).toHaveClass("flex-wrap");
    expect(working.compareDocumentPosition(next)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(next.compareDocumentPosition(signals)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
