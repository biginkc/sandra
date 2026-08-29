import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  pauseContactEnrollments,
  qualifyProperty,
  recordLeadEvent,
  recordConsentEvent,
  reportError,
  revalidatePath,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  pauseContactEnrollments: vi.fn(),
  qualifyProperty: vi.fn(),
  recordLeadEvent: vi.fn(),
  recordConsentEvent: vi.fn(),
  reportError: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/leads/qualify", () => ({ qualifyProperty }));
vi.mock("@/lib/errors/report", () => ({ reportError }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { DISPO_SET: "dispo_set", OPTED_OUT: "opted_out" },
  recordLeadEvent,
}));
vi.mock("@/lib/messaging/consent", () => ({ recordConsentEvent }));
vi.mock("@/lib/sequences/enrollment", () => ({ pauseContactEnrollments }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));

import {
  confirmAiDispositionReview,
  moveMessageThreadToLead,
  setOutreachDispo,
} from "./dispo-actions";

type Response = { data?: unknown; error?: { message: string } | null };

let responseQueue: Response[] = [];
let updatePayloads: Array<{ table: string; payload: unknown }> = [];
const CONSENT_EVENT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  responseQueue = [];
  updatePayloads = [];
  createClient.mockResolvedValue(makeSupabase("actor-1"));
  qualifyProperty.mockResolvedValue({ status: "qualified" });
  recordConsentEvent.mockResolvedValue({
    inserted: true,
    id: CONSENT_EVENT_ID,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("confirmAiDispositionReview", () => {
  it("confirms through the authenticated RPC and refreshes Messages", async () => {
    responseQueue = [{ data: { status: "confirmed", reviewId: "review-1" } }];

    const result = await confirmAiDispositionReview("review-1");

    expect(result).toEqual({ ok: true, status: "confirmed" });
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
  });

  it("reports a stale review as superseded without pretending it was confirmed", async () => {
    responseQueue = [{ data: { status: "superseded", reviewId: "review-1" } }];

    const result = await confirmAiDispositionReview("review-1");

    expect(result).toEqual({ ok: true, status: "superseded" });
  });

  it("does not claim confirmation failed when cache revalidation throws after commit", async () => {
    responseQueue = [{ data: { status: "confirmed", reviewId: "review-1" } }];
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate failed");
    });

    const result = await confirmAiDispositionReview("review-1");

    expect(result).toEqual({ ok: true, status: "confirmed" });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "revalidate failed" }),
      expect.objectContaining({
        tags: { surface: "confirm_ai_disposition_review_revalidate" },
      }),
    );
  });
});

describe("setOutreachDispo", () => {
  it("writes only message outcomes and clears follow_up_at", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: { id: "property-1" }, error: null },
    ];

    const result = await setOutreachDispo("property-1", "not_interested");

    expect(result).toEqual({ ok: true });
    expect(updatePayloads).toContainEqual({
      table: "properties",
      payload: expect.objectContaining({
        outreach_dispo: "not_interested",
        follow_up_at: null,
      }),
    });
    expect(recordConsentEvent).not.toHaveBeenCalled();
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      eventType: "dispo_set",
      actorType: "user",
      actorId: "actor-1",
      payload: { from: null, to: "not_interested" },
    });
    expect(pauseContactEnrollments).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/properties");
  });

  it("accepts needs_sequence as a tag-only disposition", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: { id: "property-1" }, error: null },
    ];

    const result = await setOutreachDispo("property-1", "needs_sequence");

    expect(result).toEqual({ ok: true });
    expect(updatePayloads).toContainEqual({
      table: "properties",
      payload: expect.objectContaining({
        outreach_dispo: "needs_sequence",
        follow_up_at: null,
      }),
    });
    expect(recordConsentEvent).not.toHaveBeenCalled();
    expect(pauseContactEnrollments).not.toHaveBeenCalled();
  });

  it("rejects legacy task dispositions from the manual Messages action", async () => {
    const result = await setOutreachDispo(
      "property-1",
      "callback_requested" as never,
    );

    expect(result).toEqual({
      ok: false,
      error: "Unknown dispo: callback_requested",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("does not record a disposition event for a same-state write", async () => {
    responseQueue = [
      { data: property("not_interested"), error: null },
      { data: { id: "property-1" }, error: null },
    ];

    const result = await setOutreachDispo("property-1", "not_interested");

    expect(result).toEqual({ ok: true });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not record an event when the compare-and-swap loses a race", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: null, error: null },
    ];

    const result = await setOutreachDispo("property-1", "not_interested");

    expect(result).toEqual({
      ok: false,
      error: "Disposition changed in another session. Refresh and try again.",
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not claim failure when cache revalidation throws after commit", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: { id: "property-1" }, error: null },
    ];
    revalidatePath.mockImplementationOnce(() => {
      throw new Error("revalidate failed");
    });

    const result = await setOutreachDispo("property-1", "not_interested");

    expect(result).toEqual({ ok: true });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "revalidate failed" }),
      expect.objectContaining({
        tags: { surface: "manual_dispo_revalidate_after_commit" },
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/properties");
  });

  it("does not claim the correction failed when the post-commit activity event fails", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: { id: "property-1" }, error: null },
    ];
    recordLeadEvent.mockRejectedValueOnce(new Error("event append failed"));

    const result = await setOutreachDispo("property-1", "not_interested");

    expect(result).toEqual({ ok: true });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "event append failed" }),
      expect.objectContaining({
        tags: { surface: "manual_dispo_event_after_commit" },
      }),
    );
  });

  it("keeps DNC and opt-out safety side effects", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: { id: "property-1" }, error: null },
      {
        data: { do_not_contact: false, sms_opted_out: false },
        error: null,
      },
      { data: { id: "contact-1" }, error: null },
    ];

    const result = await setOutreachDispo("property-1", "opted_out");

    expect(result).toEqual({ ok: true });
    expect(recordConsentEvent).toHaveBeenCalledWith(expect.anything(), {
      contactId: "contact-1",
      channel: "sms",
      eventType: "opt_out",
      source: "manual_dispo",
      sourceDetail: { propertyId: "property-1", dispo: "opted_out" },
      occurredAt: expect.any(Date),
    });
    expect(recordLeadEvent).toHaveBeenCalledTimes(2);
    expect(recordLeadEvent.mock.calls).toEqual([
      [{
        propertyId: "property-1",
        eventType: "dispo_set",
        actorType: "user",
        actorId: "actor-1",
        payload: { from: null, to: "opted_out" },
      }],
      [{
        propertyId: "property-1",
        eventType: "opted_out",
        actorType: "user",
        actorId: "actor-1",
        payload: { channel: "sms", trigger: "manual_disposition" },
        sourceType: "consent_events.opt_out",
        sourceId: CONSENT_EVENT_ID,
      }],
    ]);
    expect(updatePayloads).toContainEqual({
      table: "contacts",
      payload: expect.objectContaining({
        sms_opted_out: true,
        sms_opted_out_at: expect.any(String),
      }),
    });
    expect(pauseContactEnrollments).toHaveBeenCalledWith(expect.anything(), {
      contactId: "contact-1",
      reason: "consent_revoked",
      permanent: true,
      actor: { actorType: "user", actorId: "actor-1" },
    });
  });

  it("lets only the contact compare-and-swap winner append opt-out history", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: { id: "property-1" }, error: null },
      {
        data: { do_not_contact: false, sms_opted_out: false },
        error: null,
      },
      { data: null, error: null },
    ];

    const result = await setOutreachDispo("property-1", "opted_out");

    expect(result).toEqual({ ok: true });
    expect(recordConsentEvent).not.toHaveBeenCalled();
    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
    expect(recordLeadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "dispo_set" }),
    );
  });

  it("reports a post-commit contact failure without claiming the disposition failed", async () => {
    responseQueue = [
      { data: property(), error: null },
      { data: { id: "property-1" }, error: null },
      { data: null, error: { message: "contact read failed" } },
    ];

    const result = await setOutreachDispo("property-1", "opted_out");

    expect(result).toEqual({ ok: true });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "contact read failed" }),
      expect.objectContaining({
        tags: { surface: "manual_dispo_contact_read_after_commit" },
      }),
    );
    expect(recordConsentEvent).not.toHaveBeenCalled();
    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
  });
});

describe("moveMessageThreadToLead", () => {
  it("qualifies a property without writing outreach_dispo", async () => {
    const result = await moveMessageThreadToLead("property-1");

    expect(result).toEqual({ ok: true, alreadyQualified: false });
    expect(qualifyProperty).toHaveBeenCalledWith(
      expect.anything(),
      "property-1",
      "actor-1",
    );
    expect(updatePayloads).toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
    expect(revalidatePath).toHaveBeenCalledWith("/leads/property-1");
  });

  it("treats already-qualified properties as a successful Open Lead path", async () => {
    qualifyProperty.mockResolvedValueOnce({ status: "already_qualified" });

    const result = await moveMessageThreadToLead("property-1");

    expect(result).toEqual({ ok: true, alreadyQualified: true });
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/leads/property-1");
  });
});

function makeSupabase(userId: string) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: userId } },
      })),
    },
    rpc: vi.fn(async () => {
      const response = responseQueue.shift();
      return { data: response?.data ?? null, error: response?.error ?? null };
    }),
    from: vi.fn((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        update: vi.fn((payload: unknown) => {
          updatePayloads.push({ table, payload });
          return builder;
        }),
        eq: vi.fn(() => builder),
        is: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => {
          const response = responseQueue.shift();
          return { data: response?.data ?? null, error: response?.error ?? null };
        }),
        then: (
          onFulfilled: (value: { error: { message: string } | null }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          const response = responseQueue.shift();
          return Promise.resolve({
            error: response?.error ?? null,
          }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    }),
  };
}

function property(outreachDispo: string | null = null) {
  return {
    id: "property-1",
    homeowner_contact_id: "contact-1",
    outreach_dispo: outreachDispo,
  };
}
