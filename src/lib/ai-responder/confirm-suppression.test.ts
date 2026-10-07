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
    properties: { homeowner_contact_id: "contact-1" },
    contacts: { phone_1: "+18165550100" },
    messages: { from_address: "+18165550100" },
    ...overrides,
  };
  const updates: Array<{ table: string; values: unknown }> = [];
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.update = (values: unknown) => {
      updates.push({ table, values });
      return c;
    };
    c.maybeSingle = async () => ({ data: rows[table], error: null });
    c.then = (resolve: (v: unknown) => void) => resolve({ error: null });
    return c;
  };
  return { from: chain, updates };
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
        last_ai_escalation_reason: "suppression_incomplete",
      }),
    );
  });
});
