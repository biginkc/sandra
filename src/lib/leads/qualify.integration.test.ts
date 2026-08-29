import { beforeEach, describe, expect, it } from "vitest";

import { qualifyProperty } from "@/lib/leads/qualify";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

async function seedProspect(address = "123 Prospect St"): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({ address, state: "MO", status: "prospect" })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "seed failed");
  return data.id;
}

describe("qualifyProperty (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("promotes a prospect to new_lead and stamps qualified_at + qualified_by", async () => {
    const id = await seedProspect();

    const outcome = await qualifyProperty(supabase, id, "user-abc");
    expect(outcome.status).toBe("qualified");

    const { data } = await supabase
      .from("properties")
      .select("status, qualified_at, qualified_by")
      .eq("id", id)
      .single();
    expect(data?.status).toBe("new_lead");
    expect(data?.qualified_by).toBe("user-abc");
    expect(data?.qualified_at).not.toBeNull();
    const { data: events } = await supabase
      .from("lead_events")
      .select("event_type, actor_type, payload")
      .eq("property_id", id);
    expect(events).toEqual([
      {
        event_type: "qualified",
        actor_type: "system",
        payload: { from: "prospect", to: "new_lead" },
      },
    ]);
  });

  it("is idempotent — second call returns already_qualified and preserves the original stamp", async () => {
    const id = await seedProspect();

    const first = await qualifyProperty(supabase, id, "user-first");
    expect(first.status).toBe("qualified");
    const { data: afterFirst } = await supabase
      .from("properties")
      .select("qualified_at, qualified_by")
      .eq("id", id)
      .single();
    const originalStamp = afterFirst?.qualified_at;
    const originalBy = afterFirst?.qualified_by;

    // A small wait so a clobbering update would produce a different timestamp.
    await new Promise((r) => setTimeout(r, 15));
    const second = await qualifyProperty(supabase, id, "user-second");
    expect(second.status).toBe("already_qualified");

    const { data: afterSecond } = await supabase
      .from("properties")
      .select("status, qualified_at, qualified_by")
      .eq("id", id)
      .single();
    expect(afterSecond?.status).toBe("new_lead");
    expect(afterSecond?.qualified_at).toBe(originalStamp);
    expect(afterSecond?.qualified_by).toBe(originalBy);
    const { count } = await supabase
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("property_id", id)
      .eq("event_type", "qualified");
    expect(count).toBe(1);
  });

  it("returns already_qualified when the row isn't a prospect to begin with", async () => {
    const { data } = await supabase
      .from("properties")
      .insert({
        address: "456 Already Ln",
        state: "MO",
        status: "contacted",
      })
      .select("id")
      .single();
    expect(data).not.toBeNull();

    const outcome = await qualifyProperty(
      supabase,
      data!.id,
      "system:inbound_reply",
    );
    expect(outcome.status).toBe("already_qualified");

    const { data: row } = await supabase
      .from("properties")
      .select("status, qualified_at")
      .eq("id", data!.id)
      .single();
    expect(row?.status).toBe("contacted");
    // Never stamped since we didn't qualify.
    expect(row?.qualified_at).toBeNull();
  });

  it("returns not_found for an unknown id", async () => {
    const outcome = await qualifyProperty(
      supabase,
      "00000000-0000-0000-0000-000000000000",
      null,
    );
    expect(outcome.status).toBe("not_found");
  });

  it("accepts the system qualifier marker for auto-qualify from inbound webhook", async () => {
    const id = await seedProspect("789 Auto Ave");
    const outcome = await qualifyProperty(
      supabase,
      id,
      "system:inbound_reply",
    );
    expect(outcome.status).toBe("qualified");

    const { data } = await supabase
      .from("properties")
      .select("qualified_by, status")
      .eq("id", id)
      .single();
    expect(data?.qualified_by).toBe("system:inbound_reply");
    expect(data?.status).toBe("new_lead");
  });
});
