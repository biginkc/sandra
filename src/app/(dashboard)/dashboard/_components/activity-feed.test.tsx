import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActivityRow } from "../queries";

import { ActivityFeed } from "./activity-feed";

const inboundWithLead: ActivityRow = {
  kind: "inbound_message",
  at: "2026-09-16T12:00:00.000Z",
  property_id: "lead-1",
  address: "1 Main St",
  city: "Kansas City",
  state: "MO",
  preview: "Sensitive seller message must stay hidden",
};

const contactOnlyInbound: ActivityRow = {
  kind: "inbound_message",
  at: "2026-09-16T11:00:00.000Z",
  property_id: null,
  address: null,
  city: null,
  state: null,
  preview: "Sensitive contact-only message must stay hidden",
};

describe("<ActivityFeed />", () => {
  it("hides inbound previews while keeping property lead links and non-message activity", () => {
    render(
      <ActivityFeed
        events={[
          inboundWithLead,
          contactOnlyInbound,
          {
            kind: "sequence_completed",
            at: "2026-09-16T10:00:00.000Z",
            property_id: "lead-2",
            sequence_name: "Follow up",
          },
        ]}
        showMessagesAndLeads={false}
      />,
    );

    expect(screen.getByText("New reply — Kansas City, MO")).toBeVisible();
    expect(screen.getByRole("link", { name: /New reply/ })).toHaveAttribute(
      "href",
      "/leads/lead-1",
    );
    expect(screen.getByText(/Sequence completed/)).toBeVisible();
    expect(
      screen.queryByText(/Sensitive seller message|Sensitive contact-only message/),
    ).not.toBeInTheDocument();
  });
});
