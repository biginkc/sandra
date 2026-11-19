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

describe("claimAiResponse reclaim never erases the routing v2 obligation fallback marker (Astra B1 at dc331c85974)", () => {
  /** One claim row; filters are evaluated against the row as it is at write time. */
  function interleaving(onRead: (row: Record<string, unknown>) => void) {
    const row: Record<string, unknown> = { id: "c1", status: "processing", error_message: null, lease_expires_at: new Date(Date.now() - 60_000).toISOString() };
    const updates: Array<Record<string, unknown>> = [];
    const client = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: "duplicate" } }) }) }),
        select: () => {
          const q = { eq: () => q, maybeSingle: async () => { const snapshot = { ...row }; onRead(row); return { data: snapshot, error: null }; } };
          return q;
        },
        update: (value: Record<string, unknown>) => {
          const checks: Array<() => boolean> = [];
          const q = {
            eq: (c: string, v: unknown) => { checks.push(() => row[c] === v); return q; },
            lt: () => q, // the lease is expired in this fixture
            neq: (c: string, v: unknown) => { checks.push(() => row[c] !== v); return q; },
            or: (expr: string) => {
              const marker = /error_message\.neq\.([a-z0-9_]+)/.exec(expr)?.[1];
              checks.push(() => row.error_message === null || row.error_message !== marker);
              return q;
            },
            select: () => ({
              maybeSingle: async () => {
                if (!checks.every((c) => c())) return { data: null, error: null };
                Object.assign(row, value); updates.push(value);
                return { data: { id: row.id, claimed_at: value.claimed_at }, error: null };
              },
            }),
          };
          return q;
        },
      }),
    };
    return { client, row, updates };
  }
  const args = { orgId: "o", inboundMessageId: "m1", propertyId: "p", contactId: "c", conversationId: null };

  it("a marker written between the reclaim's read and its write: claimed false, the marker stays", async () => {
    const { claimAiResponse } = await import("./claims");
    const { client, row, updates } = interleaving((r) => { Object.assign(r, { status: "completed", error_message: "v2_safety_obligation_unrecorded" }); });
    const out = await claimAiResponse(client as never, args);
    expect(out.claimed).toBe(false);
    expect(row).toMatchObject({ status: "completed", error_message: "v2_safety_obligation_unrecorded" });
    expect(updates).toEqual([]);
  });

  it("an expired processing claim with no marker is still reclaimed", async () => {
    const { claimAiResponse } = await import("./claims");
    const { client, row } = interleaving(() => {});
    expect((await claimAiResponse(client as never, args)).claimed).toBe(true);
    expect(row).toMatchObject({ status: "processing", error_message: null });
  });
});
