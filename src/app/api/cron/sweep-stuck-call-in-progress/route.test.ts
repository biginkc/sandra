import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from })),
}));

import { POST } from "./route";

describe("stuck call-in-progress sweep route", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
    vi.stubEnv("TEST_SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    from.mockReset();
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
  });
});
