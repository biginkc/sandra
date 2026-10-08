import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  rpcCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ name, ...args });
      return mocks.rpcResult;
    },
  }),
}));

import { setLabelRule } from "./threshold-actions";

const input = {
  orgId: "org-1",
  outcome: "nurture" as const,
  minConfidence: 0.925,
  automationEnabled: false,
  expectedVersion: 3,
};

beforeEach(() => {
  mocks.rpcCalls = [];
  mocks.rpcResult = {
    data: { ok: true, minConfidence: 0.925, automationEnabled: false, version: 4 },
    error: null,
  };
});

describe("setLabelRule", () => {
  it("passes exactly what the owner confirmed to fn_set_jev_outcome_threshold", async () => {
    const r = await setLabelRule(input);
    expect(r).toEqual({ ok: true, data: { minConfidence: 0.925, automationEnabled: false, version: 4 } });
    expect(mocks.rpcCalls).toEqual([
      expect.objectContaining({
        name: "fn_set_jev_outcome_threshold",
        p_org_id: "org-1",
        p_outcome: "nurture",
        p_min_confidence: 0.925,
        p_automation_enabled: false,
        p_expected_version: 3,
        p_idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    ]);
  });

  it("rejects values it would otherwise have to round or invent, before any database call", async () => {
    for (const bad of [
      { minConfidence: 1.1 },
      { minConfidence: -0.1 },
      { minConfidence: 0.9999 },
      { minConfidence: Number.NaN },
      { outcome: "dnc" as never },
      { outcome: "opted_out_x" as never },
      { automationEnabled: "yes" as never },
      { expectedVersion: -1 },
      { expectedVersion: 1.5 },
    ]) {
      const r = await setLabelRule({ ...input, ...bad });
      expect(r.ok).toBe(false);
    }
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("explains a stale version and a non-owner in plain words", async () => {
    mocks.rpcResult = { data: null, error: { message: "STALE_STATE" } };
    expect(await setLabelRule(input)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Someone else/) } });
    mocks.rpcResult = { data: null, error: { message: "FORBIDDEN" } };
    expect(await setLabelRule(input)).toMatchObject({ ok: false, error: { message: "Only an org owner can change these rules." } });
  });

  it("refuses to enable a never-automate label server-side, before the RPC", async () => {
    for (const outcome of ["opted_out", "dnc"] as const) {
      const r = await setLabelRule({ ...input, outcome: outcome as never, automationEnabled: true });
      expect(r.ok).toBe(false);
    }
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("still lets opted_out's cutoff be set while automation stays off", async () => {
    const r = await setLabelRule({ ...input, outcome: "opted_out", automationEnabled: false });
    expect(r.ok).toBe(true);
    expect(mocks.rpcCalls).toHaveLength(1);
  });
});
