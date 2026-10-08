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

import { setLabelRule, setNurtureAutoDrip } from "./threshold-actions";

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
});

describe("setNurtureAutoDrip", () => {
  it("passes the owner's choice to the owner-only RPC", async () => {
    mocks.rpcResult = { data: { id: "c", nurtureAutoDrip: true, sequenceId: "seq-1" }, error: null };
    const r = await setNurtureAutoDrip({ configId: "c", enabled: true, sequenceId: "seq-1" });
    expect(r).toEqual({ ok: true, data: { enabled: true, sequenceId: "seq-1" } });
    expect(mocks.rpcCalls).toEqual([
      expect.objectContaining({ name: "fn_set_nurture_auto_drip", p_config_id: "c", p_enabled: true, p_sequence_id: "seq-1" }),
    ]);
  });
  it("refuses 'on' with no drip before any database call", async () => {
    const r = await setNurtureAutoDrip({ configId: "c", enabled: true, sequenceId: null });
    expect(r.ok).toBe(false);
    expect(mocks.rpcCalls).toEqual([]);
  });
  it("maps a non-owner to a plain message", async () => {
    mocks.rpcResult = { data: null, error: { message: "FORBIDDEN" } };
    const r = await setNurtureAutoDrip({ configId: "c", enabled: false, sequenceId: null });
    expect(r).toMatchObject({ ok: false, error: { message: "Only an org owner can change this." } });
  });
});
