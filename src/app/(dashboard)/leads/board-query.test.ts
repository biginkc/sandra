import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

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
      return { data: [{ rows: [], total_count: 37, snapshot_generation: "generation-a" }], error: null };
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
  it("threads a bounded org-aware latest-contract map into the returned cards", async () => {
    const lead = {
      id: "11111111-1111-4111-8111-111111111111",
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
      market: "Jackson County MO",
      status: "new_lead",
      is_vacant: false,
      cass_status: "verified",
      absentee_flag: false,
      assigned_user_id: null,
      motivation_level: null,
      outreach_dispo: null,
      has_unread: false,
      next_task_id: null,
      next_task_title: null,
      next_task_due_at: null,
      homeowner: null,
      homeowner_sms_opted_out: false,
      homeowner_sms_opted_out_at: null,
    };
    const client = {
      async rpc(name: string) {
        if (name === "get_leads_board_page") {
          return {
            data: [{ rows: [lead], total_count: 1, snapshot_generation: "generation-a" }],
            error: null,
          };
        }
        return { data: [], error: null };
      },
      from() {
        return {
          select() {
            return {
              async in() {
                return { data: [], error: null };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient<Database>;
    const loader = vi.fn().mockResolvedValue([
      {
        org_id: "22222222-2222-4222-8222-222222222222",
        property_id: lead.id,
        id: "33333333-3333-4333-8333-333333333333",
        created_at: "2026-08-29T12:00:00.000000+00:00",
        status: "signed",
      },
    ]);

    const data = await fetchLeadBoardData(
      client,
      filters,
      {
        currentUserId: "44444444-4444-4444-8444-444444444444",
        assigneeId: null,
        unassigned: false,
        dayStart: "2026-08-15T05:00:00.000Z",
        dayEnd: "2026-08-16T05:00:00.000Z",
        orgId: "22222222-2222-4222-8222-222222222222",
      },
      {},
      ["new_lead"],
      loader,
    );

    expect(loader).toHaveBeenCalledWith({
      orgId: "22222222-2222-4222-8222-222222222222",
      propertyIds: [lead.id],
    });
    expect(data.latestContractByPropertyId[lead.id]).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      created_at: "2026-08-29T12:00:00.000000+00:00",
      status: "signed",
    });
    expect(data.leads[0].latestContract).toEqual(
      data.latestContractByPropertyId[lead.id],
    );
  });

  it("does not invoke the org-scoped loader without a trusted server org id", async () => {
    const lead = {
      id: "11111111-1111-4111-8111-111111111111",
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
      market: "Jackson County MO",
      status: "new_lead",
      is_vacant: false,
      cass_status: "verified",
      absentee_flag: false,
      assigned_user_id: null,
      motivation_level: null,
      outreach_dispo: null,
      has_unread: false,
      next_task_id: null,
      next_task_title: null,
      next_task_due_at: null,
      homeowner: null,
      homeowner_sms_opted_out: false,
      homeowner_sms_opted_out_at: null,
    };
    const client = {
      async rpc(name: string) {
        if (name === "get_leads_board_page") {
          return {
            data: [{ rows: [lead], total_count: 1, snapshot_generation: "generation-a" }],
            error: null,
          };
        }
        return { data: [], error: null };
      },
      from() {
        return {
          select() {
            return {
              async in() {
                return { data: [], error: null };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient<Database>;
    const loader = vi.fn().mockResolvedValue([]);

    const data = await fetchLeadBoardData(
      client,
      filters,
      {
        currentUserId: "44444444-4444-4444-8444-444444444444",
        assigneeId: null,
        unassigned: false,
        dayStart: "2026-08-15T05:00:00.000Z",
        dayEnd: "2026-08-16T05:00:00.000Z",
      },
      {},
      ["new_lead"],
      loader,
    );

    expect(loader).not.toHaveBeenCalled();
    expect(data.latestContractByPropertyId).toEqual({});
    expect(data.leads[0].latestContract).toBeNull();
  });

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
    expect(data.snapshotGenerations.new_lead).toBe("generation-a");
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
