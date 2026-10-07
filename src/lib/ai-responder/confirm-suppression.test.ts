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
  listOutstandingSuppressionReviews,
  recordSuppressionRetriedOk,
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
    c.then = (resolve: (v: unknown) => void) => resolve({ error: null });
    return c;
  };
  return { from: chain, updates, inserts };
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
    const hold = admin.updates.find((u) => u.table === "properties");
    expect(hold?.values).toEqual(
      expect.objectContaining({
        needs_human_attention: true,
        last_ai_escalation_reason: "suppression_incomplete:review-1",
      }),
    );
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
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));
    createAdminClient.mockReturnValue({
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
          return { eq: async () => ({ error: null }) };
        };
        return c;
      },
    } as never);
    return { updates, inserts };
  }

  for (const reason of ["send_timeout:abc", "dead_letter_failed:send_timeout:abc"]) {
    it(`keeps existing ${reason} reason, raises the hold, and records the failed review id as a lead event`, async () => {
      const { updates, inserts } = failingClient(reason);
      await applyConfirmedSuppression({ ...base, disposition: "dnc" });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ needs_human_attention: true });
      expect(updates[0]).not.toHaveProperty("last_ai_escalation_reason");
      expect(inserts[0]).toMatchObject({
        org_id: "org-1",
        property_id: "property-1",
        event_type: "suppression_incomplete",
        source_type: "ai_disposition_reviews",
        source_id: "review-1",
      });
    });
  }

  it("falls back to the suppression reason when the ledger write fails, so the id is never lost", async () => {
    const { updates } = failingClient("send_timeout:abc", { message: "insert failed" });
    await applyConfirmedSuppression({ ...base, disposition: "dnc" });
    expect(updates[0]).toMatchObject({ last_ai_escalation_reason: "suppression_incomplete:review-1" });
  });

  it("treats a duplicate ledger row (unique violation) as recorded", async () => {
    const { updates } = failingClient("send_timeout:abc", { code: "23505", message: "dup" });
    await applyConfirmedSuppression({ ...base, disposition: "dnc" });
    expect(updates[0]).not.toHaveProperty("last_ai_escalation_reason");
  });

  for (const reason of [null, "low_confidence"]) {
    it(`sets suppression_incomplete:<reviewId> over ${reason ?? "null"}`, async () => {
      const { updates } = failingClient(reason);
      await applyConfirmedSuppression({ ...base, disposition: "dnc" });
      expect(updates[0]).toMatchObject({
        needs_human_attention: true,
        last_ai_escalation_reason: "suppression_incomplete:review-1",
      });
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

describe("overwriting an existing suppression_incomplete reason (r24)", () => {
  type Ev = { event_type: string; source_id: string; created_at: string };
  function statefulAdmin(initialReason: string | null) {
    const state = { reason: initialReason, events: [] as Ev[], seq: 0 };
    const failLedgerFor = new Set<string>();
    const failUpdate = { on: false };
    const admin = {
      from: (table: string) => {
        let pendingUpdate: Record<string, unknown> | null = null;
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => (pendingUpdate ? Promise.resolve(applyUpdate()) : c);
        const applyUpdate = () => {
          if (failUpdate.on) return { error: { message: "update failed" } };
          if (pendingUpdate && "last_ai_escalation_reason" in pendingUpdate) {
            state.reason = pendingUpdate.last_ai_escalation_reason as string | null;
          }
          return { error: null };
        };
        c.in = async () => ({ data: state.events, error: null });
        c.maybeSingle = async () => ({
          data: table === "properties"
            ? { org_id: "org-1", last_ai_escalation_reason: state.reason }
            : null,
          error: null,
        });
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
        c.update = (v: Record<string, unknown>) => {
          pendingUpdate = v;
          return c;
        };
        return c;
      },
    };
    createAdminClient.mockReturnValue(admin as never);
    return { state, failLedgerFor, failUpdate, admin };
  }

  it("A fails + ledger fails -> B fails + ledger ok -> retry B: A stays outstanding, hold not cleared", async () => {
    const { state, failLedgerFor } = statefulAdmin(null);
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));
    failLedgerFor.add("suppression_incomplete:A");
    await applyConfirmedSuppression({ ...base, reviewId: "A", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:A");
    expect(state.events).toHaveLength(0);

    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    // A's backfill failed: the existing reason must NOT be overwritten.
    expect(state.reason).toBe("suppression_incomplete:A");
    expect(state.events.map((e) => e.source_id)).toEqual(["B"]);

    await recordSuppressionRetriedOk({ propertyId: "property-1", reviewId: "B", actorId: "user-1" });
    const out = await listOutstandingSuppressionReviews(createAdminClient() as never, "property-1");
    expect(out.reviewIds).toEqual(["A"]);
  });

  it("backfills a ledger row for A before overwriting its reason with B", async () => {
    const { state } = statefulAdmin("suppression_incomplete:A");
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:B");
    expect(state.events.map((e) => e.source_id).sort()).toEqual(["A", "B"]);
  });

  it("the A backfill is idempotent (duplicate row counts as recorded)", async () => {
    const { state } = statefulAdmin("suppression_incomplete:A");
    state.events.push({ event_type: "suppression_incomplete", source_id: "A", created_at: "0000" });
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));
    await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(state.reason).toBe("suppression_incomplete:B");
  });

  it("reports and leaves the hold as is when the hold update fails", async () => {
    const { state, failUpdate } = statefulAdmin("low_confidence");
    failUpdate.on = true;
    applyPhoneLevelOptOut.mockRejectedValue(new Error("db down"));
    const r = await applyConfirmedSuppression({ ...base, reviewId: "B", disposition: "dnc" });
    expect(r).toEqual({ ok: false, warning: SUPPRESSION_INCOMPLETE_WARNING });
    expect(state.reason).toBe("low_confidence");
  });
});
