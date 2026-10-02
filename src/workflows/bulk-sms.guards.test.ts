import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  updates: [] as Array<{ table: string; values: Row }>,
  queueSmsBatch: vi.fn(),
}));

vi.mock("@/lib/messaging/bulk-queue", () => ({
  queueSmsBatch: h.queueSmsBatch,
  freshScheduleState: (anchor: number) => ({
    cumulativeOffsetMs: 0, dayBucketStartMs: anchor, dayBucketCount: 0, succeeded: 0, skipped: 0, failed: [],
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ error: null }),
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let updateValues: Row | null = null;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (values: Row) => ((updateValues = values), h.updates.push({ table, values }), q);
      q.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q);
      q.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), q);
      q.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q);
      q.not = () => q;
      q.order = () => q;
      q.limit = () => q;
      const rows = () => (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      q.single = async () => ({ data: rows()[0] ?? null, error: null });
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve(updateValues ? { data: null, error: null } : { data: rows(), error: null });
      return q;
    },
  }),
}));

import { bulkSmsWorkflow } from "./bulk-sms";

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.tables = {
    properties: [
      { id: "p1", status: "prospect", deleted_at: null },
      { id: "p2", status: "prospect", deleted_at: null },
      { id: "lead-after-freeze", status: "new_lead", deleted_at: null },
    ],
    campaigns: [
      { id: "adhoc-c", org_id: "org", status: "launching", pace_seconds: 8, audience_snapshot: { source: "bulk_sms_modal" } },
      { id: "saved-c", org_id: "org", status: "launching", pace_seconds: 8, audience_snapshot: { search: "x" } },
    ],
    messages: [],
  };
  h.queueSmsBatch.mockImplementation(async (_c: unknown, args: { state: { succeeded: number; skipped: number; failed: unknown[] }; propertyIds: string[] }) => ({
    ...args.state,
    succeeded: args.state.succeeded + args.propertyIds.length,
  }));
});

function job(campaignId: string, campaignSourceInInput: string, ids: string[]) {
  h.tables.jobs = [
    {
      id: "job-1",
      org_id: "org",
      input_params: {
        property_ids: ids,
        anchor_ms: 1,
        opts: { body: "Hi", paceSeconds: 8, campaignId, campaignSource: campaignSourceInInput },
      },
    },
  ];
}

describe("bulk-sms workflow provenance and ad-hoc re-check", () => {
  it("ad-hoc: a recipient promoted to a lead before its chunk is skipped (counted), prospects still queue", async () => {
    job("adhoc-c", "ad_hoc_bulk_sms", ["p1", "lead-after-freeze", "p2"]);
    const out = await bulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1", "p2"]);
    expect(out).toMatchObject({ queued: 2, skipped: 0, skippedLeads: 1 });
  });

  it("saved campaign: the frozen audience is sent as-is, even with a promoted recipient (exempt)", async () => {
    job("saved-c", "saved_campaign", ["p1", "lead-after-freeze"]);
    const out = await bulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1", "lead-after-freeze"]);
    expect(out.skipped).toBe(0);
  });

  it("provenance comes from the campaign row, not job input: a forged 'saved_campaign' on an ad-hoc campaign is still guarded", async () => {
    job("adhoc-c", "saved_campaign", ["p1", "lead-after-freeze"]);
    const out = await bulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1"]);
    expect(h.queueSmsBatch.mock.calls[0][1].opts.campaignSource).toBe("ad_hoc_bulk_sms");
    expect(out).toMatchObject({ skipped: 0, skippedLeads: 1 });
  });

  it("provenance comes from the campaign row: a forged 'ad_hoc_bulk_sms' on a saved campaign does not change it", async () => {
    job("saved-c", "ad_hoc_bulk_sms", ["p1", "lead-after-freeze"]);
    await bulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch.mock.calls[0][1].opts.campaignSource).toBe("saved_campaign");
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1", "lead-after-freeze"]);
  });
});
