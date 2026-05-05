import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type Thread = {
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  propertyId: string | null;
  propertyAddress: string | null;
  /** auth.users.id of whoever is assigned to the property, or null. */
  assigneeId: string | null;
  lastMessageBody: string;
  lastMessageDirection: "inbound" | "outbound";
  lastMessageAt: string;
  unreadCount: number;
};

export type ListThreadsOpts = {
  /** Window for "active" conversations. Defaults to 90 days. */
  sinceDays?: number;
  /** When set, returns only threads on properties assigned to this user. */
  assigneeId?: string;
  /** When true, returns only threads on properties with no assignee. */
  unassignedOnly?: boolean;
};

/**
 * Build the inbox thread list — one row per contact, sorted by most
 * recent activity, with last-message preview and unread count.
 *
 * Strategy: fetch all messages in the window in one round-trip, group
 * by contact in JS, then batch-fetch contact + property info. Keeps
 * the implementation migration-free; if this gets slow we can promote
 * to a Postgres view or RPC.
 *
 * Excludes rows with `contact_id IS NULL` — those are unmatched
 * inbounds surfaced via the Phase 2 "Unknown" filter.
 */
export async function listThreads(
  supabase: SupabaseClient<Database>,
  opts: ListThreadsOpts,
): Promise<Thread[]> {
  const sinceDays = opts.sinceDays ?? 90;
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: msgs, error } = await supabase
    .from("messages")
    .select(
      "contact_id, property_id, body, direction, created_at, read_at",
    )
    .eq("channel", "sms")
    .not("contact_id", "is", null)
    .neq("status", "queued")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listThreads: ${error.message}`);
  if (!msgs || msgs.length === 0) return [];

  type Bucket = {
    latest: typeof msgs[number];
    propertyId: string | null;
    unreadCount: number;
  };
  const byContact = new Map<string, Bucket>();
  for (const m of msgs) {
    const cid = m.contact_id!;
    let bucket = byContact.get(cid);
    if (!bucket) {
      bucket = { latest: m, propertyId: m.property_id, unreadCount: 0 };
      byContact.set(cid, bucket);
    }
    if (m.direction === "inbound" && m.read_at === null) {
      bucket.unreadCount += 1;
    }
  }

  const contactIds = Array.from(byContact.keys());
  const propertyIds = Array.from(
    new Set(
      Array.from(byContact.values())
        .map((b) => b.propertyId)
        .filter((p): p is string => p !== null),
    ),
  );

  const [contactsRes, propsRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, first_name, last_name, entity_name, phone_1")
      .in("id", contactIds),
    propertyIds.length > 0
      ? supabase
          .from("properties")
          .select("id, address, city, state, assigned_user_id")
          .in("id", propertyIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contactsRes.error) {
    throw new Error(`listThreads contacts: ${contactsRes.error.message}`);
  }
  if (propsRes.error) {
    throw new Error(`listThreads properties: ${propsRes.error.message}`);
  }

  const contactById = new Map(
    (contactsRes.data ?? []).map((c) => [c.id, c]),
  );
  const propertyById = new Map(
    (propsRes.data ?? []).map((p) => [p.id, p]),
  );

  const threads: Thread[] = [];
  for (const [contactId, bucket] of byContact) {
    const c = contactById.get(contactId);
    const p = bucket.propertyId ? propertyById.get(bucket.propertyId) : null;

    if (opts.assigneeId && p?.assigned_user_id !== opts.assigneeId) continue;
    if (opts.unassignedOnly && p?.assigned_user_id) continue;

    threads.push({
      contactId,
      contactName: c
        ? (c.entity_name ??
          ([c.first_name, c.last_name].filter(Boolean).join(" ") || null))
        : null,
      contactPhone: c?.phone_1 ?? null,
      propertyId: bucket.propertyId,
      propertyAddress: p
        ? [p.address, p.city, p.state].filter(Boolean).join(", ")
        : null,
      assigneeId: p?.assigned_user_id ?? null,
      lastMessageBody: bucket.latest.body,
      lastMessageDirection: bucket.latest.direction as "inbound" | "outbound",
      lastMessageAt: bucket.latest.created_at,
      unreadCount: bucket.unreadCount,
    });
  }

  threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return threads;
}
