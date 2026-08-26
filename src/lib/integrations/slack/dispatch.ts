import { WebClient } from "@slack/web-api";

import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";
import { formatTimeOfDay, humanDueDate } from "@/lib/notifications/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeTimeZone } from "@/lib/time/zoned";
import { completeTask } from "@/lib/tasks";

import {
  buildAppointmentReminderBlocks,
  buildMarkedDoneBlocks,
  buildTaskAssignedBlocks,
} from "./blocks";

const TASK_TYPE_LABELS: Record<string, string> = {
  follow_up: "Follow-up",
  callback: "Callback",
};

/** Codex round 6 (finding 2): the Slack SDK's `WebClient` has no request
 *  timeout by default and retries transient failures up to 10 times over
 *  ~30 minutes (`retryConfig` default is `tenRetriesInAboutThirtyMinutes`)
 *  — either alone can blow through the reminder sweep's 45s phase budget
 *  (route.ts) on a single call. Scoped to the REMINDER path only
 *  (`dispatchAppointmentReminderSlack` below) — the seller-facing
 *  `dispatchTaskAssignedSlack` send path is untouched; its call isn't
 *  budget-bound the same way and a low retry count there would trade a
 *  transient Slack blip for a dropped assignment notification for no
 *  reminder-sweep benefit. `retryConfig: { retries: 0 }` (node-retry's
 *  `OperationOptions`) disables the SDK's own retry loop entirely — the
 *  route-level Promise.race deadline (reminders.ts / route.ts) is the
 *  single source of truth for how long one delivery gets; a retrying SDK
 *  underneath it would just re-arm work that budget already gave up on.
 *  `timeout` is a generous upper bound on the underlying HTTP call itself
 *  (independent of, and smaller than, the sweep's whole 45s budget) so a
 *  hung socket can't outlive the process by much even in the discarded-
 *  promise case the route's deadline race creates. */
const SLACK_REMINDER_CLIENT_OPTIONS = {
  timeout: 10_000,
  retryConfig: { retries: 0 },
} as const;

type AdminClient = ReturnType<typeof createAdminClient>;

export interface DispatchSlackTaskInput {
  taskId: string;
  assigneeId: string;
  taskTitle: string;
  taskType: string;
  dueAt: string;
  propertyAddress: string;
  deepLink: string;
  timezone: string;
  slackEnabled?: boolean;
}

export type DispatchSlackResult =
  | { sent: true; channel: string; messageTs: string }
  | {
      sent: false;
      reason: "no_token" | "no_pref" | "pref_disabled" | "error";
    };

export type CompleteTaskFromSlackResult =
  | { ok: true }
  | { ok: false; reason: "auth" | "not_found" | "not_assignee" };

export async function dispatchTaskAssignedSlack(
  input: DispatchSlackTaskInput,
): Promise<DispatchSlackResult> {
  try {
    const admin = createAdminClient();
    // input.timezone is the authoritative zone — the caller loaded the
    // assignee's prefs once and threads the result through. Re-loading here
    // would silently swap in the Chicago default whenever the prefs read
    // transiently failed, discarding a zone the caller already knew.
    const slackEnabled =
      input.slackEnabled ??
      (await loadIntegrationPrefs(admin, input.assigneeId)).slackEnabled;
    if (!slackEnabled) return { sent: false, reason: "pref_disabled" };

    const token = await getDecryptedToken({
      userId: input.assigneeId,
      provider: "slack",
      tokenType: "bot",
    });
    if (!token?.externalAccountId) return { sent: false, reason: "no_token" };

    const slack = new WebClient(token.accessToken.reveal());
    const opened = await slack.conversations.open({
      users: token.externalAccountId,
    });
    const channel = opened.channel?.id;
    if (!channel) return { sent: false, reason: "error" };

    const taskTitle = truncateTaskTitle(input.taskTitle);
    const blocks = buildTaskAssignedBlocks({
      taskTitle,
      propertyAddress: input.propertyAddress,
      dueLabel: humanDueDate(input.dueAt, undefined, normalizeTimeZone(input.timezone)),
      taskTypeLabel: TASK_TYPE_LABELS[input.taskType] ?? "Task",
      taskId: input.taskId,
      deepLink: input.deepLink,
    });
    const posted = await slack.chat.postMessage({
      channel,
      blocks,
      text: `Task assigned: ${taskTitle}`,
    });
    const messageTs = posted.ts;
    if (!messageTs) return { sent: false, reason: "error" };

    const { error } = await admin
      .from("tasks")
      .update({ slack_channel_id: channel, slack_message_ts: messageTs })
      .eq("id", input.taskId);
    if (error) {
      throw new Error(error.message);
    }

    return { sent: true, channel, messageTs };
  } catch (error) {
    reportError(error, {
      tags: { surface: "slack_task_dispatch" },
      extra: { taskId: input.taskId, assigneeId: input.assigneeId },
    });
    return { sent: false, reason: "error" };
  }
}

export interface DispatchAppointmentReminderSlackInput {
  taskId: string;
  assigneeId: string;
  taskTitle: string;
  /** ISO timestamptz — the appointment's due_at. */
  dueAt: string;
  timezone: string;
  deepLink: string;
  /** Same short-circuit as `DispatchSlackTaskInput.slackEnabled`: pass the
   *  already-loaded pref so this function never re-loads it. */
  slackEnabled?: boolean;
}

/**
 * Codex round 12 (finding 1): three-way outcome for the reminder path,
 * distinct from `DispatchSlackResult`'s two-way sent/not-sent shape.
 * `dispatchTaskAssignedSlack` is untouched — its caller has its own retry
 * posture and is out of this finding's scope (dispatch.ts:185-199, the
 * reminder-only `dispatchAppointmentReminderSlack` below).
 *
 * The three outcomes map directly onto what `reminders.ts`'s `deliverSlack`
 * needs to classify a delivery honestly:
 *   - `sent`: `chat.postMessage` returned a `ts` — a provable receipt.
 *   - `failed`: a definite pre-send failure (disabled pref, no token, or
 *     `conversations.open` — which never transmits a message — throwing or
 *     returning no channel). Nothing was ever transmitted, so this is safe
 *     to retry.
 *   - `ambiguous`: transmission STARTED but no provable receipt came back —
 *     `chat.postMessage` itself threw (the request may have reached Slack
 *     before the exception, e.g. a timeout/connection drop), or it resolved
 *     without a `ts` (accepted-without-receipt). Neither proves the message
 *     was or wasn't sent, so this must never be treated as retryable —
 *     `deliverSlack` fences the row into `timeout_ambiguous` instead of
 *     `failed`.
 */
export type DispatchAppointmentReminderSlackResult =
  | { outcome: "sent"; channel: string; messageTs: string }
  | { outcome: "failed"; reason: "no_token" | "pref_disabled" | "pre_send_error" }
  | { outcome: "ambiguous"; reason: string };

/**
 * PR 3 reminder sweep — same shape as `dispatchTaskAssignedSlack` (open a
 * 1:1 DM, post blocks) but for the appointment-reminder template. Kept as
 * a separate function rather than a branch on the existing one: the two
 * templates diverge (no "Mark Done" action row here, and the reminder
 * fires from the reminder worker's already-loaded prefs/timezone, not a
 * fresh `loadIntegrationPrefs` call inside a task-assignment flow).
 *
 * Codex round 12 (finding 1): split into two stages with DIFFERENT failure
 * semantics — pre-send (prefs/token/`conversations.open`, none of which
 * transmit a message) and the send itself (`chat.postMessage`, which DOES).
 * A pre-send exception proves nothing was sent (`failed`, retryable); a
 * send-stage exception or a receipt-less success proves transmission
 * STARTED with no confirmed outcome (`ambiguous`, never retryable — see
 * `DispatchAppointmentReminderSlackResult`'s doc comment).
 */
export async function dispatchAppointmentReminderSlack(
  input: DispatchAppointmentReminderSlackInput,
): Promise<DispatchAppointmentReminderSlackResult> {
  let channel: string;
  let slack: WebClient;
  try {
    const admin = createAdminClient();
    const slackEnabled =
      input.slackEnabled ??
      (await loadIntegrationPrefs(admin, input.assigneeId)).slackEnabled;
    if (!slackEnabled) return { outcome: "failed", reason: "pref_disabled" };

    const token = await getDecryptedToken({
      userId: input.assigneeId,
      provider: "slack",
      tokenType: "bot",
    });
    if (!token?.externalAccountId) return { outcome: "failed", reason: "no_token" };

    slack = new WebClient(token.accessToken.reveal(), SLACK_REMINDER_CLIENT_OPTIONS);
    const opened = await slack.conversations.open({
      users: token.externalAccountId,
    });
    const openedChannel = opened.channel?.id;
    if (!openedChannel) return { outcome: "failed", reason: "pre_send_error" };
    channel = openedChannel;
  } catch (error) {
    // Pre-send failure — no message was ever transmitted, so this is a
    // definite, retryable failure, never ambiguous.
    reportError(error, {
      tags: { surface: "slack_appointment_reminder_dispatch" },
      extra: { taskId: input.taskId, assigneeId: input.assigneeId, stage: "pre_send" },
    });
    return { outcome: "failed", reason: "pre_send_error" };
  }

  const taskTitle = truncateTaskTitle(input.taskTitle);
  const timeLabel = formatTimeOfDay(input.dueAt, normalizeTimeZone(input.timezone));
  const blocks = buildAppointmentReminderBlocks({
    taskTitle,
    timeLabel,
    deepLink: input.deepLink,
  });

  try {
    const posted = await slack.chat.postMessage({
      channel,
      blocks,
      text: `Appointment in 30 min: ${taskTitle} at ${timeLabel}`,
    });
    const messageTs = posted.ts;
    if (!messageTs) {
      // Accepted without a receipt — Slack processed the call but returned
      // no ts to confirm it. Not provable non-delivery; ambiguous.
      const message = "Slack chat.postMessage resolved without a ts";
      reportError(new Error(message), {
        tags: { surface: "slack_appointment_reminder_dispatch" },
        extra: { taskId: input.taskId, assigneeId: input.assigneeId, stage: "send" },
      });
      return { outcome: "ambiguous", reason: message };
    }
    return { outcome: "sent", channel, messageTs };
  } catch (error) {
    // The send call itself threw — transmission may have reached Slack
    // before the exception (timeout, connection drop mid-call). Not
    // provable non-delivery; ambiguous, never retried as a fresh send.
    reportError(error, {
      tags: { surface: "slack_appointment_reminder_dispatch" },
      extra: { taskId: input.taskId, assigneeId: input.assigneeId, stage: "send" },
    });
    return {
      outcome: "ambiguous",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function completeTaskFromSlack(input: {
  taskId: string;
  slackUserId: string;
  teamId: string;
}): Promise<CompleteTaskFromSlackResult> {
  try {
    const admin = createAdminClient();
    const resolvedUserId = await resolveUserIdFromSlack(admin, input.slackUserId);
    if (!resolvedUserId) return { ok: false, reason: "auth" };

    const { data: task, error } = await admin
      .from("tasks")
      .select("id, assignee_id, status")
      .eq("id", input.taskId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.assignee_id !== resolvedUserId) {
      return { ok: false, reason: "not_assignee" };
    }
    if (task.status === "completed") return { ok: true };

    const result = await completeTask(
      admin,
      input.taskId,
      resolvedUserId,
      resolvedUserId,
    );
    if (!result.ok) throw new Error(result.error.message);

    return { ok: true };
  } catch (error) {
    reportError(error, {
      tags: { surface: "slack_task_complete" },
      extra: {
        taskId: input.taskId,
        slackUserId: input.slackUserId,
        teamId: input.teamId,
      },
    });
    return { ok: false, reason: "auth" };
  }
}

export async function refreshSlackMessage(input: {
  channel: string;
  messageTs: string;
  taskId: string;
  doneByUserName: string;
}): Promise<{ ok: boolean }> {
  try {
    const admin = createAdminClient();
    const { data: task, error } = await admin
      .from("tasks")
      .select("id, assignee_id, title, related_property_id")
      .eq("id", input.taskId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!task) return { ok: false };

    const token = await getDecryptedToken({
      userId: task.assignee_id,
      provider: "slack",
      tokenType: "bot",
    });
    if (!token) return { ok: false };

    // Property-less tasks (personal blocks, contact-only appointments)
    // degrade to a "Personal block" label rather than skipping the lookup.
    const propertyAddress = task.related_property_id
      ? await loadPropertyAddress(admin, task.related_property_id)
      : "Personal block";
    const deepLink = buildTaskDeepLink(input.taskId);
    const slack = new WebClient(token.accessToken.reveal());
    await slack.chat.update({
      channel: input.channel,
      ts: input.messageTs,
      blocks: buildMarkedDoneBlocks({
        taskTitle: task.title,
        propertyAddress,
        doneByUserName: input.doneByUserName,
        deepLink,
      }),
      text: "Marked done",
    });

    return { ok: true };
  } catch (error) {
    reportError(error, {
      tags: { surface: "slack_task_refresh" },
      extra: { taskId: input.taskId, channel: input.channel },
    });
    return { ok: false };
  }
}

function truncateTaskTitle(title: string): string {
  return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}

async function resolveUserIdFromSlack(
  admin: AdminClient,
  slackUserId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("user_oauth_tokens")
    .select("user_id")
    .eq("provider", "slack")
    .eq("token_type", "bot")
    .eq("external_account_id", slackUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.user_id ?? null;
}

async function loadPropertyAddress(
  admin: AdminClient,
  propertyId: string,
): Promise<string> {
  const { data, error } = await admin
    .from("properties")
    .select("address")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.address ?? "Property";
}

/** Exported for reuse by other reminder channels (e.g. the SMS/bell
 *  delivery worker) that need the same deep-link shape Slack uses.
 *
 *  Codex round 11 (finding 2): `/tasks/<id>` has no page.tsx — every link
 *  built with this 404s. Kept as-is (still used by `refreshSlackMessage`'s
 *  "Mark Done" update, out of this round's scope) but the appointment-
 *  reminder Slack CTA now uses `buildAppointmentDeepLink` below instead. */
export function buildTaskDeepLink(taskId: string): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http")
    ? baseUrl
    : `https://${baseUrl}`;
  return `${normalizedBaseUrl}/tasks/${taskId}`;
}

/**
 * Codex round 11 (finding 2): linkage-aware deep link for an appointment
 * task — property-linked -> `/leads/<propertyId>`, contact-only ->
 * `/messages?thread=<contactId>`, personal block (neither) -> `/dashboard`.
 * Same routing `lifecycle-actions.ts`'s and `book-appointment-action.ts`'s
 * own local copies already use for the assignment/lifecycle Slack CTAs;
 * exported here (not consolidated with those in this round) so the
 * reminder-sweep worker (`reminders.ts`) can build the SAME CTA instead of
 * the dead `/tasks/<id>` route `buildTaskDeepLink` produces.
 */
export function buildAppointmentDeepLink(
  propertyId?: string | null,
  contactId?: string | null,
): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http")
    ? baseUrl
    : `https://${baseUrl}`;
  if (propertyId) return `${normalizedBaseUrl}/leads/${propertyId}`;
  if (contactId) return `${normalizedBaseUrl}/messages?thread=${contactId}`;
  return `${normalizedBaseUrl}/dashboard`;
}
