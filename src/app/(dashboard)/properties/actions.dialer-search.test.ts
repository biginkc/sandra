import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  eligibility: vi.fn(),
  selectAll: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: h.createClientMock }));
vi.mock("@/lib/prospects/eligibility", () => ({ resolveProspectEligibility: h.eligibility }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/prospects/select-all", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/prospects/select-all")>();
  return {
    ...actual,
    selectAllMatching: h.selectAll,
    resolveSelection: async (s: any) => {
      const filters = actual.selectionFilters(s);
      const origin = actual.selectionOrigin(s);
      if (!filters) {
        const ids = actual.selectionIds(s);
        return { ok: true, data: { ids, skippedLeads: 0, dncLockedCount: 0, dncLockedIds: [], matchedCount: ids.length, fromFilters: false, origin } };
      }
      const r: any = await h.selectAll(filters);
      return { ok: true, data: { ids: r.data.eligibleIds, skippedLeads: r.data.skippedLeads, dncLockedCount: r.data.dncLockedCount, dncLockedIds: [], matchedCount: r.data.matchedCount, fromFilters: true, origin } };
    },
  };
});

import { createDialerBatchFromPropertyIds, previewBatchEligibilityAction } from "./actions";

function rowsQuery(rows: unknown[]) {
  const q: any = {};
  q.select = () => q;
  q.in = () => q;
  q.is = () => q;
  q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
  return q;
}

const homeowner = { id: "c1", phone_1: "+18165550001", phone_2: null, phone_3: null, do_not_contact: false, sms_opted_out: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.createClientMock.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: h.fromMock,
  });
  h.fromMock.mockImplementation(() =>
    rowsQuery([{ id: "p1", org_id: "o1", state: "MO", homeowner }]),
  );
  h.eligibility.mockResolvedValue({
    eligibleIds: ["p1"],
    exclusions: [{ propertyId: "lead-1", reason: "not_found_or_not_prospect" }],
    dncLockedCount: 0,
    skipTraceDisabledCount: 0,
    skippedLeadCount: 1,
    prospectDncLockedCount: 0,
    prospectDncLockedIds: [],
  });
});

describe("dialer preview: server-derived skipped leads", () => {
  it("Search checkbox ids report skippedLeads from the resolver (no client zero)", async () => {
    const out = await previewBatchEligibilityAction({ ids: ["p1", "lead-1"], origin: "search_page" });
    expect(out).toMatchObject({ ok: true, data: { skippedLeads: 1 } });
  });

  it("legacy id arrays keep the exact old shape (no skippedLeads field)", async () => {
    const out = await previewBatchEligibilityAction(["p1", "lead-1"]);
    expect(out.ok && "skippedLeads" in out.data).toBe(false);
  });

  it("a filter selection is resolved server-side (the client sends no ids) and adds its matched-lead count", async () => {
    h.selectAll.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["p1"], eligibleCount: 1, dncLockedCount: 2, matchedCount: 6, skippedLeads: 3 },
    });
    const filters = { search: "jane", blockStack: [], origin: "search_page" as const };
    const out = await previewBatchEligibilityAction({ filters });
    expect(h.selectAll).toHaveBeenCalledWith(filters);
    expect(out).toMatchObject({ ok: true, data: { skippedLeads: 4 } });
    expect(out.ok && out.data.blocked.dnc_locked).toBe(2);
  });
});

describe("createDialerBatchFromPropertyIds skip count", () => {
  it("is returned only for the search_page origin", async () => {
    h.fromMock.mockImplementation((table: string) => {
      if (table === "dialer_batches") {
        const q: any = { insert: () => q, select: () => q, single: async () => ({ data: { id: "b1" }, error: null }) };
        return q;
      }
      if (table === "dialer_batch_items") return { insert: async () => ({ error: null }) };
      return rowsQuery([{ id: "p1", org_id: "o1", state: "MO", homeowner }]);
    });
    const search = await createDialerBatchFromPropertyIds(["p1", "lead-1"], { origin: "search_page" });
    expect(search).toMatchObject({ ok: true, data: { batchId: "b1", skippedLeads: 1 } });
    const legacy = await createDialerBatchFromPropertyIds(["p1", "lead-1"]);
    expect(legacy.ok && "skippedLeads" in legacy.data).toBe(false);
  });
});
