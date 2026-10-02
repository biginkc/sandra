import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  inserted: [] as Array<{ table: string; values: unknown }>,
  queueSmsBatch: vi.fn(),
  resolveAdHoc: vi.fn(),
  assessLineTypes: vi.fn(),
  loadDelivery: vi.fn(),
  createClientMock: vi.fn(),
  afterMock: vi.fn(),
  startMock: vi.fn(),
  selectAll: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: h.createClientMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("workflow/api", () => ({ start: h.startMock }));
vi.mock("next/server", () => ({ after: h.afterMock }));
vi.mock("@/workflows/bulk-sms", () => ({ bulkSmsWorkflow: vi.fn() }));
vi.mock("@/lib/messaging/bulk-queue", () => ({
  CONTACTED_MESSAGE_STATUSES: ["sent", "delivered"],
  freshScheduleState: () => ({ succeeded: 0, skipped: 0, failed: [] }),
  queueSmsBatch: h.queueSmsBatch,
}));
vi.mock("@/lib/campaigns/ad-hoc-bulk-sms", () => ({
  completeLaunchingCampaign: vi.fn().mockResolvedValue({ ok: true, data: null }),
  normalizeAdHocCampaignName: (v: unknown) =>
    typeof v === "string" && v.trim() ? { ok: true, data: v.trim() } : { ok: false, error: { code: "VALIDATION", message: "Campaign name is required." } },
  resolveAdHocBulkSmsCampaign: h.resolveAdHoc,
  settleAdHocCampaignAfterQueueFailure: vi.fn(),
}));
vi.mock("@/lib/messaging/audience-assessment", () => ({ assessAudienceLineTypes: h.assessLineTypes }));
vi.mock("@/lib/messaging/delivery", () => ({
  loadCampaignDeliverySettings: h.loadDelivery,
  normalizeSenderNumber: (v: string) => v.replace(/\D/g, ""),
}));
vi.mock("@/lib/prospects/select-all", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/prospects/select-all")>()),
  selectAllMatching: h.selectAll,
}));
vi.mock("@/lib/prospects/eligibility", () => ({ resolveProspectEligibility: vi.fn() }));

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let pendingInsert: unknown = null;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.insert = (values: unknown) => {
        pendingInsert = values;
        h.inserted.push({ table, values });
        return q;
      };
      q.in = (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), q);
      q.eq = (col: string, val: unknown) => (filters.push((r) => r[col] === val), q);
      q.is = (col: string, val: unknown) => (filters.push((r) => (r[col] ?? null) === val), q);
      const rows = () => (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      q.single = async () =>
        pendingInsert ? { data: { id: "job-1" }, error: null } : { data: rows()[0] ?? null, error: null };
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      return q;
    },
  };
}

import {
  assessBulkSmsAudience,
  bulkQueueSms,
  countAlreadyContacted,
} from "./actions";

const baseOpts = {
  paceSeconds: 8,
  body: "Hi",
  senderNumber: "+15550001111",
  includeUnknown: false,
};
const adHoc = { ...baseOpts, campaignName: "Fall wave" };

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted.length = 0;
  h.tables = {
    properties: [
      { id: "p1", org_id: "org", status: "prospect", deleted_at: null },
      { id: "p2", org_id: "org", status: "prospect", deleted_at: null },
      { id: "l1", org_id: "org", status: "new_lead", deleted_at: null },
      { id: "l2", org_id: "org", status: "interested", deleted_at: null },
      { id: "d1", org_id: "org", status: "dead", deleted_at: null },
    ],
    campaigns: [
      { id: "saved-1", org_id: "org", status: "launching", audience_snapshot: { search: "x", blockStack: [] } },
      { id: "adhoc-1", org_id: "org", status: "launching", audience_snapshot: { source: "bulk_sms_modal" } },
    ],
    campaign_recipients: [
      { campaign_id: "saved-1", property_id: "p1" },
      { campaign_id: "saved-1", property_id: "l1" }, // promoted to a lead AFTER the freeze
    ],
    messages: [],
  };
  h.createClientMock.mockImplementation(async () => fakeClient());
  h.resolveAdHoc.mockImplementation(async (_c: unknown, args: { propertyIds: string[] }) => ({
    ok: true,
    data: { campaignId: "adhoc-new", propertyIds: args.propertyIds },
  }));
  h.queueSmsBatch.mockResolvedValue({ succeeded: 2, skipped: 0, failed: [] });
  h.loadDelivery.mockResolvedValue({ senderNumber: "+15550001111" });
  h.assessLineTypes.mockImplementation(async (_c: unknown, ids: string[]) => ({
    total: ids.length, mobile: ids.length, landline: 0, unknown: 0, noPhone: 0,
  }));
});

describe("ad-hoc bulk SMS is prospect-only", () => {
  it("queues prospects only, freezes the FILTERED ids, and reports skipped leads", async () => {
    const out = await bulkQueueSms(["p1", "l1", "p2", "d1", "l2"], adHoc);
    expect(out).toMatchObject({ ok: true, data: { succeeded: 2, skippedLeads: 3 } });
    expect(h.resolveAdHoc.mock.calls[0][1].propertyIds).toEqual(["p1", "p2"]);
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1", "p2"]);
  });

  it("drops a forged lead id and an other-org id (not visible to the caller) before freezing or queueing", async () => {
    const out = await bulkQueueSms(["p1", "l1", "other-org-property-id"], adHoc);
    expect(out).toMatchObject({ ok: true, data: { skippedLeads: 2 } });
    expect(h.resolveAdHoc.mock.calls[0][1].propertyIds).toEqual(["p1"]);
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1"]);
  });

  it("a select-all-matching selection is re-resolved on the server and adds its matched-lead count", async () => {
    h.selectAll.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["p1", "p2"], eligibleCount: 2, dncLockedCount: 0, matchedCount: 6, skippedLeads: 4 },
    });
    const filters = { search: "jane", blockStack: [], origin: "search_page" as const };
    const out = await bulkQueueSms({ filters }, adHoc);
    expect(h.selectAll).toHaveBeenCalledWith(filters);
    expect(out).toMatchObject({ ok: true, data: { succeeded: 2, skippedLeads: 4 } });
    expect(h.resolveAdHoc.mock.calls[0][1].propertyIds).toEqual(["p1", "p2"]);
  });

  it("a filter selection can never be used for a saved campaign", async () => {
    const out = await bulkQueueSms(
      { filters: { search: null, blockStack: [] } },
      { ...baseOpts, campaignId: "saved-1" },
    );
    expect(out).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(h.selectAll).not.toHaveBeenCalled();
  });

  it("an all-leads selection queues nothing and creates no campaign", async () => {
    const out = await bulkQueueSms(["l1", "l2", "d1"], adHoc);
    expect(out).toEqual({ ok: true, data: { succeeded: 0, skipped: 0, failed: [], skippedLeads: 3 } });
    expect(h.resolveAdHoc).not.toHaveBeenCalled();
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
  });

  it("a forged id for a soft-deleted or unknown property is skipped", async () => {
    h.tables.properties.push({ id: "gone", org_id: "org", status: "prospect", deleted_at: "2026-01-01" });
    const out = await bulkQueueSms(["p1", "gone", "ghost"], adHoc);
    expect(out).toMatchObject({ ok: true, data: { skippedLeads: 2 } });
    expect(h.resolveAdHoc.mock.calls[0][1].propertyIds).toEqual(["p1"]);
  });

  it(">500 selections defer with only filtered ids in the job and the skip count", async () => {
    const many = Array.from({ length: 520 }, (_, i) => ({ id: `bulk-${i}`, org_id: "org", status: "prospect", deleted_at: null }));
    h.tables.properties.push(...many);
    const ids = [...many.map((r) => r.id as string), "l1", "l2"];
    const out = await bulkQueueSms(ids, adHoc);
    expect(out).toMatchObject({ ok: true, data: { skippedLeads: 2, deferred: { jobId: "job-1", total: 520 } } });
    const job = h.inserted.find((i) => i.table === "jobs")!.values as { input_params: { property_ids: string[] } };
    expect(job.input_params.property_ids).toHaveLength(520);
    expect(job.input_params.property_ids).not.toContain("l1");
  });
});

describe("saved-campaign sends are bound to the frozen audience", () => {
  const saved = { ...baseOpts, campaignId: "saved-1" };

  it("sends exactly the frozen recipients, including one promoted to a lead after the freeze", async () => {
    const out = await bulkQueueSms(["p1", "l1"], saved);
    expect(out.ok).toBe(true);
    expect(h.queueSmsBatch.mock.calls[0][1].propertyIds).toEqual(["p1", "l1"]);
    // Saved-campaign outcomes carry no ad-hoc skip count.
    expect(out.ok && "skippedLeads" in out.data).toBe(false);
  });

  it("rejects an injected id that is outside the frozen audience", async () => {
    const out = await bulkQueueSms(["p1", "p2"], saved); // p2 is not frozen
    expect(out).toMatchObject({ ok: false, error: { code: "CAMPAIGN_AUDIENCE_MISMATCH" } });
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
  });

  it("rejects an injected lead id", async () => {
    const out = await bulkQueueSms(["p1", "l2"], saved);
    expect(out).toMatchObject({ ok: false, error: { code: "CAMPAIGN_AUDIENCE_MISMATCH" } });
  });

  it("rejects an ad-hoc campaign id presented as a saved campaign", async () => {
    h.tables.campaign_recipients.push({ campaign_id: "adhoc-1", property_id: "l1" });
    const out = await bulkQueueSms(["l1"], { ...baseOpts, campaignId: "adhoc-1" });
    expect(out).toMatchObject({ ok: false, error: { code: "CAMPAIGN_SOURCE_MISMATCH" } });
    expect(h.queueSmsBatch).not.toHaveBeenCalled();
  });

  it("rejects ids when the campaign has no frozen audience at all", async () => {
    h.tables.campaign_recipients = [];
    const out = await bulkQueueSms(["p1"], saved);
    expect(out).toMatchObject({ ok: false, error: { code: "CAMPAIGN_AUDIENCE_MISMATCH" } });
  });
});

describe("modal counts use the same guard as the send", () => {
  it("assessBulkSmsAudience assesses prospects only and reports skipped leads", async () => {
    const out = await assessBulkSmsAudience(["p1", "p2", "l1", "d1"]);
    expect(out).toMatchObject({ ok: true, data: { total: 2, skippedLeads: 2 } });
    expect(h.assessLineTypes.mock.calls[0][1]).toEqual(["p1", "p2"]);
  });

  it("countAlreadyContacted ignores non-prospects", async () => {
    h.tables.messages = [
      { property_id: "p1", direction: "outbound", status: "sent" },
      { property_id: "l1", direction: "outbound", status: "sent" },
    ];
    const out = await countAlreadyContacted(["p1", "l1", "p2"]);
    expect(out).toEqual({ ok: true, data: 1 });
  });
});
