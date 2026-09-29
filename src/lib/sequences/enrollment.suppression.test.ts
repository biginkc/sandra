import { beforeEach, expect, it, vi } from "vitest";

const assertNotTrainingTarget = vi.hoisted(() => vi.fn());
const getConsentState = vi.hoisted(() => vi.fn());
const selectBestSmsPhone = vi.hoisted(() => vi.fn());
const recordLeadEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget }));
vi.mock("@/lib/messaging/consent", () => ({ getConsentState }));
vi.mock("@/lib/messaging/sms-phone", () => ({ selectBestSmsPhone }));
vi.mock("@/lib/events", () => ({ LEAD_EVENT_TYPES: { SEQUENCE_ENROLLED: "sequence_enrolled" }, recordLeadEvent, recordLeadEvents: vi.fn() }));

import { enrollLead } from "./enrollment";

beforeEach(() => {
  vi.clearAllMocks();
  getConsentState.mockResolvedValue("can_send_marketing");
  selectBestSmsPhone.mockReturnValue({ phone: "+18165550001", lineType: "mobile" });
});

function clientFor(property: Record<string, unknown>) {
  const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: "enrollment-1" }, error: null }) }) }));
  const rows: Record<string, unknown> = {
    sequences: { id: "sequence-1", org_id: "org-1", name: "Drip", active: true, archived_at: null },
    sequence_steps: { id: "step-1", delay_after_previous_minutes: 0 },
    properties: {
      id: "property-1", org_id: "org-1", homeowner_contact_id: "contact-1",
      outreach_dispo: null, is_dnc_locked: false,
      homeowner: { id: "contact-1", phone_1: "+18165550001", phone_1_type: "mobile", phone_2: null, phone_2_type: null, phone_3: null, phone_3_type: null, do_not_contact: false, sms_opted_out: false },
      ...property,
    },
  };
  const client = { from: vi.fn((table: string) => {
    const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: rows[table], error: null }), insert };
    return builder;
  }) };
  return { client, insert };
}

it.each([
  ["dnc disposition", { outreach_dispo: "dnc" }],
  ["wrong number", { outreach_dispo: "wrong_number" }],
  ["locked DNC", { is_dnc_locked: true }],
  ["contact DNC", { homeowner: { id: "contact-1", do_not_contact: true, sms_opted_out: false } }],
  ["SMS opt-out", { homeowner: { id: "contact-1", do_not_contact: false, sms_opted_out: true } }],
  ["missing contact row", { homeowner: null }],
])("refuses enrollment for %s", async (_, property) => {
  const { client, insert } = clientFor(property);
  const outcome = await enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1" });
  expect(outcome.status).toBe("suppressed");
  expect(insert).not.toHaveBeenCalled();
});

it.each([
  ["nurture", "Nurture"],
  ["callback_requested", "Callback requested"],
  ["booked_appointment", "Booked appointment"],
])("refuses enrollment for human-owned %s", async (dispo, label) => {
  const { client, insert } = clientFor({ outreach_dispo: dispo });
  const outcome = await enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1" });
  expect(outcome).toEqual({
    status: "suppressed",
    message: `A rep is handling this lead personally (${label}). Change the outcome to start a drip.`,
  });
  expect(insert).not.toHaveBeenCalled();
});

it.each([
  ["dead", "Dead"],
  ["closed", "Closed"],
  ["offer_sent", "Offer sent"],
  ["under_contract", "Under contract"],
])("refuses enrollment for %s property status", async (status, label) => {
  const { client, insert } = clientFor({ status });
  expect(await enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1" }))
    .toEqual({ status: "suppressed", message: `This lead is marked ${label}, so a drip can't start.` });
  expect(insert).not.toHaveBeenCalled();
});

it("refuses a landline before inserting", async () => {
  selectBestSmsPhone.mockReturnValueOnce({ phone: "+18165550001", lineType: "landline" });
  const { client, insert } = clientFor({});
  expect((await enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1" })).status).toBe("landline_phone");
  expect(insert).not.toHaveBeenCalled();
});

it("refuses a consent event opt-out before inserting", async () => {
  getConsentState.mockResolvedValueOnce("opted_out");
  const { client, insert } = clientFor({});
  expect((await enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1" })).status).toBe("no_consent");
  expect(insert).not.toHaveBeenCalled();
});

it("reports enrollment as active when activity logging fails after insertion", async () => {
  recordLeadEvent.mockRejectedValueOnce(new Error("activity log unavailable"));
  const { client, insert } = clientFor({});
  expect((await enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1" })).status).toBe("enrolled");
  expect(insert).toHaveBeenCalledOnce();
});

it("creates an active enrollment after not_interested", async () => {
  const { client, insert } = clientFor({ outreach_dispo: "not_interested" });
  expect(await enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1" }))
    .toMatchObject({ status: "enrolled", enrollmentId: "enrollment-1" });
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({
    property_id: "property-1", sequence_id: "sequence-1", status: "active",
  }));
});
