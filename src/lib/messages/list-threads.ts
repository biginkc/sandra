import type { SupabaseClient } from "@supabase/supabase-js";

import { computeConsentState } from "@/lib/messaging/consent";
import type { Database } from "@/lib/supabase/types";
import type { AiResponderThreadStatus } from "./ai-responder-thread-state";
import { deriveSmsParties } from "./sms-parties";

export type Thread = {
  /** The conversation UUID — the one and only thread identity since
   *  migration 081. */
  threadId: string;
  contactId: string;
  contactName: string | null;
  /** Actual customer-side phone on the latest SMS in this conversation. */
  threadCustomerPhone: string | null;
  /** Actual Sandra/business-side phone on the latest SMS in this conversation. */
  threadBusinessPhone: string | null;
  /** Backward-compatible alias for threadCustomerPhone. */
  contactPhone: string | null;
  propertyId: string | null;
  propertyAddress: string | null;
  propertyStatus: string | null;
  outreachDispo: string | null;
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
   *  (STOP keyword, manual DNC, provider auto-opt-out), or the contact-level
   *  DNC/SMS opt-out flags are set. The inbox uses this to drive the DNC
   *  toggle (hidden by default). */
  isOptedOut: boolean;
  /** True when the thread belongs to Jitter test infrastructure (canary /
   *  rehearsal contacts and synthetic addresses). Hidden by the same
   *  inbox toggle as DNC — both are noise, one switch. */
  isTestTraffic: boolean;
  /** True when this replied outreach thread still needs an operator outcome. */
  needsOutcome: boolean;
  /** Current thread-level state written by Sandra's SMS AI responder. */
  aiResponderStatus: AiResponderThreadStatus | null;
  aiResponderReason: string | null;
  aiResponderStatusAt: string | null;
  aiLastDeliveryStatus: string | null;
  aiLastDeliveryError: string | null;
};

const NEEDS_OUTCOME_STATUSES = new Set(["prospect", "new_lead", "contacted"]);

function isNeedsOutcomeThread(input: {
  propertyId: string | null;
  hasInbound: boolean;
  propertyStatus: string | null | undefined;
  outreachDispo: string | null | undefined;
  isOptedOut: boolean;
}): boolean {
  return (
    input.propertyId !== null &&
    input.hasInbound &&
    input.outreachDispo == null &&
    !input.isOptedOut &&
    NEEDS_OUTCOME_STATUSES.has(input.propertyStatus ?? "")
  );
}

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
  /** Canonical conversation UUID exempt from the `unreadOnly` filter.
   *  The cockpit passes the currently open thread so read-on-open doesn't
   *  yank it out of the Unread list while the user is still looking at
   *  it. Stale URL formats are translated upstream by
   *  `canonicalizeThreadId` — this is always an exact id. */
  includeThreadId?: string;
  /** When true, returns only threads Sandra escalated for human review. */
  escalatedOnly?: boolean;
  /** When true, returns only threads Sandra's AI responder handled. */
  handledOnly?: boolean;
  /** When true, returns only threads with an applied outreach disposition. */
  dispoOnly?: boolean;
  /** When true, returns only replied outreach threads with no outreach outcome. */
  needsOutcomeOnly?: boolean;
};

export type NeedsOutcomeCountOpts = {
  /** Window for "active" conversations. Defaults to 90 days. */
  sinceDays?: number;
  /** Backward-compatible no-op: Needs Outcome always excludes opt-outs. */
  hideOptedOut?: boolean;
  /** When true, excludes known Jitter canary/rehearsal fixture traffic. */
  hideTestTraffic?: boolean;
};

/**
 * Build the inbox thread list — one row per conversation. Every
 * contact-bearing SMS row carries a conversation_id (backfilled and
 * trigger-enforced by migration 081), so grouping is a plain key lookup.
 *
 * Strategy: fetch all messages in the window in one round-trip, group
 * by conversation in JS, then batch-fetch contact + property info. Keeps
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
      "contact_id, property_id, conversation_id, body, direction, from_address, to_address, created_at, read_at",
    )
    .eq("channel", "sms")
    .not("contact_id", "is", null)
    .not("conversation_id", "is", null)
    .neq("status", "queued")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listThreads: ${error.message}`);
  if (!msgs || msgs.length === 0) return [];

  type Bucket = {
    latest: typeof msgs[number];
    propertyId: string | null;
    unreadCount: number;
    hasInbound: boolean;
  };
  const byThread = new Map<string, Bucket>();
  for (const m of msgs) {
    const threadId = m.conversation_id!;
    let bucket = byThread.get(threadId);
    if (!bucket) {
      bucket = {
        latest: m,
        propertyId: m.property_id,
        unreadCount: 0,
        hasInbound: false,
      };
      byThread.set(threadId, bucket);
    }
    if (bucket.propertyId === null && m.property_id !== null) {
      bucket.propertyId = m.property_id;
    }
    if (m.direction === "inbound") {
      bucket.hasInbound = true;
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
  const threadIds = Array.from(byThread.keys());

  // PostgREST rejects oversized IN clauses (URL length limit, ~8 KB).
  // Split into batches so an active inbox with hundreds of contacts still loads.
  const CHUNK = 250;

  const [contactsRows, propsRows, consentRows, threadRows] = await Promise.all([
    fetchInChunks(contactIds, CHUNK, (chunk) =>
      supabase
        .from("contacts")
        .select(
          "id, first_name, last_name, entity_name, phone_1, do_not_contact, sms_opted_out",
        )
        .in("id", chunk),
    ),
    fetchInChunks(propertyIds, CHUNK, (chunk) =>
      supabase
        .from("properties")
        .select(
          "id, address, city, state, status, outreach_dispo, assigned_user_id, needs_human_attention, last_ai_escalation_reason",
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
    fetchInChunks(threadIds, CHUNK, (chunk) =>
      supabase
        .from("message_threads")
        .select(
          "conversation_id, ai_responder_status, ai_responder_reason, ai_responder_status_at, ai_last_delivery_status, ai_last_delivery_error",
        )
        .in("conversation_id", chunk),
    ),
  ]);

  const contactById = new Map(contactsRows.map((c) => [c.id, c]));
  const propertyById = new Map(propsRows.map((p) => [p.id, p]));
  const aiStateByThread = new Map(
    threadRows.map((row) => [row.conversation_id, row]),
  );

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

  const threads: Thread[] = [];
  for (const [threadId, bucket] of byThread) {
    const contactId = bucket.latest.contact_id!;
    const c = contactById.get(contactId);
    const p = bucket.propertyId ? propertyById.get(bucket.propertyId) : null;
    const aiState = aiStateByThread.get(threadId);
    const aiResponderStatus = parseAiResponderStatus(
      aiState?.ai_responder_status ?? null,
    );

    if (opts.assigneeId && p?.assigned_user_id !== opts.assigneeId) continue;
    if (opts.unassignedOnly && p?.assigned_user_id) continue;
    if (
      opts.unreadOnly &&
      bucket.unreadCount === 0 &&
      threadId !== opts.includeThreadId
    )
      continue;
    if (opts.escalatedOnly && aiResponderStatus !== "escalated") continue;
    if (opts.handledOnly && aiResponderStatus !== "handled") continue;
    if (opts.dispoOnly && p?.outreach_dispo == null) continue;

    const consentState = computeConsentState(
      consentEventsByContact.get(contactId) ?? [],
    );
    const isOptedOut =
      consentState === "opted_out" ||
      c?.do_not_contact === true ||
      c?.sms_opted_out === true;
    const needsOutcome = isNeedsOutcomeThread({
      propertyId: bucket.propertyId,
      hasInbound: bucket.hasInbound,
      propertyStatus: p?.status,
      outreachDispo: p?.outreach_dispo,
      isOptedOut,
    });
    if (opts.needsOutcomeOnly && !needsOutcome) continue;
    const parties = deriveSmsParties(bucket.latest);

    threads.push({
      threadId,
      contactId,
      contactName: c
        ? (c.entity_name ??
          ([c.first_name, c.last_name].filter(Boolean).join(" ") || null))
        : null,
      threadCustomerPhone: parties.customerPhone,
      threadBusinessPhone: parties.businessPhone,
      contactPhone: parties.customerPhone,
      propertyId: bucket.propertyId,
      propertyAddress: p
        ? [p.address, p.city, p.state].filter(Boolean).join(", ")
        : null,
      propertyStatus: p?.status ?? null,
      outreachDispo: p?.outreach_dispo ?? null,
      assigneeId: p?.assigned_user_id ?? null,
      lastMessageBody: bucket.latest.body,
      lastMessageDirection: bucket.latest.direction as "inbound" | "outbound",
      lastMessageAt: bucket.latest.created_at,
      unreadCount: bucket.unreadCount,
      needsHumanAttention: p?.needs_human_attention ?? false,
      escalationReason: p?.needs_human_attention
        ? (p.last_ai_escalation_reason ?? null)
        : null,
      isOptedOut,
      isTestTraffic: looksLikeTestTraffic(
        c
          ? (c.entity_name ??
            ([c.first_name, c.last_name].filter(Boolean).join(" ") || null))
          : null,
        p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : null,
      ),
      needsOutcome,
      aiResponderStatus,
      aiResponderReason: aiState?.ai_responder_reason ?? null,
      aiResponderStatusAt: aiState?.ai_responder_status_at ?? null,
      aiLastDeliveryStatus: aiState?.ai_last_delivery_status ?? null,
      aiLastDeliveryError: aiState?.ai_last_delivery_error ?? null,
    });
  }

  // Sort: most-recent first, full stop. Rows move only when a new message
  // arrives — reading a thread must never reposition it. This retires the
  // feedback-f E2a unread-first bubbling; the dedicated Unread chip is now
  // the "what needs attention" view.
  threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return threads;
}

function parseAiResponderStatus(
  value: string | null,
): AiResponderThreadStatus | null {
  return value === "handled" || value === "escalated" ? value : null;
}

export async function countNeedsOutcomeThreads(
  supabase: SupabaseClient<Database>,
  opts: NeedsOutcomeCountOpts = {},
): Promise<number> {
  const sinceDays = opts.sinceDays ?? 90;
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: msgs, error } = await supabase
    .from("messages")
    .select("contact_id, property_id, conversation_id, direction, created_at")
    .eq("channel", "sms")
    .not("contact_id", "is", null)
    .not("conversation_id", "is", null)
    .neq("status", "queued")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`countNeedsOutcomeThreads: ${error.message}`);
  if (!msgs || msgs.length === 0) return 0;

  type Candidate = {
    contactId: string;
    propertyId: string | null;
    hasInbound: boolean;
  };
  const candidatesByThread = new Map<string, Candidate>();
  for (const m of msgs) {
    const contactId = m.contact_id;
    if (!contactId) continue;
    const threadId = m.conversation_id!;
    const propertyId = m.property_id;
    const candidate = candidatesByThread.get(threadId);
    if (candidate) {
      if (candidate.propertyId === null && propertyId !== null) {
        candidate.propertyId = propertyId;
      }
      if (m.direction === "inbound") {
        candidate.hasInbound = true;
      }
      continue;
    }

    if (m.direction === "inbound") {
      candidatesByThread.set(threadId, {
        contactId,
        propertyId,
        hasInbound: true,
      });
      continue;
    }
    candidatesByThread.set(threadId, {
      contactId,
      propertyId,
      hasInbound: false,
    });
  }
  const candidates = Array.from(candidatesByThread.values());
  if (candidates.length === 0) return 0;

  const CHUNK = 250;
  const propertyIds = Array.from(
    new Set(
      candidates
        .map((c) => c.propertyId)
        .filter((propertyId): propertyId is string => propertyId !== null),
    ),
  );
  const contactIds = Array.from(new Set(candidates.map((c) => c.contactId)));
  const [propsRows, contactsRows] = await Promise.all([
    fetchInChunks(propertyIds, CHUNK, (chunk) =>
      supabase
        .from("properties")
        .select("id, address, city, state, status, outreach_dispo")
        .in("id", chunk),
    ),
    fetchInChunks(contactIds, CHUNK, (chunk) =>
      supabase
        .from("contacts")
        .select("id, first_name, last_name, entity_name, do_not_contact, sms_opted_out")
        .in("id", chunk),
    ),
  ]);
  const propertyById = new Map(propsRows.map((p) => [p.id, p]));
  const contactById = new Map(contactsRows.map((contact) => [contact.id, contact]));

  const consentRows = await fetchInChunks(contactIds, CHUNK, (chunk) =>
    supabase
      .from("consent_events")
      .select("contact_id, event_type, occurred_at")
      .eq("channel", "sms")
      .in("contact_id", chunk)
      .order("occurred_at", { ascending: false }),
  );
  const consentEventsByContact = new Map<
    string,
    Array<{ event_type: string; occurred_at: string }>
  >();
  for (const ev of consentRows) {
    const list = consentEventsByContact.get(ev.contact_id) ?? [];
    list.push({ event_type: ev.event_type, occurred_at: ev.occurred_at });
    consentEventsByContact.set(ev.contact_id, list);
  }

  let needsOutcome = candidates.filter((candidate) => {
    const property = candidate.propertyId
      ? propertyById.get(candidate.propertyId)
      : null;
    const contact = contactById.get(candidate.contactId);
    const isOptedOut =
      contact?.do_not_contact === true ||
      contact?.sms_opted_out === true ||
      computeConsentState(consentEventsByContact.get(candidate.contactId) ?? []) ===
        "opted_out";
    return isNeedsOutcomeThread({
      propertyId: candidate.propertyId,
      hasInbound: candidate.hasInbound,
      propertyStatus: property?.status,
      outreachDispo: property?.outreach_dispo,
      isOptedOut,
    });
  });
  if (needsOutcome.length === 0) return 0;

  if (opts.hideTestTraffic) {
    needsOutcome = needsOutcome.filter((candidate) => {
      const contact = contactById.get(candidate.contactId);
      const property = candidate.propertyId
        ? propertyById.get(candidate.propertyId)
        : null;
      const contactName = contact
        ? (contact.entity_name ??
          ([contact.first_name, contact.last_name].filter(Boolean).join(" ") ||
            null))
        : null;
      const propertyAddress = property
        ? [property.address, property.city, property.state].filter(Boolean).join(", ")
        : null;

      return !looksLikeTestTraffic(contactName, propertyAddress);
    });
  }

  return needsOutcome.length;
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
