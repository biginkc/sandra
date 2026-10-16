import { describe, expect, it, vi } from "vitest";

import {
  houseAddress,
  loadHomeownerHouses,
  loadHomeownerHousesPage,
  MAX_LISTED_HOUSES,
  MAX_PAGE_ROWS,
  type HousesClient,
} from "./homeowner-houses";

const ORG = "org-1";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";

type Row = {
  id: string; org_id: string; deleted_at: string | null; address: string; city: string | null; state: string | null;
  assigned_user_id: string | null; homeowner_contact_id: string | null;
};
const row = (id: string, contact: string, extra: Partial<Row> = {}): Row => ({
  id, org_id: ORG, deleted_at: null, address: `${id} Main St`, city: "Kansas City", state: "MO",
  assigned_user_id: ME, homeowner_contact_id: contact, ...extra,
});

/** A properties table that applies the filters the way PostgREST would, and records every call. */
function fakeClient(table: Row[], error: { message: string } | null = null) {
  const calls: { from: number; filters: unknown[][]; counted: number; orders: string[][] } = {
    from: 0, filters: [], counted: 0, orders: [],
  };
  const client = {
    from: vi.fn(() => {
      calls.from += 1;
      let rows = [...table];
      let counted = false;
      const sorts: string[] = [];
      calls.orders.push(sorts);
      // Like Postgres, rows the requested order leaves tied come back in no fixed order: here a different
      // order on every query, so a page query without a full tie-break repeats or skips rows.
      const call = calls.from;
      const tie = (id: string) => {
        let h = Math.imul(call + 1, 0x9e3779b1);
        for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 0x85ebca6b) ^ (h >>> 13);
        return (h ^ (h >>> 16)) >>> 0;
      };
      const sorted = () =>
        [...rows].sort((a, b) => {
          for (const key of sorts) {
            const d = String(a[key as keyof Row]).localeCompare(String(b[key as keyof Row]));
            if (d) return d;
          }
          return tie(a.id) - tie(b.id);
        });
      const query = {
        eq(column: string, value: string) { calls.filters.push(["eq", column, value]); rows = rows.filter((r) => r[column as keyof Row] === value); return query; },
        in(column: string, values: string[]) { calls.filters.push(["in", column, values]); rows = rows.filter((r) => values.includes(r[column as keyof Row] as string)); return query; },
        is(column: string, value: null) { calls.filters.push(["is", column, value]); rows = rows.filter((r) => r[column as keyof Row] === value); return query; },
        order(column: string) { sorts.push(column); return query; },
        limit: async (count: number) =>
          error ? { data: null, error } : { data: sorted().slice(0, count), error: null, count: counted ? rows.length : null },
        range: async (from: number, to: number) =>
          error ? { data: null, error } : { data: sorted().slice(from, to + 1), error: null, count: counted ? rows.length : null },
      };
      return {
        select: (_columns: string, options?: { count: "exact" }) => {
          counted = options?.count === "exact";
          if (counted) calls.counted += 1;
          return query;
        },
      };
    }),
  };
  return { client: client as unknown as HousesClient, calls };
}

const many = (contact: string, n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${String(i).padStart(4, "0")}`, contact));

describe("loadHomeownerHouses", () => {
  it("reads a whole page of homeowners in one query", async () => {
    const { client, calls } = fakeClient([row("p1", C1), row("p2", C1), row("p3", C2)]);
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1, C2, C1, null] });
    expect(calls.from).toBe(1);
    expect(calls.filters).toContainEqual(["in", "homeowner_contact_id", [C1, C2]]);
    expect(result[C1].count).toBe(2);
    expect(result[C2].count).toBe(1);
  });

  it("leaves out deleted houses", async () => {
    const { client, calls } = fakeClient([row("p1", C1), row("p2", C1, { deleted_at: "2026-10-01T00:00:00Z" })]);
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1] });
    expect(calls.filters).toContainEqual(["is", "deleted_at", null]);
    expect(result[C1]).toMatchObject({ count: 1, houses: [{ propertyId: "p1" }] });
  });

  it("stays inside the viewer's org", async () => {
    const { client, calls } = fakeClient([row("p1", C1), row("p2", C1, { org_id: "org-2" })]);
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1] });
    expect(calls.filters).toContainEqual(["eq", "org_id", ORG]);
    expect(result[C1].houses.map((h) => h.propertyId)).toEqual(["p1"]);
  });

  it("marks the viewer's own houses and lists the address with city and state", async () => {
    const { client } = fakeClient([row("p1", C1), row("p2", C1, { assigned_user_id: REP }), row("p3", C1, { assigned_user_id: null })]);
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1] });
    expect(result[C1].houses).toEqual([
      { propertyId: "p1", address: "p1 Main St, Kansas City, MO", assignedUserId: ME, isMine: true },
      { propertyId: "p2", address: "p2 Main St, Kansas City, MO", assignedUserId: REP, isMine: false },
      { propertyId: "p3", address: "p3 Main St, Kansas City, MO", assignedUserId: null, isMine: false },
    ]);
  });

  it("makes no query without homeowner ids", async () => {
    const { client, calls } = fakeClient([]);
    expect(await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [null, "not-a-uuid"] })).toEqual({});
    expect(calls.from).toBe(0);
  });

  it("throws on a read error", async () => {
    const { client } = fakeClient([], { message: "boom" });
    await expect(loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1] })).rejects.toThrow(/boom/);
  });

  it("formats addresses without blank parts", () => {
    expect(houseAddress({ address: "1 Oak", city: null, state: " MO " })).toBe("1 Oak, MO");
  });

  it("counts every house but lists at most the cap for one large owner", async () => {
    const { client, calls } = fakeClient([...many(C1, 60, "a"), row("z1", C2)]);
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1, C2] });
    expect(calls.from).toBe(1);
    expect(result[C1].count).toBe(60);
    expect(result[C1].houses).toHaveLength(MAX_LISTED_HOUSES);
    expect(result[C2]).toMatchObject({ count: 1 });
  });

  it("stays exact for every owner on the page when the combined rows pass the page ceiling", async () => {
    // C1's 1,100 houses sort first ("a…"), so the single page read would hide C2 and C3 entirely.
    const { client, calls } = fakeClient([...many(C1, 1100, "a"), row("m1", C2), row("m2", C2), row("m3", C3)]);
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1, C2, C3] });
    expect(calls.from).toBe(4);
    expect(calls.counted).toBe(3);
    expect(result[C1].count).toBe(1100);
    expect(result[C1].houses).toHaveLength(MAX_LISTED_HOUSES);
    expect(result[C2]).toMatchObject({ count: 2, houses: [{ propertyId: "m1" }, { propertyId: "m2" }] });
    expect(result[C3]).toMatchObject({ count: 1, houses: [{ propertyId: "m3" }] });
  });

  it("orders the ceiling fallback's tied addresses by id", async () => {
    // Past the page ceiling each owner is re-read on its own; six of C2's houses share one address, so only the id tie-break
    // fixes their order (the fake returns tied rows in a different order on every query, as Postgres may).
    const tied = ["t6", "t2", "t5", "t1", "t4", "t3"].map((id) => row(id, C2, { address: "9 Same St" }));
    const { client, calls } = fakeClient([...many(C1, 1100, "a"), ...tied]);
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1, C2] });
    expect(calls.from).toBe(3);
    expect(calls.orders.slice(1)).toEqual([["address", "id"], ["address", "id"]]);
    expect(result[C2].houses.map((h) => h.propertyId)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("does not fall back below the page ceiling", async () => {
    const { client, calls } = fakeClient(many(C1, MAX_PAGE_ROWS - 1, "a"));
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1] });
    expect(calls.from).toBe(1);
    expect(result[C1].count).toBe(MAX_PAGE_ROWS - 1);
  });
});

describe("loadHomeownerHousesPage (Show more)", () => {
  it("continues an owner with 60 houses from house 51 to 60, in the first paint's order", async () => {
    const table = many(C1, 60, "a");
    const first = await loadHomeownerHouses(fakeClient(table).client, { orgId: ORG, viewerId: ME, contactIds: [C1] });
    const page = await loadHomeownerHousesPage(fakeClient(table).client, { orgId: ORG, viewerId: ME, contactId: C1, offset: first[C1].houses.length });
    expect(page.count).toBe(60);
    expect(page.nextOffset).toBeNull();
    expect([...first[C1].houses, ...page.houses].map((h) => h.propertyId)).toEqual(table.map((r) => r.id));
  });

  it("pages an owner past 1,000 houses to the end", async () => {
    const table = many(C1, 1100, "a");
    const { client } = fakeClient(table);
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await loadHomeownerHousesPage(client, { orgId: ORG, viewerId: ME, contactId: C1, offset });
      ids.push(...page.houses.map((h) => h.propertyId));
      offset = page.nextOffset;
    }
    expect(ids).toHaveLength(1100);
    expect(new Set(ids).size).toBe(1100);
  });

  it("orders ties on the address by id so pages never repeat or skip", async () => {
    const table = Array.from({ length: 70 }, (_, i) => row(`t${String(i).padStart(3, "0")}`, C1, { address: "Same St" }));
    const { client, calls } = fakeClient(table);
    const a = await loadHomeownerHousesPage(client, { orgId: ORG, viewerId: ME, contactId: C1, offset: 0 });
    const b = await loadHomeownerHousesPage(client, { orgId: ORG, viewerId: ME, contactId: C1, offset: a.nextOffset! });
    expect(calls.orders).toEqual([["address", "id"], ["address", "id"]]);
    const ids = [...a.houses, ...b.houses].map((h) => h.propertyId);
    expect(new Set(ids).size).toBe(70);
    expect(ids).toEqual(table.map((r) => r.id));
  });

  it("orders the first paint by address then id, so Show more continues it", async () => {
    const { client, calls } = fakeClient([row("p1", C1), row("p2", C1)]);
    await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1] });
    expect(calls.orders).toEqual([["address", "id"]]);
  });

  it("stays in the org and skips deleted houses", async () => {
    const { client, calls } = fakeClient([row("p1", C1), row("p2", C1, { org_id: "org-2" }), row("p3", C1, { deleted_at: "x" })]);
    const page = await loadHomeownerHousesPage(client, { orgId: ORG, viewerId: ME, contactId: C1, offset: 0 });
    expect(calls.filters).toEqual(expect.arrayContaining([["eq", "org_id", ORG], ["is", "deleted_at", null]]));
    expect(page).toMatchObject({ count: 1, nextOffset: null, houses: [{ propertyId: "p1" }] });
  });

  it("rejects a bad cursor or homeowner without reading", async () => {
    const { client, calls } = fakeClient([]);
    for (const offset of [-1, 1.5, Number.NaN, 100_001])
      await expect(loadHomeownerHousesPage(client, { orgId: ORG, viewerId: ME, contactId: C1, offset })).rejects.toThrow(/offset/);
    await expect(loadHomeownerHousesPage(client, { orgId: ORG, viewerId: ME, contactId: "nope", offset: 0 })).rejects.toThrow(/homeowner/);
    expect(calls.from).toBe(0);
  });
});
