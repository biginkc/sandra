import { describe, expect, it } from "vitest";

import { resolveInboundLeadFilters } from "./inbound-filters";

describe("resolveInboundLeadFilters", () => {
  it("translates only validated dashboard ownership links into visit state", () => {
    const context = {
      currentUserId: "user-me",
      teammateIds: ["user-me", "user-other"],
    };

    expect(resolveInboundLeadFilters({ assignee: "me" }, context)).toEqual({
      ownership: "mine",
      attention: null,
    });
    expect(
      resolveInboundLeadFilters({ assignee: "user-other" }, context),
    ).toEqual({ ownership: "user-other", attention: null });
    expect(resolveInboundLeadFilters({ unassigned: "true" }, context)).toEqual({
      ownership: "unassigned",
      attention: null,
    });
    expect(resolveInboundLeadFilters({ assignee: "not-a-member" }, context)).toEqual({
      ownership: "all",
      attention: null,
    });
  });

  it("recognizes the two dashboard attention links without persisting them", () => {
    const context = { currentUserId: "user-me", teammateIds: ["user-me"] };
    expect(resolveInboundLeadFilters({ stale: "true" }, context).attention).toBe(
      "stale",
    );
    expect(
      resolveInboundLeadFilters({ sequence_ended: "true" }, context).attention,
    ).toBe("sequence_ended");
  });
});
