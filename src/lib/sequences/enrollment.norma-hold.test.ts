import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));
const { recordLeadEvent } = vi.hoisted(() => ({ recordLeadEvent: vi.fn() }));
vi.mock("@/lib/events", async () => {
  const actual = await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return { ...actual, recordLeadEvent, recordLeadEvents: vi.fn().mockResolvedValue(undefined) };
});

import { resumeByProperty, resumeEnrollment, retrySequenceStep } from "./enrollment";

function selectBuilder(rows: unknown, single: unknown = null) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in"]) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve({ data: single, error: null });
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
  return b;
}

describe("Norma hold in the TypeScript resume paths", () => {
  beforeEach(() => {
    recordLeadEvent.mockReset();
    recordLeadEvent.mockResolvedValue(undefined);
  });

  it("resumeByProperty tells the RPC which reason it selected, and counts only real resumes", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ outcome: "resumed", next_run_at: "2026-10-02T00:00:00Z" }], error: null })
      .mockResolvedValueOnce({ data: [{ outcome: "pause_reason_changed", next_run_at: null }], error: null })
      .mockResolvedValueOnce({ data: [{ outcome: "norma_hold", next_run_at: null }], error: null });
    const client = {
      from: vi.fn(() => selectBuilder([
        { id: "e1", sequence_id: "s" }, { id: "e2", sequence_id: "s" }, { id: "e3", sequence_id: "s" },
      ])),
      rpc,
    } as unknown as SupabaseClient<Database>;

    await expect(resumeByProperty(client, { propertyId: "p" })).resolves.toEqual({ resumed: 1 });
    for (const call of rpc.mock.calls) {
      expect(call[0]).toBe("resume_sequence_enrollment");
      expect(call[1]).toMatchObject({ p_expected_pause_reason: "call_in_progress" });
    }
    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
  });

  it("resumeByProperty falls back to the original RPC when deployed before the migration", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })
      .mockResolvedValueOnce({ data: [{ outcome: "resumed", next_run_at: "2026-10-02T00:00:00Z" }], error: null });
    const client = {
      from: vi.fn(() => selectBuilder([{ id: "e1", sequence_id: "s" }])),
      rpc,
    } as unknown as SupabaseClient<Database>;
    await expect(resumeByProperty(client, { propertyId: "p" })).resolves.toEqual({ resumed: 1 });
    expect(rpc.mock.calls[1]![1]).not.toHaveProperty("p_expected_pause_reason");
  });

  it("resumeByProperty still throws on any other RPC error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    const client = {
      from: vi.fn(() => selectBuilder([{ id: "e1", sequence_id: "s" }])),
      rpc,
    } as unknown as SupabaseClient<Database>;
    await expect(resumeByProperty(client, { propertyId: "p" })).rejects.toThrow("resumeByProperty: boom");
  });

  it("Retry is refused while a Norma request holds the lead", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ outcome: "norma_hold", new_claim_id: null, step_index: 0 }], error: null });
    const client = { from: vi.fn(), rpc } as unknown as SupabaseClient<Database>;
    await expect(retrySequenceStep(client, "e1")).resolves.toEqual({ status: "norma_hold" });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("a manual resume is refused while a Norma request holds the lead", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ outcome: "norma_hold", next_run_at: null }], error: null });
    const client = {
      from: vi.fn(() => selectBuilder(null, {
        id: "e1", status: "paused", sequence_id: "s", property_id: "p", current_step_index: 0, pause_reason: "norma_call",
      })),
      rpc,
    } as unknown as SupabaseClient<Database>;
    await expect(resumeEnrollment(client, "e1")).resolves.toEqual({ status: "norma_hold" });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});

describe("enrolling while a Norma request holds the lead", () => {
  it("enrollLead refuses with a clear message and reads nothing else", async () => {
    const from = vi.fn((table: string) => {
      if (table === "norma_call_requests") {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in"]) b[m] = () => b;
        b.limit = () => Promise.resolve({ data: [{ id: "r" }], error: null });
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    });
    const { enrollLead } = await import("./enrollment");
    const outcome = await enrollLead({ from } as unknown as SupabaseClient<Database>, { sequenceId: "s", propertyId: "p" });
    expect(outcome).toMatchObject({ status: "suppressed", message: expect.stringContaining("Norma call is open") });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("enrollLead fails closed if the hold cannot be read", async () => {
    const from = vi.fn(() => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) b[m] = () => b;
      b.limit = () => Promise.resolve({ data: null, error: { code: "XX000", message: "db down" } });
      return b;
    });
    const { enrollLead } = await import("./enrollment");
    await expect(enrollLead({ from } as unknown as SupabaseClient<Database>, { sequenceId: "s", propertyId: "p" }))
      .resolves.toMatchObject({ status: "failed" });
  });
});
