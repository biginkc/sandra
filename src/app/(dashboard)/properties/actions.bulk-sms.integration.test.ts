import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import { resetMockState } from "@/lib/messaging/providers/mock";

const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

const SAFE_NOW = new Date("2026-04-23T18:00:00Z");

// eslint-disable-next-line import/first
import { bulkQueueSms } from "./actions";

async function getOrgId(): Promise<string> {
  const { data } = await testClient
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error("no org");
  return data.id;
}

async function seedLead(opts: {
  phone?: string | null;
  optOut?: boolean;
  address?: string;
}): Promise<{ propertyId: string; contactId: string | null }> {
  let contactId: string | null = null;

  if (opts.phone !== null) {
    const { data: contact } = await testClient
      .from("contacts")
      .insert({
        first_name: "Bulk",
        last_name: "Tester",
        phone_1: opts.phone ?? "+18165550099",
      })
      .select("id")
      .single();
    if (!contact) throw new Error("contact seed failed");
    contactId = contact.id;

    await testClient.from("consent_events").insert({
      contact_id: contactId,
      channel: "sms",
      event_type: opts.optOut ? "opt_out" : "opt_in_marketing_written",
      source: "test-seed",
    });
  }

  const { data: property } = await testClient
    .from("properties")
    .insert({
      address: opts.address ?? "1 Bulk SMS St",
      state: "MO",
      status: "prospect",
      homeowner_contact_id: contactId,
    })
    .select("id")
    .single();
  if (!property) throw new Error("property seed failed");

  return { propertyId: property.id, contactId };
}

async function seedTemplate(orgId: string, category: string): Promise<void> {
  const { error } = await testClient.from("sms_templates").insert({
    org_id: orgId,
    name: "Test Template",
    content:
      "Hi {{first_name | there}}, interested in selling {{property_address}}?",
    category,
  });
  if (error) throw new Error(`template seed failed: ${error.message}`);
}

describe("bulkQueueSms (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    resetMockState();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SAFE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns zero counts immediately for an empty propertyIds array", async () => {
    const result = await bulkQueueSms([], { body: "Test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ succeeded: 0, skipped: 0, failed: [] });

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("skips properties with no homeowner_contact_id", async () => {
    const { propertyId } = await seedLead({ phone: null });

    const result = await bulkQueueSms([propertyId], { body: "Hi there" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(0);
    expect(result.data.skipped).toBe(1);
    expect(result.data.failed).toHaveLength(0);

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("skips contacts with no phone_1 (blocked_no_phone)", async () => {
    const { data: contact } = await testClient
      .from("contacts")
      .insert({ first_name: "No", last_name: "Phone" })
      .select("id")
      .single();
    if (!contact) throw new Error("contact seed failed");

    const { data: property } = await testClient
      .from("properties")
      .insert({
        address: "1 No Phone St",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contact.id,
      })
      .select("id")
      .single();
    if (!property) throw new Error("property seed failed");

    const result = await bulkQueueSms([property.id], { body: "Hi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(0);
    expect(result.data.skipped).toBe(1);
    expect(result.data.failed).toHaveLength(0);
  });

  it("skips opted-out contacts without queuing a message", async () => {
    const { propertyId } = await seedLead({ optOut: true });

    const result = await bulkQueueSms([propertyId], { body: "Hi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(0);
    expect(result.data.skipped).toBe(1);

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("queues one message with scheduled_for = now for a valid lead", async () => {
    const { propertyId } = await seedLead({ phone: "+18165550031" });

    const result = await bulkQueueSms([propertyId], { body: "Hi there!" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ succeeded: 1, skipped: 0, failed: [] });

    const { data: messages } = await testClient
      .from("messages")
      .select("status, scheduled_for, body")
      .eq("property_id", propertyId);

    expect(messages).toHaveLength(1);
    expect(messages![0].status).toBe("queued");
    expect(messages![0].body).toBe("Hi there!");
    // Index 0 → no pacing offset, scheduled_for = SAFE_NOW
    expect(new Date(messages![0].scheduled_for!).getTime()).toBe(
      SAFE_NOW.getTime(),
    );
  });

  it("spaces 3 queued messages by paceSeconds=18 each", async () => {
    const ids = [
      (await seedLead({ phone: "+18165550041", address: "1 Pace St" }))
        .propertyId,
      (await seedLead({ phone: "+18165550042", address: "2 Pace St" }))
        .propertyId,
      (await seedLead({ phone: "+18165550043", address: "3 Pace St" }))
        .propertyId,
    ];

    const result = await bulkQueueSms(ids, { body: "Paced message", paceSeconds: 18 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(3);

    const { data: messages } = await testClient
      .from("messages")
      .select("scheduled_for")
      .eq("status", "queued")
      .order("scheduled_for", { ascending: true });

    expect(messages).toHaveLength(3);
    const base = SAFE_NOW.getTime();
    expect(new Date(messages![0].scheduled_for!).getTime()).toBe(base);
    expect(new Date(messages![1].scheduled_for!).getTime()).toBe(base + 18_000);
    expect(new Date(messages![2].scheduled_for!).getTime()).toBe(base + 36_000);
  });

  it("returns correct counts for a mixed batch (2 succeed, 1 no contact)", async () => {
    const p1 = (
      await seedLead({ phone: "+18165550051", address: "51 Mix St" })
    ).propertyId;
    const p2 = (
      await seedLead({ phone: "+18165550052", address: "52 Mix St" })
    ).propertyId;
    const { propertyId: p3 } = await seedLead({
      phone: null,
      address: "53 Mix St",
    });

    const result = await bulkQueueSms([p1, p2, p3], { body: "Mixed batch" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ succeeded: 2, skipped: 1, failed: [] });
  });

  it("loads a template from the pool and renders it with lead vars", async () => {
    const orgId = await getOrgId();
    await seedTemplate(orgId, "Test-Opener");
    const { propertyId } = await seedLead({
      phone: "+18165550061",
      address: "61 Template Rd",
    });

    const result = await bulkQueueSms([propertyId], {
      templateCategory: "Test-Opener",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);

    const { data: messages } = await testClient
      .from("messages")
      .select("body")
      .eq("property_id", propertyId);

    expect(messages).toHaveLength(1);
    // Template: "Hi {{first_name | there}}, interested in selling {{property_address}}?"
    // first_name="Bulk", property_address="61 Template Rd"
    expect(messages![0].body).toContain("Bulk");
    expect(messages![0].body).toContain("61 Template Rd");
  });
});
