import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  pauseContactEnrollments,
  qualifyProperty,
  recordConsentEvent,
  revalidatePath,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  pauseContactEnrollments: vi.fn(),
  qualifyProperty: vi.fn(),
  recordConsentEvent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/leads/qualify", () => ({ qualifyProperty }));
vi.mock("@/lib/messaging/consent", () => ({ recordConsentEvent }));
vi.mock("@/lib/sequences/enrollment", () => ({ pauseContactEnrollments }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { moveMessageThreadToLead, setOutreachDispo } from "./dispo-actions";

type Response = { data?: unknown; error?: { message: string } | null };

let responseQueue: Response[] = [];
let updatePayloads: Array<{ table: string; payload: unknown }> = [];

beforeEach(() => {
  responseQueue = [];
  updatePayloads = [];
  createClient.mockResolvedValue(makeSupabase("actor-1"));
  qualifyProperty.mockResolvedValue({ status: "qualified" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("setOutreachDispo", () => {
  it("writes only message outcomes and clears follow_up_at", async () => {
    responseQueue = [{ data: property(), error: null }, { error: null }];

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
    expect(pauseContactEnrollments).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
    expect(revalidatePath).toHaveBeenCalledWith("/properties");
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

  it("keeps DNC and opt-out safety side effects", async () => {
    responseQueue = [
      { data: property(), error: null },
      { error: null },
      { error: null },
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
    });
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
    from: vi.fn((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        update: vi.fn((payload: unknown) => {
          updatePayloads.push({ table, payload });
          return builder;
        }),
        eq: vi.fn(() => builder),
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

function property() {
  return {
    id: "property-1",
    homeowner_contact_id: "contact-1",
  };
}
