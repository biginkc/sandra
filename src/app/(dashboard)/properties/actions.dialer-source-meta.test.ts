import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

describe("Imported Today dialer audit metadata", () => {
  it("persists the imported filter alongside the other source filters", () => {
    const start = source.indexOf("export async function createDialerBatchFromFilters");
    const end = source.indexOf("export async function getAllMatchingProspectSelection", start);
    const implementation = source.slice(start, end);

    expect(implementation).toContain("sourceMeta:");
    expect(implementation).toMatch(/imported:\s*args\.imported\s*\?\?\s*null/);
  });

  it("only search-page batches record an origin; legacy source_meta keeps its exact shape", () => {
    const start = source.indexOf("export async function createDialerBatchFromFilters");
    const end = source.indexOf("export async function getAllMatchingProspectSelection", start);
    const implementation = source.slice(start, end);

    expect(implementation).toContain('...(origin === "search_page" ? { origin } : {})');
    expect(implementation).toContain("skippedLeads");
  });
});
