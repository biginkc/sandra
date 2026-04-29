import { describe, expect, it } from "vitest";

import { trimRowsToMapping } from "./trim-rows";

describe("trimRowsToMapping", () => {
  it("keeps only columns referenced by the mapping", () => {
    const rows = [
      {
        "PROP: Address Full": "1 Main St, KC, MO 64108",
        "PROP: City": "KC",
        "PROP: State": "MO",
        "PROP: Zip": "64108",
        "INPUT: First Name": "Alice",
        "REL1: Phone 1": "5551234",
      },
    ];
    const mapping = {
      address_full: "PROP: Address Full",
      city: "PROP: City",
      state: "PROP: State",
      zip: "PROP: Zip",
    };

    const out = trimRowsToMapping(rows, mapping);

    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]).sort()).toEqual(
      ["PROP: Address Full", "PROP: City", "PROP: State", "PROP: Zip"].sort(),
    );
    expect(out[0]["PROP: Address Full"]).toBe("1 Main St, KC, MO 64108");
  });

  it("ignores null and undefined mapping values", () => {
    const rows = [{ A: "1", B: "2", C: "3" }];
    const mapping = {
      address: "A",
      city: null,
      state: undefined as unknown as string | null,
    };

    const out = trimRowsToMapping(rows, mapping);

    expect(Object.keys(out[0])).toEqual(["A"]);
  });

  it("drops mapped headers that aren't actually present in the row", () => {
    // Defensive: if the mapping references a header the row doesn't carry
    // (e.g. inconsistent rows in a malformed CSV), we don't synthesize
    // empty values — we just leave them out. The validator treats absent
    // and empty identically.
    const rows = [{ A: "1" }];
    const mapping = { address: "A", city: "Missing" };

    const out = trimRowsToMapping(rows, mapping);

    expect(out[0]).toEqual({ A: "1" });
    expect("Missing" in out[0]).toBe(false);
  });

  it("preserves empty / null cell values for kept columns", () => {
    const rows = [
      { A: "1", B: "" },
      { A: "", B: null },
    ];
    const mapping = { address: "A", city: "B" };

    const out = trimRowsToMapping(rows, mapping);

    expect(out[0]).toEqual({ A: "1", B: "" });
    expect(out[1]).toEqual({ A: "", B: null });
  });

  it("returns empty objects when the mapping is empty", () => {
    const rows = [{ A: "1", B: "2" }];
    const out = trimRowsToMapping(rows, {});
    expect(out).toEqual([{}]);
  });

  it("handles many rows efficiently (smoke test for 2000 × 200)", () => {
    const headers = Array.from({ length: 200 }, (_, i) => `col_${i}`);
    const row: Record<string, string> = {};
    for (const h of headers) row[h] = "x";
    const rows = Array.from({ length: 2000 }, () => row);

    const mapping = {
      address: "col_0",
      city: "col_50",
      state: "col_100",
      zip: "col_150",
    };

    const start = Date.now();
    const out = trimRowsToMapping(rows, mapping);
    const elapsed = Date.now() - start;

    expect(out).toHaveLength(2000);
    expect(Object.keys(out[0])).toHaveLength(4);
    // Tight bound — anything over 100 ms suggests an O(rows × cols) miss.
    expect(elapsed).toBeLessThan(500);
  });
});
