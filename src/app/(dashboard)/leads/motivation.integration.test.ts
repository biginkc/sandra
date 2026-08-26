import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

// eslint-disable-next-line import/first
import { updateLeadMotivation } from "@/app/(dashboard)/leads/actions";

describe("updateLeadMotivation (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
  });

  async function seedProperty(): Promise<string> {
    const { data, error } = await testClient
      .from("properties")
      .insert({ address: "1 Temp St", state: "MO", status: "new_lead" })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("seed failed");
    return data.id;
  }

  it("sets motivation_level to hot", async () => {
    const id = await seedProperty();
    const result = await updateLeadMotivation(id, "hot");
    expect(result.ok).toBe(true);

    const { data } = await testClient
      .from("properties")
      .select("motivation_level")
      .eq("id", id)
      .single();
    expect(data?.motivation_level).toBe("hot");

    const { data: events } = await testClient
      .from("lead_events")
      .select("event_type, payload")
      .eq("property_id", id);
    expect(events).toEqual([
      {
        event_type: "motivation_changed",
        payload: { from: null, to: "hot" },
      },
    ]);
  });

  it("does not append an event when the motivation is unchanged", async () => {
    const id = await seedProperty();
    await updateLeadMotivation(id, "hot");
    const result = await updateLeadMotivation(id, "hot");
    expect(result.ok).toBe(true);

    const { count } = await testClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("property_id", id);
    expect(count).toBe(1);
  });

  it("clears motivation when passed null", async () => {
    const id = await seedProperty();
    await updateLeadMotivation(id, "warm");
    const cleared = await updateLeadMotivation(id, null);
    expect(cleared.ok).toBe(true);

    const { data } = await testClient
      .from("properties")
      .select("motivation_level")
      .eq("id", id)
      .single();
    expect(data?.motivation_level).toBeNull();
  });

  it("rejects an invalid level with INVALID_MOTIVATION", async () => {
    const id = await seedProperty();
    // @ts-expect-error — deliberately passing an invalid level
    const result = await updateLeadMotivation(id, "lukewarm");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_MOTIVATION");

    // And nothing was written.
    const { data } = await testClient
      .from("properties")
      .select("motivation_level")
      .eq("id", id)
      .single();
    expect(data?.motivation_level).toBeNull();
  });

  it("bumps updated_at on change", async () => {
    const id = await seedProperty();
    const { data: before } = await testClient
      .from("properties")
      .select("updated_at")
      .eq("id", id)
      .single();
    await new Promise((r) => setTimeout(r, 50));
    await updateLeadMotivation(id, "cold");
    const { data: after } = await testClient
      .from("properties")
      .select("updated_at")
      .eq("id", id)
      .single();
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime(),
    );
  });

  it("accepts all three valid levels", async () => {
    const id = await seedProperty();
    for (const level of ["hot", "warm", "cold"] as const) {
      const r = await updateLeadMotivation(id, level);
      expect(r.ok, `level=${level}`).toBe(true);
      const { data } = await testClient
        .from("properties")
        .select("motivation_level")
        .eq("id", id)
        .single();
      expect(data?.motivation_level).toBe(level);
    }
  });
});
