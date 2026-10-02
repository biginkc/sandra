import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("legacy callers stay on the legacy origin", () => {
  it("campaign audience resolution always passes origin: legacy", () => {
    const source = read("app/(dashboard)/campaigns/actions.ts");
    const calls = source.match(/getAllMatchingProspectIds\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call).toContain('origin: "legacy"');
  });

  it("campaigns never import or pass the search origin", () => {
    expect(read("app/(dashboard)/campaigns/actions.ts")).not.toContain("search_page");
  });

  it("Leads-side bulk tag keeps its own predicates (not routed through search-scope)", () => {
    const source = read("app/(dashboard)/leads/actions.ts");
    expect(source).not.toContain("search-scope");
    expect(source).not.toContain("search_properties");
  });

  it("every Search-page filter action carries the search_page origin from the table", () => {
    const table = read("app/(dashboard)/properties/prospects-table.tsx");
    expect(table.match(/origin: "search_page"/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
