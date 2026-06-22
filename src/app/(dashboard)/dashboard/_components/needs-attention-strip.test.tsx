import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NeedsAttentionStrip } from "./needs-attention-strip";

describe("<NeedsAttentionStrip />", () => {
  it("links escalated attention to the Messages Escalated filter", () => {
    render(
      <NeedsAttentionStrip
        needs={{
          escalated_unhandled: 2,
          stale_conversations: 0,
          sequence_ended_no_followup: 0,
          unassigned: 0,
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: /escalated, needs reply/i }),
    ).toHaveAttribute("href", "/messages?filter=escalated");
  });
});
