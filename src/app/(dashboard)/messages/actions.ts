"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  createContactFromUnknown as createContactFromUnknownHelper,
  dismissUnknownSender as dismissUnknownSenderHelper,
  matchUnknownSender as matchUnknownSenderHelper,
  mergeUnknownSenderToProperty as mergeUnknownSenderToPropertyHelper,
  restoreDismissedSender as restoreDismissedSenderHelper,
  type ContactRole,
} from "@/lib/messages/triage";
import type { Database } from "@/lib/supabase/types";

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
    const { error, data } = await supabase
      .from("messages")
      .delete()
      .eq("id", messageId)
      .eq("status", "queued")
      .select("id")
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
    return await createContactFromUnknownHelper({ supabase, ...input });
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
  sentToday: number;
  failedToday: number;
  /** ISO timestamp of the next queued release, or null if nothing is queued. */
  nextScheduledFor: string | null;
  /** ISO timestamp of the last queued release (used to compute drain ETA). */
  lastScheduledFor: string | null;
};

/**
 * Aggregate stats for the live banner above the Outbox queue panel.
 *
 * Five sequential reads against `messages`:
 *   - count(*) where status='queued'
 *   - count(*) where status='sent' AND created_at >= todayStartUtc
 *   - count(*) where status='failed' AND failed_at >= todayStartUtc
 *   - min(scheduled_for) where status='queued'  (next release)
 *   - max(scheduled_for) where status='queued'  (last release → drain ETA)
 *
 * UTC midnight is used as the "today" boundary; the banner is a global
 * operator surface, not a per-user view, so a stable boundary is preferred
 * over a per-viewer-timezone one. Surfaces `QUEUE_STATS_FAILED` on any
 * sub-query error so the client falls back to the last-known good stats
 * and the next 30s poll retries.
 */
export async function getQueueStats(): Promise<Result<QueueStats>> {
  try {
    const supabase = createAdminClient();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartIso = todayStart.toISOString();

    // All five reads are independent — run them concurrently. Serial
    // awaits here turned one slow-DB moment into a 5x page stall (each
    // poll and first paint pays the sum, not the max).
    const [queuedRes, sentRes, failedRes, nextRes, lastRes] =
      await Promise.all([
        supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("status", "queued"),
        supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("status", "sent")
          .gte("created_at", todayStartIso),
        supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("status", "failed")
          .gte("failed_at", todayStartIso),
        supabase
          .from("messages")
          .select("scheduled_for")
          .eq("status", "queued")
          .order("scheduled_for", { ascending: true })
          .limit(1),
        supabase
          .from("messages")
          .select("scheduled_for")
          .eq("status", "queued")
          .order("scheduled_for", { ascending: false })
          .limit(1),
      ]);

    const firstError =
      queuedRes.error ??
      sentRes.error ??
      failedRes.error ??
      nextRes.error ??
      lastRes.error;
    if (firstError) {
      return {
        ok: false,
        error: { code: "QUEUE_STATS_FAILED", message: firstError.message },
      };
    }

    return ok({
      queued: queuedRes.count ?? 0,
      sentToday: sentRes.count ?? 0,
      failedToday: failedRes.count ?? 0,
      nextScheduledFor:
        nextRes.data && nextRes.data.length > 0
          ? (nextRes.data[0].scheduled_for ?? null)
          : null,
      lastScheduledFor:
        lastRes.data && lastRes.data.length > 0
          ? (lastRes.data[0].scheduled_for ?? null)
          : null,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "get_queue_stats" } });
    return errFromUnknown(e, "QUEUE_STATS_FAILED");
  }
}
