import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

import { listThreads } from "./list-threads";

const supabase = createTestClient();

/**
 * Mint a real auth.users row so properties.assigned_user_id FK passes.
 * Idempotent — returns the existing user's id if the email already exists.
 */
async function mintTestUser(email: string): Promise<string> {
  const { data: existing } = await supabase.auth.admin.listUsers({
    perPage: 200,
  });
  const found = existing?.users.find((u) => u.email === email);
  if (found) return found.id;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: "irrelevant-for-test",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser returned no user");
  return data.user.id;
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

  // Test case #1
  it("returns one row per contact_id with the most recent message", async () => {
    const { contactId } = await seedConversation({
      phone: "+18165550001",
      messages: [
        { direction: "outbound", body: "first reach-out", createdAtOffsetMin: -120 },
        { direction: "inbound", body: "interested, tell me more", createdAtOffsetMin: -60 },
        { direction: "outbound", body: "great — 2pm work?", createdAtOffsetMin: -30 },
      ],
    });

    const threads = await listThreads(supabase, {});

    const mine = threads.filter((t) => t.contactId === contactId);
    expect(mine).toHaveLength(1);
    expect(mine[0].lastMessageBody).toBe("great — 2pm work?");
    expect(mine[0].lastMessageDirection).toBe("outbound");
  });

  // Test case #2
  it("sorts threads by most recent activity descending", async () => {
    const a = await seedConversation({
      contactName: "Alpha",
      phone: "+18165550010",
      messages: [{ direction: "inbound", body: "older", createdAtOffsetMin: -180 }],
    });
    const b = await seedConversation({
      contactName: "Bravo",
      phone: "+18165550011",
      messages: [{ direction: "inbound", body: "newer", createdAtOffsetMin: -10 }],
    });
    const c = await seedConversation({
      contactName: "Charlie",
      phone: "+18165550012",
      messages: [{ direction: "inbound", body: "middle", createdAtOffsetMin: -90 }],
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
        { direction: "inbound", body: "1", createdAtOffsetMin: -60, read: true },
        { direction: "inbound", body: "2", createdAtOffsetMin: -30, read: false },
        { direction: "inbound", body: "3", createdAtOffsetMin: -10, read: false },
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
      .insert({ first_name: "Lonely", last_name: "Contact", phone_1: "+18165550030" })
      .select("id")
      .single();
    await supabase
      .from("properties")
      .insert({
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
        { direction: "inbound", body: "ancient", createdAtOffsetMin: -60 * 24 * 100 },
      ],
    });
    const recent = await seedConversation({
      contactName: "RecentThread",
      phone: "+18165550041",
      messages: [{ direction: "inbound", body: "fresh", createdAtOffsetMin: -60 }],
    });

    const defaultThreads = await listThreads(supabase, {});
    expect(
      defaultThreads.find((t) => t.contactId === old.contactId),
    ).toBeUndefined();
    expect(
      defaultThreads.find((t) => t.contactId === recent.contactId),
    ).toBeDefined();

    const allThreads = await listThreads(supabase, { sinceDays: 365 });
    expect(
      allThreads.find((t) => t.contactId === old.contactId),
    ).toBeDefined();
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
      messages: [{ direction: "inbound", body: "needs claim", createdAtOffsetMin: -10 }],
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
      messages: [{ direction: "inbound", body: "for user A", createdAtOffsetMin: -10 }],
    });
    const b = await seedConversation({
      phone: "+18165550211",
      messages: [{ direction: "inbound", body: "for user B", createdAtOffsetMin: -20 }],
    });
    const u = await seedConversation({
      phone: "+18165550212",
      messages: [{ direction: "inbound", body: "unassigned", createdAtOffsetMin: -30 }],
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
      messages: [{ direction: "inbound", body: "claimed", createdAtOffsetMin: -10 }],
    });
    const unassigned = await seedConversation({
      phone: "+18165550221",
      messages: [{ direction: "inbound", body: "claim queue", createdAtOffsetMin: -20 }],
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
