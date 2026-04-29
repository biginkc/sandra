import { describe, expect, it } from "vitest";

import { isPrecheckApplicable, precheckRows } from "./precheck";

const HDR = "PROP: Address Full";
const CITY = "PROP: City";
const STATE = "PROP: State";
const ZIP = "PROP: Zip";

describe("precheckRows", () => {
  it("counts an empty input cleanly", () => {
    const r = precheckRows([]);
    expect(r.stats.total).toBe(0);
    expect(r.ready).toEqual([]);
    expect(r.needsReview).toEqual([]);
  });

  it("classifies rows with no PROP data as empty (dropped)", () => {
    const rows = [
      { [HDR]: "", [CITY]: "", [STATE]: "", [ZIP]: "", "INPUT: First Name": "Connie" },
    ];
    const r = precheckRows(rows);
    expect(r.stats.empty).toBe(1);
    expect(r.stats.ready).toBe(0);
    expect(r.ready).toHaveLength(0);
    expect(r.needsReview).toHaveLength(0);
  });

  it("includes parseable rows in ready output", () => {
    const rows = [
      { [HDR]: "807 TRIPLE LODE DR, ANGELS CAMP, CA 95222" },
      { [HDR]: "10000 E HIGHWAY 12, LODI, CA 95240" },
    ];
    const r = precheckRows(rows);
    expect(r.stats.ready).toBe(2);
    expect(r.ready).toHaveLength(2);
  });

  it("drops the second occurrence of the same address (intra-file dup)", () => {
    const rows = [
      { [HDR]: "807 TRIPLE LODE DR, ANGELS CAMP, CA 95222" },
      { [HDR]: "807 TRIPLE LODE DR, ANGELS CAMP, CA 95222" }, // dup
      { [HDR]: "10000 E HIGHWAY 12, LODI, CA 95240" },
    ];
    const r = precheckRows(rows);
    expect(r.stats.ready).toBe(2);
    expect(r.stats.intraFileDup).toBe(1);
    expect(r.ready).toHaveLength(2);
  });

  it("normalizes address case + whitespace before deduping", () => {
    const rows = [
      { [HDR]: "807 Triple Lode Dr, Angels Camp, CA 95222" },
      { [HDR]: "807   TRIPLE LODE DR,  ANGELS CAMP,  CA 95222" }, // dup after norm
    ];
    const r = precheckRows(rows);
    expect(r.stats.ready).toBe(1);
    expect(r.stats.intraFileDup).toBe(1);
  });

  it("routes rows whose PROP: Address Full has < 2 commas to needs-review", () => {
    const rows = [
      // Has PROP data but Address Full is space-delimited (un-reshaped)
      { [HDR]: "807 TRIPLE LODE DR ANGELS CAMP CA 95222", [CITY]: "ANGELS CAMP" },
    ];
    const r = precheckRows(rows);
    expect(r.stats.unparseable).toBe(1);
    expect(r.needsReview).toHaveLength(1);
    expect(r.ready).toHaveLength(0);
  });

  it("preserves all other CSV columns on rows it keeps", () => {
    const rows = [
      {
        [HDR]: "1 Main St, KC, MO 64108",
        [CITY]: "KC",
        [STATE]: "MO",
        [ZIP]: "64108",
        "INPUT: First Name": "Alice",
        "PH: Phone1": "8165551234",
      },
    ];
    const r = precheckRows(rows);
    expect(r.ready[0]).toEqual(rows[0]);
  });

  it("stats sum to the total row count across all four buckets", () => {
    const rows = [
      { [HDR]: "1 A St, X, MO 64108" }, // ready
      { [HDR]: "1 A St, X, MO 64108" }, // intra-dup
      { [HDR]: "" }, // empty
      { [HDR]: "no-comma here" }, // unparseable
    ];
    const r = precheckRows(rows);
    expect(
      r.stats.ready + r.stats.empty + r.stats.intraFileDup + r.stats.unparseable,
    ).toBe(r.stats.total);
    expect(r.stats.total).toBe(4);
  });

  it("returns the actual rows in each bucket so the UI can drop them selectively", () => {
    const rows = [
      { [HDR]: "1 A St, X, MO 64108", marker: "ready1" },
      { [HDR]: "1 A St, X, MO 64108", marker: "dup1" },
      { [HDR]: "", marker: "empty1" },
      { [HDR]: "no-comma", marker: "review1" },
    ];
    const r = precheckRows(rows);
    expect(r.ready.map((x) => x.marker)).toEqual(["ready1"]);
    expect(r.intraFileDups.map((x) => x.marker)).toEqual(["dup1"]);
    expect(r.empty.map((x) => x.marker)).toEqual(["empty1"]);
    expect(r.needsReview.map((x) => x.marker)).toEqual(["review1"]);
  });
});

describe("isPrecheckApplicable", () => {
  it("is true when PROP: Address Full is in the headers (D4D shape)", () => {
    expect(
      isPrecheckApplicable(["INPUT: First Name", "PROP: Address Full"]),
    ).toBe(true);
  });

  it("is false for other CSV shapes (DealMachine, Zillow, generic)", () => {
    expect(
      isPrecheckApplicable(["address", "city", "state", "zip"]),
    ).toBe(false);
    expect(
      isPrecheckApplicable(["associated_property_address_full"]),
    ).toBe(false);
  });

  it("is false for an empty header set", () => {
    expect(isPrecheckApplicable([])).toBe(false);
  });
});
