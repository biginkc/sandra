"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { errFromUnknown, err, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  cancelAppointment,
  completeAppointment,
  reassignAppointment,
  rescheduleAppointment,
  type AppointmentOutcome,
  type CancelAppointmentResult,
  type CompleteAppointmentResult,
  type ReassignAppointmentResult,
  type RescheduleAppointmentResult,
} from "@/lib/appointments/lifecycle";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { dispatchTaskAssignedSlack } from "@/lib/integrations/slack/dispatch";
import { dispatchTaskAssigned } from "@/lib/notifications/dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { wallTimeToUtc } from "@/lib/time/zoned";

/**
 * "use server" boundary for the PR 3 appointment lifecycle RPCs
 * (migration 20260814210000). Each action: authenticates, delegates the
 * actual RPC call to `src/lib/appointments/lifecycle.ts`, revalidates the
 * affected paths, and — reassign only — fires the same best-effort
 * assignment notification/Slack side effects as `createLeadTaskAction`
 * (leads/actions.ts:1337+) and `bookAppointment`
 * (book-appointment-action.ts:364-387), dispatched in `after()` so a
 * Slack/notification hiccup never rolls back an already-committed
 * reassignment.
 *
 * Complete/cancel/reschedule fire no assignment notification — the
 * assignee doesn't change for any of those three, so there is nothing new
 * to notify them of; the plan only calls out reassign for this.
 */

type TaskLookupRow = {
  org_id: string;
  title: string;
  due_at: string;
  related_property_id: string | null;
  contact_id: string | null;
};

async function loadTaskForNotification(
  supabase: Awaited<ReturnType<typeof createClient>>,
  taskId: string,
): Promise<TaskLookupRow | null> {
  const { data } = await supabase
    .from("tasks")
    .select("org_id, title, due_at, related_property_id, contact_id")
    .eq("id", taskId)
    .maybeSingle();
  return data ?? null;
}

async function loadPropertyAddress(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyId: string,
): Promise<string> {
  const { data } = await supabase
    .from("properties")
    .select("address")
    .eq("id", propertyId)
    .maybeSingle();
  return data?.address ?? "Appointment";
}

function buildAppointmentDeepLink(propertyId?: string | null, contactId?: string | null): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  if (propertyId) return `${normalizedBaseUrl}/leads/${propertyId}`;
  if (contactId) return `${normalizedBaseUrl}/messages?thread=${contactId}`;
  return `${normalizedBaseUrl}/dashboard`;
}

function revalidateAppointmentPaths(task: TaskLookupRow | null): void {
  if (task?.related_property_id) revalidatePath(`/leads/${task.related_property_id}`);
  revalidatePath("/messages");
  revalidatePath("/dashboard");
}

export async function completeAppointmentAction(
  taskId: string,
  outcome: AppointmentOutcome,
): Promise<Result<CompleteAppointmentResult>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return err({ code: "UNAUTHENTICATED", message: "Not signed in" });

    const result = await completeAppointment(supabase, taskId, outcome);
    if (!result.ok) return result;

    revalidateAppointmentPaths(await loadTaskForNotification(supabase, taskId));
    return result;
  } catch (e) {
    reportError(e, { tags: { surface: "complete_appointment_action" }, extra: { taskId } });
    return errFromUnknown(e, "COMPLETE_APPOINTMENT_FAILED");
  }
}

export async function cancelAppointmentAction(
  taskId: string,
): Promise<Result<CancelAppointmentResult>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return err({ code: "UNAUTHENTICATED", message: "Not signed in" });

    // Read before the RPC closes the row — cancel doesn't change linkage,
    // but reading after would work identically; before is cheaper (one
    // fewer round trip when the RPC itself fails).
    const task = await loadTaskForNotification(supabase, taskId);

    const result = await cancelAppointment(supabase, taskId);
    if (!result.ok) return result;

    revalidateAppointmentPaths(task);
    return result;
  } catch (e) {
    reportError(e, { tags: { surface: "cancel_appointment_action" }, extra: { taskId } });
    return errFromUnknown(e, "CANCEL_APPOINTMENT_FAILED");
  }
}

export type RescheduleAppointmentActionInput = {
  taskId: string;
  /** YYYY-MM-DD, wall-clock date in `timeZone`. */
  date: string;
  /** HH:mm, wall-clock time in `timeZone`. */
  time: string;
  /** IANA zone — MUST be the assignee's authoritative preference; the RPC
   *  rejects a caller-supplied zone that disagrees (same contract as
   *  booking). */
  timeZone: string;
  durationMinutes: number;
  /** One UUID minted per reschedule attempt, reused across retries of the
   *  same submit so a dropped response can't create a second successor —
   *  same idempotency contract as `bookAppointment`. */
  idempotencyKey?: string;
};

export async function rescheduleAppointmentAction(
  input: RescheduleAppointmentActionInput,
): Promise<Result<RescheduleAppointmentResult>> {
  if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0) {
    return err({ code: "INVALID_DURATION", message: "Choose a valid duration." });
  }

  const converted = wallTimeToUtc({
    date: input.date,
    time: input.time,
    timeZone: input.timeZone,
  });
  if (!converted.ok) {
    return err({
      code: converted.reason === "nonexistent" ? "TIME_NONEXISTENT" : "TIME_INVALID",
      message:
        converted.reason === "nonexistent"
          ? "That time doesn't exist in this timezone because of a daylight-saving change — pick another."
          : "Choose a valid date and time.",
    });
  }
  const newStartUtc = converted.utc;
  const newEndUtc = new Date(newStartUtc.getTime() + input.durationMinutes * 60_000);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return err({ code: "UNAUTHENTICATED", message: "Not signed in" });

    const task = await loadTaskForNotification(supabase, input.taskId);

    const result = await rescheduleAppointment(supabase, {
      taskId: input.taskId,
      newStartUtc: newStartUtc.toISOString(),
      newEndUtc: newEndUtc.toISOString(),
      timeZone: input.timeZone,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) return result;

    revalidateAppointmentPaths(task);
    return result;
  } catch (e) {
    reportError(e, {
      tags: { surface: "reschedule_appointment_action" },
      extra: { taskId: input.taskId },
    });
    return errFromUnknown(e, "RESCHEDULE_APPOINTMENT_FAILED");
  }
}

export async function reassignAppointmentAction(
  taskId: string,
  newAssigneeId: string,
  idempotencyKey?: string,
): Promise<Result<ReassignAppointmentResult>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return err({ code: "UNAUTHENTICATED", message: "Not signed in" });

    const result = await reassignAppointment(supabase, taskId, newAssigneeId, idempotencyKey);
    if (!result.ok) return result;

    // Codex round 10 (finding 3): everything past this point is
    // best-effort — `reassignAppointment` above already committed the
    // reassignment, so nothing that follows may flip this action's result
    // back to an error. Previously the task re-fetch used for notification
    // prep ran uncaught in this same try block: if IT threw (a transient
    // read failure, unrelated to the already-successful mutation), the
    // outer catch below reported REASSIGN_APPOINTMENT_FAILED even though
    // the reassignment had durably succeeded — the caller would see a
    // failure for a change that already happened. Caught here instead, and
    // only used for revalidation (tolerant of a missing task, same as
    // every other lifecycle action's `revalidateAppointmentPaths` call).
    const task = await loadTaskForNotification(supabase, taskId).catch((e) => {
      reportError(e, {
        tags: { surface: "reassign_appointment_action_task_lookup" },
        extra: { taskId },
      });
      return null;
    });
    revalidateAppointmentPaths(task);

    // Same single-owner-notification pattern as bookAppointment /
    // createLeadTaskAction: skip when the actor reassigned to themselves,
    // and skip on a duplicate (no-op) result — the original assignment's
    // notification already fired and a retry re-dispatching it would
    // double-notify. Decided synchronously (both flags, plus `task`, are
    // already in hand — no fetch needed), so a duplicate/self reassignment
    // registers no `after()` callback at all, same as before this round.
    //
    // Keyed-retry note: since this action now always returns the RPC's own
    // committed result once it succeeds (never downgraded by a later prep
    // or dispatch failure below), the `result.data.duplicate` skip only
    // ever fires on a genuine retry of an idempotency key that already
    // committed AND already notified — not on this path's own failures,
    // which no longer exist for it to trip over.
    if (task && !result.data.duplicate && newAssigneeId !== user.id) {
      // ALL notification prep (admin client, prefs, address) plus the
      // dispatch calls themselves move inside `after()`, wrapped in their
      // own try/catch + reportError — a failure anywhere in here is
      // reported on its own, separately, and never touches the `result`
      // already returned below.
      after(async () => {
        try {
          const admin = createAdminClient();
          const prefs = await loadIntegrationPrefs(admin, newAssigneeId);
          const subjectLabel = task.related_property_id
            ? await loadPropertyAddress(supabase, task.related_property_id)
            : task.title;
          const deepLink = buildAppointmentDeepLink(task.related_property_id, task.contact_id);
          await Promise.allSettled([
            dispatchTaskAssigned(supabase, {
              taskId,
              orgId: task.org_id,
              assigneeId: newAssigneeId,
              taskTitle: task.title,
              taskType: "appointment",
              dueAt: task.due_at,
              propertyAddress: task.related_property_id ? subjectLabel : null,
            }),
            dispatchTaskAssignedSlack({
              taskId,
              assigneeId: newAssigneeId,
              taskTitle: task.title,
              taskType: "appointment",
              dueAt: task.due_at,
              propertyAddress: subjectLabel,
              deepLink,
              timezone: prefs.timezone,
              slackEnabled: prefs.slackEnabled,
            }),
          ]);
        } catch (e) {
          reportError(e, {
            tags: { surface: "reassign_appointment_action_notify" },
            extra: { taskId },
          });
        }
      });
    }

    return result;
  } catch (e) {
    reportError(e, { tags: { surface: "reassign_appointment_action" }, extra: { taskId } });
    return errFromUnknown(e, "REASSIGN_APPOINTMENT_FAILED");
  }
}
