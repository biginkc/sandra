import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/supabase/types";
import { DEFAULT_ORG_ID, E2E_MOCK_BUSINESS_NUMBER, seedProspects } from "../fixtures";
import { ensureConversationIdForThread } from "../../src/lib/messages/threading";
import { waitForAcceptanceProjectionTarget } from "./cleanup";

/**
 * Shared fixture seeding for the inbox acceptance matrix runner
 * (e2e/inbox-acceptance/*.spec.ts). Every helper here inserts rows scoped
 * to DEFAULT_ORG_ID (= SANDRA_ORG_ID, the real single-tenant gate) and
 * returns the ids the specs assert against. This factors the per-spec
 * seeding idiom used by e2e/cockpit-inbox-shell.spec.ts and
 * e2e/cockpit-design-fidelity.spec.ts (contacts/properties/messages
 * inserts + ensureConversationIdForThread) into one place for the
 * acceptance rows.
 */

let queuedPhoneCounter = 5_000_000;
function nextQueuedPhoneSuffix(): number {
  queuedPhoneCounter += 1;
  return queuedPhoneCounter;
}

export type SeededMessage = {
  direction: "inbound" | "outbound";
  body: string;
  createdAtOffsetMin: number;
  read?: boolean;
};

export type SeededThread = {
  contactId: string;
  propertyId: string;
  threadId: string;
  contactName: string;
};

/** Seed a known-contact conversation thread (message-backed, org …000bbb). */
export async function seedAcceptanceThread(
  admin: SupabaseClient<Database>,
  opts: {
    phone: string;
    /**
     * Business number used by the inbound messages. The general Inbox
     * fixtures retain their historical number; reviewed-reply fixtures pass
     * the canonical sender seeded for the provider policy.
     */
    businessNumber?: string;
    addressTag: string;
    contactName: { first: string; last: string };
    propertyStatus?: string;
    propertyState?: string;
    messages: SeededMessage[];
    assigneeId?: string | null;
    /** Set false only when the caller intentionally seeds after opening a workset. */
    waitForProjection?: boolean;
  },
): Promise<SeededThread> {
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({
      first_name: opts.contactName.first,
      last_name: opts.contactName.last,
      phone_1: opts.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw new Error(`seedAcceptanceThread: contact insert failed: ${contactError?.message}`);
  }

  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  const { error: propUpdateError } = await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      status: opts.propertyStatus ?? "new_lead",
      ...(opts.propertyState ? { state: opts.propertyState } : {}),
      assigned_user_id: opts.assigneeId ?? null,
    })
    .eq("id", prop.id);
  if (propUpdateError) {
    throw new Error(`seedAcceptanceThread: property update failed: ${propUpdateError.message}`);
  }

  const conversationId = await ensureConversationIdForThread(admin, contact.id, prop.id);

  for (const m of opts.messages) {
    const createdAt = new Date(Date.now() + m.createdAtOffsetMin * 60_000).toISOString();
    const businessNumber = opts.businessNumber ?? "+18162804181";
    const { error: msgError } = await admin.from("messages").insert({
      channel: "sms",
      direction: m.direction,
      status: m.direction === "inbound" ? "received" : "sent",
      conversation_id: conversationId,
      contact_id: contact.id,
      property_id: prop.id,
      from_address: m.direction === "inbound" ? opts.phone : businessNumber,
      to_address: m.direction === "inbound" ? businessNumber : opts.phone,
      body: m.body,
      created_at: createdAt,
      read_at: m.direction === "inbound" && m.read === true ? new Date().toISOString() : null,
    });
    if (msgError) throw new Error(`seedAcceptanceThread: message insert failed: ${msgError.message}`);
  }

  // The source INSERT commits before the private projection worker publishes
  // summaries/filter rows. Wait for the exact target and final unread state
  // so a following workset snapshot cannot freeze before this fixture row.
  if (opts.messages.length > 0 && opts.waitForProjection !== false) {
    await waitForAcceptanceProjectionTarget({
      kind: "known_conversation",
      id: conversationId,
      unread: opts.messages.some((message) => message.direction === "inbound" && message.read !== true),
    });
  }

  return {
    contactId: contact.id,
    propertyId: prop.id,
    threadId: conversationId,
    contactName: `${opts.contactName.first} ${opts.contactName.last}`,
  };
}

/**
 * Seed an outbound message sitting in the Outbox queue (status='queued').
 *
 * Release/send (queue-panel.tsx's `sendOne` -> actions.ts's `releaseMessage`
 * -> src/lib/messaging/send.ts) requires a resolvable contact_id — a queued
 * row with no linked contact fails pre-dispatch with `contact_not_found`
 * before it ever reaches consent/quiet-hours checks, so every seeded queued
 * message needs a real, non-opted-out, non-DNC contact with a mobile phone.
 */
export async function seedQueuedMessage(
  admin: SupabaseClient<Database>,
  opts: {
    addressTag: string;
    body: string;
    scheduledForOffsetMin: number;
    phone?: string;
  },
): Promise<{ id: string; propertyId: string; contactId: string }> {
  const phone = opts.phone ?? `+1816${String(nextQueuedPhoneSuffix()).padStart(7, "0")}`;
  const [prop] = await seedProspects(admin, 1, opts.addressTag);
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({
      first_name: "Outbox",
      last_name: opts.addressTag,
      phone_1: phone,
      phone_1_type: "mobile",
      do_not_contact: false,
      sms_opted_out: false,
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw new Error(`seedQueuedMessage: contact insert failed: ${contactError?.message}`);
  }
  const { error: propUpdateError } = await admin
    .from("properties")
    .update({ homeowner_contact_id: contact.id })
    .eq("id", prop.id);
  if (propUpdateError) {
    throw new Error(`seedQueuedMessage: property update failed: ${propUpdateError.message}`);
  }

  const { data: message, error } = await admin
    .from("messages")
    .insert({
      channel: "sms",
      direction: "outbound",
      status: "queued",
      property_id: prop.id,
      contact_id: contact.id,
      // A row queued through the app's normal path (queueForLater in
      // src/lib/messaging/send.ts) always stamps `provider` at insert
      // time; releaseQueuedMessage then hard-fails any row whose stamped
      // provider doesn't match the CURRENT provider ("queued message
      // belongs to provider X, current provider is Y"). A direct INSERT
      // that skips this stamp is treated as provider "unknown" and always
      // fails release — exactly the bug the strengthened O02/O03
      // DB-status assertions (not mere card-disappearance) caught.
      provider: "mock",
      // Must be a sender the mock delivery catalog actually knows about
      // (seedMockDeliveryCatalog registers MOCK_SENDER_PRIMARY) — an
      // unregistered from_address silently fails at send time too.
      from_address: E2E_MOCK_BUSINESS_NUMBER,
      to_address: phone,
      body: opts.body,
      scheduled_for: new Date(Date.now() + opts.scheduledForOffsetMin * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !message) {
    throw new Error(`seedQueuedMessage: message insert failed: ${error?.message}`);
  }
  return { id: message.id, propertyId: prop.id, contactId: contact.id };
}

export { DEFAULT_ORG_ID };
