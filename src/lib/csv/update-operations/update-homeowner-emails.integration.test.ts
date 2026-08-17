import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updateHomeownerEmailsOp } from "@/lib/csv/update-operations/update-homeowner-emails";
import { createTestClient } from "@tests/integration/client";
import { createTemporaryOrganizationTracker } from "@tests/integration/fixtures/temporary-organizations";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();
const temporaryOrganizations = createTemporaryOrganizationTracker(supabase);

async function seedContact(): Promise<string> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({ first_name: "Test", last_name: "Owner" })
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

async function readEmail(contactId: string): Promise<string | null> {
  const { data } = await supabase
    .from("contacts")
    .select("email")
    .eq("id", contactId)
    .single();
  return data!.email;
}

async function applyRow(parsedRow: Record<string, string>) {
  const match = await matchPropertyByAddress(supabase, {
    address: parsedRow.Address,
  });
  if (match.kind !== "matched") {
    throw new Error(`expected matched, got ${match.kind}`);
  }
  return updateHomeownerEmailsOp.apply(
    { supabase, userId: null },
    { rowIndex: 0, parsedRow, property: match.property },
    { dryRun: false },
  );
}

describe("update-homeowner-emails sub-op (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  afterEach(async () => {
    await temporaryOrganizations.cleanup();
  });

  it("email written to the homeowner contact", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("100 Mail St", contactId);
    const result = await applyRow({
      Address: "100 Mail St",
      Email: "owner@example.com",
    });
    expect(result.kind).toBe("updated");
    expect(await readEmail(contactId)).toBe("owner@example.com");
  });

  it("leaves a permanently DNC homeowner contact read-only", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("150 DNC Owner Mail St", contactId);
    const { error } = await supabase
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", contactId);
    if (error) throw error;

    const result = await applyRow({
      Address: "150 DNC Owner Mail St",
      Email: "changed@example.com",
    });

    expect(result).toMatchObject({ kind: "rejected", reason: "dnc-locked" });
    expect(await readEmail(contactId)).toBeNull();
  });

  it("lowercase + trim normalization (Jane@Example.COM → jane@example.com)", async () => {
    const contactId = await seedContact();
    await seedPropertyWithHomeowner("200 Norm St", contactId);
    const result = await applyRow({
      Address: "200 Norm St",
      Email: "  Jane@Example.COM  ",
    });
    expect(result.kind).toBe("updated");
    expect(await readEmail(contactId)).toBe("jane@example.com");
  });

  it("property without homeowner_contact_id → rejected with reason no-homeowner", async () => {
    await seedPropertyWithHomeowner("300 NoOwner St", null);
    const match = await matchPropertyByAddress(supabase, {
      address: "300 NoOwner St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updateHomeownerEmailsOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "300 NoOwner St", Email: "x@y.com" },
        property: match.property,
      },
      { dryRun: false },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("no-homeowner");
  });

  it("fails closed on a legacy cross-tenant homeowner link and leaves the foreign email unchanged", async () => {
    const foreignOrg = await temporaryOrganizations.create(
      "Homeowner email foreign tenant",
    );
    const { data: foreignContact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        org_id: foreignOrg.id,
        first_name: "Foreign",
        last_name: "Homeowner",
        email: "foreign-owner@example.com",
      })
      .select("id")
      .single();
    if (contactError || !foreignContact) {
      throw contactError ?? new Error("foreign contact seed failed");
    }

    await seedPropertyWithHomeowner("325 Cross Tenant Owner St", null);
    const match = await matchPropertyByAddress(supabase, {
      address: "325 Cross Tenant Owner St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");

    // The schema now rejects new cross-tenant links. Override the matched
    // application boundary to reproduce a historical row that predates the
    // forward constraint, while keeping the contact itself in the real DB.
    const result = await updateHomeownerEmailsOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: {
          Address: "325 Cross Tenant Owner St",
          Email: "stolen@example.com",
        },
        property: {
          ...match.property,
          homeowner_contact_id: foreignContact.id,
        },
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({ kind: "rejected", reason: "no-homeowner" });
    expect(await readEmail(foreignContact.id)).toBe(
      "foreign-owner@example.com",
    );
  });
});
