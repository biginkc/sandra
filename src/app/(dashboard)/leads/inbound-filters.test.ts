import { describe, expect, it } from "vitest";

import {
  deriveAttentionLeadIds,
  executeInboundScopedLeadQuery,
  resolveInboundLeadFilters,
} from "./inbound-filters";

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

describe("executeInboundScopedLeadQuery", () => {
  function recordingQuery() {
    const operations: string[] = [];
    const query = {
      eq(field: string, value: unknown) {
        operations.push(`eq:${field}:${String(value)}`);
        return query;
      },
      is(field: string, value: unknown) {
        operations.push(`is:${field}:${String(value)}`);
        return query;
      },
      not(field: string, operator: string, value: unknown) {
        operations.push(`not:${field}:${operator}:${String(value)}`);
        return query;
      },
      order(field: string) {
        operations.push(`order:${field}`);
        return query;
      },
      limit(count: number) {
        operations.push(`limit:${count}`);
        return Promise.resolve({ data: [], error: null });
      },
    };
    return { query, operations };
  }

  it("applies assignee scope before ordering and the global limit", async () => {
    const { query, operations } = recordingQuery();
    await executeInboundScopedLeadQuery(query, "mine", "user-me", 501);
    expect(operations).toEqual([
      "eq:assigned_user_id:user-me",
      "order:created_at",
      "limit:501",
    ]);
  });

  it("applies the dashboard's active-unassigned definition before the limit", async () => {
    const { query, operations } = recordingQuery();
    await executeInboundScopedLeadQuery(query, "unassigned", "user-me", 501);
    expect(operations).toEqual([
      "is:assigned_user_id:null",
      "not:status:in:(closed,dead,prospect)",
      "order:created_at",
      "limit:501",
    ]);
  });
});

describe("deriveAttentionLeadIds", () => {
  const now = new Date("2026-08-15T18:00:00.000Z");
  const leads = [
    { id: "stale", status: "contacted" },
    { id: "answered", status: "contacted" },
    { id: "under-contract", status: "under_contract" },
    { id: "sequence", status: "interested" },
  ];

  it("matches the dashboard stale-conversation definition", () => {
    const result = deriveAttentionLeadIds({
      leads,
      messages: [
        {
          property_id: "stale",
          direction: "inbound",
          created_at: "2026-08-01T18:00:00.000Z",
        },
        {
          property_id: "stale",
          direction: "inbound",
          created_at: "2026-08-15T12:00:00.000Z",
        },
        {
          property_id: "answered",
          direction: "inbound",
          created_at: "2026-08-01T18:00:00.000Z",
        },
        {
          property_id: "answered",
          direction: "outbound",
          created_at: "2026-08-02T18:00:00.000Z",
        },
        {
          property_id: "under-contract",
          direction: "inbound",
          created_at: "2026-08-01T18:00:00.000Z",
        },
      ],
      completedEnrollments: [],
      now,
    });

    expect(result.stale).toEqual(["stale"]);
  });

  it("matches completed-sequence-without-later-outbound behavior", () => {
    const result = deriveAttentionLeadIds({
      leads,
      messages: [
        {
          property_id: "answered",
          direction: "outbound",
          created_at: "2026-08-15T00:00:00.000Z",
        },
      ],
      completedEnrollments: [
        {
          property_id: "sequence",
          completed_at: "2026-08-13T00:00:00.000Z",
        },
        {
          property_id: "answered",
          completed_at: "2026-08-13T00:00:00.000Z",
        },
      ],
      now,
    });

    expect(result.sequenceEnded).toEqual(["sequence"]);
  });
});
