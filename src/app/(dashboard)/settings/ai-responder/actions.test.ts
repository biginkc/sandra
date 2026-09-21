import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Root review of 3e4ee3b1 (jev-root-round12-review.md), finding 3: the
 * one-cutover switch (updateJevAutomaticClassification) that atomically
 * maps enabled -> classifier_provider='jev' + classifier_mode='automatic'
 * and disabled -> 'legacy' + 'shadow'. Admin-gated (UX-only), and
 * enabling requires a non-empty server-side TYPESAFE_API_KEY.
 *
 * Root review of edbd7bfe (jev-root-round13-review.md), finding 1: the
 * actual authorization boundary is now fn_update_jev_automatic_classification
 * (SECURITY DEFINER, resolves org from the DB, requires active org
 * membership) — this action just calls the RPC and maps its FORBIDDEN
 * failure to a visible error. The RPC itself is covered by an integration
 * test against real Postgres; this file proves the action's own plumbing:
 * it calls the RPC (never a plain table .update()), passes the right
 * args, and surfaces a FORBIDDEN failure truthfully instead of reporting
 * success.
 */
const mocks = vi.hoisted(() => ({
  user: { email: "owner@bmhgroupkc.com" } as { email: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ name, args });
      return mocks.rpcResult;
    },
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
    mocks.rpcCalls = [];
    mocks.rpcResult = {
      data: { id: "config-1", classifierProvider: "jev", classifierMode: "automatic" },
      error: null,
    };
  });

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalAdminEmails;
    process.env.TYPESAFE_API_KEY = originalTypesafeKey;
  });

  it("rejects a non-admin caller before ever calling the RPC (app-level UX gate)", async () => {
    mocks.user = { email: "not-an-admin@bmhgroupkc.com" };
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Only admins can change Jev automatic classification." },
    });
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("rejects enabling when TYPESAFE_API_KEY is not configured, before ever calling the RPC", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("TYPESAFE_API_KEY");
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("rejects enabling when TYPESAFE_API_KEY is only whitespace", async () => {
    process.env.TYPESAFE_API_KEY = "   ";
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("enabling calls fn_update_jev_automatic_classification with p_enabled=true", async () => {
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result).toEqual({ ok: true, data: null });
    expect(mocks.rpcCalls).toHaveLength(1);
    expect(mocks.rpcCalls[0]).toEqual({
      name: "fn_update_jev_automatic_classification",
      args: { p_config_id: "config-1", p_enabled: true },
    });
  });

  it("disabling calls fn_update_jev_automatic_classification with p_enabled=false — never requires TYPESAFE_API_KEY", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: false });
    expect(result).toEqual({ ok: true, data: null });
    expect(mocks.rpcCalls[0].args).toEqual({ p_config_id: "config-1", p_enabled: false });
  });

  // Root review of edbd7bfe, finding 1 (tightened by cba0c85d, round 14):
  // the RPC (not this action) is what actually enforces owner-only
  // authorization — it raises FORBIDDEN for ALL of: an ordinary active
  // (non-owner) member, an inactive/expired/deletion-prepared owner, a
  // config in an org the caller isn't an active owner of, and a config
  // id that no longer exists — all indistinguishable. This action must
  // surface that truthfully, not report success.
  it("surfaces the RPC's FORBIDDEN (non-owner/inactive/expired/cross-org/stale config) as a visible failure, never a silent success", async () => {
    mocks.rpcResult = { data: null, error: { message: "FORBIDDEN" } };
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "AI_CONFIG_UPDATE_FAILED",
        message: "Only an active org owner can change this, or this config no longer exists.",
      },
    });
  });

  it("surfaces any other RPC error message as-is", async () => {
    mocks.rpcResult = { data: null, error: { message: "connection reset" } };
    const result = await updateJevAutomaticClassification({ configId: "config-1", enabled: true });
    expect(result).toEqual({
      ok: false,
      error: { code: "AI_CONFIG_UPDATE_FAILED", message: "connection reset" },
    });
  });
});
