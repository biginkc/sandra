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
      let isUpdate = false;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (values: Row) => ((isUpdate = true), h.updates.push({ table, values }), q);
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
        resolve(isUpdate ? { data: null, error: null } : { data: rows(), error: null, count: rows().length });
      return q;
    },
  }),
}));

import { searchBulkSmsWorkflow } from "./search-bulk-sms";

const prospect = (id: string) => ({ id, status: "prospect", is_dnc_locked: false, deleted_at: null });

function seedJob(ids: string[], over: { surface?: string; source?: string } = {}) {
  h.tables.jobs = [
    {
      id: "job-1", org_id: "org", type: "bulk_sms",
      input_params: {
        surface: over.surface ?? "search", property_ids: ids, anchor_ms: 1,
        opts: { body: "Hi", paceSeconds: 8, campaignId: "camp-1", campaignSource: "ad_hoc_bulk_sms" },
      },
    },
  ];
  h.tables.campaigns = [
    { id: "camp-1", org_id: "org", status: "launching", pace_seconds: 8, audience_snapshot: { source: over.source ?? "bulk_sms_modal" } },
  ];
}
const summary = (status?: string) => h.updates.filter((u) => u.table === "jobs" && u.values.result_summary && (!status || u.values.status === status)).at(-1)?.values.result_summary;

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.tables = { properties: [], messages: [] };
  h.queueSmsBatch.mockImplementation(async (_c: unknown, a: { state: { succeeded: number }; propertyIds: string[] }) => ({
    ...a.state, succeeded: a.state.succeeded + a.propertyIds.length,
  }));
});

describe("Search deferred bulk SMS workflow", () => {
  it("a recipient promoted to a lead AFTER the freeze is never queued; the chunk reports the skip", async () => {
    h.tables.properties = [prospect("p1"), prospect("p2"), { ...prospect("promoted"), status: "new_lead" }];
    seedJob(["p1", "promoted", "p2"]);
    const out = await searchBulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1", "p2"]);
    expect(out).toMatchObject({ queued: 2, skippedLeads: 1 });
    expect(summary("completed")).toMatchObject({ queued: 2, skipped_leads: 1 });
  });

  it("re-validates EVERY chunk: a promotion that only affects the second chunk is caught there", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`); // chunks of 200, 200, 50
    h.tables.properties = ids.map((id) => prospect(id));
    seedJob(ids);
    // p250 (second chunk) was promoted between the freeze and its chunk; p10 (first chunk) was not.
    h.tables.properties[250] = { ...prospect("p250"), status: "interested" };
    const out = await searchBulkSmsWorkflow({ jobId: "job-1" });
    const queued = h.queueSmsBatch.mock.calls.flatMap((c) => c[1].propertyIds as string[]);
    expect(queued).toHaveLength(449);
    expect(queued).not.toContain("p250");
    expect(h.queueSmsBatch).toHaveBeenCalledTimes(3);
    expect(out.skippedLeads).toBe(1);
  });

  it("a recipient that became DNC-locked or was deleted after the freeze is not texted", async () => {
    h.tables.properties = [
      prospect("ok"),
      { ...prospect("locked"), is_dnc_locked: true },
      { ...prospect("deleted"), deleted_at: "2026-01-01" },
    ];
    seedJob(["ok", "locked", "deleted"]);
    await searchBulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["ok"]);
    expect(summary("completed")).toMatchObject({ skipped_dnc: 1, skipped_leads: 1 });
  });

  it("a chunk with nobody left to text queues nothing and still finishes", async () => {
    h.tables.properties = [{ ...prospect("a"), status: "closed" }];
    seedJob(["a"]);
    const out = await searchBulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
    expect(out).toMatchObject({ queued: 0, skippedLeads: 1 });
  });

  it("refuses a job that is not Search-owned (e.g. a legacy bulk_sms job)", async () => {
    h.tables.properties = [prospect("p1")];
    seedJob(["p1"], { surface: "legacy" });
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow(/not a Search bulk SMS job/);
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
    expect(summary("failed")).toBeTruthy();
  });

  it("refuses when the stored campaign is not an ad-hoc bulk SMS campaign (provenance from the row, not job input)", async () => {
    h.tables.properties = [prospect("p1")];
    seedJob(["p1"], { source: "filters" });
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow(/not an ad-hoc/);
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
  });
});
