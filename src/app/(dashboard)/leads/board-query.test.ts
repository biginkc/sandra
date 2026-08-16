import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { fetchLeadBoardData, LEADS_COLUMN_PAGE_SIZE, type LeadBoardFilters } from "./board-query";

type RpcCall = { name: string; args: Record<string, unknown> };

function clientHarness() {
  const calls: RpcCall[] = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "get_leads_board_urgency_counts") {
        return { data: [{ all_count: 37, overdue_count: 4, today_count: 5, scheduled_count: 8, no_action_count: 20 }], error: null };
      }
      if (name === "get_leads_board_stage_counts") {
        return { data: [{ status: "new_lead", total_count: 48 }], error: null };
      }
      return { data: [{ rows: [], total_count: 37 }], error: null };
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const filters: LeadBoardFilters = {
  search: "Main Smith",
  ownership: "mine",
  motivation: "hot",
  urgency: "today",
  attention: "stale",
  hotOnly: false,
  noActiveSequence: true,
  skipTraced: false,
};

describe("fetchLeadBoardData", () => {
  it("gets exact count and bounded rows from one snapshot RPC", async () => {
    const { client, calls } = clientHarness();
    const data = await fetchLeadBoardData(client, filters, {
      currentUserId: "11111111-1111-4111-8111-111111111111",
      assigneeId: "11111111-1111-4111-8111-111111111111",
      unassigned: false,
      dayStart: "2026-08-15T05:00:00.000Z",
      dayEnd: "2026-08-16T05:00:00.000Z",
    }, {}, ["new_lead"]);

    expect(data.totals.new_lead).toBe(37);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "get_leads_board_page",
      args: expect.objectContaining({
        p_status: "new_lead",
        p_assignee_id: "11111111-1111-4111-8111-111111111111",
        p_search_tokens: ["main", "smith"],
        p_motivation: "hot",
        p_urgency: "today",
        p_attention: "stale",
        p_no_active_sequence: true,
        p_skip_traced: false,
        p_limit: LEADS_COLUMN_PAGE_SIZE + 1,
      }),
    });
  });

  it("keeps the existing active-unassigned queue out of terminal columns", async () => {
    const { client, calls } = clientHarness();
    const data = await fetchLeadBoardData(client, { ...filters, ownership: "unassigned" }, {
      currentUserId: "11111111-1111-4111-8111-111111111111",
      assigneeId: null,
      unassigned: true,
      dayStart: "2026-08-15T05:00:00.000Z",
      dayEnd: "2026-08-16T05:00:00.000Z",
    }, {}, ["closed", "dead"]);

    expect(data.totals.closed).toBe(0);
    expect(data.totals.dead).toBe(0);
    expect(calls).toEqual([]);
  });

  it("gets server-truth urgency counts with every non-urgency filter", async () => {
    const { client, calls } = clientHarness();
    const data = await fetchLeadBoardData(client, filters, {
      currentUserId: "11111111-1111-4111-8111-111111111111",
      assigneeId: "11111111-1111-4111-8111-111111111111",
      unassigned: false,
      dayStart: "2026-08-15T05:00:00.000Z",
      dayEnd: "2026-08-16T05:00:00.000Z",
    });

    expect(data.urgencyCounts).toEqual({ all: 37, overdue: 4, today: 5, scheduled: 8, none: 20 });
    expect(data.baselineTotals?.new_lead).toBe(48);
    const countCall = calls.find((call) => call.name === "get_leads_board_urgency_counts");
    expect(countCall?.args).toEqual(expect.objectContaining({
      p_assignee_id: "11111111-1111-4111-8111-111111111111",
      p_search_tokens: ["main", "smith"],
      p_motivation: "hot",
      p_attention: "stale",
      p_no_active_sequence: true,
      p_skip_traced: false,
    }));
    expect(countCall?.args).not.toHaveProperty("p_urgency");
    expect(calls.filter((call) => call.name === "get_leads_board_stage_counts")).toHaveLength(1);
  });
});
