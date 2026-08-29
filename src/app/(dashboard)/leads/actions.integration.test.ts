import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

// Replace the real server-side supabase factory with our test client so
// the action's internal `createClient()` call returns the service-role
// client pointed at sandra-crm-test. `vi.mock` is hoisted, so the import
// sequence below works even though `testClient` is defined later.
const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

import {
  qualifyLeadsBulk,
  updatePropertyStatus,
} from "@/app/(dashboard)/leads/actions";

describe("updatePropertyStatus (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
  });

  async function seedProperty(status = "new_lead"): Promise<string> {
    const { data, error } = await testClient
      .from("properties")
      .insert({ address: "1 Test St", state: "MO", status })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("seed failed");
    return data.id;
  }

  it("updates status for a valid transition", async () => {
    const id = await seedProperty("new_lead");
    const result = await updatePropertyStatus(id, "contacted", "new_lead");
    expect(result.ok).toBe(true);

    const { data } = await testClient
      .from("properties")
      .select("status")
      .eq("id", id)
      .single();
    expect(data?.status).toBe("contacted");

    const { data: events } = await testClient
      .from("lead_events")
      .select("event_type, payload")
      .eq("property_id", id);
    expect(events).toEqual([
      {
        event_type: "status_changed",
        payload: { from: "new_lead", to: "contacted" },
      },
    ]);
  });

  it("bumps updated_at when status changes", async () => {
    const id = await seedProperty("new_lead");
    const { data: before } = await testClient
      .from("properties")
      .select("updated_at")
      .eq("id", id)
      .single();
    // Small delay so the updated_at timestamp can actually move.
    await new Promise((r) => setTimeout(r, 50));
    const result = await updatePropertyStatus(id, "offer_sent", "new_lead");
    expect(result.ok).toBe(true);
    const { data: after } = await testClient
      .from("properties")
      .select("updated_at")
      .eq("id", id)
      .single();
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime(),
    );
  });

  it("rejects an invalid status with INVALID_STATUS", async () => {
    const id = await seedProperty("new_lead");
    // @ts-expect-error — deliberately passing an invalid status
    const result = await updatePropertyStatus(id, "bogus_status", "new_lead");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_STATUS");
  });

  it("does not report success when no property row was updated", async () => {
    const result = await updatePropertyStatus(
      "00000000-0000-0000-0000-000000000000",
      "contacted",
      "new_lead",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A missing row cannot be proven unlocked, so the permanent-DNC
      // preflight correctly fails closed before compare-and-set reconciliation.
      expect(result.error.code).toBe("PROPERTY_LOCK_CHECK_FAILED");
    }
  });

  it("returns the newer authoritative stage, then accepts a retry from that stage", async () => {
    const id = await seedProperty("interested");

    const result = await updatePropertyStatus(id, "offer_sent", "contacted");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STATUS_CONFLICT");
      expect(result.error.details).toEqual({ currentStatus: "interested" });
    }
    const { data } = await testClient
      .from("properties")
      .select("status")
      .eq("id", id)
      .single();
    expect(data?.status).toBe("interested");

    const retry = await updatePropertyStatus(id, "offer_sent", "interested");
    expect(retry).toEqual({
      ok: true,
      data: { propertyId: id, status: "offer_sent" },
    });
  });

  it("treats another client's already-saved target as idempotent success", async () => {
    const id = await seedProperty("contacted");
    const result = await updatePropertyStatus(id, "contacted", "new_lead");
    expect(result).toEqual({
      ok: true,
      data: { propertyId: id, status: "contacted" },
    });
    const { count } = await testClient
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("property_id", id);
    expect(count).toBe(0);
  });

  it("qualifyLeadsBulk collects per-id failures without aborting the batch", async () => {
    // Seed three prospects + one missing id. qualifyLeadsBulk should
    // qualify the real prospects, report the missing one in `failed`,
    // and return ok so the toast can render a partial-success summary.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { data, error } = await testClient
        .from("properties")
        .insert({
          address: `${i + 100} Partial Ln`,
          state: "MO",
          status: "prospect",
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("seed failed");
      ids.push(data.id);
    }
    const missingId = "00000000-0000-0000-0000-000000000000";

    const result = await qualifyLeadsBulk([ids[0], missingId, ids[1], ids[2]]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.qualified).toBe(3);
    expect(result.data.alreadyQualified).toBe(0);
    expect(result.data.failed).toHaveLength(1);
    expect(result.data.failed[0].propertyId).toBe(missingId);

    // All three real prospects actually flipped despite the bad id in the
    // middle of the batch.
    const { data: after } = await testClient
      .from("properties")
      .select("id, status")
      .in("id", ids);
    for (const row of after ?? []) {
      expect(row.status).toBe("new_lead");
    }
  });

  it("accepts every valid enum value", async () => {
    const statuses = [
      "new_lead",
      "contacted",
      "interested",
      "offer_sent",
      "offer_declined",
      "under_contract",
      "closed",
      "dead",
    ] as const;
    const id = await seedProperty("new_lead");
    let previous = "new_lead" as (typeof statuses)[number];
    for (const s of statuses) {
      const result = await updatePropertyStatus(id, s, previous);
      expect(result.ok, `status=${s}`).toBe(true);
      previous = s;
    }
  });
});
