import { describe, expect, it, vi } from "vitest";

import {
  houseAddress,
  loadHomeownerHouses,
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
  const calls: { from: number; filters: unknown[][]; counted: number } = { from: 0, filters: [], counted: 0 };
  const client = {
    from: vi.fn(() => {
      calls.from += 1;
      let rows = [...table];
      let counted = false;
      const query = {
        eq(column: string, value: string) { calls.filters.push(["eq", column, value]); rows = rows.filter((r) => r[column as keyof Row] === value); return query; },
        in(column: string, values: string[]) { calls.filters.push(["in", column, values]); rows = rows.filter((r) => values.includes(r[column as keyof Row] as string)); return query; },
        is(column: string, value: null) { calls.filters.push(["is", column, value]); rows = rows.filter((r) => r[column as keyof Row] === value); return query; },
        order(column: string) { rows.sort((a, b) => String(a[column as keyof Row]).localeCompare(String(b[column as keyof Row]))); return query; },
        limit: async (count: number) =>
          error ? { data: null, error } : { data: rows.slice(0, count), error: null, count: counted ? rows.length : null },
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

  it("does not fall back below the page ceiling", async () => {
    const { client, calls } = fakeClient(many(C1, MAX_PAGE_ROWS - 1, "a"));
    const result = await loadHomeownerHouses(client, { orgId: ORG, viewerId: ME, contactIds: [C1] });
    expect(calls.from).toBe(1);
    expect(result[C1].count).toBe(MAX_PAGE_ROWS - 1);
  });
});
