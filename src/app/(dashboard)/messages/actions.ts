"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { getOutboundSmsMetrics } from "@/lib/messages/message-metrics";
import {
  createContactFromUnknown as createContactFromUnknownHelper,
  dismissUnknownSender as dismissUnknownSenderHelper,
  matchUnknownSender as matchUnknownSenderHelper,
  mergeUnknownSenderToProperty as mergeUnknownSenderToPropertyHelper,
  restoreDismissedSender as restoreDismissedSenderHelper,
  type ContactRole,
} from "@/lib/messages/triage";
import {
  createPropertyAndResolve,
  resolveThreadToExistingProperty,
} from "@/lib/messages/resolve";
import {
  listResolverCandidatePropertiesForContact,
  type ResolverCandidateProperty,
} from "@/lib/messages/threading";
import type { Database } from "@/lib/supabase/types";

import type { QueuedRow } from "./queue-panel";
import {
  buildQueuedCursorFilter,
  type QueuedPageCursor,
} from "./queued-cursor";

export type { QueuedPageCursor } from "./queued-cursor";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
import {
  releaseQueuedMessage,
  type SendSmsOutcome,
} from "@/lib/messaging/send";

export type ReleaseQueuedPayload = { outcome: SendSmsOutcome };

/**
 * Send one queued message. Called from the `/messages` page's "Send
 * Next" button and from the auto-send interval tick. Re-checks consent
 * + quiet hours at release time so a message queued 12 hours ago can
 * still be blocked if the contact opted out in between.
 */
export async function releaseMessage(
  messageId: string,
): Promise<Result<ReleaseQueuedPayload>> {
  try {
    const supabase = await createClient();
    const outcome = await releaseQueuedMessage(supabase, messageId);
    return ok({ outcome });
  } catch (e) {
    reportError(e, {
      tags: { surface: "release_message" },
      extra: { messageId },
    });
    return errFromUnknown(e, "RELEASE_MESSAGE_FAILED");
  }
}

/**
 * Edit a queued message's body before it sends. Only applies to
 * `status='queued'` rows — post-send is immutable.
 */
export async function updateQueuedMessage(
  messageId: string,
  body: string,
): Promise<Result<null>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "EMPTY_BODY", message: "Message body is empty." },
    };
  }
  if (trimmed.length > 1600) {
    return {
      ok: false,
      error: {
        code: "BODY_TOO_LONG",
        message: `Message is ${trimmed.length} characters — cap is 1600.`,
      },
    };
  }
  try {
    const supabase = await createClient();
    // Guard: only touch rows currently queued. A concurrent release
    // can't race us because of the status='queued' filter.
    const { error, data } = await supabase
      .from("messages")
      .update({ body: trimmed })
      .eq("id", messageId)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "UPDATE_FAILED", message: error.message },
      };
    }
    if (!data) {
      return {
        ok: false,
        error: {
          code: "NOT_QUEUED",
          message:
            "Message is no longer queued (already sent, failed, or deleted).",
        },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_queued_message" },
      extra: { messageId },
    });
    return errFromUnknown(e, "UPDATE_QUEUED_FAILED");
  }
}

/**
 * Delete a queued message. Same guard as edit — won't touch a message
 * that's already been sent.
 */
export async function deleteQueuedMessage(
  messageId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "NOT_SIGNED_IN", message: "Not signed in." },
      };
    }
    const { error, data } = await supabase
      .from("messages")
      .delete()
      .eq("id", messageId)
      .eq("status", "queued")
      .select("id, property_id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "DELETE_FAILED", message: error.message },
      };
    }
    if (!data) {
      return {
        ok: false,
        error: {
          code: "NOT_QUEUED",
          message:
            "Message is no longer queued — refresh the page to see current state.",
        },
      };
    }
    if (data.property_id) {
      await recordLeadEvent({
        propertyId: data.property_id,
        eventType: LEAD_EVENT_TYPES.QUEUED_MESSAGE_DELETED,
        actorType: "user",
        actorId: user.id,
        sourceType: "messages.deleted",
        sourceId: data.id,
      });
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "delete_queued_message" },
      extra: { messageId },
    });
    return errFromUnknown(e, "DELETE_QUEUED_FAILED");
  }
}

// ----------------------------------------------------------------------------
// Cockpit Phase 2 — Unknown sender triage actions.
// ----------------------------------------------------------------------------

export async function matchUnknownSenderAction(
  fromAddress: string,
  contactId: string,
): Promise<Result<{ updated: number }>> {
  try {
    const supabase = await createClient();
    return await matchUnknownSenderHelper({ supabase, fromAddress, contactId });
  } catch (e) {
    reportError(e, {
      tags: { surface: "match_unknown_sender" },
      extra: { fromAddress, contactId },
    });
    return errFromUnknown(e, "MATCH_UNKNOWN_FAILED");
  }
}

export async function createContactFromUnknownAction(input: {
  fromAddress: string;
  role: ContactRole;
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    entityName?: string | null;
  };
  property: {
    address: string;
    city?: string | null;
    state: string;
    zip?: string | null;
  };
}): Promise<Result<{ contactId: string; propertyId: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "NOT_SIGNED_IN", message: "Not signed in." },
      };
    }
    const result = await createContactFromUnknownHelper({ supabase, ...input });
    if (result.ok) {
      await recordLeadEvent({
        propertyId: result.data.propertyId,
        actorType: "user",
        actorId: user.id,
        eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
        payload: { source: "unknown_sender" },
        sourceType: "properties.created",
        sourceId: result.data.propertyId,
      });
    }
    return result;
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_contact_from_unknown" },
      extra: { fromAddress: input.fromAddress, role: input.role },
    });
    return errFromUnknown(e, "CREATE_FROM_UNKNOWN_FAILED");
  }
}

export async function mergeUnknownSenderToPropertyAction(input: {
  fromAddress: string;
  propertyId: string;
  role: ContactRole;
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    entityName?: string | null;
  };
}): Promise<Result<{ contactId: string }>> {
  try {
    const supabase = await createClient();
    return await mergeUnknownSenderToPropertyHelper({ supabase, ...input });
  } catch (e) {
    reportError(e, {
      tags: { surface: "merge_unknown_sender_to_property" },
      extra: {
        fromAddress: input.fromAddress,
        propertyId: input.propertyId,
        role: input.role,
      },
    });
    return errFromUnknown(e, "MERGE_TO_PROPERTY_FAILED");
  }
}

export type PropertySearchHit = {
  id: string;
  address: string;
  city: string | null;
  state: string | null;
  homeownerContactId: string | null;
  agentContactId: string | null;
};

export type ResolveCandidateProperty = ResolverCandidateProperty;

/**
 * Search properties by address fragment for the Merge-with-property
 * dialog. Caps at 20 results.
 */
export async function searchPropertiesForMatch(
  query: string,
): Promise<Result<PropertySearchHit[]>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return ok([]);
  try {
    const supabase = await createClient();
    const like = `*${trimmed.replace(/[%_*]/g, "")}*`;
    const { data, error } = await supabase
      .from("properties")
      .select(
        "id, address, city, state, homeowner_contact_id, agent_contact_id, created_at",
      )
      .or([`address.ilike.${like}`, `city.ilike.${like}`].join(","))
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      return {
        ok: false,
        error: { code: "SEARCH_FAILED", message: error.message },
      };
    }
    const hits: PropertySearchHit[] = (data ?? []).map((p) => ({
      id: p.id,
      address: p.address,
      city: p.city,
      state: p.state,
      homeownerContactId: p.homeowner_contact_id,
      agentContactId: p.agent_contact_id,
    }));
    return ok(hits);
  } catch (e) {
    reportError(e, {
      tags: { surface: "search_properties_for_match" },
      extra: { query: trimmed.slice(0, 64) },
    });
    return errFromUnknown(e, "SEARCH_FAILED");
  }
}

export async function listResolveCandidatesAction(input: {
  sourceConversationId: string;
  contactId: string;
}): Promise<Result<ResolveCandidateProperty[]>> {
  try {
    const supabase = await createClient();
    const candidates = await listResolverCandidatePropertiesForContact(
      supabase,
      input,
    );
    return ok(candidates);
  } catch (e) {
    reportError(e, {
      tags: { surface: "list_resolve_candidates" },
      extra: {
        sourceConversationId: input.sourceConversationId,
        contactId: input.contactId,
      },
    });
    return errFromUnknown(e, "LIST_RESOLVE_CANDIDATES_FAILED");
  }
}

export async function resolveThreadToPropertyAction(input: {
  sourceConversationId: string;
  contactId: string;
  propertyId: string;
  role?: ContactRole | null;
}): Promise<Result<{ updated: number; conversationId: string }>> {
  try {
    const supabase = await createClient();
    return await resolveThreadToExistingProperty({ supabase, ...input });
  } catch (e) {
    reportError(e, {
      tags: { surface: "resolve_thread_to_property" },
      extra: {
        sourceConversationId: input.sourceConversationId,
        contactId: input.contactId,
        propertyId: input.propertyId,
        role: input.role ?? null,
      },
    });
    return errFromUnknown(e, "RESOLVE_THREAD_FAILED");
  }
}

export async function createPropertyAndResolveAction(input: {
  sourceConversationId: string;
  contactId: string;
  role: ContactRole;
  property: {
    address: string;
    city?: string | null;
    state: string;
    zip?: string | null;
  };
}): Promise<
  Result<{ updated: number; conversationId: string; propertyId: string }>
> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "NOT_SIGNED_IN", message: "Not signed in." },
      };
    }
    const result = await createPropertyAndResolve({ supabase, ...input });
    if (result.ok) {
      await recordLeadEvent({
        propertyId: result.data.propertyId,
        actorType: "user",
        actorId: user.id,
        eventType: LEAD_EVENT_TYPES.LEAD_CREATED,
        payload: { source: "message_resolution" },
        sourceType: "properties.created",
        sourceId: result.data.propertyId,
      });
    }
    return result;
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_property_and_resolve" },
      extra: {
        sourceConversationId: input.sourceConversationId,
        contactId: input.contactId,
        role: input.role,
      },
    });
    return errFromUnknown(e, "CREATE_PROPERTY_AND_RESOLVE_FAILED");
  }
}

/**
 * Fetch every message from a given from_address (matched or not,
 * dismissed or not) for the read-only thread dialog. Sorted ASC by
 * created_at so bubbles render in conversation order.
 */
export async function fetchUnknownSenderThread(
  fromAddress: string,
): Promise<Result<MessageRow[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("from_address", fromAddress)
      .eq("channel", "sms")
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) {
      return {
        ok: false,
        error: { code: "FETCH_THREAD_FAILED", message: error.message },
      };
    }
    return ok(data ?? []);
  } catch (e) {
    reportError(e, {
      tags: { surface: "fetch_unknown_sender_thread" },
      extra: { fromAddress },
    });
    return errFromUnknown(e, "FETCH_THREAD_FAILED");
  }
}

export async function dismissUnknownSenderAction(
  fromAddress: string,
): Promise<Result<{ updated: number }>> {
  try {
    const supabase = await createClient();
    return await dismissUnknownSenderHelper({ supabase, fromAddress });
  } catch (e) {
    reportError(e, {
      tags: { surface: "dismiss_unknown_sender" },
      extra: { fromAddress },
    });
    return errFromUnknown(e, "DISMISS_FAILED");
  }
}

export type ContactSearchHit = {
  id: string;
  displayName: string;
  phone1: string | null;
  propertyAddress: string | null;
};

/**
 * Search contacts for the Match dialog. Matches on name (first/last/entity)
 * AND phone fragments. Caps at 20 results — caller refines query if more.
 */
export async function searchContactsForMatch(
  query: string,
): Promise<Result<ContactSearchHit[]>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return ok([]);
  try {
    const supabase = await createClient();
    // PostgREST `.or()` filter for the fuzzy search across multiple cols.
    // Inside `.or()` the wildcard for `ilike` is `*`, NOT the SQL `%` —
    // `%` lands as a literal character match and never hits anything.
    const like = `*${trimmed.replace(/[%_*]/g, "")}*`;
    const { data, error } = await supabase
      .from("contacts")
      .select(
        `id, first_name, last_name, entity_name, phone_1, phone_2, phone_3,
         properties:properties!properties_homeowner_contact_id_fkey(address, city, state)`,
      )
      .or(
        [
          `first_name.ilike.${like}`,
          `last_name.ilike.${like}`,
          `entity_name.ilike.${like}`,
          `phone_1.ilike.${like}`,
          `phone_2.ilike.${like}`,
          `phone_3.ilike.${like}`,
        ].join(","),
      )
      .limit(20);
    if (error) {
      return {
        ok: false,
        error: { code: "SEARCH_FAILED", message: error.message },
      };
    }
    const hits: ContactSearchHit[] = (data ?? []).map((c) => {
      const propRow = Array.isArray(c.properties) ? c.properties[0] : null;
      return {
        id: c.id,
        displayName:
          c.entity_name ??
          ([c.first_name, c.last_name].filter(Boolean).join(" ") ||
            "Unnamed contact"),
        phone1: c.phone_1,
        propertyAddress: propRow
          ? [propRow.address, propRow.city, propRow.state]
              .filter(Boolean)
              .join(", ")
          : null,
      };
    });
    return ok(hits);
  } catch (e) {
    reportError(e, {
      tags: { surface: "search_contacts_for_match" },
      extra: { query: trimmed.slice(0, 64) },
    });
    return errFromUnknown(e, "SEARCH_FAILED");
  }
}

export async function restoreDismissedSenderAction(
  fromAddress: string,
): Promise<Result<{ updated: number }>> {
  try {
    const supabase = await createClient();
    return await restoreDismissedSenderHelper({ supabase, fromAddress });
  } catch (e) {
    reportError(e, {
      tags: { surface: "restore_dismissed_sender" },
      extra: { fromAddress },
    });
    return errFromUnknown(e, "RESTORE_FAILED");
  }
}

// ----------------------------------------------------------------------------
// Quick task 260504-tgq — live Outbox queue stats banner.
// ----------------------------------------------------------------------------

export type QueueStats = {
  queued: number;
  paused: number;
  sentOutToday: number;
  failedToday: number;
  /** ISO timestamp of the next queued release, or null if nothing is queued. */
  nextScheduledFor: string | null;
  /** ISO timestamp of the last queued release (used to compute drain ETA). */
  lastScheduledFor: string | null;
};

/**
 * Aggregate stats for the live banner above the Outbox queue panel.
 *
 * Uses the same session/RLS surface as the visible Outbox table and the
 * shared outbound-SMS metrics contract. "Sent out today" counts rows
 * that have been handed to the provider today by `sent_at`, including
 * rows that later advanced from `sent` to `delivered`.
 */
export async function getQueueStats(): Promise<Result<QueueStats>> {
  try {
    const supabase = await createClient();
    const stats = await getOutboundSmsMetrics(supabase);

    return ok({
      queued: stats.queued,
      paused: stats.paused,
      sentOutToday: stats.handedOffToday,
      failedToday: stats.failedToday,
      nextScheduledFor: stats.nextScheduledFor,
      lastScheduledFor: stats.lastScheduledFor,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "get_queue_stats" } });
    return {
      ok: false,
      error: {
        code: "QUEUE_STATS_FAILED",
        message: e instanceof Error ? e.message : "Failed to load queue stats.",
      },
    };
  }
}

/** Page size for the Outbox queue list (first paint + each scroll fetch). */
const QUEUE_PAGE_SIZE = 100;

export type QueuedPage = {
  rows: QueuedRow[];
  hasMore: boolean;
};

/**
 * One page of the Outbox queue, ordered (scheduled_for ASC nulls last,
 * id ASC) — the same order the release path drains in. Pass null to get
 * the first page; pass the last visible row's cursor to get the next.
 *
 * The cursor is client-supplied and validated by buildQueuedCursorFilter
 * before it touches the raw `.or()` grammar — see queued-cursor.ts.
 *
 * Uses the session-scoped client (same RLS surface as the page's
 * first-paint query). Fetches PAGE_SIZE+1 rows to derive hasMore.
 */
export async function listQueuedPage(
  cursor: QueuedPageCursor | null,
): Promise<Result<QueuedPage>> {
  try {
    const supabase = await createClient();

    let query = supabase
      .from("messages")
      .select(
        `id, body, from_address, to_address, created_at, scheduled_for, property_id, contact_id,
           property:properties(id, address, city, state),
           contact:contacts(id, first_name, last_name, entity_name, phone_1)`,
      )
      .eq("status", "queued");

    if (cursor) {
      const filter = buildQueuedCursorFilter(cursor);
      if (filter.kind === "invalid") {
        return {
          ok: false,
          error: { code: "QUEUE_PAGE_FAILED", message: "invalid cursor" },
        };
      }
      if (filter.kind === "nullTail") {
        query = query.is("scheduled_for", null).gt("id", filter.id);
      } else {
        query = query.or(filter.expr);
      }
    }

    const { data, error } = await query
      .order("scheduled_for", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(QUEUE_PAGE_SIZE + 1);

    if (error) {
      return {
        ok: false,
        error: { code: "QUEUE_PAGE_FAILED", message: error.message },
      };
    }

    const all = data ?? [];
    const pageRows = all.slice(0, QUEUE_PAGE_SIZE);

    return ok({
      hasMore: all.length > QUEUE_PAGE_SIZE,
      rows: pageRows.map((r) => ({
        id: r.id,
        body: r.body,
        fromAddress: r.from_address,
        toAddress: r.to_address,
        createdAt: r.created_at,
        scheduledFor: r.scheduled_for,
        propertyId: r.property_id,
        contactId: r.contact_id,
        propertyAddress: r.property
          ? [r.property.address, r.property.city, r.property.state]
              .filter(Boolean)
              .join(", ")
          : null,
        contactName: r.contact
          ? (r.contact.entity_name ??
            ([r.contact.first_name, r.contact.last_name]
              .filter(Boolean)
              .join(" ") ||
              null))
          : null,
        contactPhone: r.contact?.phone_1 ?? null,
      })),
    });
  } catch (e) {
    reportError(e, { tags: { surface: "list_queued_page" } });
    return errFromUnknown(e, "QUEUE_PAGE_FAILED");
  }
}
