import { beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updateHomeownerEmailsOp } from "@/lib/csv/update-operations/update-homeowner-emails";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

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
});
