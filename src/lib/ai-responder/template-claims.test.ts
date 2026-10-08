import { beforeEach, describe, expect, it, vi } from "vitest";

const { markAttention, reportError } = vi.hoisted(() => ({
  markAttention: vi.fn(async () => true),
  reportError: vi.fn(),
}));
vi.mock("./dispatch", () => ({ markPropertyNeedsAttention: markAttention }));
vi.mock("@/lib/errors/report", () => ({ reportError }));

import {
  TEMPLATE_SENT_MISSING_OUTCOME,
  TEMPLATE_SENT_PENDING_OUTCOME,
  loadClaimTemplateSent,
  recordClaimTemplateSent,
} from "./claims";
import { sweepTemplateSentClaims, TEMPLATE_SENT_OUTCOME_MISSING_REASON } from "./template-claims";

/** Minimal chainable PostgREST fake that records the filters and resolves a canned result. */
function fakeClaims(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const mk = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "lt", "order", "limit", "update"]) {
      b[m] = (...args: unknown[]) => {
        calls.push([m, ...args]);
        return b;
      };
    }
    b.maybeSingle = async () => result;
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return b;
  };
  return { client: { from: vi.fn(() => mk()) } as never, calls };
}

beforeEach(() => {
  markAttention.mockReset().mockResolvedValue(true);
  reportError.mockReset();
});

describe("sweepTemplateSentClaims", () => {
  it("asks for pending-marker claims past their lease and flags each property once", async () => {
    const stale = [
      { id: "c1", org_id: "o", property_id: "p1", outbound_message_id: "m1" },
      { id: "c2", org_id: "o", property_id: "p2", outbound_message_id: "m2" },
    ];
    const queries: Array<ReturnType<typeof fakeClaims>> = [];
    const results = [
      { data: stale, error: null },
      { data: { id: "c1" }, error: null },
      { data: { id: "c2" }, error: null },
    ];
    const from = vi.fn(() => {
      const f = fakeClaims(results[queries.length]!);
      queries.push(f);
      return (f.client as { from: () => unknown }).from();
    });
    const now = new Date("2026-10-08T12:00:00.000Z");
    const out = await sweepTemplateSentClaims({ from } as never, { now, graceMs: 5 * 60_000 });

    expect(out).toEqual({ scanned: 2, flagged: 2, failed: 0 });
    const selectCalls = queries[0]!.calls;
    expect(selectCalls).toContainEqual(["eq", "outcome", TEMPLATE_SENT_PENDING_OUTCOME]);
    expect(selectCalls).toContainEqual(["in", "status", ["processing", "error"]]);
    expect(selectCalls).toContainEqual(["not", "outbound_message_id", "is", null]);
    expect(selectCalls).toContainEqual(["lt", "lease_expires_at", "2026-10-08T11:55:00.000Z"]);
    expect(markAttention).toHaveBeenCalledWith(expect.anything(), "p1", "template_sent_outcome_missing");
    expect(markAttention).toHaveBeenCalledWith(expect.anything(), "p2", TEMPLATE_SENT_OUTCOME_MISSING_REASON);
    // The marker is retired conditionally so a claim is flagged once.
    expect(queries[1]!.calls).toContainEqual(["eq", "outcome", TEMPLATE_SENT_PENDING_OUTCOME]);
    expect(queries[1]!.calls[0]![1]).toMatchObject({ outcome: TEMPLATE_SENT_MISSING_OUTCOME });
  });

  it("a flag that cannot be written leaves the marker so the next sweep retries", async () => {
    markAttention.mockResolvedValue(false);
    const queries: Array<ReturnType<typeof fakeClaims>> = [];
    const from = vi.fn(() => {
      const f = fakeClaims({ data: [{ id: "c1", org_id: "o", property_id: "p1", outbound_message_id: "m1" }], error: null });
      queries.push(f);
      return (f.client as { from: () => unknown }).from();
    });
    const out = await sweepTemplateSentClaims({ from } as never);
    expect(out).toEqual({ scanned: 1, flagged: 0, failed: 1 });
    expect(queries).toHaveLength(1); // no retire write
  });

  it("a failed scan is reported, not thrown", async () => {
    const { client } = fakeClaims({ data: null, error: { message: "boom" } });
    expect(await sweepTemplateSentClaims(client)).toEqual({ scanned: 0, flagged: 0, failed: 1 });
    expect(reportError).toHaveBeenCalled();
  });
});

describe("claim template record helpers", () => {
  it("recordClaimTemplateSent stamps the message id and the pending marker", async () => {
    const { client, calls } = fakeClaims({ data: { id: "c1" }, error: null });
    expect(await recordClaimTemplateSent(client, { claimId: "c1", outboundMessageId: "m1" })).toBe(true);
    expect(calls[0]![1]).toMatchObject({ outbound_message_id: "m1", outcome: TEMPLATE_SENT_PENDING_OUTCOME });
    expect(calls).toContainEqual(["eq", "id", "c1"]);
  });

  it("recordClaimTemplateSent reports false when the row was not updated", async () => {
    const { client } = fakeClaims({ data: null, error: null });
    expect(await recordClaimTemplateSent(client, { claimId: "c1", outboundMessageId: "m1" })).toBe(false);
    expect(await recordClaimTemplateSent(client, { claimId: null, outboundMessageId: "m1" })).toBe(true);
  });

  it("loadClaimTemplateSent returns the id only for a marked claim, 'error' when unreadable", async () => {
    expect(
      await loadClaimTemplateSent(
        fakeClaims({ data: { outbound_message_id: "m1", outcome: TEMPLATE_SENT_PENDING_OUTCOME }, error: null }).client,
        "c1",
      ),
    ).toBe("m1");
    expect(
      await loadClaimTemplateSent(
        fakeClaims({ data: { outbound_message_id: "m1", outcome: "auto_closed" }, error: null }).client,
        "c1",
      ),
    ).toBeNull();
    expect(await loadClaimTemplateSent(fakeClaims({ data: null, error: { message: "x" } }).client, "c1")).toBe("error");
    expect(await loadClaimTemplateSent(fakeClaims({ data: null, error: null }).client, null)).toBeNull();
  });
});
