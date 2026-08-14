import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
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
   *  the claim RPC — used to write attempts+1 without a read-then-write
   *  race against the claim. */
  attempts: number;
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

type DeliveryUpdateClient = {
  from(table: "task_reminder_deliveries"): {
    update(values: {
      status: "sent" | "failed";
      attempts: number;
      provider_message_id?: string | null;
      last_error?: string | null;
      sent_at?: string | null;
    }): {
      eq(
        column: "id",
        value: string,
      ): Promise<{ error: { message: string } | null }>;
    };
  };
};

async function markDelivery(
  supabase: SupabaseClient<Database>,
  row: Pick<ClaimedReminderRow, "deliveryId" | "attempts">,
  status: "sent" | "failed",
  extra: { providerMessageId?: string | null; lastError?: string | null },
): Promise<void> {
  const { error } = await (supabase as unknown as DeliveryUpdateClient)
    .from("task_reminder_deliveries")
    .update({
      status,
      attempts: row.attempts + 1,
      provider_message_id: extra.providerMessageId ?? null,
      last_error: extra.lastError ?? null,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    })
    .eq("id", row.deliveryId);
  if (error) {
    reportError(new Error(error.message), {
      tags: { surface: "reminder_delivery_mark" },
      extra: { deliveryId: row.deliveryId, status },
    });
  }
}

async function deliverBell(
  supabase: SupabaseClient<Database>,
  row: ClaimedReminderRow,
): Promise<ReminderDeliveryOutcome> {
  // `createNotification` inserts against notifications, which carries the
  // PR-1 partial unique index on (user_id, entity_id) WHERE
  // event_type='task_appointment_reminder' — a retry of an
  // already-delivered bell hits that constraint and createNotification
  // swallows the resulting error (returning inserted: 0), same as any
  // other unexpected insert failure. Either way the desired end state
  // (exactly one bell notification row for this appointment) already
  // holds, so this delivery is marked sent regardless of `inserted`.
  await createNotification(supabase, {
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
  await markDelivery(supabase, row, "sent", {});
  return { status: "sent", deliveryId: row.deliveryId, channel: "bell" };
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
  // The claim RPC already gated this row's existence on
  // (sms_reminder enabled AND reminder_phone present), but the phone is
  // re-checked here rather than trusted blindly — belt-and-suspenders
  // against a retry claim racing the assignee clearing their number
  // between claim and delivery.
  if (!row.assigneeReminderPhone) {
    const errorMessage = "no reminder phone on file";
    await markDelivery(supabase, row, "failed", { lastError: errorMessage });
    return { status: "failed", deliveryId: row.deliveryId, channel: "sms", error: errorMessage };
  }

  const { body } = formatNotification("task_appointment_reminder", {
    taskTitle: row.taskTitle,
    dueAt: row.taskDueAt,
    timezone: row.assigneeTimezone,
  });
  const result = await sendRepSmsReminder({ to: row.assigneeReminderPhone, body });
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
