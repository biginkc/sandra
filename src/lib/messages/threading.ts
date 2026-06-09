import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
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

export function buildThreadId(
  conversationId: string | null,
  contactId: string,
  propertyId: string | null,
): string {
  return conversationId ?? `legacy:${contactId}:${propertyId ?? "none"}`;
}

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

export async function ensureConversationIdForThread(
  supabase: SupabaseClient<Database>,
  contactId: string,
  propertyId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_sms_conversation_id", {
    p_contact_id: contactId,
    p_property_id: propertyId,
  });
  if (!error) return data;
  if (!isMissingEnsureConversationRpc(error.message)) {
    throw new Error(`ensureConversationIdForThread rpc: ${error.message}`);
  }

  const fallbackKey = `${contactId}:${propertyId}`;
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
  propertyId: string,
): Promise<string> {
  const { data: existing, error: lookupError } = await supabase
    .from("messages")
    .select("conversation_id")
    .eq("channel", "sms")
    .eq("contact_id", contactId)
    .eq("property_id", propertyId)
    .not("conversation_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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
  const { error: updateError } = await supabase
    .from("messages")
    .update({ conversation_id: conversationId })
    .eq("channel", "sms")
    .eq("contact_id", contactId)
    .eq("property_id", propertyId)
    .is("conversation_id", null);
  if (updateError) {
    throw new Error(
      `ensureConversationIdForThread fallback backfill: ${updateError.message}`,
    );
  }
  return conversationId;
}

function isMissingEnsureConversationRpc(message: string): boolean {
  return (
    message.includes("Could not find the function public.ensure_sms_conversation_id") ||
    message.includes("function public.ensure_sms_conversation_id") ||
    message.includes("schema cache")
  );
}

// UUIDv5-style deterministic id over the (contact, property) thread key.
function conversationIdFor(contactId: string, propertyId: string): string {
  const ns = Buffer.from(SMS_CONV_NS.replace(/-/g, ""), "hex");
  const h = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(`${contactId}:${propertyId}`)]))
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
  if (contacts.length > 1) {
    return {
      contactId: null,
      propertyId: null,
      conversationId: null,
      resolution: "ambiguous_contact",
    };
  }

  const contactId = contacts[0].id;
  const recipientCandidates = await loadCandidates(supabase, contactId, normalizedTo);
  if (recipientCandidates.length === 1) {
    const candidate = recipientCandidates[0];
    return {
      contactId,
      propertyId: candidate.propertyId,
      conversationId:
        candidate.conversationId ??
        (await ensureConversationIdForThread(
          supabase,
          contactId,
          candidate.propertyId,
        )),
      resolution: "matched_recipient_number",
    };
  }
  if (recipientCandidates.length > 1) {
    return {
      contactId,
      propertyId: null,
      conversationId: null,
      resolution: "ambiguous_recipient_number",
    };
  }

  const historyCandidates = await loadCandidates(supabase, contactId);
  if (historyCandidates.length === 1) {
    const candidate = historyCandidates[0];
    return {
      contactId,
      propertyId: candidate.propertyId,
      conversationId:
        candidate.conversationId ??
        (await ensureConversationIdForThread(
          supabase,
          contactId,
          candidate.propertyId,
        )),
      resolution: "matched_single_history_property",
    };
  }
  if (historyCandidates.length > 1) {
    return {
      contactId,
      propertyId: null,
      conversationId: null,
      resolution: "ambiguous_history",
    };
  }

  const { data: linkedProps, error: linkedError } = await supabase
    .from("properties")
    .select("id")
    .or(`homeowner_contact_id.eq.${contactId},agent_contact_id.eq.${contactId}`)
    .limit(2);
  if (linkedError) {
    throw new Error(`resolveInboundThread linked property lookup: ${linkedError.message}`);
  }
  if (linkedProps?.length === 1) {
    const propertyId = linkedProps[0].id;
    return {
      contactId,
      propertyId,
      conversationId: await ensureConversationIdForThread(
        supabase,
        contactId,
        propertyId,
      ),
      resolution: "matched_single_linked_property",
    };
  }

  return {
    contactId,
    propertyId: null,
    conversationId: null,
    resolution: "matched_contact_without_property",
  };
}

async function loadCandidates(
  supabase: SupabaseClient<Database>,
  contactId: string,
  normalizedAddress?: string | null,
): Promise<ThreadCandidate[]> {
  const baseQuery = () =>
    supabase
      .from("messages")
      .select("conversation_id, property_id, created_at")
      .eq("channel", "sms")
      .eq("contact_id", contactId)
      .not("property_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);

  const resultSets = normalizedAddress
    ? await Promise.all([
        baseQuery().eq("from_address", normalizedAddress),
        baseQuery().eq("to_address", normalizedAddress),
      ])
    : [await baseQuery()];

  const byKey = new Map<string, ThreadCandidate>();
  for (const result of resultSets) {
    if (result.error) {
      throw new Error(`loadCandidates: ${result.error.message}`);
    }
    for (const row of result.data ?? []) {
      if (!row.property_id) continue;
      const key = buildThreadId(row.conversation_id, contactId, row.property_id);
      if (!byKey.has(key)) {
        byKey.set(key, {
          conversationId: row.conversation_id,
          propertyId: row.property_id,
          latestAt: row.created_at,
        });
      }
    }
  }
  return Array.from(byKey.values());
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
