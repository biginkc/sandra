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
import {
  ensureConversationIdForThread,
  listResolverCandidatePropertiesForContact,
  resolveInboundThread,
} from "./threading";

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
  orgId?: string;
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
      org_id: opts.orgId ?? BMH_ORG_ID,
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

async function sourceConversation(
  contactId: string,
  phone: string,
  orgId = BMH_ORG_ID,
): Promise<string> {
  const conversationId = randomUUID();
  await seedSms({
    contactId,
    propertyId: null,
    conversationId,
    orgId,
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
  orgId = BMH_ORG_ID,
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
    orgId,
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
    const sourceConversationId = randomUUID();
    const seededMetadata: NonNullable<
      Database["public"]["Tables"]["messages"]["Insert"]["metadata"]
    > = {
      processing: {
        marker: "gate-3-preserve-metadata",
        attempts: 2,
        ready: true,
      },
      notification: {
        channel: "operator",
        deliveredAt: "2026-06-24T00:00:00.000Z",
      },
    };
    const sourceMessageId = await seedSms({
      contactId,
      propertyId: null,
      conversationId: sourceConversationId,
      direction: "inbound",
      phone,
      body: "which house?",
      metadata: seededMetadata,
    });
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
      .select("id, property_id, conversation_id, metadata")
      .eq("contact_id", contactId);
    expect(new Set(messages?.map((m) => m.conversation_id))).toEqual(
      new Set([expectedConversationId]),
    );
    expect(messages?.every((m) => m.property_id === propertyId)).toBe(true);
    expect(messages?.find((m) => m.id === sourceMessageId)?.metadata).toEqual(
      seededMetadata,
    );

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

  it("refuses archived properties without updates", async () => {
    const phone = "+18165552114";
    const contactId = await seedContact(phone);
    const propertyId = await seedProperty({ address: "114 Archived Ln" });
    await supabase
      .from("properties")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", propertyId);
    const sourceConversationId = await sourceConversation(contactId, phone);

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROPERTY_ARCHIVED");

    const { data: rows } = await supabase
      .from("messages")
      .select("property_id")
      .eq("conversation_id", sourceConversationId);
    expect(rows?.every((row) => row.property_id === null)).toBe(true);
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

  it("G5 refuses when source phone maps to a different supplied contact with zero mutation", async () => {
    const contactA = await seedContact("+18165552125");
    const contactB = await seedContact("+18165552126");
    const propertyId = await seedProperty({ address: "125 Wrong Contact Ln" });
    const sourceConversationId = await sourceConversation(
      contactA,
      "+18165552125",
    );

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId: contactB,
      propertyId,
      role: "homeowner",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AMBIGUOUS_CONTACT");
    }

    const [{ data: property }, { data: rows }, { data: detail }, { data: registry }] =
      await Promise.all([
        supabase
          .from("properties")
          .select("homeowner_contact_id, agent_contact_id")
          .eq("id", propertyId)
          .single(),
        supabase
          .from("messages")
          .select("contact_id, property_id, conversation_id")
          .eq("conversation_id", sourceConversationId),
        supabase
          .from("homeowner_details")
          .select("contact_id")
          .eq("contact_id", contactB),
        supabase
          .from("message_threads")
          .select("conversation_id")
          .eq("contact_id", contactB)
          .eq("property_id", propertyId),
      ]);
    expect(property).toMatchObject({
      homeowner_contact_id: null,
      agent_contact_id: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      contact_id: contactA,
      property_id: null,
      conversation_id: sourceConversationId,
    });
    expect(detail).toEqual([]);
    expect(registry).toEqual([]);
  });

  it("rejects invalid runtime roles before any mutation", async () => {
    const phone = "+18165552115";
    const contactId = await seedContact(phone);
    const propertyId = await seedProperty({ address: "115 Invalid Role Ln" });
    const sourceConversationId = await sourceConversation(contactId, phone);

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId,
      role: "landlord" as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_ROLE");

    const [{ data: property }, { data: rows }, { data: details }] =
      await Promise.all([
        supabase
          .from("properties")
          .select("homeowner_contact_id, agent_contact_id")
          .eq("id", propertyId)
          .single(),
        supabase
          .from("messages")
          .select("property_id")
          .eq("conversation_id", sourceConversationId),
        supabase.from("agent_details").select("contact_id").eq("contact_id", contactId),
      ]);
    expect(property).toMatchObject({
      homeowner_contact_id: null,
      agent_contact_id: null,
    });
    expect(rows?.every((row) => row.property_id === null)).toBe(true);
    expect(details).toEqual([]);
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
    if (!sameContact.ok) return;

    const [
      { data: sameContactPropertyRow },
      { data: sameContactDetails },
      { data: sameContactRows },
    ] = await Promise.all([
      supabase
        .from("properties")
        .select("homeowner_contact_id")
        .eq("id", sameContactProperty)
        .single(),
      supabase
        .from("homeowner_details")
        .select("contact_id")
        .eq("contact_id", contactId),
      supabase
        .from("messages")
        .select("property_id, conversation_id")
        .eq("conversation_id", sameContact.data.conversationId),
    ]);
    expect(sameContactPropertyRow?.homeowner_contact_id).toBe(contactId);
    expect(sameContactDetails).toEqual([{ contact_id: contactId }]);
    expect(sameContactRows).toHaveLength(1);
    expect(sameContactRows?.[0]).toMatchObject({
      property_id: sameContactProperty,
      conversation_id: sameContact.data.conversationId,
    });
  });

  it("links role sidecars in the contact org instead of the default org", async () => {
    const phone = "+18165552117";
    const contactId = await seedContact(phone, TEST_ORG_B_ID);
    const propertyId = await seedProperty({
      address: "117 Other Org Role Ln",
      orgId: TEST_ORG_B_ID,
    });
    const sourceConversationId = await sourceConversation(
      contactId,
      phone,
      TEST_ORG_B_ID,
    );

    const result = await resolveThreadToExistingProperty({
      supabase,
      sourceConversationId,
      contactId,
      propertyId,
      role: "agent",
    });

    expect(result.ok).toBe(true);

    const [{ data: property }, { data: detail }] = await Promise.all([
      supabase
        .from("properties")
        .select("agent_contact_id, org_id")
        .eq("id", propertyId)
        .single(),
      supabase
        .from("agent_details")
        .select("contact_id, org_id")
        .eq("contact_id", contactId)
        .single(),
    ]);
    expect(property).toMatchObject({
      agent_contact_id: contactId,
      org_id: TEST_ORG_B_ID,
    });
    expect(detail).toMatchObject({
      contact_id: contactId,
      org_id: TEST_ORG_B_ID,
    });
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

  it("fails without side effects when the source conversation has no eligible rows", async () => {
    const phone = "+18165552111";
    const contactId = await seedContact(phone);
    const propertyId = await seedProperty({ address: "111 Queued Only Ln" });
    const sourceConversationId = randomUUID();
    await seedSms({
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
      role: "homeowner",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOURCE_NO_ELIGIBLE_MESSAGES");
    }

    const [{ data: property }, { data: registry }, { data: detail }] =
      await Promise.all([
        supabase
          .from("properties")
          .select("homeowner_contact_id")
          .eq("id", propertyId)
          .single(),
        supabase
          .from("message_threads")
          .select("conversation_id")
          .eq("contact_id", contactId)
          .eq("property_id", propertyId),
        supabase
          .from("homeowner_details")
          .select("contact_id")
          .eq("contact_id", contactId),
      ]);
    expect(property?.homeowner_contact_id).toBeNull();
    expect(registry).toEqual([]);
    expect(detail).toEqual([]);
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

  it("creates the property and role sidecar in the source contact org", async () => {
    const phone = "+18165552202";
    const contactId = await seedContact(phone, TEST_ORG_B_ID);
    const sourceConversationId = await sourceConversation(
      contactId,
      phone,
      TEST_ORG_B_ID,
    );

    const result = await createPropertyAndResolve({
      supabase,
      sourceConversationId,
      contactId,
      role: "homeowner",
      property: {
        address: "202 Other Org Created Ln",
        city: "Kansas City",
        state: "MO",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [{ data: property }, { data: detail }] = await Promise.all([
      supabase
        .from("properties")
        .select("homeowner_contact_id, org_id")
        .eq("id", result.data.propertyId)
        .single(),
      supabase
        .from("homeowner_details")
        .select("contact_id, org_id")
        .eq("contact_id", contactId)
        .single(),
    ]);
    expect(property).toMatchObject({
      homeowner_contact_id: contactId,
      org_id: TEST_ORG_B_ID,
    });
    expect(detail).toMatchObject({
      contact_id: contactId,
      org_id: TEST_ORG_B_ID,
    });
  });

  it("does not create a property when no source rows are eligible", async () => {
    const phone = "+18165552203";
    const contactId = await seedContact(phone);
    const sourceConversationId = randomUUID();
    await seedSms({
      contactId,
      propertyId: null,
      conversationId: sourceConversationId,
      direction: "outbound",
      status: "queued",
      phone,
    });

    const result = await createPropertyAndResolve({
      supabase,
      sourceConversationId,
      contactId,
      role: "homeowner",
      property: {
        address: "203 Should Not Exist Ln",
        city: "Kansas City",
        state: "MO",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOURCE_NO_ELIGIBLE_MESSAGES");
    }

    const [{ data: properties }, { data: detail }] = await Promise.all([
      supabase
        .from("properties")
        .select("id")
        .eq("address", "203 Should Not Exist Ln"),
      supabase
        .from("homeowner_details")
        .select("contact_id")
        .eq("contact_id", contactId),
    ]);
    expect(properties).toEqual([]);
    expect(detail).toEqual([]);
  });
});

describe("listResolverCandidatePropertiesForContact (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    await seedTwoOrgs(supabase);
  });

  it("returns all active linked properties and excludes archived linked properties", async () => {
    const contactId = await seedContact("+18165552301");
    const linkedA = await seedProperty({
      address: "301 Linked A Ln",
      homeownerContactId: contactId,
    });
    const linkedB = await seedProperty({
      address: "301 Linked B Ln",
      agentContactId: contactId,
    });
    const linkedC = await seedProperty({
      address: "301 Linked C Ln",
      homeownerContactId: contactId,
    });
    const archived = await seedProperty({
      address: "301 Archived Linked Ln",
      agentContactId: contactId,
    });
    await supabase
      .from("properties")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", archived);

    const candidates = await listResolverCandidatePropertiesForContact(supabase, {
      contactId,
    });

    expect(candidates.map((candidate) => candidate.id).sort()).toEqual(
      [linkedA, linkedB, linkedC].sort(),
    );
    expect(candidates.every((candidate) => candidate.sources.includes("linked_property"))).toBe(
      true,
    );
  });
});

describe("resolveInboundThread multi-sender routing (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    await seedTwoOrgs(supabase);
  });

  it("routes an inbound reply to the property whose thread used the receiving sender number", async () => {
    // One seller phone, two properties, two DIFFERENT sending numbers —
    // the dynamic-sender case. The `to` number of the inbound reply must
    // select the property that was messaged from that sender.
    const sellerPhone = "+18165552401";
    const senderA = "+15551234567";
    const senderB = "+15559999999";

    const contactId = await seedContact(sellerPhone);
    const propertyA = await seedProperty({
      address: "401 Sender A Property",
      homeownerContactId: contactId,
    });
    const propertyB = await seedProperty({
      address: "402 Sender B Property",
      homeownerContactId: contactId,
    });

    const conversationA = await ensureConversationIdForThread(
      supabase,
      contactId,
      propertyA,
    );
    const conversationB = await ensureConversationIdForThread(
      supabase,
      contactId,
      propertyB,
    );

    await seedSms({
      contactId,
      propertyId: propertyA,
      conversationId: conversationA,
      direction: "outbound",
      phone: sellerPhone,
      businessPhone: senderA,
      body: "about property A",
    });
    await seedSms({
      contactId,
      propertyId: propertyB,
      conversationId: conversationB,
      direction: "outbound",
      phone: sellerPhone,
      businessPhone: senderB,
      body: "about property B",
    });

    // Reply to sender B → property B's thread.
    const toB = await resolveInboundThread(supabase, sellerPhone, senderB);
    expect(toB).toMatchObject({
      contactId,
      propertyId: propertyB,
      conversationId: conversationB,
      resolution: "matched_recipient_number",
    });

    // Reply to sender A → property A's thread.
    const toA = await resolveInboundThread(supabase, sellerPhone, senderA);
    expect(toA).toMatchObject({
      contactId,
      propertyId: propertyA,
      conversationId: conversationA,
      resolution: "matched_recipient_number",
    });
  });

  it("stays contact-level (ambiguous) when one sender messaged multiple properties for the same contact", async () => {
    const sellerPhone = "+18165552402";
    const sharedSender = "+15551234567";

    const contactId = await seedContact(sellerPhone);
    const propertyA = await seedProperty({
      address: "403 Shared Sender A",
      homeownerContactId: contactId,
    });
    const propertyB = await seedProperty({
      address: "404 Shared Sender B",
      homeownerContactId: contactId,
    });

    const conversationA = await ensureConversationIdForThread(
      supabase,
      contactId,
      propertyA,
    );
    const conversationB = await ensureConversationIdForThread(
      supabase,
      contactId,
      propertyB,
    );

    await seedSms({
      contactId,
      propertyId: propertyA,
      conversationId: conversationA,
      direction: "outbound",
      phone: sellerPhone,
      businessPhone: sharedSender,
      body: "about property A",
    });
    await seedSms({
      contactId,
      propertyId: propertyB,
      conversationId: conversationB,
      direction: "outbound",
      phone: sellerPhone,
      businessPhone: sharedSender,
      body: "about property B",
    });

    const resolved = await resolveInboundThread(
      supabase,
      sellerPhone,
      sharedSender,
    );
    expect(resolved.resolution).toBe("ambiguous_recipient_number");
    expect(resolved.contactId).toBe(contactId);
    expect(resolved.propertyId).toBeNull();
  });
});
