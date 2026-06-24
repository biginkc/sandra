import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import type { Database } from "@/lib/supabase/types";

import { listThreads } from "./list-threads";
import {
  createPropertyAndResolve,
  resolveThreadToExistingProperty,
} from "./resolve";
import { ensureConversationIdForThread } from "./threading";

const supabase = createTestClient();
const createdUserIds: string[] = [];

async function seedContact(phone: string, orgId = BMH_ORG_ID): Promise<string> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      first_name: "Resolve",
      last_name: phone.slice(-4),
      phone_1: phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function seedProperty(opts: {
  address: string;
  orgId?: string;
  homeownerContactId?: string | null;
  agentContactId?: string | null;
  outreachDispo?: string | null;
  needsHumanAttention?: boolean;
}): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      org_id: opts.orgId ?? BMH_ORG_ID,
      address: opts.address,
      state: "MO",
      status: "prospect",
      homeowner_contact_id: opts.homeownerContactId ?? null,
      agent_contact_id: opts.agentContactId ?? null,
      outreach_dispo: opts.outreachDispo ?? null,
      needs_human_attention: opts.needsHumanAttention ?? false,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function seedSms(opts: {
  contactId: string;
  propertyId: string | null;
  conversationId: string;
  direction: "inbound" | "outbound";
  status?: string;
  body?: string;
  phone?: string;
  businessPhone?: string;
  metadata?: Database["public"]["Tables"]["messages"]["Insert"]["metadata"];
  createdAt?: string;
}): Promise<string> {
  const phone = opts.phone ?? "+18165552000";
  const businessPhone = opts.businessPhone ?? "+18162804181";
  const { data, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: opts.direction,
      status:
        opts.status ?? (opts.direction === "inbound" ? "received" : "sent"),
      contact_id: opts.contactId,
      property_id: opts.propertyId,
      conversation_id: opts.conversationId,
      from_address: opts.direction === "inbound" ? phone : businessPhone,
      to_address: opts.direction === "inbound" ? businessPhone : phone,
      body: opts.body ?? "resolve test",
      metadata: opts.metadata ?? null,
      created_at: opts.createdAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function sourceConversation(contactId: string, phone: string): Promise<string> {
  const conversationId = randomUUID();
  await seedSms({
    contactId,
    propertyId: null,
    conversationId,
    direction: "inbound",
    phone,
    body: "which house?",
  });
  return conversationId;
}

async function destinationConversation(
  contactId: string,
  propertyId: string,
  phone: string,
): Promise<string> {
  const conversationId = await ensureConversationIdForThread(
    supabase,
    contactId,
    propertyId,
  );
  await seedSms({
    contactId,
    propertyId,
    conversationId,
    direction: "outbound",
    phone,
    body: "about the property",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return conversationId;
}

describe("resolveThreadToExistingProperty (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    await seedTwoOrgs(supabase);
  });

  afterAll(async () => {
    for (const userId of createdUserIds) {
      await supabase.auth.admin.deleteUser(userId);
    }
  });

  it("G1/G2/G9 resolves to ensureConversationIdForThread and collapses with an existing property thread", async () => {
    const phone = "+18165552101";
    const contactId = await seedContact(phone);
    const propertyId = await seedProperty({
      address: "101 Resolve Existing Ln",
      homeownerContactId: contactId,
    });
    const sourceConversationId = await sourceConversation(contactId, phone);
    const expectedConversationId = await destinationConversation(
      contactId,
      propertyId,
      phone,
    );

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversationId).toBe(expectedConversationId);
    expect(result.data.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const { data: messages } = await supabase
      .from("messages")
      .select("property_id, conversation_id, metadata")
      .eq("contact_id", contactId);
    expect(new Set(messages?.map((m) => m.conversation_id))).toEqual(
      new Set([expectedConversationId]),
    );
    expect(messages?.every((m) => m.property_id === propertyId)).toBe(true);
    expect(messages?.every((m) => m.metadata === null)).toBe(true);

    const threads = (await listThreads(supabase, {})).filter(
      (thread) => thread.contactId === contactId,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe(expectedConversationId);
    expect(threads[0].propertyId).toBe(propertyId);
  });

  it("G3 only restamps the selected source conversation when one contact has two propertyless conversations", async () => {
    const phone = "+18165552103";
    const contactId = await seedContact(phone);
    const propertyId = await seedProperty({ address: "103 Scoped Ln" });
    const sourceA = await sourceConversation(contactId, phone);
    const sourceB = await sourceConversation(contactId, phone);

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId: sourceA,
      contactId,
      propertyId,
    });
    expect(result.ok).toBe(true);

    const { data: rows } = await supabase
      .from("messages")
      .select("conversation_id, property_id")
      .eq("contact_id", contactId);
    const sourceBRows = rows?.filter((row) => row.conversation_id === sourceB);
    expect(sourceBRows).toHaveLength(1);
    expect(sourceBRows?.[0].property_id).toBeNull();
  });

  it("G4 refuses cross-org properties without updates and allows same-org non-candidates", async () => {
    const phone = "+18165552104";
    const contactId = await seedContact(phone, BMH_ORG_ID);
    const sourceConversationId = await sourceConversation(contactId, phone);
    const otherOrgProperty = await seedProperty({
      address: "104 Forbidden Ln",
      orgId: TEST_ORG_B_ID,
    });

    const forbidden = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId: otherOrgProperty,
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) {
      expect(forbidden.error.code).toBe("PROPERTY_FORBIDDEN");
    }

    const { data: stillNull } = await supabase
      .from("messages")
      .select("property_id")
      .eq("conversation_id", sourceConversationId);
    expect(stillNull?.every((row) => row.property_id === null)).toBe(true);

    const sameOrgNonCandidate = await seedProperty({
      address: "104 Operator Asserted Ln",
    });
    const allowed = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId: sameOrgNonCandidate,
    });
    expect(allowed.ok).toBe(true);
  });

  it("G5 refuses source conversations whose direction-aware phone mapping finds more than one contact", async () => {
    const contactA = await seedContact("+18165552105");
    const contactB = await seedContact("+18165552106");
    const propertyId = await seedProperty({ address: "105 Ambiguous Ln" });
    const conversationId = randomUUID();
    await seedSms({
      contactId: contactA,
      propertyId: null,
      conversationId,
      direction: "inbound",
      phone: "+18165552105",
    });
    await seedSms({
      contactId: contactB,
      propertyId: null,
      conversationId,
      direction: "inbound",
      phone: "+18165552106",
    });

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId: conversationId,
      contactId: contactA,
      propertyId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AMBIGUOUS_CONTACT");
    }
  });

  it("G7 refuses a role held by a different contact with zero mutation, and same-contact role is idempotent", async () => {
    const phone = "+18165552107";
    const contactId = await seedContact(phone);
    const occupyingContactId = await seedContact("+18165552170");
    const propertyId = await seedProperty({
      address: "107 Role Taken Ln",
      homeownerContactId: occupyingContactId,
    });
    const sourceConversationId = await sourceConversation(contactId, phone);

    const taken = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId,
      role: "homeowner",
    });
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.error.code).toBe("PROPERTY_ROLE_TAKEN");

    const [{ data: property }, { data: detail }, { data: rows }, { data: registry }] =
      await Promise.all([
        supabase
          .from("properties")
          .select("homeowner_contact_id")
          .eq("id", propertyId)
          .single(),
        supabase
          .from("homeowner_details")
          .select("contact_id")
          .eq("contact_id", contactId),
        supabase
          .from("messages")
          .select("property_id, conversation_id")
          .eq("conversation_id", sourceConversationId),
        supabase
          .from("message_threads")
          .select("conversation_id")
          .eq("contact_id", contactId)
          .eq("property_id", propertyId),
      ]);
    expect(property!.homeowner_contact_id).toBe(occupyingContactId);
    expect(detail).toEqual([]);
    expect(rows?.[0].property_id).toBeNull();
    expect(registry).toEqual([]);

    const sameContactProperty = await seedProperty({
      address: "107 Same Contact Ln",
      homeownerContactId: contactId,
    });
    const sameContactSource = await sourceConversation(contactId, phone);
    const sameContact = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId: sameContactSource,
      contactId,
      propertyId: sameContactProperty,
      role: "homeowner",
    });
    expect(sameContact.ok).toBe(true);
  });

  it("G8 allows a session-scoped non-admin member to resolve the thread", async () => {
    const phone = "+18165552108";
    const user = await createOrgUser(supabase, {
      orgId: BMH_ORG_ID,
      email: `resolve-member-${Date.now()}@example.test`,
      role: "member",
    });
    createdUserIds.push(user.userId);

    const contactId = await seedContact(phone);
    const propertyId = await seedProperty({ address: "108 Member Ln" });
    const sourceConversationId = await sourceConversation(contactId, phone);
    const memberClient = clientForUser(user.jwt);

    const result = await resolveThreadToExistingProperty({
      supabase: memberClient,
      sourceConversationId,
      contactId,
      propertyId,
    });

    expect(result.ok).toBe(true);
  });

  it("G10 leaves queued outbound rows in the source conversation untouched", async () => {
    const phone = "+18165552110";
    const contactId = await seedContact(phone);
    const propertyId = await seedProperty({ address: "110 Queued Ln" });
    const sourceConversationId = randomUUID();
    const liveId = await seedSms({
      contactId,
      propertyId: null,
      conversationId: sourceConversationId,
      direction: "inbound",
      phone,
    });
    const queuedId = await seedSms({
      contactId,
      propertyId: null,
      conversationId: sourceConversationId,
      direction: "outbound",
      status: "queued",
      phone,
    });

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId,
    });
    expect(result.ok).toBe(true);

    const { data: rows } = await supabase
      .from("messages")
      .select("id, property_id, conversation_id")
      .in("id", [liveId, queuedId]);
    const byId = new Map(rows?.map((row) => [row.id, row]));
    expect(byId.get(liveId)?.property_id).toBe(propertyId);
    expect(byId.get(queuedId)?.property_id).toBeNull();
    expect(byId.get(queuedId)?.conversation_id).toBe(sourceConversationId);
  });
});

describe("createPropertyAndResolve (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    await seedTwoOrgs(supabase);
  });

  it("creates a new property, links the role, and restamps the source conversation", async () => {
    const phone = "+18165552201";
    const contactId = await seedContact(phone);
    const sourceConversationId = await sourceConversation(contactId, phone);

    const result = await createPropertyAndResolve({
      supabase,
      sourceConversationId,
      contactId,
      role: "homeowner",
      property: {
        address: "201 Created Resolve Ln",
        city: "Kansas City",
        state: "MO",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: property } = await supabase
      .from("properties")
      .select("address, status, homeowner_contact_id, org_id")
      .eq("id", result.data.propertyId)
      .single();
    expect(property).toMatchObject({
      address: "201 Created Resolve Ln",
      status: "new_lead",
      homeowner_contact_id: contactId,
      org_id: BMH_ORG_ID,
    });

    const { data: messages } = await supabase
      .from("messages")
      .select("property_id, conversation_id")
      .eq("contact_id", contactId);
    expect(messages?.[0].property_id).toBe(result.data.propertyId);
    expect(messages?.[0].conversation_id).toBe(result.data.conversationId);
  });
});
