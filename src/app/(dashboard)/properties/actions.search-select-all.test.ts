import { beforeEach, describe, expect, it, vi } from "vitest";

type Script = {
  count: number | null;
  countError: { code: string; message: string } | null;
  pages: unknown[][];
  pageError: { code: string; message: string } | null;
  rpcMissing: boolean;
};

const { createClientMock, membershipsMock, eligibilityMock, state } = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    script: null as unknown as Script,
  };
  return {
    state,
    createClientMock: vi.fn(),
    membershipsMock: vi.fn(),
    eligibilityMock: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMembershipsOrThrow: membershipsMock,
}));
vi.mock("@/lib/prospects/eligibility", () => ({
  resolveProspectEligibility: eligibilityMock,
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

function makeBuilder(head: boolean, viaRpc: boolean) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ["select", "is", "eq", "or", "ilike", "in", "not", "gte", "lt", "gt", "order"]) {
    q[m] = (...a: unknown[]) => {
      state.log.push(`${m}(${a.map((x) => JSON.stringify(x)).join(",")})`);
      return self();
    };
  }
  q.limit = () => {
    state.log.push("limit");
    if (state.script.rpcMissing && viaRpc) {
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "missing" } });
    }
    if (state.script.pageError) return Promise.resolve({ data: null, error: state.script.pageError });
    return Promise.resolve({ data: state.script.pages.shift() ?? [], error: null });
  };
  q.then = (resolve: (v: unknown) => unknown) => {
    if (!head) return resolve({ data: [], error: null });
    if (state.script.rpcMissing && viaRpc) {
      return resolve({ count: null, error: { code: "PGRST202", message: "missing" } });
    }
    return resolve({ count: state.script.count, error: state.script.countError });
  };
  return q;
}

import { getAllMatchingProspectSelection } from "./actions";

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `p-${String(from + i).padStart(6, "0")}` }));

beforeEach(() => {
  vi.clearAllMocks();
  state.log = [];
  state.script = { count: 0, countError: null, pages: [], pageError: null, rpcMissing: false };
  membershipsMock.mockResolvedValue([
    { user_id: "u", org_id: "o", role: "member", acquisitions_enabled: false, access_status: "active", access_expires_at: null, deletion_prepared_at: null },
  ]);
  createClientMock.mockResolvedValue({
    from: () => {
      state.log.push("from");
      return {
        select: (cols: string, opts?: { head?: boolean }) => {
          state.log.push(`select(${cols})`);
          return makeBuilder(opts?.head === true, false);
        },
      };
    },
    rpc: (name: string, args: unknown, opts?: { head?: boolean }) => {
      state.log.push(`rpc(${name},${JSON.stringify(args)},${JSON.stringify(opts)})`);
      return { select: (cols: string) => { state.log.push(`select(${cols})`); return makeBuilder(opts?.head === true, true); } };
    },
  });
  eligibilityMock.mockImplementation(async (_c: unknown, all: string[]) => ({
    eligibleIds: all.filter((_x, i) => i % 2 === 0),
    exclusions: all.filter((_x, i) => i % 2 === 1).map((propertyId) => ({ propertyId, reason: "not_found_or_not_prospect" })),
    dncLockedCount: 0,
    skipTraceDisabledCount: 0,
  }));
});

describe("getAllMatchingProspectSelection: search_page origin", () => {
  it("returns matched and eligible sets separately, with leads broken out", async () => {
    state.script.count = 4;
    state.script.pages = [ids(4)];
    const out = await getAllMatchingProspectSelection({
      search: "jane doe",
      blockStack: [],
      origin: "search_page",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.matchedCount).toBe(4);
    expect(out.data.eligibleIds).toHaveLength(2);
    expect(out.data.skippedLeads).toBe(2);
    expect(out.data.dncLockedCount).toBe(0);
    // Went through the RPC with include_messages derived from memberships.
    expect(state.log.find((l) => l.startsWith("rpc("))).toContain('"include_messages":true');
  });

  it("restricted Acquisitions member: include_messages false", async () => {
    membershipsMock.mockResolvedValue([
      { user_id: "u", org_id: "o", role: "member", acquisitions_enabled: true, access_status: "active", access_expires_at: null, deletion_prepared_at: null },
    ]);
    state.script.count = 1;
    state.script.pages = [ids(1)];
    await getAllMatchingProspectSelection({ search: "jane", blockStack: [], origin: "search_page" });
    expect(state.log.find((l) => l.startsWith("rpc("))).toContain('"include_messages":false');
  });

  it("over the cap: error, no ids, and no paging at all", async () => {
    state.script.count = 10_001;
    const out = await getAllMatchingProspectSelection({ search: "smith", blockStack: [], origin: "search_page" });
    expect(out).toMatchObject({ ok: false, error: { code: "SELECT_ALL_TOO_LARGE" } });
    expect(JSON.stringify(out)).not.toContain("eligibleIds");
    expect(state.log).not.toContain("limit");
    expect(eligibilityMock).not.toHaveBeenCalled();
  });

  it("over the cap discovered while paging also errors with no partial selection", async () => {
    state.script.count = 9_000; // count lied (rows were added meanwhile)
    state.script.pages = Array.from({ length: 11 }, (_, p) => ids(1000, p * 1000));
    const out = await getAllMatchingProspectSelection({ search: "smith", blockStack: [], origin: "search_page" });
    expect(out).toMatchObject({ ok: false, error: { code: "SELECT_ALL_TOO_LARGE" } });
    expect(eligibilityMock).not.toHaveBeenCalled();
  });

  it("statement timeout (57014) becomes the friendly message", async () => {
    state.script.countError = { code: "57014", message: "canceling statement due to statement timeout" };
    const out = await getAllMatchingProspectSelection({ search: "the", blockStack: [], origin: "search_page" });
    expect(out).toEqual({
      ok: false,
      error: { code: "SEARCH_TOO_BROAD", message: "Search too broad — try a more specific name, phone or address" },
    });
  });

  it("missing RPC (PGRST202) falls back to address search instead of failing", async () => {
    state.script.rpcMissing = true;
    state.script.count = 2;
    state.script.pages = [ids(2)];
    const out = await getAllMatchingProspectSelection({ search: "main street", blockStack: [], origin: "search_page" });
    expect(out.ok).toBe(true);
    expect(state.log.some((l) => l.startsWith('ilike("address","%main street%")'))).toBe(true);
  });

  it("a membership lookup failure is an error, never an unrestricted search", async () => {
    membershipsMock.mockRejectedValue(new Error("down"));
    const out = await getAllMatchingProspectSelection({ search: "jane", blockStack: [], origin: "search_page" });
    expect(out).toMatchObject({ ok: false, error: { code: "SEARCH_ACCESS_UNAVAILABLE" } });
    expect(createClientMock.mock.results.length).toBeGreaterThan(0);
    expect(state.log.some((l) => l.startsWith("rpc("))).toBe(false);
  });
});

describe("getAllMatchingProspectSelection: legacy origin is unchanged", () => {
  it("is uncapped, never counts first, and never uses the RPC or membership lookup", async () => {
    state.script.pages = [ids(1000), ids(1000, 1000), ids(500, 2000)];
    const out = await getAllMatchingProspectSelection({ search: "jane doe", blockStack: [] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.matchedCount).toBe(2500); // > any search cap would allow? stays uncapped
    expect(state.log.some((l) => l.startsWith("rpc("))).toBe(false);
    expect(membershipsMock).not.toHaveBeenCalled();
    expect(state.log).toContain('or("status.eq.prospect,is_dnc_locked.eq.true")');
    // Unescaped wildcard-capable address ilike, exactly as before.
    expect(state.log).toContain('ilike("address","%jane doe%")');
  });

  it("a forged origin value is treated as legacy", async () => {
    state.script.pages = [ids(1)];
    await getAllMatchingProspectSelection({
      search: "a%b",
      blockStack: [],
      origin: "SEARCH_PAGE" as never,
    });
    expect(state.log).toContain('ilike("address","%a%b%")');
    expect(membershipsMock).not.toHaveBeenCalled();
  });
});
