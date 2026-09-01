import { describe, expect, it } from "vitest";
import { assertSafeE2ESupabaseTarget } from "./e2e-target-safety";

describe("E2E Supabase target safety", () => {
  it("accepts the exact dedicated CI project URL", () => {
    expect(() => assertSafeE2ESupabaseTarget("https://ci-project.supabase.co", {
      allowLocal: false,
      dedicatedCi: true,
      expectedProjectRef: "ci-project",
    })).not.toThrow();
    expect(() => assertSafeE2ESupabaseTarget("https://ci-project.supabase.co/", {
      allowLocal: false,
      dedicatedCi: true,
      expectedProjectRef: "ci-project",
    })).not.toThrow();
  });

  it("rejects mismatched, shared, malformed, and lookalike dedicated targets", () => {
    const options = { allowLocal: false, dedicatedCi: true, expectedProjectRef: "ci-project" };
    for (const value of [
      "https://other-project.supabase.co",
      "https://ncsngxlcyxylaeskiteu.supabase.co",
      "https://ci-project.supabase.co.evil",
      "https://evil.example/ci-project.supabase.co",
      "https://ci-project.supabase.co/path",
      "https://ci-project.supabase.co/?x=1",
      "https://user:pass@ci-project.supabase.co",
      "https://ci-project.supabase.co:443",
      "https://ci-project.supabase.co#fragment",
      "not-a-url",
    ]) {
      expect(() => assertSafeE2ESupabaseTarget(value, options)).toThrow();
    }
  });

  it("preserves shared and explicitly enabled local behavior outside dedicated CI", () => {
    expect(() => assertSafeE2ESupabaseTarget("https://ncsngxlcyxylaeskiteu.supabase.co", { allowLocal: false })).not.toThrow();
    expect(() => assertSafeE2ESupabaseTarget("http://127.0.0.1:54321", { allowLocal: true })).not.toThrow();
  });
});
