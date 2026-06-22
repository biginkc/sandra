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
});
