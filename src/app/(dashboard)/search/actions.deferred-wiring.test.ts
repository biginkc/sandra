import { beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end wiring for the >500 path with the REAL search/actions, search-bulk-sms and
// search-bulk-sms workflow modules: only the outermost I/O (Supabase, workflow runtime, `after`,
// the legacy workers) is mocked.
const h = vi.hoisted(() => ({
  afterCbs: [] as Array<() => Promise<void>>,
  start: vi.fn(),
  legacySms: vi.fn(),
  resolveAdHoc: vi.fn(),
  inserted: [] as Array<{ table: string; values: Record<string, unknown> }>,
  selectAll: vi.fn(),
}));

vi.mock("next/server", () => ({ after: (cb: () => Promise<void>) => h.afterCbs.push(cb) }));
vi.mock("workflow/api", () => ({ start: h.start }));
vi.mock("@/lib/campaigns/ad-hoc-bulk-sms", () => ({
  resolveAdHocBulkSmsCampaign: h.resolveAdHoc,
  settleAdHocCampaignAfterQueueFailure: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ update: () => ({ eq: async () => ({}) }) }) }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.insert = (values: Record<string, unknown>) => (h.inserted.push({ table, values }), q);
      q.eq = () => q;
      q.single = async () => (table === "jobs" ? { data: { id: "job-77" }, error: null } : { data: { org_id: "org-1" }, error: null });
      return q;
    },
  }),
}));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships: async () => [{ org_id: "org-1" }], getCallerMembershipsOrThrow: async () => [{ org_id: "org-1" }] }));
vi.mock("@/lib/auth/require-org-membership", () => ({ requireOrgMembership: async () => undefined }));
vi.mock("@/lib/prospects/select-all", () => ({ selectAllSearch: h.selectAll }));
vi.mock("@/lib/prospects/eligibility", () => ({ resolveProspectEligibility: async () => ({ eligibleIds: [], exclusions: [], dncLockedCount: 0, skipTraceDisabledCount: 0 }) }));
vi.mock("../leads/actions", () => ({}));
vi.mock("../campaigns/actions", () => ({ listDeliveryOptions: async () => ({}), refreshDeliveryCatalog: async () => ({}) }));
vi.mock("../properties/promote-leads-actions", () => ({ createPromoteLeadsJob: vi.fn() }));
vi.mock("../properties/actions", () => ({
  bulkQueueSms: h.legacySms, assessBulkSmsAudience: vi.fn(), countAlreadyContacted: vi.fn(),
  createDialerBatchFromPropertyIds: vi.fn(), previewBatchEligibilityAction: vi.fn(), listSmsTemplateCategories: vi.fn(),
}));
vi.mock("@/lib/skip-trace/actions", () => ({}));

import { searchBulkSmsWorkflow } from "@/workflows/search-bulk-sms";

import { searchBulkSms } from "./actions";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const opts = { campaignName: "Fall wave", paceSeconds: 8, body: "Hi", senderNumber: "+15550001111" };

beforeEach(() => {
  vi.clearAllMocks();
  h.start.mockReset();
  h.afterCbs.length = 0;
  h.inserted.length = 0;
  h.resolveAdHoc.mockImplementation(async (_c: unknown, a: { propertyIds: string[] }) => ({ ok: true, data: { campaignId: "camp-1", propertyIds: a.propertyIds } }));
});

describe("searchBulkSms (>500) wiring", () => {
  it("501 prospects: freezes them into a Search job and starts the Search workflow; the legacy workflow/worker is never used", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => uuid(i + 1));
    h.selectAll.mockResolvedValue({ ok: true, data: { eligibleIds: ids, eligibleCount: 501, dncLockedCount: 0, dncLockedIds: [], matchedCount: 520, skippedLeads: 19 } });
    const out = await searchBulkSms({ selection: { kind: "filters", filters: { search: "jane", blockStack: [] } }, opts } as never);
    expect(out).toMatchObject({ ok: true, data: { deferred: { jobId: "job-77", total: 501 }, skippedLeads: 19 } });
    const job = h.inserted.find((i) => i.table === "jobs")!.values as { input_params: { surface: string; property_ids: string[] } };
    expect(job.input_params.surface).toBe("search");
    expect(job.input_params.property_ids).toEqual(ids);
    expect(h.legacySms).not.toHaveBeenCalled();
    await h.afterCbs[0]();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start.mock.calls[0][0]).toBe(searchBulkSmsWorkflow); // the real Search workflow, not the legacy one
    expect(h.start.mock.calls[0][1]).toEqual([{ jobId: "job-77" }]);
  });
});
