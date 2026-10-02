import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: [] as string[],
  result: { count: 7 as number | null, error: null as null | { code: string; message: string } },
  createClientMock: vi.fn(),
  requireOrg: vi.fn(),
  memberships: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: h.createClientMock }));
vi.mock("@/lib/auth/require-org-membership", () => ({ requireOrgMembership: h.requireOrg }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: h.memberships }));

function builder() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "is", "eq", "or", "ilike", "not", "gte", "lt", "in"]) {
    q[m] = (...a: unknown[]) => (h.log.push(`${m}(${a.map((x) => JSON.stringify(x)).join(",")})`), q);
  }
  q.then = (resolve: (v: unknown) => unknown) => resolve({ ...h.result });
  return q;
}

import { countProspectsForFilter } from "./count";

beforeEach(() => {
  vi.clearAllMocks();
  h.log = [];
  h.result = { count: 7, error: null };
  h.requireOrg.mockResolvedValue(undefined);
  h.memberships.mockResolvedValue([
    { user_id: "u", org_id: "o", role: "member", acquisitions_enabled: false, access_status: "active", access_expires_at: null, deletion_prepared_at: null },
  ]);
  h.createClientMock.mockResolvedValue({
    from: () => (h.log.push("from"), builder()),
    rpc: (name: string, args: unknown, opts: unknown) => (
      h.log.push(`rpc(${name},${JSON.stringify(args)},${JSON.stringify(opts)})`),
      { select: () => builder() }
    ),
  });
});

describe("countProspectsForFilter", () => {
  it("legacy (default) applies the page's search and Imported Today (the old drift is fixed)", async () => {
    const out = await countProspectsForFilter({
      orgId: "o",
      blocks: [],
      search: "main",
      imported: "today",
    });
    expect(out).toEqual({ ok: true, data: { count: 7 } });
    expect(h.log).toContain('or("status.eq.prospect,is_dnc_locked.eq.true")');
    expect(h.log).toContain('ilike("address","%main%")');
    expect(h.log).toContain('not("source_import_id","is",null)');
    expect(h.log.some((l) => l.startsWith("rpc("))).toBe(false);
    expect(h.memberships).not.toHaveBeenCalled();
  });

  it("without search/imported the legacy count is exactly what it was", async () => {
    await countProspectsForFilter({ orgId: "o", blocks: [] });
    expect(h.log.some((l) => l.startsWith("ilike("))).toBe(false);
    expect(h.log.some((l) => l.startsWith("not("))).toBe(false);
  });

  it("search_page counts through the RPC with head+count and server-derived include_messages", async () => {
    await countProspectsForFilter({
      orgId: "o",
      blocks: [],
      search: "jane doe",
      origin: "search_page",
    });
    expect(h.log.find((l) => l.startsWith("rpc("))).toBe(
      'rpc(search_properties,{"q":"jane doe","include_messages":true},{"count":"exact","head":true})',
    );
    expect(h.log).toContain('eq("is_training",false)');
    expect(h.log).not.toContain('or("status.eq.prospect,is_dnc_locked.eq.true")');
  });

  it("a client cannot force message matching: restricted members get include_messages false", async () => {
    h.memberships.mockResolvedValue([
      { user_id: "u", org_id: "o", role: "member", acquisitions_enabled: true, access_status: "active", access_expires_at: null, deletion_prepared_at: null },
    ]);
    await countProspectsForFilter({ orgId: "o", blocks: [], search: "wombatplan", origin: "search_page" });
    expect(h.log.find((l) => l.startsWith("rpc("))).toContain('"include_messages":false');
  });

  it("membership failure is an error result, not an unrestricted count", async () => {
    h.memberships.mockRejectedValue(new Error("down"));
    const out = await countProspectsForFilter({ orgId: "o", blocks: [], search: "jane", origin: "search_page" });
    expect(out).toMatchObject({ ok: false, error: { code: "SEARCH_ACCESS_UNAVAILABLE" } });
  });

  it("maps the statement timeout to the friendly message", async () => {
    h.result = { count: null, error: { code: "57014", message: "timeout" } };
    const out = await countProspectsForFilter({ orgId: "o", blocks: [], search: "the", origin: "search_page" });
    expect(out).toMatchObject({
      ok: false,
      error: { message: "Search too broad — try a more specific name, phone or address" },
    });
  });

  it("falls back to address search when the RPC is missing", async () => {
    let n = 0;
    h.createClientMock.mockResolvedValue({
      from: () => (h.log.push("from"), (() => {
        const b = builder() as { then: unknown };
        b.then = (resolve: (v: unknown) => unknown) => resolve({ count: 3, error: null });
        return b;
      })()),
      rpc: () => ({
        select: () => {
          n++;
          const b = builder() as { then: unknown };
          b.then = (resolve: (v: unknown) => unknown) => resolve({ count: null, error: { code: "PGRST202", message: "missing" } });
          return b;
        },
      }),
    });
    const out = await countProspectsForFilter({ orgId: "o", blocks: [], search: "main st", origin: "search_page" });
    expect(n).toBe(1);
    expect(out).toEqual({ ok: true, data: { count: 3 } });
    expect(h.log.some((l) => l.startsWith('ilike("address","%main st%")'))).toBe(true);
  });
});
