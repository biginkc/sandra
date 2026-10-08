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
  const drips = { maybeLater: "s1", checkIn60: "s2", listedNotSelling: "s3", hotBookAppointment: "s4" };
  it("passes the owner's four choices to the owner-only RPC", async () => {
    mocks.rpcResult = {
      data: { id: "c", nurtureAutoDrip: true, maybeLaterSequenceId: "s1", checkIn60SequenceId: "s2", listedNotSellingSequenceId: "s3", hotBookAppointmentSequenceId: "s4" },
      error: null,
    };
    const r = await setNurtureAutoDrip({ configId: "c", enabled: true, drips });
    expect(r).toEqual({ ok: true, data: { enabled: true, drips } });
    expect(mocks.rpcCalls).toEqual([
      expect.objectContaining({
        name: "fn_set_nurture_auto_drip", p_config_id: "c", p_enabled: true,
        p_maybe_later_sequence_id: "s1", p_check_in_60_sequence_id: "s2",
        p_listed_not_selling_sequence_id: "s3", p_hot_book_appointment_sequence_id: "s4",
      }),
    ]);
  });
  it("refuses 'on' unless all four drips are set, before any database call", async () => {
    for (const missing of ["maybeLater", "checkIn60", "listedNotSelling", "hotBookAppointment"] as const) {
      const r = await setNurtureAutoDrip({ configId: "c", enabled: true, drips: { ...drips, [missing]: null } });
      expect(r.ok).toBe(false);
    }
    expect(mocks.rpcCalls).toEqual([]);
  });
  it("maps a non-owner to a plain message", async () => {
    mocks.rpcResult = { data: null, error: { message: "FORBIDDEN" } };
    const r = await setNurtureAutoDrip({ configId: "c", enabled: false, drips: { maybeLater: null, checkIn60: null, listedNotSelling: null, hotBookAppointment: null } });
    expect(r).toMatchObject({ ok: false, error: { message: "Only an org owner can change this." } });
  });
});
