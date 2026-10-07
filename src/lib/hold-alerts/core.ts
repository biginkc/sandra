import { digestMessage, holdsLink, slackFirstText, slackNudgeText, smsText } from "./messages";
import {
  MAX_ATTEMPTS,
  type ChannelResult,
  type EmailMessage,
  type EnsureInput,
  type HoldAlertDeps,
  type OrgAlertSummary,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;
/** PLAN 4.7 caps. */
export const MAX_DMS_PER_RECIPIENT_PER_HOUR = 20;
export const MAX_SMS_PER_HOUR = 10;
export const DEFAULT_BUDGET_MS = 50_000;

type Task = {
  input: EnsureInput;
  send: () => Promise<ChannelResult>;
};

const emptySummary = (): OrgAlertSummary => ({
  holds: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  untouched: 0,
  budgetExhausted: false,
});

/**
 * One alert pass for one org: derive tasks (first/nudge Slack DMs, owner SMS
 * for hot holds, hourly email digest), then run each through
 * ensure -> claim -> authorize -> cap -> send -> record. Idempotent: every
 * delivery is keyed (hold, recipient, channel, stage) and claimed atomically.
 */
export async function runHoldAlertsForOrg(
  deps: HoldAlertDeps,
  orgId: string,
  opts: { budgetMs?: number } = {},
): Promise<OrgAlertSummary> {
  const startMs = deps.now().getTime();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const summary = emptySummary();

  const holds = await deps.loadHolds(orgId);
  summary.holds = holds.length;
  if (holds.length === 0) return summary;

  const recipients = await deps.loadRecipients(orgId);
  const link = holdsLink(deps.baseUrl);
  const nowMs = startMs;
  const base = { orgId };
  const tasks: Task[] = [];

  for (const hold of holds) {
    for (const r of recipients) {
      tasks.push({
        input: { ...base, propertyId: hold.propertyId, holdKey: hold.holdKey, recipientUserId: r.userId, channel: "slack", stage: "first" },
        send: () => deps.sendSlack(r.userId, slackFirstText(hold, link)),
      });
    }
    if (hold.hot) {
      for (const r of recipients.filter((x) => x.role === "owner")) {
        tasks.push({
          input: { ...base, propertyId: hold.propertyId, holdKey: hold.holdKey, recipientUserId: r.userId, channel: "sms", stage: "first" },
          send: () => deps.sendSms(r.userId, smsText(hold, link)),
        });
      }
    }
  }
  for (const hold of holds) {
    const age = hold.since ? nowMs - Date.parse(hold.since) : NaN;
    if (!Number.isFinite(age) || age < HOUR_MS) continue;
    for (const r of recipients) {
      tasks.push({
        input: { ...base, propertyId: hold.propertyId, holdKey: hold.holdKey, recipientUserId: r.userId, channel: "slack", stage: "nudge_1h" },
        send: () => deps.sendSlack(r.userId, slackNudgeText(hold, link)),
      });
    }
  }
  if (deps.emailEnabled) {
    const hourKey = `digest:${orgId}:${new Date(nowMs).toISOString().slice(0, 13)}`;
    const message: EmailMessage = digestMessage(holds, nowMs, link);
    for (const r of recipients) {
      tasks.push({
        input: { ...base, propertyId: null, holdKey: hourKey, recipientUserId: r.userId, channel: "email", stage: "digest" },
        send: () => deps.sendEmail(r.userId, message),
      });
    }
  }

  for (const task of tasks) {
    if (deps.now().getTime() - startMs >= budgetMs) {
      summary.budgetExhausted = true;
      break;
    }
    const outcome = await runTask(deps, task);
    summary[outcome] += 1;
  }
  return summary;
}

async function runTask(
  deps: HoldAlertDeps,
  task: Task,
): Promise<"sent" | "skipped" | "failed" | "untouched"> {
  const { store } = deps;
  const row = await store.ensure(task.input);
  const claimable = (row.status === "pending" || row.status === "failed") && row.attempts < MAX_ATTEMPTS;
  if (!claimable) return "untouched";
  if (!(await store.claim(row))) return "untouched";

  try {
    if (!(await deps.isRecipientAuthorized(task.input.orgId, task.input.recipientUserId))) {
      await store.markSkipped(row.id, "recipient_not_authorized");
      return "skipped";
    }
    const capReason = await capReached(deps, task.input);
    if (capReason) {
      await store.markSkipped(row.id, capReason);
      return "skipped";
    }
    const result = await task.send();
    if (result.status === "sent") {
      await store.markSent(row.id);
      return "sent";
    }
    if (result.status === "skipped") {
      await store.markSkipped(row.id, result.reason);
      return "skipped";
    }
    await store.markFailed(row.id, result.error, result.terminal);
    return "failed";
  } catch (error) {
    await store.markFailed(row.id, error instanceof Error ? error.message : String(error));
    return "failed";
  }
}

async function capReached(
  deps: HoldAlertDeps,
  input: EnsureInput,
): Promise<"cap_dm_per_hour" | "cap_sms_per_hour" | null> {
  const sinceIso = new Date(deps.now().getTime() - HOUR_MS).toISOString();
  if (input.channel === "slack") {
    const n = await deps.store.countSentSince({
      orgId: input.orgId,
      channel: "slack",
      recipientUserId: input.recipientUserId,
      sinceIso,
    });
    return n >= MAX_DMS_PER_RECIPIENT_PER_HOUR ? "cap_dm_per_hour" : null;
  }
  if (input.channel === "sms") {
    const n = await deps.store.countSentSince({ orgId: input.orgId, channel: "sms", sinceIso });
    return n >= MAX_SMS_PER_HOUR ? "cap_sms_per_hour" : null;
  }
  return null;
}
