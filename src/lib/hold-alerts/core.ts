import { digestMessage, holdsLink, slackFirstText, slackNudgeText, smsText } from "./messages";
import {
  MAX_ATTEMPTS,
  ROUTE_MAX_DURATION_MS,
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
  send: (ctx: { deliveryId: string }) => Promise<ChannelResult>;
  /** The recipient must still be an owner when the send happens (SMS). */
  requireOwner?: boolean;
  /** Asked before the row is even created; false = nothing to do yet. */
  eligible?: () => Promise<boolean>;
};

const emptySummary = (): OrgAlertSummary => ({
  holds: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  untouched: 0,
  deferred: 0,
  interrupted: 0,
  archived: 0,
  budgetExhausted: false,
});

/**
 * One alert pass for one org: derive tasks (first/nudge Slack DMs, owner SMS
 * for hot holds, hourly email digest), then run each through
 * ensure -> cap -> claim -> authorize -> send -> record. Idempotent: every
 * delivery is keyed (hold, recipient, channel, stage) and claimed atomically;
 * a claimed row is `sending` before the provider is called, so a run that dies
 * mid-send can never cause a second send (the next pass sweeps it to
 * failed:interrupted). A capped row stays `pending` and is retried next run.
 */
export async function runHoldAlertsForOrg(
  deps: HoldAlertDeps,
  orgId: string,
  opts: { budgetMs?: number } = {},
): Promise<OrgAlertSummary> {
  const startMs = deps.now().getTime();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const summary = emptySummary();

  // A row left 'sending' longer than the route can run belongs to a dead run.
  summary.interrupted = await deps.store.failInterrupted(
    new Date(startMs - ROUTE_MAX_DURATION_MS).toISOString(),
  );

  const loaded = await deps.loadHolds(orgId);
  const holds = loaded.holds;
  // Archive-on-clear: a property that is no longer held closes its delivery
  // rows so a re-opened hold gets fresh keys. Only on a COMPLETE load, or a
  // truncated / failed query would "close" holds that are still open.
  if (loaded.complete) {
    summary.archived = await deps.store.archiveClosed(orgId, [...new Set(holds.map((h) => h.propertyId))]);
  }
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
          requireOwner: true,
        });
      }
    }
  }
  // The nudge is "still unanswered an hour after we told you": it keys off when
  // the first DM was actually SENT, never off the hold's own age. On first
  // deploy every old hold would otherwise get its first DM and a nudge at once.
  for (const hold of holds) {
    for (const r of recipients) {
      tasks.push({
        input: { ...base, propertyId: hold.propertyId, holdKey: hold.holdKey, recipientUserId: r.userId, channel: "slack", stage: "nudge_1h" },
        send: () => deps.sendSlack(r.userId, slackNudgeText(hold, link)),
        eligible: async () => {
          const firstSentAt = await deps.store.sentAt({
            holdKey: hold.holdKey,
            recipientUserId: r.userId,
            channel: "slack",
            stage: "first",
          });
          return firstSentAt !== null && nowMs - Date.parse(firstSentAt) >= HOUR_MS;
        },
      });
    }
  }
  if (deps.emailEnabled) {
    const hourKey = `digest:${orgId}:${new Date(nowMs).toISOString().slice(0, 13)}`;
    const message: EmailMessage = digestMessage(holds, nowMs, link);
    for (const r of recipients) {
      tasks.push({
        input: { ...base, propertyId: null, holdKey: hourKey, recipientUserId: r.userId, channel: "email", stage: "digest" },
        send: ({ deliveryId }) => deps.sendEmail(r.userId, message, { idempotencyKey: `hold-alert-${deliveryId}` }),
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
): Promise<"sent" | "skipped" | "failed" | "untouched" | "deferred"> {
  const { store } = deps;
  if (task.eligible && !(await task.eligible())) return "untouched";
  const row = await store.ensure(task.input);
  const claimable = (row.status === "pending" || row.status === "failed") && row.attempts < MAX_ATTEMPTS;
  if (!claimable) return "untouched";

  // Over a cap: leave the row pending (nothing is claimed, no attempt is spent)
  // so the next run delivers it once the hour has rolled.
  if (await capReached(deps, task.input)) return "deferred";

  if (!(await store.claim(row))) return "untouched";

  let sendStarted = false;
  try {
    if (!(await deps.isRecipientAuthorized(task.input.orgId, task.input.recipientUserId, { requireOwner: task.requireOwner }))) {
      await store.markSkipped(row.id, task.requireOwner ? "recipient_not_owner" : "recipient_not_authorized");
      return "skipped";
    }
    sendStarted = true;
    const result = await task.send({ deliveryId: row.id });
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
    // Once the provider call began, a throw is ambiguous (it may have been delivered): never retry.
    await store.markFailed(row.id, error instanceof Error ? error.message : String(error), sendStarted);
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
