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
});
