import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assignUnsafe,
  createClientMock,
  createTagUnsafe,
  preflightUnsafe,
  requestUnsafe,
  selectionMock,
  verifyUnsafe,
} = vi.hoisted(() => ({
  createTagUnsafe: vi.fn(),
  selectionMock: vi.fn(),
  assignUnsafe: vi.fn(),
  createClientMock: vi.fn(),
  preflightUnsafe: vi.fn(),
  requestUnsafe: vi.fn(),
  verifyUnsafe: vi.fn(),
}));

vi.mock("../leads/actions", () => ({
  addPropertiesToListBulk: vi.fn(),
  applyTagBulk: vi.fn(),
  assignLeadsBulk: assignUnsafe,
  createAndApplyCustomTagBulk: createTagUnsafe,
  deletePropertiesBulk: vi.fn(),
  qualifyLeadsBulk: vi.fn(),
  removePropertiesFromListBulk: vi.fn(),
  verifyPropertiesBulk: verifyUnsafe,
}));

vi.mock("@/lib/skip-trace/actions", () => ({
  preflightSkipTrace: preflightUnsafe,
  requestSkipTrace: requestUnsafe,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/prospects/select-all", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/prospects/select-all")>()),
  selectAllMatching: selectionMock,
  resolveSelection: async (s: any) => {
    const actual = await importActual<typeof import("@/lib/prospects/select-all")>();
    const filters = actual.selectionFilters(s);
    const origin = actual.selectionOrigin(s);
    if (!filters) {
      const ids = actual.selectionIds(s);
      return { ok: true, data: { ids, skippedLeads: 0, dncLockedCount: 0, dncLockedIds: [], matchedCount: ids.length, fromFilters: false, origin } };
    }
    const r: any = await selectionMock(filters);
    if (!r.ok) return r;
    return { ok: true, data: { ids: r.data.eligibleIds, skippedLeads: r.data.skippedLeads, dncLockedCount: r.data.dncLockedCount, dncLockedIds: r.data.dncLockedIds ?? [], matchedCount: r.data.matchedCount, fromFilters: true, origin } };
  },
}));

import {
  assignLeadsBulk,
  createAndApplyCustomTagBulkFromFilters,
  preflightProspectSkipTrace,
  requestProspectSkipTrace,
  verifyPropertiesBulk,
} from "./dnc-safe-actions";

function queryResult(data: unknown) {
  const promise = Promise.resolve({ data, error: null });
  const builder = {
    select: vi.fn(),
    in: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    is: vi.fn(),
    then: promise.then.bind(promise),
  };
  builder.select.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.or.mockReturnValue(builder);
  builder.is.mockReturnValue(builder);
  return builder;
}

describe("Prospects DNC-safe bulk actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignUnsafe.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    verifyUnsafe.mockResolvedValue({ ok: true, data: { jobId: "cass-job" } });
    preflightUnsafe.mockResolvedValue({
      ok: true,
      data: {
        requested: 1,
        eligible: 1,
        cassVerified: 1,
        cassUnverified: 0,
        notEligible: 0,
        killSwitchSkipped: 0,
        tracefyCreditsRequired: 1,
        tracefyCreditsAvailable: 10,
        tracefyCreditStatus: "sufficient",
        canLaunchSkipTrace: true,
        estimatedCassVerificationCostUsd: 0,
        cassVerificationPropertyIds: [],
      },
    });
    requestUnsafe.mockResolvedValue({
      ok: true,
      data: {
        jobId: "skip-job",
        status: "queued",
        requested: 1,
        eligible: 1,
        cassSkipped: 0,
        killSwitchSkipped: 0,
      },
    });
    createClientMock.mockResolvedValue({
      from: vi.fn((table: string) =>
        table === "properties"
          ? queryResult([
              {
                id: "locked",
                status: "prospect",
                is_dnc_locked: true,
                skip_trace_disabled: false,
              },
              {
                id: "locked-lead",
                status: "closed",
                is_dnc_locked: true,
                skip_trace_disabled: false,
              },
              {
                id: "eligible",
                status: "prospect",
                is_dnc_locked: false,
                skip_trace_disabled: false,
              },
            ])
          : queryResult([]),
      ),
    });
  });

  it("rechecks DNC on the server and never forwards the locked ID to a mutation", async () => {
    const result = await assignLeadsBulk(["locked", "eligible"], "user-1");

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    expect(result).toEqual({
      ok: true,
      data: {
        succeeded: 1,
        skipped: 0,
        failed: [{
          propertyId: "locked",
          message: "Prospect is locked Do Not Contact and cannot be changed in bulk.",
        }],
      },
    });
  });

  it("does not start CASS when a forged stale ID is now DNC", async () => {
    const result = await verifyPropertiesBulk(["locked"], "request-key");

    expect(verifyUnsafe).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: {
        code: "DNC_LOCKED",
        message: "Prospect is locked Do Not Contact and cannot be changed in bulk.",
      },
    });
  });

  it("filters DNC before skip-trace preflight can check credits", async () => {
    const result = await preflightProspectSkipTrace(["locked", "eligible"]);

    expect(preflightUnsafe).toHaveBeenCalledWith(["eligible"]);
    expect(result.ok && result.data.dncLockedSkipped).toBe(1);
  });

  it("does not request skip trace when every forged ID is DNC", async () => {
    const result = await requestProspectSkipTrace(["locked"]);

    expect(requestUnsafe).not.toHaveBeenCalled();
    expect(result.ok && result.data.status).toBe("none_eligible");
    expect(result.ok && result.data.dncLockedSkipped).toBe(1);
  });

  it("LEGACY (plain id array): a DNC-locked lead is still reported as a locked failure, with no lead count (parity with main)", async () => {
    const result = await assignLeadsBulk(["locked-lead", "locked", "eligible"], "user-1");

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    // origin/main behavior: every DNC-locked row (any status) is a failure; no skippedLeads field.
    expect(result.ok && result.data.failed.map((f) => f.propertyId)).toEqual(["locked-lead", "locked"]);
    expect(result.ok && "skippedLeads" in result.data).toBe(false);
  });

  it("LEGACY CASS: lockedCount still counts a locked lead", async () => {
    const result = await verifyPropertiesBulk(["locked-lead", "eligible"], "key");
    expect(result.ok && result.data.lockedCount).toBe(1);
    expect(result.ok && "skippedLeads" in result.data).toBe(false);
  });

  it("SEARCH checkbox ids: a DNC-locked LEAD is a skipped lead (leads before the DNC split), only locked prospects fail", async () => {
    const result = await assignLeadsBulk({ ids: ["locked-lead", "locked", "eligible"], origin: "search_page" as const }, "user-1");

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    expect(result.ok && result.data.skippedLeads).toBe(1);
    expect(result.ok && result.data.failed.map((f) => f.propertyId)).toEqual(["locked"]);
  });

  it("SEARCH checkbox ids: a forged lead id and an other-org id are dropped before any mutation and counted", async () => {
    const result = await assignLeadsBulk({ ids: ["some-lead", "other-org-id", "eligible"], origin: "search_page" as const }, "user-1");

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    expect(result.ok && result.data.skippedLeads).toBe(2);
  });

  it("filter selection reports DNC-locked prospects exactly like the checkbox path (parity)", async () => {
    selectionMock.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["eligible"], eligibleCount: 1, dncLockedCount: 1, dncLockedIds: ["locked"], matchedCount: 3, skippedLeads: 1 },
    });
    const viaFilters = await assignLeadsBulk({ filters: { search: "x", blockStack: [], origin: "search_page" } }, "user-1");
    const viaIds = await assignLeadsBulk({ ids: ["locked-lead", "locked", "eligible"], origin: "search_page" as const }, "user-1");
    expect(viaFilters).toEqual(viaIds);
    expect(viaFilters.ok && viaFilters.data.failed.map((f) => f.propertyId)).toEqual(["locked"]);
  });

  it("select-all-matching re-resolves from filters server-side: no id list reaches the action from the client", async () => {
    selectionMock.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["eligible"], eligibleCount: 1, dncLockedCount: 1, dncLockedIds: ["locked"], matchedCount: 5, skippedLeads: 3 },
    });
    const result = await assignLeadsBulk(
      { filters: { search: "jane", blockStack: [], origin: "search_page" } },
      "user-1",
    );

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    expect(result.ok && result.data.skippedLeads).toBe(3);
    expect(result.ok && result.data.failed.map((f) => f.propertyId)).toEqual(["locked"]);
  });

  it("reports leads in a SEARCH selection as skipped instead of silently dropping them", async () => {
    const result = await assignLeadsBulk({ ids: ["lead-not-in-prospect-set", "eligible"], origin: "search_page" as const }, "user-1");

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    expect(result.ok && result.data.skippedLeads).toBe(1);
  });

  it("omits skippedLeads when nothing was skipped", async () => {
    const result = await assignLeadsBulk(["eligible"], "user-1");
    expect(result.ok && "skippedLeads" in result.data).toBe(false);
  });

  it("tag-from-filters forwards the origin and adds the matched-lead skip count", async () => {
    selectionMock.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["eligible"], eligibleCount: 1, dncLockedCount: 0, matchedCount: 4, skippedLeads: 3 },
    });
    createTagUnsafe.mockResolvedValue({
      ok: true,
      data: { tag: { id: "t" }, outcome: { succeeded: 1, skipped: 0, failed: [] } },
    });

    const result = await createAndApplyCustomTagBulkFromFilters({
      name: "wave",
      search: "jane",
      blockStack: [],
      origin: "search_page",
    });

    expect(selectionMock).toHaveBeenCalledWith(
      { search: "jane", blockStack: [], imported: null, origin: "search_page" },
      { enforceCap: true },
    );
    expect(createTagUnsafe).toHaveBeenCalledWith(
      expect.objectContaining({ propertyIds: ["eligible"] }),
    );
    expect(result.ok && result.data.outcome.skippedLeads).toBe(3);
  });

  it("tag-from-filters without an origin stays legacy (origin undefined is forwarded as-is)", async () => {
    selectionMock.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["eligible"], eligibleCount: 1, dncLockedCount: 0, matchedCount: 1, skippedLeads: 0 },
    });
    createTagUnsafe.mockResolvedValue({
      ok: true,
      data: { tag: { id: "t" }, outcome: { succeeded: 1, skipped: 0, failed: [] } },
    });
    const result = await createAndApplyCustomTagBulkFromFilters({ name: "w", search: null, blockStack: [] });
    expect(selectionMock.mock.calls[0][0].origin).toBeUndefined();
    expect(result.ok && "skippedLeads" in result.data.outcome).toBe(false);
  });

  it("CASS from a filter selection resolves server-side and reports locked prospects and skipped leads", async () => {
    selectionMock.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["eligible"], eligibleCount: 1, dncLockedCount: 2, dncLockedIds: ["a", "b"], matchedCount: 6, skippedLeads: 3 },
    });
    const filters = { search: "x", blockStack: [], origin: "search_page" as const };
    const result = await verifyPropertiesBulk({ filters }, "key");
    expect(selectionMock).toHaveBeenCalledWith(filters);
    expect(verifyUnsafe).toHaveBeenCalledWith(["eligible"], "key");
    expect(result.ok && result.data.lockedCount).toBe(2);
    expect(result.ok && result.data.skippedLeads).toBe(3);
  });

  it("skip-trace preflight/request from a filter selection use server-resolved ids and count every matched row", async () => {
    selectionMock.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["eligible"], eligibleCount: 1, dncLockedCount: 1, dncLockedIds: ["locked"], matchedCount: 5, skippedLeads: 3 },
    });
    const filters = { search: "x", blockStack: [], origin: "search_page" as const };
    const pre = await preflightProspectSkipTrace({ filters });
    expect(preflightUnsafe).toHaveBeenCalledWith(["eligible"]);
    expect(pre.ok && pre.data.requested).toBe(5);
    expect(pre.ok && pre.data.dncLockedSkipped).toBe(1);
    const req = await requestProspectSkipTrace({ filters });
    expect(requestUnsafe).toHaveBeenCalledWith(["eligible"]);
    expect(req.ok && req.data.requested).toBe(5);
  });

  it("skip-trace filter selection: requested == eligible + notEligible (every matched row is accounted for)", async () => {
    selectionMock.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["eligible"], eligibleCount: 1, dncLockedCount: 2, dncLockedIds: ["l1", "l2"], matchedCount: 6, skippedLeads: 3 },
    });
    preflightUnsafe.mockResolvedValue({
      ok: true,
      data: {
        requested: 1, eligible: 1, cassVerified: 1, cassUnverified: 0, notEligible: 0, killSwitchSkipped: 0,
        tracefyCreditsRequired: 1, tracefyCreditsAvailable: 10, tracefyCreditStatus: "sufficient",
        canLaunchSkipTrace: true, estimatedCassVerificationCostUsd: 0, cassVerificationPropertyIds: [],
      },
    });
    const pre = await preflightProspectSkipTrace({ filters: { search: "x", blockStack: [], origin: "search_page" } });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.data.requested).toBe(6);
    expect(pre.data.eligible + pre.data.notEligible).toBe(pre.data.requested);
    expect(pre.data.notEligible).toBe(5); // 3 leads + 2 DNC-locked prospects
  });
});
