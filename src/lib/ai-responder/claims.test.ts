import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { completeAiResponseClaim, expireAiResponseClaimLease } from "./claims";

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

describe("claim write results are explicit", () => {
  const failing = (error: unknown) => ({
    from: () => ({
      update: () => ({
        eq: () => {
          const result = Promise.resolve({ error });
          return Object.assign(result, {
            select: () => ({ maybeSingle: async () => ({ data: null, error }) }),
          });
        },
      }),
    }),
  });

  it("completeAiResponseClaim returns true on success and for a null claim, false on a write error or throw", async () => {
    const { client } = recorder();
    expect(await completeAiResponseClaim(client as never, { claimId: "c1", outcome: "sent" })).toBe(true);
    expect(await completeAiResponseClaim(client as never, { claimId: null, outcome: "sent" })).toBe(true);
    expect(await completeAiResponseClaim(failing({ message: "boom" }) as never, { claimId: "c1", outcome: "sent" })).toBe(false);
    const throwing = { from: () => { throw new Error("network"); } };
    expect(await completeAiResponseClaim(throwing as never, { claimId: "c1", outcome: "sent" })).toBe(false);
  });

  it("expireAiResponseClaimLease expires the lease and reports failure instead of swallowing it", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const ok = {
      from: () => ({
        update: (value: Record<string, unknown>) => {
          updates.push(value);
          return { eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "c1" }, error: null }) }) }) };
        },
      }),
    };
    expect(await expireAiResponseClaimLease(ok as never, { claimId: "c1", errorMessage: "retry_scheduled:x:1" })).toBe(true);
    expect(updates[0]).toMatchObject({ status: "error", error_message: "retry_scheduled:x:1" });
    expect(Date.parse(updates[0]!.lease_expires_at as string)).toBeLessThanOrEqual(Date.now());
    expect(await expireAiResponseClaimLease(failing({ message: "boom" }) as never, { claimId: "c1", errorMessage: "x" })).toBe(false);
  });
});
