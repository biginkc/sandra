import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("../actions", () => ({
  loadLeadVars: vi.fn(),
  sendSmsFromLead: vi.fn(),
}));

import { InlineReply } from "./inline-reply";

describe("<InlineReply /> disabled explanations", () => {
  it("stacks the queue control at narrow widths instead of forcing overflow", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
      />,
    );

    expect(screen.getByTestId("inline-reply-send")).toHaveClass(
      "w-full",
      "sm:w-auto",
    );
  });

  it("renders an adjacent compact action with the Outbox explanation", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone="+18165550123"
        footerAction={<button type="button">Add note</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Add note" })).toBeVisible();
    expect(screen.getByText(/adds the message to Outbox/i)).toBeVisible();
  });

  it("explains that a missing contact prevents a reply", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId={null}
        homeownerPhone={null}
      />,
    );

    expect(screen.getByText(/No homeowner contact/i)).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the supplied phone restriction instead of a misleading generic error", () => {
    render(
      <InlineReply
        propertyId="property-1"
        homeownerContactId="contact-1"
        homeownerPhone={null}
        phoneUnavailableMessage="The saved number is a landline, so SMS is unavailable."
      />,
    );

    expect(screen.getByText(/saved number is a landline/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /queue reply/i })).toBeNull();
  });
});
