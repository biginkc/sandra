import { describe, expect, it } from "vitest";

import { fetchAllPages } from "./paged";

/** A table of n rows that answers .range() like PostgREST, counting requests. */
function table(n: number, failOnPage?: number) {
  const calls: Array<[number, number]> = [];
  const make = () => ({
    range: async (from: number, to: number) => {
      calls.push([from, to]);
      if (failOnPage !== undefined && calls.length === failOnPage) return { data: null, error: { message: "boom" } };
      return { data: Array.from({ length: Math.max(0, Math.min(to + 1, n) - from) }, (_, i) => ({ i: from + i })), error: null };
    },
  });
  return { make, calls };
}

describe("fetchAllPages", () => {
  it("a page that returns exactly the cap triggers a further page, so nothing past the cap is lost", async () => {
    const t = table(3, undefined);
    const out = await fetchAllPages<{ i: number }>(t.make, 3);
    expect(out.rows).toHaveLength(3);
    expect(t.calls).toEqual([[0, 2], [3, 5]]); // the full first page forced a second request, which came back empty
  });

  it("reads 2,500 rows in three requests at the default 1,000-row page", async () => {
    const t = table(2500);
    const out = await fetchAllPages<{ i: number }>(t.make);
    expect(out.rows).toHaveLength(2500);
    expect(t.calls).toHaveLength(3);
  });

  it("stops after a short page", async () => {
    const t = table(2);
    expect((await fetchAllPages(t.make, 3)).rows).toHaveLength(2);
    expect(t.calls).toHaveLength(1);
  });

  it("a failing page fails the whole read: no partial rows", async () => {
    const t = table(10, 2);
    const out = await fetchAllPages(t.make, 3);
    expect(out.error).not.toBeNull();
    expect(out.rows).toEqual([]);
  });
});
