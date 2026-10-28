import { beforeEach, expect, it, vi } from "vitest";

const assertNotTrainingTarget = vi.hoisted(() => vi.fn());
const getConsentState = vi.hoisted(() => vi.fn());
const recordLeadEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget }));
vi.mock("@/lib/messaging/consent", () => ({ getConsentState }));
vi.mock("@/lib/events", () => ({ LEAD_EVENT_TYPES: { SEQUENCE_ENROLLED: "sequence_enrolled" }, recordLeadEvent, recordLeadEvents: vi.fn() }));

import { enrollLead } from "./enrollment";

beforeEach(() => {
  vi.clearAllMocks();
  getConsentState.mockResolvedValue("can_send_marketing");
});

const REPLIER = {
  id: "contact-replier", org_id: "org-1",
  phone_1: "+18165550001", phone_1_type: "mobile", phone_2: null, phone_2_type: null, phone_3: null, phone_3_type: null,
  do_not_contact: false, sms_opted_out: false,
};

/** Imported lead: no saved homeowner, people linked through property_contacts only. */
function clientFor(opts: {
  homeownerContactId?: string | null;
  homeowner?: Record<string, unknown> | null;
  link?: { contact_id: string } | null;
  contact?: Record<string, unknown> | null;
}) {
  const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: "enrollment-1" }, error: null }) }) }));
  const filters: Record<string, Array<[string, unknown]>> = {};
  const rows: Record<string, unknown> = {
    sequences: { id: "sequence-1", org_id: "org-1", name: "Drip", active: true, archived_at: null },
    sequence_steps: { id: "step-1", delay_after_previous_minutes: 0 },
    properties: {
      id: "property-1", org_id: "org-1", homeowner_contact_id: opts.homeownerContactId ?? null,
      outreach_dispo: "needs_sequence", status: "new", is_dnc_locked: false,
      homeowner: opts.homeowner ?? null,
    },
    sequence_enrollments: null,
    property_contacts: opts.link === undefined ? { contact_id: REPLIER.id } : opts.link,
    contacts: opts.contact === undefined ? REPLIER : opts.contact,
  };
  const client = { from: vi.fn((table: string) => {
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { (filters[table] ??= []).push([column, value]); return builder; },
      in: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: rows[table], error: null }),
      insert,
    };
    return builder;
  }) };
  return { client, insert, filters };
}

const enroll = (client: unknown, contactId?: string) =>
  enrollLead(client as never, { sequenceId: "sequence-1", propertyId: "property-1", ...(contactId ? { contactId } : {}) });

it("enrolls the linked replier as the drip recipient when the lead has no homeowner", async () => {
  const { client, insert, filters } = clientFor({});
  expect(await enroll(client, REPLIER.id)).toMatchObject({ status: "enrolled", enrollmentId: "enrollment-1" });
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: REPLIER.id, property_id: "property-1" }));
  // Consent is checked on the same row that receives the texts.
  expect(getConsentState).toHaveBeenCalledWith(client, REPLIER.id, "sms");
  expect(filters.property_contacts).toEqual(expect.arrayContaining([
    ["org_id", "org-1"], ["property_id", "property-1"], ["contact_id", REPLIER.id],
  ]));
  expect(filters.contacts).toEqual(expect.arrayContaining([["id", REPLIER.id], ["org_id", "org-1"]]));
});

it("refuses a contact that is not linked to the property", async () => {
  const { client, insert } = clientFor({ link: null });
  expect((await enroll(client, "contact-stranger")).status).toBe("no_phone");
  expect(insert).not.toHaveBeenCalled();
  expect(getConsentState).not.toHaveBeenCalled();
});

it("refuses a linked contact row from another org", async () => {
  const { client, insert } = clientFor({ contact: { ...REPLIER, org_id: "org-2" } });
  expect((await enroll(client, REPLIER.id)).status).toBe("no_phone");
  expect(insert).not.toHaveBeenCalled();
});

it.each([
  ["texts opted out", { sms_opted_out: true }],
  ["do not contact", { do_not_contact: true }],
])("refuses a linked contact marked %s", async (_, flags) => {
  const { client, insert } = clientFor({ contact: { ...REPLIER, ...flags } });
  expect((await enroll(client, REPLIER.id)).status).toBe("suppressed");
  expect(insert).not.toHaveBeenCalled();
});

it("refuses a linked contact whose consent record is opted out", async () => {
  getConsentState.mockResolvedValueOnce("opted_out");
  const { client, insert } = clientFor({});
  expect((await enroll(client, REPLIER.id)).status).toBe("no_consent");
  expect(getConsentState).toHaveBeenCalledWith(client, REPLIER.id, "sms");
  expect(insert).not.toHaveBeenCalled();
});

it("refuses a linked contact with only a landline", async () => {
  const { client, insert } = clientFor({ contact: { ...REPLIER, phone_1_type: "landline" } });
  expect((await enroll(client, REPLIER.id)).status).toBe("landline_phone");
  expect(insert).not.toHaveBeenCalled();
});

it("still refuses no_phone without an explicit contact (manual start drip never picks a linked person)", async () => {
  const { client, insert } = clientFor({});
  expect((await enroll(client)).status).toBe("no_phone");
  expect(insert).not.toHaveBeenCalled();
  expect(client.from).not.toHaveBeenCalledWith("property_contacts");
});

it("ignores the explicit contact when the lead has a saved homeowner", async () => {
  const homeowner = { ...REPLIER, id: "contact-homeowner" };
  const { client, insert } = clientFor({ homeownerContactId: "contact-homeowner", homeowner });
  expect((await enroll(client, REPLIER.id)).status).toBe("enrolled");
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "contact-homeowner" }));
  expect(client.from).not.toHaveBeenCalledWith("property_contacts");
});
