import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertSafeE2ESupabaseTarget,
  assertSafeE2ESupabaseTargetFromEnvironment,
} from "./e2e-target-safety";

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

  it("requires an exact, well-formed project ref in CI", () => {
    const ci = { CI: "1" };
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://bnkipfoqggwyttbykjfn.supabase.co",
        ci,
      ),
    ).toThrow(/requires an expected/i);
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://bnkipfoqggwyttbykjfn.supabase.co",
        { ...ci, E2E_CI_SUPABASE_PROJECT_REF: "not-a-project-ref" },
      ),
    ).toThrow(/malformed/i);
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://bnkipfoqggwyttbykjfn.supabase.co",
        { ...ci, E2E_CI_SUPABASE_PROJECT_REF: " bnkipfoqggwyttbykjfn" },
      ),
    ).toThrow(/malformed/i);
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://ncsngxlcyxylaeskiteu.supabase.co",
        { ...ci, E2E_CI_SUPABASE_PROJECT_REF: "bnkipfoqggwyttbykjfn" },
      ),
    ).toThrow(/does not exactly match/i);
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://ncsngxlcyxylaeskiteu.supabase.co",
        { ...ci, E2E_CI_SUPABASE_PROJECT_REF: "ncsngxlcyxylaeskiteu" },
      ),
    ).toThrow(/not approved/i);
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://abcdefghijklmnopqrst.supabase.co",
        { ...ci, E2E_CI_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
      ),
    ).toThrow(/not approved/i);
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://bnkipfoqggwyttbykjfn.supabase.co",
        { ...ci, E2E_CI_SUPABASE_PROJECT_REF: "bnkipfoqggwyttbykjfn" },
      ),
    ).not.toThrow();
  });

  it.each([
    "http://bnkipfoqggwyttbykjfn.supabase.co",
    "https://bnkipfoqggwyttbykjfn.supabase.co:444",
    "https://user:password@bnkipfoqggwyttbykjfn.supabase.co",
    "https://bnkipfoqggwyttbykjfn.supabase.co/rest/v1",
    "https://bnkipfoqggwyttbykjfn.supabase.co?mode=test",
    "https://bnkipfoqggwyttbykjfn.supabase.co#fragment",
  ])("rejects a non-origin CI Supabase URL: %s", (url) => {
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(url, {
        CI: "1",
        E2E_CI_SUPABASE_PROJECT_REF: "bnkipfoqggwyttbykjfn",
      }),
    ).toThrow(/does not exactly match/i);
  });

  it("preserves non-CI shared-project and explicitly enabled local behavior", () => {
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment(
        "https://ncsngxlcyxylaeskiteu.supabase.co",
        {},
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeE2ESupabaseTargetFromEnvironment("http://localhost:54321", {
        E2E_ALLOW_LOCAL_SUPABASE: "1",
      }),
    ).not.toThrow();
  });
});
