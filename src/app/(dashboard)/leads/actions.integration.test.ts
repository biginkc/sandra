import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getCallerMembershipsOrThrow: vi.fn(),
  getCallerMemberships: vi.fn(),
}));

vi.mock("@/lib/auth/memberships", () => authMocks);

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
  sendSmsFromLead,
  updatePropertyStatus,
} from "@/app/(dashboard)/leads/actions";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";

describe("updatePropertyStatus (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    resetMockState();
    const membership = {
      org_id: "00000000-0000-0000-0000-000000000001",
      role: "owner",
      acquisitions_enabled: false,
    };
    authMocks.getCallerMembershipsOrThrow.mockResolvedValue([membership]);
    authMocks.getCallerMemberships.mockResolvedValue([membership]);
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

  async function seedSmsLead(): Promise<{ propertyId: string; contactId: string }> {
    const { data: contact, error: contactError } = await testClient
      .from("contacts")
      .insert({ first_name: "Parity", phone_1: "+18165550123", phone_1_type: "mobile" })
      .select("id")
      .single();
    if (contactError || !contact) throw contactError ?? new Error("contact seed failed");
    const { data: property, error: propertyError } = await testClient
      .from("properties")
      .insert({ address: "1 Parity Ln", state: "MO", homeowner_contact_id: contact.id })
      .select("id")
      .single();
    if (propertyError || !property) throw propertyError ?? new Error("property seed failed");
    await testClient.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "actions-integration",
    });
    return { propertyId: property.id, contactId: contact.id };
  }

  it("T23 uses the real sendSmsFromLead path for pending and accepted default-sender stages", async () => {
    const { propertyId, contactId } = await seedSmsLead();
    const pending = await sendSmsFromLead(propertyId, "  parity body  ", null, true, null);

    expect(pending.ok).toBe(true);
    if (!pending.ok || pending.data.outcome.status !== "queued") return;
    expect(getMockMessageLog()).toHaveLength(0);
    const { data: queued } = await testClient
      .from("messages")
      .select("status, provider, body, contact_id, property_id, from_address, to_address, external_id, metadata")
      .eq("id", pending.data.outcome.messageId)
      .single();
    expect(queued).toMatchObject({
      status: "queued",
      provider: "mock",
      body: "parity body",
      contact_id: contactId,
      property_id: propertyId,
      external_id: null,
    });

    const accepted = await (await import("@/lib/messaging/send")).releaseQueuedMessage(testClient, pending.data.outcome.messageId);
    expect(accepted.status).toBe("sent");
    expect(getMockMessageLog()).toHaveLength(1);
    const { data: sent } = await testClient
      .from("messages")
      .select("status, provider, body, contact_id, property_id, from_address, to_address, external_id, metadata")
      .eq("id", pending.data.outcome.messageId)
      .single();
    expect(sent).toMatchObject({
      status: "sent",
      provider: "mock",
      body: queued?.body,
      contact_id: queued?.contact_id,
      property_id: queued?.property_id,
      from_address: queued?.from_address,
      to_address: queued?.to_address,
    });
    expect(sent?.external_id).toMatch(/^mock_/);
  });

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
