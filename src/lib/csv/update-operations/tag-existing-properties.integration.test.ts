import { beforeEach, describe, expect, it } from "vitest";

import { matchPropertyByAddress } from "@/lib/csv/match-by-address";
import { normalizeAddress } from "@/lib/csv/normalize";
import { tagExistingPropertiesOp } from "@/lib/csv/update-operations/tag-existing-properties";
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

async function seedTag(name: string): Promise<string> {
  const { data, error } = await supabase
    .from("tags")
    .insert({ name, category: "custom" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedTag failed");
  return data.id;
}

async function readPropertyTagIds(propertyId: string): Promise<string[]> {
  const { data } = await supabase
    .from("property_tags")
    .select("tag_id")
    .eq("property_id", propertyId);
  return (data ?? []).map((r) => r.tag_id);
}

async function readTagCount(): Promise<number> {
  const { count } = await supabase
    .from("tags")
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}

async function applyRow(parsedRow: Record<string, string>) {
  const match = await matchPropertyByAddress(supabase, {
    address: parsedRow.Address,
  });
  if (match.kind !== "matched") {
    throw new Error(`expected matched, got ${match.kind}`);
  }
  return tagExistingPropertiesOp.apply(
    { supabase, userId: null },
    { rowIndex: 0, parsedRow, property: match.property },
    { dryRun: false },
  );
}

describe("tag-existing-properties sub-op (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it('comma-separated tags split correctly when both exist ("hot, probate" → 2 applied)', async () => {
    const propId = await seedProperty("100 Tag St");
    const hotId = await seedTag("hot");
    const probateId = await seedTag("probate");
    const result = await applyRow({
      Address: "100 Tag St",
      Tags: "hot, probate",
    });
    expect(result.kind).toBe("updated");
    const applied = await readPropertyTagIds(propId);
    expect(applied.sort()).toEqual([hotId, probateId].sort());
  });

  it('existing tag, case variant: "Hot" matches existing "hot", applied, no duplicate', async () => {
    const propId = await seedProperty("200 Case St");
    const hotId = await seedTag("hot");
    const result = await applyRow({ Address: "200 Case St", Tags: "Hot" });
    expect(result.kind).toBe("updated");
    expect(await readPropertyTagIds(propId)).toEqual([hotId]);
    expect(await readTagCount()).toBe(1);
  });

  it("unknown tag (schmurf) → rejected with reason unknown-tag, NO insert into tags", async () => {
    const propId = await seedProperty("300 Unknown St");
    await seedTag("hot"); // unrelated existing tag
    const tagsBefore = await readTagCount();
    const result = await applyRow({
      Address: "300 Unknown St",
      Tags: "schmurf",
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("unknown-tag");
      expect(result.unknownTags).toEqual(["schmurf"]);
    }
    expect(await readPropertyTagIds(propId)).toEqual([]);
    expect(await readTagCount()).toBe(tagsBefore);
  });

  it('mixed row ("hot, schmurf") → rejected; schmurf in unknownTags; hot NOT applied (all-or-nothing)', async () => {
    const propId = await seedProperty("400 Mixed St");
    await seedTag("hot");
    const result = await applyRow({
      Address: "400 Mixed St",
      Tags: "hot, schmurf",
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toBe("unknown-tag");
      expect(result.unknownTags).toEqual(["schmurf"]);
    }
    expect(await readPropertyTagIds(propId)).toEqual([]);
  });

  it("same property + same existing tag run twice → no duplicate property_tags row (upsert)", async () => {
    const propId = await seedProperty("500 Twice St");
    const hotId = await seedTag("hot");
    const first = await applyRow({ Address: "500 Twice St", Tags: "hot" });
    const replay = await applyRow({ Address: "500 Twice St", Tags: "hot" });
    expect(first.kind).toBe("updated");
    expect(replay).toEqual({
      kind: "unchanged",
      rowIndex: 0,
      address: "500 Twice St",
      reason: "no-change",
    });
    expect(await readPropertyTagIds(propId)).toEqual([hotId]);
  });

  it("dryRun=true with unknown tag still surfaces unknownTags but writes nothing", async () => {
    const propId = await seedProperty("600 Dry St");
    await seedTag("hot");
    const match = await matchPropertyByAddress(supabase, {
      address: "600 Dry St",
    });
    if (match.kind !== "matched") throw new Error("expected matched");
    const result = await tagExistingPropertiesOp.apply(
      { supabase, userId: null },
      {
        rowIndex: 0,
        parsedRow: { Address: "600 Dry St", Tags: "hot, schmurf" },
        property: match.property,
      },
      { dryRun: true },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.unknownTags).toEqual(["schmurf"]);
    }
    expect(await readPropertyTagIds(propId)).toEqual([]);
  });
});
