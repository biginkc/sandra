import { beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { updateMotivationLevelOp } from "@/lib/csv/update-operations/update-motivation-level";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

async function seedProperty(
  address: string,
  motivation: string | null = null,
): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address,
      address_normalized: normalizeAddress(address),
      state: "MO",
      status: "new_lead",
      market: "Kansas City",
      motivation_level: motivation,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedProperty failed");
  return data.id;
}

async function readMotivation(id: string): Promise<string | null> {
  const { data } = await supabase
    .from("properties")
    .select("motivation_level")
    .eq("id", id)
    .single();
  return data!.motivation_level;
}

async function applyRow(parsedRow: Record<string, string>) {
  const match = await matchPropertyByAddress(supabase, {
    address: parsedRow.Address,
  });
  if (match.kind !== "matched") {
    throw new Error(`expected matched, got ${match.kind}`);
  }
  return updateMotivationLevelOp.apply(
    { supabase, userId: null },
    { rowIndex: 0, parsedRow, property: match.property },
    { dryRun: false },
  );
}

describe("update-motivation-level sub-op (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("each of hot / warm / cold writes correctly (case-insensitive)", async () => {
    for (const m of ["hot", "Warm", "COLD"]) {
      await resetTenantTables(supabase);
      const id = await seedProperty(`100 ${m} St`);
      const result = await applyRow({ Address: `100 ${m} St`, Motivation: m });
      expect(result.kind).toBe("updated");
      expect(await readMotivation(id)).toBe(m.toLowerCase());
    }
  });

  it("blank Motivation → motivation_level set to NULL", async () => {
    const id = await seedProperty("200 Clear St", "hot");
    const result = await applyRow({ Address: "200 Clear St", Motivation: "" });
    expect(result.kind).toBe("updated");
    expect(await readMotivation(id)).toBeNull();
  });

  it("invalid value (\"medium\") → rejected with reason invalid-motivation, no write", async () => {
    const id = await seedProperty("300 Bad St", "hot");
    const match = await matchPropertyByAddress(supabase, { address: "300 Bad St" });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await updateMotivationLevelOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "300 Bad St", Motivation: "medium" },
        property: match.property,
      },
      { dryRun: false },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reason).toBe("invalid-motivation");
    expect(await readMotivation(id)).toBe("hot");
  });

  it("fails closed when the matched property is hard-deleted before save", async () => {
    const id = await seedProperty("400 Deleted Motivation St", "cold");
    const match = await matchPropertyByAddress(supabase, {
      address: "400 Deleted Motivation St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");
    const { error: deleteError } = await supabase
      .from("properties")
      .delete()
      .eq("id", id);
    if (deleteError) throw deleteError;

    const result = await updateMotivationLevelOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: {
          Address: "400 Deleted Motivation St",
          Motivation: "hot",
        },
        property: match.property,
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({
      kind: "rejected",
      reason: "stale-property",
    });
  });

  it("fails closed when the matched property is soft-deleted before save", async () => {
    const id = await seedProperty("500 Soft Deleted Motivation St", "cold");
    const match = await matchPropertyByAddress(supabase, {
      address: "500 Soft Deleted Motivation St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");
    const deletedAt = new Date().toISOString();
    const { error: deleteError } = await supabase
      .from("properties")
      .update({ deleted_at: deletedAt })
      .eq("id", id);
    if (deleteError) throw deleteError;

    const result = await updateMotivationLevelOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: {
          Address: "500 Soft Deleted Motivation St",
          Motivation: "hot",
        },
        property: match.property,
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({
      kind: "rejected",
      reason: "stale-property",
    });
    const { data: proof } = await supabase
      .from("properties")
      .select("motivation_level, deleted_at")
      .eq("id", id)
      .single();
    expect(proof?.motivation_level).toBe("cold");
    expect(new Date(proof!.deleted_at!).getTime()).toBe(
      new Date(deletedAt).getTime(),
    );
  });
});
