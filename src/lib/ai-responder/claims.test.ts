import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { completeAiResponseClaim } from "./claims";

function recorder() {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from: () => ({
      update: (value: Record<string, unknown>) => {
        updates.push(value);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { client, updates };
}

describe("completeAiResponseClaim", () => {
  it("a normal completion does not touch the lease", async () => {
    const { client, updates } = recorder();
    await completeAiResponseClaim(client as never, { claimId: "c1", outcome: "sent" });
    expect(updates[0]).toMatchObject({ status: "completed" });
    expect(updates[0]).not.toHaveProperty("lease_expires_at");
  });

  it("a retry parks the claim in error with an expired lease so the same inbound can be reclaimed at once", async () => {
    const { client, updates } = recorder();
    const before = Date.now();
    await completeAiResponseClaim(client as never, {
      claimId: "c1",
      outcome: "retry",
      errorMessage: "retry_scheduled:send_reserved_elsewhere:1",
      releaseLease: true,
    });
    expect(updates[0]).toMatchObject({ status: "error", completed_at: null });
    expect(Date.parse(updates[0]!.lease_expires_at as string)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(updates[0]!.lease_expires_at as string)).toBeGreaterThanOrEqual(before - 1);
  });
});
