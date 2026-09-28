import { describe, expect, it } from "vitest";

import { isJevClassifierOrg } from "./inbound";

function stubSupabase(result: { data: { classifier_provider: string } | null }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: result.data, error: null }),
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
