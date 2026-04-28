import { beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

async function seedProperty(address: string): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address,
      address_normalized: normalizeAddress(address),
      state: "MO",
      status: "new_lead",
      market: "Kansas City",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedProperty failed");
  return data.id;
}

describe("matchPropertyByAddress (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("returns matched when one property has the same address_normalized", async () => {
    const id = await seedProperty("123 Main St");
    const result = await matchPropertyByAddress(supabase, {
      address: "123 Main St",
    });
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.property.id).toBe(id);
  });

  it("returns unmatched when no property matches", async () => {
    await seedProperty("999 Other Ave");
    const result = await matchPropertyByAddress(supabase, {
      address: "1 Nowhere Pl",
    });
    expect(result.kind).toBe("unmatched");
    if (result.kind === "unmatched") expect(result.reason).toBe("no-address-match");
  });

  it("returns matched and is case-insensitive (123 Main St == 123 MAIN ST)", async () => {
    const id = await seedProperty("123 Main St");
    const result = await matchPropertyByAddress(supabase, {
      address: "123 MAIN ST",
    });
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.property.id).toBe(id);
  });

  it("returns matched and is suffix-tolerant (Street == St) via normalizeAddress", async () => {
    const id = await seedProperty("123 Main Street");
    const result = await matchPropertyByAddress(supabase, {
      address: "123 Main St",
    });
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") expect(result.property.id).toBe(id);
  });

  it("returns unmatched with reason blank-address when input is empty", async () => {
    await seedProperty("123 Main St");
    const result = await matchPropertyByAddress(supabase, { address: "  " });
    expect(result.kind).toBe("unmatched");
    if (result.kind === "unmatched") expect(result.reason).toBe("blank-address");
  });
});
