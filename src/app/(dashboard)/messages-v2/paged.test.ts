import { describe, expect, it } from "vitest";

import { fakePostgrest } from "./fake-postgrest.test-util";
import { fetchAllKeyset } from "./paged";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, "0")}`, org_id: "o", v: i }));

describe("fetchAllKeyset", () => {
  it("reads every row even when the server caps responses BELOW the page size (no 'short page = end')", async () => {
    const { client, requests } = fakePostgrest({ t: rows(1234) }, { cap: 500 });
    const out = await fetchAllKeyset<{ id: string }>(() => client.from("t").select("*").eq("org_id", "o"));
    expect(out.error).toBeNull();
    expect(out.rows).toHaveLength(1234);
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(1234);
    expect(requests.get("t")).toBe(4); // 500 + 500 + 234 + the empty page that ends it
  });

  it("stops only on an empty page", async () => {
    const { client, requests } = fakePostgrest({ t: rows(3) });
    const out = await fetchAllKeyset(() => client.from("t").select("*"), "id", 3);
    expect(out.rows).toHaveLength(3);
    expect(requests.get("t")).toBe(2);
  });

  it("a failing page (page 3) fails the whole read: no partial rows", async () => {
    const { client } = fakePostgrest({ t: rows(2500) }, { fail: (_t, n) => n === 3 });
    const out = await fetchAllKeyset(() => client.from("t").select("*"));
    expect(out.error).not.toBeNull();
    expect(out.rows).toEqual([]);
  });

  it("a page that does not move the key forward is an error, never an endless loop", async () => {
    const stuck = { order: () => stuck, gt: () => stuck, limit: async () => ({ data: [{ id: "same" }], error: null }) };
    const out = await fetchAllKeyset(() => stuck);
    expect(out.error).not.toBeNull();
  });
});
