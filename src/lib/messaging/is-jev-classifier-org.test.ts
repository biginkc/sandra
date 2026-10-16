import { describe, expect, it } from "vitest";

import { isJevClassifierOrg, resolveClassifierMode } from "./inbound";

function stubSupabase(result: {
  data: { classifier_provider: string } | null;
  error?: { message: string } | null;
}) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: result.data, error: result.error ?? null }),
  };
  return { from: () => builder } as any;
}

describe("isJevClassifierOrg", () => {
  it("returns false without querying when orgId is null (unresolved org)", async () => {
    let queried = false;
    const supabase = {
      from: () => {
        queried = true;
        throw new Error("must not query with a null orgId");
      },
    } as any;
    await expect(isJevClassifierOrg(supabase, null)).resolves.toBe(false);
    expect(queried).toBe(false);
  });

  it("returns true when the org's active config selects jev", async () => {
    const supabase = stubSupabase({ data: { classifier_provider: "jev" } });
    await expect(isJevClassifierOrg(supabase, "org-1")).resolves.toBe(true);
  });

  it("returns false when the org's active config selects legacy", async () => {
    const supabase = stubSupabase({ data: { classifier_provider: "legacy" } });
    await expect(isJevClassifierOrg(supabase, "org-1")).resolves.toBe(false);
  });

  it("defaults to false (preserve legacy behavior) when no active config row exists", async () => {
    const supabase = stubSupabase({ data: null });
    await expect(isJevClassifierOrg(supabase, "org-1")).resolves.toBe(false);
  });
});

describe("resolveClassifierMode", () => {
  it("is legacy for a null org without querying", async () => {
    const supabase = { from: () => { throw new Error("no query"); } } as any;
    await expect(resolveClassifierMode(supabase, null)).resolves.toBe("legacy");
  });

  it("is jev for a jev row", async () => {
    const s = stubSupabase({ data: { classifier_provider: "jev" } });
    await expect(resolveClassifierMode(s, "org-1")).resolves.toBe("jev");
  });

  it("is legacy for a legacy row", async () => {
    const s = stubSupabase({ data: { classifier_provider: "legacy" } });
    await expect(resolveClassifierMode(s, "org-1")).resolves.toBe("legacy");
  });

  it("is legacy only when the query succeeded and no row exists", async () => {
    const s = stubSupabase({ data: null });
    await expect(resolveClassifierMode(s, "org-1")).resolves.toBe("legacy");
  });

  it("is unavailable (not legacy) when the query errors", async () => {
    const s = stubSupabase({ data: null, error: { message: "db down" } });
    await expect(resolveClassifierMode(s, "org-1")).resolves.toBe("unavailable");
  });

  it("is unavailable when the query throws", async () => {
    const s = { from: () => { throw new Error("boom"); } } as any;
    await expect(resolveClassifierMode(s, "org-1")).resolves.toBe("unavailable");
  });

  it("isJevClassifierOrg stays false on unavailable", async () => {
    const s = stubSupabase({ data: null, error: { message: "db down" } });
    await expect(isJevClassifierOrg(s, "org-1")).resolves.toBe(false);
  });
});
