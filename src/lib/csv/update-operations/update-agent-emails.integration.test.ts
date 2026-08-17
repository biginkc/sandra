import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updateAgentEmailsOp } from "@/lib/csv/update-operations/update-agent-emails";
import { createTestClient } from "@tests/integration/client";
import { createTemporaryOrganizationTracker } from "@tests/integration/fixtures/temporary-organizations";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();
const temporaryOrganizations = createTemporaryOrganizationTracker(supabase);

async function seedContact(): Promise<string> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({ first_name: "Test", last_name: "Agent" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedContact failed");
  return data.id;
}

async function seedPropertyWithAgent(
  address: string,
  agentContactId: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address,
      address_normalized: normalizeAddress(address),
      state: "MO",
      status: "new_lead",
      market: "Kansas City",
      agent_contact_id: agentContactId,
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
  return updateAgentEmailsOp.apply(
    { supabase, userId: null },
    { rowIndex: 0, parsedRow, property: match.property },
    { dryRun: false },
  );
}

describe("update-agent-emails sub-op (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  afterEach(async () => {
    await temporaryOrganizations.cleanup();
  });

  it("email written to the agent contact (lowercased + trimmed)", async () => {
    const contactId = await seedContact();
    await seedPropertyWithAgent("100 AgentMail St", contactId);
    const result = await applyRow({
      Address: "100 AgentMail St",
      Email: "  Agent@Brokerage.COM  ",
    });
    expect(result.kind).toBe("updated");
    expect(await readEmail(contactId)).toBe("agent@brokerage.com");
  });

  it("leaves a permanently DNC agent contact read-only", async () => {
    const contactId = await seedContact();
    await seedPropertyWithAgent("150 DNC Agent Mail St", contactId);
    const { error } = await supabase
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", contactId);
    if (error) throw error;

    const result = await applyRow({
      Address: "150 DNC Agent Mail St",
      Email: "changed@example.com",
    });

    expect(result).toMatchObject({ kind: "rejected", reason: "dnc-locked" });
    expect(await readEmail(contactId)).toBeNull();
  });

  it("property without agent_contact_id → rejected with reason no-agent", async () => {
    await seedPropertyWithAgent("200 NoAgent St", null);
    const match = await matchPropertyByAddress(supabase, {
      address: "200 NoAgent St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updateAgentEmailsOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "200 NoAgent St", Email: "x@y.com" },
        property: match.property,
      },
      { dryRun: false },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("no-agent");
  });

  it("fails closed on a legacy cross-tenant agent link and leaves the foreign email unchanged", async () => {
    const foreignOrg = await temporaryOrganizations.create(
      "Agent email foreign tenant",
    );
    const { data: foreignContact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        org_id: foreignOrg.id,
        first_name: "Foreign",
        last_name: "Agent",
        email: "foreign-agent@example.com",
      })
      .select("id")
      .single();
    if (contactError || !foreignContact) {
      throw contactError ?? new Error("foreign contact seed failed");
    }

    await seedPropertyWithAgent("225 Cross Tenant Agent Mail St", null);
    const match = await matchPropertyByAddress(supabase, {
      address: "225 Cross Tenant Agent Mail St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");

    const result = await updateAgentEmailsOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: {
          Address: "225 Cross Tenant Agent Mail St",
          Email: "stolen@example.com",
        },
        property: {
          ...match.property,
          agent_contact_id: foreignContact.id,
        },
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({ kind: "rejected", reason: "no-agent" });
    expect(await readEmail(foreignContact.id)).toBe(
      "foreign-agent@example.com",
    );
  });
});
