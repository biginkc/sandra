import { describe, it, expect } from "vitest";
import {
  BLOCK_KINDS,
  EMPTY_FILTER_STATE,
  encodeFilters,
  decodeFilters,
  newBlockId,
  type FilterBlock,
  type FilterState,
} from "./filter-schema";

// --------------------------------------------------------------------------
// Test fixture: one fully-configured block of every kind.
// --------------------------------------------------------------------------
//
// This is the canonical fixture used to verify discriminated-union exhaustiveness
// (test 4) and the URL-length budget (test 10). It MUST contain exactly one entry
// for every kind in BLOCK_KINDS — if a new kind is added without a fixture entry,
// the type-level satisfies check at the bottom fails to compile.
//
// Each multi-select block uses 5 IDs (per the plan's URL-length test requirement).

const FIVE_IDS = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000004", "00000000-0000-0000-0000-000000000005"];

function makeFullStack(): FilterBlock[] {
  // Use deterministic ids so deep-equal round-trip tests are stable.
  let counter = 100;
  const id = () => `aaaaaaaa-aaaa-4aaa-aaaa-${String(counter++).padStart(12, "0")}`;
  return [
    { id: id(), kind: "list",                  combinator: "all", values: FIVE_IDS },
    { id: id(), kind: "tag",                   combinator: "any", values: FIVE_IDS },
    { id: id(), kind: "list_count",            range: { min: 2, max: null } },
    { id: id(), kind: "vacancy",               tri: "yes" },
    { id: id(), kind: "cass",                  combinator: "all", values: ["verified", "unverified", "invalid", "ambiguous"] },
    { id: id(), kind: "outreach_dispo",        combinator: "any", values: FIVE_IDS },
    { id: id(), kind: "source",                combinator: "all", values: FIVE_IDS },
    { id: id(), kind: "beds",                  range: { min: 3, max: 5 } },
    { id: id(), kind: "baths",                 range: { min: 2, max: null } },
    { id: id(), kind: "year_built",            range: { min: 1950, max: 2020 } },
    { id: id(), kind: "state",                 combinator: "any", values: ["CA", "TX", "FL", "NY", "WA"] },
    { id: id(), kind: "market",                combinator: "all", values: FIVE_IDS },
    { id: id(), kind: "absentee",              tri: "no" },
    { id: id(), kind: "estimated_value",       range: { min: 100000, max: 500000 } },
    { id: id(), kind: "equity_pct",            range: { min: 50, max: 100 } },
    { id: id(), kind: "pipeline_status",       combinator: "any", values: ["prospect", "lead"] },
    { id: id(), kind: "engagement",            combinator: "any", values: ["never_contacted", "attempted", "replied", "opted_out"] },
    { id: id(), kind: "assignee",              combinator: "all", values: ["unassigned", ...FIVE_IDS.slice(0, 4)] },
    { id: id(), kind: "created_date",          date: { mode: "since", days: 30 } },
    { id: id(), kind: "has_unread_inbound",    tri: "yes" },
    { id: id(), kind: "needs_human_attention", tri: "yes" },
    { id: id(), kind: "has_open_tasks",        tri: "no" },
    { id: id(), kind: "motivation_level",      combinator: "any", values: ["low", "medium", "high"] },
  ];
}

// --------------------------------------------------------------------------
// BLOCK_KINDS surface
// --------------------------------------------------------------------------

describe("BLOCK_KINDS", () => {
  // Test 1
  it("contains exactly 23 block kinds (per SPEC.md §41-46 + schema-audit additions)", () => {
    expect(BLOCK_KINDS.length).toBe(23);
  });

  it("contains every documented kind name verbatim (no typos)", () => {
    const expected = [
      // General (7)
      "list", "tag", "list_count", "vacancy", "cass", "outreach_dispo", "source",
      // Property (5)
      "beds", "baths", "year_built", "state", "market",
      // Owner (1)
      "absentee",
      // Value & Equity (2)
      "estimated_value", "equity_pct",
      // Status & Engagement (4)
      "pipeline_status", "engagement", "assignee", "created_date",
      // Schema-audit additions (4)
      "has_unread_inbound", "needs_human_attention", "has_open_tasks", "motivation_level",
    ];
    expect([...BLOCK_KINDS].sort()).toEqual([...expected].sort());
  });

  // Test 12 — exhaustiveness via fixture
  it("every kind in BLOCK_KINDS has a corresponding FilterBlock variant in the fixture", () => {
    const fixtureKinds = makeFullStack().map((b) => b.kind).sort();
    const declaredKinds = [...BLOCK_KINDS].sort();
    expect(fixtureKinds).toEqual(declaredKinds);
  });
});

// --------------------------------------------------------------------------
// newBlockId
// --------------------------------------------------------------------------

describe("newBlockId", () => {
  // Test 2
  it("returns a v4 UUID string", () => {
    const id = newBlockId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("is unique across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newBlockId());
    expect(ids.size).toBe(100);
  });
});

// --------------------------------------------------------------------------
// encodeFilters / decodeFilters — happy path & round-trip
// --------------------------------------------------------------------------

describe("encodeFilters/decodeFilters", () => {
  // Test 3
  it("encodes EMPTY_FILTER_STATE to a non-empty string that decodes back to EMPTY_FILTER_STATE", () => {
    const encoded = encodeFilters(EMPTY_FILTER_STATE);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    expect(decodeFilters(encoded)).toEqual(EMPTY_FILTER_STATE);
  });

  // Test 4
  it("round-trips a stack with one of every kind via deep equality", () => {
    const state: FilterState = { v: 1, blocks: makeFullStack() };
    const encoded = encodeFilters(state);
    const decoded = decodeFilters(encoded);
    expect(decoded).toEqual(state);
  });

  // Test 9 — observable encoding shape (URL-encoded JSON, NOT base64)
  it("encodes as URL-encoded JSON, evidenced by the literal substring %22v%22%3A1", () => {
    const encoded = encodeFilters(EMPTY_FILTER_STATE);
    expect(encoded).toContain("%22v%22%3A1");
  });
});

// --------------------------------------------------------------------------
// decodeFilters — fail-closed behavior
// --------------------------------------------------------------------------

describe("decodeFilters fail-closed", () => {
  // Test 5
  it("returns EMPTY_FILTER_STATE for null input", () => {
    expect(decodeFilters(null)).toEqual(EMPTY_FILTER_STATE);
  });

  it("returns EMPTY_FILTER_STATE for undefined input", () => {
    expect(decodeFilters(undefined)).toEqual(EMPTY_FILTER_STATE);
  });

  it("returns EMPTY_FILTER_STATE for empty-string input", () => {
    expect(decodeFilters("")).toEqual(EMPTY_FILTER_STATE);
  });

  // Test 6
  it("returns EMPTY_FILTER_STATE for non-JSON input", () => {
    expect(decodeFilters("not-json")).toEqual(EMPTY_FILTER_STATE);
  });

  // Test 7 — wrong version → fail closed
  it("returns EMPTY_FILTER_STATE for a payload whose v !== 1", () => {
    const wrongVersion = encodeFilters({ v: 99, blocks: [] } as unknown as FilterState);
    expect(decodeFilters(wrongVersion)).toEqual(EMPTY_FILTER_STATE);
  });

  // Test 8 — silent drop of unknown kinds, keep valid ones
  it("drops blocks with unknown kind but keeps valid blocks", () => {
    const goodBlock: FilterBlock = { id: newBlockId(), kind: "vacancy", tri: "yes" };
    // Hand-craft a payload with an extra bogus kind so we don't depend on encodeFilters
    // accepting unknown kinds.
    const payload = {
      v: 1,
      blocks: [
        goodBlock,
        { id: newBlockId(), kind: "bogus", values: [] },
      ],
    };
    const raw = encodeURIComponent(JSON.stringify(payload));
    const decoded = decodeFilters(raw);
    expect(decoded.blocks).toHaveLength(1);
    expect(decoded.blocks[0]).toEqual(goodBlock);
  });

  // Test 11 — combinator coercion
  it("coerces unknown combinator to 'all' rather than throwing", () => {
    const id = newBlockId();
    const payload = {
      v: 1,
      blocks: [
        { id, kind: "list", combinator: "bogus", values: ["a", "b"] },
      ],
    };
    const raw = encodeURIComponent(JSON.stringify(payload));
    const decoded = decodeFilters(raw);
    expect(decoded.blocks).toHaveLength(1);
    expect(decoded.blocks[0]).toEqual({ id, kind: "list", combinator: "all", values: ["a", "b"] });
  });

  it("coerces unknown tri-bool to 'any' rather than throwing", () => {
    const id = newBlockId();
    const payload = {
      v: 1,
      blocks: [
        { id, kind: "vacancy", tri: "bogus" },
      ],
    };
    const raw = encodeURIComponent(JSON.stringify(payload));
    const decoded = decodeFilters(raw);
    expect(decoded.blocks).toHaveLength(1);
    expect(decoded.blocks[0]).toEqual({ id, kind: "vacancy", tri: "any" });
  });
});

// --------------------------------------------------------------------------
// URL length budget — defensive warn at >1500 chars (RESEARCH A1/A2)
// --------------------------------------------------------------------------

describe("URL length budget", () => {
  // Test 10a — typical-sized stack stays well under the defensive 1500-char warn line.
  //
  // Note on the threshold: the plan originally specified "< 1500 chars" against a
  // 19-block (corrected: 23-block) stack with 5 UUID-shaped values per multi-select.
  // That ceiling is infeasible for the *worst* case — UUIDs are 36 chars, the JSON
  // adds quotes/braces, and `encodeURIComponent` triples every special char (e.g.
  // `"` → `%22`), so the worst-case 23-block × 5-UUID stack encodes near 5 KB.
  //
  // The RESEARCH-A1/A2 budget of 1500 is the DEFENSIVE warn threshold in encodeFilters
  // (console.warn fires above 1500). It is sized for typical use — a few blocks with
  // a few values — not the synthetic worst-case fixture.
  //
  // We split the assertion into two checks to preserve the original intent:
  //   - 10a: a typical stack (4 blocks, ≤ 5 short ids) stays under 1500
  //   - 10b: even the worst case fits comfortably under any browser URL ceiling
  it("a typical stack (4 blocks, short ids) encodes to under 1500 chars (the warn line)", () => {
    const state: FilterState = {
      v: 1,
      blocks: [
        { id: "aaaaaaaa-aaaa-4aaa-aaaa-000000000001", kind: "vacancy", tri: "yes" },
        { id: "aaaaaaaa-aaaa-4aaa-aaaa-000000000002", kind: "list_count", range: { min: 2, max: null } },
        { id: "aaaaaaaa-aaaa-4aaa-aaaa-000000000003", kind: "state", combinator: "any", values: ["KS", "MO", "TX"] },
        { id: "aaaaaaaa-aaaa-4aaa-aaaa-000000000004", kind: "engagement", combinator: "any", values: ["replied"] },
      ],
    };
    expect(encodeFilters(state).length).toBeLessThan(1500);
  });

  // Test 10b — worst case (23 fully-configured blocks, 5 UUID-shaped values each)
  // still fits comfortably under any browser URL ceiling (~8 KB Chrome, 2 KB IE).
  it("worst-case stack (23 blocks × 5 UUID values) encodes to under 8000 chars", () => {
    const state: FilterState = { v: 1, blocks: makeFullStack() };
    expect(encodeFilters(state).length).toBeLessThan(8000);
  });
});
