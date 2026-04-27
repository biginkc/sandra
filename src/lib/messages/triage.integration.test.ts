import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import {
  matchUnknownSender,
  dismissUnknownSender,
  restoreDismissedSender,
  createContactFromUnknown,
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
      phone_2: opts.phone2 ?? null,
      phone_3: opts.phone3 ?? null,
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

  // Test case #44 + #45
  it("creates a contact + property and attaches all messages from the same from_address", async () => {
    const phone = "+18165559020";
    const msgIds = [
      await seedUnknown({ fromAddress: phone, body: "first body" }),
      await seedUnknown({ fromAddress: phone, body: "second body" }),
    ];

    const result = await createContactFromUnknown({
      supabase,
      fromAddress: phone,
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
      .select("first_name, last_name, phone_1")
      .eq("id", result.data.contactId)
      .single();
    expect(c).toMatchObject({
      first_name: "New",
      last_name: "Lead",
      phone_1: phone,
    });

    // Property was created and the contact is its homeowner.
    const { data: p } = await supabase
      .from("properties")
      .select("address, homeowner_contact_id, status")
      .eq("id", result.data.propertyId)
      .single();
    expect(p).toMatchObject({
      address: "123 New Lead Ln",
      homeowner_contact_id: result.data.contactId,
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
