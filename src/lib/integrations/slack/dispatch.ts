import { WebClient } from "@slack/web-api";

import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";
import { humanDueDate } from "@/lib/notifications/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { completeTask } from "@/lib/tasks";

import { buildMarkedDoneBlocks, buildTaskAssignedBlocks } from "./blocks";

const TASK_TYPE_LABELS: Record<string, string> = {
  follow_up: "Follow-up",
  callback: "Callback",
};

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
      dueLabel: humanDueDate(input.dueAt),
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

    const result = await completeTask(admin, input.taskId, resolvedUserId);
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

function buildTaskDeepLink(taskId: string): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http")
    ? baseUrl
    : `https://${baseUrl}`;
  return `${normalizedBaseUrl}/tasks/${taskId}`;
}
