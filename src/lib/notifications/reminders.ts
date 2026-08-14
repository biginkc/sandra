import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import {
  buildTaskDeepLink,
  dispatchAppointmentReminderSlack,
} from "@/lib/integrations/slack/dispatch";
import type { Database } from "@/lib/supabase/types";

import { createNotification } from "./dispatch";
import { formatNotification } from "./format";
import { sendRepSmsReminder } from "./rep-sms";

/**
 * Appointment-reminder delivery worker (PR 3). Consumes rows returned by
 * either `fn_claim_appointment_reminders()` (the primary 30-minute-window
 * sweep) or `fn_claim_reminder_retries()` (crash-safety retries) — both
 * RPCs return the same shape, so this module doesn't need to know which
 * claim produced a given row.
 *
 * `supabase` must be an admin/service-role client: `task_reminder_deliveries`
 * writes are server-owned (20260814150000), and bell/slack delivery both
 * read/write other users' rows.
 */

export type ReminderChannel = "bell" | "slack" | "sms";

export type ClaimedReminderRow = {
  deliveryId: string;
  taskId: string;
  orgId: string;
  channel: ReminderChannel;
  /** Prior attempts already recorded on the delivery row, straight off
   *  the claim RPC.
   *
   *  Semantics differ by which claim produced this row (see `claimToken`):
   *  from `fn_claim_appointment_reminders` (fresh insert, no lease needed)
   *  this is the attempt count BEFORE this delivery, and `markDelivery`
   *  writes `attempts + 1`. From `fn_claim_reminder_retries` the claim
   *  itself already bumped attempts atomically (Codex round 1, same
   *  convention as `task_calendar_mutations`'s claim), so this IS the
   *  attempt count for this delivery and `markDelivery` writes it as-is. */
  attempts: number;
  /** Fencing token minted by `fn_claim_reminder_retries` on this claim, or
   *  `null` for a fresh row from `fn_claim_appointment_reminders` (that
   *  insert's ON CONFLICT DO NOTHING already gives exactly-once ownership
   *  — no lease/token needed). When present, `markDelivery`'s write is
   *  scoped `WHERE id=<mine> AND claim_token=<mine> AND
   *  status=<claimedStatus>` — a stalled worker whose lease was reclaimed
   *  writes zero rows instead of clobbering the new owner. */
  claimToken: string | null;
  /** The delivery's status as of just before this claim ('pending' or
   *  'failed') — the "expected status" half of the fenced write. Always
   *  present alongside `claimToken`; `null` when `claimToken` is null. */
  claimedStatus: "pending" | "failed" | null;
  taskTitle: string;
  taskDueAt: string;
  taskEndAt: string | null;
  assigneeId: string;
  assigneeTimezone: string;
  assigneeReminderPhone: string | null;
};

export type ReminderDeliveryOutcome =
  | {
      status: "sent";
      deliveryId: string;
      channel: ReminderChannel;
      providerMessageId?: string | null;
    }
  | { status: "failed"; deliveryId: string; channel: ReminderChannel; error: string };

type DeliveryUpdateBuilder = {
  eq(column: "id" | "claim_token" | "status", value: string): DeliveryUpdateBuilder;
  select(columns: "id"): PromiseLike<{
    data: { id: string }[] | null;
    error: { message: string } | null;
  }>;
};

type DeliveryUpdateClient = {
  from(table: "task_reminder_deliveries"): {
    update(values: {
      status: "sent" | "failed";
      attempts: number;
      provider_message_id?: string | null;
      last_error?: string | null;
      sent_at?: string | null;
    }): DeliveryUpdateBuilder;
  };
};

/**
 * Writes the delivery outcome. For a row claimed by `fn_claim_reminder_retries`
 * (`claimToken` present), the write is fenced — scoped `WHERE id=<mine> AND
 * claim_token=<mine> AND status=<claimedStatus>` and verified to affect
 * exactly one row (`.select("id")`) — same contract as
 * `task_calendar_mutations`'s `applyLedgerTransition` (create-worker.ts).
 * Zero rows matched means the lease was lost (reclaimed by a later sweep
 * after this worker stalled past its 2-minute lease): not an error, the
 * row is abandoned silently — ownership belongs to whoever holds the
 * current token, and their own delivery attempt (or lack thereof) is
 * authoritative. A fresh row from `fn_claim_appointment_reminders` carries
 * no token and needs no fencing (ON CONFLICT DO NOTHING already gave that
 * insert exactly-once ownership) — its write is a plain `WHERE id=<mine>`.
 *
 * `attempts` written is `row.attempts` as-is for a fenced (retry-claimed)
 * row — the claim already bumped it — and `row.attempts + 1` for an
 * unfenced (primary-claimed) row, which never has its attempts touched by
 * the claim itself. See `ClaimedReminderRow.attempts`.
 */
async function markDelivery(
  supabase: SupabaseClient<Database>,
  row: Pick<ClaimedReminderRow, "deliveryId" | "attempts" | "claimToken" | "claimedStatus">,
  status: "sent" | "failed",
  extra: { providerMessageId?: string | null; lastError?: string | null },
): Promise<void> {
  const attempts = row.claimToken ? row.attempts : row.attempts + 1;
  let query = (supabase as unknown as DeliveryUpdateClient)
    .from("task_reminder_deliveries")
    .update({
      status,
      attempts,
      provider_message_id: extra.providerMessageId ?? null,
      last_error: extra.lastError ?? null,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    })
    .eq("id", row.deliveryId);
  if (row.claimToken) {
    query = query.eq("claim_token", row.claimToken);
    if (row.claimedStatus) {
      query = query.eq("status", row.claimedStatus);
    }
  }
  const { data, error } = await query.select("id");
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "reminder_delivery_mark" },
      extra: { deliveryId: row.deliveryId, status },
    });
    return;
  }
  if (row.claimToken && (data?.length ?? 0) === 0) {
    // Lease lost — reclaimed by a later sweep. Not an error; abandon
    // silently (see doc comment above).
    return;
  }
}

async function deliverBell(
  supabase: SupabaseClient<Database>,
  row: ClaimedReminderRow,
): Promise<ReminderDeliveryOutcome> {
  // `createNotification` inserts against notifications, which carries the
  // PR-1 partial unique index on (user_id, entity_id) WHERE
  // event_type='task_appointment_reminder' — a retry of an
  // already-delivered bell hits that constraint. `createNotification`
  // distinguishes that CONFIRMED duplicate (SQLSTATE 23505, `conflict:
  // true`) from any other insert failure (transport, RLS, schema — always
  // `inserted: 0, conflict: false`). Only `inserted > 0` (fresh row) or
  // `conflict` (dedupe: the desired end state already holds) mark this
  // delivery sent; anything else is a genuine failure and must stay
  // retryable rather than being silently swallowed as success.
  const result = await createNotification(supabase, {
    orgId: row.orgId,
    eventType: "task_appointment_reminder",
    entityType: "task",
    entityId: row.taskId,
    payload: {
      taskTitle: row.taskTitle,
      dueAt: row.taskDueAt,
      timezone: row.assigneeTimezone,
    },
    recipients: [row.assigneeId],
  });
  if (result.inserted > 0 || result.conflict) {
    await markDelivery(supabase, row, "sent", {});
    return { status: "sent", deliveryId: row.deliveryId, channel: "bell" };
  }
  const errorMessage = "notification insert failed";
  await markDelivery(supabase, row, "failed", { lastError: errorMessage });
  return { status: "failed", deliveryId: row.deliveryId, channel: "bell", error: errorMessage };
}

async function deliverSlack(
  supabase: SupabaseClient<Database>,
  row: ClaimedReminderRow,
): Promise<ReminderDeliveryOutcome> {
  const result = await dispatchAppointmentReminderSlack({
    taskId: row.taskId,
    assigneeId: row.assigneeId,
    taskTitle: row.taskTitle,
    dueAt: row.taskDueAt,
    timezone: row.assigneeTimezone,
    deepLink: buildTaskDeepLink(row.taskId),
  });
  if (result.sent) {
    await markDelivery(supabase, row, "sent", { providerMessageId: result.messageTs });
    return {
      status: "sent",
      deliveryId: row.deliveryId,
      channel: "slack",
      providerMessageId: result.messageTs,
    };
  }
  await markDelivery(supabase, row, "failed", { lastError: result.reason });
  return { status: "failed", deliveryId: row.deliveryId, channel: "slack", error: result.reason };
}

async function deliverSms(
  supabase: SupabaseClient<Database>,
  row: ClaimedReminderRow,
): Promise<ReminderDeliveryOutcome> {
  // Delivery-time defense (finding 3): both claim RPCs already gate this
  // row's existence/re-eligibility on (sms_reminder enabled AND
  // reminder_phone present) — the primary claim at insert time, the retry
  // claim by re-validating inside its own locked selection — but a LIVE
  // re-check right before the provider call closes the narrow window
  // between claim and this delivery where the assignee could still
  // disable the channel or clear their number. Same posture as Slack's
  // own live pref re-check inside dispatchAppointmentReminderSlack.
  const prefs = await loadIntegrationPrefs(supabase, row.assigneeId);
  if (!prefs.smsRemindersEnabled) {
    const errorMessage = "sms reminders disabled";
    await markDelivery(supabase, row, "failed", { lastError: errorMessage });
    return { status: "failed", deliveryId: row.deliveryId, channel: "sms", error: errorMessage };
  }
  if (!prefs.reminderPhone) {
    const errorMessage = "no reminder phone on file";
    await markDelivery(supabase, row, "failed", { lastError: errorMessage });
    return { status: "failed", deliveryId: row.deliveryId, channel: "sms", error: errorMessage };
  }

  const { body } = formatNotification("task_appointment_reminder", {
    taskTitle: row.taskTitle,
    dueAt: row.taskDueAt,
    timezone: row.assigneeTimezone,
  });
  // Send to the LIVE phone number, not the (possibly stale) claimed value
  // — same "trust the live re-check, not the claim" posture as the
  // enabled-flag check above.
  const result = await sendRepSmsReminder({ to: prefs.reminderPhone, body });
  if (result.ok) {
    await markDelivery(supabase, row, "sent", { providerMessageId: result.externalId });
    return {
      status: "sent",
      deliveryId: row.deliveryId,
      channel: "sms",
      providerMessageId: result.externalId,
    };
  }
  await markDelivery(supabase, row, "failed", { lastError: result.message });
  return { status: "failed", deliveryId: row.deliveryId, channel: "sms", error: result.message };
}

/**
 * Delivers one claimed reminder row on its channel and marks the delivery
 * row sent/failed. Never throws across the boundary — an unexpected
 * exception from any channel's provider call is caught, the delivery
 * marked failed, and a `failed` outcome returned, so one row's crash
 * never aborts the sweep loop calling this.
 */
export async function deliverAppointmentReminder(
  supabase: SupabaseClient<Database>,
  row: ClaimedReminderRow,
): Promise<ReminderDeliveryOutcome> {
  try {
    switch (row.channel) {
      case "bell":
        return await deliverBell(supabase, row);
      case "slack":
        return await deliverSlack(supabase, row);
      case "sms":
        return await deliverSms(supabase, row);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markDelivery(supabase, row, "failed", { lastError: message });
    return { status: "failed", deliveryId: row.deliveryId, channel: row.channel, error: message };
  }
}
