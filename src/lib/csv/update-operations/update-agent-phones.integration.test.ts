import { beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updateAgentPhonesOp } from "@/lib/csv/update-operations/update-agent-phones";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

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
  return updateAgentPhonesOp.apply(
    { supabase, userId: null },
    { rowIndex: 0, parsedRow, property: match.property },
    { dryRun: false },
  );
}

describe("update-agent-phones sub-op (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("property with agent_contact_id → phones written to the agent contact", async () => {
    const contactId = await seedContact();
    await seedPropertyWithAgent("100 Agent St", contactId);
    const result = await applyRow({
      Address: "100 Agent St",
      "Phone 1": "8165551000",
    });
    expect(result.kind).toBe("updated");
    expect((await readPhones(contactId)).phone_1).toBe("+18165551000");
  });

  it("property without agent_contact_id → rejected with reason no-agent", async () => {
    await seedPropertyWithAgent("200 NoAgent St", null);
    const match = await matchPropertyByAddress(supabase, {
      address: "200 NoAgent St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updateAgentPhonesOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "200 NoAgent St", "Phone 1": "8165552000" },
        property: match.property,
      },
      { dryRun: false },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("no-agent");
  });
});
