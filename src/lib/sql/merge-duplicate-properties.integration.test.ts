import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

/**
 * Covers the `merge_duplicate_properties(keeper_id, loser_id)` SQL function.
 * Two outcomes matter: references to the loser re-point to the keeper
 * (messages, job_items), and the loser's non-null fields coalesce into
 * the keeper. The loser row itself is deleted and a `property_merges`
 * audit row is written with the full pre-merge snapshot.
 */

describe("merge_duplicate_properties() (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("re-points messages and job_items, coalesces fields, logs snapshot, deletes loser", async () => {
    // Keeper has an address + state only. Loser has the richer fields.
    const { data: keeper } = await supabase
      .from("properties")
      .insert({ address: "1 Keeper St", state: "MO" })
      .select()
      .single();
    const { data: loser } = await supabase
      .from("properties")
      .insert({
        address: "1 Loser St",
        state: "MO",
        beds: 3,
        baths: 2,
        zpid: "Z-LOSER-12345",
        arv: 125000,
      })
      .select()
      .single();
    expect(keeper).toBeDefined();
    expect(loser).toBeDefined();

    // Drop a message + job + job_item referencing the loser so we can
    // verify the re-point. Job is a scaffolded csv_import.
    const { data: job } = await supabase
      .from("jobs")
      .insert({ type: "csv_import", status: "completed", total_items: 1 })
      .select()
      .single();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      body: "hi",
      property_id: loser!.id,
    });
    await supabase.from("job_items").insert({
      job_id: job!.id,
      property_id: loser!.id,
      status: "success",
    });

    const { error } = await supabase.rpc("merge_duplicate_properties", {
      keeper_id: keeper!.id,
      loser_id: loser!.id,
    });
    expect(error).toBeNull();

    // Keeper now carries the loser's non-null fields where keeper was null.
    const { data: merged } = await supabase
      .from("properties")
      .select("id, address, beds, baths, zpid, arv")
      .eq("id", keeper!.id)
      .single();
    expect(merged?.address).toBe("1 Keeper St"); // keeper kept its own address
    expect(merged?.beds).toBe(3);
    expect(merged?.baths).toBe(2);
    expect(merged?.zpid).toBe("Z-LOSER-12345");
    expect(Number(merged?.arv)).toBe(125000);

    // Loser row is gone.
    const { data: loserAfter } = await supabase
      .from("properties")
      .select("id")
      .eq("id", loser!.id)
      .maybeSingle();
    expect(loserAfter).toBeNull();

    // Dependents re-pointed to keeper.
    const { data: messagesAfter } = await supabase
      .from("messages")
      .select("property_id");
    expect(messagesAfter?.[0].property_id).toBe(keeper!.id);

    const { data: itemsAfter } = await supabase
      .from("job_items")
      .select("property_id");
    expect(itemsAfter?.[0].property_id).toBe(keeper!.id);

    // Audit snapshot written.
    const { data: mergeRow } = await supabase
      .from("property_merges")
      .select("keeper_id, loser_id, loser_snapshot")
      .eq("keeper_id", keeper!.id)
      .single();
    expect(mergeRow?.loser_id).toBe(loser!.id);
    expect(mergeRow?.loser_snapshot).toMatchObject({
      address: "1 Loser St",
      beds: 3,
    });
  });

  it("raises an exception when either row doesn't exist", async () => {
    const bogus1 = "00000000-0000-0000-0000-000000000001";
    const bogus2 = "00000000-0000-0000-0000-000000000002";
    const { error } = await supabase.rpc("merge_duplicate_properties", {
      keeper_id: bogus1,
      loser_id: bogus2,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/one or both rows not found/i);
  });
});
