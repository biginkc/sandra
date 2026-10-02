import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  updates: [] as Array<{ table: string; values: Row; matched: number }>,
  queueSmsBatch: vi.fn(),
  queueCalls: 0,
}));

vi.mock("@/lib/messaging/bulk-queue", () => ({
  queueSmsBatch: h.queueSmsBatch,
  freshScheduleState: (anchor: number) => ({
    cumulativeOffsetMs: 0, dayBucketStartMs: anchor, dayBucketCount: 0, succeeded: 0, skipped: 0, failed: [],
  }),
}));

// A filter-AWARE fake: updates only touch rows that match every .eq/.in/.is filter, so a guard like
// `.eq("status","launching")` is really exercised, and state is inspected on the tables afterwards.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ error: null }),
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let pending: Row | null = null;
      let head = false;
      const q: Record<string, unknown> = {};
      q.select = (_c?: string, opts?: { head?: boolean }) => ((head = opts?.head === true), q);
      q.update = (values: Row) => ((pending = values), q);
      q.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q);
      q.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), q);
      q.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q);
      q.not = () => q;
      q.order = () => q;
      q.limit = () => q;
      const rows = () => (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      q.single = async () => ({ data: rows()[0] ?? null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => {
        if (pending) {
          const matched = rows();
          for (const r of matched) Object.assign(r, pending);
          h.updates.push({ table, values: pending, matched: matched.length });
          return resolve({ data: null, error: null });
        }
        void head;
        return resolve({ data: rows(), error: null, count: rows().length });
      };
      return q;
    },
  }),
}));

import { searchBulkSmsWorkflow } from "./search-bulk-sms";

const prospect = (id: string) => ({ id, status: "prospect", is_dnc_locked: false, deleted_at: null });
const jobRow = () => h.tables.jobs[0];
const campaign = () => h.tables.campaigns[0];
const summary = () => jobRow().result_summary as Record<string, unknown>;

function seedJob(ids: string[], over: { surface?: string; source?: string; jobOrg?: string } = {}) {
  h.tables.jobs = [
    {
      id: "job-1", org_id: over.jobOrg ?? "org", type: "bulk_sms", status: "queued",
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

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.queueCalls = 0;
  h.tables = { properties: [], messages: [] };
  h.queueSmsBatch.mockImplementation(async (_c: unknown, a: { state: { succeeded: number }; propertyIds: string[] }) => {
    h.queueCalls += 1;
    return { ...a.state, succeeded: a.state.succeeded + a.propertyIds.length };
  });
});

describe("per-chunk revalidation", () => {
  it("a recipient promoted to a lead AFTER the freeze is never queued; the run reports the skip", async () => {
    h.tables.properties = [prospect("p1"), prospect("p2"), { ...prospect("promoted"), status: "new_lead" }];
    seedJob(["p1", "promoted", "p2"]);
    const out = await searchBulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1", "p2"]);
    expect(out).toMatchObject({ queued: 2, skippedLeads: 1 });
    expect(summary()).toMatchObject({ queued: 2, skipped_leads: 1 });
  });

  it("a promotion that happens WHILE chunk 1 is queueing is caught in chunk 2 (state is re-read per chunk)", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`); // chunks of 200, 200, 50
    h.tables.properties = ids.map((id) => prospect(id));
    seedJob(ids);
    h.queueSmsBatch.mockImplementation(async (_c: unknown, a: { state: { succeeded: number }; propertyIds: string[] }) => {
      h.queueCalls += 1;
      // The promotion lands during chunk 1; p250 belongs to chunk 2.
      if (h.queueCalls === 1) h.tables.properties[250] = { ...prospect("p250"), status: "interested" };
      return { ...a.state, succeeded: a.state.succeeded + a.propertyIds.length };
    });
    const out = await searchBulkSmsWorkflow({ jobId: "job-1" });
    const queued = h.queueSmsBatch.mock.calls.flatMap((c) => c[1].propertyIds as string[]);
    expect(queued).toHaveLength(449);
    expect(queued).not.toContain("p250");
    expect(h.queueSmsBatch).toHaveBeenCalledTimes(3);
    expect(out.skippedLeads).toBe(1);
    // processed_items counts every frozen row gone through, skipped ones included.
    expect(jobRow().processed_items).toBe(450);
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
    expect(summary()).toMatchObject({ skipped_dnc: 1, skipped_leads: 1 });
  });

  it("a chunk with nobody left to text queues nothing and still finishes", async () => {
    h.tables.properties = [{ ...prospect("a"), status: "closed" }];
    seedJob(["a"]);
    const out = await searchBulkSmsWorkflow({ jobId: "job-1" });
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
    expect(out).toMatchObject({ queued: 0, skippedLeads: 1 });
  });
});

describe("status transitions (same statuses as the legacy workflow)", () => {
  it("running + started_at on load, then completed with the campaign completed", async () => {
    h.tables.properties = [prospect("p1")];
    seedJob(["p1"]);
    await searchBulkSmsWorkflow({ jobId: "job-1" });
    const first = h.updates.find((u) => u.table === "jobs")!;
    expect(first.values).toMatchObject({ status: "running" });
    expect(typeof first.values.started_at).toBe("string");
    expect(first.matched).toBe(1);
    expect(jobRow().status).toBe("completed");
    expect(campaign().status).toBe("completed");
  });

  it("some queued + some failed => partial (campaign completed); all failed => failed", async () => {
    h.tables.properties = [prospect("p1"), prospect("p2")];
    seedJob(["p1", "p2"]);
    h.queueSmsBatch.mockImplementation(async (_c: unknown, a: { state: Record<string, unknown> }) => ({
      ...a.state, succeeded: 1, failed: [{ propertyId: "p2", message: "boom" }],
    }));
    await searchBulkSmsWorkflow({ jobId: "job-1" });
    expect(jobRow().status).toBe("partial");
    expect(campaign().status).toBe("completed");

    h.tables.properties = [prospect("p1")];
    seedJob(["p1"]);
    h.queueSmsBatch.mockImplementation(async (_c: unknown, a: { state: Record<string, unknown> }) => ({
      ...a.state, succeeded: 0, failed: [{ propertyId: "p1", message: "boom" }],
    }));
    await searchBulkSmsWorkflow({ jobId: "job-1" });
    expect(jobRow().status).toBe("failed");
  });

  it("a chunk crash after messages were stamped => partial and the campaign is COMPLETED (not archived)", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    h.tables.properties = ids.map((id) => prospect(id));
    seedJob(ids);
    h.tables.messages = [{ campaign_id: "camp-1", direction: "outbound" }];
    h.queueSmsBatch.mockImplementation(async (_c: unknown, a: { state: { succeeded: number }; propertyIds: string[] }) => {
      h.queueCalls += 1;
      if (h.queueCalls === 2) throw new Error("provider down");
      return { ...a.state, succeeded: a.state.succeeded + a.propertyIds.length };
    });
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow("provider down");
    expect(jobRow().status).toBe("partial");
    expect(campaign().status).toBe("completed");
  });

  it("a chunk crash with NOTHING queued fails the job and archives the ad-hoc campaign (legacy parity: frees the name)", async () => {
    h.tables.properties = [prospect("p1")];
    seedJob(["p1"]);
    h.queueSmsBatch.mockRejectedValue(new Error("provider down"));
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow("provider down");
    expect(jobRow().status).toBe("failed");
    expect(campaign().status).toBe("archived");
  });

  it("uses the same terminal-status expression as the legacy workflow", () => {
    const root = path.resolve(__dirname, "../..");
    const norm = (t: string) => t.replace(/\s+/g, " ");
    const expr = 'state.failed.length === 0 ? "completed" : state.succeeded > 0 ? "partial" : "failed"';
    expect(norm(readFileSync(path.join(root, "src/workflows/bulk-sms.ts"), "utf8"))).toContain(expr);
    expect(norm(readFileSync(path.join(root, "src/workflows/search-bulk-sms.ts"), "utf8"))).toContain(expr);
  });

  it("a later-chunk failure does not count earlier skipped leads/DNC as failures (501 rows, 200 skipped in chunk 1, chunk 2 throws)", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `p${i}`);
    h.tables.properties = ids.map((id, i) => (i < 200 ? { ...prospect(id), status: "interested" } : prospect(id)));
    seedJob(ids);
    h.queueSmsBatch.mockRejectedValue(new Error("provider down")); // chunk 2 (the first one with prospects)
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow("provider down");
    // 200 skipped leads in chunk 1 are excluded; chunk 2's 200 + the never-reached 101 are the failures.
    expect(summary()).toMatchObject({ skipped_leads: 200, failed: 301 });
    expect(jobRow().failed_items).toBe(301);
  });

  it("DNC-locked exclusions are excluded from failed totals too", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`);
    h.tables.properties = ids.map((id, i) => (i < 200 ? { ...prospect(id), is_dnc_locked: true } : prospect(id)));
    seedJob(ids);
    h.queueSmsBatch.mockRejectedValue(new Error("provider down"));
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow();
    expect(summary()).toMatchObject({ skipped_dnc: 200, failed: 250 });
  });
});

describe("load-step failures (archive only a Search-created, same-org, launching, nothing-queued campaign)", () => {
  const noIds = () => {
    h.tables.jobs[0].input_params = { ...(h.tables.jobs[0].input_params as object), property_ids: [] };
  };

  it("genuine case: job fails and the launching ad-hoc campaign is archived", async () => {
    seedJob(["p1"]);
    noIds();
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow(/no property ids/);
    expect(jobRow().status).toBe("failed");
    expect(campaign().status).toBe("archived");
    expect(h.updates.some((u) => u.table === "campaigns" && u.matched === 1)).toBe(true);
  });

  it("NOT archived when an outbound message was already queued for the campaign", async () => {
    seedJob(["p1"]);
    noIds();
    h.tables.messages = [{ campaign_id: "camp-1", direction: "outbound" }];
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow();
    expect(campaign().status).toBe("launching");
  });

  it("NOT archived when the campaign is not launching (e.g. completed)", async () => {
    seedJob(["p1"]);
    noIds();
    campaign().status = "completed";
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow();
    expect(campaign().status).toBe("completed");
  });

  it("NOT archived when the campaign source is not the ad-hoc bulk SMS source", async () => {
    seedJob(["p1"], { source: "filters" });
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow(/not an ad-hoc/);
    expect(campaign().status).toBe("launching");
    expect(jobRow().status).toBe("failed");
  });

  it("NOT archived across orgs (job org differs from the campaign org)", async () => {
    seedJob(["p1"], { jobOrg: "other-org" });
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow(/does not match job org/);
    expect(campaign().status).toBe("launching");
    expect(jobRow().status).toBe("failed");
  });

  it("a job that is not Search-owned is failed but its campaign is never touched", async () => {
    h.tables.properties = [prospect("p1")];
    seedJob(["p1"], { surface: "legacy" });
    await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).rejects.toThrow(/not a Search bulk SMS job/);
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
    expect(campaign().status).toBe("launching");
    expect(jobRow().status).toBe("failed");
  });

  it("accepts the legacy campaign statuses (replay after completed/paused)", async () => {
    for (const status of ["completed", "paused"]) {
      h.tables.properties = [prospect("p1")];
      seedJob(["p1"]);
      campaign().status = status;
      await expect(searchBulkSmsWorkflow({ jobId: "job-1" })).resolves.toMatchObject({ queued: 1 });
    }
  });
});
