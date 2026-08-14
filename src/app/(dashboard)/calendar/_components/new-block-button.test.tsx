import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewBlockButton } from "./new-block-button";

// BookAppointmentPopover's own internals (calendar, time/duration selects,
// timezone lookup, submit) are covered by book-appointment-popover.test.tsx
// — stub it here so this suite only asserts NewBlockButton wires it up in
// personal-block mode (no propertyId/contactId) with the right trigger copy.
vi.mock("@/components/appointments/book-appointment-popover", () => ({
  BookAppointmentPopover: (props: {
    propertyId?: string;
    contactId?: string;
    currentUserId: string | null;
    triggerLabel?: string;
    triggerVariant?: string;
    triggerSize?: string;
  }) => (
    <div data-testid="stub-book-appointment-popover">
      <span data-testid="stub-property-id">{props.propertyId ?? "none"}</span>
      <span data-testid="stub-contact-id">{props.contactId ?? "none"}</span>
      <span data-testid="stub-current-user-id">{props.currentUserId}</span>
      <button type="button" data-testid="stub-trigger">
        {props.triggerLabel}
      </button>
    </div>
  ),
}));

describe("<NewBlockButton />", () => {
  it("renders the personal-block booking trigger with no property/contact context", () => {
    render(<NewBlockButton currentUserId="user-1" />);

    expect(screen.getByTestId("stub-book-appointment-popover")).toBeInTheDocument();
    expect(screen.getByTestId("stub-property-id")).toHaveTextContent("none");
    expect(screen.getByTestId("stub-contact-id")).toHaveTextContent("none");
    expect(screen.getByTestId("stub-current-user-id")).toHaveTextContent("user-1");
    expect(screen.getByTestId("stub-trigger")).toHaveTextContent("+ New");
  });
});
