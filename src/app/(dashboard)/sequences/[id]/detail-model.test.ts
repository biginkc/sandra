import { describe, expect, it, vi } from "vitest";
import { runSelectedEnrollmentAction } from "./detail-model";

describe("detail bulk actions", () => {
  it("stops only selected enrollments and reports each outcome", async () => {
    const stop = vi.fn(async (id: string) => id === "b"
      ? { ok: false as const, error: { code: "FAILED", message: "Already stopped" } }
      : { ok: true as const, data: null });
    const outcomes = await runSelectedEnrollmentAction(["a", "b"], stop);
    expect(stop.mock.calls).toEqual([["a"], ["b"]]);
    expect(outcomes).toEqual([
      { id: "a", ok: true, message: "Done" },
      { id: "b", ok: false, message: "Already stopped" },
    ]);
  });
});
