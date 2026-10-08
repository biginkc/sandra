import { beforeEach, describe, expect, it, vi } from "vitest";

const { applyPhoneLevelOptOut, recordLeadEvent, reportError, createAdminClient } = vi.hoisted(() => ({
  applyPhoneLevelOptOut: vi.fn(),
  recordLeadEvent: vi.fn(),
  reportError: vi.fn(),
  createAdminClient: vi.fn(() => ({ admin: true })),
}));

vi.mock("@/lib/messaging/opt-out-phone", () => ({ applyPhoneLevelOptOut }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { OPTED_OUT: "opted_out" },
  recordLeadEvent,
}));
vi.mock("@/lib/errors/report", () => ({ reportError }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import {
  applySuppressionForConfirmedReview,
  applyConfirmedSuppression,
  dischargeSuppressionObligation,
  retryOutstandingSuppressionObligations,
  listOutstandingSuppressionReviews,
  recordSuppressionRetriedOk,
  suppressionIncompleteReason,
  suppressionReviewIdsFromReason,
  SUPPRESSION_INCOMPLETE_WARNING,
} from "./confirm-suppression";

const base = {
  reviewId: "review-1",
  contactId: "contact-1",
  phone: "+18165550100",
  propertyId: "property-1",
  orgId: "org-1",
  actorId: "user-1",
  aiReason: "said stop",
};

beforeEach(() => {
  vi.clearAllMocks();
  applyPhoneLevelOptOut.mockResolvedValue(undefined);
  recordLeadEvent.mockResolvedValue(undefined);
  createAdminClient.mockReturnValue({ admin: true } as never);
});

describe("applyConfirmedSuppression", () => {
  it("opted_out runs phone-level opt-out once with the automated-path key and logs a user lead event", async () => {
    const result = await applyConfirmedSuppression({ ...base, disposition: "opted_out" });

    expect(result).toEqual({ ok: true });
    expect(applyPhoneLevelOptOut).toHaveBeenCalledTimes(1);
    expect(applyPhoneLevelOptOut).toHaveBeenCalledWith(
      { admin: true },
      expect.objectContaining({
        contactId: "contact-1",
        fromPhone: "+18165550100",
        orgId: "org-1",
        surface: "stop",
        source: "ai_responder",
        idempotencyKey: "ai-responder:property-1:contact-1:said stop",
      }),
    );
    expect(recordLeadEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: "property-1",
        eventType: "opted_out",
        actorType: "user",
        actorId: "user-1",
        sourceType: "ai_disposition_reviews.confirmed_suppression",
        sourceId: "review-1",
      }),
    );
  });

  it("dnc uses the dnc surface, source and key", async () => {
    await applyConfirmedSuppression({ ...base, disposition: "dnc" });

    expect(applyPhoneLevelOptOut).toHaveBeenCalledTimes(1);
    expect(applyPhoneLevelOptOut).toHaveBeenCalledWith(
      { admin: true },
      expect.objectContaining({
        surface: "dnc",
        source: "ai_responder_threat",
        idempotencyKey: "ai-responder-dnc:property-1:contact-1:said stop",
      }),
    );
  });

  it.each(["not_interested", "wrong_number"])("%s never suppresses", async (disposition) => {
    const result = await applyConfirmedSuppression({ ...base, disposition });

    expect(result).toEqual({ ok: true });
    expect(applyPhoneLevelOptOut).not.toHaveBeenCalled();
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("returns a warning (never throws) when suppression fails, and skips the lead event", async () => {
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));

    const result = await applyConfirmedSuppression({ ...base, disposition: "opted_out" });

    expect(result).toEqual({ ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING });
    expect(SUPPRESSION_INCOMPLETE_WARNING).toMatch(/suppression incomplete/i);
    expect(reportError).toHaveBeenCalled();
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("warns when there is no phone to suppress", async () => {
    const result = await applyConfirmedSuppression({ ...base, phone: null, disposition: "opted_out" });

    expect(result).toEqual({ ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING });
    expect(applyPhoneLevelOptOut).not.toHaveBeenCalled();
  });

  it("is safe to retry: a second call re-runs the idempotent opt-out with the same key", async () => {
    await applyConfirmedSuppression({ ...base, disposition: "opted_out" });
    await applyConfirmedSuppression({ ...base, disposition: "opted_out" });

    const keys = applyPhoneLevelOptOut.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });
});

function lookupClient(disposition: string, overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = {
    ai_disposition_reviews: {
      property_id: "property-1",
      org_id: "org-1",
      disposition,
      ai_reason: "said stop",
      source_inbound_message_id: "msg-1",
    },
    properties: { homeowner_contact_id: "contact-1", org_id: "org-1" },
    contacts: { phone_1: "+18165550100" },
    messages: { from_address: "+18165550100" },
    ...overrides,
  };
  const updates: Array<{ table: string; values: unknown }> = [];
  const inserts: Array<{ table: string; values: unknown }> = [];
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.insert = async (values: unknown) => {
      inserts.push({ table, values });
      return { error: null };
    };
    c.update = (values: unknown) => {
      updates.push({ table, values });
      return c;
    };
    c.maybeSingle = async () => ({ data: rows[table], error: null });
    c.then = (resolve: (v: unknown) => void) => resolve({ data: [{ id: "property-1" }], error: null });
    return c;
  };
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return { data: [{ reason: "suppression_incomplete:review-1", merged_ids: [], kept_timeout: false, dropped_ids: [] }], error: null };
  };
  return { from: chain, rpc, updates, inserts, rpcCalls };
}

describe("applySuppressionForConfirmedReview", () => {
  it("confirmed opted_out review resolves the homeowner phone and suppresses once", async () => {
    const result = await applySuppressionForConfirmedReview(lookupClient("opted_out"), "review-1", "user-1");
    expect(result).toEqual({ ok: true });
    expect(applyPhoneLevelOptOut).toHaveBeenCalledTimes(1);
    expect(applyPhoneLevelOptOut).toHaveBeenCalledWith(
      { admin: true },
      expect.objectContaining({ fromPhone: "+18165550100", contactId: "contact-1" }),
    );
  });

  it("confirmed dnc review suppresses on the dnc surface", async () => {
    await applySuppressionForConfirmedReview(lookupClient("dnc"), "review-1", "user-1");
    expect(applyPhoneLevelOptOut).toHaveBeenCalledWith({ admin: true }, expect.objectContaining({ surface: "dnc" }));
  });

  it("confirmed wrong_number scoped to all suppresses the phone on the dnc surface and discharges the obligation", async () => {
    const a = {
      inserts: [] as Array<Record<string, unknown>>,
      rpcs: [] as string[],
    };
    const chain = (table: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({ data: table === "lead_events" ? { id: "ev-1" } : { org_id: "org-1" }, error: null });
      c.insert = async (values: Record<string, unknown>) => {
        a.inserts.push(values);
        return { error: null };
      };
      return c;
    };
    createAdminClient.mockReturnValue({
      from: chain,
      rpc: async (name: string) => {
        a.rpcs.push(name);
        return { error: null };
      },
    } as never);
    const result = await applySuppressionForConfirmedReview(
      lookupClient("wrong_number", {
        ai_disposition_reviews: {
          property_id: "property-1", org_id: "org-1", disposition: "wrong_number",
          ai_reason: "wrong number", source_inbound_message_id: "msg-1", wrong_scope: "all",
        },
      }),
      "review-1",
      "user-1",
      { discharge: true },
    );
    expect(result).toEqual({ ok: true });
    expect(applyPhoneLevelOptOut).toHaveBeenCalledTimes(1);
    expect(applyPhoneLevelOptOut).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: "dnc", source: "ai_responder_wrong_number" }),
    );
    expect(a.inserts[0]).toMatchObject({ event_type: "suppression_retried_ok", source_id: "review-1" });
    expect(a.rpcs).toEqual(["fn_clear_suppression_hold_if_resolved"]);
  });

  it("confirmed wrong_number scoped to this_property (or unscoped) never suppresses the phone", async () => {
    for (const scope of ["this_property", null]) {
      await applySuppressionForConfirmedReview(
        lookupClient("wrong_number", {
          ai_disposition_reviews: {
            property_id: "property-1", org_id: "org-1", disposition: "wrong_number",
            ai_reason: "wrong number", source_inbound_message_id: "msg-1", wrong_scope: scope,
          },
        }),
        "review-1",
        "user-1",
        { discharge: true },
      );
    }
    expect(applyPhoneLevelOptOut).not.toHaveBeenCalled();
  });

  it("confirmed not_interested review does not suppress", async () => {
    const result = await applySuppressionForConfirmedReview(lookupClient("not_interested"), "review-1", "user-1");
    expect(result).toEqual({ ok: true });
    expect(applyPhoneLevelOptOut).not.toHaveBeenCalled();
  });

  it("a failed lookup returns the warning instead of throwing", async () => {
    const bad = { from: () => { throw new Error("boom"); } };
    const result = await applySuppressionForConfirmedReview(bad, "review-1", "user-1");
    expect(result).toEqual({ ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING });
  });

  it("suppresses the number the seller actually texted from (phone_2), not phone_1", async () => {
    await applySuppressionForConfirmedReview(
      lookupClient("opted_out", { messages: { from_address: "+18165550222" } }),
      "review-1",
      "user-1",
    );
    expect(applyPhoneLevelOptOut).toHaveBeenCalledWith(
      { admin: true },
      expect.objectContaining({ fromPhone: "+18165550222" }),
    );
  });

  it("falls back to the contact phone when the source message is missing", async () => {
    await applySuppressionForConfirmedReview(
      lookupClient("opted_out", { messages: null }),
      "review-1",
      "user-1",
    );
    expect(applyPhoneLevelOptOut).toHaveBeenCalledWith(
      { admin: true },
      expect.objectContaining({ fromPhone: "+18165550100" }),
    );
  });

  it("re-raises needs_human_attention with reason suppression_incomplete when suppression fails", async () => {
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));
    const admin = lookupClient("opted_out");
    createAdminClient
      .mockReturnValueOnce({ admin: true }) // opt-out attempt
      .mockReturnValueOnce(admin as never); // hold re-raise
    const result = await applySuppressionForConfirmedReview(
      lookupClient("opted_out"),
      "review-1",
      "user-1",
    );
    expect(result).toEqual({ ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING });
    expect(admin.rpcCalls).toEqual([
      {
        name: "fn_merge_suppression_incomplete_pointer",
        args: { p_property_id: "property-1", p_ids: ["review-1"], p_hint_id: "review-1" },
      },
    ]);
    expect(admin.inserts[0]).toMatchObject({
      table: "lead_events",
      values: expect.objectContaining({
        event_type: "suppression_incomplete",
        source_type: "ai_disposition_reviews",
        source_id: "review-1",
      }),
    });
  });
});

describe("suppression_incomplete hold vs timeout flags", () => {
  function failingClient(currentReason: string | null, ledgerError: unknown = null) {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));
    createAdminClient.mockReturnValue({
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return { data: [{ reason: null, merged_ids: [], kept_timeout: false, dropped_ids: [] }], error: null };
      },
      from: () => {
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => c;
        c.maybeSingle = async () => ({
          data: { org_id: "org-1", last_ai_escalation_reason: currentReason },
          error: null,
        });
        c.insert = async (v: unknown) => {
          inserts.push(v);
          return { error: ledgerError };
        };
        c.update = (v: unknown) => {
          updates.push(v);
          return c;
        };
        return c;
      },
    } as never);
    return { rpcCalls, inserts, updates };
  }

  for (const reason of ["send_timeout:abc", "dead_letter_failed:send_timeout:abc"]) {
    it(`over ${reason}: records the failed id in the ledger and reports the id only (database keeps the timeout reason)`, async () => {
      const { rpcCalls, inserts, updates } = failingClient(reason);
      await applyConfirmedSuppression({ ...base, disposition: "dnc" });
      expect(updates).toHaveLength(0); // no client-side pointer write at all
      expect(rpcCalls).toEqual([
        {
          name: "fn_merge_suppression_incomplete_pointer",
          args: { p_property_id: "property-1", p_ids: ["review-1"], p_hint_id: "review-1" },
        },
      ]);
      expect(inserts[0]).toMatchObject({
        org_id: "org-1",
        property_id: "property-1",
        event_type: "suppression_incomplete",
        source_type: "ai_disposition_reviews",
        source_id: "review-1",
      });
    });
  }

  it("still reports the id (and no classification) when the ledger write fails, so the database can keep it", async () => {
    const { rpcCalls } = failingClient("send_timeout:abc", { message: "insert failed" });
    await applyConfirmedSuppression({ ...base, disposition: "dnc" });
    expect(rpcCalls[0].args).toEqual({ p_property_id: "property-1", p_ids: ["review-1"], p_hint_id: "review-1" });
  });

  it("treats a duplicate ledger row (unique violation) as recorded", async () => {
    const { rpcCalls } = failingClient("send_timeout:abc", { code: "23505", message: "dup" });
    await applyConfirmedSuppression({ ...base, disposition: "dnc" });
    expect(rpcCalls[0].args).toEqual({ p_property_id: "property-1", p_ids: ["review-1"], p_hint_id: "review-1" });
  });

  for (const reason of [null, "low_confidence"]) {
    it(`over ${reason ?? "null"} the merge reports the id and carries it as the hint`, async () => {
      const { rpcCalls } = failingClient(reason);
      await applyConfirmedSuppression({ ...base, disposition: "dnc" });
      expect(rpcCalls[0].args).toEqual({ p_property_id: "property-1", p_ids: ["review-1"], p_hint_id: "review-1" });
    });
  }
});

describe("listOutstandingSuppressionReviews", () => {
  function ledger(reason: string | null, events: Array<{ event_type: string; source_id: string; created_at: string }>) {
    return {
      from: (table: string) => {
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => c;
        c.in = async () => ({ data: events, error: null });
        c.maybeSingle = async () => ({ data: table === "properties" ? { last_ai_escalation_reason: reason } : null, error: null });
        return c;
      },
    };
  }

  it("returns the reason id plus unresolved failure events, dropping ones with a later retried_ok", async () => {
    const result = await listOutstandingSuppressionReviews(
      ledger("suppression_incomplete:A", [
        { event_type: "suppression_incomplete", source_id: "A", created_at: "2026-01-02" },
        { event_type: "suppression_incomplete", source_id: "B", created_at: "2026-01-01" },
        { event_type: "suppression_retried_ok", source_id: "B", created_at: "2026-01-03" },
        { event_type: "suppression_incomplete", source_id: "C", created_at: "2026-01-04" },
      ]),
      "property-1",
    );
    expect(result.reviewIds.sort()).toEqual(["A", "C"]);
  });

  it("treats an id as resolved when its failure row was backfilled AFTER its retried_ok row", async () => {
    const result = await listOutstandingSuppressionReviews(
      ledger("suppression_incomplete:A", [
        { event_type: "suppression_retried_ok", source_id: "A", created_at: "2026-01-01" },
        { event_type: "suppression_incomplete", source_id: "A", created_at: "2026-01-05" },
      ]),
      "property-1",
    );
    expect(result.reviewIds).toEqual([]);
  });

  it("finds a timeout-preserved failure from its lead event", async () => {
    const result = await listOutstandingSuppressionReviews(
      ledger("send_timeout:x", [{ event_type: "suppression_incomplete", source_id: "A", created_at: "2026-01-01" }]),
      "property-1",
    );
    expect(result.reviewIds).toEqual(["A"]);
  });

  it("throws when the ledger cannot be read", async () => {
    const bad = {
      from: () => {
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => c;
        c.in = async () => ({ data: null, error: { message: "boom" } });
        c.maybeSingle = async () => ({ data: { last_ai_escalation_reason: null }, error: null });
        return c;
      },
    };
    await expect(listOutstandingSuppressionReviews(bad, "property-1")).rejects.toThrow("boom");
  });
});

describe("atomic pointer merge (r24+)", () => {
  type Ev = { event_type: string; source_id: string; created_at: string };
  const TIMEOUT_PREFIXES = ["send_timeout:", "dead_letter_failed:send_timeout:"];
  function statefulAdmin(initialReason: string | null) {
    const state = {
      reason: initialReason,
      attention: false,
      events: [] as Ev[],
      seq: 0,
      dropped: [] as string[][],
    };
    // Holds the first `expected` reads of the property until all have arrived.
    let release!: () => void;
    const barrier = {
      expected: 0,
      arrived: 0,
      release: () => release(),
      gate: new Promise<void>((r) => { release = r; }),
    };
    const failLedgerFor = new Set<string>();
    const rpcFailure = { on: false };
    // Runs right before the database applies a merge (a concurrent writer).
    const beforeRpc = { fn: null as null | (() => void) };
    // Mirrors fn_merge_suppression_incomplete_pointer; synchronous = atomic.
    // Prunable is DB truth: an id needs no pointer slot iff a failed ledger event
    // exists (backed) OR a retried_ok event exists (resolved), in any order.
    const isBacked = (id: string) =>
      state.events.some(
        (e) =>
          e.source_id === id &&
          (e.event_type === "suppression_incomplete" || e.event_type === "suppression_retried_ok"),
      );
    const merge = (ids: string[], hint: string | null) => {
      const isTimeout = !!state.reason && TIMEOUT_PREFIXES.some((p) => state.reason!.startsWith(p));
      state.attention = true;
      const existing = suppressionReviewIdsFromReason(state.reason).filter((i) => !isBacked(i));
      let all = [...new Set([...existing, ...ids.filter((i) => !isBacked(i))])];
      if (isTimeout && all.length === 0) {
        return { reason: state.reason, merged_ids: [], kept_timeout: true, dropped_ids: [] as string[] };
      }
      if (all.length === 0 && hint) all = [hint];
      const merged = all.slice(0, 10);
      const dropped = all.slice(10);
      state.reason = suppressionIncompleteReason(merged);
      return { reason: state.reason, merged_ids: merged, kept_timeout: false, dropped_ids: dropped };
    };
    const rpcCalls: Array<Record<string, unknown>> = [];
    const admin = {
      rpc: async (_name: string, args: { p_ids: string[]; p_hint_id: string | null }) => {
        rpcCalls.push(args);
        await Promise.resolve();
        if (rpcFailure.on) return { data: null, error: { message: "rpc failed" } };
        beforeRpc.fn?.();
        const row = merge(args.p_ids, args.p_hint_id);
        if (row.dropped_ids.length) state.dropped.push(row.dropped_ids);
        return { data: [row], error: null };
      },
      from: (table: string) => {
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => c;
        c.in = async () => ({ data: state.events, error: null });
        c.maybeSingle = async () => {
          const data = table === "properties"
            ? { org_id: "org-1", last_ai_escalation_reason: state.reason }
            : null;
          if (table === "properties" && barrier.expected > 0) {
            barrier.arrived++;
            if (barrier.arrived >= barrier.expected) barrier.release();
            await barrier.gate;
          }
          return { data, error: null };
        };
        c.insert = async (v: { event_type: string; source_id: string }) => {
          if (failLedgerFor.has(`${v.event_type}:${v.source_id}`)) {
            return { error: { message: "insert failed" } };
          }
          if (state.events.some((e) => e.event_type === v.event_type && e.source_id === v.source_id)) {
            return { error: { code: "23505", message: "dup" } };
          }
          state.events.push({ event_type: v.event_type, source_id: v.source_id, created_at: String(++state.seq).padStart(4, "0") });
          return { error: null };
        };
        return c;
      },
    };
    createAdminClient.mockReturnValue(admin as never);
    return { state, failLedgerFor, rpcFailure, beforeRpc, admin, barrier, merge, rpcCalls };
  }
  const fail = () => applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));

  it("A fails + ledger fails -> B fails + ledger ok -> retry B: A stays outstanding, hold not cleared", async () => {
    const { state, failLedgerFor } = statefulAdmin(null);
    fail();
    failLedgerFor.add("suppression_incomplete:A");
    await applyConfirmedSuppression({ ...base, reviewId: "A", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:A");
    expect(state.events).toHaveLength(0);

    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    // A's backfill failed: A stays in the pointer; B is ledger-backed so it
    // takes no slot.
    expect(state.reason).toBe("suppression_incomplete:A");
    expect(state.events.map((e) => e.source_id)).toEqual(["B"]);

    await recordSuppressionRetriedOk({ propertyId: "property-1", reviewId: "B", actorId: "user-1" });
    const out = await listOutstandingSuppressionReviews(createAdminClient() as never, "property-1");
    expect(out.reviewIds).toEqual(["A"]);
  });

  it("backfills a ledger row for A when B fails", async () => {
    const { state } = statefulAdmin("suppression_incomplete:A");
    fail();
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    // Both ledger writes succeed: nothing unbacked, so the hint (B) is the pointer.
    expect(state.reason).toBe("suppression_incomplete:B");
    expect(state.events.map((e) => e.source_id).sort()).toEqual(["A", "B"]);
  });

  it("the A backfill is idempotent (duplicate row counts as recorded)", async () => {
    const { state, rpcCalls } = statefulAdmin("suppression_incomplete:A");
    state.events.push({ event_type: "suppression_incomplete", source_id: "A", created_at: "0000" });
    fail();
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:B");
    expect(rpcCalls[0]).toMatchObject({ p_ids: ["B", "A"], p_hint_id: "B" });
  });

  it("makes exactly one merge call and no client-side pointer write", async () => {
    const { rpcCalls } = statefulAdmin("low_confidence");
    fail();
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(rpcCalls).toHaveLength(1);
  });

  it("reports and leaves the hold as is when the merge call fails", async () => {
    const { state, rpcFailure } = statefulAdmin("low_confidence");
    rpcFailure.on = true;
    fail();
    const r = await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(r).toEqual({ ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING });
    expect(state.reason).toBe("low_confidence");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "rpc failed" }),
      expect.objectContaining({ tags: { surface: "confirm_ai_disposition_suppression_hold" } }),
    );
  });

  it("keeps a send-timeout reason when the id is ledger-backed, and overrides it when it is not", async () => {
    const s1 = statefulAdmin("send_timeout:abc");
    fail();
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(s1.state.reason).toBe("send_timeout:abc");
    expect(s1.state.attention).toBe(true);
    expect(s1.state.events.map((e) => e.source_id)).toEqual(["B"]);

    const s2 = statefulAdmin("send_timeout:abc");
    s2.failLedgerFor.add("suppression_incomplete:B");
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(s2.state.reason).toBe("suppression_incomplete:B");
  });

  it("both ledger writes fail (A then B): the reason carries A and B, retry B leaves A outstanding", async () => {
    const { state, failLedgerFor } = statefulAdmin(null);
    fail();
    failLedgerFor.add("suppression_incomplete:A");
    failLedgerFor.add("suppression_incomplete:B");
    await applyConfirmedSuppression({ ...base, reviewId: "A", disposition: "dnc" });
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:A,B");
    expect(state.events).toHaveLength(0);

    await recordSuppressionRetriedOk({ propertyId: "property-1", reviewId: "B", actorId: "user-1" });
    const out = await listOutstandingSuppressionReviews(createAdminClient() as never, "property-1");
    expect(out.reviewIds).toEqual(["A"]);
  });

  it("three ledger failures accumulate A,B,C without duplicates, even on a repeat failure of B", async () => {
    const { state, failLedgerFor } = statefulAdmin(null);
    fail();
    for (const id of ["A", "B", "C"]) failLedgerFor.add(`suppression_incomplete:${id}`);
    for (const id of ["A", "B", "C", "B"]) {
      await applyConfirmedSuppression({ ...base, reviewId: id, disposition: "dnc" });
    }
    expect(state.reason).toBe("suppression_incomplete:A,B,C");
    const out = await listOutstandingSuppressionReviews(createAdminClient() as never, "property-1");
    expect(out.reviewIds.sort()).toEqual(["A", "B", "C"]);
  });

  it("caps the id list at 10, keeping the oldest, and reports the dropped id", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const { state, failLedgerFor } = statefulAdmin(suppressionIncompleteReason(ids));
    expect(suppressionReviewIdsFromReason(state.reason)).toHaveLength(10);
    fail();
    failLedgerFor.add("suppression_incomplete:new");
    for (const id of ids) failLedgerFor.add(`suppression_incomplete:${id}`);
    await applyConfirmedSuppression({ ...base, reviewId: "new", disposition: "dnc" });
    expect(suppressionReviewIdsFromReason(state.reason)).toEqual(ids);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { surface: "confirm_ai_disposition_suppression_id_cap" },
        extra: { propertyId: "property-1", dropped: ["new"] },
      }),
    );
  });

  it("concurrent failures A and B (both read null, both ledger writes fail): neither id is lost", async () => {
    const { state, failLedgerFor, barrier } = statefulAdmin(null);
    barrier.expected = 2;
    fail();
    failLedgerFor.add("suppression_incomplete:A");
    failLedgerFor.add("suppression_incomplete:B");
    await Promise.all([
      applyConfirmedSuppression({ ...base, reviewId: "A", disposition: "dnc" }),
      applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" }),
    ]);
    expect(state.reason).toBe("suppression_incomplete:A,B");
    expect(state.events).toHaveLength(0);

    await recordSuppressionRetriedOk({ propertyId: "property-1", reviewId: "B", actorId: "user-1" });
    const out = await listOutstandingSuppressionReviews(createAdminClient() as never, "property-1");
    expect(out.reviewIds).toEqual(["A"]);
  });

  it("outstanding is [A, B] before any retry", async () => {
    const { failLedgerFor, barrier } = statefulAdmin(null);
    barrier.expected = 2;
    fail();
    failLedgerFor.add("suppression_incomplete:A");
    failLedgerFor.add("suppression_incomplete:B");
    await Promise.all([
      applyConfirmedSuppression({ ...base, reviewId: "A", disposition: "dnc" }),
      applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" }),
    ]);
    const out = await listOutstandingSuppressionReviews(createAdminClient() as never, "property-1");
    expect(out.reviewIds).toEqual(["A", "B"]);
  });

  it("a failure arriving after B's last read (the old final window) is preserved: C lands, then B merges", async () => {
    const { state, failLedgerFor, beforeRpc, merge } = statefulAdmin(null);
    fail();
    failLedgerFor.add("suppression_incomplete:B");
    failLedgerFor.add("suppression_incomplete:C");
    // C's failure reaches the database after B read the pointer (null) and
    // before B's merge runs.
    beforeRpc.fn = () => {
      beforeRpc.fn = null;
      merge(["C"], null);
    };
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:C,B");
    expect(state.attention).toBe(true);
  });

  it("ten ledger-backed failures then one unbacked: the unbacked id survives and no cap alarm fires", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const { state, failLedgerFor } = statefulAdmin(suppressionIncompleteReason(ids));
    fail();
    failLedgerFor.add("suppression_incomplete:new");
    await applyConfirmedSuppression({ ...base, reviewId: "new", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:new");
    expect(state.events.map((e) => e.source_id).sort()).toEqual([...ids].sort());
    expect(reportError).not.toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "confirm_ai_disposition_suppression_id_cap" } }),
    );
  });

  it("reports every known id (new + existing) without classifying; the database keeps only the ledger-less one", async () => {
    const { rpcCalls, failLedgerFor, state } = statefulAdmin("suppression_incomplete:A,B");
    fail();
    failLedgerFor.add("suppression_incomplete:B");
    await applyConfirmedSuppression({ ...base, reviewId: "C", disposition: "dnc" });
    expect(rpcCalls[0]).toEqual({ p_property_id: "property-1", p_ids: ["C", "A", "B"], p_hint_id: "C" });
    expect(state.reason).toBe("suppression_incomplete:B");
  });

  it("ten durable ledger-backed ids on the pointer; new id's ledger insert AND every backfill fail: the new id survives", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const { state, failLedgerFor } = statefulAdmin(suppressionIncompleteReason(ids));
    ids.forEach((id, i) =>
      state.events.push({ event_type: "suppression_incomplete", source_id: id, created_at: `000${i}` }),
    );
    fail();
    failLedgerFor.add("suppression_incomplete:new");
    for (const id of ids) failLedgerFor.add(`suppression_incomplete:${id}`);
    await applyConfirmedSuppression({ ...base, reviewId: "new", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:new");
    expect(reportError).not.toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "confirm_ai_disposition_suppression_id_cap" } }),
    );
  });

  it("outstanding set parses every id in a multi-id reason", async () => {
    const { admin } = statefulAdmin("suppression_incomplete:A,B,C");
    const out = await listOutstandingSuppressionReviews(admin as never, "property-1");
    expect(out.reviewIds.sort()).toEqual(["A", "B", "C"]);
  });
});

describe("durable obligation discharge (round 14)", () => {
  function dischargeAdmin(opts: { ledgerRow: boolean; insertCode?: string; clearError?: boolean }) {
    const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
    const rpcs: Array<{ name: string; args: unknown }> = [];
    const chain = (table: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => ({
        data: table === "lead_events" ? (opts.ledgerRow ? { id: "ev-1" } : null) : { org_id: "org-1" },
        error: null,
      });
      c.insert = async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return { error: opts.insertCode ? { code: opts.insertCode, message: "dup" } : null };
      };
      return c;
    };
    return {
      inserts,
      rpcs,
      client: {
        from: chain,
        rpc: async (name: string, args: unknown) => {
          rpcs.push({ name, args });
          return { error: opts.clearError ? { message: "boom" } : null };
        },
      },
    };
  }

  it("with a ledger row: writes retried_ok then asks the database to clear", async () => {
    const a = dischargeAdmin({ ledgerRow: true });
    createAdminClient.mockReturnValue(a.client as never);
    await dischargeSuppressionObligation({ propertyId: "property-1", reviewId: "review-1", actorId: "user-1" });
    expect(a.inserts).toHaveLength(1);
    expect(a.inserts[0].values).toMatchObject({
      event_type: "suppression_retried_ok",
      source_id: "review-1",
      actor_type: "user",
    });
    expect(a.rpcs).toEqual([{ name: "fn_clear_suppression_hold_if_resolved", args: { p_property_id: "property-1" } }]);
  });

  it("without a ledger row writes nothing (a confirm that never needed phone suppression)", async () => {
    const a = dischargeAdmin({ ledgerRow: false });
    createAdminClient.mockReturnValue(a.client as never);
    await dischargeSuppressionObligation({ propertyId: "property-1", reviewId: "review-1", actorId: "user-1" });
    expect(a.inserts).toHaveLength(0);
    expect(a.rpcs).toHaveLength(0);
  });

  it("a duplicate retried_ok (concurrent retry) is not an error and the clear still runs", async () => {
    const a = dischargeAdmin({ ledgerRow: true, insertCode: "23505" });
    createAdminClient.mockReturnValue(a.client as never);
    await dischargeSuppressionObligation({ propertyId: "property-1", reviewId: "review-1", actorId: null });
    expect(reportError).not.toHaveBeenCalled();
    expect(a.rpcs).toHaveLength(1);
  });

  it("a failing clear is reported, never thrown", async () => {
    const a = dischargeAdmin({ ledgerRow: true, clearError: true });
    createAdminClient.mockReturnValue(a.client as never);
    await expect(
      dischargeSuppressionObligation({ propertyId: "property-1", reviewId: "review-1", actorId: "u" }),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalled();
  });

  it("applySuppressionForConfirmedReview discharges only on success and only when asked", async () => {
    const a = dischargeAdmin({ ledgerRow: true });
    createAdminClient.mockReturnValue(a.client as never);
    await applySuppressionForConfirmedReview(lookupClient("opted_out"), "review-1", "user-1");
    expect(a.inserts).toHaveLength(0);
    await applySuppressionForConfirmedReview(lookupClient("opted_out"), "review-1", "user-1", { discharge: true });
    expect(a.inserts).toHaveLength(1);

    const b = dischargeAdmin({ ledgerRow: true });
    createAdminClient.mockReturnValue(b.client as never);
    applyPhoneLevelOptOut.mockRejectedValueOnce(new Error("down"));
    const r = await applySuppressionForConfirmedReview(lookupClient("opted_out"), "review-1", "user-1", {
      discharge: true,
    });
    expect(r.ok).toBe(false);
    expect(b.inserts.filter((i) => (i.values as { event_type?: string }).event_type === "suppression_retried_ok")).toHaveLength(0);
    createAdminClient.mockReturnValue({ admin: true } as never);
  });

  function sweepFixture(attemptReply: { attempt_count: number; should_report: boolean }) {
    const a = dischargeAdmin({ ledgerRow: true });
    createAdminClient.mockReturnValue(a.client as never);
    const lookup = lookupClient("opted_out");
    const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
    const sweepClient = {
      from: lookup.from,
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcs.push({ name, args });
        if (name === "fn_list_outstanding_suppression_obligations")
          return {
            data: [
              { review_id: "review-1", property_id: "property-1", org_id: "org-1", reviewed_by: "u1" },
              { review_id: "review-2", property_id: "property-1", org_id: "org-1", reviewed_by: "u2" },
            ],
            error: null,
          };
        if (name === "fn_record_suppression_attempt_failure") return { data: [attemptReply], error: null };
        if (name === "fn_list_resolvable_suppression_holds") return { data: [{ property_id: "property-9" }], error: null };
        if (name === "fn_clear_suppression_hold_if_resolved") return { data: [{ cleared: true, outstanding_ids: [] }], error: null };
        return lookup.rpc(name, args);
      },
    };
    return { a, sweepClient, rpcs };
  }

  it("sweep step: retries each as the system actor; a failure is counted in the DB and left outstanding", async () => {
    const { a, sweepClient, rpcs } = sweepFixture({ attempt_count: 1, should_report: false });
    applyPhoneLevelOptOut.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("down"));
    const out = await retryOutstandingSuppressionObligations(sweepClient as never, { limit: 5 });
    expect(out).toEqual({ attempted: 2, succeeded: 1, failed: 1, holdsCleared: 1 });
    // Never the original reviewer: system actor on retried_ok, OPTED_OUT lead event and audit detail.
    expect(a.inserts.some((i) => i.values.event_type === "suppression_retried_ok" && i.values.actor_type === "system")).toBe(true);
    expect(a.inserts.some((i) => i.values.actor_id === "u1")).toBe(false);
    for (const call of recordLeadEvent.mock.calls) {
      expect(call[0].actorType).toBe("system");
      expect(call[0].actorId).toBeUndefined();
    }
    expect(applyPhoneLevelOptOut.mock.calls[0][1].sourceDetail).toMatchObject({ confirmedBy: null });
    // Attempt recorded once, for the failed row only; resolved holds re-cleared.
    expect(rpcs.filter((r) => r.name === "fn_record_suppression_attempt_failure")).toEqual([
      { name: "fn_record_suppression_attempt_failure", args: { p_review_id: "review-2", p_property_id: "property-1", p_org_id: "org-1" } },
    ]);
    expect(rpcs.find((r) => r.name === "fn_clear_suppression_hold_if_resolved")?.args).toEqual({ p_property_id: "property-9" });
    // Throttled: below the report threshold nothing is reported for the failure.
    expect(reportError).not.toHaveBeenCalled();
    createAdminClient.mockReturnValue({ admin: true } as never);
  });

  it("sweep step reports a permanently failing row only when the DB says so (3rd attempt on, once per day)", async () => {
    const { sweepClient } = sweepFixture({ attempt_count: 3, should_report: true });
    applyPhoneLevelOptOut.mockRejectedValue(new Error("down"));
    await retryOutstandingSuppressionObligations(sweepClient as never, { limit: 5 });
    const permanent = reportError.mock.calls.filter((c) => c[1]?.tags?.surface === "suppression_obligation_permanent_failure");
    expect(permanent).toHaveLength(2);
    expect(permanent[0][1].extra).toMatchObject({ attempts: 3 });
    reportError.mockClear();
    const quiet = sweepFixture({ attempt_count: 4, should_report: false });
    await retryOutstandingSuppressionObligations(quiet.sweepClient as never, { limit: 5 });
    expect(reportError).not.toHaveBeenCalled();
    createAdminClient.mockReturnValue({ admin: true } as never);
  });

  it("sweep step never throws when listing fails", async () => {
    const out = await retryOutstandingSuppressionObligations({
      from: () => ({}),
      rpc: async () => ({ data: null, error: { message: "nope" } }),
    } as never);
    expect(out).toEqual({ attempted: 0, succeeded: 0, failed: 0, holdsCleared: 0 });
    expect(reportError).toHaveBeenCalled();
  });

  it("hold-clear failures for many properties produce one aggregated report", async () => {
    const supabase = {
      from: () => ({}),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "fn_list_outstanding_suppression_obligations") return { data: [], error: null };
        if (name === "fn_list_resolvable_suppression_holds")
          return { data: [{ property_id: "p1" }, { property_id: "p2" }, { property_id: "p3" }], error: null };
        if (name === "fn_clear_suppression_hold_if_resolved")
          return args.p_property_id === "p3"
            ? { data: [{ cleared: true, outstanding_ids: [] }], error: null }
            : { data: null, error: { message: `boom ${args.p_property_id}` } };
        return { data: null, error: null };
      },
    };
    reportError.mockClear();
    const out = await retryOutstandingSuppressionObligations(supabase as never, { limit: 5 });
    expect(out.holdsCleared).toBe(1);
    const calls = reportError.mock.calls.filter((c) => c[1]?.tags?.surface === "suppression_hold_resolved_clear");
    expect(calls).toHaveLength(1);
    expect(calls[0][0].message).toBe("boom p1");
    expect(calls[0][1].extra).toEqual({ failedCount: 2, firstPropertyId: "p1" });
  });
});
