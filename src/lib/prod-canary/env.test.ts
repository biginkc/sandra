import { describe, expect, it } from "vitest";

import {
  PROD_PROJECT_REF,
  TEST_PROJECT_REF,
  assertProdSupabaseUrl,
} from "./env";

describe("prod canary env guards", () => {
  it("accepts the Sandra production Supabase project URL", () => {
    expect(() =>
      assertProdSupabaseUrl(`https://${PROD_PROJECT_REF}.supabase.co`),
    ).not.toThrow();
  });

  it("rejects the shared test Supabase project with setup guidance", () => {
    expect(() =>
      assertProdSupabaseUrl(`https://${TEST_PROJECT_REF}.supabase.co`),
    ).toThrow(/\.env\.prod-canary\.local/);
  });

  it("rejects unknown Supabase projects", () => {
    expect(() =>
      assertProdSupabaseUrl("https://example.supabase.co"),
    ).toThrow(PROD_PROJECT_REF);
  });
});
