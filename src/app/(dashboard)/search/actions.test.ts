import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const okOutcome = async (ids: string[]) => ({ ok: true, data: { succeeded: ids.length, skipped: 0, failed: [] as unknown[] } });
  return {
    rows: [] as Array<{ id: string; status: string; is_dnc_locked: boolean; deleted_at: string | null }>,
    selectAll: vi.fn(),
    assign: vi.fn((ids: string[]) => okOutcome(ids)),
    listAdd: vi.fn((ids: string[]) => okOutcome(ids)),
    listRemove: vi.fn((ids: string[]) => okOutcome(ids)),
    tag: vi.fn((ids: string[]) => okOutcome(ids)),
    del: vi.fn((ids: string[]) => okOutcome(ids)),
    customTag: vi.fn(async (a: { propertyIds: string[] }) => ({ ok: true, data: { tag: { id: "t" }, outcome: { succeeded: a.propertyIds.length, skipped: 0, failed: [] } } })),
    verify: vi.fn(async (ids: string[]) => ({ ok: true, data: { jobId: "j", ids } })),
    assess: vi.fn(async (ids: string[]) => ({ ok: true, data: { total: ids.length, mobile: ids.length, landline: 0, unknown: 0, noPhone: 0 } })),
    contacted: vi.fn(async () => ({ ok: true, data: 0 })),
    sms: vi.fn(async (ids: string[]) => ({ ok: true, data: { succeeded: ids.length, skipped: 0, failed: [] } })),
    dialerCreate: vi.fn(async (ids: string[]) => ({ ok: true, data: { batchId: "b", counts: { callable: ids.length, blocked: {}, missing: 0 } } })),
    dialerPreview: vi.fn(async (ids: string[]) => ({ ok: true, data: { callable: ids.length, blocked: {}, missing: 0 } })),
    promote: vi.fn(async () => ({ ok: true, data: { jobId: "pj", duplicate: false, status: "queued", counts: {}, workflowRunId: null } })),
    stPreflight: vi.fn(async (ids: string[]) => ({
      ok: true,
      data: { requested: ids.length, eligible: ids.length, cassVerified: 0, cassUnverified: ids.length, notEligible: 0, killSwitchSkipped: 0, tracefyCreditsRequired: 0, tracefyCreditsAvailable: 1, tracefyCreditStatus: "sufficient", canLaunchSkipTrace: true, estimatedCassVerificationCostUsd: 0, cassVerificationPropertyIds: ids },
    })),
    stRequest: vi.fn(async (ids: string[]) => ({ ok: true, data: { jobId: "sj", status: "queued", requested: ids.length, eligible: ids.length, cassSkipped: 0, killSwitchSkipped: 0 } })),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => {
      let ids: string[] = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.in = (_c: string, v: string[]) => ((ids = v), q);
      q.is = () => q;
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: h.rows.filter((r) => ids.includes(r.id) && !r.deleted_at).map((r) => ({ id: r.id, status: r.status, is_dnc_locked: r.is_dnc_locked })), error: null });
      return q;
    },
  }),
}));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships: async () => [{ org_id: "org-1" }], getCallerMembershipsOrThrow: async () => [{ org_id: "org-1" }] }));
vi.mock("@/lib/auth/require-org-membership", () => ({ requireOrgMembership: async () => undefined }));
vi.mock("@/lib/prospects/select-all", () => ({ selectAllSearch: h.selectAll }));
vi.mock("@/lib/prospects/eligibility", () => ({
  resolveProspectEligibility: async (_c: unknown, ids: string[]) => ({ eligibleIds: ids, exclusions: [], dncLockedCount: 0, skipTraceDisabledCount: 0 }),
}));
vi.mock("../leads/actions", () => ({
  assignLeadsBulk: h.assign, addPropertiesToListBulk: h.listAdd, removePropertiesFromListBulk: h.listRemove,
  applyTagBulk: h.tag, deletePropertiesBulk: h.del, createAndApplyCustomTagBulk: h.customTag, verifyPropertiesBulk: h.verify,
}));
vi.mock("../properties/actions", () => ({
  assessBulkSmsAudience: h.assess, countAlreadyContacted: h.contacted, bulkQueueSms: h.sms,
  createDialerBatchFromPropertyIds: h.dialerCreate, previewBatchEligibilityAction: h.dialerPreview,
  listSmsTemplateCategories: async () => ({ ok: true, data: [] }),
}));
vi.mock("../properties/promote-leads-actions", () => ({ createPromoteLeadsJob: h.promote }));
vi.mock("../campaigns/actions", () => ({ listDeliveryOptions: async () => ({ ok: true, data: {} }), refreshDeliveryCatalog: async () => ({ ok: true, data: {} }) }));
vi.mock("@/lib/skip-trace/actions", () => ({ preflightSkipTrace: h.stPreflight, requestSkipTrace: h.stRequest }));

import * as actions from "./actions";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [P1, P2, LEAD, LOCKED_PROSPECT, LOCKED_LEAD] = [U(1), U(2), U(3), U(4), U(5)];
const SPEC = { search: "jane", blockStack: [] };
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";

type Case = {
  name: keyof typeof actions;
  input: (selection: unknown) => unknown;
  /** The legacy worker that must receive ONLY the prospect ids. */
  worker?: { fn: { mock: { calls: unknown[][] } }; ids: (call: unknown[]) => string[] };
  /** Actions that do not act on rows (counts) or are catalog helpers. */
  readonly?: boolean;
};
const first = (call: unknown[]) => call[0] as string[];
const key = "00000000-0000-4000-8000-0000000000aa";

const TABLE: Case[] = [
  { name: "searchAssign", input: (selection) => ({ selection, userId: "u2" }), worker: { fn: h.assign, ids: first } },
  { name: "searchListAdd", input: (selection) => ({ selection, listId: "l1" }), worker: { fn: h.listAdd, ids: first } },
  { name: "searchListRemove", input: (selection) => ({ selection, listId: "l1" }), worker: { fn: h.listRemove, ids: first } },
  { name: "searchTag", input: (selection) => ({ selection, tagId: "t1" }), worker: { fn: h.tag, ids: first } },
  { name: "searchDelete", input: (selection) => ({ selection }), worker: { fn: h.del, ids: first } },
  { name: "searchCustomTag", input: (selection) => ({ selection, name: "wave" }), worker: { fn: h.customTag, ids: (c) => (c[0] as { propertyIds: string[] }).propertyIds } },
  { name: "searchBulkSms", input: (selection) => ({ selection, opts: { campaignName: "c", paceSeconds: 8, body: "hi" } }), worker: { fn: h.sms, ids: first } },
  { name: "searchSmsAudience", input: (selection) => ({ selection }), worker: { fn: h.assess, ids: first } },
  { name: "searchDialerPreview", input: (selection) => ({ selection }), worker: { fn: h.dialerPreview, ids: first } },
  { name: "searchDialerCreate", input: (selection) => ({ selection }), worker: { fn: h.dialerCreate, ids: first } },
  { name: "searchPromotePreflight", input: (selection) => ({ orgId: "org-1", selection }) },
  { name: "searchPromoteCreate", input: (selection) => ({ orgId: "org-1", selection, idempotencyKey: key }), worker: { fn: h.promote, ids: (c) => (c[0] as { propertyIds: string[] }).propertyIds } },
  { name: "searchSkipTracePreflight", input: (selection) => ({ selection }), worker: { fn: h.stPreflight, ids: first } },
  { name: "searchSkipTraceRequest", input: (selection) => ({ selection }), worker: { fn: h.stRequest, ids: first } },
  { name: "searchCass", input: (selection) => ({ selection, requestKey: key }), worker: { fn: h.verify, ids: first } },
  { name: "searchCassForSkipTrace", input: (selection) => ({ selection, requestKey: key }), worker: { fn: h.verify, ids: first } },
  { name: "searchSelectAllCount", input: (selection) => ({ selection }), readonly: true },
];
const NON_SELECTION = ["searchCount", "searchSmsTemplateCategories", "searchDeliveryOptions", "searchRefreshDeliveryCatalog"];

function resetMocks() {
  for (const v of Object.values(h)) if (typeof v === "function" && "mockClear" in v) (v as { mockClear(): void }).mockClear();
}

beforeEach(() => {
  resetMocks();
  h.rows = [
    { id: P1, status: "prospect", is_dnc_locked: false, deleted_at: null },
    { id: P2, status: "prospect", is_dnc_locked: false, deleted_at: null },
    { id: LEAD, status: "new_lead", is_dnc_locked: false, deleted_at: null },
    { id: LOCKED_PROSPECT, status: "prospect", is_dnc_locked: true, deleted_at: null },
    { id: LOCKED_LEAD, status: "closed", is_dnc_locked: true, deleted_at: null },
  ];
  h.selectAll.mockResolvedValue({
    ok: true,
    data: { eligibleIds: [P1, P2], eligibleCount: 2, dncLockedCount: 1, dncLockedIds: [LOCKED_PROSPECT], matchedCount: 5, skippedLeads: 2 },
  });
});

describe("export table", () => {
  it("the module's exports are exactly the audited Search entry points (add one => add a table row)", () => {
    const exported = Object.keys(actions).sort();
    const audited = [...TABLE.map((c) => c.name), ...NON_SELECTION, ...["searchCassForSkipTrace"]].filter((v, i, a) => a.indexOf(v) === i).sort();
    expect(exported).toEqual(audited);
  });
});

describe.each(TABLE)("$name", ({ name, input, worker, readonly }) => {
  const call = (selection: unknown) => (actions[name] as (i: unknown) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { code: string } }>)(input(selection));

  it("a mixed ids selection acts on prospects only; leads and DNC-locked prospects are reported", async () => {
    const out = await call({ kind: "ids", ids: [P1, P2, LEAD, LOCKED_PROSPECT, LOCKED_LEAD] });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (worker) {
      expect(worker.fn.mock.calls.length).toBeGreaterThan(0);
      expect(worker.ids(worker.fn.mock.calls.at(-1)!)).toEqual([P1, P2]);
    }
    const data = out.data as Record<string, unknown>;
    const asText = JSON.stringify(data);
    if (name !== "searchSkipTraceRequest" && name !== "searchSkipTracePreflight") {
      expect(asText).toMatch(/skippedLeads|staleOrNotProspect/);
    }
    // the locked LEAD is a skipped lead (2 = lead + locked lead), the locked PROSPECT is DNC (1).
    if (name === "searchSelectAllCount") expect(data).toMatchObject({ matchedCount: 5, eligibleCount: 2, dncLockedCount: 1, skippedLeads: 2 });
  });

  it("a filters selection is resolved on the server; only its prospects are acted on", async () => {
    const out = await call({ kind: "filters", filters: SPEC });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(h.selectAll).toHaveBeenCalledWith({ search: "jane", blockStack: [], imported: null });
    if (worker) expect(worker.ids(worker.fn.mock.calls.at(-1)!)).toEqual([P1, P2]);
  });

  it("20,001 explicit ids are rejected before anything runs (no partial selection)", async () => {
    const many = Array.from({ length: 20_001 }, (_, i) => U(100 + i));
    const out = await call({ kind: "ids", ids: many });
    expect(out).toMatchObject({ ok: false, error: { code: "SELECT_ALL_TOO_LARGE" } });
    if (worker) expect(worker.fn.mock.calls).toHaveLength(0);
  });

  it("a filter selection over the cap is rejected (select-all returns the too-large error) and nothing runs", async () => {
    h.selectAll.mockResolvedValue({ ok: false, error: { code: "SELECT_ALL_TOO_LARGE", message: "too big" } });
    const out = await call({ kind: "filters", filters: SPEC });
    expect(out).toMatchObject({ ok: false, error: { code: "SELECT_ALL_TOO_LARGE" } });
    if (worker) expect(worker.fn.mock.calls).toHaveLength(0);
  });

  it("strict input: a forged origin/mode/cap or unknown key is rejected, never ignored", async () => {
    for (const forged of [
      { kind: "filters", filters: { ...SPEC, origin: "legacy" } },
      { kind: "filters", filters: SPEC, origin: "legacy" },
      { kind: "ids", ids: [P1], cap: 10 },
      { kind: "ids", ids: ["not-a-uuid"] },
      { kind: "weird", ids: [] },
    ]) {
      const out = await call(forged);
      expect(out, JSON.stringify(forged)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    const extra = await (actions[name] as (i: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)({
      ...(input({ kind: "ids", ids: [P1] }) as object),
      origin: "legacy",
    });
    expect(extra).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    if (worker) expect(worker.fn.mock.calls).toHaveLength(0);
    void readonly;
  });
});

describe("skip trace + CASS token flow", () => {
  it("a filters preflight returns a signed token; CASS re-resolves from it and recomputes the subset server-side", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
    const pre = await actions.searchSkipTracePreflight({ selection: { kind: "filters", filters: SPEC } } as never);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.data.selectionToken).toBeTruthy();
    expect(pre.data.cassVerificationPropertyIds).toEqual([]); // the id list is withheld
    h.verify.mockClear();
    h.selectAll.mockClear();
    const out = await actions.searchCassForSkipTrace({ selectionToken: pre.data.selectionToken, requestKey: key });
    expect(out.ok).toBe(true);
    expect(h.selectAll).toHaveBeenCalledWith({ search: "jane", blockStack: [], imported: null });
    expect(h.verify.mock.calls[0][0]).toEqual([P1, P2]); // recomputed on the server (preflight worker's unverified subset)
  });

  it("a tampered or foreign token is rejected and nothing runs", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
    const pre = await actions.searchSkipTracePreflight({ selection: { kind: "filters", filters: SPEC } } as never);
    if (!pre.ok) throw new Error("preflight failed");
    const token = pre.data.selectionToken!;
    h.verify.mockClear();
    const tampered = await actions.searchCassForSkipTrace({ selectionToken: token.slice(0, -2) + "xx", requestKey: key });
    expect(tampered).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const both = await actions.searchCassForSkipTrace({ selectionToken: token, selection: { kind: "ids", ids: [P1] }, requestKey: key } as never);
    expect(both).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(h.verify).not.toHaveBeenCalled();
  });
});

describe("bulk SMS is ad-hoc only and freezes prospects only", () => {
  it("rejects a saved-campaign id", async () => {
    const out = await actions.searchBulkSms({ selection: { kind: "ids", ids: [P1] }, opts: { campaignId: "c1", paceSeconds: 8 } } as never);
    expect(out).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(h.sms).not.toHaveBeenCalled();
  });
});
