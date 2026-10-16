import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { email: "owner@bmhgroupkc.com" } as { email: string } | null,
  org: { id: "org-1" } as { id: string } | null,
  thresholdRows: [] as Array<{ outcome: string; min_confidence: number; version: number }>,
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  rpcCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    from: (table: string) => {
      if (table === "organizations") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: mocks.org, error: null }),
            }),
          }),
        };
      }
      if (table === "jev_outcome_thresholds") {
        return {
          select: () => ({
            eq: async () => ({ data: mocks.thresholdRows, error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ name, ...args });
      return mocks.rpcResult;
    },
  }),
}));

import { getJevThresholds, setJevThreshold } from "./actions";

describe("getJevThresholds", () => {
  beforeEach(() => {
    mocks.org = { id: "org-1" };
    mocks.thresholdRows = [];
  });

  it("returns all five thresholdable outcomes even when only some rows exist, defaulting to version 0", async () => {
    mocks.thresholdRows = [{ outcome: "new_lead", min_confidence: 0.9, version: 1 }];
    const result = await getJevThresholds();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data?.rows).toHaveLength(5);
    const newLead = result.data?.rows.find((r) => r.outcome === "new_lead");
    expect(newLead).toEqual({ outcome: "new_lead", minConfidence: 0.9, version: 1 });
    const nurture = result.data?.rows.find((r) => r.outcome === "nurture");
    expect(nurture).toEqual({ outcome: "nurture", minConfidence: 0, version: 0 });
  });

  it("returns null data when there is no organization", async () => {
    mocks.org = null;
    const result = await getJevThresholds();
    expect(result).toEqual({ ok: true, data: null });
  });
});

describe("setJevThreshold", () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    process.env.ADMIN_EMAILS = "owner@bmhgroupkc.com";
    mocks.user = { email: "owner@bmhgroupkc.com" };
    mocks.rpcResult = { data: { minConfidence: 0.92, version: 2 }, error: null };
    mocks.rpcCalls = [];
  });

  afterEach(() => {
    process.env.ADMIN_EMAILS = originalAdminEmails;
  });

  it("rejects a non-admin caller before ever calling the RPC", async () => {
    mocks.user = { email: "not-an-admin@bmhgroupkc.com" };
    const result = await setJevThreshold({
      orgId: "org-1",
      outcome: "new_lead",
      minConfidence: 0.9,
      expectedVersion: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Only admins can edit Jev thresholds." },
    });
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("rejects an out-of-range confidence value before calling the RPC", async () => {
    const result = await setJevThreshold({
      orgId: "org-1",
      outcome: "new_lead",
      minConfidence: 1.5,
      expectedVersion: 0,
    });
    expect(result.ok).toBe(false);
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("calls fn_set_jev_outcome_threshold with a fresh idempotency key and returns the saved value", async () => {
    const result = await setJevThreshold({
      orgId: "org-1",
      outcome: "new_lead",
      minConfidence: 0.92,
      expectedVersion: 1,
    });
    expect(result).toEqual({ ok: true, data: { minConfidence: 0.92, version: 2 } });
    expect(mocks.rpcCalls).toHaveLength(1);
    expect(mocks.rpcCalls[0]).toMatchObject({
      name: "fn_set_jev_outcome_threshold",
      p_org_id: "org-1",
      p_outcome: "new_lead",
      p_min_confidence: 0.92,
      p_expected_version: 1,
    });
    expect(typeof mocks.rpcCalls[0].p_idempotency_key).toBe("string");
  });

  it("surfaces a clear conflict message on STALE_STATE instead of the raw error", async () => {
    mocks.rpcResult = { data: null, error: { message: "STALE_STATE" } };
    const result = await setJevThreshold({
      orgId: "org-1",
      outcome: "new_lead",
      minConfidence: 0.9,
      expectedVersion: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "JEV_THRESHOLD_UPDATE_FAILED",
        message: "Someone else already changed this threshold. Reload and try again.",
      },
    });
  });
});
