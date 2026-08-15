import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { createLead } from "./create";

const supabase = createTestClient();

// createLead classifies the lead's phone via Telnyx at intake (hard
// rule: untyped phones are never saved). Stub the Telnyx endpoint so
// these tests keep covering the phone-saved happy path; everything
// else passes through to the real test DB.
const realFetch = globalThis.fetch;

function withOneInjectedFailure(
  target: "contact_insert" | "homeowner_attach",
) {
  let armed = true;
  return {
    from(table: string) {
      const realBuilder = supabase.from(
        table as Parameters<typeof supabase.from>[0],
      );
      return new Proxy(realBuilder, {
        get(builder, property, receiver) {
          if (
            armed &&
            target === "contact_insert" &&
            table === "contacts" &&
            property === "insert"
          ) {
            return () => {
              armed = false;
              const failed = {
                select: () => failed,
                single: async () => ({
                  data: null,
                  error: { code: "INJECTED", message: "injected contact failure" },
                }),
              };
              return failed;
            };
          }
          if (
            armed &&
            target === "homeowner_attach" &&
            table === "properties" &&
            property === "update"
          ) {
            return (values: Record<string, unknown>) => {
              if ("homeowner_contact_id" in values) {
                armed = false;
                const failed = {
                  eq: () => failed,
                  is: () => failed,
                  select: () => failed,
                  maybeSingle: async () => ({
                    data: null,
                    error: { code: "INJECTED", message: "injected attach failure" },
                  }),
                };
                return failed;
              }
              const realUpdate = Reflect.get(builder, property, receiver) as (
                values: Record<string, unknown>,
              ) => unknown;
              return realUpdate.call(builder, values);
            };
          }
          const value = Reflect.get(builder, property, receiver);
          return typeof value === "function" ? value.bind(builder) : value;
        },
      });
    },
  } as unknown as typeof supabase;
}

describe("createLead (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    vi.stubEnv("TELNYX_API_KEY", "test-key");
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.telnyx.com/v2/number_lookup")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { carrier: { type: "mobile" } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
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

  it("returns a duplicate before creating a contact when the existing property has no homeowner", async () => {
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

    // Second call: same address, with contact — duplicate is explicit and
    // the submitted contact must not be created or attached.
    const second = await createLead(supabase, {
      source: "cold_call",
      property: { address: "5 Attach Ln", state: "MO" },
      contact: { phone_1: "+18165551005", first_name: "Hi", last_name: "There" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.wasDuplicate).toBe(true);
    expect(second.data.contactId).toBeNull();

    const { data: propAfter } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", first.data.propertyId)
      .single();
    expect(propAfter!.homeowner_contact_id).toBeNull();
    const { count } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("preserves an existing homeowner and creates no contact on duplicate address", async () => {
    const first = await createLead(supabase, {
      source: "cold_call",
      property: { address: "5 Existing Owner Ln", state: "MO" },
      contact: { phone_1: "+18165551006", first_name: "Existing" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await createLead(supabase, {
      source: "referral",
      property: { address: "5 Existing Owner Ln", state: "MO" },
      contact: { phone_1: "+18165551007", first_name: "Submitted" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.wasDuplicate).toBe(true);
    expect(second.data.contactId).toBeNull();

    const { data: property } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", first.data.propertyId)
      .single();
    expect(property?.homeowner_contact_id).toBe(first.data.contactId);
    const { count } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(1);
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

  it("dedups against phone_2/phone_3 — secondary-slot numbers reuse the contact, no paid lookup, no duplicate", async () => {
    const { data: existing } = await supabase
      .from("contacts")
      .insert({
        first_name: "Secondary",
        last_name: "Slot",
        phone_1: "+18165553100",
        phone_1_type: "mobile",
        phone_2: "+18165553101",
        phone_2_type: "mobile",
      })
      .select("id")
      .single();

    const result = await createLead(supabase, {
      source: "cold_call",
      property: { address: "8 Secondary Slot Ln", state: "MO" },
      contact: { phone_1: "+18165553101" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.contactId).toBe(existing!.id);
    expect(result.data.phoneDropped).toBeNull();

    const { count } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .or("phone_1.eq.+18165553101,phone_2.eq.+18165553101,phone_3.eq.+18165553101");
    expect(count).toBe(1);
  });

  it("classification unavailable → lead succeeds degraded: phone parked on notes, phoneDropped flagged, no phone slot written", async () => {
    // Simulate a Telnyx outage: the stub returns a 500 for lookup calls.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.telnyx.com/v2/number_lookup")) {
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const result = await createLead(supabase, {
      source: "cold_call",
      property: { address: "9 Outage Ln", state: "MO" },
      contact: { first_name: "Out", last_name: "Age", phone_1: "+18165553200" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.phoneDropped).toBe("+18165553200");
    expect(result.data.contactId).not.toBeNull();

    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, notes")
      .eq("id", result.data.contactId!)
      .single();
    expect(contact!.phone_1).toBeNull();
    expect(contact!.notes).toContain("+18165553200");
  });

  it("removes the claimed property after contact creation failure and permits a clean retry", async () => {
    const input = {
      source: "referral" as const,
      property: { address: "20 Contact Failure Ln", state: "MO" },
      contact: { first_name: "Cleanup", last_name: "Contact" },
    };

    const first = await createLead(withOneInjectedFailure("contact_insert"), input);
    expect(first.ok).toBe(false);

    const [{ count: propertyCount }, { count: contactCount }] = await Promise.all([
      supabase
        .from("properties")
        .select("*", { count: "exact", head: true })
        .eq("address", input.property.address),
      supabase.from("contacts").select("*", { count: "exact", head: true }),
    ]);
    expect(propertyCount).toBe(0);
    expect(contactCount).toBe(0);

    const retry = await createLead(supabase, input);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.data.wasDuplicate).toBe(false);
  });

  it("removes both new rows after homeowner attach failure and permits a clean retry", async () => {
    const input = {
      source: "referral" as const,
      property: { address: "21 Attach Failure Ln", state: "MO" },
      contact: { first_name: "Cleanup", last_name: "Attach" },
    };

    const first = await createLead(withOneInjectedFailure("homeowner_attach"), input);
    expect(first.ok).toBe(false);

    const [{ count: propertyCount }, { count: contactCount }] = await Promise.all([
      supabase
        .from("properties")
        .select("*", { count: "exact", head: true })
        .eq("address", input.property.address),
      supabase.from("contacts").select("*", { count: "exact", head: true }),
    ]);
    expect(propertyCount).toBe(0);
    expect(contactCount).toBe(0);

    const retry = await createLead(supabase, input);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.data.wasDuplicate).toBe(false);
  });
});
