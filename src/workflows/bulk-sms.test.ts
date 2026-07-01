import { describe, expect, it, vi } from "vitest";

import type {
  BulkSmsScheduleState,
  ResolvedBulkSmsQueueOpts,
} from "@/lib/messaging/bulk-queue";
import {
  refreshCampaignScheduleForChunk,
  repairCampaignQueueCadenceAfterChunk,
} from "@/workflows/bulk-sms";

function state(overrides: Partial<BulkSmsScheduleState> = {}): BulkSmsScheduleState {
  return {
    cumulativeOffsetMs: 0,
    dayBucketStartMs: Date.parse("2026-07-01T12:00:00.000Z"),
    dayBucketCount: 0,
    succeeded: 0,
    skipped: 0,
    failed: [],
    ...overrides,
  };
}

function opts(overrides: Partial<ResolvedBulkSmsQueueOpts> = {}): ResolvedBulkSmsQueueOpts {
  return {
    body: "Hello",
    campaignId: "campaign-1",
    campaignSource: "saved_campaign",
    paceSeconds: 8,
    ...overrides,
  };
}

function queryClient(args: {
  campaignPaceSeconds?: number | null;
  jobInputParams?: unknown;
  queuedRows?: Array<{ property_id: string | null; scheduled_for: string | null }>;
}) {
  const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const from = vi.fn((table: string) => {
    if (table === "jobs") {
      const maybeSingle = vi.fn().mockResolvedValue({
        data: { input_params: args.jobInputParams ?? null },
        error: null,
      });
      const eq = vi.fn(() => ({ maybeSingle }));
      const select = vi.fn(() => ({ eq }));
      return { select };
    }

    if (table === "campaigns") {
      const maybeSingle = vi.fn().mockResolvedValue({
        data: { pace_seconds: args.campaignPaceSeconds ?? null },
        error: null,
      });
      const eq = vi.fn(() => ({ maybeSingle }));
      const select = vi.fn(() => ({ eq }));
      return { select };
    }

    if (table === "messages") {
      const query = {
        eq: vi.fn(() => query),
        not: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn().mockResolvedValue({
          data: args.queuedRows ?? [],
          error: null,
        }),
      };
      const select = vi.fn(() => query);
      return { select };
    }

    throw new Error(`Unexpected table ${table}`);
  });

  return { from, rpc };
}

describe("refreshCampaignScheduleForChunk", () => {
  it("keeps the synced job pace when the campaign row is still stale", async () => {
    const client = queryClient({
      campaignPaceSeconds: 8,
      jobInputParams: { opts: { campaignId: "campaign-1", paceSeconds: 2 } },
      queuedRows: [],
    });

    const result = await refreshCampaignScheduleForChunk(
      client as never,
      "job-1",
      ["property-1"],
      opts({ paceSeconds: 8 }),
      state(),
    );

    expect(result.opts.paceSeconds).toBe(2);
    expect(result.state.dayBucketStartMs).toBe(Date.parse("2026-07-01T12:00:00.000Z"));
    expect(result.state.dayBucketCount).toBe(0);
  });

  it("uses the queue horizon outside the retried chunk", async () => {
    const client = queryClient({
      campaignPaceSeconds: 4,
      jobInputParams: { opts: { campaignId: "campaign-1", paceSeconds: 4 } },
      queuedRows: [
        {
          property_id: "property-current",
          scheduled_for: "2026-07-01T12:20:00.000Z",
        },
        {
          property_id: "property-prior",
          scheduled_for: "2026-07-01T12:10:00.000Z",
        },
      ],
    });

    const result = await refreshCampaignScheduleForChunk(
      client as never,
      "job-1",
      ["property-current"],
      opts({ paceSeconds: 8 }),
      state({ dayBucketStartMs: Date.parse("2026-07-01T12:00:00.000Z") }),
    );

    expect(result.opts.paceSeconds).toBe(4);
    expect(result.state.cumulativeOffsetMs).toBe(0);
    expect(result.state.dayBucketStartMs).toBe(Date.parse("2026-07-01T12:10:00.000Z"));
    expect(result.state.dayBucketCount).toBe(1);
  });

  it("repairs the queued campaign when pace changes while a chunk is queueing", async () => {
    const client = queryClient({
      campaignPaceSeconds: 4,
      jobInputParams: { opts: { campaignId: "campaign-1", paceSeconds: 4 } },
    });

    await repairCampaignQueueCadenceAfterChunk(
      client as never,
      "job-1",
      opts({ paceSeconds: 8 }),
    );

    expect(client.rpc).toHaveBeenCalledWith("apply_campaign_cadence_reschedule", {
      p_campaign_id: "campaign-1",
      p_pace_seconds: 4,
      p_start_after_seconds: 300,
      p_operator_confirmed: true,
    });
  });

  it("does not repair when the chunk already used the current pace", async () => {
    const client = queryClient({
      campaignPaceSeconds: 4,
      jobInputParams: { opts: { campaignId: "campaign-1", paceSeconds: 4 } },
    });

    await repairCampaignQueueCadenceAfterChunk(
      client as never,
      "job-1",
      opts({ paceSeconds: 4 }),
    );

    expect(client.rpc).not.toHaveBeenCalled();
  });
});
