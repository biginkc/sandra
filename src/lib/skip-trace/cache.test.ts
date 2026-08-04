import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { normalizeAddress } from "./cache";

const unskipTracedMigration = readFileSync(
  path.resolve(
    process.cwd(),
    "supabase/migrations/20260804130000_leads_unskip_traced_view.sql",
  ),
  "utf8",
);

describe("normalizeAddress", () => {
  it("lowercases and joins with pipe", () => {
    expect(
      normalizeAddress({
        address: "123 Main St",
        city: "Kansas City",
        state: "MO",
        zip: "64106",
      }),
    ).toBe("123 main st|kansas city|mo|64106");
  });

  it("skips null/undefined parts", () => {
    expect(
      normalizeAddress({
        address: "123 Main St",
        city: null,
        state: "MO",
        zip: undefined,
      }),
    ).toBe("123 main st|mo");
  });

  it("keeps SQL and TypeScript keys equivalent for every blank-value case", () => {
    const cases = [
      { label: "null", value: null as string | null | undefined },
      { label: "undefined", value: undefined },
      { label: "empty", value: "" },
      { label: "whitespace-only", value: "   " },
      { label: "normal", value: " Kansas City " },
    ];

    // This is the SQL expression's contract: filter raw NULL/empty values
    // before trim (the same order as cache.ts), then join the survivors.
    const sqlEquivalent = (value: string | null | undefined): string =>
      ["123 main st", value, "mo", "64106"]
        .filter(
          (component): component is string =>
            component !== null && component !== undefined && component !== "",
        )
        .map((component) => component.trim().toLowerCase())
        .join("|");

    for (const { label, value } of cases) {
      const tsKey = normalizeAddress({
        address: "123 Main St",
        city: value,
        state: "MO",
        zip: "64106",
      });
      expect(tsKey, label).toBe(sqlEquivalent(value));
    }

    expect(unskipTracedMigration).toContain("from unnest(array[b.address, b.city, b.state, b.zip])");
    expect(unskipTracedMigration).toContain("component <> ''");
    expect(unskipTracedMigration).not.toContain("concat_ws(");
  });

  it("trims whitespace before lowercasing", () => {
    expect(
      normalizeAddress({
        address: "  456 Oak Ave  ",
        city: " St Louis ",
        state: " MO ",
      }),
    ).toBe("456 oak ave|st louis|mo");
  });

  it("two equivalent addresses with different formatting normalize the same", () => {
    const a = normalizeAddress({
      address: "789 Elm St",
      city: "Lee's Summit",
      state: "MO",
      zip: "64086",
    });
    const b = normalizeAddress({
      address: "789 ELM ST",
      city: "lee's summit",
      state: "mo",
      zip: "64086",
    });
    expect(a).toBe(b);
  });
});
