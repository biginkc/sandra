import { beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updateHomeownerPhonesOp } from "@/lib/csv/update-operations/update-homeowner-phones";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

async function seedContact(): Promise<string> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({ first_name: "Test", last_name: "Contact" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedContact failed");
  return data.id;
}

async function seedPropertyWithHomeowner(
  address: string,
  homeownerContactId: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address,
      address_normalized: normalizeAddress(address),
      state: "MO",
      status: "new_lead",
      market: "Kansas City",
      homeowner_contact_id: homeownerContactId,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedProperty failed");
  return data.id;
}

async function readPhones(contactId: string) {
  const { data } = await supabase
    .from("contacts")
    .select("phone_1, phone_2, phone_3")
    .eq("id", contactId)
    .single();
  return data!;
}

async function applyRow(parsedRow: Record<string, string>) {
  const match = await matchPropertyByAddress(supabase, {
    address: parsedRow.Address,
  });
  if (match.kind !== "matched") {
    throw new Error(`expected matched, got ${match.kind}`);
  }
  return updateHomeownerPhonesOp.apply(
    { supabase, userId: null },
    { rowIndex: 0, parsedRow, property: match.property },
    { dryRun: false },
  );
}

describe("update-homeowner-phones sub-op (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("property with homeowner_contact_id set → phones written to that contact", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("100 Phone St", contactId);
    const result = await applyRow({
      Address: "100 Phone St",
      "Phone 1": "8165550100",
      "Phone 2": "8165550101",
      "Phone 3": "8165550102",
    });
    expect(result.kind).toBe("updated");
    const phones = await readPhones(contactId);
    expect(phones.phone_1).toBe("+18165550100");
    expect(phones.phone_2).toBe("+18165550101");
    expect(phones.phone_3).toBe("+18165550102");
  });

  it("property without homeowner_contact_id → rejected with reason no-homeowner", async () => {
    await seedPropertyWithHomeowner("200 NoOwner St", null);
    const match = await matchPropertyByAddress(supabase, {
      address: "200 NoOwner St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updateHomeownerPhonesOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "200 NoOwner St", "Phone 1": "8165550200" },
        property: match.property,
      },
      { dryRun: false },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("no-homeowner");
  });

  it("E.164 normalization: 816-555-1234 → +18165551234", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("300 E164 St", contactId);
    const result = await applyRow({
      Address: "300 E164 St",
      "Phone 1": "816-555-1234",
    });
    expect(result.kind).toBe("updated");
    const phones = await readPhones(contactId);
    expect(phones.phone_1).toBe("+18165551234");
  });

  it("Phone 2 / Phone 3 columns optional, fill in order; existing slots untouched if blank", async () => {
    const contactId = await seedContact();
    await supabase
      .from("contacts")
      .update({ phone_1: "+19998880001", phone_2: "+19998880002" })
      .eq("id", contactId);
    await seedPropertyWithHomeowner("400 Partial St", contactId);
    const result = await applyRow({
      Address: "400 Partial St",
      "Phone 1": "8165550400",
      "Phone 2": "",
      "Phone 3": "",
    });
    expect(result.kind).toBe("updated");
    const phones = await readPhones(contactId);
    expect(phones.phone_1).toBe("+18165550400");
    expect(phones.phone_2).toBe("+19998880002");
    expect(phones.phone_3).toBeNull();
  });
});
