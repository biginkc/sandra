import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uses the REAL applyPhoneLevelOptOut / recordSmsPhoneSuppression (not mocked):
 * a phone that cannot be normalized must never count as proof of suppression.
 */
const h = vi.hoisted(() => ({
  upserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  reportError: vi.fn(),
  phone: null as string | null,
}));

vi.mock("@/lib/errors/report", () => ({ reportError: h.reportError }));
vi.mock("@/lib/events", () => ({ LEAD_EVENT_TYPES: { OPTED_OUT: "opted_out" }, recordLeadEvent: async () => undefined }));
vi.mock("@/lib/messaging/consent", () => ({ recordConsentEvent: async () => ({ inserted: true, id: "consent-1" }) }));
vi.mock("@/lib/sequences/enrollment", () => ({ pauseContactEnrollments: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient() }));

import { applySuppressionForConfirmedReview } from "./confirm-suppression";

function fakeClient() {
  const single: Record<string, unknown> = {
    ai_disposition_reviews: {
      property_id: "property-1",
      org_id: "org-1",
      disposition: "opted_out",
      ai_reason: "said stop",
      source_inbound_message_id: null,
    },
    properties: { homeowner_contact_id: "contact-1", org_id: "org-1" },
    contacts: { phone_1: h.phone, do_not_contact: false, sms_opted_out: false },
    lead_events: { id: "ledger-1" },
  };
  const from = (table: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.update = () => c;
    c.upsert = async (values: Record<string, unknown>) => {
      h.upserts.push({ table, values });
      return { error: null };
    };
    c.insert = async (values: Record<string, unknown>) => {
      h.inserts.push({ table, values });
      return { error: null };
    };
    c.maybeSingle = async () => ({ data: single[table], error: null });
    c.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    return c;
  };
  const rpc = async () => ({ data: [{ reason: "x", merged_ids: [], kept_timeout: false, dropped_ids: [] }], error: null });
  return { from, rpc };
}

const setPhone = (p: string | null) => {
  h.phone = p;
};

beforeEach(() => {
  h.upserts.length = 0;
  h.inserts.length = 0;
  h.reportError.mockClear();
});

const retriedOk = () => h.inserts.filter((i) => i.values.event_type === "suppression_retried_ok");

describe("confirmed suppression through the real phone-level opt-out", () => {
  it("valid phone: writes the suppression row, returns ok and records retried_ok", async () => {
    setPhone("(816) 555-0100");
    const r = await applySuppressionForConfirmedReview(fakeClient(), "review-1", "user-1", { discharge: true });
    expect(r).toEqual({ ok: true });
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].table).toBe("sms_phone_suppressions");
    expect(h.upserts[0].values).toMatchObject({ org_id: "org-1", phone_e164: "+18165550100" });
    expect(retriedOk()).toHaveLength(1);
  });

  it.each(["garbage", "12345", ""])("un-normalizable phone %j: failure, no suppression row, NO retried_ok", async (phone) => {
    setPhone(phone);
    const r = await applySuppressionForConfirmedReview(fakeClient(), "review-1", "user-1", { discharge: true });
    expect(r.ok).toBe(false);
    expect(h.upserts).toHaveLength(0);
    expect(retriedOk()).toHaveLength(0);
  });
});
