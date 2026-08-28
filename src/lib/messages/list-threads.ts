import type { SupabaseClient } from "@supabase/supabase-js";

import { computeConsentState } from "@/lib/messaging/consent";
import type { Database } from "@/lib/supabase/types";
import type { AiResponderThreadStatus } from "./ai-responder-thread-state";
import { deriveSmsParties } from "./sms-parties";

export type AiDispositionReview = {
  id: string;
  status: "pending";
  disposition: string;
  reason: string;
  sourceInboundMessageId: string;
  /** Present on detail hydration so the operator can see the exact inbound
   *  text Sandra classified even when it falls outside the timeline slice. */
  sourceMessageBody?: string | null;
  createdAt: string;
};

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
  /** Pending, conversation-scoped disposition decision made by Sandra AI.
   *  This is separate from the already-applied property outcome. */
  aiDispositionReview: AiDispositionReview | null;
  /** Permanent property-level DNC lock. This is independent of which
   * contact (homeowner or agent) owns the visible conversation. */
  isDncLocked: boolean;
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

export type ThreadPageFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "unread"
  | "escalated"
  | "dispo"
  | "needs_outcome";

export type ThreadPageCounts = Record<ThreadPageFilter, number>;

export type ThreadPage = {
  threads: Thread[];
  counts: ThreadPageCounts;
  total: number;
  hiddenCount: number;
  page: number;
  pageSize: number;
};

export type ListThreadPageOpts = {
  filter: ThreadPageFilter;
  currentUserId: string | null;
  includeThreadId: string | null;
  hideNoise: boolean;
  page: number;
  pageSize?: number;
  sinceDays?: number;
};

export type NeedsOutcomeCountOpts = {
  /** Window for "active" conversations. Defaults to 90 days. */
  sinceDays?: number;
  /** Backward-compatible no-op: Needs Outcome always excludes opt-outs. */
  hideOptedOut?: boolean;
  /** When true, excludes known Jitter canary/rehearsal fixture traffic. */
  hideTestTraffic?: boolean;
};

type ThreadSnapshotRow = {
  thread_id: string;
  contact_id: string;
  contact_name: string | null;
  thread_customer_phone: string | null;
  thread_business_phone: string | null;
  property_id: string | null;
  property_address: string | null;
  property_status: string | null;
  outreach_dispo: string | null;
  is_dnc_locked: boolean;
  assignee_id: string | null;
  last_message_body: string;
  last_message_direction: "inbound" | "outbound";
  last_message_at: string;
  unread_count: number;
  has_inbound: boolean;
  needs_human_attention: boolean;
  escalation_reason: string | null;
  is_opted_out: boolean;
  ai_responder_status: string | null;
  ai_responder_reason: string | null;
  ai_responder_status_at: string | null;
  ai_last_delivery_status: string | null;
  ai_last_delivery_error: string | null;
  ai_disposition_review_id?: string | null;
  ai_disposition_review_status?: string | null;
  ai_disposition_review_disposition?: string | null;
  ai_disposition_review_reason?: string | null;
  ai_disposition_review_source_inbound_message_id?: string | null;
  ai_disposition_review_created_at?: string | null;
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
  const cutoff = new Date(
    Date.now() - sinceDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const snapshot = await fetchThreadSnapshot(supabase, cutoff);
  if (snapshot) return mapThreadSnapshot(snapshot, opts);

  const { data: msgs, error } = await supabase
    .from("messages")
    .select(
      "contact_id, property_id, conversation_id, body, direction, from_address, to_address, created_at, read_at",
    )
    .eq("channel", "sms")
    .not("contact_id", "is", null)
    .not("conversation_id", "is", null)
    .not("status", "in", "(queued,paused)")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listThreads: ${error.message}`);
  if (!msgs || msgs.length === 0) return [];

  type Bucket = {
    latest: (typeof msgs)[number];
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
          "id, address, city, state, status, outreach_dispo, is_dnc_locked, assigned_user_id, needs_human_attention, last_ai_escalation_reason",
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
      aiDispositionReview: null,
      isDncLocked: p?.is_dnc_locked ?? false,
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

/**
 * Production-scale inbox reader. PostgreSQL computes counts over the complete
 * active window, applies the selected filter, and returns one bounded page.
 * This prevents a bulk campaign from turning the Messages route into a
 * tens-of-thousands-row JSON response while keeping every chip count truthful.
 */
export async function listThreadPage(
  supabase: SupabaseClient<Database>,
  opts: ListThreadPageOpts,
): Promise<ThreadPage> {
  const sinceDays = opts.sinceDays ?? 90;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 200, 1), 500);
  // p_offset is a PostgreSQL integer. Clamp adversarial URL values before
  // multiplying so a crafted ?inboxPage cannot turn a valid route into an
  // RPC cast error.
  const rawPage = Number.isFinite(opts.page) ? Math.trunc(opts.page) : 1;
  const maxPageForIntegerOffset =
    Math.floor(2_147_483_647 / pageSize) + 1;
  const requestedPage = Math.min(
    Math.max(rawPage, 1),
    maxPageForIntegerOffset,
  );
  const cutoff = new Date(
    Date.now() - sinceDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase.rpc("sms_inbox_thread_page_snapshot", {
    p_cutoff: cutoff,
    p_filter: opts.filter,
    p_assignee_id: opts.currentUserId,
    p_include_thread_id: opts.includeThreadId,
    p_hide_noise: opts.hideNoise,
    p_limit: pageSize,
    p_offset: (requestedPage - 1) * pageSize,
  });
  if (error) {
    throw new Error(`sms_inbox_thread_page_snapshot: ${error.message}`);
  }
  if (!isThreadPageDocument(data)) {
    if (isSnapshotError(data)) {
      throw new Error(
        `sms_inbox_thread_page_snapshot: ${String(data.__error)}`,
      );
    }
    throw new Error("sms_inbox_thread_page_snapshot: invalid response");
  }

  return {
    threads: mapThreadSnapshot(data.rows, {}),
    counts: data.counts,
    total: data.total,
    hiddenCount: data.hidden_count,
    page: Math.floor(data.offset / data.limit) + 1,
    pageSize: data.limit,
  };
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
  const cutoff = new Date(
    Date.now() - sinceDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const snapshot = await fetchThreadSnapshot(supabase, cutoff);
  if (snapshot) {
    return mapThreadSnapshot(snapshot, {})
      .filter((thread) => thread.needsOutcome)
      .filter((thread) => !opts.hideTestTraffic || !thread.isTestTraffic)
      .length;
  }

  const { data: msgs, error } = await supabase
    .from("messages")
    .select("contact_id, property_id, conversation_id, direction, created_at")
    .eq("channel", "sms")
    .not("contact_id", "is", null)
    .not("conversation_id", "is", null)
    .not("status", "in", "(queued,paused)")
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
        .select(
          "id, first_name, last_name, entity_name, do_not_contact, sms_opted_out",
        )
        .in("id", chunk),
    ),
  ]);
  const propertyById = new Map(propsRows.map((p) => [p.id, p]));
  const contactById = new Map(
    contactsRows.map((contact) => [contact.id, contact]),
  );

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
      computeConsentState(
        consentEventsByContact.get(candidate.contactId) ?? [],
      ) === "opted_out";
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
        ? [property.address, property.city, property.state]
            .filter(Boolean)
            .join(", ")
        : null;

      return !looksLikeTestTraffic(contactName, propertyAddress);
    });
  }

  return needsOutcome.length;
}

async function fetchThreadSnapshot(
  supabase: SupabaseClient<Database>,
  cutoff: string,
): Promise<ThreadSnapshotRow[] | null> {
  // Older unit stubs exercise the pre-migration fallback below. Real
  // Supabase clients always expose rpc(), so production never returns to the
  // PostgREST row-capped path once migration 20260816120000 is installed.
  const rpc = (supabase as unknown as { rpc?: SupabaseClient<Database>["rpc"] })
    .rpc;
  if (typeof rpc !== "function") return null;
  const { data, error } = await supabase.rpc("sms_inbox_thread_snapshot", {
    p_cutoff: cutoff,
  });
  if (error) throw new Error(`sms_inbox_thread_snapshot: ${error.message}`);
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "__error" in data
  ) {
    throw new Error(
      `sms_inbox_thread_snapshot: ${String(data.__error)}; narrow the inbox window`,
    );
  }
  if (!Array.isArray(data)) {
    throw new Error("sms_inbox_thread_snapshot: invalid response");
  }
  return data as unknown as ThreadSnapshotRow[];
}

type ThreadPageDocument = {
  rows: ThreadSnapshotRow[];
  counts: ThreadPageCounts;
  total: number;
  hidden_count: number;
  limit: number;
  offset: number;
};

function isSnapshotError(value: unknown): value is { __error: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "__error" in value
  );
}

function isThreadPageDocument(value: unknown): value is ThreadPageDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const document = value as Record<string, unknown>;
  if (
    !Array.isArray(document.rows) ||
    document.counts === null ||
    typeof document.counts !== "object" ||
    Array.isArray(document.counts) ||
    !Number.isInteger(document.total) ||
    !Number.isInteger(document.hidden_count) ||
    !Number.isInteger(document.limit) ||
    !Number.isInteger(document.offset) ||
    (document.limit as number) < 1 ||
    (document.offset as number) < 0
  ) {
    return false;
  }
  const counts = document.counts as Record<string, unknown>;
  return (
    [
      "all",
      "mine",
      "unassigned",
      "unread",
      "escalated",
      "dispo",
      "needs_outcome",
    ].every((key) => Number.isInteger(counts[key])) &&
    document.rows.every(isThreadSnapshotRow)
  );
}

function isThreadSnapshotRow(value: unknown): value is ThreadSnapshotRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.thread_id === "string" &&
    typeof row.contact_id === "string" &&
    typeof row.last_message_body === "string" &&
    (row.last_message_direction === "inbound" ||
      row.last_message_direction === "outbound") &&
    typeof row.last_message_at === "string" &&
    Number.isInteger(row.unread_count) &&
    typeof row.has_inbound === "boolean" &&
    typeof row.is_dnc_locked === "boolean" &&
    typeof row.needs_human_attention === "boolean" &&
    typeof row.is_opted_out === "boolean" &&
    hasValidAiDispositionReviewFields(row)
  );
}

function hasValidAiDispositionReviewFields(
  row: Record<string, unknown>,
): boolean {
  if (row.ai_disposition_review_id == null) {
    return [
      row.ai_disposition_review_status,
      row.ai_disposition_review_disposition,
      row.ai_disposition_review_reason,
      row.ai_disposition_review_source_inbound_message_id,
      row.ai_disposition_review_created_at,
    ].every((value) => value == null);
  }
  return (
    typeof row.ai_disposition_review_id === "string" &&
    row.ai_disposition_review_status === "pending" &&
    typeof row.ai_disposition_review_disposition === "string" &&
    typeof row.ai_disposition_review_reason === "string" &&
    typeof row.ai_disposition_review_source_inbound_message_id === "string" &&
    typeof row.ai_disposition_review_created_at === "string"
  );
}

function mapThreadSnapshot(
  rows: ThreadSnapshotRow[],
  opts: ListThreadsOpts,
): Thread[] {
  const threads: Thread[] = [];
  for (const row of rows) {
    const aiResponderStatus = parseAiResponderStatus(row.ai_responder_status);
    if (opts.assigneeId && row.assignee_id !== opts.assigneeId) continue;
    if (opts.unassignedOnly && row.assignee_id) continue;
    if (
      opts.unreadOnly &&
      row.unread_count === 0 &&
      row.thread_id !== opts.includeThreadId
    )
      continue;
    if (opts.escalatedOnly && aiResponderStatus !== "escalated") continue;
    if (opts.handledOnly && aiResponderStatus !== "handled") continue;
    if (opts.dispoOnly && row.outreach_dispo == null) continue;

    const needsOutcome = isNeedsOutcomeThread({
      propertyId: row.property_id,
      hasInbound: row.has_inbound,
      propertyStatus: row.property_status,
      outreachDispo: row.outreach_dispo,
      isOptedOut: row.is_opted_out,
    });
    if (opts.needsOutcomeOnly && !needsOutcome) continue;

    threads.push({
      threadId: row.thread_id,
      contactId: row.contact_id,
      contactName: row.contact_name,
      threadCustomerPhone: row.thread_customer_phone,
      threadBusinessPhone: row.thread_business_phone,
      contactPhone: row.thread_customer_phone,
      propertyId: row.property_id,
      propertyAddress: row.property_address,
      propertyStatus: row.property_status,
      outreachDispo: row.outreach_dispo,
      aiDispositionReview: mapAiDispositionReview(row),
      isDncLocked: row.is_dnc_locked,
      assigneeId: row.assignee_id,
      lastMessageBody: row.last_message_body,
      lastMessageDirection: row.last_message_direction,
      lastMessageAt: row.last_message_at,
      unreadCount: row.unread_count,
      needsHumanAttention: row.needs_human_attention,
      escalationReason: row.escalation_reason,
      isOptedOut: row.is_opted_out,
      isTestTraffic: looksLikeTestTraffic(
        row.contact_name,
        row.property_address,
      ),
      needsOutcome,
      aiResponderStatus,
      aiResponderReason: row.ai_responder_reason,
      aiResponderStatusAt: row.ai_responder_status_at,
      aiLastDeliveryStatus: row.ai_last_delivery_status,
      aiLastDeliveryError: row.ai_last_delivery_error,
    });
  }
  threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return threads;
}

function mapAiDispositionReview(
  row: ThreadSnapshotRow,
): AiDispositionReview | null {
  if (!row.ai_disposition_review_id) return null;
  return {
    id: row.ai_disposition_review_id,
    status: "pending",
    disposition: row.ai_disposition_review_disposition!,
    reason: row.ai_disposition_review_reason!,
    sourceInboundMessageId:
      row.ai_disposition_review_source_inbound_message_id!,
    createdAt: row.ai_disposition_review_created_at!,
  };
}

/**
 * Run a Supabase `.in("id", chunk)` query in batches and concatenate the rows.
 * Throws if any chunk errors. Returns [] for an empty input without hitting the
 * network (PostgREST treats `id=in.()` as a 400).
 */
async function fetchInChunks<T>(
  ids: string[],
  chunkSize: number,
  query: (
    chunk: string[],
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
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
