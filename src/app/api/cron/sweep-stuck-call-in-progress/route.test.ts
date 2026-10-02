import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
const rpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from, rpc })),
}));

import { POST } from "./route";

describe("stuck call-in-progress sweep route", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("TEST_SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    from.mockReset();
    rpc.mockReset();
    rpc.mockResolvedValue({ data: 1, error: null });
  });

  it("resumes only stale call pauses without a completed wrap-up", async () => {
    const stale = [
      { id: "enrollment-stale", property_id: "property-stale", updated_at: "2026-08-21T14:00:00.000Z" },
      { id: "enrollment-wrapped", property_id: "property-wrapped", updated_at: "2026-08-21T14:00:00.000Z" },
    ];
    from.mockImplementation((table: string) => {
      let operation = "select";
      const builder: Record<string, unknown> = {
        select: vi.fn(() => { operation = "select"; return builder; }),
        eq: vi.fn(() => builder),
        lt: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        in: vi.fn(() => builder),
        not: vi.fn(() => builder),
        update: vi.fn(() => { operation = "update"; return builder; }),
        then: (resolve: (value: unknown) => unknown) => {
          if (table === "sequence_enrollments" && operation === "select") {
            return Promise.resolve({ data: stale, error: null }).then(resolve);
          }
          if (table === "call_activities") {
            return Promise.resolve({ data: [{ property_id: "property-wrapped", ended_at: "2026-08-21T14:30:00.000Z" }], error: null }).then(resolve);
          }
          return Promise.resolve({ count: 1, error: null }).then(resolve);
        },
      };
      return builder;
    });

    const response = await POST(new Request("http://localhost/api/cron/sweep-stuck-call-in-progress", {
      headers: { authorization: "Bearer test-secret" },
    }));
    await expect(response.json()).resolves.toEqual({
      ok: true,
      candidates: 2,
      resumed: 1,
      skippedCompletedWrapups: 1,
    });
    expect(from).toHaveBeenCalledWith("sequence_enrollments");
    expect(from).toHaveBeenCalledWith("call_activities");
    // Activation goes through the hold-aware RPC, never a direct table update.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("sweep_resume_call_in_progress", {
      p_enrollment_ids: ["enrollment-stale"],
      p_resume_at: expect.any(String),
    });
  });

  it("reports only the rows the RPC actually resumed (a Norma-held lead is skipped)", async () => {
    from.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "lt", "order", "limit", "in", "not"]) builder[method] = () => builder;
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(
          table === "sequence_enrollments"
            ? { data: [{ id: "enrollment-held", property_id: "property-held", updated_at: "2026-08-21T14:00:00.000Z" }], error: null }
            : { data: [], error: null },
        ).then(resolve);
      return builder;
    });
    rpc.mockResolvedValue({ data: 0, error: null });
    const response = await POST(new Request("http://localhost/api/cron/sweep-stuck-call-in-progress", {
      headers: { authorization: "Bearer test-secret" },
    }));
    await expect(response.json()).resolves.toEqual({ ok: true, candidates: 1, resumed: 0, skippedCompletedWrapups: 0 });
  });

  it("falls back to the original activation when deployed before the migration", async () => {
    const updates: unknown[] = [];
    from.mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "lt", "order", "limit", "in", "not"]) builder[method] = () => builder;
      builder.update = (patch: unknown) => { updates.push(patch); return builder; };
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(
          table === "sequence_enrollments" && updates.length === 0
            ? { data: [{ id: "e", property_id: "p", updated_at: "2026-08-21T14:00:00.000Z" }], error: null }
            : table === "call_activities" ? { data: [], error: null } : { count: 1, error: null },
        ).then(resolve);
      return builder;
    });
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const response = await POST(new Request("http://localhost/api/cron/sweep-stuck-call-in-progress", {
      headers: { authorization: "Bearer test-secret" },
    }));
    await expect(response.json()).resolves.toMatchObject({ ok: true, candidates: 1, resumed: 1 });
    expect(updates).toHaveLength(1);
  });
});
