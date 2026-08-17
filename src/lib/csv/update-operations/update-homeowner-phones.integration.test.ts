import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updateHomeownerPhonesOp } from "@/lib/csv/update-operations/update-homeowner-phones";
import { createTestClient } from "@tests/integration/client";
import { createTemporaryOrganizationTracker } from "@tests/integration/fixtures/temporary-organizations";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();
const temporaryOrganizations = createTemporaryOrganizationTracker(supabase);

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

  afterEach(async () => {
    await temporaryOrganizations.cleanup();
  });

  it("property with homeowner_contact_id set → phones written to that contact", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("100 Phone St", contactId);
    const result = await applyRow({
      Address: "100 Phone St",
      "Phone 1": "8165550100",
      "Phone 1 Type": "Mobile",
      "Phone 2": "8165550101",
      "Phone 2 Type": "Mobile",
      "Phone 3": "8165550102",
      "Phone 3 Type": "Landline",
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

  it("fails closed when a property is cross-wired to another organization's homeowner", async () => {
    const foreignOrg = await temporaryOrganizations.create(
      "Homeowner phones foreign tenant",
    );
    const { data: foreignContact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        org_id: foreignOrg.id,
        first_name: "Foreign",
        last_name: "Homeowner",
      })
      .select("id")
      .single();
    if (contactError || !foreignContact) {
      throw contactError ?? new Error("foreign contact seed failed");
    }
    await seedPropertyWithHomeowner(
      "225 Cross Tenant Homeowner St",
      foreignContact.id,
    );

    const result = await applyRow({
      Address: "225 Cross Tenant Homeowner St",
      "Phone 1": "8165550225",
      "Phone 1 Type": "DO NOT CALL",
    });

    expect(result).toMatchObject({ kind: "rejected", reason: "no-homeowner" });
    const { data: proof } = await supabase
      .from("contacts")
      .select("phone_1, do_not_contact")
      .eq("id", foreignContact.id)
      .single();
    expect(proof).toEqual({ phone_1: null, do_not_contact: false });
  });

  it("phone without a line type → rejected with reason missing-line-type, nothing written", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("250 Untyped St", contactId);
    const result = await applyRow({
      Address: "250 Untyped St",
      "Phone 1": "8165550250",
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("missing-line-type");
    }
    const phones = await readPhones(contactId);
    expect(phones.phone_1).toBeNull();
  });

  it("E.164 normalization: 816-555-1234 → +18165551234", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("300 E164 St", contactId);
    const result = await applyRow({
      Address: "300 E164 St",
      "Phone 1": "816-555-1234",
      "Phone 1 Type": "Mobile",
    });
    expect(result.kind).toBe("updated");
    const phones = await readPhones(contactId);
    expect(phones.phone_1).toBe("+18165551234");
  });

  it("DO NOT CALL label on Phone 1 → do_not_contact ratcheted true, no phone written, no rejection (Codex PR #310 finding 5)", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("500 Dnc St", contactId);
    const result = await applyRow({
      Address: "500 Dnc St",
      "Phone 1": "8165550500",
      "Phone 1 Type": "DO NOT CALL",
    });
    // Drop-but-flag, same as the CSV-import DNC path — never a plain
    // rejection that leaves the contact silently callable.
    expect(result.kind).toBe("updated");
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, do_not_contact")
      .eq("id", contactId)
      .single();
    expect(contact?.phone_1).toBeNull();
    expect(contact?.do_not_contact).toBe(true);
  });

  it("DO NOT CALL on Phone 1 alongside a clean mobile in Phone 2 → only do_not_contact ratchets", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("510 Dnc Mixed St", contactId);
    const result = await applyRow({
      Address: "510 Dnc Mixed St",
      "Phone 1": "8165550510",
      "Phone 1 Type": "DO NOT CALL",
      "Phone 2": "8165550511",
      "Phone 2 Type": "Mobile",
    });
    expect(result.kind).toBe("updated");
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, phone_2, do_not_contact")
      .eq("id", contactId)
      .single();
    expect(contact?.phone_1).toBeNull();
    expect(contact?.phone_2).toBeNull();
    expect(contact?.do_not_contact).toBe(true);
    expect(result).toMatchObject({
      kind: "updated",
      after: { do_not_contact: true },
    });
  });

  it("never clears an already-suppressed contact when a later row has no DNC marker (one-way ratchet)", async () => {
    const contactId = await seedContact();
    await supabase
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", contactId);
    await seedPropertyWithHomeowner("520 Ratchet St", contactId);
    const result = await applyRow({
      Address: "520 Ratchet St",
      "Phone 1": "8165550520",
      "Phone 1 Type": "Mobile",
    });
    expect(result).toMatchObject({ kind: "rejected", reason: "dnc-locked" });
    const { data: contact } = await supabase
      .from("contacts")
      .select("phone_1, do_not_contact")
      .eq("id", contactId)
      .single();
    expect(contact?.phone_1).toBeNull();
    expect(contact?.do_not_contact).toBe(true);
  });

  it("Phone 2 / Phone 3 columns optional, fill in order; existing slots untouched if blank", async () => {
    const contactId = await seedContact();
    await supabase
      .from("contacts")
      .update({
        phone_1: "+19998880001",
        phone_1_type: "mobile",
        phone_2: "+19998880002",
        phone_2_type: "mobile",
      })
      .eq("id", contactId);
    await seedPropertyWithHomeowner("400 Partial St", contactId);
    const result = await applyRow({
      Address: "400 Partial St",
      "Phone 1": "8165550400",
      "Phone 1 Type": "Mobile",
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
