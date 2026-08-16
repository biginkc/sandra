import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertSafeE2ESupabaseTarget } from "./e2e-target-safety";

describe("E2E Supabase target safety", () => {
  it("never reuses an unverified process already listening on the destructive suite port", () => {
    const config = readFileSync(
      new URL("../../../playwright.config.ts", import.meta.url),
      "utf8",
    );
    expect(config).toMatch(/reuseExistingServer:\s*false/);
  });

  it("allows only the dedicated shared E2E project by default", () => {
    expect(() =>
      assertSafeE2ESupabaseTarget("https://ncsngxlcyxylaeskiteu.supabase.co", {
        allowLocal: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeE2ESupabaseTarget("https://another-project.supabase.co", {
        allowLocal: false,
      }),
    ).toThrow(/refusing/i);
  });

  it("requires an explicit gate and the fixed local API port", () => {
    expect(() =>
      assertSafeE2ESupabaseTarget("http://127.0.0.1:54321", {
        allowLocal: false,
      }),
    ).toThrow(/refusing/i);
    expect(() =>
      assertSafeE2ESupabaseTarget("http://127.0.0.1:54321", {
        allowLocal: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeE2ESupabaseTarget("http://localhost:6543", {
        allowLocal: true,
      }),
    ).toThrow(/refusing/i);
  });
});
