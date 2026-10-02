import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inserted: [] as Array<{ table: string; values: Record<string, unknown> }>,
  afterCbs: [] as Array<() => Promise<void>>,
  start: vi.fn(),
  resolveAdHoc: vi.fn(),
  settle: vi.fn(),
  adminUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/server", () => ({ after: (cb: () => Promise<void>) => h.afterCbs.push(cb) }));
vi.mock("workflow/api", () => ({ start: h.start }));
vi.mock("@/lib/campaigns/ad-hoc-bulk-sms", () => ({
  resolveAdHocBulkSmsCampaign: h.resolveAdHoc,
  settleAdHocCampaignAfterQueueFailure: h.settle,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ update: (v: Record<string, unknown>) => (h.adminUpdates.push(v), { eq: async () => ({ error: null }) }) }),
  }),
}));
vi.mock("@/workflows/search-bulk-sms", () => ({ SEARCH_SMS_JOB_SURFACE: "search", searchBulkSmsWorkflow: { name: "searchBulkSmsWorkflow" } }));

import { queueSearchSmsDeferred } from "./search-bulk-sms";

function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.insert = (values: Record<string, unknown>) => (h.inserted.push({ table, values }), q);
      q.eq = () => q;
      q.single = async () => (table === "jobs" ? { data: { id: "job-9" }, error: null } : { data: { org_id: "org-1" }, error: null });
      return q;
    },
  } as never;
}
const opts = { campaignName: "Fall", body: "Hi", paceSeconds: 8, senderNumber: "+15550001111" };

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted.length = 0;
  h.afterCbs.length = 0;
  h.adminUpdates.length = 0;
  h.resolveAdHoc.mockImplementation(async (_c: unknown, a: { propertyIds: string[] }) => ({ ok: true, data: { campaignId: "camp-1", propertyIds: a.propertyIds } }));
});

describe("queueSearchSmsDeferred", () => {
  it("freezes the given prospect ids into a Search-marked job and starts the Search workflow (not the legacy one)", async () => {
    const out = await queueSearchSmsDeferred(client(), ["a", "b", "c"], opts as never);
    expect(out).toMatchObject({ ok: true, data: { deferred: { jobId: "job-9", total: 3 } } });
    const job = h.inserted.find((i) => i.table === "jobs")!.values as { input_params: Record<string, unknown>; type: string };
    expect(job.type).toBe("bulk_sms");
    expect(job.input_params).toMatchObject({ surface: "search", property_ids: ["a", "b", "c"] });
    expect((job.input_params.opts as { campaignSource: string }).campaignSource).toBe("ad_hoc_bulk_sms");
    await h.afterCbs[0]();
    expect(h.start).toHaveBeenCalledWith({ name: "searchBulkSmsWorkflow" }, [{ jobId: "job-9" }]);
  });

  it("a workflow-start failure marks the job failed and settles the campaign", async () => {
    h.start.mockRejectedValue(new Error("start failed"));
    await queueSearchSmsDeferred(client(), ["a"], opts as never);
    await h.afterCbs[0]();
    expect(h.adminUpdates[0]).toMatchObject({ status: "failed" });
    expect(h.settle).toHaveBeenCalled();
  });

  it("rejects an invalid pace before creating anything", async () => {
    const out = await queueSearchSmsDeferred(client(), ["a"], { ...opts, paceSeconds: -5 } as never);
    expect(out).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(h.resolveAdHoc).not.toHaveBeenCalled();
  });
});
