import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Fixed namespace so the fallback conversation id is a pure function of the SMS
// thread key. This is what keeps a near-simultaneous first outbound and first
// inbound from splitting into two threads when the DB-owned registry
// (`ensure_sms_conversation_id`, shipped by the Sendillo rollout migration) is
// not deployed: separate
// serverless invocations independently derive the SAME id. Must match the value
// used by historical rows so existing threads stay intact.
const SMS_CONV_NS = "6f9a1e2c-3b4d-4f5a-8c7e-1d2b3a4c5d6e";

type ThreadCandidate = {
  conversationId: string | null;
  propertyId: string;
  latestAt: string;
};

export type ResolverCandidateProperty = {
  id: string;
  address: string;
  city: string | null;
  state: string | null;
  homeownerContactId: string | null;
  agentContactId: string | null;
  outreachDispo: string | null;
  needsHumanAttention: boolean;
  latestAt: string | null;
  sources: Array<"recipient_number" | "history" | "linked_property">;
};

const fallbackConversationLocks = new Map<string, Promise<string>>();

export type ParsedThreadId =
  | { kind: "conversation"; conversationId: string }
  | { kind: "legacy"; contactId: string; propertyId: string | null }
  | { kind: "contact"; contactId: string };

export type InboundThreadResolution = {
  contactId: string | null;
  propertyId: string | null;
  conversationId: string | null;
  resolution:
    | "unmatched_contact"
    | "ambiguous_contact"
    | "matched_recipient_number"
    | "matched_single_history_property"
    | "matched_single_linked_property"
    | "ambiguous_recipient_number"
    | "ambiguous_history"
    | "matched_contact_without_property";
};

/**
 * Parse a thread id from a URL. Since migration 081 every contact-bearing
 * SMS row carries a conversation_id, so this exists ONLY as the
 * URL-compat doormat: old bookmarked links may still carry
 * `legacy:<contact>:<property>` keys or bare contact ids. New code never
 * constructs those formats — `canonicalizeThreadId` translates them to a
 * conversation UUID once, at the page boundary.
 */
export function parseThreadId(threadId: string): ParsedThreadId {
  if (UUID_RE.test(threadId)) {
    return { kind: "conversation", conversationId: threadId };
  }

  if (threadId.startsWith("legacy:")) {
    const [, contactId, propertyRaw = "none"] = threadId.split(":", 3);
    return {
      kind: "legacy",
      contactId,
      propertyId: propertyRaw === "none" ? null : propertyRaw,
    };
  }

  return { kind: "contact", contactId: threadId };
}

/**
 * Resolve a thread id of any URL format to its canonical conversation
 * UUID, or null when nothing matches. This is the single compat shim for
 * stale links — everything past the page boundary deals in conversation
 * UUIDs only.
 */
export async function canonicalizeThreadId(
  supabase: SupabaseClient<Database>,
  threadId: string,
): Promise<string | null> {
  const parsed = parseThreadId(threadId);

  if (parsed.kind === "conversation") {
    const orgId = await resolveSmsConversationOrg(
      supabase,
      parsed.conversationId,
    );
    if (orgId) return parsed.conversationId;
    // Contact ids are UUID-shaped too; a pre-Phase-2 link that doesn't
    // match any conversation gets retried as a contact id.
    return latestConversationIdForContact(supabase, parsed.conversationId);
  }

  if (parsed.kind === "legacy") {
    let query = supabase
      .from("messages")
      .select("conversation_id")
      .eq("channel", "sms")
      .eq("contact_id", parsed.contactId)
      .not("conversation_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    query =
      parsed.propertyId === null
        ? query.is("property_id", null)
        : query.eq("property_id", parsed.propertyId);
    const { data } = await query.maybeSingle();
    return guardCanonicalConversation(supabase, data?.conversation_id ?? null);
  }

  return latestConversationIdForContact(supabase, parsed.contactId);
}

/** Resolve the sole active-membership-visible organization for every SMS row
 * carrying this conversation UUID. The database raises on a cross-org UUID
 * collision; callers must not catch that error and guess a tenant. */
export async function resolveSmsConversationOrg(
  supabase: SupabaseClient<Database>,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("resolve_sms_conversation_org", {
    p_conversation_id: conversationId,
  });
  if (error) {
    throw new Error(`resolveSmsConversationOrg: ${error.message}`);
  }
  if (data !== null && typeof data !== "string") {
    throw new Error("resolveSmsConversationOrg: invalid database response");
  }
  return data;
}

async function guardCanonicalConversation(
  supabase: SupabaseClient<Database>,
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId) return null;
  const orgId = await resolveSmsConversationOrg(supabase, conversationId);
  return orgId ? conversationId : null;
}

/** A bare contact id is ambiguous when the contact has several threads —
 *  resolve to the thread holding the contact's most recent message. */
async function latestConversationIdForContact(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("messages")
    .select("conversation_id")
    .eq("channel", "sms")
    .eq("contact_id", contactId)
    .not("conversation_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return guardCanonicalConversation(supabase, data?.conversation_id ?? null);
}

export async function ensureConversationIdForThread(
  supabase: SupabaseClient<Database>,
  contactId: string,
  /** Null for contact-level threads (inbound from a contact with no
   *  resolvable property). Org scoping falls back to the contact. */
  propertyId: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_sms_conversation_id", {
    p_contact_id: contactId,
    p_property_id: propertyId,
  });
  if (!error) return data;
  // Deploy-window compat: the pre-080 RPC requires a property for org
  // scoping, so a contact-level (null-property) call gets a 42501
  // scope-not-found even when the contact is fine. That state must not
  // 500 inbound webhooks — drop to the deterministic fallback, which
  // verifies the contact actually exists before minting.
  const nullPropertyRejectedByPre080Rpc =
    propertyId === null && isThreadScopeNotFound(error);
  if (
    !isMissingEnsureConversationRpc(error) &&
    !nullPropertyRejectedByPre080Rpc
  ) {
    reportError(new Error(error.message), {
      tags: { surface: "ensure_conversation_id_rpc" },
      extra: { contactId, propertyId, code: error.code ?? null },
    });
    throw new Error(`ensureConversationIdForThread rpc: ${error.message}`);
  }

  const fallbackKey = `${contactId}:${propertyId ?? "none"}`;
  const existingLock = fallbackConversationLocks.get(fallbackKey);
  if (existingLock) return existingLock;

  const fallback = ensureConversationIdForThreadWithoutRpc(
    supabase,
    contactId,
    propertyId,
  ).finally(() => {
    fallbackConversationLocks.delete(fallbackKey);
  });
  fallbackConversationLocks.set(fallbackKey, fallback);
  return fallback;
}

async function ensureConversationIdForThreadWithoutRpc(
  supabase: SupabaseClient<Database>,
  contactId: string,
  propertyId: string | null,
): Promise<string> {
  // Contact-level threads reach this path when the pre-080 RPC rejected
  // the null property — the same 42501 the new RPC raises for a missing
  // contact. Disambiguate by checking the contact really exists; fail
  // closed if it doesn't.
  if (propertyId === null) {
    const { data: contactRow, error: contactError } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .maybeSingle();
    if (contactError) {
      throw new Error(
        `ensureConversationIdForThread contact check: ${contactError.message}`,
      );
    }
    if (!contactRow) {
      throw new Error(
        "ensureConversationIdForThread: contact not found for contact-level thread",
      );
    }
  }

  let lookup = supabase
    .from("messages")
    .select("conversation_id")
    .eq("channel", "sms")
    .eq("contact_id", contactId)
    .not("conversation_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1);
  lookup =
    propertyId === null
      ? lookup.is("property_id", null)
      : lookup.eq("property_id", propertyId);
  const { data: existing, error: lookupError } = await lookup.maybeSingle();
  if (lookupError) {
    throw new Error(
      `ensureConversationIdForThread fallback lookup: ${lookupError.message}`,
    );
  }
  if (existing?.conversation_id) return existing.conversation_id;

  // Deterministic id — NOT random. Two independent invocations (outbound send
  // vs inbound webhook) that both reach this branch before either's row lands
  // must arrive at the same conversation id, or one real conversation splits
  // into two threads. The in-process lock above only dedupes within a single
  // process; determinism is the cross-process guarantee.
  const conversationId = conversationIdFor(contactId, propertyId);
  let update = supabase
    .from("messages")
    .update({ conversation_id: conversationId })
    .eq("channel", "sms")
    .eq("contact_id", contactId)
    .is("conversation_id", null);
  update =
    propertyId === null
      ? update.is("property_id", null)
      : update.eq("property_id", propertyId);
  const { error: updateError } = await update;
  if (updateError) {
    throw new Error(
      `ensureConversationIdForThread fallback backfill: ${updateError.message}`,
    );
  }
  return conversationId;
}

/** The 42501 the RPC raises when it cannot org-scope the thread key —
 *  for the pre-080 function, ANY null-property call lands here. */
function isThreadScopeNotFound(error: {
  code?: string | null;
  message: string;
}): boolean {
  return (
    error.code === "42501" &&
    error.message.includes("contact/property thread scope not found")
  );
}

function isMissingEnsureConversationRpc(error: {
  code?: string | null;
  message: string;
}): boolean {
  return (
    error.code === "PGRST202" ||
    error.message.includes(
      "Could not find the function public.ensure_sms_conversation_id",
    )
  );
}

// UUIDv5-style deterministic id over the (contact, property) thread key.
// Property-less (contact-level) threads hash with the "none" sentinel —
// the same sentinel the retired legacy: key format used, so the recipe
// stays a pure function of the thread key. Existing (contact, property)
// ids are untouched: the non-null input is hashed exactly as before.
function conversationIdFor(contactId: string, propertyId: string | null): string {
  const ns = Buffer.from(SMS_CONV_NS.replace(/-/g, ""), "hex");
  const normalizedContactId = contactId.toLowerCase();
  const normalizedPropertyId = (propertyId ?? "none").toLowerCase();
  const h = createHash("sha1")
    .update(
      Buffer.concat([
        ns,
        Buffer.from(`${normalizedContactId}:${normalizedPropertyId}`),
      ]),
    )
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export async function resolveInboundThread(
  supabase: SupabaseClient<Database>,
  fromPhone: string,
  toPhone: string,
): Promise<InboundThreadResolution> {
  const normalizedFrom = normalizePhone(fromPhone);
  const normalizedTo = normalizePhone(toPhone);

  const contacts = await loadContactsByPhone(supabase, normalizedFrom);
  if (!contacts || contacts.length === 0) {
    return {
      contactId: null,
      propertyId: null,
      conversationId: null,
      resolution: "unmatched_contact",
    };
  }
  const recipientCandidates = flattenContactCandidates(
    await Promise.all(
      contacts.map(async ({ id }) => ({
        contactId: id,
        candidates: await loadCandidates(supabase, id, normalizedTo),
      })),
    ),
  );
  if (recipientCandidates.length === 1) {
    return materializeThreadCandidate(supabase, recipientCandidates[0], "matched_recipient_number");
  }
  if (recipientCandidates.length > 1) {
    // Manual-triage rule: a reply to a business sender that still maps to
    // multiple active properties must stay contact-level. Picking the most
    // recent property would silently put the seller's reply on the wrong lead.
    return contactLevelResolution(
      supabase,
      contacts.length === 1 ? contacts[0].id : null,
      "ambiguous_recipient_number",
    );
  }

  const historyCandidates = flattenContactCandidates(
    await Promise.all(
      contacts.map(async ({ id }) => ({
        contactId: id,
        candidates: await loadCandidates(supabase, id),
      })),
    ),
  );
  if (historyCandidates.length === 1) {
    return materializeThreadCandidate(
      supabase,
      historyCandidates[0],
      "matched_single_history_property",
    );
  }
  if (historyCandidates.length > 1) {
    return contactLevelResolution(
      supabase,
      contacts.length === 1 ? contacts[0].id : null,
      "ambiguous_history",
    );
  }

  const linkedPropertyCandidates = flattenLinkedPropertyCandidates(
    await Promise.all(
      contacts.map(async ({ id }) => ({
        contactId: id,
        propertyIds: await loadLinkedPropertyIds(supabase, id),
      })),
    ),
  );
  if (linkedPropertyCandidates.length === 1) {
    const candidate = linkedPropertyCandidates[0];
    return {
      contactId: candidate.contactId,
      propertyId: candidate.propertyId,
      conversationId: await ensureConversationIdForThread(
        supabase,
        candidate.contactId,
        candidate.propertyId,
      ),
      resolution: "matched_single_linked_property",
    };
  }

  if (contacts.length === 1) {
    return contactLevelResolution(
      supabase,
      contacts[0].id,
      "matched_contact_without_property",
    );
  }

  return {
    contactId: null,
    propertyId: null,
    conversationId: null,
    resolution: "ambiguous_contact",
  };
}

export async function listCandidatePropertyThreadsForInboundContact(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string;
    toPhone?: string | null;
  },
): Promise<ThreadCandidate[]> {
  const recipientCandidates = input.toPhone
    ? await loadCandidates(supabase, input.contactId, normalizePhone(input.toPhone))
    : [];

  if (recipientCandidates.length > 0) {
    return recipientCandidates;
  }

  return loadCandidates(supabase, input.contactId);
}

export async function listResolverCandidatePropertiesForContact(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string;
    sourceConversationId?: string | null;
  },
): Promise<ResolverCandidateProperty[]> {
  const businessNumbers = input.sourceConversationId
    ? await loadBusinessNumbersForConversation(
        supabase,
        input.sourceConversationId,
        input.contactId,
      )
    : [];

  const [recipientCandidates, historyCandidates, linkedPropertyIds] =
    await Promise.all([
      Promise.all(
        businessNumbers.map((phone) =>
          loadCandidates(supabase, input.contactId, phone),
        ),
      ),
      loadCandidates(supabase, input.contactId),
      loadLinkedPropertyIdsForResolver(supabase, input.contactId),
    ]);

  const byProperty = new Map<
    string,
    {
      latestAt: string | null;
      sources: Set<ResolverCandidateProperty["sources"][number]>;
    }
  >();
  const addCandidate = (
    propertyId: string,
    latestAt: string | null,
    source: ResolverCandidateProperty["sources"][number],
  ) => {
    const existing = byProperty.get(propertyId);
    if (!existing) {
      byProperty.set(propertyId, { latestAt, sources: new Set([source]) });
      return;
    }
    existing.sources.add(source);
    if (
      latestAt &&
      (!existing.latestAt || latestAt.localeCompare(existing.latestAt) > 0)
    ) {
      existing.latestAt = latestAt;
    }
  };

  for (const candidate of recipientCandidates.flat()) {
    addCandidate(candidate.propertyId, candidate.latestAt, "recipient_number");
  }
  for (const candidate of historyCandidates) {
    addCandidate(candidate.propertyId, candidate.latestAt, "history");
  }
  for (const propertyId of linkedPropertyIds) {
    addCandidate(propertyId, null, "linked_property");
  }

  const propertyIds = Array.from(byProperty.keys());
  if (propertyIds.length === 0) return [];

  const { data, error } = await supabase
    .from("properties")
    .select(
      "id, address, city, state, homeowner_contact_id, agent_contact_id, outreach_dispo, needs_human_attention",
    )
    .in("id", propertyIds)
    .is("deleted_at", null);
  if (error) {
    throw new Error(`listResolverCandidatePropertiesForContact: ${error.message}`);
  }

  return (data ?? [])
    .map((property) => {
      const meta = byProperty.get(property.id)!;
      return {
        id: property.id,
        address: property.address,
        city: property.city,
        state: property.state,
        homeownerContactId: property.homeowner_contact_id,
        agentContactId: property.agent_contact_id,
        outreachDispo: property.outreach_dispo,
        needsHumanAttention: property.needs_human_attention,
        latestAt: meta.latestAt,
        sources: Array.from(meta.sources),
      };
    })
    .sort((left, right) => {
      const leftRecipient = left.sources.includes("recipient_number") ? 1 : 0;
      const rightRecipient = right.sources.includes("recipient_number") ? 1 : 0;
      if (leftRecipient !== rightRecipient) return rightRecipient - leftRecipient;
      return (right.latestAt ?? "").localeCompare(left.latestAt ?? "");
    });
}

/**
 * Resolution for a thread that attaches to a contact but no property.
 * Contact-level threads get a real conversation id too (migration 081) —
 * org-scoped via the contact — so no contact-bearing row is ever written
 * without one.
 */
async function contactLevelResolution(
  supabase: SupabaseClient<Database>,
  contactId: string | null,
  resolution:
    | "ambiguous_recipient_number"
    | "ambiguous_history"
    | "matched_contact_without_property",
): Promise<InboundThreadResolution> {
  return {
    contactId,
    propertyId: null,
    conversationId: contactId
      ? await ensureConversationIdForThread(supabase, contactId, null)
      : null,
    resolution,
  };
}

type ContactThreadCandidate = ThreadCandidate & { contactId: string };

function flattenContactCandidates(
  rows: Array<{ contactId: string; candidates: ThreadCandidate[] }>,
): ContactThreadCandidate[] {
  return rows.flatMap(({ contactId, candidates }) =>
    candidates.map((candidate) => ({ contactId, ...candidate })),
  );
}

function flattenLinkedPropertyCandidates(
  rows: Array<{ contactId: string; propertyIds: string[] }>,
): Array<{ contactId: string; propertyId: string }> {
  return rows.flatMap(({ contactId, propertyIds }) =>
    propertyIds.map((propertyId) => ({ contactId, propertyId })),
  );
}

async function materializeThreadCandidate(
  supabase: SupabaseClient<Database>,
  candidate: ContactThreadCandidate,
  resolution:
    | "matched_recipient_number"
    | "matched_single_history_property",
): Promise<InboundThreadResolution> {
  return {
    contactId: candidate.contactId,
    propertyId: candidate.propertyId,
    conversationId:
      candidate.conversationId ??
      (await ensureConversationIdForThread(
        supabase,
        candidate.contactId,
        candidate.propertyId,
      )),
    resolution,
  };
}

async function loadCandidates(
  supabase: SupabaseClient<Database>,
  contactId: string,
  normalizedAddress?: string | null,
): Promise<ThreadCandidate[]> {
  const { data, error } = await supabase.rpc("sms_thread_candidate_properties", {
    p_contact_id: contactId,
    p_business_phone: normalizedAddress ?? null,
  });
  if (error) {
    throw new Error(`loadCandidates: ${error.message}`);
  }
  return (data ?? []).map((row) => ({
    conversationId: row.conversation_id,
    propertyId: row.property_id,
    latestAt: row.latest_at,
  }));
}

async function loadBusinessNumbersForConversation(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  contactId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("direction, from_address, to_address")
    .eq("channel", "sms")
    .eq("conversation_id", conversationId)
    .eq("contact_id", contactId);
  if (error) {
    throw new Error(`loadBusinessNumbersForConversation: ${error.message}`);
  }

  const phones = new Set<string>();
  for (const row of data ?? []) {
    const raw =
      row.direction === "inbound" ? row.to_address : row.from_address;
    const normalized = normalizePhone(raw);
    if (normalized) phones.add(normalized);
  }
  return Array.from(phones);
}

async function loadContactsByPhone(
  supabase: SupabaseClient<Database>,
  normalizedPhone: string | null,
) {
  if (!normalizedPhone) return [];

  const results = await Promise.all([
    supabase.from("contacts").select("id").eq("phone_1", normalizedPhone).limit(2),
    supabase.from("contacts").select("id").eq("phone_2", normalizedPhone).limit(2),
    supabase.from("contacts").select("id").eq("phone_3", normalizedPhone).limit(2),
  ]);

  const deduped = new Map<string, { id: string }>();
  for (const result of results) {
    if (result.error) {
      throw new Error(`resolveInboundThread contact lookup: ${result.error.message}`);
    }
    for (const row of result.data ?? []) deduped.set(row.id, row);
  }

  return Array.from(deduped.values()).slice(0, 2);
}

async function loadLinkedPropertyIds(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<string[]> {
  return loadLinkedPropertyIdsForContact(supabase, contactId, { limit: 2 });
}

async function loadLinkedPropertyIdsForResolver(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<string[]> {
  return loadLinkedPropertyIdsForContact(supabase, contactId);
}

async function loadLinkedPropertyIdsForContact(
  supabase: SupabaseClient<Database>,
  contactId: string,
  options: { limit?: number } = {},
): Promise<string[]> {
  const { data: linkedProps, error } = await supabase
    .from("properties")
    .select("id")
    .or(`homeowner_contact_id.eq.${contactId},agent_contact_id.eq.${contactId}`)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 200);
  if (error) {
    throw new Error(`resolveInboundThread linked property lookup: ${error.message}`);
  }
  return (linkedProps ?? []).map((row) => row.id);
}
