import { beforeEach, describe, expect, it, vi } from "vitest";

const { pauseContactEnrollments, recordConsentEvent, recordLeadEvent } =
  vi.hoisted(() => ({
    pauseContactEnrollments: vi.fn(),
    recordConsentEvent: vi.fn(),
    recordLeadEvent: vi.fn(),
  }));

vi.mock("@/lib/messaging/consent", () => ({ recordConsentEvent }));
vi.mock("@/lib/sequences/enrollment", () => ({ pauseContactEnrollments }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { OPTED_OUT: "opted_out" },
  recordLeadEvent,
}));

import { applyPhoneLevelOptOut } from "./opt-out-phone";

function makeClient(propertyMatches = true) {
  return {
    from: vi.fn((table: string) => {
      if (table === "sms_phone_suppressions") {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      if (table === "properties") {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          maybeSingle: vi.fn().mockResolvedValue({
            data: propertyMatches ? { id: "property-1" } : null,
            error: null,
          }),
        };
        return query;
      }

      let selected = "";
      let updated = false;
      let phoneColumn: string | null = null;
      const query = {
        select: vi.fn((columns: string) => {
          selected = columns;
          return query;
        }),
        update: vi.fn(() => {
          updated = true;
          return query;
        }),
        eq: vi.fn((column: string) => {
          if (column.startsWith("phone_")) phoneColumn = column;
          return query;
        }),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { do_not_contact: false, sms_opted_out: false },
          error: null,
        }),
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?:
            | ((value: {
                data?: Array<{ id: string }>;
                error: null;
              }) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          const value = updated
            ? { error: null }
            : {
                data:
                  selected === "id" && phoneColumn === "phone_1"
                    ? [{ id: "contact-1" }]
                    : [],
                error: null,
              };
          return Promise.resolve(value).then(onfulfilled, onrejected);
        },
      };
      return query;
    }),
  };
}

const input = {
  contactId: "contact-1",
  fromPhone: "+18165550001",
  orgId: "org-1",
  source: "mock_inbound_webhook",
  sourceDetail: { externalId: "message-1" },
  occurredAt: new Date("2026-08-25T18:00:00.000Z"),
  providerId: "mock",
  surface: "stop" as const,
  idempotencyKey: "message-1",
  leadEvent: {
    propertyId: "property-1",
    actorType: "system" as const,
    trigger: "inbound_keyword" as const,
  },
};
const CONSENT_EVENT_ID = "33333333-3333-4333-8333-333333333333";

describe("applyPhoneLevelOptOut lead event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordConsentEvent.mockResolvedValue({
      inserted: true,
      id: CONSENT_EVENT_ID,
    });
  });

  it("records one bounded event for the newly inserted primary-contact consent", async () => {
    await applyPhoneLevelOptOut(makeClient() as never, input);

    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      eventType: "opted_out",
      actorType: "system",
      payload: { channel: "sms", trigger: "inbound_keyword" },
      sourceType: "consent_events.opt_out",
      sourceId: CONSENT_EVENT_ID,
    });
  });

  it("does not fabricate a replay event when consent already existed", async () => {
    recordConsentEvent.mockResolvedValue({
      inserted: false,
      id: CONSENT_EVENT_ID,
    });

    await applyPhoneLevelOptOut(makeClient() as never, input);

    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not attach the consent to a mismatched property", async () => {
    await applyPhoneLevelOptOut(makeClient(false) as never, input);

    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});
