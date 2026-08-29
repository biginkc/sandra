import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { Client } from "pg";

import { createTestClient } from "@tests/integration/client";
import { loadTestEnv } from "@tests/integration/env";
import {
  BMH_ORG_ID,
  TEST_ORG_B_ID,
  clientForUser,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import {
  listThreadPage,
  listThreads,
  type ThreadPageFilter,
} from "./list-threads";
import { ensureConversationIdForThread } from "./threading";

const supabase = createTestClient();

type ScaleSnapshotRow = {
  thread_id: string;
  property_status: string | null;
  assignee_id: string | null;
  unread_count: number;
  needs_outcome: boolean;
  ai_responder_status: string | null;
  ai_disposition_review_id: string | null;
};

async function readScaleSnapshotUnderStatementTimeout(
  filter: ThreadPageFilter = "all",
  assigneeId: string | null = null,
): Promise<{
  durationMs: number;
  snapshot: {
    rows: ScaleSnapshotRow[];
    counts: Record<ThreadPageFilter, number>;
    total: number;
  };
}> {
  const env = loadTestEnv();
  const connectionString =
    process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!connectionString) throw new Error("missing TEST_SUPABASE_DB_URL");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '7000ms'");
    const startedAt = performance.now();
    const result = await client.query<{
      snapshot: {
        rows: ScaleSnapshotRow[];
        counts: Record<ThreadPageFilter, number>;
        total: number;
      };
    }>(
      `select public.sms_inbox_thread_page_snapshot(
        $1::timestamptz,
        $2::text,
        $3::uuid,
        null::uuid,
        false,
        200,
        0
      ) as snapshot`,
      [
        new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString(),
        filter,
        assigneeId,
      ],
    );
    return {
      durationMs: performance.now() - startedAt,
      snapshot: result.rows[0]!.snapshot,
    };
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

/**
 * Mint a real auth.users row so properties.assigned_user_id FK passes.
 * Idempotent — returns the existing user's id if the email already exists.
 */
async function mintTestUser(email: string): Promise<string> {
  let userId: string | null = null;
  for (let page = 1; ; page += 1) {
    const { data: existing, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    const found = existing?.users.find((u) => u.email === email);
    if (found) {
      userId = found.id;
      break;
    }
    if ((existing?.users.length ?? 0) < 200) break;
  }
  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: "irrelevant-for-test",
      email_confirm: true,
    });
    if (error || !data.user)
      throw error ?? new Error("createUser returned no user");
    userId = data.user.id;
  }
  const { error: membershipError } = await supabase.from("memberships").upsert(
    {
      user_id: userId,
      org_id: BMH_ORG_ID,
      role: "member",
      access_status: "active",
      deletion_prepared_at: null,
      access_expires_at: null,
    },
    { onConflict: "user_id,org_id" },
  );
  if (membershipError) throw membershipError;
  return userId;
}

async function seedConversation(opts: {
  contactName?: string;
  phone: string;
  messages: Array<{
    direction: "inbound" | "outbound";
    body: string;
    createdAtOffsetMin?: number;
    read?: boolean;
  }>;
}): Promise<{ contactId: string; propertyId: string }> {
  const { data: contact } = await supabase
    .from("contacts")
    .insert({
      first_name: opts.contactName ?? "Conv",
      last_name: "Test",
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  const { data: property } = await supabase
    .from("properties")
    .insert({
      address: `${Math.floor(Math.random() * 9000) + 1000} Conv Ln`,
      state: "MO",
      homeowner_contact_id: contact!.id,
    })
    .select("id")
    .single();

  for (const m of opts.messages) {
    const offsetMs = (m.createdAtOffsetMin ?? 0) * 60_000;
    const createdAt = new Date(Date.now() + offsetMs).toISOString();
    await supabase.from("messages").insert({
      channel: "sms",
      direction: m.direction,
      status: m.direction === "inbound" ? "received" : "sent",
      contact_id: contact!.id,
      property_id: property!.id,
      from_address: m.direction === "inbound" ? opts.phone : "+18162804181",
      to_address: m.direction === "inbound" ? "+18162804181" : opts.phone,
      body: m.body,
      created_at: createdAt,
      read_at:
        m.direction === "inbound" && m.read === true
          ? new Date().toISOString()
          : null,
    });
  }
  return { contactId: contact!.id, propertyId: property!.id };
}

describe("listThreads (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("pages truthfully beyond the former 20,000-thread production ceiling", async () => {
    const total = 20_005;
    const viewer = await createOrgUser(supabase, {
      orgId: BMH_ORG_ID,
      email: `thread-page-scale-${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    onTestFinished(async () => {
      await supabase.auth.admin.deleteUser(viewer.userId).catch(() => {});
    });
    const otherUser = await createOrgUser(supabase, {
      orgId: BMH_ORG_ID,
      email: `thread-page-scale-other-${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    onTestFinished(async () => {
      await supabase.auth.admin.deleteUser(otherUser.userId).catch(() => {});
    });
    const viewerId = viewer.userId;
    const contacts = Array.from({ length: total }, (_, index) => ({
      id: crypto.randomUUID(),
      first_name: `Scale ${index}`,
      last_name: "Thread",
      phone_1: `+1816${String(5_000_000 + index).padStart(7, "0")}`,
      phone_1_type: "mobile",
    }));
    const properties = contacts.map((contact, index) => ({
      id: crypto.randomUUID(),
      address: `${index + 1} Scale Test Ln`,
      state: "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
    }));
    const base = Date.now() - total * 1_000;
    const messages = contacts.map((contact, index) => ({
      id: crypto.randomUUID(),
      channel: "sms" as const,
      direction: "inbound" as const,
      status: "received",
      contact_id: contact.id,
      property_id: properties[index]!.id,
      conversation_id: crypto.randomUUID(),
      from_address: contact.phone_1,
      to_address: "+18162804181",
      body: `scale message ${index} ${"x".repeat(256 + (index % 8) * 137)}`,
      created_at: new Date(base + index * 1_000).toISOString(),
      read_at: index % 2 === 0 ? null : new Date().toISOString(),
    }));
    const historyMessages = contacts.map((contact, index) => ({
      channel: "sms" as const,
      direction: "outbound" as const,
      status: "sent",
      contact_id: contact.id,
      property_id: properties[index]!.id,
      conversation_id: messages[index]!.conversation_id,
      from_address: "+18162804181",
      to_address: contact.phone_1,
      body: `history ${index} ${String(index % 97).repeat(32 + (index % 5) * 11)}`,
      created_at: new Date(base - 86_400_000 + index * 1_000).toISOString(),
      read_at: null,
    }));

    for (let start = 0; start < total; start += 500) {
      const { error: contactError } = await supabase
        .from("contacts")
        .insert(contacts.slice(start, start + 500));
      if (contactError) throw contactError;
      const { error: propertyError } = await supabase
        .from("properties")
        .insert(properties.slice(start, start + 500));
      if (propertyError) throw propertyError;
      const { error: messageError } = await supabase
        .from("messages")
        .insert(messages.slice(start, start + 500));
      if (messageError) throw messageError;
    }
    for (let start = 0; start < total; start += 500) {
      const { error: historyError } = await supabase
        .from("messages")
        .insert(historyMessages.slice(start, start + 500));
      if (historyError) throw historyError;
    }

    const { error: leadUpdateError } = await supabase
      .from("properties")
      .upsert([
        {
          ...properties[0]!,
          status: "new_lead",
          assigned_user_id: viewerId,
        },
        {
          ...properties[1]!,
          status: "contacted",
          assigned_user_id: null,
        },
        {
          ...properties[4]!,
          status: "prospect",
          assigned_user_id: viewerId,
        },
        {
          ...properties[5]!,
          status: "new_lead",
          assigned_user_id: otherUser.userId,
        },
      ]);
    if (leadUpdateError) throw leadUpdateError;

    const { error: threadStateError } = await supabase
      .from("message_threads")
      .insert({
        org_id: BMH_ORG_ID,
        channel: "sms",
        contact_id: contacts[2]!.id,
        property_id: properties[2]!.id,
        conversation_id: messages[2]!.conversation_id,
        ai_responder_status: "escalated",
      });
    if (threadStateError) throw threadStateError;

    // The table intentionally denies service-role writes; production creates
    // reviews through its controlled RPC. Seed the read-path fixture directly
    // through the isolated test database connection.
    const testEnv = loadTestEnv();
    const scaleConnectionString =
      process.env.TEST_SUPABASE_DB_URL ?? testEnv.TEST_SUPABASE_DB_URL;
    if (!scaleConnectionString) throw new Error("missing TEST_SUPABASE_DB_URL");
    const scaleDb = new Client({ connectionString: scaleConnectionString });
    await scaleDb.connect();
    try {
      await scaleDb.query("begin");
      await scaleDb.query(
        `update public.properties
         set outreach_dispo = 'not_interested'
         where id = $1 and org_id = $2`,
        [properties[3]!.id, BMH_ORG_ID],
      );
      await scaleDb.query(
        `insert into public.ai_disposition_reviews (
           org_id, property_id, conversation_id, source_inbound_message_id,
           disposition, ai_reason, status
         ) values ($1, $2, $3, $4, 'not_interested', $5, 'pending')`,
        [
          BMH_ORG_ID,
          properties[3]!.id,
          messages[3]!.conversation_id,
          messages[3]!.id,
          "scale matrix pending review",
        ],
      );
      await scaleDb.query("commit");
    } catch (error) {
      await scaleDb.query("rollback").catch(() => {});
      throw error;
    } finally {
      await scaleDb.end();
    }

    const timedSnapshot = await readScaleSnapshotUnderStatementTimeout(
      "all",
      viewerId,
    );
    expect(timedSnapshot.durationMs).toBeLessThan(7_000);
    expect(timedSnapshot.snapshot.total).toBe(total);
    expect(timedSnapshot.snapshot.rows).toHaveLength(200);
    expect(timedSnapshot.snapshot.counts).toMatchObject({
      all: total,
      unread: Math.ceil(total / 2),
      needs_outcome: total - 1,
    });

    const expectedFilterTotals: Record<ThreadPageFilter, number> = {
      all: total,
      unread: Math.ceil(total / 2),
      needs_outcome: total - 1,
      mine: 1,
      unassigned: 1,
      escalated: 1,
      dispo: 1,
    };
    const exactScaleRows = {
      mine: {
        thread_id: messages[0]!.conversation_id,
        property_status: "new_lead",
        assignee_id: viewerId,
      },
      unassigned: {
        thread_id: messages[1]!.conversation_id,
        property_status: "contacted",
        assignee_id: null,
      },
      escalated: {
        thread_id: messages[2]!.conversation_id,
        ai_responder_status: "escalated",
      },
      dispo: {
        thread_id: messages[3]!.conversation_id,
        needs_outcome: false,
        ai_disposition_review_id: expect.any(String),
      },
    };
    for (const filter of [
      "unread",
      "needs_outcome",
      "mine",
      "unassigned",
      "escalated",
      "dispo",
    ] satisfies ThreadPageFilter[]) {
      const filteredSnapshot =
        await readScaleSnapshotUnderStatementTimeout(filter, viewerId);
      expect(
        filteredSnapshot.durationMs,
        `${filter} snapshot duration`,
      ).toBeLessThan(7_000);
      expect(filteredSnapshot.snapshot.counts.all).toBe(total);
      expect(filteredSnapshot.snapshot.total).toBe(
        expectedFilterTotals[filter],
      );
      expect(filteredSnapshot.snapshot.counts[filter]).toBe(
        expectedFilterTotals[filter],
      );
      expect(filteredSnapshot.snapshot.rows).toHaveLength(
        Math.min(expectedFilterTotals[filter], 200),
      );
      if (filter === "unread") {
        expect(
          filteredSnapshot.snapshot.rows.every((row) => row.unread_count > 0),
        ).toBe(true);
      }
      if (filter === "needs_outcome") {
        expect(
          filteredSnapshot.snapshot.rows.every((row) => row.needs_outcome),
        ).toBe(true);
      }
      if (filter in exactScaleRows) {
        expect(filteredSnapshot.snapshot.rows).toEqual([
          expect.objectContaining(
            exactScaleRows[filter as keyof typeof exactScaleRows],
          ),
        ]);
      }
    }

    const authenticatedClient = clientForUser(viewer.jwt);
    for (const filter of [
      "mine",
      "unassigned",
      "escalated",
      "dispo",
    ] satisfies ThreadPageFilter[]) {
      const page = await listThreadPage(authenticatedClient, {
        filter,
        currentUserId: viewerId,
        includeThreadId: null,
        hideNoise: false,
        page: 1,
      });
      const exactThreadByFilter: Record<
        "mine" | "unassigned" | "escalated" | "dispo",
        string
      > = {
        mine: messages[0]!.conversation_id,
        unassigned: messages[1]!.conversation_id,
        escalated: messages[2]!.conversation_id,
        dispo: messages[3]!.conversation_id,
      };
      expect(page.threads.map((thread) => thread.threadId)).toEqual([
        exactThreadByFilter[filter],
      ]);
      expect(page.counts[filter]).toBe(1);
      if (filter === "mine") {
        expect(page.threads[0]).toMatchObject({
          propertyStatus: "new_lead",
          assigneeId: viewerId,
        });
      }
      if (filter === "unassigned") {
        expect(page.threads[0]).toMatchObject({
          propertyStatus: "contacted",
          assigneeId: null,
        });
      }
      if (filter === "escalated") {
        expect(page.threads[0]?.aiResponderStatus).toBe("escalated");
      }
      if (filter === "dispo") {
        expect(page.threads[0]?.aiDispositionReview).not.toBeNull();
        expect(page.threads[0]?.needsOutcome).toBe(false);
      }
    }

    const firstPageStartedAt = performance.now();
    const page = await listThreadPage(supabase, {
      filter: "all",
      currentUserId: null,
      includeThreadId: null,
      hideNoise: false,
      page: 1,
    });
    const firstPageDurationMs = performance.now() - firstPageStartedAt;
    expect(page.counts.all).toBe(total);
    expect(page.counts.unread).toBe(Math.ceil(total / 2));
    expect(page.counts.needs_outcome).toBe(total - 1);
    expect(page.total).toBe(total);
    expect(page.threads).toHaveLength(200);
    expect(page.threads[0]?.lastMessageBody).toBe(
      `scale message ${total - 1} ${"x".repeat(256 + ((total - 1) % 8) * 137)}`,
    );
    expect(firstPageDurationMs).toBeLessThan(7_000);

    const secondPage = await listThreadPage(supabase, {
      filter: "all",
      currentUserId: null,
      includeThreadId: null,
      hideNoise: false,
      page: 2,
    });
    const selectedOnSecondPage = secondPage.threads[50]?.threadId;
    expect(selectedOnSecondPage).toBeDefined();
    const selectedSecondPage = await listThreadPage(supabase, {
      filter: "all",
      currentUserId: null,
      includeThreadId: selectedOnSecondPage ?? null,
      hideNoise: false,
      page: 2,
    });
    expect(
      selectedSecondPage.threads.some(
        (thread) => thread.threadId === selectedOnSecondPage,
      ),
    ).toBe(true);
  }, 180_000);

  it("keeps full-window counts, active filters, assignment, and hidden DNC in parity", async () => {
    const viewerId = await mintTestUser(
      `thread-page-counts-${crypto.randomUUID()}@example.com`,
    );
    const normal = await seedConversation({
      contactName: "Normal",
      phone: "+18165554101",
      messages: [{ direction: "inbound", body: "normal unread" }],
    });
    const dispositioned = await seedConversation({
      contactName: "Dispositioned",
      phone: "+18165554102",
      messages: [{ direction: "inbound", body: "has outcome", read: true }],
    });
    const escalated = await seedConversation({
      contactName: "Escalated",
      phone: "+18165554103",
      messages: [{ direction: "inbound", body: "needs a human" }],
    });
    const restricted = await seedConversation({
      contactName: "Restricted",
      phone: "+18165554104",
      messages: [{ direction: "inbound", body: "stop" }],
    });

    const { error: dispoError } = await supabase
      .from("properties")
      .update({ outreach_dispo: "nurture" })
      .eq("id", dispositioned.propertyId);
    if (dispoError) throw dispoError;
    const { error: assignError } = await supabase
      .from("properties")
      .update({ assigned_user_id: viewerId })
      .eq("id", escalated.propertyId);
    if (assignError) throw assignError;
    const { data: escalatedMessage, error: escalatedMessageError } =
      await supabase
        .from("messages")
        .select("conversation_id")
        .eq("property_id", escalated.propertyId)
        .single();
    if (escalatedMessageError || !escalatedMessage?.conversation_id) {
      throw (
        escalatedMessageError ?? new Error("missing escalated conversation")
      );
    }
    const { error: escalationError } = await supabase
      .from("message_threads")
      .update({ ai_responder_status: "escalated" })
      .eq("conversation_id", escalatedMessage.conversation_id);
    if (escalationError) throw escalationError;
    const { error: dncError } = await supabase
      .from("contacts")
      .update({ do_not_contact: true })
      .eq("id", restricted.contactId);
    if (dncError) throw dncError;

    const all = await listThreadPage(supabase, {
      filter: "all",
      currentUserId: viewerId,
      includeThreadId: null,
      hideNoise: true,
      page: 1,
    });
    expect(all.counts).toMatchObject({
      all: 3,
      mine: 1,
      unassigned: 2,
      unread: 2,
      escalated: 1,
      // An applied property outcome is not a pending Sandra Dispo review.
      // That queue is backed only by ai_disposition_reviews.
      dispo: 0,
      needs_outcome: 2,
    });
    expect(all.total).toBe(3);
    expect(all.hiddenCount).toBe(1);
    expect(all.threads.map((thread) => thread.contactId)).not.toContain(
      restricted.contactId,
    );

    const dispositionPage = await listThreadPage(supabase, {
      filter: "dispo",
      currentUserId: viewerId,
      includeThreadId: null,
      hideNoise: true,
      page: 1,
    });
    expect(dispositionPage.total).toBe(0);
    expect(dispositionPage.threads).toEqual([]);

    const withRestricted = await listThreadPage(supabase, {
      filter: "all",
      currentUserId: viewerId,
      includeThreadId: null,
      hideNoise: false,
      page: 1,
    });
    expect(withRestricted.counts.all).toBe(4);
    expect(withRestricted.hiddenCount).toBe(0);
    expect(withRestricted.threads.map((thread) => thread.contactId)).toContain(
      normal.contactId,
    );
  });

  it("returns only active-member tenant threads and fails closed after suspension", async () => {
    await seedTwoOrgs(supabase);
    const userA = await createOrgUser(supabase, {
      orgId: BMH_ORG_ID,
      email: `thread-snapshot-a-${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    const userB = await createOrgUser(supabase, {
      orgId: TEST_ORG_B_ID,
      email: `thread-snapshot-b-${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    const contactA = crypto.randomUUID();
    const contactB = crypto.randomUUID();
    const propertyA = crypto.randomUUID();
    const propertyB = crypto.randomUUID();
    const { error: contactsError } = await supabase.from("contacts").insert([
      {
        id: contactA,
        org_id: BMH_ORG_ID,
        first_name: "Org A",
        phone_1: "+18165554001",
        phone_1_type: "mobile",
      },
      {
        id: contactB,
        org_id: TEST_ORG_B_ID,
        first_name: "Org B",
        phone_1: "+18165554002",
        phone_1_type: "mobile",
      },
    ]);
    if (contactsError) throw contactsError;
    const { error: propertiesError } = await supabase
      .from("properties")
      .insert([
        {
          id: propertyA,
          org_id: BMH_ORG_ID,
          address: "1 Tenant A Ln",
          state: "MO",
          homeowner_contact_id: contactA,
        },
        {
          id: propertyB,
          org_id: TEST_ORG_B_ID,
          address: "2 Tenant B Ln",
          state: "MO",
          homeowner_contact_id: contactB,
        },
      ]);
    if (propertiesError) throw propertiesError;
    const { error: messagesError } = await supabase.from("messages").insert([
      {
        org_id: BMH_ORG_ID,
        channel: "sms",
        direction: "inbound",
        status: "received",
        contact_id: contactA,
        property_id: propertyA,
        conversation_id: crypto.randomUUID(),
        from_address: "+18165554001",
        to_address: "+18162804181",
        body: "tenant A only",
      },
      {
        org_id: TEST_ORG_B_ID,
        channel: "sms",
        direction: "inbound",
        status: "received",
        contact_id: contactB,
        property_id: propertyB,
        conversation_id: crypto.randomUUID(),
        from_address: "+18165554002",
        to_address: "+18162804182",
        body: "tenant B only",
      },
    ]);
    if (messagesError) throw messagesError;

    const pageA = await listThreadPage(clientForUser(userA.jwt), {
      filter: "all",
      currentUserId: userA.userId,
      includeThreadId: null,
      hideNoise: false,
      page: 1,
    });
    const pageB = await listThreadPage(clientForUser(userB.jwt), {
      filter: "all",
      currentUserId: userB.userId,
      includeThreadId: null,
      hideNoise: false,
      page: 1,
    });
    expect(pageA.threads.map((thread) => thread.contactId)).toEqual([contactA]);
    expect(pageB.threads.map((thread) => thread.contactId)).toEqual([contactB]);

    const threadsA = await listThreads(clientForUser(userA.jwt), {});
    const threadsB = await listThreads(clientForUser(userB.jwt), {});
    expect(threadsA.map((thread) => thread.contactId)).toEqual([contactA]);
    expect(threadsB.map((thread) => thread.contactId)).toEqual([contactB]);

    const { error: suspendError } = await supabase
      .from("memberships")
      .update({ access_status: "suspended" })
      .eq("user_id", userA.userId)
      .eq("org_id", BMH_ORG_ID);
    if (suspendError) throw suspendError;
    expect(
      (
        await listThreadPage(clientForUser(userA.jwt), {
          filter: "all",
          currentUserId: userA.userId,
          includeThreadId: null,
          hideNoise: false,
          page: 1,
        })
      ).threads,
    ).toEqual([]);
    expect(await listThreads(clientForUser(userA.jwt), {})).toEqual([]);

    const { error: expireError } = await supabase
      .from("memberships")
      .update({
        access_status: "active",
        access_expires_at: new Date(Date.now() - 60_000).toISOString(),
        deletion_prepared_at: null,
      })
      .eq("user_id", userA.userId)
      .eq("org_id", BMH_ORG_ID);
    if (expireError) throw expireError;
    expect(await listThreads(clientForUser(userA.jwt), {})).toEqual([]);

    const { error: deletionPreparedError } = await supabase
      .from("memberships")
      .update({
        access_status: "active",
        access_expires_at: null,
        deletion_prepared_at: new Date().toISOString(),
      })
      .eq("user_id", userA.userId)
      .eq("org_id", BMH_ORG_ID);
    if (deletionPreparedError) throw deletionPreparedError;
    expect(await listThreads(clientForUser(userA.jwt), {})).toEqual([]);
  });

  it("keeps a recreated contact opted out through durable org-scoped phone suppression", async () => {
    const phone = "+18165554991";
    const oldContactId = crypto.randomUUID();
    const newContactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    const { error: oldContactError } = await supabase.from("contacts").insert({
      id: oldContactId,
      org_id: BMH_ORG_ID,
      first_name: "Original suppressed",
      phone_1: phone,
      phone_1_type: "mobile",
    });
    if (oldContactError) throw oldContactError;
    const { error: suppressionError } = await supabase
      .from("sms_phone_suppressions")
      .insert({
        org_id: BMH_ORG_ID,
        channel: "sms",
        phone_e164: phone,
        source: "integration_recreated_contact",
        first_contact_id: oldContactId,
      });
    if (suppressionError) throw suppressionError;
    const { error: deleteError } = await supabase
      .from("contacts")
      .delete()
      .eq("id", oldContactId);
    if (deleteError) throw deleteError;

    const { error: recreatedContactError } = await supabase
      .from("contacts")
      .insert({
        id: newContactId,
        org_id: BMH_ORG_ID,
        first_name: "Recreated suppressed",
        phone_1: phone,
        phone_1_type: "mobile",
      });
    if (recreatedContactError) throw recreatedContactError;
    const { error: propertyError } = await supabase.from("properties").insert({
      id: propertyId,
      org_id: BMH_ORG_ID,
      address: "991 Durable Suppression Ln",
      state: "MO",
      status: "prospect",
      homeowner_contact_id: newContactId,
    });
    if (propertyError) throw propertyError;
    const { error: messageError } = await supabase.from("messages").insert({
      org_id: BMH_ORG_ID,
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: newContactId,
      property_id: propertyId,
      conversation_id: conversationId,
      from_address: "(816) 555-4991",
      to_address: "+18162804181",
      body: "Recreated contact still suppressed",
    });
    if (messageError) throw messageError;

    const threads = await listThreads(supabase, {});
    const recreated = threads.find(
      (thread) => thread.threadId === conversationId,
    );
    expect(recreated?.contactId).toBe(newContactId);
    expect(recreated?.isOptedOut).toBe(true);
    expect(recreated?.needsOutcome).toBe(false);
  });

  it.each([
    {
      otherRow: "eligible",
      otherStatus: "received",
      otherCreatedAt: () => new Date().toISOString(),
    },
    {
      otherRow: "older than the inbox cutoff",
      otherStatus: "received",
      otherCreatedAt: () =>
        new Date(Date.now() - 100 * 24 * 60 * 60 * 1_000).toISOString(),
    },
    {
      otherRow: "queued",
      otherStatus: "queued",
      otherCreatedAt: () => new Date().toISOString(),
    },
    {
      otherRow: "paused",
      otherStatus: "paused",
      otherCreatedAt: () => new Date().toISOString(),
    },
  ] as const)(
    "fails closed when a dual-active user sees an $otherRow row sharing an emitted conversation UUID across orgs",
    async ({ otherStatus, otherCreatedAt }) => {
      await seedTwoOrgs(supabase);
      const user = await createOrgUser(supabase, {
        orgId: BMH_ORG_ID,
        email: `thread-collision-${crypto.randomUUID()}@example.com`,
        role: "member",
      });
      try {
        const { error: secondMembershipError } = await supabase
          .from("memberships")
          .insert({
            user_id: user.userId,
            org_id: TEST_ORG_B_ID,
            role: "member",
          });
        if (secondMembershipError) throw secondMembershipError;

        const conversationId = crypto.randomUUID();
        const contactA = crypto.randomUUID();
        const contactB = crypto.randomUUID();
        const propertyA = crypto.randomUUID();
        const propertyB = crypto.randomUUID();
        const { error: contactsError } = await supabase
          .from("contacts")
          .insert([
            {
              id: contactA,
              org_id: BMH_ORG_ID,
              first_name: "Collision A",
              phone_1: "+18165554992",
              phone_1_type: "mobile",
            },
            {
              id: contactB,
              org_id: TEST_ORG_B_ID,
              first_name: "Collision B",
              phone_1: "+18165554993",
              phone_1_type: "mobile",
            },
          ]);
        if (contactsError) throw contactsError;
        const { error: propertiesError } = await supabase
          .from("properties")
          .insert([
            {
              id: propertyA,
              org_id: BMH_ORG_ID,
              address: "1 Collision A Ln",
              state: "MO",
              homeowner_contact_id: contactA,
            },
            {
              id: propertyB,
              org_id: TEST_ORG_B_ID,
              address: "2 Collision B Ln",
              state: "MO",
              homeowner_contact_id: contactB,
            },
          ]);
        if (propertiesError) throw propertiesError;
        const { error: messagesError } = await supabase
          .from("messages")
          .insert([
            {
              org_id: BMH_ORG_ID,
              channel: "sms",
              direction: "inbound",
              status: "received",
              contact_id: contactA,
              property_id: propertyA,
              conversation_id: conversationId,
              from_address: "+18165554992",
              to_address: "+18162804181",
              body: "collision A",
              created_at: new Date().toISOString(),
            },
            {
              org_id: TEST_ORG_B_ID,
              channel: "sms",
              direction: "inbound",
              status: otherStatus,
              contact_id: contactB,
              property_id: propertyB,
              conversation_id: conversationId,
              from_address: "+18165554993",
              to_address: "+18162804182",
              body: "collision B",
              created_at: otherCreatedAt(),
            },
          ]);
        if (messagesError) throw messagesError;

        await expect(listThreads(clientForUser(user.jwt), {})).rejects.toThrow(
          "cross_org_conversation_id_ambiguity",
        );
      } finally {
        await supabase.auth.admin.deleteUser(user.userId);
      }
    },
  );

  // Test case #1
  it("returns one row per contact/property thread with the most recent message", async () => {
    const { contactId } = await seedConversation({
      phone: "+18165550001",
      messages: [
        {
          direction: "outbound",
          body: "first reach-out",
          createdAtOffsetMin: -120,
        },
        {
          direction: "inbound",
          body: "interested, tell me more",
          createdAtOffsetMin: -60,
        },
        {
          direction: "outbound",
          body: "great — 2pm work?",
          createdAtOffsetMin: -30,
        },
      ],
    });

    const threads = await listThreads(supabase, {});

    const mine = threads.filter((t) => t.contactId === contactId);
    expect(mine).toHaveLength(1);
    expect(mine[0].lastMessageBody).toBe("great — 2pm work?");
    expect(mine[0].lastMessageDirection).toBe("outbound");
  });

  it("keeps separate threads when the same contact has two properties", async () => {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Split",
        last_name: "Thread",
        phone_1: "+18165550002",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();

    const { data: propertyA } = await supabase
      .from("properties")
      .insert({
        address: "100 Alpha Ct",
        state: "MO",
        homeowner_contact_id: contact!.id,
      })
      .select("id")
      .single();

    const { data: propertyB } = await supabase
      .from("properties")
      .insert({
        address: "200 Bravo Ct",
        state: "MO",
        homeowner_contact_id: contact!.id,
      })
      .select("id")
      .single();

    await supabase.from("messages").insert([
      {
        channel: "sms",
        direction: "outbound",
        status: "sent",
        contact_id: contact!.id,
        property_id: propertyA!.id,
        from_address: "+18162804181",
        to_address: "+18165550002",
        body: "Property A",
        created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
      {
        channel: "sms",
        direction: "inbound",
        status: "received",
        contact_id: contact!.id,
        property_id: propertyB!.id,
        from_address: "+18165550002",
        to_address: "+18162804182",
        body: "Property B",
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ]);

    const threads = await listThreads(supabase, {});
    const mine = threads.filter((thread) => thread.contactId === contact!.id);

    expect(mine).toHaveLength(2);
    expect(mine.map((thread) => thread.propertyId).sort()).toEqual(
      [propertyA!.id, propertyB!.id].sort(),
    );
    expect(new Set(mine.map((thread) => thread.threadId)).size).toBe(2);
  });

  it("uses one conversation id for concurrent first-send and first-reply races", async () => {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Race",
        last_name: "Thread",
        phone_1: "+18165550123",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();

    const { data: property } = await supabase
      .from("properties")
      .insert({
        address: "123 Race St",
        state: "MO",
        homeowner_contact_id: contact!.id,
      })
      .select("id")
      .single();

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        ensureConversationIdForThread(supabase, contact!.id, property!.id),
      ),
    );

    expect(new Set(attempts).size).toBe(1);

    const [conversationId] = attempts;
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "outbound",
      status: "sent",
      contact_id: contact!.id,
      property_id: property!.id,
      conversation_id: conversationId,
      from_address: "+18162804181",
      to_address: "+18165550123",
      body: "first send",
    });
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: contact!.id,
      property_id: property!.id,
      conversation_id: await ensureConversationIdForThread(
        supabase,
        contact!.id,
        property!.id,
      ),
      from_address: "+18165550123",
      to_address: "+18162804181",
      body: "first reply",
    });

    const { data: messages, error } = await supabase
      .from("messages")
      .select("conversation_id")
      .eq("contact_id", contact!.id)
      .eq("property_id", property!.id);

    expect(error).toBeNull();
    expect(new Set((messages ?? []).map((row) => row.conversation_id))).toEqual(
      new Set([conversationId]),
    );
  });

  // Test case #2
  it("sorts threads by most recent activity descending", async () => {
    const a = await seedConversation({
      contactName: "Alpha",
      phone: "+18165550010",
      messages: [
        { direction: "inbound", body: "older", createdAtOffsetMin: -180 },
      ],
    });
    const b = await seedConversation({
      contactName: "Bravo",
      phone: "+18165550011",
      messages: [
        { direction: "inbound", body: "newer", createdAtOffsetMin: -10 },
      ],
    });
    const c = await seedConversation({
      contactName: "Charlie",
      phone: "+18165550012",
      messages: [
        { direction: "inbound", body: "middle", createdAtOffsetMin: -90 },
      ],
    });

    const threads = await listThreads(supabase, {});
    const seeded = threads.filter((t) =>
      [a.contactId, b.contactId, c.contactId].includes(t.contactId),
    );
    expect(seeded.map((t) => t.contactId)).toEqual([
      b.contactId,
      c.contactId,
      a.contactId,
    ]);
  });

  // Test case #3
  it("computes unread count = inbound messages where read_at is null", async () => {
    const { contactId } = await seedConversation({
      phone: "+18165550020",
      messages: [
        {
          direction: "inbound",
          body: "1",
          createdAtOffsetMin: -60,
          read: true,
        },
        {
          direction: "inbound",
          body: "2",
          createdAtOffsetMin: -30,
          read: false,
        },
        {
          direction: "inbound",
          body: "3",
          createdAtOffsetMin: -10,
          read: false,
        },
        { direction: "outbound", body: "ack", createdAtOffsetMin: -5 },
      ],
    });

    const threads = await listThreads(supabase, {});
    const mine = threads.find((t) => t.contactId === contactId);
    expect(mine).toBeDefined();
    expect(mine!.unreadCount).toBe(2);
  });

  // Test case #4
  it("excludes contacts with no messages", async () => {
    const { data: contact } = await supabase
      .from("contacts")
      .insert({
        first_name: "Lonely",
        last_name: "Contact",
        phone_1: "+18165550030",
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    await supabase.from("properties").insert({
      address: "999 Lonely Ln",
      state: "MO",
      homeowner_contact_id: contact!.id,
    });

    const threads = await listThreads(supabase, {});
    expect(threads.find((t) => t.contactId === contact!.id)).toBeUndefined();
  });

  // Test case #5
  it("defaults to last 90 days; respects override", async () => {
    const old = await seedConversation({
      contactName: "OldThread",
      phone: "+18165550040",
      messages: [
        {
          direction: "inbound",
          body: "ancient",
          createdAtOffsetMin: -60 * 24 * 100,
        },
      ],
    });
    const recent = await seedConversation({
      contactName: "RecentThread",
      phone: "+18165550041",
      messages: [
        { direction: "inbound", body: "fresh", createdAtOffsetMin: -60 },
      ],
    });

    const defaultThreads = await listThreads(supabase, {});
    expect(
      defaultThreads.find((t) => t.contactId === old.contactId),
    ).toBeUndefined();
    expect(
      defaultThreads.find((t) => t.contactId === recent.contactId),
    ).toBeDefined();

    const allThreads = await listThreads(supabase, { sinceDays: 365 });
    expect(allThreads.find((t) => t.contactId === old.contactId)).toBeDefined();
  });

  // Test case #6
  it("excludes rows with contact_id IS NULL (Phase 2 surfaces those)", async () => {
    await supabase.from("messages").insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
      contact_id: null,
      property_id: null,
      from_address: "+18165550099",
      to_address: "+18162804181",
      body: "stranger speaking",
    });

    const threads = await listThreads(supabase, {});
    expect(threads.every((t) => t.contactId !== null)).toBe(true);
  });

  // Phase 3 — assignee surfacing
  it("returns assigneeId on each thread (null when unassigned)", async () => {
    const seeded = await seedConversation({
      phone: "+18165550200",
      messages: [
        { direction: "inbound", body: "needs claim", createdAtOffsetMin: -10 },
      ],
    });

    const threads = await listThreads(supabase, {});
    const t = threads.find((x) => x.contactId === seeded.contactId);
    expect(t).toBeDefined();
    expect(t!.assigneeId).toBeNull();
  });

  // Phase 3 — Test case #48
  it("assigneeId filter: returns only threads on properties assigned to that user", async () => {
    // properties.assigned_user_id has a real FK to auth.users, so we have to
    // mint actual users for the test. Createsv the users via auth.admin and
    // reads their ids back (auth.admin.createUser doesn't let us pick the id).
    const userA = await mintTestUser("assignee-a@example.com");
    const userB = await mintTestUser("assignee-b@example.com");

    const a = await seedConversation({
      phone: "+18165550210",
      messages: [
        { direction: "inbound", body: "for user A", createdAtOffsetMin: -10 },
      ],
    });
    const b = await seedConversation({
      phone: "+18165550211",
      messages: [
        { direction: "inbound", body: "for user B", createdAtOffsetMin: -20 },
      ],
    });
    const u = await seedConversation({
      phone: "+18165550212",
      messages: [
        { direction: "inbound", body: "unassigned", createdAtOffsetMin: -30 },
      ],
    });

    await supabase
      .from("properties")
      .update({ assigned_user_id: userA })
      .eq("id", a.propertyId);
    await supabase
      .from("properties")
      .update({ assigned_user_id: userB })
      .eq("id", b.propertyId);

    const mineForA = await listThreads(supabase, { assigneeId: userA });
    const ids = mineForA.map((t) => t.contactId);
    expect(ids).toContain(a.contactId);
    expect(ids).not.toContain(b.contactId);
    expect(ids).not.toContain(u.contactId);
  });

  // Phase 3 — Test case #49
  it("unassignedOnly: true returns only threads where assigned_user_id IS NULL", async () => {
    const userA = await mintTestUser("unassigned-test@example.com");

    const assigned = await seedConversation({
      phone: "+18165550220",
      messages: [
        { direction: "inbound", body: "claimed", createdAtOffsetMin: -10 },
      ],
    });
    const unassigned = await seedConversation({
      phone: "+18165550221",
      messages: [
        { direction: "inbound", body: "claim queue", createdAtOffsetMin: -20 },
      ],
    });

    await supabase
      .from("properties")
      .update({ assigned_user_id: userA })
      .eq("id", assigned.propertyId);

    const queue = await listThreads(supabase, { unassignedOnly: true });
    const ids = queue.map((t) => t.contactId);
    expect(ids).toContain(unassigned.contactId);
    expect(ids).not.toContain(assigned.contactId);
  });
});
