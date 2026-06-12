import type { SupabaseClient } from "@supabase/supabase-js";

import { computeConsentState } from "@/lib/messaging/consent";
import type { Database } from "@/lib/supabase/types";
import {
  buildThreadId,
  parseThreadId,
  type ParsedThreadId,
} from "./threading";

export type Thread = {
  threadId: string;
  conversationId: string | null;
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
  /** True when properties.needs_human_attention is set — AI responder
   *  flagged this thread for human review. */
  needsHumanAttention: boolean;
  /** Latest escalation reason in `<gate>:<detail>` format, or null.
   *  Pass to <EscalationBadge> for color-coded rendering. */
  escalationReason: string | null;
  /** True when the contact's most recent SMS consent event was an opt-out
   *  (STOP keyword, manual DNC, provider auto-opt-out). Computed via
   *  `computeConsentState` on the latest consent_events for the contact.
   *  The inbox uses this to drive the DNC toggle (hidden by default). */
  isOptedOut: boolean;
  /** True when the thread belongs to Jitter test infrastructure (canary /
   *  rehearsal contacts and synthetic addresses). Hidden by the same
   *  inbox toggle as DNC — both are noise, one switch. */
  isTestTraffic: boolean;
};

/** Match Jitter's test-fixture CONTRACT precisely, not generic human
 *  text. Fixtures always present as one of:
 *   - contact "Canary CANARY-<TYPE>-<ts>" (first name literally Canary,
 *     last name a CANARY- token) — matched as a name PREFIX
 *   - synthetic address starting "Jitter " or "JITTER-" ("Jitter Canary
 *     … Golden Path Ln", "Jitter Rehearsal …", "JITTER-SANDRA-V1 …")
 *  A homeowner on "123 Canary Ln", a seller surnamed Canary, or a
 *  "Jitterbug Dr" address never matches — those are substrings, not
 *  prefixes of the fixture shapes. */
export function looksLikeTestTraffic(
  contactName: string | null,
  propertyAddress: string | null,
): boolean {
  const name = (contactName ?? "").trim().toLowerCase();
  if (name.startsWith("canary canary-")) return true;
  const address = (propertyAddress ?? "").trim().toLowerCase();
  return address.startsWith("jitter ") || address.startsWith("jitter-");
}

export type ListThreadsOpts = {
  /** Window for "active" conversations. Defaults to 90 days. */
  sinceDays?: number;
  /** When set, returns only threads on properties assigned to this user. */
  assigneeId?: string;
  /** When true, returns only threads on properties with no assignee. */
  unassignedOnly?: boolean;
  /** When true, returns only threads with at least one unread inbound message. */
  unreadOnly?: boolean;
  /** Thread id exempt from the `unreadOnly` filter. The cockpit passes the
   *  currently open thread so read-on-open doesn't yank it out of the
   *  Unread list while the user is still looking at it. Accepts any of the
   *  URL formats (conversation UUID, `legacy:contact:property`, bare
   *  contact id) — matching is by parsed identity, not raw string. */
  includeThreadId?: string;
};

/**
 * Build the inbox thread list — one row per contact/property thread,
 * using `messages.conversation_id` when available and falling back to a
 * legacy contact+property key for older rows.
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
      "contact_id, property_id, conversation_id, body, direction, created_at, read_at",
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
  const byThread = new Map<string, Bucket>();
  for (const m of msgs) {
    const cid = m.contact_id!;
    const threadId = buildThreadId(m.conversation_id, cid, m.property_id);
    let bucket = byThread.get(threadId);
    if (!bucket) {
      bucket = { latest: m, propertyId: m.property_id, unreadCount: 0 };
      byThread.set(threadId, bucket);
    }
    if (m.direction === "inbound" && m.read_at === null) {
      bucket.unreadCount += 1;
    }
  }

  const contactIds = Array.from(
    new Set(
      msgs
        .map((m) => m.contact_id)
        .filter((contactId): contactId is string => contactId !== null),
    ),
  );
  const propertyIds = Array.from(
    new Set(
      Array.from(byThread.values())
        .map((b) => b.propertyId)
        .filter((p): p is string => p !== null),
    ),
  );

  // PostgREST rejects oversized IN clauses (URL length limit, ~8 KB).
  // Split into batches so an active inbox with hundreds of contacts still loads.
  const CHUNK = 250;

  const [contactsRows, propsRows, consentRows] = await Promise.all([
    fetchInChunks(contactIds, CHUNK, (chunk) =>
      supabase
        .from("contacts")
        .select("id, first_name, last_name, entity_name, phone_1")
        .in("id", chunk),
    ),
    fetchInChunks(propertyIds, CHUNK, (chunk) =>
      supabase
        .from("properties")
        .select(
          "id, address, city, state, assigned_user_id, needs_human_attention, last_ai_escalation_reason",
        )
        .in("id", chunk),
    ),
    fetchInChunks(contactIds, CHUNK, (chunk) =>
      supabase
        .from("consent_events")
        .select("contact_id, event_type, occurred_at")
        .eq("channel", "sms")
        .in("contact_id", chunk)
        .order("occurred_at", { ascending: false }),
    ),
  ]);

  const contactById = new Map(contactsRows.map((c) => [c.id, c]));
  const propertyById = new Map(propsRows.map((p) => [p.id, p]));

  // Group consent events by contact for one computeConsentState call per
  // contact. Events are already ordered desc by the query.
  const consentEventsByContact = new Map<
    string,
    Array<{ event_type: string; occurred_at: string }>
  >();
  for (const ev of consentRows) {
    const list = consentEventsByContact.get(ev.contact_id) ?? [];
    list.push({ event_type: ev.event_type, occurred_at: ev.occurred_at });
    consentEventsByContact.set(ev.contact_id, list);
  }

  const pinned = opts.includeThreadId
    ? parseThreadId(opts.includeThreadId)
    : null;

  const threads: Thread[] = [];
  for (const [threadId, bucket] of byThread) {
    const contactId = bucket.latest.contact_id!;
    const c = contactById.get(contactId);
    const p = bucket.propertyId ? propertyById.get(bucket.propertyId) : null;

    if (opts.assigneeId && p?.assigned_user_id !== opts.assigneeId) continue;
    if (opts.unassignedOnly && p?.assigned_user_id) continue;
    if (
      opts.unreadOnly &&
      bucket.unreadCount === 0 &&
      !(pinned !== null && matchesPinnedThread(pinned, threadId, bucket))
    )
      continue;

    const consentState = computeConsentState(
      consentEventsByContact.get(contactId) ?? [],
    );

    threads.push({
      threadId,
      conversationId: bucket.latest.conversation_id,
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
      needsHumanAttention: p?.needs_human_attention ?? false,
      escalationReason: p?.last_ai_escalation_reason ?? null,
      isOptedOut: consentState === "opted_out",
      isTestTraffic: looksLikeTestTraffic(
        c
          ? (c.entity_name ??
            ([c.first_name, c.last_name].filter(Boolean).join(" ") || null))
          : null,
        p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : null,
      ),
    });
  }

  // Sort: most-recent first, full stop. Rows move only when a new message
  // arrives — reading a thread must never reposition it. This retires the
  // feedback-f E2a unread-first bubbling; the dedicated Unread chip is now
  // the "what needs attention" view.
  threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return threads;
}

/**
 * True when a thread bucket is the one the cockpit pinned via
 * `includeThreadId`. Compares parsed identity rather than raw strings:
 * the URL can carry a stale format (legacy key or bare contact id) for a
 * thread that is now grouped under a conversation UUID, and an exact
 * string compare would silently drop the pin (Codex P1 on PR #268).
 */
function matchesPinnedThread(
  pinned: ParsedThreadId,
  threadId: string,
  bucket: {
    latest: { contact_id: string | null; conversation_id: string | null };
    propertyId: string | null;
  },
): boolean {
  switch (pinned.kind) {
    case "conversation":
      return (
        threadId === pinned.conversationId ||
        bucket.latest.conversation_id === pinned.conversationId
      );
    case "legacy":
      return (
        bucket.latest.contact_id === pinned.contactId &&
        (bucket.propertyId ?? null) === pinned.propertyId
      );
    case "contact":
      return bucket.latest.contact_id === pinned.contactId;
  }
}

/**
 * Run a Supabase `.in("id", chunk)` query in batches and concatenate the rows.
 * Throws if any chunk errors. Returns [] for an empty input without hitting the
 * network (PostgREST treats `id=in.()` as a 400).
 */
async function fetchInChunks<T>(
  ids: string[],
  chunkSize: number,
  query: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  const results = await Promise.all(chunks.map((c) => query(c)));
  const rows: T[] = [];
  for (const r of results) {
    if (r.error) throw new Error(`listThreads chunk: ${r.error.message}`);
    if (r.data) rows.push(...r.data);
  }
  return rows;
}
