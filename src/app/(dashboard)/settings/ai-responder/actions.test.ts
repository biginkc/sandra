import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Root review of 3e4ee3b1 (jev-root-round12-review.md), finding 3: the
 * one-cutover switch (updateJevAutomaticClassification) that atomically
 * maps enabled -> classifier_provider='jev' + classifier_mode='automatic'
 * and disabled -> 'legacy' + 'shadow'. Admin-gated, and enabling requires
 * a non-empty server-side TYPESAFE_API_KEY.
 */
const mocks = vi.hoisted(() => ({
  user: { email: "owner@bmhgroupkc.com" } as { email: string } | null,
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown>; id: string }>,
  updateError: null as { message: string } | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          mocks.updateCalls.push({ table, values, id });
          return Promise.resolve({ error: mocks.updateError });
        },
      }),
    }),
  }),
}));

import { updateJevAutomaticClassification } from "./actions";

describe("updateJevAutomaticClassification", () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  const originalTypesafeKey = process.env.TYPESAFE_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_EMAILS = "owner@bmhgroupkc.com";
    process.env.TYPESAFE_API_KEY = "test-typesafe-key";
    mocks.user = { email: "owner@bmhgroupkc.com" };
    mocks.updateCalls = [];
    mocks.updateError = null;
  });

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalAdminEmails;
    process.env.TYPESAFE_API_KEY = originalTypesafeKey;
  });

  it("rejects a non-admin caller before touching the database", async () => {
    mocks.user = { email: "not-an-admin@bmhgroupkc.com" };
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Only admins can change Jev automatic classification." },
    });
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it("rejects enabling when TYPESAFE_API_KEY is not configured, before touching the database", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("TYPESAFE_API_KEY");
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it("rejects enabling when TYPESAFE_API_KEY is only whitespace", async () => {
    process.env.TYPESAFE_API_KEY = "   ";
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result.ok).toBe(false);
    expect(mocks.updateCalls).toHaveLength(0);
  });

  it("enabling atomically sets provider='jev' and mode='automatic' in the SAME update call", async () => {
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result).toEqual({ ok: true, data: null });
    expect(mocks.updateCalls).toHaveLength(1);
    expect(mocks.updateCalls[0]).toMatchObject({
      table: "ai_responder_configs",
      id: "config-1",
      values: { classifier_provider: "jev", classifier_mode: "automatic" },
    });
  });

  it("disabling atomically sets provider='legacy' and mode='shadow' in the SAME update call — never requires TYPESAFE_API_KEY", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: false });
    expect(result).toEqual({ ok: true, data: null });
    expect(mocks.updateCalls[0]).toMatchObject({
      values: { classifier_provider: "legacy", classifier_mode: "shadow" },
    });
  });

  it("surfaces a database error instead of silently succeeding", async () => {
    mocks.updateError = { message: "connection reset" };
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result).toEqual({
      ok: false,
      error: { code: "AI_CONFIG_UPDATE_FAILED", message: "connection reset" },
    });
  });
});
