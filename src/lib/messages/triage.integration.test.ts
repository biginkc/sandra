import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import {
  matchUnknownSender,
  dismissUnknownSender,
  restoreDismissedSender,
  createContactFromUnknown,
  mergeUnknownSenderToProperty,
} from "@/lib/messages/triage";

const supabase = createTestClient();

async function seedUnknown(opts: {
  fromAddress: string;
  body: string;
  dismissed?: boolean;
}): Promise<string> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: null,
      property_id: null,
      from_address: opts.fromAddress,
      to_address: "+18162804181",
      body: opts.body,
      dismissed_at: opts.dismissed ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

async function seedContact(opts: {
  firstName: string;
  phone1?: string;
  phone2?: string;
  phone3?: string;
}): Promise<string> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      first_name: opts.firstName,
      last_name: "Test",
      phone_1: opts.phone1 ?? null,
      phone_1_type: opts.phone1 ? "mobile" : "unknown",
      phone_2: opts.phone2 ?? null,
      phone_2_type: opts.phone2 ? "mobile" : "unknown",
      phone_3: opts.phone3 ?? null,
      phone_3_type: opts.phone3 ? "mobile" : "unknown",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

describe("matchUnknownSender (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  // Test case #40 + #41
  it("sets contact_id on the message and adds from_address to phone_2 when phone_2 is empty", async () => {
    const phone = "+18165559001";
    const msgId = await seedUnknown({ fromAddress: phone, body: "hi" });
    const contactId = await seedContact({
      firstName: "Existing",
      phone1: "+18165559999",
    });

    const result = await matchUnknownSender({
      supabase,
      fromAddress: phone,
      contactId,
    });
    expect(result.ok).toBe(true);

    const { data: msg } = await supabase
      .from("messages")
      .select("contact_id")
      .eq("id", msgId)
      .single();
    expect(msg!.contact_id).toBe(contactId);

    const { data: c } = await supabase
      .from("contacts")
      .select("phone_1, phone_2, phone_3")
      .eq("id", contactId)
      .single();
    expect(c!.phone_2).toBe(phone);
  });

  // Test case #41 (variant: phone_2 occupied → goes to phone_3)
  it("falls through to phone_3 when phone_2 is already populated", async () => {
    const phone = "+18165559002";
    await seedUnknown({ fromAddress: phone, body: "hi" });
    const contactId = await seedContact({
      firstName: "TwoPhones",
      phone1: "+18165559101",
      phone2: "+18165559102",
    });

    await matchUnknownSender({ supabase, fromAddress: phone, contactId });

    const { data: c } = await supabase
      .from("contacts")
      .select("phone_3")
      .eq("id", contactId)
      .single();
    expect(c!.phone_3).toBe(phone);
  });

  // Test case #42 — backfill siblings
  it("backfills all unmatched messages from the same from_address", async () => {
    const phone = "+18165559003";
    const ids = [
      await seedUnknown({ fromAddress: phone, body: "msg 1" }),
      await seedUnknown({ fromAddress: phone, body: "msg 2" }),
      await seedUnknown({ fromAddress: phone, body: "msg 3" }),
    ];
    const otherId = await seedUnknown({
      fromAddress: "+18165559004",
      body: "different sender",
    });
    const contactId = await seedContact({
      firstName: "Backfill",
      phone1: "+18165559199",
    });

    await matchUnknownSender({ supabase, fromAddress: phone, contactId });

    const { data: matched } = await supabase
      .from("messages")
      .select("id, contact_id")
      .in("id", ids);
    for (const m of matched!) {
      expect(m.contact_id).toBe(contactId);
    }

    // Different sender stays untouched.
    const { data: untouched } = await supabase
      .from("messages")
      .select("contact_id")
      .eq("id", otherId)
      .single();
    expect(untouched!.contact_id).toBeNull();
  });

  // Test case #43 — no-op if from_address already exists in phone_1/2/3
  it("does not duplicate the phone if it already exists in any contact phone slot", async () => {
    const phone = "+18165559005";
    await seedUnknown({ fromAddress: phone, body: "hi" });
    const contactId = await seedContact({
      firstName: "AlreadyHas",
      phone1: phone,
    });

    await matchUnknownSender({ supabase, fromAddress: phone, contactId });

    const { data: c } = await supabase
      .from("contacts")
      .select("phone_1, phone_2, phone_3")
      .eq("id", contactId)
      .single();
    expect(c!.phone_1).toBe(phone);
    expect(c!.phone_2).toBeNull();
    expect(c!.phone_3).toBeNull();
  });

  it("returns an error when contact has all three phone slots full and incoming phone is new", async () => {
    const phone = "+18165559006";
    await seedUnknown({ fromAddress: phone, body: "hi" });
    const contactId = await seedContact({
      firstName: "FullSlots",
      phone1: "+18165559201",
      phone2: "+18165559202",
      phone3: "+18165559203",
    });

    const result = await matchUnknownSender({
      supabase,
      fromAddress: phone,
      contactId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PHONE_SLOTS_FULL");
    }
  });
});

describe("createContactFromUnknown (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  // Test case #5 (Phase 2.5)
  it("with role=homeowner: creates contact, homeowner_details row, sets homeowner_contact_id, attaches messages", async () => {
    const phone = "+18165559020";
    const msgIds = [
      await seedUnknown({ fromAddress: phone, body: "first body" }),
      await seedUnknown({ fromAddress: phone, body: "second body" }),
    ];

    const result = await createContactFromUnknown({
      supabase,
      fromAddress: phone,
      role: "homeowner",
      contact: {
        firstName: "New",
        lastName: "Lead",
      },
      property: {
        address: "123 New Lead Ln",
        city: "Kansas City",
        state: "MO",
        zip: "64151",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Contact was created with the phone in phone_1.
    const { data: c } = await supabase
      .from("contacts")
      .select("first_name, last_name, phone_1, contact_type")
      .eq("id", result.data.contactId)
      .single();
    expect(c).toMatchObject({
      first_name: "New",
      last_name: "Lead",
      phone_1: phone,
      contact_type: "person", // role is separate; type stays defaulted
    });

    // homeowner_details row exists for this contact.
    const { data: detail } = await supabase
      .from("homeowner_details")
      .select("contact_id")
      .eq("contact_id", result.data.contactId)
      .maybeSingle();
    expect(detail?.contact_id).toBe(result.data.contactId);

    // Property has homeowner_contact_id set, NOT agent_contact_id.
    const { data: p } = await supabase
      .from("properties")
      .select("address, homeowner_contact_id, agent_contact_id, status")
      .eq("id", result.data.propertyId)
      .single();
    expect(p).toMatchObject({
      address: "123 New Lead Ln",
      homeowner_contact_id: result.data.contactId,
      agent_contact_id: null,
      status: "new_lead",
    });

    // All messages from that from_address now point to the contact + property.
    const { data: msgs } = await supabase
      .from("messages")
      .select("contact_id, property_id")
      .in("id", msgIds);
    for (const m of msgs!) {
      expect(m.contact_id).toBe(result.data.contactId);
      expect(m.property_id).toBe(result.data.propertyId);
    }
  });

  // Test case #6 (Phase 2.5)
  it("with role=agent: creates contact, agent_details row, sets agent_contact_id (NOT homeowner_contact_id)", async () => {
    const phone = "+18165559021";
    await seedUnknown({ fromAddress: phone, body: "agent inbound" });

    const result = await createContactFromUnknown({
      supabase,
      fromAddress: phone,
      role: "agent",
      contact: {
        firstName: "Agent",
        lastName: "Mc Agentface",
      },
      property: {
        address: "456 Agent Ave",
        state: "MO",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // agent_details row exists, homeowner_details does NOT.
    const { data: agentDetail } = await supabase
      .from("agent_details")
      .select("contact_id")
      .eq("contact_id", result.data.contactId)
      .maybeSingle();
    expect(agentDetail?.contact_id).toBe(result.data.contactId);

    const { data: homeownerDetail } = await supabase
      .from("homeowner_details")
      .select("contact_id")
      .eq("contact_id", result.data.contactId)
      .maybeSingle();
    expect(homeownerDetail).toBeNull();

    // Property has agent_contact_id set, NOT homeowner_contact_id.
    const { data: p } = await supabase
      .from("properties")
      .select("homeowner_contact_id, agent_contact_id")
      .eq("id", result.data.propertyId)
      .single();
    expect(p).toMatchObject({
      homeowner_contact_id: null,
      agent_contact_id: result.data.contactId,
    });
  });
});

// ============================================================================
// Phase 2.5 — mergeUnknownSenderToProperty
// ============================================================================
describe("mergeUnknownSenderToProperty (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  async function seedProperty(opts: {
    addressTag: string;
    homeownerContactId?: string | null;
    agentContactId?: string | null;
  }): Promise<string> {
    const { data, error } = await supabase
      .from("properties")
      .insert({
        address: `${Math.floor(Math.random() * 9000) + 1000} ${opts.addressTag} Ln`,
        state: "MO",
        homeowner_contact_id: opts.homeownerContactId ?? null,
        agent_contact_id: opts.agentContactId ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data!.id;
  }

  // Test case #1
  it("with role=homeowner: attaches messages, creates contact + homeowner_details, sets property.homeowner_contact_id", async () => {
    const phone = "+18165560001";
    const msgIds = [
      await seedUnknown({ fromAddress: phone, body: "merge to property 1" }),
      await seedUnknown({ fromAddress: phone, body: "merge to property 2" }),
    ];
    const propertyId = await seedProperty({ addressTag: "MERGE-HO" });

    const result = await mergeUnknownSenderToProperty({
      supabase,
      fromAddress: phone,
      propertyId,
      role: "homeowner",
      contact: { firstName: "Merged", lastName: "Owner" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: detail } = await supabase
      .from("homeowner_details")
      .select("contact_id")
      .eq("contact_id", result.data.contactId)
      .maybeSingle();
    expect(detail?.contact_id).toBe(result.data.contactId);

    const { data: p } = await supabase
      .from("properties")
      .select("homeowner_contact_id, agent_contact_id")
      .eq("id", propertyId)
      .single();
    expect(p).toMatchObject({
      homeowner_contact_id: result.data.contactId,
      agent_contact_id: null,
    });

    const { data: msgs } = await supabase
      .from("messages")
      .select("contact_id, property_id")
      .in("id", msgIds);
    for (const m of msgs!) {
      expect(m.contact_id).toBe(result.data.contactId);
      expect(m.property_id).toBe(propertyId);
    }
  });

  // Test case #2
  it("with role=agent: creates agent_details, sets property.agent_contact_id", async () => {
    const phone = "+18165560002";
    await seedUnknown({ fromAddress: phone, body: "agent merge" });
    const propertyId = await seedProperty({ addressTag: "MERGE-AG" });

    const result = await mergeUnknownSenderToProperty({
      supabase,
      fromAddress: phone,
      propertyId,
      role: "agent",
      contact: { firstName: "Listing", lastName: "Agent" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: agentDetail } = await supabase
      .from("agent_details")
      .select("contact_id")
      .eq("contact_id", result.data.contactId)
      .maybeSingle();
    expect(agentDetail?.contact_id).toBe(result.data.contactId);

    const { data: p } = await supabase
      .from("properties")
      .select("homeowner_contact_id, agent_contact_id")
      .eq("id", propertyId)
      .single();
    expect(p).toMatchObject({
      homeowner_contact_id: null,
      agent_contact_id: result.data.contactId,
    });
  });

  // Test case #3 — backfill siblings
  it("attaches every message from same from_address (backfill)", async () => {
    const phone = "+18165560003";
    const msgIds = [
      await seedUnknown({ fromAddress: phone, body: "msg 1" }),
      await seedUnknown({ fromAddress: phone, body: "msg 2" }),
      await seedUnknown({ fromAddress: phone, body: "msg 3" }),
    ];
    const otherMsg = await seedUnknown({
      fromAddress: "+18165560004",
      body: "different sender",
    });
    const propertyId = await seedProperty({ addressTag: "MERGE-BACKFILL" });

    const result = await mergeUnknownSenderToProperty({
      supabase,
      fromAddress: phone,
      propertyId,
      role: "homeowner",
      contact: { firstName: "BF", lastName: "Test" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: matched } = await supabase
      .from("messages")
      .select("contact_id, property_id")
      .in("id", msgIds);
    for (const m of matched!) {
      expect(m.contact_id).toBe(result.data.contactId);
      expect(m.property_id).toBe(propertyId);
    }

    const { data: other } = await supabase
      .from("messages")
      .select("contact_id, property_id")
      .eq("id", otherMsg)
      .single();
    expect(other?.contact_id).toBeNull();
    expect(other?.property_id).toBeNull();
  });

  // Test case #4 — role taken
  it("errors PROPERTY_ROLE_TAKEN if the property already has a contact in that role", async () => {
    const phone = "+18165560005";
    await seedUnknown({ fromAddress: phone, body: "blocked merge" });

    // Pre-existing homeowner on the property.
    const { data: existing } = await supabase
      .from("contacts")
      .insert({
        first_name: "Existing",
        last_name: "Homeowner",
        phone_1: "+18165560099",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    const propertyId = await seedProperty({
      addressTag: "MERGE-TAKEN",
      homeownerContactId: existing!.id,
    });

    const result = await mergeUnknownSenderToProperty({
      supabase,
      fromAddress: phone,
      propertyId,
      role: "homeowner",
      contact: { firstName: "New", lastName: "Tries" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROPERTY_ROLE_TAKEN");
    }

    // No new contact was created (no orphans).
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("phone_1", phone);
    expect(contacts).toEqual([]);
  });
});

describe("dismissUnknownSender / restoreDismissedSender (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  // Test case #46
  it("dismiss sets dismissed_at on every message from that from_address", async () => {
    const phone = "+18165559030";
    const ids = [
      await seedUnknown({ fromAddress: phone, body: "1" }),
      await seedUnknown({ fromAddress: phone, body: "2" }),
    ];
    const otherId = await seedUnknown({
      fromAddress: "+18165559031",
      body: "different",
    });

    const result = await dismissUnknownSender({ supabase, fromAddress: phone });
    expect(result.ok).toBe(true);

    const { data: dismissed } = await supabase
      .from("messages")
      .select("dismissed_at")
      .in("id", ids);
    for (const m of dismissed!) {
      expect(m.dismissed_at).not.toBeNull();
    }

    const { data: untouched } = await supabase
      .from("messages")
      .select("dismissed_at")
      .eq("id", otherId)
      .single();
    expect(untouched!.dismissed_at).toBeNull();
  });

  // Test case #47
  it("restore clears dismissed_at on every message from that from_address", async () => {
    const phone = "+18165559040";
    const ids = [
      await seedUnknown({ fromAddress: phone, body: "1", dismissed: true }),
      await seedUnknown({ fromAddress: phone, body: "2", dismissed: true }),
    ];

    const result = await restoreDismissedSender({
      supabase,
      fromAddress: phone,
    });
    expect(result.ok).toBe(true);

    const { data: restored } = await supabase
      .from("messages")
      .select("dismissed_at")
      .in("id", ids);
    for (const m of restored!) {
      expect(m.dismissed_at).toBeNull();
    }
  });
});
