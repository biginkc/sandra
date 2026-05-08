/**
 * Unit tests for the back-compat URL translator.
 *
 * Translates the 5 legacy chip URL params (the ones page.tsx wires today)
 * into an equivalent FilterBlock[] stack so old bookmarks / shared deep
 * links continue to filter correctly under the new drawer:
 *   ?vacant=1|true       → vacancy: yes
 *   ?cass=verified       → cass: any [verified]
 *   ?engagement=contacted → engagement: any [attempted, replied]
 *   ?market=<value>      → market: any [value]
 *   ?assignee=<uuid>|"unassigned" → assignee: any [value]
 *
 * Per Plan 04 acceptance: 12 cases, including unknown values (whitelist),
 * the all-five-together case in stable order, and per-block uniqueness of
 * the generated `id`.
 *
 * The translator does NOT touch ?filters= — page.tsx decides whether to
 * apply this shim (only when ?filters= is absent). v1 only; delete-able
 * once any saved bookmarks/links have aged out.
 */

import { describe, expect, it, vi } from "vitest";
import type { FilterBlock } from "./filter-schema";
import { translateLegacyChipParams } from "./back-compat-url-translator";

// Mock newBlockId so we can assert deterministic structure (and uniqueness
// across the full-stack test). One vi.mock — the translator imports
// `newBlockId` from filter-schema.
vi.mock("./filter-schema", async (orig) => {
  const actual = await orig<typeof import("./filter-schema")>();
  let n = 0;
  return {
    ...actual,
    newBlockId: () => `mock-id-${++n}`,
  };
});

describe("translateLegacyChipParams: empty / no-op cases", () => {
  it("empty params → []", () => {
    expect(translateLegacyChipParams({})).toEqual([]);
  });

  it("vacant=0 → [] (only 1/true counted as 'on')", () => {
    expect(translateLegacyChipParams({ vacant: "0" })).toEqual([]);
  });

  it("vacant=anything-else → []", () => {
    expect(translateLegacyChipParams({ vacant: "yes" })).toEqual([]);
  });
});

describe("translateLegacyChipParams: vacant", () => {
  it("vacant=1 → vacancy: yes", () => {
    const blocks = translateLegacyChipParams({ vacant: "1" });
    expect(blocks).toHaveLength(1);
    const b = blocks[0] as Extract<FilterBlock, { kind: "vacancy" }>;
    expect(b.kind).toBe("vacancy");
    expect(b.tri).toBe("yes");
    expect(b.id).toMatch(/^mock-id-/);
  });

  it("vacant=true → vacancy: yes", () => {
    const blocks = translateLegacyChipParams({ vacant: "true" });
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as Extract<FilterBlock, { kind: "vacancy" }>).tri).toBe("yes");
  });
});

describe("translateLegacyChipParams: cass", () => {
  it("cass=verified → cass: any [verified]", () => {
    const blocks = translateLegacyChipParams({ cass: "verified" });
    expect(blocks).toHaveLength(1);
    const b = blocks[0] as Extract<FilterBlock, { kind: "cass" }>;
    expect(b.kind).toBe("cass");
    expect(b.combinator).toBe("any");
    expect(b.values).toEqual(["verified"]);
  });

  it("cass=garbage → [] (whitelist enforced — only 'verified' supported in v1)", () => {
    expect(translateLegacyChipParams({ cass: "garbage" })).toEqual([]);
  });
});

describe("translateLegacyChipParams: engagement", () => {
  it("engagement=contacted → engagement: any [attempted, replied]", () => {
    const blocks = translateLegacyChipParams({ engagement: "contacted" });
    expect(blocks).toHaveLength(1);
    const b = blocks[0] as Extract<FilterBlock, { kind: "engagement" }>;
    expect(b.kind).toBe("engagement");
    expect(b.combinator).toBe("any");
    expect(b.values).toEqual(["attempted", "replied"]);
  });
});

describe("translateLegacyChipParams: market", () => {
  it('market="Jackson, MO" → market: any ["Jackson, MO"]', () => {
    const blocks = translateLegacyChipParams({ market: "Jackson, MO" });
    expect(blocks).toHaveLength(1);
    const b = blocks[0] as Extract<FilterBlock, { kind: "market" }>;
    expect(b.kind).toBe("market");
    expect(b.combinator).toBe("any");
    expect(b.values).toEqual(["Jackson, MO"]);
  });
});

describe("translateLegacyChipParams: assignee", () => {
  it("assignee=unassigned → assignee: any [unassigned]", () => {
    const blocks = translateLegacyChipParams({ assignee: "unassigned" });
    expect(blocks).toHaveLength(1);
    const b = blocks[0] as Extract<FilterBlock, { kind: "assignee" }>;
    expect(b.kind).toBe("assignee");
    expect(b.combinator).toBe("any");
    expect(b.values).toEqual(["unassigned"]);
  });

  it("assignee=<uuid> → assignee: any [<uuid>]", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const blocks = translateLegacyChipParams({ assignee: uuid });
    expect(blocks).toHaveLength(1);
    expect(
      (blocks[0] as Extract<FilterBlock, { kind: "assignee" }>).values,
    ).toEqual([uuid]);
  });
});

describe("translateLegacyChipParams: full-stack composition", () => {
  it("all 5 params present → 5 blocks in stable order: vacancy, cass, engagement, market, assignee", () => {
    const blocks = translateLegacyChipParams({
      vacant: "1",
      cass: "verified",
      engagement: "contacted",
      market: "Jackson, MO",
      assignee: "unassigned",
    });
    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => b.kind)).toEqual([
      "vacancy",
      "cass",
      "engagement",
      "market",
      "assignee",
    ]);
  });

  it("each block id is unique and non-empty", () => {
    const blocks = translateLegacyChipParams({
      vacant: "1",
      cass: "verified",
      engagement: "contacted",
      market: "Jackson, MO",
      assignee: "unassigned",
    });
    const ids = blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(blocks.length);
    for (const id of ids) {
      expect(id).toBeTruthy();
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
