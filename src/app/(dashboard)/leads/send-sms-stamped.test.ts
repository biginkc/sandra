import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  memberships: vi.fn(),
  dispatchRepSms: vi.fn(),
  readRepSmsContext: vi.fn(),
  sendSmsToContact: vi.fn(),
  stampRow: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMemberships: mocks.memberships,
  getCallerMembershipsOrThrow: mocks.memberships,
}));
vi.mock("@/lib/dnc/property-lock", () => ({
  assertPropertyDncUnlocked: vi.fn(async () => ({ ok: true, data: null })),
  DNC_LOCKED_MESSAGE: "locked",
  partitionPropertyDncLocks: vi.fn(),
}));
vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/messaging/rep-sms", () => ({
  dispatchRepSms: mocks.dispatchRepSms,
  readRepSmsContext: mocks.readRepSmsContext,
}));
vi.mock("@/lib/messaging/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/messaging/send")>("@/lib/messaging/send");
  return { ...actual, sendSmsToContact: mocks.sendSmsToContact };
});

import { sendSmsFromLead } from "./actions";
import { sendSmsFromLeadStamped } from "./send-sms-stamped";

const INBOUND = "33333333-3333-4333-8333-333333333333";

function client(stamp: Record<string, unknown> | null) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            table === "properties"
              ? Promise.resolve({ data: { id: "prop-1", org_id: "org-1", homeowner_contact_id: "contact-1" }, error: null })
              : Promise.resolve({ data: stamp, error: null }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sendSmsToContact.mockResolvedValue({ status: "sent", messageId: "m1", externalId: "e1" });
  mocks.dispatchRepSms.mockResolvedValue({ status: "sent", messageId: "m1", externalId: "e1" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("sendSmsFromLeadStamped inbound reply stamp (non-rep branch)", () => {
  beforeEach(() => {
    mocks.memberships.mockResolvedValue([{ org_id: "org-1", role: "admin", acquisitions_enabled: false }]);
  });

  it("stamps metadata.inbound_message_id for a valid inbound id", async () => {
    mocks.createClient.mockResolvedValue(client({ direction: "inbound", org_id: "org-1", property_id: "prop-1", conversation_id: null }));
    await sendSmsFromLeadStamped("prop-1", "hi", null, false, "+18165550123", INBOUND);
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata).toEqual({ inbound_message_id: INBOUND });
  });

  it("drops a cross-property id and still sends", async () => {
    mocks.createClient.mockResolvedValue(client({ direction: "inbound", org_id: "org-1", property_id: "prop-9", conversation_id: null }));
    const result = await sendSmsFromLeadStamped("prop-1", "hi", null, false, "+18165550123", INBOUND);
    expect(result.ok).toBe(true);
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata).toEqual({ inbound_stamp_unresolved: true });
  });

  it("sends exactly today's input when no id is given", async () => {
    mocks.createClient.mockResolvedValue(client(null));
    await sendSmsFromLeadStamped("prop-1", "hi", null, false, "+18165550123");
    expect(mocks.sendSmsToContact.mock.calls[0][1]).toEqual({
      origin: "manual",
      contactId: "contact-1",
      propertyId: "prop-1",
      body: "hi",
      from: undefined,
      to: "+18165550123",
      queueOnly: false,
      requireStickyFrom: true,
    });
  });
});

describe("sendSmsFromLeadStamped inbound reply stamp (rep branch)", () => {
  it("passes the id to dispatchRepSms, and omits it when absent", async () => {
    mocks.memberships.mockResolvedValue([{ org_id: "org-1", role: "member", acquisitions_enabled: true }]);
    mocks.readRepSmsContext.mockResolvedValue({ senders: [{ id: "sender-1", number: "+18163706846", isDefault: true }] });
    await sendSmsFromLeadStamped("prop-1", "hi", null, false, "+18165550123", INBOUND);
    expect(mocks.dispatchRepSms).toHaveBeenLastCalledWith(expect.objectContaining({ inboundMessageId: INBOUND }));
    await sendSmsFromLeadStamped("prop-1", "hi", null, false, "+18165550123");
    expect(mocks.dispatchRepSms.mock.calls[1][0].inboundMessageId).toBeUndefined();
  });
});

describe("legacy sendSmsFromLead is unchanged", () => {
  it("never reads or stamps an inbound id (6th argument ignored)", async () => {
    mocks.memberships.mockResolvedValue([{ org_id: "org-1", role: "admin", acquisitions_enabled: false }]);
    mocks.createClient.mockResolvedValue(client({ direction: "inbound", org_id: "org-1", property_id: "prop-1", conversation_id: null }));
    await (sendSmsFromLead as unknown as (...a: unknown[]) => Promise<unknown>)("prop-1", "hi", null, false, "+18165550123", INBOUND);
    expect(mocks.sendSmsToContact.mock.calls[0][1]).not.toHaveProperty("metadata");
  });
});
