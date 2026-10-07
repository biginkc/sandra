import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ThreadRow } from "../queries";

import { ThreadsNeedingAttention } from "./threads-needing-attention";

const thread: ThreadRow = {
  property_id: "property-1",
  address: "123 Main St",
  city: "Kansas City",
  state: "MO",
  last_ai_escalation_at: "2026-06-22T12:00:00Z",
  last_ai_escalation_reason: "handoff:question",
  homeowner_first_name: "Jane",
  homeowner_last_name: "Seller",
  homeowner_entity_name: null,
};

describe("<ThreadsNeedingAttention />", () => {
  it("links the overflow action to the Messages Escalated filter", () => {
    render(
      <ThreadsNeedingAttention
        threads={[thread]}
        totalCount={2}
        nowMs={Date.parse("2026-06-22T14:00:00Z")}
      />,
    );

    expect(screen.getByRole("link", { name: /view all/i })).toHaveAttribute(
      "href",
      "/messages?filter=escalated",
    );
  });

  it("hides the shared thread summary for restricted Acquisitions members", () => {
    const { container } = render(
      <ThreadsNeedingAttention
        threads={[thread]}
        totalCount={1}
        nowMs={Date.parse("2026-06-22T14:00:00Z")}
        showMessagesAndLeads={false}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("formats the escalation reason with parseEscalationReason, not the raw value", () => {
    render(
      <ThreadsNeedingAttention
        threads={[{ ...thread, last_ai_escalation_reason: "send_timeout:3f1c2d9e-0000-4000-8000-123456789abc" }]}
        totalCount={1}
        nowMs={Date.parse("2026-06-22T14:00:00Z")}
      />,
    );
    expect(
      screen.getByText("Reply timed out at the provider — held for review"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/3f1c2d9e/)).toBeNull();
  });

  it("falls back to a humanized reason when the parser has no label", () => {
    render(
      <ThreadsNeedingAttention
        threads={[{ ...thread, last_ai_escalation_reason: "send_check_failed" }]}
        totalCount={1}
        nowMs={Date.parse("2026-06-22T14:00:00Z")}
      />,
    );
    expect(screen.getByText("Send check failed")).toBeInTheDocument();
    expect(screen.queryByText("send_check_failed")).toBeNull();
  });
});
