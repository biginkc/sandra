import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import { resetMockState } from "@/lib/messaging/providers/mock";
import { recordSmsPhoneSuppression } from "@/lib/messaging/opt-out-phone";

const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

// loadTemplateVars uses an admin client to resolve the session user id →
// first name. In tests we point that at the same service-role test client.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => testClient,
}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>(
    "next/server",
  );
  return { ...actual, after: () => {} };
});

// Stub getUser() so the bulk action can resolve `{{my_first_name}}` from
// the current session user. Tests opt in by setting currentUserId +
// currentEmail in their setup; the default null/null preserves the
// pre-fix behavior so older tests keep their existing assertions.
let currentUserId: string | null = null;
let currentEmail: string | null = null;
vi.spyOn(testClient.auth, "getUser").mockImplementation(async () =>
  ({
    data: {
      user: currentUserId
        ? ({ id: currentUserId, email: currentEmail } as never)
        : null,
    },
    error: null,
  }) as never,
);

const SAFE_NOW = new Date("2026-04-23T18:00:00Z");

import {
  assessBulkSmsAudience,
  bulkQueueSms,
  countAlreadyContacted,
} from "./actions";

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
  outreachDispo?: string | null;
  phone2?: string | null;
  phone2Type?: "mobile" | "landline" | "unknown";
  /** Defaults to 'mobile' — bulk SMS only queues confirmed mobiles, so
   *  most tests want a textable lead. Pass 'landline' / 'unknown' to
   *  exercise the line-type gate. */
  phoneType?: "mobile" | "landline" | "unknown";
}): Promise<{ propertyId: string; contactId: string | null }> {
  let contactId: string | null = null;
  const orgId = await getOrgId();

  if (opts.phone !== null) {
    const phoneType = opts.phoneType ?? "mobile";
    const { data: contact } = await testClient
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "Bulk",
        last_name: "Tester",
        phone_1: opts.phone ?? "+18165550099",
        // The 080 trigger rejects saving a phone typed 'unknown', so
        // seed unknown rows in two steps: insert typed 'mobile', then a
        // type-only update (allowed) — exactly how legacy unknowns exist.
        phone_1_type: phoneType === "unknown" ? "mobile" : phoneType,
        phone_2: opts.phone2 ?? null,
        phone_2_type: opts.phone2
          ? (opts.phone2Type ?? "mobile")
          : "unknown",
      })
      .select("id")
      .single();
    if (!contact) throw new Error("contact seed failed");
    contactId = contact.id;

    if (phoneType === "unknown") {
      const { error: typeError } = await testClient
        .from("contacts")
        .update({ phone_1_type: "unknown" })
        .eq("id", contactId);
      if (typeError) throw new Error(`type downgrade failed: ${typeError.message}`);
    }

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
      org_id: orgId,
      address: opts.address ?? "1 Bulk SMS St",
      state: "MO",
      status: "prospect",
      outreach_dispo: opts.outreachDispo ?? null,
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

function adHocOpts<T extends Record<string, unknown>>(opts: T): T & {
  campaignName: string;
} {
  return {
    ...opts,
    campaignName: `Bulk Test ${Math.random().toString(36).slice(2)}`,
  };
}

const createdAuthUsers: string[] = [];
async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await testClient.auth.admin.createUser({
    email,
    password: `test-pw-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);
  return data.user.id;
}

describe("bulkQueueSms (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    resetMockState();
    currentUserId = null;
    currentEmail = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SAFE_NOW);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const id of createdAuthUsers) {
      await testClient.auth.admin.deleteUser(id);
    }
    createdAuthUsers.length = 0;
  });

  it("returns zero counts immediately for an empty propertyIds array", async () => {
    const result = await bulkQueueSms([], adHocOpts({ body: "Test" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ succeeded: 0, skipped: 0, failed: [] });

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("rejects an empty ad-hoc send without a campaign name", async () => {
    const result = await bulkQueueSms([], { body: "Test" } as never);
    expect(result).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "Campaign name is required." },
    });
  });

  it("rejects ad-hoc sends without a campaign name before creating messages", async () => {
    const { propertyId } = await seedLead({ phone: "+18165551031" });

    const result = await bulkQueueSms([propertyId], { body: "Hi" } as never);
    expect(result).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "Campaign name is required." },
    });

    const { count: messageCount } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(messageCount).toBe(0);
    const { count: campaignCount } = await testClient
      .from("campaigns")
      .select("*", { count: "exact", head: true });
    expect(campaignCount).toBe(0);
  });

  it("creates an ad-hoc campaign, freezes recipients, stamps messages, and completes sync sends", async () => {
    const first = await seedLead({
      phone: "+18165551032",
      address: "1 Auto Campaign Way",
    });
    const second = await seedLead({
      phone: "+18165551033",
      address: "2 Auto Campaign Way",
    });

    const result = await bulkQueueSms(
      [first.propertyId, second.propertyId],
      {
        body: "Auto campaign hello",
        campaignName: "Auto Campaign Sync",
        paceSeconds: 10,
        skipIfContacted: true,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(2);

    const { data: campaign } = await testClient
      .from("campaigns")
      .select(
        "id, name, status, body, pace_seconds, skip_if_contacted, audience_snapshot",
      )
      .eq("name", "Auto Campaign Sync")
      .single();
    expect(campaign).toMatchObject({
      name: "Auto Campaign Sync",
      status: "completed",
      body: "Auto campaign hello",
      pace_seconds: 10,
      skip_if_contacted: true,
    });
    expect(campaign?.audience_snapshot).toEqual({
      source: "bulk_sms_modal",
      selection: { count: 2 },
    });

    const { data: recipients } = await testClient
      .from("campaign_recipients")
      .select("property_id, contact_id")
      .eq("campaign_id", campaign!.id);
    expect(new Set(recipients?.map((row) => row.property_id))).toEqual(
      new Set([first.propertyId, second.propertyId]),
    );
    expect(recipients?.every((row) => row.contact_id)).toBe(true);

    const { data: messages } = await testClient
      .from("messages")
      .select("campaign_id, property_id, status")
      .order("property_id", { ascending: true });
    expect(messages).toHaveLength(2);
    expect(messages?.every((row) => row.campaign_id === campaign!.id)).toBe(
      true,
    );
    expect(messages?.every((row) => row.status === "queued")).toBe(true);
  });

  it("campaign sends use the frozen recipient contact, not the property's current homeowner", async () => {
    const orgId = await getOrgId();
    const frozen = await seedLead({
      phone: "+18165551035",
      address: "1 Frozen Contact Way",
    });
    const { data: replacement } = await testClient
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "Replacement",
        last_name: "Owner",
        phone_1: "+18165551036",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (!replacement) throw new Error("replacement contact seed failed");
    await testClient.from("consent_events").insert({
      contact_id: replacement.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "test-seed",
    });

    const { data: campaign } = await testClient
      .from("campaigns")
      .insert({
        org_id: orgId,
        name: "Frozen Recipient Campaign",
        channel: "sms",
        status: "launching",
      })
      .select("id")
      .single();
    if (!campaign) throw new Error("campaign seed failed");
    await testClient.from("campaign_recipients").insert({
      campaign_id: campaign.id,
      property_id: frozen.propertyId,
      contact_id: frozen.contactId,
    });
    await testClient
      .from("properties")
      .update({ homeowner_contact_id: replacement.id })
      .eq("id", frozen.propertyId);

    const result = await bulkQueueSms([frozen.propertyId], {
      body: "Frozen recipient hello",
      campaignId: campaign.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);

    const { data: message } = await testClient
      .from("messages")
      .select("contact_id")
      .eq("campaign_id", campaign.id)
      .single();
    expect(message?.contact_id).toBe(frozen.contactId);
    expect(message?.contact_id).not.toBe(replacement.id);
  });

  it("rejects duplicate ad-hoc campaign names before queueing", async () => {
    const orgId = await getOrgId();
    const { propertyId } = await seedLead({ phone: "+18165551034" });
    const { error } = await testClient.from("campaigns").insert({
      org_id: orgId,
      name: "Duplicate Bulk",
      channel: "sms",
      status: "active",
    });
    expect(error).toBeNull();

    const result = await bulkQueueSms([propertyId], {
      body: "Should not queue",
      campaignName: "duplicate bulk",
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "DUPLICATE_NAME",
        message: 'A campaign named "duplicate bulk" already exists.',
      },
    });

    const { count: messageCount } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(messageCount).toBe(0);
    const { count: recipientCount } = await testClient
      .from("campaign_recipients")
      .select("*", { count: "exact", head: true });
    expect(recipientCount).toBe(0);
  });

  it("skips properties with no homeowner_contact_id", async () => {
    const { propertyId } = await seedLead({ phone: null });

    const result = await bulkQueueSms([propertyId], adHocOpts({ body: "Hi there" }));
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
    const orgId = await getOrgId();
    const { data: contact } = await testClient
      .from("contacts")
      .insert({ org_id: orgId, first_name: "No", last_name: "Phone" })
      .select("id")
      .single();
    if (!contact) throw new Error("contact seed failed");

    const { data: property } = await testClient
      .from("properties")
      .insert({
        org_id: orgId,
        address: "1 No Phone St",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contact.id,
      })
      .select("id")
      .single();
    if (!property) throw new Error("property seed failed");

    const result = await bulkQueueSms([property.id], adHocOpts({ body: "Hi" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(0);
    expect(result.data.skipped).toBe(1);
    expect(result.data.failed).toHaveLength(0);
  });

  it("skips opted-out contacts without queuing a message", async () => {
    const { propertyId } = await seedLead({ optOut: true });

    const result = await bulkQueueSms([propertyId], adHocOpts({ body: "Hi" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(0);
    expect(result.data.skipped).toBe(1);

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("skips terminal outreach dispositions without queuing a message", async () => {
    const { propertyId } = await seedLead({
      phone: "+18165551037",
      outreachDispo: "wrong_number",
    });

    const result = await bulkQueueSms([propertyId], adHocOpts({ body: "Hi" }));
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

  it("skips a re-imported contact when the same phone is suppressed", async () => {
    const phone = "+18165551038";
    const original = await seedLead({
      phone,
      address: "38 Original Suppressed St",
    });
    if (!original.contactId) throw new Error("missing original contact");
    const orgId = await getOrgId();
    await recordSmsPhoneSuppression(testClient, {
      contactId: original.contactId,
      fromPhone: phone,
      orgId,
      source: "integration-test-bulk-reimport",
      sourceDetail: { reason: "original_contact_opted_out" },
      occurredAt: new Date("2026-06-08T17:00:00Z"),
      providerId: "mock",
    });
    const reimported = await seedLead({
      phone: "+18165551039",
      phoneType: "landline",
      phone2: phone,
      phone2Type: "mobile",
      address: "38 Reimported Suppressed St",
    });
    if (!reimported.contactId) throw new Error("missing reimported contact");

    const { data: contact } = await testClient
      .from("contacts")
      .select("sms_opted_out")
      .eq("id", reimported.contactId)
      .single();
    expect(contact?.sms_opted_out).toBe(false);

    const result = await bulkQueueSms(
      [reimported.propertyId],
      adHocOpts({ body: "Hi" }),
    );
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

  it("skips landline contacts — never queues regardless of includeUnknown", async () => {
    const { propertyId } = await seedLead({
      phone: "+18165550061",
      phoneType: "landline",
    });

    const result = await bulkQueueSms([propertyId], adHocOpts({
      body: "Hi",
      includeUnknown: true,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(0);
    expect(result.data.skipped).toBe(1);

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("uses a mobile in phone_2 when phone_1 is a landline", async () => {
    const orgId = await getOrgId();
    const { data: contact } = await testClient
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: "Mobile",
        last_name: "Second",
        phone_1: "+18165550101",
        phone_1_type: "landline",
        phone_2: "+18165550102",
        phone_2_type: "mobile",
      })
      .select("id")
      .single();
    if (!contact) throw new Error("contact seed failed");
    await testClient.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "test-seed",
    });
    const { data: property } = await testClient
      .from("properties")
      .insert({
        org_id: orgId,
        address: "1 Mobile Second St",
        state: "MO",
        status: "prospect",
        homeowner_contact_id: contact.id,
      })
      .select("id")
      .single();
    if (!property) throw new Error("property seed failed");

    const assessment = await assessBulkSmsAudience([property.id]);
    expect(assessment.ok).toBe(true);
    if (!assessment.ok) return;
    expect(assessment.data).toMatchObject({
      total: 1,
      mobile: 1,
      landline: 0,
      unknown: 0,
      noPhone: 0,
    });

    const result = await bulkQueueSms(
      [property.id],
      adHocOpts({ body: "Hi from the mobile slot" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);

    const { data: message } = await testClient
      .from("messages")
      .select("to_address, status")
      .single();
    expect(message).toMatchObject({
      to_address: "+18165550102",
      status: "queued",
    });
  });

  it("skips unknown line types by default", async () => {
    const { propertyId } = await seedLead({
      phone: "+18165550062",
      phoneType: "unknown",
    });

    const result = await bulkQueueSms([propertyId], adHocOpts({ body: "Hi" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(0);
    expect(result.data.skipped).toBe(1);
  });

  it("queues unknown line types when includeUnknown=true", async () => {
    const { propertyId } = await seedLead({
      phone: "+18165550063",
      phoneType: "unknown",
    });

    const result = await bulkQueueSms([propertyId], adHocOpts({
      body: "Hi",
      includeUnknown: true,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);
    expect(result.data.skipped).toBe(0);
  });

  it("queues one message with scheduled_for = now for a valid lead", async () => {
    const { propertyId } = await seedLead({ phone: "+18165550031" });

    const result = await bulkQueueSms([propertyId], adHocOpts({ body: "Hi there!" }));
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

    const result = await bulkQueueSms(
      ids,
      adHocOpts({ body: "Paced message", paceSeconds: 18 }),
    );
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

    const result = await bulkQueueSms(
      [p1, p2, p3],
      adHocOpts({ body: "Mixed batch" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ succeeded: 2, skipped: 1, failed: [] });
  });

  it("renders {{my_first_name}} from the session user when bulk-queuing a template", async () => {
    // Regression: prior to the fix, bulkQueueSms hardcoded
    // enrolledByUserId: null which made loadTemplateVars return
    // my_first_name: null. Templates with `{{my_first_name}}` then
    // rendered an empty string and produced bodies like "Andrew,  here."
    // that went out to real prospects (canceled in prod 2026-05-05).
    const userId = await createAuthUser("jarrad+bulk-sender@bmhgroupkc.com");
    currentUserId = userId;
    currentEmail = "jarrad+bulk-sender@bmhgroupkc.com";

    const orgId = await getOrgId();
    const { error: tplErr } = await testClient.from("sms_templates").insert({
      org_id: orgId,
      name: "Sender token regression",
      content:
        "{{first_name | Hey}}, {{my_first_name}} here. Is {{property_address}} your house?",
      category: "Test-Sender-Opener",
    });
    if (tplErr) throw new Error(`template seed failed: ${tplErr.message}`);

    const { propertyId } = await seedLead({
      phone: "+18165550101",
      address: "101 Sender Rd",
    });

    const result = await bulkQueueSms([propertyId], adHocOpts({
      templateCategory: "Test-Sender-Opener",
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);

    const { data: messages } = await testClient
      .from("messages")
      .select("body")
      .eq("property_id", propertyId);
    expect(messages).toHaveLength(1);
    // local part of email → capitalized first name → "Jarrad+bulk-sender"
    // Match the prefix so the test doesn't depend on email-suffix handling.
    expect(messages![0].body).toContain("Jarrad");
    // No double-space gap where the empty token used to live.
    expect(messages![0].body).not.toMatch(/,\s\s/);
  });

  it("loads a template from the pool and renders it with lead vars", async () => {
    const orgId = await getOrgId();
    await seedTemplate(orgId, "Test-Opener");
    const { propertyId } = await seedLead({
      phone: "+18165550061",
      address: "61 Template Rd",
    });

    const result = await bulkQueueSms([propertyId], adHocOpts({
      templateCategory: "Test-Opener",
    }));
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

  // ---------------------------------------------------------------
  // Quick task 260504-tgq — skipIfContacted opt + countAlreadyContacted
  // ---------------------------------------------------------------

  it("skipIfContacted=true skips a property that has a prior outbound message and queues the rest", async () => {
    const orgId = await getOrgId();
    const { propertyId: alreadyContacted, contactId: contactedContactId } =
      await seedLead({ phone: "+18165550071", address: "71 Skip St" });
    const { propertyId: fresh } = await seedLead({
      phone: "+18165550072",
      address: "72 Skip St",
    });

    // Seed the prior outbound row so the skip filter trips.
    const { error: insertErr } = await testClient.from("messages").insert({
      org_id: orgId,
      property_id: alreadyContacted,
      contact_id: contactedContactId,
      direction: "outbound",
      status: "sent",
      channel: "sms",
      body: "earlier touch",
      from_address: "+18162804181",
      to_address: "+18165550071",
    });
    if (insertErr) throw new Error(`prior msg seed failed: ${insertErr.message}`);

    const result = await bulkQueueSms([alreadyContacted, fresh], adHocOpts({
      body: "Hello again",
      skipIfContacted: true,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);
    expect(result.data.skipped).toBe(1);
    expect(result.data.failed).toHaveLength(0);

    // Only the fresh property should have a queued row.
    const { data: queued } = await testClient
      .from("messages")
      .select("property_id")
      .eq("status", "queued");
    expect(queued).toHaveLength(1);
    expect(queued![0].property_id).toBe(fresh);
  });

  it("skipIfContacted=true does not skip a prior failed outbound attempt", async () => {
    const orgId = await getOrgId();
    const { propertyId, contactId } = await seedLead({
      phone: "+18165550073",
      address: "73 Retry St",
    });

    const { error: insertErr } = await testClient.from("messages").insert({
      org_id: orgId,
      property_id: propertyId,
      contact_id: contactId,
      direction: "outbound",
      status: "failed",
      channel: "sms",
      body: "failed touch",
      from_address: "+18162804181",
      to_address: "+18165550073",
    });
    if (insertErr) throw new Error(`prior msg seed failed: ${insertErr.message}`);

    const result = await bulkQueueSms([propertyId], adHocOpts({
      body: "Retry the failed attempt",
      skipIfContacted: true,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(1);
    expect(result.data.skipped).toBe(0);

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("status", "queued");
    expect(count).toBe(1);
  });

  it("skipIfContacted=false (or omitted) queues all eligible prospects regardless of prior messages", async () => {
    const orgId = await getOrgId();
    const { propertyId: alreadyContacted, contactId: contactedContactId } =
      await seedLead({ phone: "+18165550081", address: "81 NoSkip St" });
    const { propertyId: fresh } = await seedLead({
      phone: "+18165550082",
      address: "82 NoSkip St",
    });

    const { error: insertErr } = await testClient.from("messages").insert({
      org_id: orgId,
      property_id: alreadyContacted,
      contact_id: contactedContactId,
      direction: "outbound",
      status: "sent",
      channel: "sms",
      body: "earlier touch",
      from_address: "+18162804181",
      to_address: "+18165550081",
    });
    if (insertErr) throw new Error(`prior msg seed failed: ${insertErr.message}`);

    const result = await bulkQueueSms([alreadyContacted, fresh], adHocOpts({
      body: "Send to everyone",
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(2);
    expect(result.data.skipped).toBe(0);

    const { count } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("status", "queued");
    expect(count).toBe(2);
  });

  it("countAlreadyContacted returns the distinct property count from prior successful outbound messages", async () => {
    const orgId = await getOrgId();
    const { propertyId: p1, contactId: c1 } = await seedLead({
      phone: "+18165550091",
      address: "91 Count St",
    });
    const { propertyId: p2, contactId: c2 } = await seedLead({
      phone: "+18165550092",
      address: "92 Count St",
    });
    const { propertyId: p3, contactId: c3 } = await seedLead({
      phone: "+18165550093",
      address: "93 Count St",
    });

    // Two prior outbound rows for p1 (should still count as 1 distinct), one for p2.
    await testClient.from("messages").insert([
      {
        org_id: orgId,
        property_id: p1,
        contact_id: c1,
        direction: "outbound",
        status: "sent",
        channel: "sms",
        body: "first touch p1",
        from_address: "+18162804181",
        to_address: "+18165550091",
      },
      {
        org_id: orgId,
        property_id: p1,
        contact_id: c1,
        direction: "outbound",
        status: "sent",
        channel: "sms",
        body: "second touch p1",
        from_address: "+18162804181",
        to_address: "+18165550091",
      },
      {
        org_id: orgId,
        property_id: p2,
        contact_id: c2,
        direction: "outbound",
        status: "sent",
        channel: "sms",
        body: "touch p2",
        from_address: "+18162804181",
        to_address: "+18165550092",
      },
      {
        org_id: orgId,
        property_id: p3,
        contact_id: c3,
        direction: "outbound",
        status: "failed",
        channel: "sms",
        body: "failed touch should not count",
        from_address: "+18162804181",
        to_address: "+18165550093",
      },
    ]);

    const result = await countAlreadyContacted([p1, p2, p3]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(2);
  });

  it("countAlreadyContacted returns 0 for empty propertyIds without hitting the DB", async () => {
    const result = await countAlreadyContacted([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(0);
  });

  // ---------------------------------------------------------------
  // Jitter spread + uncapped continuous ramp. No client-side volume
  // caps — provider credits are the only cap (Jarrad's standing rule;
  // dailyCap removed 2026-06-12).
  // ---------------------------------------------------------------

  it("jitterPct=0.20 produces non-uniform gaps between scheduled_for values (variance > 0)", async () => {
    // Seed 12 leads so we get 11 gaps to compare.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { propertyId } = await seedLead({
        phone: `+1816555${(7000 + i).toString()}`,
        address: `${i} Jitter St`,
      });
      ids.push(propertyId);
    }

    const result = await bulkQueueSms(ids, adHocOpts({
      body: "Jittered",
      paceSeconds: 10,
      jitterPct: 0.2,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(12);

    const { data: messages } = await testClient
      .from("messages")
      .select("scheduled_for")
      .eq("status", "queued")
      .order("scheduled_for", { ascending: true });

    const gaps: number[] = [];
    for (let i = 1; i < messages!.length; i++) {
      const a = new Date(messages![i - 1].scheduled_for!).getTime();
      const b = new Date(messages![i].scheduled_for!).getTime();
      gaps.push(b - a);
    }
    // Each gap is within ±20% of the 10s nominal (8000–12000ms).
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(8000);
      expect(g).toBeLessThanOrEqual(12000);
    }
    // And not all gaps are identical (real jitter, not constant offset).
    const allEqual = gaps.every((g) => g === gaps[0]);
    expect(allEqual).toBe(false);
  });

  it("schedules every message in one continuous ramp — no rollover, no volume cap", async () => {
    // 5 leads → all 5 schedule at pace intervals from the anchor. Before
    // 2026-06-12 a dailyCap would have deferred the overflow to the next
    // day's 8 AM PT; that behavior is permanently gone.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { propertyId } = await seedLead({
        phone: `+1816555${(8000 + i).toString()}`,
        address: `${i} Cap St`,
      });
      ids.push(propertyId);
    }

    const result = await bulkQueueSms(ids, adHocOpts({
      body: "Uncapped",
      paceSeconds: 10,
      jitterPct: 0, // deterministic for this assertion
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(5);

    const { data: messages } = await testClient
      .from("messages")
      .select("scheduled_for")
      .eq("status", "queued")
      .order("scheduled_for", { ascending: true });

    const tsMs = messages!.map((m) => new Date(m.scheduled_for!).getTime());
    const nowMs = SAFE_NOW.getTime();

    // All 5: one continuous 10s ramp, nothing deferred to a next-day bucket.
    expect(tsMs).toEqual([
      nowMs,
      nowMs + 10_000,
      nowMs + 20_000,
      nowMs + 30_000,
      nowMs + 40_000,
    ]);
  });

  it("default opts (no jitter) schedule a deterministic paced ramp", async () => {
    // 3 leads → all schedule spaced by paceSeconds from the anchor.
    const ids = [
      (await seedLead({ phone: "+18165559001", address: "1 NoCap St" }))
        .propertyId,
      (await seedLead({ phone: "+18165559002", address: "2 NoCap St" }))
        .propertyId,
      (await seedLead({ phone: "+18165559003", address: "3 NoCap St" }))
        .propertyId,
    ];
    const result = await bulkQueueSms(ids, adHocOpts({
      body: "No cap",
      paceSeconds: 5,
      // jitterPct omitted (defaults to 0)
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.succeeded).toBe(3);

    const { data: messages } = await testClient
      .from("messages")
      .select("scheduled_for")
      .eq("status", "queued")
      .order("scheduled_for", { ascending: true });

    const base = SAFE_NOW.getTime();
    expect(new Date(messages![0].scheduled_for!).getTime()).toBe(base);
    expect(new Date(messages![1].scheduled_for!).getTime()).toBe(base + 5_000);
    expect(new Date(messages![2].scheduled_for!).getTime()).toBe(base + 10_000);
  });

  it("deferred ad-hoc sends create campaign recipients and serialize the resolved campaignId", async () => {
    const orgId = await getOrgId();
    const { data: contacts, error: contactError } = await testClient
      .from("contacts")
      .insert(
        Array.from({ length: 501 }, (_, i) => ({
          org_id: orgId,
          first_name: "Deferred",
          last_name: "Lead",
          phone_1: `+1816556${(1000 + i).toString()}`,
          phone_1_type: "mobile",
        })),
      )
      .select("id");
    if (contactError || !contacts) {
      throw new Error(`deferred contacts seed failed: ${contactError?.message}`);
    }
    const { data: properties, error: propertyError } = await testClient
      .from("properties")
      .insert(
        contacts.map((contact, i) => ({
          org_id: orgId,
          address: `${i} Deferred Bulk St`,
          state: "MO",
          status: "prospect",
          homeowner_contact_id: contact.id,
        })),
      )
      .select("id");
    if (propertyError || !properties) {
      throw new Error(`deferred properties seed failed: ${propertyError?.message}`);
    }
    const ids = properties.map((property) => property.id);

    const result = await bulkQueueSms(ids, {
      body: "Deferred bulk",
      campaignName: "Deferred Auto Campaign",
      paceSeconds: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deferred?.total).toBe(501);
    expect(result.data.succeeded).toBe(0);

    const { data: campaign } = await testClient
      .from("campaigns")
      .select("id, status")
      .eq("name", "Deferred Auto Campaign")
      .single();
    expect(campaign?.status).toBe("launching");

    const { count: recipientCount } = await testClient
      .from("campaign_recipients")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaign!.id);
    expect(recipientCount).toBe(501);

    const { data: job } = await testClient
      .from("jobs")
      .select("input_params")
      .eq("id", result.data.deferred!.jobId)
      .single();
    const input = job?.input_params as {
      opts?: {
        campaignId?: string | null;
        campaignName?: string | null;
        campaignSource?: string | null;
      };
      property_ids?: string[];
    };
    expect(input.opts?.campaignId).toBe(campaign!.id);
    expect(input.opts?.campaignName).toBeUndefined();
    expect(input.opts?.campaignSource).toBe("ad_hoc_bulk_sms");
    expect(input.property_ids).toHaveLength(501);
  });
});
