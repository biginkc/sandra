import { beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updatePropertyStatusOp } from "@/lib/csv/update-operations/update-property-status";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

async function seedProperty(
  address: string,
  status = "new_lead",
): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address,
      address_normalized: normalizeAddress(address),
      state: "MO",
      status,
      market: "Kansas City",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedProperty failed");
  return data.id;
}

async function readStatus(id: string): Promise<string> {
  const { data } = await supabase
    .from("properties")
    .select("status")
    .eq("id", id)
    .single();
  return data!.status;
}

async function applyRow(parsedRow: Record<string, string>) {
  const match = await matchPropertyByAddress(supabase, {
    address: parsedRow.Address,
  });
  if (match.kind !== "matched") {
    throw new Error(`expected matched, got ${match.kind}`);
  }
  return updatePropertyStatusOp.apply(
    { supabase, userId: null },
    { rowIndex: 0, parsedRow, property: match.property },
    { dryRun: false },
  );
}

describe("update-property-status sub-op (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("matched row + valid status → status updated on the property", async () => {
    const id = await seedProperty("100 Update St", "new_lead");
    const result = await applyRow({ Address: "100 Update St", Status: "contacted" });
    expect(result.kind).toBe("updated");
    expect(await readStatus(id)).toBe("contacted");
  });

  it("matched row + variant casing (Closed / CLOSED / closed) all map to closed", async () => {
    for (const variant of ["Closed", "CLOSED", "closed"]) {
      await resetTenantTables(supabase);
      const id = await seedProperty(`200 ${variant} St`, "new_lead");
      const result = await applyRow({
        Address: `200 ${variant} St`,
        Status: variant,
      });
      expect(result.kind).toBe("updated");
      expect(await readStatus(id)).toBe("closed");
    }
  });

  it("matched row + invalid status (schmurf) → rejected with reason invalid-status, no DB write", async () => {
    const id = await seedProperty("300 Invalid St", "new_lead");
    const match = await matchPropertyByAddress(supabase, { address: "300 Invalid St" });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updatePropertyStatusOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "300 Invalid St", Status: "schmurf" },
        property: match.property,
      },
      { dryRun: false },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("invalid-status");
    expect(await readStatus(id)).toBe("new_lead");
  });

  it("blank status → unchanged (no overwrite)", async () => {
    const id = await seedProperty("400 Blank St", "interested");
    const match = await matchPropertyByAddress(supabase, { address: "400 Blank St" });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updatePropertyStatusOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "400 Blank St", Status: "" },
        property: match.property,
      },
      { dryRun: false },
    );
    expect(result.kind).toBe("unchanged");
    expect(await readStatus(id)).toBe("interested");
  });

  it("dryRun=true → no DB write even when valid", async () => {
    const id = await seedProperty("500 DryRun St", "new_lead");
    const match = await matchPropertyByAddress(supabase, { address: "500 DryRun St" });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updatePropertyStatusOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "500 DryRun St", Status: "contacted" },
        property: match.property,
      },
      { dryRun: true },
    );
    expect(result.kind).toBe("updated");
    expect(await readStatus(id)).toBe("new_lead");
  });
});
