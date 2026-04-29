import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { createLead } from "./create";

const supabase = createTestClient();

describe("createLead (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("creates property + homeowner contact with status='new_lead' and source set", async () => {
    const result = await createLead(supabase, {
      source: "cold_call",
      property: {
        address: "1 Cold Call Ln",
        city: "Kansas City",
        state: "MO",
        zip: "64111",
      },
      contact: {
        first_name: "Jane",
        last_name: "Doe",
        phone_1: "+18165551001",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.wasDuplicate).toBe(false);
    expect(result.data.contactId).not.toBeNull();

    const { data: prop } = await supabase
      .from("properties")
      .select("status, source, homeowner_contact_id, address_normalized")
      .eq("id", result.data.propertyId)
      .single();
    expect(prop!.status).toBe("new_lead");
    expect(prop!.source).toBe("cold_call");
    expect(prop!.homeowner_contact_id).toBe(result.data.contactId);
    expect(prop!.address_normalized).toBeTruthy();

    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, phone_1")
      .eq("id", result.data.contactId!)
      .single();
    expect(contact!.first_name).toBe("Jane");
    expect(contact!.phone_1).toBe("+18165551001");
  });

  it("dedups property by normalized address — second call returns existing id with wasDuplicate=true", async () => {
    const first = await createLead(supabase, {
      source: "cold_call",
      property: { address: "2 Dedup St", state: "MO" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await createLead(supabase, {
      source: "web_form",
      property: { address: "2 Dedup St", state: "MO" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.propertyId).toBe(first.data.propertyId);
    expect(second.data.wasDuplicate).toBe(true);
  });

  it("dedups contact by phone_1", async () => {
    const a = await createLead(supabase, {
      source: "cold_call",
      property: { address: "3 Phone Dedup A Ln", state: "MO" },
      contact: { phone_1: "+18165551002" },
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await createLead(supabase, {
      source: "cold_call",
      property: { address: "4 Phone Dedup B Ln", state: "MO" },
      contact: { phone_1: "+18165551002" },
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    expect(b.data.contactId).toBe(a.data.contactId);
  });

  it("attaches contact to existing property only if it has none yet", async () => {
    // First call: no contact, just the address
    const first = await createLead(supabase, {
      source: "cold_call",
      property: { address: "5 Attach Ln", state: "MO" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const { data: propBefore } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", first.data.propertyId)
      .single();
    expect(propBefore!.homeowner_contact_id).toBeNull();

    // Second call: same address, with contact — should attach
    const second = await createLead(supabase, {
      source: "cold_call",
      property: { address: "5 Attach Ln", state: "MO" },
      contact: { phone_1: "+18165551005", first_name: "Hi", last_name: "There" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const { data: propAfter } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", first.data.propertyId)
      .single();
    expect(propAfter!.homeowner_contact_id).toBe(second.data.contactId);
  });

  it("rejects with VALIDATION when address is missing", async () => {
    const result = await createLead(supabase, {
      source: "cold_call",
      property: { address: "", state: "MO" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.field).toBe("property.address");
  });

  it("rejects with VALIDATION when source is not in the canonical list", async () => {
    const result = await createLead(supabase, {
      // @ts-expect-error — deliberately invalid source
      source: "manual_entry",
      property: { address: "6 Bad Source Ln", state: "MO" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.field).toBe("source");
  });

  it("accepts a property with no contact info — homeowner_contact_id stays null", async () => {
    const result = await createLead(supabase, {
      source: "driving_for_dollars",
      property: { address: "7 No Contact Ln", state: "MO" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.contactId).toBeNull();
    const { data: prop } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", result.data.propertyId)
      .single();
    expect(prop!.homeowner_contact_id).toBeNull();
  });
});
